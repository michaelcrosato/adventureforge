/**
 * SS-F02 paired proof. One real Albany registration boundary branches into the
 * three relief terms. Those durable characters enter the shipped Wolf-Winter
 * runtime, where identical rolls isolate each narrow field consumer. Real
 * OverworldSession quest foldback then proves promise status and return service
 * eligibility rather than treating authored copy as evidence.
 */
import { describe, expect, it } from "vitest";

import { makeStep } from "../../src/core/engine.js";
import type { Rng } from "../../src/core/rng.js";
import type { GameState } from "../../src/core/state.js";
import { load, save } from "../../src/persist/save_load.js";
import { buildRpgObservation } from "../../src/rpg/observation.js";
import {
  buildRpgRules,
  enumerateRpgActions,
  indexRpgPack,
  initStateForRpgPack,
} from "../../src/rpg/runner.js";
import { loadRpgSourceFile } from "../../src/rpg/source.js";
import { OverworldSession } from "../../src/world/session.js";
import { loadOverworldManifest } from "../../src/world/source.js";
import { revealCurrentJourneyStoryOptions } from "../regression/support/journey_story.js";

const WORLD = loadOverworldManifest(process.cwd());
const REGISTRATION =
  WORLD.opening_registration ??
  (() => {
    throw new Error("The Albany starting slice requires registration.");
  })();
const OATH =
  WORLD.opening_relief_oath ??
  (() => {
    throw new Error("The Albany starting slice requires a relief oath.");
  })();
const LEAD =
  WORLD.opening_lead_source ??
  (() => {
    throw new Error("The Albany starting slice requires a lead-source scene.");
  })();
const PREPARATION =
  WORLD.opening_preparation ??
  (() => {
    throw new Error("The Albany starting slice requires preparation.");
  })();
const ALLOCATION =
  WORLD.opening_relief_allocation ??
  (() => {
    throw new Error("The Albany starting slice requires relief allocation.");
  })();
const ALLY =
  WORLD.opening_ally ??
  (() => {
    throw new Error("The Albany starting slice requires an ally commitment.");
  })();
const WOLF =
  WORLD.quests.find((quest) => quest.id === "wolf_winter") ??
  (() => {
    throw new Error("The Albany starting slice requires Wolf-Winter.");
  })();
const IMPORTS =
  WOLF.campaign_imports ??
  (() => {
    throw new Error("Wolf-Winter requires campaign imports.");
  })();

const loaded = loadRpgSourceFile("content/rpg/quests/wolf_winter.yaml");
if (!loaded.ok) throw new Error("Wolf-Winter must compile.");
const compiled = loaded.compiled;
const index = indexRpgPack(compiled.pack);

const FULL = "albany:oath_full_compact_duty";
const LIMITED = "albany:oath_limited_aid_only";
const UNAFFILIATED = "albany:oath_unaffiliated_personal_bond";
const OATH_IDS = [FULL, LIMITED, UNAFFILIATED] as const;
type OathId = (typeof OATH_IDS)[number];
const JUNE_PARTNERSHIP = "albany:ally_june_cattle_first";
const EXPLICIT_SOLO = "albany:ally_travel_solo";
const JUNE = "albany:june_pike";
const JUNE_PROMISE = "albany:promise_june_cattle_first";
const LEDGER_PROFILE = "albany:ledger_advocate";
const COURIER_PROFILE = "albany:unaffiliated_courier";
const COURIER_TAG_PROMISE = "albany:promise_close_emergency_tag";

const OATH_CASES = {
  [FULL]: {
    minutes: 10,
    knowledge: "albany:knowledge_wolf_full_compact_duty",
    value: "value:public_duty",
    valueStrength: 4,
    faction: "faction:albany_relief_compact",
    standing: 6,
    memory: "albany:memory_rowan_full_compact_duty",
    trust: 4,
    regard: 3,
    promise: "albany:promise_wolf_full_compact_duty",
    importFlag: "relief_oath_full_duty",
    importRule: "import:wolf_winter_full_compact_duty",
  },
  [LIMITED]: {
    minutes: 5,
    knowledge: "albany:knowledge_wolf_limited_aid_only",
    value: "value:bounded_authority",
    valueStrength: 4,
    faction: "faction:albany_relief_compact",
    standing: 3,
    memory: "albany:memory_rowan_limited_aid_only",
    trust: 3,
    regard: 4,
    promise: "albany:promise_wolf_limited_aid_only",
    importFlag: "relief_oath_limited_duty",
    importRule: "import:wolf_winter_limited_aid_only",
  },
  [UNAFFILIATED]: {
    minutes: 0,
    knowledge: "albany:knowledge_wolf_unaffiliated_bond",
    value: "value:voluntary_aid",
    valueStrength: 4,
    faction: "faction:independent_carriers",
    standing: 5,
    memory: "albany:memory_rowan_unaffiliated_personal_bond",
    trust: 2,
    regard: 5,
    promise: "albany:promise_wolf_unaffiliated_bond",
    importFlag: "relief_oath_unaffiliated_bond",
    importRule: "import:wolf_winter_unaffiliated_bond",
  },
} as const;

const ENDINGS = {
  ending_fortified_cade_terms: "Dawn Behind Cade's Shutters",
  ending_fortified_albany_authority: "Dawn Under Albany Seal",
  ending_pack_diverted: "The Pack Diverted Alive",
  ending_pack_diverted_cattle_scattered: "The Pack Diverted, Cattle Scattered",
  ending_drive_person_cattle_lost: "The People Out, Cattle Lost",
} as const;
type EndingId = keyof typeof ENDINGS;

function fixedRolls(...values: number[]): Rng {
  let cursor = 0;
  return {
    next: () => 0.5,
    int: (min, max) => {
      const value = values[cursor++] ?? max;
      expect(value).toBeGreaterThanOrEqual(min);
      expect(value).toBeLessThanOrEqual(max);
      return value;
    },
  };
}

function actionIds(state: GameState): string[] {
  return enumerateRpgActions(index, state).map((option) => option.id);
}

function act(state: GameState, actionId: string, ...rolls: number[]): GameState {
  const options = enumerateRpgActions(index, state);
  const option = options.find((candidate) => candidate.id === actionId);
  expect(
    option,
    `${actionId} must be legal in ${state.current}; legal: ${options
      .map((candidate) => candidate.id)
      .join(", ")}`,
  ).toBeDefined();
  if (!option) throw new Error(`Missing action ${actionId}.`);
  const result = makeStep(buildRpgRules(index, () => fixedRolls(...rolls)))(state, option.action);
  expect(result.ok, result.rejectionReason).toBe(true);
  return result.state;
}

function roundTripRpg(state: GameState): GameState {
  const bytes = save(state, compiled.contentHash, "rpg", { worldQuestId: WOLF.id });
  return load(bytes, compiled.contentHash, "rpg").state;
}

function reachOathOffer(profileId = LEDGER_PROFILE): OverworldSession {
  const session = new OverworldSession(WORLD);
  const civicPoi = session.view().pois[0];
  if (!civicPoi) throw new Error("Expected Albany's Civic opening point of interest.");
  session.scoutPoi(civicPoi.id);
  session.talkToCharacter(REGISTRATION.contact);
  session.chooseJourneyStory(profileId);
  const standardPacketId = REGISTRATION.doctrines?.find(
    (doctrine) => doctrine.profile_id === profileId,
  )?.id;
  expect(session.journey().storyChoice).toMatchObject({
    id: OATH.id,
    kind: "relief_oath",
    options: [...(standardPacketId ? [standardPacketId] : []), ...OATH_IDS].map((id) => ({ id })),
  });
  return session;
}

function selectOath(oathId: OathId, profileId = LEDGER_PROFILE): OverworldSession {
  const session = reachOathOffer(profileId);
  revealCurrentJourneyStoryOptions(session, OATH.id);
  session.chooseJourneyStory(oathId);
  expect(session.journey().storyChoice).toMatchObject({ id: LEAD.id, kind: "lead_source" });
  return session;
}

function rpgState(oathId: OathId, seed = 2026): GameState {
  const session = selectOath(oathId);
  const state = initStateForRpgPack(index, seed, {
    character: session.campaignCharacterState(),
    imports: IMPORTS,
  });
  const expected = OATH_CASES[oathId];
  expect(state.flags[expected.importFlag]).toBe(true);
  expect(state.campaignImportReceipt?.applied_rules).toContain(expected.importRule);
  return state;
}

function reachCadeDialogue(oathId: OathId): GameState {
  let state = rpgState(oathId);
  state = act(state, "go_north");
  return act(state, "talk_houndsman");
}

function commitAuthorityFortify(oathId: OathId): GameState {
  let state = reachCadeDialogue(oathId);
  state = act(state, "ask_fortify");
  state = act(state, "ask_commit_albany_authority");
  state = act(state, "ask_leave");
  state = act(state, "take_albany_relief_seals");
  return act(state, "go_north");
}

function commitLureFromState(state: GameState): GameState {
  state = act(state, "go_north");
  state = act(state, "talk_houndsman");
  state = act(state, "ask_lure");
  state = act(state, "ask_commit_lure");
  state = act(state, "ask_leave");
  state = act(state, "go_west");
  state = act(state, "take_winter_feed_sack");
  state = act(state, "go_east");
  return act(state, "go_north");
}

function commitLure(oathId: OathId): GameState {
  return commitLureFromState(rpgState(oathId));
}

function recoverFailedFirstLure(state: GameState): GameState {
  state = act(state, "wedge_paling_rail", 1);
  expect(state.flags.rail_split).toBe(true);
  state = act(state, "bind_paling_rail");
  state = act(state, "use_split_rail_guard_on_downwind_feed_line");
  expect(state.flags.yearling_redirected_with_split_guard).toBe(true);
  return state;
}

function recoverFailedFirstLureWithWorks(state: GameState): GameState {
  state = act(state, "set_paling_rail", 20);
  expect(state.flags.breach_braced).toBe(true);
  state = act(state, "turn_paling_rail");
  expect(state.flags.yearling_redirected_with_braced_rail).toBe(true);
  return state;
}

function reachFinalScentCast(state: GameState): GameState {
  state = act(state, "go_south");
  state = act(state, "go_west");
  state = act(state, "go_up");
  state = act(state, "use_winter_feed_sack_on_loft_hatch");
  state = act(state, "go_east");
  return act(state, "go_north");
}

function finishFinalScentCast(state: GameState): GameState {
  state = act(state, "use_winter_feed_sack_on_outer_scent_gate");
  return act(state, "go_north");
}

function commitDrive(oathId: OathId): GameState {
  let state = reachCadeDialogue(oathId);
  state = act(state, "ask_drive");
  state = act(state, "ask_commit_drive");
  state = act(state, "ask_leave");
  state = act(state, "take_drive_signal_rope_kit");
  return act(state, "go_north");
}

function moveToArea(session: OverworldSession, targetAreaId: string): void {
  const start = session.view().currentArea?.id;
  if (!start || start === targetAreaId) return;
  // Canonical district links are always visible. Optional discovered shortcuts
  // belong to other forks and must not become a hidden precondition of F02.
  const edges = WORLD.area_edges.filter(
    (edge) =>
      edge.home === session.view().current.id &&
      !edge.id.includes("shortcut") &&
      !edge.id.includes("loop"),
  );
  const queue = [start];
  const previous = new Map<string, string>();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!;
    if (current === targetAreaId) break;
    for (const edge of edges.filter(
      (candidate) => candidate.from_area === current || candidate.to_area === current,
    )) {
      const next = edge.from_area === current ? edge.to_area : edge.from_area;
      if (next === start || previous.has(next)) continue;
      previous.set(next, current);
      queue.push(next);
    }
  }
  const path: string[] = [];
  for (let cursor = targetAreaId; cursor !== start; ) {
    const prior = previous.get(cursor);
    if (!prior) throw new Error(`No Albany area route to ${targetAreaId}.`);
    path.unshift(cursor);
    cursor = prior;
  }
  for (const areaId of path) {
    const route = session.view().areaExits.find((candidate) => candidate.destination.id === areaId);
    if (!route) throw new Error(`Area route to ${areaId} is not visible.`);
    session.moveArea(route.id);
  }
}

function startedCampaign(oathId: OathId, profileId = LEDGER_PROFILE): OverworldSession {
  const session = selectOath(oathId, profileId);
  session.chooseJourneyStory("albany:source_rowan_civic_docket");
  moveToArea(session, PREPARATION.area);
  expect(session.view().departureInteractions[0]).toMatchObject({
    id: PREPARATION.id,
    kind: "preparation",
  });
  session.chooseJourneyStory("albany:prep_works_fortification");
  moveToArea(session, ALLOCATION.area);
  expect(session.view().departureInteractions[0]).toMatchObject({
    id: ALLOCATION.id,
    kind: "relief_allocation",
  });
  session.chooseJourneyStory("albany:relief_mobile_reserve");
  session.startQuest(WOLF.id, "albany:wolf_approach_sheltered_stockway");
  return session;
}

function reachAllyOffer(oathId: OathId): OverworldSession {
  const session = selectOath(oathId);
  session.chooseJourneyStory("albany:source_rowan_civic_docket");
  moveToArea(session, PREPARATION.area);
  session.chooseJourneyStory("albany:prep_works_fortification");
  moveToArea(session, ALLOCATION.area);
  session.chooseJourneyStory("albany:relief_mobile_reserve");
  session.talkToCharacter(ALLY.contact);
  expect(session.journey().storyChoice).toMatchObject({
    id: ALLY.id,
    kind: "ally",
    options: expect.arrayContaining([
      expect.objectContaining({ id: JUNE_PARTNERSHIP }),
      expect.objectContaining({ id: EXPLICIT_SOLO }),
    ]),
  });
  return session;
}

function rpgStateWithJune(oathId: OathId): GameState {
  const session = reachAllyOffer(oathId);
  session.chooseJourneyStory(JUNE_PARTNERSHIP);
  const state = initStateForRpgPack(index, 2026, {
    character: session.campaignCharacterState(),
    imports: IMPORTS,
  });
  expect(state.flags.june_pike_present).toBe(true);
  expect(state.campaignImportReceipt?.applied_rules).toEqual(
    expect.arrayContaining([
      OATH_CASES[oathId].importRule,
      "import:wolf_winter_june_companion",
      "import:wolf_winter_works_fortification",
    ]),
  );
  return state;
}

function completeCampaign(
  oathId: OathId,
  endingId: EndingId,
  profileId = LEDGER_PROFILE,
): OverworldSession {
  const session = startedCampaign(oathId, profileId);
  session.completeQuest(WOLF.id, {
    endingId,
    endingTitle: ENDINGS[endingId],
    death: false,
  });
  return session;
}

function promiseStatus(session: OverworldSession, oathId: OathId): string | undefined {
  const promiseId = OATH_CASES[oathId].promise;
  return session
    .campaignCharacterState()
    .promises.find((promise) => promise.promiseId === promiseId)?.status;
}

function completionText(session: OverworldSession): string | undefined {
  return session.snapshot().journalEntries.find((entry) => entry.id === `quest_done:${WOLF.id}`)
    ?.text;
}

function rowanMemories(session: OverworldSession): readonly string[] {
  return (
    session
      .campaignCharacterState()
      .relationships.find((relationship) => relationship.npcId === OATH.clerk_npc_id)?.memories ??
    []
  );
}

function addRoadStrain(session: OverworldSession): void {
  const outbound = session.view().exits.find((road) => road.destination.id === "colonie_town");
  if (!outbound) throw new Error("Expected Albany's Colonie road.");
  session.travel(outbound.id);
  if (session.view().pendingRoadEncounter) session.resolveRoadEncounter("press_on");
  const inbound = session.view().exits.find((road) => road.destination.id === "albany_city");
  if (!inbound) throw new Error("Expected Colonie's Albany road.");
  session.travel(inbound.id);
  if (session.view().pendingRoadEncounter) session.resolveRoadEncounter("press_on");
}

function returnToServiceArea(session: OverworldSession, areaId: string): OverworldSession {
  session.chooseJourney("continue");
  session.chooseJourneyStory("send_wagon_to_cade");
  if (!session.view().discoveredAreaIds.includes(areaId)) {
    // The truthful return lands at the Station. Its ordinary local actions
    // advance Albany's authored FIFO discovery before a Greenway service can
    // be visited; do not route through undiscovered shortcut edges.
    const station = session.view();
    const poi = station.pois[0];
    if (poi) session.scoutPoi(poi.id);
    if (!session.view().discoveredAreaIds.includes(areaId)) {
      const contact = session
        .view()
        .characters.find((candidate) => candidate.id === "albany_city__transport_hub__contact");
      if (!contact) throw new Error("Expected Hayden at Albany Station.");
      session.talkToCharacter(contact.id);
    }
    if (!session.view().discoveredAreaIds.includes(areaId)) {
      const event = session
        .view()
        .events.find((candidate) => !session.snapshot().resolvedEventIds.includes(candidate.id));
      if (!event) throw new Error(`Expected a Station action to discover ${areaId}.`);
      session.investigateEvent(event.id);
    }
  }
  addRoadStrain(session);
  moveToArea(session, areaId);
  return session;
}

describe("SS-F02 — relief oath paired counterfactual", () => {
  it("binds exactly one 10/5/0-minute durable character contract before source certification", () => {
    const pending = reachOathOffer();
    const pendingSnapshot = pending.snapshot();
    const presentedOptions = new Map(
      (pending.journey().storyChoice?.options ?? []).map((option) => [option.id, option]),
    );
    const disclosedOptions = new Map(
      (pending.journey().storyChoice?.options ?? []).map((option) => [
        option.id,
        option.consequence,
      ]),
    );
    for (const option of OATH.options) {
      const presented = presentedOptions.get(option.id);
      const immediateCost =
        option.terms.minutes === 0 ? "no added time" : `${String(option.terms.minutes)} minutes`;
      expect(presented?.summary).toEqual({
        commitment: option.summary,
        immediateCost,
        tradeoff: option.tradeoff,
      });
      expect(disclosedOptions.get(option.id)).toBe(
        `Benefit: ${option.trigger_category} Cost: ${immediateCost}. Tradeoff: ${option.tradeoff}`,
      );
      expect(disclosedOptions.get(option.id)?.match(/\S+/g)?.length).toBeLessThanOrEqual(32);
      expect(disclosedOptions.get(option.id)).not.toMatch(
        /Relief Protocol|Resident Shelter|consolidat|every strategy remains legal/i,
      );
    }

    for (const oathId of OATH_IDS) {
      const expected = OATH_CASES[oathId];
      const branch = OverworldSession.restore(WORLD, pendingSnapshot);
      revealCurrentJourneyStoryOptions(branch, OATH.id);
      const before = branch.snapshot();
      branch.chooseJourneyStory(oathId);
      const after = branch.snapshot();

      expect(after.minutes - before.minutes).toBe(expected.minutes);
      expect(after.character.knowledge).toContain(expected.knowledge);
      expect(after.character.values).toContainEqual({
        valueId: expected.value,
        strength: expected.valueStrength,
      });
      expect(after.character.factionStanding).toContainEqual({
        factionId: expected.faction,
        standing: expected.standing,
      });
      expect(after.character.promises).toContainEqual({
        promiseId: expected.promise,
        recipientId: OATH.clerk_npc_id,
        status: "active",
      });
      expect(
        after.character.relationships.find(
          (relationship) => relationship.npcId === OATH.clerk_npc_id,
        ),
      ).toMatchObject({
        trust: expected.trust,
        regard: expected.regard,
        memories: expect.arrayContaining([expected.memory]),
      });
      expect(after.journalEntries).toContainEqual(
        expect.objectContaining({
          id: `relief_oath:${OATH.id}:${oathId}`,
          kind: "relief_oath",
          storyChoiceBoundary: expect.objectContaining({
            acceptedDecisions: before.journey.acceptedDecisions + 1,
            minutes: after.minutes,
          }),
        }),
      );
      expect(branch.journey().storyChoice).toMatchObject({ id: LEAD.id, kind: "lead_source" });
      expect(OverworldSession.restore(WORLD, after).snapshot()).toEqual(after);
    }

    expect(pending.snapshot()).toEqual(pendingSnapshot);
  });

  it("closes the Unaffiliated Courier's registration tag across all oath terms without inventing it for other profiles", () => {
    const exports = WOLF.campaign_exports ?? [];
    expect(exports.length).toBeGreaterThan(0);
    for (const campaignExport of exports) {
      expect(campaignExport.conditional_effects).toContainEqual({
        id: "albany:close_unaffiliated_courier_emergency_tag",
        when: {
          requires_all_promises: [
            {
              promise_id: COURIER_TAG_PROMISE,
              status: "active",
            },
          ],
        },
        effects: [
          {
            type: "resolve_promise",
            promise_id: COURIER_TAG_PROMISE,
            status: "kept",
          },
        ],
      });
    }

    for (const oathId of OATH_IDS) {
      const courier = completeCampaign(oathId, "ending_pack_diverted", COURIER_PROFILE);
      expect(courier.campaignCharacterState().promises).toContainEqual({
        promiseId: COURIER_TAG_PROMISE,
        recipientId: OATH.clerk_npc_id,
        status: "kept",
      });
      expect(promiseStatus(courier, oathId)).toBe("kept");

      const ledger = completeCampaign(oathId, "ending_pack_diverted");
      expect(
        ledger
          .campaignCharacterState()
          .promises.some((promise) => promise.promiseId === COURIER_TAG_PROMISE),
      ).toBe(false);
      expect(promiseStatus(ledger, oathId)).toBe("kept");
    }
  });

  it("keeps June's partnership and an explicit solo departure reachable under every oath", () => {
    for (const oathId of OATH_IDS) {
      const offered = reachAllyOffer(oathId).snapshot();

      const partnered = OverworldSession.restore(WORLD, offered);
      const beforePartnership = partnered.snapshot();
      partnered.chooseJourneyStory(JUNE_PARTNERSHIP);
      const partneredCharacter = partnered.campaignCharacterState();
      expect(partnered.snapshot().minutes - beforePartnership.minutes).toBe(15);
      expect(partneredCharacter.companions).toContain(JUNE);
      expect(partneredCharacter.promises).toContainEqual({
        promiseId: JUNE_PROMISE,
        recipientId: JUNE,
        status: "active",
      });
      expect(partnered.startQuest(WOLF.id, "albany:wolf_approach_sheltered_stockway").id).toBe(
        WOLF.id,
      );
      expect(partnered.campaignCharacterState().companions).toContain(JUNE);

      const solo = OverworldSession.restore(WORLD, offered);
      const beforeSolo = solo.snapshot();
      solo.chooseJourneyStory(EXPLICIT_SOLO);
      const soloCharacter = solo.campaignCharacterState();
      expect(solo.snapshot().minutes).toBe(beforeSolo.minutes);
      expect(soloCharacter.companions).not.toContain(JUNE);
      expect(soloCharacter.promises.map((promise) => promise.promiseId)).not.toContain(
        JUNE_PROMISE,
      );
      expect(solo.startQuest(WOLF.id, "albany:wolf_approach_sheltered_stockway").id).toBe(WOLF.id);
      expect(solo.campaignCharacterState().companions).not.toContain(JUNE);
    }
  });

  it("keeps every strategy open and lowers only Full Duty's first authority seal DC", () => {
    const menus = OATH_IDS.map((oathId) =>
      actionIds(reachCadeDialogue(oathId)).filter((id) => id.startsWith("ask_")),
    );
    for (const menu of menus) {
      expect(menu).toEqual(
        expect.arrayContaining(["ask_wolves", "ask_lure", "ask_drive", "ask_fortify"]),
      );
    }
    expect(menus[1]).toEqual(menus[0]);
    expect(menus[0]).toContain("ask_current_support");
    expect(menus[1]).toContain("ask_current_support");
    expect(menus[2]).not.toContain("ask_current_support");
    expect(menus[2]).toEqual(menus[0]!.filter((id) => id !== "ask_current_support"));

    const fullPass = act(
      commitAuthorityFortify(FULL),
      "use_albany_relief_seals_on_fortify_outer_seal",
      12,
    );
    const limitedFail = act(
      commitAuthorityFortify(LIMITED),
      "use_albany_relief_seals_on_fortify_outer_seal",
      12,
    );
    expect(fullPass).toMatchObject({
      flags: { fortify_outer_seal_attempted: true, fortify_outer_sealed: true },
      vars: { fortification_pressure: 1, repair: 0 },
    });
    expect(fullPass.flags.fortify_outer_seal_failed).not.toBe(true);
    expect(fullPass.journal.join("\n")).toMatch(/Repair check succeeds at DC 12/i);
    expect(limitedFail).toMatchObject({
      flags: { fortify_outer_seal_attempted: true, fortify_outer_seal_failed: true },
      vars: { fortification_pressure: 2, repair: 0 },
    });
    expect(limitedFail.flags.fortify_outer_sealed).not.toBe(true);

    let fullMiss = act(
      commitAuthorityFortify(FULL),
      "use_albany_relief_seals_on_fortify_outer_seal",
      1,
    );
    let controlMiss = act(
      commitAuthorityFortify(LIMITED),
      "use_albany_relief_seals_on_fortify_outer_seal",
      1,
    );
    for (const miss of [fullMiss, controlMiss]) {
      expect(miss).toMatchObject({
        flags: { fortify_outer_seal_attempted: true, fortify_outer_seal_failed: true },
        vars: { fortification_pressure: 2 },
      });
      expect(actionIds(miss)).toContain("use_albany_relief_seals_on_authority_emergency_bind");
      expect(actionIds(miss)).not.toContain("use_albany_relief_seals_on_fortify_outer_seal");
      expect(miss.journal.join("\n")).toMatch(/cannot be retried[^]*emergency/i);
    }
    expect(fullMiss.journal.join("\n")).toMatch(/Cade will not help/i);
    expect(controlMiss.journal.join("\n")).toMatch(/Cade will not help/i);

    fullMiss = act(fullMiss, "use_albany_relief_seals_on_authority_emergency_bind");
    controlMiss = act(controlMiss, "use_albany_relief_seals_on_authority_emergency_bind");
    for (const recovered of [fullMiss, controlMiss]) {
      expect(recovered).toMatchObject({
        flags: {
          fortify_outer_seal_failed: true,
          fortify_outer_sealed: true,
          fortify_authority_emergency_seal_spent: true,
        },
        vars: { fortification_pressure: 2 },
      });
    }
  });

  it("suppresses Aid-Only's final alarm only after a clean first lure cast", () => {
    let limitedClean = act(commitLure(LIMITED), "use_winter_feed_sack_on_downwind_feed_line", 20);
    let controlClean = act(commitLure(FULL), "use_winter_feed_sack_on_downwind_feed_line", 20);
    expect(limitedClean.vars.cattle_alarm).toBe(1);
    expect(controlClean.vars.cattle_alarm).toBe(1);
    limitedClean = reachFinalScentCast(limitedClean);
    controlClean = reachFinalScentCast(controlClean);
    expect(limitedClean.vars.cattle_alarm).toBe(2);
    expect(controlClean.vars.cattle_alarm).toBe(2);
    limitedClean = finishFinalScentCast(limitedClean);
    controlClean = finishFinalScentCast(controlClean);
    expect(limitedClean).toMatchObject({
      ended: true,
      endingId: "ending_pack_diverted",
      vars: { cattle_alarm: 2 },
    });
    expect(controlClean).toMatchObject({
      ended: true,
      endingId: "ending_pack_diverted",
      vars: { cattle_alarm: 3 },
    });
    expect(limitedClean.journal.join("\n")).toMatch(
      /limited-duty herd count prevents the final 1 cattle alarm/i,
    );

    let limitedFailed = act(commitLure(LIMITED), "use_winter_feed_sack_on_downwind_feed_line", 1);
    let controlFailed = act(commitLure(FULL), "use_winter_feed_sack_on_downwind_feed_line", 1);
    for (const failed of [limitedFailed, controlFailed]) {
      expect(failed).toMatchObject({
        flags: { lure_trail_fouled: true },
        vars: { cattle_alarm: 2 },
      });
      expect(actionIds(failed)).not.toContain("use_winter_feed_sack_on_downwind_feed_line");
      expect(actionIds(failed)).toContain("wedge_paling_rail");
    }
    expect(roundTripRpg(limitedFailed)).toEqual(limitedFailed);

    limitedFailed = reachFinalScentCast(recoverFailedFirstLure(limitedFailed));
    controlFailed = reachFinalScentCast(recoverFailedFirstLure(controlFailed));
    expect(limitedFailed.flags.lure_trail_fouled).toBe(true);
    expect(controlFailed.flags.lure_trail_fouled).toBe(true);
    expect(limitedFailed.vars.cattle_alarm).toBe(3);
    expect(controlFailed.vars.cattle_alarm).toBe(3);

    limitedFailed = finishFinalScentCast(limitedFailed);
    controlFailed = finishFinalScentCast(controlFailed);
    expect(limitedFailed).toMatchObject({
      ended: true,
      endingId: "ending_pack_diverted_cattle_scattered",
      flags: { lure_trail_fouled: true },
      vars: { cattle_alarm: 4 },
    });
    expect(controlFailed).toMatchObject({
      ended: true,
      endingId: "ending_pack_diverted_cattle_scattered",
      flags: { lure_trail_fouled: true },
      vars: { cattle_alarm: 4 },
    });
    expect(limitedFailed.journal.join("\n")).not.toMatch(
      /limited-duty herd count prevents the final 1 cattle alarm/i,
    );

    let juneRecovered = act(
      commitLureFromState(rpgStateWithJune(LIMITED)),
      "use_winter_feed_sack_on_downwind_feed_line",
      1,
    );
    juneRecovered = recoverFailedFirstLureWithWorks(juneRecovered);
    juneRecovered = reachFinalScentCast(juneRecovered);
    expect(juneRecovered).toMatchObject({
      flags: { lure_trail_fouled: true, june_pike_present: true },
      vars: { cattle_alarm: 3 },
    });
    expect(actionIds(juneRecovered)).toContain("talk_june_pike");
    juneRecovered = act(juneRecovered, "talk_june_pike");
    juneRecovered = act(juneRecovered, "ask_acknowledge");
    expect(juneRecovered.vars.cattle_alarm).toBe(2);
    juneRecovered = finishFinalScentCast(juneRecovered);
    expect(juneRecovered).toMatchObject({
      ended: true,
      endingId: "ending_pack_diverted",
      flags: { lure_trail_fouled: true, june_cattle_line_taken: true },
      vars: { cattle_alarm: 3 },
    });
  });

  it("lowers only the Unaffiliated Bond's first drive shutter DC and preserves recovery", () => {
    const unaffiliatedPass = act(
      commitDrive(UNAFFILIATED),
      "use_drive_signal_rope_kit_on_drive_breach_signal",
      10,
    );
    const fullFail = act(commitDrive(FULL), "use_drive_signal_rope_kit_on_drive_breach_signal", 10);
    expect(unaffiliatedPass).toMatchObject({
      flags: { drive_yearling_turned: true },
      vars: { drive_kit_charges: 1, pack_drive: 1, cattle_alarm: 0, fieldcraft: 0 },
    });
    expect(unaffiliatedPass.flags.drive_opening_fouled).not.toBe(true);
    expect(unaffiliatedPass.journal.join("\n")).toMatch(/Fieldcraft check succeeds at DC 10/i);
    expect(fullFail).toMatchObject({
      flags: { drive_opening_fouled: true },
      vars: { drive_kit_charges: 1, pack_drive: 2, cattle_alarm: 1, fieldcraft: 0 },
    });
    expect(fullFail.flags.drive_yearling_turned).not.toBe(true);

    let unaffiliatedMiss = act(
      commitDrive(UNAFFILIATED),
      "use_drive_signal_rope_kit_on_drive_breach_signal",
      1,
    );
    let controlMiss = act(commitDrive(FULL), "use_drive_signal_rope_kit_on_drive_breach_signal", 1);
    for (const miss of [unaffiliatedMiss, controlMiss]) {
      expect(miss).toMatchObject({
        flags: { drive_opening_fouled: true },
        vars: { drive_kit_charges: 1, pack_drive: 2, cattle_alarm: 1 },
      });
      expect(actionIds(miss)).not.toContain("use_drive_signal_rope_kit_on_drive_breach_signal");
      expect(actionIds(miss)).toContain("use_drive_hurdle_recovery");
      expect(miss.journal.join("\n")).toMatch(/cannot be retried/i);
    }

    unaffiliatedMiss = act(unaffiliatedMiss, "use_drive_hurdle_recovery");
    controlMiss = act(controlMiss, "use_drive_hurdle_recovery");
    for (const recovered of [unaffiliatedMiss, controlMiss]) {
      expect(recovered).toMatchObject({
        flags: { drive_opening_fouled: true, drive_yearling_turned: true },
        vars: { drive_kit_charges: 1, pack_drive: 2, cattle_alarm: 1 },
      });
      expect(buildRpgObservation(index, recovered).enemies_present).toEqual([]);
    }
  });

  it("folds kept, bent, and broken promises into three distinct conditional services", () => {
    const fullAuthority = completeCampaign(FULL, "ending_fortified_albany_authority");
    const limitedAuthority = completeCampaign(LIMITED, "ending_fortified_albany_authority");
    const unaffiliatedAuthority = completeCampaign(
      UNAFFILIATED,
      "ending_fortified_albany_authority",
    );
    expect(promiseStatus(fullAuthority, FULL)).toBe("kept");
    expect(rowanMemories(fullAuthority)).toContain("albany:memory_rowan_full_duty_kept");
    expect(promiseStatus(limitedAuthority, LIMITED)).toBe("released");
    expect(rowanMemories(limitedAuthority)).toContain(
      "albany:memory_rowan_limited_duty_bent_to_authority",
    );
    expect(promiseStatus(unaffiliatedAuthority, UNAFFILIATED)).toBe("broken");
    expect(rowanMemories(unaffiliatedAuthority)).toContain(
      "albany:memory_rowan_unaffiliated_bond_broken",
    );

    const fullCade = completeCampaign(FULL, "ending_fortified_cade_terms");
    expect(promiseStatus(fullCade, FULL)).toBe("broken");
    expect(rowanMemories(fullCade)).toContain("albany:memory_rowan_full_duty_broken");

    // bug_0645: the completion journal reported the kept registration promise and
    // said nothing about the relief promise the same return broke.
    expect(completionText(fullCade)).toMatch(
      /Promise kept: give a truthful account\. Promise broken: use Albany's public seals during FORTIFY\.$/u,
    );
    expect(completionText(unaffiliatedAuthority)).toMatch(
      /Promise kept: give a truthful account\. Promise broken: claim no Albany authority\.$/u,
    );
    for (const unbroken of [fullAuthority, limitedAuthority]) {
      expect(completionText(unbroken)).toMatch(/Promise kept: give a truthful account\.$/u);
      expect(completionText(unbroken)).not.toContain("Promise broken");
    }

    const fullCivic = returnToServiceArea(fullAuthority, "albany_city__civic_core");
    const limitedCivic = returnToServiceArea(limitedAuthority, "albany_city__civic_core");
    expect(fullCivic.view().serviceOffers.map((offer) => offer.id)).toContain(
      "albany:full_oath_authority_return_resupply",
    );
    expect(limitedCivic.view().serviceOffers.map((offer) => offer.id)).not.toContain(
      "albany:full_oath_authority_return_resupply",
    );

    const limitedLiving = returnToServiceArea(
      completeCampaign(LIMITED, "ending_pack_diverted"),
      "albany_city__market",
    );
    const fullLiving = returnToServiceArea(
      completeCampaign(FULL, "ending_pack_diverted"),
      "albany_city__market",
    );
    const limitedScattered = returnToServiceArea(
      completeCampaign(LIMITED, "ending_pack_diverted_cattle_scattered"),
      "albany_city__market",
    );
    expect(promiseStatus(limitedLiving, LIMITED)).toBe("kept");
    expect(limitedLiving.view().serviceOffers.map((offer) => offer.id)).toContain(
      "albany:limited_oath_living_pack_return_rest",
    );
    expect(fullLiving.view().serviceOffers.map((offer) => offer.id)).not.toContain(
      "albany:limited_oath_living_pack_return_rest",
    );
    expect(limitedScattered.view().serviceOffers.map((offer) => offer.id)).not.toContain(
      "albany:limited_oath_living_pack_return_rest",
    );
    expect(limitedScattered.campaignWorldFactIds()).not.toContain("fact:wolf_winter_cattle_whole");
    const limitedScatteredGreenway = returnToServiceArea(
      completeCampaign(LIMITED, "ending_pack_diverted_cattle_scattered"),
      "albany_city__greenway",
    );
    expect(limitedScatteredGreenway.view().serviceOffers.map((offer) => offer.id)).not.toContain(
      "albany:wolf_live_pack_greenway_resupply",
    );

    const unaffiliatedDrive = returnToServiceArea(
      completeCampaign(UNAFFILIATED, "ending_drive_person_cattle_lost"),
      "albany_city__greenway",
    );
    const limitedDrive = returnToServiceArea(
      completeCampaign(LIMITED, "ending_drive_person_cattle_lost"),
      "albany_city__greenway",
    );
    expect(promiseStatus(unaffiliatedDrive, UNAFFILIATED)).toBe("kept");
    expect(unaffiliatedDrive.view().serviceOffers.map((offer) => offer.id)).toContain(
      "albany:unaffiliated_bond_returned_rig_resupply",
    );
    expect(limitedDrive.view().serviceOffers.map((offer) => offer.id)).not.toContain(
      "albany:unaffiliated_bond_returned_rig_resupply",
    );

    const offeredSnapshot = unaffiliatedDrive.snapshot();
    const restored = OverworldSession.restore(WORLD, offeredSnapshot);
    expect(promiseStatus(restored, UNAFFILIATED)).toBe("kept");
    expect(restored.view().serviceOffers).toEqual(unaffiliatedDrive.view().serviceOffers);
    expect(restored.snapshot()).toEqual(offeredSnapshot);

    const serviceCases = [
      {
        session: fullCivic,
        serviceId: "albany:full_oath_authority_return_resupply",
        action: "resupply" as const,
      },
      {
        session: limitedLiving,
        serviceId: "albany:limited_oath_living_pack_return_rest",
        action: "rest" as const,
      },
      {
        session: unaffiliatedDrive,
        serviceId: "albany:unaffiliated_bond_returned_rig_resupply",
        action: "resupply" as const,
      },
    ];

    for (const serviceCase of serviceCases) {
      const beforeView = serviceCase.session.view();
      const before = serviceCase.session.snapshot();
      expect(beforeView.serviceOffers).toContainEqual(
        expect.objectContaining({
          id: serviceCase.serviceId,
          action: serviceCase.action,
          minutes: 15,
        }),
      );

      if (serviceCase.action === "resupply") {
        expect(beforeView.supplies).toBeLessThan(beforeView.maxSupplies);
        const result = serviceCase.session.resupplyAtTown();
        expect(result).toMatchObject({
          action: "resupply",
          changed: true,
          minutes: 15,
          suppliesBefore: beforeView.supplies,
          suppliesAfter: beforeView.maxSupplies,
        });
        expect(serviceCase.session.view()).toMatchObject({
          supplies: beforeView.maxSupplies,
          fatigue: beforeView.fatigue,
        });
      } else {
        expect(beforeView.fatigue).toBeGreaterThan(0);
        const result = serviceCase.session.restAtTown();
        expect(result).toMatchObject({
          action: "rest",
          changed: true,
          minutes: 15,
          fatigueBefore: beforeView.fatigue,
          fatigueAfter: 0,
        });
        expect(serviceCase.session.view()).toMatchObject({
          supplies: beforeView.supplies,
          fatigue: 0,
        });
      }

      const remainingOffers = serviceCase.session.view().serviceOffers;
      const consumed = serviceCase.session.snapshot();
      expect(consumed.minutes - before.minutes).toBe(15);
      expect(remainingOffers.map((offer) => offer.id)).not.toContain(serviceCase.serviceId);
      expect(consumed.journalEntries).toContainEqual(
        expect.objectContaining({
          kind: "service",
          serviceRuleId: serviceCase.serviceId,
        }),
      );

      const restoredConsumed = OverworldSession.restore(WORLD, consumed);
      expect(restoredConsumed.snapshot()).toEqual(consumed);
      expect(restoredConsumed.view().serviceOffers).toEqual(remainingOffers);
      expect(restoredConsumed.view().serviceOffers.map((offer) => offer.id)).not.toContain(
        serviceCase.serviceId,
      );
    }
  });
});
