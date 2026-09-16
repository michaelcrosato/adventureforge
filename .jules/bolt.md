# Bolt's Journal

Critical learnings and codebase-specific performance patterns for AdventureForge.

## 2025-05-18 - WeakMap caching of worldHash for frozen OverworldManifest
**Learning:** `hashState(world)` takes ~100ms on the large overworld manifest object because canonical serialization recursively sorts keys and formats JSON. When building `OverworldSessionIndexes`, this calculation was being re-run on every session initialization. Caching the result via a module-level `WeakMap` for `Object.isFrozen(world)` instances eliminates this ~100ms overhead for subsequent sessions with zero risk of stale data or memory leaks.
**Action:** Always check if heavy serialization or hashing functions are repeatedly invoked on immutable/frozen domain objects, and use a `WeakMap` cached by object identity.

## 2025-05-19 - Zero-allocation state key fingerprinting in exhaustive solvers
**Learning:** In exhaustive BFS state exploration (`exhaustiveEndingsMulti`), `stateKey` is called on every state transition (hundreds of thousands of times per test run). Using `Object.entries(rec).filter().map().sort()` created millions of short-lived `[key, value]` tuple arrays and intermediate array transformations, placing immense pressure on V8 GC. Replacing this with direct `for...in` key collection and `Object.keys(obj).sort()` reduced test suite runtime by ~17 seconds (~7.6%).
**Action:** In hot-path state fingerprinting or deduplication functions called inside search loops, avoid `Object.entries()` and chaining `.filter().map()`; use imperative `for...in` or `Object.keys().sort()` to minimize heap allocations.
