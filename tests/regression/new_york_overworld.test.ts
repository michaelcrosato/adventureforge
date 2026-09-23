import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  assertOverworldIntegrity,
  overworldAreasAt,
  overworldEdgesFrom,
  overworldEventsAt,
  overworldQuestCampaignExportForEnding,
  parseOverworldManifest,
} from "../../src/world/overworld.js";
import {
  overworldCharactersAt,
  overworldExplorationSitesNear,
  overworldJobsAt,
  planOverworldRoute,
} from "./support/overworld_queries.js";
import { cloneOverworldRoadEvent } from "../../src/world/overworld_clone.js";
import { loadOverworldManifest } from "../../src/world/source.js";

const world = loadOverworldManifest(process.cwd());

describe("New York overworld graph", () => {
  it("uses New York as a town-and-road overworld, not a global quest menu", () => {
    expect(world.id).toBe("new_york_overworld");
    expect(world.start).toBe("albany_city");
    expect(world.scale.population_floor).toBe(10_000);
    expect(world.nodes.length).toBeGreaterThanOrEqual(240);
    expect(world.quests.length).toBe(12);
    expect(world.design_rules.join(" ")).toContain("not all available at the start");
    expect(world.design_rules.join(" ")).toContain("Notice boards start empty");
    expect(world.design_rules.join(" ")).toContain(
      "next area, job, site, and quest lead available here",
    );
    expect(world.design_rules.join(" ")).toContain(
      "Every local area has a point of interest, a named contact, and an event",
    );
    expect(world.design_rules.join(" ")).toContain("discoverable timed job");
    expect(world.design_rules.join(" ")).toContain(
      "Only authored road scenes stop travel for a choice",
    );
    expect(world.design_rules.join(" ")).toContain("ambient reports never block");
    expect(world.design_rules.join(" ")).toContain("connected route network");
    expect(world.regions.length).toBe(9);
    expect(world.regional_arcs.length).toBe(world.regions.length);
  });

  it("contains the major state population centers and only >=10K town nodes", () => {
    const byId = new Map(world.nodes.map((node) => [node.id, node]));

    for (const id of [
      "new_york_city",
      "buffalo_city",
      "rochester_city",
      "syracuse_city",
      "albany_city",
      "hempstead_town",
      "brookhaven_town",
    ]) {
      expect(byId.get(id), id).toBeDefined();
    }
    expect(world.nodes.filter((node) => node.population_2025 < 10_000)).toEqual([]);
    expect(byId.get("new_york_city")?.kind).toBe("metropolis");
    expect(byId.get("albany_city")?.kind).toBe("major_city");
  });

  it("has a connected weighted road graph with proportional travel time", () => {
    expect(() => assertOverworldIntegrity(world)).not.toThrow();
    expect(world.edges.length).toBeGreaterThan(world.nodes.length);
    expect(world.edges.some((edge) => edge.route.includes("I-90"))).toBe(true);
    expect(world.edges.some((edge) => edge.route.includes("I-87"))).toBe(true);
    expect(world.edges.some((edge) => edge.route.includes("I-495"))).toBe(true);

    const albanyRoads = overworldEdgesFrom(world, "albany_city");
    expect(albanyRoads.length).toBeGreaterThan(3);
    expect(albanyRoads.length).toBeLessThan(world.nodes.length / 10);
    expect(albanyRoads.map((edge) => edge.destination.id)).toContain("colonie_town");

    const buffaloRoute = planOverworldRoute(world, "albany_city", "buffalo_city");
    expect(buffaloRoute).not.toBeNull();
    expect(buffaloRoute!.steps.length).toBeGreaterThan(1);
    expect(buffaloRoute!.steps.some((step) => step.edge.route.includes("I-90"))).toBe(true);
    expect(buffaloRoute!.totalMinutes).toBe(
      buffaloRoute!.steps.reduce((sum, step) => sum + step.edge.travel_minutes, 0),
    );
  });

  it("binds opening registration packages to Albany contacts and complete character state", () => {
    const registration = world.opening_registration;
    expect(registration).toMatchObject({
      id: "albany:relief_registration",
      home: "albany_city",
      area: "albany_city__civic_core",
      contact: "albany_city__civic_core__contact",
    });
    expect(registration?.profiles.map((profile) => profile.id)).toEqual([
      "albany:road_warden",
      "albany:ledger_advocate",
      "albany:ironhands_repairer",
      "albany:unaffiliated_courier",
    ]);
    const campaignNpcIds = new Set(
      world.characters.flatMap((character) =>
        character.campaign_npc_id === undefined ? [] : [character.campaign_npc_id],
      ),
    );
    const contactByCampaignNpcId = new Map(
      world.characters.flatMap((character) =>
        character.campaign_npc_id === undefined
          ? []
          : ([[character.campaign_npc_id, character]] as const),
      ),
    );
    for (const profile of registration?.profiles ?? []) {
      expect(profile.character.relationships).toHaveLength(2);
      expect(
        profile.character.relationships.every((relationship) =>
          campaignNpcIds.has(relationship.npcId),
        ),
      ).toBe(true);
      for (const relationship of profile.character.relationships) {
        expect(relationship.memories.length).toBeGreaterThan(0);
        const contact = contactByCampaignNpcId.get(relationship.npcId);
        expect(
          relationship.memories.every((memoryId) =>
            contact?.variants?.some((variant) =>
              variant.after_relationship_memories?.includes(memoryId),
            ),
          ),
        ).toBe(true);
      }
      expect(
        profile.character.promises.every((promise) => campaignNpcIds.has(promise.recipientId)),
      ).toBe(true);
    }

    const missingContact = structuredClone(world);
    missingContact.opening_registration!.contact = "missing_contact";
    expect(() => assertOverworldIntegrity(missingContact)).toThrow(
      /registration contact must exist/i,
    );

    const emptyPackage = structuredClone(world);
    emptyPackage.opening_registration!.profiles[0]!.character.skills = [];
    expect(() => assertOverworldIntegrity(emptyPackage)).toThrow(
      /must provide a skill, value, equipment package, obligation/i,
    );

    const inactiveObligation = structuredClone(world);
    inactiveObligation.opening_registration!.profiles[0]!.character.promises[0]!.status =
      "released";
    expect(() => assertOverworldIntegrity(inactiveObligation)).toThrow(
      /must provide a skill, value, equipment package, obligation/i,
    );

    const unboundRelationship = structuredClone(world);
    unboundRelationship.opening_registration!.profiles[0]!.character.relationships[0]!.npcId =
      "albany:unbound_person";
    expect(() => assertOverworldIntegrity(unboundRelationship)).toThrow(
      /references unbound campaign npc/i,
    );

    const emptyMemory = structuredClone(world);
    emptyMemory.opening_registration!.profiles[0]!.character.relationships[0]!.memories = [];
    expect(() => assertOverworldIntegrity(emptyMemory)).toThrow(/has no authored memory/i);

    const unconsumedMemory = structuredClone(world);
    unconsumedMemory.opening_registration!.profiles[0]!.character.relationships[0]!.memories = [
      "albany:memory_no_contact_consumes_this",
    ];
    expect(() => assertOverworldIntegrity(unconsumedMemory)).toThrow(
      /has no consuming contact variant/i,
    );
  });

  it("hand-authors the Albany-Colonie road event as direction-safe starting-area texture", () => {
    const albanyExit = overworldEdgesFrom(world, "albany_city").find(
      (edge) => edge.destination.id === "colonie_town",
    );
    const colonieExit = overworldEdgesFrom(world, "colonie_town").find(
      (edge) => edge.destination.id === "albany_city",
    );
    expect(albanyExit).toBeDefined();
    expect(colonieExit).toBeDefined();
    expect(colonieExit?.id).toBe(albanyExit?.id);

    const event = world.road_events.find((roadEvent) => roadEvent.edge === albanyExit?.id);
    expect(event).toBeDefined();
    expect(event?.title).toBe("Blocked Thruway Shoulder");
    expect(event?.title.toLowerCase()).not.toContain("road report");
    expect(event?.summary).toContain("I-90 between Albany and Colonie");
    expect(event?.summary).toContain("jackknifed truck");
    expect(event?.summary).not.toMatch(/Albany city to Colonie town|Colonie town to Albany city/);
    expect(event?.requires_choice).toBe(true);
    expect(event?.active_goal_ids).toBeUndefined();
    expect(event?.retire_after_quest).toBeUndefined();
    expect(event?.responses).toMatchObject({
      cautious_scout: { label: "Inspect the Safe Route" },
      assist_travelers: { label: "Help Move the Truck" },
      press_on: { label: "Push Through the Gap" },
    });
  });

  it("separates ambient reports from goal-scoped, authored road choices", () => {
    const byId = new Map(world.road_events.map((event) => [event.id, event]));
    const choiceEvents = world.road_events.filter((event) => event.requires_choice === true);

    expect(choiceEvents.map((event) => event.id).sort()).toEqual([
      "road_event_albany_city__saratoga_springs_city",
      "road_event_colonie_town__albany_city",
      "road_event_rome_city__oneida_city",
    ]);
    for (const event of choiceEvents) {
      expect(event.responses, event.id).toBeDefined();
      const responses = Object.values(event.responses!);
      expect(new Set(responses.map((response) => response.label.toLowerCase())).size).toBe(3);
      expect(new Set(responses.map((response) => response.outcome.toLowerCase())).size).toBe(3);
    }

    const relief = byId.get("road_event_albany_city__saratoga_springs_city");
    expect(relief).toMatchObject({
      active_goal_ids: ["carry_hedricks_packet_north", "travel_north_with_albany_wardens"],
      retire_after_quest: "gallowmere",
    });

    const moorSign = byId.get("road_event_saratoga_springs_city__queensbury_town");
    expect(moorSign).toMatchObject({
      active_goal_ids: ["carry_hedricks_packet_north", "travel_north_with_albany_wardens"],
      retire_after_quest: "gallowmere",
    });
    expect(moorSign?.requires_choice).toBeUndefined();
    expect(moorSign?.responses).toBeUndefined();

    const risingRiver = byId.get("road_event_rome_city__oneida_city");
    expect(risingRiver).toMatchObject({
      title: "Rising Water Near the Weir",
      active_goal_ids: [
        "rome_breaking_weir",
        "rome_breaking_weir_household_correction",
        "rome_breaking_weir_public_warning",
      ],
      retire_after_quest: "breaking_weir",
    });
    expect(risingRiver?.summary).toContain("upper weir may fail");
    expect(risingRiver?.summary).not.toMatch(/Rome city to Oneida city|Oneida city to Rome city/);

    const generic = world.road_events.find(
      (event) =>
        event.requires_choice !== true &&
        event.active_goal_ids === undefined &&
        event.retire_after_quest === undefined,
    );
    expect(generic).toBeDefined();
    expect(generic?.requires_choice).toBeUndefined();
    expect(generic?.active_goal_ids).toBeUndefined();
    expect(generic?.retire_after_quest).toBeUndefined();
    expect(generic?.responses).toBeUndefined();
  });

  it("enforces authored road-response integrity and clones its nested fields", () => {
    const event = world.road_events.find(
      (candidate) => candidate.id === "road_event_albany_city__saratoga_springs_city",
    )!;
    const clone = cloneOverworldRoadEvent(event);
    expect(clone).not.toBe(event);
    expect(clone.active_goal_ids).not.toBe(event.active_goal_ids);
    expect(clone.responses).not.toBe(event.responses);
    expect(clone.responses?.cautious_scout).not.toBe(event.responses?.cautious_scout);

    const missingResponses = structuredClone(world);
    const choiceWithoutResponses = missingResponses.road_events.find(
      (candidate) => candidate.id === event.id,
    )!;
    delete choiceWithoutResponses.responses;
    expect(() => assertOverworldIntegrity(missingResponses)).toThrow(
      /must define requires_choice and responses together/,
    );

    const duplicateOutcomes = structuredClone(world);
    const duplicated = duplicateOutcomes.road_events.find(
      (candidate) => candidate.id === event.id,
    )!;
    duplicated.responses!.press_on.outcome = duplicated.responses!.cautious_scout.outcome;
    expect(() => assertOverworldIntegrity(duplicateOutcomes)).toThrow(
      /response outcomes must be unique/,
    );

    const questIds = new Set(world.quests.map((quest) => quest.id));
    for (const roadEvent of world.road_events) {
      if (roadEvent.retire_after_quest) {
        expect(questIds.has(roadEvent.retire_after_quest), roadEvent.id).toBe(true);
      }
    }
  });

  it("places old quest sources locally instead of exposing all of them at start", () => {
    const local = world.quests.filter((quest) => quest.home === world.start);
    expect(local.length).toBeGreaterThan(0);
    expect(local.length).toBeLessThan(world.quests.length);
    expect(new Set(world.quests.map((quest) => quest.source)).size).toBe(world.quests.length);
    expect(world.design_rules.join(" ")).toContain("only from its listed local area");

    const areasById = new Map(world.areas.map((area) => [area.id, area]));
    for (const quest of world.quests) {
      const area = areasById.get(quest.area);
      expect(area, quest.id).toBeDefined();
      expect(area?.home, quest.id).toBe(quest.home);
      if (quest.id === "wolf_winter") {
        expect(quest.discovery).toContain("Old Cade");
      } else {
        expect(quest.discovery, quest.id).toContain(area?.name);
      }
    }
  });

  it("authors every Wolf-Winter non-death campaign export as distinct monotonic history", () => {
    const wolfWinter = world.quests.find((quest) => quest.id === "wolf_winter")!;
    const legacyQuests = world.quests.filter((quest) => quest.id !== wolfWinter.id);

    expect(legacyQuests.every((quest) => !("campaign_exports" in quest))).toBe(true);
    expect(wolfWinter.campaign_exports?.map((entry) => entry.ending_id)).toEqual([
      "ending_bloodied_byre_evacuated",
      "ending_pack_diverted_after_blood",
      "ending_pack_diverted_cattle_scattered",
      "ending_pack_diverted",
      "ending_drive_cattle_wounded",
      "ending_drive_person_cattle_lost",
      "ending_drive_reserve_spent",
      "ending_fortified_cade_terms",
      "ending_fortified_albany_authority",
      "ending_held_gate_barred",
      "ending_held_timber_saved",
      "ending_held",
      "ending_held_gate_barred_june_released",
      "ending_held_timber_saved_june_released",
      "ending_held_june_released",
      "ending_bloodied_byre_evacuated_june_released",
    ]);
    expect(wolfWinter.campaign_exports?.map((entry) => entry.ending_title)).toEqual([
      "The Bloodied Byre Evacuated",
      "The Pack Broken After Blood",
      "The Pack Diverted, Cattle Scattered",
      "The Pack Diverted Alive",
      "The Herd Out, Rider Hurt",
      "The People Out, Cattle Lost",
      "The Steading Evacuated, Reserve Spent",
      "Dawn Behind Cade's Shutters",
      "Dawn Under Albany Seal",
      "The Byre Held, Inner Gate Barred",
      "The Byre Held, Paling Timber Saved",
      "The Byre Held",
      "The Byre Held, Inner Gate Barred — June Released",
      "The Byre Held, Paling Timber Saved — June Released",
      "The Byre Held — June Released",
      "The Bloodied Byre Evacuated — June Released",
    ]);
    expect(overworldQuestCampaignExportForEnding(wolfWinter, "ending_pulled_down")).toBeNull();

    const expectedOutcomeFacts = {
      ending_bloodied_byre_evacuated: [
        "fact:wolf_winter_bloodshed",
        "fact:wolf_winter_yearling_killed",
        "fact:wolf_winter_flank_wolf_killed",
        "fact:wolf_winter_old_grey_leader_remains",
        "fact:wolf_winter_steading_evacuated",
        "fact:wolf_winter_outer_line_abandoned",
        "fact:wolf_winter_people_safe",
        "fact:wolf_winter_cattle_scattered",
        "fact:wolf_winter_bloodied_byre_evacuated",
      ],
      ending_pack_diverted_after_blood: [
        "fact:wolf_winter_byre_held",
        "fact:wolf_winter_outer_paling_broken",
        "fact:wolf_winter_yearling_killed",
        "fact:wolf_winter_bloodshed",
        "fact:wolf_winter_two_wolves_diverted_alive",
        "fact:wolf_winter_winter_feed_spent",
        "fact:wolf_winter_cattle_scattered",
      ],
      ending_pack_diverted_cattle_scattered: [
        "fact:wolf_winter_byre_held",
        "fact:wolf_winter_outer_paling_broken",
        "fact:wolf_winter_pack_diverted_alive",
        "fact:wolf_winter_winter_feed_spent",
        "fact:wolf_winter_cattle_scattered",
      ],
      ending_pack_diverted: [
        "fact:wolf_winter_byre_held",
        "fact:wolf_winter_outer_paling_broken",
        "fact:wolf_winter_pack_diverted_alive",
        "fact:wolf_winter_winter_feed_spent",
        "fact:wolf_winter_cattle_whole",
      ],
      ending_drive_cattle_wounded: [
        "fact:wolf_winter_outer_line_abandoned",
        "fact:wolf_winter_pack_driven_alive",
        "fact:wolf_winter_steading_evacuated",
        "fact:wolf_winter_people_safe",
        "fact:wolf_winter_cattle_whole",
        "fact:wolf_winter_drive_reserve_returned",
        "fact:wolf_winter_courier_wounded",
      ],
      ending_drive_person_cattle_lost: [
        "fact:wolf_winter_outer_line_abandoned",
        "fact:wolf_winter_pack_driven_alive",
        "fact:wolf_winter_steading_evacuated",
        "fact:wolf_winter_people_safe",
        "fact:wolf_winter_cattle_scattered",
        "fact:wolf_winter_drive_reserve_returned",
        "fact:wolf_winter_people_prioritized",
      ],
      ending_drive_reserve_spent: [
        "fact:wolf_winter_outer_line_abandoned",
        "fact:wolf_winter_pack_driven_alive",
        "fact:wolf_winter_steading_evacuated",
        "fact:wolf_winter_people_safe",
        "fact:wolf_winter_cattle_whole",
        "fact:wolf_winter_drive_reserve_spent",
      ],
      ending_fortified_cade_terms: [
        "fact:wolf_winter_byre_held",
        "fact:wolf_winter_pack_outlasted_alive",
        "fact:wolf_winter_people_safe",
        "fact:wolf_winter_cattle_whole",
        "fact:wolf_winter_cade_terms_honored",
        "fact:wolf_winter_outer_property_exposed",
        "fact:wolf_winter_public_relief_seals_preserved",
      ],
      ending_fortified_albany_authority: [
        "fact:wolf_winter_byre_held",
        "fact:wolf_winter_pack_outlasted_alive",
        "fact:wolf_winter_people_safe",
        "fact:wolf_winter_cattle_whole",
        "fact:wolf_winter_albany_authority_invoked",
        "fact:wolf_winter_outer_property_preserved",
        "fact:wolf_winter_public_relief_seals_spent",
        "fact:wolf_winter_cade_help_refused",
      ],
      ending_held_gate_barred: [
        "fact:wolf_winter_byre_held",
        "fact:wolf_winter_bloodshed",
        "fact:wolf_winter_outer_paling_broken",
        "fact:wolf_winter_inner_gate_barred_at_dawn",
        "fact:wolf_winter_guard_wood_committed",
      ],
      ending_held_timber_saved: [
        "fact:wolf_winter_byre_held",
        "fact:wolf_winter_bloodshed",
        "fact:wolf_winter_outer_paling_broken",
        "fact:wolf_winter_repair_timber_available",
      ],
      ending_held: [
        "fact:wolf_winter_byre_held",
        "fact:wolf_winter_bloodshed",
        "fact:wolf_winter_outer_paling_broken",
        "fact:wolf_winter_repair_timber_spent",
      ],
      ending_held_gate_barred_june_released: [
        "fact:wolf_winter_byre_held",
        "fact:wolf_winter_bloodshed",
        "fact:wolf_winter_outer_paling_broken",
        "fact:wolf_winter_inner_gate_barred_at_dawn",
        "fact:wolf_winter_guard_wood_committed",
      ],
      ending_held_timber_saved_june_released: [
        "fact:wolf_winter_byre_held",
        "fact:wolf_winter_bloodshed",
        "fact:wolf_winter_outer_paling_broken",
        "fact:wolf_winter_repair_timber_available",
      ],
      ending_held_june_released: [
        "fact:wolf_winter_byre_held",
        "fact:wolf_winter_bloodshed",
        "fact:wolf_winter_outer_paling_broken",
        "fact:wolf_winter_repair_timber_spent",
      ],
      ending_bloodied_byre_evacuated_june_released: [
        "fact:wolf_winter_bloodshed",
        "fact:wolf_winter_yearling_killed",
        "fact:wolf_winter_flank_wolf_killed",
        "fact:wolf_winter_old_grey_leader_remains",
        "fact:wolf_winter_steading_evacuated",
        "fact:wolf_winter_outer_line_abandoned",
        "fact:wolf_winter_people_safe",
        "fact:wolf_winter_cattle_scattered",
        "fact:wolf_winter_bloodied_byre_evacuated",
      ],
    } as const;
    const expectedMemories = {
      ending_bloodied_byre_evacuated: [
        ["npc:old_cade", "memory:wolf_winter_bloodied_byre_evacuated", 3, 4, 0],
        ["albany:emery_sloane", "albany:memory_emery_wolf_bloodied_byre_evacuated", 2, 3, 0],
      ],
      ending_pack_diverted_after_blood: [
        ["npc:old_cade", "memory:wolf_winter_mixed_line_after_blood", 7, 7, 0],
        ["albany:emery_sloane", "albany:memory_emery_wolf_pack_diverted_after_blood", 4, 5, 0],
      ],
      ending_pack_diverted_cattle_scattered: [
        ["npc:old_cade", "memory:wolf_winter_cattle_scattered", 5, 5, 0],
        ["albany:emery_sloane", "albany:memory_emery_wolf_pack_diverted_with_loss", 2, 3, 0],
      ],
      ending_pack_diverted: [
        ["npc:old_cade", "memory:wolf_winter_pack_diverted_alive", 12, 12, 1],
        ["albany:emery_sloane", "albany:memory_emery_wolf_pack_diverted_alive", 6, 8, 1],
      ],
      ending_drive_cattle_wounded: [
        ["npc:old_cade", "memory:wolf_winter_drive_herd_first_wound", 10, 12, 1],
        ["albany:emery_sloane", "albany:memory_emery_drive_herd_first_wound", 7, 9, 1],
      ],
      ending_drive_person_cattle_lost: [
        ["npc:old_cade", "memory:wolf_winter_drive_people_first_cattle_lost", 8, 10, 1],
        ["albany:emery_sloane", "albany:memory_emery_drive_people_first_cattle_lost", 4, 6, 0],
      ],
      ending_drive_reserve_spent: [
        ["npc:old_cade", "memory:wolf_winter_drive_signal_spent", 12, 12, 1],
        ["albany:emery_sloane", "albany:memory_emery_drive_signal_spent", 8, 10, 1],
      ],
      ending_fortified_cade_terms: [
        ["npc:old_cade", "memory:wolf_winter_fortified_cade_terms", 12, 12, 1],
        ["albany:hayden_hale", "albany:memory_hayden_wolf_fortified_cade_terms", 8, 9, 1],
      ],
      ending_fortified_albany_authority: [
        ["npc:old_cade", "memory:wolf_winter_fortified_albany_authority", 0, 7, 0],
        ["albany:hayden_hale", "albany:memory_hayden_wolf_fortified_albany_authority", 10, 12, 1],
      ],
      ending_held_gate_barred: [
        ["npc:old_cade", "memory:wolf_winter_inner_gate_barred", 10, 10, 1],
        ["albany:emery_sloane", "albany:memory_emery_wolf_full_combat_bloodshed", 4, 5, 0],
      ],
      ending_held_timber_saved: [
        ["npc:old_cade", "memory:wolf_winter_repair_timber_saved", 10, 10, 1],
        ["albany:emery_sloane", "albany:memory_emery_wolf_full_combat_bloodshed", 4, 5, 0],
      ],
      ending_held: [
        ["npc:old_cade", "memory:wolf_winter_guard_wood_spent", 10, 10, 1],
        ["albany:emery_sloane", "albany:memory_emery_wolf_full_combat_bloodshed", 4, 5, 0],
      ],
      ending_held_gate_barred_june_released: [
        ["npc:old_cade", "memory:wolf_winter_inner_gate_barred", 10, 10, 1],
        ["albany:emery_sloane", "albany:memory_emery_wolf_full_combat_bloodshed", 4, 5, 0],
      ],
      ending_held_timber_saved_june_released: [
        ["npc:old_cade", "memory:wolf_winter_repair_timber_saved", 10, 10, 1],
        ["albany:emery_sloane", "albany:memory_emery_wolf_full_combat_bloodshed", 4, 5, 0],
      ],
      ending_held_june_released: [
        ["npc:old_cade", "memory:wolf_winter_guard_wood_spent", 10, 10, 1],
        ["albany:emery_sloane", "albany:memory_emery_wolf_full_combat_bloodshed", 4, 5, 0],
      ],
      ending_bloodied_byre_evacuated_june_released: [
        ["npc:old_cade", "memory:wolf_winter_bloodied_byre_evacuated", 3, 4, 0],
        ["albany:emery_sloane", "albany:memory_emery_wolf_bloodied_byre_evacuated", 2, 3, 0],
      ],
    } as const;

    for (const [endingId, facts] of Object.entries(expectedOutcomeFacts)) {
      const campaignExport = overworldQuestCampaignExportForEnding(wolfWinter, endingId);
      expect(campaignExport).not.toBeNull();
      expect(campaignExport?.effects.filter((effect) => effect.type === "set_world_fact")).toEqual(
        facts.map((fact_id) => ({ type: "set_world_fact", fact_id })),
      );
      expect(
        campaignExport?.effects.filter((effect) => effect.type === "remember_relationship"),
      ).toEqual(
        expectedMemories[endingId as keyof typeof expectedMemories].map(
          ([npc_id, memory_id, trust_at_least, regard_at_least, owes_player_at_least]) => ({
            type: "remember_relationship",
            npc_id,
            memory_id,
            trust_at_least,
            regard_at_least,
            owes_player_at_least,
          }),
        ),
      );
      expect(campaignExport?.effects.filter((effect) => effect.type === "suffer_wound")).toEqual(
        endingId === "ending_drive_cattle_wounded"
          ? [
              {
                type: "suffer_wound",
                wound_id: "wound:wolf_winter_byre_mouth_gate",
                severity: 2,
                treatment: "untreated",
                health_loss: 6,
              },
            ]
          : [],
      );
    }
  });

  it("keeps the released bloodied-byre export identical outside June's disposition", () => {
    const wolfWinter = world.quests.find((quest) => quest.id === "wolf_winter")!;
    const retained = overworldQuestCampaignExportForEnding(
      wolfWinter,
      "ending_bloodied_byre_evacuated",
    );
    const released = overworldQuestCampaignExportForEnding(
      wolfWinter,
      "ending_bloodied_byre_evacuated_june_released",
    );
    expect(released?.effects).toEqual(retained?.effects);
    expect(released?.conditional_effects?.filter((group) => !group.id.includes("june_"))).toEqual(
      retained?.conditional_effects?.filter((group) => !group.id.includes("june_")),
    );
    expect(released?.conditional_effects?.find((group) => group.id.includes("june_"))).toEqual({
      id: "albany:june_released_before_bloodied_byre_hunt",
      when: {
        requires_all_companions: ["albany:june_pike"],
        requires_all_promises: [
          { promise_id: "albany:promise_june_cattle_first", status: "active" },
        ],
      },
      effects: [
        {
          type: "resolve_promise",
          promise_id: "albany:promise_june_cattle_first",
          status: "released",
        },
        { type: "remove_companion", npc_id: "albany:june_pike" },
        {
          type: "remember_relationship",
          npc_id: "albany:june_pike",
          memory_id: "albany:memory_june_released_before_hunt",
        },
      ],
    });
  });

  it("exports the bloodied-byre evacuation as an honest loss and exposes Emery's exact count", () => {
    const wolfWinter = world.quests.find((quest) => quest.id === "wolf_winter")!;
    const campaignExport = overworldQuestCampaignExportForEnding(
      wolfWinter,
      "ending_bloodied_byre_evacuated",
    );
    const factIds = campaignExport?.effects
      .filter((effect) => effect.type === "set_world_fact")
      .map((effect) => effect.fact_id);

    expect(factIds).not.toContain("fact:wolf_winter_byre_held");
    expect(factIds).not.toContain("fact:wolf_winter_pack_diverted_alive");
    expect(factIds).not.toContain("fact:wolf_winter_pack_driven_alive");
    expect(factIds).not.toContain("fact:wolf_winter_winter_feed_spent");
    expect(factIds).not.toContain("fact:wolf_winter_drive_reserve_spent");
    expect(factIds).not.toContain("fact:wolf_winter_cattle_whole");

    const juneDeparture = campaignExport?.conditional_effects?.find(
      (group) => group.id === "albany:june_departed_after_bloodied_byre",
    );
    expect(juneDeparture).toEqual({
      id: "albany:june_departed_after_bloodied_byre",
      when: {
        requires_all_companions: ["albany:june_pike"],
        requires_all_promises: [
          { promise_id: "albany:promise_june_cattle_first", status: "active" },
        ],
      },
      effects: [
        {
          type: "resolve_promise",
          promise_id: "albany:promise_june_cattle_first",
          status: "broken",
        },
        { type: "remove_companion", npc_id: "albany:june_pike" },
        {
          type: "remember_relationship",
          npc_id: "albany:june_pike",
          memory_id: "albany:memory_june_left_after_blood",
        },
      ],
    });

    const emery = world.characters.find(
      (character) => character.id === "albany_city__greenway__contact",
    );
    const variant = emery?.variants?.find(
      (candidate) => candidate.id === "wolf_bloodied_byre_evacuated",
    );
    expect(variant).toMatchObject({
      after_relationship_memories: ["albany:memory_emery_wolf_bloodied_byre_evacuated"],
      summary:
        "Emery records two dead wolves, the old grey in the abandoned barn, two missing cattle, and every person safe.",
    });
    expect(`${variant?.summary} ${variant?.agenda}`).not.toMatch(/high wood/i);
  });

  it("requires every Wolf-Winter return to close each selected registration obligation", () => {
    const wolfWinter = world.quests.find((quest) => quest.id === "wolf_winter")!;
    const obligations = [
      ["albany:close_road_warden_return_packet", "albany:promise_return_hayden_packet"],
      ["albany:close_ledger_advocate_relief_account", "albany:promise_truthful_relief_account"],
      ["albany:close_ironhands_repairer_tools", "albany:promise_return_reese_tools"],
      ["albany:close_unaffiliated_courier_emergency_tag", "albany:promise_close_emergency_tag"],
    ] as const;

    for (const campaignExport of wolfWinter.campaign_exports ?? []) {
      for (const [groupId, promiseId] of obligations) {
        expect(
          campaignExport.conditional_effects?.find((group) => group.id === groupId),
          `${campaignExport.ending_id} / ${promiseId}`,
        ).toEqual({
          id: groupId,
          when: {
            requires_all_promises: [{ promise_id: promiseId, status: "active" }],
          },
          effects: [{ type: "resolve_promise", promise_id: promiseId, status: "kept" }],
        });
      }
    }

    const malformed = structuredClone(world);
    const malformedWolf = malformed.quests.find((quest) => quest.id === "wolf_winter")!;
    malformedWolf.campaign_exports![0]!.conditional_effects =
      malformedWolf.campaign_exports![0]!.conditional_effects?.filter(
        (group) => group.id !== "albany:close_ledger_advocate_relief_account",
      );
    expect(() => assertOverworldIntegrity(malformed)).toThrow(
      /does not keep background obligation "albany:promise_truthful_relief_account"/i,
    );

    for (const status of ["broken", "released"] as const) {
      const wrongResolution = structuredClone(world);
      const wrongWolf = wrongResolution.quests.find((quest) => quest.id === "wolf_winter")!;
      const group = wrongWolf.campaign_exports![0]!.conditional_effects?.find(
        (candidate) => candidate.id === "albany:close_ledger_advocate_relief_account",
      );
      const effect = group?.effects.find(
        (candidate) =>
          candidate.type === "resolve_promise" &&
          candidate.promise_id === "albany:promise_truthful_relief_account",
      );
      if (!effect || effect.type !== "resolve_promise") {
        throw new Error("Expected the Ledger obligation closure effect.");
      }
      effect.status = status;
      expect(() => assertOverworldIntegrity(wrongResolution)).toThrow(
        /does not keep background obligation "albany:promise_truthful_relief_account"/i,
      );
    }
  });

  it("authors Wolf-Winter's trusted campaign imports without opting legacy quests in", () => {
    const wolfWinter = world.quests.find((quest) => quest.id === "wolf_winter")!;
    const legacyQuests = world.quests.filter((quest) => quest.id !== wolfWinter.id);

    expect(legacyQuests.every((quest) => !("campaign_imports" in quest))).toBe(true);
    expect(wolfWinter.campaign_imports).toEqual({
      version: 1,
      rules: [
        {
          id: "import:wolf_winter_fieldcraft",
          type: "skill_rank_to_var",
          skill_id: "skill:fieldcraft",
          target_var: "defense",
        },
        {
          id: "import:wolf_winter_lure_fieldcraft",
          type: "skill_rank_to_var",
          skill_id: "skill:fieldcraft",
          target_var: "fieldcraft",
        },
        {
          id: "import:wolf_winter_works_repair",
          type: "skill_rank_to_var",
          skill_id: "skill:repair",
          target_var: "repair",
        },
        {
          id: "import:wolf_winter_drover_streetwise",
          type: "skill_rank_to_var",
          skill_id: "skill:streetwise",
          target_var: "streetwise",
        },
        {
          id: "import:wolf_winter_relief_mediation",
          type: "skill_rank_to_var",
          skill_id: "skill:mediation",
          target_var: "mediation",
        },
        {
          id: "import:wolf_winter_full_compact_duty",
          type: "knowledge_to_flag",
          knowledge_id: "albany:knowledge_wolf_full_compact_duty",
          target_flag: "relief_oath_full_duty",
        },
        {
          id: "import:wolf_winter_limited_aid_only",
          type: "knowledge_to_flag",
          knowledge_id: "albany:knowledge_wolf_limited_aid_only",
          target_flag: "relief_oath_limited_duty",
        },
        {
          id: "import:wolf_winter_unaffiliated_bond",
          type: "knowledge_to_flag",
          knowledge_id: "albany:knowledge_wolf_unaffiliated_bond",
          target_flag: "relief_oath_unaffiliated_bond",
        },
        {
          id: "import:wolf_winter_market_testimony",
          type: "knowledge_to_flag",
          knowledge_id: "albany:knowledge_wolf_market_testimony",
          target_flag: "jamie_market_testimony_certified",
        },
        {
          id: "import:wolf_winter_frost_report",
          type: "knowledge_to_flag",
          knowledge_id: "albany:knowledge_wolf_frost_report",
          target_flag: "hayden_frost_report_certified",
        },
        {
          id: "import:wolf_winter_works_fortification",
          type: "knowledge_to_flag",
          knowledge_id: "albany:knowledge_wolf_works_fortification",
          target_flag: "works_fortification_prepared",
        },
        {
          id: "import:wolf_winter_drover_route",
          type: "knowledge_to_flag",
          knowledge_id: "albany:knowledge_wolf_drover_route",
          target_flag: "drover_route_prepared",
        },
        {
          id: "import:wolf_winter_relief_protocol",
          type: "knowledge_to_flag",
          knowledge_id: "albany:knowledge_wolf_relief_protocol",
          target_flag: "relief_protocol_prepared",
        },
        {
          id: "import:wolf_winter_approach_exposed_ridge",
          type: "knowledge_to_flag",
          knowledge_id: "albany:knowledge_wolf_exposed_ridge",
          target_flag: "approach_exposed_ridge",
        },
        {
          id: "import:wolf_winter_approach_sheltered_stockway",
          type: "knowledge_to_flag",
          knowledge_id: "albany:knowledge_wolf_sheltered_stockway",
          target_flag: "approach_sheltered_stockway",
        },
        {
          id: "import:wolf_winter_relief_cade_fodder",
          type: "knowledge_to_flag",
          knowledge_id: "albany:knowledge_relief_cade_fodder",
          target_flag: "relief_cade_fodder_allocated",
        },
        {
          id: "import:wolf_winter_relief_resident_shelter",
          type: "knowledge_to_flag",
          knowledge_id: "albany:knowledge_relief_resident_shelter",
          target_flag: "relief_resident_shelter_allocated",
        },
        {
          id: "import:wolf_winter_relief_mobile_reserve",
          type: "knowledge_to_flag",
          knowledge_id: "albany:knowledge_relief_mobile_reserve",
          target_flag: "relief_mobile_reserve_allocated",
        },
        {
          id: "import:wolf_winter_june_companion",
          type: "companion_to_flag",
          companion_id: "albany:june_pike",
          target_flag: "june_pike_present",
        },
      ],
    });
  });

  it("keeps campaign imports strict, unique, and opt-in", () => {
    const duplicateRule = structuredClone(world);
    const imports = duplicateRule.quests.find(
      (quest) => quest.id === "wolf_winter",
    )!.campaign_imports!;
    imports.rules.push(structuredClone(imports.rules[0]!));
    expect(() => assertOverworldIntegrity(duplicateRule)).toThrow(/duplicate.*rule id/i);
    expect(() => parseOverworldManifest(duplicateRule)).toThrow(/duplicate.*rule id/i);

    const duplicateWriter = structuredClone(world);
    const writerImports = duplicateWriter.quests.find(
      (quest) => quest.id === "wolf_winter",
    )!.campaign_imports!;
    writerImports.rules.push({
      id: "import:wolf_winter_other_health",
      type: "skill_rank_to_var",
      skill_id: "skill:other",
      target_var: "defense",
    });
    expect(() => parseOverworldManifest(duplicateWriter)).toThrow(/both write/i);

    const legacyRaw = structuredClone(world);
    delete legacyRaw.quests.find((quest) => quest.id === "wolf_winter")!.campaign_imports;
    const legacyParsed = parseOverworldManifest(legacyRaw);
    expect(legacyParsed.quests.every((quest) => !("campaign_imports" in quest))).toBe(true);
  });

  it("rejects duplicate campaign export identities and effects without defaulting legacy quests", () => {
    const duplicateEndingId = structuredClone(world);
    const duplicateIdExports = duplicateEndingId.quests.find(
      (quest) => quest.id === "wolf_winter",
    )!.campaign_exports!;
    duplicateIdExports.push({
      ...structuredClone(duplicateIdExports[0]!),
      ending_title: "A Distinct Test Title",
    });
    expect(() => assertOverworldIntegrity(duplicateEndingId)).toThrow(
      /repeats campaign export ending id/i,
    );
    expect(() => parseOverworldManifest(duplicateEndingId)).toThrow(
      /duplicate campaign export ending id/i,
    );

    const duplicateEndingTitle = structuredClone(world);
    const duplicateTitleExports = duplicateEndingTitle.quests.find(
      (quest) => quest.id === "wolf_winter",
    )!.campaign_exports!;
    duplicateTitleExports.push({
      ...structuredClone(duplicateTitleExports[0]!),
      ending_id: "ending_distinct_test_id",
    });
    expect(() => assertOverworldIntegrity(duplicateEndingTitle)).toThrow(
      /repeats campaign export ending title/i,
    );
    expect(() => parseOverworldManifest(duplicateEndingTitle)).toThrow(
      /duplicate campaign export ending title/i,
    );

    const duplicateEffect = structuredClone(world);
    const duplicatedEffects = duplicateEffect.quests.find((quest) => quest.id === "wolf_winter")!
      .campaign_exports![0]!.effects;
    duplicatedEffects.push(structuredClone(duplicatedEffects[0]!));
    expect(() => assertOverworldIntegrity(duplicateEffect)).toThrow(
      /duplicate campaign consequence effect/i,
    );
    expect(() => parseOverworldManifest(duplicateEffect)).toThrow(
      /duplicate campaign consequence effect/i,
    );

    const legacyRaw = structuredClone(world);
    delete legacyRaw.quests.find((quest) => quest.id === "wolf_winter")!.campaign_exports;
    const legacyParsed = parseOverworldManifest(legacyRaw);
    expect(legacyParsed.quests.every((quest) => !("campaign_exports" in quest))).toBe(true);
  });

  it("hand-authors Albany's opening bridge into The Wolf-Winter", () => {
    const nodesById = new Map(world.nodes.map((node) => [node.id, node]));
    const areasById = new Map(world.areas.map((area) => [area.id, area]));
    const poisById = new Map(world.points_of_interest.map((poi) => [poi.id, poi]));
    const contactsById = new Map(world.characters.map((contact) => [contact.id, contact]));
    const eventsById = new Map(world.local_events.map((event) => [event.id, event]));
    const jobsById = new Map(world.local_jobs.map((job) => [job.id, job]));
    const sitesById = new Map(world.exploration_sites.map((site) => [site.id, site]));
    const questsById = new Map(world.quests.map((quest) => [quest.id, quest]));

    const albany = nodesById.get("albany_city");
    const civic = areasById.get("albany_city__civic_core");
    const station = areasById.get("albany_city__transport_hub");
    const stationPoi = poisById.get("albany_city__transport_hub__poi");
    const hayden = contactsById.get("albany_city__transport_hub__contact");
    const stationEvent = eventsById.get("albany_city__transport_hub__event");
    const stationJob = jobsById.get("albany_city__transport_hub__job");
    const stationSite = sitesById.get("albany_city__transport_hub__site");
    const wolfWinter = questsById.get("wolf_winter");

    expect(albany?.description).toContain("about 101,698 residents");
    expect(civic?.summary).toContain("notice board, official counters, and local records");
    expect(station?.summary).toContain("local roads, buses, rail lines");
    expect(station?.summary).toContain("freight routes");
    expect(station?.discovery).toContain("road conditions");
    expect(stationPoi?.summary).toContain("Scout Albany Station Quarter Route Yard");
    expect(stationPoi?.summary).toContain("route trouble");
    expect(hayden?.agenda).toContain("winter dispatches");
    expect(hayden?.agenda).toContain("field returns");
    expect(stationEvent?.title).toBe("Hayden Hale's Cade Return Filing Standard");
    expect(stationEvent?.summary).toContain("administrative filing method");
    expect(stationEvent?.summary).toContain("Cade's return");
    expect(stationEvent?.authored_scene).toMatchObject({
      id: "albany:cade-return-filing-standard",
      required_poi_id: "albany_city__transport_hub__poi",
      required_contact_id: "albany_city__transport_hub__contact",
      requires_completed_quests: ["wolf_winter"],
      forbids_completed_jobs: ["albany_city__transport_hub__job"],
      options: [
        {
          id: "bind_operational_route_abstract",
          terms: { minutes: 20, renown: 1 },
        },
        {
          id: "bind_witnessed_return_record",
          terms: { minutes: 20, renown: 1 },
        },
      ],
    });
    expect(stationJob?.summary).toMatch(/follow-up crew for Cade/i);
    expect(stationSite?.discovery).toContain("Albany Station Quarter");
    expect(stationSite?.discovery).toContain("Signal Yard");
    expect(wolfWinter?.discovery).toContain("Old Cade");
    expect(wolfWinter?.discovery).toContain("household and cattle");
    expect(wolfWinter?.discovery).toContain("June Pike");
    expect(wolfWinter?.discovery).toContain("live dispatch");
    expect(wolfWinter?.discovery).not.toContain("posted on the station board");

    const authoredBridge = [
      albany?.description,
      civic?.summary,
      station?.summary,
      station?.discovery,
      stationPoi?.summary,
      hayden?.summary,
      hayden?.agenda,
      stationEvent?.summary,
      stationJob?.summary,
      stationJob?.objective,
      stationSite?.summary,
      stationSite?.discovery,
      wolfWinter?.discovery,
    ].join(" ");
    expect(authoredBridge).not.toContain("concrete local lead point");
    expect(authoredBridge).not.toContain("Ask around Albany city for work tied to");
    expect(authoredBridge).not.toContain("make Albany City feel worked-in rather than decorative");
    expect(authoredBridge).not.toContain("from the station board");
  });

  it("authors Albany Works as a pre-Wolf charter and option-gated return priority", () => {
    const worksEvent = world.local_events.find(
      (event) => event.id === "albany_city__industrial__event",
    );
    const eventScene = worksEvent?.authored_scene;
    const worksJob = world.local_jobs.find((job) => job.id === "albany_city__industrial__job");
    const scene = worksJob?.authored_scene;

    expect(worksEvent?.title).toBe("Reese Pryce's Hazard-Shift Charter");
    expect(eventScene?.id).toBe("albany:works-hazard-shift-charter");
    expect(eventScene?.forbids_completed_quests).toEqual(["wolf_winter"]);
    expect(eventScene?.options.map((option) => [option.id, option.terms])).toEqual([
      ["license_shift_witness_count", { minutes: 20, renown: 1 }],
      ["authorize_cold_set_gate_bypass", { minutes: 20, renown: 1 }],
    ]);
    expect(worksJob).toBeDefined();
    expect(worksJob?.title).toBe("Reese's Two Winter Lines");
    expect(scene?.id).toBe("albany:works-yard-winter-shift");
    expect(scene?.required_poi_id).toBe("albany_city__industrial__poi");
    expect(scene?.required_contact_id).toBe("albany_city__industrial__contact");
    expect(scene?.requires_completed_quests).toEqual(["wolf_winter"]);
    expect(scene?.options).toEqual([
      expect.objectContaining({
        id: "protect_trapped_public_shift",
        title: "Rescue the Trapped Shift",
        terms: { minutes: 80, renown: 5 },
      }),
      expect.objectContaining({
        id: "inventory_outbound_cold_set_stock",
        title: "Inventory the Repair Reserve",
        terms: { minutes: 35, renown: 2 },
      }),
      expect.objectContaining({
        id: "release_shift_under_witness_count",
        terms: { minutes: 45, renown: 3 },
        requires_event_options: [
          {
            event_id: "albany_city__industrial__event",
            option_id: "license_shift_witness_count",
          },
        ],
      }),
      expect.objectContaining({
        id: "open_cold_set_gate_bypass",
        terms: { minutes: 60, renown: 4 },
        requires_event_options: [
          {
            event_id: "albany_city__industrial__event",
            option_id: "authorize_cold_set_gate_bypass",
          },
        ],
      }),
    ]);

    const worksCopy = [
      worksJob?.summary,
      worksJob?.objective,
      worksJob?.reward,
      scene?.prompt,
      ...(scene?.options ?? []).flatMap((option) => [
        option.title,
        option.preview,
        option.consequence,
      ]),
    ].join(" ");
    expect(worksCopy).not.toContain("The job is small enough to finish locally");
    expect(worksCopy).not.toContain("feel worked-in rather than decorative");
    expect(worksCopy).not.toContain("returned cold-set");
    expect(worksCopy).not.toContain("Spend time in Albany Works District");
    expect(worksCopy).not.toContain("concrete lead about Albany City");
  });

  it("authors the post-Wolf Campus return-evidence mandate and its exact extra Archive Query methods", () => {
    const campusEvent = world.local_events.find(
      (event) => event.id === "albany_city__campus__event",
    );
    const campusJob = world.local_jobs.find((job) => job.id === "albany_city__campus__job");
    const blair = world.characters.find(
      (character) => character.id === "albany_city__campus__contact",
    );
    const eventScene = campusEvent?.authored_scene;
    const jobScene = campusJob?.authored_scene;

    expect(campusEvent?.title).toBe("Albany Campus Row: Return Evidence Mandate");
    expect(eventScene).toMatchObject({
      id: "albany:campus-return-evidence-mandate",
      required_poi_id: "albany_city__campus__poi",
      required_contact_id: "albany_city__campus__contact",
      requires_completed_quests: ["wolf_winter"],
    });
    expect(eventScene?.options.map((option) => [option.id, option.terms])).toEqual([
      ["prioritize_clinic_exposure_thresholds", { minutes: 20, renown: 1 }],
      ["preserve_traceable_route_provenance", { minutes: 20, renown: 1 }],
    ]);
    expect(blair?.variants).toEqual([
      expect.objectContaining({
        id: "winter_return_clinic_thresholds_byre_held",
        after_quests: ["wolf_winter"],
        after_world_facts: ["fact:wolf_winter_byre_held"],
        after_event_options: [
          {
            event_id: "albany_city__campus__event",
            option_id: "prioritize_clinic_exposure_thresholds",
          },
        ],
      }),
      expect.objectContaining({
        id: "winter_return_clinic_thresholds_evacuated",
        after_world_facts: ["fact:wolf_winter_steading_evacuated"],
      }),
      expect.objectContaining({
        id: "winter_return_route_provenance_byre_held",
        after_world_facts: ["fact:wolf_winter_byre_held"],
        after_event_options: [
          {
            event_id: "albany_city__campus__event",
            option_id: "preserve_traceable_route_provenance",
          },
        ],
      }),
      expect.objectContaining({
        id: "winter_return_route_provenance_evacuated",
        after_world_facts: ["fact:wolf_winter_steading_evacuated"],
      }),
    ]);
    expect(jobScene?.options).toHaveLength(4);
    expect(jobScene?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "issue_calibrated_road_warning",
          terms: { minutes: 35, renown: 2 },
        }),
        expect.objectContaining({
          id: "prepare_traceable_field_archive",
          terms: { minutes: 75, renown: 5 },
        }),
        expect.objectContaining({
          id: "issue_clinic_threshold_card",
          terms: { minutes: 20, renown: 2 },
          requires_event_options: [
            {
              event_id: "albany_city__campus__event",
              option_id: "prioritize_clinic_exposure_thresholds",
            },
          ],
        }),
        expect.objectContaining({
          id: "index_traceable_route_digest",
          terms: { minutes: 45, renown: 3 },
          requires_event_options: [
            {
              event_id: "albany_city__campus__event",
              option_id: "preserve_traceable_route_provenance",
            },
          ],
        }),
      ]),
    );
  });

  it("rejects contact proofs outside authored quest exports and authored event options", () => {
    const blairId = "albany_city__campus__contact";

    const missingFact = structuredClone(world);
    missingFact.characters.find(
      (character) => character.id === blairId,
    )!.variants![0]!.after_world_facts![0] = "fact:not_exported_by_any_ending";
    expect(() => assertOverworldIntegrity(missingFact)).toThrow(/references missing world fact/);

    const missingEvent = structuredClone(world);
    missingEvent.characters.find(
      (character) => character.id === blairId,
    )!.variants![0]!.after_event_options![0]!.event_id = "missing_event";
    expect(() => assertOverworldIntegrity(missingEvent)).toThrow(/references missing event/);

    const missingOption = structuredClone(world);
    missingOption.characters.find(
      (character) => character.id === blairId,
    )!.variants![0]!.after_event_options![0]!.option_id = "missing_option";
    expect(() => assertOverworldIntegrity(missingOption)).toThrow(
      /references missing event option/,
    );
  });

  it("turns Cade's certified losses into one exact Station return priority", () => {
    const stationJob = world.local_jobs.find((job) => job.id === "albany_city__transport_hub__job");
    const scene = stationJob?.authored_scene;

    expect(stationJob?.title).toBe("Hayden's Cade Return Packet");
    expect(scene?.id).toBe("albany:cade-return-packet");
    expect(scene?.required_poi_id).toBe("albany_city__transport_hub__poi");
    expect(scene?.required_contact_id).toBe("albany_city__transport_hub__contact");
    expect(scene?.requires_completed_quests).toEqual(["wolf_winter"]);
    expect(scene?.options).toEqual([
      expect.objectContaining({
        id: "dispatch_paling_rebuild",
        terms: { minutes: 45, renown: 3 },
        requires_all_world_facts: ["fact:wolf_winter_outer_paling_broken"],
      }),
      expect.objectContaining({
        id: "dispatch_evacuation_line",
        terms: { minutes: 35, renown: 2 },
        requires_all_world_facts: ["fact:wolf_winter_outer_line_abandoned"],
      }),
      expect.objectContaining({
        id: "dispatch_pasture_search",
        terms: { minutes: 60, renown: 4 },
        requires_all_world_facts: ["fact:wolf_winter_cattle_scattered"],
      }),
      expect.objectContaining({
        id: "close_packet_under_route_abstract",
        terms: { minutes: 30, renown: 3 },
        requires_event_options: [
          {
            event_id: "albany_city__transport_hub__event",
            option_id: "bind_operational_route_abstract",
          },
        ],
      }),
      expect.objectContaining({
        id: "close_packet_under_witnessed_record",
        terms: { minutes: 45, renown: 4 },
        requires_event_options: [
          {
            event_id: "albany_city__transport_hub__event",
            option_id: "bind_witnessed_return_record",
          },
        ],
      }),
    ]);
  });

  it("authors Jamie and Hayden's source-reactive contact phases most-specific first", () => {
    const jamie = world.characters.find(
      (character) => character.id === "albany_city__market__contact",
    );
    expect(jamie?.campaign_npc_id).toBe("albany:jamie_tanner");
    expect(jamie?.variants).toEqual([
      {
        id: "relief_resident_shelter_allocated",
        after_relationship_memories: ["albany:memory_jamie_relief_resident_shelter_allocated"],
        summary: expect.stringContaining("Market warm room"),
        agenda: expect.stringContaining("one fast fatigue rest"),
      },
      {
        id: "wolf_relief_protocol_allocated",
        after_relationship_memories: ["albany:memory_jamie_wolf_relief_protocol_allocated"],
        summary: expect.stringContaining("cattle protocol"),
        agenda: expect.stringContaining("one Mediation attempt"),
      },
      {
        id: "market_testimony_certified",
        after_relationship_memories: ["albany:memory_jamie_market_testimony_certified"],
        summary: expect.stringContaining("certified the missing-feed witnesses"),
        agenda: expect.stringContaining("fodder-loft route"),
      },
      {
        id: "sponsored_ledger_advocate",
        after_relationship_memories: ["albany:memory_jamie_sponsored_ledger_advocate"],
        summary: expect.stringContaining("Relief Advocate background"),
        agenda: expect.stringContaining("named witnesses"),
      },
    ]);

    const hayden = world.characters.find(
      (character) => character.id === "albany_city__transport_hub__contact",
    );
    expect(hayden?.campaign_npc_id).toBe("albany:hayden_hale");
    expect(hayden?.variants).toEqual([
      {
        id: "relief_mobile_reserve_allocated",
        after_relationship_memories: ["albany:memory_hayden_relief_mobile_reserve_allocated"],
        summary: expect.stringContaining("last relief wagon"),
        agenda: expect.stringContaining("one recovered FORTIFY failure"),
      },
      {
        id: "wolf_fortified_cade_terms",
        after_relationship_memories: ["albany:memory_hayden_wolf_fortified_cade_terms"],
        summary: expect.stringContaining("household and herd safe"),
        agenda: expect.stringContaining("exposed property"),
      },
      {
        id: "wolf_fortified_albany_authority",
        after_relationship_memories: ["albany:memory_hayden_wolf_fortified_albany_authority"],
        summary: expect.stringContaining("household, herd, and property safe"),
        agenda: expect.stringContaining("spent supplies"),
      },
      {
        id: "wolf_winter_returned_road_warden",
        after_quests: ["wolf_winter"],
        after_relationship_memories: ["albany:memory_hayden_sponsored_road_warden"],
        summary: expect.stringContaining("Road Warden return"),
        agenda: expect.stringContaining("honest field report"),
      },
      {
        id: "wolf_winter_and_gallowmere_closed",
        after_quests: ["wolf_winter", "gallowmere"],
        summary: expect.stringContaining("closed both Wolf-Winter and The Gallowmere"),
        agenda: expect.stringContaining("current journey goal"),
      },
      {
        id: "wolf_winter_closed",
        after_quests: ["wolf_winter"],
        summary: expect.stringContaining("closed Wolf-Winter and recorded Cade's return"),
        agenda: expect.stringContaining("current journey goal"),
      },
      {
        id: "frost_report_certified",
        after_relationship_memories: ["albany:memory_hayden_frost_report_certified"],
        summary: expect.stringContaining("certified his frost report"),
        agenda: expect.stringContaining("public wedge"),
      },
      {
        id: "sponsored_road_warden",
        after_relationship_memories: ["albany:memory_hayden_sponsored_road_warden"],
        summary: expect.stringContaining("Road Warden background"),
        agenda: expect.stringContaining("Fieldcraft helps"),
      },
    ]);

    const reactiveCopy = (hayden?.variants ?? [])
      .flatMap((variant) => [variant.summary, variant.agenda])
      .filter((copy): copy is string => copy !== undefined)
      .join(" ");
    expect(reactiveCopy).not.toMatch(/needs someone|before the cattle are lost/i);
    expect(reactiveCopy).not.toMatch(/Queensbury|Oneonta|Rome|wind-stone|blind-side/i);
  });

  it("enforces contact variant references, precedence, overrides, and journal identities", () => {
    const haydenId = "albany_city__transport_hub__contact";

    const missingQuest = structuredClone(world);
    const missingQuestVariant = missingQuest.characters
      .find((character) => character.id === haydenId)!
      .variants!.find((variant) => variant.after_quests?.length);
    if (!missingQuestVariant?.after_quests) throw new Error("expected a quest-gated variant");
    missingQuestVariant.after_quests[0] = "missing_quest";
    expect(() => assertOverworldIntegrity(missingQuest)).toThrow(/references missing quest/);

    const broaderFirst = structuredClone(world);
    const reordered = broaderFirst.characters.find(
      (character) => character.id === haydenId,
    )!.variants!;
    reordered.reverse();
    expect(() => assertOverworldIntegrity(broaderFirst)).toThrow(
      /orders broader variant .* before more-specific variant/,
    );

    const noOverride = structuredClone(world);
    const emptyVariant = noOverride.characters.find((character) => character.id === haydenId)!
      .variants![0]!;
    delete emptyVariant.summary;
    delete emptyVariant.agenda;
    expect(() => assertOverworldIntegrity(noOverride)).toThrow(/must override summary or agenda/);

    const noCondition = structuredClone(world);
    noCondition.characters
      .find((character) => character.id === haydenId)!
      .variants!.find((variant) => variant.id === "wolf_winter_closed")!.after_quests = [];
    expect(() => assertOverworldIntegrity(noCondition)).toThrow(/has no campaign condition/);

    const unboundMemory = structuredClone(world);
    const unboundHayden = unboundMemory.characters.find((character) => character.id === haydenId)!;
    delete unboundHayden.campaign_npc_id;
    const unboundVariant = unboundHayden.variants!.find(
      (variant) => variant.id === "wolf_fortified_cade_terms",
    )!;
    delete unboundVariant.after_quests;
    unboundVariant.after_relationship_memories = ["memory:albany_relief_packet"];
    expect(() => assertOverworldIntegrity(unboundMemory)).toThrow(
      /requires relationship memories without a campaign_npc_id/,
    );

    const broaderMemoryFirst = structuredClone(world);
    const memoryHayden = broaderMemoryFirst.characters.find(
      (character) => character.id === haydenId,
    )!;
    memoryHayden.campaign_npc_id = "npc:hayden_hale";
    memoryHayden.variants = [
      {
        id: "packet_known",
        after_relationship_memories: ["memory:albany_relief_packet"],
        agenda: "The packet is familiar.",
      },
      {
        id: "packet_and_wolf_closed",
        after_quests: ["wolf_winter"],
        after_relationship_memories: ["memory:albany_relief_packet"],
        agenda: "The packet and closed winter road are familiar.",
      },
    ];
    expect(() => assertOverworldIntegrity(broaderMemoryFirst)).toThrow(
      /orders broader variant .* before more-specific variant/,
    );

    const journalCollision = structuredClone(world);
    const haydenVariantId = journalCollision.characters.find(
      (character) => character.id === haydenId,
    )!.variants![0]!.id;
    journalCollision.characters.find((character) => character.id !== haydenId)!.id =
      `${haydenId}@${haydenVariantId}`;
    expect(() => assertOverworldIntegrity(journalCollision)).toThrow(
      /duplicate overworld contact talk journal id/i,
    );
  });

  it("populates every town and road with exploration substrate", () => {
    expect(world.points_of_interest.length).toBeGreaterThanOrEqual(world.nodes.length);
    expect(world.areas.length).toBeGreaterThan(world.nodes.length * 2);
    expect(world.area_edges.length).toBeGreaterThan(world.areas.length - world.nodes.length);
    expect(world.characters.length).toBeGreaterThanOrEqual(world.nodes.length);
    expect(world.local_events.length).toBeGreaterThanOrEqual(world.nodes.length);
    expect(world.local_jobs.length).toBe(world.areas.length);
    expect(world.road_events.length).toBe(world.edges.length);
    expect(world.exploration_sites.length).toBe(world.areas.length);
    expect(world.design_rules.join(" ")).toContain("Every local area has a point of interest");
    expect(world.design_rules.join(" ")).toContain("Only the current area's points of interest");
    expect(world.design_rules.join(" ")).toContain(
      "Every local area has one larger exploration site",
    );
    expect(world.design_rules.join(" ")).toContain(
      "consume time and record discoveries in the journal",
    );
    expect(world.design_rules.join(" ")).toContain("Roads cost supplies and add fatigue");
    expect(world.design_rules.join(" ")).toContain("Shortages and fatigue add travel delay");
    expect(world.design_rules.join(" ")).toContain(
      "Route planning lists road time, condition delay, supplies, and fatigue separately",
    );
    expect(world.design_rules.join(" ")).toContain(
      "Resolve enough events in a region's listed towns",
    );
    expect(world.design_rules.join(" ")).toContain("complete its regional arc");
    expect(world.design_rules.join(" ")).toContain("Every road has an ambient report");
    expect(world.design_rules.join(" ")).toContain("Local actions can reveal exploration sites");

    for (const node of world.nodes) {
      const minimumLocalScale =
        node.kind === "metropolis"
          ? 10
          : node.kind === "great_city"
            ? 8
            : node.kind === "major_city"
              ? 6
              : node.kind === "city"
                ? 5
                : node.kind === "large_town"
                  ? 3
                  : 2;
      expect(overworldAreasAt(world, node.id).length, node.id).toBeGreaterThanOrEqual(
        minimumLocalScale,
      );
      expect(overworldJobsAt(world, node.id).length, node.id).toBeGreaterThanOrEqual(
        minimumLocalScale,
      );
      expect(overworldCharactersAt(world, node.id).length, node.id).toBeGreaterThan(0);
      expect(overworldEventsAt(world, node.id).length, node.id).toBeGreaterThan(0);
    }

    const jobAreas = new Set(world.local_jobs.map((job) => job.area));
    const poiAreas = new Set(world.points_of_interest.map((poi) => poi.area));
    const characterAreas = new Set(world.characters.map((character) => character.area));
    const eventAreas = new Set(world.local_events.map((event) => event.area));
    const siteAreas = new Set(world.exploration_sites.map((site) => site.area));
    for (const area of world.areas) {
      expect(jobAreas.has(area.id), area.id).toBe(true);
      expect(poiAreas.has(area.id), area.id).toBe(true);
      expect(characterAreas.has(area.id), area.id).toBe(true);
      expect(eventAreas.has(area.id), area.id).toBe(true);
      expect(siteAreas.has(area.id), area.id).toBe(true);
    }

    const areaRoutesByTown = new Map<string, number>();
    for (const route of world.area_edges) {
      areaRoutesByTown.set(route.home, (areaRoutesByTown.get(route.home) ?? 0) + 1);
    }
    const minimumAreaRouteCount = (areaCount: number): number =>
      areaCount <= 1
        ? 0
        : areaCount -
          1 +
          (areaCount >= 3 ? 1 : 0) +
          (areaCount >= 4 ? 2 : 0) +
          (areaCount >= 5 ? 1 : 0) +
          (areaCount >= 6 ? 1 : 0) +
          (areaCount >= 7 ? 1 : 0) +
          (areaCount >= 8 ? 1 : 0) +
          (areaCount >= 9 ? 1 : 0) +
          (areaCount >= 10 ? 1 : 0);
    for (const node of world.nodes) {
      const localAreaCount = overworldAreasAt(world, node.id).length;
      expect(areaRoutesByTown.get(node.id), node.id).toBeGreaterThanOrEqual(
        minimumAreaRouteCount(localAreaCount),
      );
    }

    expect(overworldAreasAt(world, "new_york_city").length).toBeGreaterThan(
      overworldAreasAt(world, "albany_city").length,
    );
    expect(overworldAreasAt(world, "albany_city").length).toBeGreaterThan(
      overworldAreasAt(world, "colonie_town").length,
    );

    const roadEventEdges = new Set(world.road_events.map((event) => event.edge));
    for (const edge of world.edges) {
      expect(roadEventEdges.has(edge.id), edge.id).toBe(true);
    }

    const nodesById = new Map(world.nodes.map((node) => [node.id, node]));
    for (const arc of world.regional_arcs) {
      expect(arc.required_resolutions).toBeLessThanOrEqual(arc.anchor_towns.length);
      expect(arc.anchor_towns.length).toBeGreaterThanOrEqual(arc.required_resolutions);
      for (const townId of arc.anchor_towns) {
        expect(nodesById.get(townId)?.region, `${arc.id}:${townId}`).toBe(arc.region);
      }
    }

    for (const region of world.regions) {
      expect(
        world.exploration_sites.filter((site) => site.region === region.name).length,
        region.name,
      ).toBeGreaterThanOrEqual(3);
    }
    for (const site of world.exploration_sites) {
      expect(nodesById.get(site.nearest_town)?.region, site.id).toBe(site.region);
      expect(world.areas.find((area) => area.id === site.area)?.home, site.id).toBe(
        site.nearest_town,
      );
      expect(
        overworldExplorationSitesNear(world, site.nearest_town).map((near) => near.id),
      ).toContain(site.id);
    }
  });

  it("removes the global quest selector from the app shell", () => {
    const app = readFileSync("ui/src/App.tsx", "utf8");
    const overworldScreen = readFileSync("ui/src/OverworldPlayScreen.tsx", "utf8");
    const actionPresentation = readFileSync("ui/src/worldActionPresentation.ts", "utf8");
    const journeyChoice = readFileSync("ui/src/JourneyChoiceScreen.tsx", "utf8");
    const humanSurface = `${app}\n${overworldScreen}\n${actionPresentation}`;
    expect(humanSurface).not.toContain("<select");
    expect(humanSurface).not.toContain("<option");
    expect(app).toContain('title: "Roads from here"');
    expect(overworldScreen).toContain("Roads from here");
    expect(app).toContain("pendingRoadEncounter");
    expect(app).toContain("Road encounter resolved");
    expect(app).toMatch(/Road encounter resolved:[\s\S]{0,300}result\.entry\.text/);
    expect(app).toContain('title: "Local movement"');
    expect(app).toContain('group: goalRelevant ? "Next for current goal" : "Local route"');
    expect(app).toContain("moveArea");
    expect(app).toContain('buttonLabel: "Explore area"');
    expect(app).toContain("unmapped local");
    expect(app).toContain('title: "Local jobs"');
    expect(app).toContain('buttonLabel: completed ? "Completed" : "Work job"');
    expect(app).toContain('completed ? "This job is complete." : "Requirements not met."');
    expect(app).not.toContain("undiscovered local");
    expect(app).toContain("road min");
    expect(app).toContain("exit.estimate.suppliesUsed");
    expect(app).toContain("exit.estimate.fatigueGained");
    expect(app).toContain('title: "Notice board"');
    expect(app).toContain('group: "Scout"');
    expect(app).toContain('group: "Talk"');
    expect(app).toContain('buttonLabel: resolved ? "Resolved" : "Investigate"');
    expect(app).toContain('buttonLabel: "Resolve event"');
    expect(app).toContain('title: "Discoveries and sites"');
    expect(app).toContain('group: "Regional site"');
    expect(overworldScreen).toContain("Regional threads");
    expect(overworldScreen).toContain("world.supplies");
    expect(overworldScreen).toContain("world.fatigue");
    expect(overworldScreen).toContain("world.travelCondition");
    expect(actionPresentation).toContain('return "Resupply"');
    expect(actionPresentation).toContain('return "Rest"');
    expect(actionPresentation).toContain("session.resupplyAtTown()");
    expect(actionPresentation).toContain("session.restAtTown()");
    expect(overworldScreen).toContain("journey.goalGuidance");
    expect(app).toContain("<JourneyChoiceScreen journey={journey}");
    expect(app).toContain("<JourneyStoryChoiceScreen");
    expect(app).toContain("inspectedDepartureStory");
    expect(app).toContain("<JourneyEndedScreen journey={journey}");
    expect(journeyChoice).toContain("journey.goalGuidance");
    expect(app).toContain("worldSession.recordQuestDecision(");
    expect(app).toContain("questSession.isCheckpointSafeBoundary()");
  });
});
