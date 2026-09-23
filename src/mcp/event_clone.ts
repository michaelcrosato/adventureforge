import type { GameEvent } from "../core/events.js";
import type { RpgCompactEvent } from "./compact_rpg_event.js";

type McpEvent = GameEvent | RpgCompactEvent;

function cloneEventValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneEventValue) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneEventValue(nested)]),
    ) as T;
  }
  return value;
}

export function cloneMcpEvent<Event extends McpEvent>(event: Event): Event {
  return cloneEventValue(event);
}
