import { describe, expect, it, onTestFinished } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolApi } from "../../src/mcp/tools.js";
import { OVERWORLD_CONTACT_PROSE_PREDECESSOR_WORLD_HASH } from "../../src/world/contact_journal_prose_migration.js";
import { createInitialCampaignCharacterState } from "../../src/world/campaign_character_state.js";
import {
  overworldAreasAt,
  overworldEdgesFrom,
  overworldQuestsAt,
  overworldRoadEventFor,
} from "../../src/world/overworld.js";
import { overworldExplorationSitesInArea, overworldJobsAt } from "./support/overworld_queries.js";
import { loadOverworldManifest } from "../../src/world/source.js";

const api = () => createToolApi({ root: process.cwd() });
const overworld = loadOverworldManifest(process.cwd());
const FULL_OVERWORLD_RESPONSE = {
  compact_context: false,
  compact_result: false,
} as const;

function syntheticLegacyGenericMarketJob(): {
  a: ReturnType<typeof api>;
  world: typeof overworld;
} {
  const root = mkdtempSync(join(tmpdir(), "snapshot-generic-jobs-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const world = structuredClone(overworld);
  const marketJob = world.local_jobs.find(
    (candidate) => candidate.id === "albany_city__market__job",
  );
  if (!marketJob) throw new Error("expected the synthetic Market job fixture");
  delete marketJob.authored_scene;
  mkdirSync(join(root, "content", "world"), { recursive: true });
  writeFileSync(
    join(root, "content", "world", "new_york_overworld.json"),
    `${JSON.stringify(world, null, 2)}\n`,
  );
  cpSync(join(process.cwd(), "content", "rpg", "quests"), join(root, "content", "rpg", "quests"), {
    recursive: true,
  });
  return { a: createToolApi({ root }), world };
}

type Snapshot = ReturnType<typeof exportedSnapshotAfterTwoRoads>["snapshot"];
type JournalEntry = Snapshot["journalEntries"][number];
type LocalActionJournalKind = Extract<JournalEntry["kind"], "contact" | "event" | "poi">;
type LocalActionJournalSource = {
  id: string;
  home: string;
  area: string;
};
type LocalActionJournalCase = {
  label: string;
  kind: LocalActionJournalKind;
  prefix: "investigate" | "scout" | "talk";
  sources: readonly LocalActionJournalSource[];
  chronologyPattern: RegExp;
  unvisitedPattern: RegExp;
  undiscoveredPattern: RegExp;
};

function townName(nodeId: string): string {
  const town = overworld.nodes.find((node) => node.id === nodeId);
  if (!town) throw new Error(`unknown test town ${nodeId}`);
  return town.name;
}

function otherTownName(name: string): string {
  const town = overworld.nodes.find((node) => node.name !== name);
  if (!town) throw new Error(`expected another town besides ${name}`);
  return town.name;
}

function otherRegionName(name: string): string {
  const region = overworld.regions.find((candidate) => candidate.name !== name);
  if (!region) throw new Error(`expected another region besides ${name}`);
  return region.name;
}

function townRegion(nodeId: string): string {
  const town = overworld.nodes.find((node) => node.id === nodeId);
  if (!town) throw new Error(`unknown test town ${nodeId}`);
  return town.region;
}

function timeLabelForMinutes(minutes: number): string {
  const day = Math.floor(minutes / 1440) + 1;
  const minuteOfDay = minutes % 1440;
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `Day ${day}, ${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

function visitedTownAreas(
  snapshot: Snapshot,
  minimumCount: number,
  excludedFirstAreaId: string | null = null,
) {
  for (const townId of snapshot.visitedIds) {
    const areas = overworldAreasAt(overworld, townId);
    if (areas.length >= minimumCount && areas[0]?.id !== excludedFirstAreaId) {
      return { townId, areas };
    }
  }
  throw new Error(`expected a visited town with at least ${minimumCount} areas`);
}

function visitedTownJobs(snapshot: Snapshot, minimumCount: number) {
  for (const townId of snapshot.visitedIds) {
    const areas = overworldAreasAt(overworld, townId);
    const jobs = overworldJobsAt(overworld, townId);
    if (jobs.length >= minimumCount) return { areaIds: areas.map((area) => area.id), jobs };
  }
  throw new Error(`expected a visited town with at least ${minimumCount} jobs`);
}

function appendUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function appendUniques(values: readonly string[], additions: readonly string[]): string[] {
  let next = [...values];
  for (const addition of additions) next = appendUnique(next, addition);
  return next;
}

function addRenown(
  values: readonly (readonly [string, number])[],
  region: string,
  amount: number,
): [string, number][] {
  const totals = new Map(values);
  totals.set(region, (totals.get(region) ?? 0) + amount);
  return [...totals.entries()];
}

function exportedSnapshotAfterTwoRoads() {
  const a = api();
  const started = a.start_overworld({ compact_context: false });
  const firstRoad =
    started.observation.exits.find((edge) => edge.destination.id === "colonie_town") ??
    started.observation.exits[0];
  if (!firstRoad) throw new Error("expected an overworld road from start");

  a.travel_overworld_session({ session_id: started.session_id, road_id: firstRoad.id });
  a.resolve_overworld_session_road_encounter({
    ...FULL_OVERWORLD_RESPONSE,
    session_id: started.session_id,
    strategy: "press_on",
  });

  const afterFirstRoad = a.get_overworld_session({
    include_observation: true,
    session_id: started.session_id,
  }).observation;
  const secondRoad =
    afterFirstRoad.exits.find(
      (edge) => edge.id !== firstRoad.id && overworldRoadEventFor(overworld, edge.id),
    ) ?? afterFirstRoad.exits[0];
  if (!secondRoad) throw new Error("expected a second overworld road");
  a.travel_overworld_session({ session_id: started.session_id, road_id: secondRoad.id });
  const afterSecondRoad = a.get_overworld_session({
    include_observation: true,
    session_id: started.session_id,
  }).observation;
  if (afterSecondRoad.pendingRoadEncounter) {
    a.resolve_overworld_session_road_encounter({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      strategy: "press_on",
    });
  }

  const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
  expect(snapshot.travelLog.length).toBeGreaterThanOrEqual(2);
  expect(snapshot.journalEntries.some((entry) => entry.kind === "road")).toBe(true);
  return { a, snapshot };
}

function exportedSnapshotWithResolvedInitialEvent() {
  const a = api();
  const started = a.start_overworld({ compact_context: false });
  const road =
    started.observation.exits.find((edge) => edge.destination.id === "colonie_town") ??
    started.observation.exits[0];
  if (!road) throw new Error("expected a road out of Albany");
  a.travel_overworld_session({ session_id: started.session_id, road_id: road.id });
  let observation = a.get_overworld_session({
    include_observation: true,
    session_id: started.session_id,
  }).observation;
  if (observation.pendingRoadEncounter) {
    a.resolve_overworld_session_road_encounter({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      strategy: "press_on",
    });
    observation = a.get_overworld_session({
      include_observation: true,
      session_id: started.session_id,
    }).observation;
  }
  const poi = observation.pois[0];
  const contact = observation.characters[0];
  const event = observation.events[0];
  if (!poi || !contact || !event) throw new Error("expected initial local event prerequisites");

  a.scout_overworld_session_poi({ session_id: started.session_id, poi_id: poi.id });
  a.talk_overworld_session_contact({
    ...FULL_OVERWORLD_RESPONSE,
    session_id: started.session_id,
    character_id: contact.id,
  });
  a.investigate_overworld_session_event({
    ...FULL_OVERWORLD_RESPONSE,
    session_id: started.session_id,
    event_id: event.id,
  });
  a.resolve_overworld_session_event({
    ...FULL_OVERWORLD_RESPONSE,
    session_id: started.session_id,
    event_id: event.id,
  });

  const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
  expect(snapshot.resolvedEventIds).toContain(event.id);
  return { a, snapshot, poi, contact, event };
}

function exportedSnapshotWithBaseHaydenConversation() {
  const a = api();
  const started = a.start_overworld({ compact_context: false });
  const sessionId = started.session_id;
  a.scout_overworld_session_poi({
    ...FULL_OVERWORLD_RESPONSE,
    session_id: sessionId,
    poi_id: "albany_city__civic_core__poi",
  });
  let view = a.get_overworld_session({
    include_observation: true,
    session_id: sessionId,
  }).observation;
  const marketRoute = view.areaExits.find(
    (route) => route.destination.id === "albany_city__market",
  );
  if (!marketRoute) throw new Error("expected the Albany market route");
  a.move_overworld_session_area({
    ...FULL_OVERWORLD_RESPONSE,
    session_id: sessionId,
    area_route_id: marketRoute.id,
  });
  a.scout_overworld_session_poi({
    ...FULL_OVERWORLD_RESPONSE,
    session_id: sessionId,
    poi_id: "albany_city__market__poi",
  });
  view = a.get_overworld_session({ include_observation: true, session_id: sessionId }).observation;
  const stationRoute = view.areaExits.find(
    (route) => route.destination.id === "albany_city__transport_hub",
  );
  if (!stationRoute) throw new Error("expected the Albany Station Quarter route");
  a.move_overworld_session_area({
    ...FULL_OVERWORLD_RESPONSE,
    session_id: sessionId,
    area_route_id: stationRoute.id,
  });
  a.talk_overworld_session_contact({
    ...FULL_OVERWORLD_RESPONSE,
    session_id: sessionId,
    character_id: "albany_city__transport_hub__contact",
  });
  const snapshot = a.export_overworld_session({ session_id: sessionId }).snapshot;
  const entry = snapshot.journalEntries.find(
    (candidate) => candidate.id === "talk:albany_city__transport_hub__contact",
  );
  if (!entry) throw new Error("expected Hayden's base contact journal entry");
  return { a, snapshot, entry };
}

function exportedSnapshotAfterRoadStrategy(strategy: "assist_travelers" | "cautious_scout") {
  const a = api();
  const started = a.start_overworld({ compact_context: false });
  const firstRoad =
    started.observation.exits.find((edge) => edge.destination.id === "colonie_town") ??
    started.observation.exits[0];
  if (!firstRoad) throw new Error("expected an overworld road from start");

  a.travel_overworld_session({ session_id: started.session_id, road_id: firstRoad.id });
  a.resolve_overworld_session_road_encounter({
    ...FULL_OVERWORLD_RESPONSE,
    session_id: started.session_id,
    strategy,
  });

  const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
  expect(snapshot.journalEntries.some((entry) => entry.kind === "road")).toBe(true);
  expect(snapshot.regionRenown.length).toBeGreaterThan(0);
  return { a, snapshot };
}

function overworldRoadPath(from: string, to: string): string[] {
  const queue: { town: string; roadIds: string[] }[] = [{ town: from, roadIds: [] }];
  const seen = new Set<string>([from]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    if (current.town === to) return current.roadIds;
    for (const edge of overworld.edges.filter(
      (candidate) => candidate.from === current.town || candidate.to === current.town,
    )) {
      const nextTown = edge.from === current.town ? edge.to : edge.from;
      if (seen.has(nextTown)) continue;
      seen.add(nextTown);
      queue.push({ town: nextTown, roadIds: [...current.roadIds, edge.id] });
    }
  }
  throw new Error(`expected road path from ${from} to ${to}`);
}

function travelOverworldSessionTo(
  a: ReturnType<typeof api>,
  sessionId: string,
  townId: string,
): void {
  const start = a.get_overworld_session({ include_observation: true, session_id: sessionId })
    .observation.current.id;
  for (const roadId of overworldRoadPath(start, townId)) {
    a.travel_overworld_session({ session_id: sessionId, road_id: roadId });
    const observation = a.get_overworld_session({
      include_observation: true,
      session_id: sessionId,
    }).observation;
    if (observation.pendingRoadEncounter) {
      a.resolve_overworld_session_road_encounter({
        ...FULL_OVERWORLD_RESPONSE,
        session_id: sessionId,
        strategy: "press_on",
      });
    }
  }
}

function resolveCurrentOverworldSessionEvent(a: ReturnType<typeof api>, sessionId: string): void {
  const view = a.get_overworld_session({
    include_observation: true,
    session_id: sessionId,
  }).observation;
  const event = view.events.find((candidate) => !view.resolvedEventIds.includes(candidate.id));
  if (!event) throw new Error(`expected unresolved event in ${view.current.id}`);
  const poi = view.pois[0];
  const contact = view.characters[0];
  if (!poi || !contact) throw new Error("expected local event prerequisites");
  a.scout_overworld_session_poi({ session_id: sessionId, poi_id: poi.id });
  const talked = a.talk_overworld_session_contact({
    session_id: sessionId,
    character_id: contact.id,
  });
  if (talked.journey.storyChoice?.kind === "registration") {
    a.choose_overworld_session_story({
      session_id: sessionId,
      choice: "albany:ledger_advocate",
    });
    a.choose_overworld_session_story({
      session_id: sessionId,
      choice: "albany:oath_limited_aid_only",
    });
    const sourced = a.choose_overworld_session_story({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: sessionId,
      choice: "albany:source_rowan_civic_docket",
    });
    const preparationArea = overworld.opening_preparation?.area;
    if (!preparationArea) throw new Error("expected Albany opening preparation");
    const preparationRoute = sourced.observation.areaExits.find(
      (route) => route.destination.id === preparationArea,
    );
    if (!preparationRoute) throw new Error("expected a route to the opening preparation board");
    const stationed = a.move_overworld_session_area({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: sessionId,
      area_route_id: preparationRoute.id,
    });
    expect(stationed.journey.storyChoice).toBeNull();
    expect(
      stationed.observation.departureInteractions.map((interaction) => interaction.id),
    ).toEqual(["albany:wolf_preparation", "albany:wolf_relief_allocation"]);
    a.choose_overworld_session_story({
      session_id: sessionId,
      story_choice_id: "albany:wolf_preparation",
      choice: "albany:prep_works_fortification",
    });
    a.choose_overworld_session_story({
      session_id: sessionId,
      story_choice_id: "albany:wolf_relief_allocation",
      choice: "albany:relief_resident_shelter",
    });
  }
  const afterOpening = a.get_overworld_session({
    include_observation: true,
    session_id: sessionId,
  }).observation;
  if (afterOpening.currentArea?.id !== event.area) {
    const eventRoute = afterOpening.areaExits.find((route) => route.destination.id === event.area);
    if (!eventRoute) throw new Error(`expected a route to event area ${event.area}`);
    a.move_overworld_session_area({ session_id: sessionId, area_route_id: eventRoute.id });
  }
  a.investigate_overworld_session_event({ session_id: sessionId, event_id: event.id });
  a.resolve_overworld_session_event({
    session_id: sessionId,
    event_id: event.id,
    ...(event.authored_scene?.options[0] ? { option_id: event.authored_scene.options[0].id } : {}),
  });
}

function exportedSnapshotWithCompletedRegionalArc() {
  const a = api();
  const started = a.start_overworld({ compact_context: false });
  const arc = overworld.regional_arcs.find((candidate) => candidate.region === "Capital / Mohawk");
  if (!arc) throw new Error("expected Capital / Mohawk regional arc");

  for (const townId of arc.anchor_towns.slice(0, arc.required_resolutions)) {
    travelOverworldSessionTo(a, started.session_id, townId);
    resolveCurrentOverworldSessionEvent(a, started.session_id);
  }

  const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
  expect(snapshot.completedRegionalArcIds).toContain(arc.id);
  return { a, snapshot, arc };
}

function exportedSnapshotWithPendingRoad() {
  const a = api();
  const started = a.start_overworld({ compact_context: false });
  const road =
    started.observation.exits.find((edge) => overworldRoadEventFor(overworld, edge.id) !== null) ??
    started.observation.exits[0];
  if (!road) throw new Error("expected an overworld road from start");

  a.travel_overworld_session({ session_id: started.session_id, road_id: road.id });
  const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
  expect(snapshot.pendingRoadEncounter).toEqual({ edgeId: road.id });
  expect(snapshot.travelLog[0]?.edgeId).toBe(road.id);
  expect(snapshot.travelLog[0]?.roadEventId).toBe(overworldRoadEventFor(overworld, road.id)?.id);
  return { a, snapshot };
}

const localActionJournalCases: readonly LocalActionJournalCase[] = [
  {
    label: "point of interest",
    kind: "poi",
    prefix: "scout",
    sources: overworld.points_of_interest,
    chronologyPattern: /journal point of interest.*before visiting town/,
    unvisitedPattern: /journal point of interest.*unvisited town/,
    undiscoveredPattern: /journal point of interest.*undiscovered area/,
  },
  {
    label: "contact",
    kind: "contact",
    prefix: "talk",
    sources: overworld.characters,
    chronologyPattern: /journal contact.*before visiting town/,
    unvisitedPattern: /journal contact.*unvisited town/,
    undiscoveredPattern: /journal contact.*undiscovered area/,
  },
  {
    label: "event investigation",
    kind: "event",
    prefix: "investigate",
    sources: overworld.local_events.filter((event) => !event.authored_scene),
    chronologyPattern: /journal event.*before visiting town/,
    unvisitedPattern: /journal event.*unvisited town/,
    undiscoveredPattern: /journal event.*undiscovered area/,
  },
];

function localActionJournalEntry(
  snapshot: Snapshot,
  source: LocalActionJournalSource,
  journalCase: LocalActionJournalCase,
  recordedAt = snapshot.journalEntries[0]!.recordedAt,
): JournalEntry {
  return {
    id: `${journalCase.prefix}:${source.id}`,
    kind: journalCase.kind,
    town: townName(source.home),
    title: `Forged ${journalCase.label}`,
    text: "Forged local action journal proof.",
    recordedAt,
  };
}

describe("overworld snapshot restore integrity", () => {
  it("rejects duplicate journal ids in forged session snapshots", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const duplicatedJournal = {
      ...snapshot,
      journalEntries: [snapshot.journalEntries[0]!, ...snapshot.journalEntries],
    };

    expect(() => a.restore_overworld_session({ snapshot: duplicatedJournal })).toThrow(
      /duplicate journal entry id/,
    );
  });

  it("rejects malformed journal timestamps in forged session snapshots", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const malformedJournal = {
      ...snapshot,
      journalEntries: [
        { ...snapshot.journalEntries[0]!, recordedAt: "yesterday" },
        ...snapshot.journalEntries.slice(1),
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: malformedJournal })).toThrow(
      /malformed journal timestamp/,
    );
  });

  it("rejects journal entries bound to unknown overworld towns", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const detachedJournalTown = {
      ...snapshot,
      journalEntries: [
        { ...snapshot.journalEntries[0]!, town: "Atlantis" },
        ...snapshot.journalEntries.slice(1),
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: detachedJournalTown })).toThrow(
      /unknown town/,
    );
  });

  it("rejects journal entries whose kind does not match their source id", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const mismatchedJournalSource = {
      ...snapshot,
      journalEntries: [
        { ...snapshot.journalEntries[0]!, kind: "job" as const },
        ...snapshot.journalEntries.slice(1),
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: mismatchedJournalSource })).toThrow(
      /journal job entry id/,
    );
  });

  it("rejects journal entries bound to unknown overworld source ids", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const roadEntry = snapshot.journalEntries.find((entry) => entry.kind === "road");
    if (!roadEntry) throw new Error("expected a road journal entry");
    const roadMatch = /^road:(.+):(\d+):([a-z_]+)$/.exec(roadEntry.id);
    if (!roadMatch) throw new Error(`unexpected road journal id ${roadEntry.id}`);
    const detachedJournalSource = {
      ...snapshot,
      journalEntries: snapshot.journalEntries.map((entry) =>
        entry === roadEntry
          ? { ...entry, id: `road:missing_road:${roadMatch[2]}:${roadMatch[3]}` }
          : entry,
      ),
    };

    expect(() => a.restore_overworld_session({ snapshot: detachedJournalSource })).toThrow(
      /unknown road/,
    );
  });

  it("rejects current-provenance contact rewrites while preserving legacy journal copy", () => {
    const { a, snapshot, entry } = exportedSnapshotWithBaseHaydenConversation();
    const replaceEntry = (replacement: JournalEntry): Snapshot => ({
      ...snapshot,
      journalEntries: snapshot.journalEntries.map((candidate) =>
        candidate === entry ? replacement : candidate,
      ),
    });

    expect(() =>
      a.restore_overworld_session({
        snapshot: replaceEntry({ ...entry, id: `${entry.id}@missing_phase` }),
      }),
    ).toThrow(/unknown contact presentation/);

    expect(() =>
      a.restore_overworld_session({
        snapshot: replaceEntry({
          ...entry,
          id: `${entry.id}@wolf_winter_and_gallowmere_closed`,
        }),
      }),
    ).toThrow(/contact presentation .* was not active/);

    expect(() =>
      a.restore_overworld_session({
        snapshot: replaceEntry({ ...entry, text: "Hayden's earlier dispatch wording." }),
      }),
    ).toThrow(/does not match its authored copy/);

    const legacyText = "Hayden's earlier dispatch wording.";
    const legacy = a.restore_overworld_session({
      snapshot: {
        ...replaceEntry({ ...entry, text: legacyText }),
        worldHash: "0".repeat(64),
      },
    });
    const legacyExport = a.export_overworld_session({ session_id: legacy.session_id });
    expect(legacyExport.ok).toBe(true);
    if (!legacyExport.ok) throw new Error("expected legacy contact export");
    expect(
      legacyExport.snapshot.journalEntries.find((candidate) => candidate.id === entry.id)?.text,
    ).toBe(legacyText);
  });

  it("rejects forged prose in content-authored local journal lines under the current world", () => {
    const { a, snapshot } = exportedSnapshotWithResolvedInitialEvent();
    // scout and investigate write the two content-authored local lines the
    // starting slice can produce; both are pure functions of the world file, so
    // there is exactly one string the engine could have written for each.
    const forgeable = snapshot.journalEntries.filter(
      (candidate) => candidate.kind === "poi" || candidate.kind === "event",
    );
    expect([...forgeable.map((candidate) => candidate.kind)].sort()).toEqual(["event", "poi"]);

    for (const entry of forgeable) {
      const replaceEntry = (replacement: JournalEntry): Snapshot => ({
        ...snapshot,
        journalEntries: snapshot.journalEntries.map((candidate) =>
          candidate === entry ? replacement : candidate,
        ),
      });
      const authoredCopy = new RegExp(
        `${entry.kind} journal entry .* does not match its authored copy`,
      );

      expect(() =>
        a.restore_overworld_session({
          snapshot: replaceEntry({ ...entry, title: `Forged ${entry.kind} title` }),
        }),
      ).toThrow(authoredCopy);

      expect(() =>
        a.restore_overworld_session({
          snapshot: replaceEntry({
            ...entry,
            text: "Forged: the sheriff waives every fee for you forever.",
          }),
        }),
      ).toThrow(authoredCopy);

      // A save written against different world content legitimately carries the
      // prose of its own generation, so it still restores under the provenance
      // warning with the player's own history intact.
      const legacyText = "Earlier generation wording for this line.";
      const legacy = a.restore_overworld_session({
        snapshot: {
          ...replaceEntry({ ...entry, text: legacyText }),
          worldHash: "0".repeat(64),
        },
      });
      const legacyExport = a.export_overworld_session({ session_id: legacy.session_id });
      expect(legacyExport.ok).toBe(true);
      if (!legacyExport.ok) throw new Error(`expected legacy ${entry.kind} export`);
      expect(
        legacyExport.snapshot.journalEntries.find((candidate) => candidate.id === entry.id)?.text,
      ).toBe(legacyText);
    }
  });

  it("upgrades exact predecessor contact copy and survives re-export plus a second restore", () => {
    const { a, snapshot, entry } = exportedSnapshotWithBaseHaydenConversation();
    const predecessorText =
      "Hayden Hale dispatches road wardens from Albany Station Quarter, matching late coaches, snow reports, and relief freight to travelers who can move faster than official crews. Hayden matches every hill dispatch to Rowan's controlling source certification; settled packets carry route timing to Old Cade's steading and the other winter stops.";
    const predecessorEntries = snapshot.journalEntries.map((candidate) =>
      candidate === entry ? { ...entry, text: predecessorText } : candidate,
    );

    expect(() =>
      a.restore_overworld_session({
        snapshot: { ...snapshot, journalEntries: predecessorEntries },
      }),
    ).toThrow(/does not match its authored copy/);

    const restored = a.restore_overworld_session({
      snapshot: {
        ...snapshot,
        journalEntries: predecessorEntries,
        worldHash: OVERWORLD_CONTACT_PROSE_PREDECESSOR_WORLD_HASH,
      },
    });
    const migrated = a.export_overworld_session({ session_id: restored.session_id });
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) throw new Error("expected migrated predecessor contact export");
    expect(migrated.snapshot.worldHash).toBe(snapshot.worldHash);
    expect(
      migrated.snapshot.journalEntries.find((candidate) => candidate.id === entry.id)?.text,
    ).toBe(entry.text);

    const restoredAgain = a.restore_overworld_session({ snapshot: migrated.snapshot });
    const exportedAgain = a.export_overworld_session({ session_id: restoredAgain.session_id });
    expect(exportedAgain.ok).toBe(true);
    if (!exportedAgain.ok) throw new Error("expected twice-restored predecessor contact export");
    expect(exportedAgain.snapshot).toEqual(migrated.snapshot);
  });

  it.each([
    {
      label: "area",
      makeEntry(): JournalEntry {
        const area = overworld.areas[0]!;
        return {
          id: `area:${area.id}`,
          kind: "area",
          town: otherTownName(townName(area.home)),
          title: "Forged area",
          text: "Forged area journal proof.",
          recordedAt: "Day 1, 08:00",
        };
      },
    },
    {
      label: "contact",
      makeEntry(): JournalEntry {
        const character = overworld.characters[0]!;
        return {
          id: `talk:${character.id}`,
          kind: "contact",
          town: otherTownName(townName(character.home)),
          title: "Forged contact",
          text: "Forged contact journal proof.",
          recordedAt: "Day 1, 08:00",
        };
      },
    },
    {
      label: "event investigation",
      makeEntry(): JournalEntry {
        const event = overworld.local_events[0]!;
        return {
          id: `investigate:${event.id}`,
          kind: "event",
          town: otherTownName(townName(event.home)),
          title: "Forged investigation",
          text: "Forged event journal proof.",
          recordedAt: "Day 1, 08:00",
        };
      },
    },
    {
      label: "job",
      makeEntry(): JournalEntry {
        const job = overworld.local_jobs[0]!;
        return {
          id: `job:${job.id}`,
          kind: "job",
          town: otherTownName(townName(job.home)),
          title: "Forged job",
          text: "Forged job journal proof.",
          recordedAt: "Day 1, 08:00",
        };
      },
    },
    {
      label: "point of interest",
      makeEntry(): JournalEntry {
        const poi = overworld.points_of_interest[0]!;
        return {
          id: `scout:${poi.id}`,
          kind: "poi",
          town: otherTownName(townName(poi.home)),
          title: "Forged scout",
          text: "Forged point-of-interest journal proof.",
          recordedAt: "Day 1, 08:00",
        };
      },
    },
    {
      label: "site",
      makeEntry(): JournalEntry {
        const site = overworld.exploration_sites[0]!;
        return {
          id: `site:${site.id}`,
          kind: "site",
          town: otherTownName(townName(site.nearest_town)),
          title: "Forged site",
          text: "Forged site journal proof.",
          recordedAt: "Day 1, 08:00",
        };
      },
    },
    {
      label: "resolution",
      makeEntry(): JournalEntry {
        const event = overworld.local_events[0]!;
        return {
          id: `resolve:${event.id}`,
          kind: "resolution",
          town: otherTownName(townName(event.home)),
          title: "Forged resolution",
          text: "Forged resolution journal proof.",
          recordedAt: "Day 1, 08:00",
        };
      },
    },
    {
      label: "regional arc",
      makeEntry(): JournalEntry {
        const arc = overworld.regional_arcs[0]!;
        return {
          id: `arc:${arc.id}`,
          kind: "regional_arc",
          town: otherRegionName(arc.region),
          title: "Forged regional arc",
          text: "Forged regional arc journal proof.",
          recordedAt: "Day 1, 08:00",
        };
      },
    },
  ])("rejects $label journal entries bound to the wrong place", ({ makeEntry }) => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const forgedJournal = {
      ...snapshot,
      journalEntries: [makeEntry(), ...snapshot.journalEntries],
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedJournal })).toThrow(
      /journal .* entry .*expected/,
    );
  });

  it("rejects road journal entries bound to the wrong arrival town", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const roadEntry = snapshot.journalEntries.find((entry) => entry.kind === "road");
    if (!roadEntry) throw new Error("expected a road journal entry");
    const forgedRoadTown = {
      ...snapshot,
      journalEntries: snapshot.journalEntries.map((entry) =>
        entry === roadEntry ? { ...entry, town: otherTownName(entry.town) } : entry,
      ),
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedRoadTown })).toThrow(
      /journal road entry .*expected/,
    );
  });

  it("rejects completed regional arcs without enough resolved anchors", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const arc = overworld.regional_arcs[0]!;
    const regionalArcSnapshot = {
      ...snapshot,
      completedRegionalArcIds: [arc.id],
      journalEntries: [
        {
          id: `arc:${arc.id}`,
          kind: "regional_arc" as const,
          town: arc.region,
          title: `Completed ${arc.title}`,
          text: arc.reward,
          recordedAt: snapshot.journalEntries[0]!.recordedAt,
        },
        ...snapshot.journalEntries,
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: regionalArcSnapshot })).toThrow(
      /completed regional arc.*required resolved anchor towns/,
    );
  });

  it("rejects missing completed regional arcs earned by resolved anchors", () => {
    const { a, snapshot, arc } = exportedSnapshotWithCompletedRegionalArc();
    const forgedMissingArc = {
      ...snapshot,
      completedRegionalArcIds: snapshot.completedRegionalArcIds.filter((id) => id !== arc.id),
      journalEntries: snapshot.journalEntries.filter((entry) => entry.id !== `arc:${arc.id}`),
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedMissingArc })).toThrow(
      /missing completed regional arc.*resolved anchor towns/,
    );
  });

  it("rejects regional arc journal entries before enough anchor resolutions", () => {
    const { a, snapshot, arc } = exportedSnapshotWithCompletedRegionalArc();
    const arcEntryId = `arc:${arc.id}`;
    const arcEntry = snapshot.journalEntries.find((entry) => entry.id === arcEntryId);
    if (!arcEntry) throw new Error("expected regional arc journal entry");
    const forgedEarlyArcEntry = {
      ...snapshot,
      journalEntries: [
        ...snapshot.journalEntries.filter((entry) => entry.id !== arcEntryId),
        {
          ...arcEntry,
          recordedAt: timeLabelForMinutes(8 * 60),
        },
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedEarlyArcEntry })).toThrow(
      /completed regional arc.*before enough anchor resolutions/,
    );
  });

  it.each(localActionJournalCases)(
    "rejects $label journal entries from unvisited towns",
    (journalCase) => {
      const { a, snapshot } = exportedSnapshotAfterTwoRoads();
      const source = journalCase.sources.find(
        (candidate) => !snapshot.visitedIds.includes(candidate.home),
      );
      if (!source) throw new Error(`expected a ${journalCase.label} in an unvisited town`);
      const forgedJournal = {
        ...snapshot,
        journalEntries: [
          localActionJournalEntry(snapshot, source, journalCase),
          ...snapshot.journalEntries,
        ],
      };

      expect(() => a.restore_overworld_session({ snapshot: forgedJournal })).toThrow(
        journalCase.unvisitedPattern,
      );
    },
  );

  it.each(localActionJournalCases)(
    "rejects $label journal entries in undiscovered areas",
    (journalCase) => {
      const { a, snapshot } = exportedSnapshotAfterTwoRoads();
      const source = journalCase.sources.find(
        (candidate) =>
          snapshot.visitedIds.includes(candidate.home) &&
          !snapshot.discoveredAreaIds.includes(candidate.area),
      );
      if (!source)
        throw new Error(`expected a ${journalCase.label} in an undiscovered visited-town area`);
      const forgedJournal = {
        ...snapshot,
        journalEntries: [
          localActionJournalEntry(snapshot, source, journalCase),
          ...snapshot.journalEntries,
        ],
      };

      expect(() => a.restore_overworld_session({ snapshot: forgedJournal })).toThrow(
        journalCase.undiscoveredPattern,
      );
    },
  );

  it("rejects unexpected region renown with no journal source", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const region = overworld.nodes[0]!.region;
    const forgedRenown = {
      ...snapshot,
      regionRenown: [[region, 1] satisfies [string, number]],
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedRenown })).toThrow(
      /unexpected region renown/,
    );
  });

  it("rejects missing region renown earned by road encounters", () => {
    const { a, snapshot } = exportedSnapshotAfterRoadStrategy("cautious_scout");
    const missingRoadRenown = {
      ...snapshot,
      regionRenown: [],
    };

    expect(() => a.restore_overworld_session({ snapshot: missingRoadRenown })).toThrow(
      /region renown.*expected 1/,
    );
  });

  it("rejects discovered areas attached to unvisited towns", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const area = overworld.areas.find((candidate) => !snapshot.visitedIds.includes(candidate.home));
    if (!area) throw new Error("expected an area in an unvisited town");
    const forgedAreaDiscovery = {
      ...snapshot,
      discoveredAreaIds: appendUnique(snapshot.discoveredAreaIds, area.id),
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedAreaDiscovery })).toThrow(
      /discovered area.*unvisited town/,
    );
  });

  it("rejects visited towns missing their initial discovered area", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const { areas } = visitedTownAreas(snapshot, 1, snapshot.currentAreaId);
    const firstArea = areas[0]!;
    const missingInitialArea = {
      ...snapshot,
      discoveredAreaIds: snapshot.discoveredAreaIds.filter((id) => id !== firstArea.id),
    };

    expect(() => a.restore_overworld_session({ snapshot: missingInitialArea })).toThrow(
      /missing its initial discovered area/,
    );
  });

  it("rejects discovered areas that skip earlier town areas", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const { areas } = visitedTownAreas(snapshot, 2, snapshot.currentAreaId);
    const firstArea = areas[0]!;
    const secondArea = areas[1]!;
    const skippedAreaDiscovery = {
      ...snapshot,
      discoveredAreaIds: appendUnique(
        snapshot.discoveredAreaIds.filter((id) => id !== firstArea.id),
        secondArea.id,
      ),
    };

    expect(() => a.restore_overworld_session({ snapshot: skippedAreaDiscovery })).toThrow(
      /discovered area.*skips an earlier area/,
    );
  });

  it("rejects discovered jobs that skip earlier visible jobs", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const { areaIds, jobs } = visitedTownJobs(snapshot, 2);
    const firstJob = jobs[0]!;
    const secondJob = jobs[1]!;
    const skippedJobDiscovery = {
      ...snapshot,
      discoveredAreaIds: appendUniques(snapshot.discoveredAreaIds, areaIds),
      discoveredJobIds: appendUnique(
        snapshot.discoveredJobIds.filter((id) => id !== firstJob.id),
        secondJob.id,
      ),
    };

    expect(() => a.restore_overworld_session({ snapshot: skippedJobDiscovery })).toThrow(
      /discovered job.*skips an earlier job/,
    );
  });

  it("rejects saved area positions for unvisited towns", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const area = overworld.areas.find((candidate) => !snapshot.visitedIds.includes(candidate.home));
    if (!area) throw new Error("expected an area in an unvisited town");
    const forgedSavedArea = {
      ...snapshot,
      discoveredAreaIds: appendUnique(snapshot.discoveredAreaIds, area.id),
      currentAreaByTown: [
        ...snapshot.currentAreaByTown,
        [area.home, area.id] satisfies [string, string],
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedSavedArea })).toThrow(
      /saved area town.*not visited/,
    );
  });

  it("rejects pending road encounters without a travel arrival", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    const road =
      started.observation.exits.find(
        (edge) => overworldRoadEventFor(overworld, edge.id) !== null,
      ) ?? started.observation.exits[0];
    if (!road) throw new Error("expected an overworld road from start");
    const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
    const forgedPendingRoad = {
      ...snapshot,
      pendingRoadEncounter: { edgeId: road.id },
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedPendingRoad })).toThrow(
      /pending road encounter.*no travel log/,
    );
  });

  it("rejects ambient road reports forged into pending encounters", () => {
    const { a, snapshot } = exportedSnapshotWithPendingRoad();
    const latestTravel = snapshot.travelLog[0]!;
    const alternateRoad = overworldEdgesFrom(overworld, snapshot.currentId).find(
      (edge) => edge.id !== latestTravel.edgeId && overworldRoadEventFor(overworld, edge.id),
    );
    if (!alternateRoad) throw new Error("expected another current-town road with a road event");
    const forgedPendingRoad = {
      ...snapshot,
      pendingRoadEncounter: { edgeId: alternateRoad.id },
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedPendingRoad })).toThrow(
      /ambient report, not a choice/,
    );
  });

  it("rejects pending road encounters when the latest travel explicitly had no road event", () => {
    const { a, snapshot } = exportedSnapshotWithPendingRoad();
    const latestTravel = snapshot.travelLog[0]!;
    const forgedSuppressedPendingRoad = {
      ...snapshot,
      travelLog: [{ ...latestTravel, roadEventId: null }, ...snapshot.travelLog.slice(1)],
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedSuppressedPendingRoad })).toThrow(
      /pending road encounter.*did not fire/,
    );
  });

  it("rejects pending road encounters when the latest travel records a different road event", () => {
    const { a, snapshot } = exportedSnapshotWithPendingRoad();
    const latestTravel = snapshot.travelLog[0]!;
    const forgedMismatchedPendingRoad = {
      ...snapshot,
      travelLog: [
        { ...latestTravel, roadEventId: "road_event:forged_other" },
        ...snapshot.travelLog.slice(1),
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedMismatchedPendingRoad })).toThrow(
      /travel road event .*does not match the world/,
    );
  });

  it("rejects pending road encounters that already have a road journal resolution", () => {
    const { a, snapshot } = exportedSnapshotWithPendingRoad();
    const latestTravel = snapshot.travelLog[0]!;
    const forgedResolvedPendingRoad = {
      ...snapshot,
      journalEntries: [
        {
          id: `road:${latestTravel.edgeId}:${latestTravel.arrivedAt}:press_on`,
          kind: "road" as const,
          town: townName(latestTravel.toId),
          title: "Forged road resolution",
          text: "Forged road resolution proof.",
          recordedAt: timeLabelForMinutes(latestTravel.arrivedAt),
        },
        ...snapshot.journalEntries,
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedResolvedPendingRoad })).toThrow(
      /pending road encounter.*already has a road journal/,
    );
  });

  it("rejects missing saved area positions for visited towns", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const townId = snapshot.visitedIds.find(
      (id) => id !== snapshot.currentId && snapshot.currentAreaByTown.some(([town]) => town === id),
    );
    if (!townId) throw new Error("expected a non-current visited town with a saved area");
    const missingSavedArea = {
      ...snapshot,
      currentAreaByTown: snapshot.currentAreaByTown.filter(([town]) => town !== townId),
    };

    expect(() => a.restore_overworld_session({ snapshot: missingSavedArea })).toThrow(
      /saved area map.*missing visited town/,
    );
  });

  it("rejects missing current areas for local towns", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const missingCurrentArea = {
      ...snapshot,
      currentAreaId: null,
    };

    expect(() => a.restore_overworld_session({ snapshot: missingCurrentArea })).toThrow(
      /current area is missing/,
    );
  });

  it("rejects current areas that disagree with saved area positions", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const currentAreas = overworldAreasAt(overworld, snapshot.currentId);
    const alternateArea = currentAreas.find((area) => area.id !== snapshot.currentAreaId);
    if (!alternateArea) throw new Error("expected another current-town area");
    const mismatchedSavedArea = {
      ...snapshot,
      discoveredAreaIds: appendUnique(snapshot.discoveredAreaIds, alternateArea.id),
      currentAreaByTown: snapshot.currentAreaByTown.map(([town, area]) =>
        town === snapshot.currentId
          ? ([town, alternateArea.id] satisfies [string, string])
          : ([town, area] satisfies [string, string]),
      ),
    };

    expect(() => a.restore_overworld_session({ snapshot: mismatchedSavedArea })).toThrow(
      /current area.*saved area map/,
    );
  });

  it("rejects visited towns with no travel proof", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const town = overworld.nodes.find(
      (candidate) =>
        candidate.id !== overworld.start && !snapshot.visitedIds.includes(candidate.id),
    );
    if (!town) throw new Error("expected an unvisited non-start town");
    const forgedVisit = {
      ...snapshot,
      discoveredIds: appendUnique(snapshot.discoveredIds, town.id),
      visitedIds: appendUnique(snapshot.visitedIds, town.id),
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedVisit })).toThrow(
      /visited town.*no travel arrival/,
    );
  });

  it("rejects discovered towns outside the visited frontier", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const town = overworld.nodes.find(
      (candidate) => !snapshot.discoveredIds.includes(candidate.id),
    );
    if (!town) throw new Error("expected an undiscovered town outside the current frontier");
    const forgedDiscovery = {
      ...snapshot,
      discoveredIds: appendUnique(snapshot.discoveredIds, town.id),
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedDiscovery })).toThrow(
      /discovered town.*outside the visited frontier/,
    );
  });

  it("rejects missing discovered towns from the visited frontier", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const townId = snapshot.discoveredIds.find((id) => !snapshot.visitedIds.includes(id));
    if (!townId) throw new Error("expected an unvisited discovered frontier town");
    const missingFrontierDiscovery = {
      ...snapshot,
      discoveredIds: snapshot.discoveredIds.filter((id) => id !== townId),
    };

    expect(() => a.restore_overworld_session({ snapshot: missingFrontierDiscovery })).toThrow(
      /discovered town frontier is missing/,
    );
  });

  it.each(localActionJournalCases)(
    "rejects $label journal entries recorded before reaching their town",
    (journalCase) => {
      const { a, snapshot } = exportedSnapshotAfterTwoRoads();
      const source = journalCase.sources.find(
        (candidate) =>
          candidate.home !== overworld.start &&
          snapshot.visitedIds.includes(candidate.home) &&
          snapshot.discoveredAreaIds.includes(candidate.area),
      );
      if (!source) throw new Error(`expected a ${journalCase.label} in a visited non-start town`);
      const forgedJournal = {
        ...snapshot,
        journalEntries: [
          ...snapshot.journalEntries,
          localActionJournalEntry(snapshot, source, journalCase, "Day 1, 08:00"),
        ],
      };

      expect(() => a.restore_overworld_session({ snapshot: forgedJournal })).toThrow(
        journalCase.chronologyPattern,
      );
    },
  );

  it("rejects local area journal entries recorded before area discovery", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    const firstArea = started.observation.areas[0]!;
    const exploredFirstArea = a.explore_overworld_session_area({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      area_id: firstArea.id,
    });
    const route = exploredFirstArea.observation.areaExits[0];
    if (!route) throw new Error("expected a local route after discovering a second area");

    a.move_overworld_session_area({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      area_route_id: route.id,
    });
    a.explore_overworld_session_area({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      area_id: route.destination.id,
    });
    const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
    const destinationEntryId = `area:${route.destination.id}`;
    const destinationEntry = snapshot.journalEntries.find(
      (entry) => entry.id === destinationEntryId,
    );
    if (!destinationEntry) throw new Error("expected destination area journal entry");
    const forgedEarlyAreaEntry = {
      ...snapshot,
      journalEntries: [
        ...snapshot.journalEntries.filter((entry) => entry.id !== destinationEntryId),
        {
          ...destinationEntry,
          recordedAt: timeLabelForMinutes(8 * 60),
        },
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedEarlyAreaEntry })).toThrow(
      /journal area.*before discovering area/,
    );
  });

  it("rejects discovered local areas without local action replay proof", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
    const currentAreas = overworldAreasAt(overworld, snapshot.currentId);
    const extraArea = currentAreas.find((area) => !snapshot.discoveredAreaIds.includes(area.id));
    if (!extraArea) throw new Error("expected a hidden current-town area");
    const forgedAreaDiscovery = {
      ...snapshot,
      discoveredAreaIds: appendUnique(snapshot.discoveredAreaIds, extraArea.id),
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedAreaDiscovery })).toThrow(
      /discovered area count.*local action replay/,
    );
  });

  it("rejects missing local areas earned by local action replay", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    const poi = started.observation.pois[0];
    if (!poi) throw new Error("expected an initial-area point of interest");
    const scouted = a.scout_overworld_session_poi({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      poi_id: poi.id,
    });
    const discoveredArea = scouted.result.discoveredAreas?.[0];
    if (!discoveredArea) throw new Error("expected scouting to discover another area");
    const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
    const forgedMissingArea = {
      ...snapshot,
      discoveredAreaIds: snapshot.discoveredAreaIds.filter((id) => id !== discoveredArea.id),
      discoveredJobIds: snapshot.discoveredJobIds.filter((jobId) => {
        const job = overworld.local_jobs.find((candidate) => candidate.id === jobId);
        return job?.area !== discoveredArea.id;
      }),
      discoveredQuestIds: snapshot.discoveredQuestIds.filter((questId) => {
        const quest = overworld.quests.find((candidate) => candidate.id === questId);
        return quest?.area !== discoveredArea.id;
      }),
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedMissingArea })).toThrow(
      /discovered area count.*local action replay/,
    );
  });

  it("rejects local job journal entries recorded before job discovery", () => {
    const { a } = syntheticLegacyGenericMarketJob();
    const started = a.start_overworld({ compact_context: false });
    const civicPoi = started.observation.pois[0];
    if (!civicPoi) throw new Error("expected an initial point of interest");
    a.scout_overworld_session_poi({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      poi_id: civicPoi.id,
    });
    const afterScout = a.get_overworld_session({
      include_observation: true,
      session_id: started.session_id,
    }).observation;
    const marketRoute = afterScout.areaExits.find(
      (route) => route.destination.id === "albany_city__market",
    );
    if (!marketRoute) throw new Error("expected a discovered route to Albany Market");
    a.move_overworld_session_area({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      area_route_id: marketRoute.id,
    });
    const exploredMarket = a.explore_overworld_session_area({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      area_id: "albany_city__market",
    });
    const job = exploredMarket.observation.jobs.find((candidate) => !candidate.authored_scene);
    if (!job) throw new Error("expected a generic Market job after local discovery");

    a.work_overworld_session_job({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      job_id: job.id,
    });
    const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
    const jobEntryId = `job:${job.id}`;
    const jobEntry = snapshot.journalEntries.find((entry) => entry.id === jobEntryId);
    if (!jobEntry) throw new Error("expected job journal entry");
    const journalEntries = snapshot.journalEntries.filter((entry) => entry.id !== jobEntryId);
    const scoutIndex = journalEntries.findIndex((entry) => entry.id === `scout:${civicPoi.id}`);
    if (scoutIndex < 0) throw new Error("expected the earlier Civic scout entry");
    journalEntries.splice(scoutIndex, 0, {
      ...jobEntry,
      recordedAt: timeLabelForMinutes(8 * 60 + 21),
    });
    const forgedEarlyJobEntry = {
      ...snapshot,
      journalEntries,
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedEarlyJobEntry })).toThrow(
      /journal job.*before discovering job/,
    );
  });

  it("rejects local job journal entries recorded before that job's reveal order", () => {
    const { a, world } = syntheticLegacyGenericMarketJob();
    const started = a.start_overworld({ compact_context: false });
    const poi = started.observation.pois[0];
    const contact = started.observation.characters[0];
    if (!poi || !contact) throw new Error("expected initial local action sources");

    const scouted = a.scout_overworld_session_poi({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      poi_id: poi.id,
    });
    const talked = a.talk_overworld_session_contact({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      character_id: contact.id,
    });
    if (talked.journey.storyChoice?.kind === "registration") {
      a.choose_overworld_session_story({
        ...FULL_OVERWORLD_RESPONSE,
        session_id: started.session_id,
        choice: "albany:ledger_advocate",
      });
      a.choose_overworld_session_story({
        ...FULL_OVERWORLD_RESPONSE,
        session_id: started.session_id,
        choice: "albany:oath_limited_aid_only",
      });
      const sourced = a.choose_overworld_session_story({
        ...FULL_OVERWORLD_RESPONSE,
        session_id: started.session_id,
        choice: "albany:source_rowan_civic_docket",
      });
      const preparationArea = world.opening_preparation?.area;
      if (!preparationArea) throw new Error("expected Albany opening preparation");
      const preparationRoute = sourced.observation.areaExits.find(
        (route) => route.destination.id === preparationArea,
      );
      if (!preparationRoute) throw new Error("expected a route to the opening preparation board");
      const stationed = a.move_overworld_session_area({
        ...FULL_OVERWORLD_RESPONSE,
        session_id: started.session_id,
        area_route_id: preparationRoute.id,
      });
      expect(stationed.journey.storyChoice).toBeNull();
      expect(
        stationed.observation.departureInteractions.map((interaction) => interaction.id),
      ).toEqual(["albany:wolf_preparation", "albany:wolf_relief_allocation"]);
      a.choose_overworld_session_story({
        ...FULL_OVERWORLD_RESPONSE,
        session_id: started.session_id,
        story_choice_id: "albany:wolf_preparation",
        choice: "albany:prep_works_fortification",
      });
      a.choose_overworld_session_story({
        ...FULL_OVERWORLD_RESPONSE,
        session_id: started.session_id,
        story_choice_id: "albany:wolf_relief_allocation",
        choice: "albany:relief_resident_shelter",
      });
    }
    const secondJob = talked.result.discoveredJobs?.[0];
    if (!scouted.result.discoveredJobs?.[0] || !secondJob) {
      throw new Error("expected two discovered jobs after two local actions");
    }

    const beforeMove = a.get_overworld_session({
      include_observation: true,
      session_id: started.session_id,
    }).observation;
    const routeToJobArea = beforeMove.areaExits.find(
      (route) => route.destination.id === secondJob.area,
    );
    if (!routeToJobArea) throw new Error("expected a route to the second job area");
    a.move_overworld_session_area({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      area_route_id: routeToJobArea.id,
    });
    a.work_overworld_session_job({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      job_id: secondJob.id,
    });

    const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
    const jobEntryId = `job:${secondJob.id}`;
    const jobEntry = snapshot.journalEntries.find((entry) => entry.id === jobEntryId);
    const scoutEntry = snapshot.journalEntries.find((entry) => entry.id === `scout:${poi.id}`);
    if (!jobEntry || !scoutEntry) throw new Error("expected job and scout journal entries");
    const forgedEarlySecondJobEntry = {
      ...snapshot,
      journalEntries: [
        ...snapshot.journalEntries.filter(
          (entry) => entry.id !== jobEntryId && entry.id !== scoutEntry.id,
        ),
        {
          ...jobEntry,
          recordedAt: timeLabelForMinutes(8 * 60 + 21),
        },
        scoutEntry,
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedEarlySecondJobEntry })).toThrow(
      /journal job.*before discovering job/,
    );
  });

  it("rejects local site journal entries recorded before site discovery", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    const site = overworld.exploration_sites.find(
      (candidate) => candidate.area === started.observation.currentArea?.id,
    );
    if (!site) throw new Error("expected an initial-area exploration site");

    a.scout_overworld_session_poi({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      poi_id: started.observation.pois[0]!.id,
    });
    a.explore_overworld_session_site({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      site_id: site.id,
    });
    const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
    const siteEntryId = `site:${site.id}`;
    const siteEntry = snapshot.journalEntries.find((entry) => entry.id === siteEntryId);
    if (!siteEntry) throw new Error("expected site journal entry");
    const forgedEarlySiteEntry = {
      ...snapshot,
      journalEntries: [
        ...snapshot.journalEntries.filter((entry) => entry.id !== siteEntryId),
        {
          ...siteEntry,
          recordedAt: timeLabelForMinutes(8 * 60),
        },
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedEarlySiteEntry })).toThrow(
      /journal site.*before discovering site/,
    );
  });

  it("rejects discovered jobs without enough local action proof", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
    const job = overworldJobsAt(overworld, snapshot.currentId).find(
      (candidate) => candidate.area === snapshot.currentAreaId,
    );
    if (!job) throw new Error("expected an initial-area job");
    const forgedJobDiscovery = {
      ...snapshot,
      discoveredJobIds: appendUnique(snapshot.discoveredJobIds, job.id),
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedJobDiscovery })).toThrow(
      /discovered job count.*local action proof/,
    );
  });

  it("rejects missing discovered jobs earned by local action replay", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    const poi = started.observation.pois[0];
    if (!poi) throw new Error("expected an initial-area point of interest");
    const scouted = a.scout_overworld_session_poi({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      poi_id: poi.id,
    });
    const job = scouted.result.discoveredJobs?.[0];
    if (!job) throw new Error("expected scouting to discover a job");
    const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
    const forgedMissingJob = {
      ...snapshot,
      discoveredJobIds: snapshot.discoveredJobIds.filter((id) => id !== job.id),
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedMissingJob })).toThrow(
      /discovered job count.*local action proof/,
    );
  });

  it("rejects discovered sites without enough local action proof", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
    if (!snapshot.currentAreaId) throw new Error("expected a current area");
    const site = overworldExplorationSitesInArea(overworld, snapshot.currentAreaId)[0];
    if (!site) throw new Error("expected an initial-area exploration site");
    const forgedSiteDiscovery = {
      ...snapshot,
      discoveredSiteIds: appendUnique(snapshot.discoveredSiteIds, site.id),
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedSiteDiscovery })).toThrow(
      /discovered site count.*local action proof/,
    );
  });

  it("rejects missing discovered sites earned by local action replay", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    const poi = started.observation.pois[0];
    if (!poi) throw new Error("expected an initial-area point of interest");
    const scouted = a.scout_overworld_session_poi({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      poi_id: poi.id,
    });
    const site = scouted.result.discoveredSites?.[0];
    if (!site) throw new Error("expected scouting to discover a site");
    const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
    const forgedMissingSite = {
      ...snapshot,
      discoveredSiteIds: snapshot.discoveredSiteIds.filter((id) => id !== site.id),
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedMissingSite })).toThrow(
      /discovered site count.*local action proof/,
    );
  });

  it("rejects the opening quest without certified source proof", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    const firstArea = started.observation.currentArea;
    if (!firstArea) throw new Error("expected Albany's opening area");
    const firstExploration = a.explore_overworld_session_area({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      area_id: firstArea.id,
    });
    const marketRoute = firstExploration.observation.areaExits.find(
      (route) => route.destination.id === "albany_city__market",
    );
    if (!marketRoute) throw new Error("expected Albany's market route");
    a.move_overworld_session_area({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      area_route_id: marketRoute.id,
    });
    a.explore_overworld_session_area({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      area_id: marketRoute.destination.id,
    });
    const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
    const quest = overworldQuestsAt(overworld, snapshot.currentId)[0];
    if (!quest) throw new Error("expected a local quest lead");
    expect(snapshot.discoveredAreaIds).toContain(quest.area);
    const forgedQuestDiscovery = {
      ...snapshot,
      discoveredQuestIds: appendUnique(snapshot.discoveredQuestIds, quest.id),
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedQuestDiscovery })).toThrow(
      /discovered the opening lead-source target quest without a certified lead source/i,
    );
  });

  it("rejects a missing quest earned by opening source certification", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    const poi = started.observation.pois[0];
    const contact = started.observation.characters[0];
    if (!poi || !contact) throw new Error("expected Albany's opening sources");
    a.scout_overworld_session_poi({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      poi_id: poi.id,
    });
    a.talk_overworld_session_contact({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      character_id: contact.id,
    });
    a.choose_overworld_session_story({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      choice: "albany:ledger_advocate",
    });
    a.choose_overworld_session_story({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      choice: "albany:oath_limited_aid_only",
    });
    const sourced = a.choose_overworld_session_story({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      choice: "albany:source_rowan_civic_docket",
    });
    const preparationArea = overworld.opening_preparation?.area;
    if (!preparationArea) throw new Error("expected Albany opening preparation");
    const preparationRoute = sourced.observation.areaExits.find(
      (route) => route.destination.id === preparationArea,
    );
    if (!preparationRoute) throw new Error("expected a route to the opening preparation board");
    const stationed = a.move_overworld_session_area({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      area_route_id: preparationRoute.id,
    });
    expect(stationed.journey.storyChoice).toBeNull();
    expect(
      stationed.observation.departureInteractions.map((interaction) => interaction.id),
    ).toEqual(["albany:wolf_preparation", "albany:wolf_relief_allocation"]);
    a.choose_overworld_session_story({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      story_choice_id: "albany:wolf_preparation",
      choice: "albany:prep_works_fortification",
    });
    a.choose_overworld_session_story({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      story_choice_id: "albany:wolf_relief_allocation",
      choice: "albany:relief_resident_shelter",
    });
    const quest = overworld.opening_lead_source?.target_quest;
    if (!quest) throw new Error("expected Albany's source-bound quest");
    const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
    const forgedMissingQuest = {
      ...snapshot,
      discoveredQuestIds: snapshot.discoveredQuestIds.filter((id) => id !== quest),
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedMissingQuest })).toThrow(
      /selected lead source did not reveal its target quest/i,
    );
  });

  it("rejects discovered jobs in undiscovered areas", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const job = overworld.local_jobs.find(
      (candidate) =>
        snapshot.visitedIds.includes(candidate.home) &&
        !snapshot.discoveredAreaIds.includes(candidate.area),
    );
    if (!job) throw new Error("expected a job in an undiscovered visited-town area");
    const forgedJobDiscovery = {
      ...snapshot,
      discoveredJobIds: appendUnique(snapshot.discoveredJobIds, job.id),
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedJobDiscovery })).toThrow(
      /discovered job.*undiscovered area/,
    );
  });

  it("rejects discovered sites in undiscovered areas", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const site = overworld.exploration_sites.find(
      (candidate) =>
        snapshot.visitedIds.includes(candidate.nearest_town) &&
        !snapshot.discoveredAreaIds.includes(candidate.area),
    );
    if (!site) throw new Error("expected a site in an undiscovered visited-town area");
    const forgedSiteDiscovery = {
      ...snapshot,
      discoveredSiteIds: appendUnique(snapshot.discoveredSiteIds, site.id),
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedSiteDiscovery })).toThrow(
      /discovered site.*undiscovered area/,
    );
  });

  it("rejects discovered quests in undiscovered areas", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    travelOverworldSessionTo(a, started.session_id, "new_york_city");
    const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
    const quest = overworld.quests.find(
      (candidate) =>
        candidate.home === "new_york_city" && !snapshot.discoveredAreaIds.includes(candidate.area),
    );
    if (!quest) throw new Error("expected a quest in an undiscovered visited-town area");
    const forgedQuestDiscovery = {
      ...snapshot,
      discoveredQuestIds: appendUnique(snapshot.discoveredQuestIds, quest.id),
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedQuestDiscovery })).toThrow(
      /discovered quest.*undiscovered area/,
    );
  });

  it("rejects resolved events attached to unvisited towns", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const event = overworld.local_events.find(
      (candidate) => !snapshot.visitedIds.includes(candidate.home),
    );
    if (!event) throw new Error("expected an event in an unvisited town");
    const forgedEventResolution = {
      ...snapshot,
      resolvedEventIds: appendUnique(snapshot.resolvedEventIds, event.id),
      regionRenown: addRenown(snapshot.regionRenown, townRegion(event.home), event.intensity),
      journalEntries: [
        {
          id: `resolve:${event.id}`,
          kind: "resolution" as const,
          town: townName(event.home),
          title: "Forged resolution",
          text: "Forged resolution journal proof.",
          recordedAt: snapshot.journalEntries[0]!.recordedAt,
        },
        ...snapshot.journalEntries,
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedEventResolution })).toThrow(
      /resolved event.*unvisited town/,
    );
  });

  it("rejects resolved events in undiscovered areas", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const event = overworld.local_events.find(
      (candidate) =>
        !candidate.authored_scene &&
        snapshot.visitedIds.includes(candidate.home) &&
        !snapshot.discoveredAreaIds.includes(candidate.area),
    );
    if (!event) throw new Error("expected an event in an undiscovered visited-town area");
    const forgedEventResolution = {
      ...snapshot,
      resolvedEventIds: appendUnique(snapshot.resolvedEventIds, event.id),
      regionRenown: addRenown(snapshot.regionRenown, townRegion(event.home), event.intensity),
      journalEntries: [
        {
          id: `resolve:${event.id}`,
          kind: "resolution" as const,
          town: townName(event.home),
          title: "Forged resolution",
          text: "Forged resolution journal proof.",
          recordedAt: snapshot.journalEntries[0]!.recordedAt,
        },
        ...snapshot.journalEntries,
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedEventResolution })).toThrow(
      /resolved event.*undiscovered area/,
    );
  });

  it.each([
    {
      label: "local scout",
      removedEntryId({ poi }: ReturnType<typeof exportedSnapshotWithResolvedInitialEvent>) {
        return `scout:${poi.id}`;
      },
      pattern: /resolved event.*scout prerequisite/,
    },
    {
      label: "local contact",
      removedEntryId({ contact }: ReturnType<typeof exportedSnapshotWithResolvedInitialEvent>) {
        return `talk:${contact.id}`;
      },
      pattern: /resolved event.*contact prerequisite/,
    },
    {
      label: "event investigation",
      removedEntryId({ event }: ReturnType<typeof exportedSnapshotWithResolvedInitialEvent>) {
        return `investigate:${event.id}`;
      },
      pattern: /resolved event.*investigated event prerequisite/,
    },
  ])("rejects resolved events missing $label proof", ({ removedEntryId, pattern }) => {
    const resolved = exportedSnapshotWithResolvedInitialEvent();
    const targetEntryId = removedEntryId(resolved);
    const removingContact = targetEntryId.startsWith("talk:");
    const missingPrerequisite = {
      ...resolved.snapshot,
      ...(removingContact ? { character: createInitialCampaignCharacterState() } : {}),
      journalEntries: resolved.snapshot.journalEntries.filter(
        (entry) =>
          entry.id !== targetEntryId &&
          !(
            removingContact &&
            (entry.kind === "registration_offer" || entry.kind === "registration")
          ),
      ),
    };

    expect(() =>
      resolved.a.restore_overworld_session({
        ...FULL_OVERWORLD_RESPONSE,
        snapshot: missingPrerequisite,
      }),
    ).toThrow(pattern);
  });

  it("restores resolved events with local prerequisite proof", () => {
    const { a, snapshot } = exportedSnapshotWithResolvedInitialEvent();

    expect(() => a.restore_overworld_session({ snapshot })).not.toThrow();
  });

  it.each([
    {
      label: "completed job",
      forge(snapshot: Snapshot): Snapshot {
        const job = overworld.local_jobs.find(
          (candidate) => !snapshot.completedJobIds.includes(candidate.id),
        );
        if (!job) throw new Error("expected an incomplete job");
        return {
          ...snapshot,
          discoveredJobIds: [...snapshot.discoveredJobIds, job.id],
          completedJobIds: [...snapshot.completedJobIds, job.id],
          journalEntries: [
            {
              id: `job:${job.id}`,
              kind: "job",
              town: townName(job.home),
              title: "Forged job",
              text: "Forged job journal proof.",
              recordedAt: snapshot.journalEntries[0]!.recordedAt,
            },
            ...snapshot.journalEntries,
          ],
        };
      },
    },
    {
      label: "explored site",
      forge(snapshot: Snapshot): Snapshot {
        const site = overworld.exploration_sites.find(
          (candidate) => !snapshot.exploredSiteIds.includes(candidate.id),
        );
        if (!site) throw new Error("expected an unexplored site");
        return {
          ...snapshot,
          discoveredSiteIds: [...snapshot.discoveredSiteIds, site.id],
          exploredSiteIds: [...snapshot.exploredSiteIds, site.id],
          journalEntries: [
            {
              id: `site:${site.id}`,
              kind: "site",
              town: townName(site.nearest_town),
              title: "Forged site",
              text: "Forged site journal proof.",
              recordedAt: snapshot.journalEntries[0]!.recordedAt,
            },
            ...snapshot.journalEntries,
          ],
        };
      },
    },
    {
      label: "resolved event",
      forge(snapshot: Snapshot): Snapshot {
        const event = overworld.local_events.find(
          (candidate) => !snapshot.resolvedEventIds.includes(candidate.id),
        );
        if (!event) throw new Error("expected an unresolved event");
        return {
          ...snapshot,
          resolvedEventIds: [...snapshot.resolvedEventIds, event.id],
          journalEntries: [
            {
              id: `resolve:${event.id}`,
              kind: "resolution",
              town: townName(event.home),
              title: "Forged resolution",
              text: "Forged resolution journal proof.",
              recordedAt: snapshot.journalEntries[0]!.recordedAt,
            },
            ...snapshot.journalEntries,
          ],
        };
      },
    },
  ])("rejects $label journal/progress proof without earned renown", ({ forge }) => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();

    expect(() => a.restore_overworld_session({ snapshot: forge(snapshot) })).toThrow(
      /region renown/,
    );
  });

  it.each([
    {
      label: "visited area",
      forge(snapshot: Snapshot): Snapshot {
        const area = overworld.areas.find(
          (candidate) => !snapshot.visitedAreaIds.includes(candidate.id),
        );
        if (!area) throw new Error("expected an unvisited area");
        return {
          ...snapshot,
          discoveredAreaIds: [...snapshot.discoveredAreaIds, area.id],
          visitedAreaIds: [...snapshot.visitedAreaIds, area.id],
        };
      },
      pattern: /visited area id.*matching journal/,
    },
    {
      label: "completed job",
      forge(snapshot: Snapshot): Snapshot {
        const job = overworld.local_jobs.find(
          (candidate) => !snapshot.completedJobIds.includes(candidate.id),
        );
        if (!job) throw new Error("expected an incomplete job");
        return {
          ...snapshot,
          discoveredJobIds: [...snapshot.discoveredJobIds, job.id],
          completedJobIds: [...snapshot.completedJobIds, job.id],
        };
      },
      pattern: /completed job id.*matching journal/,
    },
    {
      label: "explored site",
      forge(snapshot: Snapshot): Snapshot {
        const site = overworld.exploration_sites.find(
          (candidate) => !snapshot.exploredSiteIds.includes(candidate.id),
        );
        if (!site) throw new Error("expected an unexplored site");
        return {
          ...snapshot,
          discoveredSiteIds: [...snapshot.discoveredSiteIds, site.id],
          exploredSiteIds: [...snapshot.exploredSiteIds, site.id],
        };
      },
      pattern: /explored site id.*matching journal/,
    },
    {
      label: "resolved event",
      forge(snapshot: Snapshot): Snapshot {
        const event = overworld.local_events.find(
          (candidate) => !snapshot.resolvedEventIds.includes(candidate.id),
        );
        if (!event) throw new Error("expected an unresolved event");
        return {
          ...snapshot,
          resolvedEventIds: [...snapshot.resolvedEventIds, event.id],
        };
      },
      pattern: /resolved event id.*matching journal/,
    },
    {
      label: "completed regional arc",
      forge(snapshot: Snapshot): Snapshot {
        const arc = overworld.regional_arcs.find(
          (candidate) => !snapshot.completedRegionalArcIds.includes(candidate.id),
        );
        if (!arc) throw new Error("expected an incomplete regional arc");
        return {
          ...snapshot,
          completedRegionalArcIds: [...snapshot.completedRegionalArcIds, arc.id],
        };
      },
      pattern: /completed regional arc id.*matching journal/,
    },
  ])("rejects $label state without matching journal proof", ({ forge, pattern }) => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();

    expect(() => a.restore_overworld_session({ snapshot: forge(snapshot) })).toThrow(pattern);
  });

  it.each([
    {
      label: "visited area",
      makeEntry(snapshot: Snapshot): JournalEntry {
        const area = overworld.areas.find(
          (candidate) => !snapshot.visitedAreaIds.includes(candidate.id),
        );
        if (!area) throw new Error("expected an unvisited area");
        return {
          id: `area:${area.id}`,
          kind: "area",
          town: townName(area.home),
          title: "Forged area",
          text: "Forged area journal proof.",
          recordedAt: snapshot.journalEntries[0]!.recordedAt,
        };
      },
      pattern: /journal visited area id.*missing from saved state/,
    },
    {
      label: "completed job",
      makeEntry(snapshot: Snapshot): JournalEntry {
        const job = overworld.local_jobs.find(
          (candidate) => !snapshot.completedJobIds.includes(candidate.id),
        );
        if (!job) throw new Error("expected an incomplete job");
        return {
          id: `job:${job.id}`,
          kind: "job",
          town: townName(job.home),
          title: "Forged job",
          text: "Forged job journal proof.",
          recordedAt: snapshot.journalEntries[0]!.recordedAt,
        };
      },
      pattern: /journal completed job id.*missing from saved state/,
    },
    {
      label: "explored site",
      makeEntry(snapshot: Snapshot): JournalEntry {
        const site = overworld.exploration_sites.find(
          (candidate) => !snapshot.exploredSiteIds.includes(candidate.id),
        );
        if (!site) throw new Error("expected an unexplored site");
        return {
          id: `site:${site.id}`,
          kind: "site",
          town: townName(site.nearest_town),
          title: "Forged site",
          text: "Forged site journal proof.",
          recordedAt: snapshot.journalEntries[0]!.recordedAt,
        };
      },
      pattern: /journal explored site id.*missing from saved state/,
    },
    {
      label: "resolved event",
      makeEntry(snapshot: Snapshot): JournalEntry {
        const event = overworld.local_events.find(
          (candidate) => !snapshot.resolvedEventIds.includes(candidate.id),
        );
        if (!event) throw new Error("expected an unresolved event");
        return {
          id: `resolve:${event.id}`,
          kind: "resolution",
          town: townName(event.home),
          title: "Forged resolution",
          text: "Forged resolution journal proof.",
          recordedAt: snapshot.journalEntries[0]!.recordedAt,
        };
      },
      pattern: /journal resolved event id.*missing from saved state/,
    },
    {
      label: "completed regional arc",
      makeEntry(snapshot: Snapshot): JournalEntry {
        const arc = overworld.regional_arcs.find(
          (candidate) => !snapshot.completedRegionalArcIds.includes(candidate.id),
        );
        if (!arc) throw new Error("expected an incomplete regional arc");
        return {
          id: `arc:${arc.id}`,
          kind: "regional_arc",
          town: arc.region,
          title: "Forged regional arc",
          text: "Forged regional arc journal proof.",
          recordedAt: snapshot.journalEntries[0]!.recordedAt,
        };
      },
      pattern: /journal completed regional arc id.*missing from saved state/,
    },
  ])("rejects $label journal proof missing from progress state", ({ makeEntry, pattern }) => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const forgedJournal = {
      ...snapshot,
      journalEntries: [makeEntry(snapshot), ...snapshot.journalEntries],
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedJournal })).toThrow(pattern);
  });

  it("rejects future journal history in forged session snapshots", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const futureJournal = {
      ...snapshot,
      journalEntries: [
        { ...snapshot.journalEntries[0]!, recordedAt: "Day 999, 00:00" },
        ...snapshot.journalEntries.slice(1),
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: futureJournal })).toThrow(/future entry/);
  });

  it("rejects journal history that is not newest-first", () => {
    const { a, snapshot } = exportedSnapshotWithResolvedInitialEvent();
    expect(snapshot.journalEntries.length).toBeGreaterThan(1);
    const reversedJournal = {
      ...snapshot,
      journalEntries: [...snapshot.journalEntries].reverse(),
    };

    expect(() => a.restore_overworld_session({ snapshot: reversedJournal })).toThrow(
      /journal must be newest-first/,
    );
  });

  it("rejects forged travel logs that are not newest-first", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const reversedTravelLog = {
      ...snapshot,
      travelLog: [...snapshot.travelLog].reverse(),
    };

    expect(() => a.restore_overworld_session({ snapshot: reversedTravelLog })).toThrow(
      /newest-first/,
    );
  });

  it("rejects future travel history in forged session snapshots", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const futureTravelLog = {
      ...snapshot,
      travelLog: [
        { ...snapshot.travelLog[0]!, arrivedAt: snapshot.minutes + 1 },
        ...snapshot.travelLog.slice(1),
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: futureTravelLog })).toThrow(
      /future arrival/,
    );
  });

  it("rejects travel logs that do not replay from the start town", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const oldestTravel = snapshot.travelLog.at(-1);
    if (!oldestTravel) throw new Error("expected travel history");
    const discontinuousTravelLog = {
      ...snapshot,
      travelLog: snapshot.travelLog.map((entry) =>
        entry === oldestTravel ? { ...entry, fromId: entry.toId } : entry,
      ),
    };

    expect(() => a.restore_overworld_session({ snapshot: discontinuousTravelLog })).toThrow(
      /travel log is not contiguous/,
    );
  });

  it("rejects current towns that do not match replayed travel history", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const replayedCurrentId = snapshot.travelLog[0]!.toId;
    const wrongCurrentId = snapshot.visitedIds.find((id) => id !== replayedCurrentId);
    if (!wrongCurrentId) throw new Error("expected another visited town");
    const wrongCurrentTown = {
      ...snapshot,
      currentId: wrongCurrentId,
      currentAreaId: null,
    };

    expect(() => a.restore_overworld_session({ snapshot: wrongCurrentTown })).toThrow(
      /current town does not match travel history/,
    );
  });

  it("rejects snapshots before the starting clock", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
    const forgedEarlyClock = {
      ...snapshot,
      minutes: 8 * 60 - 1,
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedEarlyClock })).toThrow(
      /minutes.*clock replay/,
    );
  });

  it("rejects local action journals before their action duration can elapse", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    const poi = started.observation.pois[0];
    if (!poi) throw new Error("expected an initial point of interest");

    a.scout_overworld_session_poi({
      ...FULL_OVERWORLD_RESPONSE,
      session_id: started.session_id,
      poi_id: poi.id,
    });
    const snapshot = a.export_overworld_session({ session_id: started.session_id }).snapshot;
    const scoutEntryId = `scout:${poi.id}`;
    const scoutEntry = snapshot.journalEntries.find((entry) => entry.id === scoutEntryId);
    if (!scoutEntry) throw new Error("expected scout journal entry");
    const forgedEarlyScout = {
      ...snapshot,
      journalEntries: [
        {
          ...scoutEntry,
          recordedAt: timeLabelForMinutes(8 * 60 + 1),
        },
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: forgedEarlyScout })).toThrow(
      /journal poi entry.*clock time elapsed/,
    );
  });

  it("rejects forged travel resource transitions inside schema bounds", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const latestTravel = snapshot.travelLog[0];
    if (!latestTravel) throw new Error("expected travel history");
    const forgedSuppliesAfter =
      latestTravel.suppliesAfter === 0 ? 1 : latestTravel.suppliesAfter - 1;
    const impossibleVitals = {
      ...snapshot,
      travelLog: [
        { ...latestTravel, suppliesAfter: forgedSuppliesAfter },
        ...snapshot.travelLog.slice(1),
      ],
    };

    expect(() => a.restore_overworld_session({ snapshot: impossibleVitals })).toThrow(
      /supplies after.*resource replay/,
    );
  });

  it("rejects final supplies that do not match resource replay", () => {
    const { a, snapshot } = exportedSnapshotAfterTwoRoads();
    const impossibleVitals = {
      ...snapshot,
      supplies: snapshot.supplies === 0 ? 1 : snapshot.supplies - 1,
    };

    expect(() => a.restore_overworld_session({ snapshot: impossibleVitals })).toThrow(
      /supplies do not match resource replay/,
    );
  });
});
