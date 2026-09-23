import { hashState } from "../core/hash.js";
import {
  cloneCampaignCharacterState,
  type CampaignCharacterState,
} from "./campaign_character_state.js";
import type { OpeningLeadSourceJournalProof } from "./opening_lead_source_journal.js";
import {
  applyOpeningPreparationProfile,
  formatOpeningPreparationCost,
  openingPreparationProfileById,
  parseOpeningPreparation,
  type OpeningPreparation,
  type OpeningPreparationProfile,
  type OpeningPreparationTerms,
} from "./opening_preparation.js";
import { parseTimeLabel } from "./session_journal_codec.js";
import type {
  OverworldJournalDecisionBoundary,
  OverworldJournalEntry,
} from "./session_snapshot.js";

const OPENING_PREPARATION_JOURNAL_PREFIX = "preparation:" as const;
const OPENING_PREPARATION_OFFER_JOURNAL_PREFIX = "preparation_offer:" as const;

export type OpeningPreparationJournalDraft = Readonly<
  Pick<OverworldJournalEntry, "id" | "kind" | "title" | "text">
>;

export type OpeningPreparationJournalProof = Readonly<{
  characterAfterPreparation: CampaignCharacterState;
  offered: boolean;
  offerBoundary: OverworldJournalDecisionBoundary | null;
  profile: OpeningPreparationProfile | null;
  selectionBoundary: OverworldJournalDecisionBoundary | null;
  terms: OpeningPreparationTerms | null;
  journalIndex: number | null;
  recordedAt: number | null;
}>;

export function openingPreparationOfferJournalId(sceneId: string): string {
  return `${OPENING_PREPARATION_OFFER_JOURNAL_PREFIX}${sceneId}`;
}

export function openingPreparationJournalId(sceneId: string, profileId: string): string {
  return `${OPENING_PREPARATION_JOURNAL_PREFIX}${sceneId}:${profileId}`;
}

export function openingPreparationOfferJournalDraft(
  scene: OpeningPreparation,
): OpeningPreparationJournalDraft {
  const parsed = parseOpeningPreparation(scene);
  return Object.freeze({
    id: openingPreparationOfferJournalId(parsed.id),
    kind: "preparation_offer" as const,
    title: parsed.title,
    text: parsed.message,
  });
}

function openingPreparationJournalDraft(args: {
  scene: OpeningPreparation;
  character: CampaignCharacterState;
  profileId: string;
}): OpeningPreparationJournalDraft {
  const parsed = parseOpeningPreparation(args.scene);
  const applied = applyOpeningPreparationProfile({
    scene: parsed,
    character: args.character,
    profileId: args.profileId,
  });
  const sponsorship = applied.terms.sponsorNote ? ` ${applied.terms.sponsorNote}` : "";
  return Object.freeze({
    id: openingPreparationJournalId(parsed.id, applied.profile.id),
    kind: "preparation" as const,
    title: `Prepared: ${applied.profile.title}`,
    text: `${applied.profile.summary} ${applied.profile.preview} Actual cost: ${formatOpeningPreparationCost(applied.terms)}.${sponsorship} ${applied.profile.consequence}`,
  });
}

function freezeBoundary(
  boundary: OverworldJournalDecisionBoundary,
): OverworldJournalDecisionBoundary {
  return Object.freeze({ ...boundary });
}

export function openingPreparationOfferJournalEntry(args: {
  scene: OpeningPreparation;
  town: string;
  recordedAt: string;
  storyChoiceBoundary: OverworldJournalDecisionBoundary;
}): OverworldJournalEntry {
  return Object.freeze({
    ...openingPreparationOfferJournalDraft(args.scene),
    town: args.town,
    recordedAt: args.recordedAt,
    storyChoiceBoundary: freezeBoundary(args.storyChoiceBoundary),
  });
}

export function openingPreparationJournalEntry(args: {
  scene: OpeningPreparation;
  character: CampaignCharacterState;
  profileId: string;
  town: string;
  recordedAt: string;
  storyChoiceBoundary: OverworldJournalDecisionBoundary;
}): OverworldJournalEntry {
  return Object.freeze({
    ...openingPreparationJournalDraft(args),
    town: args.town,
    recordedAt: args.recordedAt,
    storyChoiceBoundary: freezeBoundary(args.storyChoiceBoundary),
  });
}

function boundariesEqual(
  left: OverworldJournalDecisionBoundary,
  right: OverworldJournalDecisionBoundary,
): boolean {
  return (
    left.acceptedDecisions === right.acceptedDecisions &&
    left.decisionProofHash === right.decisionProofHash &&
    left.townId === right.townId &&
    left.areaId === right.areaId &&
    left.minutes === right.minutes
  );
}

function emptyPreparationProof(character: CampaignCharacterState): OpeningPreparationJournalProof {
  return Object.freeze({
    characterAfterPreparation: cloneCampaignCharacterState(character),
    offered: false,
    offerBoundary: null,
    profile: null,
    selectionBoundary: null,
    terms: null,
    journalIndex: null,
    recordedAt: null,
  });
}

/**
 * Replay the preparation offer and paid profile selection without trusting the
 * mutable campaign-character payload.
 */
export function proveOpeningPreparationJournal(args: {
  scene: OpeningPreparation | null | undefined;
  leadSourceProof: OpeningLeadSourceJournalProof;
  journalEntries: readonly OverworldJournalEntry[];
  expectedTown: string | null;
}): OpeningPreparationJournalProof {
  const selections = args.journalEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.kind === "preparation");
  const offers = args.journalEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.kind === "preparation_offer");
  if (selections.length > 1) {
    throw new Error("Overworld session snapshot must contain at most one opening preparation.");
  }
  if (offers.length > 1) {
    throw new Error(
      "Overworld session snapshot must contain at most one opening preparation offer.",
    );
  }
  if (selections.length === 0 && offers.length === 0) {
    return emptyPreparationProof(args.leadSourceProof.characterAfterSource);
  }
  if (!args.scene) {
    throw new Error(
      "Overworld session snapshot has opening preparation evidence, but this world has no opening preparation scene.",
    );
  }
  if (
    !args.leadSourceProof.option ||
    args.leadSourceProof.journalIndex === null ||
    !args.leadSourceProof.selectionBoundary
  ) {
    throw new Error(
      "Overworld session snapshot opening preparation has no selected Albany lead source.",
    );
  }
  const scene = parseOpeningPreparation(args.scene);
  const leadBoundary = args.leadSourceProof.selectionBoundary;
  const leadJournalIndex = args.leadSourceProof.journalIndex;
  const leadEntry = args.journalEntries[leadJournalIndex];
  if (!leadEntry) {
    throw new Error(
      "Overworld session snapshot opening preparation cannot locate its lead-source journal boundary.",
    );
  }

  const offered = offers[0];
  if (!offered) {
    throw new Error("Overworld session snapshot preparation selection has no replayable offer.");
  }
  const expectedOffer = openingPreparationOfferJournalDraft(scene);
  if (offered.entry.id !== expectedOffer.id) {
    throw new Error(
      `Overworld session snapshot preparation offer "${offered.entry.id}" references unknown evidence.`,
    );
  }
  if (args.expectedTown !== null && offered.entry.town !== args.expectedTown) {
    throw new Error(
      `Overworld session snapshot preparation offer "${offered.entry.id}" is bound to town "${offered.entry.town}", expected "${args.expectedTown}".`,
    );
  }
  const offerBoundary = offered.entry.storyChoiceBoundary;
  if (!offerBoundary) {
    throw new Error(
      "Overworld session snapshot preparation offer has no durable story-choice boundary.",
    );
  }
  const selected = selections[0];
  const offeredAtLeadBoundary = scene.area === leadBoundary.areaId;
  const invalidOfferBoundary = offeredAtLeadBoundary
    ? offered.index + 1 !== leadJournalIndex ||
      offered.entry.recordedAt !== leadEntry.recordedAt ||
      !boundariesEqual(offerBoundary, leadBoundary)
    : offered.index >= leadJournalIndex ||
      offerBoundary.acceptedDecisions <= leadBoundary.acceptedDecisions ||
      offerBoundary.decisionProofHash === leadBoundary.decisionProofHash;
  if (
    invalidOfferBoundary ||
    offerBoundary.townId !== scene.home ||
    offerBoundary.areaId !== scene.area ||
    offerBoundary.minutes !== parseTimeLabel(offered.entry.recordedAt)
  ) {
    throw new Error(
      "Overworld session snapshot preparation offer must follow source certification at its authored departure boundary.",
    );
  }
  if (offeredAtLeadBoundary) {
    for (let index = offered.index + 1; index < leadJournalIndex; index += 1) {
      const kind = args.journalEntries[index]!.kind;
      if (kind === "quest" || kind === "quest_done") {
        throw new Error(
          "Overworld session snapshot preparation offer cannot follow a started or completed quest.",
        );
      }
    }
  }
  const targetQuestEvidence = args.journalEntries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        (entry.kind === "quest" && entry.id === `quest:${scene.target_quest}`) ||
        (entry.kind === "quest_done" && entry.id === `quest_done:${scene.target_quest}`),
    );
  if (targetQuestEvidence.some(({ index }) => selected === undefined || index >= selected.index)) {
    throw new Error(
      "Overworld session snapshot opening preparation cannot follow a started or completed quest for its target.",
    );
  }
  if (selections.length === 0) {
    if (offered.index !== 0) {
      throw new Error(
        "Overworld session snapshot pending preparation offer must remain the latest journal boundary.",
      );
    }
    return Object.freeze({
      characterAfterPreparation: cloneCampaignCharacterState(
        args.leadSourceProof.characterAfterSource,
      ),
      offered: true,
      offerBoundary: { ...offerBoundary },
      profile: null,
      selectionBoundary: null,
      terms: null,
      journalIndex: null,
      recordedAt: parseTimeLabel(offered.entry.recordedAt),
    });
  }

  if (!selected) throw new Error("Expected opening preparation selection.");
  const profile = scene.profiles.find(
    (candidate) => openingPreparationJournalId(scene.id, candidate.id) === selected.entry.id,
  );
  if (!profile || !openingPreparationProfileById(scene, profile.id)) {
    throw new Error(
      `Overworld session snapshot preparation entry references an unknown profile in "${selected.entry.id}".`,
    );
  }
  const application = applyOpeningPreparationProfile({
    scene,
    character: args.leadSourceProof.characterAfterSource,
    profileId: profile.id,
  });
  if (args.expectedTown !== null && selected.entry.town !== args.expectedTown) {
    throw new Error(
      `Overworld session snapshot preparation entry "${selected.entry.id}" is bound to town "${selected.entry.town}", expected "${args.expectedTown}".`,
    );
  }
  const selectionBoundary = selected.entry.storyChoiceBoundary;
  if (!selectionBoundary) {
    throw new Error(
      "Overworld session snapshot preparation selection has no durable story-choice boundary.",
    );
  }
  if (selected.index + 1 !== offered.index) {
    throw new Error(
      "Overworld session snapshot preparation selection must immediately follow its offer.",
    );
  }
  const expectedDecisionNumber = offerBoundary.acceptedDecisions + 1;
  const expectedLastDecision = {
    number: expectedDecisionNumber,
    surface: "overworld" as const,
    actionId: `campaign_story:${scene.id}:${profile.id}`,
    reason: "situation_changed" as const,
  };
  const expectedDecisionProofHash = hashState({
    previous: offerBoundary.decisionProofHash,
    ...expectedLastDecision,
  });
  const expectedMinutes = offerBoundary.minutes + application.terms.minutes;
  if (
    selectionBoundary.acceptedDecisions !== expectedDecisionNumber ||
    selectionBoundary.decisionProofHash !== expectedDecisionProofHash ||
    selectionBoundary.townId !== offerBoundary.townId ||
    selectionBoundary.areaId !== offerBoundary.areaId ||
    selectionBoundary.minutes !== expectedMinutes ||
    parseTimeLabel(selected.entry.recordedAt) !== expectedMinutes
  ) {
    throw new Error(
      "Overworld session snapshot preparation selection does not match its journey decision, location, or paid-time boundary.",
    );
  }
  return Object.freeze({
    characterAfterPreparation: cloneCampaignCharacterState(application.characterAfter),
    offered: true,
    offerBoundary: { ...offerBoundary },
    profile,
    selectionBoundary: { ...selectionBoundary },
    terms: { ...application.terms },
    journalIndex: selected.index,
    recordedAt: expectedMinutes,
  });
}
