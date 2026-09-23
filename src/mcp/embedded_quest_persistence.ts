/**
 * Persisting an embedded quest child beside its overworld parent over MCP (bug_0654).
 *
 * `export_overworld_session` used to return only the parent snapshot, and a restore mints a
 * new parent id, while the child RPG session stayed bound to the OLD id in server memory (and
 * `load_game` never binds a child to any parent). A journey saved mid-quest therefore came
 * back with its quest started and nothing able to finish it: starting it again said "already
 * active", completing it said "did not start from the supplied overworld session", and
 * following the goal found no route.
 *
 * The terminal journey and browser UI never had this problem because they persist parent
 * AND child together and re-verify the child on load. This module gives MCP the same
 * capability by reusing the terminal journey's own record and verifier
 * (src/cli/embedded_quest_journey.ts), so the surfaces cannot drift on what a trustworthy
 * restored child is:
 *
 * - export adds `embedded_quest` NEXT TO the versioned snapshot (the snapshot schema has no
 *   slot for a child, and gaining one would change every snapshot hash);
 * - restore verifies it against the restored parent, then binds a fresh child session to
 *   the NEW parent id;
 * - a mid-quest snapshot restored WITHOUT its child is refused with the remedy, instead of
 *   producing a parent nothing can finish.
 */
import {
  EmbeddedQuestChildRecordSchema,
  embeddedQuestChildRecord,
  restoreEmbeddedQuestChild,
  unfinishedEmbeddedQuestIds,
  type EmbeddedQuestChildRecord,
} from "../cli/embedded_quest_journey.js";
import type { OverworldManifest } from "../world/overworld.js";
import type { OverworldSession } from "../world/session.js";
import type { RpgSourceRuntime } from "./rpg_source_runtime.js";
import type { RpgMcpSessionRuntime } from "./rpg_session_runtime.js";
import { publicRpgStateHash } from "./rpg_state_guards.js";
import type { SessionStore } from "./sessions.js";

export type { EmbeddedQuestChildRecord };

export type EmbeddedQuestPersistenceDeps = {
  sessions: SessionStore;
  rpgRuntime: RpgMcpSessionRuntime;
  rpgSources: RpgSourceRuntime;
  loadOverworldManifest: () => OverworldManifest;
};

/** What a restore that re-bound a child adds to its response. */
export type EmbeddedQuestRestoreFields = {
  rpg_session_id: string;
  rpg_state_hash: string;
};

/** Binds the verified child to the parent's newly minted session id. */
export type EmbeddedQuestBinder = (parentSessionId: string) => EmbeddedQuestRestoreFields;

export type EmbeddedQuestPersistence = {
  exportChild(parentSessionId: string, parent: OverworldSession): EmbeddedQuestChildRecord | null;
  prepareRestore(parent: OverworldSession, raw: unknown): EmbeddedQuestBinder | null;
};

function questTitle(world: OverworldManifest, questId: string): string {
  return world.quests.find((quest) => quest.id === questId)?.title ?? questId;
}

/**
 * The quest whose child a persisted parent cannot be restored without: its one unfinished
 * quest, while the journey is still live. An ended journey retains no child, exactly as the
 * terminal journey rules.
 */
function questNeedingChild(parent: OverworldSession): string | null {
  if (parent.journey().status === "ended") return null;
  const unfinished = unfinishedEmbeddedQuestIds(parent);
  if (unfinished.length === 0) return null;
  if (unfinished.length > 1) {
    throw new Error(
      `This journey has more than one unfinished quest (${unfinished.join(", ")}); only one embedded quest can be active.`,
    );
  }
  return unfinished[0]!;
}

export function createEmbeddedQuestPersistence(
  deps: EmbeddedQuestPersistenceDeps,
): EmbeddedQuestPersistence {
  return {
    exportChild(parentSessionId, parent) {
      const questId = questNeedingChild(parent);
      if (questId === null) return null;
      const world = deps.loadOverworldManifest();
      const title = questTitle(world, questId);
      const child = deps.sessions.embeddedChildFor(parentSessionId, questId);
      // Refuse rather than export a parent alone: that export could never be restored.
      if (!child || !child.embeddedCharacterContinuity || !child.embeddedActionIds) {
        throw new Error(
          `Cannot export this journey while "${title}" is active: its quest session is no longer in server memory, so the export could not be restored. Sessions are retained only while recent; export while the quest is still in play.`,
        );
      }
      const launchCharacter = parent.questLaunchCharacterState(questId);
      if (!launchCharacter) {
        throw new Error(`Cannot export "${title}": the journey has no proven launch character.`);
      }
      return embeddedQuestChildRecord({
        worldQuestId: questId,
        title,
        contentHash: child.contentHash,
        launchCharacter,
        continuity: child.embeddedCharacterContinuity,
        actionIds: child.embeddedActionIds,
        state: child.state,
      });
    },

    prepareRestore(parent, raw) {
      const questId = questNeedingChild(parent);
      const world = deps.loadOverworldManifest();
      if (raw === undefined) {
        if (questId === null) return null;
        throw new Error(
          `This snapshot was exported while "${questTitle(world, questId)}" was active, so it needs the embedded_quest from the same export_overworld_session response. Pass both snapshot and embedded_quest to restore_overworld_session; restored without it, the journey could never finish that quest.`,
        );
      }
      if (questId === null) {
        throw new Error(
          "embedded_quest was supplied, but this snapshot has no active quest to bind it to. Pass embedded_quest only with the snapshot from the same export.",
        );
      }
      const parsed = EmbeddedQuestChildRecordSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `embedded_quest is malformed; pass it exactly as export_overworld_session returned it. ${parsed.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
            .join("; ")}`,
        );
      }
      if (parsed.data.worldQuestId !== questId) {
        throw new Error(
          `embedded_quest is for "${parsed.data.worldQuestId}", but this snapshot's active quest is "${questId}". Pass the embedded_quest from the same export.`,
        );
      }
      // A parent at a character-death boundary retains its ended child as terminal;
      // every other live parent retains an unended one. The verifier checks both halves.
      const phase =
        parent.snapshot().questCharacterDeathBoundary?.questId === questId ? "terminal" : "active";
      const child = restoreEmbeddedQuestChild({
        world,
        runtime: deps.rpgSources,
        parent,
        phase,
        saved: parsed.data,
      });
      const compiled = deps.rpgSources.requireWorldQuestPlayable(questId).compiled;
      return (parentSessionId) => {
        const session = deps.rpgRuntime.startSession(compiled, child.state, {
          worldQuestId: child.worldQuestId,
          overworldSessionId: parentSessionId,
          embeddedCharacterContinuity: child.continuity,
          embeddedActionIds: child.actionIds,
        });
        // A journey checkpoint or death gate paused this exact child when it was exported;
        // re-register the pause so answering the journey choice resumes it again.
        if (parent.journey().pendingChoice !== null) {
          deps.sessions.markEmbeddedJourneyPause(session.id);
        }
        return {
          rpg_session_id: session.id,
          rpg_state_hash: publicRpgStateHash(session.stateHash),
        };
      };
    },
  };
}
