# Bolt's Journal

Critical learnings and codebase-specific performance patterns for AdventureForge.

## 2025-05-18 - WeakMap caching of worldHash for frozen OverworldManifest
**Learning:** `hashState(world)` takes ~100ms on the large overworld manifest object because canonical serialization recursively sorts keys and formats JSON. When building `OverworldSessionIndexes`, this calculation was being re-run on every session initialization. Caching the result via a module-level `WeakMap` for `Object.isFrozen(world)` instances eliminates this ~100ms overhead for subsequent sessions with zero risk of stale data or memory leaks.
**Action:** Always check if heavy serialization or hashing functions are repeatedly invoked on immutable/frozen domain objects, and use a `WeakMap` cached by object identity.

## 2025-05-19 - O(1) single-object presence checks vs. full world scans
**Learning:** Checking whether a single item was present in a room previously called `visibleObjectIds(index, state, room).includes(id)`. Because `visibleObjectIds` iterates across every object in the game pack, evaluating 20+ candidate actions per turn caused dozens of full-pack scans per step. Implementing `isObjectVisibleInRoom` directly resolves the target item's runtime location and walks its container hierarchy up to the room in $O(\text{container\_depth})$ time, avoiding $O(N_{\text{world\_objects}})$ iterations.
**Action:** When validating if a specific item or entity satisfies a spatial predicate, use targeted location lookup (`locateObject`) and parent chain traversal rather than materializing the entire visible set of the room.
