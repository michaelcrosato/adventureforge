import {
  hasContinuedJourneyGoal,
  INITIAL_JOURNEY_GOAL,
  type JourneyContractSnapshot,
  type JourneyGoalDefinition,
} from "./journey_contract.js";
import {
  campaignStoryChoiceRefKey,
  type CampaignStoryChoiceRef,
} from "./campaign_story_choices.js";
import { hashState } from "../core/hash.js";

export const JOURNEY_CAMPAIGN_START_TOWN_ID = "albany_city" as const;
/**
 * The canonical manifest currently has exactly one authored quest whose home is
 * the campaign's Albany start: Wolf-Winter. Keeping that binding here lets this
 * module remain pure and manifest-free; adding another qualifying Albany start
 * quest requires updating this explicit campaign datum and its proof tests.
 */
export const JOURNEY_CAMPAIGN_INITIAL_QUEST_ID = "wolf_winter" as const;

export type JourneyCampaignGoalDefinition = Readonly<{
  id: string;
  text: string;
  targetQuestId: string;
  targetTownId: string;
  targetAreaId: string;
}>;

function campaignGoal(
  id: string,
  text: string,
  targetQuestId: string,
  targetTownId: string,
  targetAreaId: string,
): JourneyCampaignGoalDefinition {
  return Object.freeze({ id, text, targetQuestId, targetTownId, targetAreaId });
}

export const INITIAL_JOURNEY_CAMPAIGN_GOAL = campaignGoal(
  INITIAL_JOURNEY_GOAL.id,
  INITIAL_JOURNEY_GOAL.text,
  JOURNEY_CAMPAIGN_INITIAL_QUEST_ID,
  JOURNEY_CAMPAIGN_START_TOWN_ID,
  "albany_city__transport_hub",
);

export const ALBANY_DAWN_DISPATCH_ID = "albany_dawn_dispatch" as const;
export const ALBANY_DAWN_DISPATCH_CHOICE_IDS = Object.freeze([
  "send_wagon_to_cade",
  "send_wardens_north",
] as const);
export type AlbanyDawnDispatchChoiceId = (typeof ALBANY_DAWN_DISPATCH_CHOICE_IDS)[number];

export const ALBANY_DAWN_DISPATCH_TEASER =
  "Hayden has one dawn relief wagon. He also has a Queensbury report: an old grey sow killed Hedrick Cradoc's father this morning. Continue to assign the wagon, then take Hedrick's Gallowmere lead north." as const;
export const ALBANY_DAWN_DISPATCH_CONTINUE_LABEL =
  "Continue: decide the dawn wagon, then take the Gallowmere lead" as const;
export const ALBANY_DAWN_DISPATCH_CONTINUE_CONSEQUENCE_PREFIX =
  "Assign Albany's only dawn relief wagon. Then find Hedrick in Queensbury and complete The Gallowmere." as const;

export const ALBANY_DAWN_DISPATCH_GOALS = Object.freeze({
  send_wagon_to_cade: campaignGoal(
    "carry_hedricks_packet_north",
    "Take Hayden's packet to Hedrick Cradoc in Queensbury Market Streets. Complete The Gallowmere.",
    "gallowmere",
    "queensbury_town",
    "queensbury_town__market",
  ),
  send_wardens_north: campaignGoal(
    "travel_north_with_albany_wardens",
    "Travel with Hayden's wardens to Hedrick Cradoc in Queensbury Market Streets. Complete The Gallowmere.",
    "gallowmere",
    "queensbury_town",
    "queensbury_town__market",
  ),
} as const satisfies Record<AlbanyDawnDispatchChoiceId, JourneyCampaignGoalDefinition>);

export const TANNERS_FEVER_ACCOUNTABILITY_ID = "tanners_fever_accountability" as const;
export const TANNERS_FEVER_ACCOUNTABILITY_CHOICE_IDS = Object.freeze([
  "keep_household_correction",
  "publish_dosage_warning",
] as const);
export type TannersFeverAccountabilityChoiceId =
  (typeof TANNERS_FEVER_ACCOUNTABILITY_CHOICE_IDS)[number];

export const TANNERS_FEVER_ACCOUNTABILITY_CONTEXT =
  "Edric will recover, and Godwin's triple-strength dose has stopped. Decide whether Oneonta records the correction privately or publicly." as const;

export const TANNERS_FEVER_ACCOUNTABILITY_TEASER =
  "Continue to choose a private household record or a public warning. Then take the next report to Rome." as const;

export const TANNERS_FEVER_ACCOUNTABILITY_GOALS = Object.freeze({
  keep_household_correction: campaignGoal(
    "rome_breaking_weir_household_correction",
    "Travel to Rome Market Streets and find The Breaking Weir. Edric's correction remains private.",
    "breaking_weir",
    "rome_city",
    "rome_city__market",
  ),
  publish_dosage_warning: campaignGoal(
    "rome_breaking_weir_public_warning",
    "Travel to Rome Market Streets and find The Breaking Weir. Oneonta's dosage warning is public.",
    "breaking_weir",
    "rome_city",
    "rome_city__market",
  ),
} as const satisfies Record<TannersFeverAccountabilityChoiceId, JourneyCampaignGoalDefinition>);

export const ROME_POST_WEIR_DISPATCH_ID = "rome_post_weir_dispatch" as const;
export const ROME_POST_WEIR_DISPATCH_CHOICE_IDS = Object.freeze([
  "take_oswego_charter_packet",
  "take_greece_forge_packet",
] as const);
export type RomePostWeirDispatchChoiceId = (typeof ROME_POST_WEIR_DISPATCH_CHOICE_IDS)[number];

export const ROME_POST_WEIR_DISPATCH_CONTEXT =
  "Pell's relief channel carried the flood around the valley. The downstream households survived." as const;

export const ROME_POST_WEIR_DISPATCH_TEASER =
  "Two reports wait. Oswego officials are seizing Marta Holm's cloth despite her inherited charter. Greece's old forge has gone cold around the Ember-Heart. Continue to choose which report to take first." as const;

/**
 * These selected-first goals deliberately use new ids. The pre-choice
 * `oswego_advocates_case` and `greece_cold_forge` ids remain canonical for old
 * version-8 saves and for whichever packet is deferred to second place.
 */
export const ROME_POST_WEIR_DISPATCH_GOALS = Object.freeze({
  take_oswego_charter_packet: campaignGoal(
    "oswego_advocates_case_first",
    "Take Rome's charter packet to Oswego Market Streets. Complete The Advocate's Case.",
    "advocates_case",
    "oswego_city",
    "oswego_city__market",
  ),
  take_greece_forge_packet: campaignGoal(
    "greece_cold_forge_first",
    "Take Rome's forge packet to Greece Market Streets. Complete The Cold Forge.",
    "cold_forge",
    "greece_town",
    "greece_town__market",
  ),
} as const satisfies Record<RomePostWeirDispatchChoiceId, JourneyCampaignGoalDefinition>);

export type BreakingWeirCampaignEndingId =
  | "ending_fields_held_race_spent"
  | "ending_race_held_fields_given"
  | "ending_held";

export type BreakingWeirCampaignOutcome =
  | "fields_held_race_spent"
  | "race_held_fields_given"
  | "held";

type BreakingWeirCampaignOutcomeContext = Readonly<{
  id: BreakingWeirCampaignOutcome;
  endingId: BreakingWeirCampaignEndingId;
  romeDispatchContext: string;
}>;

export const BREAKING_WEIR_CAMPAIGN_OUTCOMES = Object.freeze({
  ending_fields_held_race_spent: Object.freeze({
    id: "fields_held_race_spent",
    endingId: "ending_fields_held_race_spent",
    romeDispatchContext:
      "The valley is dry, and its winter grain survived. Pell's gate and relief channel are destroyed, so the next flood has no working bypass.",
  }),
  ending_race_held_fields_given: Object.freeze({
    id: "race_held_fields_given",
    endingId: "ending_race_held_fields_given",
    romeDispatchContext:
      "The valley is dry, and Pell's weir can handle another flood. The lower farms lost their winter grain, so food will be scarce.",
  }),
  ending_held: Object.freeze({
    id: "held",
    endingId: "ending_held",
    romeDispatchContext: ROME_POST_WEIR_DISPATCH_CONTEXT,
  }),
} as const satisfies Record<BreakingWeirCampaignEndingId, BreakingWeirCampaignOutcomeContext>);

const BREAKING_WEIR_OUTCOME_BY_ID: ReadonlyMap<string, BreakingWeirCampaignOutcomeContext> =
  new Map(
    Object.values(BREAKING_WEIR_CAMPAIGN_OUTCOMES).map((outcome) => [outcome.endingId, outcome]),
  );

export type WolfWinterCampaignOutcome =
  | "pack_diverted"
  | "pack_diverted_cattle_scattered"
  | "pack_diverted_after_blood"
  | "bloodied_byre_evacuated"
  | "drive_cattle_wounded"
  | "drive_person_cattle_lost"
  | "drive_reserve_spent"
  | "fortified_cade_terms"
  | "fortified_albany_authority"
  | "gate_barred"
  | "timber_saved"
  | "held";

type WolfWinterCampaignOutcomeContext = Readonly<{
  id: WolfWinterCampaignOutcome;
  endingId: string;
  albanyReturnContext: string;
}>;

export const WOLF_WINTER_CAMPAIGN_OUTCOMES = Object.freeze({
  ending_pack_diverted: Object.freeze({
    id: "pack_diverted",
    endingId: "ending_pack_diverted",
    albanyReturnContext:
      "Cade's whole herd survived, and all three wolves are alive in the high wood. His winter feed is gone, and the broken outer fence still exposes the herd.",
  }),
  ending_pack_diverted_cattle_scattered: Object.freeze({
    id: "pack_diverted_cattle_scattered",
    endingId: "ending_pack_diverted_cattle_scattered",
    albanyReturnContext:
      "Most of Cade's herd survived, and all three wolves are alive in the high wood. Two cattle are missing, the winter feed is gone, and the outer fence is broken.",
  }),
  ending_pack_diverted_after_blood: Object.freeze({
    id: "pack_diverted_after_blood",
    endingId: "ending_pack_diverted_after_blood",
    albanyReturnContext:
      "The yearling wolf died. The other two wolves are alive in the high wood. Most of the herd survived, but two cattle are missing, the winter feed is gone, and the outer fence is broken.",
  }),
  ending_bloodied_byre_evacuated: Object.freeze({
    id: "bloodied_byre_evacuated",
    endingId: "ending_bloodied_byre_evacuated",
    albanyReturnContext:
      "Cade and everyone else escaped. The yearling and flank wolf died; the old grey still holds the abandoned barn. Two cattle are missing, and the outer boundary is abandoned.",
  }),
  ending_bloodied_byre_evacuated_june_released: Object.freeze({
    id: "bloodied_byre_evacuated",
    endingId: "ending_bloodied_byre_evacuated_june_released",
    albanyReturnContext:
      "Cade and everyone else escaped. The yearling and flank wolf died; the old grey still holds the abandoned barn. Two cattle are missing, and the outer boundary is abandoned. You released June before HUNT, so she returned separately with her cattle-safety promise intact and earned no field-aid service.",
  }),
  ending_drive_cattle_wounded: Object.freeze({
    id: "drive_cattle_wounded",
    endingId: "ending_drive_cattle_wounded",
    albanyReturnContext:
      "Everyone and the whole herd escaped. All three wolves survived. The signal-and-rope rig returned for repair, but your gate wound is untreated and the outer boundary is abandoned.",
  }),
  ending_drive_person_cattle_lost: Object.freeze({
    id: "drive_person_cattle_lost",
    endingId: "ending_drive_person_cattle_lost",
    albanyReturnContext:
      "Everyone escaped, and all three wolves survived. The rig returned for repair, but the herd scattered and the outer boundary is abandoned.",
  }),
  ending_drive_reserve_spent: Object.freeze({
    id: "drive_reserve_spent",
    endingId: "ending_drive_reserve_spent",
    albanyReturnContext:
      "Everyone and the whole herd escaped without a wound. All three wolves survived. The rig was destroyed, and the outer boundary is abandoned.",
  }),
  ending_fortified_cade_terms: Object.freeze({
    id: "fortified_cade_terms",
    endingId: "ending_fortified_cade_terms",
    albanyReturnContext:
      "Cade's household and whole herd survived behind his shutters. All three wolves remain alive outside. You followed Cade's terms and returned Albany's seals, but the outer property remained exposed.",
  }),
  ending_fortified_albany_authority: Object.freeze({
    id: "fortified_albany_authority",
    endingId: "ending_fortified_albany_authority",
    albanyReturnContext:
      "Cade's household, whole herd, and outer property survived behind Albany's sealed boundary. All three wolves remain alive outside. You spent the public seals, and Cade refused to help under Albany's order.",
  }),
  ending_held_gate_barred: Object.freeze({
    id: "gate_barred",
    endingId: "ending_held_gate_barred",
    albanyReturnContext:
      "Cade's cattle survived behind the barred inner gate. The outer fence is still broken, so only one boundary remains.",
  }),
  ending_held_gate_barred_june_released: Object.freeze({
    id: "gate_barred",
    endingId: "ending_held_gate_barred_june_released",
    albanyReturnContext:
      "Cade's cattle survived behind the barred inner gate. The outer fence is still broken, so only one boundary remains. You released June before HUNT, so she returned separately with her cattle-safety promise intact and earned no field-aid service.",
  }),
  ending_held_timber_saved: Object.freeze({
    id: "timber_saved",
    endingId: "ending_held_timber_saved",
    albanyReturnContext:
      "Cade's cattle survived. The timber you saved can begin the outer-fence repair.",
  }),
  ending_held_timber_saved_june_released: Object.freeze({
    id: "timber_saved",
    endingId: "ending_held_timber_saved_june_released",
    albanyReturnContext:
      "Cade's cattle survived. The timber you saved can begin the outer-fence repair. You released June before HUNT, so she returned separately with her cattle-safety promise intact and earned no field-aid service.",
  }),
  ending_held: Object.freeze({
    id: "held",
    endingId: "ending_held",
    albanyReturnContext:
      "Cade's cattle survived, but the fight used the guard wood. The broken outer fence has no repair timber.",
  }),
  ending_held_june_released: Object.freeze({
    id: "held",
    endingId: "ending_held_june_released",
    albanyReturnContext:
      "Cade's cattle survived, but the fight used the guard wood. The broken outer fence has no repair timber. You released June before HUNT, so she returned separately with her cattle-safety promise intact and earned no field-aid service.",
  }),
} as const satisfies Record<string, WolfWinterCampaignOutcomeContext>);

const WOLF_OUTCOME_BY_ID: ReadonlyMap<string, WolfWinterCampaignOutcomeContext> = new Map(
  Object.values(WOLF_WINTER_CAMPAIGN_OUTCOMES).map((outcome) => [outcome.endingId, outcome]),
);

const ALBANY_DAWN_DISPATCH_CONSEQUENCES = Object.freeze({
  pack_diverted: Object.freeze({
    send_wagon_to_cade:
      "The wagon repairs Cade's outer fence. His whole herd stays home, and the living pack stays in the high wood. You take Hedrick's packet north alone.",
    send_wardens_north:
      "The wagon goes north. Cade keeps the whole herd behind a broken fence with no winter feed. The living pack stays in the high wood.",
  }),
  pack_diverted_cattle_scattered: Object.freeze({
    send_wagon_to_cade:
      "The wagon repairs Cade's outer fence and searches for the two missing cattle. You take Hedrick's packet north alone.",
    send_wardens_north:
      "The wagon goes north. Cade's outer fence remains broken, two cattle are missing, and the living pack stays in the high wood.",
  }),
  pack_diverted_after_blood: Object.freeze({
    send_wagon_to_cade:
      "The wagon repairs Cade's outer fence and searches for the two missing cattle. The yearling wolf is dead; the other two live. You take Hedrick's packet north alone.",
    send_wardens_north:
      "The wagon goes north. Cade's outer fence remains broken, and two cattle are missing. The yearling wolf is dead; the other two live in the high wood.",
  }),
  bloodied_byre_evacuated: Object.freeze({
    send_wagon_to_cade:
      "The wagon helps the evacuees, searches for two missing cattle, and marks a safe boundary around the abandoned barn. Two wolves are dead; the old grey still holds the barn. You take Hedrick's packet north alone.",
    send_wardens_north:
      "The wagon goes north. The evacuees remain safe, but two cattle are missing. Two wolves are dead, and the old grey remains in the abandoned barn.",
  }),
  drive_cattle_wounded: Object.freeze({
    send_wagon_to_cade:
      "The wagon returns Cade's whole herd and repairs the abandoned outer boundary. All three wolves live outside it. Your gate wound is untreated, and the rig is in Albany for repair. You take Hedrick's packet north alone.",
    send_wardens_north:
      "The wagon goes north. Cade and the whole herd remain on the evacuation road. All three wolves live beyond the abandoned boundary. Your gate wound is untreated, and the rig is in Albany for repair.",
  }),
  drive_person_cattle_lost: Object.freeze({
    send_wagon_to_cade:
      "The wagon helps the evacuees search for the scattered herd and repair the abandoned boundary. All three wolves live outside it, and the rig is in Albany for repair. You take Hedrick's packet north alone.",
    send_wardens_north:
      "The wagon goes north. The evacuees remain safe, but the herd is scattered. All three wolves live beyond the abandoned boundary, and the rig is in Albany for repair.",
  }),
  drive_reserve_spent: Object.freeze({
    send_wagon_to_cade:
      "The wagon returns Cade's whole herd and repairs the abandoned boundary. All three wolves live outside it, and the destroyed rig is gone. You take Hedrick's packet north alone.",
    send_wardens_north:
      "The wagon goes north. Cade and the whole herd remain safe on the evacuation road. All three wolves live beyond the abandoned boundary, and the destroyed rig is gone.",
  }),
  fortified_cade_terms: Object.freeze({
    send_wagon_to_cade:
      "The wagon protects Cade's exposed outer property. His household and herd stay behind the shutters, and Albany's seals remain unused. You take Hedrick's packet north alone.",
    send_wardens_north:
      "The wagon goes north. Cade's household and herd remain safe behind the shutters, but the outer property stays exposed. Albany's seals remain unused.",
  }),
  fortified_albany_authority: Object.freeze({
    send_wagon_to_cade:
      "The wagon checks the outer property protected by Albany's boundary. Cade's household and herd remain safe, but the public seals are spent and his refusal stays recorded. You take Hedrick's packet north alone.",
    send_wardens_north:
      "The wagon goes north. Cade's household, herd, and outer property remain safe behind Albany's boundary. The public seals are spent, and Cade refused to help.",
  }),
  gate_barred: Object.freeze({
    send_wagon_to_cade:
      "The wagon repairs the outer fence. The inner-gate timber remains Cade's last barrier. You take Hedrick's packet north alone.",
    send_wardens_north:
      "The wagon goes north. Cade keeps the cattle behind the barred inner gate, and the outer fence remains broken.",
  }),
  timber_saved: Object.freeze({
    send_wagon_to_cade:
      "The wagon uses the saved timber to repair Cade's fence before night. You take Hedrick's packet north alone.",
    send_wardens_north:
      "The wagon goes north. Cade uses the saved timber to begin the repair alone.",
  }),
  held: Object.freeze({
    send_wagon_to_cade:
      "The wagon brings replacement timber and repairs Cade's outer fence. You take Hedrick's packet north alone.",
    send_wardens_north:
      "The wagon goes north. Cade has no repair timber for the broken outer fence until another relief run.",
  }),
} as const satisfies Record<WolfWinterCampaignOutcome, Record<AlbanyDawnDispatchChoiceId, string>>);

const ALBANY_DAWN_DISPATCH_SERVICE_TERMS = Object.freeze({
  send_wagon_to_cade: "Reward: one 15-minute Market resupply for taking Hedrick's packet alone.",
  send_wardens_north: "Reward: one 15-minute Greenway rest for traveling with the wardens.",
} as const satisfies Record<AlbanyDawnDispatchChoiceId, string>);

const TANNERS_FEVER_ACCOUNTABILITY_CONSEQUENCES = Object.freeze({
  keep_household_correction:
    "Godwin records the correct dose in Edric's private household file. The family keeps control of the record, but other patients receive no warning about the three-to-one error.",
  publish_dosage_warning:
    "Oneonta publishes the three-to-one error and warns future patients. Godwin faces public review, and Edric's family loses control of the private record.",
} as const satisfies Record<TannersFeverAccountabilityChoiceId, string>);

const ROME_POST_WEIR_DISPATCH_CONSEQUENCES = Object.freeze({
  take_oswego_charter_packet:
    "Take Marta Holm's charter case to Oswego first. Her cloth remains seized, and the Greece forge report stays open.",
  take_greece_forge_packet:
    "Take the Ember-Heart forge report to Greece first. Marta Holm's Oswego case stays open.",
} as const satisfies Record<RomePostWeirDispatchChoiceId, string>);

export type JourneyCampaignStoryChoiceId =
  | typeof ALBANY_DAWN_DISPATCH_ID
  | typeof TANNERS_FEVER_ACCOUNTABILITY_ID
  | typeof ROME_POST_WEIR_DISPATCH_ID;

export type JourneyCampaignStoryChoiceOptionId =
  | AlbanyDawnDispatchChoiceId
  | TannersFeverAccountabilityChoiceId
  | RomePostWeirDispatchChoiceId;

type JourneyCampaignStoryChoiceOption<
  ChoiceId extends JourneyCampaignStoryChoiceOptionId = JourneyCampaignStoryChoiceOptionId,
> = Readonly<{
  id: ChoiceId;
  label: string;
  consequence: string;
}>;

type JourneyCampaignStoryChoiceDefinition<
  StoryChoiceId extends JourneyCampaignStoryChoiceId,
  ChoiceId extends JourneyCampaignStoryChoiceOptionId,
> = Readonly<{
  id: StoryChoiceId;
  message: string;
  options: readonly [
    JourneyCampaignStoryChoiceOption<ChoiceId>,
    JourneyCampaignStoryChoiceOption<ChoiceId>,
  ];
}>;

type AlbanyDawnDispatchStoryChoice = JourneyCampaignStoryChoiceDefinition<
  typeof ALBANY_DAWN_DISPATCH_ID,
  AlbanyDawnDispatchChoiceId
>;

type TannersFeverAccountabilityStoryChoice = JourneyCampaignStoryChoiceDefinition<
  typeof TANNERS_FEVER_ACCOUNTABILITY_ID,
  TannersFeverAccountabilityChoiceId
>;

type RomePostWeirDispatchStoryChoice = JourneyCampaignStoryChoiceDefinition<
  typeof ROME_POST_WEIR_DISPATCH_ID,
  RomePostWeirDispatchChoiceId
>;

type JourneyCampaignStoryChoice =
  | AlbanyDawnDispatchStoryChoice
  | TannersFeverAccountabilityStoryChoice
  | RomePostWeirDispatchStoryChoice;

type JourneyCampaignStoryChoiceSelection =
  | Readonly<{
      storyChoiceId: typeof ALBANY_DAWN_DISPATCH_ID;
      choiceId: AlbanyDawnDispatchChoiceId;
      goal: JourneyCampaignGoalDefinition;
    }>
  | Readonly<{
      storyChoiceId: typeof TANNERS_FEVER_ACCOUNTABILITY_ID;
      choiceId: TannersFeverAccountabilityChoiceId;
      goal: JourneyCampaignGoalDefinition;
    }>
  | Readonly<{
      storyChoiceId: typeof ROME_POST_WEIR_DISPATCH_ID;
      choiceId: RomePostWeirDispatchChoiceId;
      goal: JourneyCampaignGoalDefinition;
    }>;

type JourneyCampaignJournalCopy = Readonly<{
  title: string;
  text: string;
}>;

/**
 * Exact journal-copy digests from the immediately preceding authored prose.
 *
 * Campaign journals are durable save evidence, so a copy-only rewrite needs a
 * narrow migration path. The goal id limits each allowlist, and the full digest
 * covers both title and text. Anything except an exact predecessor remains
 * subject to the normal forged-journal rejection.
 */
const ALBANY_DAWN_PREDECESSOR_JOURNAL_DIGESTS: Readonly<
  Record<AlbanyDawnDispatchChoiceId, Readonly<Record<string, string>>>
> = Object.freeze({
  send_wagon_to_cade: Object.freeze({
    pack_diverted: "35bd3f64f2cbb9536a856af9740079ef015801a8270eeee0340c4d6981af7542",
    pack_diverted_cattle_scattered:
      "3968aa16600d65d296be568b0318a858b5636a9b8a10a41bdc0f6d6e08c5ef09",
    pack_diverted_after_blood: "75be5427c477e02f061f5450af6b1c5c48e73f1652fb355dac511e123a842721",
    bloodied_byre_evacuated: "8e6fd0121605748816b92e875755ca0441e6e080fa5aaf3600f43455f0e1a772",
    drive_cattle_wounded: "3ad7ccf8493eafbec2f564e372b6e150f539ace1b0caa9362fa7f5d009ec4efa",
    drive_person_cattle_lost: "5e92e1d896c95f0c2cca802f4196f0a972b9d4b80842da03540661d079ed8170",
    drive_reserve_spent: "dab8916d4db8592c289effc03d210280d167648cac9836af21192ab07175c4cf",
    fortified_cade_terms: "98bc8b03e27c4285286ac7f7df772c4dd922524a1067fafd80498489b30fadf4",
    fortified_albany_authority: "3f29ef4405140cb13dd670f7cce07256e8d421b6b03b20c4e9b0f73dac970aad",
    gate_barred: "bfe3b781aa62f2e66dce2620054d4e6489854216b9975b800951dbfce6c0e2f3",
    timber_saved: "906070e3510a8fc7f687810e6a30e50dfbaaf55944ff57757655ad141a96870f",
    held: "6419ee1be6f94aa5f3304faff0e6a2143dac04190668cad519b0c4fd02783b5d",
  }),
  send_wardens_north: Object.freeze({
    pack_diverted: "685fe785938a057ea54c038654dbb165b065f0132c7f4d20783dc69dc89f6724",
    pack_diverted_cattle_scattered:
      "abcc2f57c1a4fd08d96c9a59ff068ef259c43a148cce3a734a1673ba696e791b",
    pack_diverted_after_blood: "bb0c7dcc80bb0526c0015f530fc3f303468f4073d8eb2910352c7a1c2813bbca",
    bloodied_byre_evacuated: "92f16715b233e3b77997d1707c4bc4bd7b834e335102753c2c9711b5ed290657",
    drive_cattle_wounded: "ab571d2fa1377c8ac40c22cfb4c7a2c3f917b76bcfe74a280488d34ae5a7ade2",
    drive_person_cattle_lost: "f13fc06630a3f50aeb08882147f839893c8b54d8b41052ffd96a9f802b30241f",
    drive_reserve_spent: "437f5c23a34044d0cc097942bbadf9ef3453cf8aeb5e21d8e3b3173cb1b726b6",
    fortified_cade_terms: "f09c0f79c39f92c26547421daad5dec4d9627f663d025cc32ff578aa831f838b",
    fortified_albany_authority: "cfb8708ef2f7d88e29a11cd72129afda2afdfdcfbde62aa1cc61c7820da2c31b",
    gate_barred: "b6a6c5b3e1de3d313b029635bc2fdcdff771fadf90ea93cc9c122347981cf10a",
    timber_saved: "498df52955d96c066676b698a03f182622a1bd92f26d3579ebb90c7bcfcdf0b9",
    held: "15b3bef2c7f8d434fd4acab850d152fff973951693fb3af3261ce81b3b8332ff",
  }),
});

const JOURNEY_CAMPAIGN_PREDECESSOR_JOURNAL_DIGESTS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  [
    "oneonta_tanners_fever",
    new Set(["1be0fe8795f327b71878ac268aca954a43cfc925ec013152952a72f15744585f"]),
  ],
  [
    "rome_breaking_weir_household_correction",
    new Set(["2529537922215bf988ebe89a87aa3d72c6d140e8e03ff7561cd37d1588e923fc"]),
  ],
  [
    "rome_breaking_weir_public_warning",
    new Set(["208be0992b0a8ad33d7b5b9aff4d586a74f519cf8738f9f74bcd1933c7e4d97d"]),
  ],
  [
    "rome_breaking_weir",
    new Set(["7966eda2d44af4950fce863b83696e8c063847f9077f5e493c2b29bc16c03ff8"]),
  ],
  [
    "oswego_advocates_case_first",
    new Set(["22b0bb99da86df9bd8d98279709756308871e9bd7016e43f6f7ade4d214f5e1d"]),
  ],
  [
    "greece_cold_forge_first",
    new Set(["70d37fe38e8d5e74c4c1bf34d71a871ba9a74257e680af53075279910b4f3dc8"]),
  ],
  [
    "oswego_advocates_case",
    new Set(["0220874742df976f7762117fa35b0d49ab7300e8a730c0bf8ef543519088e8a9"]),
  ],
  [
    "greece_cold_forge",
    new Set(["5f62e02ddaeb5e5948915762a179c409b4575b3bb8d0a58f46d85134538a2d90"]),
  ],
  [
    "amherst_dawn_beacon",
    new Set(["995e925d8edd16c5ebf531a23ef9b111f7bc24b4ec0d876cfccbc15dbe8f3048"]),
  ],
  [
    "cheektowaga_factors_mark",
    new Set(["e4f1a64f028cef452c4f63fd2abccc825602ca448cb2e5bcaa333b1ca941868d"]),
  ],
  [
    "tonawanda_falconers_ransom",
    new Set(["1a185b7b26c86ebe42974e3274f514166c855e271defe85229e9ba0711bb3245"]),
  ],
  [
    "new_york_tide_mill",
    new Set(["21939acfce29bf0712187b5743930e8dbecbb20dd2cfb0ce5bd8bdf97ae3ece2"]),
  ],
  [
    "riverhead_sunken_barrow",
    new Set(["67e76aabf3936f0ddf7c06dff63bcd08287f59e0d6d08209c4e2f48c062f5a0c"]),
  ],
  [
    "southampton_printers_night",
    new Set(["b4d3a97b317a0012a37a8e354bc2f7948cfcfb9f08277af78f2ebe4a3d8177a1"]),
  ],
]);

export function journeyCampaignGoalJournalIsExactPredecessorCopy(
  definition: JourneyCampaignGoalDefinition,
  copy: JourneyCampaignJournalCopy,
  questOutcomeIds: ReadonlyMap<string, string>,
): boolean {
  const dispatchChoice = albanyDispatchChoiceForGoal(definition);
  if (dispatchChoice) {
    const outcome = wolfWinterCampaignOutcome(questOutcomeIds);
    if (!outcome) return false;
    return (
      ALBANY_DAWN_PREDECESSOR_JOURNAL_DIGESTS[dispatchChoice][outcome.id] ===
      hashState([copy.title, copy.text])
    );
  }
  const acceptedDigests = JOURNEY_CAMPAIGN_PREDECESSOR_JOURNAL_DIGESTS.get(definition.id);
  return acceptedDigests?.has(hashState([copy.title, copy.text])) ?? false;
}

export function wolfWinterCampaignOutcome(
  questOutcomeIds: ReadonlyMap<string, string>,
): WolfWinterCampaignOutcomeContext | null {
  const endingId = questOutcomeIds.get(JOURNEY_CAMPAIGN_INITIAL_QUEST_ID);
  return endingId === undefined ? null : (WOLF_OUTCOME_BY_ID.get(endingId) ?? null);
}

export function breakingWeirCampaignOutcome(
  questOutcomeIds: ReadonlyMap<string, string>,
): BreakingWeirCampaignOutcomeContext | null {
  const endingId = questOutcomeIds.get("breaking_weir");
  return endingId === undefined ? null : (BREAKING_WEIR_OUTCOME_BY_ID.get(endingId) ?? null);
}

/** Keep authored campaign aftermaths bound only to supported victory endings. */
export function assertJourneyCampaignQuestOutcome(questId: string, endingId: string): void {
  if (questId === JOURNEY_CAMPAIGN_INITIAL_QUEST_ID) {
    if (WOLF_OUTCOME_BY_ID.has(endingId)) return;
    throw new Error(
      `Journey campaign quest "${questId}" has unsupported completion ending "${endingId}".`,
    );
  }
  if (questId !== "breaking_weir" || BREAKING_WEIR_OUTCOME_BY_ID.has(endingId)) return;
  throw new Error(
    `Journey campaign quest "${questId}" has unsupported completion ending "${endingId}".`,
  );
}

function albanyDawnDispatchGoal(
  choiceId: AlbanyDawnDispatchChoiceId,
): JourneyCampaignGoalDefinition {
  return ALBANY_DAWN_DISPATCH_GOALS[choiceId];
}

export function albanyDawnDispatchStoryChoice(
  outcome: WolfWinterCampaignOutcomeContext,
): AlbanyDawnDispatchStoryChoice {
  const consequences = ALBANY_DAWN_DISPATCH_CONSEQUENCES[outcome.id];
  return Object.freeze({
    id: ALBANY_DAWN_DISPATCH_ID,
    message:
      "Wolf-Winter is complete. Send Albany's only dawn relief wagon to Cade or north with the wardens. Your next goal is The Gallowmere in Queensbury.",
    options: Object.freeze([
      Object.freeze({
        id: "send_wagon_to_cade" as const,
        label: "Send the wagon back to Cade",
        consequence: `${consequences.send_wagon_to_cade} ${ALBANY_DAWN_DISPATCH_SERVICE_TERMS.send_wagon_to_cade}`,
      }),
      Object.freeze({
        id: "send_wardens_north" as const,
        label: "Send the wagon and wardens north",
        consequence: `${consequences.send_wardens_north} ${ALBANY_DAWN_DISPATCH_SERVICE_TERMS.send_wardens_north}`,
      }),
    ] as const),
  });
}

function tannersFeverAccountabilityGoal(
  choiceId: TannersFeverAccountabilityChoiceId,
): JourneyCampaignGoalDefinition {
  return TANNERS_FEVER_ACCOUNTABILITY_GOALS[choiceId];
}

export function tannersFeverAccountabilityStoryChoice(): TannersFeverAccountabilityStoryChoice {
  return Object.freeze({
    id: TANNERS_FEVER_ACCOUNTABILITY_ID,
    message:
      "Edric will recover. Keep the corrected dose in his private household record, or publish a warning for other patients.",
    options: Object.freeze([
      Object.freeze({
        id: "keep_household_correction" as const,
        label: "Keep the correction in the household record",
        consequence: TANNERS_FEVER_ACCOUNTABILITY_CONSEQUENCES.keep_household_correction,
      }),
      Object.freeze({
        id: "publish_dosage_warning" as const,
        label: "Publish the dosage warning",
        consequence: TANNERS_FEVER_ACCOUNTABILITY_CONSEQUENCES.publish_dosage_warning,
      }),
    ] as const),
  });
}

function romePostWeirDispatchGoal(
  choiceId: RomePostWeirDispatchChoiceId,
): JourneyCampaignGoalDefinition {
  return ROME_POST_WEIR_DISPATCH_GOALS[choiceId];
}

export function romePostWeirDispatchStoryChoice(): RomePostWeirDispatchStoryChoice {
  return Object.freeze({
    id: ROME_POST_WEIR_DISPATCH_ID,
    message: "Choose the next report: Oswego's charter case or Greece's cold forge.",
    options: Object.freeze([
      Object.freeze({
        id: "take_oswego_charter_packet" as const,
        label: "Carry the Oswego charter packet first",
        consequence: ROME_POST_WEIR_DISPATCH_CONSEQUENCES.take_oswego_charter_packet,
      }),
      Object.freeze({
        id: "take_greece_forge_packet" as const,
        label: "Carry the Greece forge packet first",
        consequence: ROME_POST_WEIR_DISPATCH_CONSEQUENCES.take_greece_forge_packet,
      }),
    ] as const),
  });
}

function isAlbanyDawnDispatchChoiceId(value: string): value is AlbanyDawnDispatchChoiceId {
  return ALBANY_DAWN_DISPATCH_CHOICE_IDS.some((choiceId) => choiceId === value);
}

function isTannersFeverAccountabilityChoiceId(
  value: string,
): value is TannersFeverAccountabilityChoiceId {
  return TANNERS_FEVER_ACCOUNTABILITY_CHOICE_IDS.some((choiceId) => choiceId === value);
}

function isRomePostWeirDispatchChoiceId(value: string): value is RomePostWeirDispatchChoiceId {
  return ROME_POST_WEIR_DISPATCH_CHOICE_IDS.some((choiceId) => choiceId === value);
}

export function journeyCampaignStoryChoiceSelection(
  storyChoiceId: string,
  choiceId: string,
): JourneyCampaignStoryChoiceSelection {
  if (storyChoiceId === ALBANY_DAWN_DISPATCH_ID) {
    if (!isAlbanyDawnDispatchChoiceId(choiceId)) {
      throw new Error(`Story choice "${storyChoiceId}" does not accept option "${choiceId}".`);
    }
    return Object.freeze({
      storyChoiceId,
      choiceId,
      goal: albanyDawnDispatchGoal(choiceId),
    });
  }
  if (storyChoiceId === TANNERS_FEVER_ACCOUNTABILITY_ID) {
    if (!isTannersFeverAccountabilityChoiceId(choiceId)) {
      throw new Error(`Story choice "${storyChoiceId}" does not accept option "${choiceId}".`);
    }
    return Object.freeze({
      storyChoiceId,
      choiceId,
      goal: tannersFeverAccountabilityGoal(choiceId),
    });
  }
  if (storyChoiceId === ROME_POST_WEIR_DISPATCH_ID) {
    if (!isRomePostWeirDispatchChoiceId(choiceId)) {
      throw new Error(`Story choice "${storyChoiceId}" does not accept option "${choiceId}".`);
    }
    return Object.freeze({
      storyChoiceId,
      choiceId,
      goal: romePostWeirDispatchGoal(choiceId),
    });
  }
  throw new Error(`Unknown journey campaign story choice "${storyChoiceId}".`);
}

function albanyDispatchChoiceForGoal(
  definition: JourneyCampaignGoalDefinition,
): AlbanyDawnDispatchChoiceId | null {
  return (
    ALBANY_DAWN_DISPATCH_CHOICE_IDS.find(
      (choiceId) => ALBANY_DAWN_DISPATCH_GOALS[choiceId].id === definition.id,
    ) ?? null
  );
}

/**
 * Recover the canonical authored story selection from the goal it activated.
 * This inverse keeps campaign consequences derived from trusted goal history
 * instead of introducing a second mutable choice field into saves.
 */
export function journeyCampaignStoryChoiceRefForGoal(
  definition: JourneyCampaignGoalDefinition,
): CampaignStoryChoiceRef | null {
  const dispatchChoice = albanyDispatchChoiceForGoal(definition);
  if (dispatchChoice) {
    return Object.freeze({
      story_choice_id: ALBANY_DAWN_DISPATCH_ID,
      choice_id: dispatchChoice,
    });
  }
  const accountabilityChoice = tannersFeverAccountabilityChoiceForGoal(definition);
  if (accountabilityChoice) {
    return Object.freeze({
      story_choice_id: TANNERS_FEVER_ACCOUNTABILITY_ID,
      choice_id: accountabilityChoice,
    });
  }
  const postWeirDispatchChoice = romePostWeirDispatchChoiceForGoal(definition);
  if (postWeirDispatchChoice) {
    return Object.freeze({
      story_choice_id: ROME_POST_WEIR_DISPATCH_ID,
      choice_id: postWeirDispatchChoice,
    });
  }
  return null;
}

/** Ordered, deduplicated selections proven by current plus historical goals. */
export function journeyCampaignSelectedStoryChoiceRefs(
  journey: Pick<JourneyContractSnapshot, "goal" | "goalHistory">,
): CampaignStoryChoiceRef[] {
  const refs = new Map<string, CampaignStoryChoiceRef>();
  const choiceByStoryId = new Map<string, string>();
  for (const goal of [...journey.goalHistory, journey.goal]) {
    const definition = journeyCampaignGoalDefinition(goal);
    if (!definition) continue;
    const ref = journeyCampaignStoryChoiceRefForGoal(definition);
    if (!ref) continue;
    const selectedChoice = choiceByStoryId.get(ref.story_choice_id);
    if (selectedChoice !== undefined && selectedChoice !== ref.choice_id) {
      throw new Error(
        `Journey campaign story choice "${ref.story_choice_id}" selects both "${selectedChoice}" and "${ref.choice_id}".`,
      );
    }
    choiceByStoryId.set(ref.story_choice_id, ref.choice_id);
    refs.set(campaignStoryChoiceRefKey(ref), ref);
  }
  return [...refs.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, ref]) => ({ ...ref }));
}

function tannersFeverAccountabilityChoiceForGoal(
  definition: JourneyCampaignGoalDefinition,
): TannersFeverAccountabilityChoiceId | null {
  return (
    TANNERS_FEVER_ACCOUNTABILITY_CHOICE_IDS.find(
      (choiceId) => TANNERS_FEVER_ACCOUNTABILITY_GOALS[choiceId].id === definition.id,
    ) ?? null
  );
}

function romePostWeirDispatchChoiceForGoal(
  definition: JourneyCampaignGoalDefinition,
): RomePostWeirDispatchChoiceId | null {
  return (
    ROME_POST_WEIR_DISPATCH_CHOICE_IDS.find(
      (choiceId) => ROME_POST_WEIR_DISPATCH_GOALS[choiceId].id === definition.id,
    ) ?? null
  );
}

export function journeyCampaignGoalJournalCopy(
  definition: JourneyCampaignGoalDefinition,
  questOutcomeIds: ReadonlyMap<string, string>,
): JourneyCampaignJournalCopy {
  const dispatchChoice = albanyDispatchChoiceForGoal(definition);
  if (dispatchChoice) {
    const outcome = wolfWinterCampaignOutcome(questOutcomeIds);
    if (!outcome) throw new Error("Albany dawn dispatch requires a supported Wolf-Winter ending.");
    const option = albanyDawnDispatchStoryChoice(outcome).options.find(
      (candidate) => candidate.id === dispatchChoice,
    );
    if (!option) throw new Error(`Albany dawn dispatch option "${dispatchChoice}" is unavailable.`);
    // The durable campaign journal records the irreversible wagon disposition.
    // Its exact copy predates one-time service offers and therefore remains
    // stable across the direct campaign-service migration. The live choice and
    // named service offer disclose the additional terms before and after choice.
    return Object.freeze({
      title: option.label,
      text: ALBANY_DAWN_DISPATCH_CONSEQUENCES[outcome.id][dispatchChoice],
    });
  }
  const accountabilityChoice = tannersFeverAccountabilityChoiceForGoal(definition);
  if (accountabilityChoice) {
    const option = tannersFeverAccountabilityStoryChoice().options.find(
      (candidate) => candidate.id === accountabilityChoice,
    );
    if (!option) {
      throw new Error(
        `Tanner's Fever accountability option "${accountabilityChoice}" is unavailable.`,
      );
    }
    return Object.freeze({ title: option.label, text: option.consequence });
  }
  const postWeirDispatchChoice = romePostWeirDispatchChoiceForGoal(definition);
  if (postWeirDispatchChoice) {
    const option = romePostWeirDispatchStoryChoice().options.find(
      (candidate) => candidate.id === postWeirDispatchChoice,
    );
    if (!option) {
      throw new Error(`Rome post-Weir dispatch option "${postWeirDispatchChoice}" is unavailable.`);
    }
    return Object.freeze({ title: option.label, text: option.consequence });
  }
  if (definition.id === INITIAL_JOURNEY_CAMPAIGN_GOAL.id) {
    throw new Error("The initial journey goal does not have an activation journal entry.");
  }
  return Object.freeze({
    title: "New goal",
    text: definition.text,
  });
}

export const TANNERS_FEVER_CAMPAIGN_GOAL = campaignGoal(
  "oneonta_tanners_fever",
  "Travel to Oneonta Market Streets. Find and complete The Tanner's Fever.",
  "tanners_fever",
  "oneonta_city",
  "oneonta_city__market",
);

/** Lookup-only compatibility for version 8 saves created before the accountability branch. */
const LEGACY_ROME_BREAKING_WEIR_GOAL = campaignGoal(
  "rome_breaking_weir",
  "Travel to Rome Market Streets. Find and complete The Breaking Weir.",
  "breaking_weir",
  "rome_city",
  "rome_city__market",
);

/** Preserve these ids and their generic journal copy for existing version-8 saves. */
const LEGACY_OSWEGO_ADVOCATES_CASE_GOAL = campaignGoal(
  "oswego_advocates_case",
  "Travel to Oswego Market Streets. Find and complete The Advocate's Case.",
  "advocates_case",
  "oswego_city",
  "oswego_city__market",
);

const LEGACY_GREECE_COLD_FORGE_GOAL = campaignGoal(
  "greece_cold_forge",
  "Travel to Greece Market Streets. Find and complete The Cold Forge.",
  "cold_forge",
  "greece_town",
  "greece_town__market",
);

const ORDERED_POST_BREAKING_WEIR_GOALS = Object.freeze([
  LEGACY_OSWEGO_ADVOCATES_CASE_GOAL,
  LEGACY_GREECE_COLD_FORGE_GOAL,
  campaignGoal(
    "amherst_dawn_beacon",
    "Travel to Amherst Market Streets. Find and complete The Dawn Beacon.",
    "dawn_beacon",
    "amherst_town",
    "amherst_town__market",
  ),
  campaignGoal(
    "cheektowaga_factors_mark",
    "Travel to Cheektowaga Market Streets. Find and complete The Factor's Mark.",
    "factors_mark",
    "cheektowaga_town",
    "cheektowaga_town__market",
  ),
  campaignGoal(
    "tonawanda_falconers_ransom",
    "Travel to Tonawanda Market Streets. Find and complete The Falconer's Ransom.",
    "falconers_ransom",
    "tonawanda_town",
    "tonawanda_town__market",
  ),
  campaignGoal(
    "new_york_tide_mill",
    "Travel to New York Waterfront. Find and complete The Tide-Mill.",
    "tide_mill",
    "new_york_city",
    "new_york_city__waterfront",
  ),
  campaignGoal(
    "riverhead_sunken_barrow",
    "Travel to Riverhead Market Streets. Find and complete The Sunken Barrow.",
    "sunken_barrow",
    "riverhead_town",
    "riverhead_town__market",
  ),
  campaignGoal(
    "southampton_printers_night",
    "Travel to Southampton Market Streets. Find and complete The Printer's Night.",
    "printers_night",
    "southampton_town",
    "southampton_town__market",
  ),
]);

export const JOURNEY_CAMPAIGN_QUEST_ORDER = Object.freeze([
  JOURNEY_CAMPAIGN_INITIAL_QUEST_ID,
  "gallowmere",
  TANNERS_FEVER_CAMPAIGN_GOAL.targetQuestId,
  TANNERS_FEVER_ACCOUNTABILITY_GOALS.keep_household_correction.targetQuestId,
  ...ORDERED_POST_BREAKING_WEIR_GOALS.map((goal) => goal.targetQuestId),
] as const);

const GOALS_BY_ID: ReadonlyMap<string, JourneyCampaignGoalDefinition> = new Map([
  [INITIAL_JOURNEY_CAMPAIGN_GOAL.id, INITIAL_JOURNEY_CAMPAIGN_GOAL],
  ...Object.values(ALBANY_DAWN_DISPATCH_GOALS).map((goal) => [goal.id, goal] as const),
  [TANNERS_FEVER_CAMPAIGN_GOAL.id, TANNERS_FEVER_CAMPAIGN_GOAL],
  ...Object.values(TANNERS_FEVER_ACCOUNTABILITY_GOALS).map((goal) => [goal.id, goal] as const),
  [LEGACY_ROME_BREAKING_WEIR_GOAL.id, LEGACY_ROME_BREAKING_WEIR_GOAL],
  ...Object.values(ROME_POST_WEIR_DISPATCH_GOALS).map((goal) => [goal.id, goal] as const),
  ...ORDERED_POST_BREAKING_WEIR_GOALS.map((goal) => [goal.id, goal] as const),
]);

export function journeyCampaignGoalDefinition(
  goal: Pick<JourneyGoalDefinition, "id">,
): JourneyCampaignGoalDefinition | null {
  return GOALS_BY_ID.get(goal.id) ?? null;
}

export function materializeJourneyCampaignGoal(
  definition: JourneyCampaignGoalDefinition,
  currentGoalVersion: number,
): JourneyGoalDefinition {
  if (!Number.isSafeInteger(currentGoalVersion) || currentGoalVersion < 1) {
    throw new Error("Current journey goal version must be a positive safe integer.");
  }
  if (currentGoalVersion === Number.MAX_SAFE_INTEGER) {
    throw new Error("Journey goal version has reached the maximum safe integer.");
  }
  return Object.freeze({
    version: currentGoalVersion + 1,
    id: definition.id,
    text: definition.text,
  });
}

export function nextJourneyCampaignGoal(args: {
  completedQuestIds: ReadonlySet<string>;
  albanyDawnDispatchChoiceId?: AlbanyDawnDispatchChoiceId | null;
  tannersFeverAccountabilityChoiceId?: TannersFeverAccountabilityChoiceId | null;
}): JourneyCampaignGoalDefinition | null {
  if (!args.completedQuestIds.has(JOURNEY_CAMPAIGN_INITIAL_QUEST_ID)) return null;
  if (!args.completedQuestIds.has("gallowmere")) {
    return args.albanyDawnDispatchChoiceId
      ? albanyDawnDispatchGoal(args.albanyDawnDispatchChoiceId)
      : null;
  }
  if (!args.completedQuestIds.has(TANNERS_FEVER_CAMPAIGN_GOAL.targetQuestId)) {
    return TANNERS_FEVER_CAMPAIGN_GOAL;
  }
  if (!args.completedQuestIds.has("breaking_weir")) {
    return args.tannersFeverAccountabilityChoiceId
      ? tannersFeverAccountabilityGoal(args.tannersFeverAccountabilityChoiceId)
      : null;
  }
  if (
    !args.completedQuestIds.has(LEGACY_OSWEGO_ADVOCATES_CASE_GOAL.targetQuestId) &&
    !args.completedQuestIds.has(LEGACY_GREECE_COLD_FORGE_GOAL.targetQuestId)
  ) {
    return null;
  }
  return (
    ORDERED_POST_BREAKING_WEIR_GOALS.find(
      (goal) => !args.completedQuestIds.has(goal.targetQuestId),
    ) ?? null
  );
}

export function journeyCampaignGoalIsComplete(
  goal: Pick<JourneyGoalDefinition, "id">,
  completedQuestIds: ReadonlySet<string>,
): boolean {
  const definition = journeyCampaignGoalDefinition(goal);
  return definition !== null && completedQuestIds.has(definition.targetQuestId);
}

function assertKnownGoalCompletion(
  goal: JourneyContractSnapshot["goal"] | JourneyContractSnapshot["goalHistory"][number],
  completedQuestIds: ReadonlySet<string>,
): void {
  const definition = journeyCampaignGoalDefinition(goal);
  if (!definition) throw new Error(`Unknown journey campaign goal "${goal.id}".`);
  const completed = completedQuestIds.has(definition.targetQuestId);
  if (goal.status === "completed" && !completed) {
    throw new Error(
      `Journey goal "${goal.id}" is complete without target quest "${definition.targetQuestId}".`,
    );
  }
  if (goal.status === "active" && completed) {
    throw new Error(
      `Journey goal "${goal.id}" is active despite completed target quest "${definition.targetQuestId}".`,
    );
  }
}

export function assertJourneyCampaignGoalCompletionProof(args: {
  journey: JourneyContractSnapshot;
  completedQuestIds: ReadonlySet<string>;
  startTownId: string;
}): void {
  if (args.startTownId !== JOURNEY_CAMPAIGN_START_TOWN_ID) {
    throw new Error(
      `Journey campaign starts in ${JOURNEY_CAMPAIGN_START_TOWN_ID}, not "${args.startTownId}".`,
    );
  }
  for (const goal of args.journey.goalHistory) {
    assertKnownGoalCompletion(goal, args.completedQuestIds);
  }
  assertKnownGoalCompletion(args.journey.goal, args.completedQuestIds);

  if (
    args.journey.goal.id !== INITIAL_JOURNEY_GOAL.id &&
    !args.journey.goalHistory.some(
      (goal) =>
        goal.version === INITIAL_JOURNEY_GOAL.version && goal.id === INITIAL_JOURNEY_GOAL.id,
    )
  ) {
    throw new Error("A follow-up journey goal requires the completed Albany opening goal.");
  }
}

export function assertJourneyCampaignJournalProof(args: {
  journey: JourneyContractSnapshot;
  questOutcomeIds: ReadonlyMap<string, string>;
  journalEntries: readonly {
    id: string;
    kind: string;
    title: string;
    text: string;
  }[];
}): void {
  const goalsByVersion = new Map<number, JourneyContractSnapshot["goal"]>();
  for (const goal of args.journey.goalHistory) goalsByVersion.set(goal.version, goal);
  goalsByVersion.set(args.journey.goal.version, args.journey.goal);
  const activatedGoals = [...goalsByVersion.values()].filter((goal) => goal.version > 1);
  const campaignEntries = args.journalEntries.filter((entry) => entry.kind === "campaign");
  if (campaignEntries.length !== activatedGoals.length) {
    throw new Error(
      `Overworld session snapshot has ${String(campaignEntries.length)} campaign journal entries for ${String(activatedGoals.length)} activated journey goals.`,
    );
  }
  const entriesById = new Map(campaignEntries.map((entry) => [entry.id, entry]));
  for (const goal of activatedGoals) {
    const entryId = `campaign_goal:${String(goal.version)}:${goal.id}`;
    const entry = entriesById.get(entryId);
    if (!entry) {
      throw new Error(`Overworld session snapshot is missing campaign journal entry "${entryId}".`);
    }
    const definition = journeyCampaignGoalDefinition(goal);
    if (!definition) throw new Error(`Unknown journey campaign goal "${goal.id}".`);
    const expected = journeyCampaignGoalJournalCopy(definition, args.questOutcomeIds);
    if (entry.title !== expected.title || entry.text !== expected.text) {
      throw new Error(`Overworld session snapshot campaign journal entry "${entryId}" is forged.`);
    }
  }
}

function awaitsInitialGoalChoice(journey: JourneyContractSnapshot): boolean {
  return (
    journey.status === "awaiting_choice" &&
    journey.pendingChoice?.reasons.includes("goal_completed") === true &&
    journey.pendingChoice.goalVersion === INITIAL_JOURNEY_GOAL.version &&
    journey.pendingChoice.goalId === INITIAL_JOURNEY_GOAL.id
  );
}

function awaitsAlbanyDawnDispatch(journey: JourneyContractSnapshot): boolean {
  return (
    journey.status === "active" &&
    journey.goal.version === INITIAL_JOURNEY_GOAL.version &&
    journey.goal.id === INITIAL_JOURNEY_GOAL.id &&
    journey.goal.status === "completed" &&
    hasContinuedJourneyGoal(journey, INITIAL_JOURNEY_GOAL)
  );
}

function awaitsTannersFeverGoalChoice(journey: JourneyContractSnapshot): boolean {
  return (
    journey.status === "awaiting_choice" &&
    journey.goal.id === TANNERS_FEVER_CAMPAIGN_GOAL.id &&
    journey.goal.status === "completed" &&
    journey.pendingChoice?.reasons.includes("goal_completed") === true &&
    journey.pendingChoice.goalVersion === journey.goal.version &&
    journey.pendingChoice.goalId === journey.goal.id
  );
}

function awaitsTannersFeverAccountability(journey: JourneyContractSnapshot): boolean {
  return (
    journey.status === "active" &&
    journey.goal.id === TANNERS_FEVER_CAMPAIGN_GOAL.id &&
    journey.goal.status === "completed" &&
    hasContinuedJourneyGoal(journey, journey.goal)
  );
}

function currentGoalTargetsBreakingWeir(journey: JourneyContractSnapshot): boolean {
  return journeyCampaignGoalDefinition(journey.goal)?.targetQuestId === "breaking_weir";
}

type JourneyCampaignPendingStoryStep =
  | "albany_dawn_dispatch"
  | "tanners_fever_accountability"
  | "rome_post_weir_dispatch";

/**
 * The story choice the campaign needs before its next goal can activate, derived from
 * completed quests exactly as nextJourneyCampaignGoal derives its null-returning
 * branches. Quests are not gated by the active goal, so a player can complete a later
 * campaign quest while an earlier goal is still active; presentation keyed only on the
 * current goal's identity then dead-ends the campaign at that goal's continue.
 */
export function journeyCampaignPendingStoryStep(
  completedQuestIds: ReadonlySet<string>,
): JourneyCampaignPendingStoryStep | null {
  if (!completedQuestIds.has(JOURNEY_CAMPAIGN_INITIAL_QUEST_ID)) return null;
  if (!completedQuestIds.has("gallowmere")) return "albany_dawn_dispatch";
  if (!completedQuestIds.has(TANNERS_FEVER_CAMPAIGN_GOAL.targetQuestId)) return null;
  if (!completedQuestIds.has("breaking_weir")) return "tanners_fever_accountability";
  if (
    !completedQuestIds.has(LEGACY_OSWEGO_ADVOCATES_CASE_GOAL.targetQuestId) &&
    !completedQuestIds.has(LEGACY_GREECE_COLD_FORGE_GOAL.targetQuestId)
  ) {
    return "rome_post_weir_dispatch";
  }
  return null;
}

function awaitsAnyGoalCompletionChoice(journey: JourneyContractSnapshot): boolean {
  return (
    journey.status === "awaiting_choice" &&
    journey.goal.status === "completed" &&
    journey.pendingChoice?.reasons.includes("goal_completed") === true &&
    journey.pendingChoice.goalVersion === journey.goal.version &&
    journey.pendingChoice.goalId === journey.goal.id
  );
}

function awaitsAnyStoryContinuation(journey: JourneyContractSnapshot): boolean {
  return (
    journey.status === "active" &&
    journey.goal.status === "completed" &&
    hasContinuedJourneyGoal(journey, journey.goal)
  );
}

function awaitsBreakingWeirGoalChoice(journey: JourneyContractSnapshot): boolean {
  return (
    journey.status === "awaiting_choice" &&
    currentGoalTargetsBreakingWeir(journey) &&
    journey.goal.status === "completed" &&
    journey.pendingChoice?.reasons.includes("goal_completed") === true &&
    journey.pendingChoice.goalVersion === journey.goal.version &&
    journey.pendingChoice.goalId === journey.goal.id
  );
}

function awaitsRomePostWeirDispatch(journey: JourneyContractSnapshot): boolean {
  return (
    journey.status === "active" &&
    currentGoalTargetsBreakingWeir(journey) &&
    journey.goal.status === "completed" &&
    hasContinuedJourneyGoal(journey, journey.goal)
  );
}

type JourneyCampaignPresentationContext = Readonly<{
  completionContext: string;
  preRetentionTeaser: string | null;
  continueLabel?: string;
  continueConsequencePrefix: string | null;
  continuationPreview?: AlbanyDawnDispatchStoryChoice;
  storyChoice: JourneyCampaignStoryChoice | null;
}>;

export function journeyCampaignPresentationContext(args: {
  journey: JourneyContractSnapshot;
  questOutcomeIds: ReadonlyMap<string, string>;
  completedQuestIds?: ReadonlySet<string>;
}): JourneyCampaignPresentationContext | null {
  const beforeAlbanyRetention = awaitsInitialGoalChoice(args.journey);
  const afterAlbanyContinue = awaitsAlbanyDawnDispatch(args.journey);
  if (beforeAlbanyRetention || afterAlbanyContinue) {
    const outcome = wolfWinterCampaignOutcome(args.questOutcomeIds);
    if (!outcome) return null;
    return Object.freeze({
      completionContext: outcome.albanyReturnContext,
      preRetentionTeaser: beforeAlbanyRetention ? ALBANY_DAWN_DISPATCH_TEASER : null,
      ...(beforeAlbanyRetention ? { continueLabel: ALBANY_DAWN_DISPATCH_CONTINUE_LABEL } : {}),
      ...(beforeAlbanyRetention
        ? { continuationPreview: albanyDawnDispatchStoryChoice(outcome) }
        : {}),
      continueConsequencePrefix: beforeAlbanyRetention
        ? ALBANY_DAWN_DISPATCH_CONTINUE_CONSEQUENCE_PREFIX
        : null,
      storyChoice: afterAlbanyContinue ? albanyDawnDispatchStoryChoice(outcome) : null,
    });
  }

  const beforeTannersRetention = awaitsTannersFeverGoalChoice(args.journey);
  const afterTannersContinue = awaitsTannersFeverAccountability(args.journey);
  if (beforeTannersRetention || afterTannersContinue) {
    return Object.freeze({
      completionContext: TANNERS_FEVER_ACCOUNTABILITY_CONTEXT,
      preRetentionTeaser: beforeTannersRetention ? TANNERS_FEVER_ACCOUNTABILITY_TEASER : null,
      continueConsequencePrefix: beforeTannersRetention
        ? "Continue to decide how Oneonta records the corrected dose."
        : null,
      storyChoice: afterTannersContinue ? tannersFeverAccountabilityStoryChoice() : null,
    });
  }

  const beforeBreakingWeirRetention = awaitsBreakingWeirGoalChoice(args.journey);
  const afterBreakingWeirContinue = awaitsRomePostWeirDispatch(args.journey);
  if (beforeBreakingWeirRetention || afterBreakingWeirContinue) {
    const breakingWeirOutcome = breakingWeirCampaignOutcome(args.questOutcomeIds);
    return Object.freeze({
      completionContext:
        breakingWeirOutcome?.romeDispatchContext ?? ROME_POST_WEIR_DISPATCH_CONTEXT,
      preRetentionTeaser: beforeBreakingWeirRetention ? ROME_POST_WEIR_DISPATCH_TEASER : null,
      continueConsequencePrefix: beforeBreakingWeirRetention
        ? "Continue to choose which live packet you carry first."
        : null,
      storyChoice: afterBreakingWeirContinue ? romePostWeirDispatchStoryChoice() : null,
    });
  }

  // Out-of-order fallback: a later campaign quest completed while an earlier goal was
  // active leaves the required story step unmatched by every goal-identity branch above.
  // Derive the step from completed quests so the choice presents at whichever completed,
  // continued goal the player is actually at.
  if (!args.completedQuestIds) return null;
  const step = journeyCampaignPendingStoryStep(args.completedQuestIds);
  if (!step) return null;
  const beforeRetention = awaitsAnyGoalCompletionChoice(args.journey);
  const afterContinue = awaitsAnyStoryContinuation(args.journey);
  if (!beforeRetention && !afterContinue) return null;
  if (step === "albany_dawn_dispatch") {
    const outcome = wolfWinterCampaignOutcome(args.questOutcomeIds);
    if (!outcome) return null;
    return Object.freeze({
      completionContext: outcome.albanyReturnContext,
      preRetentionTeaser: beforeRetention ? ALBANY_DAWN_DISPATCH_TEASER : null,
      ...(beforeRetention ? { continueLabel: ALBANY_DAWN_DISPATCH_CONTINUE_LABEL } : {}),
      ...(beforeRetention ? { continuationPreview: albanyDawnDispatchStoryChoice(outcome) } : {}),
      continueConsequencePrefix: beforeRetention
        ? ALBANY_DAWN_DISPATCH_CONTINUE_CONSEQUENCE_PREFIX
        : null,
      storyChoice: afterContinue ? albanyDawnDispatchStoryChoice(outcome) : null,
    });
  }
  if (step === "tanners_fever_accountability") {
    return Object.freeze({
      completionContext: TANNERS_FEVER_ACCOUNTABILITY_CONTEXT,
      preRetentionTeaser: beforeRetention ? TANNERS_FEVER_ACCOUNTABILITY_TEASER : null,
      continueConsequencePrefix: beforeRetention
        ? "Continue to decide how Oneonta records the corrected dose."
        : null,
      storyChoice: afterContinue ? tannersFeverAccountabilityStoryChoice() : null,
    });
  }
  const fallbackWeirOutcome = breakingWeirCampaignOutcome(args.questOutcomeIds);
  return Object.freeze({
    completionContext: fallbackWeirOutcome?.romeDispatchContext ?? ROME_POST_WEIR_DISPATCH_CONTEXT,
    preRetentionTeaser: beforeRetention ? ROME_POST_WEIR_DISPATCH_TEASER : null,
    continueConsequencePrefix: beforeRetention
      ? "Continue to choose which live packet you carry first."
      : null,
    storyChoice: afterContinue ? romePostWeirDispatchStoryChoice() : null,
  });
}
