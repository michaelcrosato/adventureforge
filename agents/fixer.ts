/**
 * Fixer agent (spec §12.5, §15, §16).
 *
 * The fixer proposes a STRUCTURED, single-layer patch (a `ContentPatchProposal`)
 * and our deterministic code applies it — the model never edits files, runs
 * shell, or writes code (§16). Each op is drawn from a CLOSED whitelist; an op
 * outside it is refused. After applying, the pack is re-parsed through its Zod
 * schema and re-validated, so a "fix" that breaks the contract is rejected rather
 * than silently shipped (§10). This is the safe analogue of a model "editing the
 * game": data in, validated data out.
 *
 * The fixer touches exactly one of {content, engine_rule, validator, test,
 * hint_text, quest_structure}. Content/hint/quest patches are expressed as the
 * whitelisted ops below and applied deterministically. engine_rule/validator/test
 * changes fall OUTSIDE this structured-patch vocabulary: the fixer surfaces them as
 * a diagnosis and the agent makes those code edits directly under trust, but verify
 * (AGENTS.md — full authority, no human-approval gate, no §14 ceremony), with the
 * automated verification (`npm run health`) as the bar. Keeping the model on the
 * data-in/validated-data-out path is the §16 safety property; it is no longer a
 * human-approval gate.
 */
import { z } from "zod";
import { RpgPackSchema, type RpgPack } from "../src/rpg/schema.js";
import { validateRpg } from "../src/validate/rpg_validator.js";
import { makeReport, type ValidationReport } from "../src/validate/report.js";
import type { Diagnosis, FixLayer } from "./debugger.js";

export const FixLayerSchema = z.enum([
  "content",
  "engine_rule",
  "validator",
  "test",
  "hint_text",
  "quest_structure",
]);

/** The closed op vocabulary. Each op is a small, reversible data edit. */
export const PatchOpSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("set_meta"),
      field: z.string().min(1),
      value: z.union([z.string(), z.number(), z.boolean()]),
    })
    .strict(),
  // RPG room/object content, hint, and quest edits.
  z
    .object({
      op: z.literal("set_object_field"),
      id: z.string().min(1),
      field: z.enum(["description", "read_text", "quest_critical", "takeable", "locked"]),
      value: z.union([z.string(), z.boolean()]),
    })
    .strict(),
  z
    .object({
      op: z.literal("add_room_journal_hint"),
      room: z.string().min(1),
      text: z.string().min(1),
    })
    .strict(),
]);
export type PatchOp = z.infer<typeof PatchOpSchema>;

export const ContentPatchProposalSchema = z
  .object({
    layer: FixLayerSchema,
    summary: z.string().min(1),
    ops: z.array(PatchOpSchema).default([]),
  })
  .strict();
export type ContentPatchProposal = z.infer<typeof ContentPatchProposalSchema>;

export type ApplyResult =
  /**
   * `applied` counts the ops that actually CHANGED a field, not the ops that were
   * proposed. This tool is a repair's proof, so an op that set a field to the
   * value it already held — or that named a field the clone silently refuses —
   * must not be reported as a change that happened.
   */
  | { ok: true; applied: number; pack: unknown; report: ValidationReport }
  | { ok: false; report: ValidationReport };

/** A deep structural clone via JSON (content is plain data — no functions, §16). */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

type AnyPack = {
  meta: Record<string, unknown>;
  objects?: Record<string, unknown>[];
  rooms?: { id: string; on_enter?: unknown[] }[];
};

export type ApplyContentPatchOptions = {
  /**
   * The validation bar the patched pack must clear. Defaults to plain `validateRpg`,
   * which is right for a standalone pack. A pack that ships as a world quest must be
   * validated the way its load path validates it — campaign imports supply flags and
   * items plain validation cannot see — so the MCP tool passes
   * `RpgSourceRuntime.validateWorldQuestPack` here (bug_0653).
   */
  validate?: (pack: RpgPack) => ValidationReport;
};

/**
 * Apply a proposal to a raw (schema-shaped) pack object. Deterministic; mutates
 * only a clone. Returns the re-validated pack — with `applied` counting the ops
 * that actually changed a field — or a report explaining why the patch was
 * refused (unknown target, unsafe field name, schema break, or a still-failing
 * validation).
 */
export function applyContentPatch(
  rawPack: unknown,
  proposal: ContentPatchProposal,
  options: ApplyContentPatchOptions = {},
): ApplyResult {
  const parsedProposal = ContentPatchProposalSchema.safeParse(proposal);
  if (!parsedProposal.success) {
    return {
      ok: false,
      report: makeReport("patch", [
        {
          severity: "error",
          code: "PATCH_INVALID",
          message: parsedProposal.error.message,
          where: ["proposal"],
        },
      ]),
    };
  }
  const pack = clone(rawPack) as AnyPack;
  const fail = (code: string, message: string, where: string[]): ApplyResult => ({
    ok: false,
    report: makeReport(String(pack.meta?.["id"] ?? "patch"), [
      { severity: "error", code, message, where },
    ]),
  });

  // Ops that genuinely mutated the clone. A proposal is a claim about a repair;
  // the count we report back is the evidence for that claim, so it counts writes,
  // not intentions.
  let applied = 0;

  for (const op of parsedProposal.data.ops) {
    switch (op.op) {
      case "set_meta": {
        // `set_meta` is the one op with an open field name (`z.string()`), so it is
        // also the one that can name a key JavaScript treats specially. Assigning
        // "__proto__" on a plain object runs Object.prototype's setter, which
        // silently DISCARDS a primitive: the op would report success having changed
        // nothing. Refuse those names outright — a prototype key is never a content
        // field, and failing closed is the §16 posture everywhere else here.
        if (op.field === "__proto__" || op.field === "constructor" || op.field === "prototype") {
          return fail(
            "PATCH_UNSAFE_FIELD",
            `meta field "${op.field}" is a JavaScript prototype key, not a content field.`,
            [`meta.${op.field}`],
          );
        }
        if (pack.meta[op.field] === op.value) break;
        pack.meta[op.field] = op.value;
        applied += 1;
        break;
      }
      case "set_object_field": {
        const obj = pack.objects?.find((o) => o["id"] === op.id);
        if (!obj) return fail("PATCH_TARGET_MISSING", `no object "${op.id}".`, [`object:${op.id}`]);
        if (obj[op.field] === op.value) break;
        obj[op.field] = op.value;
        applied += 1;
        break;
      }
      case "add_room_journal_hint": {
        const room = pack.rooms?.find((r) => r.id === op.room);
        if (!room)
          return fail("PATCH_TARGET_MISSING", `no room "${op.room}".`, [`room:${op.room}`]);
        (room.on_enter ??= []).push({ add_journal: op.text });
        applied += 1;
        break;
      }
    }
  }

  // Re-parse through the contract: a patch that breaks the schema is refused (§16).
  const reparsed = RpgPackSchema.safeParse(pack);
  if (!reparsed.success) {
    const findings = reparsed.error.issues.map((i) => ({
      severity: "error" as const,
      code: "PATCH_SCHEMA_BREAK",
      message: `${i.message} (${i.path.join(".") || "<root>"})`,
      where: [i.path.join(".") || "<root>"],
    }));
    return { ok: false, report: makeReport(String(pack.meta?.["id"] ?? "patch"), findings) };
  }
  const report = (options.validate ?? ((candidate: RpgPack) => validateRpg(candidate)))(
    reparsed.data,
  );
  return { ok: report.ok, applied, pack: reparsed.data, report };
}

/**
 * Heuristic: turn a diagnosis into a candidate single-layer proposal. The fixer
 * proposes; the validator disposes. A model can refine this, but even the
 * code-only default produces a legitimate, safe patch for the common cases.
 */
export function proposeFix(diagnosis: Diagnosis, ctx: { location?: string }): ContentPatchProposal {
  if (diagnosis.type === "soft_lock" && ctx.location) {
    return {
      layer: "hint_text",
      summary: `Add an in-world hint at "${ctx.location}" so the player is never left without a signposted next step (§17.1, §17.7).`,
      ops: [
        {
          op: "add_room_journal_hint",
          room: ctx.location,
          text: "You sense there is still a way forward here — look closer at what you carry and what stands before you.",
        },
      ],
    };
  }
  // Loops, rejected actions, and engine-touching fixes have no content-patch op:
  // the fixer surfaces them as a diagnosis (empty ops) for the agent to fix in code
  // directly under trust, but verify — not a human-approval gate.
  const layer: FixLayer = diagnosis.type === "loop" ? "quest_structure" : "content";
  return {
    layer,
    summary: `Direct code fix required (no content-patch op) for "${diagnosis.type}" at ${ctx.location ?? "unknown"}: ${diagnosis.description}`,
    ops: [],
  };
}

/**
 * A regression-test source stub asserting the diagnosed failure cannot recur (§15).
 *
 * The stub must not be pasteable into a permanently-green test that asserts
 * nothing. Two holes make that possible and both are closed here:
 *   - `replayTrace` returns ok:true with "no expected final hash to assert" when
 *     the trace omits `expected_final_hash` (a shape integrity.ts permits), so the
 *     stub demands that hash is present and is the one replay reproduced;
 *   - a trace replayed against content it was not recorded on proves nothing, so
 *     the stub binds `content_hash` to the source the same way bin/replay,
 *     bin/inspect and the MCP trace tools do before they step anything.
 */
export function regressionTestStub(
  bugId: string,
  replayPath: string,
  worldQuestId: string,
): string {
  const replayPathLiteral = JSON.stringify(replayPath);
  const worldQuestIdLiteral = JSON.stringify(worldQuestId);
  return `import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { RpgSourceRuntime } from "../../src/mcp/rpg_source_runtime.js";
import { indexRpgPack, buildRpgRules } from "../../src/rpg/runner.js";
import { replayTrace } from "../../src/trace/replay.js";
import type { Trace } from "../../src/trace/record.js";

// Regression for ${bugId} (§15). The bug's trace must replay to its recorded
// hash forever — if a future change reintroduces the failure, this goes red.
describe("${bugId}", () => {
  it("replays the fixed trace to its expected final hash", () => {
    const trace = JSON.parse(readFileSync(${replayPathLiteral}, "utf8")) as Trace;
    const source = new RpgSourceRuntime(process.cwd()).requireWorldQuestPlayable(${worldQuestIdLiteral});

    // Bind the trace to the build it was recorded against. Replaying against
    // different content proves nothing about this bug.
    expect(trace.content_hash).toBe(source.compiled.contentHash);
    // A trace with no recorded final hash replays "ok" while asserting nothing,
    // so demand the hash this regression exists to lock.
    expect(trace.expected_final_hash).toBeDefined();

    const rules = buildRpgRules(indexRpgPack(source.compiled.pack));
    const result = replayTrace(trace, rules);
    expect(result.ok).toBe(true);
    expect(result.finalHash).toBe(trace.expected_final_hash);
  });
});
`;
}
