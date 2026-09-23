/**
 * Adapter agent (spec §12.2, §12.3).
 *
 * Input: a writer story + the engine contract. Output: a schema-valid content pack
 * plus a per-beat classification (§11). The adapter loops against the deterministic
 * validator (§12.3) — feeding each round's ERROR findings back into the prompt —
 * until the pack is green or a round budget is hit. This is the "iterate until the
 * report is green" loop from §10, with the validator (not the model) deciding
 * correctness (§16). Provider-agnostic; deterministic under MockAuthorProvider.
 *
 * The adapter emits exactly one runtime shape: RPG. It loops against `validateRpg`
 * (the richest validator: room graph, objects, quests, combat, skill checks, and
 * ending reachability) until the pack is green or the round budget is hit.
 */
import type { Provider } from "../llm/provider.js";
import { RpgAdapterOutputSchema, type BeatClassification } from "./schemas.js";
import type { RpgPack } from "../../src/rpg/schema.js";
import { validateRpg } from "../../src/validate/rpg_validator.js";
import type { Finding, ValidationReport } from "../../src/validate/report.js";
import type { WriterStory } from "./schemas.js";
import type { ZodType, ZodTypeDef } from "zod";

const RPG_ADAPTER_SYSTEM =
  "You are a game designer. Adapt the story + beats into a schema-valid RPG content " +
  "pack with rooms, objects, exits, player stats in meta.vars_init, enemies, and skill " +
  "checks. Classify every beat against the engine contract's adaptation labels. " +
  "Every enemy must stand in a real room and name a declared DEATH ending; every fight " +
  "must be winnable and every skill check passable. If prior_errors are present, fix " +
  "exactly those reference/reachability/soft-lock/combat/skill-check issues. Respond as JSON.";

export type AdaptResult<P = RpgPack> = {
  ok: boolean;
  pack: P;
  classifications: BeatClassification[];
  report: ValidationReport;
  rounds: number;
};

/** Wiring for the revise loop: prompt, output schema, and deterministic validator. */
type AdaptConfig<P> = {
  system: string;
  schemaName: string;
  // Same input/output split as CompletionRequest: the validated OUTPUT carries the
  // pack + classifications, while the INPUT is left open (`unknown`) so schemas that
  // apply `.default()` — where Zod's input type ≠ output type — are accepted.
  schema: ZodType<{ pack: P; classifications: BeatClassification[] }, ZodTypeDef, unknown>;
  validate: (pack: P) => ValidationReport;
};

/** Author → validate → revise loop: emit a pack, validate it, feed any
 *  ERROR findings back into the next prompt, and stop when green or the budget is hit. */
async function runAdaptLoop<P>(
  provider: Provider,
  opts: { story: WriterStory; contract: unknown; maxRounds?: number },
  cfg: AdaptConfig<P>,
): Promise<AdaptResult<P>> {
  const maxRounds = opts.maxRounds ?? 4;
  let priorErrors: Finding[] = [];
  let last: AdaptResult<P> | null = null;
  let lastParseError: string | null = null;

  for (let round = 1; round <= maxRounds; round++) {
    let out: { pack: P; classifications: BeatClassification[] };
    try {
      out = await provider.completeJson({
        system: cfg.system,
        user: JSON.stringify({
          story: opts.story,
          engine_contract: opts.contract,
          prior_errors: priorErrors,
        }),
        schemaName: cfg.schemaName,
        schema: cfg.schema,
      });
    } catch (err) {
      // A real model can return prose, code fences, extra keys (the adapter OUTPUT
      // schemas are `.strict()`), or otherwise off-shape JSON — a live `completeJson` would
      // throw on BOTH a failed JSON extraction and the Zod parse. The mock never does this, but a
      // live frontier model will (the keystone keyed-run risk). Treat a thrown completion
      // as a NON-GREEN round, not a fatal crash: surface it as an ERROR finding fed back
      // into the next prompt so the model can revise toward valid output, exactly as a
      // validator error would be. A transient bad reply must not abort the whole run.
      lastParseError = err instanceof Error ? err.message : String(err);
      priorErrors = [
        {
          severity: "error",
          code: "ADAPTER_OUTPUT_UNPARSEABLE",
          message:
            `Your previous reply could not be parsed as JSON for schema "${cfg.schemaName}": ` +
            `${lastParseError}. Reply with a SINGLE JSON object that matches the schema exactly — ` +
            `no prose, no code fences, and no keys beyond those the schema declares.`,
          where: [cfg.schemaName],
        },
      ];
      continue;
    }
    const report = cfg.validate(out.pack);
    last = {
      ok: report.ok,
      pack: out.pack,
      classifications: out.classifications,
      report,
      rounds: round,
    };
    if (report.ok) return last;
    priorErrors = report.findings.filter((f) => f.severity === "error");
  }
  if (last) return last;
  // Every round threw before producing a parseable pack, so there is no AdaptResult to
  // return. Fail loudly with the accumulated cause instead of a non-null-assertion lie on
  // a null `last` — the caller gets an attributable error, not a TypeError on `.pack`.
  throw new Error(
    `Adapter produced no schema-valid output for "${cfg.schemaName}" in ${maxRounds} round(s). ` +
      `Last parse error: ${lastParseError ?? "unknown"}.`,
  );
}

/** Adapt a story into a validated RPG pack, looping until `validateRpg` is green. */
export function runRpgAdapter(
  provider: Provider,
  opts: { story: WriterStory; contract: unknown; maxRounds?: number },
): Promise<AdaptResult<RpgPack>> {
  return runAdaptLoop(provider, opts, {
    system: RPG_ADAPTER_SYSTEM,
    schemaName: "RpgAdapterOutput",
    schema: RpgAdapterOutputSchema,
    validate: (pack) => validateRpg(pack),
  });
}
