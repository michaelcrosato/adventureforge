import { applyCampaignConsequences, deriveCampaignWorldFactIds } from "./campaign_consequences.js";
import {
  serializeCampaignCharacterState,
  type CampaignCharacterState,
} from "./campaign_character_state.js";
import { wolfWinterCampaignOutcome } from "./journey_campaign.js";
import type { OverworldQuest, OverworldQuestCampaignExport } from "./overworld.js";
import { overworldQuestCampaignEffectsForCharacter } from "./overworld.js";
import type { OpeningLeadSource } from "./opening_lead_source.js";
import { proveOpeningLeadSourceJournal } from "./opening_lead_source_journal.js";
import type { OpeningRegistration } from "./opening_registration.js";
import { proveOpeningRegistrationJournal } from "./opening_registration_journal.js";
import type { OpeningReliefOath } from "./opening_relief_oath.js";
import { proveOpeningReliefOathJournal } from "./opening_relief_oath_journal.js";
import type { OverworldJournalEntry } from "./session_snapshot.js";

const WOLF_WINTER_QUEST_ID = "wolf_winter";
const AUTHORITY_INVOKED_FACT_ID = "fact:wolf_winter_albany_authority_invoked";

const REGISTRATION_PROMISE_BY_PROFILE: ReadonlyMap<
  string,
  Readonly<{ promiseId: string; recipientId: string }>
> = new Map([
  [
    "albany:road_warden",
    {
      promiseId: "albany:promise_return_hayden_packet",
      recipientId: "albany:hayden_hale",
    },
  ],
  [
    "albany:ledger_advocate",
    {
      promiseId: "albany:promise_truthful_relief_account",
      recipientId: "albany:rowan_quill",
    },
  ],
  [
    "albany:ironhands_repairer",
    {
      promiseId: "albany:promise_return_reese_tools",
      recipientId: "albany:reese_pryce",
    },
  ],
  [
    "albany:unaffiliated_courier",
    {
      promiseId: "albany:promise_close_emergency_tag",
      recipientId: "albany:rowan_quill",
    },
  ],
]);

const REGISTRATION_PROMISE_IDS = new Set(
  [...REGISTRATION_PROMISE_BY_PROFILE.values()].map((entry) => entry.promiseId),
);

/**
 * Player-facing terms for every promise a shipped quest export can resolve as
 * `broken`, in the same imperative voice as the registration "Promise kept:" lines.
 * A completion journal that reports a kept promise must not stay silent about one
 * the same export broke (bug_0645). tests/unit/registration_promise_receipt.test.ts
 * proves every authored `broken` resolution has wording here.
 */
export const BROKEN_PROMISE_TERMS: ReadonlyMap<string, string> = new Map([
  ["albany:promise_wolf_full_compact_duty", "use Albany's public seals during FORTIFY"],
  ["albany:promise_wolf_unaffiliated_bond", "claim no Albany authority"],
  ["albany:promise_june_cattle_first", "keep June's cattle-first terms"],
]);

/**
 * The "Promise broken: …" sentences for a quest completion, read from the same
 * character-selected export effects the "Promise kept:" receipt and the character
 * transition use. Undefined when the export breaks nothing.
 */
export function deriveBrokenPromiseFoldbackReceipt(
  campaignExport: OverworldQuestCampaignExport,
  characterBefore: CampaignCharacterState,
): string | undefined {
  const sentences = overworldQuestCampaignEffectsForCharacter(campaignExport, characterBefore)
    .flatMap((effect) =>
      effect.type === "resolve_promise" && effect.status === "broken" ? [effect.promise_id] : [],
    )
    .map((promiseId) => {
      const terms = BROKEN_PROMISE_TERMS.get(promiseId);
      if (terms === undefined) {
        throw new Error(`Broken promise "${promiseId}" has no completion-journal wording.`);
      }
      return `Promise broken: ${terms}.`;
    });
  return sentences.length > 0 ? sentences.join(" ") : undefined;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function authenticateQuestStart(
  quest: OverworldQuest,
  journalEntries: readonly OverworldJournalEntry[],
): void {
  const starts = journalEntries.filter((entry) => entry.id === `quest:${quest.id}`);
  if (starts.length !== 1 || starts[0]!.kind !== "quest") {
    throw new Error(
      `Registration receipt requires exactly one authenticated quest start for "${quest.id}".`,
    );
  }
  const proof = starts[0]!.questStartProof;
  if (!proof) {
    throw new Error(`Registration receipt requires an authenticated start for "${quest.id}".`);
  }
  if (!quest.launch?.options.some((option) => option.id === proof.approachId)) {
    throw new Error(
      `Registration receipt quest start names unknown approach "${proof.approachId}".`,
    );
  }
}

function assertSelectedRegistrationPromise(args: {
  characterBefore: CampaignCharacterState;
  characterAfter: CampaignCharacterState;
  profileId: string;
}): Readonly<{ promiseId: string; recipientId: string }> {
  const expected = REGISTRATION_PROMISE_BY_PROFILE.get(args.profileId);
  if (!expected || args.characterBefore.background !== args.profileId) {
    throw new Error("Registration receipt profile does not match the campaign character.");
  }
  const selectedBefore = args.characterBefore.promises.find(
    (promise) => promise.promiseId === expected.promiseId,
  );
  const selectedAfter = args.characterAfter.promises.find(
    (promise) => promise.promiseId === expected.promiseId,
  );
  if (
    selectedBefore?.recipientId !== expected.recipientId ||
    selectedBefore.status !== "active" ||
    selectedAfter?.recipientId !== expected.recipientId ||
    selectedAfter.status !== "kept"
  ) {
    throw new Error(
      `Registration receipt requires exact active-to-kept evidence for "${expected.promiseId}".`,
    );
  }
  const registrationPromises = args.characterBefore.promises.filter((promise) =>
    REGISTRATION_PROMISE_IDS.has(promise.promiseId),
  );
  if (
    registrationPromises.length !== 1 ||
    registrationPromises[0]!.promiseId !== expected.promiseId
  ) {
    throw new Error("Registration receipt cannot combine obligations from multiple profiles.");
  }
  return expected;
}

function assertIronhandsEquipment(
  character: CampaignCharacterState,
  registration: OpeningRegistration,
): number {
  const profile = registration.profiles.find(
    (candidate) => candidate.id === "albany:ironhands_repairer",
  );
  const authored = profile?.character.equipment.find(
    (equipment) => equipment.equipmentId === "albany:ironhands_repair_roll",
  );
  const held = character.equipment.find(
    (equipment) => equipment.equipmentId === "albany:ironhands_repair_roll",
  );
  if (!authored || !held || JSON.stringify(held) !== JSON.stringify(authored)) {
    throw new Error(
      "Registration receipt cannot release Reese's loan without the exact repair-roll snapshot.",
    );
  }
  return held.condition;
}

export function deriveRegistrationPromiseFoldbackReceipt(args: {
  quest: OverworldQuest;
  campaignExport: OverworldQuestCampaignExport;
  characterBefore: CampaignCharacterState;
  characterAfter: CampaignCharacterState;
  worldFactIds: readonly string[];
  journalEntries: readonly OverworldJournalEntry[];
  openingRegistration: OpeningRegistration | null | undefined;
  openingReliefOath: OpeningReliefOath | null | undefined;
  openingLeadSource: OpeningLeadSource | null | undefined;
}): string | undefined {
  if (args.quest.id !== WOLF_WINTER_QUEST_ID) return undefined;
  const effects = overworldQuestCampaignEffectsForCharacter(
    args.campaignExport,
    args.characterBefore,
  );
  const registrationPromise = REGISTRATION_PROMISE_BY_PROFILE.get(
    args.characterBefore.background ?? "",
  );
  if (
    !registrationPromise ||
    !effects.some(
      (effect) =>
        effect.type === "resolve_promise" &&
        effect.promise_id === registrationPromise.promiseId &&
        effect.status === "kept",
    )
  ) {
    return undefined;
  }
  if (
    !args.openingRegistration ||
    !args.openingReliefOath ||
    !args.openingLeadSource ||
    args.openingReliefOath.target_quest !== args.quest.id ||
    args.openingLeadSource.target_quest !== args.quest.id
  ) {
    throw new Error("Registration receipt requires the complete Albany dispatch proof chain.");
  }
  if (args.campaignExport.ending_id.length === 0 || args.campaignExport.ending_title.length === 0) {
    throw new Error("Registration receipt requires a canonical Wolf-Winter outcome.");
  }

  authenticateQuestStart(args.quest, args.journalEntries);
  const registrationProof = proveOpeningRegistrationJournal({
    registration: args.openingRegistration,
    journalEntries: args.journalEntries,
    expectedTown: null,
  });
  if (!registrationProof.profile) {
    throw new Error("Registration receipt requires one authenticated registration profile.");
  }
  const reliefOathProof = proveOpeningReliefOathJournal({
    scene: args.openingReliefOath,
    registrationProof,
    journalEntries: args.journalEntries,
    expectedTown: null,
  });
  if (!reliefOathProof.option) {
    throw new Error("Registration receipt requires current relief-oath terms.");
  }
  const leadSourceProof = proveOpeningLeadSourceJournal({
    scene: args.openingLeadSource,
    registrationProof,
    reliefOathProof,
    journalEntries: args.journalEntries,
    expectedTown: null,
  });
  if (!leadSourceProof.option) {
    throw new Error("Registration receipt requires current source terms.");
  }
  const expectedApplication = applyCampaignConsequences({
    character: args.characterBefore,
    effects,
  });
  assertSelectedRegistrationPromise({
    characterBefore: args.characterBefore,
    characterAfter: args.characterAfter,
    profileId: registrationProof.profile.id,
  });
  if (
    serializeCampaignCharacterState(expectedApplication.characterAfter) !==
    serializeCampaignCharacterState(args.characterAfter)
  ) {
    throw new Error("Registration receipt character transition does not match the exact export.");
  }
  const exactFactIds = deriveCampaignWorldFactIds([effects]);
  if (!sameStringSet(exactFactIds, args.worldFactIds)) {
    throw new Error("Registration receipt facts do not match the exact Wolf-Winter export.");
  }
  const outcome = wolfWinterCampaignOutcome(
    new Map([[WOLF_WINTER_QUEST_ID, args.campaignExport.ending_id]]),
  );
  if (!outcome) {
    throw new Error(
      `Registration receipt does not recognize outcome "${args.campaignExport.ending_id}".`,
    );
  }

  const fieldReturn = `${args.campaignExport.ending_title}: ${outcome.albanyReturnContext}`;
  switch (registrationProof.profile.id) {
    case "albany:road_warden":
      return (
        `Registration complete. Hayden Hale accepts your field report. ${fieldReturn} ` +
        "Promise kept: return Hayden's winter packet."
      );
    case "albany:ledger_advocate":
      return `Registration complete. Rowan Quill records ${leadSourceProof.option.title} under ${reliefOathProof.option.title}. Result: ${fieldReturn} Promise kept: give a truthful account.`;
    case "albany:ironhands_repairer": {
      const condition = assertIronhandsEquipment(args.characterBefore, args.openingRegistration);
      return (
        "Registration complete. Reese Pryce records the insulated repair roll at " +
        `${String(condition)}/100 condition and closes the tool loan. Result: ${fieldReturn} ` +
        "Promise kept: return Reese's tools."
      );
    }
    case "albany:unaffiliated_courier":
      return args.worldFactIds.includes(AUTHORITY_INVOKED_FACT_ID)
        ? `Registration complete. Rowan Quill cancels the emergency tag after you used Albany authority. Result: ${fieldReturn} Promise kept: close the emergency tag.`
        : `Registration complete. Rowan Quill records the emergency tag returned with Emery Sloane as witness. Result: ${fieldReturn} Promise kept: close the emergency tag.`;
    default:
      throw new Error(
        `Registration receipt does not support profile "${registrationProof.profile.id}".`,
      );
  }
}
