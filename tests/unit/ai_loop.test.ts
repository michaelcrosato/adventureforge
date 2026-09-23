/**
 * The AFK loop driver's saturation-triggered ultraplan gate (docs/afk_loop.md).
 * Importing src/ai-loop.ts must NOT run a cycle — main() is entry-point guarded —
 * so we can unit-test the pure decision in isolation.
 */
import { describe, it, expect } from "vitest";
import {
  buildLatestCycleMetadata,
  buildPrompt,
  buildUltraplanPrompt,
  formatRecommendationConsoleLine,
  formatLoopStateAppend,
  playtestTargetSummary,
  playtestTarget,
  playtestTargetMetadata,
  FOCUSED_CHECKS_CONTRACT,
  formatLeadsSection,
  HEADLESS_TURN_CONTRACT,
  PROMPT_QUEUE_LIMIT,
  selectPromptQueue,
  selectUnverifiedLeads,
  UNVERIFIED_LEADS_LIMIT,
  shouldRunUltraplan,
} from "../../src/ai-loop.js";
import type { Submission } from "../../src/intake/submission.js";
import type { QaTicket } from "../../src/qa/ticket.js";
import {
  OVERWORLD_PLAYTEST_TARGET,
  SATURATION_FLOOR,
  type Assessment,
  type ImprovementCandidate,
} from "../../src/afk/assessor.js";

const playtestRecord = "ai-runs/2026-06-25T00-00-00-000Z/playtest.md";
const currentPlanRecord = "ai-runs/2026-06-25T00-00-00-000Z/current-plan.md";

function candidate(
  category: ImprovementCandidate["category"],
  target: string,
): ImprovementCandidate {
  return {
    id: `${category}-${target}`,
    category,
    target,
    title: `${category} candidate`,
    rationale: "test rationale",
    evidence: ["test evidence"],
    impact: 3,
    effort: category === "content_new" ? "L" : "M",
    score: 1,
  };
}

function assessment(top: ImprovementCandidate | null): Assessment {
  return {
    rpgQuestCount: 16,
    worldQuestCount: 16,
    quests: [],
    allGeneratorsClean: true,
    candidates: top ? [top] : [],
    top,
  };
}

function saturatedAssessment(top: ImprovementCandidate | null): Assessment {
  return {
    ...assessment(top),
    candidates: top ? [top] : [],
    top,
    allGeneratorsClean: true,
  };
}

describe("shouldRunUltraplan", () => {
  it("fires only when SATURATED and the cooldown has elapsed", () => {
    expect(shouldRunUltraplan(true, 8, 8)).toBe(true); // saturated, exactly at cooldown
    expect(shouldRunUltraplan(true, 12, 8)).toBe(true); // saturated, well past cooldown
  });

  it("does NOT fire while saturated but still on cooldown", () => {
    expect(shouldRunUltraplan(true, 0, 8)).toBe(false);
    expect(shouldRunUltraplan(true, 7, 8)).toBe(false);
  });

  it("never fires when not saturated, regardless of cooldown", () => {
    expect(shouldRunUltraplan(false, 0, 8)).toBe(false);
    expect(shouldRunUltraplan(false, 9999, 8)).toBe(false);
  });

  it("a cooldown of 0 means every saturated cycle fires (no throttle)", () => {
    expect(shouldRunUltraplan(true, 0, 0)).toBe(true);
    expect(shouldRunUltraplan(false, 0, 0)).toBe(false);
  });
});

describe("playtestTarget", () => {
  it("always launches a fresh overworld, independently of the recommendation category", () => {
    for (const top of [
      candidate("content_fix", "cold_forge"),
      candidate("content_new", "world"),
      candidate("engine", "src/core/engine.ts"),
      candidate("repo", "tooling"),
      null,
    ]) {
      expect(playtestTarget(top)).toBe(OVERWORLD_PLAYTEST_TARGET);
    }
  });

  it("targets the overworld when the rotation nominates the core-game opening review", () => {
    const top = candidate("content_fix", OVERWORLD_PLAYTEST_TARGET);

    expect(playtestTarget(top)).toBe(OVERWORLD_PLAYTEST_TARGET);
  });
});

describe("fresh-overworld target normalization", () => {
  it("never resolves a direct quest id or quest-labeled summary", () => {
    expect(playtestTargetSummary("cold_forge", "cold_forge")).toBe(OVERWORLD_PLAYTEST_TARGET);
    expect(playtestTargetMetadata("cold_forge", "cold_forge")).toEqual({
      target: OVERWORLD_PLAYTEST_TARGET,
    });
  });
});

describe("compact AFK handoff metadata", () => {
  it("writes latest-cycle metadata with recommendation ids instead of verbose titles", () => {
    const top = {
      ...candidate("engine", "src/core/engine.ts"),
      id: "engine-runtime-cache",
      title: "Refactor the runtime cache into something with a deliberately long title",
      rationale: "Long rationale that belongs in the prompt, not latest-cycle metadata.",
    };

    const metadata = buildLatestCycleMetadata({
      runId: "2026-07-04T00-00-00-000Z",
      target: "breaking_weir",
      targetWorldQuestId: "breaking_weir",
      playtestRecord: "ai-runs/2026-07-04T00-00-00-000Z/playtest.md",
      top,
      ultraplan: false,
      agentTimeoutSeconds: null,
    });

    expect(metadata).toMatchObject({
      target: OVERWORLD_PLAYTEST_TARGET,
      recommendationId: "engine-runtime-cache",
      recommendationCategory: "engine",
    });
    expect("targetWorldQuestId" in metadata).toBe(false);
    expect("mode" in metadata).toBe(false);
    expect("runDir" in metadata).toBe(false);
    expect("recommendation" in metadata).toBe(false);
    expect("currentPlanRecord" in metadata).toBe(false);
    expect(JSON.stringify(metadata)).not.toContain(top.title);
    expect(JSON.stringify(metadata)).not.toContain(top.rationale);
  });

  it("still records the playtest slot the seal verifies when something lands in it", () => {
    // The dev cycle stopped playing, but the slot is still a real location: the
    // feedback seal verifies ai-runs/<runId>/playtest.* in full whenever a playtest
    // IS published there, so the metadata must keep naming it.
    const metadata = buildLatestCycleMetadata({
      runId: "2026-06-25T00-00-00-000Z",
      target: OVERWORLD_PLAYTEST_TARGET,
      playtestRecord,
      top: null,
      ultraplan: false,
      agentTimeoutSeconds: null,
    });

    expect(metadata.playtestRecord).toBe(playtestRecord);
  });

  it("records the ignored per-cycle handoff only for ultraplan cycles", () => {
    const metadata = buildLatestCycleMetadata({
      runId: "2026-06-25T00-00-00-000Z",
      target: OVERWORLD_PLAYTEST_TARGET,
      playtestRecord,
      top: null,
      ultraplan: true,
      currentPlanRecord,
      agentTimeoutSeconds: 3600,
    });

    expect(metadata.currentPlanRecord).toBe(currentPlanRecord);
    expect(
      buildLatestCycleMetadata({
        runId: "2026-06-25T00-00-00-000Z",
        target: OVERWORLD_PLAYTEST_TARGET,
        playtestRecord,
        top: null,
        ultraplan: true,
        agentTimeoutSeconds: 3600,
      }).currentPlanRecord,
    ).toBe(currentPlanRecord);
  });

  it("normalizes even stale quest-target callers to an overworld launch", () => {
    expect(playtestTargetMetadata("content/rpg/quests/cold_forge.yaml", "cold_forge")).toEqual({
      target: OVERWORLD_PLAYTEST_TARGET,
    });
  });

  it("keeps automatic loop-state appends compact and free of unearned claims", () => {
    const top = {
      ...candidate("engine", "src/core/engine.ts"),
      id: "engine-runtime-cache",
      title: "Verbose title that should stay out of compact loop state",
      rationale: "Verbose rationale that should stay out of compact loop state.",
    };
    const text = formatLoopStateAppend("2026-07-04T00-00-00-000Z", assessment(top), false);

    expect(text).toContain("Rec: engine-runtime-cache (engine/M; score=1).");
    expect(text).not.toContain(top.title);
    expect(text).not.toContain(top.rationale);
    expect(text).not.toContain("Process: assessor ranks");
    // The scaffold is COMMITTED. A cycle that plays nothing must not write a per-cycle
    // playtest target or a blind-report guard into the tracked ledger — that is exactly
    // the unearned evidence claim this subsystem exists to keep out.
    expect(text).not.toContain("Playtest:");
    expect(text).not.toContain("blind report");
    expect(text).toContain("Guard: health + verify:integrity before commit.");
  });
});

/**
 * The dev cycle no longer plays the game.
 *
 * This is the regression these cases exist for, and it is not cosmetic. While the
 * prompt still ordered a blind run, a cycle that trusted the charter and skipped the
 * playtest passed every mechanical gate and was then hard-reset at the feedback seal —
 * and because only one vendor could mint the sidecar that seal demanded, a prompt that
 * says "play" is also what kept the harness vendor-locked. Experience evidence is an
 * INPUT produced asynchronously by the playtest loop (docs/two_loop_workflow.md), never
 * a condition on landing a dev cycle.
 */
function expectNoBlindPlaytestMandate(prompt: string): void {
  // The launch itself, in either prompt's phrasing.
  expect(prompt).not.toContain("npm run blind");
  expect(prompt).not.toContain("play_mode: pure");
  expect(prompt).not.toContain("start_surface: fresh_overworld");
  expect(prompt).not.toContain("Do not pass `--quest`");
  expect(prompt).not.toContain("call-count stopping rule");
  // The artifacts the runner had to publish, and the gate that bound them.
  expect(prompt).not.toContain("playtest.md");
  expect(prompt).not.toContain("playtest.run.json");
  expect(prompt).not.toContain("build/receipt sidecar");
  expect(prompt).not.toContain("report gates");
  // The step that carried the mandate, and every instruction that presumed it ran.
  expect(prompt).not.toMatch(/^## STEP -?\d+ — Play\b/mu);
  expect(prompt).not.toContain("clean evidence-only baseline");
  expect(prompt).not.toContain("pure play");
  expect(prompt).not.toContain("launch the player");
  expect(prompt).not.toContain("interview only after exit");
  expect(prompt).not.toContain("interview happens only afterward");
  expect(prompt).not.toContain("Do not edit source after play");
  expect(prompt).not.toContain("STOP without playing");
  expect(prompt).not.toContain("what you playtested");
}

/** Every `## STEP n — title` heading, in the order the prompt emits them. */
function promptSteps(prompt: string): string[] {
  return [...prompt.matchAll(/^## STEP (-?\d+) — (.+)$/gmu)].map(
    (match) => `${match[1]} — ${match[2]}`,
  );
}

/** Removing a step must renumber the rest, not leave a hole the agent has to guess at. */
function expectContiguousSteps(prompt: string, first: number): void {
  const numbers = promptSteps(prompt).map((step) => Number(step.split(" — ")[0]));
  expect(numbers.length).toBeGreaterThan(0);
  expect(numbers).toEqual(numbers.map((_value, index) => first + index));
}

describe("both prompts state the headless single-turn contract", () => {
  const standard = (): string => {
    const top = candidate("engine", "src/core/engine.ts");
    return buildPrompt({ a: assessment(top), top, commitEnabled: true });
  };
  const ultraplan = (): string =>
    buildUltraplanPrompt({
      a: saturatedAssessment(null),
      currentPlanRecord: "ai-runs/x/current-plan.md",
      commitEnabled: true,
    });

  it("tells the worker it has exactly one turn and nothing resumes it", () => {
    // A worker backgrounded its checks and ended its turn expecting a wakeup that a
    // headless run never delivers; 950 s of work was reverted and the CLI still reported
    // success. A host can unset whatever auto-backgrounds long commands, but a host
    // defends one machine and dev-agents.json invites any vendor on any machine.
    for (const prompt of [standard(), ultraplan()]) {
      expect(prompt).toContain("ONE non-interactive turn");
      expect(prompt).toContain("FOREGROUND");
      expect(prompt).toContain("ending the turn to come back later ends the CYCLE");
      expect(prompt).toContain("provisional commit must already EXIST before you finish");
    }
  });

  it("warns that the final gate counts UNTRACKED paths, naming the ones the cycle writes", () => {
    // The cycle's own triage step writes qa/tickets/*.json — tracked in git on purpose —
    // as new untracked files after the cycle started. require_final_ledger_only counts
    // untracked paths, so leaving one reverts an otherwise green cycle at the last gate.
    for (const prompt of [standard(), ultraplan()]) {
      expect(prompt).toContain("UNTRACKED");
      expect(prompt).toContain("qa/tickets");
      expect(prompt).toContain("intake/queue");
    }
    // And the commit-mode step no longer understates that gate as tracked-only.
    expect(standard()).toContain("untracked paths included, not just tracked ones");
    expect(standard()).not.toContain("must be the only tracked change after the provisional");
  });

  it("forbids running the driver's own bar inside the turn", () => {
    // A worker ran health:fast three times in one turn — roughly 17 minutes each under
    // load — and hit its 60-minute budget without landing anything. Each run re-proved the
    // bar loop.sh runs immediately afterwards on the same tree, so it bought no safety.
    for (const prompt of [standard(), ultraplan()]) {
      expect(prompt).toContain("Run FOCUSED checks only");
      expect(prompt).toContain("npm run health:fast");
      expect(prompt).toContain("Do NOT run");
      expect(prompt).toContain("loop.sh runs the bar itself");
    }
  });

  it("states the bar loop.sh actually runs, not an unconditional full health", () => {
    // The hard-constraints line used to say "`npm run health` must pass", while loop.sh
    // picks health OR health:fast off the diff via `npm run loop:bar`. A prompt that
    // overstates the gate invites a worker to run the full bar itself "to be sure".
    for (const prompt of [standard(), ultraplan()]) {
      expect(prompt).toContain("npm run loop:bar");
      expect(prompt).toMatch(/health:fast/u);
      expect(prompt).not.toContain("`npm run health` must pass");
      expect(prompt).not.toContain("`npm run health` and verify:integrity must pass");
    }
  });

  it("uses ONE contract for both prompts so they cannot drift apart", () => {
    // Two hand-maintained copies of a safety contract is how one of them goes stale.
    for (const line of [...HEADLESS_TURN_CONTRACT, ...FOCUSED_CHECKS_CONTRACT]) {
      expect(standard()).toContain(line);
      expect(ultraplan()).toContain(line);
    }
    expect(HEADLESS_TURN_CONTRACT.length).toBeGreaterThan(0);
  });
});

describe("buildPrompt surfaces unverified leads without trusting them", () => {
  /** `reportCount` is its own knob so a case can vary it without restating the whole
   *  evidence block — a partial `evidence` would not satisfy TicketEvidence and a cast
   *  around that gap would hide the very field this section filters on. */
  const ticket = (
    over: Partial<Omit<QaTicket, "evidence">> & { ticket_id: string; reportCount?: number },
  ): QaTicket => {
    const { reportCount = 2, ...rest } = over;
    return {
      schema_version: 2,
      title: `lead ${over.ticket_id}`,
      kind: "bug",
      severity: "S2",
      status: "open",
      promotion: "accumulating",
      location: "albany_city",
      excerpts: [],
      priority: 1,
      evidence: {
        report_count: reportCount,
        families: ["claude"],
        providers: ["claude_code"],
        tiers: ["volume"],
        has_runner_enforced_report: true,
        session_ids: ["s1"],
        first_seen_build: "a".repeat(40),
        last_seen_build: "a".repeat(40),
        first_seen_at: "2026-09-01T00:00:00.000Z",
        last_seen_at: "2026-09-01T00:00:00.000Z",
      },
      ...rest,
    } as QaTicket;
  };

  const promptWith = (leads: readonly QaTicket[]): string => {
    const top = candidate("engine", "src/core/engine.ts");
    return buildPrompt({ a: assessment(top), top, commitEnabled: true, leads });
  };

  it("lists an accumulating bug that two reports hit, and demands reproduction first", () => {
    // The rule this encodes: one lineage reporting a thing twenty times is one opinion
    // repeated, not two witnesses — so a lead is shown as a LEAD, never as work.
    const prompt = promptWith([
      ticket({ ticket_id: "a".repeat(16), title: "docket has no options" }),
    ]);
    expect(prompt).toContain("docket has no options");
    expect(prompt).toContain("REPRODUCE BEFORE YOU FIX");
    expect(prompt).toContain("npm run qa:triage -- --verified");
    expect(prompt).toContain("--verified-by");
    // And the honest exit when it cannot be reproduced.
    expect(prompt).toContain("not a defect you may fix on faith");
  });

  it("excludes experience tickets, single reports, and anything already promoted", () => {
    // An experience judgement cannot be settled by a test, so offering one here would invite
    // exactly the faith-based fix the section exists to prevent.
    expect(
      selectUnverifiedLeads([
        ticket({ ticket_id: "b".repeat(16), kind: "experience" }),
        ticket({ ticket_id: "c".repeat(16), reportCount: 1 }),
        ticket({ ticket_id: "d".repeat(16), promotion: "corroborated" }),
        ticket({ ticket_id: "e".repeat(16), promotion: "verified" }),
        ticket({ ticket_id: "f".repeat(16), status: "wont_fix" }),
        ticket({ ticket_id: "0".repeat(16), superseded_by: ["1".repeat(16)] }),
      ]),
    ).toEqual([]);
  });

  it("caps the listing so one noisy bucket cannot flood the prompt", () => {
    const many = Array.from({ length: UNVERIFIED_LEADS_LIMIT + 4 }, (_unused, index) =>
      ticket({ ticket_id: `${index}`.padStart(16, "a"), priority: index }),
    );
    expect(selectUnverifiedLeads(many)).toHaveLength(UNVERIFIED_LEADS_LIMIT);
  });

  it("says nothing at all when there is no lead to show", () => {
    // Silence is right here, unlike the queue: an empty bucket is not a state the worker
    // has to reason about, and a permanent empty heading is noise in every prompt.
    expect(formatLeadsSection([])).toEqual([]);
    expect(promptWith([])).not.toContain("Unverified leads");
  });
});

describe("buildPrompt carries the intake queue", () => {
  const NOW = new Date("2026-09-05T21:00:00.000Z");
  const submission = (over: Partial<Submission> & { id: string }): Submission =>
    ({
      title: `work ${over.id}`,
      priority: "P2",
      source: "playtest",
      kind: "bug",
      status: "open",
      created_at: "2026-09-01T00:00:00.000Z",
      evidence: { summary: "", refs: [], lineages: [], observations: 1 },
      ...over,
    }) as Submission;

  const promptFor = (queue: readonly Submission[]): string => {
    const top = candidate("engine", "src/core/engine.ts");
    return buildPrompt({ a: assessment(top), top, queue });
  };

  it("names the open queue ahead of the assessor's ranking, with the claim commands", () => {
    // The defect this closes: the worker is a fresh process reading only STDIN, so a queue
    // printed to the cycle log reaches nobody. Order matters as much as presence — the
    // charter puts somebody's actual request ahead of a candidate the assessor synthesized.
    const prompt = promptFor([
      submission({ id: "b".repeat(16), priority: "P2", title: "split the overworld JSON" }),
      submission({ id: "a".repeat(16), priority: "P1", title: "cattle alarm stays 0" }),
    ]);

    expect(prompt).toContain("cattle alarm stays 0");
    expect(prompt).toContain("a".repeat(16));
    expect(prompt).toContain("npm run work -- --claim <id>");
    expect(prompt).toContain("npm run work -- --done <id>");
    // --done writes intake/queue/, so it must precede the freeze or the ledger-only gate trips.
    expect(prompt).toContain("BEFORE the provisional commit");
    expect(prompt.indexOf("intake queue")).toBeLessThan(prompt.indexOf("The assessor's"));
    // Priority decides the order, not file order or the order the caller happened to pass.
    expect(prompt.indexOf("cattle alarm stays 0")).toBeLessThan(
      prompt.indexOf("split the overworld JSON"),
    );
  });

  it("keeps the selection marker honest for off-list queue work", () => {
    // A queue item is not an assessor candidate, so claiming its id would make the sealed
    // acceptance marker assert a candidate the cycle never implemented.
    expect(promptFor([submission({ id: "c".repeat(16) })])).toContain(
      "leave `selected_recommendation_id` null",
    );
  });

  it("hides work another lane holds, and shows it again once the lease expires", () => {
    const held = submission({
      id: "d".repeat(16),
      status: "in_progress",
      claimed_by: "some-other-lane",
      claimed_at: "2026-09-05T20:00:00.000Z",
      title: "held by a live lane",
    });
    const expired = { ...held, claimed_at: "2026-09-01T00:00:00.000Z" };

    // Two lanes building the same item is the exact waste claims exist to stop...
    expect(selectPromptQueue([held], { identity: "dev-opus-lane", now: NOW }).shown).toEqual([]);
    // ...but a crashed lane must not hold work hostage past its lease.
    expect(
      selectPromptQueue([expired], { identity: "dev-opus-lane", now: NOW }).shown,
    ).toHaveLength(1);
    // Our own claim is ours to keep working.
    expect(
      selectPromptQueue([{ ...held, claimed_by: "dev-opus-lane" }], {
        identity: "dev-opus-lane",
        now: NOW,
      }).shown,
    ).toHaveLength(1);
  });

  it("drops resolved and superseded items", () => {
    // Supersession sets status "declined"; done/stale are equally not work.
    const closed = (["done", "declined", "stale"] as const).map((status, index) =>
      submission({ id: `${index}`.repeat(16), status }),
    );
    expect(selectPromptQueue(closed, { identity: "dev-opus-lane", now: NOW }).available).toBe(0);
    expect(promptFor(closed)).toContain("normal state, not a stall");
  });

  it("caps the listing and points at the CLI for the rest", () => {
    const queue = Array.from({ length: PROMPT_QUEUE_LIMIT + 5 }, (_unused, index) =>
      submission({ id: `${index}`.padStart(16, "0"), title: `queued item ${index}` }),
    );
    const prompt = promptFor(queue);

    expect(prompt).toContain(`queued item ${PROMPT_QUEUE_LIMIT - 1}`);
    expect(prompt).not.toContain(`queued item ${PROMPT_QUEUE_LIMIT}`);
    expect(prompt).toContain("5 more");
  });

  it("says an empty queue is normal instead of staying silent about it", () => {
    // Silence reads as "nothing was checked". The charter is explicit that empty is normal.
    const prompt = promptFor([]);
    expect(prompt).toContain("normal state, not a stall");
    expect(prompt).not.toContain("--claim");
  });
});

describe("buildPrompt drops the blind-playtest mandate", () => {
  it.each([
    ["content_fix", "cold_forge"],
    ["engine", "src/core/engine.ts"],
    ["repo", "tooling"],
  ] as const)("%s evidence-only cycles improve without playing", (category, target) => {
    const top = candidate(category, target);
    const prompt = buildPrompt({ a: assessment(top), top });

    expect(promptSteps(prompt)).toEqual([
      "1 — Make ONE uncommitted improvement",
      "2 — Self-critique, run focused checks, and record evidence",
    ]);
    expectContiguousSteps(prompt, 1);
    expect(prompt).toContain(
      "one focused, high-impact AdventureForge maintenance improvement within this repo",
    );
    // The clean-tree requirement is NOT the playtest: loop.sh still measures an
    // evidence-only cycle against its clean starting ref, so it has to survive.
    expect(prompt).toContain("`git status --porcelain` to");
    expect(prompt).toContain("STOP without editing anything");
    expect(prompt).not.toContain("FULL authority");
    expectNoBlindPlaytestMandate(prompt);
  });

  it("keeps a quest-specific work recommendation without a launch instruction", () => {
    const top = {
      ...candidate("content_fix", "cold_forge"),
      title: 'Fix quest "cold_forge" — two validator warnings',
      rationale: "The recommended edit is deliberately quest-specific.",
    };
    const prompt = buildPrompt({ a: assessment(top), top });

    expect(prompt).toContain('Recommended: Fix quest "cold_forge"');
    expect(prompt).not.toContain("Playtest launch this cycle: cold_forge");
    expectNoBlindPlaytestMandate(prompt);
  });

  it("keeps a saturated floor pick executable without presenting strategic direction", () => {
    const top = {
      ...candidate("content_fix", "wolf_winter"),
      title: 'Maintenance rotation: review quest "wolf_winter"',
      score: SATURATION_FLOOR,
    };
    const a = saturatedAssessment(top);
    const prompt = buildPrompt({ a, top });
    const ultraplan = buildUltraplanPrompt({ a, currentPlanRecord });

    expect(formatRecommendationConsoleLine(a)).toContain("maintenance rotation only");
    expect(formatRecommendationConsoleLine(a)).toContain("no strategic recommendation");
    expect(formatRecommendationConsoleLine(a)).not.toContain("next best improvement");

    expect(prompt).toContain("maintenance rotation (deterministic; not strategic direction)");
    expect(prompt).toContain("floor candidate remains executable routine maintenance");
    expect(prompt).not.toContain("▶ Recommended:");
    expect(prompt).not.toContain("ranked next-best improvements");

    expect(ultraplan).toContain("maintenance floor, not strategic direction");
    expect(ultraplan).toContain("Do not carry this floor ordering into the ultraplan");
    expect(ultraplan).toContain("independently selects and justifies the structural re-aim");
    expect(ultraplan).not.toContain("▶ Recommended:");
    expectNoBlindPlaytestMandate(prompt);
    expectNoBlindPlaytestMandate(ultraplan);
  });

  it("the rotation's core-game opening review still orders no playtest of its own", () => {
    const top = candidate("content_fix", OVERWORLD_PLAYTEST_TARGET);
    const prompt = buildPrompt({ a: assessment(top), top });

    expectNoBlindPlaytestMandate(prompt);
  });

  it("content_new cycles author without a baseline run", () => {
    const top = candidate("content_new", "world");
    const prompt = buildPrompt({ a: assessment(top), top });

    expect(prompt).toContain("content_new: add and register one world-graph RPG quest");
    expectNoBlindPlaytestMandate(prompt);
  });

  it("commit-enabled cycles go improvement → provisional commit → ledger, with no play step", () => {
    const top = candidate("content_new", "world");
    const prompt = buildPrompt({ a: assessment(top), top, commitEnabled: true });

    expect(promptSteps(prompt)).toEqual([
      "1 — Make ONE improvement",
      "2 — Self-critique, run focused checks, and commit provisionally",
      "3 — Compile only at the real threshold, then finish the ledger",
    ]);
    expectContiguousSteps(prompt, 1);
    const improve = prompt.indexOf("## STEP 1 — Make ONE improvement");
    const provisional = prompt.indexOf("PROVISIONAL commit");
    // Re-pointed, not relaxed: the ledger step is now stated in terms of the gate that
    // actually runs, which counts untracked paths too. The ORDER it pins is unchanged.
    const ledger = prompt.indexOf(
      "After the provisional commit, AI_LOOP_STATE.md must be the only thing left",
    );
    expect(improve).toBeGreaterThanOrEqual(0);
    expect(provisional).toBeGreaterThan(improve);
    expect(ledger).toBeGreaterThan(provisional);
    // bug: a worker read STEP 3's old "Do not commit it" as "never commit the ledger",
    // committed ten correct src/world files with NO AI_LOOP_STATE.md, and lost the whole
    // cycle to the attestation gate. STEP 2 now states the requirement positively and
    // hands the worker the SAME command loop.sh runs, so the turn cannot end red on a
    // check the worker could have run itself. Pin both halves.
    expect(prompt).toContain("The provisional commit MUST INCLUDE AI_LOOP_STATE.md");
    expect(prompt).toContain(
      "npm run --silent loop:seal-feedback -- --check-attestation --meta ai-runs/latest-cycle.json",
    );
    expect(prompt).toContain("Never end the turn on");
    // STEP 3 still withholds the COMPLETION, and must not be re-readable as withholding
    // the file: the words that caused the loss are gone.
    expect(prompt).toContain("Leave THIS COMPLETION uncommitted");
    expect(prompt).not.toContain("Do not commit it.");
    expect(prompt).toContain("Never push");
    expect(prompt).toContain("npm run feedback:status");
    expect(prompt).toContain("only when status says ready");
    expect(prompt).toContain("Deterministic structural mocks never satisfy");
    // The compiler is not left looking starved: the prompt says whose corpus it is.
    expect(prompt).toContain("This cycle plays nothing and contributes no report of its own");
    expect(prompt).toContain("the playtest loop");
    expectNoBlindPlaytestMandate(prompt);
  });
});

describe("buildUltraplanPrompt drops the blind-playtest mandate", () => {
  it("uses an ignored sole handoff and commits provisionally without playing", () => {
    const prompt = buildUltraplanPrompt({
      a: saturatedAssessment(null),
      currentPlanRecord,
      commitEnabled: true,
    });

    expect(promptSteps(prompt)).toEqual([
      "0 — Read the decision log FIRST (docs/DECISION_LOG.md)",
      "1 — Run a LOCAL-ONLY ULTRAPLAN (multi-agent if available)",
      "2 — Persist the decision and the ignored per-cycle handoff",
      "3 — Implement in a FRESH context",
      "4 — Run focused checks and create the LOCAL provisional commit",
      "5 — Compile only at the real threshold, then finish the ledger",
    ]);
    expectContiguousSteps(prompt, 0);
    expect(prompt).toContain("one focused AdventureForge maintenance improvement");
    expect(prompt).not.toContain("FULL authority");
    expect(prompt).toContain(currentPlanRecord);
    expect(prompt).toContain("ONLY fresh-agent handoff");
    expect(prompt).toContain("Never write it into a tracked doc");
    expect(prompt).not.toContain("CURRENT_PLAN");
    expect(prompt).toContain("npm run feedback:status");
    expect(prompt).toContain("compile only when it reports ready");
    expect(prompt).toContain("Deterministic structural mocks never meet the threshold");
    expect(prompt).toContain("this cycle adds no report of its own");
    expectNoBlindPlaytestMandate(prompt);
  });

  it("still demands an exactly clean tree when ultraplan commits are disabled", () => {
    const prompt = buildUltraplanPrompt({ a: saturatedAssessment(null), currentPlanRecord });

    expect(prompt.indexOf("STEP -1")).toBeLessThan(prompt.indexOf("STEP 0"));
    expectContiguousSteps(prompt, -1);
    expect(prompt).toContain("`git status --porcelain` to be exactly empty");
    expect(prompt).toContain("STOP without editing");
    expect(prompt).toContain("Do not commit or push");
    expectNoBlindPlaytestMandate(prompt);
  });
});
