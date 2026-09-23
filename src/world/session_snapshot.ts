import { z } from "zod";
import {
  CampaignCharacterStateSchema,
  cloneCampaignCharacterState,
} from "./campaign_character_state.js";
import {
  JourneyContractSnapshotSchema,
  JourneyDecisionProofLastSchema,
  cloneJourneyContractSnapshot,
  type JourneyDecisionProofLast,
} from "./journey_contract.js";
import type { OverworldRoadEvent } from "./overworld.js";
import {
  OVERWORLD_MAX_FATIGUE as MAX_FATIGUE,
  OVERWORLD_MAX_SUPPLIES as MAX_SUPPLIES,
  type OverworldRoadEncounterOption,
} from "./travel_mechanics.js";
import type { QuestDispatchLaunchSeal } from "./quest_dispatch_window.js";

/**
 * Structural compatibility contract for overworld saves. Authored content
 * revisions do not change this value; incompatible state-shape changes do.
 */
const OVERWORLD_WORLD_SCHEMA_VERSION = 11 as const;
export const OVERWORLD_SESSION_PREVIOUS_SAVE_VERSION = 10 as const;
export const OVERWORLD_SESSION_SAVE_VERSION = OVERWORLD_WORLD_SCHEMA_VERSION;

/**
 * Clock and counter fields a restore will accept. Integer arithmetic on the session clock
 * (travel, rest, local scenes) is exact only inside the safe-integer range; a restored
 * 2^53+2 or 1e300 used to load, advance and re-save as a silently inexact clock (bug_0643).
 * The journal-registration boundary's own `minutes` already carried this bound.
 */
const SAFE_NONNEGATIVE_INT = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export type TravelLogEntry = {
  edgeId: string;
  fromId: string;
  toId: string;
  from: string;
  to: string;
  route: string;
  distanceMi: number;
  baseMinutes: number;
  delayMinutes: number;
  minutes: number;
  arrivedAt: number;
  suppliesUsed: number;
  suppliesAfter: number;
  fatigueGained: number;
  fatigueAfter: number;
  roadEvent: OverworldRoadEvent | null;
};

export type TravelLogEntrySnapshot = {
  edgeId: string;
  fromId: string;
  toId: string;
  roadEventId?: string | null | undefined;
  delayMinutes: number;
  minutes: number;
  arrivedAt: number;
  suppliesUsed: number;
  suppliesAfter: number;
  fatigueGained: number;
  fatigueAfter: number;
};

const TravelLogEntrySnapshotSchema = z
  .object({
    edgeId: z.string().min(1),
    fromId: z.string().min(1),
    toId: z.string().min(1),
    roadEventId: z.string().min(1).nullable().optional(),
    delayMinutes: SAFE_NONNEGATIVE_INT,
    minutes: SAFE_NONNEGATIVE_INT,
    arrivedAt: SAFE_NONNEGATIVE_INT,
    suppliesUsed: z.number().int().min(0).max(MAX_SUPPLIES),
    suppliesAfter: z.number().int().min(0).max(MAX_SUPPLIES),
    fatigueGained: SAFE_NONNEGATIVE_INT,
    fatigueAfter: z.number().int().min(0).max(MAX_FATIGUE),
  })
  .strict();

export type OverworldPendingRoadEncounter = {
  id: string;
  edgeId: string;
  from: string;
  to: string;
  route: string;
  arrivedAt: string;
  timing: string;
  event: OverworldRoadEvent;
  options: OverworldRoadEncounterOption[];
};

export type OverworldPendingRoadEncounterSnapshot = {
  edgeId: string;
};

const OverworldPendingRoadEncounterSnapshotSchema = z
  .object({
    edgeId: z.string().min(1),
  })
  .strict();

export type OverworldJournalDecisionBoundary = {
  acceptedDecisions: number;
  decisionProofHash: string;
  townId: string;
  areaId: string;
  minutes: number;
};

export type OverworldQuestStartProof = {
  kind: "approach";
  approachId: string;
  boundary: OverworldJournalDecisionBoundary;
  dispatchSeal?: QuestDispatchLaunchSeal | undefined;
};

export type OverworldLocalSceneProof = {
  sceneId: string;
  optionId: string;
  /** Added by the session when the action is accepted; required in serialized saves. */
  boundary?: OverworldJournalDecisionBoundary | undefined;
};

/**
 * Replayable suffix from the source offer to the current journey proof. This
 * makes the chosen source part of every later
 * save's causal history instead of trusting a detached journal entry.
 */
export type OverworldOpeningLeadSourceDecisionTrail = {
  anchorId: string;
  baseAcceptedDecisions: number;
  baseDecisionProofHash: string;
  decisions: JourneyDecisionProofLast[];
};

const OverworldQuestCharacterDeathBoundarySchema = z
  .object({
    questId: z.string().min(1),
    endingId: z.string().min(1),
    acceptedDecisions: z.number().int().nonnegative().safe(),
    journeyDecisionProof: z
      .object({
        hash: z.string().regex(/^[0-9a-f]{64}$/),
        last: JourneyDecisionProofLastSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export type OverworldQuestCharacterDeathBoundary = z.infer<
  typeof OverworldQuestCharacterDeathBoundarySchema
>;

export function cloneQuestCharacterDeathBoundary(
  boundary: OverworldQuestCharacterDeathBoundary,
): OverworldQuestCharacterDeathBoundary {
  return {
    ...boundary,
    journeyDecisionProof: {
      ...boundary.journeyDecisionProof,
      last: boundary.journeyDecisionProof.last ? { ...boundary.journeyDecisionProof.last } : null,
    },
  };
}

export function cloneOpeningLeadSourceDecisionTrail(
  trail: OverworldOpeningLeadSourceDecisionTrail,
): OverworldOpeningLeadSourceDecisionTrail {
  return {
    ...trail,
    decisions: trail.decisions.map((decision) => ({ ...decision })),
  };
}

export type OverworldJournalEntry = {
  id: string;
  kind:
    | "area"
    | "ally"
    | "ally_offer"
    | "campaign"
    | "contact"
    | "event"
    | "job"
    | "lead_source"
    | "lead_source_offer"
    | "preparation"
    | "preparation_offer"
    | "relief_allocation"
    | "relief_allocation_offer"
    | "relief_oath"
    | "relief_oath_offer"
    | "poi"
    | "quest"
    | "quest_done"
    | "registration"
    | "registration_offer"
    | "regional_arc"
    | "resolution"
    | "road"
    | "service"
    | "site";
  town: string;
  title: string;
  text: string;
  recordedAt: string;
  questStartProof?: OverworldQuestStartProof | undefined;
  localSceneProof?: OverworldLocalSceneProof | undefined;
  questCompletionEndingId?: string | undefined;
  questCompletionBoundary?: OverworldJournalDecisionBoundary | undefined;
  registrationBoundary?: OverworldJournalDecisionBoundary | undefined;
  serviceBoundary?: OverworldJournalDecisionBoundary | undefined;
  serviceRuleId?: string | undefined;
  serviceAreaId?: string | undefined;
  storyChoiceBoundary?: OverworldJournalDecisionBoundary | undefined;
};

const OverworldJournalRegistrationBoundarySchema = z
  .object({
    acceptedDecisions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    decisionProofHash: z.string().regex(/^[0-9a-f]{64}$/),
    townId: z.string().min(1),
    areaId: z.string().min(1),
    minutes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

const QuestDispatchLaunchSealSlotSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("selected"), optionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("declined_at_launch") }).strict(),
]);

const QuestDispatchLaunchSealSchema = z
  .object({
    schemaVersion: z.literal(1),
    questId: z.literal("wolf_winter"),
    approachId: z.string().min(1),
    status: z.enum(["on_time", "delayed"]),
    ledgerMinutes: z.number().int().nonnegative().safe(),
    windowProofHash: z.string().regex(/^[0-9a-f]{64}$/),
    slots: z
      .object({
        preparation: QuestDispatchLaunchSealSlotSchema,
        reliefAllocation: QuestDispatchLaunchSealSlotSchema,
        fieldTeam: QuestDispatchLaunchSealSlotSchema,
      })
      .strict(),
    launchBoundary: OverworldJournalRegistrationBoundarySchema,
    proofHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const OverworldQuestStartProofSchema = z
  .object({
    kind: z.literal("approach"),
    approachId: z.string().min(1),
    boundary: OverworldJournalRegistrationBoundarySchema,
    dispatchSeal: QuestDispatchLaunchSealSchema.optional(),
  })
  .strict();

const OverworldLocalSceneProofSchema = z
  .object({
    sceneId: z.string().min(1),
    optionId: z.string().min(1),
    boundary: OverworldJournalRegistrationBoundarySchema,
  })
  .strict();

/** Exact proof envelope emitted by the v10 writer before hash-keyed authority was retired. */
const OverworldQuestStartProofV10Schema = z.discriminatedUnion("kind", [
  OverworldQuestStartProofSchema,
  z
    .object({
      kind: z.literal("legacy"),
      sourceWorldHash: z.string().regex(/^[0-9a-f]{64}$/),
      boundary: OverworldJournalRegistrationBoundarySchema,
    })
    .strict(),
]);

const OverworldLocalSceneProofV10Schema = z
  .object({
    sceneId: z.string().min(1),
    optionId: z.string().min(1),
    sourceWorldHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    boundary: OverworldJournalRegistrationBoundarySchema.optional(),
  })
  .strict();

const OverworldOpeningLeadSourceDecisionTrailSchema = z
  .object({
    anchorId: z.string().min(1),
    baseAcceptedDecisions: z.number().int().nonnegative().safe(),
    baseDecisionProofHash: z.string().regex(/^[0-9a-f]{64}$/),
    decisions: z.array(JourneyDecisionProofLastSchema),
  })
  .strict();

const OverworldJournalEntrySchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum([
      "area",
      "ally",
      "ally_offer",
      "campaign",
      "contact",
      "event",
      "job",
      "lead_source",
      "lead_source_offer",
      "preparation",
      "preparation_offer",
      "relief_allocation",
      "relief_allocation_offer",
      "relief_oath",
      "relief_oath_offer",
      "poi",
      "quest",
      "quest_done",
      "registration",
      "registration_offer",
      "regional_arc",
      "resolution",
      "road",
      "service",
      "site",
    ]),
    town: z.string().min(1),
    title: z.string().min(1),
    text: z.string().min(1),
    recordedAt: z.string().min(1),
    questStartProof: OverworldQuestStartProofSchema.optional(),
    localSceneProof: OverworldLocalSceneProofSchema.optional(),
    questCompletionEndingId: z.string().min(1).optional(),
    questCompletionBoundary: OverworldJournalRegistrationBoundarySchema.optional(),
    registrationBoundary: OverworldJournalRegistrationBoundarySchema.optional(),
    serviceBoundary: OverworldJournalRegistrationBoundarySchema.optional(),
    serviceRuleId: z.string().min(1).optional(),
    serviceAreaId: z.string().min(1).optional(),
    storyChoiceBoundary: OverworldJournalRegistrationBoundarySchema.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const hasRuleId = entry.serviceRuleId !== undefined;
    const hasAreaId = entry.serviceAreaId !== undefined;
    if (hasRuleId !== hasAreaId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Service journal proof must include both serviceRuleId and serviceAreaId.",
      });
    }
    const hasServiceProof = hasRuleId || hasAreaId;
    if (hasServiceProof && entry.kind !== "service") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Service journal proof is only valid on service entries.",
      });
    }
    if (hasServiceProof !== (entry.serviceBoundary !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Campaign service journal proof must include its serviceBoundary.",
      });
    }
    if (entry.questCompletionBoundary !== undefined && entry.kind !== "quest_done") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Quest completion boundaries are only valid on quest_done entries.",
      });
    }
    if (entry.questCompletionEndingId !== undefined && entry.kind !== "quest_done") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Quest completion ending IDs are only valid on quest_done entries.",
      });
    }
    if (entry.questStartProof !== undefined && entry.kind !== "quest") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Quest-start proofs are only valid on quest entries.",
      });
    }
    if (
      entry.localSceneProof !== undefined &&
      entry.kind !== "job" &&
      entry.kind !== "resolution"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Local-scene proofs are only valid on job or resolution entries.",
      });
    }
  });

const OVERWORLD_V10_LEGACY_JOURNAL_KINDS = [
  "ally_legacy",
  "lead_source_legacy",
  "preparation_legacy",
  "registration_legacy",
  "relief_allocation_legacy",
  "relief_oath_legacy",
] as const;

const OverworldJournalEntryV10Schema = z
  .object({
    id: z.string().min(1),
    kind: z.enum([
      "area",
      "ally",
      "ally_legacy",
      "ally_offer",
      "campaign",
      "contact",
      "event",
      "job",
      "lead_source",
      "lead_source_legacy",
      "lead_source_offer",
      "preparation",
      "preparation_legacy",
      "preparation_offer",
      "relief_allocation",
      "relief_allocation_legacy",
      "relief_allocation_offer",
      "relief_oath",
      "relief_oath_legacy",
      "relief_oath_offer",
      "poi",
      "quest",
      "quest_done",
      "registration",
      "registration_legacy",
      "registration_offer",
      "regional_arc",
      "resolution",
      "road",
      "service",
      "site",
    ]),
    town: z.string().min(1),
    title: z.string().min(1),
    text: z.string().min(1),
    recordedAt: z.string().min(1),
    questStartProof: OverworldQuestStartProofV10Schema.optional(),
    localSceneProof: OverworldLocalSceneProofV10Schema.optional(),
    questCompletionBoundary: OverworldJournalRegistrationBoundarySchema.optional(),
    registrationBoundary: OverworldJournalRegistrationBoundarySchema.optional(),
    serviceBoundary: OverworldJournalRegistrationBoundarySchema.optional(),
    serviceRuleId: z.string().min(1).optional(),
    serviceAreaId: z.string().min(1).optional(),
    sourceWorldHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    storyChoiceBoundary: OverworldJournalRegistrationBoundarySchema.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const hasRuleId = entry.serviceRuleId !== undefined;
    const hasAreaId = entry.serviceAreaId !== undefined;
    if (hasRuleId !== hasAreaId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Service journal proof must include both serviceRuleId and serviceAreaId.",
      });
    }
    const hasServiceProof = hasRuleId || hasAreaId;
    if (hasServiceProof && entry.kind !== "service") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Service journal proof is only valid on service entries.",
      });
    }
    if (hasServiceProof !== (entry.serviceBoundary !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Campaign service journal proof must include its serviceBoundary.",
      });
    }
    if (entry.questCompletionBoundary !== undefined && entry.kind !== "quest_done") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Quest completion boundaries are only valid on quest_done entries.",
      });
    }
    if (entry.questStartProof !== undefined && entry.kind !== "quest") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Quest-start proofs are only valid on quest entries.",
      });
    }
    if (
      entry.localSceneProof !== undefined &&
      entry.kind !== "job" &&
      entry.kind !== "resolution"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Local-scene proofs are only valid on job or resolution entries.",
      });
    }
    if (
      entry.localSceneProof !== undefined &&
      entry.localSceneProof.boundary === undefined &&
      entry.localSceneProof.sourceWorldHash === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "A serialized local-scene proof requires its accepted-decision boundary or v10 source-world provenance.",
      });
    }
    if (
      entry.sourceWorldHash !== undefined &&
      entry.kind !== "preparation" &&
      entry.kind !== "preparation_offer" &&
      entry.kind !== "event" &&
      entry.kind !== "contact"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "V10 source-world provenance is only valid on preparation, event, or contact evidence.",
      });
    }
  });

const OverworldSessionSnapshotBaseSchema = z
  .object({
    version: z.literal(OVERWORLD_SESSION_PREVIOUS_SAVE_VERSION),
    worldId: z.string().min(1),
    worldHash: z.string().regex(/^[0-9a-f]{64}$/),
    currentId: z.string().min(1),
    currentAreaId: z.string().min(1).nullable(),
    minutes: SAFE_NONNEGATIVE_INT,
    supplies: z.number().int().min(0).max(MAX_SUPPLIES),
    fatigue: z.number().int().min(0).max(MAX_FATIGUE),
    discoveredIds: z.array(z.string().min(1)),
    visitedIds: z.array(z.string().min(1)),
    currentAreaByTown: z.array(z.tuple([z.string().min(1), z.string().min(1)])),
    travelLog: z.array(TravelLogEntrySnapshotSchema),
    journalEntries: z.array(OverworldJournalEntrySchema),
    resolvedEventIds: z.array(z.string().min(1)),
    discoveredAreaIds: z.array(z.string().min(1)),
    visitedAreaIds: z.array(z.string().min(1)),
    discoveredJobIds: z.array(z.string().min(1)),
    completedJobIds: z.array(z.string().min(1)),
    discoveredSiteIds: z.array(z.string().min(1)),
    discoveredQuestIds: z.array(z.string().min(1)),
    startedQuestIds: z.array(z.string().min(1)),
    completedQuestIds: z.array(z.string().min(1)),
    questOutcomes: z.array(z.tuple([z.string().min(1), z.string().min(1)])),
    exploredSiteIds: z.array(z.string().min(1)),
    regionRenown: z.array(z.tuple([z.string().min(1), SAFE_NONNEGATIVE_INT])),
    completedRegionalArcIds: z.array(z.string().min(1)),
    pendingRoadEncounter: OverworldPendingRoadEncounterSnapshotSchema.nullable(),
    journey: JourneyContractSnapshotSchema,
    character: CampaignCharacterStateSchema,
    openingLeadSourceDecisionTrail: OverworldOpeningLeadSourceDecisionTrailSchema.optional(),
    questCharacterDeathBoundary: OverworldQuestCharacterDeathBoundarySchema.optional(),
    inspectedStoryReveals: z
      .array(z.tuple([z.string().min(1), z.array(z.string().min(1)).min(1)]))
      .optional(),
  })
  .strict();

/** The immediately previous structural shape; upgraded without content rewrites. */
export const OverworldSessionSnapshotV10Schema = OverworldSessionSnapshotBaseSchema.extend({
  journalEntries: z.array(OverworldJournalEntryV10Schema),
}).strict();

export const OverworldSessionSnapshotSchema = OverworldSessionSnapshotBaseSchema.extend({
  version: z.literal(OVERWORLD_SESSION_SAVE_VERSION),
  stationDispatchSupportReveals: z
    .array(z.tuple([z.string().min(1), z.string().min(1)]))
    .optional(),
})
  .strict()
  .superRefine((snapshot, ctx) => {
    const questOutcomes = new Map(snapshot.questOutcomes);
    for (let index = 0; index < snapshot.journalEntries.length; index += 1) {
      const entry = snapshot.journalEntries[index]!;
      if (entry.kind !== "quest_done" || !entry.id.startsWith("quest_done:")) continue;
      const questId = entry.id.slice("quest_done:".length);
      const expectedEndingId = questOutcomes.get(questId);
      if (expectedEndingId === undefined || entry.questCompletionEndingId !== expectedEndingId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["journalEntries", index, "questCompletionEndingId"],
          message: `Quest outcome "${questId}" is not bound to its canonical completion journal.`,
        });
      }
    }
    const pendingDeath =
      snapshot.journey.pendingChoice?.reasons.includes("character_died") === true;
    const finalDeath =
      snapshot.journey.retentionHistory.at(-1)?.reasons.includes("character_died") === true;
    const hasDeath = pendingDeath || finalDeath;
    if (hasDeath && snapshot.questCharacterDeathBoundary === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questCharacterDeathBoundary"],
        message: "A character-death journey requires its quest death boundary.",
      });
    } else if (!hasDeath && snapshot.questCharacterDeathBoundary !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questCharacterDeathBoundary"],
        message: "A quest death boundary is forbidden without a character-death journey.",
      });
    }
  });

export type OverworldSessionSnapshotV10 = z.infer<typeof OverworldSessionSnapshotV10Schema>;
export type OverworldSessionSnapshot = z.infer<typeof OverworldSessionSnapshotSchema>;

const OverworldSessionSnapshotVersionSchema = z.object({ version: z.number().int() }).passthrough();

function upgradeV10JournalEntry(
  entry: OverworldSessionSnapshotV10["journalEntries"][number],
  questOutcomes: ReadonlyMap<string, string>,
): OverworldJournalEntry {
  if ((OVERWORLD_V10_LEGACY_JOURNAL_KINDS as readonly string[]).includes(entry.kind)) {
    throw new Error(
      `V10 journal entry "${entry.id}" uses legacy kind "${entry.kind}", which cannot be structurally upgraded without retired hash-keyed authority.`,
    );
  }
  if (entry.questStartProof?.kind === "legacy") {
    throw new Error(
      `V10 quest-start entry "${entry.id}" has no structural approach ID and cannot be upgraded without retired hash-keyed authority.`,
    );
  }
  if (entry.localSceneProof && !entry.localSceneProof.boundary) {
    throw new Error(
      `V10 local-scene entry "${entry.id}" has no causal decision boundary and cannot be structurally upgraded from source-world provenance alone.`,
    );
  }

  const {
    kind: previousKind,
    localSceneProof,
    questStartProof,
    sourceWorldHash: _sourceWorldHash,
    ...stored
  } = entry;
  const kind = previousKind as OverworldJournalEntry["kind"];
  let questCompletionEndingId: string | undefined;
  if (kind === "quest_done") {
    const questId = entry.id.startsWith("quest_done:") ? entry.id.slice("quest_done:".length) : "";
    questCompletionEndingId = questOutcomes.get(questId);
    if (!questCompletionEndingId) {
      throw new Error(
        `V10 quest-completion entry "${entry.id}" has no matching structural quest outcome ID.`,
      );
    }
  }

  return {
    ...stored,
    kind,
    ...(questStartProof
      ? {
          questStartProof: {
            ...questStartProof,
            boundary: { ...questStartProof.boundary },
          },
        }
      : {}),
    ...(localSceneProof
      ? {
          localSceneProof: {
            sceneId: localSceneProof.sceneId,
            optionId: localSceneProof.optionId,
            boundary: { ...localSceneProof.boundary! },
          },
        }
      : {}),
    ...(questCompletionEndingId ? { questCompletionEndingId } : {}),
  };
}

/** Parse current saves and perform the single supported structural upgrade. */
export function parseOverworldSessionSnapshot(raw: unknown): OverworldSessionSnapshot {
  const { version } = OverworldSessionSnapshotVersionSchema.parse(raw);
  if (version === OVERWORLD_SESSION_PREVIOUS_SAVE_VERSION) {
    const previous = OverworldSessionSnapshotV10Schema.parse(raw);
    const questOutcomes = new Map(previous.questOutcomes);
    return OverworldSessionSnapshotSchema.parse({
      ...previous,
      version: OVERWORLD_SESSION_SAVE_VERSION,
      journalEntries: previous.journalEntries.map((entry) =>
        upgradeV10JournalEntry(entry, questOutcomes),
      ),
    });
  }
  if (version === OVERWORLD_SESSION_SAVE_VERSION) {
    return OverworldSessionSnapshotSchema.parse(raw);
  }
  throw new Error(
    `Unsupported overworld session snapshot version ${String(version)}; expected ${String(OVERWORLD_SESSION_PREVIOUS_SAVE_VERSION)} or ${String(OVERWORLD_SESSION_SAVE_VERSION)}.`,
  );
}

export function cloneJournalEntries<T extends OverworldJournalEntry>(entries: readonly T[]): T[] {
  const clones: T[] = [];
  for (const entry of entries) clones.push(cloneOverworldJournalEntry(entry) as T);
  return clones;
}

export function cloneOverworldJournalEntry(entry: OverworldJournalEntry): OverworldJournalEntry {
  return {
    ...entry,
    ...(entry.questStartProof
      ? {
          questStartProof: {
            kind: "approach" as const,
            approachId: entry.questStartProof.approachId,
            boundary: { ...entry.questStartProof.boundary },
            ...(entry.questStartProof.dispatchSeal
              ? {
                  dispatchSeal: {
                    ...entry.questStartProof.dispatchSeal,
                    slots: {
                      preparation: {
                        ...entry.questStartProof.dispatchSeal.slots.preparation,
                      },
                      reliefAllocation: {
                        ...entry.questStartProof.dispatchSeal.slots.reliefAllocation,
                      },
                      fieldTeam: { ...entry.questStartProof.dispatchSeal.slots.fieldTeam },
                    },
                    launchBoundary: {
                      ...entry.questStartProof.dispatchSeal.launchBoundary,
                    },
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(entry.localSceneProof
      ? {
          localSceneProof: {
            sceneId: entry.localSceneProof.sceneId,
            optionId: entry.localSceneProof.optionId,
            ...(entry.localSceneProof.boundary
              ? { boundary: { ...entry.localSceneProof.boundary } }
              : {}),
          },
        }
      : {}),
    ...(entry.questCompletionBoundary
      ? { questCompletionBoundary: { ...entry.questCompletionBoundary } }
      : {}),
    ...(entry.registrationBoundary
      ? { registrationBoundary: { ...entry.registrationBoundary } }
      : {}),
    ...(entry.serviceBoundary ? { serviceBoundary: { ...entry.serviceBoundary } } : {}),
    ...(entry.storyChoiceBoundary ? { storyChoiceBoundary: { ...entry.storyChoiceBoundary } } : {}),
  };
}

export function redactOverworldJournalEntryForPresentation(
  entry: OverworldJournalEntry,
): OverworldJournalEntry {
  const {
    questStartProof: _questStartProof,
    localSceneProof: _localSceneProof,
    questCompletionEndingId: _questCompletionEndingId,
    questCompletionBoundary: _questCompletionBoundary,
    registrationBoundary: _registrationBoundary,
    serviceBoundary: _serviceBoundary,
    serviceRuleId: _serviceRuleId,
    serviceAreaId: _serviceAreaId,
    storyChoiceBoundary: _storyChoiceBoundary,
    ...presented
  } = entry;
  return presented;
}

function cloneTravelLogSnapshots(
  entries: readonly TravelLogEntrySnapshot[],
): TravelLogEntrySnapshot[] {
  const clones: TravelLogEntrySnapshot[] = [];
  for (const entry of entries) clones.push({ ...entry });
  return clones;
}

function cloneStringTuples(values: readonly (readonly [string, string])[]): [string, string][] {
  const clones: [string, string][] = [];
  for (const [left, right] of values) clones.push([left, right]);
  return clones;
}

function cloneNumberTuples(values: readonly (readonly [string, number])[]): [string, number][] {
  const clones: [string, number][] = [];
  for (const [left, right] of values) clones.push([left, right]);
  return clones;
}

function cloneStringArrayTuples(
  values: readonly (readonly [string, readonly string[]])[],
): [string, string[]][] {
  const clones: [string, string[]][] = [];
  for (const [key, entries] of values) clones.push([key, [...entries]]);
  return clones;
}

export function cloneOverworldSessionSnapshot(
  snapshot: OverworldSessionSnapshot,
): OverworldSessionSnapshot {
  return {
    ...snapshot,
    character: cloneCampaignCharacterState(snapshot.character),
    discoveredIds: [...snapshot.discoveredIds],
    visitedIds: [...snapshot.visitedIds],
    currentAreaByTown: cloneStringTuples(snapshot.currentAreaByTown),
    travelLog: cloneTravelLogSnapshots(snapshot.travelLog),
    journalEntries: cloneJournalEntries(snapshot.journalEntries),
    resolvedEventIds: [...snapshot.resolvedEventIds],
    discoveredAreaIds: [...snapshot.discoveredAreaIds],
    visitedAreaIds: [...snapshot.visitedAreaIds],
    discoveredJobIds: [...snapshot.discoveredJobIds],
    completedJobIds: [...snapshot.completedJobIds],
    discoveredSiteIds: [...snapshot.discoveredSiteIds],
    discoveredQuestIds: [...snapshot.discoveredQuestIds],
    startedQuestIds: [...snapshot.startedQuestIds],
    completedQuestIds: [...snapshot.completedQuestIds],
    questOutcomes: cloneStringTuples(snapshot.questOutcomes),
    exploredSiteIds: [...snapshot.exploredSiteIds],
    regionRenown: cloneNumberTuples(snapshot.regionRenown),
    completedRegionalArcIds: [...snapshot.completedRegionalArcIds],
    ...(snapshot.inspectedStoryReveals
      ? { inspectedStoryReveals: cloneStringArrayTuples(snapshot.inspectedStoryReveals) }
      : {}),
    ...(snapshot.stationDispatchSupportReveals
      ? { stationDispatchSupportReveals: cloneStringTuples(snapshot.stationDispatchSupportReveals) }
      : {}),
    pendingRoadEncounter: snapshot.pendingRoadEncounter
      ? { ...snapshot.pendingRoadEncounter }
      : null,
    ...(snapshot.openingLeadSourceDecisionTrail
      ? {
          openingLeadSourceDecisionTrail: cloneOpeningLeadSourceDecisionTrail(
            snapshot.openingLeadSourceDecisionTrail,
          ),
        }
      : {}),
    ...(snapshot.questCharacterDeathBoundary
      ? {
          questCharacterDeathBoundary: cloneQuestCharacterDeathBoundary(
            snapshot.questCharacterDeathBoundary,
          ),
        }
      : {}),
    journey: cloneJourneyContractSnapshot(snapshot.journey),
  };
}

export function snapshotTravelLogEntry(entry: TravelLogEntry): TravelLogEntrySnapshot {
  return {
    edgeId: entry.edgeId,
    fromId: entry.fromId,
    toId: entry.toId,
    roadEventId: entry.roadEvent?.id ?? null,
    delayMinutes: entry.delayMinutes,
    minutes: entry.minutes,
    arrivedAt: entry.arrivedAt,
    suppliesUsed: entry.suppliesUsed,
    suppliesAfter: entry.suppliesAfter,
    fatigueGained: entry.fatigueGained,
    fatigueAfter: entry.fatigueAfter,
  };
}

export function snapshotTravelLogEntries(
  entries: readonly TravelLogEntry[],
): TravelLogEntrySnapshot[] {
  const snapshots: TravelLogEntrySnapshot[] = [];
  for (const entry of entries) snapshots.push(snapshotTravelLogEntry(entry));
  return snapshots;
}
