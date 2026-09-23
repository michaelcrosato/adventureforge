import { hashState } from "../core/hash.js";
import { WOLF_WINTER_DISPATCH_ON_TIME_MAX_MINUTES } from "../core/embedded_launch_overlay_receipt.js";
import type {
  JourneyStoryChoiceDispatchForecast,
  JourneyStoryChoicePrompt,
} from "./journey_contract.js";
import { resolveOpeningDispatchManifestChain } from "./opening_dispatch_briefing.js";
import { replayOpeningDispatchChoices } from "./opening_dispatch_choice_replay.js";
import { proveOpeningAllyJournal } from "./opening_ally_journal.js";
import { openingPreparationTerms } from "./opening_preparation.js";
import { proveOpeningLeadSourceJournal } from "./opening_lead_source_journal.js";
import { proveOpeningPreparationJournal } from "./opening_preparation_journal.js";
import { proveOpeningRegistrationJournal } from "./opening_registration_journal.js";
import { proveOpeningReliefAllocationJournal } from "./opening_relief_allocation_journal.js";
import { proveOpeningReliefOathJournal } from "./opening_relief_oath_journal.js";
import type { OverworldManifest } from "./overworld.js";
import type {
  OverworldJournalDecisionBoundary,
  OverworldJournalEntry,
} from "./session_snapshot.js";

const OPENING_PREPARATION_DISPATCH_FORECAST_SCHEMA_VERSION = 1 as const;
const OPENING_PREPARATION_DISPATCH_FORECAST_STORY_ID = "albany:wolf_preparation" as const;
const OPENING_PREPARATION_DISPATCH_FORECAST_QUEST_ID = "wolf_winter" as const;
const OPENING_PREPARATION_DISPATCH_ON_TIME_MAX_MINUTES = WOLF_WINTER_DISPATCH_ON_TIME_MAX_MINUTES;
export const OPENING_PREPARATION_DISPATCH_FORECAST_LINE_CHAR_LIMIT = 150;

type ForecastBoundary = Readonly<{
  acceptedDecisions: number;
  decisionProofHash: string;
  townId: string;
  areaId: string;
  minutes: number;
}>;

type ForecastCandidate = Readonly<{ id: string; minutes: number }>;

export type OpeningPreparationDispatchForecastInputs = Readonly<{
  world: OverworldManifest;
  journalEntries: readonly OverworldJournalEntry[];
  currentTownId: string;
  currentAreaId: string | null;
  journeyActive: boolean;
  acceptedDecisions: number;
  decisionProofHash: string;
  currentMinutes: number;
  targetQuestStarted: boolean;
  targetQuestCompleted: boolean;
}>;

function freezeBoundary(boundary: OverworldJournalDecisionBoundary): ForecastBoundary {
  return Object.freeze({ ...boundary });
}

function forecastLine(args: {
  minimum: number;
  maximum: number;
  classification: JourneyStoryChoiceDispatchForecast["classification"];
}): string {
  const range =
    args.minimum === args.maximum
      ? `${String(args.minimum)}m`
      : `${String(args.minimum)}–${String(args.maximum)}m`;
  let line: string;
  switch (args.classification) {
    case "on_time_guaranteed":
      line = `If chosen, dispatch totals ${range}. Every remaining wagon and rider option stays on time. Choose them to set the final total.`;
      break;
    case "threshold_crossing":
      line = `If chosen, dispatch totals ${range}. ${String(OPENING_PREPARATION_DISPATCH_ON_TIME_MAX_MINUTES)}m is on time; later wagon or rider choices could cause delay.`;
      break;
    case "delayed_guaranteed":
      line = `If chosen, dispatch totals ${range}. Dispatch will be delayed even if you leave the wagon unassigned and ride alone.`;
      break;
  }
  if (line.length > OPENING_PREPARATION_DISPATCH_FORECAST_LINE_CHAR_LIMIT) {
    throw new Error(
      `Opening preparation dispatch forecast exceeds ${String(
        OPENING_PREPARATION_DISPATCH_FORECAST_LINE_CHAR_LIMIT,
      )} characters.`,
    );
  }
  return line;
}

/**
 * Replays only the current Albany preparation-offer boundary. The range is a
 * read-only comparison of one profile plus the selected or still-optional
 * allocation and June terms; it grants neither a selection nor launch authority.
 */
export function deriveOpeningPreparationDispatchForecasts(
  args: OpeningPreparationDispatchForecastInputs,
): ReadonlyMap<string, JourneyStoryChoiceDispatchForecast> | null {
  const chain = resolveOpeningDispatchManifestChain(args.world);
  if (
    !chain?.ally ||
    chain.quest.id !== OPENING_PREPARATION_DISPATCH_FORECAST_QUEST_ID ||
    chain.preparation.id !== OPENING_PREPARATION_DISPATCH_FORECAST_STORY_ID ||
    !args.journeyActive ||
    args.targetQuestStarted ||
    args.targetQuestCompleted ||
    args.currentTownId !== chain.preparation.home ||
    args.currentAreaId !== chain.preparation.area
  ) {
    return null;
  }

  try {
    const registrationProof = proveOpeningRegistrationJournal({
      registration: chain.registration,
      journalEntries: args.journalEntries,
      expectedTown: null,
    });
    if (
      !registrationProof.profile ||
      !registrationProof.selectionBoundary ||
      registrationProof.journalIndex === null
    ) {
      return null;
    }

    const reliefOathProof = proveOpeningReliefOathJournal({
      scene: chain.reliefOath,
      registrationProof,
      journalEntries: args.journalEntries,
      expectedTown: null,
    });
    if (
      !reliefOathProof.option ||
      !reliefOathProof.terms ||
      !reliefOathProof.selectionBoundary ||
      reliefOathProof.journalIndex === null
    ) {
      return null;
    }

    const leadSourceProof = proveOpeningLeadSourceJournal({
      scene: chain.leadSource,
      registrationProof,
      reliefOathProof,
      journalEntries: args.journalEntries,
      expectedTown: null,
    });
    if (
      !leadSourceProof.option ||
      !leadSourceProof.terms ||
      !leadSourceProof.selectionBoundary ||
      leadSourceProof.journalIndex === null
    ) {
      return null;
    }

    const preparationProof = proveOpeningPreparationJournal({
      scene: chain.preparation,
      leadSourceProof,
      journalEntries: args.journalEntries,
      expectedTown: null,
    });
    if (preparationProof.profile || preparationProof.terms) {
      return null;
    }
    const reliefAllocationProof = proveOpeningReliefAllocationJournal({
      scene: chain.reliefAllocation,
      preparationProof,
      leadSourceProof,
      preparationScene: chain.preparation,
      journalEntries: args.journalEntries,
      expectedTown: null,
    });
    if (reliefAllocationProof.offered && !reliefAllocationProof.option) {
      return null;
    }
    const allyProof = proveOpeningAllyJournal({
      scene: chain.ally,
      preparationProof,
      reliefAllocationProof,
      leadSourceProof,
      preparationScene: chain.preparation,
      reliefAllocationScene: chain.reliefAllocation,
      journalEntries: args.journalEntries,
      expectedTown: null,
    });
    if (allyProof.offered && !allyProof.option) return null;

    const characterBeforePreparation = replayOpeningDispatchChoices({
      characterAfterSource: leadSourceProof.characterAfterSource,
      choices: [
        ...(reliefAllocationProof.option && reliefAllocationProof.journalIndex !== null
          ? [
              {
                kind: "relief_allocation" as const,
                journalIndex: reliefAllocationProof.journalIndex,
                scene: chain.reliefAllocation,
                optionId: reliefAllocationProof.option.id,
              },
            ]
          : []),
        ...(allyProof.option && allyProof.journalIndex !== null
          ? [
              {
                kind: "ally" as const,
                journalIndex: allyProof.journalIndex,
                scene: chain.ally,
                optionId: allyProof.option.id,
              },
            ]
          : []),
      ],
    });
    const virtualOfferBoundary: ForecastBoundary = Object.freeze({
      acceptedDecisions: args.acceptedDecisions,
      decisionProofHash: args.decisionProofHash,
      townId: chain.preparation.home,
      areaId: chain.preparation.area,
      minutes: args.currentMinutes,
    });
    const preparationOfferBoundary = preparationProof.offered
      ? preparationProof.offerBoundary
      : virtualOfferBoundary;
    if (
      !preparationOfferBoundary ||
      preparationProof.selectionBoundary ||
      preparationProof.journalIndex !== null ||
      (preparationProof.offered &&
        preparationProof.recordedAt !== preparationOfferBoundary.minutes) ||
      args.acceptedDecisions !== preparationOfferBoundary.acceptedDecisions ||
      args.decisionProofHash !== preparationOfferBoundary.decisionProofHash ||
      args.currentMinutes !== preparationOfferBoundary.minutes ||
      preparationOfferBoundary.townId !== chain.preparation.home ||
      preparationOfferBoundary.areaId !== chain.preparation.area ||
      (!preparationProof.offered &&
        (args.acceptedDecisions < leadSourceProof.selectionBoundary.acceptedDecisions ||
          args.currentMinutes < leadSourceProof.selectionBoundary.minutes ||
          (args.acceptedDecisions === leadSourceProof.selectionBoundary.acceptedDecisions &&
            args.decisionProofHash !== leadSourceProof.selectionBoundary.decisionProofHash)))
    ) {
      return null;
    }

    const preparationCandidates = Object.freeze(
      chain.preparation.profiles.map((profile) =>
        Object.freeze({
          id: profile.id,
          minutes: openingPreparationTerms(profile, characterBeforePreparation).minutes,
        }),
      ),
    );
    const allocationCandidates = Object.freeze(
      reliefAllocationProof.option && reliefAllocationProof.terms
        ? [
            Object.freeze({
              id: reliefAllocationProof.option.id,
              minutes: reliefAllocationProof.terms.minutes,
            }),
          ]
        : [
            Object.freeze({ id: "unassigned", minutes: 0 }),
            ...chain.reliefAllocation.options.map((option) =>
              Object.freeze({ id: option.id, minutes: option.terms.minutes }),
            ),
          ],
    ) satisfies readonly ForecastCandidate[];
    const juneCandidates = Object.freeze(
      allyProof.option && allyProof.terms
        ? [Object.freeze({ id: allyProof.option.id, minutes: allyProof.terms.minutes })]
        : chain.ally.options.map((option) =>
            Object.freeze({ id: option.id, minutes: option.terms.minutes }),
          ),
    ) satisfies readonly ForecastCandidate[];
    if (
      preparationCandidates.length !== chain.preparation.profiles.length ||
      allocationCandidates.length === 0 ||
      juneCandidates.length === 0 ||
      preparationCandidates.some((candidate) => candidate.minutes < 0) ||
      allocationCandidates.some((candidate) => candidate.minutes < 0) ||
      juneCandidates.some((candidate) => candidate.minutes < 0)
    ) {
      return null;
    }

    const allocationMinimum = Math.min(
      ...allocationCandidates.map((candidate) => candidate.minutes),
    );
    const allocationMaximum = Math.max(
      ...allocationCandidates.map((candidate) => candidate.minutes),
    );
    const juneMinimum = Math.min(...juneCandidates.map((candidate) => candidate.minutes));
    const juneMaximum = Math.max(...juneCandidates.map((candidate) => candidate.minutes));
    const prefixMinutes = reliefOathProof.terms.minutes + leadSourceProof.terms.minutes;
    const receipt = Object.freeze({
      registration: Object.freeze({
        profileId: registrationProof.profile.id,
        journalId: args.journalEntries[registrationProof.journalIndex]!.id,
        boundary: freezeBoundary(registrationProof.selectionBoundary),
      }),
      reliefOath: Object.freeze({
        optionId: reliefOathProof.option.id,
        journalId: args.journalEntries[reliefOathProof.journalIndex]!.id,
        minutes: reliefOathProof.terms.minutes,
        boundary: freezeBoundary(reliefOathProof.selectionBoundary),
      }),
      leadSource: Object.freeze({
        optionId: leadSourceProof.option.id,
        journalId: args.journalEntries[leadSourceProof.journalIndex]!.id,
        minutes: leadSourceProof.terms.minutes,
        boundary: freezeBoundary(leadSourceProof.selectionBoundary),
      }),
      preparationOffer: Object.freeze({
        journalId: preparationProof.offered ? `preparation_offer:${chain.preparation.id}` : null,
        boundary: freezeBoundary(preparationOfferBoundary),
      }),
      preparationCandidates,
      allocationCandidates,
      juneCandidates,
      selectedReliefAllocationId: reliefAllocationProof.option?.id ?? null,
      selectedFieldTeamId: allyProof.option?.id ?? null,
      thresholdMinutes: OPENING_PREPARATION_DISPATCH_ON_TIME_MAX_MINUTES,
    });

    const forecasts = preparationCandidates.map((candidate) => {
      const minimum = prefixMinutes + candidate.minutes + allocationMinimum + juneMinimum;
      const maximum = prefixMinutes + candidate.minutes + allocationMaximum + juneMaximum;
      const classification: JourneyStoryChoiceDispatchForecast["classification"] =
        maximum <= OPENING_PREPARATION_DISPATCH_ON_TIME_MAX_MINUTES
          ? "on_time_guaranteed"
          : minimum <= OPENING_PREPARATION_DISPATCH_ON_TIME_MAX_MINUTES
            ? "threshold_crossing"
            : "delayed_guaranteed";
      const finalMinutes = Object.freeze({ minimum, maximum });
      const proofHash = hashState({
        schemaVersion: OPENING_PREPARATION_DISPATCH_FORECAST_SCHEMA_VERSION,
        storyChoiceId: chain.preparation.id,
        questId: chain.quest.id,
        profileId: candidate.id,
        prefixMinutes,
        finalMinutes,
        classification,
        receipt,
      });
      return [
        candidate.id,
        Object.freeze({
          schemaVersion: OPENING_PREPARATION_DISPATCH_FORECAST_SCHEMA_VERSION,
          finalMinutes,
          classification,
          thresholdMinutes: OPENING_PREPARATION_DISPATCH_ON_TIME_MAX_MINUTES,
          line: forecastLine({ minimum, maximum, classification }),
          proofHash,
        }),
      ] as const;
    });
    return new Map(forecasts);
  } catch {
    return null;
  }
}

/** Add authenticated timing lines without changing any choice terms or actions. */
export function withOpeningPreparationDispatchForecast(args: {
  prompt: JourneyStoryChoicePrompt;
  inputs: OpeningPreparationDispatchForecastInputs;
}): JourneyStoryChoicePrompt {
  if (
    args.prompt.id !== OPENING_PREPARATION_DISPATCH_FORECAST_STORY_ID ||
    args.prompt.kind !== "preparation"
  ) {
    return args.prompt;
  }
  const forecasts = deriveOpeningPreparationDispatchForecasts(args.inputs);
  if (
    !forecasts ||
    forecasts.size !== args.prompt.options.length ||
    args.prompt.options.some((option) => !forecasts.has(option.id))
  ) {
    return args.prompt;
  }
  return Object.freeze({
    ...args.prompt,
    options: Object.freeze(
      args.prompt.options.map((option) =>
        Object.freeze({ ...option, dispatchForecast: forecasts.get(option.id)! }),
      ),
    ),
  }) as JourneyStoryChoicePrompt;
}
