/**
 * Feedback location normalization.
 *
 * Crawler findings and fleet blind-tester reports both describe a "location"
 * as free text (a room title, an area name, whatever the reporting persona
 * called it). Hotspot clustering needs a single canonical identity per real
 * place so two reports of the same spot merge instead of forking. This module
 * builds a compile-time index over the overworld manifest and every shipped
 * quest pack, then resolves free text against it through a conservative
 * ladder that would rather stay `unmapped` than guess wrong.
 *
 * Resolution ladder (each rung tried in order; a rung "hits" only when it
 * finds exactly one candidate location — a tie falls through to the next
 * rung, never forcing a pick):
 *   1. exact id hit — raw equals a questId / node id / region id / room|scene
 *      id (case-insensitive, trimmed).
 *  1b. embedded id hit — raw QUOTES one such id rather than being it, whether
 *      inside a sentence or merely wrapped in punctuation (backticks, quotes,
 *      parentheses, a trailing full stop). Restricted to ids containing an
 *      underscore, because a one-word id cannot be told apart from the
 *      ordinary English word. Candidates that are only coarser views of
 *      another candidate (a quest named alongside its own room) are dropped
 *      before the single-candidate test, so naming a place and its container
 *      in one breath resolves instead of reading as a tie.
 *   2. exact name hit — a node/region/area name or quest/room title, each
 *      punctuation-normalized (lowercased; every run of non-alphanumeric
 *      characters collapsed to a single space; trimmed), appears as a
 *      literal substring of raw normalized the same way. Punctuation
 *      normalization means two titles that differ only in punctuation (e.g.
 *      "The Gate-Arch" vs "The Gate Arch") produce the identical phrase — a
 *      raw that hits that phrase then hits every location registered under
 *      it, and a tie across distinct locations falls through rather than
 *      silently crediting whichever one happened to be indexed first. A hit
 *      whose every occurrence sits INSIDE a strictly longer hit's occurrence
 *      is dropped before the tie is counted (longest match wins), so a place
 *      whose name properly contains a shorter place's name still resolves to
 *      itself rather than reading as a permanent two-candidate tie.
 *   3. unique contiguous fuzzy hit — strip a small fixed stopword set ("the",
 *      "a", "an", "of", "in", "on", "at", "to", "and") from both the
 *      candidate's normalized tokens and raw's normalized tokens. A candidate
 *      left with fewer than 2 content tokens is ineligible for this rung —
 *      too short to disambiguate safely, so it's skipped rather than risking
 *      a match on a single common word. Otherwise the candidate hits iff its
 *      content-token sequence appears CONTIGUOUSLY, in the same order,
 *      inside raw's content-token sequence — tolerant of a little connective
 *      noise around the name, never of its words scattered loose across an
 *      unrelated sentence. The same longest-match preference as rung 2
 *      applies to the surviving candidates.
 *   4. otherwise: `unmapped`, raw preserved for audit.
 */
import { listShippedQuestIds, prepareShippedQuest } from "../crawl/prepare.js";
import { loadOverworldManifest } from "../world/source.js";
import type { CanonicalLocation } from "./schema.js";

/** A resolved location shape without the caller-supplied raw text attached yet. */
type LocationTemplate = Omit<CanonicalLocation, "raw">;

/**
 * Minimal stopword set for rung 3's contiguous fuzzy match. Deliberately small —
 * only articles/prepositions/conjunctions common enough to appear incidentally
 * between a location name's content words in freeform reports. A bigger list would
 * risk stripping enough of a real name to make it collide with something else,
 * which is exactly what the "never force" mandate rules out.
 */
const RUNG3_STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "at",
  "to",
  "and",
]);

type NameCandidate = {
  /** Punctuation-normalized literal name/title text — used for the rung-2 substring test. */
  phrase: string;
  /** `phrase` split into tokens — used to locate the rung-2 hit's span inside raw. */
  phraseTokens: readonly string[];
  /**
   * `phrase`'s tokens with the rung-3 stopword set stripped — used for the rung-3
   * contiguous match. Fewer than 2 entries makes the candidate ineligible for rung 3.
   */
  contentTokens: readonly string[];
  location: LocationTemplate;
};

export type LocationIndex = {
  /** Lowercased id -> every candidate location registered under that id. */
  readonly ids: ReadonlyMap<string, readonly LocationTemplate[]>;
  /** Every name/title candidate across regions, nodes, areas, quests, and rooms. */
  readonly names: readonly NameCandidate[];
};

const UNMAPPED_TEMPLATE: LocationTemplate = {
  kind: "unmapped",
  questId: null,
  region: null,
  node: null,
  sceneId: null,
};

/**
 * A report about the game rather than about a place.
 *
 * Distinct from `unmapped`, which means "this text named nothing I recognise". `global`
 * means the opposite problem: the text named SEVERAL things I recognise, because the
 * player was citing examples of a pattern rather than pointing at one location.
 */
const GLOBAL_TEMPLATE: LocationTemplate = {
  kind: "global",
  questId: null,
  region: null,
  node: null,
  sceneId: null,
};

function tokenize(lowerText: string): string[] {
  return lowerText.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

/**
 * Lowercases, collapses every run of non-alphanumeric characters to a single space,
 * and trims. Used for both indexed name/title phrases and query-time raw text so
 * punctuation-only differences (a hyphen vs a space, an apostrophe, etc.) can't cause
 * two spellings of the same name to fail to collide at rung 2/3, nor a genuinely
 * different name to dodge the tie-detection that keeps those rungs from forcing a pick.
 * Deliberately separate from the id lookup's normalization, which preserves the raw
 * string (including underscores) since ids are matched verbatim.
 */
function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stripStopwords(tokens: readonly string[]): string[] {
  return tokens.filter((token) => !RUNG3_STOPWORDS.has(token));
}

/**
 * True iff `phrase` appears inside `normalizedRaw` aligned to token
 * boundaries — not merely as a raw character run that happens to sit inside
 * a longer word (e.g. "store" must not match inside "restore"). Both
 * arguments are assumed already run through `normalizePhrase` (lowercased,
 * every run of non-alphanumeric characters collapsed to a single space,
 * trimmed — so no leading/trailing/doubled spaces). Padding both sides with
 * a single space turns "phrase sits at the very start/end of raw" and
 * "phrase sits between two other tokens" into the same `includes` check.
 * Exported for direct testing — no shipped location name is currently a single
 * token short enough to trigger the old bug against real content, so a
 * regression test has to target this helper directly rather than the compiled
 * index.
 */
export function matchesAtTokenBoundary(normalizedRaw: string, phrase: string): boolean {
  if (phrase.length === 0) return false;
  return ` ${normalizedRaw} `.includes(` ${phrase} `);
}

/** Half-open `[start, end)` range of token indexes covered by one phrase occurrence. */
type PhraseSpan = { readonly start: number; readonly end: number };

/**
 * Every place `needle` appears as a contiguous, in-order run inside `haystack`,
 * as token-index spans. Spans rather than a bare boolean because the rungs need
 * to know WHERE a name matched, not just that it did — see `preferLongestMatches`.
 */
function contiguousSpans(haystack: readonly string[], needle: readonly string[]): PhraseSpan[] {
  const spans: PhraseSpan[] = [];
  if (needle.length === 0 || needle.length > haystack.length) return spans;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    let matched = true;
    for (let i = 0; i < needle.length; i++) {
      if (haystack[start + i] !== needle[i]) {
        matched = false;
        break;
      }
    }
    if (matched) spans.push({ start, end: start + needle.length });
  }
  return spans;
}

/** One candidate location plus every span of raw its name matched at. */
type PhraseMatch = { location: LocationTemplate; spans: readonly PhraseSpan[] };

/**
 * Longest-match preference: drop a candidate whose every occurrence sits INSIDE a
 * strictly longer candidate's occurrence.
 *
 * Without this, any location whose human-facing name properly contains a shorter
 * location's name is permanently unresolvable from its own exact name. Real example:
 * "North Hempstead town" (node `north_hempstead_town`) also contains the whole name of
 * "Hempstead town" (node `hempstead_town`), so both hit at rung 2, the ladder reads a
 * two-candidate tie, and the report lands `unmapped` — keyed on its own raw wording,
 * where clustering can never corroborate it. 51 of 783 shipped named locations failed
 * to resolve from the exact name the game shows the player.
 *
 * It stays a redundancy rule, not a tiebreaker, because eclipsing is judged per
 * occurrence: a raw that mentions "Hempstead Town" somewhere the longer name does NOT
 * cover keeps both candidates and still refuses to force a pick. Two rivals of equal
 * length never eclipse each other either, so "The Gate Arch" in two quest packs stays
 * ambiguous exactly as before.
 */
function preferLongestMatches(matches: readonly PhraseMatch[]): LocationTemplate[] {
  const eclipsed = (span: PhraseSpan, match: PhraseMatch): boolean =>
    matches.some(
      (other) =>
        other !== match &&
        other.spans.some(
          (candidate) =>
            candidate.end - candidate.start > span.end - span.start &&
            candidate.start <= span.start &&
            span.end <= candidate.end,
        ),
    );
  return matches
    .filter((match) => match.spans.some((span) => !eclipsed(span, match)))
    .map((match) => match.location);
}

/** Builds the location index once, compiling every shipped quest pack. Cache the result. */
export function buildLocationIndex(root: string): LocationIndex {
  const overworld = loadOverworldManifest(root);
  const ids = new Map<string, LocationTemplate[]>();
  const names: NameCandidate[] = [];

  const addId = (rawId: string, location: LocationTemplate): void => {
    const key = rawId.trim().toLowerCase();
    if (key.length === 0) return;
    const existing = ids.get(key);
    if (existing) existing.push(location);
    else ids.set(key, [location]);
  };

  const addName = (rawName: string, location: LocationTemplate): void => {
    const phrase = normalizePhrase(rawName);
    if (phrase.length === 0) return;
    const phraseTokens = tokenize(phrase);
    names.push({
      phrase,
      phraseTokens,
      contentTokens: stripStopwords(phraseTokens),
      location,
    });
  };

  const regionNameByNodeId = new Map<string, string>();
  for (const node of overworld.nodes) {
    regionNameByNodeId.set(node.id, node.region);
  }

  for (const region of overworld.regions) {
    const location: LocationTemplate = {
      kind: "overworld",
      questId: null,
      region: region.name,
      node: null,
      sceneId: null,
    };
    addId(region.id, location);
    addName(region.name, location);
  }

  for (const node of overworld.nodes) {
    const location: LocationTemplate = {
      kind: "overworld",
      questId: null,
      region: node.region,
      node: node.id,
      sceneId: null,
    };
    addId(node.id, location);
    addName(node.name, location);
  }

  for (const area of overworld.areas) {
    const location: LocationTemplate = {
      kind: "overworld",
      questId: null,
      region: regionNameByNodeId.get(area.home) ?? null,
      node: area.home,
      sceneId: null,
    };
    addId(area.id, location);
    addName(area.name, location);
  }

  for (const quest of overworld.quests) {
    const location: LocationTemplate = {
      kind: "quest",
      questId: quest.id,
      region: null,
      node: null,
      sceneId: null,
    };
    addId(quest.id, location);
    addName(quest.title, location);
  }

  for (const questId of listShippedQuestIds(root)) {
    const prepared = prepareShippedQuest(root, questId);
    for (const room of prepared.index.rooms.values()) {
      const location: LocationTemplate = {
        kind: "quest",
        questId,
        region: null,
        node: null,
        sceneId: room.id,
      };
      addId(room.id, location);
      addName(room.name, location);
    }
  }

  return { ids, names };
}

function locationTemplateKey(location: LocationTemplate): string {
  return JSON.stringify([
    location.kind,
    location.questId,
    location.region,
    location.node,
    location.sceneId,
  ]);
}

/**
 * Is `ancestor` the same place as `descendant`, only described more coarsely?
 *
 * True when every field `ancestor` DOES pin matches `descendant`, and `ancestor` leaves
 * at least one further field unpinned. So `quest wolf_winter` is a strict ancestor of
 * `quest wolf_winter / room steading_yard`, while two different rooms of one quest — or
 * the same room id under two different quests — are not related at all.
 *
 * This exists so that citing a place and its container in one breath is not mistaken for
 * ambiguity. "room steading_yard in quest wolf_winter" names ONE location twice at two
 * zoom levels; a ladder that counts those as two rival candidates refuses a match it
 * should have made.
 */
function isStrictAncestor(ancestor: LocationTemplate, descendant: LocationTemplate): boolean {
  if (ancestor.kind !== descendant.kind) return false;
  let coarser = false;
  for (const field of ["questId", "region", "node", "sceneId"] as const) {
    const pinned = ancestor[field];
    if (pinned === null) {
      if (descendant[field] !== null) coarser = true;
      continue;
    }
    if (pinned !== descendant[field]) return false;
  }
  return coarser;
}

/**
 * Drop candidates that are only coarser views of another candidate, keeping the most
 * specific reading of each distinct place.
 *
 * Deliberately NOT a tiebreaker: it removes redundancy, never rivalry. Two genuinely
 * different places both survive, so a caller that requires a single candidate still
 * refuses to force a match — the property the whole ladder is built on.
 */
function narrowToMostSpecific(candidates: readonly LocationTemplate[]): LocationTemplate[] {
  return candidates.filter(
    (candidate) => !candidates.some((other) => isStrictAncestor(candidate, other)),
  );
}

/** Distinct locations by shape — duplicate registrations of the identical location collapse. */
function uniqueLocations(locations: readonly LocationTemplate[]): LocationTemplate[] {
  const byKey = new Map<string, LocationTemplate>();
  for (const location of locations) {
    byKey.set(locationTemplateKey(location), location);
  }
  return [...byKey.values()];
}

/**
 * Resolves free-text `raw` against the index via the conservative ladder
 * described above. Never forces a match: any step that lands on more than one
 * distinct candidate location falls through to the next step, and running
 * out of steps yields `unmapped` with `raw` preserved.
 */
/**
 * Whether `raw` names two or more DIFFERENT known places at non-overlapping positions.
 *
 * Both qualifiers carry weight. "Different" excludes a name that is merely a fragment of
 * another name — the reason `preferLongestMatches` exists — and "non-overlapping" is what
 * separates "The Cold Forge and The Breaking Weir" (two places, two spans) from a single
 * title that happens to contain a shorter title inside it (one place, one span).
 *
 * Deliberately NOT a threshold on how many names appear: two is already a pattern being
 * illustrated, and asking for three would file the commonest shape of this report — "X
 * through Y" — under one of its own examples.
 *
 * KNOWN BLIND SPOT, kept rather than papered over. The fuzzy arm inherits rung 3's
 * `contentTokens.length >= 2` bar, so a place whose whole name is one content word cannot
 * be counted unless the player spells it exactly as indexed. A real corpus report — "Overall
 * regional quest chain (Gallowmere through Dawn Beacon)" — therefore still resolves to
 * `dawn_beacon` alone, because "the gallowmere" is one content token. Lowering that bar
 * would let an ordinary English word that happens to be a place name drag genuinely
 * location-specific reports into `global`, which is the OVER-merge direction and the one
 * that hides defects. Under-merging leaves a finding as a singleton, which is the failure
 * we already have and can see.
 */
/**
 * Coarser than `locationTemplateKey`: a scene and the quest containing it are ONE place.
 *
 * Counting template rows instead would read "The Gallowmere — specifically the Gallowmere
 * hollow" as two places and call a single-location report global, which is the over-merge
 * direction. What makes a report cross-cutting is naming places that are not each other,
 * not naming one place at two zoom levels.
 */
function placeKey(location: LocationTemplate): string {
  return location.questId ?? location.node ?? location.region ?? location.kind;
}

function citesSeveralPlaces(raw: string, idx: LocationIndex): boolean {
  const normalizedRaw = normalizePhrase(raw);
  if (normalizedRaw.length === 0) return false;
  const rawTokens = tokenize(normalizedRaw);
  const contentTokens = stripStopwords(rawTokens);
  const hits: { key: string; span: PhraseSpan }[] = [];
  for (const candidate of idx.names) {
    // Exact first, then rung 3's fuzzy content-token match. Both are needed, and the
    // second is the one that earns its keep: the index stores titles WITH their article
    // ("the wolf winter"), while players write "Wolf-Winter", so an exact-only count sees
    // one place in "Wolf-Winter through The Factor's Mark" and files a finding about every
    // quest under whichever example the player happened to capitalise.
    let span: PhraseSpan | undefined;
    if (matchesAtTokenBoundary(normalizedRaw, candidate.phrase)) {
      span = contiguousSpans(rawTokens, candidate.phraseTokens)[0];
    }
    if (span === undefined && candidate.contentTokens.length >= 2) {
      span = contiguousSpans(contentTokens, candidate.contentTokens)[0];
    }
    if (span === undefined) continue;
    hits.push({ key: placeKey(candidate.location), span });
  }
  if (hits.length < 2) return false;
  // Earliest span first, longest first on a tie, so a containing title is considered
  // before the shorter one it swallows and the shorter one is then rejected as
  // overlapping rather than counted as a second place.
  //
  // Exact and fuzzy spans index different token arrays (raw tokens vs stopword-stripped
  // ones), so the overlap test is approximate across the two arms. It is deliberately the
  // CONSERVATIVE approximation: a false overlap suppresses a second place and leaves the
  // report where it already was, while the alternative would invent one.
  hits.sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end);
  const takenKeys = new Set<string>();
  const takenSpans: PhraseSpan[] = [];
  for (const hit of hits) {
    if (takenKeys.has(hit.key)) continue;
    if (takenSpans.some((span) => hit.span.start < span.end && span.start < hit.span.end)) continue;
    takenKeys.add(hit.key);
    takenSpans.push(hit.span);
    if (takenKeys.size >= 2) return true;
  }
  return false;
}

export function canonicalizeLocation(raw: string, idx: LocationIndex): CanonicalLocation {
  const finalize = (location: LocationTemplate): CanonicalLocation => ({
    ...location,
    raw: [raw],
  });

  // Rung 1: exact id hit. Ids are matched verbatim (trim + lowercase only — no
  // punctuation normalization, since ids like "gate_arch" rely on their underscores).
  const idKey = raw.trim().toLowerCase();
  if (idKey.length > 0) {
    const idCandidates = uniqueLocations(idx.ids.get(idKey) ?? []);
    if (idCandidates.length === 1) return finalize(idCandidates[0]!);

    // Rung 1b: a known id quoted INSIDE a sentence.
    //
    // Rung 1 only fires when the whole field IS the id, and rungs 2-3 match human-facing
    // NAMES — while `normalizePhrase` collapses "steading_yard" to "steading yard", so an
    // id never matches a name phrase either. That left a gap exactly where the reports
    // come from: the MCP surface hands models ids, not titles, so a model writes "room
    // steading_yard, blocked exit north" and every such report landed `unmapped`, keyed
    // on its own raw wording. Four reports of one defect became four locations, and since
    // clustering never merges across locations, corroboration could not accumulate.
    //
    // Two guards keep this from pinning prose to a place it merely mentions:
    //
    // - Only ids carrying an underscore count. A single-word id is indistinguishable
    //   from the English word — "armory" is a room id AND a noun — so a bare word stays
    //   unmapped, while "steading_yard" is unmistakably a machine id being quoted.
    // - Only a raw that is MORE than the bare id reaches this rung. A raw that IS just
    //   an id is rung 1's alone, so an id that resolves to rival places ("new_york_city"
    //   is both a region and a node) keeps its ambiguous verdict instead of being
    //   narrowed here.
    //
    // That second guard is "more than the bare id", NOT "more than one token": an id
    // wrapped in punctuation — `steading_yard` in markdown backticks, in quotes, in
    // parentheses, or trailing a full stop, which is how a model quotes a machine id —
    // splits into exactly ONE token, so a plain `length > 1` test skipped it while rung
    // 1 had already missed it (its lookup key still carries the punctuation). Comparing
    // the lone token against `idKey` is what tells "the raw IS the id" apart from "the
    // raw merely decorates it": 54 of the 1032 underscore-bearing ids resolved bare and
    // fell to `unmapped` in every quoted spelling.
    //
    // Ids are matched on whole tokens (every id in the index is `[a-z0-9_]+`), so
    // "steading_yard" never hits inside "steading_yard_north". Two distinct places still
    // refuse to resolve; only a place cited alongside its own container collapses.
    const rawTokens = idKey.split(/[^a-z0-9_]+/).filter((token) => token.length > 0);
    const rawIsBareId = rawTokens.length === 1 && rawTokens[0] === idKey;
    if (rawTokens.length > 0 && !rawIsBareId) {
      const embedded: LocationTemplate[] = [];
      for (const token of new Set(rawTokens)) {
        if (!token.includes("_")) continue;
        embedded.push(...(idx.ids.get(token) ?? []));
      }
      const embeddedCandidates = narrowToMostSpecific(uniqueLocations(embedded));
      if (embeddedCandidates.length === 1) return finalize(embeddedCandidates[0]!);
    }
  }

  // Scope rung: a `where` that cites SEVERAL known places is not a location, it is a
  // pattern illustrated by examples — "quest structure, Wolf-Winter through The Factor's
  // Mark", "Gallowmere through Dawn Beacon". Those belong together as one finding about
  // the game, and they must not be filed under whichever example happened to win.
  //
  // This rung has to run BEFORE rungs 2-3 because `preferLongestMatches` is what destroys
  // the evidence: given two quests named in one sentence it keeps the longer match and
  // returns a single confident candidate, so by the time rung 2 answers, "named two
  // quests" is indistinguishable from "named one". Measured on real reports — the two
  // corpus reports of identical quest skeletons resolved to `factors_mark` and
  // `dawn_beacon`, two different single quests, and so could never corroborate each other
  // however many players agreed.
  //
  // It runs AFTER the id rungs above deliberately: an exact machine id is a caller
  // pointing at one place on purpose, and no count of incidental prose names should
  // override it.
  if (citesSeveralPlaces(raw, idx)) return finalize(GLOBAL_TEMPLATE);

  const normalizedRaw = normalizePhrase(raw);
  if (normalizedRaw.length > 0) {
    // Rung 2: exact name hit, both sides punctuation-normalized (see normalizePhrase)
    // and token-boundary-aligned (see matchesAtTokenBoundary) so a short name never
    // matches mid-word inside an unrelated longer word. Surviving hits then go through
    // the longest-match preference, so a name that is only a fragment of a longer name
    // matched at the same place in raw stops counting as a rival.
    const rawNameTokens = tokenize(normalizedRaw);
    const nameHits = idx.names.filter((candidate) =>
      matchesAtTokenBoundary(normalizedRaw, candidate.phrase),
    );
    const nameCandidates = uniqueLocations(
      preferLongestMatches(
        nameHits.map((hit) => ({
          location: hit.location,
          spans: contiguousSpans(rawNameTokens, hit.phraseTokens),
        })),
      ),
    );
    if (nameCandidates.length === 1) return finalize(nameCandidates[0]!);

    // Rung 3: unique contiguous fuzzy hit over stopword-stripped content tokens, under
    // the same longest-match preference as rung 2.
    const rawContentTokens = stripStopwords(rawNameTokens);
    if (rawContentTokens.length > 0) {
      const fuzzyHits: PhraseMatch[] = [];
      for (const candidate of idx.names) {
        if (candidate.contentTokens.length < 2) continue;
        const spans = contiguousSpans(rawContentTokens, candidate.contentTokens);
        if (spans.length > 0) fuzzyHits.push({ location: candidate.location, spans });
      }
      const fuzzyCandidates = uniqueLocations(preferLongestMatches(fuzzyHits));
      if (fuzzyCandidates.length === 1) return finalize(fuzzyCandidates[0]!);
    }
  }

  return finalize(UNMAPPED_TEMPLATE);
}
