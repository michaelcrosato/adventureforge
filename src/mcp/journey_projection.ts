import { journeyStoryChoiceOptionsForPresentation } from "../world/journey_contract.js";
import type {
  JourneyPresentation,
  JourneyStoryChoiceDispatchImpact,
  JourneyStoryChoiceDispatchForecast,
  JourneyStoryChoiceOption,
  JourneyStoryChoicePrompt,
  JourneyStoryChoicePresentationKind,
  JourneyStoryChoiceSummary,
} from "../world/journey_contract.js";
import {
  INSPECT_OVERWORLD_SESSION_STORY_TOOL,
  OVERWORLD_DEPARTURE_CHOICE_VALUES_FROM,
  type OverworldDepartureInteractionArguments,
} from "../world/session_departure_interactions.js";
import type { RpgCompactMore, RpgCompactObservation } from "./compact_rpg_observation.js";
import { compactTrailingOmissionCounts } from "./compact_truncation.js";
import type { McpObservation } from "./types.js";

const COMPACT_MORE_ACTIONS_INDEX = 4;
const COMPACT_MORE_UNAVAILABLE_INDEX = 10;
const COMPACT_MORE_CHOICES_INDEX = 12;
export const JOURNEY_STORY_CHOICE_COMPARISON_VERSION = 12 as const;
export const JOURNEY_STORY_CHOICE_SITUATIONAL_BOUNDARY_CHAR_LIMIT = 320;
export const JOURNEY_STORY_CHOICE_SITUATIONAL_BOUNDARY_WORD_LIMIT = 50;
export const JOURNEY_STORY_CHOICE_STAGED_CONSEQUENCE =
  "Inspect this option to see its full terms. Inspection does not choose it." as const;
export const JOURNEY_STORY_CHOICE_REVIEW_INSTRUCTION =
  "Choose from these summaries. To see full terms, inspect one option. Inspection does not choose it." as const;

export type JourneyStoryChoiceComparisonOption = Readonly<{
  id: string;
  label: string;
  group?: JourneyStoryChoiceOption["group"];
  /** Human stakes and cost; preparation also carries its governing check as one highlight. */
  summary?: Omit<JourneyStoryChoiceSummary, "checkFit">;
}>;

export type JourneyStoryChoiceDetailOption = Readonly<{
  id: string;
  label: string;
  group?: JourneyStoryChoiceOption["group"];
  checkFit?: string;
  dispatchForecast?: JourneyStoryChoiceDispatchForecast;
  dispatchImpact?: JourneyStoryChoiceDispatchImpact;
  situationalBoundary?: string;
  consequence: string;
}>;

export type JourneyStoryChoiceReviewAffordance = Readonly<{
  tool: typeof INSPECT_OVERWORLD_SESSION_STORY_TOOL;
  storyChoiceId: string;
  arguments: OverworldDepartureInteractionArguments;
  argument: "option_id";
  valuesFrom: typeof OVERWORLD_DEPARTURE_CHOICE_VALUES_FROM;
  readOnly: true;
}>;

/** Optional Station choices can compare one candidate beside the committed plan. */
export function storyChoiceSupportsDepartureRecapTerms(
  prompt: Pick<JourneyStoryChoicePrompt, "kind">,
): boolean {
  return (
    prompt.kind === "preparation" || prompt.kind === "relief_allocation" || prompt.kind === "ally"
  );
}

/** Read-only expansion for deliberately staged story-choice cards. */
export type JourneyStoryChoiceRevealAffordance = Readonly<{
  id: string;
  label: string;
  description: string;
  tool: typeof INSPECT_OVERWORLD_SESSION_STORY_TOOL;
  arguments: Readonly<{ story_choice_id: string; reveal_id: string }>;
  readOnly: true;
}>;

/**
 * Compact story-card surface. Canonical kind-specific tuple cardinalities do
 * not apply here because progressive disclosure may initially project one card.
 */
export type CompactJourneyStoryChoicePrompt = Readonly<{
  id: string;
  message: string;
  kind?: JourneyStoryChoicePresentationKind;
  options: readonly JourneyStoryChoiceOption[];
  /** Canonical disclosure metadata is replaced by the read-only MCP affordance. */
  progressiveDisclosure?: never;
  revealOption?: JourneyStoryChoiceRevealAffordance;
}>;

/** Compact-context journey with an honestly typed projected story surface. */
export type CompactJourneyPresentation = Omit<JourneyPresentation, "storyChoice"> &
  Readonly<{
    storyChoice: CompactJourneyStoryChoicePrompt | null;
  }>;

/**
 * Compact, read-only story inspection. The first response is deliberately only
 * a comparison surface; one exact option can be expanded without exposing the
 * other options' full terms.
 */
type JourneyStoryChoiceProjectionBase = Readonly<{
  comparisonVersion: typeof JOURNEY_STORY_CHOICE_COMPARISON_VERSION;
  id: string;
  kind?: JourneyStoryChoicePresentationKind;
}>;

export type JourneyStoryChoiceSummaryComparison = JourneyStoryChoiceProjectionBase &
  Readonly<{
    message: string;
    options: readonly JourneyStoryChoiceComparisonOption[];
    reviewOption: JourneyStoryChoiceReviewAffordance;
    /** Present only until this prompt's staged cards have been expanded. */
    revealOption?: JourneyStoryChoiceRevealAffordance;
    inspectedOption: null;
  }>;

export type JourneyStoryChoiceDetail = JourneyStoryChoiceProjectionBase &
  Readonly<{
    inspectedOption: JourneyStoryChoiceDetailOption;
  }>;

export type JourneyStoryChoiceComparison =
  | JourneyStoryChoiceSummaryComparison
  | JourneyStoryChoiceDetail;

export type EmbeddedJourneyField<
  Journey extends JourneyPresentation | CompactJourneyPresentation | EmbeddedJourneyFocus =
    JourneyPresentation,
> = {
  journey: Journey;
  overworld_snapshot_hash: string;
};

/**
 * The parent journey facts needed while a child quest owns the active gameplay
 * surface. The full parent context remains available through the echoed
 * overworld session handle; repeating its route, opportunity, proof, and history
 * payload on every child turn only obscures the quest state that is actionable.
 */
export type EmbeddedJourneyFocus = Readonly<{
  status: JourneyPresentation["status"];
  goal: JourneyPresentation["goal"];
  acceptedDecisions: number;
  nextCheckpoint: number | null;
  /** Null while child play is active; otherwise the complete Continue / End choice. */
  pendingChoice: JourneyPresentation["pendingChoice"];
  /** Present only when the complete compact parent story surface blocks child play. */
  storyChoice?: CompactJourneyStoryChoicePrompt;
}>;

export function embeddedJourneyFocus(journey: JourneyPresentation): EmbeddedJourneyFocus {
  return Object.freeze({
    status: journey.status,
    goal: journey.goal,
    acceptedDecisions: journey.acceptedDecisions,
    nextCheckpoint: journey.nextCheckpoint,
    pendingChoice: journey.pendingChoice,
    ...(journey.storyChoice
      ? { storyChoice: compactJourneyStoryChoicePrompt(journey.storyChoice) }
      : {}),
  });
}

function progressiveDisclosureRevealAffordance(
  prompt: JourneyStoryChoicePrompt,
): JourneyStoryChoiceRevealAffordance | undefined {
  const disclosure = prompt.progressiveDisclosure;
  if (!disclosure) return undefined;
  return Object.freeze({
    id: disclosure.reveal.id,
    label: disclosure.reveal.label,
    description: disclosure.reveal.description,
    tool: INSPECT_OVERWORLD_SESSION_STORY_TOOL,
    arguments: Object.freeze({
      story_choice_id: prompt.id,
      reveal_id: disclosure.reveal.id,
    }),
    readOnly: true,
  });
}

function storyChoiceReviewAffordance(
  prompt: JourneyStoryChoicePrompt,
): JourneyStoryChoiceReviewAffordance {
  return Object.freeze({
    tool: INSPECT_OVERWORLD_SESSION_STORY_TOOL,
    storyChoiceId: prompt.id,
    arguments: Object.freeze({ story_choice_id: prompt.id }),
    argument: "option_id",
    valuesFrom: OVERWORLD_DEPARTURE_CHOICE_VALUES_FROM,
    readOnly: true,
  });
}

export function journeyBlocksGameplay(
  journey: JourneyPresentation | CompactJourneyPresentation,
): boolean {
  return (
    journey.pendingChoice !== null || journey.storyChoice !== null || journey.status === "ended"
  );
}

function countExactOccurrences(value: string, exact: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= value.length - exact.length) {
    const match = value.indexOf(exact, offset);
    if (match === -1) break;
    count += 1;
    offset = match + exact.length;
  }
  return count;
}

function compactJourneyStoryChoiceOption(
  option: JourneyStoryChoiceOption,
): JourneyStoryChoiceOption {
  const { summary } = option;
  if (!summary?.fieldTrigger) return option;

  const repeatedLead = `${summary.commitment} ${summary.fieldTrigger} `;
  if (!option.consequence.startsWith(repeatedLead)) return option;

  const withoutRepeatedLead = option.consequence.slice(repeatedLead.length);
  const repeatedCost = `Actual cost: ${summary.immediateCost}.`;
  const repeatedCostCount = countExactOccurrences(withoutRepeatedLead, repeatedCost);
  if (repeatedCostCount === 0) {
    return Object.freeze({ ...option, consequence: withoutRepeatedLead });
  }
  if (repeatedCostCount !== 1) return option;

  const costIndex = withoutRepeatedLead.indexOf(repeatedCost);
  if (costIndex === -1) return option;
  const beforeCost = withoutRepeatedLead.slice(0, costIndex).trimEnd();
  const afterCost = withoutRepeatedLead.slice(costIndex + repeatedCost.length).trimStart();
  const consequence = [beforeCost, afterCost].filter((part) => part.length > 0).join(" ");
  return Object.freeze({ ...option, consequence });
}

function journeyStoryChoiceOptionById(
  prompt: JourneyStoryChoicePrompt,
  optionId: string,
): JourneyStoryChoiceOption {
  const option = prompt.options.find((candidate) => candidate.id === optionId);
  if (!option) {
    throw new Error(`Story choice "${prompt.id}" does not offer option "${optionId}".`);
  }
  return option;
}

function exactStationSituationalBoundary(
  prompt: Pick<JourneyStoryChoicePrompt, "id" | "kind">,
  option: Pick<JourneyStoryChoiceOption, "id">,
): string | undefined {
  const boundary =
    prompt.id === "albany:wolf_preparation" &&
    prompt.kind === "preparation" &&
    option.id === "albany:prep_relief_protocol"
      ? "This bonus may not trigger. In LURE, it applies only if you foul the first feed cast, fail the public wedge, use the split-rail guard to redirect the yearling alive, and return to Cade before the loft cast. A clean cast, braced rail, or different recovery gives no bonus."
      : prompt.id === "albany:wolf_ally_commitment" &&
          prompt.kind === "ally" &&
          option.id === "albany:ally_june_cattle_first"
        ? "June's help may not trigger. She lowers cattle alarm after recovered LURE if the herd presses. She prevents 2 HP after failed-signal DRIVE Overrun or an unstabilized first FORTIFY failure at pressure 3+. No help for clean DRIVE, lower/stabilized FORTIFY, or combat. Her help ends when a wolf dies."
        : undefined;
  if (boundary === undefined) return undefined;
  if (boundary.length > JOURNEY_STORY_CHOICE_SITUATIONAL_BOUNDARY_CHAR_LIMIT) {
    throw new Error("Station situational boundary exceeds its compact character limit.");
  }
  const wordCount = boundary.trim().split(/\s+/u).length;
  if (wordCount > JOURNEY_STORY_CHOICE_SITUATIONAL_BOUNDARY_WORD_LIMIT) {
    throw new Error("Station situational boundary exceeds its compact word limit.");
  }
  return boundary;
}

/** Keep the first tier on human stakes; preparation also names its governing check before purchase. */
function compactJourneyStoryChoiceBriefSummary(
  summary: JourneyStoryChoiceSummary,
  kind: JourneyStoryChoicePrompt["kind"],
): Omit<JourneyStoryChoiceSummary, "checkFit"> {
  const highlights =
    summary.highlights ??
    (kind === "preparation" && summary.checkFit
      ? ([Object.freeze({ label: "Check skill", value: summary.checkFit })] as const)
      : undefined);
  return Object.freeze({
    commitment: summary.commitment,
    ...(summary.fieldTrigger === undefined ? {} : { fieldTrigger: summary.fieldTrigger }),
    ...(summary.fieldTriggerScope === undefined
      ? {}
      : { fieldTriggerScope: summary.fieldTriggerScope }),
    ...(highlights === undefined
      ? {}
      : {
          highlights: Object.freeze(
            highlights.map((highlight) => Object.freeze({ ...highlight })),
          ) as NonNullable<JourneyStoryChoiceSummary["highlights"]>,
        }),
    immediateCost: summary.immediateCost,
    tradeoff: summary.tradeoff,
  });
}

/** Stage active compact consequences behind exact, read-only option inspection. */
export function compactJourneyStoryChoicePrompt(
  prompt: JourneyStoryChoicePrompt,
): CompactJourneyStoryChoicePrompt {
  const usesPromptLevelReview =
    prompt.kind !== undefined && prompt.options.every((option) => option.summary !== undefined);
  const options = journeyStoryChoiceOptionsForPresentation(prompt).map((option) => {
    const projected = {
      id: option.id,
      label: option.label,
      ...(option.group === undefined ? {} : { group: option.group }),
      ...(option.summary
        ? { summary: compactJourneyStoryChoiceBriefSummary(option.summary, prompt.kind) }
        : {}),
      ...(usesPromptLevelReview
        ? { consequence: "" }
        : { consequence: JOURNEY_STORY_CHOICE_STAGED_CONSEQUENCE }),
    };
    return Object.freeze(projected);
  });
  const {
    progressiveDisclosure: _progressiveDisclosure,
    options: _canonicalOptions,
    ...withoutProgressiveDisclosure
  } = prompt;
  const revealOption = progressiveDisclosureRevealAffordance(prompt);
  return Object.freeze({
    ...withoutProgressiveDisclosure,
    message: usesPromptLevelReview
      ? `${prompt.message} ${JOURNEY_STORY_CHOICE_REVIEW_INSTRUCTION}`
      : prompt.message,
    ...(revealOption ? { revealOption } : {}),
    options: Object.freeze(options),
  }) as CompactJourneyStoryChoicePrompt;
}

/** Build the staged compact inspection without changing the canonical prompt. */
export function compactJourneyStoryChoiceComparison(
  prompt: JourneyStoryChoicePrompt,
): JourneyStoryChoiceSummaryComparison;
export function compactJourneyStoryChoiceComparison(
  prompt: JourneyStoryChoicePrompt,
  optionId: string,
): JourneyStoryChoiceDetail;
export function compactJourneyStoryChoiceComparison(
  prompt: JourneyStoryChoicePrompt,
  optionId: undefined,
  revealId: string,
): JourneyStoryChoiceSummaryComparison;
export function compactJourneyStoryChoiceComparison(
  prompt: JourneyStoryChoicePrompt,
  optionId: undefined,
  revealId?: string,
): JourneyStoryChoiceSummaryComparison;
/** Runtime validation rejects this mutually exclusive argument combination. */
export function compactJourneyStoryChoiceComparison(
  prompt: JourneyStoryChoicePrompt,
  optionId: string,
  revealId: string,
): JourneyStoryChoiceComparison;
export function compactJourneyStoryChoiceComparison(
  prompt: JourneyStoryChoicePrompt,
  optionId?: string,
  revealId?: string,
): JourneyStoryChoiceComparison {
  if (optionId !== undefined && revealId !== undefined) {
    throw new Error("Story choice inspection accepts option_id or reveal_id, not both.");
  }
  const base = Object.freeze({
    comparisonVersion: JOURNEY_STORY_CHOICE_COMPARISON_VERSION,
    id: prompt.id,
    ...(prompt.kind === undefined ? {} : { kind: prompt.kind }),
  });
  if (optionId !== undefined) {
    const inspectedSource = compactJourneyStoryChoiceOption(
      journeyStoryChoiceOptionById(prompt, optionId),
    );
    const situationalBoundary = exactStationSituationalBoundary(prompt, inspectedSource);
    return Object.freeze({
      ...base,
      inspectedOption: Object.freeze({
        id: inspectedSource.id,
        label: inspectedSource.label,
        ...(inspectedSource.group === undefined ? {} : { group: inspectedSource.group }),
        ...(inspectedSource.summary?.checkFit === undefined
          ? {}
          : { checkFit: inspectedSource.summary.checkFit }),
        ...(inspectedSource.dispatchForecast
          ? {
              dispatchForecast: Object.freeze({
                ...inspectedSource.dispatchForecast,
                finalMinutes: Object.freeze({
                  ...inspectedSource.dispatchForecast.finalMinutes,
                }),
              }),
            }
          : {}),
        ...(inspectedSource.dispatchImpact
          ? { dispatchImpact: Object.freeze({ ...inspectedSource.dispatchImpact }) }
          : {}),
        ...(situationalBoundary === undefined ? {} : { situationalBoundary }),
        consequence: inspectedSource.consequence,
      }),
    });
  }
  const options = journeyStoryChoiceOptionsForPresentation(prompt, revealId).map((option) =>
    Object.freeze({
      id: option.id,
      label: option.label,
      ...(option.group === undefined ? {} : { group: option.group }),
      ...(option.summary
        ? { summary: compactJourneyStoryChoiceBriefSummary(option.summary, prompt.kind) }
        : {}),
    }),
  );
  const revealOption =
    revealId === undefined ? progressiveDisclosureRevealAffordance(prompt) : undefined;
  return Object.freeze({
    ...base,
    message: prompt.message,
    ...(revealOption ? { revealOption } : {}),
    options: Object.freeze(options),
    reviewOption: storyChoiceReviewAffordance(prompt),
    inspectedOption: null,
  });
}

/** Compact MCP projection; the canonical journey and all non-story fields remain shared. */
export function compactJourneyPresentation(
  journey: JourneyPresentation,
): CompactJourneyPresentation {
  if (!journey.storyChoice) return journey as CompactJourneyPresentation;
  const storyChoice = compactJourneyStoryChoicePrompt(journey.storyChoice);
  if ((storyChoice as object) === journey.storyChoice) {
    return journey as CompactJourneyPresentation;
  }
  return Object.freeze({ ...journey, storyChoice });
}

function suppressCompactGameplayOmissions(
  more: RpgCompactMore | undefined,
): RpgCompactMore | undefined {
  if (!more) return undefined;
  const counts = more.map((count) => count ?? 0);
  if (counts.length > COMPACT_MORE_ACTIONS_INDEX) counts[COMPACT_MORE_ACTIONS_INDEX] = 0;
  if (counts.length > COMPACT_MORE_UNAVAILABLE_INDEX) {
    counts[COMPACT_MORE_UNAVAILABLE_INDEX] = 0;
  }
  if (counts.length > COMPACT_MORE_CHOICES_INDEX) counts[COMPACT_MORE_CHOICES_INDEX] = 0;
  return compactTrailingOmissionCounts(counts) as RpgCompactMore | undefined;
}

/** Hide RPG decisions while the parent journey choice is the only legal move. */
export function suppressRpgGameplayActions<
  Payload extends {
    context?: RpgCompactObservation;
    observation?: McpObservation;
  },
>(payload: Payload): Payload {
  const context = payload.context
    ? (() => {
        const {
          actions: _actions,
          unavailable: _unavailable,
          choices: _choices,
          more,
          ...withoutActions
        } = payload.context;
        const visibleMore = suppressCompactGameplayOmissions(more);
        return {
          ...withoutActions,
          ...(visibleMore ? { more: visibleMore } : {}),
        } as RpgCompactObservation;
      })()
    : undefined;
  const observation = payload.observation
    ? { ...payload.observation, available_actions: [], blocked_actions: [] }
    : undefined;
  return {
    ...payload,
    ...(context ? { context } : {}),
    ...(observation ? { observation } : {}),
  };
}
