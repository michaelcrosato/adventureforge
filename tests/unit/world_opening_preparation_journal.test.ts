import { describe, expect, it } from "vitest";

import { hashState } from "../../src/core/hash.js";
import {
  buildCampaignCharacterState,
  cloneCampaignCharacterState,
  type CampaignCharacterState,
} from "../../src/world/campaign_character_state.js";
import { OpeningLeadSourceOptionSchema } from "../../src/world/opening_lead_source.js";
import type { OpeningLeadSourceJournalProof } from "../../src/world/opening_lead_source_journal.js";
import {
  parseOpeningPreparation,
  type OpeningPreparation,
} from "../../src/world/opening_preparation.js";
import {
  openingPreparationJournalEntry,
  openingPreparationJournalId,
  openingPreparationOfferJournalDraft,
  openingPreparationOfferJournalEntry,
  proveOpeningPreparationJournal,
} from "../../src/world/opening_preparation_journal.js";
import { timeLabel } from "../../src/world/session_journal_codec.js";
import type {
  OverworldJournalDecisionBoundary,
  OverworldJournalEntry,
} from "../../src/world/session_snapshot.js";

const TOWN = "Albany city";
const LEAD_HASH = "a".repeat(64);
const SPONSOR_MEMORY = "albany:memory_civic_sponsorship";

function preparationScene(): OpeningPreparation {
  return parseOpeningPreparation({
    version: 1,
    id: "albany:wolf_winter_preparation",
    after_lead_source: "albany:wolf_source_priority",
    target_quest: "wolf_winter",
    home: "albany_city",
    area: "albany_city__civic_core",
    title: "Wolf-Winter preparation",
    message: "Choose the plan that will shape the expedition.",
    profiles: [
      {
        id: "albany:prepare_civic_works",
        title: "Civic works survey",
        provider_npc_id: "albany:reese_pryce",
        summary: "Reese walks you through the damaged waterworks ledger.",
        preview: "You will enter knowing which frozen valves matter.",
        tradeoff: "The other specialist plans remain behind.",
        consequence: "Reese remembers that you trusted the civic plan.",
        terms: { minutes: 20, money: 4 },
        sponsor: {
          memory_id: SPONSOR_MEMORY,
          minutes: 5,
          money: 1,
          note: "Your sponsorship expedites the survey.",
        },
        effects: [
          {
            type: "learn_knowledge",
            knowledge_id: "albany:knowledge_wolf_frozen_valves",
          },
          {
            type: "remember_relationship",
            npc_id: "albany:reese_pryce",
            memory_id: "albany:memory_reese_civic_plan",
            trust_at_least: 3,
          },
        ],
      },
      {
        id: "albany:prepare_drovers",
        title: "Drover relay",
        provider_npc_id: "albany:morgan_bell",
        summary: "Morgan maps the whiteout relay.",
        preview: "You will know its fallback barns.",
        tradeoff: "The other specialist plans remain behind.",
        consequence: "Morgan remembers your road plan.",
        terms: { minutes: 15, money: 0 },
        effects: [
          {
            type: "learn_knowledge",
            knowledge_id: "albany:knowledge_wolf_drover_relay",
          },
          {
            type: "remember_relationship",
            npc_id: "albany:morgan_bell",
            memory_id: "albany:memory_morgan_drover_plan",
          },
        ],
      },
      {
        id: "albany:prepare_relief_routes",
        title: "Relief-route hearing",
        provider_npc_id: "albany:avery_shaw",
        summary: "Avery reconstructs the disputed route.",
        preview: "You will know its hidden winter track.",
        tradeoff: "The other specialist plans remain behind.",
        consequence: "Avery remembers your hearing.",
        terms: { minutes: 0, money: 2 },
        effects: [
          {
            type: "learn_knowledge",
            knowledge_id: "albany:knowledge_wolf_relief_track",
          },
          {
            type: "remember_relationship",
            npc_id: "albany:avery_shaw",
            memory_id: "albany:memory_avery_relief_plan",
          },
        ],
      },
    ],
  });
}

function sourceCharacter(sponsored = true): CampaignCharacterState {
  return buildCampaignCharacterState({
    money: 10,
    relationships: sponsored
      ? [
          {
            npcId: "albany:rowan_quill",
            trust: 1,
            regard: 1,
            owesPlayer: 0,
            playerOwes: 0,
            memories: [SPONSOR_MEMORY],
          },
        ]
      : [],
  });
}

const LEAD_OPTION = OpeningLeadSourceOptionSchema.parse({
  id: "albany:source_priority_docket",
  title: "Priority docket",
  source_npc_id: "albany:rowan_quill",
  summary: "Rowan certifies the docket.",
  preview: "The priority is now clear.",
  tradeoff: "Other packets remain uncertified.",
  consequence: "The lead is durable.",
  terms: { minutes: 0, money: 0 },
  effects: [],
});

function leadBoundary(): OverworldJournalDecisionBoundary {
  return {
    acceptedDecisions: 4,
    decisionProofHash: LEAD_HASH,
    townId: "albany_city",
    areaId: "albany_city__civic_core",
    minutes: 100,
  };
}

function leadEntry(boundary: OverworldJournalDecisionBoundary): OverworldJournalEntry {
  return {
    id: "lead_source:albany:wolf_source_priority:albany:source_priority_docket",
    kind: "lead_source",
    town: TOWN,
    title: "Certified source: Priority docket",
    text: "The priority docket was selected.",
    recordedAt: timeLabel(boundary.minutes),
    storyChoiceBoundary: { ...boundary },
  };
}

function leadProof(args: {
  character: CampaignCharacterState;
  boundary: OverworldJournalDecisionBoundary;
  journalIndex: number;
}): OpeningLeadSourceJournalProof {
  return {
    characterAfterSource: cloneCampaignCharacterState(args.character),
    offered: true,
    offerBoundary: { ...args.boundary },
    option: LEAD_OPTION,
    selectionBoundary: { ...args.boundary },
    terms: { minutes: 0, money: 0, sponsored: false, sponsorNote: null },
    journalIndex: args.journalIndex,
    recordedAt: args.boundary.minutes,
  };
}

function pendingFixture(character = sourceCharacter()) {
  const scene = preparationScene();
  const boundary = leadBoundary();
  const entries = [
    openingPreparationOfferJournalEntry({
      scene,
      town: TOWN,
      recordedAt: timeLabel(boundary.minutes),
      storyChoiceBoundary: boundary,
    }),
    leadEntry(boundary),
  ];
  return {
    scene,
    boundary,
    entries,
    proof: leadProof({ character, boundary, journalIndex: 1 }),
  };
}

function selectedFixture(character = sourceCharacter()) {
  const pending = pendingFixture(character);
  const profileId = "albany:prepare_civic_works";
  const selectionBoundary: OverworldJournalDecisionBoundary = {
    acceptedDecisions: pending.boundary.acceptedDecisions + 1,
    decisionProofHash: hashState({
      previous: pending.boundary.decisionProofHash,
      number: pending.boundary.acceptedDecisions + 1,
      surface: "overworld",
      actionId: `campaign_story:${pending.scene.id}:${profileId}`,
      reason: "situation_changed",
    }),
    townId: pending.boundary.townId,
    areaId: pending.boundary.areaId,
    minutes: pending.boundary.minutes + 5,
  };
  const entries = [
    openingPreparationJournalEntry({
      scene: pending.scene,
      character,
      profileId,
      town: TOWN,
      recordedAt: timeLabel(selectionBoundary.minutes),
      storyChoiceBoundary: selectionBoundary,
    }),
    ...pending.entries,
  ];
  return {
    ...pending,
    entries,
    proof: leadProof({ character, boundary: pending.boundary, journalIndex: 2 }),
    selectionBoundary,
  };
}

function prove(args: {
  scene?: OpeningPreparation | null;
  entries: readonly OverworldJournalEntry[];
  proof: OpeningLeadSourceJournalProof;
  trustedLegacySourceWorldHash?: string | null;
}) {
  return proveOpeningPreparationJournal({
    scene: args.scene === undefined ? preparationScene() : args.scene,
    leadSourceProof: args.proof,
    journalEntries: args.entries,
    expectedTown: TOWN,
    ...(args.trustedLegacySourceWorldHash === undefined
      ? {}
      : { trustedLegacySourceWorldHash: args.trustedLegacySourceWorldHash }),
  });
}

describe("opening preparation journal proof", () => {
  it("creates canonical detached offer and paid-selection evidence", () => {
    const fixture = selectedFixture();
    const offer = openingPreparationOfferJournalDraft(fixture.scene);
    expect(offer).toEqual({
      id: "preparation_offer:albany:wolf_winter_preparation",
      kind: "preparation_offer",
      title: fixture.scene.title,
      text: fixture.scene.message,
    });
    expect(Object.isFrozen(offer)).toBe(true);
    expect(Object.isFrozen(fixture.entries[0])).toBe(true);
    expect(Object.isFrozen(fixture.entries[0]!.storyChoiceBoundary)).toBe(true);
  });

  it("replays no evidence, a pending offer, and a sponsored paid selection", () => {
    const pending = pendingFixture();
    const noEvidenceCharacter = sourceCharacter();
    const noEvidence = prove({
      scene: null,
      entries: [pending.entries[1]!],
      proof: leadProof({
        character: noEvidenceCharacter,
        boundary: pending.boundary,
        journalIndex: 0,
      }),
    });
    expect(noEvidence).toMatchObject({ offered: false, profile: null });
    expect(noEvidence.characterAfterPreparation).toEqual(noEvidenceCharacter);
    expect(noEvidence.characterAfterPreparation).not.toBe(noEvidenceCharacter);

    const pendingResult = prove(pending);
    expect(pendingResult).toMatchObject({
      offered: true,
      profile: null,
      selectionBoundary: null,
      recordedAt: 100,
    });

    const selected = selectedFixture();
    const selectedResult = prove(selected);
    expect(selectedResult.profile?.id).toBe("albany:prepare_civic_works");
    expect(selectedResult.terms).toEqual({
      minutes: 5,
      money: 1,
      sponsored: true,
      sponsorNote: "Your sponsorship expedites the survey.",
    });
    expect(selectedResult.selectionBoundary).toEqual(selected.selectionBoundary);
    expect(selectedResult.recordedAt).toBe(105);
    expect(selectedResult.characterAfterPreparation.money).toBe(9);
    expect(selectedResult.characterAfterPreparation.knowledge).toContain(
      "albany:knowledge_wolf_frozen_valves",
    );
    expect(selectedResult.characterAfterPreparation.relationships).toContainEqual({
      npcId: "albany:reese_pryce",
      trust: 3,
      regard: 0,
      owesPlayer: 0,
      playerOwes: 0,
      memories: ["albany:memory_reese_civic_plan"],
    });
  });

  it("binds ids, town, adjacency, and the selected lead while preserving historical copy", () => {
    const fixture = selectedFixture();

    const forgedOffer = structuredClone(fixture.entries);
    forgedOffer[1]!.text += " Earlier wording.";
    expect(() => prove({ ...fixture, entries: forgedOffer })).not.toThrow();

    const forgedSelection = structuredClone(fixture.entries);
    forgedSelection[0]!.title = "Prepared under an earlier title";
    expect(() => prove({ ...fixture, entries: forgedSelection })).not.toThrow();

    const unknownProfile = structuredClone(fixture.entries);
    unknownProfile[0]!.id = openingPreparationJournalId(fixture.scene.id, "albany:prepare_missing");
    expect(() => prove({ ...fixture, entries: unknownProfile })).toThrow(/unknown profile/i);

    const wrongTown = structuredClone(fixture.entries);
    wrongTown[0]!.town = "Queensbury town";
    expect(() => prove({ ...fixture, entries: wrongTown })).toThrow(/bound to town/i);

    const separated = structuredClone(fixture.entries);
    separated.splice(1, 0, {
      id: "area:interposed",
      kind: "area",
      town: TOWN,
      title: "Interposed",
      text: "This cannot divide a decision from its offer.",
      recordedAt: timeLabel(105),
    });
    const separatedProof = leadProof({
      character: sourceCharacter(),
      boundary: fixture.boundary,
      journalIndex: 3,
    });
    expect(() => prove({ ...fixture, entries: separated, proof: separatedProof })).toThrow(
      /immediately follow its offer/i,
    );

    const noSelectedLead: OpeningLeadSourceJournalProof = {
      ...fixture.proof,
      option: null,
      selectionBoundary: null,
      journalIndex: null,
    };
    expect(() => prove({ ...fixture, proof: noSelectedLead })).toThrow(/no selected Albany lead/i);
    expect(() => prove({ ...fixture, scene: null })).toThrow(/no opening preparation scene/i);
  });

  it("binds the decision hash, exact location, and exact sponsored elapsed time", () => {
    const fixture = selectedFixture();

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

    const forgedOffer = structuredClone(fixture.entries);
    forgedOffer[1]!.storyChoiceBoundary!.minutes += 1;
    expect(() => prove({ ...fixture, entries: forgedOffer })).toThrow(
      /authored departure boundary/i,
    );
  });

  it("rejects duplicate, mixed, late pending, and post-quest evidence", () => {
    const fixture = selectedFixture();
    expect(() => prove({ ...fixture, entries: [fixture.entries[0]!, ...fixture.entries] })).toThrow(
      /at most one opening preparation/i,
    );
    expect(() => prove({ ...fixture, entries: [fixture.entries[1]!, ...fixture.entries] })).toThrow(
      /at most one opening preparation offer/i,
    );

    const pending = pendingFixture();
    const later = {
      id: "area:later",
      kind: "area" as const,
      town: TOWN,
      title: "Later",
      text: "Play advanced after the offer.",
      recordedAt: timeLabel(101),
    };
    expect(() =>
      prove({
        ...pending,
        entries: [later, ...pending.entries],
        proof: leadProof({
          character: sourceCharacter(),
          boundary: pending.boundary,
          journalIndex: 2,
        }),
      }),
    ).toThrow(/pending preparation offer must remain the latest/i);

    const quest = {
      id: "quest:wolf_winter",
      kind: "quest" as const,
      town: TOWN,
      title: "Wolf-Winter",
      text: "The quest already began.",
      recordedAt: timeLabel(90),
    };
    expect(() =>
      prove({
        ...pending,
        entries: [...pending.entries, quest],
      }),
    ).toThrow(/cannot follow a started or completed quest/i);
  });
});
