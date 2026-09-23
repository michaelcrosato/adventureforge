import { hashState } from "../core/hash.js";
import {
  cloneCampaignCharacterState,
  type CampaignCharacterState,
} from "./campaign_character_state.js";
import { replayOpeningDispatchChoices } from "./opening_dispatch_choice_replay.js";
import type { OpeningLeadSourceJournalProof } from "./opening_lead_source_journal.js";
import type { OpeningPreparation } from "./opening_preparation.js";
import type { OpeningPreparationJournalProof } from "./opening_preparation_journal.js";
import type { OpeningReliefAllocation } from "./opening_relief_allocation.js";
import type { OpeningReliefAllocationJournalProof } from "./opening_relief_allocation_journal.js";
import {
  applyOpeningAllyOption,
  formatOpeningAllyTimingDisclosure,
  openingAllyOptionById,
  parseOpeningAlly,
  type OpeningAlly,
  type OpeningAllyOption,
  type OpeningAllyTerms,
} from "./opening_ally.js";
import { parseTimeLabel } from "./session_journal_codec.js";
import type {
  OverworldJournalDecisionBoundary,
  OverworldJournalEntry,
} from "./session_snapshot.js";

const OPENING_ALLY_JOURNAL_PREFIX = "ally:" as const;
const OPENING_ALLY_OFFER_JOURNAL_PREFIX = "ally_offer:" as const;

export type OpeningAllyJournalDraft = Readonly<
  Pick<OverworldJournalEntry, "id" | "kind" | "title" | "text">
>;

export type OpeningAllyJournalProof = Readonly<{
  characterAfterAlly: CampaignCharacterState;
  offered: boolean;
  offerBoundary: OverworldJournalDecisionBoundary | null;
  option: OpeningAllyOption | null;
  selectionBoundary: OverworldJournalDecisionBoundary | null;
  terms: OpeningAllyTerms | null;
  journalIndex: number | null;
  recordedAt: number | null;
}>;

export function openingAllyOfferJournalId(sceneId: string): string {
  return `${OPENING_ALLY_OFFER_JOURNAL_PREFIX}${sceneId}`;
}

export function openingAllyJournalId(sceneId: string, optionId: string): string {
  return `${OPENING_ALLY_JOURNAL_PREFIX}${sceneId}:${optionId}`;
}

export function openingAllyOfferJournalDraft(scene: OpeningAlly): OpeningAllyJournalDraft {
  const parsed = parseOpeningAlly(scene);
  return Object.freeze({
    id: openingAllyOfferJournalId(parsed.id),
    kind: "ally_offer" as const,
    title: parsed.title,
    text: `${parsed.message} Capability: ${parsed.capability} Condition: ${parsed.condition}`,
  });
}

export function openingAllyJournalDraft(args: {
  scene: OpeningAlly;
  character: CampaignCharacterState;
  optionId: string;
}): OpeningAllyJournalDraft {
  const parsed = parseOpeningAlly(args.scene);
  const applied = applyOpeningAllyOption(args);
  return Object.freeze({
    id: openingAllyJournalId(parsed.id, applied.option.id),
    kind: "ally" as const,
    title: `Field team: ${applied.option.title}`,
    text: `${applied.option.summary} ${applied.option.preview} ${formatOpeningAllyTimingDisclosure(applied.terms)} ${applied.option.consequence}`,
  });
}

function freezeBoundary(
  boundary: OverworldJournalDecisionBoundary,
): OverworldJournalDecisionBoundary {
  return Object.freeze({ ...boundary });
}

export function openingAllyOfferJournalEntry(args: {
  scene: OpeningAlly;
  town: string;
  recordedAt: string;
  storyChoiceBoundary: OverworldJournalDecisionBoundary;
}): OverworldJournalEntry {
  return Object.freeze({
    ...openingAllyOfferJournalDraft(args.scene),
    town: args.town,
    recordedAt: args.recordedAt,
    storyChoiceBoundary: freezeBoundary(args.storyChoiceBoundary),
  });
}

export function openingAllyJournalEntry(args: {
  scene: OpeningAlly;
  character: CampaignCharacterState;
  optionId: string;
  town: string;
  recordedAt: string;
  storyChoiceBoundary: OverworldJournalDecisionBoundary;
}): OverworldJournalEntry {
  return Object.freeze({
    ...openingAllyJournalDraft(args),
    town: args.town,
    recordedAt: args.recordedAt,
    storyChoiceBoundary: freezeBoundary(args.storyChoiceBoundary),
  });
}

function emptyAllyProof(character: CampaignCharacterState): OpeningAllyJournalProof {
  return Object.freeze({
    characterAfterAlly: cloneCampaignCharacterState(character),
    offered: false,
    offerBoundary: null,
    option: null,
    selectionBoundary: null,
    terms: null,
    journalIndex: null,
    recordedAt: null,
  });
}

/** Replay the departure offer and selected field-team contract. */
export function proveOpeningAllyJournal(args: {
  scene: OpeningAlly | null | undefined;
  preparationProof: OpeningPreparationJournalProof;
  reliefAllocationProof?: OpeningReliefAllocationJournalProof;
  leadSourceProof?: OpeningLeadSourceJournalProof;
  preparationScene?: OpeningPreparation | null;
  reliefAllocationScene?: OpeningReliefAllocation | null;
  journalEntries: readonly OverworldJournalEntry[];
  expectedTown: string | null;
}): OpeningAllyJournalProof {
  const indexed = args.journalEntries.map((entry, index) => ({ entry, index }));
  const selections = indexed.filter(({ entry }) => entry.kind === "ally");
  const offers = indexed.filter(({ entry }) => entry.kind === "ally_offer");
  const allocationSelected =
    args.reliefAllocationProof?.option !== null && args.reliefAllocationProof?.option !== undefined;
  const allocationJournalIndex = args.reliefAllocationProof?.journalIndex ?? null;
  const allyEvidenceIndex = selections[0]?.index ?? offers[0]?.index ?? null;
  const sourceSelected =
    args.leadSourceProof?.option !== null &&
    args.leadSourceProof?.option !== undefined &&
    args.leadSourceProof.journalIndex !== null;
  const preparationSelected =
    args.preparationProof.profile !== null && args.preparationProof.journalIndex !== null;
  const hasOrderNeutralReplay =
    sourceSelected &&
    args.preparationScene !== undefined &&
    args.reliefAllocationScene !== undefined;
  const characterBeforeAlly = hasOrderNeutralReplay
    ? replayOpeningDispatchChoices({
        characterAfterSource: args.leadSourceProof!.characterAfterSource,
        choices: [
          ...(preparationSelected && args.preparationScene
            ? [
                {
                  kind: "preparation" as const,
                  journalIndex: args.preparationProof.journalIndex!,
                  scene: args.preparationScene,
                  optionId: args.preparationProof.profile!.id,
                },
              ]
            : []),
          ...(allocationSelected && allocationJournalIndex !== null && args.reliefAllocationScene
            ? [
                {
                  kind: "relief_allocation" as const,
                  journalIndex: allocationJournalIndex,
                  scene: args.reliefAllocationScene,
                  optionId: args.reliefAllocationProof!.option!.id,
                },
              ]
            : []),
        ],
        ...(allyEvidenceIndex === null ? {} : { beforeJournalIndex: allyEvidenceIndex }),
      })
    : allocationSelected &&
        allocationJournalIndex !== null &&
        allyEvidenceIndex !== null &&
        allocationJournalIndex > allyEvidenceIndex
      ? args.reliefAllocationProof!.characterAfterAllocation
      : args.preparationProof.characterAfterPreparation;
  const predecessorJournalIndex = sourceSelected
    ? args.leadSourceProof!.journalIndex
    : allocationSelected &&
        allocationJournalIndex !== null &&
        allyEvidenceIndex !== null &&
        allocationJournalIndex > allyEvidenceIndex
      ? allocationJournalIndex
      : args.preparationProof.journalIndex;
  if (selections.length > 1 || offers.length > 1) {
    throw new Error("Overworld session snapshot must contain at most one ally offer and choice.");
  }
  if (selections.length === 0 && offers.length === 0) {
    return emptyAllyProof(characterBeforeAlly);
  }
  if (!args.scene) {
    throw new Error(
      "Overworld session snapshot has opening ally evidence, but this world has no opening ally scene.",
    );
  }
  if (
    !sourceSelected &&
    (!args.preparationProof.profile || args.preparationProof.journalIndex === null)
  ) {
    throw new Error(
      "Overworld session snapshot opening ally evidence has no certified opening source.",
    );
  }
  const scene = parseOpeningAlly(args.scene);

  const offered = offers[0];
  const selected = selections[0];
  if (!offered) {
    throw new Error(
      "Overworld session snapshot ally choice has no durable offer; direct departures remain solo without invented ally evidence.",
    );
  }
  const expectedOffer = openingAllyOfferJournalDraft(scene);
  if (offered.entry.id !== expectedOffer.id) {
    throw new Error(
      `Overworld session snapshot ally offer "${offered.entry.id}" references unknown evidence.`,
    );
  }
  if (args.expectedTown !== null && offered.entry.town !== args.expectedTown) {
    throw new Error(
      `Overworld session snapshot ally offer "${offered.entry.id}" is bound to town "${offered.entry.town}", expected "${args.expectedTown}".`,
    );
  }
  const offerBoundary = offered.entry.storyChoiceBoundary;
  const contactEntry = args.journalEntries[offered.index + 1];
  if (
    !offerBoundary ||
    !contactEntry ||
    !contactEntry.id.startsWith(`talk:${scene.contact}`) ||
    contactEntry.recordedAt !== offered.entry.recordedAt ||
    offerBoundary.townId !== scene.home ||
    offerBoundary.areaId !== scene.area ||
    offerBoundary.minutes !== parseTimeLabel(offered.entry.recordedAt) ||
    predecessorJournalIndex === null ||
    offered.index >= predecessorJournalIndex
  ) {
    throw new Error(
      "Overworld session snapshot ally offer is not bound to June's post-source contact, departure location, time, and journey proof.",
    );
  }
  if (selections.length === 0) {
    for (let index = 0; index < offered.index; index += 1) {
      const entry = args.journalEntries[index]!;
      if (entry.kind === "quest" || entry.kind === "quest_done") {
        throw new Error(
          "Overworld session snapshot pending ally offer cannot survive target-quest progress.",
        );
      }
    }
    if (offered.index !== 0) {
      throw new Error(
        "Overworld session snapshot pending ally offer must remain the latest journal boundary.",
      );
    }
    return Object.freeze({
      ...emptyAllyProof(characterBeforeAlly),
      offered: true,
      offerBoundary: { ...offerBoundary },
      recordedAt: parseTimeLabel(offered.entry.recordedAt),
    });
  }

  const selectedAfterOffer = selected!;
  const option = scene.options.find(
    (candidate) => openingAllyJournalId(scene.id, candidate.id) === selectedAfterOffer.entry.id,
  );
  if (!option || !openingAllyOptionById(scene, option.id)) {
    throw new Error(
      `Overworld session snapshot ally entry references an unknown option in "${selectedAfterOffer.entry.id}".`,
    );
  }
  const application = applyOpeningAllyOption({
    scene,
    character: characterBeforeAlly,
    optionId: option.id,
  });
  if (args.expectedTown !== null && selectedAfterOffer.entry.town !== args.expectedTown) {
    throw new Error(
      `Overworld session snapshot ally entry "${selectedAfterOffer.entry.id}" is bound to town "${selectedAfterOffer.entry.town}", expected "${args.expectedTown}".`,
    );
  }
  const selectionBoundary = selectedAfterOffer.entry.storyChoiceBoundary;
  if (!selectionBoundary || selectedAfterOffer.index + 1 !== offered.index) {
    throw new Error(
      "Overworld session snapshot ally selection must immediately follow its durable offer.",
    );
  }
  for (let index = selectedAfterOffer.index + 1; index < args.journalEntries.length; index += 1) {
    const entry = args.journalEntries[index]!;
    if (entry.kind === "quest" || entry.kind === "quest_done") {
      throw new Error(
        "Overworld session snapshot ally selection must precede every quest boundary.",
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
    parseTimeLabel(selectedAfterOffer.entry.recordedAt) !== expectedMinutes
  ) {
    throw new Error(
      "Overworld session snapshot ally selection does not match its journey decision, location, or paid-time boundary.",
    );
  }
  return Object.freeze({
    characterAfterAlly: cloneCampaignCharacterState(application.characterAfter),
    offered: true,
    offerBoundary: { ...offerBoundary },
    option,
    selectionBoundary: { ...selectionBoundary },
    terms: { ...application.terms },
    journalIndex: selectedAfterOffer.index,
    recordedAt: expectedMinutes,
  });
}
