# Bolt's Journal

Critical learnings and codebase-specific performance patterns for AdventureForge.

## 2025-05-19 - Fast state fingerprinting in exhaustive search solver
**Learning:** `stateKey(s)` is called millions of times during BFS state space traversal in `src/solve/exhaustive_endings.ts`. Using `Object.entries` creates temporary `[key, value]` tuple arrays for every property in `flags`, `visited`, `vars`, `objectState`, and `questStage`. Replacing `Object.entries` with `Object.keys` and skipping `.sort()` when `length <= 1` speeds up `stateKey` computation by ~15-20% with zero change in fingerprint string formatting.
**Action:** When fingerprinting or hashing state objects in hot search loops, iterate keys directly via `Object.keys` rather than `Object.entries` to avoid tuple allocations, and guard `.sort()` calls on arrays with `length > 1`.

## 2025-05-18 - WeakMap caching of worldHash for frozen OverworldManifest
**Learning:** `hashState(world)` takes ~100ms on the large overworld manifest object because canonical serialization recursively sorts keys and formats JSON. When building `OverworldSessionIndexes`, this calculation was being re-run on every session initialization. Caching the result via a module-level `WeakMap` for `Object.isFrozen(world)` instances eliminates this ~100ms overhead for subsequent sessions with zero risk of stale data or memory leaks.
**Action:** Always check if heavy serialization or hashing functions are repeatedly invoked on immutable/frozen domain objects, and use a `WeakMap` cached by object identity.
