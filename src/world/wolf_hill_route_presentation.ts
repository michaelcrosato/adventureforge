/**
 * Player-facing, pre-commitment projection for the starting slice's hill roads.
 *
 * The route mechanics remain authored in Wolf-Winter. This small presentation
 * adapter keeps the decisive route tradeoff out of the longer launch preview,
 * where compact projections may truncate it. Strategy-specific support and
 * failure forecasts belong at Cade, after the independent ground condition is
 * visible and the player can compare all four plans as peers.
 */

import { WOLF_WINTER_DISPATCH_ON_TIME_MAX_MINUTES } from "../core/embedded_launch_overlay_receipt.js";
import type { QuestDispatchPresentationWindow } from "./quest_dispatch_window.js";

export const WOLF_HILL_ROUTE_TRADEOFF_SUMMARY_CHAR_LIMIT = 360;

const WOLF_HILL_APPROACH_LAUNCH_ID = "albany:wolf_hill_approach";
const EXPOSED_RIDGE_OPTION_ID = "albany:wolf_approach_exposed_ridge";
const SHELTERED_STOCKWAY_OPTION_ID = "albany:wolf_approach_sheltered_stockway";
const ROUTE_SUMMARIES = Object.freeze({
  exposedRidge:
    "Exposed Ridge — 30 minutes, 1 supply, +25 fatigue. Descending raises cattle alarm to 1, but you can see the byre and weather clearly. This road chooses no field plan.",
  shelteredStockway:
    "Sheltered Stockway — 75 minutes, 2 supplies, +10 fatigue. Cattle alarm starts at 0, but hedges hide the byre and weather. This road chooses no field plan.",
});

const ROUTE_SUMMARY_MARKERS = Object.freeze([
  ROUTE_SUMMARIES.exposedRidge,
  ROUTE_SUMMARIES.shelteredStockway,
]);

type WolfHillRouteTradeoffParts = Readonly<{
  dispatchStatus: string | null;
  routeSummary: string;
}>;

/** Split only the two authenticated hill-road summaries; unknown prose stays intact. */
export function wolfHillRouteTradeoffParts(summary: string): WolfHillRouteTradeoffParts {
  for (const marker of ROUTE_SUMMARY_MARKERS) {
    const routeIndex = summary.indexOf(marker);
    if (routeIndex < 0) continue;
    return Object.freeze({
      dispatchStatus: routeIndex === 0 ? null : summary.slice(0, routeIndex).trim(),
      routeSummary: summary.slice(routeIndex),
    });
  }
  return Object.freeze({ dispatchStatus: null, routeSummary: summary });
}

/** Return one shared dispatch line only when every shown hill road agrees exactly. */
export function sharedWolfHillRouteDispatchStatus(summaries: readonly string[]): string | null {
  const statuses = summaries.map((summary) => wolfHillRouteTradeoffParts(summary).dispatchStatus);
  const first = statuses[0];
  if (!first || statuses.length === 0 || statuses.some((status) => status !== first)) return null;
  return first;
}

type WolfHillRoutePresentation = Readonly<{
  tradeoffSummary: string;
}>;

function boundedSummary(summary: string): string {
  if (summary.length > WOLF_HILL_ROUTE_TRADEOFF_SUMMARY_CHAR_LIMIT) {
    throw new Error(
      `Wolf hill-route tradeoff summary exceeds ${String(WOLF_HILL_ROUTE_TRADEOFF_SUMMARY_CHAR_LIMIT)} characters.`,
    );
  }
  return summary;
}

function dispatchBriefing(window: QuestDispatchPresentationWindow | undefined): string | null {
  if (!window) return null;
  if (window.status === "support_choices_open") {
    const { minimum, maximum } = window.finalMinutes;
    const finalRange =
      minimum === maximum ? `${String(minimum)}m` : `${String(minimum)}–${String(maximum)}m`;
    const timing =
      minimum > WOLF_WINTER_DISPATCH_ON_TIME_MAX_MINUTES
        ? "already late"
        : maximum <= WOLF_WINTER_DISPATCH_ON_TIME_MAX_MINUTES
          ? "all on time"
          : "support can delay dispatch";
    return (
      `Background, promise, and report are set. Current setup: ${String(window.committedMinutes)}m. ` +
      `Final setup: ${finalRange}; ${timing}. Optional support remains. ` +
      "Start Wolf-Winter to skip it."
    );
  }
  if (window.status === "delayed" && window.ledgerMinutes !== undefined) {
    return (
      `Setup took ${String(window.ledgerMinutes)}m, so the dispatch is late. Roads change arrival costs only. ` +
      "The first failed LURE, DRIVE, or HUNT raises cattle alarm by 1; a failed FORTIFY raises winter pressure by 1."
    );
  }
  if (window.status === "on_time" && window.ledgerMinutes !== undefined) {
    return (
      `Setup took ${String(window.ledgerMinutes)}m, so the dispatch is on time. Roads change arrival costs only. ` +
      "No late-dispatch penalty applies."
    );
  }
  return (
    "Dispatch timing is unverified. Roads change arrival costs only. " +
    "No late-dispatch penalty applies."
  );
}

function withDispatchBriefing(
  summary: string,
  window: QuestDispatchPresentationWindow | undefined,
): string {
  const briefing = dispatchBriefing(window);
  return briefing ? `${briefing} ${summary}` : summary;
}

export function wolfHillRoutePresentation(args: {
  launchId: string;
  optionId: string;
  knowledgeIds?: readonly string[];
  dispatchWindow?: QuestDispatchPresentationWindow;
}): WolfHillRoutePresentation | null {
  if (args.launchId !== WOLF_HILL_APPROACH_LAUNCH_ID) return null;
  if (args.optionId === EXPOSED_RIDGE_OPTION_ID) {
    return Object.freeze({
      tradeoffSummary: boundedSummary(
        withDispatchBriefing(ROUTE_SUMMARIES.exposedRidge, args.dispatchWindow),
      ),
    });
  }
  if (args.optionId === SHELTERED_STOCKWAY_OPTION_ID) {
    return Object.freeze({
      tradeoffSummary: boundedSummary(
        withDispatchBriefing(ROUTE_SUMMARIES.shelteredStockway, args.dispatchWindow),
      ),
    });
  }
  return null;
}
