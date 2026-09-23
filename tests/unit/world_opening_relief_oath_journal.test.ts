import { describe, expect, it } from "vitest";

import { hashState } from "../../src/core/hash.js";
import {
  buildCampaignCharacterState,
  cloneCampaignCharacterState,
  type CampaignCharacterState,
} from "../../src/world/campaign_character_state.js";
import { OpeningRegistrationProfileSchema } from "../../src/world/opening_registration.js";
import type { OpeningRegistrationJournalProof } from "../../src/world/opening_registration_journal.js";
import {
  parseOpeningReliefOath,
  type OpeningReliefOath,
} from "../../src/world/opening_relief_oath.js";
import {
  openingReliefOathJournalEntry,
  openingReliefOathJournalId,
  openingReliefOathOfferJournalDraft,
  openingReliefOathOfferJournalEntry,
  proveOpeningReliefOathJournal,
} from "../../src/world/opening_relief_oath_journal.js";
import { timeLabel } from "../../src/world/session_journal_codec.js";
import type {
  OverworldJournalDecisionBoundary,
  OverworldJournalEntry,
} from "../../src/world/session_snapshot.js";

const TOWN = "Albany city";
const REGISTRATION_HASH = "a".repeat(64);
const REGISTRATION_PROFILE_ID = "albany:registered_relief_worker";

function registeredCharacter(): CampaignCharacterState {
  return buildCampaignCharacterState({
    background: REGISTRATION_PROFILE_ID,
    money: 12,
    values: [{ valueId: "albany:value_public_stewardship", strength: 5 }],
    factionStanding: [{ factionId: "albany:relief_board", standing: -10 }],
    relationships: [
      {
        npcId: "albany:rowan_quill",
        trust: 2,
        regard: 1,
        owesPlayer: 0,
        playerOwes: 0,
        memories: ["albany:memory_registration_complete"],
      },
    ],
  });
}

const REGISTRATION_PROFILE = OpeningRegistrationProfileSchema.parse({
  id: REGISTRATION_PROFILE_ID,
  title: "Registered relief worker",
  summary: "You know the municipal relief apparatus.",
  preview: "Your filing carries civic standing.",
  tradeoff: "The other histories remain unavailable.",
  consequence: "Albany recognizes your registered background.",
  character: registeredCharacter(),
});

function oathScene(): OpeningReliefOath {
  return parseOpeningReliefOath({
    version: 1,
    id: "albany:wolf_winter_relief_oath",
    after_registration: "albany:opening_registration",
    target_quest: "wolf_winter",
    home: "albany_city",
    area: "albany_city__civic_core",
    contact: "rowan_quill",
    clerk_npc_id: "albany:rowan_quill",
    title: "Choose your relief oath",
    message: "Rowan discloses three different forms of access and duty.",
    options: [
      {
        id: "albany:oath_official_relief",
        kind: "official",
        title: "Swear the official relief oath",
        summary: "You join Albany's recognized relief apparatus.",
        preview: "The board will open its depots and dispatch books.",
        tradeoff: "Public duty binds the dispatch.",
        consequence: "Your public duty will be remembered after Wolf-Winter.",
        access: "Municipal depots, dispatch books, and a board hearing.",
        duty: "Answer one lawful winter-relief dispatch before leaving Albany.",
        terms: { minutes: 12 },
        effects: [
          {
            type: "learn_knowledge",
            knowledge_id: "albany:knowledge_official_relief_protocol",
          },
          {
            type: "affirm_value",
            value_id: "albany:value_public_stewardship",
            strength_at_least: 4,
          },
          {
            type: "raise_faction_standing",
            faction_id: "albany:relief_board",
            standing_at_least: 30,
          },
          {
            type: "remember_relationship",
            npc_id: "albany:rowan_quill",
            memory_id: "albany:memory_swore_official_relief_oath",
            trust_at_least: 10,
          },
          {
            type: "record_promise",
            promise_id: "albany:promise_answer_relief_dispatch",
            recipient_id: "albany:rowan_quill",
          },
        ],
      },
      {
        id: "albany:oath_limited_relief",
        kind: "limited",
        title: "Accept a limited relief compact",
        summary: "You accept a narrow material compact.",
        preview: "One certified cache becomes available.",
        tradeoff: "Only the named cache is available.",
        consequence: "Albany records the limits you named.",
        access: "One certified cache and its route ledger.",
        duty: "Return an accounting of anything taken from that cache.",
        terms: { minutes: 6 },
        effects: [
          {
            type: "learn_knowledge",
            knowledge_id: "albany:knowledge_limited_relief_cache",
          },
          {
            type: "affirm_value",
            value_id: "albany:value_measured_obligation",
            strength_at_least: 3,
          },
          {
            type: "raise_faction_standing",
            faction_id: "albany:quartermasters",
            standing_at_least: 20,
          },
          {
            type: "remember_relationship",
            npc_id: "albany:rowan_quill",
            memory_id: "albany:memory_accepted_limited_relief_compact",
          },
          {
            type: "record_promise",
            promise_id: "albany:promise_account_for_relief_cache",
            recipient_id: "albany:rowan_quill",
          },
        ],
      },
      {
        id: "albany:oath_unaffiliated_relief",
        kind: "unaffiliated",
        title: "Remain unaffiliated",
        summary: "You decline institutional command without hiding from need.",
        preview: "Independent contacts will recognize your chosen boundary.",
        tradeoff: "No board authority is granted.",
        consequence: "Rowan records that your aid remains personal.",
        access: "Independent mutual-aid contacts and public road reports.",
        duty: "Carry one named civilian warning without claiming board authority.",
        terms: { minutes: 0 },
        effects: [
          {
            type: "learn_knowledge",
            knowledge_id: "albany:knowledge_independent_relief_contacts",
          },
          {
            type: "affirm_value",
            value_id: "albany:value_independent_mercy",
            strength_at_least: 3,
          },
          {
            type: "raise_faction_standing",
            faction_id: "albany:mutual_aid_network",
            standing_at_least: 15,
          },
          {
            type: "remember_relationship",
            npc_id: "albany:rowan_quill",
            memory_id: "albany:memory_remained_unaffiliated",
          },
          {
            type: "record_promise",
            promise_id: "albany:promise_carry_civilian_warning",
            recipient_id: "albany:rowan_quill",
          },
        ],
      },
    ],
  });
}

function registrationBoundary(): OverworldJournalDecisionBoundary {
  return {
    acceptedDecisions: 2,
    decisionProofHash: REGISTRATION_HASH,
    townId: "albany_city",
    areaId: "albany_city__civic_core",
    minutes: 60,
  };
}

function registrationEntry(boundary: OverworldJournalDecisionBoundary): OverworldJournalEntry {
  return {
    id: `registration:albany:opening_registration:${REGISTRATION_PROFILE_ID}`,
    kind: "registration",
    town: TOWN,
    title: "Registered: Registered relief worker",
    text: "The opening registration was selected.",
    recordedAt: timeLabel(boundary.minutes),
    registrationBoundary: { ...boundary },
  };
}

function registrationProof(args: {
  character: CampaignCharacterState;
  boundary: OverworldJournalDecisionBoundary;
  journalIndex: number;
}): OpeningRegistrationJournalProof {
  return {
    characterAtRegistration: cloneCampaignCharacterState(args.character),
    offered: true,
    offerBoundary: { ...args.boundary },
    profile: REGISTRATION_PROFILE,
    selectionBoundary: { ...args.boundary },
    journalIndex: args.journalIndex,
    recordedAt: args.boundary.minutes,
  };
}

function pendingFixture(character = registeredCharacter()) {
  const scene = oathScene();
  const boundary = registrationBoundary();
  const entries = [
    openingReliefOathOfferJournalEntry({
      scene,
      town: TOWN,
      recordedAt: timeLabel(boundary.minutes),
      storyChoiceBoundary: boundary,
    }),
    registrationEntry(boundary),
  ];
  return {
    scene,
    character,
    boundary,
    entries,
    proof: registrationProof({ character, boundary, journalIndex: 1 }),
  };
}

function selectedFixture(character = registeredCharacter()) {
  const pending = pendingFixture(character);
  const optionId = "albany:oath_official_relief";
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
    minutes: pending.boundary.minutes + 12,
  };
  const entries = [
    openingReliefOathJournalEntry({
      scene: pending.scene,
      character,
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
    proof: registrationProof({ character, boundary: pending.boundary, journalIndex: 2 }),
    selectionBoundary,
  };
}

function prove(args: {
  scene?: OpeningReliefOath | null;
  entries: readonly OverworldJournalEntry[];
  proof: OpeningRegistrationJournalProof;
  trustedLegacySourceWorldHash?: string | null;
}) {
  return proveOpeningReliefOathJournal({
    scene: args.scene === undefined ? oathScene() : args.scene,
    registrationProof: args.proof,
    journalEntries: args.entries,
    expectedTown: TOWN,
    ...(args.trustedLegacySourceWorldHash === undefined
      ? {}
      : { trustedLegacySourceWorldHash: args.trustedLegacySourceWorldHash }),
  });
}

describe("opening relief-oath journal proof", () => {
  it("creates canonical detached offer and access-duty-cost selection evidence", () => {
    const fixture = selectedFixture();
    const offer = openingReliefOathOfferJournalDraft(fixture.scene);
    expect(offer).toEqual({
      id: "relief_oath_offer:albany:wolf_winter_relief_oath",
      kind: "relief_oath_offer",
      title: fixture.scene.title,
      text: fixture.scene.message,
    });
    expect(Object.isFrozen(offer)).toBe(true);
    expect(Object.isFrozen(fixture.entries[0])).toBe(true);
    expect(Object.isFrozen(fixture.entries[0]!.storyChoiceBoundary)).toBe(true);
  });

  it("replays no evidence, a latest pending offer, and a paid selection", () => {
    const pending = pendingFixture();
    const noEvidenceCharacter = registeredCharacter();
    const noEvidence = prove({
      scene: null,
      entries: [pending.entries[1]!],
      proof: registrationProof({
        character: noEvidenceCharacter,
        boundary: pending.boundary,
        journalIndex: 0,
      }),
    });
    expect(noEvidence).toMatchObject({
      offered: false,
      option: null,
      terms: null,
    });
    expect(noEvidence.characterAfterOath).toEqual(noEvidenceCharacter);
    expect(noEvidence.characterAfterOath).not.toBe(noEvidenceCharacter);

    const pendingResult = prove(pending);
    expect(pendingResult).toMatchObject({
      offered: true,
      option: null,
      selectionBoundary: null,
      journalIndex: null,
      recordedAt: 60,
    });
    expect(pendingResult.offerBoundary).toEqual(pending.boundary);

    const selected = selectedFixture();
    const before = cloneCampaignCharacterState(selected.character);
    const selectedResult = prove(selected);
    expect(selected.character).toEqual(before);
    expect(selectedResult.option?.id).toBe("albany:oath_official_relief");
    expect(selectedResult.terms).toEqual({ minutes: 12 });
    expect(selectedResult.selectionBoundary).toEqual(selected.selectionBoundary);
    expect(selectedResult.journalIndex).toBe(0);
    expect(selectedResult.recordedAt).toBe(72);
    expect(selectedResult.characterAfterOath.knowledge).toContain(
      "albany:knowledge_official_relief_protocol",
    );
    expect(selectedResult.characterAfterOath.values).toContainEqual({
      valueId: "albany:value_public_stewardship",
      strength: 5,
    });
    expect(selectedResult.characterAfterOath.factionStanding).toContainEqual({
      factionId: "albany:relief_board",
      standing: 30,
    });
    expect(selectedResult.characterAfterOath.promises).toContainEqual({
      promiseId: "albany:promise_answer_relief_dispatch",
      recipientId: "albany:rowan_quill",
      status: "active",
    });
    expect(selectedResult.characterAfterOath.relationships).toContainEqual({
      npcId: "albany:rowan_quill",
      trust: 10,
      regard: 1,
      owesPlayer: 0,
      playerOwes: 0,
      memories: ["albany:memory_registration_complete", "albany:memory_swore_official_relief_oath"],
    });
  });

  it("preserves historical copy while binding ids, town, adjacency, and selected registration", () => {
    const fixture = selectedFixture();

    const forgedOffer = structuredClone(fixture.entries);
    forgedOffer[1]!.text += " Earlier wording.";
    expect(() => prove({ ...fixture, entries: forgedOffer })).not.toThrow();

    const forgedSelection = structuredClone(fixture.entries);
    forgedSelection[0]!.text = forgedSelection[0]!.text.replace("Access:", "Earlier access:");
    expect(() => prove({ ...fixture, entries: forgedSelection })).not.toThrow();

    const unknownOption = structuredClone(fixture.entries);
    unknownOption[0]!.id = openingReliefOathJournalId(fixture.scene.id, "albany:oath_missing");
    expect(() => prove({ ...fixture, entries: unknownOption })).toThrow(/unknown option/i);

    const wrongTown = structuredClone(fixture.entries);
    wrongTown[0]!.town = "Queensbury town";
    expect(() => prove({ ...fixture, entries: wrongTown })).toThrow(/bound to town/i);

    const dividedSelection = structuredClone(fixture.entries);
    dividedSelection.splice(1, 0, {
      id: "area:interposed",
      kind: "area",
      town: TOWN,
      title: "Interposed",
      text: "This cannot divide a selection from its offer.",
      recordedAt: timeLabel(72),
    });
    const dividedSelectionProof = registrationProof({
      character: fixture.character,
      boundary: fixture.boundary,
      journalIndex: 3,
    });
    expect(() =>
      prove({ ...fixture, entries: dividedSelection, proof: dividedSelectionProof }),
    ).toThrow(/immediately follow its offer/i);

    const dividedRegistration = structuredClone(fixture.entries);
    dividedRegistration.splice(2, 0, {
      id: "area:interposed_registration",
      kind: "area",
      town: TOWN,
      title: "Interposed",
      text: "This cannot divide the offer from registration.",
      recordedAt: timeLabel(60),
    });
    const dividedRegistrationProof = registrationProof({
      character: fixture.character,
      boundary: fixture.boundary,
      journalIndex: 3,
    });
    expect(() =>
      prove({ ...fixture, entries: dividedRegistration, proof: dividedRegistrationProof }),
    ).toThrow(/immediately follow registration/i);

    const noRegistration: OpeningRegistrationJournalProof = {
      ...fixture.proof,
      profile: null,
      selectionBoundary: null,
      journalIndex: null,
    };
    expect(() => prove({ ...fixture, proof: noRegistration })).toThrow(
      /no selected character registration/i,
    );
    expect(() => prove({ ...fixture, scene: null })).toThrow(/no opening relief-oath scene/i);
  });

  it("binds the decision hash, exact location, and exact paid elapsed time", () => {
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
      /same world and story boundary/i,
    );
  });

  it("rejects duplicate, mixed, late pending, and post-quest evidence", () => {
    const fixture = selectedFixture();
    expect(() => prove({ ...fixture, entries: [fixture.entries[0]!, ...fixture.entries] })).toThrow(
      /at most one opening relief oath/i,
    );
    expect(() => prove({ ...fixture, entries: [fixture.entries[1]!, ...fixture.entries] })).toThrow(
      /at most one opening relief-oath offer/i,
    );

    const pending = pendingFixture();
    const later = {
      id: "area:later",
      kind: "area" as const,
      town: TOWN,
      title: "Later",
      text: "Play advanced after the offer.",
      recordedAt: timeLabel(61),
    };
    expect(() =>
      prove({
        ...pending,
        entries: [later, ...pending.entries],
        proof: registrationProof({
          character: pending.character,
          boundary: pending.boundary,
          journalIndex: 2,
        }),
      }),
    ).toThrow(/pending relief-oath offer must remain the latest/i);

    const quest = {
      id: "quest:wolf_winter",
      kind: "quest" as const,
      town: TOWN,
      title: "Wolf-Winter",
      text: "The quest already began.",
      recordedAt: timeLabel(50),
    };
    expect(() => prove({ ...pending, entries: [...pending.entries, quest] })).toThrow(
      /cannot follow a started or completed quest/i,
    );
  });
});
