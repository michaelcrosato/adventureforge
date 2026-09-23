/**
 * Shared object location helpers.
 *
 * Parser and RPG packs both use the same runtime precedence:
 * inventory > moved room > static room home > static container > nowhere.
 */
import type { GameState } from "./state.js";

export type ObjectLocation =
  | { kind: "inventory" }
  | { kind: "room"; room: string }
  | { kind: "container"; container: string }
  | { kind: "nowhere" };

type ObjectPlacementIndex = {
  objects: Map<string, { locked?: boolean }>;
  homeRoom: Map<string, string>;
  containerOf: Map<string, string>;
};

export function indexObjectHomes(
  rooms: readonly { id: string; objects: readonly string[] }[],
  objects: readonly { id: string; contents: readonly string[] }[],
): { homeRoom: Map<string, string>; containerOf: Map<string, string> } {
  const homeRoom = new Map<string, string>();
  for (const room of rooms) for (const objectId of room.objects) homeRoom.set(objectId, room.id);
  const containerOf = new Map<string, string>();
  for (const object of objects) {
    for (const childId of object.contents) containerOf.set(childId, object.id);
  }
  return { homeRoom, containerOf };
}

export function locateObject(
  index: ObjectPlacementIndex,
  state: GameState,
  id: string,
): ObjectLocation {
  if (state.inventory.includes(id)) return { kind: "inventory" };
  const moved = state.objectState[id]?.room;
  if (moved) return { kind: "room", room: moved };
  const home = index.homeRoom.get(id);
  if (home) return { kind: "room", room: home };
  const container = index.containerOf.get(id);
  if (container) return { kind: "container", container };
  return { kind: "nowhere" };
}

export function isOpen(state: GameState, id: string): boolean {
  return state.objectState[id]?.open === true;
}

export function isLocked(index: ObjectPlacementIndex, state: GameState, id: string): boolean {
  const runtimeLocked = state.objectState[id]?.locked;
  if (runtimeLocked !== undefined) return runtimeLocked;
  return index.objects.get(id)?.locked ?? false;
}

export function visibleObjectIds(
  index: ObjectPlacementIndex,
  state: GameState,
  room: string,
): string[] {
  const out: string[] = [];
  for (const id of index.objects.keys()) {
    const loc = locateObject(index, state, id);
    if (loc.kind === "room" && loc.room === room) {
      out.push(id);
    } else if (loc.kind === "container") {
      const containerLoc = locateObject(index, state, loc.container);
      if (
        containerLoc.kind === "room" &&
        containerLoc.room === room &&
        isOpen(state, loc.container)
      ) {
        out.push(id);
      }
    }
  }
  return out.sort();
}
