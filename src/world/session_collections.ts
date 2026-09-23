import { OVERWORLD_COMPACT_ID_LIST_LIMIT, type OverworldCompactIdBucket } from "./compact_view.js";
import { compareCaseFoldedCodeUnits, compareCodeUnits } from "./string_order.js";

const EMPTY_INDEX_LIST: readonly never[] = [];

export function sortedStringSet(values: ReadonlySet<string>): string[] {
  return [...values].sort();
}

/** Deterministic serialization of a map of string sets: both levels sorted, so the
 *  snapshot hash cannot depend on insertion order. */
export function sortedStringSetMap(
  values: ReadonlyMap<string, ReadonlySet<string>>,
): [string, string[]][] {
  return [...values.entries()]
    .filter(([, members]) => members.size > 0)
    .map(([key, members]): [string, string[]] => [key, [...members].sort()])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function sortedStringMap(values: ReadonlyMap<string, string>): [string, string][] {
  return [...values.entries()].sort(([left], [right]) => compareCodeUnits(left, right));
}

export function sortedNumberMap(values: ReadonlyMap<string, number>): [string, number][] {
  return [...values.entries()].sort(([left], [right]) => compareCodeUnits(left, right));
}

export function sortedNumberRecord(values: ReadonlyMap<string, number>): Record<string, number> {
  const record: Record<string, number> = {};
  const keys = [...values.keys()].sort();
  for (const key of keys) record[key] = values.get(key)!;
  return record;
}

function compareStringId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function insertBoundedSorted<T>(
  target: T[],
  value: T,
  limit: number,
  compare: (left: T, right: T) => number,
): void {
  let index = 0;
  while (index < target.length && compare(target[index]!, value) <= 0) index += 1;
  if (index >= limit) return;
  target.splice(index, 0, value);
  if (target.length > limit) target.pop();
}

export function compactSortedStringSet(values: ReadonlySet<string>): OverworldCompactIdBucket {
  const ids: string[] = [];
  for (const value of values) {
    insertBoundedSorted(ids, value, OVERWORLD_COMPACT_ID_LIST_LIMIT, compareStringId);
  }
  return { ids, count: values.size };
}

export function compactSortedTownIdsByPopulation<
  T extends { id: string; name: string; population_2025: number },
>(ids: ReadonlySet<string>, townsById: ReadonlyMap<string, T>): string[] {
  const towns: T[] = [];
  for (const id of ids) {
    const town = townsById.get(id);
    if (town) {
      insertBoundedSorted(
        towns,
        town,
        OVERWORLD_COMPACT_ID_LIST_LIMIT,
        compareTownByPopulationThenName,
      );
    }
  }

  const compactIds: string[] = [];
  for (const town of towns) compactIds.push(town.id);
  return compactIds;
}

export function compareTownByPopulationThenName(
  left: { name: string; population_2025: number },
  right: { name: string; population_2025: number },
): number {
  return (
    right.population_2025 - left.population_2025 ||
    compareCaseFoldedCodeUnits(left.name, right.name)
  );
}

export function assertUnique(label: string, values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value))
      throw new Error(`Overworld session snapshot has duplicate ${label} "${value}".`);
    seen.add(value);
  }
  return seen;
}

export function assertKnownIds(
  label: string,
  values: readonly string[],
  known: ReadonlySet<string>,
): Set<string> {
  const seen = assertUnique(label, values);
  for (const value of seen) {
    if (!known.has(value))
      throw new Error(`Overworld session snapshot has unknown ${label} "${value}".`);
  }
  return seen;
}

export function assertUniqueTupleMap<T>(
  label: string,
  values: readonly (readonly [string, T])[],
): Map<string, T> {
  const seen = new Map<string, T>();
  for (const [key, value] of values) {
    if (seen.has(key))
      throw new Error(`Overworld session snapshot has duplicate ${label} "${key}".`);
    seen.set(key, value);
  }
  return seen;
}

export function indexedList<T>(
  index: ReadonlyMap<string, readonly T[]>,
  key: string,
): readonly T[] {
  return index.get(key) ?? EMPTY_INDEX_LIST;
}

export function replaceStringSet(target: Set<string>, values: readonly string[]): void {
  target.clear();
  for (const value of values) target.add(value);
}

export function pushIndexed<T>(index: Map<string, T[]>, key: string, value: T): void {
  const values = index.get(key);
  if (values) {
    values.push(value);
    return;
  }
  index.set(key, [value]);
}

export function sortedIndex<T>(
  values: readonly T[],
  keyFor: (value: T) => string,
  compare: (a: T, b: T) => number,
): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const value of values) pushIndexed(index, keyFor(value), value);
  for (const indexed of index.values()) indexed.sort(compare);
  return index;
}

export function keyedIndex<T>(values: readonly T[], keyFor: (value: T) => string): Map<string, T> {
  const index = new Map<string, T>();
  for (const value of values) index.set(keyFor(value), value);
  return index;
}

export function idIndex<T extends { id: string }>(values: readonly T[]): Map<string, T> {
  return keyedIndex(values, (value) => value.id);
}

export function nestedIdIndex<T extends { id: string }>(
  source: ReadonlyMap<string, readonly T[]>,
): Map<string, Map<string, T>> {
  const index = new Map<string, Map<string, T>>();
  for (const [ownerId, values] of source) {
    const ownerIndex = new Map<string, T>();
    for (const value of values) ownerIndex.set(value.id, value);
    index.set(ownerId, ownerIndex);
  }
  return index;
}
