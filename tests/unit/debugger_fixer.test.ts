/**
 * Debugger + Fixer agents (spec §12.5, §15, §16).
 *
 * The debugger classifies a trace's outcome from the pure engine; the fixer
 * applies a closed, whitelisted patch and re-validates. Both are deterministic
 * code — no live model, no file/shell access from content.
 */
import { describe, it, expect } from "vitest";
import { initState } from "../../src/core/state.js";
import type { Rules } from "../../src/core/engine.js";
import { loadRpgSourceFile } from "../../src/rpg/source.js";
import { diagnose } from "../../agents/debugger.js";
import { applyContentPatch, type ContentPatchProposal } from "../../agents/fixer.js";

const startState = () => initState({ seed: 1, start: "a" });

describe("debugger.diagnose", () => {
  it("detects a soft-lock (no legal actions, not ended)", () => {
    const rules: Rules = {
      legalActions: (state) => (state.current === "a" ? [{ type: "MOVE", direction: "east" }] : []),
      resolve: (state, action) =>
        state.current === "a" && action.type === "MOVE"
          ? { conditions: [], effects: [{ goto: "b" }] }
          : null,
    };

    const d = diagnose(rules, startState(), [{ type: "MOVE", direction: "east" }]);
    expect(d.type).toBe("soft_lock");
    expect(d.severity).toBe("high");
    expect(d.where).toContain("location:b");
  });

  it("detects a non-progress loop", () => {
    const rules: Rules = {
      legalActions: () => [{ type: "LOOK" }],
      resolve: () => ({ conditions: [], effects: [] }),
    };
    const d = diagnose(rules, startState(), [{ type: "LOOK" }, { type: "LOOK" }]);
    expect(d.type).toBe("loop");
  });

  it("reports no_failure on a clean ending", () => {
    const rules: Rules = {
      legalActions: () => [{ type: "LOOK" }],
      resolve: () => ({ conditions: [], effects: [{ end_game: "done" }] }),
    };
    const state = startState();
    const actions = [{ type: "LOOK" as const }];
    const d = diagnose(rules, state, actions);
    expect(d.type).toBe("no_failure");
  });
});

describe("fixer.applyContentPatch", () => {
  const loaded = loadRpgSourceFile("content/rpg/quests/cold_forge.yaml");
  if (!loaded.ok) throw new Error("cold_forge failed to compile");
  const rawPack = loaded.compiled.pack;

  it("applies a benign hint and re-validates green", () => {
    const proposal: ContentPatchProposal = {
      layer: "hint_text",
      summary: "hint at the start room",
      ops: [
        {
          op: "add_room_journal_hint",
          room: "forge_steps",
          text: "The forge below answers only to a delver who reads the room carefully.",
        },
      ],
    };
    const res = applyContentPatch(rawPack, proposal);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.applied).toBe(1);
  });

  it("refuses a patch whose target does not exist", () => {
    const res = applyContentPatch(rawPack, {
      layer: "content",
      summary: "x",
      ops: [{ op: "set_object_field", id: "no_such_object", field: "quest_critical", value: true }],
    });
    expect(res.ok).toBe(false);
    expect(res.report.findings[0]?.code).toBe("PATCH_TARGET_MISSING");
  });

  it("counts ops that CHANGED a field, not ops that were proposed", () => {
    // `applied` is the repair's proof, so it must not credit a write that never
    // happened. Setting meta.title to the value it already holds changes nothing;
    // setting it to a new one changes exactly one field.
    const title = (rawPack as { meta: { title: string } }).meta.title;

    const noop = applyContentPatch(rawPack, {
      layer: "content",
      summary: "restate the title the pack already has",
      ops: [{ op: "set_meta", field: "title", value: title }],
    });
    expect(noop.ok).toBe(true);
    if (noop.ok) expect(noop.applied).toBe(0);

    const real = applyContentPatch(rawPack, {
      layer: "content",
      summary: "retitle",
      ops: [{ op: "set_meta", field: "title", value: `${title} (revised)` }],
    });
    expect(real.ok).toBe(true);
    if (real.ok) expect(real.applied).toBe(1);
  });

  it("refuses a set_meta op naming a JavaScript prototype key", () => {
    // set_meta is the one op with an open field name, so it can name "__proto__".
    // Assigning that on a plain object runs Object.prototype's setter, which
    // silently discards a primitive — the patch would report success having
    // changed nothing at all.
    const res = applyContentPatch(rawPack, {
      layer: "content",
      summary: "x",
      ops: [{ op: "set_meta", field: "__proto__", value: "hijacked" }],
    });
    expect(res.ok).toBe(false);
    expect(res.report.findings[0]?.code).toBe("PATCH_UNSAFE_FIELD");
  });

  it("refuses a patch that breaks the schema (§16)", () => {
    // max_score must be a number; a string value must be rejected, not shipped.
    const res = applyContentPatch(rawPack, {
      layer: "content",
      summary: "x",
      ops: [{ op: "set_meta", field: "max_score", value: "lots" }],
    });
    expect(res.ok).toBe(false);
    expect(res.report.findings.some((f) => f.code === "PATCH_SCHEMA_BREAK")).toBe(true);
  });
});
