/**
 * Trust-but-verify coherence: detect text that instructs the RETIRED §14
 * human-approval ceremony as LIVE, mandatory process.
 *
 * The project switched to "trust, but verify": the agent has full authority over
 * ALL game code (engine, validators, schemas), gated by nothing but the automated
 * verification (AGENTS.md — "no human-approval gate and no §14 ceremony"). Any
 * CURRENT-PROCESS material (the docs a fresh agent follows, and the agent-facing
 * code comments it reads) that still tells the agent to PROPOSE-ONLY and wait for a
 * human is a stale map that steers behaviour the wrong way — a fresh agent would
 * refuse the very engine/validator fixes the charter grants.
 *
 * This predicate is the shared, conservative detector behind both coherence guards:
 *   - bug_0049: the current-process DOCS (AGENTS.md, blind_playtest_protocol.md,
 *     afk_loop.md) — tests/regression/docs_trust_but_verify_coherence.test.ts.
 *   - bug_0050: the agent-facing CODE COMMENTS (agents/*.ts) —
 *     tests/regression/agents_trust_but_verify_coherence.test.ts.
 *
 * It is conservative BY CONSTRUCTION: it matches only imperative gate phrasings, so
 * it never fires on the charter's legitimate NEGATIONS ("no §14 ceremony", "no
 * human-approval gate"), on past-tense HISTORY ("went through the §14 gate"), or on
 * the many legitimate SPEC references to the §14 engine-extension gate as a
 * technical concept ("§14 testing strategy", "§14 gate", "§14 engine-extension
 * gate"). Those describe what §14 IS; they do not instruct a human-approval step.
 */

/** Phrases that instruct the retired §14 human-approval gate as live policy. */
const SIGNATURES: RegExp[] = [
  // "gated (§14)" / "gated** (§14)" as an instruction. A NEGATION reads "no §14
  // ceremony" / "need no §14 ceremony" and never matches "gated (§14)"; a spec
  // reference reads "(§14 testing strategy)" / "(§14 gate)" and has no "gated".
  /gated\*{0,2}\s*\(§14\)/i,
  // "propose only; a human reviews" — the human-gate instruction itself.
  /propose only;?\s*a human\s+reviews/i,
  // "Do not silently change engine rules" — forbids the authority the charter grants.
  /do not silently change engine rules/i,
  // Code-comment forms (bug_0050): the fixer header / inline comment claimed
  // engine/validator/test fixes are "proposals only (gated, §14)" and that "code
  // edits stay with the human supervisor" — the same retired ceremony in code.
  /proposals?\s+only\s*\(gated,?\s*§14\)/i,
  /code edits stay with the human supervisor/i,
];

/**
 * Return the substrings in `text` that instruct the retired §14 human-approval gate
 * as LIVE, mandatory process. Empty array means the text is charter-coherent.
 */
export function instructsRetiredGateAsLive(text: string): string[] {
  const hits: string[] = [];
  for (const re of SIGNATURES) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}
