import { z } from "zod";

import { hashState } from "../core/hash.js";

export const JOURNEY_CONTRACT_VERSION = 3 as const;
export const JOURNEY_BASELINE_DECISIONS = 40 as const;
export const JOURNEY_EXIT_REASON = "player_ended_at_choice" as const;

export const INITIAL_JOURNEY_GOAL = Object.freeze({
  version: 1,
  id: "albany_local_lead",
  text: "Complete Wolf-Winter in Albany.",
} as const);

export const OPENING_CHAPTER_HORIZON =
  "Wolf-Winter ends the opening chapter. Choose End to stop there, or Continue to carry its results into the optional Gallowmere chapter." as const;

export const INITIAL_JOURNEY_GOAL_GUIDANCE =
  `Finish The Wolf-Winter to complete this opening. ${OPENING_CHAPTER_HORIZON}` as const;

export type JourneyChoice = "continue" | "end";
export type JourneyChoiceReason = "checkpoint" | "goal_completed" | "character_died";
export type JourneyStatus = "active" | "awaiting_choice" | "ended";
export type JourneyGoalStatus = "active" | "completed";
export type JourneyDecisionSurface = "overworld" | "quest";

export type JourneyCountedDecisionReason =
  | "movement"
  | "stateful_clue"
  | "substantive_dialogue"
  | "combat"
  | "skill_check"
  | "preparation"
  | "situation_changed";

export type JourneyExcludedDecisionReason =
  | "context_only"
  | "repeated_context"
  | "dialogue_opening"
  | "dialogue_navigation"
  | "dialogue_closure"
  | "unchanged_service"
  | "technical_quest_foldback"
  | "rejected";

export type JourneyDecisionClassification = Readonly<
  | { countsTowardJourney: true; reason: JourneyCountedDecisionReason }
  | { countsTowardJourney: false; reason: JourneyExcludedDecisionReason }
>;

type JourneyAcceptedDecision = Readonly<{
  surface: JourneyDecisionSurface;
  actionId: string;
  reason: JourneyCountedDecisionReason;
}>;

export type JourneyDecisionProofLast = Readonly<{
  number: number;
  surface: JourneyDecisionSurface;
  actionId: string;
  reason: JourneyCountedDecisionReason;
}>;

export type JourneyDecisionProof = Readonly<{
  hash: string;
  last: JourneyDecisionProofLast | null;
}>;

type JourneyGoalIdentity = Readonly<{
  version: number;
  id: string;
}>;

export type JourneyGoalDefinition = Readonly<{
  version: number;
  id: string;
  text: string;
}>;

export type JourneyGoalSnapshot = {
  version: number;
  id: string;
  text: string;
  status: JourneyGoalStatus;
  completedAtDecision: number | null;
};

export type JourneyCompletedGoalSnapshot = {
  version: number;
  id: string;
  text: string;
  status: "completed";
  completedAtDecision: number;
};

export type JourneyPendingChoiceSnapshot = {
  atDecision: number;
  reasons: JourneyChoiceReason[];
  checkpoint: number | null;
  goalVersion: number | null;
  goalId: string | null;
};

export type JourneyRetentionEvent = Readonly<{
  sequence: number;
  atDecision: number;
  reasons: readonly JourneyChoiceReason[];
  checkpoint: number | null;
  goalVersion: number | null;
  goalId: string | null;
  choice: JourneyChoice;
  decisionProofHash: string;
}>;

type JourneyRetentionEventSnapshot = {
  sequence: number;
  atDecision: number;
  reasons: JourneyChoiceReason[];
  checkpoint: number | null;
  goalVersion: number | null;
  goalId: string | null;
  choice: JourneyChoice;
  decisionProofHash: string;
};

export type JourneyContractSnapshot = {
  version: typeof JOURNEY_CONTRACT_VERSION;
  status: JourneyStatus;
  goal: JourneyGoalSnapshot;
  goalHistory: JourneyCompletedGoalSnapshot[];
  acceptedDecisions: number;
  nextCheckpoint: number | null;
  decisionProof: {
    hash: string;
    last: JourneyDecisionProofLast | null;
  };
  pendingChoice: JourneyPendingChoiceSnapshot | null;
  retentionHistory: JourneyRetentionEventSnapshot[];
};

export type JourneyGoalPresentation = Readonly<JourneyGoalSnapshot>;
export type JourneyCompletedGoalPresentation = Readonly<JourneyCompletedGoalSnapshot>;

export type JourneyChoiceOption = Readonly<{
  id: JourneyChoice;
  label: string;
  consequence: string;
}>;

/**
 * Read-only authored terms for the next mandatory story decision. A retention
 * pause may show these terms, but it never makes the contained options legal.
 */
type JourneyContinuationPreview = Readonly<{
  id: string;
  message: string;
  options: readonly [JourneyStoryChoiceOption, JourneyStoryChoiceOption];
}>;

export type JourneyChoicePrompt = Readonly<{
  id: string;
  atDecision: number;
  reasons: readonly JourneyChoiceReason[];
  checkpoint: number | null;
  goalVersion: number | null;
  goalId: string | null;
  message: string;
  options: readonly [JourneyChoiceOption, ...JourneyChoiceOption[]];
  continuationPreview?: JourneyContinuationPreview;
}>;

/**
 * A short, scannable account of a choice before its complete authored terms.
 * Optional so historic two-option aftermath cards and persisted saves remain
 * compatible with the original journey presentation.
 */
export type JourneyStoryChoiceHighlight = Readonly<{
  label: string;
  value: string;
}>;

export type JourneyStoryChoiceSummary = Readonly<{
  commitment: string;
  /**
   * Legacy or unfamiliar content may still compare an exact/broad field term.
   * Shipped roleplay-first receipts omit it until the field actually consumes it.
   */
  fieldTrigger?: string;
  /** Present when fieldTrigger is a broad category or a starter-package comparison. */
  fieldTriggerScope?: "category" | "starter";
  /** Character-relative skill modifier and DC for a preparation's eventual field check. */
  checkFit?: string;
  /** Authored facts that must remain visible before committing to this option. */
  highlights?: readonly [JourneyStoryChoiceHighlight, ...JourneyStoryChoiceHighlight[]];
  immediateCost: string;
  tradeoff: string;
}>;

/** Read-only timing comparison attached only to an authenticated preparation offer. */
export type JourneyStoryChoiceDispatchForecast = Readonly<{
  schemaVersion: 1;
  finalMinutes: Readonly<{ minimum: number; maximum: number }>;
  classification: "on_time_guaranteed" | "threshold_crossing" | "delayed_guaranteed";
  thresholdMinutes: number;
  line: string;
  proofHash: string;
}>;

/** Exact, read-only timing for one currently selectable Station option. */
export type JourneyStoryChoiceDispatchImpact = Readonly<{
  schemaVersion: 1;
  resultingMinutes: number;
  timing: "on_time" | "delayed";
  addedMinutes: number;
  line: string;
  proofHash: string;
}>;

/** Optional presentation-only section for the opening registration cards. */
export type JourneyStoryChoiceOptionGroup = "doctrine" | "custom_role";

export type JourneyStoryChoiceOption = Readonly<{
  id: string;
  label: string;
  /** Present only when a registration prompt separates doctrine and custom-role starts. */
  group?: JourneyStoryChoiceOptionGroup;
  summary?: JourneyStoryChoiceSummary;
  /** Present only on the current authenticated Albany preparation comparison. */
  dispatchForecast?: JourneyStoryChoiceDispatchForecast;
  /** Present only on a current authenticated Station relief or field-team card. */
  dispatchImpact?: JourneyStoryChoiceDispatchImpact;
  consequence: string;
}>;

/**
 * A presentation-only split for an otherwise canonical story-choice set.
 * Every option remains legal to choose; this only stages which cards are
 * initially compared and the read-only affordance that reveals the remainder.
 */
export type JourneyStoryChoiceProgressiveDisclosure = Readonly<{
  /** Empty for a reveal-first briefing that offers no commitment before comparison. */
  initialOptionIds: readonly string[];
  reveal: Readonly<{
    id: string;
    label: string;
    description: string;
    optionIds: readonly [string, ...string[]];
  }>;
}>;

export type JourneyStoryChoicePresentationKind =
  | "ally"
  | "lead_source"
  | "preparation"
  | "relief_allocation"
  | "relief_oath"
  | "registration";

export type JourneyStoryChoiceOptions = readonly [
  JourneyStoryChoiceOption,
  JourneyStoryChoiceOption,
];

export type JourneyRegistrationStoryChoiceOptions = readonly [
  JourneyStoryChoiceOption,
  JourneyStoryChoiceOption,
  JourneyStoryChoiceOption,
  JourneyStoryChoiceOption,
  ...JourneyStoryChoiceOption[],
];

export type JourneyLeadSourceStoryChoiceOptions = readonly [
  JourneyStoryChoiceOption,
  JourneyStoryChoiceOption,
  JourneyStoryChoiceOption,
  ...JourneyStoryChoiceOption[],
];

export type JourneyPreparationStoryChoiceOptions = readonly [
  JourneyStoryChoiceOption,
  JourneyStoryChoiceOption,
  JourneyStoryChoiceOption,
  ...JourneyStoryChoiceOption[],
];

export type JourneyAllyStoryChoiceOptions = readonly [
  JourneyStoryChoiceOption,
  JourneyStoryChoiceOption,
  JourneyStoryChoiceOption,
  ...JourneyStoryChoiceOption[],
];

export type JourneyReliefAllocationStoryChoiceOptions = readonly [
  JourneyStoryChoiceOption,
  JourneyStoryChoiceOption,
  JourneyStoryChoiceOption,
  ...JourneyStoryChoiceOption[],
];

export type JourneyReliefOathStoryChoiceOptions = readonly [
  JourneyStoryChoiceOption,
  JourneyStoryChoiceOption,
  JourneyStoryChoiceOption,
  ...JourneyStoryChoiceOption[],
];

type JourneyStoryChoicePromptBase = Readonly<{
  id: string;
  message: string;
  progressiveDisclosure?: JourneyStoryChoiceProgressiveDisclosure;
}>;

export type JourneyStoryChoicePrompt = JourneyStoryChoicePromptBase &
  Readonly<
    | {
        /** Omitted for the existing two-option post-goal aftermath presentation. */
        kind?: undefined;
        options: JourneyStoryChoiceOptions;
      }
    | {
        kind: "registration";
        options: JourneyRegistrationStoryChoiceOptions;
      }
    | {
        kind: "lead_source";
        options: JourneyLeadSourceStoryChoiceOptions;
      }
    | {
        kind: "preparation";
        options: JourneyPreparationStoryChoiceOptions;
      }
    | {
        kind: "ally";
        options: JourneyAllyStoryChoiceOptions;
      }
    | {
        kind: "relief_allocation";
        options: JourneyReliefAllocationStoryChoiceOptions;
      }
    | {
        kind: "relief_oath";
        options: JourneyReliefOathStoryChoiceOptions;
      }
  >;

/**
 * Return only the cards appropriate for this read-only presentation state.
 * The canonical prompt always retains every executable option.
 */
export function journeyStoryChoiceOptionsForPresentation(
  prompt: JourneyStoryChoicePrompt,
  revealId?: string,
): readonly JourneyStoryChoiceOption[] {
  const disclosure = prompt.progressiveDisclosure;
  if (!disclosure) {
    if (revealId !== undefined) {
      throw new Error(
        `Journey story choice "${prompt.id}" has no progressive disclosure "${revealId}".`,
      );
    }
    return prompt.options;
  }
  const orderedOptions = (optionIds: readonly string[]): readonly JourneyStoryChoiceOption[] =>
    optionIds.map((optionId) => {
      const option = prompt.options.find((candidate) => candidate.id === optionId);
      if (!option) {
        throw new Error(
          `Journey progressive disclosure references unknown story choice option "${optionId}".`,
        );
      }
      return option;
    });
  if (revealId === undefined) return orderedOptions(disclosure.initialOptionIds);
  if (revealId !== disclosure.reveal.id) {
    throw new Error(
      `Journey story choice "${prompt.id}" has no progressive disclosure "${revealId}".`,
    );
  }
  return orderedOptions([...disclosure.initialOptionIds, ...disclosure.reveal.optionIds]);
}

export type JourneyGoalCompletionPresentationContext = Readonly<{
  goalVersion: number;
  goalId: string;
  messagePrefix?: string;
  messageSuffix?: string;
  /** Names the immediate authored decision after Continue; generic checkpoints keep the default. */
  continueLabel?: string;
  continueConsequencePrefix?: string;
  continueConsequenceSuffix?: string;
  /** Read-only next-decision terms; legal options remain Continue and End. */
  continuationPreview?: JourneyContinuationPreview;
}>;

/**
 * A player-facing, game-owned passage toward the current authored objective.
 * It deliberately carries no town ids, road ids, intermediate path, or event
 * details: those become visible only as the player actually travels them.
 */
export type JourneyGoalPassagePresentation = Readonly<{
  id: "follow_current_goal";
  label: string;
  destination: string;
  roadCount: number;
  baseMinutes: number;
  estimatedMinutes: number;
  suppliesNeeded: number;
  supplyDeficit: number;
  suppliesAfter: number;
  fatigueAfter: number;
  travelConditionAfter: string;
  consequence: string;
  stopRule: string;
}>;

export const JOURNEY_OPPORTUNITY_GUIDANCE =
  "Optional local work: if you are in its area, finish any setup and start it. If its area is mapped, travel there first. If the route is unknown, explore the town to reveal it. You may also leave the work for later." as const;

export type JourneyOpportunityAccess = "here" | "mapped" | "route_unmapped";
export type JourneyOpportunityKind = "event" | "job";

export type JourneyOpportunityLeadPresentation = Readonly<{
  id: string;
  kind: JourneyOpportunityKind;
  title: string;
  area: string;
  access: JourneyOpportunityAccess;
}>;

export type JourneyOpportunityPresentation = Readonly<{
  guidance: string;
  leads: readonly JourneyOpportunityLeadPresentation[];
  deferredLeadCount?: number;
}>;

export type JourneyPresentationContext = Readonly<{
  goalCompletion?: JourneyGoalCompletionPresentationContext;
  goalGuidance?: string | null;
  goalPassage?: JourneyGoalPassagePresentation | null;
  opportunities?: JourneyOpportunityPresentation | null;
  storyChoice?: JourneyStoryChoicePrompt | null;
}>;

export type JourneyPresentation = Readonly<{
  contractVersion: typeof JOURNEY_CONTRACT_VERSION;
  status: JourneyStatus;
  goal: JourneyGoalPresentation;
  completedGoals: readonly JourneyCompletedGoalPresentation[];
  acceptedDecisions: number;
  baselineDecisions: typeof JOURNEY_BASELINE_DECISIONS;
  nextCheckpoint: number | null;
  decisionProof: JourneyDecisionProof;
  goalGuidance: string | null;
  goalPassage: JourneyGoalPassagePresentation | null;
  opportunities: JourneyOpportunityPresentation | null;
  pendingChoice: JourneyChoicePrompt | null;
  storyChoice: JourneyStoryChoicePrompt | null;
  retentionHistory: readonly JourneyRetentionEvent[];
}>;

export type JourneyExitReceipt = Readonly<{
  contractVersion: typeof JOURNEY_CONTRACT_VERSION;
  exitReason: typeof JOURNEY_EXIT_REASON;
  goalVersion: number;
  goalId: string;
  goalText: string;
  goalStatus: JourneyGoalStatus;
  goalCompletedAtDecision: number | null;
  completedGoals: readonly JourneyCompletedGoalPresentation[];
  acceptedDecisions: number;
  exitReasons: readonly JourneyChoiceReason[];
  checkpoint: number | null;
  decisionProofHash: string;
  retentionHistory: readonly JourneyRetentionEvent[];
  receiptHash: string;
}>;

export type JourneyChoiceResult = Readonly<{
  journey: JourneyPresentation;
  retentionEvent: JourneyRetentionEvent;
  exitReceipt: JourneyExitReceipt | null;
}>;

function initialDecisionProofHash(goal: JourneyGoalDefinition): string {
  return hashState({
    contractVersion: JOURNEY_CONTRACT_VERSION,
    goalVersion: goal.version,
    goalId: goal.id,
    goalText: goal.text,
    baselineDecisions: JOURNEY_BASELINE_DECISIONS,
    acceptedDecisions: 0,
  });
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_NONNEGATIVE_INT = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const POSITIVE_SAFE_INT = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const JourneyChoiceSchema = z.enum(["continue", "end"]);
const JourneyChoiceReasonSchema = z.enum(["checkpoint", "goal_completed", "character_died"]);
const JourneyGoalStatusSchema = z.enum(["active", "completed"]);
const JourneyCountedDecisionReasonSchema = z.enum([
  "movement",
  "stateful_clue",
  "substantive_dialogue",
  "combat",
  "skill_check",
  "preparation",
  "situation_changed",
]);

const JourneyGoalDefinitionSchema = z
  .object({
    version: POSITIVE_SAFE_INT,
    id: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();

const JourneyGoalSnapshotSchema = JourneyGoalDefinitionSchema.extend({
  status: JourneyGoalStatusSchema,
  completedAtDecision: SAFE_NONNEGATIVE_INT.nullable(),
}).strict();

const JourneyCompletedGoalSnapshotSchema = JourneyGoalDefinitionSchema.extend({
  status: z.literal("completed"),
  completedAtDecision: SAFE_NONNEGATIVE_INT,
}).strict();

export const JourneyDecisionProofLastSchema = z
  .object({
    number: POSITIVE_SAFE_INT,
    surface: z.enum(["overworld", "quest"]),
    actionId: z.string().min(1),
    reason: JourneyCountedDecisionReasonSchema,
  })
  .strict();

const JourneyGoalBindingSchema = {
  goalVersion: POSITIVE_SAFE_INT.nullable(),
  goalId: z.string().min(1).nullable(),
} as const;

const JourneyPendingChoiceSchema = z
  .object({
    atDecision: SAFE_NONNEGATIVE_INT,
    reasons: z.array(JourneyChoiceReasonSchema).min(1).max(2),
    checkpoint: POSITIVE_SAFE_INT.nullable(),
    ...JourneyGoalBindingSchema,
  })
  .strict();

const JourneyRetentionEventSchema = z
  .object({
    sequence: POSITIVE_SAFE_INT,
    atDecision: SAFE_NONNEGATIVE_INT,
    reasons: z.array(JourneyChoiceReasonSchema).min(1).max(2),
    checkpoint: POSITIVE_SAFE_INT.nullable(),
    ...JourneyGoalBindingSchema,
    choice: JourneyChoiceSchema,
    decisionProofHash: z.string().regex(HASH_PATTERN),
  })
  .strict();

function reasonsAreCanonical(reasons: readonly JourneyChoiceReason[]): boolean {
  if (reasons.length === 1) return true;
  return (
    reasons.length === 2 &&
    reasons[0] === "checkpoint" &&
    (reasons[1] === "goal_completed" || reasons[1] === "character_died")
  );
}

function hasReason(
  value: { reasons: readonly JourneyChoiceReason[] },
  reason: JourneyChoiceReason,
): boolean {
  return value.reasons.includes(reason);
}

function fixedCheckpointAfter(atDecision: number): number | null {
  const remainder = atDecision % JOURNEY_BASELINE_DECISIONS;
  const delta =
    remainder === 0 ? JOURNEY_BASELINE_DECISIONS : JOURNEY_BASELINE_DECISIONS - remainder;
  return atDecision > Number.MAX_SAFE_INTEGER - delta ? null : atDecision + delta;
}

function nextFixedCheckpointAfter(atDecision: number): number {
  const checkpoint = fixedCheckpointAfter(atDecision);
  if (checkpoint === null) {
    throw new Error("The next journey checkpoint exceeds JavaScript's safe integer range.");
  }
  return checkpoint;
}

function sameCompletedGoal(
  left: JourneyGoalSnapshot,
  right: JourneyCompletedGoalSnapshot,
): boolean {
  return (
    left.version === right.version &&
    left.id === right.id &&
    left.text === right.text &&
    left.status === right.status &&
    left.completedAtDecision === right.completedAtDecision
  );
}

function addIssue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

type CompletionBinding = {
  choice: JourneyChoice | null;
  path: (string | number)[];
};

export const JourneyContractSnapshotSchema = z
  .object({
    version: z.literal(JOURNEY_CONTRACT_VERSION),
    status: z.enum(["active", "awaiting_choice", "ended"]),
    goal: JourneyGoalSnapshotSchema,
    goalHistory: z.array(JourneyCompletedGoalSnapshotSchema),
    acceptedDecisions: SAFE_NONNEGATIVE_INT,
    nextCheckpoint: POSITIVE_SAFE_INT.nullable(),
    decisionProof: z
      .object({
        hash: z.string().regex(HASH_PATTERN),
        last: JourneyDecisionProofLastSchema.nullable(),
      })
      .strict(),
    pendingChoice: JourneyPendingChoiceSchema.nullable(),
    retentionHistory: z.array(JourneyRetentionEventSchema),
  })
  .strict()
  .superRefine((state, ctx) => {
    const { acceptedDecisions, decisionProof, goal, goalHistory, pendingChoice, retentionHistory } =
      state;

    if (acceptedDecisions === 0) {
      if (decisionProof.last !== null) {
        addIssue(ctx, ["decisionProof", "last"], "Zero decisions cannot have a last decision.");
      }
      const initialGoal = goalHistory[0] ?? goal;
      if (decisionProof.hash !== initialDecisionProofHash(initialGoal)) {
        addIssue(
          ctx,
          ["decisionProof", "hash"],
          "Initial journey decision proof hash does not match the contract.",
        );
      }
    } else if (decisionProof.last?.number !== acceptedDecisions) {
      addIssue(
        ctx,
        ["decisionProof", "last"],
        "Last decision number must equal acceptedDecisions.",
      );
    }

    let previousGoalCompletion = -1;
    goalHistory.forEach((completed, index) => {
      const expectedVersion = index + 1;
      if (completed.version !== expectedVersion) {
        addIssue(
          ctx,
          ["goalHistory", index, "version"],
          `Completed goal versions must form the sequence 1..N; expected ${expectedVersion}.`,
        );
      }
      if (completed.completedAtDecision > acceptedDecisions) {
        addIssue(
          ctx,
          ["goalHistory", index, "completedAtDecision"],
          "A completed goal cannot follow the accepted decision count.",
        );
      }
      if (completed.completedAtDecision < previousGoalCompletion) {
        addIssue(
          ctx,
          ["goalHistory", index, "completedAtDecision"],
          "Completed goal decisions must be nondecreasing.",
        );
      }
      previousGoalCompletion = completed.completedAtDecision;
    });

    if (goal.status === "active") {
      if (goal.completedAtDecision !== null) {
        addIssue(ctx, ["goal", "completedAtDecision"], "An active goal cannot be completed.");
      }
      const expectedVersion = goalHistory.length + 1;
      if (goal.version !== expectedVersion) {
        addIssue(
          ctx,
          ["goal", "version"],
          `The active goal must be version ${expectedVersion}, immediately after completed history.`,
        );
      }
    } else {
      const latest = goalHistory.at(-1);
      if (!latest || !sameCompletedGoal(goal, latest)) {
        addIssue(
          ctx,
          ["goal"],
          "The completed current goal must exactly equal the latest completed goal history entry.",
        );
      }
      if (goal.completedAtDecision === null || goal.completedAtDecision > acceptedDecisions) {
        addIssue(
          ctx,
          ["goal", "completedAtDecision"],
          "Completed goal decision must exist and cannot exceed acceptedDecisions.",
        );
      }
    }

    const completionBindings = new Map<number, CompletionBinding[]>();
    const validateGoalBinding = (
      value: {
        atDecision: number;
        reasons: readonly JourneyChoiceReason[];
        goalVersion: number | null;
        goalId: string | null;
      },
      path: (string | number)[],
      choice: JourneyChoice | null,
    ): void => {
      const completesGoal = hasReason(value, "goal_completed");
      if (!completesGoal) {
        if (value.goalVersion !== null || value.goalId !== null) {
          addIssue(
            ctx,
            path,
            "Retention evidence without goal completion must use null goalVersion and goalId.",
          );
        }
        return;
      }
      if (value.goalVersion === null || value.goalId === null) {
        addIssue(ctx, path, "Goal-completion retention evidence must bind goalVersion and goalId.");
        return;
      }
      const completed = goalHistory[value.goalVersion - 1];
      if (!completed || completed.version !== value.goalVersion || completed.id !== value.goalId) {
        addIssue(ctx, path, "Goal-completion retention evidence references no completed goal.");
        return;
      }
      if (value.atDecision !== completed.completedAtDecision) {
        addIssue(
          ctx,
          [...path, "atDecision"],
          "Goal-completion retention evidence must match its goal completion decision.",
        );
      }
      const bindings = completionBindings.get(completed.version) ?? [];
      bindings.push({ choice, path });
      completionBindings.set(completed.version, bindings);
    };

    let expectedCheckpoint: number = JOURNEY_BASELINE_DECISIONS;
    let sawEnd = false;
    let previousRetentionDecision = -1;
    retentionHistory.forEach((event, index) => {
      const path: (string | number)[] = ["retentionHistory", index];
      if (event.sequence !== index + 1) {
        addIssue(ctx, [...path, "sequence"], "Retention sequence is not contiguous.");
      }
      if (event.atDecision < previousRetentionDecision || event.atDecision > acceptedDecisions) {
        addIssue(
          ctx,
          [...path, "atDecision"],
          "Retention event decisions must be ordered and cannot exceed acceptedDecisions.",
        );
      }
      previousRetentionDecision = event.atDecision;
      if (
        event.atDecision === acceptedDecisions &&
        event.decisionProofHash !== decisionProof.hash
      ) {
        addIssue(
          ctx,
          [...path, "decisionProofHash"],
          "Retention evidence at the current decision must match the journey decision proof.",
        );
      }
      if (!reasonsAreCanonical(event.reasons)) {
        addIssue(
          ctx,
          [...path, "reasons"],
          "Retention reasons must be unique and in canonical order.",
        );
      }
      if (hasReason(event, "character_died") && event.choice !== "end") {
        addIssue(ctx, [...path, "choice"], "Character death can only end the journey.");
      }
      const checkpointReason = hasReason(event, "checkpoint");
      if (
        !checkpointReason &&
        event.atDecision >= expectedCheckpoint &&
        (hasReason(event, "goal_completed") || hasReason(event, "character_died"))
      ) {
        addIssue(
          ctx,
          [...path, "reasons"],
          `A mandatory choice at or after fixed checkpoint ${expectedCheckpoint} must merge that checkpoint.`,
        );
      }
      if (checkpointReason) {
        if (event.checkpoint !== expectedCheckpoint || event.atDecision < expectedCheckpoint) {
          addIssue(
            ctx,
            [...path, "checkpoint"],
            `Expected fixed journey checkpoint ${expectedCheckpoint} at or after that decision.`,
          );
        }
        if (event.choice === "continue") {
          const nextCheckpoint = fixedCheckpointAfter(event.atDecision);
          if (nextCheckpoint === null) {
            addIssue(
              ctx,
              [...path, "atDecision"],
              "A continued retention event requires another safe fixed checkpoint.",
            );
          } else {
            expectedCheckpoint = nextCheckpoint;
          }
        }
      } else if (event.checkpoint !== null) {
        addIssue(
          ctx,
          [...path, "checkpoint"],
          "Only checkpoint prompts may carry a checkpoint number.",
        );
      }
      validateGoalBinding(event, path, event.choice);
      if (event.choice === "end") {
        sawEnd = true;
        if (index !== retentionHistory.length - 1) {
          addIssue(ctx, path, "Ending must be the final retention event.");
        }
      } else if (sawEnd) {
        addIssue(ctx, path, "Retention cannot continue after ending.");
      }
    });

    if (pendingChoice) {
      const path: (string | number)[] = ["pendingChoice"];
      if (state.status !== "awaiting_choice") {
        addIssue(ctx, ["status"], "A pending choice requires awaiting_choice status.");
      }
      if (pendingChoice.atDecision !== acceptedDecisions) {
        addIssue(
          ctx,
          ["pendingChoice", "atDecision"],
          "Pending choice must occur at the current accepted decision count.",
        );
      }
      if (!reasonsAreCanonical(pendingChoice.reasons)) {
        addIssue(
          ctx,
          ["pendingChoice", "reasons"],
          "Pending reasons must be unique and in canonical order.",
        );
      }
      const checkpointReason = hasReason(pendingChoice, "checkpoint");
      if (checkpointReason) {
        if (
          pendingChoice.checkpoint !== expectedCheckpoint ||
          pendingChoice.atDecision < expectedCheckpoint
        ) {
          addIssue(
            ctx,
            ["pendingChoice", "checkpoint"],
            `Pending checkpoint must be fixed checkpoint ${expectedCheckpoint} at or after that decision.`,
          );
        }
      } else if (pendingChoice.checkpoint !== null) {
        addIssue(
          ctx,
          ["pendingChoice", "checkpoint"],
          "Only a checkpoint prompt may carry a checkpoint number.",
        );
      }
      validateGoalBinding(pendingChoice, path, null);
      if (hasReason(pendingChoice, "goal_completed")) {
        if (
          goal.status !== "completed" ||
          pendingChoice.goalVersion !== goal.version ||
          pendingChoice.goalId !== goal.id
        ) {
          addIssue(
            ctx,
            ["pendingChoice"],
            "A pending goal-completion choice must bind the completed current goal.",
          );
        }
      }
      if (hasReason(pendingChoice, "character_died") && goal.status !== "active") {
        addIssue(
          ctx,
          ["pendingChoice"],
          "Character death must preserve an unfinished active goal.",
        );
      }
    } else if (state.status === "awaiting_choice") {
      addIssue(ctx, ["pendingChoice"], "awaiting_choice status requires a pending choice.");
    }

    goalHistory.forEach((completed, index) => {
      const bindings = completionBindings.get(completed.version) ?? [];
      if (bindings.length !== 1) {
        addIssue(
          ctx,
          ["goalHistory", index],
          "Every completed goal must have exactly one bound retention prompt or event.",
        );
      }
      if (completed.version < goal.version && bindings[0]?.choice !== "continue") {
        addIssue(
          ctx,
          ["goalHistory", index],
          "Activating a later goal requires a continued completion event for this goal.",
        );
      }
    });

    if (state.status === "ended") {
      if (pendingChoice !== null || state.nextCheckpoint !== null || !sawEnd) {
        addIssue(
          ctx,
          ["status"],
          "Ended journeys require a final end event and no pending/next checkpoint.",
        );
      }
      const endedByDeath = retentionHistory.at(-1)?.reasons.includes("character_died") === true;
      if (endedByDeath && goal.status !== "active") {
        addIssue(ctx, ["goal"], "A journey ended by character death must keep its goal active.");
      }
    } else {
      if (sawEnd) {
        addIssue(ctx, ["retentionHistory"], "Only an ended journey may retain an end choice.");
      }
      if (state.nextCheckpoint !== expectedCheckpoint) {
        addIssue(
          ctx,
          ["nextCheckpoint"],
          `Next fixed journey checkpoint must be ${expectedCheckpoint}.`,
        );
      }
      const pendingCheckpoint = pendingChoice && hasReason(pendingChoice, "checkpoint");
      if (pendingCheckpoint) {
        if (acceptedDecisions < expectedCheckpoint) {
          addIssue(
            ctx,
            ["acceptedDecisions"],
            "Checkpoint prompt cannot precede its fixed threshold.",
          );
        }
      } else if (pendingChoice && acceptedDecisions >= expectedCheckpoint) {
        addIssue(
          ctx,
          ["pendingChoice"],
          "An overdue checkpoint must be merged into a mandatory goal or death prompt.",
        );
      }
    }
  });

function cloneReasons(reasons: readonly JourneyChoiceReason[]): JourneyChoiceReason[] {
  return [...reasons];
}

function cloneCompletedGoal(goal: JourneyCompletedGoalSnapshot): JourneyCompletedGoalSnapshot {
  return { ...goal };
}

function cloneRetentionEvent(event: JourneyRetentionEvent): JourneyRetentionEventSnapshot {
  return {
    ...event,
    reasons: cloneReasons(event.reasons),
  };
}

export function cloneJourneyContractSnapshot(
  state: JourneyContractSnapshot,
): JourneyContractSnapshot {
  return {
    ...state,
    goal: { ...state.goal },
    goalHistory: state.goalHistory.map(cloneCompletedGoal),
    decisionProof: {
      ...state.decisionProof,
      last: state.decisionProof.last ? { ...state.decisionProof.last } : null,
    },
    pendingChoice: state.pendingChoice
      ? { ...state.pendingChoice, reasons: cloneReasons(state.pendingChoice.reasons) }
      : null,
    retentionHistory: state.retentionHistory.map(cloneRetentionEvent),
  };
}

function assertGoalDefinition(goal: JourneyGoalDefinition, expectedVersion?: number): void {
  const parsed = JourneyGoalDefinitionSchema.parse(goal);
  if (expectedVersion !== undefined && parsed.version !== expectedVersion) {
    throw new Error(`Journey goal version must be ${expectedVersion}, got ${parsed.version}.`);
  }
}

export function createInitialJourneyContractSnapshot(
  initialGoal: JourneyGoalDefinition = INITIAL_JOURNEY_GOAL,
): JourneyContractSnapshot {
  assertGoalDefinition(initialGoal, 1);
  return {
    version: JOURNEY_CONTRACT_VERSION,
    status: "active",
    goal: {
      ...initialGoal,
      status: "active",
      completedAtDecision: null,
    },
    goalHistory: [],
    acceptedDecisions: 0,
    nextCheckpoint: JOURNEY_BASELINE_DECISIONS,
    decisionProof: {
      hash: initialDecisionProofHash(initialGoal),
      last: null,
    },
    pendingChoice: null,
    retentionHistory: [],
  };
}

function freezeGoal(goal: JourneyGoalSnapshot): JourneyGoalPresentation {
  return Object.freeze({ ...goal });
}

function freezeCompletedGoal(goal: JourneyCompletedGoalSnapshot): JourneyCompletedGoalPresentation {
  return Object.freeze({ ...goal });
}

function freezeRetentionEvent(event: JourneyRetentionEvent): JourneyRetentionEvent {
  return Object.freeze({ ...event, reasons: Object.freeze(cloneReasons(event.reasons)) });
}

function continuationCheckpoint(
  state: JourneyContractSnapshot,
  pending: JourneyPendingChoiceSnapshot,
): number {
  const checkpoint =
    pending.checkpoint === null
      ? state.nextCheckpoint
      : nextFixedCheckpointAfter(pending.atDecision);
  if (checkpoint === null) {
    throw new Error("A continuing journey choice requires a next fixed checkpoint.");
  }
  return checkpoint;
}

function pendingChoiceMessage(state: JourneyContractSnapshot): string {
  const pending = state.pendingChoice;
  if (!pending) throw new Error("Journey has no pending choice.");
  const checkpoint = hasReason(pending, "checkpoint");
  const goal = hasReason(pending, "goal_completed");
  if (hasReason(pending, "character_died")) {
    const decisionUnit = pending.atDecision === 1 ? "decision" : "decisions";
    return `Your character died before completing the current goal, after ${String(pending.atDecision)} ${decisionUnit}. You cannot continue. End the journey to keep the unfinished goal and history for review.`;
  }
  const continueTo = continuationCheckpoint(state, pending);
  const goalBoundary = goal ? "you complete another goal" : "you complete the current goal";
  const continueBoundary = `${goalBoundary} or reach the first safe break on or after decision ${String(continueTo)}`;
  if (checkpoint && goal) {
    if (pending.atDecision !== pending.checkpoint) {
      return `You completed the current goal at decision ${String(pending.atDecision)}, the first safe break after decision ${String(pending.checkpoint)}. Continue keeps all progress. End makes this journey read-only. If you continue, the next Continue/End choice appears when ${continueBoundary}.`;
    }
    return `You completed the current goal at safe break ${String(pending.checkpoint)}. Continue keeps all progress. End makes this journey read-only. If you continue, the next Continue/End choice appears when ${continueBoundary}.`;
  }
  if (checkpoint) {
    if (pending.atDecision !== pending.checkpoint) {
      return `You reached the first safe break after decision ${String(pending.checkpoint)}, now at decision ${String(pending.atDecision)}. Any active quest is paused with its progress saved. Continue from here, or end and keep a read-only record. The next Continue/End choice appears when ${continueBoundary}.`;
    }
    return `You reached safe break ${String(pending.checkpoint)}. Any active quest is paused with its progress saved. Continue from here, or end and keep a read-only record. The next Continue/End choice appears when ${continueBoundary}.`;
  }
  return `You completed the current goal after decision ${String(pending.atDecision)}. Continue keeps all progress. End makes this journey read-only. If you continue, the next Continue/End choice appears when ${continueBoundary}.`;
}

function affix(base: string, prefix: string | undefined, suffix: string | undefined): string {
  return [prefix, base, suffix].filter((value): value is string => Boolean(value)).join(" ");
}

function matchingGoalCompletionContext(
  pending: JourneyPendingChoiceSnapshot,
  context: JourneyPresentationContext | undefined,
): JourneyGoalCompletionPresentationContext | undefined {
  const goalContext = context?.goalCompletion;
  if (
    !goalContext ||
    !hasReason(pending, "goal_completed") ||
    goalContext.goalVersion !== pending.goalVersion ||
    goalContext.goalId !== pending.goalId
  ) {
    return undefined;
  }
  return goalContext;
}

function pendingChoicePresentation(
  state: JourneyContractSnapshot,
  context?: JourneyPresentationContext,
): JourneyChoicePrompt | null {
  const pending = state.pendingChoice;
  if (!pending) return null;
  const characterDied = hasReason(pending, "character_died");
  const goalContext = matchingGoalCompletionContext(pending, context);
  if (goalContext?.continueLabel !== undefined && goalContext.continueLabel.trim().length === 0) {
    throw new Error("Journey goal-completion Continue label cannot be empty.");
  }
  const options = characterDied
    ? Object.freeze([
        Object.freeze({
          id: "end" as const,
          label: "End this journey",
          consequence:
            "End now. You cannot continue after death. The unfinished goal and completed history remain available for review.",
        }),
      ])
    : (() => {
        const continueTo = continuationCheckpoint(state, pending);
        return Object.freeze([
          Object.freeze({
            id: "continue" as const,
            label: goalContext?.continueLabel ?? "Continue from here",
            consequence: affix(
              `Keep all progress and continue. The next Continue/End choice appears when you complete a goal or reach the first safe break on or after decision ${String(continueTo)}.`,
              goalContext?.continueConsequencePrefix,
              goalContext?.continueConsequenceSuffix,
            ),
          }),
          Object.freeze({
            id: "end" as const,
            label: "End here",
            consequence: "End this journey and keep its read-only record. You cannot resume it.",
          }),
        ]);
      })();
  const continuationPreview =
    characterDied || !goalContext?.continuationPreview
      ? undefined
      : freezeContinuationPreview(goalContext.continuationPreview);
  return Object.freeze({
    id: `journey:${pending.atDecision}:${pending.reasons.join("+")}:${String(pending.goalVersion ?? "none")}:${pending.goalId ?? "none"}`,
    atDecision: pending.atDecision,
    reasons: Object.freeze(cloneReasons(pending.reasons)),
    checkpoint: pending.checkpoint,
    goalVersion: pending.goalVersion,
    goalId: pending.goalId,
    message: affix(
      pendingChoiceMessage(state),
      goalContext?.messagePrefix,
      goalContext?.messageSuffix,
    ),
    options: options as readonly [JourneyChoiceOption, ...JourneyChoiceOption[]],
    ...(continuationPreview ? { continuationPreview } : {}),
  });
}

function freezeContinuationPreview(
  preview: JourneyContinuationPreview,
): JourneyContinuationPreview {
  if (preview.id.length === 0 || preview.message.length === 0 || preview.options.length !== 2) {
    throw new Error(
      "Journey continuation preview requires an id, message, and exactly two options.",
    );
  }
  const optionIds = new Set<string>();
  const options = preview.options.map((option) => {
    if (option.id.length === 0 || option.label.length === 0 || option.consequence.length === 0) {
      throw new Error("Journey continuation preview option fields cannot be empty.");
    }
    if (optionIds.has(option.id)) {
      throw new Error("Journey continuation preview option ids must be unique.");
    }
    optionIds.add(option.id);
    return Object.freeze({ ...option });
  });
  return Object.freeze({
    id: preview.id,
    message: preview.message,
    options: Object.freeze(options) as JourneyContinuationPreview["options"],
  });
}

function freezeStoryChoice(
  storyChoice: JourneyStoryChoicePrompt | null | undefined,
): JourneyStoryChoicePrompt | null {
  if (!storyChoice) return null;
  if (storyChoice.id.length === 0 || storyChoice.message.length === 0) {
    throw new Error("Journey story choice id and message cannot be empty.");
  }
  const presentationKind = (storyChoice as { kind?: unknown }).kind;
  if (
    presentationKind !== undefined &&
    presentationKind !== "ally" &&
    presentationKind !== "registration" &&
    presentationKind !== "lead_source" &&
    presentationKind !== "preparation" &&
    presentationKind !== "relief_allocation" &&
    presentationKind !== "relief_oath"
  ) {
    throw new Error(
      `Journey story choice has unknown presentation kind "${String(presentationKind)}".`,
    );
  }
  if (presentationKind === "registration") {
    if (storyChoice.options.length < 4 || storyChoice.options.length > 8) {
      throw new Error("Journey registration choice requires between four and eight options.");
    }
  } else if (presentationKind === "lead_source") {
    if (storyChoice.options.length < 3 || storyChoice.options.length > 5) {
      throw new Error("Journey lead-source choice requires between three and five options.");
    }
  } else if (presentationKind === "preparation") {
    if (storyChoice.options.length < 3 || storyChoice.options.length > 5) {
      throw new Error("Journey preparation choice requires between three and five options.");
    }
  } else if (presentationKind === "relief_allocation") {
    if (storyChoice.options.length !== 3) {
      throw new Error("Journey relief-allocation choice requires exactly three options.");
    }
  } else if (presentationKind === "relief_oath") {
    if (storyChoice.options.length < 3 || storyChoice.options.length > 4) {
      throw new Error("Journey relief-oath choice requires between three and four options.");
    }
  } else if (presentationKind === "ally") {
    if (storyChoice.options.length < 3 || storyChoice.options.length > 4) {
      throw new Error("Journey ally choice requires between three and four options.");
    }
  } else if (storyChoice.options.length !== 2) {
    throw new Error("Journey aftermath story choice requires exactly two options.");
  }
  const requiresStructuredSummary =
    presentationKind === "registration" ||
    presentationKind === "ally" ||
    presentationKind === "relief_oath" ||
    presentationKind === "lead_source" ||
    presentationKind === "preparation" ||
    presentationKind === "relief_allocation";
  const optionIds = new Set<string>();
  const options = storyChoice.options.map((option) => {
    if (option.id.length === 0 || option.label.length === 0 || option.consequence.length === 0) {
      throw new Error("Journey story choice option fields cannot be empty.");
    }
    if (requiresStructuredSummary && !option.summary) {
      throw new Error("Journey setup choice options require a concise summary.");
    }
    if (
      option.summary &&
      (option.summary.commitment.length === 0 ||
        (option.summary.fieldTrigger !== undefined && option.summary.fieldTrigger.length === 0) ||
        (option.summary.checkFit !== undefined && option.summary.checkFit.trim().length === 0) ||
        typeof option.summary.immediateCost !== "string" ||
        option.summary.immediateCost.length === 0 ||
        typeof option.summary.tradeoff !== "string" ||
        option.summary.tradeoff.length === 0)
    ) {
      throw new Error("Journey story choice summary fields cannot be empty.");
    }
    if (
      option.summary?.fieldTriggerScope !== undefined &&
      (option.summary.fieldTrigger === undefined ||
        (option.summary.fieldTriggerScope !== "category" &&
          option.summary.fieldTriggerScope !== "starter"))
    ) {
      throw new Error(
        `Journey story choice field-trigger scope "${String(option.summary.fieldTriggerScope)}" is invalid.`,
      );
    }
    if (option.summary?.highlights) {
      if (option.summary.highlights.length === 0) {
        throw new Error("Journey story choice summary highlights cannot be empty.");
      }
      const highlightLabels = new Set<string>();
      for (const highlight of option.summary.highlights) {
        if (highlight.label.trim().length === 0 || highlight.value.trim().length === 0) {
          throw new Error("Journey story choice summary highlights cannot be blank.");
        }
        if (highlightLabels.has(highlight.label)) {
          throw new Error("Journey story choice summary highlight labels must be unique.");
        }
        highlightLabels.add(highlight.label);
      }
    }
    if (optionIds.has(option.id)) {
      throw new Error("Journey story choice option ids must be unique.");
    }
    optionIds.add(option.id);
    return Object.freeze({
      ...option,
      ...(option.summary
        ? {
            summary: Object.freeze({
              ...option.summary,
              ...(option.summary.highlights
                ? {
                    highlights: Object.freeze(
                      option.summary.highlights.map((highlight) => Object.freeze({ ...highlight })),
                    ) as JourneyStoryChoiceSummary["highlights"],
                  }
                : {}),
            }),
          }
        : {}),
    });
  });
  const frozenOptions = Object.freeze(options);
  const progressiveDisclosure = storyChoice.progressiveDisclosure;
  if (progressiveDisclosure && presentationKind !== "relief_oath") {
    throw new Error("Journey progressive disclosure is supported only for relief-oath choices.");
  }
  const frozenProgressiveDisclosure = progressiveDisclosure
    ? (() => {
        const initialOptionIds = progressiveDisclosure.initialOptionIds;
        const reveal = progressiveDisclosure.reveal;
        if (
          reveal.optionIds.length === 0 ||
          reveal.id.trim().length === 0 ||
          reveal.label.trim().length === 0 ||
          reveal.description.trim().length === 0
        ) {
          throw new Error("Journey progressive disclosure fields cannot be empty.");
        }
        if (optionIds.has(reveal.id)) {
          throw new Error(
            `Journey progressive disclosure id "${reveal.id}" collides with a story choice option id.`,
          );
        }

        const disclosedOptionIds = new Set<string>();
        for (const id of [...initialOptionIds, ...reveal.optionIds]) {
          if (id.trim().length === 0) {
            throw new Error("Journey progressive disclosure option ids cannot be empty.");
          }
          if (!optionIds.has(id)) {
            throw new Error(
              `Journey progressive disclosure references unknown story choice option "${id}".`,
            );
          }
          if (disclosedOptionIds.has(id)) {
            throw new Error(
              "Journey progressive disclosure option ids must be unique and disjoint.",
            );
          }
          disclosedOptionIds.add(id);
        }
        if (disclosedOptionIds.size !== optionIds.size) {
          throw new Error(
            "Journey progressive disclosure must cover every story choice option exactly once.",
          );
        }
        return Object.freeze({
          initialOptionIds: Object.freeze([
            ...initialOptionIds,
          ]) as JourneyStoryChoiceProgressiveDisclosure["initialOptionIds"],
          reveal: Object.freeze({
            id: reveal.id,
            label: reveal.label,
            description: reveal.description,
            optionIds: Object.freeze([
              ...reveal.optionIds,
            ]) as JourneyStoryChoiceProgressiveDisclosure["reveal"]["optionIds"],
          }),
        });
      })()
    : undefined;
  return Object.freeze({
    ...storyChoice,
    options: frozenOptions,
    ...(frozenProgressiveDisclosure ? { progressiveDisclosure: frozenProgressiveDisclosure } : {}),
  }) as JourneyStoryChoicePrompt;
}

function freezeGoalPassage(
  goalPassage: JourneyGoalPassagePresentation | null | undefined,
): JourneyGoalPassagePresentation | null {
  if (!goalPassage) return null;
  if (goalPassage.id !== "follow_current_goal") {
    throw new Error("Journey goal passage has an unknown action id.");
  }
  if (
    goalPassage.label.trim().length === 0 ||
    goalPassage.destination.trim().length === 0 ||
    goalPassage.consequence.trim().length === 0 ||
    goalPassage.stopRule.trim().length === 0 ||
    goalPassage.travelConditionAfter.trim().length === 0
  ) {
    throw new Error("Journey goal passage text fields cannot be empty.");
  }
  for (const value of [
    goalPassage.roadCount,
    goalPassage.baseMinutes,
    goalPassage.estimatedMinutes,
    goalPassage.suppliesNeeded,
    goalPassage.supplyDeficit,
    goalPassage.suppliesAfter,
    goalPassage.fatigueAfter,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Journey goal passage estimates must be non-negative safe integers.");
    }
  }
  if (goalPassage.roadCount === 0) {
    throw new Error("Journey goal passage requires at least one road.");
  }
  return Object.freeze({
    id: goalPassage.id,
    label: goalPassage.label,
    destination: goalPassage.destination,
    roadCount: goalPassage.roadCount,
    baseMinutes: goalPassage.baseMinutes,
    estimatedMinutes: goalPassage.estimatedMinutes,
    suppliesNeeded: goalPassage.suppliesNeeded,
    supplyDeficit: goalPassage.supplyDeficit,
    suppliesAfter: goalPassage.suppliesAfter,
    fatigueAfter: goalPassage.fatigueAfter,
    travelConditionAfter: goalPassage.travelConditionAfter,
    consequence: goalPassage.consequence,
    stopRule: goalPassage.stopRule,
  });
}

export function cloneJourneyOpportunityPresentation(
  opportunities: JourneyOpportunityPresentation | null,
): JourneyOpportunityPresentation | null {
  if (!opportunities) return null;
  return {
    guidance: opportunities.guidance,
    leads: opportunities.leads.map((lead) => ({ ...lead })),
    ...(opportunities.deferredLeadCount === undefined
      ? {}
      : { deferredLeadCount: opportunities.deferredLeadCount }),
  };
}

function freezeJourneyOpportunities(
  opportunities: JourneyOpportunityPresentation | null | undefined,
): JourneyOpportunityPresentation | null {
  if (!opportunities) return null;
  if (opportunities.guidance.trim().length === 0) {
    throw new Error("Journey opportunity guidance cannot be empty.");
  }
  const deferredLeadCount = opportunities.deferredLeadCount;
  if (
    deferredLeadCount !== undefined &&
    (!Number.isSafeInteger(deferredLeadCount) || deferredLeadCount <= 0)
  ) {
    throw new Error("Deferred journey opportunity count must be a positive safe integer.");
  }
  if (deferredLeadCount === undefined && opportunities.leads.length === 0) {
    throw new Error("Detailed journey opportunities require at least one lead.");
  }
  if (deferredLeadCount !== undefined && opportunities.leads.length > 0) {
    throw new Error("Deferred journey opportunities cannot disclose detailed leads.");
  }
  const keys = new Set<string>();
  const leads = opportunities.leads.map((lead) => {
    if (
      lead.id.trim().length === 0 ||
      lead.title.trim().length === 0 ||
      lead.area.trim().length === 0
    ) {
      throw new Error("Journey opportunity lead text fields cannot be empty.");
    }
    if (lead.kind !== "event" && lead.kind !== "job") {
      throw new Error("Journey opportunity lead has an unknown kind.");
    }
    if (lead.access !== "here" && lead.access !== "mapped" && lead.access !== "route_unmapped") {
      throw new Error("Journey opportunity lead has an unknown access state.");
    }
    const key = `${lead.kind}:${lead.id}`;
    if (keys.has(key)) throw new Error("Journey opportunity lead identities must be unique.");
    keys.add(key);
    return Object.freeze({ ...lead });
  });
  return Object.freeze({
    guidance: opportunities.guidance,
    leads: Object.freeze(leads),
    ...(deferredLeadCount === undefined ? {} : { deferredLeadCount }),
  });
}

export function journeyPresentation(
  state: JourneyContractSnapshot,
  context?: JourneyPresentationContext,
): JourneyPresentation {
  const presentsActiveInitialGoal =
    state.status !== "ended" &&
    state.goal.status === "active" &&
    state.goal.version === INITIAL_JOURNEY_GOAL.version &&
    state.goal.id === INITIAL_JOURNEY_GOAL.id &&
    state.goal.text === INITIAL_JOURNEY_GOAL.text &&
    state.pendingChoice?.reasons.includes("character_died") !== true;
  const contextualGoalGuidance = context?.goalGuidance;
  const goalGuidance =
    contextualGoalGuidance === undefined
      ? presentsActiveInitialGoal
        ? INITIAL_JOURNEY_GOAL_GUIDANCE
        : null
      : contextualGoalGuidance;
  if (goalGuidance !== null && goalGuidance.trim().length === 0) {
    throw new Error("Journey goal guidance cannot be empty.");
  }
  return Object.freeze({
    contractVersion: JOURNEY_CONTRACT_VERSION,
    status: state.status,
    goal: freezeGoal(state.goal),
    completedGoals: Object.freeze(state.goalHistory.map(freezeCompletedGoal)),
    acceptedDecisions: state.acceptedDecisions,
    baselineDecisions: JOURNEY_BASELINE_DECISIONS,
    nextCheckpoint: state.nextCheckpoint,
    decisionProof: Object.freeze({
      hash: state.decisionProof.hash,
      last: state.decisionProof.last ? Object.freeze({ ...state.decisionProof.last }) : null,
    }),
    goalGuidance,
    goalPassage: freezeGoalPassage(context?.goalPassage),
    opportunities: freezeJourneyOpportunities(context?.opportunities),
    pendingChoice: pendingChoicePresentation(state, context),
    storyChoice: freezeStoryChoice(context?.storyChoice),
    retentionHistory: Object.freeze(state.retentionHistory.map(freezeRetentionEvent)),
  });
}

export function assertJourneyAcceptingDecision(state: JourneyContractSnapshot): void {
  if (state.status === "ended") {
    throw new Error("This journey has ended.");
  }
  if (state.status === "awaiting_choice") {
    throw new Error(
      "Choose whether to continue or end this journey before taking another gameplay action.",
    );
  }
  if (state.acceptedDecisions >= Number.MAX_SAFE_INTEGER) {
    throw new Error("The journey has reached the maximum safe accepted-decision count.");
  }
}

function materializeDueJourneyCheckpoint(
  state: JourneyContractSnapshot,
  checkpointSafeBoundary: boolean,
): JourneyContractSnapshot {
  if (
    !checkpointSafeBoundary ||
    state.status !== "active" ||
    state.pendingChoice !== null ||
    state.nextCheckpoint === null ||
    state.acceptedDecisions < state.nextCheckpoint
  ) {
    return state;
  }
  return {
    ...state,
    status: "awaiting_choice",
    pendingChoice: {
      atDecision: state.acceptedDecisions,
      reasons: ["checkpoint"],
      checkpoint: state.nextCheckpoint,
      goalVersion: null,
      goalId: null,
    },
  };
}

export function recordJourneyAcceptedDecision(
  state: JourneyContractSnapshot,
  decision: JourneyAcceptedDecision,
  checkpointSafeBoundary: boolean,
): JourneyContractSnapshot {
  assertJourneyAcceptingDecision(state);
  if (decision.actionId.length === 0) {
    throw new Error("Accepted journey action id cannot be empty.");
  }
  const acceptedDecisions = state.acceptedDecisions + 1;
  const last: JourneyDecisionProofLast = {
    number: acceptedDecisions,
    surface: decision.surface,
    actionId: decision.actionId,
    reason: decision.reason,
  };
  const decisionProof = {
    hash: hashState({ previous: state.decisionProof.hash, ...last }),
    last,
  };
  return materializeDueJourneyCheckpoint(
    {
      ...state,
      acceptedDecisions,
      decisionProof,
      status: "active",
      pendingChoice: null,
    },
    checkpointSafeBoundary,
  );
}

/** Apply one accepted gameplay outcome to the versioned journey contract. */
export function recordJourneyDecision(
  state: JourneyContractSnapshot,
  decision: Omit<JourneyAcceptedDecision, "reason">,
  classification: JourneyDecisionClassification,
  checkpointSafeBoundary: boolean,
): JourneyContractSnapshot {
  assertJourneyAcceptingDecision(state);
  if (!classification.countsTowardJourney) {
    return classification.reason === "rejected"
      ? state
      : materializeDueJourneyCheckpoint(state, checkpointSafeBoundary);
  }
  return recordJourneyAcceptedDecision(
    state,
    {
      ...decision,
      reason: classification.reason,
    },
    checkpointSafeBoundary,
  );
}

function canonicalReasons(reasons: readonly JourneyChoiceReason[]): JourneyChoiceReason[] {
  return ["checkpoint", "goal_completed", "character_died"].filter((reason) =>
    reasons.includes(reason as JourneyChoiceReason),
  ) as JourneyChoiceReason[];
}

export function recordJourneyGoalCompleted(
  state: JourneyContractSnapshot,
): JourneyContractSnapshot {
  if (state.status === "ended") throw new Error("This journey has ended.");
  if (state.goal.status === "completed") return state;
  const goal: JourneyCompletedGoalSnapshot = {
    ...state.goal,
    status: "completed",
    completedAtDecision: state.acceptedDecisions,
  };
  const goalHistory = [...state.goalHistory, goal];
  const checkpoint = state.nextCheckpoint;
  const checkpointDue = checkpoint !== null && state.acceptedDecisions >= checkpoint;
  if (state.pendingChoice || checkpointDue) {
    const pendingChoice = state.pendingChoice ?? {
      atDecision: state.acceptedDecisions,
      reasons: ["checkpoint"] as JourneyChoiceReason[],
      checkpoint,
      goalVersion: null,
      goalId: null,
    };
    return {
      ...state,
      status: "awaiting_choice",
      goal,
      goalHistory,
      pendingChoice: {
        ...pendingChoice,
        reasons: canonicalReasons([...pendingChoice.reasons, "goal_completed"]),
        goalVersion: goal.version,
        goalId: goal.id,
      },
    };
  }
  return {
    ...state,
    status: "awaiting_choice",
    goal,
    goalHistory,
    pendingChoice: {
      atDecision: state.acceptedDecisions,
      reasons: ["goal_completed"],
      checkpoint: null,
      goalVersion: goal.version,
      goalId: goal.id,
    },
  };
}

/**
 * Stop an embedded death on the game-owned journey surface. Death never completes
 * the current goal and never offers a resurrection disguised as continuation.
 */
export function recordJourneyCharacterDied(
  state: JourneyContractSnapshot,
): JourneyContractSnapshot {
  if (state.status === "ended") throw new Error("This journey has ended.");
  if (state.goal.status === "completed") {
    throw new Error("A character-death pause cannot replace a completed-goal choice.");
  }
  const checkpoint = state.nextCheckpoint;
  const checkpointDue = checkpoint !== null && state.acceptedDecisions >= checkpoint;
  if (state.pendingChoice || checkpointDue) {
    const pendingChoice = state.pendingChoice ?? {
      atDecision: state.acceptedDecisions,
      reasons: ["checkpoint"] as JourneyChoiceReason[],
      checkpoint,
      goalVersion: null,
      goalId: null,
    };
    return {
      ...state,
      status: "awaiting_choice",
      pendingChoice: {
        ...pendingChoice,
        reasons: canonicalReasons([...pendingChoice.reasons, "character_died"]),
        goalVersion: null,
        goalId: null,
      },
    };
  }
  return {
    ...state,
    status: "awaiting_choice",
    pendingChoice: {
      atDecision: state.acceptedDecisions,
      reasons: ["character_died"],
      checkpoint: null,
      goalVersion: null,
      goalId: null,
    },
  };
}

export function hasContinuedJourneyGoal(
  state: JourneyContractSnapshot,
  goal: JourneyGoalIdentity,
): boolean {
  return state.retentionHistory.some(
    (event) =>
      event.choice === "continue" &&
      hasReason(event, "goal_completed") &&
      event.goalVersion === goal.version &&
      event.goalId === goal.id,
  );
}

export function activateJourneyGoal(
  state: JourneyContractSnapshot,
  definition: JourneyGoalDefinition,
): JourneyContractSnapshot {
  if (state.status === "ended") throw new Error("This journey has ended.");
  if (state.status !== "active" || state.pendingChoice !== null) {
    throw new Error("Answer the current journey choice before activating another goal.");
  }
  if (state.goal.status !== "completed") {
    throw new Error("The current journey goal must be completed before activating another goal.");
  }
  if (!hasContinuedJourneyGoal(state, state.goal)) {
    throw new Error(
      "Activating another journey goal requires continuing from the completed goal's choice.",
    );
  }
  const expectedVersion = state.goal.version + 1;
  assertGoalDefinition(definition, expectedVersion);
  return {
    ...state,
    goal: {
      ...definition,
      status: "active",
      completedAtDecision: null,
    },
  };
}

function buildJourneyExitReceipt(state: JourneyContractSnapshot): JourneyExitReceipt | null {
  if (state.status !== "ended") return null;
  const last = state.retentionHistory.at(-1);
  if (!last || last.choice !== "end") {
    throw new Error("Ended journey is missing its final retention event.");
  }
  const completedGoalsPayload = state.goalHistory.map(cloneCompletedGoal);
  const retentionHistoryPayload = state.retentionHistory.map((event) => ({
    ...event,
    reasons: cloneReasons(event.reasons),
  }));
  const payload = {
    contractVersion: JOURNEY_CONTRACT_VERSION,
    exitReason: JOURNEY_EXIT_REASON,
    goalVersion: state.goal.version,
    goalId: state.goal.id,
    goalText: state.goal.text,
    goalStatus: state.goal.status,
    goalCompletedAtDecision: state.goal.completedAtDecision,
    completedGoals: completedGoalsPayload,
    acceptedDecisions: state.acceptedDecisions,
    exitReasons: cloneReasons(last.reasons),
    checkpoint: last.checkpoint,
    decisionProofHash: state.decisionProof.hash,
    retentionHistory: retentionHistoryPayload,
  };
  return Object.freeze({
    ...payload,
    completedGoals: Object.freeze(state.goalHistory.map(freezeCompletedGoal)),
    exitReasons: Object.freeze(payload.exitReasons),
    retentionHistory: Object.freeze(state.retentionHistory.map(freezeRetentionEvent)),
    receiptHash: hashState(payload),
  });
}

export function journeyExitReceipt(state: JourneyContractSnapshot): JourneyExitReceipt | null {
  return buildJourneyExitReceipt(state);
}

export function chooseJourney(
  state: JourneyContractSnapshot,
  choice: JourneyChoice,
): { state: JourneyContractSnapshot; result: JourneyChoiceResult } {
  if (choice !== "continue" && choice !== "end") {
    throw new Error(`Unknown journey choice "${String(choice)}".`);
  }
  if (state.status !== "awaiting_choice" || !state.pendingChoice) {
    throw new Error("There is no journey continuation choice to make right now.");
  }
  const pending = state.pendingChoice;
  if (choice === "continue" && hasReason(pending, "character_died")) {
    throw new Error("This character died. End the journey; it cannot continue.");
  }
  const retentionEvent: JourneyRetentionEventSnapshot = {
    sequence: state.retentionHistory.length + 1,
    atDecision: state.acceptedDecisions,
    reasons: cloneReasons(pending.reasons),
    checkpoint: pending.checkpoint,
    goalVersion: pending.goalVersion,
    goalId: pending.goalId,
    choice,
    decisionProofHash: state.decisionProof.hash,
  };
  const answeredCheckpoint = hasReason(pending, "checkpoint");
  if (answeredCheckpoint && state.nextCheckpoint === null) {
    throw new Error("Journey checkpoint choice is missing its next checkpoint.");
  }
  const nextCheckpoint =
    choice === "end"
      ? null
      : answeredCheckpoint
        ? nextFixedCheckpointAfter(pending.atDecision)
        : state.nextCheckpoint;
  if (nextCheckpoint !== null && nextCheckpoint > Number.MAX_SAFE_INTEGER) {
    throw new Error("The next journey checkpoint exceeds JavaScript's safe integer range.");
  }
  const nextState: JourneyContractSnapshot = {
    ...state,
    status: choice === "end" ? "ended" : "active",
    nextCheckpoint,
    pendingChoice: null,
    retentionHistory: [...state.retentionHistory, retentionEvent],
  };
  const frozenEvent = freezeRetentionEvent(retentionEvent);
  return {
    state: nextState,
    result: Object.freeze({
      journey: journeyPresentation(nextState),
      retentionEvent: frozenEvent,
      exitReceipt: buildJourneyExitReceipt(nextState),
    }),
  };
}
