# Bolt's Journal

Critical learnings and codebase-specific performance patterns for AdventureForge.

## 2025-05-19 - Deferred error path construction in canonical object serialization (`sortDeep`)
**Learning:** `sortDeep` in `src/core/hash.ts` was allocating path strings (`${path}.${key}`) on every node visit solely for formatting exception messages if a non-plain collection (e.g. Map, Set, Date) was found. Deferring string path construction until a rejected object kind is actually encountered eliminated ~27% of time spent during state canonicalization/hashing across thousands of state nodes.
**Action:** In recursive AST or object graph traversal functions, never allocate path tracking strings in the hot path unless required for the output; defer error context generation to an error handler or lazy path finder.

## 2025-05-18 - WeakMap caching of worldHash for frozen OverworldManifest
**Learning:** `hashState(world)` takes ~100ms on the large overworld manifest object because canonical serialization recursively sorts keys and formats JSON. When building `OverworldSessionIndexes`, this calculation was being re-run on every session initialization. Caching the result via a module-level `WeakMap` for `Object.isFrozen(world)` instances eliminates this ~100ms overhead for subsequent sessions with zero risk of stale data or memory leaks.
**Action:** Always check if heavy serialization or hashing functions are repeatedly invoked on immutable/frozen domain objects, and use a `WeakMap` cached by object identity.
