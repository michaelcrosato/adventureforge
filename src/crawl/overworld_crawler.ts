/**
 * Overworld crawler (Task 8) — sweeps every town/road in the shipped overworld,
 * reads every quest's local notice board through the SAME progressive local-
 * discovery mechanic a real player faces, then round-trips every quest (start
 * -> solve to a real non-death ending -> complete) proving quest handoff never
 * corrupts overworld session state.
 *
 * Deterministic: the ONLY randomness is `mulberry32(seed)`, used solely to pick
 * a road-encounter resolution strategy when travel triggers one. Everything
 * else (edge-sweep order, local-action order, area BFS routing) is a fixed
 * function of the manifest + accumulated session state, so two runs with the
 * same seed produce byte-identical coverage.
 *
 * PERFORMANCE NOTE: the crawler deliberately never calls `session.view()` /
 * `session.compactView()` inside its loops — building a view computes route
 * options (one Dijkstra per discovered town, ~247 of them late in the sweep)
 * and that cost per step turns a sub-second sweep into minutes. Instead the
 * crawler mirrors the tiny slice of session state it needs (current town,
 * discovered towns/areas/quests, current area) from the RETURN VALUES of the
 * calls it makes — every mutation goes through the crawler, so the mirror
 * can't drift — and re-syncs from `session.snapshot()` (cheap: no route
 * computation) at each quest anchor as a belt-and-braces authority check.
 *
 * Algorithm (see .superpowers/sdd/task-8-brief.md):
 *   1. Edge sweep — repeatedly travel the lexicographically-smallest untraveled
 *      edge reachable from wherever the session currently stands (routing
 *      through `session.planRoute` when not already at one of its endpoints).
 *      Any thrown travel/encounter-resolution is a WORLD finding; the SAME edge
 *      failing twice orphans it (dropped from the sweep, contributes to
 *      `coverage.edges.orphans`).
 *   2. Snapshot roundtrip probe every 25 successful travels — a save/restore
 *      hash mismatch is a PERSIST finding.
 *   3. Boards + quests — for each quest (sorted by id), travel to its anchor
 *      town, then drive the SAME progressive local-discovery a player uses
 *      (explore/scout/talk/investigate, hopping between already-discovered
 *      areas) until the quest's area is current AND the quest itself has
 *      surfaced as discovered. Failure inside the per-town action budget is a
 *      WORLD finding.
 *   4. Round trips — start the quest, solve it to a genuine non-death ending
 *      in-process (`solveToEnding`), complete it, and assert the overworld
 *      session state actually changed and round-trips through a snapshot
 *      restore — any violated expectation is a WORLD finding.
 *   5. Coverage — unvisited nodes / untraveled edges each roll up into ONE
 *      aggregated, report-only ORPHAN finding.
 */
import { z } from "zod";
import { mulberry32 } from "../core/rng.js";
import type {
  OverworldAreaEdge,
  OverworldEdge,
  OverworldManifest,
  OverworldQuest,
} from "../world/overworld.js";
import { loadOverworldManifest } from "../world/source.js";
import { OverworldSession } from "../world/session.js";
import type { OverworldQuestView } from "../world/session_local_discovery.js";
import { initStateForRpgPack } from "../rpg/runner.js";
import { buildOverworldCoverageSummary, type OverworldCoverageSummary } from "./coverage.js";
import { CrawlLocationSchema, FindingCollector, type CrawlFinding } from "./findings.js";
import { prepareShippedQuest } from "./prepare.js";
import { describeSolveToEndingFailure, solveToEnding } from "./quest_solver.js";
import { describeError } from "./step_oracles.js";

type OverworldCrawlOptions = {
  root: string;
  seed: number;
  commit: string;
  /** Whether to start+solve+complete every quest in-process. smoke: true. */
  questRoundTrips: boolean;
  /** `solveToEnding`'s state cap. smoke uses 30000+. */
  solverBudget: number;
  /** Local-action budget per quest-anchor town's discovery loop. Default 40. */
  maxLocalActionsPerTown: number;
};

type OverworldCrawlResult = {
  findings: CrawlFinding[];
  coverage: OverworldCoverageSummary;
  questRoundTrips: { questId: string; endingId: string | null }[];
};

/**
 * Stable authored package for structural quest QA. Ledger Advocate intentionally
 * preserves the quests' default mechanical baseline while satisfying Albany's
 * mandatory player-facing registration boundary.
 */
const STRUCTURAL_QA_REGISTRATION_PROFILE_ID = "albany:ledger_advocate";

type CrawlLocation = z.infer<typeof CrawlLocationSchema>;

/**
 * Pick a stable player-visible approach from the same projected terms shown in
 * full and compact play. Optionless quests deliberately return `undefined`,
 * preserving their historical `startQuest(id)` path.
 */
export function selectCrawlQuestApproach(quest: OverworldQuestView): string | undefined {
  if (!quest.launch) return undefined;
  const available = quest.launch.options
    .filter((option) => option.projection?.available === true)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (available[0]) return available[0].id;
  const reasons = quest.launch.options.map(
    (option) =>
      `${option.title}: ${option.projection?.blockedReason ?? "current resource projection is unavailable"}`,
  );
  throw new Error(`No available launch approach for quest "${quest.id}". ${reasons.join(" ")}`);
}

/** Use exact player-visible service terms; never infer care from hidden campaign state. */
export function shouldCrawlCampaignCare(
  actions: readonly {
    action: string;
    source: string;
    available: boolean;
    changed: boolean;
  }[],
): boolean {
  return actions.some(
    (action) =>
      action.action === "care" &&
      action.source === "campaign_override" &&
      action.available &&
      action.changed,
  );
}

/** Per-area drain cursor: how far the crawler has gotten through that area's
 *  always-available (no discovery gate) local actions. Tracked by the crawler
 *  itself — it drives every call, so it always knows what it has already done. */
type AreaCursor = {
  explored: boolean;
  poiIdx: number;
  charIdx: number;
  eventIdx: number;
};

type AreaContentIndex = {
  poisByArea: Map<string, string[]>;
  charsByArea: Map<string, string[]>;
  eventsByArea: Map<string, string[]>;
};

function buildAreaContentIndex(world: OverworldManifest): AreaContentIndex {
  const poisByArea = new Map<string, string[]>();
  const charsByArea = new Map<string, string[]>();
  const eventsByArea = new Map<string, string[]>();
  const push = (index: Map<string, string[]>, key: string, id: string): void => {
    const list = index.get(key);
    if (list) list.push(id);
    else index.set(key, [id]);
  };
  for (const poi of world.points_of_interest) push(poisByArea, poi.area, poi.id);
  for (const character of world.characters) push(charsByArea, character.area, character.id);
  for (const event of world.local_events) push(eventsByArea, event.area, event.id);
  for (const list of poisByArea.values()) list.sort();
  for (const list of charsByArea.values()) list.sort();
  for (const list of eventsByArea.values()) list.sort();
  return { poisByArea, charsByArea, eventsByArea };
}

/** Undirected road adjacency: every edge listed under both endpoints. */
function buildRoadsByTown(world: OverworldManifest): Map<string, OverworldEdge[]> {
  const roads = new Map<string, OverworldEdge[]>();
  const push = (townId: string, edge: OverworldEdge): void => {
    const list = roads.get(townId);
    if (list) list.push(edge);
    else roads.set(townId, [edge]);
  };
  for (const edge of world.edges) {
    push(edge.from, edge);
    push(edge.to, edge);
  }
  return roads;
}

/** BFS a path of area-route ids from `fromAreaId` to `toAreaId` within one
 *  town's area graph, stepping ONLY through areas already in `discovered`
 *  (mirrors `moveArea`'s own precondition — you can't walk through a district
 *  you haven't mapped yet). The destination itself is exempt only when the
 *  caller has verified it is discovered (both call sites below do). Null when
 *  no such path exists yet. */
function findAreaRoute(
  areaEdges: readonly OverworldAreaEdge[],
  townId: string,
  fromAreaId: string,
  toAreaId: string,
  discovered: ReadonlySet<string>,
): string[] | null {
  if (fromAreaId === toAreaId) return [];
  const adjacency = new Map<string, { edgeId: string; to: string }[]>();
  const push = (from: string, edgeId: string, to: string): void => {
    const list = adjacency.get(from);
    if (list) list.push({ edgeId, to });
    else adjacency.set(from, [{ edgeId, to }]);
  };
  for (const edge of areaEdges) {
    if (edge.home !== townId) continue;
    push(edge.from_area, edge.id, edge.to_area);
    push(edge.to_area, edge.id, edge.from_area);
  }
  for (const list of adjacency.values()) list.sort((a, b) => a.edgeId.localeCompare(b.edgeId));

  const prev = new Map<string, { from: string; edgeId: string }>();
  const visited = new Set<string>([fromAreaId]);
  const queue: string[] = [fromAreaId];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]!;
    if (cur === toAreaId) break;
    for (const { edgeId, to } of adjacency.get(cur) ?? []) {
      if (visited.has(to)) continue;
      if (!discovered.has(to)) continue;
      visited.add(to);
      prev.set(to, { from: cur, edgeId });
      queue.push(to);
    }
  }
  if (!prev.has(toAreaId)) return null;
  const path: string[] = [];
  for (let cursor = toAreaId; cursor !== fromAreaId; ) {
    const step = prev.get(cursor);
    if (!step) return null;
    path.unshift(step.edgeId);
    cursor = step.from;
  }
  return path;
}

export function crawlOverworld(opts: OverworldCrawlOptions): OverworldCrawlResult {
  const world = loadOverworldManifest(opts.root);
  const session = new OverworldSession(world);
  const rng = mulberry32(opts.seed);
  const collector = new FindingCollector({
    seed: opts.seed,
    policy: "overworld",
    commit: opts.commit,
  });

  const nodesById = new Map(world.nodes.map((node) => [node.id, node]));
  const roadsByTown = buildRoadsByTown(world);

  const actionJournal: unknown[] = [];
  let stepCounter = 0;

  // Crawler-side mirror of the session state the loops need (see PERFORMANCE
  // NOTE above). Every mutation flows through this file, so the mirror is
  // updated at each call site from the call's own return value.
  let currentTownId = world.start;
  const visitedNodeIds = new Set<string>([world.start]);
  const discoveredTownIds = new Set<string>([world.start]);
  for (const edge of roadsByTown.get(world.start) ?? []) {
    discoveredTownIds.add(edge.from === world.start ? edge.to : edge.from);
  }
  const traveledEdgeIds = new Set<string>();
  const edgeFailureCounts = new Map<string, number>();

  const record = (entry: Record<string, unknown>): void => {
    actionJournal.push(entry);
    stepCounter += 1;
    // The crawler is an explicit structural QA driver, not a retention player.
    // Keep its exhaustive sweep moving through the same game-native pauses by
    // deterministically selecting continue after each recorded mutation. Pure
    // live agents must make this choice themselves through the player surface.
    for (;;) {
      const journey = session.journey();
      if (journey.pendingChoice !== null) {
        session.chooseJourney("continue");
        continue;
      }
      if (journey.storyChoice !== null) {
        const option =
          journey.storyChoice.kind === "registration"
            ? journey.storyChoice.options.find(
                (candidate) => candidate.id === STRUCTURAL_QA_REGISTRATION_PROFILE_ID,
              )
            : journey.storyChoice.options[0];
        if (!option) {
          throw new Error(
            journey.storyChoice.kind === "registration"
              ? `Opening registration is missing structural-QA profile "${STRUCTURAL_QA_REGISTRATION_PROFILE_ID}".`
              : "Journey story choice has no visible option.",
          );
        }
        session.chooseJourneyStory(option.id);
        actionJournal.push({ op: "chooseJourneyStory", choice: option.id });
        stepCounter += 1;
        continue;
      }
      break;
    }
  };

  const addFinding = (input: {
    code: "WORLD" | "PERSIST";
    location: CrawlLocation;
    message: string;
    action?: unknown;
  }): void => {
    collector.add({
      code: input.code,
      step: stepCounter,
      location: input.location,
      action: input.action ?? null,
      message: input.message,
      stateHash: session.snapshotHash(),
      repro: { kind: "overworld-actions", trace: [...actionJournal], minimized: false },
    });
  };

  const locationAt = (townId: string, questId: string | null): CrawlLocation => ({
    region: nodesById.get(townId)?.region ?? null,
    node: townId,
    questId,
    sceneId: null,
  });

  // Quest round trips are an explicit structural-QA path, but they still use
  // the player runtime and therefore must satisfy its authored first-quest
  // boundary. Complete the opening registration once, before the exhaustive
  // road sweep can carry the session away from its starting-area contact.
  if (opts.questRoundTrips && world.opening_registration) {
    const registration = world.opening_registration;
    try {
      session.talkToCharacter(registration.contact);
      record({ op: "talkToCharacter", characterId: registration.contact });
      if (session.campaignCharacterState().background !== STRUCTURAL_QA_REGISTRATION_PROFILE_ID) {
        throw new Error(
          `opening registration did not apply structural-QA profile "${STRUCTURAL_QA_REGISTRATION_PROFILE_ID}"`,
        );
      }
    } catch (err) {
      addFinding({
        code: "WORLD",
        location: locationAt(registration.home, null),
        message: `opening registration setup for quest round trips threw: ${describeError(err)}`,
      });
    }
  }

  // ---- travel primitives (shared by the edge sweep and quest-anchor travel) ----

  function markArrival(townId: string): void {
    currentTownId = townId;
    visitedNodeIds.add(townId);
    discoveredTownIds.add(townId);
    for (const edge of roadsByTown.get(townId) ?? []) {
      discoveredTownIds.add(edge.from === townId ? edge.to : edge.from);
    }
  }

  function doTravel(edgeId: string): void {
    const entry = session.travel(edgeId);
    record({ op: "travel", edgeId });
    markArrival(entry.toId);
    if (entry.roadEvent?.requires_choice === true) {
      // Ambient route reports travel with the leg and never wedge the sweep.
      // Only an explicitly authored choice event creates a pending encounter;
      // its options are the same labeled costs exposed to real players.
      const options = session.view().pendingRoadEncounter?.options;
      if (!options) throw new Error(`Choice road event "${entry.roadEvent.id}" is not pending.`);
      const strategy = options[rng.int(0, options.length - 1)]!.strategy;
      session.resolveRoadEncounter(strategy);
      record({ op: "resolveRoadEncounter", edgeId, strategy });
    }
    traveledEdgeIds.add(edgeId);
  }

  let travelsSincePersistProbe = 0;
  function persistProbe(): void {
    try {
      const before = session.snapshotHash();
      const restored = OverworldSession.restore(world, session.snapshot());
      const after = restored.snapshotHash();
      if (after !== before) {
        addFinding({
          code: "PERSIST",
          location: locationAt(currentTownId, null),
          message: `overworld snapshot roundtrip hash mismatch at "${currentTownId}" (before=${before}, after=${after})`,
        });
      }
    } catch (err) {
      // A restore that THROWS on the session's own snapshot is itself a
      // persistence defect (this is exactly how the crawler's first pass
      // caught the missing quest-completion renown replay term).
      addFinding({
        code: "PERSIST",
        location: locationAt(currentTownId, null),
        message: `overworld snapshot restore threw at "${currentTownId}": ${describeError(err)}`,
      });
    }
  }

  function attemptTravel(edgeId: string): boolean {
    const fromTownId = currentTownId;
    try {
      doTravel(edgeId);
      edgeFailureCounts.delete(edgeId);
    } catch (err) {
      const count = (edgeFailureCounts.get(edgeId) ?? 0) + 1;
      edgeFailureCounts.set(edgeId, count);
      addFinding({
        code: "WORLD",
        location: locationAt(fromTownId, null),
        message: `travel on edge "${edgeId}" failed: ${describeError(err)}`,
      });
      return false;
    }
    travelsSincePersistProbe += 1;
    if (travelsSincePersistProbe >= 25) {
      travelsSincePersistProbe = 0;
      persistProbe();
    }
    return true;
  }

  function travelToTown(destinationId: string, questId: string | null): boolean {
    if (currentTownId === destinationId) return true;
    let plan;
    try {
      plan = session.planRoute(destinationId);
    } catch (err) {
      addFinding({
        code: "WORLD",
        location: locationAt(currentTownId, questId),
        message: `could not plan a route to "${destinationId}": ${describeError(err)}`,
      });
      return false;
    }
    for (const step of plan.steps) {
      if (!attemptTravel(step.edge.id)) return false;
    }
    return true;
  }

  // ---- Step 1/2: edge sweep ----

  const sortedEdges = [...world.edges].sort((a, b) => a.id.localeCompare(b.id));

  function pickNextEdge(): OverworldEdge | null {
    for (const edge of sortedEdges) {
      if (traveledEdgeIds.has(edge.id)) continue;
      if ((edgeFailureCounts.get(edge.id) ?? 0) >= 2) continue;
      if (discoveredTownIds.has(edge.from) || discoveredTownIds.has(edge.to)) return edge;
    }
    return null;
  }

  for (;;) {
    const edge = pickNextEdge();
    if (!edge) break;

    let ok = true;
    if (edge.from !== currentTownId && edge.to !== currentTownId) {
      const target = discoveredTownIds.has(edge.from) ? edge.from : edge.to;
      ok = travelToTown(target, null);
    }
    if (ok) {
      attemptTravel(edge.id);
    } else {
      // Routing toward the edge failed; count it against the edge so a
      // persistently unreachable edge orphans out instead of looping forever.
      edgeFailureCounts.set(edge.id, (edgeFailureCounts.get(edge.id) ?? 0) + 1);
    }
  }

  // ---- Step 3/4: boards + quests ----

  const areaContent = buildAreaContentIndex(world);
  const areaCursors = new Map<string, AreaCursor>();
  const cursorFor = (areaId: string): AreaCursor => {
    const existing = areaCursors.get(areaId);
    if (existing) return existing;
    const fresh: AreaCursor = { explored: false, poiIdx: 0, charIdx: 0, eventIdx: 0 };
    areaCursors.set(areaId, fresh);
    return fresh;
  };

  function hasFreshLocalActions(areaId: string): boolean {
    const cursor = cursorFor(areaId);
    const pois = areaContent.poisByArea.get(areaId)?.length ?? 0;
    const chars = areaContent.charsByArea.get(areaId)?.length ?? 0;
    const events = areaContent.eventsByArea.get(areaId)?.length ?? 0;
    return (
      !cursor.explored || cursor.poiIdx < pois || cursor.charIdx < chars || cursor.eventIdx < events
    );
  }

  /** Local mirror of the session's discovery state during one quest's board
   *  loop — seeded from `session.snapshot()` on arrival, then folded forward
   *  from each action result's own `discovered*` payloads. */
  type LocalDiscoveryState = {
    currentAreaId: string | null;
    discoveredAreaIds: Set<string>;
    discoveredQuestIds: Set<string>;
  };

  function syncLocalState(): LocalDiscoveryState {
    const snapshot = session.snapshot();
    return {
      currentAreaId: snapshot.currentAreaId,
      discoveredAreaIds: new Set(snapshot.discoveredAreaIds),
      discoveredQuestIds: new Set(snapshot.discoveredQuestIds),
    };
  }

  function foldDiscovery(
    local: LocalDiscoveryState,
    result: {
      discoveredAreas?: { id: string }[];
      discoveredQuests?: { id: string }[];
    },
  ): void {
    for (const area of result.discoveredAreas ?? []) local.discoveredAreaIds.add(area.id);
    for (const quest of result.discoveredQuests ?? []) local.discoveredQuestIds.add(quest.id);
  }

  /** Perform exactly one not-yet-done local action in the current area
   *  (exploreArea, then each poi/character/event in fixed id order — none of
   *  these carry a per-thing discovery gate, so each is a guaranteed-fresh
   *  discovery trigger the first time it's called). False once drained. */
  function tryOneFreshLocalAction(local: LocalDiscoveryState, areaId: string): boolean {
    const cursor = cursorFor(areaId);
    if (!cursor.explored) {
      foldDiscovery(local, session.exploreArea(areaId));
      cursor.explored = true;
      record({ op: "exploreArea", areaId });
      return true;
    }
    const pois = areaContent.poisByArea.get(areaId) ?? [];
    if (cursor.poiIdx < pois.length) {
      const poiId = pois[cursor.poiIdx]!;
      foldDiscovery(local, session.scoutPoi(poiId));
      cursor.poiIdx += 1;
      record({ op: "scoutPoi", poiId });
      return true;
    }
    const characters = areaContent.charsByArea.get(areaId) ?? [];
    if (cursor.charIdx < characters.length) {
      const characterId = characters[cursor.charIdx]!;
      foldDiscovery(local, session.talkToCharacter(characterId));
      cursor.charIdx += 1;
      record({ op: "talkToCharacter", characterId });
      return true;
    }
    const events = areaContent.eventsByArea.get(areaId) ?? [];
    if (cursor.eventIdx < events.length) {
      const eventId = events[cursor.eventIdx]!;
      foldDiscovery(local, session.investigateEvent(eventId));
      cursor.eventIdx += 1;
      record({ op: "investigateEvent", eventId });
      return true;
    }
    return false;
  }

  function moveToArea(local: LocalDiscoveryState, areaRouteId: string): void {
    const result = session.moveArea(areaRouteId);
    local.currentAreaId = result.to.id;
    record({ op: "moveArea", areaRouteId });
  }

  function driveBoardDiscovery(quest: OverworldQuest, maxActions: number): boolean {
    const local = syncLocalState();
    for (let used = 0; used < maxActions; ) {
      const questDiscovered = local.discoveredQuestIds.has(quest.id);
      if (local.currentAreaId === quest.area && questDiscovered) return true;
      if (!local.currentAreaId) return false;

      if (local.discoveredAreaIds.has(quest.area) && local.currentAreaId !== quest.area) {
        const path = findAreaRoute(
          world.area_edges,
          quest.home,
          local.currentAreaId,
          quest.area,
          local.discoveredAreaIds,
        );
        if (path && path.length > 0) {
          moveToArea(local, path[0]!);
          used += 1;
          continue;
        }
      }

      if (tryOneFreshLocalAction(local, local.currentAreaId)) {
        used += 1;
        continue;
      }

      // Current area drained: hop to an already-discovered area of this town
      // that still has fresh content (smallest area id first, deterministic).
      let moved = false;
      for (const areaId of [...local.discoveredAreaIds].sort()) {
        if (areaId === local.currentAreaId || !hasFreshLocalActions(areaId)) continue;
        const path = findAreaRoute(
          world.area_edges,
          quest.home,
          local.currentAreaId,
          areaId,
          local.discoveredAreaIds,
        );
        if (path && path.length > 0) {
          moveToArea(local, path[0]!);
          used += 1;
          moved = true;
          break;
        }
      }
      if (moved) continue;

      return false; // nothing fresh anywhere reachable — budget can't help
    }
    return false;
  }

  function roundTripQuest(quest: OverworldQuest): { questId: string; endingId: string | null } {
    const loc = locationAt(quest.home, quest.id);
    try {
      const hashBefore = session.snapshotHash();
      session.previewQuestStart(quest.id);
      record({ op: "previewQuestStart", questId: quest.id });

      let preview = session.previewQuestStart(quest.id);
      let approachId: string | undefined;
      try {
        approachId = selectCrawlQuestApproach(preview);
      } catch (initialError) {
        // A launch cost can become blocked after the exhaustive road sweep.
        // Use the ordinary player service once, then recompute the projections;
        // never bypass or forge the authored resource requirement.
        const resupply = session.resupplyAtTown();
        record({ op: "resupplyAtTown", questId: quest.id, changed: resupply.changed });
        preview = session.previewQuestStart(quest.id);
        try {
          approachId = selectCrawlQuestApproach(preview);
        } catch (afterResupplyError) {
          throw new Error(
            `${describeError(initialError)} After resupply: ${describeError(afterResupplyError)}`,
            { cause: afterResupplyError },
          );
        }
      }

      const plan =
        approachId === undefined
          ? session.prepareQuestStart(quest.id)
          : session.prepareQuestStart(quest.id, approachId);

      const prepared = prepareShippedQuest(opts.root, quest.id);
      const initialState = quest.launch
        ? (() => {
            if (!quest.campaign_imports) {
              throw new Error(`Launch-enabled quest "${quest.id}" has no campaign import catalog.`);
            }
            return initStateForRpgPack(prepared.index, opts.seed, {
              character: plan.characterAfter,
              imports: quest.campaign_imports,
            });
          })()
        : undefined;

      session.commitQuestStart(plan);
      record({
        op: "startQuest",
        questId: quest.id,
        ...(approachId !== undefined ? { approachId } : {}),
      });

      const solved = solveToEnding(prepared, opts.seed, opts.solverBudget, {
        ...(initialState !== undefined ? { initialState } : {}),
      });
      if (!solved.ok) {
        addFinding({
          code: "WORLD",
          location: loc,
          message: describeSolveToEndingFailure(solved.reason, quest.id, opts.solverBudget),
        });
        return { questId: quest.id, endingId: null };
      }

      session.completeQuest(quest.id, {
        endingId: solved.endingId,
        endingTitle: solved.endingTitle,
        death: false,
      });
      record({ op: "completeQuest", questId: quest.id, endingId: solved.endingId });
      if (shouldCrawlCampaignCare(session.view().serviceActions)) {
        const care = session.careAtTown();
        record({ op: "careAtTown", questId: quest.id, changed: care.changed });
      }

      const hashAfter = session.snapshotHash();
      if (hashAfter === hashBefore) {
        addFinding({
          code: "WORLD",
          location: loc,
          message: `quest handoff/return corrupted overworld state: snapshot hash did not change after completing "${quest.id}"`,
        });
      }

      const restored = OverworldSession.restore(world, session.snapshot());
      if (restored.snapshotHash() !== hashAfter) {
        addFinding({
          code: "WORLD",
          location: loc,
          message: `quest handoff/return corrupted overworld state: restore roundtrip mismatch after completing "${quest.id}"`,
        });
      }

      const snapshot = session.snapshot();
      if (
        !snapshot.startedQuestIds.includes(quest.id) ||
        !snapshot.completedQuestIds.includes(quest.id)
      ) {
        addFinding({
          code: "WORLD",
          location: loc,
          message: `quest handoff/return corrupted overworld state: started/completed quest ids missing "${quest.id}" after completion`,
        });
      }

      return { questId: quest.id, endingId: solved.endingId };
    } catch (err) {
      addFinding({
        code: "WORLD",
        location: loc,
        message: `quest round trip for "${quest.id}" threw: ${describeError(err)}`,
      });
      return { questId: quest.id, endingId: null };
    }
  }

  const sortedQuests = [...world.quests].sort((a, b) => a.id.localeCompare(b.id));
  const boardsReadKeys = new Set<string>();
  const boardsTotalKeys = new Set(world.quests.map((q) => `${q.home}::${q.area}`));
  const questRoundTrips: { questId: string; endingId: string | null }[] = [];

  for (const quest of sortedQuests) {
    if (!travelToTown(quest.home, quest.id)) {
      if (opts.questRoundTrips) questRoundTrips.push({ questId: quest.id, endingId: null });
      continue;
    }

    let discovered: boolean;
    try {
      discovered = driveBoardDiscovery(quest, opts.maxLocalActionsPerTown);
    } catch (err) {
      addFinding({
        code: "WORLD",
        location: locationAt(quest.home, quest.id),
        message: `board discovery for quest "${quest.id}" threw: ${describeError(err)}`,
      });
      discovered = false;
    }
    if (!discovered) {
      addFinding({
        code: "WORLD",
        location: locationAt(quest.home, quest.id),
        message: `quest "${quest.id}" not discoverable from its anchor within ${opts.maxLocalActionsPerTown} local actions`,
      });
      if (opts.questRoundTrips) questRoundTrips.push({ questId: quest.id, endingId: null });
      continue;
    }
    boardsReadKeys.add(`${quest.home}::${quest.area}`);

    if (opts.questRoundTrips) {
      questRoundTrips.push(roundTripQuest(quest));
    }
  }

  // ---- Step 6: coverage + aggregated ORPHAN findings ----

  const finalSnapshot = session.snapshot();
  const coverage = buildOverworldCoverageSummary({
    world,
    visitedNodeIds,
    traveledEdgeIds,
    boardsRead: boardsReadKeys,
    boardsTotal: boardsTotalKeys,
    questsEntered: finalSnapshot.startedQuestIds,
  });

  const orphanFinding = (kind: "towns" | "roads", ids: readonly string[]): void => {
    collector.add({
      code: "ORPHAN",
      step: stepCounter,
      location: { region: null, node: null, questId: null, sceneId: null },
      action: null,
      message: `overworld ${kind} never ${kind === "towns" ? "visited" : "traveled"}: count=${ids.length} first10=[${ids.slice(0, 10).join(", ")}]`,
      stateHash: session.snapshotHash(),
      repro: { kind: "none", trace: null, minimized: false },
    });
  };
  if (coverage.nodes.orphans.length > 0) orphanFinding("towns", coverage.nodes.orphans);
  if (coverage.edges.orphans.length > 0) orphanFinding("roads", coverage.edges.orphans);

  return {
    findings: collector.findings,
    coverage,
    questRoundTrips,
  };
}
