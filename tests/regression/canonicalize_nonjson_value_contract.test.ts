import { describe, it, expect } from "vitest";
import { canonicalize, hashState } from "../../src/core/hash.js";

/**
 * bug_0230 — the non-JSON-safe value contract for the canonicalizer
 * (src/core/hash.ts), the determinism-keystone leg the bug_0228 RNG
 * known-answer-vector cycle named as the last open small key-free lever.
 *
 * `hashState` rests entirely on `canonicalize(value) = JSON.stringify(sortDeep(value))`.
 * The existing coverage (tests/unit/hash_rng.test.ts) pins only the JSON-SAFE happy
 * path: key-order insensitivity, array-order sensitivity, recursive sort, shortHash
 * slicing. It says NOTHING about the values JSON.stringify treats specially —
 * undefined, functions, NaN/±Infinity, BigInt — even though those are exactly the
 * values that decide whether two distinct-looking GameStates COLLIDE to one hash or
 * the canonicalizer THROWS. This is load-bearing on the untrusted-input boundary:
 * tests/regression/trace_load_integrity.test.ts generates a fixture that loads
 * `vars.hp: 1e999` (= Infinity) straight off disk into a GameState that gets hashed
 * (the bug_0181/0190 load-integrity arc), and a
 * non-finite var silently collapses to the same hash as `null`. Pinning these is the
 * SoundnessBench absolute-witness discipline (parity with bug_0228's RNG KAT and the
 * bug_0182/0218/0227 negative corpus): the contract is FROZEN, so any future change to
 * the canonicalizer (a replacer that preserves Infinity, BigInt support, a uniform-null
 * serializer) becomes a CONSCIOUS, surfaced decision that re-pins every dependent trace
 * hash — never a silent hash-discontinuity that invalidates pinned traces with no
 * attributable cause.
 *
 * NOT a discovered defect: `canonicalize` is correct today. These are the missing
 * absolute witnesses for already-correct code. Frozen vectors verified against the
 * live module before committing.
 */

// SHA-256 of the empty string — the famous, portable known-answer vector. The
// canonicalizer maps a non-serializable TOP-LEVEL value (undefined / a function) to a
// bare `undefined`, which sha256Hex coerces to the empty string before hashing.
const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("canonicalize — non-JSON-safe value contract (bug_0230)", () => {
  it("a non-serializable TOP-LEVEL value yields the bare `undefined` (not a string)", () => {
    // JSON.stringify(undefined) and JSON.stringify(fn) both return the value `undefined`.
    expect(canonicalize(undefined)).toBeUndefined();
    expect(typeof canonicalize(undefined)).toBe("undefined");
    expect(canonicalize(() => {})).toBeUndefined();
  });

  it('non-finite numbers serialize to the string "null"', () => {
    expect(canonicalize(NaN)).toBe("null");
    expect(canonicalize(Infinity)).toBe("null");
    expect(canonicalize(-Infinity)).toBe("null");
  });

  it("BigInt is NOT canonicalizable — it throws (the canonicalizer is not total)", () => {
    // Pins that GameState vars must stay JSON-number-safe: a BigInt would crash the
    // hash, so supporting one is a deliberate, witnessed change, never an accident.
    expect(() => canonicalize(BigInt(10))).toThrow(TypeError);
    expect(() => canonicalize({ b: BigInt(1), a: 1 })).toThrow(TypeError);
  });

  it("OBJECT: undefined- and function-valued keys are DROPPED entirely", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalize({ f: () => {}, a: 1 })).toBe('{"a":1}');
  });

  it("OBJECT: non-finite values become null, and keys stay recursively sorted", () => {
    // Combines two contracts in one witness: the NaN→null coercion AND the
    // sort-keys-then-serialize order (b sorts after a even with a null value).
    expect(canonicalize({ b: NaN, a: 1 })).toBe('{"a":1,"b":null}');
  });

  it("ARRAY: non-serializable elements become positional null (length preserved)", () => {
    // Arrays are positional, so order is meaningful — holes become null, not dropped.
    expect(canonicalize([undefined, 1])).toBe("[null,1]");
    expect(canonicalize([NaN, Infinity])).toBe("[null,null]");
  });

  it("the OBJECT-drop vs ARRAY-null collapse modes are genuinely distinct", () => {
    // Non-vacuity guard: an undefined element collapses two different ways depending on
    // container. A future uniform-null serializer would erase this asymmetry and fail here.
    expect(canonicalize({ a: undefined })).toBe("{}");
    expect(canonicalize([undefined])).toBe("[null]");
    expect(canonicalize({ a: undefined })).not.toBe(canonicalize([undefined]));
  });
});

describe("canonicalize — the ±0 sign-of-zero collapse (bug_0240)", () => {
  // The bug_0230 family froze the non-finite numeric collapse (NaN/±Infinity → the
  // string "null"). It left ONE member of the same numeric-collapse family unpinned:
  // the sign of zero. `JSON.stringify(-0) === "0"`, so negative zero serializes
  // IDENTICALLY to positive zero and is hash-indistinguishable from it — but, unlike
  // the non-finite class, it collapses to "0", NOT to "null". A future canonicalizer
  // that preserved -0 (e.g. a replacer emitting "-0") would silently shift the digest
  // of any state holding a negative zero while every bug_0230 test stayed GREEN. This
  // pins that last numeric-collapse member, same SoundnessBench absolute-witness
  // discipline (parity with bug_0228/0230).
  it('-0 serializes to "0" — identical to +0, at every nesting depth', () => {
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(-0)).toBe(canonicalize(0));
    expect(canonicalize({ a: -0, b: 0 })).toBe('{"a":0,"b":0}');
    expect(canonicalize([-0, 0])).toBe("[0,0]");
  });

  it('the ±0 collapse is the "0" class, NOT the non-finite "null" class (non-vacuity)', () => {
    // Separates the sign-of-zero collapse from the NaN/±Infinity → null collapse: a
    // future uniform-null serializer would fail HERE by turning -0 into "null".
    expect(canonicalize(-0)).not.toBe("null");
    expect(canonicalize(-0)).not.toBe(canonicalize(NaN));
  });
});

describe("hashState — the ±0 sign-of-zero collapse witness (bug_0240)", () => {
  it("a -0 var collapses to the SAME hash as +0", () => {
    expect(hashState({ vars: { score: -0 } })).toBe(hashState({ vars: { score: 0 } }));
  });

  it("but that collapse does NOT swallow distinct finite values (non-vacuity)", () => {
    // Proves the equality above is the sign-of-zero contract, not "all numbers hash
    // the same": a real negative value hashes differently from the ±0 class.
    const hZero = hashState({ vars: { score: 0 } });
    expect(hashState({ vars: { score: -1 } })).not.toBe(hZero);
    expect(hashState({ vars: { score: 1 } })).not.toBe(hZero);
  });
});

describe("hashState — the untrusted-Infinity load-integrity witness (bug_0230)", () => {
  it("a non-finite numeric var collapses to the SAME hash as null (the bug_0190 hp:1e999 case)", () => {
    // The bug_0190 test-generated fixture loads vars.hp = 1e999 (Infinity) off disk.
    // Hashing it canonicalizes Infinity -> null, so it is hash-indistinguishable from hp:null.
    // The numeric-range VALIDATORS (the .int() gate, save-integrity) are what reject such
    // states; the hash deliberately does not, and this pins that boundary contract.
    const hNull = hashState({ vars: { hp: null } });
    expect(hashState({ vars: { hp: Infinity } })).toBe(hNull);
    expect(hashState({ vars: { hp: -Infinity } })).toBe(hNull);
    expect(hashState({ vars: { hp: NaN } })).toBe(hNull);
  });

  it("but that collapse does NOT swallow finite values (non-vacuity)", () => {
    // Proves the equality above is the Infinity→null contract, not "everything hashes
    // the same": a real finite value hashes differently from the null/Infinity class.
    const hNull = hashState({ vars: { hp: null } });
    expect(hashState({ vars: { hp: 0 } })).not.toBe(hNull);
    expect(hashState({ vars: { hp: 1 } })).not.toBe(hNull);
  });

  it("a non-serializable top-level value hashes the empty string's SHA-256 (portable KAT)", () => {
    // canonicalize(undefined) === undefined -> sha256Hex coerces to "" -> the empty-string
    // digest. A fixed, machine-independent known-answer vector.
    expect(hashState(undefined)).toBe(SHA256_EMPTY);
    expect(hashState(() => {})).toBe(SHA256_EMPTY);
  });
});

describe('canonicalize — the "__proto__" state-key collision contract (bug_0247)', () => {
  // A DISCOVERED defect (unlike the bug_0230/0240 absolute witnesses above): the
  // sortDeep accumulator used a normal `{}`, so `out["__proto__"] = v` hit Object's
  // __proto__ SETTER instead of creating a key — a primitive v was silently dropped,
  // an object v re-pointed the accumulator's prototype — and JSON.stringify then
  // omitted it either way. Two DISTINCT states then canonicalized to the SAME string,
  // colliding their hashes and breaking the §8.6 "equal hash ⇒ equal state" invariant
  // the save-integrity check rests on. A "__proto__" key is reachable off the
  // untrusted-save boundary: JSON.parse('{"__proto__":...}') makes it an OWN enumerable
  // property (the bug_0190 load-integrity threat model). Fixed with a null-prototype
  // accumulator. These witnesses fail RED against the pre-fix `{}` accumulator.

  // JSON.parse, not an object literal: a literal `{ __proto__: 5 }` sets the prototype
  // rather than a key, so we must build the inputs exactly as the untrusted boundary does.
  const withProto = JSON.parse('{"score":10,"__proto__":5}');
  const withoutProto = JSON.parse('{"score":10}');

  it('a primitive "__proto__"-valued key is PRESERVED, not dropped', () => {
    // The pre-fix code returned '{"score":10}' here (the key silently swallowed by the
    // __proto__ setter), colliding with the key-less state below.
    expect(canonicalize(withProto)).toBe('{"__proto__":5,"score":10}');
  });

  it('a state with a "__proto__" key does NOT collide with the same state lacking it', () => {
    expect(canonicalize(withProto)).not.toBe(canonicalize(withoutProto));
    expect(hashState(withProto)).not.toBe(hashState(withoutProto));
  });

  it('an OBJECT-valued "__proto__" key is preserved (no prototype pollution / drop)', () => {
    const nested = JSON.parse('{"score":1,"__proto__":{"polluted":true}}');
    // Pre-fix: '{"score":1}' — the object value re-pointed the accumulator's prototype.
    expect(canonicalize(nested)).toBe('{"__proto__":{"polluted":true},"score":1}');
    // And the live runtime prototype is never touched (the canonicalizer pollutes nothing).
    expect(Object.prototype.hasOwnProperty.call({}, "polluted")).toBe(false);
  });

  it('a NESTED "__proto__" key (the GameState vars/flags shape) is preserved too', () => {
    const a = JSON.parse('{"vars":{"score":10}}');
    const b = JSON.parse('{"vars":{"score":10,"__proto__":5}}');
    expect(canonicalize(b)).toBe('{"vars":{"__proto__":5,"score":10}}');
    expect(hashState(a)).not.toBe(hashState(b));
  });

  it("normal states without a __proto__ key hash byte-identically (no churn)", () => {
    // The null-prototype accumulator changes NOTHING for ordinary states: key-sort,
    // recursive sort and array-order are unaffected. Frozen so the fix carries no
    // collateral hash discontinuity for any real pack/save/trace.
    expect(canonicalize({ b: 2, a: 1, c: { z: 1, a: 2 } })).toBe('{"a":1,"b":2,"c":{"a":2,"z":1}}');
    expect(canonicalize({ constructor: 9, score: 1 })).toBe('{"constructor":9,"score":1}');
  });
});

describe("canonicalize — non-plain collections are REJECTED, never collapsed to `{}` (bug_0607)", () => {
  // `Object.keys` of a Map, Set, Date or RegExp is empty, so before bug_0607 every one
  // of them canonicalized to the string "{}" — the same string as the empty object —
  // and two states differing only inside such a value hashed IDENTICALLY. The
  // canonicalizer is not total (it already throws on BigInt); these join that class.
  it.each([
    ["Map", new Map([["a", 1]])],
    ["Set", new Set([1, 2])],
    ["Date", new Date(0)],
    ["RegExp", /x/],
    ["WeakMap", new WeakMap()],
    ["WeakSet", new WeakSet()],
  ])("a top-level %s throws instead of canonicalizing to `{}`", (_name, value) => {
    expect(() => canonicalize(value)).toThrow(/canonicalize/);
  });

  it("the error names the key path of the offending value when it is nested", () => {
    expect(() => canonicalize({ vars: { seen: new Set([1]) } })).toThrow(/vars\.seen/);
  });

  it("an offending element inside an array is caught and its index named", () => {
    expect(() => canonicalize([{}, new Map()])).toThrow(/\[1\]/);
  });

  it("plain objects, null-prototype objects and arrays are unaffected (non-vacuity)", () => {
    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { z: 0 });
    expect(canonicalize({ b: 1, a: [nullProto] })).toBe('{"a":[{"z":0}],"b":1}');
  });

  it("hashState refuses a Set-bearing state rather than returning the empty-object hash", () => {
    expect(() => hashState({ s: new Set([1]) })).toThrow(/canonicalize/);
    expect(canonicalize({ s: {} })).toBe('{"s":{}}');
  });
});

describe("canonicalize — the fast paths change no byte and no error (bug_0607, Bolt #376/#378/#379/#387)", () => {
  // The canonicalizer skips its rejected-kind walk for plain and null-prototype objects,
  // records an error's key path only while unwinding, and builds its sorted copies on a
  // frozen null-prototype prototype instead of Object.create(null). None of that may move
  // a byte of output or a character of an error. Every expected value below was frozen
  // from the implementation that preceded those changes.
  const rejected = (kind: string, path: string): string =>
    `canonicalize: a ${kind} at ${path} has no JSON-visible keys and would collapse to "{}"; convert it to a plain object or array first (bug_0607).`;

  it("an OWN `constructor` key is data: a Map stored under it is still rejected", () => {
    expect(() => canonicalize({ constructor: new Map([["a", 1]]) })).toThrow(
      rejected("Map", "constructor"),
    );
  });

  it("a Map carrying an own `constructor: Object` is still a Map (the constructor-check hole)", () => {
    // A fast path keyed on `value.constructor === Object` would wave this through as "{}".
    const disguised = Object.assign(new Map([["a", 1]]), { constructor: Object });
    expect(() => canonicalize(disguised)).toThrow(rejected("Map", "$"));
    expect(() => canonicalize({ s: { t: disguised } })).toThrow(rejected("Map", "s.t"));
    class SubMap extends Map {}
    expect(() => canonicalize({ m: new SubMap() })).toThrow(rejected("Map", "m"));
  });

  it("Object.create(null) records canonicalize exactly as before", () => {
    const record = Object.assign(Object.create(null) as Record<string, unknown>, {
      b: 1,
      a: Object.assign(Object.create(null) as Record<string, unknown>, { d: 1, c: 2 }),
    });
    expect(canonicalize(record)).toBe('{"a":{"c":2,"d":1},"b":1}');
  });

  it("class instances serialize as their own enumerable data, as before", () => {
    class Point {
      x = 1;
      a = 2;
      get g(): number {
        return 3;
      }
      toJSON(): string {
        return "never consulted: the sorted copy does not inherit it";
      }
    }
    expect(canonicalize(new Point())).toBe('{"a":2,"x":1}');
    expect(canonicalize({ p: [new Point()] })).toBe('{"p":[{"a":2,"x":1}]}');
  });

  it("arrays keep their species and holes, as before", () => {
    class Tagged extends Array<number> {
      toJSON(): string {
        return "tagged";
      }
    }
    expect(canonicalize({ s: Tagged.from([1, 2]) })).toBe('{"s":"tagged"}');
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalize([1, , 3])).toBe("[1,null,3]");
  });

  it("error paths are character-for-character unchanged, including the historical quirks", () => {
    expect(() => canonicalize([{ a: { b: [0, 1, new Date(0)] } }])).toThrow(
      rejected("Date", "$[0].a.b[2]"),
    );
    expect(() => canonicalize(new WeakMap())).toThrow(rejected("WeakMap", "$"));
    // The first offender in sorted-key depth-first order is the one named.
    expect(() => canonicalize({ b: new Set(), a: [1, new Map()] })).toThrow(
      rejected("Map", "a[1]"),
    );
    // A top-level key spelled "$" or "" was always rendered by the same formula.
    expect(() => canonicalize({ $: { x: new Map() } })).toThrow(rejected("Map", "x"));
    expect(() => canonicalize({ "": { b: new WeakSet() } })).toThrow(rejected("WeakSet", ".b"));
    const proto = JSON.parse('{"__proto__":{"k":1}}') as Record<string, Record<string, unknown>>;
    proto["__proto__"]!.k = new Map();
    expect(() => canonicalize(proto)).toThrow(rejected("Map", "__proto__.k"));
    // A rejected kind is found before JSON.stringify ever meets a sibling BigInt.
    expect(() => canonicalize({ a: BigInt(1), b: new Map() })).toThrow(rejected("Map", "b"));
  });

  it("a cyclic value still throws RangeError (there is no cycle detection to change)", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(RangeError);
    const loop: unknown[] = [];
    loop.push(loop);
    expect(() => canonicalize(loop)).toThrow(RangeError);
  });

  it("a polluted Object.prototype cannot reach the canonical form", () => {
    const proto = Object.prototype as Record<string, unknown>;
    Object.defineProperty(proto, "toJSON", {
      value: () => "polluted",
      configurable: true,
      writable: true,
    });
    Object.defineProperty(proto, "swallowed", {
      set: () => undefined,
      configurable: true,
    });
    try {
      expect(canonicalize({ b: 1, a: { swallowed: 2 } })).toBe('{"a":{"swallowed":2},"b":1}');
    } finally {
      delete proto.toJSON;
      delete proto.swallowed;
    }
  });

  it("a known-answer hash is unchanged", () => {
    expect(hashState({ b: 1, a: [1, { d: 2, c: null }] })).toBe(
      "ca51f74adb4c801453d34b2fff0ebe79c0b55517a77671a0b0c63305d1e0a48a",
    );
  });
});
