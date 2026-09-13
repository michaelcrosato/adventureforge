/**
 * Canonical serialization + state hash (spec §8.6).
 *
 * Two states with identical hashes are identical games. To make this true on any
 * machine and any run, we serialize with object keys SORTED recursively (arrays
 * keep their order, since list order is semantically meaningful — e.g. inventory
 * and the event log). JSON key order, map/set iteration order, etc. must never
 * leak into the hash (§8.5).
 */
import { sha256Hex } from "./sha256.js";

/** Deterministic JSON: object keys sorted; arrays preserved; no whitespace. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/**
 * Value kinds whose `Object.keys` is empty although they carry state. Before bug_0607
 * each canonicalized to the string "{}" — the same string as the empty object — so two
 * states differing only inside a Map, Set or Date hashed IDENTICALLY and the "equal
 * hash ⇒ equal state" invariant (§8.6) failed silently. The canonicalizer is not total
 * (it already throws on BigInt); these join that class rather than gaining a
 * serialization, because a hash that depends on how a Map is flattened is a new
 * contract and no engine state carries one on purpose.
 */
const REJECTED_OBJECT_KINDS: ReadonlyArray<readonly [string, (value: object) => boolean]> = [
  ["Map", (value) => value instanceof Map],
  ["Set", (value) => value instanceof Set],
  ["WeakMap", (value) => value instanceof WeakMap],
  ["WeakSet", (value) => value instanceof WeakSet],
  ["Date", (value) => value instanceof Date],
  ["RegExp", (value) => value instanceof RegExp],
];

function rejectedObjectKind(value: object): string | null {
  for (const [name, test] of REJECTED_OBJECT_KINDS) if (test(value)) return name;
  return null;
}

function findPathAndThrow(root: unknown, target: object, kind: string): never {
  function find(val: unknown, currentPath: string): string | null {
    if (val === target) return currentPath;
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        const res = find(val[i], `${currentPath}[${i}]`);
        if (res) return res;
      }
    } else if (val !== null && typeof val === "object") {
      const keys = Object.keys(val as Record<string, unknown>).sort();
      for (const k of keys) {
        const res = find(
          (val as Record<string, unknown>)[k],
          currentPath === "$" ? k : `${currentPath}.${k}`,
        );
        if (res) return res;
      }
    }
    return null;
  }
  const path = find(root, "$") ?? "$";
  throw new TypeError(
    `canonicalize: a ${kind} at ${path} has no JSON-visible keys and would collapse to "{}"; convert it to a plain object or array first (bug_0607).`,
  );
}

/**
 * Recursively clone and sort object keys for deterministic canonical serialization.
 *
 * Performance optimization:
 * Eliminate path string allocations (`${path}[${index}]` / `${path}.${key}`) on every node
 * during normal traversal. Path formatting is deferred to `findPathAndThrow` if a rejected
 * object kind (e.g. Map, Set, Date) is encountered. Plain objects (`ctor === Object`) and
 * null-prototype objects (`ctor === undefined`) skip the `rejectedObjectKind` checks.
 */
function sortDeep(value: unknown, root?: unknown): unknown {
  const top = root ?? value;
  if (Array.isArray(value)) {
    return value.map((item) => sortDeep(item, top));
  }
  if (value !== null && typeof value === "object") {
    const ctor = (value as { constructor?: unknown }).constructor;
    if (ctor !== Object && ctor !== undefined) {
      const kind = rejectedObjectKind(value);
      if (kind !== null) {
        findPathAndThrow(top, value, kind);
      }
    }
    const obj = value as Record<string, unknown>;
    // A NULL-PROTOTYPE accumulator so a key literally named "__proto__" is stored as
    // an own data property. With a normal `{}`, `out["__proto__"] = v` hits Object's
    // `__proto__` SETTER: a primitive v is silently dropped, and an object v re-points
    // the accumulator's prototype instead of becoming a key — JSON.stringify then omits
    // it either way. That would canonicalize a state carrying a "__proto__" key to a
    // string COLLIDING with the same state lacking it, breaking the §8.6 "equal hash ⇒
    // equal state" invariant (and the save-integrity check that rests on it). Such a key
    // is reachable off the untrusted-save boundary (JSON.parse makes "__proto__" an own
    // enumerable property — the load-integrity threat model, cf. bug_0190). Normal states
    // carry no such key, so every existing hash is byte-identical.
    const out = Object.create(null) as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length > 1) {
      keys.sort();
    }
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      out[key] = sortDeep(obj[key], top);
    }
    return out;
  }
  return value;
}

/** Full SHA-256 hex of the canonical form — used for save integrity. */
export function hashState(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/** First 8 hex chars — used in logs and traces (§8.3, §8.6). */
export function shortHash(value: unknown): string {
  return hashState(value).slice(0, 8);
}
