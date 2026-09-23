import {
  deriveQuestDispatchPresentationWindow,
  type QuestDispatchPresentationWindow,
} from "./quest_dispatch_window.js";
import { resolveOpeningDispatchManifestChain } from "./opening_dispatch_briefing.js";
import {
  replayOpeningDispatchChoices,
  type OpeningDispatchReplayChoice,
} from "./opening_dispatch_choice_replay.js";
import { proveOpeningAllyJournal } from "./opening_ally_journal.js";
import { proveOpeningLeadSourceJournal } from "./opening_lead_source_journal.js";
import { proveOpeningPreparationJournal } from "./opening_preparation_journal.js";
import { proveOpeningRegistrationJournal } from "./opening_registration_journal.js";
import { proveOpeningReliefAllocationJournal } from "./opening_relief_allocation_journal.js";
import { proveOpeningReliefOathJournal } from "./opening_relief_oath_journal.js";
import { presentOpeningAlly } from "./opening_ally_presentation.js";
import { presentOpeningLeadSource } from "./opening_lead_source_presentation.js";
import { presentOpeningPreparation } from "./opening_preparation_presentation.js";
import { presentOpeningRegistration } from "./opening_registration_presentation.js";
import { presentOpeningReliefAllocation } from "./opening_relief_allocation_presentation.js";
import { presentOpeningReliefOath } from "./opening_relief_oath_presentation.js";
import type { JourneyStoryChoicePrompt } from "./journey_contract.js";
import type { OverworldManifest } from "./overworld.js";
import type { OverworldJournalEntry } from "./session_snapshot.js";

export const OPENING_DEPARTURE_RECAP_VERSION = 7 as const;
export const OPENING_DEPARTURE_RECAP_FIELD_TERM_CHAR_LIMIT = 120;

export type OpeningDepartureRecapSlot =
  | "role"
  | "duty"
  | "evidence"
  | "preparation"
  | "relief_allocation"
  | "field_team";

export type OpeningDepartureRecapStatus =
  | "selected"
  | "solo_default"
  | "open_optional"
  | "available_after_preparation";

export type OpeningDepartureRecapEntry = Readonly<{
  slot: OpeningDepartureRecapSlot;
  label: string;
  status: OpeningDepartureRecapStatus;
  title: string | null;
  activeFieldTerm: string | null;
}>;

/**
 * A read-only timing line for the authenticated plan currently shown at the
 * Station. "committed" deliberately does not call the plan final: the named
 * optional selections can still change it. Its minutes are exposed only when
 * the canonical dispatch authority has authenticated that partial receipt.
 */
export type OpeningDepartureRecapDispatch = Readonly<{
  state: "committed" | "direct_launch" | "sealed";
  minutes: number;
  timing: "on_time" | "delayed" | null;
  remainingOptional: readonly Exclude<OpeningDepartureRecapSlot, "role" | "duty" | "evidence">[];
}>;

export type OpeningDepartureRecap = Readonly<{
  version: typeof OPENING_DEPARTURE_RECAP_VERSION;
  questId: string;
  questTitle: string;
  entries: readonly OpeningDepartureRecapEntry[];
  dispatch: OpeningDepartureRecapDispatch | null;
}>;

export type OpeningCompactDepartureRecapEntry = readonly [
  slot: OpeningDepartureRecapSlot,
  status: OpeningDepartureRecapStatus,
  title: string | null,
];

export type OpeningCompactDepartureRecap = readonly [
  version: typeof OPENING_DEPARTURE_RECAP_VERSION,
  questId: string,
  questTitle: string,
  entries: readonly OpeningCompactDepartureRecapEntry[],
  dispatch:
    | readonly [
        state: OpeningDepartureRecapDispatch["state"],
        minutes: number,
        timing: OpeningDepartureRecapDispatch["timing"],
        remainingOptional: readonly OpeningDepartureRecapDispatch["remainingOptional"][number][],
      ]
    | null,
];

export type OpeningCompactDepartureRecapTerms = readonly [
  version: typeof OPENING_DEPARTURE_RECAP_VERSION,
  questId: string,
  terms: readonly (readonly [slot: OpeningDepartureRecapSlot, activeFieldTerm: string])[],
];

type OpeningDepartureRecapInputs = Readonly<{
  world: OverworldManifest;
  journalEntries: readonly OverworldJournalEntry[];
}>;

function recapEntry(
  slot: OpeningDepartureRecapSlot,
  label: string,
  status: OpeningDepartureRecapStatus,
  title: string | null,
  activeFieldTerm: string | null = null,
): OpeningDepartureRecapEntry {
  return Object.freeze({ slot, label, status, title, activeFieldTerm });
}

function deriveDispatchRecap(
  window: QuestDispatchPresentationWindow,
): OpeningDepartureRecapDispatch | null {
  if (window.status === "support_choices_open") {
    const remainingOptional = Object.freeze([
      ...(window.receipt.preparation.kind === "open_optional" ? (["preparation"] as const) : []),
      ...(window.receipt.reliefAllocation.kind === "open_optional"
        ? (["relief_allocation"] as const)
        : []),
      ...(window.receipt.juneCommitment.kind === "open_optional" ? (["field_team"] as const) : []),
    ]);
    return Object.freeze({
      state: "committed",
      minutes: window.committedMinutes,
      timing: null,
      remainingOptional,
    });
  }
  if (
    (window.status !== "on_time" && window.status !== "delayed") ||
    window.ledgerMinutes === undefined
  ) {
    return null;
  }
  return Object.freeze({
    state: "sealed",
    minutes: window.ledgerMinutes,
    timing: window.status,
    remainingOptional: Object.freeze([]),
  });
}

/**
 * Reuse the binding boundary from the canonical selected-choice presentation.
 * Roleplay-first receipts defer field mechanics until their actual consumer, so
 * the recap keeps the selected promise's concise "give up" term instead.
 */
function selectedPresentedOption(prompt: JourneyStoryChoicePrompt, selectedId: string) {
  const selected = prompt.options.find((option) => option.id === selectedId);
  if (!selected) {
    throw new Error(`Opening departure recap cannot resolve selected option "${selectedId}".`);
  }
  return selected;
}

function selectedTitle(prompt: JourneyStoryChoicePrompt, selectedId: string): string {
  return selectedPresentedOption(prompt, selectedId).label;
}

function boundedFieldTerm(value: string): string {
  if (value.length > OPENING_DEPARTURE_RECAP_FIELD_TERM_CHAR_LIMIT) {
    throw new Error(
      `Opening departure recap field term exceeds ${String(
        OPENING_DEPARTURE_RECAP_FIELD_TERM_CHAR_LIMIT,
      )} characters.`,
    );
  }
  return value;
}

function selectedFieldTerm(prompt: JourneyStoryChoicePrompt, selectedId: string): string {
  const selected = selectedPresentedOption(prompt, selectedId);
  if (!selected.summary) {
    throw new Error(`Opening departure recap cannot resolve selected field term "${selectedId}".`);
  }
  const value =
    selected.summary.fieldTriggerScope === "category" && selected.summary.fieldTrigger
      ? selected.summary.fieldTrigger
      : selected.summary.tradeoff;
  return boundedFieldTerm(value);
}

/**
 * Reconstruct the player's accumulated Albany departure plan from the same
 * authenticated evidence used by save restore. No alternative or consequence
 * copy is projected, and contradictory evidence fails closed.
 */
export function deriveOpeningDepartureRecap(
  args: OpeningDepartureRecapInputs,
): OpeningDepartureRecap | null {
  const chain = resolveOpeningDispatchManifestChain(args.world);
  if (!chain?.ally) return null;

  try {
    const registrationProof = proveOpeningRegistrationJournal({
      registration: chain.registration,
      journalEntries: args.journalEntries,
      expectedTown: null,
    });
    if (!registrationProof.profile) return null;

    const reliefOathProof = proveOpeningReliefOathJournal({
      scene: chain.reliefOath,
      registrationProof,
      journalEntries: args.journalEntries,
      expectedTown: null,
    });
    if (!reliefOathProof.option) return null;

    const leadSourceProof = proveOpeningLeadSourceJournal({
      scene: chain.leadSource,
      registrationProof,
      reliefOathProof,
      journalEntries: args.journalEntries,
      expectedTown: null,
    });
    if (!leadSourceProof.option) return null;

    const preparationProof = proveOpeningPreparationJournal({
      scene: chain.preparation,
      leadSourceProof,
      journalEntries: args.journalEntries,
      expectedTown: null,
    });
    const reliefAllocationProof = proveOpeningReliefAllocationJournal({
      scene: chain.reliefAllocation,
      preparationProof,
      leadSourceProof,
      preparationScene: chain.preparation,
      journalEntries: args.journalEntries,
      expectedTown: null,
    });
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
    const dispatchWindow = deriveQuestDispatchPresentationWindow({
      questId: chain.quest.id,
      journalEntries: args.journalEntries,
      openingRegistration: chain.registration,
      openingReliefOath: chain.reliefOath,
      openingLeadSource: chain.leadSource,
      openingPreparation: chain.preparation,
      openingReliefAllocation: chain.reliefAllocation,
      openingAlly: chain.ally,
    });
    const dispatch = deriveDispatchRecap(dispatchWindow);
    const selectedSupport: OpeningDispatchReplayChoice[] = [
      ...(preparationProof.profile && preparationProof.journalIndex !== null
        ? [
            {
              kind: "preparation" as const,
              journalIndex: preparationProof.journalIndex,
              scene: chain.preparation,
              optionId: preparationProof.profile.id,
            },
          ]
        : []),
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
    ];
    const characterBeforeSupport = (journalIndex: number) =>
      replayOpeningDispatchChoices({
        characterAfterSource: leadSourceProof.characterAfterSource,
        choices: selectedSupport,
        beforeJournalIndex: journalIndex,
      });
    const registrationPresentation = presentOpeningRegistration(chain.registration);
    const reliefOathPresentation = presentOpeningReliefOath(
      chain.reliefOath,
      registrationProof.profile.character,
    );
    const leadSourcePresentation = presentOpeningLeadSource(
      chain.leadSource,
      reliefOathProof.characterAfterOath,
    );
    const preparationPresentation = preparationProof.profile
      ? presentOpeningPreparation(
          chain.preparation,
          characterBeforeSupport(preparationProof.journalIndex!),
        )
      : null;
    const reliefAllocationPresentation = reliefAllocationProof.option
      ? presentOpeningReliefAllocation(
          chain.reliefAllocation,
          characterBeforeSupport(reliefAllocationProof.journalIndex!),
        )
      : null;
    const allyPresentation = allyProof.option
      ? presentOpeningAlly(chain.ally, characterBeforeSupport(allyProof.journalIndex!))
      : null;
    const entries = Object.freeze([
      recapEntry(
        "role",
        "Background",
        "selected",
        selectedTitle(registrationPresentation, registrationProof.profile.id),
        boundedFieldTerm(registrationProof.profile.tradeoff),
      ),
      recapEntry(
        "duty",
        "Wolf-Winter promise",
        "selected",
        selectedTitle(reliefOathPresentation, reliefOathProof.option.id),
        selectedFieldTerm(reliefOathPresentation, reliefOathProof.option.id),
      ),
      recapEntry(
        "evidence",
        "Report",
        "selected",
        selectedTitle(leadSourcePresentation, leadSourceProof.option.id),
        selectedFieldTerm(leadSourcePresentation, leadSourceProof.option.id),
      ),
      preparationProof.profile
        ? recapEntry(
            "preparation",
            "Field kit",
            "selected",
            selectedTitle(preparationPresentation!, preparationProof.profile.id),
            selectedFieldTerm(preparationPresentation!, preparationProof.profile.id),
          )
        : recapEntry("preparation", "Field kit", "open_optional", null),
      reliefAllocationProof.option
        ? recapEntry(
            "relief_allocation",
            "Relief wagon",
            "selected",
            selectedTitle(reliefAllocationPresentation!, reliefAllocationProof.option.id),
            selectedFieldTerm(reliefAllocationPresentation!, reliefAllocationProof.option.id),
          )
        : recapEntry("relief_allocation", "Relief wagon", "open_optional", null),
      allyProof.option
        ? recapEntry(
            "field_team",
            "Second rider",
            "selected",
            selectedTitle(allyPresentation!, allyProof.option.id),
            selectedFieldTerm(allyPresentation!, allyProof.option.id),
          )
        : recapEntry("field_team", "Second rider", "open_optional", null),
    ]);

    return Object.freeze({
      version: OPENING_DEPARTURE_RECAP_VERSION,
      questId: chain.quest.id,
      questTitle: chain.quest.title,
      entries,
      dispatch,
    });
  } catch {
    return null;
  }
}

export function cloneOpeningDepartureRecap(recap: OpeningDepartureRecap): OpeningDepartureRecap {
  return {
    ...recap,
    entries: recap.entries.map((entry) => ({ ...entry })),
    dispatch: recap.dispatch
      ? { ...recap.dispatch, remainingOptional: [...recap.dispatch.remainingOptional] }
      : null,
  };
}

export function compactOpeningDepartureRecap(
  recap: OpeningDepartureRecap,
): OpeningCompactDepartureRecap {
  const entries =
    recap.dispatch?.state === "committed"
      ? recap.entries.filter((entry) => entry.status !== "open_optional")
      : recap.entries;
  return [
    recap.version,
    recap.questId,
    recap.questTitle,
    entries.map((entry) => [entry.slot, entry.status, entry.title] as const),
    recap.dispatch
      ? [
          recap.dispatch.state,
          recap.dispatch.minutes,
          recap.dispatch.timing,
          [...recap.dispatch.remainingOptional],
        ]
      : null,
  ];
}

export function compactOpeningDepartureRecapTerms(
  recap: OpeningDepartureRecap,
): OpeningCompactDepartureRecapTerms {
  return [
    recap.version,
    recap.questId,
    recap.entries.flatMap((entry) =>
      entry.activeFieldTerm ? [[entry.slot, entry.activeFieldTerm] as const] : [],
    ),
  ];
}
