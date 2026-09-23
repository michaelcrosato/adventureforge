import type { OpeningDepartureRecap } from "../world/opening_departure_recap.js";
import type { OverworldQuestView } from "../world/session.js";

const EMBEDDED_QUEST_LAUNCH_HANDOFF_VERSION = 1 as const;

/** A small, player-facing bridge from campaign planning into actionable quest state. */
export type WolfWinterEmbeddedQuestLaunchHandoff = Readonly<{
  version: typeof EMBEDDED_QUEST_LAUNCH_HANDOFF_VERSION;
  transition: "Albany Station -> The Wolf-Winter";
  route: readonly [id: string, title: string];
  preparation: Readonly<
    { status: "imported"; title: string } | { status: "declined_at_launch"; title: null }
  >;
  childState: "actionable";
}>;

export type GallowmereEmbeddedQuestLaunchHandoff = Readonly<{
  version: typeof EMBEDDED_QUEST_LAUNCH_HANDOFF_VERSION;
  transition: "Queensbury Market -> The Gallowmere";
  packet: Readonly<{
    status: "delivered";
    title: "Hayden's Gallowmere packet";
    recipient: "Hedrick Cradoc";
  }>;
  objective: "Packet delivered. Finish The Gallowmere.";
  childState: "actionable";
}>;

export type EmbeddedQuestLaunchHandoff =
  | WolfWinterEmbeddedQuestLaunchHandoff
  | GallowmereEmbeddedQuestLaunchHandoff;

/**
 * Build only authored, provenance-backed handoffs. Gallowmere's packet receipt
 * is valid only for the matching campaign goal; local and wardens-route starts
 * must not invent Hayden's packet.
 */
export function embeddedQuestLaunchHandoff(args: {
  quest: OverworldQuestView;
  departureRecap: OpeningDepartureRecap | null;
  journeyGoalId: string;
}): EmbeddedQuestLaunchHandoff | null {
  if (args.quest.id === "gallowmere") {
    if (args.journeyGoalId !== "carry_hedricks_packet_north") return null;
    return Object.freeze({
      version: EMBEDDED_QUEST_LAUNCH_HANDOFF_VERSION,
      transition: "Queensbury Market -> The Gallowmere",
      packet: Object.freeze({
        status: "delivered",
        title: "Hayden's Gallowmere packet",
        recipient: "Hedrick Cradoc",
      }),
      objective: "Packet delivered. Finish The Gallowmere.",
      childState: "actionable",
    });
  }
  if (args.quest.id !== "wolf_winter" || args.departureRecap?.questId !== args.quest.id) {
    return null;
  }
  const selectedRouteId = args.quest.launch?.selected?.optionId;
  const selectedRoute = args.quest.launch?.options.find((option) => option.id === selectedRouteId);
  if (!selectedRouteId || !selectedRoute) {
    throw new Error("Wolf-Winter launch handoff requires its accepted hill route.");
  }
  const preparation = args.departureRecap.entries.find((entry) => entry.slot === "preparation");
  if (!preparation) {
    throw new Error("Wolf-Winter launch handoff requires the Station preparation slot.");
  }
  const preparationHandoff =
    preparation.status === "selected" && preparation.title
      ? Object.freeze({ status: "imported" as const, title: preparation.title })
      : Object.freeze({ status: "declined_at_launch" as const, title: null });
  return Object.freeze({
    version: EMBEDDED_QUEST_LAUNCH_HANDOFF_VERSION,
    transition: "Albany Station -> The Wolf-Winter",
    route: Object.freeze([selectedRouteId, selectedRoute.title] as const),
    preparation: preparationHandoff,
    childState: "actionable",
  });
}
