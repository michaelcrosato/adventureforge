import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs module without type declarations
import { validPureMcpToolCatalogEntry } from "../../blind-tester/codex-pure-envelope.mjs";
import { MCP_ACTION_LABEL_CHAR_LIMIT } from "../../src/mcp/action_labels.js";
import {
  PURE_PLAYER_TOOLS,
  PURE_STATION_DISPATCH_REVEAL_VERSION,
  PURE_STATION_JUNE_CONTACT_ID,
  PURE_STATION_JUNE_MODAL_VERSION,
  resolveAreaMoveSelector,
  resolveVisibleAreaRouteId,
  toolAvailableInPlayMode,
  type PureOverworldContextWireResponse,
  type PureOverworldTalkWireResponse,
  type PureStationDispatchRevealResponseV1,
  type PureStationJuneModalResponseV1,
} from "../../src/mcp/server.js";
import type { OverworldMcpReadArgs } from "../../src/mcp/overworld_sessions.js";
import {
  JOURNEY_STORY_CHOICE_COMPARISON_VERSION,
  JOURNEY_STORY_CHOICE_REVIEW_INSTRUCTION,
} from "../../src/mcp/journey_projection.js";
import { OVERWORLD_COMPACT_RESULT_LEGEND } from "../../src/mcp/compact_overworld_result.js";
import {
  OVERWORLD_COMPACT_LEGEND,
  type OverworldCompactCampaignCharacter,
} from "../../src/world/compact_view.js";
import {
  STATION_DISPATCH_SUPPORT_REVEAL_ID,
  type OpeningCompactStationDispatchBoard,
  type OpeningCompactStationDispatchBoardSupport,
} from "../../src/world/station_dispatch_board.js";
import {
  INSPECT_OVERWORLD_SESSION_STORY_TOOL,
  OVERWORLD_DEPARTURE_CHOICE_VALUES_FROM,
} from "../../src/world/session_departure_interactions.js";

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MCP_SERVER = join(ROOT, "src", "mcp", "server.ts");
const TEST_RUN_SEED = 2731;
const TEST_BUILD_COMMIT = "b".repeat(40);
const CADE_HUNT_INSPECT_LABEL =
  "HUNT — Protect home and herd. Wolves may die; failure risks cattle. Cade's tactics and padded byre-jerkin help. Review. Go north or RELEASE JUNE to choose.";
const CADE_HUNT_INSPECT_COMMAND = `ask: ${CADE_HUNT_INSPECT_LABEL}`;
const ACTION_TRUNCATION_MARKER = /(?:\.\.\.\(\+\d+ chars\)|#[0-9a-f]{12}\b)/i;
const PARENT_BOUND_STORY_INSPECTION_DESCRIPTION =
  "Inspect a visible story choice without choosing it. Only reveal_id changes state.";

async function withPureServer<T>(
  evidencePath: string,
  body: (client: Client) => Promise<T>,
  runSeed = TEST_RUN_SEED,
  root = ROOT,
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      TSX,
      MCP_SERVER,
      "--play-mode",
      "pure",
      "--run-evidence",
      evidencePath,
      "--run-seed",
      String(runSeed),
      "--build-commit",
      TEST_BUILD_COMMIT,
      "--tracked-worktree-clean",
      "true",
    ],
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({ name: "pure-play-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}

async function withFullServer<T>(body: (client: Client) => Promise<T>, root = ROOT): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX, MCP_SERVER, "--play-mode", "full"],
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({ name: "full-play-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}

function textPayload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return JSON.parse(textResult(result)) as Record<string, unknown>;
}

function textResult(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text?: string }[];
  const first = content[0];
  if (!first || first.type !== "text") throw new Error("expected text tool result");
  return first.text ?? "";
}

function stringsContaining(value: unknown, needle: string): string[] {
  const matches: string[] = [];
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      if (candidate.includes(needle)) matches.push(candidate);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (candidate && typeof candidate === "object") {
      for (const entry of Object.values(candidate)) visit(entry);
    }
  };
  visit(value);
  return matches;
}

function mergeLegendAndExpectContextCoverage(
  accumulated: Record<string, string>,
  payload: Record<string, unknown>,
  label: string,
): void {
  Object.assign(accumulated, payload.legend, payload.legend_delta);
  const context = payload.context as Record<string, unknown> | undefined;
  if (!context) return;
  for (const key of Object.keys(context)) {
    expect(accumulated, `${label} compact field "${key}"`).toHaveProperty(key);
  }
}

function expectPureStoryInspectionEnvelope(
  payload: Record<string, unknown>,
  sessionId: string,
  expectedDepartureRecap?: unknown,
  expectsDepartureRecapTerms = false,
): void {
  expect(payload).toMatchObject({
    ok: true,
    session_id: sessionId,
    overworld_session_id: sessionId,
    snapshot_hash: expect.any(String),
    unchanged: true,
    story: expect.any(Object),
  });
  const expectedKeys = [
    "ok",
    "overworld_session_id",
    "session_id",
    "snapshot_hash",
    "story",
    "unchanged",
    ...(expectedDepartureRecap === undefined ? [] : ["departure_recap"]),
    ...(expectsDepartureRecapTerms ? ["departure_recap_terms", "legend_delta"] : []),
  ];
  expect(Object.keys(payload).sort()).toEqual(expectedKeys.sort());
  if (expectedDepartureRecap === undefined) {
    expect(payload).not.toHaveProperty("departure_recap");
  } else {
    expect(payload.departure_recap).toEqual(expectedDepartureRecap);
  }
  if (expectsDepartureRecapTerms) {
    expect(payload.departure_recap_terms).toEqual(expect.any(Array));
    expect(payload.legend_delta).toHaveProperty("departure_recap_terms");
  } else {
    expect(payload).not.toHaveProperty("departure_recap_terms");
  }
  expect(payload).not.toHaveProperty("journey");
  expect(payload).not.toHaveProperty("context");
  expect(payload).not.toHaveProperty("observation");
}

function expectAliasedToolSchema(
  listed: Awaited<ReturnType<Client["listTools"]>>,
  name: string,
  canonicalName: string,
  aliasName: string,
): void {
  const schema = listed.tools.find((tool) => tool.name === name)?.inputSchema;
  expect(schema, name).toBeDefined();
  expect(schema?.type, name).toBe("object");
  expect(schema?.properties, name).toHaveProperty(canonicalName);
  expect(schema?.properties, name).toHaveProperty(aliasName);
  const schemaWithGroups = schema as
    | {
        anyOf?: { required?: string[] }[];
        allOf?: { anyOf?: { required?: string[] }[] }[];
      }
    | undefined;
  const presenceOptions = [
    ...(schemaWithGroups?.anyOf ? [schemaWithGroups] : []),
    ...(schemaWithGroups?.allOf ?? []),
  ].find((part) => part.anyOf?.some((option) => option.required?.[0] === canonicalName))?.anyOf;
  expect(presenceOptions, name).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ required: [canonicalName] }),
      expect.objectContaining({ required: [aliasName] }),
    ]),
  );
}

function expectOneOfToolSchema(
  listed: Awaited<ReturnType<Client["listTools"]>>,
  name: string,
  argumentNames: readonly string[],
): void {
  const schema = listed.tools.find((tool) => tool.name === name)?.inputSchema;
  expect(schema, name).toBeDefined();
  expect(schema?.type, name).toBe("object");
  for (const argumentName of argumentNames) {
    expect(schema?.properties, name).toHaveProperty(argumentName);
  }
  expect(schema?.anyOf, name).toEqual(
    argumentNames.map((argumentName) => ({ required: [argumentName] })),
  );
}

function expectToolSchemaFields(
  listed: Awaited<ReturnType<Client["listTools"]>>,
  name: string,
  fieldNames: readonly string[],
): void {
  const schema = listed.tools.find((tool) => tool.name === name)?.inputSchema;
  expect(schema, name).toBeDefined();
  expect(schema?.type, name).toBe("object");
  for (const fieldName of fieldNames) {
    expect(schema?.properties, name).toHaveProperty(fieldName);
  }
}

async function callPlayerTool(
  client: Client,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: argumentsValue });
  const payload = textPayload(result);
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(payload)}`);
  return payload;
}

function compactAreaRoute(payload: Record<string, unknown>, destination: string): string {
  const context = payload.context as { area_routes?: [string, string, number][] };
  const route = context.area_routes?.find(
    ([, routeDestination]) => routeDestination === destination,
  );
  if (!route) throw new Error(`expected a visible area route to ${destination}`);
  return route[0];
}

async function movePlayerToOpeningPreparation(
  client: Client,
  parent: { session_id: string },
): Promise<Record<string, unknown>> {
  const context = await callPlayerTool(client, "get_overworld_session_context", parent);
  return callPlayerTool(client, "move_overworld_session_area", {
    ...parent,
    area_route_id: compactAreaRoute(context, "albany_city__transport_hub"),
  });
}

async function startPureAtOpeningStation(
  client: Client,
  sourceId = "albany:source_rowan_civic_docket",
): Promise<{
  sessionId: string;
  stationed: Record<string, unknown>;
}> {
  const started = await callPlayerTool(client, "start_overworld", {});
  const sessionId = String(started.session_id);
  const parent = { session_id: sessionId };
  await callPlayerTool(client, "scout_overworld_session_poi", {
    ...parent,
    poi_id: "albany_city__civic_core__poi",
  });
  await callPlayerTool(client, "talk_overworld_session_contact", {
    ...parent,
    character_id: "albany_city__civic_core__contact",
  });
  for (const choice of ["albany:ledger_advocate", "albany:oath_limited_aid_only", sourceId]) {
    await callPlayerTool(client, "choose_overworld_session_story", { ...parent, choice });
  }
  return {
    sessionId,
    stationed: await movePlayerToOpeningPreparation(client, parent),
  };
}

async function chooseOpeningDepartureStories(
  client: Client,
  parent: { session_id: string },
): Promise<void> {
  for (const [storyChoiceId, choice] of [
    ["albany:wolf_preparation", "albany:prep_works_fortification"],
    ["albany:wolf_relief_allocation", "albany:relief_resident_shelter"],
  ] as const) {
    await callPlayerTool(client, "choose_overworld_session_story", {
      ...parent,
      story_choice_id: storyChoiceId,
      choice,
    });
  }
}

async function launchPreparedPureWolf(client: Client): Promise<{
  overworldSessionId: string;
  rpgSessionId: string;
  stateHash: string;
}> {
  const started = await callPlayerTool(client, "start_overworld", {});
  const overworldSessionId = String(started.session_id);
  const parent = { session_id: overworldSessionId };
  await callPlayerTool(client, "scout_overworld_session_poi", {
    ...parent,
    poi_id: "albany_city__civic_core__poi",
  });
  await callPlayerTool(client, "talk_overworld_session_contact", {
    ...parent,
    character_id: "albany_city__civic_core__contact",
  });
  for (const choice of [
    "albany:ledger_advocate",
    "albany:oath_limited_aid_only",
    "albany:source_rowan_civic_docket",
  ]) {
    await callPlayerTool(client, "choose_overworld_session_story", { ...parent, choice });
  }
  await movePlayerToOpeningPreparation(client, parent);
  await chooseOpeningDepartureStories(client, parent);
  let view = await callPlayerTool(client, "get_overworld_session_context", parent);
  await callPlayerTool(client, "move_overworld_session_area", {
    ...parent,
    area_route_id: compactAreaRoute(view, "albany_city__market"),
  });
  await callPlayerTool(client, "scout_overworld_session_poi", {
    ...parent,
    poi_id: "albany_city__market__poi",
  });
  view = await callPlayerTool(client, "get_overworld_session_context", parent);
  expect(
    (
      view.context as {
        quest_start_locations?: unknown;
        quest_starts?: unknown;
      }
    ).quest_start_locations,
  ).toEqual([["wolf_winter", "Albany Station Quarter"]]);
  expect((view.context as { quest_starts?: unknown }).quest_starts).toBeUndefined();
  const departure = await callPlayerTool(client, "move_overworld_session_area", {
    ...parent,
    area_route_id: compactAreaRoute(view, "albany_city__transport_hub"),
  });
  expect((departure.journey as { storyChoice?: unknown }).storyChoice).toBeNull();
  expect(
    (departure.context as { quest_start_locations?: unknown }).quest_start_locations,
  ).toBeUndefined();
  expect((departure.context as { quest_starts?: unknown }).quest_starts).toEqual([
    ["wolf_winter", "albany:wolf_approach_exposed_ridge"],
    ["wolf_winter", "albany:wolf_approach_sheltered_stockway"],
  ]);
  const launched = await callPlayerTool(client, "start_overworld_session_quest", {
    ...parent,
    quest_id: "wolf_winter",
    approach_id: "albany:wolf_approach_sheltered_stockway",
  });
  expect(launched).not.toHaveProperty("context");
  expect(launched.launch_handoff).toMatchObject({
    transition: "Albany Station -> The Wolf-Winter",
    route: ["albany:wolf_approach_sheltered_stockway", "Take the Sheltered Stockway"],
    preparation: {
      status: "imported",
      title: "Take Reese's Repair Plan",
    },
    childState: "actionable",
  });
  expect((launched.quest as unknown[])[3]).toBeDefined();
  const rpgSession = launched.rpg_session as { state_hash: string };
  return {
    overworldSessionId,
    rpgSessionId: String(launched.rpg_session_id),
    stateHash: rpgSession.state_hash,
  };
}

async function playPureQuestActions(
  client: Client,
  launch: { rpgSessionId: string; stateHash: string },
  actions: readonly string[],
): Promise<Record<string, unknown>> {
  let stateHash = launch.stateHash;
  let response: Record<string, unknown> = {};
  for (const action_id of actions) {
    response = await callPlayerTool(client, "step_action", {
      session_id: launch.rpgSessionId,
      action_id,
      expected_state_hash: stateHash,
    });
    expect(response.ok, action_id).toBe(true);
    stateHash = String(response.state_hash);
  }
  return response;
}

type MutableDenseWorld = {
  areas: Record<string, unknown>[];
  points_of_interest: Record<string, unknown>[];
  characters: Record<string, unknown>[];
  local_events: Record<string, unknown>[];
  local_jobs: Record<string, unknown>[];
  exploration_sites: Record<string, unknown>[];
  area_edges: Record<string, unknown>[];
};

function fixtureEntry(
  values: readonly Record<string, unknown>[],
  predicate: (value: Record<string, unknown>) => boolean,
  label: string,
): Record<string, unknown> {
  const value = values.find(predicate);
  if (!value) throw new Error(`expected ${label} fixture source`);
  return value;
}

function createDenseAreaFixture(root: string): {
  revealPoiIds: string[];
  hiddenDestinationId: string;
  hiddenRouteId: string;
} {
  cpSync(join(ROOT, "content"), join(root, "content"), { recursive: true });
  const worldPath = join(root, "content", "world", "new_york_overworld.json");
  const world = JSON.parse(readFileSync(worldPath, "utf8")) as MutableDenseWorld;
  const sourceArea = fixtureEntry(
    world.areas,
    (area) => area.id === "airmont_village__civic_core",
    "area",
  );
  const sourcePoi = fixtureEntry(
    world.points_of_interest,
    (poi) => poi.id === "airmont_village__civic_core__poi",
    "point of interest",
  );
  const sourceCharacter = fixtureEntry(
    world.characters,
    (character) => character.id === "airmont_village__civic_core__contact",
    "character",
  );
  const sourceEvent = fixtureEntry(
    world.local_events,
    (event) => event.id === "airmont_village__civic_core__event",
    "local event",
  );
  const sourceJob = fixtureEntry(
    world.local_jobs,
    (job) => job.id === "airmont_village__civic_core__job",
    "local job",
  );
  const sourceSite = fixtureEntry(
    world.exploration_sites,
    (site) => site.id === "airmont_village__civic_core__site",
    "exploration site",
  );

  const denseAreaIds = Array.from(
    { length: 14 },
    (_, index) => `albany_city__dense_alias_${String(index).padStart(2, "0")}`,
  );
  for (const [index, areaId] of denseAreaIds.entries()) {
    const suffix = String(index).padStart(2, "0");
    const title = `ZZ Dense Alias District ${suffix}`;
    world.areas.push({
      ...sourceArea,
      id: areaId,
      home: "albany_city",
      name: title,
      summary: `${title} exists only in the dense MCP visibility regression fixture.`,
      discovery: `A local Albany lead maps ${title}.`,
      travel_minutes: 100 + index,
    });
    world.points_of_interest.push({
      ...sourcePoi,
      id: `${areaId}__poi`,
      home: "albany_city",
      area: areaId,
      title: `${title} Marker`,
      summary: `${title} has a concrete marker for fixture integrity.`,
    });
    world.characters.push({
      ...sourceCharacter,
      id: `${areaId}__contact`,
      home: "albany_city",
      area: areaId,
      name: `Dense Guide ${suffix}`,
      summary: `Dense Guide ${suffix} watches the fixture district.`,
      agenda: `Keep ${title} legible to the visibility regression.`,
    });
    world.local_events.push({
      ...sourceEvent,
      id: `${areaId}__event`,
      home: "albany_city",
      area: areaId,
      title: `${title}: visibility check`,
      summary: `${title} carries a harmless fixture event.`,
    });
    world.local_jobs.push({
      ...sourceJob,
      id: `${areaId}__job`,
      home: "albany_city",
      area: areaId,
      title: `${title}: Route Ledger`,
      summary: `${title} has a bounded route-ledger fixture job.`,
      objective: `Verify the route ledger in ${title}.`,
      reward: "Earn 1 Capital / Mohawk renown for checking the fixture route.",
    });
    world.exploration_sites.push({
      ...sourceSite,
      id: `${areaId}__site`,
      region: "Capital / Mohawk",
      nearest_town: "albany_city",
      area: areaId,
      title: `${title} Archive`,
      summary: `${title} contains a bounded fixture archive.`,
      discovery: `The route ledger points toward the ${title} archive.`,
      reward: "You verify the fixture archive and gain 2 Capital / Mohawk renown.",
    });
    world.area_edges.push({
      id: `albany_city__area_route__civic_core__dense_alias_${suffix}`,
      home: "albany_city",
      from_area: "albany_city__civic_core",
      to_area: areaId,
      route: `Albany Civic Center to ${title}`,
      travel_minutes: 20 + index,
    });
  }
  for (let index = 0; index < 4; index += 1) {
    world.area_edges.push({
      id: `albany_city__area_route__dense_alias_${index}__${index + 1}`,
      home: "albany_city",
      from_area: denseAreaIds[index]!,
      to_area: denseAreaIds[index + 1]!,
      route: `Dense fixture cross-route ${index} to ${index + 1}`,
      travel_minutes: 8,
    });
  }

  const revealPoiIds = Array.from({ length: 18 }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    const id = `albany_city__civic_core__dense_reveal_${suffix}`;
    world.points_of_interest.push({
      ...sourcePoi,
      id,
      home: "albany_city",
      area: "albany_city__civic_core",
      title: `ZZ Dense Route Notice ${suffix}`,
      summary: `This fixture notice reveals the next local area in deterministic order ${suffix}.`,
    });
    return id;
  });

  writeFileSync(worldPath, JSON.stringify(world));
  return {
    revealPoiIds,
    hiddenDestinationId: denseAreaIds.at(-1)!,
    hiddenRouteId: "albany_city__area_route__civic_core__dense_alias_13",
  };
}

async function prepareDenseAreaSession(
  client: Client,
  revealPoiIds: readonly string[],
): Promise<string> {
  const startResult = await client.callTool({ name: "start_overworld", arguments: {} });
  if (startResult.isError) throw new Error(textResult(startResult));
  const started = textPayload(startResult);
  const sessionId = String(started.session_id);
  const civicScout = await client.callTool({
    name: "scout_overworld_session_poi",
    arguments: { session_id: sessionId, poi_id: "albany_city__civic_core__poi" },
  });
  expect(civicScout.isError).not.toBe(true);
  for (const poiId of revealPoiIds) {
    const scouted = await client.callTool({
      name: "scout_overworld_session_poi",
      arguments: { session_id: sessionId, poi_id: poiId },
    });
    expect(scouted.isError, poiId).not.toBe(true);
  }
  const contact = await client.callTool({
    name: "talk_overworld_session_contact",
    arguments: {
      session_id: sessionId,
      character_id: "albany_city__civic_core__contact",
    },
  });
  expect(contact.isError).not.toBe(true);
  for (const choice of [
    "albany:ledger_advocate",
    "albany:oath_limited_aid_only",
    "albany:source_rowan_civic_docket",
  ]) {
    const chosen = await client.callTool({
      name: "choose_overworld_session_story",
      arguments: { session_id: sessionId, choice },
    });
    expect(chosen.isError, choice).not.toBe(true);
  }
  await movePlayerToOpeningPreparation(client, { session_id: sessionId });
  await chooseOpeningDepartureStories(client, { session_id: sessionId });
  const stationContext = await callPlayerTool(client, "get_overworld_session_context", {
    session_id: sessionId,
  });
  await callPlayerTool(client, "move_overworld_session_area", {
    session_id: sessionId,
    area_route_id: compactAreaRoute(stationContext, "albany_city__civic_core"),
  });
  return sessionId;
}

describe("MCP pure play mode", () => {
  it("requires a unique currently visible route for the destination-area alias", () => {
    expect(resolveVisibleAreaRouteId([["r1", "market", 5]], "market")).toBe("r1");
    expect(() => resolveVisibleAreaRouteId([["r1", "market", 5]], "campus")).toThrow(
      /not a visible destination/,
    );
    expect(() =>
      resolveVisibleAreaRouteId(
        [
          ["r1", "market", 5],
          ["r2", "market", 7],
        ],
        "market",
      ),
    ).toThrow(/More than one visible route leads to area/);
  });

  it("lets a visible exact selector resolve an otherwise ambiguous area_id", () => {
    const routes = [
      ["market_short", "market", 5],
      ["market_safe", "market", 9],
      ["campus_loop", "campus", 7],
    ] as const;
    expect(() => resolveAreaMoveSelector(routes, { area_id: "market" })).toThrow(
      /More than one visible route leads to area.*Pass area_route_id or route_id/,
    );
    expect(
      resolveAreaMoveSelector(routes, { area_route_id: "market_short", area_id: "market" }, true),
    ).toBe("market_short");
    expect(
      resolveAreaMoveSelector(routes, { route_id: "market_safe", area_id: "market" }, true),
    ).toBe("market_safe");
    expect(() =>
      resolveAreaMoveSelector(routes, { route_id: "hidden_edge", area_id: "market" }, true),
    ).toThrow(/not visible from here/);
    expect(() =>
      resolveAreaMoveSelector(routes, { route_id: "market_short", area_id: "campus" }, true),
    ).toThrow(/route_id and area_id conflict/);
  });

  it("accepts the reported Civic-to-Transport-Hub edge through compact route_id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-route-id-alias-"));
    const evidence = join(dir, "run.jsonl");
    try {
      await withPureServer(evidence, async (client) => {
        const started = await callPlayerTool(client, "start_overworld", {});
        const sessionId = String(started.session_id);
        const parent = { session_id: sessionId };
        await callPlayerTool(client, "scout_overworld_session_poi", {
          ...parent,
          poi_id: "albany_city__civic_core__poi",
        });
        await callPlayerTool(client, "talk_overworld_session_contact", {
          ...parent,
          contact_id: "albany_city__civic_core__contact",
        });
        for (const choice of [
          "albany:ledger_advocate",
          "albany:oath_limited_aid_only",
          "albany:source_rowan_civic_docket",
        ]) {
          await callPlayerTool(client, "choose_overworld_session_story", { ...parent, choice });
        }
        const context = await callPlayerTool(client, "get_overworld_session_context", parent);
        const exactRouteId = "albany_city__area_route__civic_core__transport_hub__shortcut_1";
        const routes = (context.context as { area_routes?: [string, string, number][] })
          .area_routes;
        expect(routes).toContainEqual([exactRouteId, "albany_city__transport_hub", 5]);

        const moved = await callPlayerTool(client, "move_overworld_session_area", {
          ...parent,
          route_id: exactRouteId,
        });
        expect((moved.context as { here?: unknown[] }).here?.[3]).toBe(
          "albany_city__transport_hub",
        );
        await chooseOpeningDepartureStories(client, parent);
        expect(
          (moved.journey as { decisionProof?: { last?: { actionId?: string } } }).decisionProof
            ?.last?.actionId,
        ).toBe(`move_area:${exactRouteId}`);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps the selected Road-Warden receipt summary-first while exact branch terms stay opt-in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-road-warden-receipt-"));
    const evidence = join(dir, "run.jsonl");
    try {
      await withPureServer(evidence, async (client) => {
        const started = await callPlayerTool(client, "start_overworld", {});
        const sessionId = String(started.session_id);
        const parent = { session_id: sessionId };
        const scouted = await callPlayerTool(client, "scout_overworld_session_poi", {
          ...parent,
          poi_id: "albany_city__civic_core__poi",
          expected_snapshot_hash: started.snapshot_hash,
        });
        const registration = await callPlayerTool(client, "talk_overworld_session_contact", {
          ...parent,
          character_id: "albany_city__civic_core__contact",
          expected_snapshot_hash: scouted.snapshot_hash,
        });
        await callPlayerTool(client, "inspect_overworld_session_story", {
          ...parent,
          story_choice_id: "albany:relief_registration",
          option_id: "albany:road_warden",
          if_snapshot_hash: registration.snapshot_hash,
        });

        const selectedRoleCall = await client.callTool({
          name: "choose_overworld_session_story",
          arguments: {
            ...parent,
            choice: "albany:road_warden",
            expected_snapshot_hash: registration.snapshot_hash,
          },
        });
        const selectedRoleText = textResult(selectedRoleCall);
        const selectedRole = textPayload(selectedRoleCall);
        expect(selectedRoleCall.isError).not.toBe(true);
        // 5_523 -> 5_683 (bug_0625): civic_core's POI/contact are the opening's own, so by
        // this point Rowan's Winter Return Docket is already discovered with an unmet
        // scene-level quest gate, and job_leads now names it instead of leaving it silent.
        expect(Buffer.byteLength(selectedRoleText, "utf8")).toBe(5_683);
        expect(Buffer.byteLength(selectedRoleText, "utf8")).toBeLessThanOrEqual(6_400);
        expect((selectedRole.result as { consequence?: string }).consequence).toContain(
          "In Wolf-Winter, Defense starts at 4 instead of 3.",
        );
        expect((selectedRole.result as { consequence?: string }).consequence).not.toMatch(
          /\b(?:DEF|LURE|HUNT)\b|imported starting|ordinary-hunt|frost[- ](?:brace|jamb)|public wedge|field-team|relief allocation/gu,
        );

        const readyDetail = await callPlayerTool(client, "inspect_overworld_session_story", {
          ...parent,
          story_choice_id: "albany:wolf_relief_oath",
          option_id: "albany:doctrine_road_warden_aid_route",
          if_snapshot_hash: selectedRole.snapshot_hash,
        });
        expect(
          (
            readyDetail.story as {
              inspectedOption?: { consequence?: string };
            }
          ).inspectedOption?.consequence,
        ).toContain(
          "Benefit: Defense 4. First LURE LAY still +1; last feed skips +1 if that LAY succeeded. Split rail can help HUNT.",
        );

        const selectedDispatchCall = await client.callTool({
          name: "choose_overworld_session_story",
          arguments: {
            ...parent,
            choice: "albany:doctrine_road_warden_aid_route",
            expected_snapshot_hash: selectedRole.snapshot_hash,
          },
        });
        const selectedDispatchText = textResult(selectedDispatchCall);
        const selectedDispatch = textPayload(selectedDispatchCall);
        expect(selectedDispatchCall.isError).not.toBe(true);
        const readyDispatchStatus =
          "Background, promise, and report are set. Current setup: 10m. Final setup: 10–60m; all on time. Optional support remains. Start Wolf-Winter to skip it.";
        const readyDispatchSummaries = stringsContaining(selectedDispatch, readyDispatchStatus);
        expect(readyDispatchSummaries).toHaveLength(2);
        expect(
          readyDispatchSummaries.every((summary) => summary.startsWith(readyDispatchStatus)),
        ).toBe(true);
        expect(selectedDispatchText.split(readyDispatchStatus)).toHaveLength(3);
        expect(selectedDispatchText).not.toContain("optional Station support remains");
        // bug_0614: the exposed-ridge route summary grew when it stopped claiming cattle
        // alarm starts at 1 (it doesn't; descending raises it to 1).
        // 7_533 -> 7_693 (bug_0625): same job_leads addition as the selected-role receipt above.
        expect(Buffer.byteLength(selectedDispatchText, "utf8")).toBe(7_693);
        expect(Buffer.byteLength(selectedDispatchText, "utf8")).toBeLessThanOrEqual(9_250);
        expect(selectedDispatchText).not.toMatch(/\b(?:DEF|DRIVE|FORTIFY)\b/gu);
        expect(selectedDispatchText).not.toMatch(/\bWorks\b/gu);
        expect(selectedDispatchText).not.toMatch(
          /public (?:fence )?(?:brace|wedge)|yearling|bare spear/gu,
        );
        const consequence = (selectedDispatch.result as { consequence?: string }).consequence;
        expect(consequence).toBe(
          "Defense starts at 4 instead of 3. The first successful LURE LAY still raises cattle alarm as listed; Aid-Only then skips the last feed's +1, not the first. Hayden's report can unlock a HUNT brace after a rail splits. Cost: 10 minutes and $0. Cost: 10 minutes and $0. Specialist preparation, the wagon, June, and both roads remain available. Background: Road Warden. Promise: Accept Aid-Only Terms. Report: Use Hayden's Frost Report.",
        );
        expect(consequence).not.toMatch(
          /\b(?:DEF|DRIVE|FORTIFY|Works)\b|imported starting|ordinary-hunt|frost[- ](?:brace|jamb)|public (?:fence )?(?:brace|wedge)|yearling|bare spear|field-team|relief allocation/gu,
        );
        expect((selectedDispatch.journey as { acceptedDecisions?: number }).acceptedDecisions).toBe(
          5,
        );
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps area-alias normalization from consuming progressive definitions", async () => {
    await withFullServer(async (client) => {
      const started = await callPlayerTool(client, "start_overworld", {
        compact_context: false,
      });
      const sessionId = String(started.session_id);
      const poiId = (
        started.observation as {
          pois?: { id: string }[];
        }
      ).pois?.[0]?.id;
      if (!poiId) throw new Error("expected a fresh Albany point of interest");
      await callPlayerTool(client, "scout_overworld_session_poi", {
        session_id: sessionId,
        poi_id: poiId,
        compact_context: false,
        compact_result: false,
      });

      const moved = await callPlayerTool(client, "move_overworld_session_area", {
        session_id: sessionId,
        area_id: "albany_city__market",
      });
      const delta = moved.legend_delta as Record<string, string>;
      for (const key of Object.keys(moved.context as Record<string, unknown>)) {
        expect(delta, `first compact move field "${key}"`).toHaveProperty(key);
      }
      const serialized = JSON.stringify(moved);
      expect(serialized.indexOf('"legend_delta"')).toBeLessThan(serialized.indexOf('"result"'));
      expect(serialized.indexOf('"legend_delta"')).toBeLessThan(serialized.indexOf('"context"'));
    });
  }, 120_000);

  it("uses verbose full visibility beyond the compact route cap without widening pure play", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-dense-area-alias-"));
    const fixtureRoot = join(dir, "fixture");
    mkdirSync(fixtureRoot, { recursive: true });
    const { revealPoiIds, hiddenDestinationId, hiddenRouteId } =
      createDenseAreaFixture(fixtureRoot);
    try {
      await withFullServer(async (client) => {
        const sessionId = await prepareDenseAreaSession(client, revealPoiIds);
        const compactBefore = textPayload(
          await client.callTool({
            name: "get_overworld_session_context",
            arguments: { session_id: sessionId },
          }),
        );
        const compactContext = compactBefore.context as {
          area_routes?: [string, string, number][];
          area_routes_truncated?: true;
        };
        expect(compactContext.area_routes).toHaveLength(12);
        expect(compactContext.area_routes_truncated).toBe(true);
        expect(
          compactContext.area_routes?.some(([, areaId]) => areaId === hiddenDestinationId),
        ).toBe(false);

        const verbose = textPayload(
          await client.callTool({
            name: "get_overworld_session",
            arguments: { session_id: sessionId, include_observation: true },
          }),
        );
        const fullRoutes = (
          verbose.observation as {
            areaExits: { id: string; destination: { id: string }; travel_minutes: number }[];
          }
        ).areaExits;
        expect(fullRoutes.length).toBeGreaterThan(12);
        expect(fullRoutes.some((route) => route.destination.id === hiddenDestinationId)).toBe(true);

        const compactRejected = await client.callTool({
          name: "move_overworld_session_area",
          arguments: { session_id: sessionId, area_id: hiddenDestinationId },
        });
        expect(compactRejected.isError).toBe(true);
        expect(textResult(compactRejected)).toMatch(/not a visible destination/);
        const afterCompactRejection = textPayload(
          await client.callTool({
            name: "get_overworld_session_context",
            arguments: { session_id: sessionId },
          }),
        );
        expect(afterCompactRejection.snapshot_hash).toBe(compactBefore.snapshot_hash);

        const moved = textPayload(
          await client.callTool({
            name: "move_overworld_session_area",
            arguments: {
              session_id: sessionId,
              area_id: hiddenDestinationId,
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        expect((moved.observation as { currentArea?: { id: string } }).currentArea?.id).toBe(
          hiddenDestinationId,
        );
      }, fixtureRoot);

      await withPureServer(
        join(dir, "pure-evidence.jsonl"),
        async (client) => {
          const sessionId = await prepareDenseAreaSession(client, revealPoiIds);
          const compactBefore = textPayload(
            await client.callTool({
              name: "get_overworld_session_context",
              arguments: { session_id: sessionId },
            }),
          );
          const compactRoutes = (
            compactBefore.context as { area_routes?: [string, string, number][] }
          ).area_routes;
          expect(compactRoutes).toHaveLength(12);
          expect(compactRoutes?.some(([, areaId]) => areaId === hiddenDestinationId)).toBe(false);

          expect(compactRoutes?.some(([routeId]) => routeId === hiddenRouteId)).toBe(false);
          for (const [selectorName, selectorValue] of [
            ["area_route_id", { area_route_id: hiddenRouteId }],
            ["route_id", { route_id: hiddenRouteId }],
          ] as const) {
            const rejected = await client.callTool({
              name: "move_overworld_session_area",
              arguments: {
                session_id: sessionId,
                ...selectorValue,
                // Pure strips this unadvertised escape attempt and remains compact.
                compact_context: false,
              },
            });
            expect(rejected.isError, selectorName).toBe(true);
            expect(textPayload(rejected).error, selectorName).toMatch(/not visible from here/i);
            const afterSelectorRejection = textPayload(
              await client.callTool({
                name: "get_overworld_session_context",
                arguments: { session_id: sessionId },
              }),
            );
            expect(afterSelectorRejection.snapshot_hash, selectorName).toBe(
              compactBefore.snapshot_hash,
            );
          }

          const destinationRejected = await client.callTool({
            name: "move_overworld_session_area",
            arguments: {
              session_id: sessionId,
              area_id: hiddenDestinationId,
              // Pure strips this unadvertised escape attempt and remains compact.
              compact_context: false,
            },
          });
          expect(destinationRejected.isError).toBe(true);
          expect(textPayload(destinationRejected).error).toMatch(/not a visible destination/);
          const after = textPayload(
            await client.callTool({
              name: "get_overworld_session_context",
              arguments: { session_id: sessionId },
            }),
          );
          expect(after.snapshot_hash).toBe(compactBefore.snapshot_hash);
        },
        TEST_RUN_SEED,
        fixtureRoot,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps structural QA on the full tool surface", () => {
    expect(toolAvailableInPlayMode("start_world_quest", "structural")).toBe(true);
    expect(toolAvailableInPlayMode("start_world_quest", "full")).toBe(true);
    expect(toolAvailableInPlayMode("start_world_quest", "pure")).toBe(false);
    expect(toolAvailableInPlayMode("plan_overworld_session_route", "pure")).toBe(true);
    expect(toolAvailableInPlayMode("follow_overworld_session_goal", "pure")).toBe(true);
    expect(toolAvailableInPlayMode("inspect_overworld_session_story", "pure")).toBe(true);
    expect(toolAvailableInPlayMode("choose_overworld_session_story", "pure")).toBe(true);
    expect(PURE_PLAYER_TOOLS.has("follow_overworld_session_goal")).toBe(true);
    expect(PURE_PLAYER_TOOLS.has("inspect_overworld_session_story")).toBe(true);
    expect(PURE_PLAYER_TOOLS.has("choose_overworld_session_story")).toBe(true);
  });

  it("types known context requests narrowly and broad callers conservatively", () => {
    type IncludesV1<Response> = [Extract<Response, PureStationDispatchRevealResponseV1>] extends [
      never,
    ]
      ? false
      : true;
    type IncludesUnchanged<Response> = [Extract<Response, { unchanged: true }>] extends [never]
      ? false
      : true;
    type Assert<Condition extends true> = Condition;
    const compileTimeAssertions: [
      Assert<
        IncludesV1<PureOverworldContextWireResponse<{ session_id: string }>> extends false
          ? true
          : false
      >,
      Assert<
        IncludesV1<
          PureOverworldContextWireResponse<{
            session_id: string;
            reveal_station_dispatch_support: string;
          }>
        >
      >,
      Assert<
        IncludesV1<
          PureOverworldContextWireResponse<{
            session_id: string;
            reveal_station_dispatch_support: string;
            include_station_dispatch_support: true;
          }>
        > extends false
          ? true
          : false
      >,
      Assert<
        IncludesV1<
          PureOverworldContextWireResponse<{
            session_id: string;
            reveal_station_dispatch_support: string;
            include_departure_recap_terms: true;
          }>
        > extends false
          ? true
          : false
      >,
      Assert<IncludesV1<PureOverworldContextWireResponse<OverworldMcpReadArgs>>>,
    ] = [true, true, true, true, true];
    expect(compileTimeAssertions).toEqual([true, true, true, true, true]);
    const unchangedAssertions: [
      Assert<
        IncludesUnchanged<PureOverworldContextWireResponse<{ session_id: string }>> extends false
          ? true
          : false
      >,
      Assert<
        IncludesUnchanged<
          PureOverworldContextWireResponse<{
            session_id: string;
            if_snapshot_hash: string;
          }>
        >
      >,
      Assert<
        IncludesUnchanged<
          PureOverworldContextWireResponse<{
            session_id: string;
            if_snapshot_hash: string;
            reveal_station_dispatch_support: string;
          }>
        > extends false
          ? true
          : false
      >,
      Assert<IncludesUnchanged<PureOverworldContextWireResponse<OverworldMcpReadArgs>>>,
    ] = [true, true, true, true];
    expect(unchangedAssertions).toEqual([true, true, true, true]);

    type IncludesJuneModal<Response> = [Extract<Response, PureStationJuneModalResponseV1>] extends [
      never,
    ]
      ? false
      : true;
    type IncludesCanonicalTalk<Response> = [Extract<Response, { session_id: string }>] extends [
      never,
    ]
      ? false
      : true;
    const talkAssertions: [
      Assert<
        IncludesJuneModal<
          PureOverworldTalkWireResponse<{
            session_id: string;
            character_id: typeof PURE_STATION_JUNE_CONTACT_ID;
          }>
        >
      >,
      Assert<
        IncludesJuneModal<
          PureOverworldTalkWireResponse<{
            session_id: string;
            contact_id: typeof PURE_STATION_JUNE_CONTACT_ID;
          }>
        >
      >,
      Assert<
        IncludesJuneModal<
          PureOverworldTalkWireResponse<{
            session_id: string;
            character_id: "some_other_contact";
          }>
        > extends false
          ? true
          : false
      >,
      Assert<
        IncludesJuneModal<
          PureOverworldTalkWireResponse<{ session_id: string; character_id: string }>
        >
      >,
      Assert<
        IncludesCanonicalTalk<
          PureOverworldTalkWireResponse<{
            session_id: string;
            character_id: typeof PURE_STATION_JUNE_CONTACT_ID;
          }>
        >
      >,
      Assert<
        IncludesCanonicalTalk<
          PureOverworldTalkWireResponse<{
            session_id: string;
            character_id: "some_other_contact";
          }>
        >
      >,
    ] = [true, true, true, true, true, true];
    expect(talkAssertions).toEqual([true, true, true, true, true, true]);
  });

  it("keeps live recovery handles out of full multi-session errors while naming the parent field", async () => {
    await withFullServer(async (client) => {
      const listed = await client.listTools();
      const fullRead = listed.tools.find((tool) => tool.name === "get_overworld_session_context");
      expect(fullRead?.inputSchema.required).toContain("session_id");
      const fullCatalogProjection = listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: Object.fromEntries(
          Object.entries(tool.inputSchema).filter(([key]) => key !== "$schema"),
        ),
      }));
      // +807 on 2026-08-28: inspect_overworld_session_story now publishes its ten
      // full-mode properties instead of an empty `{}`. Only the pure catalogue is
      // budget-capped; full mode is pinned to catch unintended drift, not to ration.
      // +8 on 2026-08-28: reveal_station_dispatch_support's full-mode description
      // dropped an untrue "without changing state" claim — that path writes a durable
      // reveal receipt into the snapshot and moves the hash — and says so instead.
      // +95 on 2026-08-30: new_game's description stopped promising a "default pack"
      // it actually refuses (generate_rpg_seed is required) and now points shipped
      // quests at start_world_quest — found by playing during the full audit.
      // +116 on 2026-09-06: choose_overworld_session_story now also accepts option_id
      // as a full-mode-only alias for choice, so the obvious inspect-then-choose
      // sequence no longer fails on an argument-name mismatch (queue 61d3b9dec4cb09fd).
      // +132 on 2026-09-22 (bug_0654): restore_overworld_session publishes an optional
      // embedded_quest property and export_overworld_session's description says to pass
      // it back — a snapshot exported mid-quest is not restorable without its child.
      // Neither tool is in the pure catalogue, whose pins are unchanged.
      // -442 on 2026-09-23: the canned-author adapt_story tool was deleted with the mock
      // authoring pipeline. Neither change touched the pure catalogue.
      expect(Buffer.byteLength(JSON.stringify(fullCatalogProjection), "utf8")).toBe(39_571);
      expect(fullRead?.description).toBe(
        "Read current context without acting. Station support uses the exact board[5] id.",
      );
      expect(
        (fullRead?.inputSchema.properties as Record<string, { description?: string }> | undefined)
          ?.reveal_station_dispatch_support?.description,
      ).toBe("Station board[5] reveal id. Records a durable receipt, so the snapshot hash moves.");

      const first = textPayload(await client.callTool({ name: "start_overworld", arguments: {} }));
      const second = textPayload(await client.callTool({ name: "start_overworld", arguments: {} }));
      expect(first.session_id).not.toBe(second.session_id);
      expect(first).not.toHaveProperty("overworld_session_id");
      expect(second).not.toHaveProperty("overworld_session_id");

      const rejected = await client.callTool({
        name: "get_overworld_session_context",
        arguments: { session_id: "not-a-live-handle" },
      });
      expect(rejected.isError).toBe(true);
      const text = (rejected.content as { type: string; text?: string }[])[0]?.text ?? "";
      expect(text).not.toContain(String(first.session_id));
      expect(text).not.toContain(String(second.session_id));
      expect(text).toContain("Pass the current parent overworld_session_id.");
      expect(text).not.toContain("rpg_session_id");
    });
  });

  it("publishes and honors the full-mode alias matrix", async () => {
    await withFullServer(async (client) => {
      const listed = await client.listTools();
      for (const [name, canonicalName, aliasName] of [
        ["talk_overworld_session_contact", "character_id", "contact_id"],
        ["move_overworld_session_area", "area_route_id", "area_id"],
        ["plan_overworld_session_route", "destination_town_id", "dest_town_id"],
        ["get_observation", "session_id", "rpg_session_id"],
        ["list_legal_actions", "session_id", "rpg_session_id"],
        ["step_action", "session_id", "rpg_session_id"],
        ["get_state", "session_id", "rpg_session_id"],
        ["get_transcript", "session_id", "rpg_session_id"],
        ["save_game", "session_id", "rpg_session_id"],
        ["choose_overworld_session_story", "choice", "option_id"],
      ] as const) {
        expectAliasedToolSchema(listed, name, canonicalName, aliasName);
      }
      expectAliasedToolSchema(listed, "step_action", "action_id", "action");
      expectToolSchemaFields(listed, "travel_overworld_session", [
        "destination_town_id",
        "dest_town_id",
      ]);
      expectOneOfToolSchema(listed, "move_overworld_session_area", [
        "area_route_id",
        "route_id",
        "area_id",
      ]);

      for (const [name, argumentsValue, message] of [
        ["talk_overworld_session_contact", {}, /Provide character_id or contact_id/],
        ["move_overworld_session_area", {}, /Provide area_route_id, route_id, or area_id/],
        ["get_state", {}, /Provide session_id or rpg_session_id/],
      ] as const) {
        const omitted = await client.callTool({ name, arguments: argumentsValue });
        expect(omitted.isError, name).toBe(true);
        expect(textResult(omitted), name).toMatch(message);
      }

      const started = textPayload(
        await client.callTool({ name: "start_overworld", arguments: {} }),
      );
      const overworldSessionId = String(started.session_id);
      const planBefore = textPayload(
        await client.callTool({
          name: "get_overworld_session_context",
          arguments: { session_id: overworldSessionId },
        }),
      );
      const plannedByAlias = await client.callTool({
        name: "plan_overworld_session_route",
        arguments: { session_id: overworldSessionId, dest_town_id: "colonie_town" },
      });
      expect(plannedByAlias.isError).not.toBe(true);
      const plannedBySameDual = await client.callTool({
        name: "plan_overworld_session_route",
        arguments: {
          session_id: overworldSessionId,
          destination_town_id: "colonie_town",
          dest_town_id: "colonie_town",
        },
      });
      expect(plannedBySameDual.isError).not.toBe(true);
      const planConflict = await client.callTool({
        name: "plan_overworld_session_route",
        arguments: {
          session_id: overworldSessionId,
          destination_town_id: "colonie_town",
          dest_town_id: "bethlehem_town",
        },
      });
      expect(planConflict.isError).toBe(true);
      expect(textResult(planConflict)).toMatch(/destination_town_id and dest_town_id conflict/);
      const planAfter = textPayload(
        await client.callTool({
          name: "get_overworld_session_context",
          arguments: { session_id: overworldSessionId },
        }),
      );
      expect(planAfter.snapshot_hash).toBe(planBefore.snapshot_hash);

      const travelAliasStarted = textPayload(
        await client.callTool({ name: "start_overworld", arguments: {} }),
      );
      const travelAliasId = String(travelAliasStarted.session_id);
      const traveledByAlias = await client.callTool({
        name: "travel_overworld_session",
        arguments: { session_id: travelAliasId, dest_town_id: "colonie_town" },
      });
      expect(traveledByAlias.isError).not.toBe(true);
      const travelAliasAfter = textPayload(
        await client.callTool({
          name: "get_overworld_session_context",
          arguments: { session_id: travelAliasId },
        }),
      );
      expect(travelAliasAfter.snapshot_hash).not.toBe(travelAliasStarted.snapshot_hash);

      const travelDualStarted = textPayload(
        await client.callTool({ name: "start_overworld", arguments: {} }),
      );
      const travelDual = await client.callTool({
        name: "travel_overworld_session",
        arguments: {
          session_id: String(travelDualStarted.session_id),
          destination_town_id: "colonie_town",
          dest_town_id: "colonie_town",
        },
      });
      expect(travelDual.isError).not.toBe(true);

      const travelConflictStarted = textPayload(
        await client.callTool({ name: "start_overworld", arguments: {} }),
      );
      const travelConflictId = String(travelConflictStarted.session_id);
      const travelConflictBefore = textPayload(
        await client.callTool({
          name: "get_overworld_session_context",
          arguments: { session_id: travelConflictId },
        }),
      );
      const travelConflict = await client.callTool({
        name: "travel_overworld_session",
        arguments: {
          session_id: travelConflictId,
          destination_town_id: "colonie_town",
          dest_town_id: "bethlehem_town",
        },
      });
      expect(travelConflict.isError).toBe(true);
      expect(textResult(travelConflict)).toMatch(/destination_town_id and dest_town_id conflict/);
      const travelConflictAfter = textPayload(
        await client.callTool({
          name: "get_overworld_session_context",
          arguments: { session_id: travelConflictId },
        }),
      );
      expect(travelConflictAfter.snapshot_hash).toBe(travelConflictBefore.snapshot_hash);
      const roadDestinationConflict = await client.callTool({
        name: "travel_overworld_session",
        arguments: {
          session_id: travelConflictId,
          road_id: "road_albany_city__colonie_town",
          dest_town_id: "colonie_town",
        },
      });
      expect(roadDestinationConflict.isError).toBe(true);
      expect(textResult(roadDestinationConflict)).toMatch(
        /Pass exactly one: road_id or destination_town_id/,
      );
      const roadDestinationAfter = textPayload(
        await client.callTool({
          name: "get_overworld_session_context",
          arguments: { session_id: travelConflictId },
        }),
      );
      expect(roadDestinationAfter.snapshot_hash).toBe(travelConflictBefore.snapshot_hash);
      const contactId = "albany_city__civic_core__contact";
      const scouted = await client.callTool({
        name: "scout_overworld_session_poi",
        arguments: { session_id: overworldSessionId, poi_id: "albany_city__civic_core__poi" },
      });
      expect(scouted.isError).not.toBe(true);
      const contacted = await client.callTool({
        name: "talk_overworld_session_contact",
        arguments: { session_id: overworldSessionId, contact_id: contactId },
      });
      expect(contacted.isError).not.toBe(true);
      for (const choice of [
        "albany:ledger_advocate",
        "albany:oath_limited_aid_only",
        "albany:source_rowan_civic_docket",
      ]) {
        const chosen = await client.callTool({
          name: "choose_overworld_session_story",
          arguments: { session_id: overworldSessionId, choice },
        });
        expect(chosen.isError, choice).not.toBe(true);
      }

      // The natural sequence is inspect an option, then choose the id just inspected. The
      // two tools used to name that id differently (option_id vs choice), so the obvious
      // second call was rejected. This proves choose now accepts the inspected id verbatim.
      const storyAliasStarted = textPayload(
        await client.callTool({ name: "start_overworld", arguments: {} }),
      );
      const storyAliasSessionId = String(storyAliasStarted.session_id);
      await client.callTool({
        name: "scout_overworld_session_poi",
        arguments: { session_id: storyAliasSessionId, poi_id: "albany_city__civic_core__poi" },
      });
      await client.callTool({
        name: "talk_overworld_session_contact",
        arguments: { session_id: storyAliasSessionId, contact_id: contactId },
      });
      const inspected = await client.callTool({
        name: "inspect_overworld_session_story",
        arguments: {
          session_id: storyAliasSessionId,
          story_choice_id: "albany:relief_registration",
          option_id: "albany:ledger_advocate",
        },
      });
      expect(inspected.isError).not.toBe(true);
      const chosenByAlias = await client.callTool({
        name: "choose_overworld_session_story",
        arguments: { session_id: storyAliasSessionId, option_id: "albany:ledger_advocate" },
      });
      expect(chosenByAlias.isError).not.toBe(true);
      const storyAliasConflict = await client.callTool({
        name: "choose_overworld_session_story",
        arguments: {
          session_id: overworldSessionId,
          choice: "albany:oath_limited_aid_only",
          option_id: "albany:oath_full_duty",
        },
      });
      expect(storyAliasConflict.isError).toBe(true);
      expect(textResult(storyAliasConflict)).toMatch(/choice and option_id conflict/);

      const dualStarted = textPayload(
        await client.callTool({ name: "start_overworld", arguments: {} }),
      );
      const sameContact = await client.callTool({
        name: "talk_overworld_session_contact",
        arguments: {
          session_id: String(dualStarted.session_id),
          character_id: contactId,
          contact_id: contactId,
        },
      });
      expect(sameContact.isError).not.toBe(true);
      const moveContext = textPayload(
        await client.callTool({
          name: "get_overworld_session_context",
          arguments: { session_id: overworldSessionId },
        }),
      );
      const transportHubRoute = (
        moveContext.context as { area_routes?: [string, string, number][] }
      ).area_routes?.find(([, destination]) => destination === "albany_city__transport_hub");
      if (!transportHubRoute) throw new Error("expected a visible Albany transport-hub route");
      const moved = textPayload(
        await client.callTool({
          name: "move_overworld_session_area",
          arguments: {
            session_id: overworldSessionId,
            route_id: transportHubRoute[0],
            compact_context: false,
            compact_result: false,
          },
        }),
      );
      expect((moved.observation as { currentArea?: { id: string } }).currentArea?.id).toBe(
        "albany_city__transport_hub",
      );
      await chooseOpeningDepartureStories(client, { session_id: overworldSessionId });

      const created = textPayload(
        await client.callTool({ name: "new_game", arguments: { generate_rpg_seed: 3 } }),
      );
      const rpgSessionId = String(created.session_id);
      const initialStateHash = String(created.state_hash);
      for (const name of [
        "get_observation",
        "list_legal_actions",
        "get_state",
        "get_transcript",
        "save_game",
      ]) {
        const aliasOnly = await client.callTool({
          name,
          arguments: { rpg_session_id: rpgSessionId },
        });
        expect(aliasOnly.isError, `${name} alias-only`).not.toBe(true);
        const sameDual = await client.callTool({
          name,
          arguments: { session_id: rpgSessionId, rpg_session_id: rpgSessionId },
        });
        expect(sameDual.isError, `${name} same dual`).not.toBe(true);
        const conflict = await client.callTool({
          name,
          arguments: { session_id: rpgSessionId, rpg_session_id: "r-conflict" },
        });
        expect(conflict.isError, `${name} conflict`).toBe(true);
        expect(textResult(conflict), name).toMatch(/session_id and rpg_session_id conflict/);
      }

      const menu = textPayload(
        await client.callTool({
          name: "list_legal_actions",
          arguments: { rpg_session_id: rpgSessionId, compact_actions: true },
        }),
      );
      const actionId = (menu.actions as string[])[0];
      if (!actionId) throw new Error("expected a legal opening RPG action");
      const stepConflict = await client.callTool({
        name: "step_action",
        arguments: {
          session_id: rpgSessionId,
          rpg_session_id: "r-conflict",
          action_id: actionId,
        },
      });
      expect(stepConflict.isError).toBe(true);
      expect(textResult(stepConflict)).toMatch(/session_id and rpg_session_id conflict/);
      const actionConflictBefore = textPayload(
        await client.callTool({
          name: "get_state",
          arguments: { rpg_session_id: rpgSessionId },
        }),
      );
      const actionConflict = await client.callTool({
        name: "step_action",
        arguments: {
          rpg_session_id: rpgSessionId,
          action_id: actionId,
          action: "not_the_same_action",
          expected_state_hash: initialStateHash,
        },
      });
      expect(actionConflict.isError).toBe(true);
      expect(textResult(actionConflict)).toMatch(/action_id and action conflict/);
      const actionConflictAfter = textPayload(
        await client.callTool({
          name: "get_state",
          arguments: { rpg_session_id: rpgSessionId },
        }),
      );
      expect(actionConflictAfter.state_hash).toBe(actionConflictBefore.state_hash);
      const stepped = textPayload(
        await client.callTool({
          name: "step_action",
          arguments: {
            rpg_session_id: rpgSessionId,
            action: actionId,
            expected_state_hash: initialStateHash,
          },
        }),
      );
      expect(stepped.ok).toBe(true);
      const sameDualGame = textPayload(
        await client.callTool({ name: "new_game", arguments: { generate_rpg_seed: 3 } }),
      );
      const sameDualId = String(sameDualGame.session_id);
      const sameDualMenu = textPayload(
        await client.callTool({
          name: "list_legal_actions",
          arguments: { session_id: sameDualId, compact_actions: true },
        }),
      );
      const sameDualAction = (sameDualMenu.actions as string[])[0];
      if (!sameDualAction) throw new Error("expected a legal opening RPG action");
      const sameDualStep = await client.callTool({
        name: "step_action",
        arguments: {
          session_id: sameDualId,
          action_id: sameDualAction,
          action: sameDualAction,
          expected_state_hash: String(sameDualGame.state_hash),
        },
      });
      expect(sameDualStep.isError).not.toBe(true);
    });
  }, 120_000);

  it("reports unrelated full-mode alias validation failures without mutation", async () => {
    await withFullServer(async (client) => {
      const started = textPayload(
        await client.callTool({ name: "start_overworld", arguments: {} }),
      );
      const overworldSessionId = String(started.session_id);
      const parentBefore = textPayload(
        await client.callTool({
          name: "get_overworld_session_context",
          arguments: { session_id: overworldSessionId },
        }),
      );

      for (const [name, argumentsValue, aliasPresenceMessage] of [
        [
          "talk_overworld_session_contact",
          { contact_id: "albany_city__civic_core__contact" },
          /Provide character_id or contact_id/,
        ],
        [
          "move_overworld_session_area",
          { area_id: "albany_city__market" },
          /Provide area_route_id, route_id, or area_id/,
        ],
        [
          "move_overworld_session_area",
          { route_id: "albany_city__area_route__civic_core__market__1" },
          /Provide area_route_id, route_id, or area_id/,
        ],
      ] as const) {
        const rejected = await client.callTool({ name, arguments: argumentsValue });
        expect(rejected.isError, name).toBe(true);
        const error = textResult(rejected);
        expect(error, name).toMatch(/session_id/);
        expect(error, name).toMatch(/Required/);
        expect(error, name).not.toMatch(aliasPresenceMessage);
      }
      const malformedRouteId = await client.callTool({
        name: "move_overworld_session_area",
        arguments: { session_id: overworldSessionId, route_id: 7 },
      });
      expect(malformedRouteId.isError).toBe(true);
      expect(textResult(malformedRouteId)).toMatch(/route_id/);
      expect(textResult(malformedRouteId)).toMatch(/Expected string/);
      const parentAfter = textPayload(
        await client.callTool({
          name: "get_overworld_session_context",
          arguments: { session_id: overworldSessionId },
        }),
      );
      expect(parentAfter.snapshot_hash).toBe(parentBefore.snapshot_hash);

      const created = textPayload(
        await client.callTool({ name: "new_game", arguments: { generate_rpg_seed: 3 } }),
      );
      const rpgSessionId = String(created.session_id);
      const rpgBefore = textPayload(
        await client.callTool({
          name: "get_state",
          arguments: { session_id: rpgSessionId },
        }),
      );
      for (const [argumentsValue, expectedField, expectedMessage] of [
        [{ rpg_session_id: rpgSessionId }, "action_id", /Required/],
        [
          { rpg_session_id: rpgSessionId, action_id: 7 },
          "action_id",
          /Expected string, received number/,
        ],
        [{ rpg_session_id: rpgSessionId, action: 7 }, "action", /Expected string, received number/],
      ] as const) {
        const rejected = await client.callTool({
          name: "step_action",
          arguments: argumentsValue,
        });
        expect(rejected.isError).toBe(true);
        const error = textResult(rejected);
        expect(error).toMatch(new RegExp(expectedField));
        expect(error).toMatch(expectedMessage);
        expect(error).not.toMatch(/Provide session_id or rpg_session_id/);
      }
      const missingSessionWrongAliasAction = await client.callTool({
        name: "step_action",
        arguments: { action: 7 },
      });
      expect(missingSessionWrongAliasAction.isError).toBe(true);
      expect(textResult(missingSessionWrongAliasAction)).toMatch(/session_id/);
      expect(textResult(missingSessionWrongAliasAction)).toMatch(/action/);
      expect(textResult(missingSessionWrongAliasAction)).toMatch(
        /Expected string, received number/,
      );
      for (const [name, argumentsValue, fieldName] of [
        ["plan_overworld_session_route", { session_id: overworldSessionId }, "destination_town_id"],
        [
          "plan_overworld_session_route",
          { session_id: overworldSessionId, dest_town_id: 7 },
          "dest_town_id",
        ],
        [
          "travel_overworld_session",
          { session_id: overworldSessionId, dest_town_id: 7 },
          "dest_town_id",
        ],
      ] as const) {
        const rejected = await client.callTool({ name, arguments: argumentsValue });
        expect(rejected.isError, name).toBe(true);
        expect(textResult(rejected), name).toMatch(new RegExp(fieldName));
      }
      const rpgAfter = textPayload(
        await client.callTool({
          name: "get_state",
          arguments: { session_id: rpgSessionId },
        }),
      );
      expect(rpgAfter.state_hash).toBe(rpgBefore.state_hash);
    });
  }, 120_000);

  it("accepts player-facing MCP aliases and rejects conflicts without changing state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-pure-aliases-"));
    const evidence = join(dir, "run.jsonl");
    try {
      await withPureServer(evidence, async (client) => {
        const listed = await client.listTools();
        for (const [name, canonicalName, aliasName] of [
          ["talk_overworld_session_contact", "character_id", "contact_id"],
          ["move_overworld_session_area", "area_route_id", "area_id"],
          ["plan_overworld_session_route", "destination_town_id", "dest_town_id"],
          ["get_observation", "session_id", "rpg_session_id"],
          ["list_legal_actions", "session_id", "rpg_session_id"],
          ["step_action", "session_id", "rpg_session_id"],
        ] as const) {
          expectAliasedToolSchema(listed, name, canonicalName, aliasName);
        }
        expectAliasedToolSchema(listed, "step_action", "action_id", "action");
        expectToolSchemaFields(listed, "travel_overworld_session", [
          "destination_town_id",
          "dest_town_id",
        ]);
        expectOneOfToolSchema(listed, "move_overworld_session_area", [
          "area_route_id",
          "route_id",
          "area_id",
        ]);
        for (const [name, message] of [
          ["talk_overworld_session_contact", /Provide character_id or contact_id/],
          ["move_overworld_session_area", /Provide area_route_id, route_id, or area_id/],
          ["get_observation", /Provide session_id or rpg_session_id/],
        ] as const) {
          const omitted = await client.callTool({ name, arguments: {} });
          expect(omitted.isError, name).toBe(true);
          expect(textResult(omitted), name).toMatch(message);
        }

        const started = await callPlayerTool(client, "start_overworld", {});
        const sessionId = String(started.session_id);
        const parent = { session_id: sessionId };
        const parentState = async () => {
          const read = await callPlayerTool(client, "get_overworld_session_context", parent);
          return {
            snapshot_hash: read.snapshot_hash,
            journey: read.journey,
          };
        };

        for (const [name, argumentsValue, fieldName] of [
          ["plan_overworld_session_route", { ...parent, dest_town_id: 7 }, "dest_town_id"],
          ["travel_overworld_session", { ...parent, dest_town_id: 7 }, "dest_town_id"],
          ["step_action", { action: 7 }, "action"],
        ] as const) {
          const rejected = await client.callTool({ name, arguments: argumentsValue });
          expect(rejected.isError, name).toBe(true);
          expect(textResult(rejected), name).toMatch(new RegExp(fieldName));
          expect(textResult(rejected), name).toMatch(/Expected string, received number/);
        }

        const beforeContactConflict = await parentState();
        const contactConflict = await client.callTool({
          name: "talk_overworld_session_contact",
          arguments: {
            ...parent,
            character_id: "albany_city__civic_core__contact",
            contact_id: "albany_city__market__contact",
          },
        });
        expect(contactConflict.isError).toBe(true);
        expect(textPayload(contactConflict).error).toMatch(/character_id and contact_id conflict/);
        expect(await parentState()).toEqual(beforeContactConflict);

        await callPlayerTool(client, "scout_overworld_session_poi", {
          ...parent,
          poi_id: "albany_city__civic_core__poi",
        });
        await callPlayerTool(client, "talk_overworld_session_contact", {
          ...parent,
          character_id: "albany_city__civic_core__contact",
          contact_id: "albany_city__civic_core__contact",
        });
        for (const choice of [
          "albany:ledger_advocate",
          "albany:oath_limited_aid_only",
          "albany:source_rowan_civic_docket",
        ]) {
          await callPlayerTool(client, "choose_overworld_session_story", { ...parent, choice });
        }
        await movePlayerToOpeningPreparation(client, parent);
        await chooseOpeningDepartureStories(client, parent);

        let context = await callPlayerTool(client, "get_overworld_session_context", parent);
        let areaRoutes = (context.context as { area_routes?: [string, string, number][] })
          .area_routes;
        const marketRoute = areaRoutes?.find(
          ([, destination]) => destination === "albany_city__market",
        );
        if (!marketRoute) throw new Error("expected a visible Albany market route");
        await callPlayerTool(client, "move_overworld_session_area", {
          ...parent,
          route_id: marketRoute[0],
        });
        await callPlayerTool(client, "scout_overworld_session_poi", {
          ...parent,
          poi_id: "albany_city__market__poi",
        });
        await callPlayerTool(client, "talk_overworld_session_contact", {
          ...parent,
          contact_id: "albany_city__market__contact",
        });
        context = await callPlayerTool(client, "get_overworld_session_context", parent);
        areaRoutes = (context.context as { area_routes?: [string, string, number][] }).area_routes;
        const civicRoute = areaRoutes?.find(
          ([, destination]) => destination === "albany_city__civic_core",
        );
        const stationRoute = areaRoutes?.find(
          ([, destination]) => destination === "albany_city__transport_hub",
        );
        if (!civicRoute || !stationRoute) throw new Error("expected two visible Albany routes");

        const beforeAreaConflict = await parentState();
        const areaConflict = await client.callTool({
          name: "move_overworld_session_area",
          arguments: {
            ...parent,
            area_route_id: stationRoute[0],
            area_id: civicRoute[1],
          },
        });
        expect(areaConflict.isError).toBe(true);
        expect(textPayload(areaConflict).error).toMatch(/area_route_id and area_id conflict/);
        expect(await parentState()).toEqual(beforeAreaConflict);

        const beforeRouteAliasConflict = await parentState();
        const routeAliasConflict = await client.callTool({
          name: "move_overworld_session_area",
          arguments: {
            ...parent,
            area_route_id: stationRoute[0],
            route_id: civicRoute[0],
          },
        });
        expect(routeAliasConflict.isError).toBe(true);
        expect(textPayload(routeAliasConflict).error).toMatch(
          /area_route_id and route_id conflict/,
        );
        expect(await parentState()).toEqual(beforeRouteAliasConflict);

        const beforeRouteDestinationConflict = await parentState();
        const routeDestinationConflict = await client.callTool({
          name: "move_overworld_session_area",
          arguments: {
            ...parent,
            route_id: stationRoute[0],
            area_id: civicRoute[1],
          },
        });
        expect(routeDestinationConflict.isError).toBe(true);
        expect(textPayload(routeDestinationConflict).error).toMatch(
          /route_id and area_id conflict/,
        );
        expect(await parentState()).toEqual(beforeRouteDestinationConflict);

        const beforeTripleConflict = await parentState();
        const tripleConflict = await client.callTool({
          name: "move_overworld_session_area",
          arguments: {
            ...parent,
            area_route_id: stationRoute[0],
            route_id: stationRoute[0],
            area_id: civicRoute[1],
          },
        });
        expect(tripleConflict.isError).toBe(true);
        expect(textPayload(tripleConflict).error).toMatch(/route selector and area_id conflict/);
        expect(await parentState()).toEqual(beforeTripleConflict);

        const ready = await callPlayerTool(client, "move_overworld_session_area", {
          ...parent,
          area_route_id: stationRoute[0],
          route_id: stationRoute[0],
          area_id: stationRoute[1],
        });
        expect((ready.context as { quest_starts?: unknown }).quest_starts).toBeDefined();
        const launched = await callPlayerTool(client, "start_overworld_session_quest", {
          ...parent,
          quest_id: "wolf_winter",
          approach_id: "albany:wolf_approach_sheltered_stockway",
        });
        const rpgSessionId = String(launched.rpg_session_id);
        const rpgStateHash = String((launched.rpg_session as { state_hash: string }).state_hash);

        const aliasRead = await callPlayerTool(client, "get_observation", {
          rpg_session_id: rpgSessionId,
        });
        expect(aliasRead.state_hash).toBe(rpgStateHash);
        const sameHandleRead = await callPlayerTool(client, "list_legal_actions", {
          session_id: rpgSessionId,
          rpg_session_id: rpgSessionId,
        });
        expect(sameHandleRead.rpg_session_id).toBe(rpgSessionId);

        const beforeRpgConflict = await parentState();
        const rpgConflict = await client.callTool({
          name: "step_action",
          arguments: {
            session_id: rpgSessionId,
            rpg_session_id: "r-conflict",
            action_id: "use_sheltered_stockway_last_mile",
            expected_state_hash: rpgStateHash,
          },
        });
        expect(rpgConflict.isError).toBe(true);
        expect(textPayload(rpgConflict).error).toMatch(/session_id and rpg_session_id conflict/);
        expect(await parentState()).toEqual(beforeRpgConflict);
        const afterConflictRead = await callPlayerTool(client, "get_observation", {
          rpg_session_id: rpgSessionId,
        });
        expect(afterConflictRead.state_hash).toBe(rpgStateHash);

        const wrongDomain = await client.callTool({
          name: "list_legal_actions",
          arguments: { session_id: sessionId },
        });
        expect(wrongDomain.isError).toBe(true);
        expect(textPayload(wrongDomain)).toMatchObject({
          expected_session_field: "rpg_session_id",
          expected_argument: "session_id",
          returned_handle_field: "rpg_session_id",
          overworld_session_id: sessionId,
          rpg_session_id: rpgSessionId,
        });

        const beforeActionAliasConflict = await parentState();
        const actionAliasConflict = await client.callTool({
          name: "step_action",
          arguments: {
            rpg_session_id: rpgSessionId,
            action_id: "use_sheltered_stockway_last_mile",
            action: "look_around",
            expected_state_hash: rpgStateHash,
          },
        });
        expect(actionAliasConflict.isError).toBe(true);
        expect(textPayload(actionAliasConflict).error).toMatch(/action_id and action conflict/);
        expect(await parentState()).toEqual(beforeActionAliasConflict);

        const stepped = await callPlayerTool(client, "step_action", {
          rpg_session_id: rpgSessionId,
          action: "use_sheltered_stockway_last_mile",
          expected_state_hash: rpgStateHash,
        });
        expect(stepped.ok).toBe(true);
        expect(stepped.state_hash).not.toBe(rpgStateHash);
        const afterStepActions = await callPlayerTool(client, "list_legal_actions", {
          rpg_session_id: rpgSessionId,
          compact_actions: true,
        });
        const sameAction = (afterStepActions.actions as string[])[0];
        if (!sameAction) throw new Error("expected a legal post-step RPG action");
        const sameDualAction = await callPlayerTool(client, "step_action", {
          session_id: rpgSessionId,
          rpg_session_id: rpgSessionId,
          action_id: sameAction,
          action: sameAction,
          expected_state_hash: String(afterStepActions.state_hash),
        });
        expect(sameDualAction.ok).toBe(true);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("honors destination-town aliases in pure play without weakening travel exclusivity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-pure-destination-aliases-"));
    try {
      await withPureServer(join(dir, "alias-only.jsonl"), async (client) => {
        const started = await callPlayerTool(client, "start_overworld", {});
        const sessionId = String(started.session_id);
        const parent = { session_id: sessionId };
        const beforePlan = await callPlayerTool(client, "get_overworld_session_context", parent);
        await callPlayerTool(client, "plan_overworld_session_route", {
          ...parent,
          dest_town_id: "colonie_town",
        });
        await callPlayerTool(client, "plan_overworld_session_route", {
          ...parent,
          destination_town_id: "colonie_town",
          dest_town_id: "colonie_town",
        });
        const planConflict = await client.callTool({
          name: "plan_overworld_session_route",
          arguments: {
            ...parent,
            destination_town_id: "colonie_town",
            dest_town_id: "bethlehem_town",
          },
        });
        expect(planConflict.isError).toBe(true);
        expect(textPayload(planConflict).error).toMatch(
          /destination_town_id and dest_town_id conflict/,
        );
        const afterPlan = await callPlayerTool(client, "get_overworld_session_context", parent);
        expect(afterPlan.snapshot_hash).toBe(beforePlan.snapshot_hash);

        const traveled = await callPlayerTool(client, "travel_overworld_session", {
          ...parent,
          dest_town_id: "colonie_town",
        });
        expect(traveled.ok).toBe(true);
        const beforeRoadDestinationConflict = await callPlayerTool(
          client,
          "get_overworld_session_context",
          parent,
        );
        const roadDestinationConflict = await client.callTool({
          name: "travel_overworld_session",
          arguments: {
            ...parent,
            road_id: "road_albany_city__colonie_town",
            dest_town_id: "colonie_town",
          },
        });
        expect(roadDestinationConflict.isError).toBe(true);
        expect(textPayload(roadDestinationConflict).error).toMatch(
          /Pass exactly one: road_id or destination_town_id/,
        );
        const afterRoadDestinationConflict = await callPlayerTool(
          client,
          "get_overworld_session_context",
          parent,
        );
        expect(afterRoadDestinationConflict.snapshot_hash).toBe(
          beforeRoadDestinationConflict.snapshot_hash,
        );
      });

      await withPureServer(join(dir, "same-dual.jsonl"), async (client) => {
        const started = await callPlayerTool(client, "start_overworld", {});
        const traveled = await callPlayerTool(client, "travel_overworld_session", {
          session_id: String(started.session_id),
          destination_town_id: "colonie_town",
          dest_town_id: "colonie_town",
        });
        expect(traveled.ok).toBe(true);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails closed when private pure-evidence provenance is missing or malformed", () => {
    const cases = [
      {
        label: "missing seed",
        args: ["--build-commit", TEST_BUILD_COMMIT, "--tracked-worktree-clean", "true"],
        message: /requires --run-seed/i,
      },
      {
        label: "unsafe seed",
        args: [
          "--run-seed",
          "9007199254740992",
          "--build-commit",
          TEST_BUILD_COMMIT,
          "--tracked-worktree-clean",
          "true",
        ],
        message: /safe integer/i,
      },
      {
        label: "malformed commit",
        args: [
          "--run-seed",
          String(TEST_RUN_SEED),
          "--build-commit",
          "abc",
          "--tracked-worktree-clean",
          "true",
        ],
        message: /40-character lowercase Git commit hash/i,
      },
      {
        label: "malformed clean flag",
        args: [
          "--run-seed",
          String(TEST_RUN_SEED),
          "--build-commit",
          TEST_BUILD_COMMIT,
          "--tracked-worktree-clean",
          "yes",
        ],
        message: /exactly "true" or "false"/i,
      },
    ];
    for (const testCase of cases) {
      const evidence = join(tmpdir(), `mcp-pure-invalid-${testCase.label.replaceAll(" ", "-")}`);
      const result = spawnSync(
        process.execPath,
        [
          TSX,
          "src/mcp/server.ts",
          "--play-mode",
          "pure",
          "--run-evidence",
          evidence,
          ...testCase.args,
        ],
        { cwd: ROOT, encoding: "utf8", timeout: 15_000 },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
      expect(result.status, `${testCase.label}: ${output}`).not.toBe(0);
      expect(output, testCase.label).toMatch(testCase.message);
    }
  }, 60_000);

  it("launches from retained Station context after applying only the V1 reveal delta", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-pure-station-delta-"));
    const evidence = join(dir, "run.jsonl");
    try {
      await withPureServer(evidence, async (client) => {
        const { sessionId, stationed: beforeJune } = await startPureAtOpeningStation(client);
        const noReceiptJune = await callPlayerTool(client, "talk_overworld_session_contact", {
          session_id: sessionId,
          character_id: PURE_STATION_JUNE_CONTACT_ID,
        });
        expect(noReceiptJune).toMatchObject({
          ok: true,
          session_id: sessionId,
          overworld_session_id: sessionId,
          snapshot_hash: expect.any(String),
          context: expect.any(Object),
          journey: {
            storyChoice: {
              id: "albany:wolf_ally_commitment",
              kind: "ally",
            },
          },
        });
        expect(noReceiptJune.snapshot_hash).not.toBe(beforeJune.snapshot_hash);
        expect(noReceiptJune).not.toHaveProperty("station_dispatch_modal");
        await callPlayerTool(client, "choose_overworld_session_story", {
          session_id: sessionId,
          story_choice_id: "albany:wolf_ally_commitment",
          choice: "albany:ally_travel_solo",
          expected_snapshot_hash: noReceiptJune.snapshot_hash,
        });
        const stationed = await callPlayerTool(client, "get_overworld_session_context", {
          session_id: sessionId,
        });
        const retainedJourney = structuredClone(stationed.journey);
        const retainedContext = structuredClone(stationed.context) as {
          quest_starts?: [string, string][];
          station_dispatch_board?: OpeningCompactStationDispatchBoard;
          [key: string]: unknown;
        };
        const hiddenBoard = retainedContext.station_dispatch_board;
        expect(hiddenBoard?.[0]).toBe(6);
        expect(hiddenBoard?.[5]).toEqual([STATION_DISPATCH_SUPPORT_REVEAL_ID, expect.any(String)]);
        const retainedHash = String(stationed.snapshot_hash);
        const revealed = await callPlayerTool(client, "get_overworld_session_context", {
          session_id: sessionId,
          if_snapshot_hash: retainedHash,
          reveal_station_dispatch_support: STATION_DISPATCH_SUPPORT_REVEAL_ID,
        });
        expect(revealed).not.toHaveProperty("journey");
        expect(revealed).not.toHaveProperty("context");
        const delta = revealed.station_dispatch_reveal as {
          version: number;
          base_snapshot_hash: string;
          station_dispatch_board: OpeningCompactStationDispatchBoard;
        };
        expect(delta).toMatchObject({
          version: PURE_STATION_DISPATCH_REVEAL_VERSION,
          base_snapshot_hash: retainedHash,
        });
        expect(delta.station_dispatch_board[0]).toBe(6);
        expect(delta.station_dispatch_board[5]).toBeNull();
        const { station_dispatch_board: _hiddenBoard, ...retainedOtherContext } = retainedContext;
        const appliedContext = {
          ...retainedContext,
          station_dispatch_board: delta.station_dispatch_board,
        };
        const { station_dispatch_board: appliedBoard, ...appliedOtherContext } = appliedContext;
        expect(appliedOtherContext).toEqual(retainedOtherContext);
        expect(appliedBoard).toEqual(delta.station_dispatch_board);
        expect(stationed.journey).toEqual(retainedJourney);

        const launchTuple = retainedContext.quest_starts?.[0];
        if (!launchTuple) throw new Error("expected a retained Station quest-start tuple");
        const [quest_id, approach_id] = launchTuple;
        const launched = await callPlayerTool(client, "start_overworld_session_quest", {
          session_id: sessionId,
          quest_id,
          approach_id,
          expected_snapshot_hash: revealed.snapshot_hash,
        });
        expect(launched).toMatchObject({
          ok: true,
          overworld_session_id: sessionId,
          rpg_session_id: expect.any(String),
        });
        expect((launched.quest as unknown[])[0]).toBe("wolf_winter");
        const afterLaunch = await callPlayerTool(client, "get_overworld_session_context", {
          session_id: sessionId,
        });
        expect(
          (afterLaunch.context as { station_dispatch_board?: unknown }).station_dispatch_board,
        ).toBeUndefined();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps the legal threshold Station reveal below its pure envelope limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-pure-station-threshold-"));
    const evidence = join(dir, "run.jsonl");
    try {
      await withPureServer(evidence, async (client) => {
        const { sessionId, stationed } = await startPureAtOpeningStation(
          client,
          "albany:source_jamie_market_testimony",
        );
        const expectedGuidance =
          "Background, promise, and report are set. Current setup: 20m. Final setup: 20–65m; support can delay dispatch. Optional support remains. Start Wolf-Winter to skip it.";
        const stationedBoard = (
          stationed.context as { station_dispatch_board?: OpeningCompactStationDispatchBoard }
        ).station_dispatch_board;
        expect(stationedBoard?.[2]).toBe(expectedGuidance);
        const revealed = await callPlayerTool(client, "get_overworld_session_context", {
          session_id: sessionId,
          if_snapshot_hash: stationed.snapshot_hash,
          reveal_station_dispatch_support: STATION_DISPATCH_SUPPORT_REVEAL_ID,
        });
        expect(revealed).not.toHaveProperty("journey");
        expect(revealed).not.toHaveProperty("context");
        const delta = revealed.station_dispatch_reveal as {
          version: number;
          base_snapshot_hash: string;
          station_dispatch_board: OpeningCompactStationDispatchBoard;
        };
        expect(delta).toMatchObject({
          version: PURE_STATION_DISPATCH_REVEAL_VERSION,
          base_snapshot_hash: stationed.snapshot_hash,
        });
        expect(delta.station_dispatch_board[2]).toBe(expectedGuidance);
        const revealBytes = Buffer.byteLength(JSON.stringify(revealed), "utf8");
        expect(revealBytes).toBe(1_047);
        expect(revealBytes).toBeLessThanOrEqual(1_100);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps full-mode June talk on the canonical verbose response", async () => {
    await withFullServer(async (client) => {
      const { sessionId, stationed } = await startPureAtOpeningStation(client);
      const revealed = await callPlayerTool(client, "get_overworld_session_context", {
        session_id: sessionId,
        if_snapshot_hash: stationed.snapshot_hash,
        reveal_station_dispatch_support: STATION_DISPATCH_SUPPORT_REVEAL_ID,
      });
      const prepared = await callPlayerTool(client, "choose_overworld_session_story", {
        session_id: sessionId,
        story_choice_id: "albany:wolf_preparation",
        choice: "albany:prep_works_fortification",
        expected_snapshot_hash: revealed.snapshot_hash,
      });
      const fullJune = await callPlayerTool(client, "talk_overworld_session_contact", {
        session_id: sessionId,
        character_id: PURE_STATION_JUNE_CONTACT_ID,
        expected_snapshot_hash: prepared.snapshot_hash,
      });
      expect(Object.keys(fullJune).sort()).toEqual(
        [
          "journey",
          "journeyDecision",
          "legend_delta",
          "ok",
          "result",
          "session_id",
          "snapshot_hash",
          "context",
        ].sort(),
      );
      expect(fullJune).toMatchObject({
        ok: true,
        session_id: sessionId,
        snapshot_hash: expect.any(String),
        journey: { storyChoice: { id: "albany:wolf_ally_commitment", kind: "ally" } },
        journeyDecision: { countsTowardJourney: true, reason: "substantive_dialogue" },
        context: expect.any(Object),
        result: expect.any(Object),
      });
      expect(fullJune.legend_delta).toEqual({
        departure_recap: OVERWORLD_COMPACT_LEGEND.departure_recap,
      });
      expect(fullJune).not.toHaveProperty("overworld_session_id");
      expect(fullJune).not.toHaveProperty("station_dispatch_modal");
      const fullJuneText = JSON.stringify(fullJune);
      const preparedDispatchStatus =
        "Background, promise, and report are set. Current setup: 30m. Final setup: 30–50m; all on time. Optional support remains. Start Wolf-Winter to skip it.";
      const fullJuneSummaries = stringsContaining(fullJune, preparedDispatchStatus);
      expect(fullJuneSummaries).toHaveLength(2);
      expect(fullJuneSummaries.every((summary) => summary.startsWith(preparedDispatchStatus))).toBe(
        true,
      );
      expect(fullJuneText.split(preparedDispatchStatus)).toHaveLength(3);
      expect(fullJuneText).not.toContain("optional Station support remains");
      // bug_0614: the exposed-ridge route summary grew when it stopped claiming cattle
      // alarm starts at 1 (it doesn't; descending raises it to 1).
      expect(Buffer.byteLength(fullJuneText, "utf8")).toBe(7_875);
    });
  }, 120_000);

  it("advertises only player tools and records exactly one fresh overworld start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-pure-"));
    const evidence = join(dir, "run.jsonl");
    try {
      let sessionId = "";
      await withPureServer(evidence, async (client) => {
        const listed = await client.listTools();
        expect(new Set(listed.tools.map((tool) => tool.name))).toEqual(PURE_PLAYER_TOOLS);
        const pureCatalogProjection = listed.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: Object.fromEntries(
            Object.entries(tool.inputSchema).filter(([key]) => key !== "$schema"),
          ),
        }));
        const pureCatalogBytes = Buffer.byteLength(JSON.stringify(pureCatalogProjection), "utf8");
        // Frozen first-contact accounting, in UTF-8 bytes: the prompt template, the
        // fresh compact context, and this catalogue are everything a blind player is
        // handed before its first action, and 34_868 is the ceiling that budget may
        // not cross.
        //
        // 2026-08-28: inspect_overworld_session_story used to publish `{}` for its
        // whole input schema — a `z.object().refine()` handed to registerTool where a
        // ZodRawShape was expected — so it advertised no arguments at all. Publishing
        // its five real properties costs 749 bytes; 371 came back by deleting the
        // prose description that had been standing in for the missing schema, and the
        // rest from two parameter descriptions the schema now states machine-readably
        // (`not: {required: [option_id, reveal_id]}` replaces "not both"). Net +332,
        // which is why the headroom below is 36 bytes rather than the old 368.
        expect(pureCatalogBytes).toBe(17_079);
        expect(15_720 + 2_042 + pureCatalogBytes).toBe(34_841);
        expect(15_720 + 2_042 + pureCatalogBytes).toBeLessThanOrEqual(34_868);
        for (const tool of listed.tools) {
          expect(
            validPureMcpToolCatalogEntry({ name: tool.name }),
            `redacted catalogue entry must not authenticate ${tool.name}`,
          ).toBe(false);
          expect(
            validPureMcpToolCatalogEntry({
              name: tool.name,
              description: tool.description,
              input_schema: Object.fromEntries(
                Object.entries(tool.inputSchema).filter(([key]) => key !== "$schema"),
              ),
            }),
            `pure MCP catalogue digest drifted for ${tool.name}`,
          ).toBe(true);
        }
        expect(listed.tools.map((tool) => tool.name)).not.toEqual(
          expect.arrayContaining([
            "list_overworld",
            "restore_overworld_session",
            "start_world_quest",
            "complete_overworld_session_quest",
          ]),
        );

        const contextTool = listed.tools.find(
          (tool) => tool.name === "get_overworld_session_context",
        );
        expect(contextTool?.description).toBe(
          "Read current compact context without acting. A Station reveal returns only its new fields.",
        );
        expect(contextTool?.inputSchema.properties).toHaveProperty(
          "include_departure_recap_terms",
          expect.objectContaining({
            type: "boolean",
            description: "Include the full terms of the selected plan.",
          }),
        );
        expect(contextTool?.inputSchema.properties).toHaveProperty(
          "reveal_station_dispatch_support",
          expect.objectContaining({
            type: "string",
            description: "Station board[5] reveal id. Also pass the latest if_snapshot_hash.",
          }),
        );

        const storyChoiceTool = listed.tools.find(
          (tool) => tool.name === "choose_overworld_session_story",
        );
        expect(storyChoiceTool).toBeDefined();
        const storyChoiceProperties = storyChoiceTool?.inputSchema.properties as
          | Record<string, { description?: unknown; enum?: unknown; type?: unknown }>
          | undefined;
        expect(storyChoiceProperties?.choice).toMatchObject({
          type: "string",
          description: "Exact visible option id. Departure story id is inferred.",
        });
        expect(storyChoiceProperties?.story_choice_id).toMatchObject({
          type: "string",
          description: "Story id required for Station support.",
        });
        expect(storyChoiceProperties?.choice).not.toHaveProperty("enum");
        expect(JSON.stringify(storyChoiceTool)).not.toMatch(
          /targetQuestId|endingId|ending_held|wolf_winter|content\/rpg|win_conditions|maneuver_/i,
        );
        expect(JSON.stringify(storyChoiceTool)).not.toMatch(
          /send_wagon_to_cade|send_wardens_north|keep_household_correction|publish_dosage_warning|advocate|cold_forge|Edric|Godwin|wormwood|public scrutiny|family's trust/i,
        );

        const observationTool = listed.tools.find((tool) => tool.name === "get_observation");
        expect(observationTool?.inputSchema.properties).toHaveProperty(
          "include_character_continuity",
          expect.objectContaining({
            type: "boolean",
            description: "Include the embedded quest's character continuity.",
          }),
        );

        const goalPassageTool = listed.tools.find(
          (tool) => tool.name === "follow_overworld_session_goal",
        );
        expect(goalPassageTool).toBeDefined();
        const goalPassageProperties = goalPassageTool?.inputSchema.properties as
          | Record<string, unknown>
          | undefined;
        expect(goalPassageTool?.inputSchema.required ?? []).not.toContain("session_id");
        expect(goalPassageProperties).toHaveProperty("session_id");
        expect(
          (goalPassageProperties?.session_id as { description?: string } | undefined)?.description,
        ).toBe("Parent overworld_session_id. Do not use rpg_session_id.");
        expect(goalPassageProperties).toHaveProperty("expected_snapshot_hash");
        expect(goalPassageProperties).not.toHaveProperty("destination_town_id");
        expect(goalPassageProperties).not.toHaveProperty("road_id");
        expect(goalPassageProperties).not.toHaveProperty("choice");
        expect(JSON.stringify(goalPassageTool)).not.toMatch(
          /targetQuestId|targetTownId|targetAreaId|endingId|wolf_winter|gallowmere|content\/rpg|win_conditions|maneuver_/i,
        );

        const beforeStart = await client.callTool({
          name: "get_overworld_session_context",
          arguments: {},
        });
        expect(beforeStart.isError).toBe(true);
        const beforeStartPayload = textPayload(beforeStart);
        expect(beforeStartPayload).toMatchObject({
          ok: false,
          error: "Start pure play with start_overworld.",
        });
        expect(beforeStartPayload).not.toHaveProperty("expected_session_field");
        expect(beforeStartPayload).not.toHaveProperty("overworld_session_id");
        expect(beforeStartPayload).not.toHaveProperty("rpg_session_id");

        const started = await client.callTool({
          name: "start_overworld",
          arguments: {},
        });
        const payload = textPayload(started);
        sessionId = String(payload.session_id);
        expect(payload.overworld_session_id).toBe(sessionId);
        expect(sessionId).toMatch(
          /^o-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );

        const invalidStoryChoice = await client.callTool({
          name: "choose_overworld_session_story",
          arguments: { session_id: sessionId, choice: "not-a-visible-choice" },
        });
        expect(invalidStoryChoice.isError).toBe(true);
        expect((invalidStoryChoice.content as unknown[])[0]).toMatchObject({
          type: "text",
          text: expect.stringMatching(
            /no story consequence|no presented story consequence|requires story_choice_id/i,
          ),
        });

        const second = await client.callTool({
          name: "start_overworld",
          arguments: {},
        });
        expect(second.isError).toBe(true);
        const recovery = textPayload(second);
        expect(recovery).toMatchObject({
          ok: false,
          error:
            "Pure play allows one new overworld session. Continue with the recovered overworld_session_id.",
          expected_session_field: "overworld_session_id",
          overworld_session_id: sessionId,
        });
        const recoveredRead = await client.callTool({
          name: "get_overworld_session_context",
          arguments: {
            session_id: recovery.overworld_session_id,
            include_departure_recap_terms: true,
          },
        });
        expect(recoveredRead.isError).not.toBe(true);
        expect(textPayload(recoveredRead).overworld_session_id).toBe(sessionId);
      });

      const lines = readFileSync(evidence, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toEqual([
        expect.objectContaining({
          schema_version: 2,
          play_mode: "pure",
          event: "fresh_start",
          start_surface: "fresh_overworld",
          session_id: sessionId,
          run_seed: TEST_RUN_SEED,
          build: {
            git_commit: TEST_BUILD_COMMIT,
            tracked_worktree_clean: true,
            world_id: "new_york_overworld",
            world_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("does not advertise or honor QA-only quest graph and seed overrides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-pure-visibility-"));
    const evidence = join(dir, "run.jsonl");
    type AreaView = {
      pois: { id: string }[];
      characters: { id: string }[];
      areaExits: { id: string; destination: { id: string } }[];
      quests: { id: string; area: string }[];
    };
    type CompactAreaContext = {
      character?: OverworldCompactCampaignCharacter;
      poi?: [string, string][];
      contacts?: [string, string][];
      area_routes?: [string, string, number][];
      quests?: [string, string, string, unknown?][];
      quest_starts?: [string, string][];
      departure_contact_leads?: [
        string,
        "ally",
        string,
        "requires_preparation" | "ready",
        string,
        string,
        string,
        string,
        string,
      ][];
      departure_recap?: unknown;
      departure_recap_terms?: unknown;
      station_dispatch_board?: OpeningCompactStationDispatchBoard;
      station_dispatch_support?: readonly OpeningCompactStationDispatchBoardSupport[];
    };
    type RpgObservation = {
      exits: { direction: string; to?: string }[];
      available_actions: { id: string; command?: string }[];
      dialogue: { npc: string; npc_text: string } | null;
      state: { flags: string[]; vars: Record<string, number>; journal: string[] };
    };
    type RpgCompactContext = {
      actions?: string[];
      choices?: [string, string][];
      dialogue?: [string, string];
    };
    const areaView = (payload: Record<string, unknown>): AreaView => {
      const context = payload.context as CompactAreaContext;
      return {
        pois: (context.poi ?? []).map(([id]) => ({ id })),
        characters: (context.contacts ?? []).map(([id]) => ({ id })),
        areaExits: (context.area_routes ?? []).map(([id, destination]) => ({
          id,
          destination: { id: destination },
        })),
        quests: (context.quests ?? []).map(([id, _title, area]) => ({ id, area })),
      };
    };
    const expectJuneCattleFirst = (payload: Record<string, unknown>): void => {
      const character = (payload.context as CompactAreaContext).character;
      if (!character) throw new Error("expected compact campaign character state");
      const [, , , , , , , , , promises, companions] = character;
      expect(companions).toEqual(["albany:june_pike"]);
      expect(promises).toContainEqual([
        "albany:promise_june_cattle_first",
        "albany:june_pike",
        "active",
      ]);
    };
    try {
      await withPureServer(evidence, async (client) => {
        const listed = await client.listTools();
        for (const name of [
          "start_overworld_session_quest",
          "choose_overworld_session_journey",
          "get_observation",
          "step_action",
        ]) {
          const registered = listed.tools.find((candidate) => candidate.name === name);
          expect(registered).toBeDefined();
          const properties = registered?.inputSchema.properties ?? {};
          expect(properties).not.toHaveProperty("hide_graph");
          expect(properties).toHaveProperty("include_actions");
        }
        const questStartSchema = listed.tools.find(
          (candidate) => candidate.name === "start_overworld_session_quest",
        )?.inputSchema.properties;
        expect(questStartSchema).not.toHaveProperty("seed");
        expect(JSON.stringify(listed.tools)).not.toMatch(
          /run_seed|build_commit|tracked_worktree_clean|quest_outcomes/i,
        );
        const legalActionSchema = listed.tools.find(
          (candidate) => candidate.name === "list_legal_actions",
        )?.inputSchema.properties as Record<string, { description?: string }> | undefined;
        expect(legalActionSchema?.compact_actions?.description).toMatch(
          /Set true for action ids without labels[^]*default includes labels/i,
        );
        expect(legalActionSchema?.session_id?.description).toMatch(
          /Child rpg_session_id[^]*Do not use overworld_session_id/i,
        );
        const storyInspectionTool = listed.tools.find(
          (candidate) => candidate.name === "inspect_overworld_session_story",
        );
        expect(storyInspectionTool?.description).toBe(PARENT_BOUND_STORY_INSPECTION_DESCRIPTION);
        // Pure keeps the parent handle schema-optional only so omission reaches the
        // authoritative recovery envelope instead of failing at transport validation.
        expect(storyInspectionTool?.inputSchema.required ?? []).not.toContain("session_id");

        const started = textPayload(
          await client.callTool({
            name: "start_overworld",
            arguments: {},
          }),
        );
        const sessionId = String(started.session_id);
        const cumulativeLegend: Record<string, string> = {};
        mergeLegendAndExpectContextCoverage(cumulativeLegend, started, "fresh start");
        expect(started.overworld_session_id).toBe(sessionId);
        expect(started.legend as Record<string, string>).not.toHaveProperty(
          "departure_contact_leads",
        );
        let view = areaView(started);
        const openingPoi = view.pois[0]?.id;
        if (!openingPoi) throw new Error("expected opening Albany point of interest");

        const openingScout = textPayload(
          await client.callTool({
            name: "scout_overworld_session_poi",
            arguments: {
              session_id: sessionId,
              poi_id: openingPoi,
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        mergeLegendAndExpectContextCoverage(cumulativeLegend, openingScout, "opening scout");
        view = areaView(openingScout);
        const rowan = view.characters[0];
        if (!rowan) throw new Error("expected Albany registration contact");
        const registration = textPayload(
          await client.callTool({
            name: "talk_overworld_session_contact",
            arguments: {
              session_id: sessionId,
              character_id: rowan.id,
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        mergeLegendAndExpectContextCoverage(cumulativeLegend, registration, "registration");
        const registrationChoice = (
          registration.journey as {
            storyChoice?: {
              kind?: string;
              message?: string;
              options?: {
                id: string;
                group?: string;
                consequence?: string;
                summary?: { tradeoff?: string };
              }[];
            };
          }
        ).storyChoice;
        expect(registrationChoice?.kind).toBe("registration");
        expect(registrationChoice?.message).toContain("Choose one permanent background.");
        expect(JSON.stringify(registrationChoice?.options)).not.toMatch(
          /\b(?:DEF|import|fieldTrigger)\b/i,
        );
        expect(
          registrationChoice?.options?.every(
            (option) => option.consequence === "" && typeof option.summary?.tradeoff === "string",
          ),
        ).toBe(true);
        expect(registrationChoice?.message).toContain(JOURNEY_STORY_CHOICE_REVIEW_INSTRUCTION);
        const ironhandsRepairer = registrationChoice?.options?.find(
          (option) => option.id === "albany:ironhands_repairer",
        );
        if (!ironhandsRepairer) throw new Error("expected visible Ironhands Repairer profile");
        const registrationJourney = registration.journey;
        const registrationJourneyBytes = JSON.stringify(registrationJourney);
        const missingParentInspection = await client.callTool({
          name: "inspect_overworld_session_story",
          arguments: { story_choice_id: "albany:relief_registration" },
        });
        expect(missingParentInspection.isError).toBe(true);
        expect(textPayload(missingParentInspection)).toMatchObject({
          ok: false,
          error:
            "Pass the current parent overworld_session_id. The supplied session_id is missing, invalid, stale, or unknown.",
          expected_session_field: "overworld_session_id",
          expected_argument: "session_id",
          returned_handle_field: "overworld_session_id",
          overworld_session_id: sessionId,
        });
        const afterMissingParentInspection = textPayload(
          await client.callTool({
            name: "get_overworld_session_context",
            arguments: { session_id: sessionId },
          }),
        );
        expect(afterMissingParentInspection.snapshot_hash).toBe(registration.snapshot_hash);
        expect(afterMissingParentInspection.journey).toEqual(registrationJourney);
        expect(JSON.stringify(afterMissingParentInspection.journey)).toBe(registrationJourneyBytes);

        const exactParentInspection = textPayload(
          await client.callTool({
            name: "inspect_overworld_session_story",
            arguments: {
              session_id: sessionId,
              story_choice_id: "albany:relief_registration",
            },
          }),
        );
        expectPureStoryInspectionEnvelope(exactParentInspection, sessionId);
        expect(exactParentInspection.snapshot_hash).toBe(registration.snapshot_hash);
        expect(exactParentInspection.story).toMatchObject({
          id: "albany:relief_registration",
          inspectedOption: null,
        });
        for (const optionId of [undefined, ironhandsRepairer.id] as const) {
          const staleInspection = textPayload(
            await client.callTool({
              name: "inspect_overworld_session_story",
              arguments: {
                session_id: sessionId,
                story_choice_id: "albany:relief_registration",
                ...(optionId === undefined ? {} : { option_id: optionId }),
                expected_snapshot_hash: "0".repeat(24),
              },
            }),
          );
          expect(staleInspection).toMatchObject({
            ok: false,
            snapshot_hash: registration.snapshot_hash,
            rejection_reason:
              "The overworld state changed since your last read. Refresh with get_overworld_session_context.",
            overworld_session_id: sessionId,
          });
          expect(staleInspection).not.toHaveProperty("story");
        }
        const registrationInspection = textPayload(
          await client.callTool({
            name: "inspect_overworld_session_story",
            arguments: {
              session_id: sessionId,
              story_choice_id: "albany:relief_registration",
              option_id: ironhandsRepairer.id,
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        expectPureStoryInspectionEnvelope(registrationInspection, sessionId);
        expect(registrationInspection.snapshot_hash).toBe(registration.snapshot_hash);
        const registrationDetail = registrationInspection.story as Record<string, unknown> & {
          inspectedOption?: Record<string, unknown>;
        };
        expect(Object.keys(registrationDetail).sort()).toEqual(
          ["comparisonVersion", "id", "inspectedOption", "kind"].sort(),
        );
        expect(registrationDetail.comparisonVersion).toBe(JOURNEY_STORY_CHOICE_COMPARISON_VERSION);
        expect(registrationDetail).not.toHaveProperty("message");
        expect(registrationDetail).not.toHaveProperty("options");
        expect(registrationDetail.inspectedOption).toMatchObject({
          id: ironhandsRepairer.id,
        });
        expect(Object.keys(registrationDetail.inspectedOption ?? {}).sort()).toEqual(
          ["consequence", "id", "label"].sort(),
        );
        const wolfBeforeSource = areaView(registration).quests.find(
          (quest) => quest.id === "wolf_winter",
        );
        expect(wolfBeforeSource).toBeUndefined();
        const selected = textPayload(
          await client.callTool({
            name: "choose_overworld_session_story",
            arguments: {
              session_id: sessionId,
              choice: ironhandsRepairer.id,
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        mergeLegendAndExpectContextCoverage(cumulativeLegend, selected, "profile selection");
        const oathChoice = (
          selected.journey as {
            storyChoice?: {
              kind?: string;
              message?: string;
              options?: { id: string; consequence?: string; summary?: { tradeoff?: string } }[];
              revealOption?: {
                id: string;
                arguments: { story_choice_id: string; reveal_id: string };
              };
            };
          }
        ).storyChoice;
        expect(oathChoice?.kind).toBe("relief_oath");
        const defaultCivicMessages = [registrationChoice?.message, oathChoice?.message].join(" ");
        expect(defaultCivicMessages).not.toMatch(/\b[12]\/3\b/);
        expect(defaultCivicMessages).not.toMatch(/Civic order/i);
        expect(defaultCivicMessages).not.toMatch(/role\s*→\s*duty\s*→\s*evidence/i);
        expect(defaultCivicMessages).not.toMatch(/June Pike|second field seat/i);
        expect(oathChoice?.message).toBe(
          `The Wolf-Winter: use a ready-made promise and report or choose them separately. Every approach stays open. ${JOURNEY_STORY_CHOICE_REVIEW_INSTRUCTION}`,
        );
        expect(
          oathChoice?.options?.every(
            (option) => option.consequence === "" && typeof option.summary?.tradeoff === "string",
          ),
        ).toBe(true);
        expect(oathChoice?.message).toContain(JOURNEY_STORY_CHOICE_REVIEW_INSTRUCTION);
        expect(oathChoice?.options?.map((option) => option.id)).toEqual([
          "albany:doctrine_fortify_breach",
        ]);
        expect(JSON.stringify(oathChoice)).not.toContain("albany:oath_limited_aid_only");
        const matchedShortcut = oathChoice?.options?.[0];
        if (!matchedShortcut) throw new Error("expected the sole ready-made dispatch");
        const matchedShortcutInspection = textPayload(
          await client.callTool({
            name: "inspect_overworld_session_story",
            arguments: {
              session_id: sessionId,
              story_choice_id: "albany:wolf_relief_oath",
              option_id: matchedShortcut.id,
              expected_snapshot_hash: selected.snapshot_hash,
            },
          }),
        );
        expectPureStoryInspectionEnvelope(matchedShortcutInspection, sessionId);
        expect(matchedShortcutInspection.snapshot_hash).toBe(selected.snapshot_hash);
        expect(matchedShortcutInspection.story).toMatchObject({
          id: "albany:wolf_relief_oath",
          inspectedOption: {
            id: matchedShortcut.id,
            consequence: expect.any(String),
          },
        });
        const reveal = oathChoice?.revealOption;
        if (!reveal) throw new Error("expected pure compact oath reveal affordance");
        const mutuallyExclusiveInspection = await client.callTool({
          name: "inspect_overworld_session_story",
          arguments: {
            session_id: sessionId,
            ...reveal.arguments,
            option_id: matchedShortcut.id,
          },
        });
        expect(mutuallyExclusiveInspection.isError).toBe(true);
        expect(textResult(mutuallyExclusiveInspection)).toMatch(
          /option_id and reveal_id are mutually exclusive/i,
        );
        const afterMutuallyExclusiveInspection = textPayload(
          await client.callTool({
            name: "get_overworld_session_context",
            arguments: { session_id: sessionId },
          }),
        );
        expect(afterMutuallyExclusiveInspection.snapshot_hash).toBe(selected.snapshot_hash);
        expect(afterMutuallyExclusiveInspection.journey).toEqual(selected.journey);
        const expandedOath = textPayload(
          await client.callTool({
            name: "inspect_overworld_session_story",
            arguments: {
              session_id: sessionId,
              ...reveal.arguments,
            },
          }),
        );
        expectPureStoryInspectionEnvelope(expandedOath, sessionId);
        // Opening the reveal is recorded in the session, so it moves the hash: the gate
        // that gives duty selection its legality reads that receipt, and legality here
        // is a function of state. Read-only in the sense that matters — no decision is
        // accepted and no goal advances — but not invisible to the snapshot, or a
        // restore would silently revoke a gate the player had already satisfied.
        expect(expandedOath.snapshot_hash).not.toBe(selected.snapshot_hash);
        const limitedOath = (
          expandedOath.story as {
            options?: { id: string; consequence?: string; summary?: { tradeoff?: string } }[];
            revealOption?: unknown;
          }
        ).options?.find((option) => option.id === "albany:oath_limited_aid_only");
        expect(expandedOath.story as Record<string, unknown>).not.toHaveProperty("revealOption");
        if (!limitedOath) throw new Error("expected visible limited aid-only oath");
        const oathed = textPayload(
          await client.callTool({
            name: "choose_overworld_session_story",
            arguments: {
              session_id: sessionId,
              choice: limitedOath.id,
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        mergeLegendAndExpectContextCoverage(cumulativeLegend, oathed, "relief oath");
        const sourceChoice = (
          oathed.journey as {
            storyChoice?: {
              kind?: string;
              options?: { id: string; consequence?: string; summary?: { tradeoff?: string } }[];
            };
          }
        ).storyChoice;
        expect(sourceChoice?.kind).toBe("lead_source");
        expect(
          sourceChoice?.options?.every(
            (option) => option.consequence === "" && typeof option.summary?.tradeoff === "string",
          ),
        ).toBe(true);
        const rowanDocket = sourceChoice?.options?.find(
          (option) => option.id === "albany:source_rowan_civic_docket",
        );
        if (!rowanDocket) throw new Error("expected visible Rowan civic-docket source");
        const sourced = textPayload(
          await client.callTool({
            name: "choose_overworld_session_story",
            arguments: {
              session_id: sessionId,
              choice: rowanDocket.id,
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        mergeLegendAndExpectContextCoverage(cumulativeLegend, sourced, "lead source");
        expect(
          (
            sourced.journey as {
              storyChoice?: { kind?: string };
            }
          ).storyChoice,
        ).toBeNull();
        expect(areaView(sourced).quests.map((quest) => quest.id)).toContain("wolf_winter");
        const preparationRoute = areaView(sourced).areaExits.find(
          (route) => route.destination.id === "albany_city__transport_hub",
        );
        if (!preparationRoute) throw new Error("expected route to Albany Station Quarter");
        const stationed = textPayload(
          await client.callTool({
            name: "move_overworld_session_area",
            arguments: {
              session_id: sessionId,
              area_route_id: preparationRoute.id,
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        mergeLegendAndExpectContextCoverage(cumulativeLegend, stationed, "Station");
        expect((stationed.journey as { storyChoice?: unknown }).storyChoice).toBeNull();
        const stationLegend = (stationed.legend_delta as Record<string, string>)
          .station_dispatch_board;
        expect(stationLegend).toContain(
          "[6,quest_id,dispatch_status,dispatch|null,rows,overview|null]",
        );
        expect(stationLegend).toContain(
          "dispatch=[state,minutes,timing|null,remaining_optional_count]",
        );
        expect(stationLegend).toContain(
          "row=[slot,status,selected_title|null,purpose|null,action|null]",
        );
        expect(stationLegend).toContain(
          "role/duty/evidence/preparation/relief_allocation/field_team=",
        );
        expect(stationLegend).toContain("=background/promise/report/kit/wagon/rider.");
        expect(stationLegend).toContain(
          "Before review, overview lists open kit, wagon, and rider categories.",
        );
        expect(stationLegend).toContain(
          "Call get-context with reveal_station_dispatch_support set to its exact id.",
        );
        expect(stationLegend).toContain("Returned rows give inspect or talk actions.");
        expect(stationLegend).toContain("Support is optional and chooses no strategy.");
        expect(JSON.stringify(cumulativeLegend).length).toBeLessThanOrEqual(7_200);
        const stationedContext = stationed.context as CompactAreaContext;
        expect(stationedContext.departure_contact_leads).toBeUndefined();
        expect(stationedContext.departure_recap).toBeUndefined();
        const stationedBoard = stationedContext.station_dispatch_board;
        expect(stationedBoard?.slice(0, 2)).toEqual([6, "wolf_winter"]);
        const stationedGuidance = stationedBoard?.[2];
        expect(stationedGuidance).toBe(
          "Background, promise, and report are set. Current setup: 5m. Final setup: 5–55m; all on time. Optional support remains. Start Wolf-Winter to skip it.",
        );
        expect(stationedBoard?.[3]).toEqual(["committed", 5, null, 3]);
        expect(stationedBoard?.[4].map(([slot]) => slot)).toEqual(["role", "duty", "evidence"]);
        expect(stationedBoard?.[4].every((row) => row[3] === null && row[4] === null)).toBe(true);
        expect(stationedBoard?.[5]).toEqual([
          STATION_DISPATCH_SUPPORT_REVEAL_ID,
          "Optional: a field kit using Repair, Streetwise, or Mediation; plus Albany's last relief wagon or June as a cattle-safety rider. Review only what interests you.",
        ]);
        const hiddenStationJson = JSON.stringify(stationedBoard);
        expect(hiddenStationJson).not.toContain("albany:wolf_preparation");
        expect(hiddenStationJson).not.toContain("albany:wolf_relief_allocation");
        expect(hiddenStationJson).not.toContain("albany_city__transport_hub__june_pike");
        expect((stationed.context as CompactAreaContext).quest_starts).toContainEqual([
          "wolf_winter",
          expect.any(String),
        ]);
        expect(stationedContext.station_dispatch_support).toBeUndefined();
        const supportReview = textPayload(
          await client.callTool({
            name: "get_overworld_session_context",
            arguments: {
              session_id: sessionId,
              if_snapshot_hash: stationed.snapshot_hash,
              include_station_dispatch_support: true,
            },
          }),
        );
        expect(supportReview.unchanged).toBeUndefined();
        const supportContext = supportReview.context as CompactAreaContext;
        expect(supportReview.snapshot_hash).toBe(stationed.snapshot_hash);
        expect(supportReview.journey).toEqual(stationed.journey);
        expect(supportContext.station_dispatch_board).toEqual(stationedBoard);
        expect(supportContext.station_dispatch_support).toEqual([
          ["preparation", expect.any(String), ["inspect", "albany:wolf_preparation"]],
          ["relief_allocation", expect.any(String), ["inspect", "albany:wolf_relief_allocation"]],
          [
            "field_team",
            expect.any(String),
            ["talk", "albany_city__transport_hub__june_pike", "June Pike"],
          ],
        ]);
        expect(
          (supportReview.legend_delta as Record<string, string>).station_dispatch_support,
        ).toBe(
          "[[support_slot,purpose,action|null],...] optional Station support. preparation=field kit, relief_allocation=relief wagon, field_team=second rider. action is ['inspect',story_choice_id] or ['talk',character_id,contact_name]. Support changes dispatch cost or aftermath, not the available Wolf-Winter strategies.",
        );
        const missingRevealBase = await client.callTool({
          name: "get_overworld_session_context",
          arguments: {
            session_id: sessionId,
            reveal_station_dispatch_support: STATION_DISPATCH_SUPPORT_REVEAL_ID,
          },
        });
        expect(missingRevealBase.isError).toBe(true);
        expect(textPayload(missingRevealBase).error).toBe(
          "Also pass if_snapshot_hash from the latest compact context.",
        );
        const staleRevealBase = await client.callTool({
          name: "get_overworld_session_context",
          arguments: {
            session_id: sessionId,
            if_snapshot_hash: "0".repeat(24),
            reveal_station_dispatch_support: STATION_DISPATCH_SUPPORT_REVEAL_ID,
          },
        });
        expect(staleRevealBase.isError).toBe(true);
        expect(textPayload(staleRevealBase).error).toBe(
          "The snapshot changed. Read a new compact context, then reveal again.",
        );
        const afterRejectedReveal = textPayload(
          await client.callTool({
            name: "get_overworld_session_context",
            arguments: { session_id: sessionId },
          }),
        );
        expect(afterRejectedReveal.snapshot_hash).toBe(stationed.snapshot_hash);
        expect((afterRejectedReveal.context as CompactAreaContext).station_dispatch_board).toEqual(
          stationedBoard,
        );
        const revealed = textPayload(
          await client.callTool({
            name: "get_overworld_session_context",
            arguments: {
              session_id: sessionId,
              if_snapshot_hash: stationed.snapshot_hash,
              reveal_station_dispatch_support: STATION_DISPATCH_SUPPORT_REVEAL_ID,
            },
          }),
        );
        expect(Object.keys(revealed).sort()).toEqual(
          ["ok", "overworld_session_id", "snapshot_hash", "station_dispatch_reveal"].sort(),
        );
        expect(revealed).toMatchObject({
          ok: true,
          overworld_session_id: sessionId,
          snapshot_hash: expect.any(String),
        });
        expect(revealed).not.toHaveProperty("session_id");
        expect(revealed).not.toHaveProperty("unchanged");
        expect(revealed).not.toHaveProperty("journey");
        expect(revealed).not.toHaveProperty("context");
        expect(revealed).not.toHaveProperty("legend_delta");
        expect(revealed.snapshot_hash).not.toBe(stationed.snapshot_hash);
        const stationDispatchReveal = revealed.station_dispatch_reveal as {
          version: number;
          base_snapshot_hash: string;
          station_dispatch_board: OpeningCompactStationDispatchBoard;
        };
        expect(Object.keys(stationDispatchReveal).sort()).toEqual(
          ["version", "base_snapshot_hash", "station_dispatch_board"].sort(),
        );
        expect(stationDispatchReveal.version).toBe(PURE_STATION_DISPATCH_REVEAL_VERSION);
        expect(stationDispatchReveal.base_snapshot_hash).toBe(stationed.snapshot_hash);
        const revealedBoard = stationDispatchReveal.station_dispatch_board;
        expect(revealedBoard).toHaveLength(6);
        expect(revealedBoard?.[0]).toBe(6);
        expect(revealedBoard?.[3]).toEqual(["committed", 5, null, 3]);
        expect(revealedBoard?.[5]).toBeNull();
        expect(revealedBoard?.[4]).toEqual(
          expect.arrayContaining([
            [
              "preparation",
              "open_optional",
              null,
              "Optional field kit: helps with one specific danger.",
              ["inspect", "albany:wolf_preparation"],
            ],
            [
              "relief_allocation",
              "open_optional",
              null,
              "Optional wagon: support one need; leave two unsupported.",
              ["inspect", "albany:wolf_relief_allocation"],
            ],
            [
              "field_team",
              "open_optional",
              null,
              "Optional rider: June helps cattle safety, never combat.",
              ["talk", "albany_city__transport_hub__june_pike", "June Pike"],
            ],
          ]),
        );
        const revealReceiptBytes = Buffer.byteLength(JSON.stringify(revealed), "utf8");
        expect(revealReceiptBytes).toBe(1_025);
        expect(revealReceiptBytes).toBeLessThanOrEqual(1_100);
        const repeatedReveal = textPayload(
          await client.callTool({
            name: "get_overworld_session_context",
            arguments: {
              session_id: sessionId,
              if_snapshot_hash: revealed.snapshot_hash,
              reveal_station_dispatch_support: STATION_DISPATCH_SUPPORT_REVEAL_ID,
              include_departure_recap_terms: false,
              include_station_dispatch_support: false,
            },
          }),
        );
        expect(repeatedReveal.snapshot_hash).toBe(revealed.snapshot_hash);
        expect(repeatedReveal).not.toHaveProperty("journey");
        expect(repeatedReveal).not.toHaveProperty("context");
        expect(repeatedReveal.station_dispatch_reveal).toEqual({
          version: PURE_STATION_DISPATCH_REVEAL_VERSION,
          base_snapshot_hash: revealed.snapshot_hash,
          station_dispatch_board: revealedBoard,
        });
        const refreshedReveal = textPayload(
          await client.callTool({
            name: "get_overworld_session_context",
            arguments: { session_id: sessionId },
          }),
        );
        expect(refreshedReveal.snapshot_hash).toBe(revealed.snapshot_hash);
        expect((refreshedReveal.context as CompactAreaContext).station_dispatch_board).toEqual(
          revealedBoard,
        );
        expect(refreshedReveal.journey).toEqual(stationed.journey);
        expect((refreshedReveal.context as CompactAreaContext).quest_starts).toEqual(
          stationedContext.quest_starts,
        );
        const forgedReveal = await client.callTool({
          name: "get_overworld_session_context",
          arguments: {
            session_id: sessionId,
            if_snapshot_hash: revealed.snapshot_hash,
            reveal_station_dispatch_support: "forged:station-support",
          },
        });
        expect(forgedReveal.isError).toBe(true);
        expect(textResult(forgedReveal)).toMatch(/Unknown Station optional-support reveal/i);
        const afterForgery = textPayload(
          await client.callTool({
            name: "get_overworld_session_context",
            arguments: { session_id: sessionId },
          }),
        );
        expect(afterForgery.snapshot_hash).toBe(revealed.snapshot_hash);
        expect((afterForgery.context as CompactAreaContext).station_dispatch_board).toEqual(
          revealedBoard,
        );
        const directPreparationAction = revealedBoard?.[4].find(
          ([slot]) => slot === "preparation",
        )?.[4];
        if (directPreparationAction?.[0] !== "inspect") {
          throw new Error("expected an authenticated revealed preparation row");
        }
        const directInspection = textPayload(
          await client.callTool({
            name: "inspect_overworld_session_story",
            arguments: {
              session_id: sessionId,
              story_choice_id: directPreparationAction[1],
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        expectPureStoryInspectionEnvelope(directInspection, sessionId);
        expect((directInspection.story as { kind?: string }).kind).toBe("preparation");
        expect(directInspection.snapshot_hash).toBe(revealed.snapshot_hash);
        const inspected = textPayload(
          await client.callTool({
            name: "inspect_overworld_session_story",
            arguments: {
              session_id: sessionId,
              story_choice_id: "albany:wolf_preparation",
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        expectPureStoryInspectionEnvelope(inspected, sessionId);
        const preparationChoice = inspected.story as {
          comparisonVersion?: number;
          kind?: string;
          message?: string;
          options?: {
            id: string;
            consequence?: string;
            summary?: { checkFit?: string };
          }[];
          reviewOption?: {
            tool: string;
            storyChoiceId: string;
            arguments: { story_choice_id: string };
            argument: string;
            valuesFrom: string;
            readOnly: boolean;
          };
          inspectedOption?: { id: string; consequence: string } | null;
        };
        expect(Object.keys(preparationChoice).sort()).toEqual(
          [
            "comparisonVersion",
            "id",
            "inspectedOption",
            "kind",
            "message",
            "options",
            "reviewOption",
          ].sort(),
        );
        expect(preparationChoice?.comparisonVersion).toBe(JOURNEY_STORY_CHOICE_COMPARISON_VERSION);
        expect(JOURNEY_STORY_CHOICE_COMPARISON_VERSION).toBe(12);
        expect(preparationChoice?.kind).toBe("preparation");
        expect(preparationChoice?.inspectedOption).toBeNull();
        expect(preparationChoice?.reviewOption).toEqual({
          tool: INSPECT_OVERWORLD_SESSION_STORY_TOOL,
          storyChoiceId: "albany:wolf_preparation",
          arguments: { story_choice_id: "albany:wolf_preparation" },
          argument: "option_id",
          valuesFrom: OVERWORLD_DEPARTURE_CHOICE_VALUES_FROM,
          readOnly: true,
        });
        expect(
          preparationChoice?.options?.every((option) => option.consequence === undefined),
        ).toBe(true);
        const worksFortification = preparationChoice?.options?.find(
          (option) => option.id === "albany:prep_works_fortification",
        );
        if (!worksFortification)
          throw new Error("expected visible works-fortification preparation");
        expect(worksFortification.summary).not.toHaveProperty("checkFit");
        expect(worksFortification.summary).toMatchObject({
          highlights: [{ label: "Check skill", value: "Repair +4 vs DC 12" }],
        });
        const detailed = textPayload(
          await client.callTool({
            name: "inspect_overworld_session_story",
            arguments: {
              session_id: sessionId,
              story_choice_id: "albany:wolf_preparation",
              option_id: worksFortification.id,
            },
          }),
        );
        expectPureStoryInspectionEnvelope(detailed, sessionId, undefined, true);
        expect(detailed.snapshot_hash).toBe(inspected.snapshot_hash);
        const detailedPreparation = detailed.story as Record<string, unknown> & {
          inspectedOption?: Record<string, unknown> & { id?: string; consequence?: string };
        };
        expect(Object.keys(detailedPreparation).sort()).toEqual(
          ["comparisonVersion", "id", "inspectedOption", "kind"].sort(),
        );
        expect(detailedPreparation).not.toHaveProperty("message");
        expect(detailedPreparation).not.toHaveProperty("options");
        expect(detailedPreparation.inspectedOption).toMatchObject({
          id: worksFortification.id,
          checkFit: "Repair +4 vs DC 12",
          dispatchForecast: { proofHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
          consequence:
            "Benefit: First loose fence rail: Repair check with a guaranteed recovery. " +
            "Cost: 10 minutes and $0. " +
            "Tradeoff: Replaces the public wedge and closes Hayden's frost brace.",
        });
        expect(Object.keys(detailedPreparation.inspectedOption ?? {}).sort()).toEqual(
          ["checkFit", "consequence", "dispatchForecast", "id", "label"].sort(),
        );
        for (const expansion of [
          {
            arguments: { include_departure_recap_terms: true },
            departureTerms: true,
            stationSupport: false,
          },
          {
            arguments: {
              include_station_dispatch_support: true,
              if_snapshot_hash: "0".repeat(24),
            },
            departureTerms: false,
            stationSupport: true,
          },
          {
            arguments: {
              include_departure_recap_terms: true,
              include_station_dispatch_support: true,
              if_snapshot_hash: "0".repeat(24),
            },
            departureTerms: true,
            stationSupport: true,
          },
        ] as const) {
          const expandedReveal = textPayload(
            await client.callTool({
              name: "get_overworld_session_context",
              arguments: {
                session_id: sessionId,
                reveal_station_dispatch_support: STATION_DISPATCH_SUPPORT_REVEAL_ID,
                ...expansion.arguments,
              },
            }),
          );
          expect(expandedReveal.snapshot_hash).toBe(revealed.snapshot_hash);
          expect(expandedReveal).toHaveProperty("journey");
          expect(expandedReveal).toHaveProperty("context");
          expect(expandedReveal).not.toHaveProperty("station_dispatch_reveal");
          const expandedContext = expandedReveal.context as CompactAreaContext;
          expect(expandedContext.station_dispatch_board).toEqual(revealedBoard);
          if (expansion.departureTerms) {
            expect(expandedContext.departure_recap_terms).toEqual(expect.any(Array));
          } else {
            expect(expandedContext.departure_recap_terms).toBeUndefined();
          }
          if (expansion.stationSupport) {
            expect(expandedContext.station_dispatch_support).toEqual(
              supportContext.station_dispatch_support,
            );
          } else {
            expect(expandedContext.station_dispatch_support).toBeUndefined();
          }
        }
        const prepared = textPayload(
          await client.callTool({
            name: "choose_overworld_session_story",
            arguments: {
              session_id: sessionId,
              story_choice_id: "albany:wolf_preparation",
              choice: worksFortification.id,
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        const preparedBoard = (prepared.context as CompactAreaContext).station_dispatch_board;
        expect(preparedBoard?.[0]).toBe(6);
        expect(preparedBoard?.[2]).toMatch(
          /^Background, promise, and report are set\. Current setup: \d+m\. Final setup: \d+–\d+m; (?:all on time|support can delay dispatch|already late)\. Optional support remains\. Start Wolf-Winter to skip it\.$/,
        );
        expect(preparedBoard?.[3]?.[3]).toBe(2);
        expect(
          preparedBoard?.[4]
            .filter(([, status]) => status === "open_optional")
            .map(([slot]) => slot),
        ).toEqual(["relief_allocation", "field_team"]);
        expect(preparedBoard?.[4].find(([slot]) => slot === "preparation")).toMatchObject([
          "preparation",
          "selected",
          expect.any(String),
          null,
          null,
        ]);
        const readyFieldTeam = (preparedBoard?.[4] ?? []).find(
          ([slot]) => slot === "field_team",
        )?.[4];
        expect(readyFieldTeam).toEqual([
          "talk",
          "albany_city__transport_hub__june_pike",
          "June Pike",
        ]);
        if (readyFieldTeam?.[0] !== "talk") {
          throw new Error("expected June's ready Station board action");
        }
        const juneContactId = readyFieldTeam[1];
        const missingJuneBase = await client.callTool({
          name: "talk_overworld_session_contact",
          arguments: {
            session_id: sessionId,
            character_id: juneContactId,
          },
        });
        expect(missingJuneBase.isError).toBe(true);
        expect(textPayload(missingJuneBase).error).toBe(
          "To talk to June here, pass expected_snapshot_hash from the revealed Station board.",
        );
        const staleJuneBase = await client.callTool({
          name: "talk_overworld_session_contact",
          arguments: {
            session_id: sessionId,
            character_id: juneContactId,
            expected_snapshot_hash: "0".repeat(24),
          },
        });
        expect(staleJuneBase.isError).toBe(true);
        expect(textPayload(staleJuneBase).error).toBe(
          "The snapshot changed. Read the latest Station response, then talk to June.",
        );
        const afterRejectedJune = textPayload(
          await client.callTool({
            name: "get_overworld_session_context",
            arguments: {
              session_id: sessionId,
              if_snapshot_hash: prepared.snapshot_hash,
            },
          }),
        );
        expect(afterRejectedJune.snapshot_hash).toBe(prepared.snapshot_hash);
        expect(afterRejectedJune.unchanged).toBe(true);
        expect(afterRejectedJune).not.toHaveProperty("context");
        const juneConversation = textPayload(
          await client.callTool({
            name: "talk_overworld_session_contact",
            arguments: {
              session_id: sessionId,
              contact_id: juneContactId,
              expected_snapshot_hash: prepared.snapshot_hash,
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        expect(Object.keys(juneConversation).sort()).toEqual(
          [
            "journey",
            "journeyDecision",
            "legend_delta",
            "ok",
            "overworld_session_id",
            "result",
            "snapshot_hash",
            "station_dispatch_modal",
          ].sort(),
        );
        expect(juneConversation).toMatchObject({
          ok: true,
          overworld_session_id: sessionId,
          snapshot_hash: expect.any(String),
          journeyDecision: {
            countsTowardJourney: true,
            reason: "substantive_dialogue",
          },
          result: {
            m: expect.any(Number),
            entry: expect.any(Array),
            text: expect.any(String),
          },
          station_dispatch_modal: {
            version: PURE_STATION_JUNE_MODAL_VERSION,
            base_snapshot_hash: prepared.snapshot_hash,
          },
        });
        expect(juneConversation.snapshot_hash).not.toBe(prepared.snapshot_hash);
        expect(juneConversation).not.toHaveProperty("session_id");
        expect(juneConversation).not.toHaveProperty("context");
        expect(juneConversation.legend_delta).toEqual({
          departure_recap: OVERWORLD_COMPACT_LEGEND.departure_recap,
        });
        const typedJuneConversation = juneConversation as unknown as PureStationJuneModalResponseV1;
        expect(typedJuneConversation.station_dispatch_modal.version).toBe(
          PURE_STATION_JUNE_MODAL_VERSION,
        );
        const allyChoice = (
          juneConversation.journey as {
            storyChoice?: {
              id?: string;
              kind?: string;
              options?: { id: string; consequence?: string; summary?: { tradeoff?: string } }[];
            };
          }
        ).storyChoice;
        expect(allyChoice).toMatchObject({
          id: "albany:wolf_ally_commitment",
          kind: "ally",
        });
        expect(
          allyChoice?.options?.every(
            (option) => option.consequence === "" && typeof option.summary?.tradeoff === "string",
          ),
        ).toBe(true);
        if (!allyChoice?.id) throw new Error("expected June's active field-team choice");
        const cattleFirst = allyChoice.options?.find(
          (option) => option.id === "albany:ally_june_cattle_first",
        );
        if (!cattleFirst) throw new Error("expected June's visible cattle-first option");
        const juneModalBytes = Buffer.byteLength(JSON.stringify(juneConversation), "utf8");
        expect(juneModalBytes).toBe(3_420);
        expect(juneModalBytes).toBeLessThanOrEqual(4_000);
        const inspectedAlly = textPayload(
          await client.callTool({
            name: "inspect_overworld_session_story",
            arguments: {
              session_id: sessionId,
              story_choice_id: allyChoice.id,
              expected_snapshot_hash: juneConversation.snapshot_hash,
            },
          }),
        );
        const inspectedAllyRecap = inspectedAlly.departure_recap as unknown[];
        expect(inspectedAllyRecap?.[0]).toBe(7);
        expect(inspectedAllyRecap?.[1]).toBe("wolf_winter");
        expect(inspectedAllyRecap?.[2]).toEqual(expect.any(String));
        expect(inspectedAllyRecap?.[3]).toEqual(expect.any(Array));
        expectPureStoryInspectionEnvelope(inspectedAlly, sessionId, inspectedAllyRecap);
        expect(inspectedAlly.snapshot_hash).toBe(juneConversation.snapshot_hash);
        expect((inspectedAlly.story as { kind?: string }).kind).toBe("ally");
        const repeatedJune = await client.callTool({
          name: "talk_overworld_session_contact",
          arguments: {
            session_id: sessionId,
            character_id: juneContactId,
            expected_snapshot_hash: juneConversation.snapshot_hash,
          },
        });
        expect(repeatedJune.isError).toBe(true);
        expect(textPayload(repeatedJune).error).toBe(
          "Choose the open story option before taking another action.",
        );
        const afterRepeatedJune = textPayload(
          await client.callTool({
            name: "get_overworld_session_context",
            arguments: {
              session_id: sessionId,
              if_snapshot_hash: juneConversation.snapshot_hash,
            },
          }),
        );
        expect(afterRepeatedJune.snapshot_hash).toBe(juneConversation.snapshot_hash);
        expect(afterRepeatedJune.unchanged).toBe(true);
        expect(
          (afterRepeatedJune.journey as { storyChoice?: { id?: string } }).storyChoice?.id,
        ).toBe(allyChoice.id);
        const allied = textPayload(
          await client.callTool({
            name: "choose_overworld_session_story",
            arguments: {
              session_id: sessionId,
              story_choice_id: allyChoice.id,
              choice: cattleFirst.id,
              expected_snapshot_hash: juneConversation.snapshot_hash,
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        expect(allied.session_id).toBe(sessionId);
        expect(allied.overworld_session_id).toBe(sessionId);
        expect(allied).toHaveProperty("context");
        expect(allied).not.toHaveProperty("station_dispatch_modal");
        expect((allied.context as CompactAreaContext).departure_contact_leads).toBeUndefined();
        expectJuneCattleFirst(allied);
        expect((allied.journey as { storyChoice?: unknown }).storyChoice).toBeNull();
        const postChoiceJune = textPayload(
          await client.callTool({
            name: "talk_overworld_session_contact",
            arguments: {
              session_id: sessionId,
              character_id: juneContactId,
            },
          }),
        );
        expect(postChoiceJune).toMatchObject({
          ok: true,
          session_id: sessionId,
          overworld_session_id: sessionId,
          snapshot_hash: expect.any(String),
          context: expect.any(Object),
        });
        expect(postChoiceJune.snapshot_hash).not.toBe(allied.snapshot_hash);
        expect(postChoiceJune).not.toHaveProperty("station_dispatch_modal");
        expectJuneCattleFirst(postChoiceJune);
        const persistedAlly = textPayload(
          await client.callTool({
            name: "get_overworld_session_context",
            arguments: { session_id: sessionId },
          }),
        );
        expect(
          (persistedAlly.context as CompactAreaContext).departure_contact_leads,
        ).toBeUndefined();
        expectJuneCattleFirst(persistedAlly);
        expect((prepared.context as CompactAreaContext).quest_starts).toContainEqual([
          "wolf_winter",
          expect.any(String),
        ]);
        const wolfWinter = areaView(prepared).quests.find((quest) => quest.id === "wolf_winter");
        if (!wolfWinter) throw new Error("expected selected preparation to reveal Wolf-Winter");
        expect((allied.context as CompactAreaContext).station_dispatch_board?.[0]).toBe(6);
        const inspectedAllocation = textPayload(
          await client.callTool({
            name: "inspect_overworld_session_story",
            arguments: {
              session_id: sessionId,
              story_choice_id: "albany:wolf_relief_allocation",
            },
          }),
        );
        expectPureStoryInspectionEnvelope(inspectedAllocation, sessionId);
        expect((inspectedAllocation.story as { kind?: string }).kind).toBe("relief_allocation");
        const allocated = textPayload(
          await client.callTool({
            name: "choose_overworld_session_story",
            arguments: {
              session_id: sessionId,
              story_choice_id: "albany:wolf_relief_allocation",
              choice: "albany:relief_resident_shelter",
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        const allocatedBoard = (allocated.context as CompactAreaContext).station_dispatch_board;
        expect(allocatedBoard?.[2]).toBe(
          "Setup took 35m, so the dispatch is on time. Roads change arrival costs only. No late-dispatch penalty applies.",
        );
        expect(allocatedBoard?.[3]?.[3]).toBe(0);
        expect(allocatedBoard?.[4].filter(([, status]) => status === "open_optional")).toEqual([]);
        expect(allocatedBoard?.[5]).toBeNull();
        expectJuneCattleFirst(allocated);
        view = areaView(allocated);
        const marketRoute = view.areaExits.find(
          (route) => route.destination.id === "albany_city__market",
        );
        if (!marketRoute) throw new Error("expected route to Albany market");

        const market = textPayload(
          await client.callTool({
            name: "move_overworld_session_area",
            arguments: {
              session_id: sessionId,
              area_route_id: marketRoute.id,
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        view = areaView(market);
        const marketPoi = view.pois[0]?.id;
        if (!marketPoi) throw new Error("expected Albany market point of interest");

        const lead = textPayload(
          await client.callTool({
            name: "scout_overworld_session_poi",
            arguments: {
              session_id: sessionId,
              poi_id: marketPoi,
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        const quest = wolfWinter;
        view = areaView(lead);
        const questRoute = view.areaExits.find((route) => route.destination.id === quest.area);
        if (!questRoute) throw new Error("expected route to the discovered lead");
        const departure = textPayload(
          await client.callTool({
            name: "move_overworld_session_area",
            arguments: {
              session_id: sessionId,
              area_route_id: questRoute.id,
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        expect((departure.journey as { storyChoice?: unknown }).storyChoice).toBeNull();

        const launched = textPayload(
          await client.callTool({
            name: "start_overworld_session_quest",
            arguments: {
              session_id: sessionId,
              quest_id: quest.id,
              approach_id: "albany:wolf_approach_sheltered_stockway",
              seed: 8675309,
              hide_graph: false,
              include_actions: false,
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        const rpgSessionId = String(launched.rpg_session_id);
        expect(launched.legend_delta).toMatchObject({
          quest: OVERWORLD_COMPACT_RESULT_LEGEND.quest,
        });
        expect(launched).toMatchObject({
          overworld_session_id: sessionId,
          rpg_session_id: rpgSessionId,
          rpg_session: {
            overworld_session_id: sessionId,
            rpg_session_id: rpgSessionId,
          },
        });
        const rpgSession = launched.rpg_session as {
          context: RpgCompactContext;
          state_hash: string;
        };
        expect(rpgSession.context.actions).toContain("use_sheltered_stockway_last_mile");
        expect(rpgSession.context.actions?.length).toBeLessThanOrEqual(24);

        const unchanged = textPayload(
          await client.callTool({
            name: "get_observation",
            arguments: {
              session_id: rpgSessionId,
              if_state_hash: rpgSession.state_hash,
            },
          }),
        );
        expect(unchanged).toMatchObject({
          unchanged: true,
          state_hash: rpgSession.state_hash,
          overworld_session_id: sessionId,
          rpg_session_id: rpgSessionId,
        });

        const staleStepResult = await client.callTool({
          name: "step_action",
          arguments: {
            session_id: rpgSessionId,
            action_id: "use_sheltered_stockway_last_mile",
            expected_state_hash: "stale-state-hash",
          },
        });
        expect(staleStepResult.isError).not.toBe(true);
        expect(textPayload(staleStepResult)).toMatchObject({
          ok: false,
          overworld_session_id: sessionId,
          rpg_session_id: rpgSessionId,
        });

        const parentRecovery = textPayload(
          await client.callTool({
            name: "get_overworld_session_context",
            arguments: { session_id: sessionId },
          }),
        );
        expect(parentRecovery).toMatchObject({
          overworld_session_id: sessionId,
          rpg_session_id: rpgSessionId,
        });
        const parentSnapshotBeforeRejectedStart = parentRecovery.snapshot_hash;
        const journeyBeforeRejectedStart = parentRecovery.journey;
        expect(parentSnapshotBeforeRejectedStart).toEqual(expect.stringMatching(/^[0-9a-f]{24}$/));
        expect(journeyBeforeRejectedStart).not.toBeNull();
        expect(typeof journeyBeforeRejectedStart).toBe("object");
        expect(Array.isArray(journeyBeforeRejectedStart)).toBe(false);
        const journeyBytesBeforeRejectedStart = JSON.stringify(journeyBeforeRejectedStart);
        const expectParentUnchanged = async (): Promise<void> => {
          const currentParentResult = await client.callTool({
            name: "get_overworld_session_context",
            arguments: { session_id: sessionId },
          });
          expect(currentParentResult.isError).not.toBe(true);
          const currentParent = textPayload(currentParentResult);
          expect(currentParent.snapshot_hash).toBe(parentSnapshotBeforeRejectedStart);
          expect(currentParent.journey).toEqual(journeyBeforeRejectedStart);
          expect(JSON.stringify(currentParent.journey)).toBe(journeyBytesBeforeRejectedStart);
          expect(currentParent).toMatchObject({
            overworld_session_id: sessionId,
            rpg_session_id: rpgSessionId,
          });
        };
        const expectSessionRecoveryEnvelope = (
          payload: Record<string, unknown>,
          expectedField: "overworld_session_id" | "rpg_session_id",
        ): void => {
          expect(payload).toMatchObject({
            ok: false,
            expected_session_field: expectedField,
            expected_argument: "session_id",
            returned_handle_field: expectedField,
            overworld_session_id: sessionId,
            rpg_session_id: rpgSessionId,
          });
        };
        const repeatedQuestStart = await client.callTool({
          name: "start_overworld_session_quest",
          arguments: {
            session_id: sessionId,
            quest_id: quest.id,
            approach_id: "albany:wolf_approach_sheltered_stockway",
          },
        });
        expect(repeatedQuestStart.isError).toBe(true);
        expect(textPayload(repeatedQuestStart)).toMatchObject({
          error:
            "Finish the active quest with its rpg_session_id before taking another overworld action.",
          expected_session_field: "rpg_session_id",
          expected_argument: "session_id",
          returned_handle_field: "rpg_session_id",
          overworld_session_id: sessionId,
          rpg_session_id: rpgSessionId,
        });
        await expectParentUnchanged();

        for (const [name, argumentsValue] of [
          ["list_legal_actions", { session_id: null }],
          ["list_legal_actions", { session_id: 7 }],
          ["list_legal_actions", { session_id: sessionId }],
        ] as const) {
          const rejected = await client.callTool({ name, arguments: argumentsValue });
          expect(rejected.isError).toBe(true);
          expectSessionRecoveryEnvelope(textPayload(rejected), "rpg_session_id");
          await expectParentUnchanged();
        }

        const childUsedForParent = await client.callTool({
          name: "get_overworld_session_context",
          arguments: { session_id: rpgSessionId },
        });
        expect(childUsedForParent.isError).toBe(true);
        const childUsedForParentPayload = textPayload(childUsedForParent);
        expectSessionRecoveryEnvelope(childUsedForParentPayload, "overworld_session_id");
        expect(childUsedForParentPayload.error).toBe(
          "This overworld tool needs the parent overworld_session_id, not the active child rpg_session_id.",
        );
        await expectParentUnchanged();

        const finalSegmentStart = sessionId.lastIndexOf("-") + 1;
        const cycle14ParentNearMiss =
          sessionId.slice(0, finalSegmentStart + 2) + sessionId.slice(finalSegmentStart + 3);
        const nonCurrentRpgShapedHandle = "r999";
        expect(cycle14ParentNearMiss).toMatch(/^o-/);
        expect(cycle14ParentNearMiss).toHaveLength(sessionId.length - 1);
        expect(nonCurrentRpgShapedHandle).not.toBe(rpgSessionId);
        for (const [label, argumentsValue] of [
          ["missing", {}],
          ["wrong field", { rpg_session_id: sessionId }],
          ["null", { session_id: null }],
          ["non-string", { session_id: 7 }],
          ["Cycle 14 one-character parent near-miss", { session_id: cycle14ParentNearMiss }],
          ["non-current RPG-shaped child", { session_id: nonCurrentRpgShapedHandle }],
          ["unknown", { session_id: "not-a-live-handle" }],
        ] as const) {
          const rejected = await client.callTool({
            name: "get_overworld_session_context",
            arguments: argumentsValue,
          });
          expect(rejected.isError, label).toBe(true);
          const payload = textPayload(rejected);
          expectSessionRecoveryEnvelope(payload, "overworld_session_id");
          expect(payload.error, label).toContain("Pass the current parent overworld_session_id.");
          expect(payload.error, label).toContain(
            "The supplied session_id is missing, invalid, stale, or unknown.",
          );
          expect(String(payload.error), label).not.toMatch(/RPG|child/i);
          if (label === "Cycle 14 one-character parent near-miss") {
            expect(JSON.stringify(payload)).not.toContain(cycle14ParentNearMiss);
          }
          await expectParentUnchanged();
        }
        const bothRecovered = await client.callTool({ name: "start_overworld", arguments: {} });
        expect(bothRecovered.isError).toBe(true);
        expect(textPayload(bothRecovered)).toMatchObject({
          expected_session_field: "overworld_session_id",
          expected_argument: "session_id",
          returned_handle_field: "overworld_session_id",
          overworld_session_id: sessionId,
          rpg_session_id: rpgSessionId,
        });
        await expectParentUnchanged();

        const enteredByre = textPayload(
          await client.callTool({
            name: "step_action",
            arguments: {
              session_id: rpgSessionId,
              action_id: "use_sheltered_stockway_last_mile",
              expected_state_hash: rpgSession.state_hash,
              include_actions: false,
            },
          }),
        );
        expect(enteredByre.ok).toBe(true);
        expect((enteredByre.context as RpgCompactContext).actions).toContain("talk_houndsman");

        const talked = textPayload(
          await client.callTool({
            name: "step_action",
            arguments: {
              session_id: rpgSessionId,
              action_id: "talk_houndsman",
              expected_state_hash: String(enteredByre.state_hash),
            },
          }),
        );
        expect(talked.ok).toBe(true);
        const talkContext = talked.context as RpgCompactContext;
        const talkActions = talkContext.actions;
        expect(talkContext.dialogue?.[1]).toBe(
          "Reviews choose nothing. Choose LURE, DRIVE, or FORTIFY in review. Choose HUNT with GO north or RELEASE JUNE. One choice permanently closes the rest. PREPARE SUPPORT chooses nothing.\nFIELD CONDITION — steady scent channel. At the opening, LAY downwind feed line WITH Cade's winter-feed sack succeeds without a check. Later feed and cattle-alarm costs remain.",
        );
        expect(talkContext.dialogue?.[1].length).toBeLessThanOrEqual(360);
        expect(talkActions).toEqual(
          expect.arrayContaining(["ask_wolves", "ask_byre", "ask_leave"]),
        );
        expect(talkContext.choices).toContainEqual(["ask_hunt", CADE_HUNT_INSPECT_LABEL]);
        expect(talkContext.choices?.find(([id]) => id === "ask_hunt")?.[1]).not.toMatch(
          ACTION_TRUNCATION_MARKER,
        );
        expect(talkActions?.length).toBeLessThanOrEqual(24);

        const currentRead = textPayload(
          await client.callTool({
            name: "get_observation",
            arguments: { session_id: rpgSessionId, include_actions: false },
          }),
        );
        expect(currentRead.state_hash).toBe(talked.state_hash);
        expect((currentRead.context as RpgCompactContext).dialogue).toEqual(talkContext.dialogue);
        expect((currentRead.context as RpgCompactContext).actions).toEqual(talkActions);
        expect((currentRead.context as RpgCompactContext).choices).toEqual(talkContext.choices);

        const fullCurrentRead = textPayload(
          await client.callTool({
            name: "get_observation",
            arguments: {
              session_id: rpgSessionId,
              compact_observation: false,
              include_actions: false,
            },
          }),
        );
        expect(fullCurrentRead.state_hash).toBe(talked.state_hash);
        expect((fullCurrentRead.observation as RpgObservation).dialogue?.npc_text).toBe(
          talkContext.dialogue?.[1],
        );

        const labeledMenu = textPayload(
          await client.callTool({
            name: "list_legal_actions",
            arguments: { session_id: rpgSessionId },
          }),
        );
        const labeledActions = labeledMenu.actions as { id: string; command?: string }[];
        expect(
          Object.fromEntries(labeledActions.map((action) => [action.id, action.command])),
        ).toMatchObject({
          ask_wolves:
            "ask: PREPARE SUPPORT — Learn the quick HUNT tactic for +2 attack and +5 score. This does not choose HUNT.",
          ask_byre:
            "ask: PREPARE SUPPORT — Learn the guarded HUNT tactic. This does not choose HUNT.",
          ask_hunt: CADE_HUNT_INSPECT_COMMAND,
          ask_leave: "ask: LEAVE — Return to the yard.",
        });
        const huntAction = labeledActions.find((action) => action.id === "ask_hunt");
        expect(MCP_ACTION_LABEL_CHAR_LIMIT).toBe(160);
        expect(huntAction?.command).toBe(CADE_HUNT_INSPECT_COMMAND);
        expect(huntAction?.command?.length).toBeLessThanOrEqual(MCP_ACTION_LABEL_CHAR_LIMIT);
        expect(huntAction?.command).not.toMatch(ACTION_TRUNCATION_MARKER);
        expect(labeledMenu).toMatchObject({
          overworld_session_id: sessionId,
          rpg_session_id: rpgSessionId,
        });
        const compactMenu = textPayload(
          await client.callTool({
            name: "list_legal_actions",
            arguments: { session_id: rpgSessionId, compact_actions: true },
          }),
        );
        expect(compactMenu.actions).toEqual(
          expect.arrayContaining(["ask_wolves", "ask_byre", "ask_hunt", "ask_leave"]),
        );

        // The action menu carried by TALK is immediately executable; a player does
        // not need a second read or a guessed/stale menu before choosing a topic.
        const asked = textPayload(
          await client.callTool({
            name: "step_action",
            arguments: {
              session_id: rpgSessionId,
              action_id: "ask_byre",
              expected_state_hash: String(talked.state_hash),
              hide_graph: false,
              compact_observation: false,
            },
          }),
        );
        expect(asked.ok).toBe(true);
        const askedObservation = asked.observation as RpgObservation;
        expect(askedObservation.exits.length).toBeGreaterThan(0);
        expect(askedObservation.exits.every((exit) => exit.to === undefined)).toBe(true);
        expect(askedObservation.available_actions.length).toBeGreaterThan(0);
        expect(askedObservation.state.flags).toContain("heard_plan");
        expect(askedObservation.state.flags).not.toEqual(
          expect.arrayContaining([
            "strategy_lure_committed",
            "strategy_drive_committed",
            "strategy_fortify_committed",
          ]),
        );
        expect(
          askedObservation.available_actions.every(
            (action) => typeof action.command === "string" && action.command.length > 0,
          ),
        ).toBe(true);
        expect(asked).toMatchObject({
          overworld_session_id: sessionId,
          rpg_session_id: rpgSessionId,
        });

        const reread = textPayload(
          await client.callTool({
            name: "get_observation",
            arguments: {
              session_id: rpgSessionId,
              hide_graph: false,
              compact_observation: false,
            },
          }),
        );
        const rereadObservation = reread.observation as RpgObservation;
        expect(rereadObservation.exits.length).toBeGreaterThan(0);
        expect(rereadObservation.exits.every((exit) => exit.to === undefined)).toBe(true);
        expect(rereadObservation.available_actions.length).toBeGreaterThan(0);
        expect(
          rereadObservation.available_actions.every(
            (action) => typeof action.command === "string" && action.command.length > 0,
          ),
        ).toBe(true);

        // Bounce over the safe yard gate until a real quest move lands on the
        // fixed checkpoint. Pure mode must suppress that step's menu, then put
        // the exact current quest menu back on the Continue response itself.
        let questTurn = textPayload(
          await client.callTool({
            name: "get_observation",
            arguments: {
              session_id: rpgSessionId,
              compact_observation: true,
              include_actions: false,
            },
          }),
        );
        let questJourney = questTurn.journey as {
          status: string;
          acceptedDecisions: number;
          nextCheckpoint: number | null;
          pendingChoice: unknown;
        };
        while (questJourney.acceptedDecisions < 40) {
          const actions = (questTurn.context as RpgCompactContext).actions ?? [];
          const actionId = actions.includes("ask_leave")
            ? "ask_leave"
            : actions.includes("go_south")
              ? "go_south"
              : actions.includes("go_north")
                ? "go_north"
                : null;
          if (!actionId) throw new Error("expected a safe reversible quest route");
          questTurn = textPayload(
            await client.callTool({
              name: "step_action",
              arguments: {
                session_id: rpgSessionId,
                action_id: actionId,
                expected_state_hash: String(questTurn.state_hash),
                include_actions: false,
              },
            }),
          );
          questJourney = questTurn.journey as typeof questJourney;
        }
        expect(questJourney).toMatchObject({
          status: "awaiting_choice",
          acceptedDecisions: 40,
          nextCheckpoint: 40,
        });
        expect((questTurn.context as RpgCompactContext).actions).toBeUndefined();
        const checkpointStateHash = String(questTurn.state_hash);
        const recoveredParentId = String(questTurn.overworld_session_id);
        expect(recoveredParentId).toBe(sessionId);
        expect(questTurn.rpg_session_id).toBe(rpgSessionId);

        const continued = textPayload(
          await client.callTool({
            name: "choose_overworld_session_journey",
            arguments: {
              session_id: recoveredParentId,
              choice: "continue",
              compact_observation: true,
              include_actions: false,
            },
          }),
        );
        expect(continued.journey).toMatchObject({
          status: "active",
          acceptedDecisions: 40,
          nextCheckpoint: 80,
          pendingChoice: null,
        });
        expect(continued.rpg_session_id).toBe(rpgSessionId);
        expect(continued.overworld_session_id).toBe(sessionId);
        const resumed = continued.rpg_session as {
          session_id: string;
          state_hash: string;
          context: RpgCompactContext;
          overworld_session_id: string;
          rpg_session_id: string;
        };
        expect(resumed).toMatchObject({
          session_id: rpgSessionId,
          state_hash: checkpointStateHash,
          overworld_session_id: sessionId,
          rpg_session_id: rpgSessionId,
        });
        expect(resumed.context.actions?.length).toBeGreaterThan(0);
        expect(continued).not.toHaveProperty("observation");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("auto-folds non-death and holds a dead child until the end-only journey receipt", async () => {
    const nonDeathDir = mkdtempSync(join(tmpdir(), "mcp-pure-terminal-success-"));
    const deathDir = mkdtempSync(join(tmpdir(), "mcp-pure-terminal-death-"));
    const deathEvidence = join(deathDir, "run.jsonl");
    const preservedDeathEvidence = join(deathDir, "run-preserved.jsonl");
    try {
      await withPureServer(
        join(nonDeathDir, "run.jsonl"),
        async (client) => {
          const launch = await launchPreparedPureWolf(client);
          const final = await playPureQuestActions(client, launch, [
            "use_sheltered_stockway_last_mile",
            "go_north",
            "maneuver_yearling_wolf_set_spear",
            "maneuver_yearling_wolf_drive_set_spear_unarmored",
            "go_north",
            "attack_flank_wolf",
            "attack_flank_wolf",
            "go_north",
            "attack_grey_leader",
            "attack_grey_leader",
            "go_north",
          ]);
          expect(final.questCompletion).toMatchObject({ endingId: "ending_held" });
          expect(final.context).toMatchObject({
            ended: true,
            ending_id: "ending_held",
            ending: { death: false },
          });
          expect(final.overworld_session_id).toBe(launch.overworldSessionId);
          expect(final).not.toHaveProperty("rpg_session_id");

          const continued = await callPlayerTool(client, "choose_overworld_session_journey", {
            session_id: launch.overworldSessionId,
            choice: "continue",
          });
          expect(continued.overworld_session_id).toBe(launch.overworldSessionId);
          expect(continued).not.toHaveProperty("rpg_session_id");
        },
        0,
      );

      await withPureServer(
        deathEvidence,
        async (client) => {
          const launch = await launchPreparedPureWolf(client);
          const final = await playPureQuestActions(client, launch, [
            "use_sheltered_stockway_last_mile",
            "go_north",
            "maneuver_yearling_wolf_set_spear",
            "maneuver_yearling_wolf_drive_set_spear_unarmored",
            "go_north",
            "attack_flank_wolf",
            "attack_flank_wolf",
            "attack_flank_wolf",
            "go_north",
            "attack_grey_leader",
            "attack_grey_leader",
          ]);
          expect(final).not.toHaveProperty("questCompletion");
          expect(final.context).toMatchObject({
            ended: true,
            ending_id: "ending_pulled_down",
            ending: { death: true },
          });
          expect(final.overworld_session_id).toBe(launch.overworldSessionId);
          expect(final.rpg_session_id).toBe(launch.rpgSessionId);
          expect(final.journey).toMatchObject({
            status: "awaiting_choice",
            goal: { status: "active" },
            pendingChoice: {
              reasons: ["character_died"],
              checkpoint: null,
              goalVersion: null,
              goalId: null,
              options: [{ id: "end" }],
            },
          });

          const parent = await callPlayerTool(client, "get_overworld_session_context", {
            session_id: launch.overworldSessionId,
          });
          expect(parent.rpg_session_id).toBe(launch.rpgSessionId);

          const continuedCall = await client.callTool({
            name: "choose_overworld_session_journey",
            arguments: { session_id: launch.overworldSessionId, choice: "continue" },
          });
          expect(continuedCall.isError).toBe(true);
          expect(textPayload(continuedCall)).toMatchObject({
            ok: false,
            overworld_session_id: launch.overworldSessionId,
            rpg_session_id: launch.rpgSessionId,
            error: expect.stringMatching(/character died/i),
          });

          // Make the evidence target unwritable after fresh-start evidence has
          // landed. The journey end itself must remain committed and recoverable.
          renameSync(deathEvidence, preservedDeathEvidence);
          mkdirSync(deathEvidence);
          const ended = await callPlayerTool(client, "choose_overworld_session_journey", {
            session_id: launch.overworldSessionId,
            choice: "end",
          });
          expect(ended.overworld_session_id).toBe(launch.overworldSessionId);
          expect(ended).not.toHaveProperty("rpg_session_id");
          expect(ended.journey).toMatchObject({ status: "ended", pendingChoice: null });
          const exitReceipt = (ended.result as { exitReceipt: Record<string, unknown> })
            .exitReceipt;
          expect(exitReceipt).toMatchObject({
            exitReason: "player_ended_at_choice",
            goalStatus: "active",
            exitReasons: ["character_died"],
          });
          expect(ended.run_evidence).toMatchObject({
            recorded: false,
            retryable: true,
            message: expect.stringMatching(
              /journey ended[^]*evidence was not saved[^]*exactly one more End call[^]*same parent session[^]*retry/i,
            ),
          });

          const blockedAfterCommittedExit = await client.callTool({
            name: "get_overworld_session_context",
            arguments: { session_id: launch.overworldSessionId },
          });
          expect(blockedAfterCommittedExit.isError).toBe(true);
          expect(textPayload(blockedAfterCommittedExit)).toMatchObject({
            ok: false,
            overworld_session_id: launch.overworldSessionId,
            error: expect.stringMatching(
              /exit receipt is final[^]*do not take another gameplay action/i,
            ),
          });
          expect(textPayload(blockedAfterCommittedExit)).not.toHaveProperty("rpg_session_id");

          // Repair the target and replay the exact terminal choice. The handler
          // must not mutate twice; it re-emits the cached receipt and persists one
          // journey-exit event.
          rmSync(deathEvidence, { recursive: true, force: true });
          renameSync(preservedDeathEvidence, deathEvidence);
          const retried = await callPlayerTool(client, "choose_overworld_session_journey", {
            session_id: launch.overworldSessionId,
            choice: "end",
          });
          expect(retried).not.toHaveProperty("run_evidence");
          expect(retried).not.toHaveProperty("rpg_session_id");
          expect((retried.result as { exitReceipt: Record<string, unknown> }).exitReceipt).toEqual(
            exitReceipt,
          );

          const replayed = await callPlayerTool(client, "choose_overworld_session_journey", {
            session_id: launch.overworldSessionId,
            choice: "end",
          });
          expect(replayed).not.toHaveProperty("rpg_session_id");
          expect((replayed.result as { exitReceipt: Record<string, unknown> }).exitReceipt).toEqual(
            exitReceipt,
          );
        },
        6,
      );

      const deathEvents = readFileSync(deathEvidence, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(deathEvents).toHaveLength(2);
      expect(deathEvents[1]).toMatchObject({
        event: "journey_exit",
        quest_outcomes: [],
        receipt: {
          goalStatus: "active",
          exitReasons: ["character_died"],
        },
      });
    } finally {
      rmSync(nonDeathDir, { recursive: true, force: true });
      rmSync(deathDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("records the same-session exit receipt and rejects every post-exit call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-pure-exit-"));
    const evidence = join(dir, "run.jsonl");
    try {
      let expectedReceipt: unknown;
      let sessionId = "";
      await withPureServer(evidence, async (client) => {
        const started = textPayload(
          await client.callTool({
            name: "start_overworld",
            arguments: {},
          }),
        );
        sessionId = String(started.session_id);
        type CompactAreaContext = {
          area_routes?: [string, string, number][];
          poi?: [string, string][];
        };
        const areaObservation = (payload: Record<string, unknown>) => {
          const context = payload.context as CompactAreaContext;
          return {
            areaExits: (context.area_routes ?? []).map(([id]) => ({ id })),
            pois: (context.poi ?? []).map(([id]) => ({ id })),
          };
        };
        let observation = areaObservation(started);

        let journey = started.journey as {
          acceptedDecisions: number;
          pendingChoice: unknown;
        };
        const openingPoi = observation.pois[0];
        if (!openingPoi) throw new Error("expected an opening local lead");
        const scouted = textPayload(
          await client.callTool({
            name: "scout_overworld_session_poi",
            arguments: {
              session_id: sessionId,
              poi_id: openingPoi.id,
              compact_context: false,
              compact_result: false,
            },
          }),
        );
        journey = scouted.journey as typeof journey;
        observation = areaObservation(scouted);
        while (journey.acceptedDecisions < 40) {
          const route = observation.areaExits[0];
          if (!route) throw new Error("expected a legal local movement");
          const moved = textPayload(
            await client.callTool({
              name: "move_overworld_session_area",
              arguments: {
                session_id: sessionId,
                area_route_id: route.id,
                compact_context: false,
                compact_result: false,
              },
            }),
          );
          journey = moved.journey as typeof journey;
          observation = areaObservation(moved);
        }
        expect(journey.pendingChoice).not.toBeNull();

        const ended = textPayload(
          await client.callTool({
            name: "choose_overworld_session_journey",
            arguments: { session_id: sessionId, choice: "end" },
          }),
        );
        const result = ended.result as { exitReceipt: unknown };
        expectedReceipt = result.exitReceipt;
        expect(expectedReceipt).toMatchObject({ exitReason: "player_ended_at_choice" });

        const afterExit = await client.callTool({
          name: "get_overworld_session_context",
          arguments: { session_id: sessionId },
        });
        expect(afterExit.isError).toBe(true);
        expect((afterExit.content as unknown[])[0]).toMatchObject({
          type: "text",
          text: expect.stringMatching(
            /exit receipt is final[^]*do not take another gameplay action/i,
          ),
        });
      });

      const lines = readFileSync(evidence, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        schema_version: 2,
        play_mode: "pure",
        event: "fresh_start",
        start_surface: "fresh_overworld",
        session_id: sessionId,
        run_seed: TEST_RUN_SEED,
        build: {
          git_commit: TEST_BUILD_COMMIT,
          tracked_worktree_clean: true,
          world_id: "new_york_overworld",
          world_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      });
      expect(lines[1]).toMatchObject({
        schema_version: 2,
        play_mode: "pure",
        event: "journey_exit",
        start_surface: "fresh_overworld",
        session_id: sessionId,
        run_seed: TEST_RUN_SEED,
        build: lines[0].build,
        quest_outcomes: [],
        receipt: expectedReceipt,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  // Zod v3's ZodError.message is a GETTER that pretty-prints one object per failing
  // element, and these two tools accept opaque blobs with no size bound. A 108 KB
  // restore snapshot produced a 3.9 MB error string, 1 MB produced 59 MB, and around
  // 300k issues the getter read itself threw RangeError from INSIDE the catch block —
  // so spectateRecord never ran and, in pure mode, the structured recovery envelope was
  // silently replaced by the SDK's generic error. Bound the response and the work.
  it("bounds a malformed restore_overworld_session error instead of amplifying it", async () => {
    await withFullServer(async (client) => {
      const result = await client.callTool({
        name: "restore_overworld_session",
        arguments: {
          snapshot: { version: 9, visitedIds: Array.from({ length: 500 }, (_, index) => index) },
        },
      });
      expect(result.isError).toBe(true);
      const text = textResult(result);
      // Untrimmed, this snapshot alone yields 527 issues and a ~99 KB message.
      expect(text.length).toBeLessThan(4_000);
      expect(text.startsWith("Error: ")).toBe(true);
    });
  }, 120_000);

  it("refuses an implausibly large snapshot at the tool boundary", async () => {
    await withFullServer(async (client) => {
      const result = await client.callTool({
        name: "restore_overworld_session",
        arguments: { snapshot: { version: 9, filler: "x".repeat(600_000) } },
      });
      expect(result.isError).toBe(true);
      expect(textResult(result).length).toBeLessThan(4_000);
    });
  }, 120_000);

  it("bounds a malformed load_game error the same way", async () => {
    await withFullServer(async (client) => {
      const result = await client.callTool({
        name: "load_game",
        arguments: {
          save: JSON.stringify({
            state: { flags: Array.from({ length: 400 }, (_, index) => index) },
          }),
        },
      });
      expect(result.isError).toBe(true);
      expect(textResult(result).length).toBeLessThan(4_000);
    });
  }, 120_000);
});
