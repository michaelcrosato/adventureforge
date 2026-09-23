/**
 * Quest crawler — the zero-LLM mechanical game-crawler's stepping loop.
 *
 * Drives a `PreparedQuest` through many seeded episodes with a policy-driven
 * action choice, running these oracles:
 *   - CRASH      a THROW out of enumerate/resolve/render is an engine bug, never
 *                a silent propagation — caught, recorded with a lazy repro trace.
 *   - INTEGRITY  `assertRpgStateReferences` must hold after every accepted step.
 *   - LEGALITY   a listed-legal action must never be rejected; a sampled
 *                NOT-legal action must always be rejected cleanly (no throw, no
 *                state change).
 *   - RENDER     the observation + event text the player would actually see must
 *                never leak an unresolved template, "undefined", "[object
 *                Object]", "NaN", or empty text.
 *   - PERSIST    a save→load roundtrip of a live state must reproduce a
 *                byte-identical hash (§8.7); a throw is itself a finding.
 *   - DESYNC     replaying an episode's recorded actions from a fresh init state
 *                must reproduce the SAME per-step hash stream the live run saw —
 *                catches hidden non-determinism/mutable state a repro trace could
 *                never actually reproduce.
 *   - SOFTLOCK   two forms: an immediate S4 (live, non-ended state with zero legal
 *                actions) and an end-of-episode S3 solver form (an exhaustive
 *                best/worst-roll search from the post-episode state proves no
 *                declared ending is reachable; a capped-out search is unproven and
 *                never a finding).
 *
 * Repro traces are built LAZILY — only when a finding's fingerprint is genuinely
 * new (`addFinding`'s `collector.has` pre-check), never per step and never for a
 * fingerprint `collector.add` would just dedupe away, since throughput matters
 * over many episodes.
 */
import type { RpgAction } from "../api/types.js";
import { makeStep, type Rules } from "../core/engine.js";
import { hashState } from "../core/hash.js";
import { mulberry32 } from "../core/rng.js";
import type { GameState } from "../core/state.js";
import type { RpgActionOption } from "../rpg/legal_actions.js";
import { enumerateRpgActions, initStateForRpgPack, type RpgIndex } from "../rpg/runner.js";
import { recordTrace, type RecordOptions, type Trace } from "../trace/record.js";
import { FindingCollector, type CrawlFinding, type CrawlSeverity } from "./findings.js";
import { minimizeFinding } from "./minimize.js";
import { sampleIllegalAction } from "./oracles.js";
import { makePolicy, type PolicyName } from "./policies.js";
import type { PreparedQuest } from "./prepare.js";
import {
  describeError,
  runStepOracles,
  S4_SOFTLOCK_MESSAGE,
  softlockSolverCheck,
  type CrawlLocation,
} from "./step_oracles.js";

type QuestCrawlOptions = {
  seed: number;
  maxSteps: number;
  policy: PolicyName;
  /** Steps per episode before a fresh episode starts. Default 300. */
  maxStepsPerEpisode?: number;
  /** Cadence for the (Task 5) PERSIST oracle; 0 disables it. Default 37. */
  persistEvery?: number;
  /** Cadence for negative-legality sampling; 0 disables it. Default 23. */
  illegalEvery?: number;
  /** Whether to run the (Task 5) end-of-episode DESYNC replay check. Default true. */
  desyncReplay?: boolean;
  /** (Task 5) SOFTLOCK-solver budget; 0 (default) keeps the solver off. */
  solverBudget?: number;
  commit: string;
  /** Extra location fields (region/node) when launched from the overworld. */
  location?: Partial<CrawlLocation>;
};

export type EpisodeRecord = {
  episodeSeed: number;
  actions: RpgAction[];
  perStepHashes: string[];
  endingId: string | null;
};

export type QuestCrawlResult = {
  questId: string;
  steps: number;
  episodes: EpisodeRecord[];
  endingsReached: string[];
  findings: CrawlFinding[];
  totalRawFindings: number;
  /** `actionIdsTried` holds only the ids the engine actually APPLIED — an action
   *  the engine rejected exercised nothing and is itself a LEGALITY finding, so
   *  it must not inflate the coverage numerator `run.ts` prints as `actions X/Y`
   *  (the policy's own repeat-avoidance uses a separate attempted-ids set). */
  coverage: { roomsVisited: string[]; actionIdsTried: string[] };
};

function none(): CrawlFinding["repro"] {
  return { kind: "none", trace: null, minimized: false };
}

/**
 * Build a replayable repro trace for an episode-so-far. Lazy by construction — only
 * ever called from a finding site (through `addFinding`'s dedupe pre-check below),
 * never once per step and never for a fingerprint already kept. A shipped quest's
 * trace carries its real `worldQuestId`; an in-memory pack (no on-disk source)
 * carries its episode seed as a `generatedRpgSeed` placeholder identity — the
 * trace is a diagnostic artifact here, not a claim that a generator minted this
 * exact pack from that seed.
 */
function buildRepro(prepared: PreparedQuest, record: EpisodeRecord): Trace<RpgAction> {
  const initial = initStateForRpgPack(prepared.index, record.episodeSeed);
  const traceId = `crawl:${prepared.questId}:${record.episodeSeed}`;
  const identity: RecordOptions =
    prepared.sourceRef && prepared.sourceRef[0] === "wq"
      ? {
          trace_id: traceId,
          content_hash: prepared.contentHash,
          worldQuestId: prepared.sourceRef[1],
        }
      : {
          trace_id: traceId,
          content_hash: prepared.contentHash,
          generatedRpgSeed: record.episodeSeed,
        };
  return recordTrace(prepared.rules, initial, record.actions, identity);
}

/** Result of replaying an episode's recorded actions (see `replayEpisodeHashes`). */
type ReplayResult = {
  hashes: string[];
  /** Set iff the replay itself threw; carries the action index and error text so
   *  the caller can surface a DESYNC finding instead of propagating the throw. */
  threw: { index: number; error: string } | null;
};

/**
 * Hand-rolled replay of a recorded episode's actions, from a fresh
 * `initStateForRpgPack` and a fresh `makeStep(rules)` closure, hashing after each
 * APPLIED action — mirroring exactly how the live loop built `record.perStepHashes`
 * (a hash pushed only for an accepted step; a rejected action leaves state, and the
 * hash stream, untouched). `runActions` (src/trace/record.ts) instead pushes a hash
 * after EVERY action regardless of `ok`, which misaligns index-for-index against
 * `perStepHashes` the moment either run ever rejects an action the other accepted —
 * so DESYNC steps its own loop rather than reusing it.
 *
 * The live loop already catches a throw from `rules.resolve`/`legalActions` as a
 * CRASH finding (never propagated); a replay-only rules wrapper (hidden state keyed
 * off a call count, say) can throw here even when the live run never did, since the
 * two runs don't share position in that hidden state. Wrapped so a throw here becomes
 * a reported DESYNC finding too, rather than crashing the whole crawl (Task 5 review
 * fix).
 */
function replayEpisodeHashes(
  rules: Rules<RpgAction>,
  index: RpgIndex,
  record: EpisodeRecord,
): ReplayResult {
  const step = makeStep(rules);
  let state = initStateForRpgPack(index, record.episodeSeed);
  const hashes: string[] = [];
  for (let i = 0; i < record.actions.length; i++) {
    const action = record.actions[i]!;
    try {
      const result = step(state, action);
      if (!result.ok) continue;
      state = result.state;
      hashes.push(hashState(state));
    } catch (err) {
      return { hashes, threw: { index: i, error: describeError(err) } };
    }
  }
  return { hashes, threw: null };
}

/** Deterministic per-episode seed derived from the crawl seed and episode index. */
function episodeSeed(seed: number, episode: number): number {
  return (seed * 9973 + episode) >>> 0 || 1;
}

export function crawlQuest(prepared: PreparedQuest, opts: QuestCrawlOptions): QuestCrawlResult {
  const { index, rules } = prepared;
  const step = makeStep(rules);
  const collector = new FindingCollector({
    seed: opts.seed,
    policy: opts.policy,
    commit: opts.commit,
  });
  const roomsVisited = new Set<string>();
  // Two distinct sets, because the two consumers want different questions
  // answered. `actionIdsAttempted` steers the coverage/mixed policies away from
  // repeats (`PolicyContext.triedActionIds`) and must therefore include an id
  // the engine REJECTED — otherwise the policy keeps re-picking the same
  // never-satisfiable option as "untried" and exploration collapses.
  // `actionIdsApplied` is the reported coverage numerator, and a rejected action
  // exercised nothing: it left state untouched by the engine contract (and is
  // itself a LEGALITY finding). Counting it made `actions X/Y` measure neither
  // exercised surface nor attempted surface.
  const actionIdsAttempted = new Set<string>();
  const actionIdsApplied = new Set<string>();
  const episodes: EpisodeRecord[] = [];
  const endingsReached = new Set<string>();
  let totalSteps = 0;
  let episodeN = 0;
  const illegalEvery = opts.illegalEvery ?? 23;
  const persistEvery = opts.persistEvery ?? 37;
  const desyncReplay = opts.desyncReplay ?? true;
  const solverBudget = opts.solverBudget ?? 0;

  const loc = (state: GameState): CrawlLocation => ({
    region: opts.location?.region ?? null,
    node: opts.location?.node ?? null,
    questId: prepared.questId,
    sceneId: state.current,
  });

  /**
   * Add a finding, building its repro trace only when the finding's fingerprint is
   * genuinely new — `collector.has` is the cheap pre-check that lets us skip
   * `buildRepro`'s O(actions-so-far) `recordTrace` replay whenever `collector.add`
   * would discard the finding as a duplicate anyway (a defect firing every step must
   * not pay that cost on every occurrence — Task 5 review fix). `record` is null only
   * for the one CRASH site that predates any recorded actions (episode init itself
   * threw).
   */
  // Indices into `collector.findings` of NEW (non-deduped), non-ORPHAN findings
  // added during the CURRENT episode — reset at the top of each episode below,
  // drained (each minimized in place) at the end of that same episode's
  // processing (Task 6 Step 5). `collector.findings` is the collector's own
  // live array (not a defensive copy), so an index assignment into it mutates
  // the collector's stored finding directly.
  let newFindingIndices: number[] = [];

  const addFinding = (
    f: Omit<CrawlFinding, "seed" | "policy" | "commit" | "severity" | "repro"> & {
      severity?: CrawlSeverity;
    },
    record: EpisodeRecord | null,
  ): boolean => {
    const repro: CrawlFinding["repro"] =
      record && !collector.has(f)
        ? { kind: "rpg-trace", trace: buildRepro(prepared, record), minimized: false }
        : none();
    const added = collector.add({ ...f, repro });
    if (added && f.code !== "ORPHAN") {
      newFindingIndices.push(collector.findings.length - 1);
    }
    return added;
  };

  const crash = (
    message: string,
    state: GameState,
    record: EpisodeRecord,
    action: RpgAction | null = null,
  ): void => {
    addFinding(
      {
        code: "CRASH",
        step: totalSteps,
        location: loc(state),
        action,
        message,
        stateHash: hashState(state),
      },
      record,
    );
  };

  // `totalSteps` advances only in the step loop's update clause (`s++, totalSteps++`),
  // which `break` skips. Five break sites can fire at s === 0 — enumerate threw, an
  // already-ended initial state, a crashed step oracle, a fatal INTEGRITY/render
  // outcome, and a first action that ends the game — and each costs the episode zero
  // steps. The zero-legal-actions case is guarded below by `initialSoftlockFired`,
  // but the other four were not: with a deterministic first-step failure the outer
  // loop re-enters forever, the repeated finding dedupes away so nothing new is
  // recorded, and `episodes` grows without bound. crawl:smoke — the loop's mandatory
  // pre/post gate — then hangs and OOMs instead of exiting 1 with the CRASH finding
  // it exists to report.
  //
  // Bounding CONSECUTIVE zero-progress episodes rather than breaking on the first one
  // keeps the legitimate case alive: a small quest whose first action can end the run
  // will produce scattered zero-step episodes under the mixed policy and must still
  // be crawled. Only an unbroken run of them means the crawl genuinely cannot advance.
  const MAX_CONSECUTIVE_ZERO_PROGRESS_EPISODES = 32;
  let consecutiveZeroProgressEpisodes = 0;

  while (totalSteps < opts.maxSteps) {
    const stepsBeforeEpisode = totalSteps;
    newFindingIndices = [];
    const eSeed = episodeSeed(opts.seed, episodeN++);
    const rng = mulberry32(eSeed);
    const policy = makePolicy(opts.policy, rng);
    const loc0: CrawlLocation = {
      region: opts.location?.region ?? null,
      node: opts.location?.node ?? null,
      questId: prepared.questId,
      sceneId: null,
    };

    let state: GameState;
    try {
      state = initStateForRpgPack(index, eSeed);
    } catch (err) {
      addFinding(
        {
          code: "CRASH",
          step: 0,
          location: { ...loc0 },
          action: null,
          message: `init threw: ${describeError(err)}`,
          stateHash: null,
        },
        null,
      );
      break;
    }
    const record: EpisodeRecord = {
      episodeSeed: eSeed,
      actions: [],
      perStepHashes: [],
      endingId: null,
    };
    episodes.push(record);
    roomsVisited.add(state.current);
    // Set the moment the immediate S4 SOFTLOCK (zero legal actions) fires below, so
    // the end-of-episode solver-form check can skip itself for THIS episode — both
    // would otherwise be true but redundant findings for the same dead end (Task 5
    // review fix); the S4 one is kept since it fired first and needs no solver budget.
    let episodeSoftlockFired = false;
    // A zero-action INITIAL state cannot consume a step, so blindly starting fresh
    // episodes would repeat forever without advancing `totalSteps`. One witness is
    // complete evidence for that seed-independent initial corruption.
    let initialSoftlockFired = false;

    for (
      let s = 0;
      s < (opts.maxStepsPerEpisode ?? 300) && totalSteps < opts.maxSteps;
      s++, totalSteps++
    ) {
      // 1. enumerate (CRASH oracle around it)
      let options: RpgActionOption[];
      try {
        options = enumerateRpgActions(index, state);
      } catch (err) {
        crash(`enumerate threw: ${describeError(err)}`, state, record);
        break;
      }
      if (state.ended) break;

      // 2. SOFTLOCK (immediate form): live state with zero legal actions
      if (options.length === 0) {
        addFinding(
          {
            code: "SOFTLOCK",
            severity: "S4",
            step: totalSteps,
            location: loc(state),
            action: null,
            message: S4_SOFTLOCK_MESSAGE,
            stateHash: hashState(state),
          },
          record,
        );
        episodeSoftlockFired = true;
        initialSoftlockFired = record.actions.length === 0;
        break;
      }

      // 3. LEGALITY (negative sampling): a sampled illegal action must be rejected cleanly
      if (illegalEvery && s > 0 && s % illegalEvery === 0) {
        const illegal = sampleIllegalAction(index, state, options, rng);
        if (illegal) {
          const before = hashState(state);
          try {
            const r = step(state, illegal);
            if (r.ok) {
              addFinding(
                {
                  code: "LEGALITY",
                  step: totalSteps,
                  location: loc(state),
                  action: illegal,
                  message: `illegal action was accepted: ${JSON.stringify(illegal)}`,
                  stateHash: hashState(r.state),
                },
                record,
              );
            } else if (hashState(r.state) !== before && hashState(state) !== before) {
              // The engine contract guarantees a rejection leaves state untouched
              // (r.state is the SAME reference, unchanged). Reaching here means the
              // rejection path itself mutated state in place — a purity violation.
              addFinding(
                {
                  code: "LEGALITY",
                  step: totalSteps,
                  location: loc(state),
                  action: illegal,
                  message: `illegal action rejection mutated state (was ${before})`,
                  stateHash: hashState(r.state),
                },
                record,
              );
            }
          } catch (err) {
            addFinding(
              {
                code: "LEGALITY",
                step: totalSteps,
                location: loc(state),
                action: illegal,
                message: `illegal action threw instead of clean rejection: ${describeError(err)}`,
                stateHash: hashState(state),
              },
              record,
            );
          }
        }
      }

      // 4-7. pick + execute a legal action, then the per-step oracles
      // (CRASH / INTEGRITY / RENDER / PERSIST) — `runStepOracles` (Task 6) is
      // shared byte-for-byte with `reproducesFingerprint`'s replay so a
      // minimized repro trace can never drift from what the live crawl saw.
      const choice = policy.pick(options, {
        visitedRooms: roomsVisited,
        triedActionIds: actionIdsAttempted,
      });
      const outcome = runStepOracles({
        prepared,
        step,
        state,
        action: choice.action,
        totalStep: totalSteps,
        loc,
        eSeed,
        sInEpisode: s,
        persistEvery,
      });

      if (outcome.kind === "crashed") {
        for (const f of outcome.findings) addFinding(f, record);
        break;
      }

      record.actions.push(choice.action);
      actionIdsAttempted.add(choice.id);

      if (outcome.kind === "rejected") {
        addFinding(
          {
            code: "LEGALITY",
            step: totalSteps,
            location: loc(state),
            action: choice.action,
            message: `listed legal action rejected: ${outcome.result.rejectionReason ?? "?"} (${choice.id})`,
            stateHash: hashState(state),
          },
          record,
        );
        continue; // state unchanged per engine contract
      }

      // outcome.kind === "applied"
      actionIdsApplied.add(choice.id);
      state = outcome.state;
      roomsVisited.add(state.current);
      record.perStepHashes.push(hashState(state));
      for (const f of outcome.findings) addFinding(f, record);
      if (outcome.fatal) break; // INTEGRITY failure or a RENDER-render throw

      if (state.ended) {
        record.endingId = state.endingId;
        if (state.endingId) endingsReached.add(state.endingId);
        break;
      }
    }

    // end-of-episode DESYNC replay: re-run the recorded actions from a fresh initial
    // state and a fresh step closure over the SAME rules, and compare per-step
    // hashes — any divergence means the engine's live behavior is not reproducible
    // from the recorded action list alone (e.g. hidden mutable state in a rules
    // wrapper), which is itself a defect a replay-based repro/regression tool can
    // never reproduce.
    if (desyncReplay) {
      const replay = replayEpisodeHashes(rules, index, record);
      if (replay.threw) {
        addFinding(
          {
            code: "DESYNC",
            step: totalSteps,
            location: loc(state),
            action: null,
            message: `replay threw: ${replay.threw.error} at action index ${replay.threw.index}`,
            stateHash: hashState(state),
          },
          record,
        );
      } else {
        const firstDivergence = record.perStepHashes.findIndex((h, i) => replay.hashes[i] !== h);
        if (firstDivergence !== -1) {
          addFinding(
            {
              code: "DESYNC",
              step: totalSteps,
              location: loc(state),
              action: null,
              message: `replay diverged at action index ${firstDivergence}`,
              stateHash: hashState(state),
            },
            record,
          );
        } else if (replay.hashes.length !== record.perStepHashes.length) {
          // The replay accepted an action the live run rejected (or vice versa),
          // producing extra (or missing) trailing hashes with no index-for-index
          // divergence in the shared prefix — `findIndex` above can't see this, so
          // it needs its own check.
          addFinding(
            {
              code: "DESYNC",
              step: totalSteps,
              location: loc(state),
              action: null,
              message:
                `replay hash-stream length mismatch: replay produced ${replay.hashes.length} ` +
                `hashes, live run produced ${record.perStepHashes.length}`,
              stateHash: hashState(state),
            },
            record,
          );
        }
      }
    }

    // end-of-episode SOFTLOCK (solver form): the episode ended without state.ended —
    // exhaustively search from the post-episode state under a best/worst-roll
    // bracket (`softlockSolverCheck`, Task 6 — shared with `reproducesFingerprint`'s
    // end-of-replay mirror so the two can never drift); an empty reached set with a
    // completed (non-capped) search is a proven no-ending-reachable dead end. A
    // capped-out search is UNPROVEN and never a finding. Skipped when the immediate
    // S4 SOFTLOCK already fired this episode (`episodeSoftlockFired`) — both are true
    // for the same dead end, and firing both is a redundant double-report, not a
    // second bug (Task 5 review fix); the S4 one already recorded it for free (no
    // solver budget spent) so it's the one kept.
    if (solverBudget > 0 && !state.ended && !episodeSoftlockFired) {
      const softlock = softlockSolverCheck(index, state, solverBudget);
      if (softlock) {
        addFinding(
          {
            code: "SOFTLOCK",
            step: totalSteps,
            location: loc(state),
            action: null,
            message: softlock.message,
            stateHash: hashState(state),
          },
          record,
        );
      }
    }

    // Minimization (Task 6 Step 5): every NEW (non-deduped), non-ORPHAN finding
    // this episode produced gets its repro trace ddmin'd down to a smaller
    // replayable subsequence — skipped, budget-guarded, when the episode's own
    // action count is already large (a minimization re-run replays a prefix of
    // it many times over; not worth the cost past a few thousand actions).
    if (record.actions.length <= 2000) {
      for (const idx of newFindingIndices) {
        const f = collector.findings[idx];
        if (f) collector.findings[idx] = minimizeFinding(prepared, f, record);
      }
    }
    if (initialSoftlockFired) break;
    if (totalSteps === stepsBeforeEpisode) {
      if (++consecutiveZeroProgressEpisodes >= MAX_CONSECUTIVE_ZERO_PROGRESS_EPISODES) break;
    } else {
      consecutiveZeroProgressEpisodes = 0;
    }
  }

  return {
    questId: prepared.questId,
    steps: totalSteps,
    episodes,
    endingsReached: [...endingsReached].sort(),
    findings: collector.findings,
    totalRawFindings: collector.totalRaw,
    coverage: {
      roomsVisited: [...roomsVisited].sort(),
      actionIdsTried: [...actionIdsApplied].sort(),
    },
  };
}
