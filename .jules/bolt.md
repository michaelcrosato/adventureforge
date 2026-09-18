# Bolt's Journal

Critical learnings and codebase-specific performance patterns for AdventureForge.

## 2025-05-18 - WeakMap caching of worldHash for frozen OverworldManifest
**Learning:** `hashState(world)` takes ~100ms on the large overworld manifest object because canonical serialization recursively sorts keys and formats JSON. When building `OverworldSessionIndexes`, this calculation was being re-run on every session initialization. Caching the result via a module-level `WeakMap` for `Object.isFrozen(world)` instances eliminates this ~100ms overhead for subsequent sessions with zero risk of stale data or memory leaks.
**Action:** Always check if heavy serialization or hashing functions are repeatedly invoked on immutable/frozen domain objects, and use a `WeakMap` cached by object identity.

## 2025-05-18 - O(1) resolution check for blocked action enumeration
**Learning:** `enumerateRpgBlockedActions` previously called `enumerateRpgBaseActions(index, state)` to collect all legal action options in the room before filtering blocked USE affordances. In RPG observation generation, constructing all legal base actions (exits, objects, inventory, dialogues) solely to check if a specific USE action was legal incurred significant unnecessary CPU overhead. Checking `useInteraction(index, target, item, state) !== undefined` directly provides an O(1) test for USE interaction legibility.
**Action:** Avoid full legal action set enumeration when checking legibility of specific known interaction types; prefer direct targeted resolver queries.
