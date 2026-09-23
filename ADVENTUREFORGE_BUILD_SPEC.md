# AdventureForge Build Spec

## Unified Open-World RPG Engine

This is the standing architecture contract for AdventureForge. The project is no
longer a staged text-game sampler. It is a single deterministic, text-based,
open-world RPG engine backed by a contiguous world graph. The consolidation this
document originally specified was completed on 2026-07-06 (see the dated entry in
`docs/DECISION_LOG.md`); what remains here is the settled architecture and the
rules that keep it true.

`AGENTS.md` is the operating charter. The short version is trust, but verify:
agents may change engine code, schemas, content, tooling, and docs, but every
substantive change must keep the repo green.

## The Architecture Baseline

AdventureForge converged on one architecture:

- One runtime mode: `rpg`.
- One public shipped-content source key: `world_quest_id`.
- One world AND quest registry: the New York overworld (`list_overworld`); it is
  the single world, and every shipped quest is anchored to a town and discovered
  from its local notice board.
- One player quest-start surface: in-world, from the overworld
  (`start_overworld_session_quest`). `start_world_quest(world_quest_id)` remains a
  dev/QA entry point into the RPG runtime, not a second world.
- One action loop: observe, list legal actions when needed, step by stable
  `action_id`, checkpoint by state hash.
- One contiguous world model: a single seamless open world (like Skyrim or
  Cyberpunk 2077) — no second world or game mode.

Retired variants are not implementation targets. Do not rebuild the old CYOA
engine, the old semantic-command engine, or standalone package-mode authoring
surfaces. Historical docs and traces may mention them, but active code and active
agent instructions must point at the RPG world graph.

## Architecture

The LLM is never the game engine. The engine is deterministic code; content is
validated data; agents interact only through structured APIs.

### Layer 1: World And Content Data

- `content/world/new_york_overworld.json` is the single world: the contiguous
  overworld data AND the shipped RPG quest registry (each quest maps a
  `world_quest_id` to its `content/rpg/quests/*.yaml` source).
- `content/rpg/quests/*.yaml` holds RPG quest packs registered through the
  overworld quest registry.
- Raw pack paths are edit metadata, not public play or validation sources.

### Layer 2: Deterministic Engine

- `src/core` owns pure state, effects, hashing, and deterministic transitions.
- `src/rpg` owns RPG schema, rules, observations, legal actions, and reducers.
- `src/world` owns world source loading, routes, and overworld sessions.
- `src/persist` owns save/load integrity.
- `src/trace` owns record/replay.
- `src/validate` owns validators and reports.

The reducer must be deterministic: same content, seed, save, and action sequence
produce the same state hash.

### Layer 3: Agent And Tool Surfaces

- `src/mcp/server.ts` owns the registered public MCP tool names, descriptions,
  and argument schemas.
- `src/mcp/tools.ts` owns the tested, transport-independent ToolApi handlers.
- `bin/validate.ts`, `bin/replay.ts`, `bin/inspect.ts`, `bin/rpg_play.ts`, and
  `bin/assess.ts` are operator surfaces.
- `agents/`, `src/ai-loop.ts`, and `src/afk/` (the assessor) coordinate
  autonomous improvement cycles; `src/gen/` mints procedural eval packs;
  `src/blind/` verifies blind-playtest reports.

This layer map names the primary surfaces, not every module. Adapters should be
thin. Engine behavior belongs below the MCP and CLI layers.

## Public Gameplay Contract

Use these surfaces for shipped world play (the listed args are the primary
options, not exhaustive signatures — `src/mcp/server.ts` defines the public MCP
registration and argument schemas, while `src/mcp/tools.ts` defines behavior):

- `list_overworld({ include_design_notes? })` — the world + quest registry summary
- `start_overworld({ … })` then travel/scout/talk/explore to discover and
  `start_overworld_session_quest({ session_id, quest_id, … })` — the player path
- `start_world_quest` with `world_quest_id`, optional `seed`, `hide_graph`, and
  `compact_observation` — dev/QA entry point into a shipped quest by id
- `get_observation({ session_id, if_state_hash?, compact_observation? })`
- `list_legal_actions({ session_id, if_state_hash?, compact_actions? })`
- `step_action({ session_id, action_id, expected_state_hash? })`
- `save_game({ session_id, expected_state_hash? })`
- `load_game({ save, world_quest_id?, generate_rpg_seed? })`
- `get_transcript({ session_id, summary_only?, compact_summary? })`
- `replay_trace` and `inspect_trace` for deterministic audit paths.

`new_game` is generated-RPG only. It must not become a shortcut for shipped
quest starts.

## State And Persistence Requirements

Saves and traces must be RPG-mode only. Missing, malformed, or legacy modes are
integrity failures, not migration inputs.

Core state must preserve:

- player location and visited locations
- inventory and object state
- flags, vars, and journal history
- vitals, stats, checks, combat state, and endings
- world quest identity or generated-RPG seed identity
- deterministic step count and state hash

Restore paths must reject forged or incoherent references before returning a
playable session.

## Open-World Consolidation Rules

The world graph is the source of shipped quest placement. A quest pack is not a
public game by itself; it becomes playable when registered in the world graph.

Future world expansion should move in this order:

1. Strengthen engine invariants and restore integrity.
2. Strengthen gameplay systems: combat formulas, stat tables, scaling,
   environmental flags, quest stages, and event lifecycle rules.
3. Strengthen token-efficient context packing for long autonomous play.
4. Only then add descriptive content or new quest nodes.

If a content structure blocks consolidation, remove the package-era shortcut and
route the content through world graph identity instead of preserving the shortcut.

## Token-Efficiency Requirements

Agent-facing surfaces should be compact by default and verbose by explicit opt-in.

Required patterns:

- Return state hashes and snapshot hashes so callers can use `if_*_hash`.
- Reject stale mutations with `expected_*_hash` before changing state.
- Prefer ids over repeated labels in compact payloads.
- Cap compact inventory, flag, journal, action, and transcript arrays with omitted
  counts when needed.
- Keep `AI_LOOP_STATE.md` to the tested live window; superseded planning docs
  are deleted, and detail not worth keeping in the tree belongs in git history
  or ignored local artifacts.
- Keep raw logs, blind reports, generated evidence, and run output out of tracked
  files unless they are curated bug artifacts.

## Verification

`npm run health` is the bar for anything that lands. `AGENTS.md` is the single
authoritative description of it (it already chains `npm run validate` and
`npm test`), of the bug and regression rules, and of the two loops. Do not weaken
tests, validators, protected assets, or `scripts/verify-integrity.ts` to make a
change pass.

The 2026-07-06 consolidation audit's results are standing invariants: no active
CYOA or semantic-command runtime, content tree, binary, or test fixture; public
shipped play starts through `world_quest_id`; shipped content is discoverable
through the contiguous world graph; and saves, traces, and sessions are RPG-mode
only. A regression against any of them is a bug.
