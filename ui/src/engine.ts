/**
 * Browser engine client (spec §13 Stage 5).
 *
 * The Web UI is a view over the same headless, deterministic RPG core (§3): it
 * never reimplements a rule. This module compiles an RPG pack in the browser
 * (yaml + zod, no Node APIs), indexes it with the RPG runner, and drives the
 * exact `step` reducer the CLI and MCP server use. No engine internals leak
 * beyond the structured observation.
 *
 * It contains no React, so it is unit-tested in Node alongside the rest of the
 * engine — proving the UI talks only to the structured API.
 */
import { makeStep, actionEquals, type Rules } from "../../src/core/engine.js";
import { hashState } from "../../src/core/hash.js";
import { cloneGameState, type GameState } from "../../src/core/state.js";
import type { RpgAction } from "../../src/api/types.js";
import type { GameEvent } from "../../src/core/events.js";

import { RpgPackSchema } from "../../src/rpg/schema.js";
import {
  CampaignCharacterImportsSchema,
  type CampaignCharacterImports,
} from "../../src/rpg/campaign_character_import.js";
import {
  indexRpgPack,
  buildRpgRules,
  initStateForRpgPack,
  enumerateRpgActions,
  isRpgCheckpointSafeBoundary,
  type RpgIndex,
} from "../../src/rpg/runner.js";
import { rpgActionOptionForInputId } from "../../src/rpg/legal_actions.js";
import { renderRpgSkillCheckDisclosure } from "../../src/rpg/player_command_projection.js";
import {
  parseCampaignCharacterState,
  type CampaignCharacterState,
} from "../../src/world/campaign_character_state.js";
import { buildRpgObservation, type RpgObservation } from "../../src/rpg/observation.js";
import {
  buildEmbeddedQuestCharacterContinuity,
  projectEmbeddedQuestCharacterContinuity,
  cloneEmbeddedQuestCharacterContinuity,
  type EmbeddedQuestCharacterContinuity,
} from "../../src/rpg/embedded_quest_character_continuity.js";
import { assertRpgStateReferences } from "../../src/rpg/state_integrity.js";
import type { EmbeddedLaunchOverlay } from "../../src/core/embedded_launch_overlay_receipt.js";
import { embeddedLaunchOverlayFromPersistedReceipt } from "../../src/world/embedded_launch_overlay.js";
import { SAVE_MODE, SaveIntegrityError, load, save } from "../../src/persist/save_load.js";
import { assertCampaignImportReceiptCatalogCompatibility } from "../../src/persist/campaign_import_integrity.js";
import {
  classifyRpgJourneyDecision,
  excludedJourneyDecision,
} from "../../src/world/journey_decision.js";
import type { JourneyDecisionClassification } from "../../src/world/journey_contract.js";

import { parse as parseYaml } from "yaml";

/** Browser-side compile: parse YAML, require RPG shape, validate, and hash. */
function compileRpgSource(source: string) {
  const raw = parseYaml(source);
  const parsed = RpgPackSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `RPG-only UI pack failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return { pack: parsed.data, contentHash: hashState(parsed.data) };
}

export type Mode = "rpg";

export type ViewChoice = {
  id: string;
  title: string;
  label: string;
  kind: RpgAction["type"];
  detail?: string;
  skillCheck?: NonNullable<RpgObservation["available_actions"][number]["skill_check"]>;
  combat?: NonNullable<RpgObservation["available_actions"][number]["combat"]>;
  resources?: NonNullable<RpgObservation["available_actions"][number]["resources"]>;
};

/** A UI-normalized view of the RPG observation. */
export type View = {
  mode: Mode;
  location: string;
  title: string;
  text: string;
  dialogue: { npc: string; text: string } | null;
  choices: ViewChoice[];
  unavailableChoices: { id: string; label: string; reason: string }[];
  inventory: string[];
  stats: RpgObservation["stats"];
  score: number;
  maxScore: number;
  pressureTracks?: NonNullable<RpgObservation["pressure_tracks"]>;
  visibleObjects: RpgObservation["visible_objects"];
  npcs: RpgObservation["npcs_present"];
  exits: RpgObservation["exits"];
  blockedExits: RpgObservation["blocked_exits"];
  enemies: RpgObservation["enemies_present"];
  publicState: RpgObservation["state"];
  ending: RpgObservation["ending"];
  /** @deprecated Prefer the structured scene/public-state fields above. */
  facts: string[];
  journal: string[];
  ended: boolean;
  endingId: string | null;
  stateHash: string;
  characterContinuity?: EmbeddedQuestCharacterContinuity;
};

type StepOutcome = {
  ok: boolean;
  narration: string[];
  rejection: string | null;
  journeyDecision: JourneyDecisionClassification;
  journeyActionId: string | null;
};

type ReplayedEmbeddedQuestDecision = {
  actionId: string;
  classification: JourneyDecisionClassification;
  checkpointSafeBoundary: boolean;
};

/** Fast shape predicate for catalog filtering and tests. */
export function isRpgSource(source: string): boolean {
  try {
    return RpgPackSchema.safeParse(parseYaml(source)).success;
  } catch {
    return false;
  }
}

/** One playable browser session bound to a compiled RPG pack and a live GameState. */
export class GameSession {
  readonly mode: Mode = "rpg";
  readonly packId: string;
  readonly title: string;
  readonly contentHash: string;
  private readonly rules: Rules<RpgAction>;
  private readonly index: RpgIndex;
  private readonly fresh: () => GameState;
  private readonly characterContinuity: EmbeddedQuestCharacterContinuity | undefined;
  private state: GameState;

  private constructor(opts: {
    packId: string;
    title: string;
    contentHash: string;
    rules: Rules<RpgAction>;
    index: RpgIndex;
    fresh: () => GameState;
    campaignCharacter?: CampaignCharacterState;
    initialState?: GameState;
    characterContinuity?: EmbeddedQuestCharacterContinuity;
  }) {
    this.packId = opts.packId;
    this.title = opts.title;
    this.contentHash = opts.contentHash;
    this.rules = opts.rules;
    this.index = opts.index;
    this.fresh = opts.fresh;
    this.state = opts.initialState ? cloneGameState(opts.initialState) : opts.fresh();
    this.characterContinuity = opts.characterContinuity
      ? cloneEmbeddedQuestCharacterContinuity(opts.characterContinuity)
      : opts.campaignCharacter
        ? buildEmbeddedQuestCharacterContinuity({
            character: opts.campaignCharacter,
            pack: opts.index.pack,
            state: this.state,
          })
        : undefined;
  }

  /** Compile an RPG pack source and start a session (throws on schema failure, §10). */
  static start(source: string, seed = 1): GameSession {
    const c = compileRpgSource(source);
    const index = indexRpgPack(c.pack);
    return new GameSession({
      packId: c.pack.meta.id,
      title: c.pack.meta.title,
      contentHash: c.contentHash,
      rules: buildRpgRules(index),
      index,
      fresh: () => initStateForRpgPack(index, seed),
    });
  }

  /**
   * Start a quest from a live overworld character using only the import catalog
   * authored on that trusted quest. Standalone `start` deliberately has no such
   * input surface.
   */
  static startEmbedded(
    source: string,
    character: CampaignCharacterState,
    imports: CampaignCharacterImports | undefined,
    seed = 1,
    launchOverlay?: EmbeddedLaunchOverlay,
  ): GameSession {
    const c = compileRpgSource(source);
    const index = indexRpgPack(c.pack);
    const characterSnapshot = parseCampaignCharacterState(character);
    const importsSnapshot =
      imports === undefined ? undefined : CampaignCharacterImportsSchema.parse(imports);
    return new GameSession({
      packId: c.pack.meta.id,
      title: c.pack.meta.title,
      contentHash: c.contentHash,
      rules: buildRpgRules(index),
      index,
      fresh: () =>
        importsSnapshot === undefined
          ? initStateForRpgPack(index, seed, undefined, launchOverlay)
          : initStateForRpgPack(
              index,
              seed,
              {
                character: characterSnapshot,
                imports: importsSnapshot,
              },
              launchOverlay,
            ),
      campaignCharacter: characterSnapshot,
    });
  }

  /**
   * Restore a browser quest only after deterministic replay proves the saved
   * state belongs to this exact pack, campaign launch, and accepted action trail.
   */
  static restoreEmbedded(
    source: string,
    worldQuestId: string,
    character: CampaignCharacterState,
    imports: CampaignCharacterImports | undefined,
    expectedSeed: number,
    actionIds: readonly string[],
    savedQuest: string,
  ): { session: GameSession; decisions: ReplayedEmbeddedQuestDecision[] } {
    const c = compileRpgSource(source);
    const index = indexRpgPack(c.pack);
    const characterSnapshot = parseCampaignCharacterState(character);
    const importsSnapshot =
      imports === undefined ? undefined : CampaignCharacterImportsSchema.parse(imports);
    const bundle = load(savedQuest, c.contentHash, SAVE_MODE);
    if (bundle.source_ref[0] !== "wq" || bundle.source_ref[1] !== worldQuestId) {
      throw new SaveIntegrityError(
        `This save belongs to a different quest, not ${JSON.stringify(worldQuestId)}.`,
      );
    }
    if (bundle.state.seed !== expectedSeed) {
      throw new SaveIntegrityError(
        `This save uses a different quest seed than the journey (${expectedSeed}).`,
      );
    }
    assertRpgStateReferences(index, bundle.state);
    assertCampaignImportReceiptCatalogCompatibility(bundle.state, importsSnapshot);

    // A saved child that opened under a launch overlay carries its receipt in
    // state; replaying from a bare fresh state could never reproduce it.
    const launchOverlay = embeddedLaunchOverlayFromPersistedReceipt(
      bundle.state.embeddedLaunchOverlayReceipt,
    );
    const fresh = () =>
      importsSnapshot === undefined
        ? initStateForRpgPack(index, expectedSeed, undefined, launchOverlay)
        : initStateForRpgPack(
            index,
            expectedSeed,
            {
              character: characterSnapshot,
              imports: importsSnapshot,
            },
            launchOverlay,
          );
    const launchState = fresh();
    const expectedContinuity = buildEmbeddedQuestCharacterContinuity({
      character: characterSnapshot,
      pack: index.pack,
      state: launchState,
    });
    const savedContinuity = bundle.embedded_character_continuity?.character_continuity;
    if (!savedContinuity) {
      throw new SaveIntegrityError("This quest save is missing its journey character record.");
    }
    if (hashState(savedContinuity) !== hashState(expectedContinuity)) {
      throw new SaveIntegrityError("This quest save does not match the character who started it.");
    }

    const session = new GameSession({
      packId: c.pack.meta.id,
      title: c.pack.meta.title,
      contentHash: c.contentHash,
      rules: buildRpgRules(index),
      index,
      fresh,
      initialState: launchState,
      characterContinuity: expectedContinuity,
    });
    const decisions: ReplayedEmbeddedQuestDecision[] = [];
    for (const actionId of actionIds) {
      if (typeof actionId !== "string" || actionId.length === 0) {
        throw new SaveIntegrityError("This quest save contains an invalid recorded action.");
      }
      const outcome = session.choose(actionId);
      if (!outcome.ok || outcome.journeyActionId !== actionId) {
        throw new SaveIntegrityError(
          `The recorded action ${JSON.stringify(actionId)} cannot be replayed in this quest.`,
        );
      }
      decisions.push({
        actionId,
        classification: outcome.journeyDecision,
        checkpointSafeBoundary: session.isCheckpointSafeBoundary(),
      });
    }
    if (session.view().stateHash !== bundle.stateHash) {
      throw new SaveIntegrityError("The saved quest state does not match its recorded actions.");
    }
    return { session, decisions };
  }

  /** Canonical, content-bound bytes for the current embedded quest state. */
  saveEmbedded(worldQuestId: string): string {
    if (!this.characterContinuity) {
      throw new SaveIntegrityError("Only a quest started from this journey can be saved here.");
    }
    return save(this.state, this.contentHash, SAVE_MODE, {
      worldQuestId,
      embeddedCharacterContinuity: this.characterContinuity,
    });
  }

  /** Map a choice id from the current view to its structured Action. */
  private actionFor(id: string): ReturnType<typeof enumerateRpgActions>[number] | null {
    return rpgActionOptionForInputId(enumerateRpgActions(this.index, this.state), id);
  }

  /** The current UI view (the only thing a player sees). */
  view(): View {
    const o = buildRpgObservation(this.index, this.state, { includeWorldIntro: true });
    return {
      mode: "rpg",
      location: o.room,
      title: o.title,
      text: o.description,
      dialogue: o.dialogue
        ? {
            npc:
              o.npcs_present.find((candidate) => candidate.id === o.dialogue?.npc)?.name ??
              o.dialogue.npc,
            text: o.dialogue.npc_text,
          }
        : null,
      choices: o.available_actions.map((a) => ({
        id: a.id,
        title: a.command,
        label: a.combat
          ? `${a.command}  ⟨${a.combat.phase === "opening" ? "opening" : a.combat.phase === "follow_through" ? "follow-through" : "one-shot"}, ATK ${signed(a.combat.attack_bonus)}, DEF ${signed(a.combat.defense_bonus)} this round${resourceHint(a.resources)}⟩`
          : a.command,
        kind: a.action.type,
        ...(a.skill_check ? { detail: renderRpgSkillCheckDisclosure(a.skill_check) } : {}),
        ...(a.skill_check ? { skillCheck: a.skill_check } : {}),
        ...(a.combat ? { combat: a.combat } : {}),
        ...(a.resources
          ? { resources: { gains: [...a.resources.gains], costs: [...a.resources.costs] } }
          : {}),
      })),
      unavailableChoices: o.blocked_actions.map((action) => ({
        id: action.id,
        label: action.command,
        reason: action.reason,
      })),
      inventory: o.inventory,
      stats: { ...o.stats },
      score: o.score,
      maxScore: o.max_score,
      ...(o.pressure_tracks ? { pressureTracks: o.pressure_tracks } : {}),
      visibleObjects: o.visible_objects.map((object) => ({ ...object })),
      npcs: o.npcs_present.map((npc) => ({ ...npc })),
      exits: o.exits.map((exit) => ({ ...exit })),
      blockedExits: o.blocked_exits.map((exit) => ({ ...exit })),
      enemies: o.enemies_present.map((enemy) => ({ ...enemy })),
      publicState: {
        flags: [...o.state.flags],
        vars: { ...o.state.vars },
        journal: [...o.state.journal],
      },
      ending: o.ending ? { ...o.ending } : null,
      facts: [
        `HP ${o.stats.hp}  ATK ${o.stats.attack}  DEF ${o.stats.defense}`,
        ...(o.pressure_tracks ?? []).map(pressureFact),
        ...o.enemies_present.map((enemy) => `foe: ${enemy.name} (HP ${enemy.hp})`),
        ...o.exits.map((exit) => `exit: ${exit.direction}`),
        ...o.blocked_exits.map((exit) => `blocked: ${exit.direction} — ${exit.message}`),
      ],
      journal: o.state.journal,
      ended: o.ended,
      endingId: o.ending_id,
      stateHash: hashState(this.state),
      ...(this.characterContinuity
        ? {
            characterContinuity: projectEmbeddedQuestCharacterContinuity({
              continuity: this.characterContinuity,
              pack: this.index.pack,
              state: this.state,
            }),
          }
        : {}),
    };
  }

  /** Whether the embedded journey may pause without interrupting combat or dialogue. */
  isCheckpointSafeBoundary(): boolean {
    return isRpgCheckpointSafeBoundary(this.index, this.state);
  }

  /** Apply a chosen action by id. The legal-action set is ground truth (§9). */
  choose(id: string): StepOutcome {
    const option = this.actionFor(id);
    const blocked = option
      ? null
      : buildRpgObservation(this.index, this.state).blocked_actions.find(
          (action) => action.id === id,
        );
    if (
      !option ||
      !this.rules.legalActions(this.state).some((action) => actionEquals(action, option.action))
    ) {
      return {
        ok: false,
        narration: [],
        rejection: blocked?.reason ?? "That action is not available.",
        journeyDecision: excludedJourneyDecision("rejected"),
        journeyActionId: null,
      };
    }
    const before = this.state;
    const r = makeStep(this.rules)(this.state, option.action);
    if (r.ok) this.state = r.state;
    return {
      ok: r.ok,
      narration: narrationsOf(r.events),
      rejection: r.rejectionReason ?? null,
      journeyDecision: classifyRpgJourneyDecision({
        action: option.action,
        before,
        after: r.state,
        events: r.events,
        accepted: r.ok,
        isSkillCheck: option.skill_check !== undefined,
      }),
      journeyActionId: option.id,
    };
  }

  /**
   * The pack's ending record once the session has ended (null while play
   * continues) — the completion payload the overworld quest bridge needs.
   * Death endings must NOT be completed back into the overworld (the engine
   * rejects them), so callers branch on `death`.
   */
  ending(): { id: string; title: string; death: boolean } | null {
    if (!this.state.ended || !this.state.endingId) return null;
    const ending = this.index.pack.endings.find((e) => e.id === this.state.endingId);
    return ending ? { id: ending.id, title: ending.title, death: ending.death } : null;
  }

  /** Restart from a fresh initial state. */
  reset(): void {
    this.state = this.fresh();
  }
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function pressureFact(track: NonNullable<RpgObservation["pressure_tracks"]>[number]): string {
  const next = track.next ? `; next ${track.next.label} at ${track.next.min}` : "; at maximum";
  const description = track.band.description ? ` — ${track.band.description}` : "";
  return `pressure: ${track.title} — ${track.band.label} (${track.value}${next})${description}`;
}

function resourceHint(resources: { gains: string[]; costs: string[] } | undefined): string {
  if (!resources) return "";
  const readable = (id: string): string => id.replaceAll("_", " ");
  const changes = [
    ...resources.gains.map((id) => `gain ${readable(id)}`),
    ...resources.costs.map((id) => `spend ${readable(id)}`),
  ];
  return changes.length > 0 ? `, ${changes.join(", ")}` : "";
}

function narrationsOf(events: GameEvent[]): string[] {
  return events
    .filter((e): e is Extract<GameEvent, { type: "narration" }> => e.type === "narration")
    .map((e) => e.text);
}
