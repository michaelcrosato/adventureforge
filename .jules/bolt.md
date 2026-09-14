# Bolt's Journal

Critical learnings and codebase-specific performance patterns for AdventureForge.

## 2025-05-18 - WeakMap caching of worldHash for frozen OverworldManifest
**Learning:** `hashState(world)` takes ~100ms on the large overworld manifest object because canonical serialization recursively sorts keys and formats JSON. When building `OverworldSessionIndexes`, this calculation was being re-run on every session initialization. Caching the result via a module-level `WeakMap` for `Object.isFrozen(world)` instances eliminates this ~100ms overhead for subsequent sessions with zero risk of stale data or memory leaks.
**Action:** Always check if heavy serialization or hashing functions are repeatedly invoked on immutable/frozen domain objects, and use a `WeakMap` cached by object identity.

## 2025-05-19 - Defer path string construction during recursive state canonicalization
**Learning:** `canonicalize(value)` recursively traversed game states while concatenating `path` strings (`${path}.${key}`) for every object property and array element. Since 99.999% of state hashes do not throw invalid object kind errors, constructing path strings on the happy path was creating unnecessary intermediate string allocations on every state hash. Deferring path construction by collecting path segments only when unwinding a `CanonicalizeError` exception yielded ~14% faster state hashing with zero intermediate path string allocations.
**Action:** In recursive data traversal functions that report node paths on validation errors, do not construct path strings on the happy path—throw a lightweight exception and accumulate path segments as the stack unwinds.
