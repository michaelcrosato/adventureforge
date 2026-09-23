import { hashState } from "../core/hash.js";
import {
  cloneCampaignCharacterState,
  type CampaignCharacterState,
} from "./campaign_character_state.js";
import {
  applyOpeningLeadSourceOption,
  formatOpeningLeadSourceCost,
  openingLeadSourceOptionById,
  parseOpeningLeadSource,
  type OpeningLeadSource,
  type OpeningLeadSourceOption,
  type OpeningLeadSourceTerms,
} from "./opening_lead_source.js";
import type { OpeningRegistrationJournalProof } from "./opening_registration_journal.js";
import type { OpeningReliefOathJournalProof } from "./opening_relief_oath_journal.js";
import { parseTimeLabel } from "./session_journal_codec.js";
import type {
  OverworldJournalDecisionBoundary,
  OverworldJournalEntry,
} from "./session_snapshot.js";

const OPENING_LEAD_SOURCE_JOURNAL_PREFIX = "lead_source:" as const;
const OPENING_LEAD_SOURCE_OFFER_JOURNAL_PREFIX = "lead_source_offer:" as const;

export type OpeningLeadSourceJournalDraft = Readonly<
  Pick<OverworldJournalEntry, "id" | "kind" | "title" | "text">
>;

export type OpeningLeadSourceJournalProof = Readonly<{
  characterAfterSource: CampaignCharacterState;
  offered: boolean;
  offerBoundary: OverworldJournalDecisionBoundary | null;
  option: OpeningLeadSourceOption | null;
  selectionBoundary: OverworldJournalDecisionBoundary | null;
  terms: OpeningLeadSourceTerms | null;
  journalIndex: number | null;
  recordedAt: number | null;
}>;

export function openingLeadSourceOfferJournalId(sceneId: string): string {
  return `${OPENING_LEAD_SOURCE_OFFER_JOURNAL_PREFIX}${sceneId}`;
}

export function openingLeadSourceJournalId(sceneId: string, optionId: string): string {
  return `${OPENING_LEAD_SOURCE_JOURNAL_PREFIX}${sceneId}:${optionId}`;
}

export function openingLeadSourceOfferJournalDraft(
  scene: OpeningLeadSource,
): OpeningLeadSourceJournalDraft {
  const parsed = parseOpeningLeadSource(scene);
  return Object.freeze({
    id: openingLeadSourceOfferJournalId(parsed.id),
    kind: "lead_source_offer" as const,
    title: parsed.title,
    text: parsed.message,
  });
}

export function openingLeadSourceJournalDraft(args: {
  scene: OpeningLeadSource;
  character: CampaignCharacterState;
  optionId: string;
}): OpeningLeadSourceJournalDraft {
  const parsed = parseOpeningLeadSource(args.scene);
  const applied = applyOpeningLeadSourceOption({
    scene: parsed,
    character: args.character,
    optionId: args.optionId,
  });
  const sponsorship = applied.terms.sponsorNote ? ` ${applied.terms.sponsorNote}` : "";
  return Object.freeze({
    id: openingLeadSourceJournalId(parsed.id, applied.option.id),
    kind: "lead_source" as const,
    title: `Certified source: ${applied.option.title}`,
    text: `${applied.option.summary} ${applied.option.preview} Actual cost: ${formatOpeningLeadSourceCost(applied.terms)}.${sponsorship} ${applied.option.consequence}`,
  });
}

function freezeBoundary(
  boundary: OverworldJournalDecisionBoundary,
): OverworldJournalDecisionBoundary {
  return Object.freeze({ ...boundary });
}

export function openingLeadSourceOfferJournalEntry(args: {
  scene: OpeningLeadSource;
  town: string;
  recordedAt: string;
  storyChoiceBoundary: OverworldJournalDecisionBoundary;
}): OverworldJournalEntry {
  return Object.freeze({
    ...openingLeadSourceOfferJournalDraft(args.scene),
    town: args.town,
    recordedAt: args.recordedAt,
    storyChoiceBoundary: freezeBoundary(args.storyChoiceBoundary),
  });
}

export function openingLeadSourceJournalEntry(args: {
  scene: OpeningLeadSource;
  character: CampaignCharacterState;
  optionId: string;
  town: string;
  recordedAt: string;
  storyChoiceBoundary: OverworldJournalDecisionBoundary;
}): OverworldJournalEntry {
  return Object.freeze({
    ...openingLeadSourceJournalDraft(args),
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

/** Replay the mandatory source offer and its optional pending/selected state. */
export function proveOpeningLeadSourceJournal(args: {
  scene: OpeningLeadSource | null | undefined;
  registrationProof: OpeningRegistrationJournalProof;
  reliefOathProof?: OpeningReliefOathJournalProof;
  journalEntries: readonly OverworldJournalEntry[];
  expectedTown: string | null;
}): OpeningLeadSourceJournalProof {
  const selections = args.journalEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.kind === "lead_source");
  const offers = args.journalEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.kind === "lead_source_offer");
  if (selections.length > 1) {
    throw new Error("Overworld session snapshot must contain at most one opening lead source.");
  }
  if (offers.length > 1) {
    throw new Error(
      "Overworld session snapshot must contain at most one opening lead-source offer.",
    );
  }
  if (selections.length === 0 && offers.length === 0) {
    return Object.freeze({
      characterAfterSource: cloneCampaignCharacterState(
        args.reliefOathProof?.characterAfterOath ?? args.registrationProof.characterAtRegistration,
      ),
      offered: false,
      offerBoundary: null,
      option: null,
      selectionBoundary: null,
      terms: null,
      journalIndex: null,
      recordedAt: null,
    });
  }
  if (!args.scene) {
    throw new Error(
      "Overworld session snapshot has opening lead-source evidence, but this world has no opening lead-source scene.",
    );
  }
  if (!args.registrationProof.profile || args.registrationProof.journalIndex === null) {
    throw new Error(
      "Overworld session snapshot opening lead source has no selected character registration.",
    );
  }
  const scene = parseOpeningLeadSource(args.scene);
  let characterBeforeSource = args.registrationProof.characterAtRegistration;
  let predecessorBoundary = args.registrationProof.selectionBoundary;
  let predecessorJournalIndex = args.registrationProof.journalIndex;
  let predecessorLabel = "registration";

  const reliefOathProof = args.reliefOathProof;
  if (reliefOathProof !== undefined) {
    const selectedOath =
      reliefOathProof.offered &&
      reliefOathProof.offerBoundary !== null &&
      reliefOathProof.option !== null &&
      reliefOathProof.selectionBoundary !== null &&
      reliefOathProof.terms !== null &&
      reliefOathProof.journalIndex !== null &&
      reliefOathProof.recordedAt !== null;
    const emptyOath =
      !reliefOathProof.offered &&
      reliefOathProof.offerBoundary === null &&
      reliefOathProof.option === null &&
      reliefOathProof.selectionBoundary === null &&
      reliefOathProof.terms === null &&
      reliefOathProof.journalIndex === null &&
      reliefOathProof.recordedAt === null;

    if (selectedOath) {
      const oathEntry = args.journalEntries[reliefOathProof.journalIndex!];
      if (
        !oathEntry ||
        oathEntry.kind !== "relief_oath" ||
        !oathEntry.storyChoiceBoundary ||
        !boundariesEqual(oathEntry.storyChoiceBoundary, reliefOathProof.selectionBoundary!) ||
        reliefOathProof.recordedAt !== reliefOathProof.selectionBoundary!.minutes ||
        oathEntry.storyChoiceBoundary.minutes !== parseTimeLabel(oathEntry.recordedAt)
      ) {
        throw new Error(
          "Overworld session snapshot opening lead source cannot locate its selected relief-oath boundary.",
        );
      }
      characterBeforeSource = reliefOathProof.characterAfterOath;
      predecessorBoundary = reliefOathProof.selectionBoundary;
      predecessorJournalIndex = reliefOathProof.journalIndex;
      predecessorLabel = "the selected relief oath";
    } else if (emptyOath) {
      throw new Error(
        "Overworld session snapshot opening lead source is missing its required relief-oath predecessor.",
      );
    } else {
      throw new Error(
        "Overworld session snapshot opening lead source requires a selected relief-oath predecessor.",
      );
    }
  }

  if (predecessorBoundary === null || predecessorJournalIndex === null) {
    throw new Error(
      `Overworld session snapshot opening lead source has no durable ${predecessorLabel} boundary.`,
    );
  }
  const predecessorEntry = args.journalEntries[predecessorJournalIndex];
  if (!predecessorEntry) {
    throw new Error(
      `Overworld session snapshot opening lead source cannot locate its ${predecessorLabel} journal boundary.`,
    );
  }
  const offered = offers[0];
  if (!offered) {
    throw new Error("Overworld session snapshot lead-source selection has no replayable offer.");
  }
  const expectedOffer = openingLeadSourceOfferJournalDraft(scene);
  if (offered.entry.id !== expectedOffer.id) {
    throw new Error(
      `Overworld session snapshot lead-source offer "${offered.entry.id}" references unknown evidence.`,
    );
  }
  if (args.expectedTown !== null && offered.entry.town !== args.expectedTown) {
    throw new Error(
      `Overworld session snapshot lead-source offer "${offered.entry.id}" is bound to town "${offered.entry.town}", expected "${args.expectedTown}".`,
    );
  }
  const offerBoundary = offered.entry.storyChoiceBoundary;
  if (!offerBoundary) {
    throw new Error(
      "Overworld session snapshot lead-source offer has no durable story-choice boundary.",
    );
  }
  if (
    offered.index + 1 !== predecessorJournalIndex ||
    offered.entry.recordedAt !== predecessorEntry.recordedAt ||
    !boundariesEqual(offerBoundary, predecessorBoundary) ||
    offerBoundary.townId !== scene.home ||
    offerBoundary.areaId !== scene.area ||
    offerBoundary.minutes !== parseTimeLabel(offered.entry.recordedAt)
  ) {
    throw new Error(
      `Overworld session snapshot lead-source offer must immediately follow ${predecessorLabel} at the same world and journey boundary.`,
    );
  }
  for (let index = offered.index + 1; index < args.journalEntries.length; index += 1) {
    const kind = args.journalEntries[index]!.kind;
    if (kind === "quest" || kind === "quest_done") {
      throw new Error(
        "Overworld session snapshot lead-source offer cannot follow a started or completed quest.",
      );
    }
  }

  if (selections.length === 0) {
    if (offered.index !== 0) {
      throw new Error(
        "Overworld session snapshot pending lead-source offer must remain the latest journal boundary.",
      );
    }
    return Object.freeze({
      characterAfterSource: cloneCampaignCharacterState(characterBeforeSource),
      offered: true,
      offerBoundary: { ...offerBoundary },
      option: null,
      selectionBoundary: null,
      terms: null,
      journalIndex: null,
      recordedAt: parseTimeLabel(offered.entry.recordedAt),
    });
  }

  const selected = selections[0]!;
  const option = scene.options.find(
    (candidate) => openingLeadSourceJournalId(scene.id, candidate.id) === selected.entry.id,
  );
  if (!option || !openingLeadSourceOptionById(scene, option.id)) {
    throw new Error(
      `Overworld session snapshot lead-source entry references an unknown option in "${selected.entry.id}".`,
    );
  }
  const application = applyOpeningLeadSourceOption({
    scene,
    character: characterBeforeSource,
    optionId: option.id,
  });
  if (args.expectedTown !== null && selected.entry.town !== args.expectedTown) {
    throw new Error(
      `Overworld session snapshot lead-source entry "${selected.entry.id}" is bound to town "${selected.entry.town}", expected "${args.expectedTown}".`,
    );
  }
  const selectionBoundary = selected.entry.storyChoiceBoundary;
  if (!selectionBoundary) {
    throw new Error(
      "Overworld session snapshot lead-source selection has no durable story-choice boundary.",
    );
  }
  if (selected.index + 1 !== offered.index) {
    throw new Error(
      "Overworld session snapshot lead-source selection must immediately follow its offer.",
    );
  }
  const expectedDecisionNumber = offerBoundary.acceptedDecisions + 1;
  const expectedLastDecision = {
    number: expectedDecisionNumber,
    surface: "overworld" as const,
    actionId: `campaign_story:${scene.id}:${option.id}`,
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
      "Overworld session snapshot lead-source selection does not match its journey decision, location, or paid-time boundary.",
    );
  }
  return Object.freeze({
    characterAfterSource: cloneCampaignCharacterState(application.characterAfter),
    offered: true,
    offerBoundary: { ...offerBoundary },
    option,
    selectionBoundary: { ...selectionBoundary },
    terms: { ...application.terms },
    journalIndex: selected.index,
    recordedAt: expectedMinutes,
  });
}
