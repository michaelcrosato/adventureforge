export {
  OverworldSession,
  type OverworldAreaTravelResult,
  type OverworldActionResult,
  type OverworldRoadEncounterResult,
  type OverworldSessionSnapshot,
  type OverworldServiceResult,
  type OverworldView,
} from "../../src/world/session.js";
export type { CampaignCharacterView } from "../../src/world/campaign_character_view.js";
export { embeddedLaunchOverlayForPlan } from "../../src/world/embedded_launch_overlay.js";

/** The UI must only disclose authored event terms once the engine marks one legal. */
export function hasLiveOverworldEventChoice(
  eventId: string,
  choices: readonly (readonly [eventId: string, optionId: string])[],
): boolean {
  return choices.some(([choiceEventId]) => choiceEventId === eventId);
}
