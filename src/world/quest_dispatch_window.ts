import { hashState } from "../core/hash.js";
import { WOLF_WINTER_DISPATCH_ON_TIME_MAX_MINUTES } from "../core/embedded_launch_overlay_receipt.js";
import type { OpeningAlly } from "./opening_ally.js";
import { proveOpeningAllyJournal } from "./opening_ally_journal.js";
import type { OpeningLeadSource } from "./opening_lead_source.js";
import { proveOpeningLeadSourceJournal } from "./opening_lead_source_journal.js";
import { openingPreparationTerms, type OpeningPreparation } from "./opening_preparation.js";
import { proveOpeningPreparationJournal } from "./opening_preparation_journal.js";
import type { OpeningRegistration } from "./opening_registration.js";
import { proveOpeningRegistrationJournal } from "./opening_registration_journal.js";
import type { OpeningReliefAllocation } from "./opening_relief_allocation.js";
import { proveOpeningReliefAllocationJournal } from "./opening_relief_allocation_journal.js";
import type { OpeningReliefOath } from "./opening_relief_oath.js";
import { proveOpeningReliefOathJournal } from "./opening_relief_oath_journal.js";
import type {
  OverworldJournalDecisionBoundary,
  OverworldJournalEntry,
} from "./session_snapshot.js";

export const QUEST_DISPATCH_WINDOW_SCHEMA_VERSION = 2 as const;
export const QUEST_DISPATCH_LAUNCH_SEAL_SCHEMA_VERSION = 1 as const;
export const WOLF_WINTER_DISPATCH_WINDOW_QUEST_ID = "wolf_winter" as const;

export type QuestDispatchWindowBoundary = Readonly<{
  acceptedDecisions: number;
  decisionProofHash: string;
  townId: string;
  areaId: string;
  minutes: number;
}>;

type SelectedPreparationReceipt = Readonly<{
  kind: "selected";
  profileId: string;
  journalId: string;
  minutes: number;
  boundary: QuestDispatchWindowBoundary;
}>;

type SelectedOptionReceipt = Readonly<{
  kind: "selected";
  optionId: string;
  journalId: string;
  minutes: number;
  boundary: QuestDispatchWindowBoundary;
}>;

type OpenOptionalReceipt = Readonly<{
  kind: "open_optional";
  minutes: 0;
}>;

type DeclinedAtLaunchReceipt = Readonly<{
  kind: "declined_at_launch";
  minutes: 0;
}>;

export type QuestDispatchWindowReceipt = Readonly<{
  reliefOath: Readonly<{
    optionId: string;
    journalId: string;
    minutes: number;
    boundary: QuestDispatchWindowBoundary;
  }>;
  leadSource: Readonly<{
    optionId: string;
    journalId: string;
    minutes: number;
    boundary: QuestDispatchWindowBoundary;
  }>;
  preparation: SelectedPreparationReceipt | DeclinedAtLaunchReceipt;
  reliefAllocation: SelectedOptionReceipt | DeclinedAtLaunchReceipt;
  juneCommitment: SelectedOptionReceipt | DeclinedAtLaunchReceipt;
}>;

type QuestDispatchPresentationReceipt = Readonly<{
  reliefOath: QuestDispatchWindowReceipt["reliefOath"];
  leadSource: QuestDispatchWindowReceipt["leadSource"];
  preparation: SelectedPreparationReceipt | OpenOptionalReceipt;
  reliefAllocation: SelectedOptionReceipt | OpenOptionalReceipt;
  juneCommitment: SelectedOptionReceipt | OpenOptionalReceipt;
}>;

/**
 * A frozen, proof-carrying classification for the Wolf-Winter launch. It is a
 * ledger of departure choices only; clock time, exploration, work, travel and
 * the hill approach remain separate. Every unselected optional support becomes
 * an explicit decline only when a caller prepares an actual launch.
 */
export type QuestDispatchWindow = Readonly<{
  schemaVersion: typeof QUEST_DISPATCH_WINDOW_SCHEMA_VERSION;
  questId: string;
  status: "on_time" | "delayed" | "legacy_neutral";
  ledgerMinutes?: number;
  receipt?: QuestDispatchWindowReceipt;
  proofHash: string;
}>;

export type OpenQuestDispatchPresentation = Readonly<{
  schemaVersion: typeof QUEST_DISPATCH_WINDOW_SCHEMA_VERSION;
  questId: string;
  status: "support_choices_open";
  committedMinutes: number;
  finalMinutes: Readonly<{ minimum: number; maximum: number }>;
  receipt: QuestDispatchPresentationReceipt;
  proofHash: string;
}>;

export type QuestDispatchPresentationWindow = QuestDispatchWindow | OpenQuestDispatchPresentation;

type QuestDispatchWindowInputs = Readonly<{
  questId: string;
  journalEntries?: readonly OverworldJournalEntry[];
  openingRegistration?: OpeningRegistration | null;
  openingReliefOath?: OpeningReliefOath | null;
  openingLeadSource?: OpeningLeadSource | null;
  openingPreparation?: OpeningPreparation | null;
  openingReliefAllocation?: OpeningReliefAllocation | null;
  openingAlly?: OpeningAlly | null;
}>;

export type QuestDispatchLaunchSealSlot = Readonly<
  { kind: "selected"; optionId: string } | { kind: "declined_at_launch" }
>;

/** Durable compact proof attached to the actual quest-start journal boundary. */
export type QuestDispatchLaunchSeal = Readonly<{
  schemaVersion: typeof QUEST_DISPATCH_LAUNCH_SEAL_SCHEMA_VERSION;
  questId: typeof WOLF_WINTER_DISPATCH_WINDOW_QUEST_ID;
  approachId: string;
  status: "on_time" | "delayed";
  ledgerMinutes: number;
  windowProofHash: string;
  slots: Readonly<{
    preparation: QuestDispatchLaunchSealSlot;
    reliefAllocation: QuestDispatchLaunchSealSlot;
    fieldTeam: QuestDispatchLaunchSealSlot;
  }>;
  launchBoundary: QuestDispatchWindowBoundary;
  proofHash: string;
}>;

type AuthenticatedDispatchState = Readonly<{
  questId: string;
  committedMinutes: number;
  maximumRemainingMinutes: number;
  receipt: QuestDispatchPresentationReceipt;
}>;

function freezeBoundary(boundary: OverworldJournalDecisionBoundary): QuestDispatchWindowBoundary {
  return Object.freeze({ ...boundary });
}

function neutralWindow(questId: string): QuestDispatchWindow {
  const proofHash = hashState({
    schemaVersion: QUEST_DISPATCH_WINDOW_SCHEMA_VERSION,
    questId,
    status: "legacy_neutral" as const,
  });
  return Object.freeze({
    schemaVersion: QUEST_DISPATCH_WINDOW_SCHEMA_VERSION,
    questId,
    status: "legacy_neutral",
    proofHash,
  });
}

/** The one dispatch threshold used by launch authority and read-only projections. */
export function classifyQuestDispatchMinutes(ledgerMinutes: number): "on_time" | "delayed" {
  return ledgerMinutes <= WOLF_WINTER_DISPATCH_ON_TIME_MAX_MINUTES ? "on_time" : "delayed";
}

function currentScenesForQuest(args: QuestDispatchWindowInputs): boolean {
  return (
    args.openingRegistration !== null &&
    args.openingRegistration !== undefined &&
    args.openingReliefOath?.target_quest === args.questId &&
    args.openingLeadSource?.target_quest === args.questId &&
    args.openingPreparation?.target_quest === args.questId &&
    args.openingReliefAllocation?.target_quest === args.questId &&
    args.openingAlly?.target_quest === args.questId
  );
}

function selectedOptionSealSlot(
  receipt: SelectedOptionReceipt | DeclinedAtLaunchReceipt,
): QuestDispatchLaunchSealSlot {
  return receipt.kind === "selected"
    ? Object.freeze({ kind: "selected", optionId: receipt.optionId })
    : Object.freeze({ kind: "declined_at_launch" });
}

function authenticatedDispatchState(
  args: QuestDispatchWindowInputs,
): AuthenticatedDispatchState | null {
  if (
    args.questId !== WOLF_WINTER_DISPATCH_WINDOW_QUEST_ID ||
    !args.journalEntries ||
    !currentScenesForQuest(args)
  ) {
    return null;
  }

  const registrationProof = proveOpeningRegistrationJournal({
    registration: args.openingRegistration!,
    journalEntries: args.journalEntries,
    expectedTown: null,
  });
  if (!registrationProof.profile) return null;

  const reliefOathProof = proveOpeningReliefOathJournal({
    scene: args.openingReliefOath!,
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
    scene: args.openingLeadSource!,
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
    scene: args.openingPreparation!,
    leadSourceProof,
    journalEntries: args.journalEntries,
    expectedTown: null,
  });

  const reliefAllocationProof = proveOpeningReliefAllocationJournal({
    scene: args.openingReliefAllocation!,
    preparationProof,
    leadSourceProof,
    preparationScene: args.openingPreparation!,
    journalEntries: args.journalEntries,
    expectedTown: null,
  });

  const allyProof = proveOpeningAllyJournal({
    scene: args.openingAlly!,
    preparationProof,
    reliefAllocationProof,
    leadSourceProof,
    preparationScene: args.openingPreparation!,
    reliefAllocationScene: args.openingReliefAllocation!,
    journalEntries: args.journalEntries,
    expectedTown: null,
  });

  const preparation =
    preparationProof.profile &&
    preparationProof.terms &&
    preparationProof.selectionBoundary &&
    preparationProof.journalIndex !== null
      ? Object.freeze({
          kind: "selected" as const,
          profileId: preparationProof.profile.id,
          journalId: args.journalEntries[preparationProof.journalIndex]!.id,
          minutes: preparationProof.terms.minutes,
          boundary: freezeBoundary(preparationProof.selectionBoundary),
        })
      : Object.freeze({ kind: "open_optional" as const, minutes: 0 as const });
  if (preparationProof.profile && preparation.kind !== "selected") return null;

  const reliefAllocation =
    reliefAllocationProof.option &&
    reliefAllocationProof.terms &&
    reliefAllocationProof.selectionBoundary &&
    reliefAllocationProof.journalIndex !== null
      ? Object.freeze({
          kind: "selected" as const,
          optionId: reliefAllocationProof.option.id,
          journalId: args.journalEntries[reliefAllocationProof.journalIndex]!.id,
          minutes: reliefAllocationProof.terms.minutes,
          boundary: freezeBoundary(reliefAllocationProof.selectionBoundary),
        })
      : Object.freeze({ kind: "open_optional" as const, minutes: 0 as const });
  if (reliefAllocationProof.option && reliefAllocation.kind !== "selected") return null;

  const juneCommitment =
    allyProof.option &&
    allyProof.terms &&
    allyProof.selectionBoundary &&
    allyProof.journalIndex !== null
      ? Object.freeze({
          kind: "selected" as const,
          optionId: allyProof.option.id,
          journalId: args.journalEntries[allyProof.journalIndex]!.id,
          minutes: allyProof.terms.minutes,
          boundary: freezeBoundary(allyProof.selectionBoundary),
        })
      : Object.freeze({ kind: "open_optional" as const, minutes: 0 as const });
  if (allyProof.option && juneCommitment.kind !== "selected") return null;

  const receipt: QuestDispatchPresentationReceipt = Object.freeze({
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
    preparation,
    reliefAllocation,
    juneCommitment,
  });
  const committedMinutes =
    receipt.reliefOath.minutes +
    receipt.leadSource.minutes +
    receipt.preparation.minutes +
    receipt.reliefAllocation.minutes +
    receipt.juneCommitment.minutes;
  const maximumRemainingMinutes =
    (receipt.preparation.kind === "open_optional"
      ? Math.max(
          0,
          ...args.openingPreparation!.profiles.map(
            (profile) =>
              openingPreparationTerms(profile, leadSourceProof.characterAfterSource).minutes,
          ),
        )
      : 0) +
    (receipt.reliefAllocation.kind === "open_optional"
      ? Math.max(0, ...args.openingReliefAllocation!.options.map((option) => option.terms.minutes))
      : 0) +
    (receipt.juneCommitment.kind === "open_optional"
      ? Math.max(0, ...args.openingAlly!.options.map((option) => option.terms.minutes))
      : 0);
  return Object.freeze({
    questId: args.questId,
    committedMinutes,
    maximumRemainingMinutes,
    receipt,
  });
}

function finalReceipt(receipt: QuestDispatchPresentationReceipt): QuestDispatchWindowReceipt {
  const decline = (): DeclinedAtLaunchReceipt =>
    Object.freeze({ kind: "declined_at_launch", minutes: 0 as const });
  return Object.freeze({
    reliefOath: receipt.reliefOath,
    leadSource: receipt.leadSource,
    preparation: receipt.preparation.kind === "selected" ? receipt.preparation : decline(),
    reliefAllocation:
      receipt.reliefAllocation.kind === "selected" ? receipt.reliefAllocation : decline(),
    juneCommitment: receipt.juneCommitment.kind === "selected" ? receipt.juneCommitment : decline(),
  });
}

function finalWindow(state: AuthenticatedDispatchState): QuestDispatchWindow {
  const receipt = finalReceipt(state.receipt);
  const ledgerMinutes = state.committedMinutes;
  const status = classifyQuestDispatchMinutes(ledgerMinutes);
  const proofHash = hashState({
    schemaVersion: QUEST_DISPATCH_WINDOW_SCHEMA_VERSION,
    questId: state.questId,
    status,
    ledgerMinutes,
    receipt,
  });
  return Object.freeze({
    schemaVersion: QUEST_DISPATCH_WINDOW_SCHEMA_VERSION,
    questId: state.questId,
    status,
    ledgerMinutes,
    receipt,
    proofHash,
  });
}

/** Player-facing timing keeps unresolved support visibly open until launch. */
export function deriveQuestDispatchPresentationWindow(
  args: QuestDispatchWindowInputs,
): QuestDispatchPresentationWindow {
  try {
    const state = authenticatedDispatchState(args);
    if (!state) return neutralWindow(args.questId);
    const hasOpenSupport =
      state.receipt.preparation.kind === "open_optional" ||
      state.receipt.reliefAllocation.kind === "open_optional" ||
      state.receipt.juneCommitment.kind === "open_optional";
    if (!hasOpenSupport) return finalWindow(state);
    const finalMinutes = Object.freeze({
      minimum: state.committedMinutes,
      maximum: state.committedMinutes + state.maximumRemainingMinutes,
    });
    const proofHash = hashState({
      schemaVersion: QUEST_DISPATCH_WINDOW_SCHEMA_VERSION,
      questId: state.questId,
      status: "support_choices_open" as const,
      committedMinutes: state.committedMinutes,
      finalMinutes,
      receipt: state.receipt,
    });
    return Object.freeze({
      schemaVersion: QUEST_DISPATCH_WINDOW_SCHEMA_VERSION,
      questId: state.questId,
      status: "support_choices_open",
      committedMinutes: state.committedMinutes,
      finalMinutes,
      receipt: state.receipt,
      proofHash,
    });
  } catch {
    return neutralWindow(args.questId);
  }
}

/** Final quest-launch authority converts every unresolved support into a signed decline. */
export function deriveQuestDispatchWindow(args: QuestDispatchWindowInputs): QuestDispatchWindow {
  try {
    const state = authenticatedDispatchState(args);
    return state ? finalWindow(state) : neutralWindow(args.questId);
  } catch {
    return neutralWindow(args.questId);
  }
}

export function createQuestDispatchLaunchSeal(args: {
  window: QuestDispatchWindow;
  approachId: string;
  launchBoundary: OverworldJournalDecisionBoundary;
}): QuestDispatchLaunchSeal | null {
  const { window } = args;
  if (
    window.questId !== WOLF_WINTER_DISPATCH_WINDOW_QUEST_ID ||
    (window.status !== "on_time" && window.status !== "delayed") ||
    window.ledgerMinutes === undefined ||
    !window.receipt
  ) {
    return null;
  }
  const slots = Object.freeze({
    preparation:
      window.receipt.preparation.kind === "selected"
        ? Object.freeze({
            kind: "selected" as const,
            optionId: window.receipt.preparation.profileId,
          })
        : Object.freeze({ kind: "declined_at_launch" as const }),
    reliefAllocation: selectedOptionSealSlot(window.receipt.reliefAllocation),
    fieldTeam: selectedOptionSealSlot(window.receipt.juneCommitment),
  });
  const launchBoundary = freezeBoundary(args.launchBoundary);
  const proof = {
    schemaVersion: QUEST_DISPATCH_LAUNCH_SEAL_SCHEMA_VERSION,
    questId: WOLF_WINTER_DISPATCH_WINDOW_QUEST_ID,
    approachId: args.approachId,
    status: window.status,
    ledgerMinutes: window.ledgerMinutes,
    windowProofHash: window.proofHash,
    slots,
    launchBoundary,
  } as const;
  return Object.freeze({ ...proof, proofHash: hashState(proof) });
}

export function assertQuestDispatchLaunchSeal(args: {
  seal: QuestDispatchLaunchSeal;
  expectedWindow: QuestDispatchWindow;
  expectedApproachId: string;
  expectedLaunchBoundary: OverworldJournalDecisionBoundary;
}): void {
  const expected = createQuestDispatchLaunchSeal({
    window: args.expectedWindow,
    approachId: args.expectedApproachId,
    launchBoundary: args.expectedLaunchBoundary,
  });
  if (!expected || hashState(expected) !== hashState(args.seal)) {
    throw new Error(
      "Overworld session snapshot quest dispatch seal does not match its selected support, launch boundary, or timing ledger.",
    );
  }
}
