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
  try {
    return JSON.stringify(sortDeep(value));
  } catch (error) {
    if (error instanceof RejectedValue) throw error.toTypeError();
    throw error;
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
  // A plain object literal, a JSON.parse result or an Object.create(null) record cannot
  // be any rejected kind: `instanceof K` is true only when K.prototype is on the
  // prototype chain, and the chain of such an object is [Object.prototype] or []. This is
  // exactly the answer the loop below gives, reached without six `instanceof` walks on
  // nearly every node of a state. It reads the prototype, never `value.constructor`: an
  // OWN `constructor` key is ordinary data (a Map can carry `constructor: Object`), so a
  // constructor test would wave that Map through as `{}` — the bug_0607 collision again.
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return null;
  for (const [name, test] of REJECTED_OBJECT_KINDS) if (test(value)) return name;
  return null;
}

/**
 * A rejected value found during `sortDeep`, carrying the path back to the root.
 *
 * The error message names where the value sits (`vars.seen`, `$[1]`). Building that path
 * string on the way DOWN cost a template-literal allocation at every node of every state
 * hashed, to serve an error that essentially never happens. Instead each level records
 * its own step (a key or an index) only while this unwinds, and `toTypeError` replays the
 * steps through the exact formula the eager version used — including its quirks, such as
 * a top-level key spelled `$` or `""` — so the message is byte-identical.
 */
class RejectedValue extends Error {
  /** Innermost step first: the order the stack unwinds in. */
  readonly steps: (string | number)[] = [];

  constructor(readonly kind: string) {
    super(kind);
  }

  toTypeError(): TypeError {
    let path = "$";
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const step = this.steps[i]!;
      path =
        typeof step === "number" ? `${path}[${step}]` : path === "$" ? step : `${path}.${step}`;
    }
    return new TypeError(
      `canonicalize: a ${this.kind} at ${path} has no JSON-visible keys and would collapse to "{}"; convert it to a plain object or array first (bug_0607).`,
    );
  }
}

/**
 * The prototype of every object `sortDeep` builds: frozen, empty, and itself
 * null-prototype. What serialization can observe of an accumulator is its own keys plus
 * whatever its chain answers to `toJSON` and to a property write, and this chain answers
 * nothing — exactly like the `Object.create(null)` accumulator it replaces: no
 * `__proto__` setter to swallow a key, and no polluted `Object.prototype` `toJSON` or
 * setter that could reach the canonical form. The difference is V8's: an
 * `Object.create(null)` object is born in dictionary mode (a hash table), so every key
 * insert and the whole JSON.stringify pass took the slow path. An object with an
 * ordinary prototype is a fast-mode object, and that alone is about a third of the time
 * `canonicalize` spends on a realistic state (scripts/bench-engine-hot-paths.ts).
 */
const ACCUMULATOR_PROTOTYPE: object = Object.freeze(Object.create(null) as object);

function sortDeep(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    // `map`, not a counted loop: it keeps an Array subclass's species (and so a subclass
    // `toJSON`) and skips holes exactly as the canonical form always has.
    return value.map((item: unknown, index) => {
      try {
        return sortDeep(item);
      } catch (error) {
        if (error instanceof RejectedValue) error.steps.push(index);
        throw error;
      }
    });
  }
  const kind = rejectedObjectKind(value);
  if (kind !== null) throw new RejectedValue(kind);
  const obj = value as Record<string, unknown>;
  // An accumulator with NO Object.prototype on its chain (see ACCUMULATOR_PROTOTYPE) so a
  // key literally named "__proto__" is stored as an own data property. With a normal
  // `{}`, `out["__proto__"] = v` hits Object's
  // `__proto__` SETTER: a primitive v is silently dropped, and an object v re-points
  // the accumulator's prototype instead of becoming a key — JSON.stringify then omits
  // it either way. That would canonicalize a state carrying a "__proto__" key to a
  // string COLLIDING with the same state lacking it, breaking the §8.6 "equal hash ⇒
  // equal state" invariant (and the save-integrity check that rests on it). Such a key
  // is reachable off the untrusted-save boundary (JSON.parse makes "__proto__" an own
  // enumerable property — the load-integrity threat model, cf. bug_0190). Normal states
  // carry no such key, so every existing hash is byte-identical.
  const out = Object.create(ACCUMULATOR_PROTOTYPE) as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length > 1) keys.sort();
  for (const key of keys) {
    try {
      out[key] = sortDeep(obj[key]);
    } catch (error) {
      if (error instanceof RejectedValue) error.steps.push(key);
      throw error;
    }
  }
  return out;
}

/** Full SHA-256 hex of the canonical form — used for save integrity. */
export function hashState(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/** First 8 hex chars — used in logs and traces (§8.3, §8.6). */
export function shortHash(value: unknown): string {
  return hashState(value).slice(0, 8);
}
