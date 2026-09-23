import type { CampaignCharacterState } from "./campaign_character_state.js";
import type {
  JourneyReliefOathStoryChoiceOptions,
  JourneyStoryChoiceProgressiveDisclosure,
  JourneyStoryChoicePrompt,
} from "./journey_contract.js";
import type { OpeningLeadSource } from "./opening_lead_source.js";
import type { OpeningRegistration, OpeningStartingDoctrine } from "./opening_registration.js";
import {
  formatOpeningReliefOathCost,
  parseOpeningReliefOath,
  type OpeningReliefOath,
} from "./opening_relief_oath.js";
import { presentOpeningChoiceOption } from "./opening_choice_receipt.js";

type OpeningReliefOathStandardPacketContext = Readonly<{
  registration: OpeningRegistration;
  leadSource: OpeningLeadSource;
}>;

const OPENING_RELIEF_OATH_CUSTOMIZE_REVEAL_ID = "customize_duty_and_evidence" as const;
export const OPENING_RELIEF_OATH_CUSTOMIZE_LABEL = "Choose promise and report separately" as const;
export const OPENING_RELIEF_OATH_CUSTOMIZE_DESCRIPTION =
  "Compare all four field plans before choosing. This review selects nothing. You can then choose a promise and report separately." as const;
export const OPENING_RELIEF_OATH_FIELD_OUTCOME_COMPASS =
  "HUNT — Fight the wolves to protect the farm, herd, and supplies. Wolves may die; failure can cost cattle or damage the fence. Bloodshed changes later Greenway work. LURE — Use Cade's last feed to lead the wolves away and keep the herd. The fence breaks, and a failed first feed can cost two cattle. DRIVE — Move the people and herd out, forcing the living pack away. The farm is abandoned, and the crisis costs a wound, two cattle, or the rig. FORTIFY — Keep the household, herd, and wolves apart until dawn. You cannot retreat; choose between exposing property with Cade's help or spending public seals without it. Review only: no plan is selected." as const;

/**
 * Project the authored four-plan compass only after the session has accepted
 * this prompt's durable reveal receipt. The canonical pre-reveal prompt keeps
 * only the short affordance, so full, compact, terminal, and UI surfaces share
 * the same disclosure boundary without placing presentation copy in save data.
 */
export function withOpeningReliefOathFieldOutcomeCompass(
  prompt: JourneyStoryChoicePrompt,
  revealId: string,
): JourneyStoryChoicePrompt {
  const disclosure = prompt.progressiveDisclosure;
  if (
    prompt.kind !== "relief_oath" ||
    !disclosure ||
    disclosure.reveal.id !== OPENING_RELIEF_OATH_CUSTOMIZE_REVEAL_ID ||
    revealId !== disclosure.reveal.id
  ) {
    return prompt;
  }
  const { progressiveDisclosure: _progressiveDisclosure, ...withoutDisclosure } = prompt;
  return Object.freeze({
    ...withoutDisclosure,
    message: `${prompt.message} ${OPENING_RELIEF_OATH_FIELD_OUTCOME_COMPASS}`,
  }) as JourneyStoryChoicePrompt;
}

const STANDARD_PACKET_SUPPORT_COPY: Readonly<
  Record<
    string,
    Readonly<{
      dispatchLabel: string;
      expectedProfileId: string;
      expectedReliefOathOptionId: string;
      expectedReliefOathTitle: string;
      expectedLeadSourceOptionId: string;
      expectedLeadSourceTitle: string;
      expectedTriggerCategory: string;
      outcome: string;
    }>
  >
> = Object.freeze({
  "albany:doctrine_fortify_breach": Object.freeze({
    dispatchLabel: "Ready-made setup — Full Compact + Rowan's report",
    expectedProfileId: "albany:ironhands_repairer",
    expectedReliefOathOptionId: "albany:oath_full_compact_duty",
    expectedReliefOathTitle: "Accept Full Compact Authority",
    expectedLeadSourceOptionId: "albany:source_rowan_civic_docket",
    expectedLeadSourceTitle: "Use Rowan's Public Report",
    expectedTriggerCategory: "Repair 4; first public-seal FORTIFY Repair is DC 12 instead of 14.",
    outcome:
      "Start with public authority and a first public-seal FORTIFY Repair of DC 12 instead of 14.",
  }),
  "albany:doctrine_road_warden_aid_route": Object.freeze({
    dispatchLabel: "Ready-made setup — Aid-Only + Hayden's report",
    expectedProfileId: "albany:road_warden",
    expectedReliefOathOptionId: "albany:oath_limited_aid_only",
    expectedReliefOathTitle: "Accept Aid-Only Terms",
    expectedLeadSourceOptionId: "albany:source_hayden_frost_report",
    expectedLeadSourceTitle: "Use Hayden's Frost Report",
    expectedTriggerCategory:
      "Defense 4. First LURE LAY still +1; last feed skips +1 if that LAY succeeded. Split rail can help HUNT.",
    outcome:
      "Start with Defense 4, the clean-feed LURE benefit, and Hayden's conditional HUNT brace.",
  }),
  "albany:doctrine_independent_drive": Object.freeze({
    dispatchLabel: "Ready-made setup — Personal Bond + Rowan's report",
    expectedProfileId: "albany:unaffiliated_courier",
    expectedReliefOathOptionId: "albany:oath_unaffiliated_personal_bond",
    expectedReliefOathTitle: "Use a Personal Bond",
    expectedLeadSourceOptionId: "albany:source_rowan_civic_docket",
    expectedLeadSourceTitle: "Use Rowan's Public Report",
    expectedTriggerCategory:
      "Streetwise 4; first DRIVE shutter-signal check drops from DC 12 to DC 10.",
    outcome: "Start independent with an easier first DRIVE shutter-signal check.",
  }),
});

function matchesKnownStartingDoctrineMapping(
  doctrine: OpeningStartingDoctrine,
  oathTitle: string,
  sourceTitle: string,
): boolean {
  const copy = STANDARD_PACKET_SUPPORT_COPY[doctrine.id];
  return (
    copy?.expectedProfileId === doctrine.profile_id &&
    copy.expectedReliefOathOptionId === doctrine.relief_oath_option_id &&
    copy.expectedReliefOathTitle === oathTitle &&
    copy.expectedLeadSourceOptionId === doctrine.lead_source_option_id &&
    copy.expectedLeadSourceTitle === sourceTitle
  );
}

function summarizeStartingDoctrineOutcome(
  doctrine: OpeningStartingDoctrine,
  oathTitle: string,
  sourceTitle: string,
): string {
  const copy = STANDARD_PACKET_SUPPORT_COPY[doctrine.id];
  return matchesKnownStartingDoctrineMapping(doctrine, oathTitle, sourceTitle) &&
    copy?.expectedTriggerCategory === doctrine.trigger_category
    ? copy.outcome
    : `Pairs ${reliefOathDisplayLabel(oathTitle)} with ${sourceTitle}.`;
}

function startingDoctrineDispatchLabel(
  doctrine: OpeningStartingDoctrine,
  oathTitle: string,
  sourceTitle: string,
): string {
  const copy = STANDARD_PACKET_SUPPORT_COPY[doctrine.id];
  const matchesKnownCopy = matchesKnownStartingDoctrineMapping(doctrine, oathTitle, sourceTitle);
  return matchesKnownCopy && copy
    ? copy.dispatchLabel
    : `Ready-made setup — ${oathTitle} + ${sourceTitle}`;
}

function reliefOathDisplayLabel(title: string): string {
  return title;
}

/** Project Albany's disclosed access-and-duty terms onto the journey choice surface. */
export function presentOpeningReliefOath(
  scene: OpeningReliefOath,
  character: CampaignCharacterState,
  packetContext?: OpeningReliefOathStandardPacketContext,
): JourneyStoryChoicePrompt {
  const parsed = parseOpeningReliefOath(scene);
  const doctrine = packetContext?.registration.doctrines?.find(
    (candidate) => candidate.profile_id === character.background,
  );
  const doctrineOath = doctrine
    ? parsed.options.find((candidate) => candidate.id === doctrine.relief_oath_option_id)
    : undefined;
  const doctrineSource = doctrine
    ? packetContext?.leadSource.options.find(
        (candidate) => candidate.id === doctrine.lead_source_option_id,
      )
    : undefined;
  if (doctrine && (!doctrineOath || !doctrineSource)) {
    throw new Error(`Opening quick setup "${doctrine.id}" has an invalid duty/source mapping.`);
  }
  const standardPacket = doctrine
    ? (() => {
        const exactReceipt = presentOpeningChoiceOption({
          id: doctrine.id,
          label: startingDoctrineDispatchLabel(
            doctrine,
            doctrineOath!.title,
            doctrineSource!.title,
          ),
          commitment: summarizeStartingDoctrineOutcome(
            doctrine,
            doctrineOath!.title,
            doctrineSource!.title,
          ),
          exactBenefit: doctrine.trigger_category,
          immediateCost: doctrine.immediate_cost,
          giveUp: "Other promise/report pairs close.",
        });
        return Object.freeze({
          ...exactReceipt,
          summary: Object.freeze({
            ...exactReceipt.summary!,
            tradeoff: "Other promise/report pairs close.",
          }),
        });
      })()
    : null;
  const oathOptions = Object.freeze(
    parsed.options.map((option) => {
      const cost = formatOpeningReliefOathCost(option.terms);
      if (option.trigger_category === undefined) {
        return Object.freeze({
          id: option.id,
          label: reliefOathDisplayLabel(option.title),
          summary: Object.freeze({
            commitment: option.summary,
            fieldTrigger: option.preview,
            immediateCost: cost,
            tradeoff: option.tradeoff,
          }),
          consequence:
            `${option.summary} ${option.preview} Access: ${option.access} Duty: ${option.duty} ` +
            `Actual cost: ${cost}. ${option.consequence}`,
        });
      }
      return presentOpeningChoiceOption({
        id: option.id,
        label: reliefOathDisplayLabel(option.title),
        commitment: option.summary,
        exactBenefit: option.trigger_category,
        immediateCost: cost,
        giveUp: option.tradeoff,
      });
    }),
  );
  const options = Object.freeze([
    ...(standardPacket ? [standardPacket] : []),
    ...oathOptions,
  ]) as JourneyReliefOathStoryChoiceOptions;
  const progressiveDisclosure: JourneyStoryChoiceProgressiveDisclosure | undefined = standardPacket
    ? (() => {
        const firstOathOption = oathOptions[0];
        if (!firstOathOption) throw new Error("Opening relief oath requires at least one duty.");
        const optionIds: JourneyStoryChoiceProgressiveDisclosure["reveal"]["optionIds"] =
          Object.freeze([firstOathOption.id, ...oathOptions.slice(1).map((option) => option.id)]);
        return Object.freeze({
          initialOptionIds: Object.freeze([standardPacket.id]),
          reveal: Object.freeze({
            id: OPENING_RELIEF_OATH_CUSTOMIZE_REVEAL_ID,
            label: OPENING_RELIEF_OATH_CUSTOMIZE_LABEL,
            description: OPENING_RELIEF_OATH_CUSTOMIZE_DESCRIPTION,
            optionIds,
          }),
        });
      })()
    : undefined;

  return Object.freeze({
    id: parsed.id,
    kind: "relief_oath" as const,
    message: standardPacket
      ? `${parsed.title}. Use the ready-made promise and report, or choose them separately. Every field plan stays open. ${parsed.message}`
      : `${parsed.title}. ${parsed.message}`,
    options,
    ...(progressiveDisclosure ? { progressiveDisclosure } : {}),
  });
}
