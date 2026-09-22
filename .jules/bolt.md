# Bolt's Journal

Critical learnings and codebase-specific performance patterns for AdventureForge.

## 2025-05-18 - WeakMap caching of worldHash for frozen OverworldManifest
**Learning:** `hashState(world)` takes ~100ms on the large overworld manifest object because canonical serialization recursively sorts keys and formats JSON. When building `OverworldSessionIndexes`, this calculation was being re-run on every session initialization. Caching the result via a module-level `WeakMap` for `Object.isFrozen(world)` instances eliminates this ~100ms overhead for subsequent sessions with zero risk of stale data or memory leaks.
**Action:** Always check if heavy serialization or hashing functions are repeatedly invoked on immutable/frozen domain objects, and use a `WeakMap` cached by object identity.

## 2025-05-24 - Avoid redundant Zod parsing in hot campaign consequence loops
**Learning:** `campaignCharacterMatchesConditions` and `deriveCampaignWorldFactIds` were calling `CampaignCharacterConditionsSchema.parse` and `CampaignConsequenceEffectsSchema.parse` on every invocation. During overworld integrity checking (`assertOverworldIntegrity`), these functions are executed tens of thousands of times across reachability states. Eliminating redundant Zod schema parsing on already-typed objects reduced `assertOverworldIntegrity` runtime from ~18.0s to ~11.3s (~35% speedup / 6.7s saved per call).
**Action:** Do not re-parse objects with Zod schemas inside inner evaluation loops when inputs are already validated and strongly typed.
