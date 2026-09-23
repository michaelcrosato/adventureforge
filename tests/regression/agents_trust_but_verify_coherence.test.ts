/**
 * bug_0050 — the agent-facing CODE COMMENTS stop instructing the RETIRED §14
 * human-approval ceremony as live policy (the sibling of bug_0049).
 *
 * bug_0049 fixed the last current-process DOC (docs/blind_playtest_protocol.md) that
 * still told a fresh agent to PROPOSE-ONLY and wait for a human, and logged its
 * next-focus (a)(i): the same stale phrasing also lingered in CODE COMMENTS —
 * specifically `agents/fixer.ts`, whose header said engine_rule/validator/test
 * changes "are gated (§14) and produce a proposal only — code edits stay with the
 * human supervisor", with an inline echo "engine-touching fixes are proposals only
 * (gated, §14)". Under the trust-but-verify charter (AGENTS.md — "no human-approval
 * gate and no §14 ceremony") the agent edits that code DIRECTLY, verified by the
 * automated bar. A fixer/agent reading the stale comment would refuse the authority
 * the charter grants — a stale map, not a harmless note.
 *
 * This guard scans the agent-facing code (agents/*.ts) with the SAME conservative
 * predicate the doc guard uses (tests/regression/support/gate_coherence.ts). It is deliberately
 * conservative: the many legitimate SPEC references to the §14 engine-extension gate
 * (e.g. debugger.ts's "(§14 testing strategy)") describe what §14 IS and must NOT be
 * flagged — only imperative human-gate phrasings are.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { instructsRetiredGateAsLive } from "./support/gate_coherence.js";

const root = process.cwd();
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");

/** Every .ts file under agents/ (the agent-facing code a fresh agent reads). */
function agentTsFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && p.endsWith(".ts")) out.push(relative(root, p).replaceAll("\\", "/"));
    }
  };
  walk(join(root, "agents"));
  return out.sort();
}

describe("bug_0050 — the new code-comment signatures (the predicate)", () => {
  it("flags the fixer header's pre-charter human-gate claim", () => {
    const stale =
      "engine_rule/validator/test changes are gated (§14) and produce a\nproposal only — code edits stay with the human supervisor.";
    expect(instructsRetiredGateAsLive(stale).length).toBeGreaterThan(0);
  });

  it("flags the inline 'proposals only (gated, §14)' echo", () => {
    expect(
      instructsRetiredGateAsLive("engine-touching fixes are proposals only (gated, §14).").length,
    ).toBeGreaterThan(0);
  });

  it("does NOT false-fire on a legitimate §14 spec reference", () => {
    // debugger.ts cites the §14 *testing strategy* as a concept — not a human gate.
    const specRef =
      "the legal-action set never offers an action the engine then rejects (§14 testing strategy)";
    expect(instructsRetiredGateAsLive(specRef)).toEqual([]);
  });
});

describe("bug_0050 — agent-facing code is charter-coherent on the REAL repo", () => {
  it("every agents/*.ts file is free of retired-gate-as-live phrasing", () => {
    const offenders = agentTsFiles()
      .map((f) => ({ f, hits: instructsRetiredGateAsLive(read(f)) }))
      .filter((x) => x.hits.length > 0);
    expect(offenders).toEqual([]);
  });

  it("agents/fixer.ts no longer instructs the retired §14 gate", () => {
    expect(instructsRetiredGateAsLive(read("agents/fixer.ts"))).toEqual([]);
  });

  it("agents/fixer.ts still affirmatively routes engine fixes through trust-but-verify (not vacuous)", () => {
    // Guard against passing by DELETING the comment: the header must still tell the
    // agent how engine/validator/test fixes are handled — directly, under the charter.
    const fixer = read("agents/fixer.ts");
    expect(fixer).toMatch(/engine_rule\/validator\/test/);
    expect(fixer).toMatch(/trust, but verify/i);
    expect(fixer).toContain("no §14 ceremony");
  });

  it("WOULD catch a regression if the stale claim returned (mechanism live)", () => {
    const regressed =
      read("agents/fixer.ts") + "\n// engine fixes are gated (§14): a human reviews.";
    expect(instructsRetiredGateAsLive(regressed).length).toBeGreaterThan(0);
  });
});
