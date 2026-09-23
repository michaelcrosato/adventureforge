#!/usr/bin/env -S npx tsx
/**
 * bin/overworld_play — play the New York overworld from the terminal.
 *
 * Usage:
 *   npm run overworld                                   # start a new journey
 *   npm run overworld -- --restore saves/journey.json   # resume a saved journey
 *   npm run overworld -- --commands "look; go albany; press; rest"
 *   npm run overworld -- --seed 7                       # seed for RPG quest handoffs only
 *
 * Drives the same deterministic OverworldSession the web UI and MCP server use:
 * travel (every road leg raises a road encounter that must be resolved — assist /
 * scout / press), rest/resupply, local areas, scouting, contacts, events, jobs,
 * and notice-board quest leads. Starting a discovered quest hands off to the same
 * RPG quest loop as `npm run play`; a non-death ending is completed back into the
 * overworld (journal + renown), mirroring the MCP quest bridge. The overworld has
 * no RNG — determinism comes from action order alone; `--seed` only affects the
 * RPG quest sub-sessions. In `--commands` mode the run succeeds (exit 0) when every
 * scripted command is accepted; any rejected or unparseable command sets exit 1.
 * `save <name>` / `load <name>` snapshot the parent plus any active/suspended
 * embedded quest to saves/<name>.json (gitignored).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { makeStep, actionEquals } from "../src/core/engine.js";
import {
  indexRpgPack,
  buildRpgRules,
  initStateForRpgPack,
  enumerateRpgActions,
} from "../src/rpg/runner.js";
import { buildRpgObservation } from "../src/rpg/observation.js";
import { renderRpgActiveDialoguePrompt } from "../src/rpg/player_command_projection.js";
import { EMBEDDED_QUEST_CONTINUITY_EXPLANATION } from "../src/rpg/embedded_quest_character_continuity.js";
import { RpgSourceRuntime } from "../src/mcp/rpg_source_runtime.js";
import {
  CliJourneySession,
  isCliJourneyIntegrityError,
} from "../src/cli/embedded_quest_journey.js";
import {
  render as renderQuest,
  renderActionHelp as renderQuestActionHelp,
  illegalReason,
  resolve as resolveRpgCommand,
  resolveActionOption as resolveRpgActionOption,
} from "./rpg_play.js";
import {
  isStructuredTerminalStoryChoice,
  matchTerminalStoryChoiceOption,
  renderTerminalStoryChoiceComparison,
  runTerminalStoryChoiceController,
  storyChoiceCommitmentLabel,
  type TerminalStoryChoiceAuxiliaryResult,
} from "./terminal_story_choice.js";
import { loadOverworldManifest } from "../src/world/source.js";
import { embeddedLaunchOverlayForPlan } from "../src/world/embedded_launch_overlay.js";
import { timeLabel } from "../src/world/session_journal_codec.js";
import type {
  JourneyChoiceOption,
  JourneyExitReceipt,
  JourneyPresentation,
} from "../src/world/journey_contract.js";
import {
  OverworldSession,
  type OverworldActionResult,
  type OverworldJourneyGoalPassageResult,
  type OverworldJourneyStoryChoiceResult,
  type OverworldPendingRoadEncounter,
  type OverworldQuestCompletionResult,
  type OverworldQuestView,
  type OverworldRoadEncounterStrategy,
  type OverworldServiceResult,
  type OverworldView,
  type TravelLogEntry,
} from "../src/world/session.js";
import type { OverworldDepartureInteraction } from "../src/world/session_departure_interactions.js";

const VALUE_FLAGS = new Set(["--commands", "--seed", "--restore"]);
const SAVE_DIR = "saves";
const DEFAULT_SAVE_NAME = "journey";

/** Exact quest foldback copy printed by the terminal after an embedded victory. */
export function renderQuestCompletion(result: OverworldQuestCompletionResult): string {
  return result.entry.text;
}

/** Append a destination only when the authored route label does not already
 * name it. Generated local routes commonly include both endpoints. */
export function routeLabelWithDestination(route: string, destination: string): string {
  const normalizedRoute = route.trim().toLocaleLowerCase();
  const normalizedDestination = destination.trim().toLocaleLowerCase();
  return normalizedDestination && normalizedRoute.includes(normalizedDestination)
    ? route
    : `${route} to ${destination}`;
}

/** The full status screen (pure; exported for tests). */
export function render(view: OverworldView): string {
  const lines = [
    `\n=== ${view.world} — ${view.current.name} (${view.current.region}) — ${view.timeLabel} ===`,
    view.current.description,
    `Supplies ${view.supplies}/${view.maxSupplies} · Fatigue ${view.fatigue} · Condition ${view.travelCondition} · Towns visited ${view.visitedCount}/${view.totalTowns}`,
  ];
  if (view.exits.length) {
    lines.push("Roads:");
    lines.push("  Travel with `go <road number>` (for example, `go 1`).");
    view.exits.forEach((exit, i) => {
      lines.push(
        `  ${i + 1}. ${exit.destination.name} — ${exit.route}, ${exit.distance_mi.toFixed(1)} mi, ${exit.travel_minutes} min`,
      );
    });
  }
  if (view.currentArea) lines.push(`Area: ${view.currentArea.name} — ${view.currentArea.summary}`);
  if (view.areaExits.length)
    lines.push(
      `Local routes: ${view.areaExits.map((e) => `${e.destination.name} (${e.travel_minutes} min)`).join(" · ")}`,
    );
  const more = (n: number): string => (n > 0 ? ` (+${n} undiscovered)` : "");
  if (view.areas.length || view.hiddenAreaCount)
    lines.push(
      `Areas: ${view.areas.map((a) => a.name).join(" · ") || "—"}${more(view.hiddenAreaCount)}`,
    );
  if (view.pois.length) lines.push(`Places to scout: ${view.pois.map((p) => p.title).join(" · ")}`);
  if (view.characters.length)
    lines.push(`Contacts: ${view.characters.map((c) => `${c.name} (${c.role})`).join(" · ")}`);
  const departureQuestId = view.departureRecap?.questId;
  const departureQuest =
    departureQuestId && view.questStarts.some(([questId]) => questId === departureQuestId)
      ? view.quests.find((quest) => quest.id === departureQuestId)
      : undefined;
  const noticeBoardQuests = departureQuest
    ? view.quests.filter((quest) => quest.id !== departureQuest.id)
    : view.quests;
  if (view.stationDispatchBoard) {
    lines.push(`${view.stationDispatchBoard.questTitle} field briefing:`);
    lines.push(`  ${view.stationDispatchBoard.guidance}`);
  }
  if (departureQuest) {
    lines.push("Depart now:");
    lines.push("  Start now by choosing an available road. Planning is optional.");
    lines.push(`  ${questLine(view, departureQuest)}`);
    if (departureQuest.launch) {
      lines.push(
        ...renderQuestLaunch(departureQuest, "preview")
          .trim()
          .split("\n")
          .map((line) => `  ${line}`),
      );
    }
  }
  if (view.stationDispatchBoard) {
    lines.push(...renderStationSupportAffordance(view));
  }
  if (
    !view.stationDispatchBoard &&
    departureQuest &&
    (view.departureRecap || view.departureInteractions.length || view.departureContactLeads.length)
  ) {
    lines.push("Optional departure planning:");
  }
  if (!view.stationDispatchBoard && view.departureRecap) {
    lines.push(...renderDepartureRecap(view.departureRecap));
  }
  if (!view.stationDispatchBoard && view.departureInteractions.length) {
    lines.push("Optional departure choices:");
    for (const interaction of view.departureInteractions) {
      lines.push(`  ${interaction.kind === "preparation" ? "Field kit" : "Relief wagon"}`);
      lines.push(`    Compare: \`inspect ${interaction.id}\``);
    }
  }
  if (!view.stationDispatchBoard && view.departureContactLeads.length) {
    lines.push("Optional second rider:");
    for (const lead of view.departureContactLeads) {
      lines.push(`  Second rider — ${lead.guidance}`);
      if (lead.action) {
        lines.push(`    Command: talk ${lead.contactName}`);
      } else {
        lines.push("    Choose a field kit first.");
      }
    }
  }
  if (view.events.length)
    lines.push(
      `Events: ${view.events
        .map((e) => `${e.title}${view.resolvedEventIds.includes(e.id) ? " [resolved]" : ""}`)
        .join(" · ")}`,
    );
  if (view.jobs.length || view.hiddenJobCount)
    lines.push(
      `Jobs: ${
        view.jobs
          .map((j) => `${j.title}${view.completedJobIds.includes(j.id) ? " [done]" : ""}`)
          .join(" · ") || "—"
      }${more(view.hiddenJobCount)}`,
    );
  if (view.sites.length || view.hiddenSiteCount)
    lines.push(
      `Sites: ${
        view.sites
          .map((s) => `${s.title}${view.exploredSiteIds.includes(s.id) ? " [explored]" : ""}`)
          .join(" · ") || "—"
      }${more(view.hiddenSiteCount)}`,
    );
  if (noticeBoardQuests.length || view.hiddenQuestCount) {
    lines.push(`Notice board${more(view.hiddenQuestCount)}:`);
    for (const quest of noticeBoardQuests) lines.push(`  ${questLine(view, quest)}`);
  }
  return lines.join("\n");
}

type StationDispatchBoardView = NonNullable<OverworldView["stationDispatchBoard"]>;

const STATION_SUPPORT_SLOT_LABELS: Readonly<
  Record<StationDispatchBoardView["support"][number]["slot"], string>
> = {
  preparation: "field kit",
  relief_allocation: "relief wagon",
  field_team: "second rider",
};

function formatStationSupportLabels(
  support: readonly StationDispatchBoardView["support"][number][],
): string {
  const labels = support.map((entry) => STATION_SUPPORT_SLOT_LABELS[entry.slot]);
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels.at(-1)!}`;
}

function stationDispatchStatus(support: StationDispatchBoardView["support"][number]): string {
  if (support.selectedTitle) return `Selected: ${support.selectedTitle}`;
  switch (support.status) {
    case "open_optional":
      return "Open (optional)";
    case "available_after_preparation":
      return "Choose a field kit first";
    case "solo_default":
      return "Leave alone now";
    case "selected":
      return "Selected";
  }
}

/** Read-only Station summary; every printed command is an existing session action. */
export function renderStationDispatchBoard(view: OverworldView): string[] {
  const board = view.stationDispatchBoard;
  if (!board) return [];
  const openSupport = board.support.filter(
    (support) => support.status === "open_optional" && support.selectedTitle === null,
  );
  const lines =
    openSupport.length > 0
      ? [`Optional support — ${formatStationSupportLabels(openSupport)}:`]
      : ["No optional support remains."];
  for (const support of openSupport) {
    lines.push(`  ${support.label} — ${stationDispatchStatus(support)}.`);
    lines.push(`    ${support.purpose}`);
    lines.push(`    ${support.detailHint}`);
    if (support.action?.kind === "inspect") {
      lines.push(
        `    Inspect ${STATION_SUPPORT_SLOT_LABELS[support.slot]}: \`inspect ${support.action.storyChoiceId}\``,
      );
    } else if (support.action?.kind === "talk") {
      lines.push(
        `    Talk to ${support.action.contactName}: \`talk ${support.action.contactName}\``,
      );
    }
  }
  lines.push("  Review your current plan: `review dispatch`.");
  return lines;
}

/**
 * Opening Station status keeps optional planning to one deliberate expansion.
 * The detailed board stays available through `review support` without touching
 * session state, the decision count, or the authored action handles.
 */
export function renderStationSupportAffordance(view: OverworldView): string[] {
  const board = view.stationDispatchBoard;
  if (!board) return [];
  const open = board.support.filter(
    (support) =>
      support.status === "open_optional" &&
      support.selectedTitle === null &&
      support.action !== null,
  );
  return [
    ...(open.length > 0
      ? [
          "Optional support (`review support` for details):",
          ...open.map((support) => {
            const action = support.action!;
            const command =
              action.kind === "inspect"
                ? `inspect ${action.storyChoiceId}`
                : `talk ${action.contactName}`;
            return `  ${support.purpose} \`${command}\``;
          }),
        ]
      : []),
    "  Current plan: `review dispatch`.",
  ];
}

function printStationDispatchSupport(session: OverworldSession): void {
  const board = session.view().stationDispatchBoard;
  console.log(
    board
      ? renderStationDispatchBoard(session.view()).join("\n")
      : "No optional support is available.",
  );
}

/** Bounded authenticated recall shared by status and an active Station choice. */
function departureRecapValue(
  entry: NonNullable<OverworldView["departureRecap"]>["entries"][number],
): string {
  if (entry.title !== null) return entry.title;
  if (entry.status === "open_optional") return "Open (optional)";
  if (entry.status === "available_after_preparation") {
    return "Available after choosing a field kit";
  }
  if (entry.status === "solo_default") return "Solo departure";
  return "Selected";
}

export function renderDepartureRecap(
  recap: NonNullable<OverworldView["departureRecap"]>,
): string[] {
  const lines = [`${recap.questTitle} departure plan:`];
  if (recap.dispatch) {
    const dispatch = recap.dispatch;
    if (dispatch.state === "sealed") {
      const timing = dispatch.timing === "on_time" ? "on time" : "delayed";
      lines.push(`  Departure plan complete: ${String(dispatch.minutes)} min — ${timing}.`);
    } else if (dispatch.state === "direct_launch") {
      const timing = dispatch.timing === "on_time" ? "on time" : "delayed";
      lines.push(
        `  Leave now: ${String(dispatch.minutes)} min — ${timing}. You may still add a second rider.`,
      );
    } else {
      const remainingLabels = dispatch.remainingOptional.map((slot) =>
        slot === "preparation"
          ? "field kit"
          : slot === "relief_allocation"
            ? "relief wagon"
            : "second rider",
      );
      const remaining =
        remainingLabels.length > 2
          ? `${remainingLabels.slice(0, -1).join(", ")}, and ${remainingLabels.at(-1)!}`
          : remainingLabels.join(" and ");
      lines.push(`  Departure ready: ${String(dispatch.minutes)} min. Optional: ${remaining}.`);
    }
  }
  if (recap.dispatch?.state === "committed") {
    const selected = recap.entries
      .filter((entry) => entry.title !== null)
      .map((entry) => `${entry.label}: ${entry.title!}`);
    if (selected.length > 0) lines.push(`  Selected plan: ${selected.join(" · ")}.`);
    lines.push("  Review all choices and costs: `review dispatch`.");
    return lines;
  }
  for (const entry of recap.entries) {
    lines.push(
      `  ${entry.label}: ${departureRecapValue(entry)}${entry.status === "solo_default" ? " (leaving alone; you may still add a second rider)" : ""}`,
    );
  }
  if (recap.entries.some((entry) => entry.activeFieldTerm)) {
    lines.push("  Review selected costs and effects: `review dispatch`.");
  }
  return lines;
}

/** Explicit read-only expansion of the authenticated terms omitted from the summary. */
export function renderDepartureRecapTerms(
  recap: NonNullable<OverworldView["departureRecap"]>,
): string[] {
  return [
    `${recap.questTitle} choices, costs, and effects:`,
    ...recap.entries.flatMap((entry) => [
      `  ${entry.label}: ${departureRecapValue(entry)}`,
      ...(entry.activeFieldTerm ? [`    Effect: ${entry.activeFieldTerm}`] : []),
    ]),
  ];
}

function printDepartureRecapTerms(session: OverworldSession): void {
  const recap = session.view().departureRecap;
  console.log(
    recap ? renderDepartureRecapTerms(recap).join("\n") : "No departure plan is available.",
  );
}

function questLine(view: OverworldView, quest: OverworldQuestView): string {
  const areaName = view.areas.find((a) => a.id === quest.area)?.name ?? quest.area;
  const status = view.completedQuestIds.includes(quest.id)
    ? " [completed]"
    : view.startedQuestIds.includes(quest.id)
      ? " [started]"
      : view.currentArea?.id === quest.area
        ? ""
        : ` (move to ${areaName} to start)`;
  return `${quest.title} — posted in ${areaName}${status}`;
}

/** Player-facing quest-launch terms shared by interactive and scripted CLI play. */
export function renderQuestLaunch(
  quest: OverworldQuestView,
  mode: "selection" | "preview" = "selection",
): string {
  if (!quest.launch) return "";
  const selectionActive = mode === "selection";
  const lines = [
    `\n${quest.launch.prompt}`,
    EMBEDDED_QUEST_CONTINUITY_EXPLANATION,
    selectionActive
      ? "Choose with `choose <number|name>`. You can also type the number alone."
      : `Start with \`start ${quest.title}\`, then choose a route.`,
  ];
  quest.launch.options.forEach((option, index) => {
    const projection = option.projection;
    const availability =
      projection?.available === false ? ` [blocked: ${projection.blockedReason}]` : "";
    lines.push(
      `  ${selectionActive ? `choose ${String(index + 1)}` : `${String(index + 1)}.`} — ${option.title} — ${option.summary}${availability}`,
    );
    lines.push(`     Expected result: ${option.preview}`);
    if (option.tradeoffSummary) {
      lines.push(`     Tradeoff: ${option.tradeoffSummary}`);
    }
    lines.push(`     If chosen: ${option.consequence}`);
    lines.push(
      `     Cost: ${String(option.terms.minutes)} min, ${String(option.terms.supplies)} ${option.terms.supplies === 1 ? "supply" : "supplies"}, fatigue +${String(option.terms.fatigue)}.`,
    );
    if (projection?.available) {
      lines.push(
        `     Arrival: ${timeLabel(projection.minutesAfter)}; ${String(projection.suppliesAfter)} ${projection.suppliesAfter === 1 ? "supply" : "supplies"} left; fatigue ${String(projection.fatigueAfter)}; condition ${projection.travelConditionAfter}.`,
      );
    } else if (projection) {
      lines.push(`     Arrival time: ${timeLabel(projection.minutesAfter)}.`);
    }
  });
  return lines.join("\n");
}

type QuestLaunchOption = NonNullable<OverworldQuestView["launch"]>["options"][number];

export type QuestLaunchChoiceResolution =
  | { kind: "resolved"; option: QuestLaunchOption }
  | { kind: "ambiguous"; reason: string }
  | { kind: "unmatched"; reason: string };

function normalizeQuestLaunchSelector(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Resolve a quest approach without permissive prefix/substring guessing.
 * `choose 2` is canonical, bare `2` remains compatible, and names/ids must be
 * exact. A mixed value such as `2 garbage` is never parsed as option two. */
export function resolveQuestLaunchChoice(
  options: readonly QuestLaunchOption[],
  raw: string,
): QuestLaunchChoiceResolution {
  const normalized = normalizeQuestLaunchSelector(raw);
  const selector = normalized.startsWith("choose ")
    ? normalized.slice("choose ".length).trim()
    : normalized;
  if (!selector) {
    return {
      kind: "unmatched",
      reason: "Choose with `choose <number|name>`, or type `cancel`.",
    };
  }

  if (/^\d+$/.test(selector)) {
    const number = Number(selector);
    const option = Number.isSafeInteger(number) && number >= 1 ? options[number - 1] : undefined;
    return option
      ? { kind: "resolved", option }
      : {
          kind: "unmatched",
          reason: `There is no option ${selector}. Use a command shown above.`,
        };
  }

  const matches = options.filter(
    (option) =>
      normalizeQuestLaunchSelector(option.id) === selector ||
      normalizeQuestLaunchSelector(option.title) === selector,
  );
  if (matches.length === 1) return { kind: "resolved", option: matches[0]! };
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      reason: `More than one option matches "${selector}". Use \`choose <number>\` or an exact id.`,
    };
  }
  return {
    kind: "unmatched",
    reason: `No option matches "${selector}". Use \`choose <number|name>\`.`,
  };
}

/** The pending road-encounter prompt (pure; exported for tests). */
export function renderEncounter(encounter: OverworldPendingRoadEncounter): string {
  const lines = [
    `\n! Road encounter on ${encounter.route} near ${encounter.to} — ${encounter.event.title} (risk ${encounter.event.risk})`,
    `  ${encounter.event.summary}`,
    "  Choose how to respond:",
  ];
  for (const option of encounter.options) {
    lines.push(
      `    ${commandForStrategy(option.strategy)} — ${option.label}: ${option.minutes} min, supplies -${option.suppliesCost}, fatigue +${option.fatigueGained}${option.renownGained ? `, renown +${option.renownGained}` : ""}`,
    );
  }
  return lines.join("\n");
}

/** The authoritative mandatory journey prompt, shared by fresh and restored CLI sessions. */
export function renderJourneyGate(journey: JourneyPresentation): string {
  const gate = journey.pendingChoice ?? journey.storyChoice;
  if (!gate) return "";
  if (
    journey.storyChoice &&
    gate === journey.storyChoice &&
    isStructuredTerminalStoryChoice(gate)
  ) {
    return renderTerminalStoryChoiceComparison(gate);
  }
  const kind = journey.pendingChoice ? "Journey decision" : "Story choice";
  const lines = [`\n! ${kind}`, `  ${gate.message}`];
  if (journey.pendingChoice?.continuationPreview) {
    const preview = journey.pendingChoice.continuationPreview;
    lines.push("  If you continue, this choice comes next:");
    lines.push(`    ${preview.message}`);
    preview.options.forEach((option) => {
      lines.push(`    [locked] ${option.label}`);
      lines.push(`             Result: ${option.consequence}`);
    });
    lines.push("  You cannot choose these yet. Choose Continue or End first.");
  }
  lines.push("  Choose with `choose <number|label>`:");
  gate.options.forEach((option, index) => {
    lines.push(`    ${String(index + 1)}. ${option.label}`);
    const summary = "summary" in option ? option.summary : undefined;
    if (summary) {
      if (summary.fieldTrigger === undefined) {
        lines.push(
          `       ${storyChoiceCommitmentLabel(
            journey.storyChoice?.kind,
            journey.storyChoice?.progressiveDisclosure?.initialOptionIds.includes(option.id) ===
              true,
          )}: ${summary.commitment}`,
        );
        lines.push(`       Cost: ${summary.immediateCost}`);
        lines.push(`       Give up: ${summary.tradeoff}`);
      } else {
        const usesTriggerCategory = summary.fieldTriggerScope === "category";
        lines.push(`       ${usesTriggerCategory ? "Purpose" : "Choice"}: ${summary.commitment}`);
        lines.push(
          `       ${usesTriggerCategory ? "Applies to" : "Applies when"}: ${summary.fieldTrigger}`,
        );
        if (summary.immediateCost) lines.push(`       Cost: ${summary.immediateCost}`);
        lines.push(`       Tradeoff: ${summary.tradeoff}`);
      }
    }
    lines.push(`       Result: ${option.consequence}`);
  });
  return lines.join("\n");
}

/** The current objective and its engine-owned movement forecast. */
export function renderJourneyStatus(journey: JourneyPresentation): string {
  const lines = ["\n--- Journey ---", `Goal [${journey.goal.status}]: ${journey.goal.text}`];
  if (journey.goalGuidance) lines.push(`Guidance: ${journey.goalGuidance}`);
  const passage = journey.goalPassage;
  if (passage) {
    lines.push(`Route to goal: ${passage.label}`);
    lines.push(
      `  Route: ${String(passage.roadCount)} ${passage.roadCount === 1 ? "road" : "roads"}; ${String(passage.baseMinutes)} min without delays; ${String(passage.estimatedMinutes)} min estimated.`,
    );
    lines.push(
      `  Supplies: ${String(passage.suppliesNeeded)} needed; ${String(passage.supplyDeficit)} short; ${String(passage.suppliesAfter)} left after travel.`,
    );
    lines.push(
      `  Arrival: fatigue ${String(passage.fatigueAfter)}; condition ${passage.travelConditionAfter}.`,
    );
    lines.push(`  Result: ${passage.consequence}`);
    lines.push(`  Stops when: ${passage.stopRule}`);
    lines.push("  Travel: `follow goal`");
  }
  return lines.join("\n");
}

/** The truthful terminal surface for an ended, read-only journey. */
export function renderEndedJourney(
  journey: JourneyPresentation,
  receipt: JourneyExitReceipt,
): string {
  if (journey.status !== "ended") {
    throw new Error("Only an ended journey has an exit record.");
  }
  return [
    "\n! Journey ended. This record is read-only.",
    `  Goal: ${journey.goal.text} [${journey.goal.status}]`,
    `  Decisions made: ${String(journey.acceptedDecisions)}.`,
    `  Exit: ${receipt.exitReason}. Reasons: ${receipt.exitReasons.join(", ")}. Receipt: ${receipt.receiptHash}.`,
    "  The exit record is saved for review.",
  ].join("\n");
}

export function matchJourneyGateOption<Option extends { id: string; label: string }>(
  options: readonly Option[],
  raw: string,
): Option | null {
  return matchTerminalStoryChoiceOption(options, raw);
}

function chooseJourneyGate(
  session: OverworldSession,
  raw: string,
): {
  label: string;
  consequence: string;
} {
  const journey = session.journey();
  const pending = journey.pendingChoice;
  const story = pending ? null : journey.storyChoice;
  const gate = pending ?? story;
  if (!gate) throw new Error("There is no mandatory journey choice right now.");
  const option = matchJourneyGateOption<{
    id: string;
    label: string;
    consequence: string;
  }>(gate.options, raw);
  if (!option) {
    throw new Error("Choose a number or type a full option label shown above.");
  }
  if (pending) {
    session.chooseJourney(option.id as JourneyChoiceOption["id"]);
  } else {
    session.chooseJourneyStory(option.id, story!.id);
  }
  return { label: option.label, consequence: option.consequence };
}

function commandForStrategy(strategy: OverworldRoadEncounterStrategy): string {
  return strategy === "assist_travelers"
    ? "assist"
    : strategy === "cautious_scout"
      ? "scout"
      : "press";
}

function strategyForCommand(raw: string): OverworldRoadEncounterStrategy | null {
  const word = raw.trim().toLowerCase();
  if (word.startsWith("assist")) return "assist_travelers";
  if (word.startsWith("scout") || word.startsWith("caut")) return "cautious_scout";
  if (word.startsWith("press")) return "press_on";
  return null;
}

const HELP = `Commands:
  look                     show this town, area, and available work
  review support           compare optional departure support
  review dispatch          show your departure choices, costs, and effects
  choose <number|label|id> answer the current choice
  inspect <id>             compare an optional choice
  follow goal              travel toward the current goal
  go <town|road #>         travel one road (long trips continue one road at a time)
  routes                   show travel estimates to known towns
  assist | scout | press   handle a road encounter
  care | rest | resupply   use a town service
  enter <area>             walk to another area in this town
  explore [<area|site>]    explore an area or known site
  scout <poi>              scout a place
  talk <contact>           talk to a contact
  investigate <event>      investigate an event
  resolve <event>          resolve an event
  work <job>               do a known local job
  start <quest>            start or resume a known quest
  abandon                  pause the active quest and return to the road
  journal | log            show recent journal entries or travel
  save [name] | load [name] save or load this journey and active quest
  hash                     show the save-state hash
  actions | help | quit`;

function matchingEntities<T extends { id: string }>(
  items: readonly T[],
  raw: string,
  label: (item: T) => string,
): T[] {
  const q = raw.trim().toLowerCase();
  if (!q) return [];
  const exactIds = items.filter((item) => item.id.toLowerCase() === q);
  if (exactIds.length) return exactIds;
  const exactLabels = items.filter((item) => label(item).toLowerCase() === q);
  if (exactLabels.length) return exactLabels;
  const partialLabels = items.filter((item) => label(item).toLowerCase().includes(q));
  if (partialLabels.length) return partialLabels;
  return items.filter((item) => item.id.toLowerCase().includes(q));
}

function matchEntity<T extends { id: string }>(
  items: readonly T[],
  raw: string,
  label: (item: T) => string,
): T | null {
  return matchingEntities(items, raw, label)[0] ?? null;
}

function printActionResult(result: OverworldActionResult, view: OverworldView): void {
  if (result.alreadyKnown) {
    console.log(`Reviewed: ${result.entry.title}.`);
    return;
  }
  console.log(`[+${result.minutes} min] ${result.entry.text}`);
  for (const area of result.discoveredAreas ?? []) console.log(`  ↳ new area: ${area.name}`);
  const actionableJobIds = new Set([...view.jobs, ...view.rememberedJobs].map((job) => job.id));
  for (const job of result.discoveredJobs ?? []) {
    if (job.authored_scene && !actionableJobIds.has(job.id)) {
      console.log(`  ↳ new job (not available yet): ${job.title}`);
    } else {
      console.log(`  ↳ new job: ${job.title}`);
    }
  }
  for (const site of result.discoveredSites ?? []) console.log(`  ↳ new site: ${site.title}`);
  for (const quest of result.discoveredQuests ?? [])
    console.log(`  ↳ new quest lead: ${quest.title}`);
}

function printServiceResult(result: OverworldServiceResult): void {
  console.log(result.changed ? `[+${result.minutes} min] ${result.message}` : result.message);
}

function printTravelEntry(entry: TravelLogEntry): void {
  const delay = entry.delayMinutes > 0 ? ` (+${entry.delayMinutes} min delay)` : "";
  console.log(
    `Took ${entry.route} to ${entry.to} — ${entry.minutes} min${delay}. Supplies ${entry.suppliesAfter}, fatigue ${entry.fatigueAfter}.`,
  );
  if (entry.roadEvent) {
    console.log(`${entry.roadEvent.title} (risk ${entry.roadEvent.risk})`);
    console.log(entry.roadEvent.summary);
  }
}

function printGoalPassageResult(result: OverworldJourneyGoalPassageResult): void {
  console.log(`Followed the current goal toward ${result.destination}:`);
  for (const leg of result.legs) printTravelEntry(leg);
  const reason =
    result.stopReason === "objective"
      ? "Reached the goal town."
      : result.stopReason === "road_encounter"
        ? "A road encounter needs your response."
        : "Stopped before another road would cause a supply shortage or worsen your condition.";
  console.log(`Stopped at ${result.stoppedAt}. ${reason}`);
}

function printJournal(view: OverworldView): void {
  for (const entry of view.journal.slice(-10)) {
    console.log(`[${entry.recordedAt}] ${entry.town}: ${entry.title} — ${entry.text}`);
  }
  if (!view.journal.length) console.log("The journal is empty.");
}

function printTravelLog(view: OverworldView): void {
  for (const entry of view.log.slice(0, 10)) {
    console.log(
      `${entry.from} → ${entry.to} via ${entry.route} — ${entry.minutes} min, supplies ${entry.suppliesAfter}, fatigue ${entry.fatigueAfter}`,
    );
  }
  if (!view.log.length) console.log("No roads travelled yet.");
}

export type QuestCommandReader = {
  read(prompt: string): Promise<string | null>;
  scripted: boolean;
};

type TerminalStoryChoiceRunResult = "chosen" | "cancelled" | "closed" | "quit" | "refresh";

async function controlTerminalStoryChoice(args: {
  session: OverworldSession;
  prompt: NonNullable<JourneyPresentation["storyChoice"]>;
  allowComparisonExit: boolean;
  reader: QuestCommandReader;
  reject: (message: string) => void;
  onAuxiliary: (line: string) => Promise<TerminalStoryChoiceAuxiliaryResult>;
}): Promise<TerminalStoryChoiceRunResult> {
  let chosenResult: OverworldJourneyStoryChoiceResult | undefined;
  const result = await runTerminalStoryChoiceController({
    prompt: args.prompt,
    reader: args.reader,
    write: (text) => console.log(text),
    reject: args.reject,
    choose: (option) => {
      chosenResult = args.session.chooseJourneyStory(option.id, args.prompt.id);
    },
    reveal: (revealId) => {
      return args.session.revealJourneyStory(args.prompt.id, revealId);
    },
    presentedOptions: () => args.session.journeyStoryOptionsForPresentation(args.prompt.id),
    allowComparisonExit: args.allowComparisonExit,
    onAuxiliary: args.onAuxiliary,
  });
  if (result.kind === "chosen") {
    console.log(`Chosen: ${result.option.label}.`);
    if (chosenResult?.displaySummary) {
      console.log(chosenResult.displaySummary);
    } else {
      console.log(`Result: ${result.option.consequence}`);
    }
    console.log(renderJourneyStatus(args.session.journey()));
  } else if (result.kind === "cancelled") {
    console.log("Closed without making a choice.");
  }
  return result.kind;
}

function departureInteractionByExactId(
  interactions: readonly OverworldDepartureInteraction[],
  raw: string,
): OverworldDepartureInteraction | null {
  const exact = raw.trim().toLowerCase();
  return interactions.find((interaction) => interaction.id.toLowerCase() === exact) ?? null;
}

async function main(): Promise<void> {
  rejectPositionals();
  const seed = Number(arg("--seed") ?? 1);
  const rawCommands = arg("--commands");
  const commands =
    rawCommands === undefined
      ? null
      : rawCommands
          .split(/[;,]/)
          .map((s) => s.trim())
          .filter(Boolean);

  const manifest = loadOverworldManifest(process.cwd());
  const restorePath = arg("--restore");
  let cli: CliJourneySession;
  if (restorePath !== undefined) {
    cli = CliJourneySession.restore(
      process.cwd(),
      manifest,
      JSON.parse(readFileSync(restorePath, "utf8")),
    );
    printRestoreWarnings(cli.overworld());
    if (cli.journey().status !== "ended") {
      console.log(`Resumed in ${cli.overworld().view().current.name}.`);
    }
  } else {
    cli = CliJourneySession.fresh(process.cwd(), manifest);
    console.log(
      `You begin in ${cli.overworld().view().current.name}. Scout or talk to find local work, or take a known road.`,
    );
  }
  let session = cli.overworld();
  if (cli.journey().status !== "ended") {
    console.log(render(session.view()));
    console.log(renderJourneyStatus(cli.journey()));
  }

  const interactive = commands === null;
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
  const scripted = commands ?? [];
  let scriptedFailure = false;
  const reader: QuestCommandReader = {
    scripted: !interactive,
    read: async (prompt: string) => {
      if (interactive) return rl!.question(prompt);
      const next = scripted.shift();
      if (next === undefined) return null;
      console.log(`${prompt}${next}`);
      return next;
    },
  };
  try {
    running: while (true) {
      session = cli.overworld();
      const view = session.view();
      const journey = cli.journey();
      if (journey.status === "ended") {
        const receipt = session.journeyExitReceipt();
        if (!receipt) throw new Error("An ended journey is missing its exit record.");
        console.log(renderEndedJourney(journey, receipt));
        break;
      }

      // One persistent child owns quest turns, but every parent journey/story
      // gate preempts it until the player answers that parent boundary.
      const child = cli.child();
      if (!journey.pendingChoice && !journey.storyChoice && child?.phase === "active") {
        const observation = buildRpgObservation(child.index, child.state, {
          includeWorldIntro: true,
          availableActions: [...child.actions],
        });
        console.log(renderQuest(observation));
        const dialoguePrompt = renderRpgActiveDialoguePrompt(observation, child.actions, {
          index: child.index,
          state: child.state,
        });
        if (dialoguePrompt) console.log(dialoguePrompt);

        const raw = await reader.read(`\n[quest: ${child.title}] > `);
        if (raw === null) break;
        const line = raw.trim();
        if (!line) continue;
        const low = line.toLowerCase();
        if (["quit", "q", "exit"].includes(low)) break;
        if (["actions", "help", "?"].includes(low)) {
          console.log(renderQuestActionHelp(child.index, child.state));
          continue;
        }
        if (low === "abandon") {
          cli.suspendQuest();
          console.log(`You set ${child.title} aside and return to the road.`);
          continue;
        }
        if (low === "hash") {
          console.log(cli.snapshotHash());
          continue;
        }
        if (low === "save" || low.startsWith("save ")) {
          try {
            saveSnapshot(cli, line.slice(4).trim());
          } catch (error) {
            if (isCliJourneyIntegrityError(error)) throw error;
            console.log(
              `Could not continue: ${error instanceof Error ? error.message : String(error)}`,
            );
            scriptedFailure = true;
          }
          continue;
        }
        if (low === "load" || low.startsWith("load ")) {
          try {
            const path = savePath(line.slice(4).trim());
            cli = CliJourneySession.restore(
              process.cwd(),
              manifest,
              JSON.parse(readFileSync(path, "utf8")),
            );
            session = cli.overworld();
            printRestoreWarnings(session);
            console.log(`Restored ${path}. Resumed in ${session.view().current.name}.`);
          } catch (error) {
            if (isCliJourneyIntegrityError(error)) throw error;
            console.log(
              `Could not continue: ${error instanceof Error ? error.message : String(error)}`,
            );
            scriptedFailure = true;
          }
          continue;
        }

        const parsed = resolveRpgActionOption(child.index, child.state, raw);
        if (!parsed.ok) {
          // `leave` remains available as a legacy escape only when it was not
          // an exact authored command on this turn.
          if (low === "leave") {
            cli.suspendQuest();
            console.log(`You set ${child.title} aside and return to the road.`);
          } else {
            console.log(parsed.reason);
            scriptedFailure = true;
          }
          continue;
        }
        try {
          const result = cli.stepQuest(parsed.option);
          if (!result.ok) {
            console.log(`(${result.rejectionReason ?? "Action rejected."})`);
            scriptedFailure = true;
            continue;
          }
          for (const event of result.events) {
            if (event.type === "narration") console.log(event.text);
          }
          if (result.questCompletion) {
            console.log(renderQuestCompletion(result.questCompletion));
          } else if (result.terminalDeath) {
            console.log(
              "Your character died before completing the quest. The lead remains open, but this journey cannot restart it.",
            );
          }
        } catch (error) {
          if (isCliJourneyIntegrityError(error)) throw error;
          console.log(
            `Could not continue: ${error instanceof Error ? error.message : String(error)}`,
          );
          scriptedFailure = true;
        }
        continue;
      }

      const fail = (message: string): void => {
        console.log(message);
        scriptedFailure = true;
      };
      const handleStoryChoiceAuxiliary = async (
        line: string,
      ): Promise<TerminalStoryChoiceAuxiliaryResult> => {
        const [rawVerb = ""] = line.trim().split(/\s+/, 1);
        const verb = rawVerb.toLowerCase();
        const rest = line.trim().slice(rawVerb.length).trim();
        if (["actions", "help", "?"].includes(verb) && rest.length === 0) {
          console.log(HELP);
          return "handled";
        }
        if (["look", "status", "l"].includes(verb) && rest.length === 0) {
          console.log(render(session.view()));
          console.log(renderJourneyStatus(session.journey()));
          return "handled";
        }
        if (verb === "review" && rest.toLowerCase() === "dispatch") {
          printDepartureRecapTerms(session);
          return "handled";
        }
        if (verb === "review" && rest.toLowerCase() === "support") {
          printStationDispatchSupport(session);
          return "handled";
        }
        if (verb === "hash" && rest.length === 0) {
          console.log(cli.snapshotHash());
          return "handled";
        }
        if (verb === "journal" && rest.length === 0) {
          printJournal(session.view());
          return "handled";
        }
        if (verb === "log" && rest.length === 0) {
          printTravelLog(session.view());
          return "handled";
        }
        if (verb === "save") {
          saveSnapshot(cli, rest);
          return "handled";
        }
        if (verb === "load") {
          const path = savePath(rest);
          cli = CliJourneySession.restore(
            process.cwd(),
            manifest,
            JSON.parse(readFileSync(path, "utf8")),
          );
          session = cli.overworld();
          printRestoreWarnings(session);
          if (session.journey().status !== "ended") {
            console.log(`Restored ${path}. Resumed in ${session.view().current.name}.`);
            console.log(renderJourneyStatus(session.journey()));
          }
          return "refresh";
        }
        return "unhandled";
      };
      if (journey.storyChoice && isStructuredTerminalStoryChoice(journey.storyChoice)) {
        try {
          // The Station choice is still mandatory, but the player should not
          // have to leave its comparison to recall already-authenticated terms.
          if (view.departureRecap)
            console.log(renderDepartureRecap(view.departureRecap).join("\n"));
          const outcome = await controlTerminalStoryChoice({
            session,
            prompt: journey.storyChoice,
            reader,
            reject: fail,
            allowComparisonExit: false,
            onAuxiliary: handleStoryChoiceAuxiliary,
          });
          if (outcome === "chosen") cli.afterParentChoice();
          if (outcome === "quit" || outcome === "closed") break;
        } catch (error) {
          if (isCliJourneyIntegrityError(error)) throw error;
          fail(`Could not continue: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      const journeyGate = renderJourneyGate(journey);
      if (journeyGate) console.log(journeyGate);
      else if (view.pendingRoadEncounter) console.log(renderEncounter(view.pendingRoadEncounter));
      const raw = await reader.read(`\n[${view.current.name}] > `);
      if (raw === null) break;
      const line = raw.trim();
      if (!line) continue;
      const low = line.toLowerCase();
      if (["quit", "q", "exit"].includes(low)) break;
      if (["actions", "help", "?"].includes(low)) {
        console.log(HELP);
        continue;
      }

      try {
        if (journey.pendingChoice || journey.storyChoice) {
          const [verb = "", ...restWords] = low.split(/\s+/);
          const rest = restWords.join(" ");
          if (["look", "status", "l"].includes(verb)) {
            console.log(render(session.view()));
            console.log(renderJourneyStatus(session.journey()));
          } else if (verb === "review" && rest === "dispatch") {
            printDepartureRecapTerms(session);
          } else if (verb === "review" && rest === "support") {
            printStationDispatchSupport(session);
          } else if (verb === "hash") {
            console.log(cli.snapshotHash());
          } else if (verb === "journal") {
            printJournal(session.view());
          } else if (verb === "log") {
            printTravelLog(session.view());
          } else if (verb === "save") {
            saveSnapshot(cli, line.slice(4).trim());
          } else if (verb === "load") {
            const path = savePath(rest);
            cli = CliJourneySession.restore(
              process.cwd(),
              manifest,
              JSON.parse(readFileSync(path, "utf8")),
            );
            session = cli.overworld();
            printRestoreWarnings(session);
            if (session.journey().status !== "ended") {
              console.log(`Restored ${path}. Resumed in ${session.view().current.name}.`);
              console.log(renderJourneyStatus(session.journey()));
            }
          } else if (verb === "choose") {
            const chosen = chooseJourneyGate(session, line.slice(verb.length).trim());
            cli.afterParentChoice();
            console.log(`Chosen: ${chosen.label}.`);
            console.log(`Result: ${chosen.consequence}`);
            if (session.journey().status === "ended") {
              const receipt = session.journeyExitReceipt();
              if (!receipt) throw new Error("An ended journey is missing its exit record.");
              console.log(renderEndedJourney(session.journey(), receipt));
              break running;
            }
            console.log(renderJourneyStatus(session.journey()));
          } else {
            fail(
              "Answer the current choice with `choose <number|label>`. You may also use `look`, `review support`, `review dispatch`, `help`, `journal`, `log`, `save`, `load`, `hash`, or `quit`.",
            );
          }
          continue;
        }

        if (view.pendingRoadEncounter) {
          const strategy = strategyForCommand(low);
          if (strategy) {
            const result = session.resolveRoadEncounter(strategy);
            console.log(result.entry.text);
          } else if (["look", "status", "l"].includes(low)) {
            console.log(render(session.view()));
            console.log(renderJourneyStatus(session.journey()));
          } else if (low === "review dispatch") {
            printDepartureRecapTerms(session);
          } else if (low === "review support") {
            printStationDispatchSupport(session);
          } else if (low === "hash") {
            console.log(cli.snapshotHash());
          } else if (low.startsWith("save")) {
            saveSnapshot(cli, line.slice(4).trim());
          } else {
            fail("Resolve the pending road encounter first (assist / scout / press).");
          }
          continue;
        }

        const [verb, ...restWords] = low.split(/\s+/);
        const rest = restWords.join(" ");
        switch (verb) {
          case "look":
          case "status":
          case "l":
            console.log(render(session.view()));
            console.log(renderJourneyStatus(session.journey()));
            break;
          case "roads":
            console.log(render(session.view()));
            break;
          case "routes":
          case "destinations": {
            const options = session.view().routeOptions;
            if (!options.length) {
              console.log("No destinations are known yet. Take a road to learn the map.");
              break;
            }
            for (const plan of options) {
              const deficit =
                plan.estimate.supplyDeficit > 0 ? ` (${plan.estimate.supplyDeficit} short!)` : "";
              const supplyUnit = plan.estimate.suppliesNeeded === 1 ? "supply" : "supplies";
              console.log(
                `${plan.destination.name} — ${plan.totalDistanceMi.toFixed(1)} mi, about ${plan.estimate.elapsedMinutes} min on ${plan.steps.length} ${plan.steps.length === 1 ? "road" : "roads"}, needs ${plan.estimate.suppliesNeeded} ${supplyUnit}${deficit}, fatigue +${plan.estimate.fatigueGained}`,
              );
            }
            break;
          }
          case "review":
            if (rest === "dispatch") {
              printDepartureRecapTerms(session);
              break;
            }
            if (rest === "support") {
              printStationDispatchSupport(session);
              break;
            }
            fail(
              "Use `review support` for optional choices or `review dispatch` for your current plan.",
            );
            break;
          case "go":
          case "travel": {
            if (!rest) {
              fail("Go where? Try `go <town name>` or `go <road number>` from `look`.");
              break;
            }
            printTravelEntry(travelToward(session, rest));
            break;
          }
          case "follow": {
            if (rest !== "goal") {
              fail("Use `follow goal` to travel toward the current goal.");
              break;
            }
            const journey = session.journey();
            if (!journey.goalPassage) {
              console.log(renderJourneyStatus(journey));
              console.log(
                "You cannot travel toward this goal from here. Follow the local goal guidance above.",
              );
              break;
            }
            printGoalPassageResult(session.followGoalPassage());
            break;
          }
          case "rest":
            printServiceResult(session.restAtTown());
            break;
          case "care":
            printServiceResult(session.careAtTown());
            break;
          case "resupply":
            printServiceResult(session.resupplyAtTown());
            break;
          case "areas":
            console.log(render(session.view()));
            break;
          case "enter":
          case "move": {
            const exit = matchEntity(session.view().areaExits, rest, (e) => e.destination.name);
            if (!exit) {
              fail(`No local route matches "${rest}". Local routes are listed under \`look\`.`);
              break;
            }
            const result = session.moveArea(exit.id);
            console.log(
              `Walked ${routeLabelWithDestination(result.route, result.to.name)} — ${result.minutes} min.`,
            );
            break;
          }
          case "explore": {
            const v = session.view();
            if (!rest) {
              if (!v.currentArea) {
                fail("There is no local area here to explore.");
                break;
              }
              printActionResult(session.exploreArea(v.currentArea.id), session.view());
              break;
            }
            const area = matchEntity(v.areas, rest, (a) => a.name);
            if (area) {
              printActionResult(session.exploreArea(area.id), session.view());
              break;
            }
            const site = matchEntity(v.sites, rest, (s) => s.title);
            if (site) {
              printActionResult(session.exploreSite(site.id), session.view());
              break;
            }
            fail(`Nothing discovered here matches "${rest}" to explore.`);
            break;
          }
          case "scout": {
            const poi = matchEntity(session.view().pois, rest, (p) => p.title);
            if (!poi) {
              fail(`Nothing scoutable matches "${rest}".`);
              break;
            }
            printActionResult(session.scoutPoi(poi.id), session.view());
            break;
          }
          case "talk": {
            const target = rest.replace(/^to\s+/, "");
            const character = matchEntity(session.view().characters, target, (c) => c.name);
            if (!character) {
              fail(`No local contact matches "${target}".`);
              break;
            }
            printActionResult(session.talkToCharacter(character.id), session.view());
            break;
          }
          case "inspect": {
            const interaction = departureInteractionByExactId(
              session.view().departureInteractions,
              rest,
            );
            if (!interaction) {
              if (session.isDepartureStoryChoiceResolved(rest)) {
                fail(
                  `You already made the optional choice "${rest}". Use \`look\` to see what remains.`,
                );
                break;
              }
              fail(
                `No optional choice matches "${rest}". Use an \`inspect <id>\` command shown by \`look\`.`,
              );
              break;
            }
            const prompt = session.inspectJourneyStory(interaction.id);
            if (!isStructuredTerminalStoryChoice(prompt)) {
              fail(`The optional choice "${interaction.id}" has no comparison to show.`);
              break;
            }
            const departureRecap = session.view().departureRecap;
            if (departureRecap) {
              console.log(renderDepartureRecap(departureRecap).join("\n"));
            }
            const outcome = await controlTerminalStoryChoice({
              session,
              prompt,
              reader,
              reject: fail,
              allowComparisonExit: true,
              onAuxiliary: handleStoryChoiceAuxiliary,
            });
            if (outcome === "quit") break running;
            break;
          }
          case "investigate": {
            const event = matchEntity(session.view().events, rest, (e) => e.title);
            if (!event) {
              fail(`No local event matches "${rest}".`);
              break;
            }
            printActionResult(session.investigateEvent(event.id), session.view());
            break;
          }
          case "resolve": {
            const event = matchEntity(session.view().events, rest, (e) => e.title);
            if (!event) {
              fail(`No local event matches "${rest}".`);
              break;
            }
            printActionResult(session.resolveEvent(event.id), session.view());
            break;
          }
          case "work": {
            const current = session.view();
            const job = matchEntity(current.jobs, rest, (j) => j.title);
            if (!job) {
              const elsewhere = matchEntity(current.rememberedJobs, rest, (j) => j.title);
              if (elsewhere) {
                const area = current.areas.find((candidate) => candidate.id === elsewhere.area);
                fail(
                  `${elsewhere.title} is discovered but not available in this area${area ? `; move to ${area.name}` : ""}.`,
                );
                break;
              }
              const unavailableMatches = matchingEntities(
                manifest.local_jobs.filter((candidate) =>
                  current.discoveredJobIds.includes(candidate.id),
                ),
                rest,
                (candidate) => candidate.title,
              );
              if (unavailableMatches.length > 1) {
                const choices = unavailableMatches.map((candidate) => {
                  const town = manifest.nodes.find((node) => node.id === candidate.home);
                  return `${candidate.id} (${town?.name ?? candidate.home})`;
                });
                fail(
                  `More than one discovered job matches "${rest}": ${choices.join("; ")}. Use an exact job id.`,
                );
                break;
              }
              const unavailable = unavailableMatches[0];
              if (unavailable) {
                if (current.completedJobIds.includes(unavailable.id)) {
                  fail(`${unavailable.title} is already complete.`);
                  break;
                }
                if (unavailable.home !== current.current.id) {
                  const town = manifest.nodes.find(
                    (candidate) => candidate.id === unavailable.home,
                  );
                  fail(
                    `${unavailable.title} is discovered in ${town?.name ?? unavailable.home}; travel there before working it.`,
                  );
                  break;
                }
                fail(
                  `${unavailable.title} is known but not available yet. Continue the journey and check again later.`,
                );
                break;
              }
              fail(`No known job matches "${rest}". Scout or explore to find jobs.`);
              break;
            }
            printActionResult(session.workLocalJob(job.id), session.view());
            break;
          }
          case "start": {
            const retained = cli.child();
            const retainedMatch = retained
              ? matchEntity(
                  [{ id: retained.worldQuestId, title: retained.title }],
                  rest,
                  (candidate) => candidate.title,
                )
              : null;
            const quest = matchEntity(session.view().quests, rest, (q) => q.title);
            if (retained) {
              if (!retainedMatch) {
                fail(`Finish or resume ${retained.title} before starting another quest.`);
                break;
              }
              if (retained.phase === "terminal") {
                fail(`${retained.title} has already reached a terminal death outcome.`);
                break;
              }
              cli.resumeQuest(retained.worldQuestId);
              console.log(`Resumed local quest: ${retained.title}.`);
              break;
            }
            if (!quest) {
              fail(`No known quest matches "${rest}". Scout to find more leads.`);
              break;
            }
            const approach = await chooseQuestApproach(quest, reader, () => {
              scriptedFailure = true;
            });
            if (approach === "quit") break running;
            if (approach === "cancel") break;
            const started = cli.beginQuest(quest.id, seed, approach);
            console.log(
              `Started local quest: ${started.title}${
                started.launch?.selected
                  ? ` via ${started.launch.options.find((option) => option.id === started.launch?.selected?.optionId)?.title ?? started.launch.selected.optionId}`
                  : ""
              }. (Type \`abandon\` to set it aside.)`,
            );
            break;
          }
          case "journal": {
            printJournal(session.view());
            break;
          }
          case "log": {
            printTravelLog(session.view());
            break;
          }
          case "save":
            saveSnapshot(cli, rest);
            break;
          case "load": {
            const path = savePath(rest);
            cli = CliJourneySession.restore(
              process.cwd(),
              manifest,
              JSON.parse(readFileSync(path, "utf8")),
            );
            session = cli.overworld();
            printRestoreWarnings(session);
            if (session.journey().status !== "ended") {
              console.log(`Restored ${path}. Resumed in ${session.view().current.name}.`);
              console.log(renderJourneyStatus(session.journey()));
            }
            break;
          }
          case "hash":
            console.log(cli.snapshotHash());
            break;
          default:
            fail(`Unknown command "${verb}". Try \`help\`.`);
        }
      } catch (error) {
        if (isCliJourneyIntegrityError(error)) throw error;
        fail(`Could not continue: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    rl?.close();
  }

  if (!interactive && scriptedFailure) {
    console.error("\nA scripted command was rejected.");
    process.exitCode = 1;
  }
}

/**
 * One travel leg toward a target: a road number from `look`, an adjacent town, or
 * a discovered town (first leg of the planned route — road encounters resolve
 * between legs, so multi-leg journeys go leg by leg like the web UI).
 */
function travelToward(session: OverworldSession, target: string): TravelLogEntry {
  const view = session.view();
  const index = Number.parseInt(target, 10);
  if (Number.isInteger(index) && index >= 1 && index <= view.exits.length)
    return session.travel(view.exits[index - 1]!.id);
  // Match on the DESTINATION town (name or id), never the edge id — an edge id
  // contains both endpoint names, so it would match the town you are standing in.
  const direct = matchEntity(
    view.exits.map((e) => ({ id: e.destination.id, name: e.destination.name, edgeId: e.id })),
    target,
    (e) => e.name,
  );
  if (direct) return session.travel(direct.edgeId);
  const town = matchEntity(view.discovered, target, (t) => t.name);
  if (!town)
    throw new Error(`No road or discovered town matches "${target}". Try \`routes\` or \`look\`.`);
  const plan = session.planRoute(town.id);
  const first = plan.steps[0];
  if (!first) throw new Error("You are already there.");
  console.log(`Heading to ${plan.destination.name}: road 1 of ${plan.steps.length}.`);
  return session.travel(first.edge.id);
}

async function chooseQuestApproach(
  quest: OverworldQuestView,
  reader: QuestCommandReader,
  onRejectedCommand?: () => void,
): Promise<string | undefined | "cancel" | "quit"> {
  if (!quest.launch) return undefined;
  console.log(renderQuestLaunch(quest));
  while (true) {
    const raw = await reader.read(`\n[approach: ${quest.title}] > `);
    if (raw === null) return "cancel";
    const low = raw.trim().toLowerCase();
    if (["quit", "q", "exit"].includes(low)) return "quit";
    if (["abandon", "leave", "cancel"].includes(low)) return "cancel";
    if (["actions", "help", "?"].includes(low)) {
      console.log(renderQuestLaunch(quest));
      continue;
    }
    const selection = resolveQuestLaunchChoice(quest.launch.options, raw);
    if (selection.kind !== "resolved") {
      console.log(selection.reason);
      if (reader.scripted) onRejectedCommand?.();
      continue;
    }
    if (selection.option.projection?.available === false) {
      console.log(selection.option.projection.blockedReason ?? "That approach is unavailable.");
      if (reader.scripted) onRejectedCommand?.();
      continue;
    }
    return selection.option.id;
  }
}

/**
 * Hand off to an RPG quest session and close the outcome back into the overworld,
 * mirroring the MCP quest bridge: preview → prepare the launch → boot/import the
 * quest → commit the start → play to an ending → completeQuest (never on death; abandoning
 * leaves the lead started-but-open, as the engine dictates).
 */
export async function runQuestSession(
  session: OverworldSession,
  runtime: RpgSourceRuntime,
  questId: string,
  seed: number,
  reader: QuestCommandReader,
): Promise<"done" | "quit"> {
  const quest = session.previewQuestStart(questId);
  let approachId: string | undefined;
  if (quest.launch) {
    console.log(renderQuestLaunch(quest));
    while (approachId === undefined) {
      const raw = await reader.read(`\n[approach: ${quest.title}] > `);
      if (raw === null) return "done";
      const low = raw.trim().toLowerCase();
      if (["quit", "q", "exit"].includes(low)) return "quit";
      if (["abandon", "leave", "cancel"].includes(low)) return "done";
      if (["actions", "help", "?"].includes(low)) {
        console.log(renderQuestLaunch(quest));
        continue;
      }
      const selection = resolveQuestLaunchChoice(quest.launch.options, raw);
      if (selection.kind !== "resolved") {
        console.log(selection.reason);
        continue;
      }
      const option = selection.option;
      if (option.projection?.available === false) {
        console.log(option.projection.blockedReason ?? "That approach is unavailable.");
        continue;
      }
      approachId = option.id;
    }
  }

  // Prepare the parent transition first, but compile and initialize the embedded RPG
  // before committing it. A bad pack or import therefore cannot spend the approach
  // resources, record its memory, or consume the quest-start decision.
  const plan = session.prepareQuestStart(quest.id, approachId);
  const launchOverlay = embeddedLaunchOverlayForPlan(plan);
  const source = runtime.requireWorldQuestPlayable(plan.quest.id);

  const index = indexRpgPack(source.compiled.pack);
  const rules = buildRpgRules(index);
  const step = makeStep(rules);
  let state =
    source.campaignImports === undefined
      ? initStateForRpgPack(index, seed, undefined, launchOverlay)
      : initStateForRpgPack(
          index,
          seed,
          {
            character: plan.characterAfter,
            imports: source.campaignImports,
          },
          launchOverlay,
        );
  session.commitQuestStart(plan);
  console.log(
    `Started local quest: ${plan.quest.title}${
      plan.quest.launch?.selected
        ? ` via ${plan.quest.launch.options.find((option) => option.id === plan.quest.launch?.selected?.optionId)?.title ?? plan.quest.launch.selected.optionId}`
        : ""
    }. (Type \`abandon\` to set it aside.)`,
  );
  let quitting = false;

  while (true) {
    const obs = buildRpgObservation(index, state, { includeWorldIntro: true });
    console.log(renderQuest(obs));
    const dialoguePrompt = renderRpgActiveDialoguePrompt(obs, enumerateRpgActions(index, state), {
      index,
      state,
    });
    if (dialoguePrompt) console.log(dialoguePrompt);
    if (obs.ended || obs.available_actions.length === 0) break;

    const raw = await reader.read(`\n[quest: ${plan.quest.title}] > `);
    if (raw === null) break;
    const low = raw.trim().toLowerCase();
    if (["quit", "q", "exit"].includes(low)) {
      quitting = true;
      break;
    }
    // `leave` is a common authored dialogue topic (including Cade's). Only the
    // explicitly documented `abandon` command escapes before legal-command
    // resolution gets a chance to act; an unmatched legacy `leave` falls back
    // to abandoning below.
    if (low === "abandon") break;
    if (["actions", "help", "?"].includes(low)) {
      console.log(renderQuestActionHelp(index, state));
      continue;
    }
    const parsed = resolveRpgCommand(index, state, raw);
    if (!parsed.ok) {
      if (low === "leave") break;
      console.log(parsed.reason);
      continue;
    }
    if (!rules.legalActions(state).some((a) => actionEquals(a, parsed.action))) {
      if (low === "leave") break;
      console.log(illegalReason(index, state, parsed.action));
      continue;
    }
    const r = step(state, parsed.action);
    if (!r.ok) {
      console.log(`(${r.rejectionReason})`);
      continue;
    }
    for (const e of r.events) if (e.type === "narration") console.log(e.text);
    state = r.state;
  }

  if (state.ended && state.endingId) {
    const ending = source.compiled.pack.endings.find((e) => e.id === state.endingId);
    if (ending && !ending.death) {
      const result = session.completeQuest(quest.id, {
        endingId: ending.id,
        endingTitle: ending.title,
        death: ending.death,
      });
      console.log(renderQuestCompletion(result));
    } else {
      console.log(
        "Your character died before completing the quest. The lead remains open, but this journey cannot restart it.",
      );
    }
  } else if (!quitting) {
    console.log(`You set ${plan.quest.title} aside and return to the road.`);
  }
  return quitting ? "quit" : "done";
}

function saveSnapshot(session: CliJourneySession, name: string): void {
  const path = savePath(name);
  mkdirSync(SAVE_DIR, { recursive: true });
  writeFileSync(path, session.serialize());
  console.log(`Saved journey to ${path}.`);
}

function printRestoreWarnings(session: OverworldSession): void {
  for (const warning of session.restoreWarnings()) console.log(`Warning: ${warning}`);
}

function savePath(name: string): string {
  const slug = (name.trim() || DEFAULT_SAVE_NAME).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return join(SAVE_DIR, `${slug}.json`);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function rejectPositionals(): void {
  for (let i = 2; i < process.argv.length; i += 1) {
    const value = process.argv[i]!;
    if (VALUE_FLAGS.has(value)) {
      i += 1;
      continue;
    }
    if (value === "--" || value.startsWith("--")) continue;
    throw new Error(
      `overworld takes no positional arguments (got "${value}"); use --restore <saves/file.json> to resume or --commands "..." to script.`,
    );
  }
}

// Run only when invoked directly (not when imported for testing the pure render()),
// mirroring the bin/rpg_play.ts entry guard.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
