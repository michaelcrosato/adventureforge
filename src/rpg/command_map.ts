/**
 * Controlled command mapper (spec §9.3) — the human input side of the RPG engine.
 *
 * This is a *controlled* verb/object mapper, NOT open natural language: it maps
 * a small set of command shapes (`look`, `go north`, `take rope`, `open chest`,
 * `unlock chest with brass key`, `use rope on old well`, `talk to sexton`,
 * `ask about crypt`, `inventory`) to the same structured `Action` the AI uses.
 * The legal-action set is the ground truth either way — an unrecognized or
 * illegal command yields a friendly message, never a state change.
 */
import type { RpgAction } from "../api/types.js";
import type { GameState } from "../core/state.js";
import {
  normalizeRpgTopicCommand,
  parseQualifiedRpgAskCommand,
  parseRpgTalkCommand,
} from "./command_normalization.js";
import {
  type RpgModelIndex,
  activeDialogue,
  npcsInRoom,
  objectName,
  visibleObjectIds,
} from "./model.js";
import { enumerateRpgBaseActions, useInteraction } from "./legal_actions.js";
import { projectRpgPlayerCommands } from "./player_command_projection.js";

type ParseResult = { ok: true; action: RpgAction } | { ok: false; reason: string };

const DIRECTIONS: Record<string, string> = {
  north: "north",
  n: "north",
  south: "south",
  s: "south",
  east: "east",
  e: "east",
  west: "west",
  w: "west",
  up: "up",
  u: "up",
  down: "down",
  d: "down",
};

const stripArticle = (s: string): string => s.replace(/^\s*(the|a|an)\s+/i, "").trim();
const normalizeEntitySelector = (value: string): string =>
  stripArticle(normalizeRpgTopicCommand(value));

/** Build a lowercase alias → object-id map from the pack (names + aliases). */
function aliasMap(index: RpgModelIndex): Map<string, string> {
  const m = new Map<string, string>();
  for (const o of index.objects.values()) {
    for (const key of [o.name.toLowerCase(), ...o.aliases.map((a) => a.toLowerCase())]) {
      if (!m.has(key)) m.set(key, o.id);
    }
  }
  return m;
}

/** Resolve a noun phrase to an object id: exact alias/name first, then a unique
 *  alias that appears as a substring of the phrase. */
function resolveObject(index: RpgModelIndex, phrase: string): string | null {
  const norm = stripArticle(phrase).toLowerCase().trim();
  if (!norm) return null;
  const map = aliasMap(index);
  if (map.has(norm)) return map.get(norm)!;
  const hits = new Set<string>();
  for (const [alias, id] of map) {
    if (norm === alias || norm.includes(alias)) hits.add(id);
  }
  return hits.size === 1 ? [...hits][0]! : null;
}

/** Connecting prepositions accepted in a natural two-noun custom-verb command
 *  ("tie rope TO well", "lever slab WITH bar"). The template only drives DISPLAY;
 *  the mapper resolves the two nouns order-independently, so it accepts whichever
 *  natural preposition the player reaches for. */
const USE_PREPS = ["on", "with", "to", "into", "onto", "under", "against", "in", "through"];

/** Resolve a custom USE verb ("drink the phial", "tie rope to well", "lever slab
 *  with bar"): if `verb` is the `command_verb` of a USE interaction, map the rest of
 *  the command to that interaction's USE action. Two shapes are accepted:
 *   - self-USE ("drink phial"): a single noun naming a self-targeted (item === target)
 *     interaction whose command_verb is `verb`;
 *   - item-on-target ("tie rope to well", "lever slab"): two nouns joined by any
 *     preposition matching the interaction's {item, target} in EITHER order, or a
 *     single noun that uniquely names one side of exactly one such interaction.
 *  The schema guarantees `command_verb` never shadows a builtin verb, so this is only
 *  consulted for otherwise-unknown verbs. Legality (held / present) is re-checked by
 *  the engine, exactly as for the generic "use <obj>" / "use <item> on <obj>" paths. */
function customUseByVerb(index: RpgModelIndex, verb: string, rest: string): RpgAction | null {
  // Every USE interaction in the pack whose natural verb is `verb`.
  const matches: { item?: string; target: string }[] = [];
  for (const o of index.objectsWithUseInteractions) {
    for (const it of o.interactions) {
      if (it.verb === "USE" && it.command_verb === verb && it.target) {
        const hit = { target: it.target, ...(it.item !== undefined ? { item: it.item } : {}) };
        if (!matches.some((m) => m.target === hit.target && m.item === hit.item)) {
          matches.push(hit);
        }
      }
    }
  }
  if (matches.length === 0) return null;

  // Two-noun form: "<a> <prep> <b>" — resolve both nouns and match the interaction's
  // {item, target} in either order (display word order is a presentation choice, not
  // a constraint on what the player may type).
  const prep = USE_PREPS.map((p) => `(?:${p})`).join("|");
  const m = rest.match(new RegExp(`^(.*?)\\s+(?:${prep})\\s+(.*)$`));
  if (m) {
    const a = resolveObject(index, m[1]!);
    const b = resolveObject(index, m[2]!);
    if (!a || !b) return null;
    const hit = matches.find(
      (i) =>
        i.item !== undefined &&
        ((i.item === a && i.target === b) || (i.item === b && i.target === a)),
    );
    return hit ? { type: "USE", item: hit.item as string, target: hit.target } : null;
  }

  // Single-noun form: "<verb> <noun>" — the noun names one side of exactly one such
  // interaction (covers self-USE "drink phial" and a tool-less "lever slab").
  const solo = resolveObject(index, rest);
  if (!solo) return null;
  const hits = matches.filter((i) => i.item === solo || i.target === solo);
  if (hits.length !== 1) return null;
  const hit = hits[0]!;
  return hit.item === undefined
    ? { type: "USE", target: hit.target }
    : { type: "USE", item: hit.item, target: hit.target };
}

type VisibleNpcResolution =
  | { kind: "resolved"; id: string; name: string }
  | { kind: "ambiguous" }
  | { kind: "unmatched" };

/** Resolve a dialogue qualifier only against people the player can currently see.
 * Exact ids/names win; partial names are accepted only when exactly one visible
 * person matches. */
function resolveVisibleNpc(
  index: RpgModelIndex,
  state: GameState,
  phrase: string,
): VisibleNpcResolution {
  const norm = normalizeEntitySelector(phrase);
  if (!norm) return { kind: "unmatched" };
  const visible = npcsInRoom(index, state, state.current);
  const exact = visible.filter(
    (npc) => normalizeEntitySelector(npc.id) === norm || normalizeEntitySelector(npc.name) === norm,
  );
  if (exact.length === 1) {
    return { kind: "resolved", id: exact[0]!.id, name: exact[0]!.name };
  }
  if (exact.length > 1) return { kind: "ambiguous" };
  const partial = visible.filter(
    (npc) =>
      normalizeEntitySelector(npc.id).includes(norm) ||
      normalizeEntitySelector(npc.name).includes(norm),
  );
  if (partial.length === 1) {
    return { kind: "resolved", id: partial[0]!.id, name: partial[0]!.name };
  }
  return partial.length > 1 ? { kind: "ambiguous" } : { kind: "unmatched" };
}

type VisibleLookCandidate =
  | { kind: "object"; id: string }
  | { kind: "npc"; id: string; name: string };

type VisibleLookResolution =
  | { kind: "resolved"; candidate: VisibleLookCandidate }
  | { kind: "ambiguous" }
  | { kind: "unmatched" };

/** Resolve LOOK across the visible object and NPC namespaces together. Exact
 * selectors win before the controlled parser's legacy noun-phrase affordance
 * is tried in both directions: "spear" may abbreviate "Albany relief spear",
 * while "my relief spear" may contain the authored "relief spear" alias. Each
 * entity contributes at most one candidate regardless of how many of its
 * selectors match; candidates from different namespaces remain distinct and
 * therefore fail closed within the same matching tier. */
function resolveVisibleLookTarget(
  index: RpgModelIndex,
  state: GameState,
  phrase: string,
): VisibleLookResolution {
  const norm = normalizeEntitySelector(phrase);
  if (!norm) return { kind: "unmatched" };

  const entries: Array<{ candidate: VisibleLookCandidate; names: string[] }> = [];
  const objectIds = new Set([...visibleObjectIds(index, state, state.current), ...state.inventory]);
  for (const id of objectIds) {
    const object = index.objects.get(id);
    if (!object) continue;
    entries.push({
      candidate: { kind: "object", id },
      names: [object.id, object.name, objectName(object, state), ...object.aliases].map((name) =>
        normalizeEntitySelector(name),
      ),
    });
  }
  for (const npc of npcsInRoom(index, state, state.current)) {
    entries.push({
      candidate: { kind: "npc", id: npc.id, name: npc.name },
      names: [npc.id, npc.name].map(normalizeEntitySelector),
    });
  }

  const exact = entries
    .filter((entry) => entry.names.some((name) => name === norm))
    .map((entry) => entry.candidate);
  if (exact.length === 1) return { kind: "resolved", candidate: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous" };

  const partial = entries
    .filter((entry) => entry.names.some((name) => name.includes(norm) || norm.includes(name)))
    .map((entry) => entry.candidate);
  if (partial.length === 1) return { kind: "resolved", candidate: partial[0]! };
  return partial.length > 1 ? { kind: "ambiguous" } : { kind: "unmatched" };
}

function lookParseResult(index: RpgModelIndex, state: GameState, phrase: string): ParseResult {
  const resolved = resolveVisibleLookTarget(index, state, phrase);
  if (resolved.kind === "resolved") {
    return resolved.candidate.kind === "npc"
      ? { ok: true, action: { type: "LOOK", npc: resolved.candidate.id } }
      : { ok: true, action: { type: "LOOK", target: resolved.candidate.id } };
  }
  return resolved.kind === "ambiguous"
    ? {
        ok: false,
        reason: `"${phrase}" matches more than one visible object or person. Use an exact command from \`actions\`.`,
      }
    : { ok: false, reason: `You don't see "${phrase}" here.` };
}

function activeDialogueTalkFailure(
  index: RpgModelIndex,
  state: GameState,
  speaker: string,
): ParseResult | null {
  const active = activeDialogue(index, state);
  if (!active) return null;
  const requested = resolveVisibleNpc(index, state, speaker);
  if (requested.kind === "ambiguous") {
    return {
      ok: false,
      reason: `"${speaker}" matches more than one person here. Use a full name.`,
    };
  }
  const commands = projectRpgPlayerCommands(enumerateRpgBaseActions(index, state), {
    index,
    state,
  })
    .filter(({ option }) => option.action.type === "ASK" && option.action.npc === active.npc.id)
    .map(({ command }) => `\`${command}\``);
  const continueWith =
    commands.length > 0
      ? ` Continue that exchange with ${commands.join(" or ")}.`
      : " Continue that exchange first.";
  if (requested.kind === "resolved" && requested.id !== active.npc.id) {
    return {
      ok: false,
      reason: `You are speaking with ${active.npc.name}, not ${requested.name}.${continueWith}`,
    };
  }
  return {
    ok: false,
    reason: `You are already speaking with ${active.npc.name}.${continueWith}`,
  };
}

function currentCustomUseVerbs(index: RpgModelIndex, state: GameState): string[] {
  const verbs = enumerateRpgBaseActions(index, state)
    .filter((option) => option.action.type === "USE")
    .map((option) => option.command.trim().toLowerCase().split(/\s+/, 1)[0]!)
    .filter((verb) => verb !== "use");
  return [...new Set(verbs)].sort();
}

const notUnderstood = (index: RpgModelIndex, state: GameState, raw: string): ParseResult => {
  const customUseVerbs = currentCustomUseVerbs(index, state);
  const useHint = customUseVerbs.length
    ? `current action ${customUseVerbs.length === 1 ? "verb" : "verbs"}: ${customUseVerbs.join(", ")}`
    : "use <obj> on <obj>";
  return {
    ok: false,
    reason: `I don't understand "${raw}". Try: look, go <dir>, take/drop <obj>, open/unlock <obj>, ${useHint}, talk to <npc>, ask about <topic>, inventory.`,
  };
};

/** Parse one command line into a structured Action (or a reason it can't be). */
export function parseCommand(index: RpgModelIndex, state: GameState, raw: string): ParseResult {
  const text = raw.trim().toLowerCase();
  if (!text) return notUnderstood(index, state, raw);
  const words = text.split(/\s+/);
  const verb = words[0]!;
  const rest = words.slice(1).join(" ").trim();

  // Dialogue-specific shorthand is handled first. Ordinary commands continue
  // through the normal parser below; same-room actions preserve the exchange,
  // while leaving the scene closes it atomically before the move.
  const active = activeDialogue(index, state);
  const talkCommand = parseRpgTalkCommand(raw);
  const qualifiedAsk = parseQualifiedRpgAskCommand(raw);
  if (active && talkCommand) {
    return activeDialogueTalkFailure(index, state, talkCommand.speaker)!;
  }
  if (active && (qualifiedAsk || verb === "ask" || verb === "say" || verb === "topic")) {
    let arg = qualifiedAsk?.topic ?? rest.replace(/^about\s+/, "").trim();
    if (qualifiedAsk) {
      const qualifier = qualifiedAsk.speaker;
      const resolvedNpc = resolveVisibleNpc(index, state, qualifier);
      if (resolvedNpc.kind === "ambiguous") {
        return {
          ok: false,
          reason: `"${qualifier}" matches more than one person here. Name the active speaker exactly.`,
        };
      }
      if (resolvedNpc.kind === "unmatched") {
        return { ok: false, reason: `There's no visible person called "${qualifier}" here.` };
      }
      if (resolvedNpc.id !== active.npc.id) {
        return {
          ok: false,
          reason: `You are speaking with ${active.npc.name}, not ${resolvedNpc.name}.`,
        };
      }
      arg = qualifiedAsk.topic;
    }
    const normalizedArg = normalizeRpgTopicCommand(arg);
    const topic =
      active.node.topics.find(
        (candidate) => normalizeRpgTopicCommand(candidate.id) === normalizedArg,
      ) ??
      active.node.topics.find((t) =>
        (t.aliases ?? []).some((alias) => normalizeRpgTopicCommand(alias) === normalizedArg),
      ) ??
      active.node.topics.find(
        (candidate) =>
          normalizedArg.length > 0 &&
          normalizeRpgTopicCommand(candidate.prompt).includes(normalizedArg),
      );
    if (!topic)
      return {
        ok: false,
        reason: `No such topic. Options: ${active.node.topics.map((t) => t.id).join(", ")}.`,
      };
    return { ok: true, action: { type: "ASK", npc: active.npc.id, topic: topic.id } };
  }
  if (active && (verb === "bye" || verb === "goodbye" || verb === "leave")) {
    const bye = active.node.topics.find((t) => t.end);
    if (bye) return { ok: true, action: { type: "ASK", npc: active.npc.id, topic: bye.id } };
  }

  // Bare direction ("north", "n").
  if (DIRECTIONS[verb] && words.length === 1)
    return { ok: true, action: { type: "MOVE", direction: DIRECTIONS[verb]! } };

  switch (verb) {
    case "look":
    case "l": {
      if (rest === "" || rest === "around") return { ok: true, action: { type: "LOOK" } };
      const at = rest.replace(/^at\s+/, "");
      return lookParseResult(index, state, at);
    }
    case "examine":
    case "x":
    case "inspect": {
      return lookParseResult(index, state, rest);
    }
    case "read": {
      const id = resolveObject(index, rest);
      return id
        ? { ok: true, action: { type: "READ", target: id } }
        : { ok: false, reason: `You don't see "${rest}" here.` };
    }
    case "go":
    case "move": {
      const dir = DIRECTIONS[rest];
      return dir
        ? { ok: true, action: { type: "MOVE", direction: dir } }
        : { ok: false, reason: `Go where? (north/south/east/west/up/down)` };
    }
    case "take":
    case "get":
    case "grab": {
      const phrase = rest.replace(/^up\s+/, "");
      const id = resolveObject(index, phrase);
      return id
        ? { ok: true, action: { type: "TAKE", item: id } }
        : { ok: false, reason: `You can't take "${rest}".` };
    }
    case "drop": {
      const id = resolveObject(index, rest);
      return id
        ? { ok: true, action: { type: "DROP", item: id } }
        : { ok: false, reason: `You aren't carrying "${rest}".` };
    }
    case "open": {
      const id = resolveObject(index, rest);
      return id
        ? { ok: true, action: { type: "OPEN", target: id } }
        : { ok: false, reason: `You can't open "${rest}".` };
    }
    case "close": {
      const id = resolveObject(index, rest);
      return id
        ? { ok: true, action: { type: "CLOSE", target: id } }
        : { ok: false, reason: `You can't close "${rest}".` };
    }
    case "unlock": {
      const m = rest.match(/^(.*?)\s+with\s+(.*)$/);
      if (!m)
        return { ok: false, reason: `Unlock what with what? (e.g. "unlock chest with brass key")` };
      const target = resolveObject(index, m[1]!);
      const key = resolveObject(index, m[2]!);
      if (!target || !key) return { ok: false, reason: `Unlock what with what?` };
      return { ok: true, action: { type: "UNLOCK", target, with: key } };
    }
    case "use": {
      const m = rest.match(/^(.*?)\s+(?:on|with)\s+(.*)$/);
      if (m) {
        const item = resolveObject(index, m[1]!);
        const target = resolveObject(index, m[2]!);
        if (!item || !target) return { ok: false, reason: `Use what on what?` };
        return { ok: true, action: { type: "USE", item, target } };
      }
      // Bare "use <obj>" is a self-targeted USE — consume the thing (drink the
      // phial, eat the bread). Only accept it when the object actually carries a
      // self-interaction; otherwise the verb still needs a target, so keep the hint.
      const solo = resolveObject(index, rest);
      if (solo && useInteraction(index, solo, undefined))
        return { ok: true, action: { type: "USE", target: solo } };
      if (solo && useInteraction(index, solo, solo))
        return { ok: true, action: { type: "USE", item: solo, target: solo } };
      return { ok: false, reason: `Use what on what? (e.g. "use rope on old well")` };
    }
    case "talk": {
      // Resolve against people the player can actually SEE, never pack order. The
      // old resolver scanned the whole pack and returned the first substring hit
      // with no presence filter, so in a quest that models one character in several
      // mutually exclusive states — four NPCs sharing "Road Warden June Pike" — the
      // player read that name off the legal-action menu, typed any abbreviation of
      // it, and was told the action was unavailable: the id it resolved to belonged
      // to a June who was definitionally absent on that branch. Only the byte-exact
      // menu label worked, and only through the CLI's exact-match short-circuit.
      const phrase = rest.replace(/^to\s+/, "").trim();
      const resolved = resolveVisibleNpc(index, state, phrase);
      if (resolved.kind === "ambiguous") {
        return {
          ok: false,
          reason: `"${phrase}" matches more than one person here. Name them exactly.`,
        };
      }
      if (resolved.kind === "unmatched") {
        return { ok: false, reason: `There's no visible person called "${phrase}" here.` };
      }
      return { ok: true, action: { type: "TALK", npc: resolved.id } };
    }
    case "inventory":
    case "inv":
    case "i":
      return { ok: true, action: { type: "INVENTORY" } };
    default: {
      // An unknown verb may be a pack-declared natural verb for a USE — a self-USE
      // ("drink phial", "eat bread") or an item-on-target USE ("tie rope to well",
      // "lever slab with bar") — the prose's verb made legible to the command mapper.
      const use = customUseByVerb(index, verb, rest);
      if (use) return { ok: true, action: use };
      return notUnderstood(index, state, raw);
    }
  }
}
