/**
 * Shared derivation of the embedded launch overlay from an accepted quest
 * start plan (spec §16 launch handoff). Every interface bridge — the MCP
 * server, the terminal journey, and the web UI — must launch a child quest
 * through this one function so a delayed Wolf-Winter dispatch opens the same
 * child state regardless of which surface the player used. Keeping the
 * derivation here (rather than per bridge) is what prevents the drift where
 * one interface honors the dispatch window and another silently drops it.
 */
import { hashState } from "../core/hash.js";
import {
  EMBEDDED_LAUNCH_OVERLAY_RECEIPT_VERSION,
  WOLF_WINTER_DISPATCH_DELAY_FLAG,
  WOLF_WINTER_DISPATCH_ON_TIME_MAX_MINUTES,
  cloneEmbeddedLaunchOverlay,
  type EmbeddedLaunchOverlay,
  type EmbeddedLaunchOverlayReceipt,
} from "../core/embedded_launch_overlay_receipt.js";
import {
  QUEST_DISPATCH_WINDOW_SCHEMA_VERSION,
  type QuestDispatchWindow,
} from "./quest_dispatch_window.js";

type QuestStartPlanWithDispatchWindow = {
  quest: { id: string };
  dispatchWindow: QuestDispatchWindow;
};

/**
 * Deliberately takes no caller identity: the overlay enters the child's
 * deterministic state, so anything surface-specific here (an MCP session handle,
 * a CLI or browser label) would make one launch hash differently per interface
 * and per run (bug_0644). The parent binding an MCP child needs lives outside
 * GameState, on the MCP session record.
 */
export function embeddedLaunchOverlayForPlan(
  plan: QuestStartPlanWithDispatchWindow,
): EmbeddedLaunchOverlay | undefined {
  const dispatchWindow = plan.dispatchWindow;
  const ledgerMinutes = dispatchWindow.ledgerMinutes;
  // Current plans always carry the dispatch field. A missing or legacy-neutral
  // proof is deliberately neutral; only a complete, self-verifying delayed
  // receipt can change this child opening.
  if (dispatchWindow.status !== "delayed") return undefined;
  if (
    dispatchWindow.schemaVersion !== QUEST_DISPATCH_WINDOW_SCHEMA_VERSION ||
    dispatchWindow.questId !== plan.quest.id ||
    typeof ledgerMinutes !== "number" ||
    !Number.isSafeInteger(ledgerMinutes) ||
    ledgerMinutes <= WOLF_WINTER_DISPATCH_ON_TIME_MAX_MINUTES ||
    dispatchWindow.receipt === undefined ||
    dispatchWindow.proofHash !==
      hashState({
        schemaVersion: dispatchWindow.schemaVersion,
        questId: dispatchWindow.questId,
        status: dispatchWindow.status,
        ledgerMinutes: dispatchWindow.ledgerMinutes,
        receipt: dispatchWindow.receipt,
      })
  ) {
    throw new Error("Quest dispatch window is incomplete or lacks current provenance.");
  }
  // This is a launch-local Wolf-Winter condition. Other quests retain their
  // authored fresh state even when the parent carries dispatch timing data.
  if (plan.quest.id !== "wolf_winter") return undefined;

  return cloneEmbeddedLaunchOverlay({
    receipt: {
      version: EMBEDDED_LAUNCH_OVERLAY_RECEIPT_VERSION,
      kind: "overworld_dispatch_opening",
      world_quest_id: "wolf_winter",
      dispatch_window_version: dispatchWindow.schemaVersion,
      status: "delayed",
      ledger_minutes: ledgerMinutes,
      provenance_hash: dispatchWindow.proofHash,
      applied_flag: WOLF_WINTER_DISPATCH_DELAY_FLAG,
    },
  });
}

/**
 * Rehydrate the overlay a persisted child state already carries, so a
 * replay-from-fresh restore reproduces the same overlaid launch state the
 * original session started from. The receipt re-parses through its zod schema
 * on application, so a tampered persisted receipt still fails closed.
 */
export function embeddedLaunchOverlayFromPersistedReceipt(
  receipt: EmbeddedLaunchOverlayReceipt | undefined,
): EmbeddedLaunchOverlay | undefined {
  return receipt === undefined ? undefined : cloneEmbeddedLaunchOverlay({ receipt });
}
