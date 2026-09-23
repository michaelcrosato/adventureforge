/**
 * Cross-interface launch-overlay parity (audit/fix-2026-08-30).
 *
 * The delayed Wolf-Winter dispatch overlay was derived and applied only on the
 * MCP quest bridge; the terminal journey and the web UI called the same
 * initializer without it, so identical player behavior opened a different
 * child state depending on interface. Every bridge now derives the overlay
 * through src/world/embedded_launch_overlay.ts. These tests pin that parity
 * and the replay-from-fresh restore paths that must rehydrate the persisted
 * receipt. The derivation takes no surface identity at all (bug_0644), so the
 * children are byte-identical across MCP runs and interfaces, not just alike.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  EMBEDDED_LAUNCH_OVERLAY_RECEIPT_VERSION,
  WOLF_WINTER_DISPATCH_DELAY_FLAG,
} from "../../src/core/embedded_launch_overlay_receipt.js";
import { createToolApi } from "../../src/mcp/tools.js";
import { embeddedLaunchOverlayForPlan } from "../../src/world/embedded_launch_overlay.js";
import { CliJourneySession } from "../../src/cli/embedded_quest_journey.js";
import { OverworldSession } from "../../src/world/session.js";
import { loadOverworldManifest } from "../../src/world/source.js";
import { GameSession } from "../../ui/src/engine.js";
import { revealCurrentJourneyStoryOptions } from "./support/journey_story.js";

const WORLD = loadOverworldManifest(process.cwd());
const REGISTRATION = WORLD.opening_registration!;
const RELIEF_OATH = WORLD.opening_relief_oath!;
const PREPARATION = WORLD.opening_preparation!;
const RELIEF_ALLOCATION = WORLD.opening_relief_allocation!;
const ALLY = WORLD.opening_ally!;
const WOLF = WORLD.quests.find((quest) => quest.id === "wolf_winter")!;
const WOLF_YAML = readFileSync(resolve(process.cwd(), WOLF.source), "utf8");
const APPROACH_ID = "albany:wolf_approach_exposed_ridge";

function moveToArea(session: OverworldSession, targetAreaId: string): void {
  const currentAreaId = session.view().currentArea?.id;
  if (!currentAreaId || currentAreaId === targetAreaId) return;
  const edges = WORLD.area_edges.filter((edge) => edge.home === session.view().current.id);
  const queue = [currentAreaId];
  const previous = new Map<string, string>();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    if (current === targetAreaId) break;
    for (const edge of edges.filter(
      (candidate) => candidate.from_area === current || candidate.to_area === current,
    )) {
      const next = edge.from_area === current ? edge.to_area : edge.from_area;
      if (next === currentAreaId || previous.has(next)) continue;
      previous.set(next, current);
      queue.push(next);
    }
  }
  const path: string[] = [];
  for (let cursor = targetAreaId; cursor !== currentAreaId; ) {
    const prior = previous.get(cursor);
    if (!prior) throw new Error(`No area route to ${targetAreaId}.`);
    path.unshift(cursor);
    cursor = prior;
  }
  for (const areaId of path) {
    const route = session.view().areaExits.find((candidate) => candidate.destination.id === areaId);
    if (!route) throw new Error(`Area route to ${areaId} is not visible.`);
    session.moveArea(route.id);
  }
}

function preparedDispatch(args: {
  registrationId: string;
  sourceId: string;
  preparationId: string;
  allyId: string;
}): OverworldSession {
  const session = new OverworldSession(WORLD);
  session.scoutPoi(session.view().pois[0]!.id);
  session.talkToCharacter(REGISTRATION.contact);
  session.chooseJourneyStory(args.registrationId);
  revealCurrentJourneyStoryOptions(session, RELIEF_OATH.id);
  session.chooseJourneyStory(RELIEF_OATH.options[0]!.id);
  session.chooseJourneyStory(args.sourceId);
  moveToArea(session, PREPARATION.area);
  session.chooseJourneyStory(args.preparationId);
  session.chooseJourneyStory(RELIEF_ALLOCATION.options[0]!.id);
  session.talkToCharacter(ALLY.contact);
  session.chooseJourneyStory(args.allyId);
  return session;
}

function delayedDispatchSession(): OverworldSession {
  return preparedDispatch({
    registrationId: "albany:ironhands_repairer",
    sourceId: "albany:source_hayden_frost_report",
    preparationId: "albany:prep_relief_protocol",
    allyId: "albany:ally_travel_solo",
  });
}

function onTimeDispatchSession(): OverworldSession {
  return preparedDispatch({
    registrationId: "albany:ledger_advocate",
    sourceId: "albany:source_jamie_market_testimony",
    preparationId: "albany:prep_relief_protocol",
    allyId: "albany:ally_travel_solo",
  });
}

describe("embedded launch overlay parity across interfaces", () => {
  // bug_0644: the receipt used to embed the launching surface's session handle
  // (MCP `o-<uuid>`, "cli-journey", "ui-journey"), and it lives in GameState, so the
  // same launch hashed differently per MCP run and per interface. Two independent
  // MCP launches (two random handles), the terminal journey and the browser must
  // now open byte-identical children.
  it("opens the same delayed-dispatch child state hash on MCP, CLI and web UI", () => {
    const seed = 11;
    const mcpChild = () => {
      const api = createToolApi({ root: process.cwd() });
      const restored = api.restore_overworld_session({
        snapshot: delayedDispatchSession().snapshot(),
        compact_context: false,
      }) as unknown as { session_id: string };
      const launched = api.start_overworld_session_quest({
        session_id: restored.session_id,
        quest_id: "wolf_winter",
        approach_id: APPROACH_ID,
        seed,
        compact_context: false,
        compact_result: false,
      }) as unknown as { rpg_session_id: string };
      const child = api.sessions.get(launched.rpg_session_id);
      expect(child.overworldSessionId).toBe(restored.session_id);
      return child;
    };
    const firstMcp = mcpChild();
    const secondMcp = mcpChild();
    expect(firstMcp.overworldSessionId).not.toBe(secondMcp.overworldSessionId);

    const journey = CliJourneySession.fromParent(process.cwd(), WORLD, delayedDispatchSession());
    journey.beginQuest("wolf_winter", seed, APPROACH_ID);
    const cliChild = journey.child()!;

    const plan = delayedDispatchSession().prepareQuestStart("wolf_winter", APPROACH_ID);
    const ui = GameSession.startEmbedded(
      WOLF_YAML,
      plan.characterAfter,
      WOLF.campaign_imports,
      seed,
      embeddedLaunchOverlayForPlan(plan),
    );

    expect(firstMcp.state.flags[WOLF_WINTER_DISPATCH_DELAY_FLAG]).toBe(true);
    expect(firstMcp.state.embeddedLaunchOverlayReceipt).toMatchObject({
      version: EMBEDDED_LAUNCH_OVERLAY_RECEIPT_VERSION,
    });
    expect(firstMcp.state.embeddedLaunchOverlayReceipt).not.toHaveProperty("overworld_session_id");
    expect(secondMcp.state).toEqual(firstMcp.state);
    expect(cliChild.state).toEqual(firstMcp.state);
    for (const stateHash of [secondMcp.stateHash, cliChild.stateHash, ui.view().stateHash]) {
      expect(stateHash).toBe(firstMcp.stateHash);
    }
  });

  it("CLI journey applies the delayed-dispatch overlay the MCP bridge derives", () => {
    // A separate, identically-built session derives the expected receipt so
    // the journey under test performs the only prepare/commit on its parent.
    const expectedReceipt = embeddedLaunchOverlayForPlan(
      delayedDispatchSession().prepareQuestStart("wolf_winter", APPROACH_ID),
    )?.receipt;
    expect(expectedReceipt).toBeDefined();

    const journey = CliJourneySession.fromParent(process.cwd(), WORLD, delayedDispatchSession());
    journey.beginQuest("wolf_winter", 11, APPROACH_ID);
    const child = journey.child();
    expect(child).not.toBeNull();
    expect(child!.state.flags[WOLF_WINTER_DISPATCH_DELAY_FLAG]).toBe(true);
    expect(child!.state.embeddedLaunchOverlayReceipt).toEqual(expectedReceipt);
  });

  it("CLI journey keeps an on-time launch overlay-free", () => {
    const journey = CliJourneySession.fromParent(process.cwd(), WORLD, onTimeDispatchSession());
    journey.beginQuest("wolf_winter", 11, APPROACH_ID);
    const child = journey.child();
    expect(child).not.toBeNull();
    expect(child!.state.flags[WOLF_WINTER_DISPATCH_DELAY_FLAG]).toBeUndefined();
    expect(child!.state.embeddedLaunchOverlayReceipt).toBeUndefined();
  });

  it("CLI save/restore round-trips an overlaid child through replay-from-fresh", () => {
    const journey = CliJourneySession.fromParent(process.cwd(), WORLD, delayedDispatchSession());
    journey.beginQuest("wolf_winter", 11, APPROACH_ID);
    const beforeHash = journey.child()!.stateHash;

    const restored = CliJourneySession.restore(
      process.cwd(),
      WORLD,
      JSON.parse(journey.serialize()),
    );
    const child = restored.child();
    expect(child).not.toBeNull();
    expect(child!.stateHash).toBe(beforeHash);
    expect(child!.state.flags[WOLF_WINTER_DISPATCH_DELAY_FLAG]).toBe(true);
  });

  it("web UI start applies the same overlay and its save restores byte-identically", () => {
    const parent = delayedDispatchSession();
    const plan = parent.prepareQuestStart("wolf_winter", APPROACH_ID);
    const launchOverlay = embeddedLaunchOverlayForPlan(plan);
    expect(launchOverlay).toBeDefined();

    const session = GameSession.startEmbedded(
      WOLF_YAML,
      plan.characterAfter,
      WOLF.campaign_imports,
      1,
      launchOverlay,
    );
    const view = session.view();
    expect(view.publicState.flags).toContain(WOLF_WINTER_DISPATCH_DELAY_FLAG);

    const saved = session.saveEmbedded("wolf_winter");
    const restored = GameSession.restoreEmbedded(
      WOLF_YAML,
      "wolf_winter",
      plan.characterAfter,
      WOLF.campaign_imports,
      1,
      [],
      saved,
    );
    expect(restored.session.view().stateHash).toBe(view.stateHash);
    expect(restored.session.view().publicState.flags).toContain(WOLF_WINTER_DISPATCH_DELAY_FLAG);
  });
});
