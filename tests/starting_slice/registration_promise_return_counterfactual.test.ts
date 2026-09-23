/**
 * SS-F01 return proof. Hold every supported Wolf-Winter outcome constant while
 * varying only Albany's permanent background, then prove that the selected
 * registration obligation closes without inventing any other background's
 * promise. The same promise remains active before foldback and after an
 * unrelated quest consequence replay.
 */
import { describe, expect, it } from "vitest";

import { applyCampaignConsequences } from "../../src/world/campaign_consequences.js";
import {
  overworldQuestCampaignEffectsForCharacter,
  type OverworldQuestCampaignExport,
} from "../../src/world/overworld.js";
import { deriveRegistrationPromiseFoldbackReceipt } from "../../src/world/registration_promise_receipt.js";
import { OverworldSession } from "../../src/world/session.js";
import {
  applyOverworldQuestCompletion,
  planOverworldQuestCompletion,
} from "../../src/world/session_quests.js";
import { loadOverworldManifest } from "../../src/world/source.js";
import { OverworldSession as UiOverworldSession } from "../../ui/src/overworld.js";
import { renderQuestCompletion } from "../../bin/overworld_play.js";
import { compactOverworldQuestCompletionResult } from "../../src/mcp/compact_overworld_result.js";
import { revealCurrentJourneyStoryOptions } from "../regression/support/journey_story.js";

const WORLD = loadOverworldManifest(process.cwd());
const REGISTRATION = WORLD.opening_registration!;
const RELIEF_OATH = WORLD.opening_relief_oath!;
const LEAD_SOURCE = WORLD.opening_lead_source!;
const PREPARATION = WORLD.opening_preparation!;
const WOLF = WORLD.quests.find((quest) => quest.id === "wolf_winter")!;
const GALLOWMERE = WORLD.quests.find((quest) => quest.id === "gallowmere")!;
const QUESTS = new Map(WORLD.quests.map((quest) => [quest.id, quest] as const));

const BACKGROUND_PROMISES: ReadonlyMap<string, string> = new Map([
  ["albany:road_warden", "albany:promise_return_hayden_packet"],
  ["albany:ledger_advocate", "albany:promise_truthful_relief_account"],
  ["albany:ironhands_repairer", "albany:promise_return_reese_tools"],
  ["albany:unaffiliated_courier", "albany:promise_close_emergency_tag"],
] as const);
const RECEIPT_OWNER_BY_BACKGROUND: ReadonlyMap<string, string> = new Map([
  ["albany:road_warden", "Hayden Hale"],
  ["albany:ledger_advocate", "Rowan Quill"],
  ["albany:ironhands_repairer", "Reese Pryce"],
  ["albany:unaffiliated_courier", "Rowan Quill"],
]);
const RECEIPT_ACTION_BY_BACKGROUND: ReadonlyMap<string, string> = new Map([
  ["albany:road_warden", "accepts your field report"],
  ["albany:ledger_advocate", "records Use Hayden's Frost Report under Accept Aid-Only Terms"],
  [
    "albany:ironhands_repairer",
    "records the insulated repair roll at 100/100 condition and closes the tool loan",
  ],
  ["albany:unaffiliated_courier", "records the emergency tag returned"],
]);

const DEFAULT_OATH = "albany:oath_limited_aid_only";
const DEFAULT_SOURCE = "albany:source_hayden_frost_report";
const DEFAULT_PREPARATION = "albany:prep_works_fortification";
const DEFAULT_ALLOCATION = "albany:relief_resident_shelter";
const DEFAULT_APPROACH = "albany:wolf_approach_sheltered_stockway";

function moveToArea(session: OverworldSession, areaId: string): void {
  const currentAreaId = session.view().currentArea?.id;
  if (!currentAreaId) throw new Error("expected a current Albany area");
  for (
    let attempt = 0;
    attempt < 8 && !session.view().discoveredAreaIds.includes(areaId);
    attempt += 1
  ) {
    session.exploreArea(currentAreaId);
  }
  if (!session.view().discoveredAreaIds.includes(areaId)) {
    throw new Error(`Albany play did not discover ${areaId}`);
  }
  const queue: { areaId: string; routeIds: string[] }[] = [{ areaId: currentAreaId, routeIds: [] }];
  const seen = new Set([currentAreaId]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    if (current.areaId === areaId) {
      for (const routeId of current.routeIds) session.moveArea(routeId);
      return;
    }
    for (const route of WORLD.area_edges.filter(
      (candidate) => candidate.from_area === current.areaId || candidate.to_area === current.areaId,
    )) {
      const nextAreaId = route.from_area === current.areaId ? route.to_area : route.from_area;
      if (seen.has(nextAreaId)) continue;
      seen.add(nextAreaId);
      queue.push({ areaId: nextAreaId, routeIds: [...current.routeIds, route.id] });
    }
  }
  throw new Error(`No Albany area path reaches ${areaId}`);
}

function wolfBoundary(profileId: string): ReturnType<OverworldSession["snapshot"]> {
  const session = new OverworldSession(WORLD);
  session.scoutPoi(session.view().pois[0]!.id);
  session.talkToCharacter(REGISTRATION.contact);
  session.chooseJourneyStory(profileId);
  revealCurrentJourneyStoryOptions(session, RELIEF_OATH.id);
  session.chooseJourneyStory(DEFAULT_OATH);
  session.chooseJourneyStory(DEFAULT_SOURCE);
  moveToArea(session, PREPARATION.area);
  session.chooseJourneyStory(DEFAULT_PREPARATION);
  session.chooseJourneyStory(DEFAULT_ALLOCATION);
  moveToArea(session, WOLF.area);
  session.startQuest(WOLF.id, DEFAULT_APPROACH);
  return session.snapshot();
}

function promiseStatus(
  character: ReturnType<OverworldSession["snapshot"]>["character"],
  promiseId: string,
): string | null {
  return character.promises.find((candidate) => candidate.promiseId === promiseId)?.status ?? null;
}

function complete(
  boundary: ReturnType<OverworldSession["snapshot"]>,
  campaignExport: OverworldQuestCampaignExport,
): OverworldSession {
  const session = OverworldSession.restore(WORLD, boundary);
  session.completeQuest(WOLF.id, {
    endingId: campaignExport.ending_id,
    endingTitle: campaignExport.ending_title,
    death: false,
  });
  return session;
}

describe("SS-F01 — registration obligations close on truthful Wolf-Winter return", () => {
  it("closes exactly one selected background obligation across all 4 × 16 counterfactuals", () => {
    expect(REGISTRATION.profiles).toHaveLength(4);
    expect(WOLF.campaign_exports).toHaveLength(16);

    for (const profile of REGISTRATION.profiles) {
      const selectedPromiseId = BACKGROUND_PROMISES.get(profile.id);
      if (!selectedPromiseId) throw new Error(`unexpected background ${profile.id}`);
      expect(profile.character.promises).toEqual([
        expect.objectContaining({ promiseId: selectedPromiseId, status: "active" }),
      ]);

      for (const campaignExport of WOLF.campaign_exports ?? []) {
        const applied = applyCampaignConsequences({
          character: profile.character,
          effects: overworldQuestCampaignEffectsForCharacter(campaignExport, profile.character),
        }).characterAfter;

        expect(
          applied.promises.map((promise) => promise.promiseId),
          `${profile.id} / ${campaignExport.ending_id}`,
        ).toEqual([selectedPromiseId]);
        expect(
          promiseStatus(applied, selectedPromiseId),
          `${profile.id} / ${campaignExport.ending_id}`,
        ).toBe("kept");
        for (const [otherProfileId, otherPromiseId] of BACKGROUND_PROMISES) {
          if (otherProfileId === profile.id) continue;
          expect(
            promiseStatus(applied, otherPromiseId),
            `${profile.id} must not invent ${otherPromiseId}`,
          ).toBeNull();
        }
      }
    }
  });

  it("keeps the obligation active before foldback", () => {
    for (const profile of REGISTRATION.profiles) {
      const promiseId = BACKGROUND_PROMISES.get(profile.id)!;
      const boundary = wolfBoundary(profile.id);
      expect(promiseStatus(boundary.character, promiseId), profile.id).toBe("active");
      expect(
        boundary.journalEntries.some((entry) => entry.text.includes("Registration complete.")),
        profile.id,
      ).toBe(false);
    }
  });

  it("folds back, restores, and projects every background closure without a new decision", () => {
    const ending = WOLF.campaign_exports!.find(
      (candidate) => candidate.ending_id === "ending_pack_diverted",
    )!;

    for (const profile of REGISTRATION.profiles) {
      const promiseId = BACKGROUND_PROMISES.get(profile.id)!;
      const boundary = wolfBoundary(profile.id);
      const completed = complete(boundary, ending);
      const snapshot = completed.snapshot();
      const completion = snapshot.journalEntries.find(
        (entry) => entry.id === `quest_done:${WOLF.id}`,
      )!;

      expect(snapshot.journey.acceptedDecisions).toBe(boundary.journey.acceptedDecisions);
      expect(promiseStatus(snapshot.character, promiseId), profile.id).toBe("kept");
      expect(completion.text.match(/Registration complete\./g), profile.id).toHaveLength(1);
      expect(completion.text, profile.id).toContain(RECEIPT_OWNER_BY_BACKGROUND.get(profile.id)!);
      expect(completion.text, profile.id).toContain(RECEIPT_ACTION_BY_BACKGROUND.get(profile.id)!);
      for (const [otherProfileId, action] of RECEIPT_ACTION_BY_BACKGROUND) {
        if (otherProfileId === profile.id) continue;
        expect(completion.text, `${profile.id} must not cross into ${action}`).not.toContain(
          action,
        );
      }
      expect(
        completed.view().character.promises.find((promise) => promise.promiseId === promiseId),
      ).toMatchObject({ status: "kept" });
      expect(completed.compactView().character[9]).toContainEqual([
        promiseId,
        profile.character.promises[0]!.recipientId,
        "kept",
      ]);

      const restored = OverworldSession.restore(WORLD, snapshot);
      expect(restored.snapshot()).toEqual(snapshot);
      expect(OverworldSession.restore(WORLD, restored.snapshot()).snapshot()).toEqual(snapshot);
      expect(UiOverworldSession.restore(WORLD, snapshot).view().character.promises).toEqual(
        completed.view().character.promises,
      );
      expect(UiOverworldSession.restore(WORLD, snapshot).view().journal[0]?.text).toBe(
        completion.text,
      );
    }
  });

  it("binds every profile receipt to every supported Wolf return without crossing profiles", () => {
    for (const profile of REGISTRATION.profiles) {
      for (const campaignExport of WOLF.campaign_exports ?? []) {
        const completed = OverworldSession.restore(WORLD, wolfBoundary(profile.id));
        const result = completed.completeQuest(WOLF.id, {
          endingId: campaignExport.ending_id,
          endingTitle: campaignExport.ending_title,
          death: false,
        });
        const completion = completed
          .snapshot()
          .journalEntries.find((entry) => entry.id === `quest_done:${WOLF.id}`)!;
        expect(completion.text, `${profile.id} / ${campaignExport.ending_id}`).toContain(
          campaignExport.ending_title,
        );
        expect(
          completion.text.match(/Registration complete\./g),
          `${profile.id} / ${campaignExport.ending_id}`,
        ).toHaveLength(1);
        const expectedOwner = RECEIPT_OWNER_BY_BACKGROUND.get(profile.id)!;
        expect(completion.text, `${profile.id} / ${campaignExport.ending_id}`).toContain(
          expectedOwner,
        );
        expect(renderQuestCompletion(result), `${profile.id} / ${campaignExport.ending_id}`).toBe(
          completion.text,
        );
        expect(
          compactOverworldQuestCompletionResult(result).text,
          `${profile.id} / ${campaignExport.ending_id}`,
        ).toBe(completion.text);
        expect(
          UiOverworldSession.restore(WORLD, completed.snapshot()).view().journal[0]?.text,
          `${profile.id} / ${campaignExport.ending_id}`,
        ).toBe(completion.text);
      }
    }
  });

  it("returns the courier tag to Rowan under Emery's witness unless authority requires a public void", () => {
    const courier = "albany:unaffiliated_courier";
    const returned = complete(
      wolfBoundary(courier),
      WOLF.campaign_exports!.find((candidate) => candidate.ending_id === "ending_pack_diverted")!,
    )
      .snapshot()
      .journalEntries.find((entry) => entry.id === `quest_done:${WOLF.id}`)!.text;
    const voided = complete(
      wolfBoundary(courier),
      WOLF.campaign_exports!.find(
        (candidate) => candidate.ending_id === "ending_fortified_albany_authority",
      )!,
    )
      .snapshot()
      .journalEntries.find((entry) => entry.id === `quest_done:${WOLF.id}`)!.text;

    expect(returned).toContain(
      "Rowan Quill records the emergency tag returned with Emery Sloane as witness",
    );
    expect(returned).not.toContain("publicly voids");
    expect(voided).toContain(
      "Rowan Quill cancels the emergency tag after you used Albany authority",
    );
    expect(voided).not.toContain("Emery Sloane's witness");
  });

  it("fails closed on mismatched profile, outcome facts, start proof, or repair-roll evidence", () => {
    const exportEntry = WOLF.campaign_exports!.find(
      (candidate) => candidate.ending_id === "ending_pack_diverted",
    )!;
    const boundary = wolfBoundary("albany:ironhands_repairer");
    const effects = overworldQuestCampaignEffectsForCharacter(exportEntry, boundary.character);
    const applied = applyCampaignConsequences({
      character: boundary.character,
      effects,
    });
    const base = {
      quest: WOLF,
      campaignExport: exportEntry,
      characterBefore: boundary.character,
      characterAfter: applied.characterAfter,
      worldFactIds: applied.worldFactIds,
      journalEntries: boundary.journalEntries,
      openingRegistration: WORLD.opening_registration,
      openingReliefOath: WORLD.opening_relief_oath,
      openingLeadSource: WORLD.opening_lead_source,
    };
    expect(deriveRegistrationPromiseFoldbackReceipt(base)).toContain("Reese Pryce");

    const roadCharacter = REGISTRATION.profiles.find(
      (profile) => profile.id === "albany:road_warden",
    )!.character;
    const roadApplied = applyCampaignConsequences({
      character: roadCharacter,
      effects: overworldQuestCampaignEffectsForCharacter(exportEntry, roadCharacter),
    });
    expect(() =>
      deriveRegistrationPromiseFoldbackReceipt({
        ...base,
        characterBefore: roadCharacter,
        characterAfter: roadApplied.characterAfter,
        worldFactIds: roadApplied.worldFactIds,
      }),
    ).toThrow(/profile does not match|character transition/i);
    expect(() => deriveRegistrationPromiseFoldbackReceipt({ ...base, worldFactIds: [] })).toThrow(
      /facts do not match/i,
    );
    const mismatchedOutcome = WOLF.campaign_exports!.find(
      (candidate) => candidate.ending_id === "ending_held",
    )!;
    expect(() =>
      deriveRegistrationPromiseFoldbackReceipt({
        ...base,
        campaignExport: mismatchedOutcome,
      }),
    ).toThrow(/character transition|facts do not match/i);

    const forgedStart = structuredClone(boundary.journalEntries);
    const start = forgedStart.find((entry) => entry.id === `quest:${WOLF.id}`)!;
    if (start.questStartProof?.kind !== "approach") throw new Error("expected approach proof");
    start.questStartProof.approachId = "albany:forged_approach";
    expect(() =>
      deriveRegistrationPromiseFoldbackReceipt({ ...base, journalEntries: forgedStart }),
    ).toThrow(/unknown approach/i);

    const missingRoll = {
      ...boundary.character,
      equipment: boundary.character.equipment.filter(
        (equipment) => equipment.equipmentId !== "albany:ironhands_repair_roll",
      ),
    };
    const missingRollApplied = applyCampaignConsequences({
      character: missingRoll,
      effects: overworldQuestCampaignEffectsForCharacter(exportEntry, missingRoll),
    });
    expect(() =>
      deriveRegistrationPromiseFoldbackReceipt({
        ...base,
        characterBefore: missingRoll,
        characterAfter: missingRollApplied.characterAfter,
        worldFactIds: missingRollApplied.worldFactIds,
      }),
    ).toThrow(/exact repair-roll snapshot/i);
  });

  it.each([99, 37])(
    "rejects an Ironhands repair roll at non-authored condition %i",
    (condition) => {
      const exportEntry = WOLF.campaign_exports!.find(
        (candidate) => candidate.ending_id === "ending_pack_diverted",
      )!;
      const boundary = wolfBoundary("albany:ironhands_repairer");
      const characterBefore = structuredClone(boundary.character);
      const repairRoll = characterBefore.equipment.find(
        (equipment) => equipment.equipmentId === "albany:ironhands_repair_roll",
      )!;
      repairRoll.condition = condition;
      const applied = applyCampaignConsequences({
        character: characterBefore,
        effects: overworldQuestCampaignEffectsForCharacter(exportEntry, characterBefore),
      });

      expect(() =>
        deriveRegistrationPromiseFoldbackReceipt({
          quest: WOLF,
          campaignExport: exportEntry,
          characterBefore,
          characterAfter: applied.characterAfter,
          worldFactIds: applied.worldFactIds,
          journalEntries: boundary.journalEntries,
          openingRegistration: WORLD.opening_registration,
          openingReliefOath: WORLD.opening_relief_oath,
          openingLeadSource: WORLD.opening_lead_source,
        }),
      ).toThrow(/exact repair-roll snapshot/i);
    },
  );

  it("fails closed at the planner boundary and applies only a receipt-bound plan", () => {
    const exportEntry = WOLF.campaign_exports!.find(
      (candidate) => candidate.ending_id === "ending_pack_diverted",
    )!;
    const boundary = wolfBoundary("albany:road_warden");
    const baseState = {
      questId: WOLF.id,
      outcome: {
        endingId: exportEntry.ending_id,
        endingTitle: exportEntry.ending_title,
        death: false,
      },
      character: boundary.character,
      questsById: QUESTS,
      areasById: new Map(WORLD.areas.map((area) => [area.id, area] as const)),
      nodesById: new Map(WORLD.nodes.map((node) => [node.id, node] as const)),
      questOutcomeIds: new Map<string, string>(),
      startedQuestIds: new Set([WOLF.id]),
    };

    expect(() =>
      planOverworldQuestCompletion({
        ...baseState,
        journalEntries: boundary.journalEntries,
      }),
    ).toThrow(/complete Albany dispatch proof chain/i);
    expect(() =>
      planOverworldQuestCompletion({
        ...baseState,
        openingRegistration: REGISTRATION,
        openingReliefOath: RELIEF_OATH,
        openingLeadSource: LEAD_SOURCE,
      }),
    ).toThrow(/exactly one authenticated quest start/i);

    const plan = planOverworldQuestCompletion({
      ...baseState,
      journalEntries: boundary.journalEntries,
      openingRegistration: REGISTRATION,
      openingReliefOath: RELIEF_OATH,
      openingLeadSource: LEAD_SOURCE,
    });
    expect(plan.entryDraft.text.match(/Registration complete\./g)).toHaveLength(1);

    const applicationState = {
      completedQuestIds: new Set<string>(),
      regionRenown: new Map<string, number>(),
    };
    expect(applyOverworldQuestCompletion(applicationState, plan)).toMatchObject({
      questId: WOLF.id,
      renownGained: plan.renown,
    });
    expect(applicationState.completedQuestIds).toEqual(new Set([WOLF.id]));
  });

  it("creates no receipt for unrelated quests or death and prints exactly one receipt in the CLI", () => {
    const unrelated = WOLF.campaign_exports![0]!;
    expect(
      deriveRegistrationPromiseFoldbackReceipt({
        quest: GALLOWMERE,
        campaignExport: unrelated,
        characterBefore: REGISTRATION.profiles[0]!.character,
        characterAfter: REGISTRATION.profiles[0]!.character,
        worldFactIds: [],
        journalEntries: [],
        openingRegistration: WORLD.opening_registration,
        openingReliefOath: WORLD.opening_relief_oath,
        openingLeadSource: WORLD.opening_lead_source,
      }),
    ).toBeUndefined();

    const deathSession = OverworldSession.restore(WORLD, wolfBoundary("albany:road_warden"));
    const beforeDeath = deathSession.snapshot();
    expect(() =>
      deathSession.completeQuest(WOLF.id, {
        endingId: "ending_pulled_down",
        endingTitle: "Pulled Down in the Snow",
        death: true,
      }),
    ).toThrow(/death ending does not complete/i);
    expect(deathSession.snapshot()).toEqual(beforeDeath);
    expect(
      deathSession
        .snapshot()
        .journalEntries.some((entry) => entry.text.includes("Registration complete.")),
    ).toBe(false);

    const session = OverworldSession.restore(WORLD, wolfBoundary("albany:ledger_advocate"));
    const result = session.completeQuest(WOLF.id, {
      endingId: "ending_held",
      endingTitle: "The Byre Held",
      death: false,
    });
    const transcript = renderQuestCompletion(result);
    expect(transcript.match(/Registration complete\./g)).toHaveLength(1);
    expect(transcript).toBe(result.entry.text);
    expect(compactOverworldQuestCompletionResult(result).text).toBe(result.entry.text);
  });
});
