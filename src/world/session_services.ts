import {
  recordOverworldRepeatableEntry,
  type OverworldActionJournalState,
} from "./session_action_recording.js";
import type { CampaignServiceAction, CampaignServiceRule } from "./campaign_service_rules.js";
import {
  applyCampaignConsequences,
  type CampaignConsequenceEffects,
} from "./campaign_consequences.js";
import type { CampaignCharacterState } from "./campaign_character_state.js";
import type { OverworldJournalEntry } from "./session_snapshot.js";
import { OVERWORLD_MAX_SUPPLIES as MAX_SUPPLIES } from "./travel_mechanics.js";

export type OverworldServiceAction = CampaignServiceAction;

export type OverworldServiceResult = {
  action: OverworldServiceAction;
  minutes: number;
  changed: boolean;
  suppliesBefore: number;
  suppliesAfter: number;
  fatigueBefore: number;
  fatigueAfter: number;
  message: string;
  entry: OverworldJournalEntry | null;
};

export type OverworldServiceJournalEntryDraft = Omit<OverworldJournalEntry, "recordedAt"> & {
  serviceRuleId?: string;
  serviceAreaId?: string;
};

export type OverworldServicePlan = Omit<OverworldServiceResult, "entry"> & {
  entryDraft: OverworldServiceJournalEntryDraft | null;
  characterAfter?: CampaignCharacterState;
};

export type OverworldAppliedServicePlan = OverworldServiceResult & {
  minutesAfter: number;
  stateChanged: boolean;
  characterAfter?: CampaignCharacterState;
};

export type OverworldServiceState = {
  townName: string;
  services: readonly string[];
  activeCampaignServiceRules?: readonly CampaignServiceRule[];
  character?: CampaignCharacterState;
  supplies: number;
  fatigue: number;
};

export const OVERWORLD_REST_UNAVAILABLE_MESSAGE =
  "Rest is unavailable here. This town has no inn or healer.";
export const OVERWORLD_RESUPPLY_UNAVAILABLE_MESSAGE =
  "Resupply is unavailable here. This town has no market, inn, or stable.";
const OVERWORLD_CARE_UNAVAILABLE_MESSAGE =
  "Wound care is unavailable here. No active care offer matches your condition.";

function campaignServiceRule(
  state: OverworldServiceState,
  action: OverworldServiceAction,
): CampaignServiceRule | null {
  const rules = (state.activeCampaignServiceRules ?? []).filter((rule) => rule.action === action);
  if (rules.length > 1) {
    throw new Error(`Multiple active campaign service rules resolve for action "${action}".`);
  }
  return rules[0] ?? null;
}

function authoredServiceText(summary: string, consequence: string): string {
  return `${summary.trim()} ${consequence}`;
}

type CampaignServiceJournalCopy = Readonly<{
  title: string;
  text: string;
}>;

export function campaignServiceJourneyActionId(
  ruleId: string,
  action: CampaignServiceAction,
): string {
  return `campaign_service:${ruleId}:${action}`;
}

/** Canonical player-facing copy shared by live planning and snapshot replay. */
export function campaignServiceJournalCopy(
  rule: CampaignServiceRule,
  resources: Pick<OverworldServiceState, "supplies" | "fatigue">,
  character?: CampaignCharacterState,
): CampaignServiceJournalCopy {
  const consequence =
    rule.action === "rest"
      ? `Time: ${rule.minutes} minutes. Fatigue: ${resources.fatigue} → 0.`
      : rule.action === "resupply"
        ? `Time: ${rule.minutes} minutes. Supplies: ${resources.supplies} → ${MAX_SUPPLIES}.`
        : (() => {
            if (!character || !rule.effects) {
              throw new Error(
                `Campaign care rule "${rule.id}" is missing character state or treatment effects.`,
              );
            }
            const after = applyCampaignConsequences({
              character,
              effects: rule.effects,
            }).characterAfter;
            const treatment = (rule.effects as CampaignConsequenceEffects)
              .filter((effect) => effect.type === "treat_wound")
              .map((effect) => `wound treatment: ${effect.from_treatment} → ${effect.to_treatment}`)
              .join("; ");
            return `Time: ${rule.minutes} minutes. ${treatment}. Health: ${character.health.current} → ${after.health.current}.`;
          })();
  return {
    title: rule.title,
    text: authoredServiceText(rule.summary, consequence),
  };
}

export function canRestAtOverworldTown(services: readonly string[]): boolean {
  return services.includes("inn") || services.includes("healer");
}

export function canResupplyAtOverworldTown(services: readonly string[]): boolean {
  return services.includes("market") || services.includes("inn") || services.includes("stable");
}

export function applyOverworldServicePlan(
  state: OverworldActionJournalState,
  plan: OverworldServicePlan,
): OverworldAppliedServicePlan {
  const { entryDraft, ...result } = plan;
  if (!result.changed) {
    return {
      ...result,
      entry: null,
      minutesAfter: state.minutes,
      stateChanged: false,
    };
  }
  if (!entryDraft) {
    throw new Error("Changed overworld service plan is missing a journal entry.");
  }
  const recorded = recordOverworldRepeatableEntry(state, entryDraft, plan.minutes);
  return {
    ...result,
    message: recorded.entry.text,
    entry: recorded.entry,
    minutesAfter: recorded.minutesAfter,
    stateChanged: true,
  };
}

export function planOverworldTownRest(state: OverworldServiceState): OverworldServicePlan {
  const rule = campaignServiceRule(state, "rest");
  if (!rule && !canRestAtOverworldTown(state.services)) {
    throw new Error(OVERWORLD_REST_UNAVAILABLE_MESSAGE);
  }
  if (state.fatigue === 0) {
    return {
      action: "rest",
      minutes: 0,
      changed: false,
      suppliesBefore: state.supplies,
      suppliesAfter: state.supplies,
      fatigueBefore: state.fatigue,
      fatigueAfter: state.fatigue,
      message: "You are already rested.",
      entryDraft: null,
    };
  }

  const minutes = rule?.minutes ?? Math.max(180, Math.ceil(state.fatigue / 20) * 60);
  const ordinaryText = `You rest safely. Time: ${minutes} minutes. Fatigue: ${state.fatigue} → 0.`;
  const authoredCopy = rule ? campaignServiceJournalCopy(rule, state) : null;
  const text = authoredCopy?.text ?? ordinaryText;
  return {
    action: "rest",
    minutes,
    changed: true,
    suppliesBefore: state.supplies,
    suppliesAfter: state.supplies,
    fatigueBefore: state.fatigue,
    fatigueAfter: 0,
    message: text,
    entryDraft: {
      id: "service:rest",
      kind: "service",
      town: state.townName,
      title: authoredCopy?.title ?? `Rested in ${state.townName}`,
      text,
      ...(rule ? { serviceRuleId: rule.id, serviceAreaId: rule.area } : {}),
    },
  };
}

export function planOverworldTownResupply(state: OverworldServiceState): OverworldServicePlan {
  const rule = campaignServiceRule(state, "resupply");
  if (!rule && !canResupplyAtOverworldTown(state.services)) {
    throw new Error(OVERWORLD_RESUPPLY_UNAVAILABLE_MESSAGE);
  }
  if (state.supplies >= MAX_SUPPLIES) {
    return {
      action: "resupply",
      minutes: 0,
      changed: false,
      suppliesBefore: state.supplies,
      suppliesAfter: state.supplies,
      fatigueBefore: state.fatigue,
      fatigueAfter: state.fatigue,
      message: "Your supplies are already full.",
      entryDraft: null,
    };
  }

  const minutes = rule?.minutes ?? 45;
  const ordinaryText = `You buy food, lamp oil, and road gear. Time: ${minutes} minutes. Supplies: ${state.supplies} → ${MAX_SUPPLIES}.`;
  const authoredCopy = rule ? campaignServiceJournalCopy(rule, state) : null;
  const text = authoredCopy?.text ?? ordinaryText;
  return {
    action: "resupply",
    minutes,
    changed: true,
    suppliesBefore: state.supplies,
    suppliesAfter: MAX_SUPPLIES,
    fatigueBefore: state.fatigue,
    fatigueAfter: state.fatigue,
    message: text,
    entryDraft: {
      id: "service:resupply",
      kind: "service",
      town: state.townName,
      title: authoredCopy?.title ?? `Resupplied in ${state.townName}`,
      text,
      ...(rule ? { serviceRuleId: rule.id, serviceAreaId: rule.area } : {}),
    },
  };
}

export function planOverworldTownCare(state: OverworldServiceState): OverworldServicePlan {
  const rule = campaignServiceRule(state, "care");
  if (!rule) {
    throw new Error(OVERWORLD_CARE_UNAVAILABLE_MESSAGE);
  }
  if (!state.character || !rule.effects) {
    throw new Error(`Campaign care rule "${rule.id}" is missing treatment state.`);
  }
  const characterAfter = applyCampaignConsequences({
    character: state.character,
    effects: rule.effects,
  }).characterAfter;
  const authoredCopy = campaignServiceJournalCopy(rule, state, state.character);
  return {
    action: "care",
    minutes: rule.minutes,
    changed: true,
    suppliesBefore: state.supplies,
    suppliesAfter: state.supplies,
    fatigueBefore: state.fatigue,
    fatigueAfter: state.fatigue,
    message: authoredCopy.text,
    characterAfter,
    entryDraft: {
      id: "service:care",
      kind: "service",
      town: state.townName,
      title: authoredCopy.title,
      text: authoredCopy.text,
      serviceRuleId: rule.id,
      serviceAreaId: rule.area,
    },
  };
}
