/**
 * Event log (spec §8.3).
 *
 * Every action produces an ordered event list — the system's universal record,
 * used for narration, the AI's experience log, testing, and debugging. Event
 * shapes are deliberately flat and JSON-serializable.
 */

export type GameEvent =
  | { type: "state_change"; effect: string; [k: string]: unknown }
  | { type: "narration"; text: string }
  | { type: "open_object"; id: string }
  | { type: "close_object"; id: string }
  | { type: "move"; from: string; to: string }
  | { type: "take"; item: string }
  | { type: "drop"; item: string }
  | { type: "dialogue"; npc: string; node: string }
  | { type: "ending"; endingId: string }
  | { type: "rejected"; reason: string };

/** Allowed `type` values, per §8.3 — handy for tests and exhaustiveness. */
