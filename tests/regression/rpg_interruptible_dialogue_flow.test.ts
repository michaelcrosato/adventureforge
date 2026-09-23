/**
 * bug_0512 — fresh pure seed 1809 found two sides of the same conversation tax:
 * reply nodes demanded a navigation-only "ask something else" step, while an
 * ordinary read or move was rejected until dialogue was explicitly closed.
 *
 * The shared RPG core now treats conversation as an interruptible exchange.
 * Answer nodes with a safe unconditional root-back edge resume the root in the
 * same step. Same-room actions coexist with the exchange; leaving closes it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolve as resolveCli } from "../../bin/rpg_play.js";
import type { RpgAction } from "../../src/api/types.js";
import { makeStep, type Rules } from "../../src/core/engine.js";
import type { GameEvent } from "../../src/core/events.js";
import type { GameState } from "../../src/core/state.js";
import { createToolApi } from "../../src/mcp/tools.js";
import { activeDialogue } from "../../src/rpg/model.js";
import { buildRpgObservation } from "../../src/rpg/observation.js";
import { projectRpgPlayerCommands } from "../../src/rpg/player_command_projection.js";
import {
  buildRpgRules,
  enumerateRpgActions,
  indexRpgPack,
  initStateForRpgPack,
  type RpgIndex,
} from "../../src/rpg/runner.js";
import { InteractionSchema, type RpgPack } from "../../src/rpg/schema.js";
import { loadRpgSourceFile } from "../../src/rpg/source.js";
import { classifyRpgJourneyDecision } from "../../src/world/journey_decision.js";
import { GameSession } from "../../ui/src/engine.js";

const SOURCE_PATH = "content/rpg/quests/gallowmere.yaml";
const SOURCE = readFileSync(SOURCE_PATH, "utf8");
const loaded = loadRpgSourceFile(SOURCE_PATH);
if (!loaded.ok) throw new Error("gallowmere must compile");
const BASE_PACK = loaded.compiled.pack;

type Driven = {
  before: GameState;
  state: GameState;
  action: RpgAction;
  events: GameEvent[];
  skillCheck: boolean;
};

function drive(
  index: RpgIndex,
  rules: Rules<RpgAction>,
  state: GameState,
  actionId: string,
): Driven {
  const option = enumerateRpgActions(index, state).find((candidate) => candidate.id === actionId);
  if (!option) {
    throw new Error(
      `Missing ${actionId} in ${state.current}; legal=[${enumerateRpgActions(index, state)
        .map((candidate) => candidate.id)
        .join(", ")}]`,
    );
  }
  const result = makeStep(rules)(state, option.action);
  expect(result.ok, result.rejectionReason).toBe(true);
  if (!result.ok) throw new Error("unreachable rejected action");
  return {
    before: state,
    state: result.state,
    action: option.action,
    events: result.events,
    skillCheck: option.skill_check !== undefined,
  };
}

function fresh(pack: RpgPack = BASE_PACK): {
  index: RpgIndex;
  rules: Rules<RpgAction>;
  state: GameState;
} {
  const index = indexRpgPack(pack);
  return { index, rules: buildRpgRules(index), state: initStateForRpgPack(index, 1809) };
}

describe("bug_0512 — interruptible, auto-resuming RPG dialogue", () => {
  it("delivers Hedrick's answer once and immediately exposes the next real choices", () => {
    const game = fresh();
    let state = drive(game.index, game.rules, game.state, "go_west").state;
    state = drive(game.index, game.rules, state, "talk_hedrick").state;
    const answer = drive(game.index, game.rules, state, "ask_ask_sow");
    state = answer.state;

    expect(answer.events.filter((event) => event.type === "narration")).toHaveLength(1);
    expect(
      answer.events
        .filter(
          (event): event is Extract<GameEvent, { type: "narration" }> => event.type === "narration",
        )
        .map((event) => event.text)
        .join(" "),
    ).toMatch(/attack from upwind/i);
    expect(activeDialogue(game.index, state)?.node.id).toBe("hedrick_root");
    expect(state.flags.heard_lore_counsel).toBe(true);

    const ids = enumerateRpgActions(game.index, state).map((option) => option.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "ask_ask_father",
        "ask_leave_hedrick",
        "read_shepherd_log",
        "go_east",
      ]),
    );
    expect(ids).not.toContain("ask_hedrick_sow_back");
    expect(ids).not.toContain("ask_ask_sow");
  });

  it("keeps read/inventory in the exchange and closes it only when movement leaves", () => {
    const readGame = fresh();
    let state = drive(readGame.index, readGame.rules, readGame.state, "go_west").state;
    state = drive(readGame.index, readGame.rules, state, "talk_hedrick").state;
    const read = drive(readGame.index, readGame.rules, state, "read_shepherd_log");
    expect(read.state.step).toBe(read.before.step + 1);
    expect(activeDialogue(readGame.index, read.state)?.node.id).toBe("hedrick_root");
    expect(read.state.flags.read_log).toBe(true);
    expect(
      classifyRpgJourneyDecision({
        action: read.action,
        before: read.before,
        after: read.state,
        events: read.events,
        accepted: true,
      }),
    ).toEqual({ countsTowardJourney: true, reason: "stateful_clue" });

    const inventoryGame = fresh();
    state = drive(inventoryGame.index, inventoryGame.rules, inventoryGame.state, "go_west").state;
    state = drive(inventoryGame.index, inventoryGame.rules, state, "talk_hedrick").state;
    const inventory = drive(inventoryGame.index, inventoryGame.rules, state, "inventory");
    expect(activeDialogue(inventoryGame.index, inventory.state)?.node.id).toBe("hedrick_root");
    expect(
      classifyRpgJourneyDecision({
        action: inventory.action,
        before: inventory.before,
        after: inventory.state,
        events: inventory.events,
        accepted: true,
      }),
    ).toEqual({ countsTowardJourney: false, reason: "context_only" });

    const moveGame = fresh();
    state = drive(moveGame.index, moveGame.rules, moveGame.state, "go_west").state;
    state = drive(moveGame.index, moveGame.rules, state, "talk_hedrick").state;
    const moved = drive(moveGame.index, moveGame.rules, state, "go_east");
    expect(moved.state.current).toBe("moor_edge");
    expect(activeDialogue(moveGame.index, moved.state)).toBeNull();
    expect(
      classifyRpgJourneyDecision({
        action: moved.action,
        before: moved.before,
        after: moved.state,
        events: moved.events,
        accepted: true,
      }),
    ).toEqual({ countsTowardJourney: true, reason: "movement" });
  });

  it("fails closed when a qualified ask names an ambiguous, absent, or different speaker", () => {
    const pack = structuredClone(BASE_PACK);
    const hedrick = pack.npcs.find((npc) => npc.id === "hedrick");
    if (!hedrick) throw new Error("expected Hedrick");
    pack.npcs.push({
      ...structuredClone(hedrick),
      id: "hedrick_witness",
      name: "Hedrick witness",
    });

    const game = fresh(pack);
    let state = drive(game.index, game.rules, game.state, "go_west").state;
    state = drive(game.index, game.rules, state, "talk_hedrick").state;

    for (const command of [
      "ask Hedrick about sow",
      "ASK_HEDRICK_ABOUT_SOW",
      "ask-Hedrick-about-sow",
    ]) {
      expect(resolveCli(game.index, state, command)).toEqual({
        ok: true,
        action: { type: "ASK", npc: "hedrick", topic: "ask_sow" },
      });
    }
    expect(resolveCli(game.index, state, "ask Hed about sow")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/more than one person here/i),
    });
    expect(resolveCli(game.index, state, "ask Hedrick witness about sow")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/speaking with Hedrick, not Hedrick witness/i),
    });
    expect(resolveCli(game.index, state, "ask Rowan about sow")).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no visible person called "rowan" here/i),
    });
  });

  it("gives speaker-aware TALK guidance using every exact current reply", () => {
    const pack = structuredClone(BASE_PACK);
    const hedrick = pack.npcs.find((npc) => npc.id === "hedrick");
    if (!hedrick) throw new Error("expected Hedrick");
    pack.npcs.push({
      ...structuredClone(hedrick),
      id: "hedrick_witness",
      name: "Hedrick witness",
    });

    const game = fresh(pack);
    let state = drive(game.index, game.rules, game.state, "go_west").state;
    state = drive(game.index, game.rules, state, "talk_hedrick").state;
    const exactReplies = projectRpgPlayerCommands(enumerateRpgActions(game.index, state), {
      index: game.index,
      state,
    })
      .filter(({ option }) => option.action.type === "ASK" && option.action.npc === "hedrick")
      .map(({ command }) => command);

    for (const command of ["talk to Hedrick", "TALK_TO_HEDRICK"]) {
      const retry = resolveCli(game.index, state, command);
      expect(retry).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/already speaking with Hedrick/i),
      });
      if (retry.ok) throw new Error("active TALK retry must fail closed");
      for (const reply of exactReplies) expect(retry.reason).toContain(`\`${reply}\``);
    }

    const switchSpeaker = resolveCli(game.index, state, "TALK-TO-HEDRICK-WITNESS");
    expect(switchSpeaker).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/speaking with Hedrick, not Hedrick witness/i),
    });
    expect(activeDialogue(game.index, state)?.npc.id).toBe("hedrick");
  });

  it("keeps a genuine child-only branch instead of folding it out of sight", () => {
    const pack = structuredClone(BASE_PACK);
    const hedrick = pack.npcs.find((npc) => npc.id === "hedrick");
    const reply = hedrick?.dialogue.nodes.find((node) => node.id === "hedrick_sow");
    if (!reply) throw new Error("expected Hedrick's sow reply");
    reply.topics.push({
      id: "press_unique_detail",
      prompt: "Press Hedrick for one detail only available here.",
      goto: "hedrick_father",
      end: false,
    });

    const game = fresh(pack);
    let state = drive(game.index, game.rules, game.state, "go_west").state;
    state = drive(game.index, game.rules, state, "talk_hedrick").state;
    state = drive(game.index, game.rules, state, "ask_ask_sow").state;

    expect(activeDialogue(game.index, state)?.node.id).toBe("hedrick_sow");
    expect(enumerateRpgActions(game.index, state).map((option) => option.id)).toEqual(
      expect.arrayContaining(["ask_press_unique_detail", "ask_hedrick_sow_back"]),
    );
  });

  it("keeps an authored root re-entry effect behind its explicit back choice", () => {
    const pack = structuredClone(BASE_PACK);
    const hedrick = pack.npcs.find((npc) => npc.id === "hedrick");
    const root = hedrick?.dialogue.nodes.find((node) => node.id === "hedrick_root");
    if (!root) throw new Error("expected Hedrick's root");
    root.effects.push({ inc_var: { name: "root_visits", by: 1 } });

    const game = fresh(pack);
    let state = drive(game.index, game.rules, game.state, "go_west").state;
    state = drive(game.index, game.rules, state, "talk_hedrick").state;
    expect(state.vars.root_visits).toBe(1);
    state = drive(game.index, game.rules, state, "ask_ask_sow").state;

    expect(state.vars.root_visits).toBe(1);
    expect(activeDialogue(game.index, state)?.node.id).toBe("hedrick_sow");
    expect(enumerateRpgActions(game.index, state).map((option) => option.id)).toContain(
      "ask_hedrick_sow_back",
    );
  });

  it("closes an exchange when a same-room action retires its NPC", () => {
    const pack = structuredClone(BASE_PACK);
    const hedrick = pack.npcs.find((npc) => npc.id === "hedrick");
    if (!hedrick) throw new Error("expected Hedrick");
    hedrick.conditions = [{ not_flag: "read_log" }];

    const game = fresh(pack);
    let state = drive(game.index, game.rules, game.state, "go_west").state;
    state = drive(game.index, game.rules, state, "talk_hedrick").state;
    const read = enumerateRpgActions(game.index, state).find(
      (option) => option.id === "read_shepherd_log",
    );
    if (!read) throw new Error("expected shepherd log read");
    expect(resolveCli(game.index, state, read.command)).toEqual({
      ok: true,
      action: read.action,
    });
    state = drive(game.index, game.rules, state, read.id).state;

    expect(activeDialogue(game.index, state)).toBeNull();
    const observation = buildRpgObservation(game.index, state);
    expect(observation.npcs_present.map((npc) => npc.id)).not.toContain("hedrick");
    expect(observation.dialogue).toBeNull();
    expect(observation.available_actions.map((option) => option.id)).not.toContain(
      "ask_ask_father",
    );
  });

  it("clears dialogue before a same-room post-action win ends play", () => {
    const pack = structuredClone(BASE_PACK);
    pack.win_conditions.unshift({
      id: "log_wins",
      conditions: [{ has_flag: "read_log" }],
      ending: "ending_hunt_won",
    });

    const game = fresh(pack);
    let state = drive(game.index, game.rules, game.state, "go_west").state;
    state = drive(game.index, game.rules, state, "talk_hedrick").state;
    state = drive(game.index, game.rules, state, "read_shepherd_log").state;

    expect(state.ended).toBe(true);
    expect(state.endingId).toBe("ending_hunt_won");
    expect(activeDialogue(game.index, state)).toBeNull();
    expect(buildRpgObservation(game.index, state).dialogue).toBeNull();
  });

  // bug_0640: applyEffects stops at the first end_game, so the close used to be
  // appended where it could never land whenever the ACTION ITSELF ended play.
  it("clears dialogue when an answer node's own effects end play", () => {
    const pack = structuredClone(BASE_PACK);
    const answerNode = pack.npcs
      .find((npc) => npc.id === "hedrick")
      ?.dialogue?.nodes.find((node) => node.id === "hedrick_sow");
    if (!answerNode) throw new Error("expected Hedrick's sow answer");
    answerNode.effects.push({ end_game: "ending_hunt_won" });

    const game = fresh(pack);
    let state = drive(game.index, game.rules, game.state, "go_west").state;
    state = drive(game.index, game.rules, state, "talk_hedrick").state;
    const answer = drive(game.index, game.rules, state, "ask_ask_sow");

    expect(answer.state.ended).toBe(true);
    expect(answer.state.endingId).toBe("ending_hunt_won");
    // The node re-points the dialogue variable before its end_game; every effect
    // ahead of the end_game still lands, and the close now lands after them.
    expect(answer.state.flags.heard_lore_counsel).toBe(true);
    expect(answer.state.vars.__dlg_hedrick).toBe(0);
    expect(activeDialogue(game.index, answer.state)).toBeNull();
    expect(buildRpgObservation(game.index, answer.state).dialogue).toBeNull();
    expect(answer.events.at(-1)).toEqual({ type: "ending", endingId: "ending_hunt_won" });
  });

  it("clears dialogue when a same-room rolled USE's outcome ends play", () => {
    const pack = structuredClone(BASE_PACK);
    const log = pack.objects.find((object) => object.id === "shepherd_log");
    if (!log) throw new Error("expected shepherd_log");
    log.interactions.push(
      InteractionSchema.parse({
        verb: "USE",
        target: "shepherd_log",
        command_verb: "test",
        conditions: [],
        effects: [{ set_flag: "test_started" }],
        skill_check: {
          skill: "tracking",
          difficulty: 1,
          on_success: [{ set_flag: "test_succeeded" }, { end_game: "ending_hunt_won" }],
          on_failure: [{ set_flag: "test_failed" }, { end_game: "ending_hunt_won" }],
        },
      }),
    );

    const game = fresh(pack);
    let state = drive(game.index, game.rules, game.state, "go_west").state;
    state = drive(game.index, game.rules, state, "talk_hedrick").state;
    const rolled = drive(game.index, game.rules, state, "use_shepherd_log");

    expect(rolled.skillCheck).toBe(true);
    expect(rolled.state.ended).toBe(true);
    expect(rolled.state.endingId).toBe("ending_hunt_won");
    expect(rolled.state.flags.test_started).toBe(true);
    expect(rolled.state.vars.__dlg_hedrick).toBe(0);
    expect(activeDialogue(game.index, rolled.state)).toBeNull();
    expect(buildRpgObservation(game.index, rolled.state).dialogue).toBeNull();
  });

  it("keeps a same-room rolled USE inside the active exchange", () => {
    const pack = structuredClone(BASE_PACK);
    const log = pack.objects.find((object) => object.id === "shepherd_log");
    if (!log) throw new Error("expected shepherd_log");
    log.interactions.push(
      InteractionSchema.parse({
        verb: "USE",
        target: "shepherd_log",
        command_verb: "test",
        conditions: [],
        effects: [{ set_flag: "test_started" }],
        skill_check: {
          skill: "tracking",
          difficulty: 1,
          on_success: [{ set_flag: "test_succeeded" }],
          on_failure: [{ set_flag: "test_failed" }],
        },
      }),
    );

    const game = fresh(pack);
    let state = drive(game.index, game.rules, game.state, "go_west").state;
    state = drive(game.index, game.rules, state, "talk_hedrick").state;
    const option = enumerateRpgActions(game.index, state).find(
      (candidate) => candidate.id === "use_shepherd_log",
    );
    expect(option?.skill_check).toEqual({
      skill: "tracking",
      modifier: state.vars.tracking ?? 0,
      difficulty: 1,
      die: "d20",
    });
    const rolled = drive(game.index, game.rules, state, "use_shepherd_log");

    expect(rolled.state.step).toBe(rolled.before.step + 1);
    expect(activeDialogue(game.index, rolled.state)?.node.id).toBe("hedrick_root");
    expect(rolled.state.flags.test_started).toBe(true);
    expect(rolled.state.flags.test_succeeded).toBe(true);
    expect(rolled.state.flags.test_failed).toBeUndefined();
    expect(
      classifyRpgJourneyDecision({
        action: rolled.action,
        before: rolled.before,
        after: rolled.state,
        events: rolled.events,
        accepted: true,
        isSkillCheck: rolled.skillCheck,
      }),
    ).toEqual({ countsTowardJourney: true, reason: "skill_check" });
  });

  it("keeps browser and compact MCP choices/classification identical", () => {
    const ui = GameSession.start(SOURCE, 1809);
    const api = createToolApi({ root: process.cwd() });
    const started = api.start_world_quest({
      world_quest_id: "gallowmere",
      seed: 1809,
      compact_observation: true,
      include_actions: true,
    });
    const sid = started.session_id;
    const stepMcp = (action_id: string) =>
      api.step_action({
        session_id: sid,
        action_id,
        compact_observation: true,
        compact_events: false,
        include_actions: true,
      }) as unknown as {
        ok: boolean;
        context: {
          actions?: string[];
          dialogue?: [string, string];
          here: readonly [string, string];
        };
        journeyDecision: { countsTowardJourney: boolean; reason: string };
      };

    for (const actionId of ["go_west", "talk_hedrick", "ask_ask_sow"]) {
      const uiResult = ui.choose(actionId);
      const mcpResult = stepMcp(actionId);
      expect(mcpResult.ok, actionId).toBe(true);
      expect(mcpResult.journeyDecision, actionId).toEqual(uiResult.journeyDecision);
    }

    const uiIds = ui.view().choices.map((choice) => choice.id);
    const compact = api.get_observation({
      session_id: sid,
      compact_observation: true,
      include_actions: true,
    }) as unknown as { context: { actions?: string[]; dialogue?: [string, string] } };
    expect(compact.context.actions).toEqual(uiIds);
    expect(compact.context.dialogue?.[0]).toBe("hedrick");
    expect(uiIds).toEqual(expect.arrayContaining(["ask_ask_father", "read_shepherd_log"]));
    expect(uiIds).not.toContain("ask_hedrick_sow_back");

    const uiRead = ui.choose("read_shepherd_log");
    const mcpRead = stepMcp("read_shepherd_log");
    expect(mcpRead.ok).toBe(true);
    expect(mcpRead.journeyDecision).toEqual(uiRead.journeyDecision);
    expect(mcpRead.journeyDecision).toEqual({
      countsTowardJourney: true,
      reason: "stateful_clue",
    });
    expect(mcpRead.context.dialogue?.[0]).toBe("hedrick");
    expect(ui.view().choices.map((choice) => choice.id)).toContain("ask_ask_father");
    expect(ui.view().choices.map((choice) => choice.id)).not.toContain("talk_hedrick");

    const uiFollowup = ui.choose("ask_ask_father");
    const mcpFollowup = stepMcp("ask_ask_father");
    expect(mcpFollowup.ok).toBe(true);
    expect(mcpFollowup.journeyDecision).toEqual(uiFollowup.journeyDecision);
    expect(mcpFollowup.journeyDecision).toEqual({
      countsTowardJourney: true,
      reason: "substantive_dialogue",
    });

    const uiMoved = ui.choose("go_east");
    const mcpMoved = stepMcp("go_east");
    expect(mcpMoved.ok).toBe(true);
    expect(mcpMoved.journeyDecision).toEqual(uiMoved.journeyDecision);
    expect(mcpMoved.journeyDecision).toEqual({
      countsTowardJourney: true,
      reason: "movement",
    });
    expect(ui.view().location).toBe("moor_edge");
    expect(mcpMoved.context.here[0]).toBe("moor_edge");
    expect(mcpMoved.context.dialogue).toBeUndefined();
    expect(mcpMoved.context.actions).toEqual(ui.view().choices.map((choice) => choice.id));
  });
});
