import { type OverworldServiceResult, OverworldSession, type OverworldView } from "./overworld.js";
import type { WorldActionSection } from "./OverworldPlayScreen.js";

type ProjectedServiceAction = OverworldView["serviceActions"][number]["action"];

function assertNever(value: never, context: string): never {
  throw new Error(`${context}: ${String(value)}`);
}

/**
 * Keep authored service expansion fail-visible. A new canonical action must get
 * an explicit label and engine call instead of silently becoming "Resupply".
 */
function serviceActionTitle(action: ProjectedServiceAction): string {
  switch (action) {
    case "care":
      return "Receive care";
    case "rest":
      return "Rest";
    case "resupply":
      return "Resupply";
    default:
      return assertNever(action, "Unsupported projected service action");
  }
}

export function activateProjectedService(
  session: OverworldSession,
  action: ProjectedServiceAction,
): OverworldServiceResult {
  switch (action) {
    case "care":
      return session.careAtTown();
    case "rest":
      return session.restAtTown();
    case "resupply":
      return session.resupplyAtTown();
    default:
      return assertNever(action, "Unsupported projected service action");
  }
}

export function presentServiceSection(
  view: Pick<OverworldView, "serviceActions" | "serviceOffers">,
  session: OverworldSession,
  runServiceAction: (action: () => OverworldServiceResult) => void,
): WorldActionSection {
  return {
    id: "services",
    title: "Town services",
    actions: view.serviceActions.map((serviceAction) => {
      const offer = view.serviceOffers.find((candidate) => candidate.id === serviceAction.offerId);
      return {
        id: `service:${serviceAction.action}`,
        group: "Service",
        title: serviceActionTitle(serviceAction.action),
        summary: serviceAction.message,
        terms: `${serviceAction.minutes} min · supplies ${serviceAction.suppliesBefore}→${serviceAction.suppliesAfter} · fatigue ${serviceAction.fatigueBefore}→${serviceAction.fatigueAfter}${offer ? ` · ${offer.summary}` : ""}`,
        buttonLabel: "Use service",
        tone: "lichen",
        ...(!serviceAction.available ? { disabledReason: serviceAction.message } : {}),
        onChoose: () =>
          runServiceAction(() => activateProjectedService(session, serviceAction.action)),
      };
    }),
  };
}

const EXCLUSIVE_SECTION_IDS = new Set(["encounter", "dispatch"]);
const REFERENCE_SECTION_IDS = new Set(["services", "roads"]);

/**
 * Select the focused deck from the projected model, not a closed list of known
 * gameplay categories. Newly added legal sections therefore surface by default.
 */
export function primaryWorldSectionIds(
  sections: readonly WorldActionSection[],
  pendingRoadEncounter: boolean,
  hasLegalDispatchAction: boolean,
): string[] {
  if (pendingRoadEncounter) return ["encounter"];
  if (hasLegalDispatchAction) return ["dispatch"];

  const legalSections = sections.filter((section) =>
    section.actions.some((action) => action.disabledReason === undefined),
  );
  const focusedSections = legalSections.filter(
    (section) => !EXCLUSIVE_SECTION_IDS.has(section.id) && !REFERENCE_SECTION_IDS.has(section.id),
  );

  return (focusedSections.length > 0 ? focusedSections : legalSections).map(
    (section) => section.id,
  );
}
