import { hashState } from "../core/hash.js";
import {
  cloneCampaignCharacterState,
  type CampaignCharacterState,
} from "./campaign_character_state.js";
import {
  applyOpeningReliefAllocationOption,
  formatOpeningReliefAllocationCost,
  openingReliefAllocationOptionById,
  parseOpeningReliefAllocation,
  type OpeningReliefAllocation,
  type OpeningReliefAllocationOption,
  type OpeningReliefAllocationTerms,
} from "./opening_relief_allocation.js";
import { replayOpeningDispatchChoices } from "./opening_dispatch_choice_replay.js";
import type { OpeningLeadSourceJournalProof } from "./opening_lead_source_journal.js";
import type { OpeningPreparation } from "./opening_preparation.js";
import type { OpeningPreparationJournalProof } from "./opening_preparation_journal.js";
import { parseTimeLabel } from "./session_journal_codec.js";
import type {
  OverworldJournalDecisionBoundary,
  OverworldJournalEntry,
} from "./session_snapshot.js";

const OPENING_RELIEF_ALLOCATION_JOURNAL_PREFIX = "relief_allocation:" as const;
const OPENING_RELIEF_ALLOCATION_OFFER_JOURNAL_PREFIX = "relief_allocation_offer:" as const;

export type OpeningReliefAllocationJournalDraft = Readonly<
  Pick<OverworldJournalEntry, "id" | "kind" | "title" | "text">
>;

export type OpeningReliefAllocationJournalProof = Readonly<{
  characterAfterAllocation: CampaignCharacterState;
  offered: boolean;
  offerBoundary: OverworldJournalDecisionBoundary | null;
  option: OpeningReliefAllocationOption | null;
  selectionBoundary: OverworldJournalDecisionBoundary | null;
  terms: OpeningReliefAllocationTerms | null;
  journalIndex: number | null;
  recordedAt: number | null;
}>;

export function openingReliefAllocationOfferJournalId(sceneId: string): string {
  return `${OPENING_RELIEF_ALLOCATION_OFFER_JOURNAL_PREFIX}${sceneId}`;
}

export function openingReliefAllocationJournalId(sceneId: string, optionId: string): string {
  return `${OPENING_RELIEF_ALLOCATION_JOURNAL_PREFIX}${sceneId}:${optionId}`;
}

export function openingReliefAllocationOfferJournalDraft(
  scene: OpeningReliefAllocation,
): OpeningReliefAllocationJournalDraft {
  const parsed = parseOpeningReliefAllocation(scene);
  return Object.freeze({
    id: openingReliefAllocationOfferJournalId(parsed.id),
    kind: "relief_allocation_offer" as const,
    title: parsed.title,
    text: parsed.message,
  });
}

function openingReliefAllocationJournalDraft(args: {
  scene: OpeningReliefAllocation;
  character: CampaignCharacterState;
  optionId: string;
}): OpeningReliefAllocationJournalDraft {
  const parsed = parseOpeningReliefAllocation(args.scene);
  const applied = applyOpeningReliefAllocationOption(args);
  return Object.freeze({
    id: openingReliefAllocationJournalId(parsed.id, applied.option.id),
    kind: "relief_allocation" as const,
    title: `Allocated relief: ${applied.option.title}`,
    text:
      `${applied.option.summary} ${applied.option.preview} ` +
      `Protects: ${applied.option.protects} Leaves exposed: ${applied.option.leaves_exposed} ` +
      `Actual cost: ${formatOpeningReliefAllocationCost(applied.terms)}. ${applied.option.consequence}`,
  });
}

function freezeBoundary(
  boundary: OverworldJournalDecisionBoundary,
): OverworldJournalDecisionBoundary {
  return Object.freeze({ ...boundary });
}

export function openingReliefAllocationOfferJournalEntry(args: {
  scene: OpeningReliefAllocation;
  town: string;
  recordedAt: string;
  storyChoiceBoundary: OverworldJournalDecisionBoundary;
}): OverworldJournalEntry {
  return Object.freeze({
    ...openingReliefAllocationOfferJournalDraft(args.scene),
    town: args.town,
    recordedAt: args.recordedAt,
    storyChoiceBoundary: freezeBoundary(args.storyChoiceBoundary),
  });
}

export function openingReliefAllocationJournalEntry(args: {
  scene: OpeningReliefAllocation;
  character: CampaignCharacterState;
  optionId: string;
  town: string;
  recordedAt: string;
  storyChoiceBoundary: OverworldJournalDecisionBoundary;
}): OverworldJournalEntry {
  return Object.freeze({
    ...openingReliefAllocationJournalDraft(args),
    town: args.town,
    recordedAt: args.recordedAt,
    storyChoiceBoundary: freezeBoundary(args.storyChoiceBoundary),
  });
}

function emptyAllocationProof(
  character: CampaignCharacterState,
): OpeningReliefAllocationJournalProof {
  return Object.freeze({
    characterAfterAllocation: cloneCampaignCharacterState(character),
    offered: false,
    offerBoundary: null,
    option: null,
    selectionBoundary: null,
    terms: null,
    journalIndex: null,
    recordedAt: null,
  });
}

/** Replay one current allocation without trusting saved character state. */
export function proveOpeningReliefAllocationJournal(args: {
  scene: OpeningReliefAllocation | null | undefined;
  preparationProof: OpeningPreparationJournalProof;
  leadSourceProof?: OpeningLeadSourceJournalProof;
  preparationScene?: OpeningPreparation | null;
  journalEntries: readonly OverworldJournalEntry[];
  expectedTown: string | null;
}): OpeningReliefAllocationJournalProof {
  const indexed = args.journalEntries.map((entry, index) => ({ entry, index }));
  const selections = indexed.filter(({ entry }) => entry.kind === "relief_allocation");
  const offers = indexed.filter(({ entry }) => entry.kind === "relief_allocation_offer");
  const evidenceIndex = selections[0]?.index ?? offers[0]?.index;
  const sourceSelected =
    args.leadSourceProof?.option !== null &&
    args.leadSourceProof?.option !== undefined &&
    args.leadSourceProof.journalIndex !== null;
  const preparationSelected =
    args.preparationProof.profile !== null && args.preparationProof.journalIndex !== null;
  const characterBeforeAllocation =
    sourceSelected && args.preparationScene
      ? replayOpeningDispatchChoices({
          characterAfterSource: args.leadSourceProof!.characterAfterSource,
          choices: preparationSelected
            ? [
                {
                  kind: "preparation" as const,
                  journalIndex: args.preparationProof.journalIndex!,
                  scene: args.preparationScene,
                  optionId: args.preparationProof.profile!.id,
                },
              ]
            : [],
          ...(evidenceIndex === undefined ? {} : { beforeJournalIndex: evidenceIndex }),
        })
      : args.preparationProof.characterAfterPreparation;
  if (selections.length > 1 || offers.length > 1) {
    throw new Error(
      "Overworld session snapshot must contain at most one relief allocation offer and choice.",
    );
  }
  if (selections.length === 0 && offers.length === 0) {
    return emptyAllocationProof(characterBeforeAllocation);
  }
  if (!args.scene) {
    throw new Error(
      "Overworld session snapshot has relief allocation evidence, but this world has no opening relief allocation scene.",
    );
  }
  if (
    !sourceSelected &&
    (!args.preparationProof.profile || args.preparationProof.journalIndex === null)
  ) {
    throw new Error(
      args.leadSourceProof === undefined
        ? "Overworld session snapshot relief allocation evidence has no resolved opening preparation."
        : "Overworld session snapshot relief allocation evidence has no certified opening source.",
    );
  }
  const scene = parseOpeningReliefAllocation(args.scene);

  const offered = offers[0];
  const selected = selections[0];
  if (!offered) {
    throw new Error("Overworld session snapshot relief allocation choice has no durable offer.");
  }
  const expectedOffer = openingReliefAllocationOfferJournalDraft(scene);
  if (offered.entry.id !== expectedOffer.id) {
    throw new Error(
      `Overworld session snapshot relief allocation offer "${offered.entry.id}" references unknown evidence.`,
    );
  }
  if (args.expectedTown !== null && offered.entry.town !== args.expectedTown) {
    throw new Error(
      `Overworld session snapshot relief allocation offer "${offered.entry.id}" is bound to town "${offered.entry.town}", expected "${args.expectedTown}".`,
    );
  }
  const offerBoundary = offered.entry.storyChoiceBoundary;
  const predecessorJournalIndex = sourceSelected
    ? args.leadSourceProof!.journalIndex
    : args.preparationProof.journalIndex;
  if (
    !offerBoundary ||
    offerBoundary.townId !== scene.home ||
    offerBoundary.areaId !== scene.area ||
    offerBoundary.minutes !== parseTimeLabel(offered.entry.recordedAt) ||
    predecessorJournalIndex === null ||
    offered.index >= predecessorJournalIndex
  ) {
    throw new Error(
      "Overworld session snapshot relief allocation offer is not bound after source certification at its authored departure location, time, and journey boundary.",
    );
  }
  if (!selected) {
    if (offered.index !== 0) {
      throw new Error(
        "Overworld session snapshot pending relief allocation offer must remain the latest journal boundary.",
      );
    }
    return Object.freeze({
      ...emptyAllocationProof(characterBeforeAllocation),
      offered: true,
      offerBoundary: { ...offerBoundary },
      recordedAt: parseTimeLabel(offered.entry.recordedAt),
    });
  }

  const option = scene.options.find(
    (candidate) => openingReliefAllocationJournalId(scene.id, candidate.id) === selected.entry.id,
  );
  if (!option || !openingReliefAllocationOptionById(scene, option.id)) {
    throw new Error(
      `Overworld session snapshot relief allocation entry references an unknown option in "${selected.entry.id}".`,
    );
  }
  const application = applyOpeningReliefAllocationOption({
    scene,
    character: characterBeforeAllocation,
    optionId: option.id,
  });
  if (args.expectedTown !== null && selected.entry.town !== args.expectedTown) {
    throw new Error(
      `Overworld session snapshot relief allocation entry "${selected.entry.id}" is bound to town "${selected.entry.town}", expected "${args.expectedTown}".`,
    );
  }
  const selectionBoundary = selected.entry.storyChoiceBoundary;
  if (!selectionBoundary || selected.index + 1 !== offered.index) {
    throw new Error(
      "Overworld session snapshot relief allocation selection must immediately follow its durable offer.",
    );
  }
  for (let index = selected.index + 1; index < args.journalEntries.length; index += 1) {
    const entry = args.journalEntries[index]!;
    if (
      (entry.kind === "quest" && entry.id === `quest:${scene.target_quest}`) ||
      (entry.kind === "quest_done" && entry.id === `quest_done:${scene.target_quest}`)
    ) {
      throw new Error(
        "Overworld session snapshot relief allocation selection must precede the target quest boundary.",
      );
    }
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
      "Overworld session snapshot relief allocation selection does not match its journey decision, location, or paid-time boundary.",
    );
  }
  return Object.freeze({
    characterAfterAllocation: cloneCampaignCharacterState(application.characterAfter),
    offered: true,
    offerBoundary: { ...offerBoundary },
    option,
    selectionBoundary: { ...selectionBoundary },
    terms: { ...application.terms },
    journalIndex: selected.index,
    recordedAt: expectedMinutes,
  });
}
