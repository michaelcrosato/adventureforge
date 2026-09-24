/**
 * Fault-injection acceptance suite (Task 9) — proves the mechanical crawler
 * actually CATCHES planted defects, end to end. Each test plants one bug in a
 * freshly generated pack (never a shipped one) using the exact mutation/wrapper
 * recipes first proven in the since-retired crawl_quest_crawler unit suite, then asserts:
 *  (a) the crawl reports exactly the right finding code, and
 *  (b) the finding's ddmin-minimized repro trace re-triggers the SAME finding
 *      fingerprint via `reproducesFingerprint` — the repro is real, not a stub.
 *
 * Repro contract (documented on `reproducesFingerprint`, Task 6): a CRASH
 * caused by `step` itself throwing records a trace whose `actions` array OMITS
 * the triggering action (the crawler breaks before pushing it so the trace
 * stays safely replayable) — replaying the trace alone won't reproduce it, so
 * the helper appends `finding.action` when the direct replay comes up empty.
 * RENDER / INTEGRITY / PERSIST / both SOFTLOCK forms keep their trigger in the
 * trace and self-reproduce. SOFTLOCK(solver) reproduction additionally needs
 * the same solver budget the finding was produced with.
 */
import { describe, expect, it } from "vitest";
import type { RpgAction } from "../../src/api/types.js";
import { generateRpgPack } from "../../src/gen/rpg_generator.js";
import { findingFingerprint, type CrawlFindingCode } from "../../src/crawl/findings.js";
import { reproducesFingerprint } from "../../src/crawl/minimize.js";
import { preparePack, type PreparedQuest } from "../../src/crawl/prepare.js";
import { crawlQuest, type QuestCrawlResult } from "../../src/crawl/quest_crawler.js";

// Same seeds/steps the unit suite proved fast and defect-triggering (Tasks 4-5);
// only the commit tag differs (metadata only — it never affects behavior).
const CRAWL = { seed: 11, maxSteps: 400, policy: "mixed" as const, commit: "fault-injection" };

const SOLVER_BUDGET = 20000;

function assertCaughtWithRepro(
  r: QuestCrawlResult,
  code: CrawlFindingCode,
  prepared: PreparedQuest,
): void {
  const f = r.findings.find((x) => x.code === code);
  expect(f, `expected a ${code} finding`).toBeDefined();
  expect(f!.repro.kind).toBe("rpg-trace");
  expect(f!.repro.minimized).toBe(true);

  const trace = f!.repro.trace as { seed: number; actions: RpgAction[] };
  const fingerprint = findingFingerprint(f!);
  // SOFTLOCK(solver) needs the budget it was found with; harmless for S4.
  const opts = { solverBudget: code === "SOFTLOCK" ? SOLVER_BUDGET : 0 };

  const reproduced =
    reproducesFingerprint(prepared, trace.seed, trace.actions, fingerprint, opts) ||
    // Step-throw CRASH traces omit the trigger action (see module doc above).
    (f!.action != null &&
      reproducesFingerprint(
        prepared,
        trace.seed,
        [...trace.actions, f!.action as RpgAction],
        fingerprint,
        opts,
      ));
  expect(reproduced, `minimized repro must re-trigger the ${code} fingerprint`).toBe(true);
}

describe("fault injection: the crawler catches planted defects", () => {
  it("catches a planted CRASH (throwing resolver)", () => {
    const prepared = preparePack(generateRpgPack(3), {
      wrapRules: (rules) => ({
        ...rules,
        resolve: (state, action) => {
          if (action.type === "TAKE") throw new Error("fault: take explodes");
          return rules.resolve(state, action);
        },
      }),
    });
    const r = crawlQuest(prepared, CRAWL);
    assertCaughtWithRepro(r, "CRASH", prepared);
  });

  // This leg runs a 20k-state solver repeatedly (~24s isolated) against the 60s
  // global testTimeout (vitest.config.ts) — thin headroom under CI suite
  // contention (repo precedent: bug_0237, see vitest.config.ts's comment on
  // `testTimeout`). Explicit 120s per-test timeout removes the flake risk
  // without loosening correctness.
  it("catches a planted SOFTLOCK (one-way pit)", () => {
    const pack = generateRpgPack(7);
    // "cell" (src/gen/rpg_generator.ts) is a reachable, non-start, non-terminal
    // dead end off "hall". Stripping its exits makes it a genuine one-way pit —
    // LOOK/INVENTORY/TAKE-the-ward stay legal there (so the immediate S4
    // zero-actions form never fires), but no route out exists: only the solver
    // oracle can prove the endings unreachable.
    const cell = pack.rooms.find((room) => room.id === "cell")!;
    cell.exits = [];
    const prepared = preparePack(pack);
    const r = crawlQuest(prepared, {
      ...CRAWL,
      seed: 5,
      maxSteps: 1500,
      solverBudget: SOLVER_BUDGET,
    });
    assertCaughtWithRepro(r, "SOFTLOCK", prepared);
  }, 120_000);

  it("catches a planted RENDER defect (unresolved template + [object Object])", () => {
    const pack = generateRpgPack(3);
    // pack.rooms is an array (src/rpg/schema.ts); mutate the plain object AFTER
    // schema parse. The first non-start room is "hall", one MOVE from the start.
    const room = pack.rooms.find((r) => r.id !== pack.meta.start_room)!;
    room.description = "A {{macro}} of [object Object].";
    const prepared = preparePack(pack);
    const r = crawlQuest(prepared, { ...CRAWL, maxSteps: 600 });
    assertCaughtWithRepro(r, "RENDER", prepared);
    expect(r.findings.find((f) => f.code === "RENDER")!.location.sceneId).toBe(room.id);
  });

  // The two legs below plant into fields the RENDER oracle was blind to until it walked
  // the whole observation: an object's display name and an exit's authored `locked_msg`.
  // Neither is ever emitted as a narration event and the schemas only demand min(1)
  // strings, so before the oracle widened, both rendered straight to the player through
  // a fully green bar. Keep them separate from the description leg so each field has its
  // own witness rather than sharing one.
  it("catches a planted RENDER defect in an object display name", () => {
    const pack = generateRpgPack(3);
    // "bar" sits in "hall" (src/gen/rpg_generator.ts), one MOVE from the start room, so
    // a mixed-policy crawl sees it almost immediately.
    const object = pack.objects.find((o) => o.id === "bar")!;
    object.name = "a {{macro}} gad-bar";
    const prepared = preparePack(pack);
    // 150 steps rather than the 600 the description leg uses: the defect is one MOVE
    // away, and a longer crawl only lengthens the trace ddmin has to minimize.
    const r = crawlQuest(prepared, { ...CRAWL, maxSteps: 150 });
    assertCaughtWithRepro(r, "RENDER", prepared);
    const finding = r.findings.find((f) => f.code === "RENDER")!;
    expect(finding.location.sceneId).toBe("hall");
    expect(finding.message).toContain("visible object bar name");
  });

  it("catches a planted RENDER defect in a blocked exit's locked_msg", () => {
    const pack = generateRpgPack(3);
    // "gallery" is two MOVEs from the start and its east exit stays blocked while the
    // rock-golem stands, so the authored locked_msg renders on every look from there.
    const gallery = pack.rooms.find((room) => room.id === "gallery")!;
    const blocked = gallery.exits.find((exit) => exit.direction === "east")!;
    blocked.locked_msg = "The way east is barred by ${lock.name} until undefined.";
    const prepared = preparePack(pack);
    const r = crawlQuest(prepared, { ...CRAWL, maxSteps: 600 });
    assertCaughtWithRepro(r, "RENDER", prepared);
    const finding = r.findings.find((f) => f.code === "RENDER")!;
    expect(finding.location.sceneId).toBe("gallery");
    expect(finding.message).toContain("blocked exit east message");
  });

  it("catches planted state corruption (INTEGRITY or CRASH — engine may throw first)", () => {
    const prepared = preparePack(generateRpgPack(4), {
      wrapRules: (rules) => ({
        ...rules,
        resolve: (state, action) => {
          const res = rules.resolve(state, action);
          if (action.type === "MOVE" && res) {
            return {
              ...res,
              effects: [
                ...res.effects,
                { type: "add_item", item: "ghost_item_not_in_pack" } as never,
              ],
            };
          }
          return res;
        },
      }),
    });
    const r = crawlQuest(prepared, CRAWL);
    const f = r.findings.find((x) => x.code === "INTEGRITY" || x.code === "CRASH");
    expect(f, "expected an INTEGRITY or CRASH finding").toBeDefined();
    assertCaughtWithRepro(r, f!.code, prepared);
  });
});
