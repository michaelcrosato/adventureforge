/**
 * AdventureForge AFK loop driver (trust-but-verify).
 *
 * One cycle of the autonomous improvement loop. This driver is deterministic
 * tooling (not the engine): it
 *   1. ASSESSES the whole project (src/afk/assessor.ts) to distinguish strategic
 *      recommendations from routine maintenance rotation across content / engine / repo;
 *   2. records the CORE GAME — the overworld from a fresh start — as the launch
 *      contract for this build, independently of which quest/code target the
 *      assessor recommends;
 *   3. writes the cycle artifacts to an ignored ai-runs/<id>/ dir, including the
 *      exact path a playtest of this revision would occupy if one is published; and
 *   4. emits a cycle prompt: commit-enabled cycles make ONE focused improvement and
 *      freeze it in a local provisional commit; evidence-only cycles make the same
 *      one improvement without committing it.
 *
 * THE CYCLE NO LONGER PLAYS THE GAME. That coupling is what the two-loop split
 * removed (docs/two_loop_workflow.md): experience evidence is an INPUT to a dev cycle,
 * produced asynchronously by the playtest loop and its fleet, never a condition on
 * landing one. loop.sh has no playtest gate left (require_playtest_record is gone) and
 * the feedback acceptance seal treats ai-runs/<id>/playtest.{md,evidence.jsonl,run.json}
 * as OPTIONAL — verified in full when present, absent without penalty when not. What
 * still gates a cycle is mechanical and vendor-neutral: post-crawl, `npm run health`,
 * and the integrity drift check. See docs/afk_loop.md for the whole picture.
 */
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assess,
  assessmentRecommendationKind,
  formatAssessment,
  isSaturated,
  OVERWORLD_PLAYTEST_TARGET,
  type Assessment,
  type ImprovementCandidate,
} from "./afk/assessor.js";
import { rotateLoopState } from "./afk/loop_state.js";
import { formatFeedbackCycleSelectionMarker } from "./feedback/acceptance.js";
import { claimLeaseHours, readQueue, resolveClaimIdentity } from "./intake/queue.js";
import { compareTickets, type QaTicket } from "./qa/ticket.js";
import { readTickets } from "./qa/ticket_store.js";
import { compareSubmissions, isOpenWork, type Submission } from "./intake/submission.js";

// ── Saturation-triggered ultraplan (docs/afk_loop.md) ──────────────────────────
// When the deterministic assessor runs dry (isSaturated), a cycle re-aims the
// project with a bounded multi-agent ultraplan instead of another routine polish
// pass — but no more than once every COOLDOWN cycles, so persistent saturation
// can't make every ~15-min cycle spend a 4–6-agent ultraplan. State lives in an
// ignored ai-runs marker; the ultraplan cycle also gets a larger agent budget.
const ULTRAPLAN_COOLDOWN = Number(process.env.AI_LOOP_ULTRAPLAN_COOLDOWN ?? 8);
const ULTRAPLAN_TIMEOUT_SECONDS = Number(process.env.AI_LOOP_ULTRAPLAN_TIMEOUT_SECONDS ?? 3600);
// Authoring a brand-new quest (content_new) is L-effort: it writes a quest +
// validates + locks tests (no playtest — the dev loop never plays), and was
// observed to hit loop.sh's
// default 2400s routine budget (twice) and get terminated mid-author, wasting the
// cycle. Give content_new cycles the SAME larger budget as ultraplan cycles via the
// existing per-cycle agentTimeoutSeconds override loop.sh already reads. Routine
// content_fix cycles keep the lean default (a one-spot prose fix never needs more).
const AUTHORING_TIMEOUT_SECONDS = Number(process.env.AI_LOOP_AUTHORING_TIMEOUT_SECONDS ?? 3600);
const SATURATION_STATE_FILE = join("ai-runs", "saturation-state.json");
const CURRENT_PLAN_DOC = "docs/CURRENT_PLAN.md";
// CURRENT_PLAN_DOC is a durable strategic router. Each ultraplan writes its sole
// fresh-agent handoff to ignored ai-runs/<cycle>/current-plan.md instead of
// replacing that router. The append-only decision log remains the reviewers'
// "already closed" boundary across cycles.
const DECISION_LOG_DOC = "docs/DECISION_LOG.md";

/** Pure decision: should THIS cycle run an ultraplan? Saturated AND off cooldown. */
export function shouldRunUltraplan(
  saturated: boolean,
  cyclesSinceUltraplan: number,
  cooldown: number,
): boolean {
  return saturated && cyclesSinceUltraplan >= cooldown;
}

function readCyclesSinceUltraplan(): number {
  try {
    const v = JSON.parse(readFileSync(SATURATION_STATE_FILE, "utf8")).cyclesSinceUltraplan;
    return typeof v === "number" ? v : ULTRAPLAN_COOLDOWN;
  } catch {
    // No marker yet → allow an ultraplan immediately if the repo is already saturated.
    return ULTRAPLAN_COOLDOWN;
  }
}

function cycleStamp(): string {
  // Tooling (not the engine), so a wall-clock id is fine here.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function requirePlayableWorldQuest(quests: readonly { playable: boolean }[]): void {
  // The overworld discovers and bridges into shipped quests, so a build worth handing
  // to the playtest loop still needs at least one playable quest in the world registry.
  // The dev cycle no longer plays it itself, but shipping a world nobody CAN play would
  // starve the other loop of anything to report on.
  if (!quests.some((quest) => quest.playable)) {
    throw new Error("AFK loop requires at least one shipped RPG quest in the overworld registry.");
  }
}

/** True when a playtest target means the CORE GAME (overworld fresh start), not one quest. */
export function isOverworldPlaytestTarget(target: string | null | undefined): boolean {
  return target === OVERWORLD_PLAYTEST_TARGET;
}

/**
 * Any live playtest of this build launches the CORE GAME from a fresh overworld
 * start. The assessor's recommendation remains independent: it may still name a
 * quest to inspect or edit, but it never becomes a drop-in launch.
 */
export function playtestTarget(
  _top: ImprovementCandidate | null,
): typeof OVERWORLD_PLAYTEST_TARGET {
  return OVERWORLD_PLAYTEST_TARGET;
}

type LatestCycleMetadata = {
  runId: string;
  target: typeof OVERWORLD_PLAYTEST_TARGET;
  playtestRecord: string;
  recommendationId: string | null;
  recommendationCategory: ImprovementCandidate["category"] | null;
  currentPlanRecord?: string;
  agentTimeoutSeconds?: number;
};

export function playtestTargetMetadata(
  _target: string,
  _targetWorldQuestId?: string | null,
): {
  target: typeof OVERWORLD_PLAYTEST_TARGET;
} {
  // Normalize stale/manual callers too: latest-cycle metadata is a launch
  // contract, not a mirror of the assessor's recommendation target.
  return { target: OVERWORLD_PLAYTEST_TARGET };
}

/** Loop-state summaries describe the actual launch, not the recommended edit target. */
export function playtestTargetSummary(
  _target: string,
  _targetWorldQuestId?: string | null,
): typeof OVERWORLD_PLAYTEST_TARGET {
  return OVERWORLD_PLAYTEST_TARGET;
}

export function buildLatestCycleMetadata(ctx: {
  runId: string;
  target: string;
  /** Accepted only to normalize stale callers; never emitted. */
  targetWorldQuestId?: string | null;
  playtestRecord: string;
  top: ImprovementCandidate | null;
  ultraplan: boolean;
  currentPlanRecord?: string | null;
  agentTimeoutSeconds: number | null;
}): LatestCycleMetadata {
  const metadata: LatestCycleMetadata = {
    runId: ctx.runId,
    ...playtestTargetMetadata(ctx.target, ctx.targetWorldQuestId),
    playtestRecord: ctx.playtestRecord,
    recommendationId: ctx.top?.id ?? null,
    recommendationCategory: ctx.top?.category ?? null,
  };
  if (ctx.ultraplan) {
    metadata.currentPlanRecord = ctx.currentPlanRecord ?? `ai-runs/${ctx.runId}/current-plan.md`;
  }
  if (ctx.agentTimeoutSeconds !== null) metadata.agentTimeoutSeconds = ctx.agentTimeoutSeconds;
  return metadata;
}

function main(): void {
  const root = process.cwd();
  const commitEnabled = process.env.AI_LOOP_COMMIT === "1";
  // Keep the loop log token-small: archive all but the most recent cycles before we
  // assess and hand the prompt to the agent. Evidence-only cycles leave the tracked
  // tree untouched, so their rotation happens at the end of the cycle instead.
  if (commitEnabled) rotateLoopState(root);
  const stamp = cycleStamp();
  const runDir = join("ai-runs", stamp);
  mkdirSync(runDir, { recursive: true });

  const a = assess(root);
  const top = a.top;
  requirePlayableWorldQuest(a.quests);
  const target = playtestTarget(top);
  const playtestRecord = join(runDir, "playtest.md").replaceAll("\\", "/");

  // Saturation-triggered ultraplan: re-aim with a multi-agent ultraplan only when
  // the cheap assessor has run dry AND we're off the cooldown.
  const saturated = isSaturated(a);
  const cyclesSince = readCyclesSinceUltraplan();
  const ultraplan = shouldRunUltraplan(saturated, cyclesSince, ULTRAPLAN_COOLDOWN);
  const currentPlanRecord = ultraplan
    ? join(runDir, "current-plan.md").replaceAll("\\", "/")
    : null;

  const prompt = ultraplan
    ? buildUltraplanPrompt({ a, currentPlanRecord: currentPlanRecord!, commitEnabled })
    : buildPrompt({
        a,
        top,
        commitEnabled,
        queue: readQueue().submissions,
        leads: readTickets().tickets,
      });

  // Per-cycle agent budget: ultraplan (multi-agent re-aim) and content_new (L-effort
  // quest authoring) both need more than the lean routine default; loop.sh reads this
  // agentTimeoutSeconds override and falls back to its own default when absent.
  const agentTimeoutSeconds = ultraplan
    ? ULTRAPLAN_TIMEOUT_SECONDS
    : top?.category === "content_new"
      ? AUTHORING_TIMEOUT_SECONDS
      : null;

  // Artifacts (all under the ignored ai-runs/).
  writeFileSync(join(runDir, "assessment.md"), formatAssessment(a));
  writeFileSync(join(runDir, "assessment.json"), JSON.stringify(a, null, 2));
  writeFileSync(join(runDir, "prompt.md"), prompt);
  // Stable pointer loop.sh and the feedback seal read for this cycle's run id, its
  // per-cycle agent timeout (ultraplan cycles get a larger budget), and the slot a
  // playtest of this exact revision would occupy. The slot is a location, not an
  // obligation: the seal verifies it in full if something lands there and seals the
  // acceptance marker alone if nothing does.
  writeFileSync(
    join("ai-runs", "latest-cycle.json"),
    JSON.stringify(
      buildLatestCycleMetadata({
        runId: stamp,
        target,
        playtestRecord,
        top,
        ultraplan,
        currentPlanRecord,
        agentTimeoutSeconds,
      }),
      null,
      2,
    ),
  );
  // Advance the cooldown marker (reset to 0 on an ultraplan cycle, else count up).
  writeFileSync(
    SATURATION_STATE_FILE,
    JSON.stringify({ saturated, cyclesSinceUltraplan: ultraplan ? 0 : cyclesSince + 1 }, null, 2),
  );
  // In commit-enabled mode this scaffold is included in the provisional commit, then
  // completed after the outer gates as the final ledger-only commit. Evidence-only mode
  // must begin with an exact-clean tree, so its agent appends the entry at the end.
  if (commitEnabled) {
    appendFileSync(
      "AI_LOOP_STATE.md",
      formatLoopStateAppend(stamp, a, ultraplan, currentPlanRecord),
    );
  }

  console.log(`AFK cycle ${stamp}${ultraplan ? "  [ULTRAPLAN MODE — assessor saturated]" : ""}`);
  console.log(`  assessment: ${runDir}/assessment.md`);
  console.log(`  prompt:     ${runDir}/prompt.md`);
  console.log(`  playtest slot (optional, unused by this loop): ${playtestRecord}`);
  if (ultraplan) console.log(`  ⟳ saturation re-aim → ultraplan; handoff → ${currentPlanRecord}`);
  console.log(formatRecommendationConsoleLine(a));
}

/** Honest one-line assessor status for the CLI without changing cycle execution. */
export function formatRecommendationConsoleLine(a: Assessment): string {
  const kind = assessmentRecommendationKind(a);
  if (kind === "strategic") return `  ▶ next best improvement: ${a.top!.title}`;
  if (kind === "maintenance") {
    return `  ↻ maintenance rotation only — no strategic recommendation: ${a.top!.title}`;
  }
  return "  • no strategic recommendation (the assessor produced no candidate)";
}

/** How many queued items the prompt names before deferring to `npm run work -- --list`. */
export const PROMPT_QUEUE_LIMIT = 12;

/**
 * A LIVE claim by a different lane — the one reason an open item is not this cycle's to take.
 *
 * The lease rules mirror `claimSubmission` exactly, including the awkward case: a claim with
 * no timestamp cannot prove freshness, so it counts as expired rather than as a hold. Being
 * stricter here than the claim path would advertise work the worker is then refused, and being
 * looser would advertise work another lane is actively building.
 */
function heldByAnotherLane(
  submission: Submission,
  identity: string,
  leaseHours: number,
  now: Date,
): boolean {
  if (submission.status !== "in_progress") return false;
  if (!submission.claimed_by || submission.claimed_by === identity) return false;
  if (!submission.claimed_at) return false;
  return (now.getTime() - Date.parse(submission.claimed_at)) / 3_600_000 < leaseHours;
}

/**
 * The slice of the queue this cycle should actually be offered.
 *
 * Sorted here rather than trusted from the caller: `compareSubmissions` is the queue's own
 * order — priority first, then weight of evidence, then age — and the prompt must not invent
 * a second one. Declined and done items (which is what supersession produces) are already
 * outside `isOpenWork`.
 */
export function selectPromptQueue(
  submissions: readonly Submission[],
  options: { identity?: string; leaseHours?: number; now?: Date; limit?: number } = {},
): { shown: Submission[]; available: number } {
  const identity = options.identity ?? resolveClaimIdentity();
  const leaseHours = options.leaseHours ?? claimLeaseHours();
  const now = options.now ?? new Date();
  const available = submissions
    .filter((submission) => isOpenWork(submission))
    .filter((submission) => !heldByAnotherLane(submission, identity, leaseHours, now))
    .sort(compareSubmissions);
  return {
    shown: available.slice(0, options.limit ?? PROMPT_QUEUE_LIMIT),
    available: available.length,
  };
}

/**
 * The intake queue, IN THE PROMPT.
 *
 * `loop.sh` has always printed the queue at cycle start, but it prints it to the cycle LOG —
 * and the worker is a fresh headless process whose entire world is this string on STDIN. So
 * the charter's first step ("read the intake queue first ... claim it with
 * `npm run work -- --claim <id>`") was something no worker could act on: dozens of open
 * submissions, several corroborated by many independent playtest observations, were invisible
 * to the one agent whose job is to work them, and every cycle fell to the assessor's
 * synthesized maintenance candidates by default rather than by judgement.
 *
 * An empty queue is stated rather than omitted. Silence reads as "nothing was checked", while
 * the charter is explicit that an empty queue is a normal state and not a stall.
 */
export function formatQueueSection(shown: readonly Submission[], available: number): string[] {
  if (available === 0)
    return [
      "## The intake queue (`npm run work -- --list`)",
      "Empty right now, or entirely claimed by another lane — a normal state, not a stall.",
      "The assessor's own candidates carry this cycle.",
    ];
  const remainder = available - shown.length;
  return [
    "## The intake queue — CONSIDER THIS FIRST (`npm run work -- --list`)",
    `${available} open submission(s) not held by another lane, highest priority first (weight`,
    "of evidence breaks ties). A queued item is somebody's actual request, and a verified or",
    "corroborated playtest item is the strongest evidence this repo has — stronger than any",
    "candidate the deterministic assessor can synthesize, because a real player hit it.",
    "",
    ...shown.map((s) => `  ${s.priority} ${s.source}/${s.kind} ${s.id} — ${s.title}`),
    ...(remainder > 0 ? [`  … ${remainder} more; \`npm run work -- --list\` shows them all.`] : []),
    "",
    "PREFER the highest-ranked item you can both finish AND verify in this ONE cycle against",
    "the bar. An item you cannot finish is worth less this cycle than an assessor candidate you",
    "can. Taking one:",
    "  `npm run work -- --claim <id>`   before you start",
    "  `npm run work -- --done <id>`    when the change is complete, BEFORE the provisional commit",
    "Both write tracked files under intake/queue/, so they have to ride that commit — afterwards",
    "AI_LOOP_STATE.md is the only tracked change the driver still allows.",
    "Queue work is normally OFF-LIST: leave `selected_recommendation_id` null unless you really",
    "implemented the assessor candidate of that id. If you pass over the queue for an assessor",
    "candidate, say why in AI_LOOP_STATE.md.",
  ];
}

/**
 * How this agent is actually run, stated in the prompt because it is a property of the
 * LOOP rather than of any vendor.
 *
 * Every one of these lines is a failure that happened rather than one that might. A cycle
 * worker put its checks in the background and ended its turn "to resume when the
 * background test run completes or the scheduled wakeup fires" — 950 s and $3.59 reverted,
 * and the CLI reported success, so only the driver's provisional-commit check caught it. A
 * host can defend against that (unset whatever makes long commands auto-background), but a
 * host defends one machine; `dev-agents.json` invites any vendor on any machine, and the
 * prompt is the only place the contract reaches all of them.
 *
 * The untracked clause is the same shape of trap from the other end: the cycle's own
 * triage step writes qa/tickets/*.json, which are tracked in git on purpose
 * (qa/tickets/README.md), as NEW untracked files after the cycle has already started —
 * and require_final_ledger_only counts untracked paths, not just tracked ones. A worker
 * that reads "only tracked change" literally leaves them behind and loses a green cycle at
 * the very last gate.
 */
export const HEADLESS_TURN_CONTRACT: readonly string[] = [
  "- You get ONE non-interactive turn, and nothing resumes you: no scheduled wakeup, no",
  "  follow-up message, nobody to answer a question. Run every command in the FOREGROUND",
  "  and wait for it. A backgrounded check is a check whose result you will never see, and",
  "  ending the turn to come back later ends the CYCLE.",
  "- The provisional commit must already EXIST before you finish. loop.sh looks for it the",
  "  moment you exit and reverts the entire cycle when it is absent, however much the turn",
  "  accomplished.",
  "- That commit must absorb everything this cycle produced, including files that are still",
  "  UNTRACKED — new tests and traces, and the intake/queue and qa/tickets entries written",
  "  by the cycle's own claim and triage steps. The final gate counts untracked paths too,",
  "  so one leftover qa/tickets/*.json reverts a cycle that was otherwise green.",
];

/**
 * What "focused checks" means, stated because a worker guessed generously and lost a cycle.
 *
 * Measured on cycle 2026-09-06T02-27-19-129Z: the worker ran `npm run health:fast` THREE
 * times inside its own turn, at roughly 17 minutes each under load, and reached its
 * 60-minute budget without finishing. Every one of those runs re-proved the exact bar the
 * driver runs immediately afterwards, on the same tree, so the cycle paid for its gate four
 * times and landed nothing.
 *
 * The instinct is a good one pointed at the wrong target — the worker was trying to be sure
 * before freezing. But the driver's bar is the gate, and a red bar reverts the cycle whether
 * or not the worker saw it coming, so a self-run bar buys no safety at all. It only spends
 * the turn. What genuinely helps is narrow: the tests that cover what was touched, and
 * lint/format on the touched files, which catch the mistakes a worker can actually fix
 * inside its turn.
 */
export const FOCUSED_CHECKS_CONTRACT: readonly string[] = [
  "- Run FOCUSED checks only: the test files covering what you touched, plus lint and format",
  "  on those files. Do NOT run `npm run health`, `npm run health:fast`, `npm test`, or the",
  "  whole suite inside your turn. loop.sh runs the bar itself right after your provisional",
  "  commit, on this same tree, and reverts the cycle if it is red — so running it yourself",
  "  proves nothing the cycle does not already prove, and a turn that spends its budget",
  "  re-proving the gate is a turn that lands nothing.",
];

/** How many unverified leads the prompt names before deferring to the bucket itself. */
export const UNVERIFIED_LEADS_LIMIT = 6;

/**
 * The leads a cycle is allowed to see but not to trust.
 *
 * `derivePromotion` only reaches `corroborated` on reference-tier evidence or two independent
 * model families, so a single-lineage fleet can report the same defect twenty times and never
 * move it off `accumulating` — and `isActionable` then keeps it out of the queue entirely. That
 * is the correct rule for CONFIDENCE and the wrong outcome for a real defect nobody can see: on
 * this branch it left a two-session S2 blocker, and roughly $200 of corroborated evidence,
 * invisible to the loop.
 *
 * Reproduction is the other honest route to confidence, so these are surfaced as LEADS rather
 * than as work: a worker may take one only by first reproducing it deterministically, which is
 * what promotes it. BUG tickets only — an `experience` judgement about how the game reads cannot
 * be settled by a test, only by more players, so putting one here would invite exactly the
 * faith-based "fix" this section exists to prevent.
 */
export function selectUnverifiedLeads(
  tickets: readonly QaTicket[],
  limit: number = UNVERIFIED_LEADS_LIMIT,
): QaTicket[] {
  return tickets
    .filter(
      (ticket) =>
        ticket.kind === "bug" &&
        ticket.promotion === "accumulating" &&
        ticket.superseded_by === undefined &&
        (ticket.status === "open" || ticket.status === "in_progress") &&
        ticket.evidence.report_count >= 2,
    )
    .sort(compareTickets)
    .slice(0, limit);
}

export function formatLeadsSection(leads: readonly QaTicket[]): string[] {
  if (leads.length === 0) return [];
  return [
    "",
    "## Unverified leads (qa/tickets) — REPRODUCE BEFORE YOU FIX",
    `${leads.length} accumulating BUG ticket(s) that more than one report has hit and that`,
    "nothing has reproduced yet. They are NOT corroborated: one model lineage reporting the same",
    "thing many times is one opinion repeated, not two independent witnesses, which is why volume",
    "alone never promotes them. Experience tickets are excluded — how the game READS can only be",
    "settled by more players, never by a test.",
    "",
    ...leads.map(
      (lead) =>
        `  ${lead.severity} ${lead.ticket_id} — ${lead.title} ` +
        `(${lead.evidence.report_count} reports, ${lead.evidence.families.length} lineage(s), ${lead.location})`,
    ),
    "",
    "You may take a lead ONLY by first reproducing it deterministically — a regression test or a",
    "crawler probe that fails on the current build for the reason the ticket gives. That",
    "reproduction is what turns a lead into evidence, so record it BEFORE the provisional commit:",
    "  `npm run qa:triage -- --verified <ticket_id> --verified-by tests/regression/<your test>.ts`",
    "which stamps the ticket, promotes it to verified, and lets ordinary cycle-start triage carry",
    "it into the intake queue from then on. If you CANNOT reproduce it, say so in AI_LOOP_STATE.md",
    "and leave it — an unreproduced lead is not a defect you may fix on faith.",
  ];
}

export function buildPrompt(ctx: {
  a: Assessment;
  top: ImprovementCandidate | null;
  commitEnabled?: boolean;
  queue?: readonly Submission[];
  leads?: readonly QaTicket[];
}): string {
  const { a, commitEnabled = false, queue = [], leads = [] } = ctx;
  const { shown: queueShown, available: queueAvailable } = selectPromptQueue(queue);
  const top = a.top;
  const recommendationKind = assessmentRecommendationKind(a);
  const ranked = a.candidates
    .slice(0, 6)
    .map((c, i) => `  ${i + 1}. [${c.score}] (${c.category}/${c.effort}) ${c.title}`);
  const assessorSection =
    recommendationKind === "strategic"
      ? [
          "## The assessor's ranked next-best improvements (deterministic)",
          ...ranked,
          "",
          `▶ Recommended: ${top!.title}`,
          `   why: ${top!.rationale}`,
          `   evidence: ${top!.evidence.join("; ")}`,
          "",
          "You MAY pick a different candidate (or something off-list) if your judgement and",
          "the available evidence say it is higher value — but justify it in AI_LOOP_STATE.md.",
        ]
      : recommendationKind === "maintenance"
        ? [
            "## The assessor's maintenance rotation (deterministic; not strategic direction)",
            ...ranked,
            "",
            `↻ Maintenance rotation only — no strategic recommendation: ${top!.title}`,
            `   why: ${top!.rationale}`,
            `   evidence: ${top!.evidence.join("; ")}`,
            "",
            "This floor candidate remains executable routine maintenance. Treat it as rotation",
            "context, not as evidence that it is the project's strategic next-best move.",
          ]
        : [
            "## Assessor status (deterministic)",
            "• No candidate and no strategic recommendation.",
            "",
            "Use verified playtest or repo evidence to choose one focused maintenance task;",
            "do not invent an assessor ranking.",
          ];
  const cycleCharge =
    recommendationKind === "strategic"
      ? [
          "Make exactly one focused, high-impact AdventureForge maintenance improvement within this repo",
          "and leave it green. Use the available repo context to choose and verify the improvement;",
        ]
      : recommendationKind === "maintenance"
        ? [
            "Make exactly one focused AdventureForge maintenance improvement within this repo and leave it green.",
            "The assessor's floor pick is routine rotation, not evidence of strategic priority;",
          ]
        : [
            "Make exactly one focused AdventureForge maintenance improvement within this repo and leave it green.",
            "The assessor supplied no candidate; ground the choice in verified playtest or repo evidence;",
          ];
  const improvementInstructions = [
    "- content_fix: edit the quest source (or apply_content_patch); re-validate.",
    "- content_new: add and register one world-graph RPG quest, not a detached source file;",
    "  validate it, then let the later fresh-overworld player test natural discovery.",
    "- engine / repo: change freely under trust-but-verify. New mechanics no longer need",
    "  a §14 ceremony, but keep verification green and add tests for new behavior.",
    "- If you fix a bug, add a traces/bugs/ artifact + a tests/regression/ test (§15).",
    "- A content edit that changes a pinned hash must re-pin it deliberately",
    "  (tests/unit/rpg_validator.test.ts, traces/bugs/*.yaml); never weaken a check to pass.",
    "- FIX THE CLASS, NOT THE INSTANCE. If recent cycles keep surfacing the same class",
    "  of finding, prefer a class-level validator/lint fix when that is the higher-value move.",
  ];
  const feedbackInstructions = [
    "- Run `npm run feedback:status`; it verifies unseen ledger reports plus exact pending",
    "  cycle evidence from committed loop state. Run `npm run feedback:compile` only when status says ready",
    "  (including a one-time bootstrap); otherwise record the reported skip count.",
    "  Deterministic structural mocks never satisfy the three-actionable-report threshold.",
    "  This cycle plays nothing and contributes no report of its own; the corpus belongs to",
    "  the playtest loop, and an empty one is a normal state rather than a failure.",
  ];
  const workflow = commitEnabled
    ? [
        "## STEP 1 — Make ONE improvement",
        "",
        ...improvementInstructions,
        "",
        "## STEP 2 — Self-critique, run focused checks, and commit provisionally",
        "",
        "- In one or two lines, judge whether the change raises player-facing quality or",
        "  closes a real defect. If it is busywork, replace it with the higher-value move.",
        "- Run the focused tests/validation appropriate to the change. loop.sh runs the",
        "  post-crawl, health (fast or full — loop.sh reads that off your diff), and",
        "  integrity-drift gates after you return.",
        "- Commit every tracked implementation change locally as a PROVISIONAL commit.",
        "  Never push. The outer loop will hard-reset this commit if any later gate fails.",
        "- REQUIRED before that commit, and checked the moment you exit: set",
        "  `selected_recommendation_id` in this cycle's `feedback_cycle_selection` marker",
        "  to the exact candidate id you implemented,",
        "  or to null for queue-driven or off-list work. Never change it after the freeze.",
        "  This is a hard precondition, not bookkeeping. The seal REFUSES a provisional",
        "  commit whose ledger entry has no actual-selection marker, so a cycle that skips",
        "  it is discarded however green its bar was — one such cycle threw away seventy",
        "  minutes of passing tests. loop.sh now checks it immediately after your commit.",
        "- The provisional commit MUST INCLUDE AI_LOOP_STATE.md, carrying the frozen",
        "  `feedback_cycle_selection` marker. Commit the scaffold as it stands; you finish",
        "  its prose in STEP 3, after the gates. This is not optional and not bookkeeping:",
        "  the attestation lives inside that file, so a provisional commit that does not",
        "  contain AI_LOOP_STATE.md is rejected within seconds and the whole cycle is",
        '  discarded — a worker that read STEP 3 as "never commit the ledger" lost 290',
        "  turns and 44 minutes of finished, correct work exactly this way.",
        "- VERIFY IT YOURSELF before you end the turn, using the same check loop.sh runs:",
        "  `npm run --silent loop:seal-feedback -- --check-attestation --meta ai-runs/latest-cycle.json`",
        "  If it fails, amend the provisional commit until it passes. Never end the turn on",
        "  a red attestation check.",
        "",
        "## STEP 3 — Compile only at the real threshold, then finish the ledger",
        "",
        ...feedbackInstructions,
        "- Complete AI_LOOP_STATE.md TERSELY (≤8 lines): what changed + why,",
        "  self-critique, evidence, and next focus.",
        "- Keep the frozen `feedback_cycle_selection` marker unchanged; the post-gate seal",
        "  removes it after using the committed actual-selection attestation.",
        "- After the provisional commit, AI_LOOP_STATE.md must be the only thing left in",
        "  `git status --porcelain` at all — untracked paths included, not just tracked ones.",
        "  Leave THIS COMPLETION uncommitted. The file is already inside your STEP 2 commit;",
        "  what stays uncommitted is only the later edit finishing its prose. Do not make a",
        "  second commit for it: loop.sh runs the outer gates and makes the final",
        "  ledger-only commit; only after that may its separately enabled push step run.",
      ]
    : [
        "## STEP 1 — Make ONE uncommitted improvement",
        "",
        "- This run has AI_LOOP_COMMIT disabled. First require `git status --porcelain` to",
        "  be exactly empty: loop.sh measures this cycle against its clean starting ref, so",
        "  uncommitted changes on top of an unknown revision are not attributable evidence.",
        "  If it is not empty, STOP without editing anything.",
        ...improvementInstructions,
        "",
        "## STEP 2 — Self-critique, run focused checks, and record evidence",
        "",
        "- Judge the change against player value and run its focused tests/validation.",
        ...feedbackInstructions,
        "- Append a TERSE AI_LOOP_STATE.md entry (≤8 lines) with the change,",
        "  self-critique, evidence, and next focus. Put it at the END of the file under a",
        "  `## AFK Cycle <runId>` heading (runId from ai-runs/latest-cycle.json) — the shape",
        "  rotation and cycle counting match.",
        "- Do not commit or push: this is explicitly an evidence-only run. loop.sh still",
        "  runs post-crawl, health, and integrity drift against the clean starting ref.",
      ];

  return [
    "# AdventureForge AFK improvement cycle (trust, but verify)",
    "",
    "This cycle improves AdventureForge, a local fictional text-based TTRPG project.",
    ...cycleCharge,
    "do not route around the verifier.",
    "",
    ...formatQueueSection(queueShown, queueAvailable),
    ...formatLeadsSection(selectUnverifiedLeads(leads)),
    "",
    ...assessorSection,
    "",
    ...workflow,
    "",
    "## Hard constraints",
    ...HEADLESS_TURN_CONTRACT,
    ...FOCUSED_CHECKS_CONTRACT,
    "- Do not commit ai-runs/, node_modules/, dist/, coverage/, saves/*.json.",
    "- Keep the game playable; prefer a small, verified change over a broad rewrite.",
    "- The health bar loop.sh reads off your diff (`npm run loop:bar`: the full",
    "  `npm run health`, or `health:fast` when nothing the census proofs read changed)",
    "  must pass in loop.sh before anything is retained or pushed.",
    "  Do not disable/delete tests or silently re-pin hashes to go green.",
    "- Token economy: read files in RANGES (offset/limit), not wholesale, and don't",
    "  re-read unchanged files. AI_LOOP_STATE.md is auto-trimmed to recent cycles — older",
    "  history lives in the gitignored AI_LOOP_STATE_ARCHIVE.md (read it only if you truly",
    "  need deep history). `npm test` uses --reporter=dot, so keep diagnostics terse.",
    "",
  ].join("\n");
}

export function formatLoopStateAppend(
  stamp: string,
  a: Assessment,
  ultraplan: boolean,
  currentPlanRecord: string | null = null,
): string {
  const top = a.top;
  // The scaffold states the cycle's CONTRACT, and it is committed, so every line here
  // has to stay true of a cycle that plays nothing. The old entry advertised a per-cycle
  // playtest target and a blind-report guard; both were retired with the two-loop split,
  // and a ledger line asserting evidence nobody produced is the exact failure this
  // subsystem exists to prevent. The playtest launch contract remains in latest-cycle.json
  // via playtestTargetSummary/playtestTargetMetadata, where it belongs.
  const text = [
    "",
    `## AFK Cycle ${stamp}${ultraplan ? " — ULTRAPLAN (saturation re-aim)" : ""}`,
    formatFeedbackCycleSelectionMarker(stamp, null),
    "",
    `- Assess: rpg=${a.rpgQuestCount}; world=${a.worldQuestCount}; candidates=${a.candidates.length}.`,
    `- Rec: ${top ? `${top.id} (${top.category}/${top.effort}; score=${top.score})` : "none"}.`,
    ultraplan
      ? `- Mode: ultraplan re-aim; handoff ${currentPlanRecord ?? `ai-runs/${stamp}/current-plan.md`}.`
      : "",
    "- Guard: health + verify:integrity before commit.",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  return text + "\n";
}

/**
 * The ULTRAPLAN-mode prompt, emitted only when the assessor is saturated (and off
 * cooldown). It tells the cycle's agent to RE-AIM the project with a bounded
 * multi-agent ultraplan, persist the per-cycle handoff under ignored ai-runs/, then
 * implement the chosen move in a FRESH context — keeping the same green-bar discipline
 * as a standard cycle, and, like a standard cycle, playing nothing itself.
 */
export function buildUltraplanPrompt(ctx: {
  a: Assessment;
  currentPlanRecord: string;
  commitEnabled?: boolean;
}): string {
  const { a, currentPlanRecord, commitEnabled = false } = ctx;
  const recommendationKind = assessmentRecommendationKind(a);
  if (recommendationKind === "strategic") {
    throw new Error("Ultraplan mode requires a saturated assessment, not strategic direction.");
  }
  const assessorStatus =
    recommendationKind === "maintenance"
      ? [
          "## Assessor status — maintenance floor, not strategic direction",
          `↻ Maintenance rotation only — no strategic recommendation: ${a.top!.title}`,
          "Do not carry this floor ordering into the ultraplan as a recommendation. The bounded",
          "repo review below independently selects and justifies the structural re-aim.",
        ]
      : [
          "## Assessor status — no candidate and no strategic recommendation",
          "The bounded repo review below independently selects and justifies the structural re-aim.",
        ];
  const evidenceOnlyPrelude = commitEnabled
    ? []
    : [
        "## STEP -1 — Start from an exactly clean tree, before any plan or code edit",
        "- AI_LOOP_COMMIT is disabled, so this cycle's evidence is a diff against its clean",
        "  starting ref. Require `git status --porcelain` to be exactly empty before editing",
        "  anything. If it is not empty, STOP without editing.",
        "",
      ];
  const finish = commitEnabled
    ? [
        "## STEP 4 — Run focused checks and create the LOCAL provisional commit",
        "- Self-critique the move, then run its focused tests/validation. The outer loop",
        "  runs post-crawl, health (fast or full — read off your diff), and integrity",
        "  drift after you return.",
        "- Commit every tracked implementation/decision-log change locally as a PROVISIONAL",
        "  commit. Include the unfinished AI_LOOP_STATE.md scaffold. Never push.",
        "- REQUIRED before that commit, and checked the moment you exit: set",
        "  `selected_recommendation_id` in this cycle's `feedback_cycle_selection` marker",
        "  to the exact candidate id you implemented,",
        "  or to null for the ultraplan's off-list choice. Freeze it with the revision.",
        "  This is a hard precondition, not bookkeeping. The seal REFUSES a provisional",
        "  commit whose ledger entry has no actual-selection marker, so a cycle that skips",
        "  it is discarded however green its bar was — one such cycle threw away seventy",
        "  minutes of passing tests. loop.sh now checks it immediately after your commit.",
        "",
        "## STEP 5 — Compile only at the real threshold, then finish the ledger",
        "- Run `npm run feedback:status`; compile only when it reports ready (including a",
        "  one-time bootstrap). Deterministic structural mocks never meet the threshold, and",
        "  this cycle adds no report of its own — the playtest loop owns that corpus.",
        "- Complete AI_LOOP_STATE.md TERSELY (≤8 lines): ultraplan choice, self-critique,",
        "  evidence, and next focus. It must be the ONLY tracked post-provisional change.",
        "- Keep the frozen `feedback_cycle_selection` marker unchanged; the post-gate seal",
        "  removes it after checking the committed selection.",
        "- Do not commit the ledger edit. loop.sh runs the outer gates and makes the final",
        "  ledger-only commit; its optional push runs only after that commit succeeds.",
      ]
    : [
        "## STEP 4 — Self-critique, focused checks, and evidence-only ledger",
        "- Run the focused tests/validation, then `npm run feedback:status`. Compile only",
        "  when status reports ready. Evidence-only runs cannot make the provisional compile",
        "  authoritative because they do not execute the final tracked-state seal.",
        "- Append a TERSE AI_LOOP_STATE.md entry (≤8 lines): ultraplan choice,",
        "  self-critique, evidence, and next focus. Put it at the END of the file under a",
        "  `## AFK Cycle <runId>` heading (runId from ai-runs/latest-cycle.json).",
        "- Do not commit or push. loop.sh still runs post-crawl, health, and integrity drift",
        "  against the clean starting ref, leaving evidence-only changes uncommitted.",
      ];
  return [
    "# AdventureForge AFK cycle — ULTRAPLAN MODE (the assessor is saturated)",
    "",
    "The deterministic assessor has run dry: every high-value lever has disarmed and",
    "only routine 0.5-floor blind passes remain. That is the signal to RE-AIM the",
    "project with a multi-agent ultraplan rather than spend another cycle on polish.",
    "Keep this repo-local: use the ultraplan to select one focused AdventureForge maintenance improvement, then verify it completely.",
    "",
    ...assessorStatus,
    "",
    ...evidenceOnlyPrelude,
    `## STEP 0 — Read the decision log FIRST (${DECISION_LOG_DOC})`,
    `- Read ${DECISION_LOG_DOC} before fanning out. It is the append-only memory of`,
    '  SETTLED questions. Every reviewer MUST treat its "Confirmed CLOSED" list as a hard',
    '  boundary: do NOT re-nominate, re-investigate, or "confirm" any gap listed there — it',
    "  is already implemented, with the file:line proof recorded. Re-deriving closed gaps is",
    "  the exact redundant fan-out this log exists to stop (re-aim #19 re-confirmed SIX such",
    "  false alarms). Put the closed list in EVERY reviewer subagent's prompt as its boundary.",
    "",
    "## STEP 1 — Run a LOCAL-ONLY ULTRAPLAN (multi-agent if available)",
    "- Fan out a BOUNDED, LOCAL-ONLY ultraplan (≈4-6 agents total) with whatever subagent",
    "  or orchestration mechanism your harness provides; if it has none, work the same",
    "  review dimensions sequentially in this one context:",
    "  parallel repo reviewers (engine/determinism · content/authoring · verification ·",
    "  loop/strategy) → ONE synthesis that picks the single highest-value STRUCTURAL",
    "  next move (not content polish). Fan out ONLY here, where the review dimensions are",
    "  genuinely independent; never fan out a single tightly-coupled fix (keep that one agent).",
    "- LOCAL ONLY — do NOT use web search, web fetch, or any network/external tool. Web",
    "  tools force an interactive approval prompt that STALLS this unattended loop. Ground",
    "  the re-aim entirely in the repo itself (source, tests, validators, generated RPG quests).",
    `- Ground it in docs/archive/ULTRAPLAN-2026-06-02.md, docs/ROADMAP.md, ${CURRENT_PLAN_DOC}`,
    "  (the durable strategic router), and recent AI_LOOP_STATE.md — advance them, do not",
    `  restart from zero. Do not overwrite ${CURRENT_PLAN_DOC}.`,
    "",
    "## STEP 2 — Persist the decision and the ignored per-cycle handoff",
    `- APPEND a dated entry to ${DECISION_LOG_DOC} recording the gaps you CONFIRMED CLOSED`,
    "  this cycle (each with its file:line proof) and the one move you chose. Append only —",
    "  never edit or delete prior entries. This is what stops the NEXT re-aim re-deriving them.",
    `- Write the synthesis + chosen next move to ${currentPlanRecord} (tight and`,
    "  actionable: what, why, the exact files, and the acceptance check — which must state",
    "  that the outer `npm run health` gate is mandatory, not best-effort). This ignored",
    `  per-cycle artifact is the ONLY fresh-agent handoff. Never edit ${CURRENT_PLAN_DOC}.`,
    "",
    "## STEP 3 — Implement in a FRESH context",
    `- Spawn a FRESH implementation agent (whatever fresh-context mechanism your harness`,
    `  offers) that reads ONLY ${currentPlanRecord} and the specific files it names — NOT`,
    "  the whole repo. It makes",
    "  the ONE chosen change and locks it (a traces/bugs/ artifact + a tests/regression/",
    "  test for a bug; tests for new behaviour).",
    "",
    ...finish,
    "",
    "## Hard constraints",
    ...HEADLESS_TURN_CONTRACT,
    ...FOCUSED_CHECKS_CONTRACT,
    "- Do not commit ai-runs/, node_modules/, dist/, coverage/, saves/*.json.",
    "- ONE focused structural change; keep the game playable and the bar green.",
    "- The health bar loop.sh reads off your diff (`health` or `health:fast`, via",
    "  `npm run loop:bar`) and verify:integrity must pass in loop.sh; never weaken a check.",
    "- Token economy: ranged file reads (offset/limit), no redundant re-reads; the loop",
    "  log is auto-trimmed (deep history in the gitignored AI_LOOP_STATE_ARCHIVE.md).",
    "",
  ].join("\n");
}

// Run a cycle only as the CLI entry point (npm run ai:loop), NOT when imported —
// so tests can import shouldRunUltraplan without executing a real cycle.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
