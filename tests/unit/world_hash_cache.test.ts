/**
 * bug_0642 — the worldHash identity cache trusted a shallow freeze.
 *
 * `buildOverworldSessionIndexes` cached `hashState(world)` by object identity whenever
 * `Object.isFrozen(world)` held. That predicate answers for the top level only, so a
 * manifest frozen at the top with an edited nested field was served its stale first
 * hash. Production was safe only because `loadOverworldManifest` deep-freezes; the
 * cache now admits only manifests a loader registered as deep-frozen.
 */
import { describe, expect, it } from "vitest";
import { hashState } from "../../src/core/hash.js";
import type { OverworldManifest } from "../../src/world/overworld.js";
import {
  buildOverworldSessionIndexes,
  overworldWorldHashIsCached,
  registerDeepFrozenOverworldManifest,
} from "../../src/world/session_indices.js";
import { loadOverworldManifest } from "../../src/world/source.js";

const WORLD = loadOverworldManifest(process.cwd());

describe("bug_0642 — worldHash cache keys on registered deep-frozen manifests", () => {
  it("serves the loader's deep-frozen manifest from the cache with the true hash", () => {
    const first = buildOverworldSessionIndexes(WORLD).worldHash;
    expect(overworldWorldHashIsCached(WORLD)).toBe(true);
    expect(buildOverworldSessionIndexes(WORLD).worldHash).toBe(first);
    expect(first).toBe(hashState(WORLD));
  });

  it("never caches a top-level-only freeze, so a nested edit changes the hash", () => {
    const clone = structuredClone(WORLD) as { -readonly [K in keyof OverworldManifest]: unknown };
    const shallow = Object.freeze(clone) as unknown as OverworldManifest;
    expect(Object.isFrozen(shallow)).toBe(true);
    expect(Object.isFrozen(shallow.areas)).toBe(false);

    const before = buildOverworldSessionIndexes(shallow).worldHash;
    expect(before).toBe(hashState(WORLD));
    expect(overworldWorldHashIsCached(shallow)).toBe(false);

    const area = shallow.areas[0] as { name: string };
    area.name = `${area.name} (edited)`;
    const after = buildOverworldSessionIndexes(shallow).worldHash;
    expect(after).toBe(hashState(shallow));
    expect(after).not.toBe(before);
    expect(overworldWorldHashIsCached(shallow)).toBe(false);
  });

  it("refuses to register a manifest that is not frozen at all", () => {
    const unfrozen = structuredClone(WORLD);
    expect(() => registerDeepFrozenOverworldManifest(unfrozen)).toThrow(/deep-frozen/);
    buildOverworldSessionIndexes(unfrozen);
    expect(overworldWorldHashIsCached(unfrozen)).toBe(false);
  });
});
