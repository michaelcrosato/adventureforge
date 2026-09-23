/**
 * bug_0236 — author revise-loop resilience to off-shape model replies.
 *
 * `runAdaptLoop` (agents/authoring/adapter.ts) is the author → validate → revise loop
 * behind the RPG authoring path. Its only model call is `provider.completeJson(...)`,
 * which for a live model extracts JSON from the reply and then `schema.parse`s it: it
 * THROWS both when no balanced JSON
 * can be extracted (prose / fences / truncation) AND when the parsed object fails the
 * `.strict()` adapter OUTPUT schema (an extra key, a wrong shape). The deterministic
 * MockAuthorProvider never does either — but a live frontier model will.
 *
 * BEFORE this fix the throw propagated straight out of the loop, aborting the whole
 * authoring run on the offending round with a raw, unattributed error and zero retries.
 * AFTER it, a thrown completion is treated as a NON-GREEN round: it is surfaced as an
 * `ADAPTER_OUTPUT_UNPARSEABLE` error finding fed back into the next prompt (so the model
 * can revise toward valid output) and the loop continues. Only if EVERY round fails to
 * parse does the loop throw — and then with an attributable, aggregated message rather
 * than a non-null-assertion lie on a null result.
 *
 * These witnesses pin that contract: a transient bad reply self-heals (and the revise
 * prompt actually carries the parse-error feedback), while a persistent bad backend
 * fails loudly only after exhausting the round budget.
 */
import { describe, it, expect } from "vitest";
import type { Provider, CompletionRequest } from "../../agents/llm/provider.js";
import { MockAuthorProvider } from "../../agents/authoring/mock_author.js";
import { loadEngineContract, runWriter } from "../../agents/authoring/writer.js";
import { runRpgAdapter } from "../../agents/authoring/adapter.js";
import { validateRpg } from "../../src/validate/rpg_validator.js";

const contract = loadEngineContract();
const PREMISE = "A keeper must relight a dead lighthouse before a ship wrecks.";

/**
 * Wraps a real provider but throws on the first `throwFirst` ADAPTER calls (the writer
 * call is always delegated, untouched), simulating a model that returns off-shape JSON
 * for a while before settling. Records the user payload of every DELEGATED adapter call
 * so a test can prove the revise prompt carried the parse-error feedback.
 */
class FlakyAuthorProvider implements Provider {
  readonly name = "mock:flaky-author";
  adapterCalls = 0;
  delegatedUserPayloads: string[] = [];
  constructor(
    private readonly inner: Provider,
    private readonly throwFirst: number,
  ) {}
  async completeJson<T>(req: CompletionRequest<T>): Promise<T> {
    if (req.schemaName === "WriterStory") return this.inner.completeJson(req);
    this.adapterCalls++;
    if (this.adapterCalls <= this.throwFirst) {
      // Mimics a live `completeJson`'s own failure mode (JSON extraction / strict-schema throw).
      throw new Error(`simulated off-shape model reply (adapter call ${this.adapterCalls})`);
    }
    this.delegatedUserPayloads.push(req.user);
    return this.inner.completeJson(req);
  }
}

describe("adapter revise-loop resilience (bug_0236)", () => {
  it("a TRANSIENT off-shape reply is fed back and self-heals — the run is not aborted", async () => {
    const provider = new FlakyAuthorProvider(new MockAuthorProvider(), 1);
    const story = await runWriter(provider, { premise: PREMISE, contract });

    // Before the fix this REJECTS (the round-1 throw escapes the loop). After it, the
    // loop swallows the throw, revises, and converges on the corrected pack.
    const result = await runRpgAdapter(provider, { story, contract });

    expect(result.ok).toBe(true);
    expect(result.report.ok).toBe(true);
    expect(validateRpg(result.pack).ok).toBe(true);
    // One thrown round + one successful round = exactly two adapter calls.
    expect(provider.adapterCalls).toBe(2);
    // The revise prompt actually carried the parse-error feedback (non-vacuous: proves
    // the throw became an ADAPTER_OUTPUT_UNPARSEABLE finding in prior_errors, which is
    // ALSO what flips MockAuthorProvider from its broken first draft to the fix).
    expect(provider.delegatedUserPayloads).toHaveLength(1);
    expect(provider.delegatedUserPayloads[0]).toContain("ADAPTER_OUTPUT_UNPARSEABLE");
  });

  it("a PERSISTENT off-shape backend fails loudly only AFTER exhausting the round budget", async () => {
    const provider = new FlakyAuthorProvider(new MockAuthorProvider(), 99);
    const story = await runWriter(provider, { premise: PREMISE, contract });

    await expect(runRpgAdapter(provider, { story, contract })).rejects.toThrow(
      /no schema-valid output/i,
    );
    // It exhausted the default 4-round budget rather than bailing on the first throw —
    // proving the loop genuinely retried, not crashed on round 1.
    expect(provider.adapterCalls).toBe(4);
  });

  it("the round budget is honoured for a persistent bad backend (maxRounds respected)", async () => {
    const provider = new FlakyAuthorProvider(new MockAuthorProvider(), 99);
    const story = await runWriter(provider, { premise: PREMISE, contract });

    await expect(runRpgAdapter(provider, { story, contract, maxRounds: 2 })).rejects.toThrow(
      /2 round\(s\)/,
    );
    expect(provider.adapterCalls).toBe(2);
  });
});
