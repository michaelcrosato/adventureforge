# Bolt's Journal

Critical learnings and codebase-specific performance patterns for AdventureForge.

## 2025-05-18 - WeakMap caching of worldHash for frozen OverworldManifest
**Learning:** `hashState(world)` takes ~100ms on the large overworld manifest object because canonical serialization recursively sorts keys and formats JSON. When building `OverworldSessionIndexes`, this calculation was being re-run on every session initialization. Caching the result via a module-level `WeakMap` for `Object.isFrozen(world)` instances eliminates this ~100ms overhead for subsequent sessions with zero risk of stale data or memory leaks.
**Action:** Always check if heavy serialization or hashing functions are repeatedly invoked on immutable/frozen domain objects, and use a `WeakMap` cached by object identity.

## 2025-05-19 - Deferring path string allocation and fast-pathing plain objects in canonicalize()
**Learning:** `canonicalize()` recursively sorts object keys and traverses state objects. Previously, `sortDeep()` constructed string path templates (`${path}.${key}`) on every property/array traversal solely for error reporting if non-plain collections (Map, Set, Date, etc.) were found, and checked `instanceof` against 6 collection types on every object. Deferring path string formatting to a lazy re-traversal on error and fast-pathing plain objects (`value.constructor === Object || value.constructor === undefined`) speeds up canonical state serialization by ~15%.
**Action:** Avoid constructing error contextual strings or running full `instanceof` checks speculatively during recursive data traversal loops when errors are exceptional.
