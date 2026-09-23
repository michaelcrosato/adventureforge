/**
 * Version-bump guard for the compact-payload legends (the blind-agent contract).
 *
 * The compact contexts are positional — [town_id, name, region, ...] — so a blind
 * playtester can only decode them through the initial `legend` plus same-response
 * `legend_delta` patches. Two invariants keep that contract honest:
 *
 *   1. Every key the compact encoders emit must have a legend entry, so adding a
 *      new positional field without documenting it fails here (the `satisfies`
 *      clauses on the legends enforce the same at compile time).
 *   2. A definition arrives no later than the first compact response that uses it.
 *   3. Every registered MCP tool must carry a real description — terse
 *      abbreviations ("Start OW.") regress the interface to unreadable.
 */
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createToolApi } from "../../src/mcp/tools.js";
import {
  compactOverworldOpportunityExplanation,
  compactOverworldQuestCompletionResultLegendKeys,
  OVERWORLD_COMPACT_RESULT_LEGEND,
  OVERWORLD_COMPACT_RESULT_LEGEND_KEYS,
} from "../../src/mcp/compact_overworld_result.js";
import { OverworldMcpSessionStore } from "../../src/mcp/overworld_sessions.js";
import { TOOL_REGISTRATIONS } from "../../src/mcp/server.js";
import {
  OVERWORLD_COMPACT_LEGEND,
  OVERWORLD_COMPACT_VIEW_VERSION,
} from "../../src/world/compact_view.js";
import { loadOverworldManifest } from "../../src/world/source.js";
import { RPG_COMPACT_LEGEND } from "../../src/mcp/compact_rpg_observation.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The exact published MCP tool surface. `TOOL_REGISTRATIONS` is exported so tests
 * can pin it; pinning the names (not just a count) is what makes an accidental
 * rename or removal readable in the failure diff.
 */
const EXPECTED_TOOL_SURFACE = [
  "apply_content_patch",
  "care_overworld_session",
  "choose_overworld_session_journey",
  "choose_overworld_session_story",
  "complete_overworld_session_quest",
  "explain_overworld_session_opportunity",
  "explore_overworld_session_area",
  "explore_overworld_session_site",
  "export_overworld_session",
  "follow_overworld_session_goal",
  "generate_rpg_pack",
  "get_observation",
  "get_overworld_session",
  "get_overworld_session_context",
  "get_state",
  "get_transcript",
  "inspect_overworld_session_story",
  "inspect_trace",
  "investigate_overworld_session_event",
  "list_legal_actions",
  "list_overworld",
  "load_game",
  "load_quest",
  "move_overworld_session_area",
  "new_game",
  "plan_overworld_session_route",
  "replay_trace",
  "resolve_overworld_session_event",
  "resolve_overworld_session_road_encounter",
  "rest_overworld_session",
  "restore_overworld_session",
  "resupply_overworld_session",
  "save_game",
  "scout_overworld_session_poi",
  "start_overworld",
  "start_overworld_session_quest",
  "start_world_quest",
  "step_action",
  "talk_overworld_session_contact",
  "travel_overworld_session",
  "validate_quest",
  "work_overworld_session_job",
] as const;

function api() {
  return createToolApi({ root: ROOT });
}

function expectedLegendFor(context: Record<string, unknown>): Record<string, string> {
  const contextKeys = new Set(Object.keys(context));
  return Object.fromEntries(
    Object.entries(OVERWORLD_COMPACT_LEGEND).filter(([key]) => contextKeys.has(key)),
  );
}

function expectLegendCovers(legend: Record<string, string>, context: Record<string, unknown>) {
  const legendKeys = new Set(Object.keys(legend));
  for (const key of Object.keys(context)) {
    expect(legendKeys, `compact context key "${key}" has no legend entry`).toContain(key);
  }
}

describe("compact legends", () => {
  it("pins each overworld positional schema signature to an explicit version", () => {
    const expectedSignatureByVersion = {
      40: "33b1acb50ded446f991f6022dbacd78786587cab50ee844246a23fdd3ec6a304",
      41: "f1d75c0180777aee89afc0a66deeb3c9cb5cb7ecd01f781595c3fbe3627d8ecd",
      42: "1abe68a5ddd649e8395076e742ec23e1b74d8aafd1b6bdc252d5141f09778ade",
      43: "8781a5bab9c143dceec4dd6f64eea9bfd600a909bc4a7472862d849d00693ac7",
      44: "9877e73471b10cda5e10af871b621c731fff97a935984f46ac312470bc081d53",
      45: "9877e73471b10cda5e10af871b621c731fff97a935984f46ac312470bc081d53",
      46: "b93524fb7e965a094bf2dfb1909f901c339e8fcd1018ee5dccaeb072c82e2ac5",
      47: "04e4a1a44b2ce7e3131a09e143add5fd5b599502715f901758da3ca681ccc1e6",
      48: "8c7f281cab4e663cc1fc0fac73d0af68e26499ff5bf67bfb63a7a74b240aa838",
      49: "ff1e6f0fa60641609dacce89ea162da62ead7952dd1c27818ba78452c033487d",
      // v50 re-signed on 2026-08-28: the RESULT legend gained the six exact paths a
      // compact result was already emitting undefined — `result.m` (in-game minutes,
      // on five different result shapes), `result.at`, `result.known`, area travel's
      // `result.route` (which previously collided with the bare five-tuple `route`),
      // and the two positional `explanation.*` tuples. No positional schema changed,
      // so v50 still decodes exactly as before; only definitions were added.
      50: "1aa9defdcc42f3410b0205f0163b42852c7db25a8c8fc0b5457247db04dffcf1",
      // v51 adds job_leads: a discovered, POI-scouted, contact-talked job whose own
      // SCENE-level quest/event prerequisite is unmet now names it by title instead of
      // vanishing into `hidden`'s job count (bug_0625). No existing field's shape changed.
      51: "45c87bd0a920361c6b811a9aa1bd383e48c58efd02087947c898bbec318d4322",
    } as const;
    const signature = createHash("sha256")
      .update(
        JSON.stringify({
          context: OVERWORLD_COMPACT_LEGEND,
          result: OVERWORLD_COMPACT_RESULT_LEGEND,
        }),
      )
      .digest("hex");

    expect(OVERWORLD_COMPACT_VIEW_VERSION).toBe(51);
    expect(signature).toBe(expectedSignatureByVersion[OVERWORLD_COMPACT_VIEW_VERSION]);
  });

  it("start_overworld sends only the definitions used by its compact context", () => {
    const a = api();
    const started = a.start_overworld();

    expect(started.legend).toEqual(expectedLegendFor(started.context as Record<string, unknown>));
    expectLegendCovers(started.legend!, started.context as Record<string, unknown>);
    expect(Object.keys(started.legend!)).toHaveLength(14);
    expect(JSON.stringify(started.legend).length).toBeLessThanOrEqual(3_100);
    expect(JSON.stringify(started.legend).length).toBeLessThan(
      JSON.stringify(OVERWORLD_COMPACT_LEGEND).length * 0.3,
    );
    expect(JSON.stringify(started).indexOf('"legend"')).toBeLessThan(
      JSON.stringify(started).indexOf('"context"'),
    );
    for (const [key, text] of Object.entries(started.legend!)) {
      expect(typeof text, `legend entry "${key}"`).toBe("string");
      expect(text.length, `legend entry "${key}"`).toBeGreaterThan(10);
    }
    expect(started.legend).not.toHaveProperty("quests");
    expect(started.legend).not.toHaveProperty("quest_starts");

    expect(OVERWORLD_COMPACT_LEGEND.quest_starts).toContain("start_overworld_session_quest");
    expect(OVERWORLD_COMPACT_LEGEND.quest_starts).toContain("approach_id");
    expect(OVERWORLD_COMPACT_LEGEND.quest_start_locations).toContain("location requirement");
    expect(OVERWORLD_COMPACT_LEGEND.quest_start_locations).toContain("advisory only");
    expect(OVERWORLD_COMPACT_LEGEND.quest_start_locations).toContain("area_routes");
    expect(OVERWORLD_COMPACT_LEGEND.quest_start_locations).toContain("quest_starts");
    expect(OVERWORLD_COMPACT_LEGEND.quests).toContain("preview|null");
    expect(OVERWORLD_COMPACT_LEGEND.quests).toContain("quest_starts");
    expect(OVERWORLD_COMPACT_LEGEND.quests).toContain("strategic_comparison");
    expect(OVERWORLD_COMPACT_LEGEND.quests).toContain("replaces duplicate preview text");
    expect(OVERWORLD_COMPACT_LEGEND.quests).toContain("keep preview and consequence");
    expect(OVERWORLD_COMPACT_LEGEND.quests).toContain("accepted result and journal");
    expect(OVERWORLD_COMPACT_LEGEND.quests).toContain("Started quest rows omit launch");
    expect(OVERWORLD_COMPACT_LEGEND.quests).toContain("starting them again is illegal");
    expect(OVERWORLD_COMPACT_LEGEND.quests).toContain("selected terms");
  });

  it("describes unavailable jobs and optional aftermath without overstating either", () => {
    expect(OVERWORLD_COMPACT_LEGEND.hidden).toContain(
      "undiscovered jobs plus discovered, incomplete authored job scenes",
    );
    expect(OVERWORLD_COMPACT_LEGEND.hidden).toContain("no legal options currently available");
    expect(OVERWORLD_COMPACT_LEGEND.hidden).not.toContain("counts still undiscovered");

    // job_leads names the SCENE-level subset of `hidden`'s job count — a discovered,
    // scouted, talked-to job whose own quest/event prerequisite is unmet — so it is not
    // silently unexplained; the option-level subset stays inside `hidden` alone.
    expect(OVERWORLD_COMPACT_LEGEND.job_leads).toContain("scouted POI and talked contact");
    expect(OVERWORLD_COMPACT_LEGEND.job_leads).toContain("unmet quest/event prerequisite");
    expect(OVERWORLD_COMPACT_LEGEND.job_leads).toContain("blocked_reason names it");
    expect(OVERWORLD_COMPACT_LEGEND.job_leads).toContain("Not workable yet");

    expect(OVERWORLD_COMPACT_LEGEND.opportunity_leads).toContain(
      "do not create, replace, or activate a journey objective",
    );
    expect(OVERWORLD_COMPACT_LEGEND.opportunity_leads).toContain(
      "no choices, rewards, or outcomes are disclosed",
    );
    expect(OVERWORLD_COMPACT_LEGEND.opportunity_leads).not.toContain(
      "journey objective remains available",
    );
    expect(OVERWORLD_COMPACT_LEGEND.opportunity_guidance).toContain(
      "temporarily deferred at a journey decision boundary",
    );
    expect(OVERWORLD_COMPACT_LEGEND.opportunity_leads_deferred).toContain(
      "after the current journey decision",
    );
    expect(OVERWORLD_COMPACT_LEGEND.opportunity_leads_deferred).toContain(
      "opportunity_leads is omitted",
    );
    expect(OVERWORLD_COMPACT_LEGEND.opportunity_leads_truncated).not.toContain("deferred");

    expect(OVERWORLD_COMPACT_LEGEND.service_actions).toContain("resupply_overworld_session");
    expect(OVERWORLD_COMPACT_LEGEND.service_actions).toContain("rest_overworld_session");
    expect(OVERWORLD_COMPACT_LEGEND.service_actions).toContain("care_overworld_session");
    expect(OVERWORLD_COMPACT_LEGEND.service_actions).toContain("available");
    expect(OVERWORLD_COMPACT_LEGEND.service_actions).toContain("blocked_reason");
    expect(OVERWORLD_COMPACT_LEGEND.service_actions).toContain("campaign_override");
    expect(OVERWORLD_COMPACT_LEGEND.service_offers).toContain(
      "informational and deferred while service_actions is absent",
    );
    expect(OVERWORLD_COMPACT_LEGEND.service_offers).toContain("present and available");

    expect(OVERWORLD_COMPACT_LEGEND.departure_contact_leads).toContain(
      "before or after field kit (preparation) or relief wagon (relief_allocation)",
    );
    expect(OVERWORLD_COMPACT_LEGEND.departure_contact_leads).toContain(
      "legacy requires_preparation has no available action",
    );
    const stationSlotMap =
      "role=background; duty=Wolf-Winter promise; evidence=report; preparation=field kit; relief_allocation=relief wagon; field_team=second rider";
    expect(OVERWORLD_COMPACT_LEGEND.departure_recap).toContain(stationSlotMap);
    const compactStationSlotMap =
      "role/duty/evidence/preparation/relief_allocation/field_team=background/promise/report/kit/wagon/rider";
    expect(OVERWORLD_COMPACT_LEGEND.station_dispatch_board).toContain(compactStationSlotMap);
    expect(OVERWORLD_COMPACT_LEGEND.departure_recap_terms).toContain(compactStationSlotMap);
    expect(OVERWORLD_COMPACT_LEGEND.station_dispatch_support).toContain(
      "preparation=field kit, relief_allocation=relief wagon, field_team=second rider",
    );
    expect(OVERWORLD_COMPACT_LEGEND.departure_interactions).toContain(
      "Field-kit (preparation), relief-wagon (relief_allocation), and second-rider (ally/field_team)",
    );
    expect(OVERWORLD_COMPACT_LEGEND.departure_recap).toContain("independent optional choices");
    expect(OVERWORLD_COMPACT_LEGEND.departure_recap).toContain(
      "omits redundant open_optional rows",
    );
    expect(OVERWORLD_COMPACT_LEGEND.departure_recap).toContain("in any order or skipped at launch");
    expect(OVERWORLD_COMPACT_LEGEND.departure_recap).toContain(
      "available_after_preparation remain legacy sequential values",
    );
  });

  it("introduces context and result-only definitions once in the response that needs them", () => {
    const a = api();
    const started = a.start_overworld();
    const poiId = started.context.poi[0]?.[0];
    if (!poiId) throw new Error("expected a fresh Albany point of interest");
    const scouted = a.scout_overworld_session_poi({
      session_id: started.session_id,
      poi_id: poiId,
      expected_snapshot_hash: started.snapshot_hash,
    });
    expect(scouted.ok).toBe(true);
    if (!scouted.ok) throw new Error("expected scout to succeed");
    expect(Object.keys(scouted.legend_delta ?? {})).toEqual([
      "area_routes",
      "sites",
      "journal",
      "result.entry",
      "result.areas",
      "result.jobs",
      "result.sites",
      "result.m",
    ]);
    expectLegendCovers(
      { ...started.legend, ...scouted.legend_delta } as Record<string, string>,
      scouted.context as Record<string, unknown>,
    );
    expect(JSON.stringify(scouted.legend_delta).length).toBeLessThanOrEqual(850);
    expect(JSON.stringify(scouted).indexOf('"legend_delta"')).toBeLessThan(
      JSON.stringify(scouted).indexOf('"context"'),
    );

    const repeated = a.get_overworld_session_context({ session_id: started.session_id });
    expect(repeated).not.toHaveProperty("legend_delta");

    const routeDestination = scouted.context.roads[0]?.[0];
    if (!routeDestination) throw new Error("expected a route destination");
    const planned = a.plan_overworld_session_route({
      session_id: started.session_id,
      destination_town_id: routeDestination,
      expected_snapshot_hash: scouted.snapshot_hash,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error("expected route plan to succeed");
    expect(planned.context).not.toHaveProperty("route_options");
    expect(planned.legend_delta).toEqual({
      route: OVERWORLD_COMPACT_RESULT_LEGEND.route,
    });
    const serializedPlan = JSON.stringify(planned);
    expect(serializedPlan.indexOf('"legend_delta"')).toBeLessThan(
      serializedPlan.indexOf('"route":['),
    );
    expect(serializedPlan.indexOf('"legend_delta"')).toBeLessThan(
      serializedPlan.indexOf('"context"'),
    );
    const plannedAgain = a.plan_overworld_session_route({
      session_id: started.session_id,
      destination_town_id: routeDestination,
      expected_snapshot_hash: planned.snapshot_hash,
    });
    expect(plannedAgain.ok).toBe(true);
    if (!plannedAgain.ok) throw new Error("expected repeated route plan to succeed");
    expect(plannedAgain).not.toHaveProperty("legend_delta");
  });

  it("defines transient discovery result tuples even when rolling context filters them out", () => {
    const a = api();
    const started = a.start_overworld();
    const areaId = started.context.here[3];
    if (!areaId) throw new Error("expected a fresh Albany starting area");

    const explored = a.explore_overworld_session_area({
      session_id: started.session_id,
      area_id: areaId,
      expected_snapshot_hash: started.snapshot_hash,
    });
    expect(explored.ok).toBe(true);
    if (!explored.ok) throw new Error("expected starting-area exploration to succeed");
    expect(explored.result.jobs?.length).toBeGreaterThan(0);
    expect(explored.context).not.toHaveProperty("jobs");
    const accumulated = {
      ...started.legend,
      ...explored.legend_delta,
    } as Record<string, string>;
    for (const resultKey of ["entry", "jobs"] as const) {
      const legendKey = `result.${resultKey}`;
      expect(accumulated, `compact result key "${resultKey}"`).toHaveProperty(legendKey);
    }
    const serialized = JSON.stringify(explored);
    expect(serialized.indexOf('"legend_delta"')).toBeLessThan(serialized.indexOf('"result"'));
    expect(serialized.indexOf('"legend_delta"')).toBeLessThan(serialized.indexOf('"context"'));
  });

  it("defines a compact result when it is paired with a full observation", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    const destination = started.observation.exits[0]?.destination.id;
    if (!destination) throw new Error("expected a fresh Albany road");

    const planned = a.plan_overworld_session_route({
      session_id: started.session_id,
      destination_town_id: destination,
      compact_context: false,
      compact_result: true,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error("expected mixed-mode route plan to succeed");
    expect(planned.legend_delta).toEqual({
      route: OVERWORLD_COMPACT_RESULT_LEGEND.route,
    });
    expect(planned).toHaveProperty("observation");
    const serialized = JSON.stringify(planned);
    expect(serialized.indexOf('"legend_delta"')).toBeLessThan(serialized.indexOf('"route":['));
    expect(serialized.indexOf('"legend_delta"')).toBeLessThan(serialized.indexOf('"observation"'));
  });

  it("defines service resource tuples even when an unchanged service has no receipt", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    const rested = a.rest_overworld_session({
      session_id: started.session_id,
      compact_context: false,
      compact_result: true,
    });
    expect(rested.ok).toBe(true);
    if (!rested.ok) throw new Error("expected mixed-mode rest to succeed");
    expect(rested.result.entry).toBeUndefined();
    expect(rested.legend_delta).toEqual({
      "result.supplies": OVERWORLD_COMPACT_RESULT_LEGEND["result.supplies"],
      "result.fatigue": OVERWORLD_COMPACT_RESULT_LEGEND["result.fatigue"],
      "result.m": OVERWORLD_COMPACT_RESULT_LEGEND["result.m"],
    });
    const serialized = JSON.stringify(rested);
    expect(serialized.indexOf('"legend_delta"')).toBeLessThan(serialized.indexOf('"result":{'));
  });

  it("defines a consumed road encounter in the compact resolution result", () => {
    const a = api();
    const started = a.start_overworld({ compact_context: false });
    const road = started.observation.exits.find(
      (candidate) => candidate.destination.id === "colonie_town",
    );
    if (!road) throw new Error("expected the Albany-to-Colonie road");
    const traveled = a.travel_overworld_session({
      session_id: started.session_id,
      road_id: road.id,
      compact_context: false,
      compact_result: false,
    });
    expect(traveled.ok).toBe(true);
    if (!traveled.ok) throw new Error("expected verbose travel to succeed");

    const resolved = a.resolve_overworld_session_road_encounter({
      session_id: started.session_id,
      strategy: "cautious_scout",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("expected compact road resolution to succeed");
    expect(resolved.context).not.toHaveProperty("pending_road");
    expect(resolved.result.encounter).toBeDefined();
    expect(resolved.legend_delta).toMatchObject({
      "result.entry": OVERWORLD_COMPACT_RESULT_LEGEND["result.entry"],
      "result.encounter": OVERWORLD_COMPACT_RESULT_LEGEND["result.encounter"],
    });
    const serialized = JSON.stringify(resolved);
    expect(serialized.indexOf('"legend_delta"')).toBeLessThan(serialized.indexOf('"result"'));
    expect(serialized.indexOf('"legend_delta"')).toBeLessThan(serialized.indexOf('"context"'));
  });

  it("declares result-only quest schemas centrally", () => {
    expect(OVERWORLD_COMPACT_RESULT_LEGEND_KEYS.quest_start).toEqual(["quest"]);
    // Completion carries `known` only for a foldback that was already recorded, so
    // its disclosure list is computed from the emitted result rather than fixed.
    expect(
      compactOverworldQuestCompletionResultLegendKeys({
        m: 45,
        quest: ["q", "Q", "area"],
        ending: ["e", "E"],
        renown: ["region", 1, 2],
        entry: ["quest", "Q", "Day 1, 08:00"],
        text: "done",
      }),
    ).toEqual(["result.entry", "result.quest", "result.ending", "result.renown", "result.m"]);
    expect(
      compactOverworldQuestCompletionResultLegendKeys({
        m: 45,
        known: true,
        quest: ["q", "Q", "area"],
        ending: ["e", "E"],
        renown: ["region", 1, 2],
        entry: ["quest", "Q", "Day 1, 08:00"],
        text: "done",
      }),
    ).toContain("result.known");
    for (const keys of Object.values(OVERWORLD_COMPACT_RESULT_LEGEND_KEYS)) {
      for (const key of keys) {
        expect(OVERWORLD_COMPACT_RESULT_LEGEND, `compact result path "${key}"`).toHaveProperty(key);
      }
    }
  });

  /**
   * `route` is the one key in either legend that names two different shapes.
   * plan_overworld_session_route's bare `route` is a five-tuple
   * [town, minutes, supplies, fatigue, [road_id, ...]]; an area-travel result's
   * `route` is a plain road name. A blind agent following the documented rule
   * ("merge legend_delta patches by exact field") therefore decoded a label
   * string against a tuple definition. The exact path is what disambiguates it.
   */
  it("defines area travel's own route label, minutes, and arrival clock", () => {
    const a = api();
    const started = a.start_overworld();
    const areaId = started.context.here[3];
    if (!areaId) throw new Error("expected a fresh Albany starting area");
    const explored = a.explore_overworld_session_area({
      session_id: started.session_id,
      area_id: areaId,
      expected_snapshot_hash: started.snapshot_hash,
    });
    expect(explored.ok).toBe(true);
    if (!explored.ok) throw new Error("expected starting-area exploration to succeed");
    const areaRouteId = explored.context.area_routes?.[0]?.[0];
    if (!areaRouteId) throw new Error("expected a discovered Albany area route");

    const moved = a.move_overworld_session_area({
      session_id: started.session_id,
      area_route_id: areaRouteId,
      expected_snapshot_hash: explored.snapshot_hash,
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) throw new Error("expected area travel to succeed");
    expect(typeof moved.result.route).toBe("string");
    expect(typeof moved.result.m).toBe("number");
    expect(typeof moved.result.at).toBe("string");

    const accumulated = {
      ...started.legend,
      ...explored.legend_delta,
      ...moved.legend_delta,
    } as Record<string, string>;
    for (const key of ["result.route", "result.m", "result.at"] as const) {
      expect(accumulated[key], `area travel field "${key}"`).toBe(
        OVERWORLD_COMPACT_RESULT_LEGEND[key],
      );
    }
    // The two definitions must stay distinguishable, or the exact path buys nothing.
    expect(OVERWORLD_COMPACT_RESULT_LEGEND["result.route"]).not.toBe(
      OVERWORLD_COMPACT_RESULT_LEGEND.route,
    );
  });

  it("defines the positional tuples an opportunity explanation ships", () => {
    expect(OVERWORLD_COMPACT_RESULT_LEGEND_KEYS.opportunity_explanation).toEqual([
      "explanation.lead",
      "explanation.next_action",
    ]);
    const compact = compactOverworldOpportunityExplanation({
      lead: {
        id: "albany_city__civic_core__event",
        kind: "event",
        title: "Albany Civic Center: charter backlog",
        area: "Albany Civic Center",
        access: "here",
      },
      nextAction: {
        tool: "explore_overworld_session_area",
        arguments: { area_id: "albany_city__civic_core" },
        command: "explore albany_city__civic_core",
        label: "Explore Albany Civic Center",
      },
    });
    // Both fields are positional tuples, so neither can rely on its name.
    for (const field of Object.keys(compact)) {
      expect(Array.isArray((compact as Record<string, unknown>)[field])).toBe(true);
      expect(
        OVERWORLD_COMPACT_RESULT_LEGEND,
        `compact explanation field "${field}"`,
      ).toHaveProperty(`explanation.${field}`);
    }
  });

  it("introduces opt-in projection definitions once without changing game state", () => {
    const a = api();
    const started = a.start_overworld();
    const worldNamed = a.get_overworld_session_context({
      session_id: started.session_id,
      include_world_name: true,
    });
    expect(worldNamed.legend_delta).toEqual({ world: OVERWORLD_COMPACT_LEGEND.world });
    expect(worldNamed.snapshot_hash).toBe(started.snapshot_hash);

    const ids = a.get_overworld_session_context({
      session_id: started.session_id,
      include_ids: true,
    });
    expect(ids.legend_delta).toEqual({ ids: OVERWORLD_COMPACT_LEGEND.ids });
    expect(ids.snapshot_hash).toBe(started.snapshot_hash);

    const routes = a.get_overworld_session_context({
      session_id: started.session_id,
      include_route_options: true,
    });
    expect(routes.legend_delta).toEqual({
      route_options: OVERWORLD_COMPACT_LEGEND.route_options,
    });
    expect(routes.snapshot_hash).toBe(started.snapshot_hash);

    const repeated = a.get_overworld_session_context({
      session_id: started.session_id,
      include_world_name: true,
      include_ids: true,
      include_route_options: true,
    });
    expect(repeated).not.toHaveProperty("legend_delta");
    expect(repeated.snapshot_hash).toBe(started.snapshot_hash);
  });

  it("restore and the first compact read each create a self-contained disclosure boundary", () => {
    const a = api();
    const started = a.start_overworld();
    const exported = a.export_overworld_session({ session_id: started.session_id });
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error("expected export to succeed");

    const restored = a.restore_overworld_session({ snapshot: exported.snapshot });
    expect(restored.legend).toEqual(expectedLegendFor(restored.context as Record<string, unknown>));
    expect("tutorial" in restored).toBe(false);
    expectLegendCovers(restored.legend!, restored.context as Record<string, unknown>);
    const independentlyRestored = a.restore_overworld_session({ snapshot: exported.snapshot });
    expect(independentlyRestored.session_id).not.toBe(restored.session_id);
    expect(independentlyRestored.legend).toEqual(restored.legend);

    const reread = a.get_overworld_session_context({ session_id: started.session_id });
    expect("legend" in reread).toBe(false);
    expect("legend_delta" in reread).toBe(false);
    const rested = a.rest_overworld_session({ session_id: started.session_id });
    expect("legend" in rested).toBe(false);
    expect(rested.legend_delta).toEqual({
      "result.supplies": OVERWORLD_COMPACT_RESULT_LEGEND["result.supplies"],
      "result.fatigue": OVERWORLD_COMPACT_RESULT_LEGEND["result.fatigue"],
      "result.m": OVERWORLD_COMPACT_RESULT_LEGEND["result.m"],
    });

    const fullRestored = a.restore_overworld_session({
      snapshot: exported.snapshot,
      compact_context: false,
    });
    expect(fullRestored).not.toHaveProperty("legend");
    expect(fullRestored).not.toHaveProperty("legend_delta");
    const firstCompactRead = a.get_overworld_session_context({
      session_id: fullRestored.session_id,
    });
    expect(firstCompactRead.legend_delta).toEqual(
      expectedLegendFor(firstCompactRead.context as Record<string, unknown>),
    );
    expectLegendCovers(
      firstCompactRead.legend_delta!,
      firstCompactRead.context as Record<string, unknown>,
    );
  });

  it("unchanged and rejected responses do not consume pending definitions", () => {
    const a = api();
    const fullStarted = a.start_overworld({ compact_context: false });
    const unchanged = a.get_overworld_session_context({
      session_id: fullStarted.session_id,
      if_snapshot_hash: fullStarted.snapshot_hash,
    });
    expect(unchanged).not.toHaveProperty("context");
    expect(unchanged).not.toHaveProperty("legend_delta");

    const rejected = a.rest_overworld_session({
      session_id: fullStarted.session_id,
      expected_snapshot_hash: "0".repeat(24),
    });
    expect(rejected.ok).toBe(false);
    expect(rejected).not.toHaveProperty("legend_delta");

    const firstCompactRead = a.get_overworld_session_context({
      session_id: fullStarted.session_id,
    });
    expect(firstCompactRead.legend_delta).toEqual(
      expectedLegendFor(firstCompactRead.context as Record<string, unknown>),
    );
  });

  it("verbose actions do not consume definitions needed by a later compact response", () => {
    const a = api();
    const fullStarted = a.start_overworld({ compact_context: false });
    const poiId = fullStarted.observation.pois[0]?.id;
    if (!poiId) throw new Error("expected a fresh Albany point of interest");
    const fullScout = a.scout_overworld_session_poi({
      session_id: fullStarted.session_id,
      poi_id: poiId,
      expected_snapshot_hash: fullStarted.snapshot_hash,
      compact_context: false,
      compact_result: false,
    });
    expect(fullScout.ok).toBe(true);
    if (!fullScout.ok) throw new Error("expected verbose scout to succeed");
    expect(fullScout).not.toHaveProperty("legend");
    expect(fullScout).not.toHaveProperty("legend_delta");

    const firstCompactRead = a.get_overworld_session_context({
      session_id: fullStarted.session_id,
    });
    expect(firstCompactRead.legend_delta).toEqual(
      expectedLegendFor(firstCompactRead.context as Record<string, unknown>),
    );
    expect(firstCompactRead.legend_delta).toHaveProperty("area_routes");
    expect(firstCompactRead.legend_delta).toHaveProperty("sites");
    expect(firstCompactRead.legend_delta).toHaveProperty("journal");
  });

  it("fails closed if a runtime compact field lacks a legend definition", () => {
    const sessions = new OverworldMcpSessionStore(() => loadOverworldManifest(ROOT));
    const created = sessions.create();
    const context = created.session.compactView();
    vi.spyOn(created.session, "compactView").mockReturnValue({
      ...context,
      future_field: ["undocumented"],
    } as never);

    expect(() => sessions.viewField({ compact_context: true }, created.session)).toThrowError(
      /future_field.*no legend definition/i,
    );
  });

  it("RPG session starts carry a legend covering every compact observation key", () => {
    const a = api();
    const started = a.start_world_quest({
      world_quest_id: "sunken_barrow",
      seed: 1,
      include_actions: true,
      include_context_version: true,
    });

    expect(started.legend).toBe(RPG_COMPACT_LEGEND);
    const legendKeys = new Set(Object.keys(started.legend!));
    for (const key of Object.keys(started.context)) {
      expect(legendKeys, `compact observation key "${key}" has no legend entry`).toContain(key);
    }
    // The one-time legend also decodes the step_action event tuples.
    expect(started.legend!.events).toContain("step_action");
    expect(started.legend!.npcs).toContain("[npc_id, display_name]");
    expect(started.legend!.actions).toContain("more counts truncation");
    expect(started.legend!.actions).toContain("complete menu");
    expect(started.legend!.choices).toContain("authored_prompt");
    expect(started.legend!.choices).toContain("unchanged id from actions");
    expect(started.legend!.choices).toContain("other listed actions remain legal");
    expect(started.legend!.choices).toContain("leaving the room ends the exchange");

    const fresh = a.new_game({ generate_rpg_seed: 7 });
    expect(fresh.legend).toBe(RPG_COMPACT_LEGEND);

    const save = a.save_game({ session_id: started.session_id });
    expect(save.ok).toBe(true);
    if (!save.ok) throw new Error("expected save to succeed");
    const reloaded = a.load_game({ save: save.save });
    expect(reloaded.legend).toBe(RPG_COMPACT_LEGEND);

    // Per-step payloads stay lean: no legend outside session creation.
    const stepped = a.step_action({
      session_id: started.session_id,
      action_id: a.list_legal_actions({ session_id: started.session_id }).actions[0] as string,
    });
    expect("legend" in stepped).toBe(false);
    const observed = a.get_observation({ session_id: started.session_id });
    expect("legend" in observed).toBe(false);
  });

  /**
   * `compact_events` and `compact_observation` are PER-CALL flags that both default
   * to true, and the RPG surface has no legend_delta — the session-creating response
   * is its only carrier. Gating that carrier on the creating call's own
   * compact_observation flag therefore left a verbose start playing the rest of the
   * quest against tuples whose key was never sent.
   */
  it("defines the compact tuples a verbose RPG start still receives on its next step", () => {
    const a = api();
    const started = a.start_world_quest({
      world_quest_id: "sunken_barrow",
      seed: 1,
      compact_observation: false,
    });
    expect(started).toHaveProperty("observation");
    expect(started.legend).toBe(RPG_COMPACT_LEGEND);

    const stepped = a.step_action({
      session_id: started.session_id,
      action_id: a.list_legal_actions({ session_id: started.session_id }).actions[0] as string,
    });
    // Both halves of the next payload are positional despite the verbose start.
    const [firstEvent] = stepped.events as unknown[];
    expect(Array.isArray(firstEvent), "step_action events ship as tagged tuples").toBe(true);
    expect(stepped).toHaveProperty("context");
    const legendKeys = new Set(Object.keys(started.legend!));
    expect(legendKeys, "event tuples have no definition").toContain("events");
    for (const key of Object.keys((stepped as { context: Record<string, unknown> }).context)) {
      expect(legendKeys, `compact observation key "${key}" has no legend entry`).toContain(key);
    }
  });

  it("every registered MCP tool has an informative description", () => {
    const names = TOOL_REGISTRATIONS.map((registration) => registration.name);
    expect(new Set(names).size).toBe(names.length);
    for (const { name, description } of TOOL_REGISTRATIONS) {
      expect(description.length, `tool "${name}" description too terse`).toBeGreaterThanOrEqual(15);
      expect(description.trim(), `tool "${name}" description is blank`).not.toBe("");
    }
  });

  /**
   * This guard used to be `toBeGreaterThanOrEqual(35)`, which cannot fail on
   * either half of the drift it exists to catch: a floor stays green when a tool
   * is added AND when one is removed. The 2026-08 audit found README.md's group
   * breakdown listing 25 overworld tools for a group of 26 (so its four groups
   * summed to 42 against a 43-tool surface); the doc was corrected, this guard was
   * not, and the same group count drifted again. Pin the surface itself, so adding
   * or removing a tool fails here and the diff names it.
   *
   * If you are updating README.md's "**42 tools**" breakdown, the measured split is:
   * World catalog 1 + Overworld sessions 26 + RPG quest sessions and tooling 15.
   */
  it("registers exactly the published tool surface", () => {
    const names = TOOL_REGISTRATIONS.map((registration) => registration.name);
    expect([...names].sort()).toEqual([...EXPECTED_TOOL_SURFACE].sort());
    expect(names.length).toBe(42);

    // The one group whose count the README states and the audit found wrong. The
    // rule is objective — every session tool carries `overworld` in its name and
    // the catalog read is the single non-session one — so this cannot drift silently.
    const overworldGroup = names.filter(
      (name) => name.includes("overworld") && name !== "list_overworld",
    );
    expect(overworldGroup).toHaveLength(26);
    expect(names.filter((name) => name === "list_overworld")).toHaveLength(1);
  });
});
