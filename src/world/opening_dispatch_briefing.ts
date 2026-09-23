import type { JourneyStoryChoicePrompt } from "./journey_contract.js";
import type { OverworldManifest } from "./overworld.js";

const OPENING_DISPATCH_SUPPORT_DISCOVERY_MARKER = " The live dispatch has ";

/** Split the authored crisis from Station support; ambiguous/missing boundaries fail closed. */
export function openingDispatchCrisisPreview(discovery: string): string | null {
  const parts = discovery.split(OPENING_DISPATCH_SUPPORT_DISCOVERY_MARKER);
  if (parts.length !== 2) return null;
  const preview = parts[0]!.trim();
  const deferredSupport = parts[1]!.trim();
  return preview.length > 0 && deferredSupport.length > 0 ? preview : null;
}

type OpeningDispatchStage = Readonly<{
  id: string;
  kind: NonNullable<JourneyStoryChoicePrompt["kind"]>;
}>;

type OpeningDispatchManifestChain = Readonly<{
  quest: OverworldManifest["quests"][number];
  registration: NonNullable<OverworldManifest["opening_registration"]>;
  reliefOath: NonNullable<OverworldManifest["opening_relief_oath"]>;
  leadSource: NonNullable<OverworldManifest["opening_lead_source"]>;
  preparation: NonNullable<OverworldManifest["opening_preparation"]>;
  reliefAllocation: NonNullable<OverworldManifest["opening_relief_allocation"]>;
  ally: NonNullable<OverworldManifest["opening_ally"]> | null;
}>;

type OpeningDispatchPlan = Readonly<{
  questTitle: string;
  questCrisisPreview: string;
  allyContactName: string | null;
  civicStages: readonly OpeningDispatchStage[];
  departureChoices: readonly OpeningDispatchStage[];
  allyChoice: OpeningDispatchStage | null;
}>;

/** Resolve the one authored Albany dispatch chain shared by its read-only projections. */
export function resolveOpeningDispatchManifestChain(
  world: OverworldManifest,
): OpeningDispatchManifestChain | null {
  const registration = world.opening_registration;
  const reliefOath = world.opening_relief_oath;
  const leadSource = world.opening_lead_source;
  const preparation = world.opening_preparation;
  const reliefAllocation = world.opening_relief_allocation;
  if (!registration || !reliefOath || !leadSource || !preparation || !reliefAllocation) {
    return null;
  }
  const targetQuestId = leadSource.target_quest;
  if (
    reliefOath.after_registration !== registration.id ||
    reliefOath.target_quest !== targetQuestId ||
    leadSource.after_registration !== registration.id ||
    preparation.after_lead_source !== leadSource.id ||
    preparation.target_quest !== targetQuestId ||
    reliefAllocation.after_preparation !== preparation.id ||
    reliefAllocation.target_quest !== targetQuestId ||
    reliefAllocation.home !== preparation.home ||
    reliefAllocation.area !== preparation.area
  ) {
    return null;
  }
  const quest = world.quests.find((candidate) => candidate.id === targetQuestId);
  if (!quest) return null;
  const authoredAlly = world.opening_ally;
  const ally =
    authoredAlly?.target_quest === targetQuestId &&
    authoredAlly.after_preparation === preparation.id &&
    authoredAlly.home === preparation.home &&
    authoredAlly.area === preparation.area &&
    world.characters.some((candidate) => candidate.id === authoredAlly.contact)
      ? authoredAlly
      : null;
  return {
    quest,
    registration,
    reliefOath,
    leadSource,
    preparation,
    reliefAllocation,
    ally,
  };
}

/**
 * Resolve the authored five-card Albany dispatch without adding a second
 * content source. The briefing uses only the crisis sentence from quest discovery,
 * leaving Station support for the departure board.
 */
function openingDispatchPlan(world: OverworldManifest): OpeningDispatchPlan | null {
  const chain = resolveOpeningDispatchManifestChain(world);
  if (!chain) return null;
  const { quest, registration, reliefOath, leadSource, preparation, reliefAllocation, ally } =
    chain;
  const questCrisisPreview = openingDispatchCrisisPreview(quest.discovery);
  if (!questCrisisPreview) return null;
  const allyContact = ally
    ? world.characters.find((candidate) => candidate.id === ally.contact)
    : null;
  return {
    questTitle: quest.title,
    questCrisisPreview,
    allyContactName: ally && allyContact ? allyContact.name : null,
    civicStages: Object.freeze([
      Object.freeze({
        id: registration.id,
        kind: "registration",
      }),
      Object.freeze({
        id: reliefOath.id,
        kind: "relief_oath",
      }),
      Object.freeze({ id: leadSource.id, kind: "lead_source" }),
    ]),
    departureChoices: Object.freeze([
      Object.freeze({
        id: preparation.id,
        kind: "preparation",
      }),
      Object.freeze({
        id: reliefAllocation.id,
        kind: "relief_allocation",
      }),
    ]),
    allyChoice: ally
      ? Object.freeze({
          id: ally.id,
          kind: "ally",
        })
      : null,
  };
}

/** Add finite mission and planning context without changing the saved journal. */
export function withOpeningDispatchBriefing(
  world: OverworldManifest,
  prompt: JourneyStoryChoicePrompt | null | undefined,
): JourneyStoryChoicePrompt | null | undefined {
  if (!prompt?.kind) return prompt;
  const plan = openingDispatchPlan(world);
  if (!plan) return prompt;
  const civicStageIndex = plan.civicStages.findIndex(
    (stage) => stage.id === prompt.id && stage.kind === prompt.kind,
  );
  const departureChoice = plan.departureChoices.find(
    (stage) => stage.id === prompt.id && stage.kind === prompt.kind,
  );
  const allyChoice =
    plan.allyChoice?.id === prompt.id && plan.allyChoice.kind === prompt.kind
      ? plan.allyChoice
      : null;
  if (civicStageIndex < 0 && !departureChoice && !allyChoice) return prompt;
  const registration = world.opening_registration;
  const offersStandardPacket =
    prompt.kind === "relief_oath" &&
    (registration?.doctrines?.some((doctrine) =>
      prompt.options.some((option) => option.id === doctrine.id),
    ) ??
      false);
  if (civicStageIndex === 0) {
    const crisis = plan.questCrisisPreview.replace(/\.$/u, "");
    return {
      ...prompt,
      message:
        `${plan.questTitle}: ${crisis}. Choose one permanent background. Then use a ` +
        "ready-made setup or choose the promise and report separately. Every field plan stays open.",
    };
  }
  if (offersStandardPacket) {
    return {
      ...prompt,
      message:
        `${plan.questTitle}: use a ready-made promise and report or choose them separately. ` +
        "Every approach stays open.",
    };
  }
  if (civicStageIndex >= 0 && prompt.kind === "relief_oath") {
    return {
      ...prompt,
      message:
        `${plan.questTitle}: choose one promise. Your report comes next. ` +
        "Every field plan stays open.",
    };
  }
  if (civicStageIndex >= 0 && prompt.kind === "lead_source") {
    return {
      ...prompt,
      message:
        `${plan.questTitle}: choose one report. Albany Station comes next. Every ` +
        "field plan stays open.",
    };
  }
  if (departureChoice?.kind === "preparation") {
    return {
      ...prompt,
      message:
        "You can leave Albany Station now or choose one field kit. The relief wagon " +
        "and June are separate choices.",
    };
  }
  if (departureChoice?.kind === "relief_allocation") {
    return {
      ...prompt,
      message:
        "You can leave Albany Station now or assign the relief wagon. The field kit " +
        "and June are separate choices.",
    };
  }
  if (allyChoice) {
    return {
      ...prompt,
      message:
        `You can leave Albany Station alone or ask ${plan.allyContactName ?? "the second rider"} ` +
        "to join. The field kit and relief wagon are separate choices.",
    };
  }
  return prompt;
}
