# Bolt's Journal

Critical learnings and codebase-specific performance patterns for AdventureForge.

## 2025-05-18 - WeakMap caching of worldHash for frozen OverworldManifest
**Learning:** `hashState(world)` takes ~100ms on the large overworld manifest object because canonical serialization recursively sorts keys and formats JSON. When building `OverworldSessionIndexes`, this calculation was being re-run on every session initialization. Caching the result via a module-level `WeakMap` for `Object.isFrozen(world)` instances eliminates this ~100ms overhead for subsequent sessions with zero risk of stale data or memory leaks.
**Action:** Always check if heavy serialization or hashing functions are repeatedly invoked on immutable/frozen domain objects, and use a `WeakMap` cached by object identity.

## 2025-05-19 - Fast presence pre-gating for RPG USE action enumeration
**Learning:** In BFS solver searches (and live game state evaluation), `enumerateRpgBaseActions` runs on every state. Previously, `projectUseAction` was called for every USE interaction in the entire pack (doing regex matching, string substitutions, and object name lookups) BEFORE checking if the interaction target was even present in the room or held in inventory. By constructing a function-scoped `Set` of present object IDs (`state.inventory` + room `visibleObjectIds`) once and pre-gating `it.target` and `it.item` presence before projecting or evaluating conditions, quest solver search time dropped by ~25-30% overall (e.g., `tide_mill` dropped from ~11.2s to ~8.1s).
**Action:** Check if action/command enumerators perform expensive string formatting and projection before cheap structural existence or presence checks.
