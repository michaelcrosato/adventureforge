/**
 * Pure crawl oracles — no engine stepping, no I/O.
 *
 * `textDefect` / `renderDefects` catch content that RENDERS wrong (an unresolved
 * template marker, a literal "undefined"/"[object Object]"/"NaN" leaking into
 * player-facing prose, or an empty string). `sampleIllegalAction` synthesizes an
 * action that is deterministically NOT in the current legal set, for the
 * negative-legality probe in the quest crawler's stepping loop.
 */
import type { RpgAction } from "../api/types.js";
import type { GameEvent } from "../core/events.js";
import type { Rng } from "../core/rng.js";
import type { GameState } from "../core/state.js";
import type { RpgActionOption } from "../rpg/legal_actions.js";
import { buildRpgObservation } from "../rpg/observation.js";
import type { RpgIndex } from "../rpg/runner.js";

const UNDEFINED_WORD = /\bundefined\b/;
const OBJECT_OBJECT = /\[object Object\]/;
const NAN_WORD = /\bNaN\b/;
const UNRESOLVED_TEMPLATE = /\{\{|\}\}|\$\{/;

/** Returns a defect description or null. Pure string check — no engine access. */
function textDefect(text: string): string | null {
  if (text.trim().length === 0) return "empty or whitespace-only text";
  if (UNDEFINED_WORD.test(text))
    return `text contains a literal "undefined": ${JSON.stringify(text)}`;
  if (OBJECT_OBJECT.test(text))
    return `text contains a literal "[object Object]": ${JSON.stringify(text)}`;
  if (NAN_WORD.test(text)) return `text contains a literal "NaN": ${JSON.stringify(text)}`;
  if (UNRESOLVED_TEMPLATE.test(text))
    return `text contains an unresolved template marker: ${JSON.stringify(text)}`;
  return null;
}

/**
 * Scan everything the current step just made player-visible, then every
 * `narration` event's text. Never throws on content defects (those become
 * messages); a THROW out of this function (e.g. the observation builder itself
 * blowing up) is the caller's CRASH oracle to catch.
 *
 * The oracle used to check only title/description/ending text, which left the
 * whole reactive surface unwatched: a broken template in a `locked_msg`, an
 * object `variants[].name`, a dialogue node, a pressure band label, or a skill
 * check's `stakes` renders straight to the player and is never emitted as a
 * narration event, so nothing else in the pipeline could see it either — the
 * schemas only require `min(1)` strings. Every field below is text a player
 * reads. Prefixes are per-site so the finding fingerprint
 * (`src/crawl/findings.ts`) dedupes each site independently; the original four
 * prefixes are unchanged so existing fingerprints still match.
 *
 * Deliberately NOT scanned: `state.journal` (it only grows, so re-scanning the
 * whole log every step is quadratic in a long crawl, and journal prose is
 * written by effects that narrate the same text), `inventory` and `state.flags`
 * (ids, not prose), and `exits[].direction` (compass tokens).
 */
export function renderDefects(index: RpgIndex, state: GameState, events: GameEvent[]): string[] {
  const messages: string[] = [];
  // `available_actions` costs a second base-action enumeration, but `command` and
  // `skill_check.stakes` are only reachable through it and are read by every player.
  const obs = buildRpgObservation(index, state, { includeAvailableActions: true });
  const check = (label: string, text: string): void => {
    const defect = textDefect(text);
    if (defect) messages.push(`${label}: ${defect}`);
  };

  check("observation title", obs.title);
  check("observation description", obs.description);

  if (obs.ending) check("ending text", obs.ending.text);

  for (const object of obs.visible_objects) check(`visible object ${object.id} name`, object.name);
  for (const npc of obs.npcs_present) check(`npc ${npc.id} name`, npc.name);
  for (const enemy of obs.enemies_present) check(`enemy ${enemy.id} name`, enemy.name);

  for (const exit of obs.blocked_exits)
    check(`blocked exit ${exit.direction} message`, exit.message);
  for (const blocked of obs.blocked_actions)
    check(`blocked action ${blocked.id} reason`, blocked.reason);

  if (obs.dialogue) check(`dialogue ${obs.dialogue.npc} text`, obs.dialogue.npc_text);

  for (const track of obs.pressure_tracks ?? []) {
    check(`pressure track ${track.id} title`, track.title);
    check(`pressure track ${track.id} band label`, track.band.label);
    // Band descriptions are optional in the schema; an absent one is not a defect,
    // but a present-and-broken one is.
    if (track.band.description !== undefined)
      check(`pressure track ${track.id} band description`, track.band.description);
    // The next-band preview renders alongside the current one, so a defect there is
    // visible a band earlier than the band itself would reveal it.
    if (track.next) {
      check(`pressure track ${track.id} next band label`, track.next.label);
      if (track.next.description !== undefined)
        check(`pressure track ${track.id} next band description`, track.next.description);
    }
  }

  for (const option of obs.available_actions) {
    check(`available action ${option.id} command`, option.command);
    if (option.skill_check?.stakes !== undefined)
      check(`available action ${option.id} skill check stakes`, option.skill_check.stakes);
  }

  for (const event of events) {
    if (event.type === "narration") check("narration event", event.text);
  }

  return messages;
}

const COMPASS_DIRECTIONS = [
  "north",
  "south",
  "east",
  "west",
  "up",
  "down",
  "in",
  "out",
  "northeast",
  "northwest",
  "southeast",
  "southwest",
] as const;

/**
 * Deterministically synthesize an action NOT in the legal set, for the
 * negative-legality probe (a listed-illegal action must be rejected cleanly,
 * never silently accepted or thrown). Draws uniformly from EVERY illegal
 * candidate the current state affords, across three families: an unlisted MOVE
 * direction, a TAKE of an item that is not currently offered or held, and —
 * only while mid-dialogue — an ASK of a topic id no live topic uses. Returns
 * null only when none of the three can be built at all.
 *
 * This used to be an ordered fallback chain (MOVE first, TAKE only if every
 * compass direction was already legal, ASK only if that failed too). No shipped
 * room has all twelve directions legal at once, so the later legs were
 * unreachable for real content and the oracle only ever probed movement
 * rejection — never a TAKE of an absent object, never a dead dialogue topic,
 * which is exactly where a resolver is likelier to accept something it should
 * not. Pooling the candidates and picking once fixes the coverage without
 * costing determinism, and deliberately keeps the rng draw to EXACTLY ONE
 * `rng.int` per call, as the old first-branch-wins shape did in practice: this
 * generator shares its `Rng` with the crawl's action policy, so any change in
 * how many values it consumes would shift every subsequent policy pick and
 * silently re-route the whole crawl. The ASK sentinel is therefore derived by
 * lengthening a fixed prefix until it is unused, not by drawing a random suffix.
 */
export function sampleIllegalAction(
  index: RpgIndex,
  state: GameState,
  legal: RpgActionOption[],
  rng: Rng,
): RpgAction | null {
  const legalMoveDirections = new Set<string>();
  const legalTakeItems = new Set<string>();
  let dialogueNpc: string | null = null;
  const legalAskTopics = new Set<string>();
  for (const option of legal) {
    const { action } = option;
    if (action.type === "MOVE") legalMoveDirections.add(action.direction);
    else if (action.type === "TAKE") legalTakeItems.add(action.item);
    else if (action.type === "ASK") {
      dialogueNpc = action.npc;
      legalAskTopics.add(action.topic);
    }
  }

  const candidates: RpgAction[] = [];
  for (const direction of COMPASS_DIRECTIONS) {
    if (!legalMoveDirections.has(direction)) candidates.push({ type: "MOVE", direction });
  }
  for (const item of index.objects.keys()) {
    if (!legalTakeItems.has(item) && !state.inventory.includes(item)) {
      candidates.push({ type: "TAKE", item });
    }
  }
  if (dialogueNpc !== null) {
    let topic = "__illegal_topic";
    while (legalAskTopics.has(topic)) topic += "_";
    candidates.push({ type: "ASK", npc: dialogueNpc, topic });
  }

  if (candidates.length === 0) return null;
  return candidates[rng.int(0, candidates.length - 1)]!;
}
