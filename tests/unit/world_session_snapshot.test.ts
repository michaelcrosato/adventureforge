import { describe, expect, it } from "vitest";
import { createInitialCampaignCharacterState } from "../../src/world/campaign_character_state.js";
import { createInitialJourneyContractSnapshot } from "../../src/world/journey_contract.js";
import {
  OVERWORLD_SESSION_PREVIOUS_SAVE_VERSION,
  OVERWORLD_SESSION_SAVE_VERSION,
  OverworldSessionSnapshotSchema,
  OverworldSessionSnapshotV10Schema,
  cloneJournalEntries,
  cloneOverworldSessionSnapshot,
  parseOverworldSessionSnapshot,
  snapshotTravelLogEntry,
  type OverworldJournalEntry,
  type OverworldSessionSnapshot,
  type OverworldSessionSnapshotV10,
  type TravelLogEntry,
} from "../../src/world/session_snapshot.js";

function baseSnapshot(): OverworldSessionSnapshot {
  return {
    version: OVERWORLD_SESSION_SAVE_VERSION,
    worldId: "new_york_overworld",
    worldHash: "a".repeat(64),
    character: createInitialCampaignCharacterState(),
    currentId: "albany_city",
    currentAreaId: "albany_capitol_hill",
    minutes: 480,
    supplies: 6,
    fatigue: 0,
    discoveredIds: ["albany_city"],
    visitedIds: ["albany_city"],
    currentAreaByTown: [["albany_city", "albany_capitol_hill"]],
    travelLog: [
      {
        edgeId: "road:albany:colonie",
        fromId: "albany_city",
        toId: "colonie_town",
        delayMinutes: 0,
        minutes: 20,
        arrivedAt: 500,
        suppliesUsed: 1,
        suppliesAfter: 5,
        fatigueGained: 1,
        fatigueAfter: 1,
      },
    ],
    journalEntries: [
      {
        id: "area:albany_capitol_hill",
        kind: "area",
        town: "albany_city",
        title: "Capitol Hill",
        text: "You map the first local district.",
        recordedAt: "Day 1, 08:00",
      },
    ],
    resolvedEventIds: [],
    discoveredAreaIds: ["albany_capitol_hill"],
    visitedAreaIds: [],
    discoveredJobIds: [],
    completedJobIds: [],
    discoveredSiteIds: [],
    discoveredQuestIds: [],
    startedQuestIds: [],
    completedQuestIds: [],
    questOutcomes: [],
    exploredSiteIds: [],
    regionRenown: [["Capital / Mohawk", 1]],
    completedRegionalArcIds: [],
    pendingRoadEncounter: { edgeId: "road:albany:colonie" },
    journey: createInitialJourneyContractSnapshot(),
  };
}

function previousSnapshot(): OverworldSessionSnapshotV10 {
  return { ...baseSnapshot(), version: OVERWORLD_SESSION_PREVIOUS_SAVE_VERSION };
}

describe("overworld session snapshots", () => {
  it("validates the saved session shape and resource caps", () => {
    expect(OverworldSessionSnapshotSchema.parse(baseSnapshot()).version).toBe(
      OVERWORLD_SESSION_SAVE_VERSION,
    );

    expect(() =>
      OverworldSessionSnapshotSchema.parse({
        ...baseSnapshot(),
        supplies: 9,
      }),
    ).toThrow();
  });

  // bug_0643: the clock and its sibling counters had no safe-integer bound, so a
  // restored 2^53+2 or 1e300 loaded, advanced inexactly on travel, and re-saved.
  it("rejects clock and counter values outside the safe-integer range", () => {
    const base = baseSnapshot();
    const entry = base.travelLog[0]!;
    const unsafeSnapshots: Array<[string, unknown]> = [];
    for (const unsafe of [Number.MAX_SAFE_INTEGER + 1, 2 ** 53 + 2, 1e300]) {
      unsafeSnapshots.push(
        ["minutes", { ...base, minutes: unsafe }],
        ["regionRenown", { ...base, regionRenown: [["Capital / Mohawk", unsafe]] }],
        ...(["delayMinutes", "minutes", "arrivedAt", "fatigueGained"] as const).map(
          (field): [string, unknown] => [
            `travelLog.${field}`,
            { ...base, travelLog: [{ ...entry, [field]: unsafe }] },
          ],
        ),
      );
    }
    for (const [field, snapshot] of unsafeSnapshots) {
      expect(() => OverworldSessionSnapshotSchema.parse(snapshot), field).toThrow();
      expect(() => parseOverworldSessionSnapshot(snapshot), field).toThrow();
    }
    for (const safe of [0, Number.MAX_SAFE_INTEGER]) {
      expect(OverworldSessionSnapshotSchema.parse({ ...base, minutes: safe }).minutes).toBe(safe);
    }
  });

  it("requires campaign service proof ids as a pair and only on service entries", () => {
    const serviceProof = {
      id: "service:rest:600",
      kind: "service" as const,
      town: "Albany city",
      title: "A private recovery room",
      text: "A trusted contact clears a private room for you.",
      recordedAt: "Day 1, 10:00",
      serviceRuleId: "service_rule:trusted_rest",
      serviceAreaId: "albany_city__market",
      serviceBoundary: {
        acceptedDecisions: 3,
        decisionProofHash: "b".repeat(64),
        townId: "albany_city",
        areaId: "albany_city__market",
        minutes: 600,
      },
    };
    expect(() =>
      OverworldSessionSnapshotSchema.parse({
        ...baseSnapshot(),
        journalEntries: [serviceProof],
      }),
    ).not.toThrow();
    expect(() =>
      OverworldSessionSnapshotSchema.parse({
        ...baseSnapshot(),
        journalEntries: [{ ...serviceProof, serviceAreaId: undefined }],
      }),
    ).toThrow(/must include both serviceRuleId and serviceAreaId/i);
    expect(() =>
      OverworldSessionSnapshotSchema.parse({
        ...baseSnapshot(),
        journalEntries: [{ ...serviceProof, kind: "area" }],
      }),
    ).toThrow(/only valid on service entries/i);
  });

  it("upgrades the immediately previous structural version without rewriting content", () => {
    const previous = previousSnapshot();
    expect(parseOverworldSessionSnapshot(previous)).toEqual({
      ...previous,
      version: OVERWORLD_SESSION_SAVE_VERSION,
    });
  });

  it("parses the exact v10 journal envelope while stripping non-authoritative provenance", () => {
    const boundary = {
      acceptedDecisions: 2,
      decisionProofHash: "b".repeat(64),
      townId: "albany_city",
      areaId: "albany_capitol_hill",
      minutes: 480,
    };
    const previous: OverworldSessionSnapshotV10 = {
      ...previousSnapshot(),
      journalEntries: [
        {
          id: "investigate:albany_event",
          kind: "event",
          town: "Albany",
          title: "Earlier event title",
          text: "Earlier event prose.",
          recordedAt: "Day 1, 08:00",
          sourceWorldHash: "c".repeat(64),
        },
        {
          id: "job:albany_job",
          kind: "job",
          town: "Albany",
          title: "Earlier job title",
          text: "Earlier job prose.",
          recordedAt: "Day 1, 08:00",
          localSceneProof: {
            sceneId: "scene:albany_job",
            optionId: "option:structural",
            sourceWorldHash: "d".repeat(64),
            boundary,
          },
        },
      ],
    };

    expect(() => OverworldSessionSnapshotV10Schema.parse(previous)).not.toThrow();
    const upgraded = parseOverworldSessionSnapshot(previous);
    expect(upgraded.version).toBe(OVERWORLD_SESSION_SAVE_VERSION);
    expect(upgraded.journalEntries[0]).not.toHaveProperty("sourceWorldHash");
    expect(upgraded.journalEntries[1]?.localSceneProof).toEqual({
      sceneId: "scene:albany_job",
      optionId: "option:structural",
      boundary,
    });
  });

  it("derives the v11 quest-completion ending receipt from a v10 structural outcome ID", () => {
    const previous: OverworldSessionSnapshotV10 = {
      ...previousSnapshot(),
      questOutcomes: [["wolf_winter", "ending_held"]],
      journalEntries: [
        {
          id: "quest_done:wolf_winter",
          kind: "quest_done",
          town: "Albany",
          title: "Completed Wolf-Winter",
          text: "Earlier completion prose.",
          recordedAt: "Day 1, 08:00",
        },
      ],
    };

    expect(parseOverworldSessionSnapshot(previous).journalEntries[0]).toMatchObject({
      id: "quest_done:wolf_winter",
      questCompletionEndingId: "ending_held",
      text: "Earlier completion prose.",
    });
  });

  it("recognizes retired v10 proof shapes before rejecting those without current causal authority", () => {
    const boundary = {
      acceptedDecisions: 2,
      decisionProofHash: "b".repeat(64),
      townId: "albany_city",
      areaId: "albany_capitol_hill",
      minutes: 480,
    };
    const legacyKinds = [
      "ally_legacy",
      "lead_source_legacy",
      "preparation_legacy",
      "registration_legacy",
      "relief_allocation_legacy",
      "relief_oath_legacy",
    ] as const;
    for (const kind of legacyKinds) {
      const previous: OverworldSessionSnapshotV10 = {
        ...previousSnapshot(),
        journalEntries: [
          {
            id: `${kind}:${"c".repeat(64)}`,
            kind,
            town: "Albany",
            title: "Retired migration marker",
            text: "Retired hash-keyed authority.",
            recordedAt: "Day 1, 08:00",
          },
        ],
      };
      expect(() => OverworldSessionSnapshotV10Schema.parse(previous)).not.toThrow();
      expect(() => parseOverworldSessionSnapshot(previous)).toThrow(
        /cannot be structurally upgraded without retired hash-keyed authority/i,
      );
    }

    const legacyQuestStart: OverworldSessionSnapshotV10 = {
      ...previousSnapshot(),
      journalEntries: [
        {
          id: "quest:wolf_winter",
          kind: "quest",
          town: "Albany",
          title: "Started Wolf-Winter",
          text: "Earlier quest-start prose.",
          recordedAt: "Day 1, 08:00",
          questStartProof: {
            kind: "legacy",
            sourceWorldHash: "c".repeat(64),
            boundary,
          },
        },
      ],
    };
    expect(() => OverworldSessionSnapshotV10Schema.parse(legacyQuestStart)).not.toThrow();
    expect(() => parseOverworldSessionSnapshot(legacyQuestStart)).toThrow(
      /has no structural approach ID/i,
    );

    const provenanceOnlyScene: OverworldSessionSnapshotV10 = {
      ...previousSnapshot(),
      journalEntries: [
        {
          id: "job:albany_job",
          kind: "job",
          town: "Albany",
          title: "Earlier job title",
          text: "Earlier job prose.",
          recordedAt: "Day 1, 08:00",
          localSceneProof: {
            sceneId: "scene:albany_job",
            optionId: "option:legacy",
            sourceWorldHash: "d".repeat(64),
          },
        },
      ],
    };
    expect(() => OverworldSessionSnapshotV10Schema.parse(provenanceOnlyScene)).not.toThrow();
    expect(() => parseOverworldSessionSnapshot(provenanceOnlyScene)).toThrow(
      /has no causal decision boundary/i,
    );
  });

  it("rejects unsupported, disguised, and malformed snapshot versions", () => {
    expect(() => parseOverworldSessionSnapshot({ ...previousSnapshot(), version: 9 })).toThrow(
      /unsupported overworld session snapshot version 9/i,
    );
    expect(() => parseOverworldSessionSnapshot({ ...baseSnapshot(), version: 12 })).toThrow(
      /unsupported overworld session snapshot version 12/i,
    );
    expect(() => parseOverworldSessionSnapshot({ ...previousSnapshot(), version: "10" })).toThrow();
    expect(() => parseOverworldSessionSnapshot({ ...previousSnapshot(), supplies: 9 })).toThrow();
    const { character: _character, ...missingCharacter } = baseSnapshot();
    expect(() => parseOverworldSessionSnapshot(missingCharacter)).toThrow();
  });

  it("projects runtime travel log entries into compact save entries", () => {
    const entry: TravelLogEntry = {
      edgeId: "road:albany:colonie",
      fromId: "albany_city",
      toId: "colonie_town",
      from: "Albany",
      to: "Colonie",
      route: "Old Post Road",
      distanceMi: 8,
      baseMinutes: 20,
      delayMinutes: 5,
      minutes: 25,
      arrivedAt: 505,
      suppliesUsed: 1,
      suppliesAfter: 5,
      fatigueGained: 1,
      fatigueAfter: 1,
      roadEvent: null,
    };

    expect(snapshotTravelLogEntry(entry)).toEqual({
      edgeId: "road:albany:colonie",
      fromId: "albany_city",
      toId: "colonie_town",
      roadEventId: null,
      delayMinutes: 5,
      minutes: 25,
      arrivedAt: 505,
      suppliesUsed: 1,
      suppliesAfter: 5,
      fatigueGained: 1,
      fatigueAfter: 1,
    });
  });

  it("clones saved arrays, tuples, journals, and pending encounters", () => {
    const snapshot = baseSnapshot();
    snapshot.inspectedStoryReveals = [["story:oath", ["reveal:duties"]]];
    const clone = cloneOverworldSessionSnapshot(snapshot);

    clone.discoveredIds.push("colonie_town");
    clone.currentAreaByTown[0]![1] = "changed_area";
    clone.travelLog[0]!.arrivedAt = 999;
    clone.journalEntries[0]!.title = "Changed";
    clone.questOutcomes.push(["wolf_winter", "ending_held"]);
    clone.regionRenown[0]![1] = 9;
    clone.inspectedStoryReveals![0]![1].push("reveal:mutated");
    clone.pendingRoadEncounter!.edgeId = "changed_road";
    clone.journey.goal.status = "completed";
    clone.character.health.current = 1;

    expect(snapshot.discoveredIds).toEqual(["albany_city"]);
    expect(snapshot.currentAreaByTown[0]).toEqual(["albany_city", "albany_capitol_hill"]);
    expect(snapshot.travelLog[0]?.arrivedAt).toBe(500);
    expect(snapshot.journalEntries[0]?.title).toBe("Capitol Hill");
    expect(snapshot.questOutcomes).toEqual([]);
    expect(snapshot.regionRenown[0]).toEqual(["Capital / Mohawk", 1]);
    expect(snapshot.inspectedStoryReveals).toEqual([["story:oath", ["reveal:duties"]]]);
    expect(snapshot.pendingRoadEncounter?.edgeId).toBe("road:albany:colonie");
    expect(snapshot.journey.goal.status).toBe("active");
    expect(snapshot.character.health.current).toBe(30);
  });

  it("clones journal entries independently", () => {
    const entries: OverworldJournalEntry[] = [
      {
        id: "service:rest:600",
        kind: "service",
        town: "albany_city",
        title: "Rest",
        text: "You recover.",
        recordedAt: "Day 1, 10:00",
      },
    ];

    const clones = cloneJournalEntries(entries);
    clones[0]!.title = "Changed";

    expect(entries[0]?.title).toBe("Rest");
  });

  it("deep-clones replay boundaries", () => {
    const entries: OverworldJournalEntry[] = [
      {
        id: "quest_done:wolf_winter",
        kind: "quest_done",
        town: "Albany",
        title: "Quest complete",
        text: "The timber survives.",
        recordedAt: "Day 1, 10:00",
        questCompletionBoundary: {
          acceptedDecisions: 3,
          decisionProofHash: "b".repeat(64),
          townId: "albany_city",
          areaId: "albany_city__transport_hub",
          minutes: 600,
        },
      },
    ];

    const clones = cloneJournalEntries(entries);
    clones[0]!.questCompletionBoundary!.areaId = "changed";

    expect(entries[0]?.questCompletionBoundary?.areaId).toBe("albany_city__transport_hub");
  });
});
