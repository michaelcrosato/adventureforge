import { describe, expect, it } from "vitest";

import { hashState } from "../../src/core/hash.js";
import {
  buildCampaignCharacterState,
  cloneCampaignCharacterState,
  type CampaignCharacterState,
} from "../../src/world/campaign_character_state.js";
import { OpeningPreparationProfileSchema } from "../../src/world/opening_preparation.js";
import type { OpeningPreparationJournalProof } from "../../src/world/opening_preparation_journal.js";
import {
  parseOpeningReliefAllocation,
  type OpeningReliefAllocation,
} from "../../src/world/opening_relief_allocation.js";
import {
  openingReliefAllocationJournalEntry,
  openingReliefAllocationJournalId,
  openingReliefAllocationOfferJournalDraft,
  openingReliefAllocationOfferJournalEntry,
  proveOpeningReliefAllocationJournal,
} from "../../src/world/opening_relief_allocation_journal.js";
import { timeLabel } from "../../src/world/session_journal_codec.js";
import type {
  OverworldJournalDecisionBoundary,
  OverworldJournalEntry,
} from "../../src/world/session_snapshot.js";

const TOWN = "Albany city";
const PREPARATION_HASH = "a".repeat(64);

function reliefAllocationScene(): OpeningReliefAllocation {
  return parseOpeningReliefAllocation({
    version: 1,
    id: "albany:wolf_relief_allocation",
    after_preparation: "albany:wolf_preparation",
    target_quest: "wolf_winter",
    home: "albany_city",
    area: "albany_city__transport_hub",
    title: "Allocate Albany's Relief Capacity",
    message:
      "One public packet can cover Cade's steading, Albany's vulnerable residents, or the mobile reserve.",
    options: [
      {
        id: "albany:relief_cade_steading",
        title: "Cover Cade's Steading",
        provider_npc_id: "albany:hayden_hale",
        summary: "Send the packet's barriers and drover hands north with the field team.",
        preview: "The steading begins with a staffed relief line.",
        protects: "Cade's byre and its first failed cattle recovery.",
        leaves_exposed: "Albany's resident counter and the roaming reserve.",
        consequence: "Hayden records that the hill steading received first claim.",
        terms: { minutes: 10 },
        effects: [
          {
            type: "learn_knowledge",
            knowledge_id: "albany:knowledge_relief_cade_steading",
          },
          {
            type: "remember_relationship",
            npc_id: "albany:hayden_hale",
            memory_id: "albany:memory_hayden_relief_cade_steading",
            trust_at_least: 3,
          },
        ],
      },
      {
        id: "albany:relief_vulnerable_residents",
        title: "Cover Vulnerable Residents",
        provider_npc_id: "albany:jamie_tanner",
        summary: "Keep the packet at Albany's public counter for exposed households.",
        preview: "The hill dispatch leaves without those public stores.",
        protects: "Albany's heat, medicine, and food claims.",
        leaves_exposed: "Cade's first field recovery and the roaming reserve.",
        consequence: "Jamie records that resident claims remained first in line.",
        terms: { minutes: 0 },
        effects: [
          {
            type: "learn_knowledge",
            knowledge_id: "albany:knowledge_relief_vulnerable_residents",
          },
          {
            type: "remember_relationship",
            npc_id: "albany:jamie_tanner",
            memory_id: "albany:memory_jamie_relief_vulnerable_residents",
            regard_at_least: 3,
          },
        ],
      },
      {
        id: "albany:relief_mobile_reserve",
        title: "Keep a Mobile Reserve",
        provider_npc_id: "albany:rowan_quill",
        summary: "Keep the packet sealed on the relief wagon for one later emergency.",
        preview: "Neither fixed site receives its protection at departure.",
        protects: "One mobile response where the winter line breaks next.",
        leaves_exposed: "Cade's opening line and Albany's fixed resident counter.",
        consequence: "Rowan records that flexibility outranked immediate coverage.",
        terms: { minutes: 5 },
        effects: [
          {
            type: "learn_knowledge",
            knowledge_id: "albany:knowledge_relief_mobile_reserve",
          },
          {
            type: "remember_relationship",
            npc_id: "albany:rowan_quill",
            memory_id: "albany:memory_rowan_relief_mobile_reserve",
          },
        ],
      },
    ],
  });
}

const PREPARATION_PROFILE = OpeningPreparationProfileSchema.parse({
  id: "albany:prep_test",
  title: "Test preparation",
  provider_npc_id: "albany:reese_pryce",
  summary: "The field plan is selected.",
  preview: "Its knowledge will remain available.",
  tradeoff: "The other field plans remain behind.",
  consequence: "Reese records the selected preparation.",
  terms: { minutes: 0, money: 0 },
  effects: [
    { type: "learn_knowledge", knowledge_id: "albany:knowledge_test_preparation" },
    {
      type: "remember_relationship",
      npc_id: "albany:reese_pryce",
      memory_id: "albany:memory_reese_test_preparation",
    },
  ],
});

function characterAfterPreparation(): CampaignCharacterState {
  return buildCampaignCharacterState({
    money: 12,
    knowledge: ["albany:knowledge_test_preparation"],
  });
}

function preparationBoundary(): OverworldJournalDecisionBoundary {
  return {
    acceptedDecisions: 5,
    decisionProofHash: PREPARATION_HASH,
    townId: "albany_city",
    areaId: "albany_city__civic_core",
    minutes: 90,
  };
}

function preparationEntry(boundary = preparationBoundary()): OverworldJournalEntry {
  return {
    id: "preparation:albany:wolf_preparation:albany:prep_test",
    kind: "preparation",
    town: TOWN,
    title: "Prepared: Test preparation",
    text: "The exact preparation proof is supplied by its predecessor module.",
    recordedAt: timeLabel(boundary.minutes),
    storyChoiceBoundary: { ...boundary },
  };
}

function preparationProof(args: {
  character?: CampaignCharacterState;
  journalIndex: number;
}): OpeningPreparationJournalProof {
  const boundary = preparationBoundary();
  return {
    characterAfterPreparation: cloneCampaignCharacterState(
      args.character ?? characterAfterPreparation(),
    ),
    offered: true,
    offerBoundary: { ...boundary },
    profile: PREPARATION_PROFILE,
    selectionBoundary: { ...boundary },
    terms: { minutes: 0, money: 0, sponsored: false, sponsorNote: null },
    journalIndex: args.journalIndex,
    recordedAt: boundary.minutes,
  };
}

function offerBoundary(): OverworldJournalDecisionBoundary {
  return {
    acceptedDecisions: 6,
    decisionProofHash: "b".repeat(64),
    townId: "albany_city",
    areaId: "albany_city__transport_hub",
    minutes: 100,
  };
}

function pendingFixture() {
  const scene = reliefAllocationScene();
  const boundary = offerBoundary();
  const entries = [
    openingReliefAllocationOfferJournalEntry({
      scene,
      town: TOWN,
      recordedAt: timeLabel(boundary.minutes),
      storyChoiceBoundary: boundary,
    }),
    preparationEntry(),
  ];
  return { scene, boundary, entries, proof: preparationProof({ journalIndex: 1 }) };
}

function selectedFixture(optionId = "albany:relief_cade_steading") {
  const pending = pendingFixture();
  const option = pending.scene.options.find((candidate) => candidate.id === optionId);
  if (!option) throw new Error("expected allocation option");
  const selectionBoundary: OverworldJournalDecisionBoundary = {
    acceptedDecisions: pending.boundary.acceptedDecisions + 1,
    decisionProofHash: hashState({
      previous: pending.boundary.decisionProofHash,
      number: pending.boundary.acceptedDecisions + 1,
      surface: "overworld",
      actionId: `campaign_story:${pending.scene.id}:${optionId}`,
      reason: "situation_changed",
    }),
    townId: pending.boundary.townId,
    areaId: pending.boundary.areaId,
    minutes: pending.boundary.minutes + option.terms.minutes,
  };
  const entries = [
    openingReliefAllocationJournalEntry({
      scene: pending.scene,
      character: characterAfterPreparation(),
      optionId,
      town: TOWN,
      recordedAt: timeLabel(selectionBoundary.minutes),
      storyChoiceBoundary: selectionBoundary,
    }),
    ...pending.entries,
  ];
  return {
    ...pending,
    entries,
    proof: preparationProof({ journalIndex: 2 }),
    selectionBoundary,
  };
}

function prove(args: {
  scene?: OpeningReliefAllocation | null;
  entries: readonly OverworldJournalEntry[];
  proof: OpeningPreparationJournalProof;
}) {
  return proveOpeningReliefAllocationJournal({
    scene: args.scene === undefined ? reliefAllocationScene() : args.scene,
    preparationProof: args.proof,
    journalEntries: args.entries,
    expectedTown: TOWN,
  });
}

describe("opening relief allocation journal proof", () => {
  it("creates immutable canonical offer and selection copies with named exposure", () => {
    const scene = reliefAllocationScene();
    const offer = openingReliefAllocationOfferJournalDraft(scene);
    expect(offer).toEqual({
      id: "relief_allocation_offer:albany:wolf_relief_allocation",
      kind: "relief_allocation_offer",
      title: scene.title,
      text: scene.message,
    });
    expect(Object.isFrozen(offer)).toBe(true);
  });

  it("replays no evidence, a pending offer, and one exact paid allocation", () => {
    const character = characterAfterPreparation();
    const noEvidence = prove({
      scene: null,
      entries: [preparationEntry()],
      proof: preparationProof({ character, journalIndex: 0 }),
    });
    expect(noEvidence).toMatchObject({ offered: false, option: null });
    expect(noEvidence.characterAfterAllocation).toEqual(character);
    expect(noEvidence.characterAfterAllocation).not.toBe(character);

    const pending = pendingFixture();
    expect(prove(pending)).toMatchObject({
      offered: true,
      option: null,
      selectionBoundary: null,
      recordedAt: 100,
    });

    const selected = selectedFixture();
    const result = prove(selected);
    expect(result.option?.id).toBe("albany:relief_cade_steading");
    expect(result.terms).toEqual({ minutes: 10 });
    expect(result.selectionBoundary).toEqual(selected.selectionBoundary);
    expect(result.recordedAt).toBe(110);
    expect(result.characterAfterAllocation.knowledge).toContain(
      "albany:knowledge_relief_cade_steading",
    );
    expect(result.characterAfterAllocation.relationships).toContainEqual({
      npcId: "albany:hayden_hale",
      trust: 3,
      regard: 0,
      owesPlayer: 0,
      playerOwes: 0,
      memories: ["albany:memory_hayden_relief_cade_steading"],
    });
  });

  it("preserves historical copy while rejecting forged identity, town, adjacency, boundary, and time", () => {
    const fixture = selectedFixture();

    const forgedOffer = structuredClone(fixture.entries);
    forgedOffer[1]!.text += " Earlier wording.";
    expect(() => prove({ ...fixture, entries: forgedOffer })).not.toThrow();

    const forgedSelection = structuredClone(fixture.entries);
    forgedSelection[0]!.title = "Allocated relief under an earlier title";
    expect(() => prove({ ...fixture, entries: forgedSelection })).not.toThrow();

    const unknown = structuredClone(fixture.entries);
    unknown[0]!.id = openingReliefAllocationJournalId(fixture.scene.id, "albany:relief_missing");
    expect(() => prove({ ...fixture, entries: unknown })).toThrow(/unknown option/i);

    const wrongTown = structuredClone(fixture.entries);
    wrongTown[0]!.town = "Queensbury town";
    expect(() => prove({ ...fixture, entries: wrongTown })).toThrow(/bound to town/i);

    const separated = structuredClone(fixture.entries);
    separated.splice(1, 0, {
      id: "area:interposed",
      kind: "area",
      town: TOWN,
      title: "Interposed",
      text: "This cannot divide selection from offer.",
      recordedAt: timeLabel(110),
    });
    expect(() =>
      prove({ ...fixture, entries: separated, proof: preparationProof({ journalIndex: 3 }) }),
    ).toThrow(/immediately follow its durable offer/i);

    for (const mutate of [
      (entry: OverworldJournalEntry) => {
        entry.storyChoiceBoundary!.acceptedDecisions += 1;
      },
      (entry: OverworldJournalEntry) => {
        entry.storyChoiceBoundary!.decisionProofHash = "0".repeat(64);
      },
      (entry: OverworldJournalEntry) => {
        entry.storyChoiceBoundary!.areaId = "albany_city__market";
      },
      (entry: OverworldJournalEntry) => {
        entry.storyChoiceBoundary!.minutes += 1;
        entry.recordedAt = timeLabel(entry.storyChoiceBoundary!.minutes);
      },
    ]) {
      const forged = structuredClone(fixture.entries);
      mutate(forged[0]!);
      expect(() => prove({ ...fixture, entries: forged })).toThrow(/paid-time boundary/i);
    }
  });

  it("rejects duplicate, unresolved-preparation, and late pending evidence", () => {
    const fixture = selectedFixture();
    expect(() => prove({ ...fixture, entries: [fixture.entries[0]!, ...fixture.entries] })).toThrow(
      /at most one relief allocation/i,
    );

    const unresolved: OpeningPreparationJournalProof = {
      ...fixture.proof,
      profile: null,
      journalIndex: null,
      selectionBoundary: null,
    };
    expect(() => prove({ ...fixture, proof: unresolved })).toThrow(/no resolved.*preparation/i);

    const pending = pendingFixture();
    expect(() =>
      prove({
        ...pending,
        entries: [
          {
            id: "area:later",
            kind: "area",
            town: TOWN,
            title: "Later",
            text: "The pending offer is no longer latest.",
            recordedAt: timeLabel(101),
          },
          ...pending.entries,
        ],
        proof: preparationProof({ journalIndex: 2 }),
      }),
    ).toThrow(/pending relief allocation offer must remain the latest/i);
  });

  it("may follow unrelated quest work but must precede Wolf-Winter itself", () => {
    const fixture = selectedFixture();
    const unrelatedQuest: OverworldJournalEntry = {
      id: "quest:gallowmere",
      kind: "quest",
      town: "Queensbury town",
      title: "Started Gallowmere",
      text: "An unrelated dispatch was started before the Wolf-Winter allocation.",
      recordedAt: timeLabel(90),
    };
    const entries = [fixture.entries[0]!, fixture.entries[1]!, unrelatedQuest, fixture.entries[2]!];
    expect(
      prove({
        ...fixture,
        entries,
        proof: preparationProof({ journalIndex: 3 }),
      }).option?.id,
    ).toBe("albany:relief_cade_steading");

    const targetQuest = structuredClone(entries);
    targetQuest[2]!.id = "quest:wolf_winter";
    expect(() =>
      prove({
        ...fixture,
        entries: targetQuest,
        proof: preparationProof({ journalIndex: 3 }),
      }),
    ).toThrow(/precede the target quest boundary/i);
  });
});
