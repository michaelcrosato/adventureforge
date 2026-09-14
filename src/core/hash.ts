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

/**
 * Custom error used internally during canonicalization to record path segments
 * only when an unsupported object kind is encountered. This avoids allocating
 * string path arguments at every level during normal deep traversal (~14% speedup).
 */
class CanonicalizeError extends Error {
  kind: string;
  pathSegments: string[] = [];

  constructor(kind: string) {
    super();
    this.kind = kind;
  }

  get path(): string {
    if (this.pathSegments.length === 0) return "$";
    const full = [...this.pathSegments].reverse().join("");
    if (full.startsWith("[")) return "$" + full;
    return full.startsWith(".") ? full.slice(1) : full;
  }
}

/** Deterministic JSON: object keys sorted; arrays preserved; no whitespace. */
export function canonicalize(value: unknown): string {
  try {
    return JSON.stringify(sortDeep(value));
  } catch (err) {
    if (err instanceof CanonicalizeError) {
      throw new TypeError(
        `canonicalize: a ${err.kind} at ${err.path} has no JSON-visible keys and would collapse to "{}"; convert it to a plain object or array first (bug_0607).`,
        { cause: err },
      );
    }
    throw err;
  }
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
  // Fast path: plain objects with Object or undefined constructor cannot be any rejected kind.
  const ctor = (value as { constructor?: unknown }).constructor;
  if (ctor === Object || ctor === undefined) return null;
  for (const [name, test] of REJECTED_OBJECT_KINDS) if (test(value)) return name;
  return null;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    const len = value.length;
    const out = new Array(len);
    for (let i = 0; i < len; i++) {
      try {
        out[i] = sortDeep(value[i]);
      } catch (err) {
        if (err instanceof CanonicalizeError) {
          err.pathSegments.push(`[${i}]`);
        }
        throw err;
      }
    }
    return out;
  }
  if (value !== null && typeof value === "object") {
    const kind = rejectedObjectKind(value);
    if (kind !== null) {
      throw new CanonicalizeError(kind);
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
      try {
        out[key] = sortDeep(obj[key]);
      } catch (err) {
        if (err instanceof CanonicalizeError) {
          err.pathSegments.push(`.${key}`);
        }
        throw err;
      }
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
