# AdventureForge Roadmap

This roadmap is current operational guidance. Historical multi-mode plans live in
`docs/archive/` (the convention for superseded planning docs) and git history,
not in the active roadmap.

AdventureForge is converging on one product: a deterministic, text-based,
open-world RPG engine whose shipped content is placed through a contiguous world
graph.

## North Star

- One runtime mode: `rpg`.
- One world AND quest registry: the New York overworld (`list_overworld`); every
  shipped quest is anchored to a town and discovered from its local notice board.
- One shipped-content source key: `world_quest_id`.
- One shipped quest start path: from the overworld via `start_overworld_session_quest`.
- One autonomous loop: inspect, change one aligned surface, verify, commit.
- One world model: a single seamless open world (like Skyrim/Cyberpunk) where every
  quest is reached in-world — no second world or game mode.

## Current Anchors

- `AGENTS.md` is the trust-but-verify charter.
- `ADVENTUREFORGE_BUILD_SPEC.md` is the standing architecture contract.
- `docs/VISION.md` is the why; `docs/DECISION_LOG.md` is the append-only memory
  of settled questions.
- `content/world/new_york_overworld.json` is the single world: the large contiguous
  overworld data source AND the shipped RPG quest registry (each quest maps a
  `world_quest_id` to its `content/rpg/quests/*.yaml` source).
- `src/world/session.ts` is the primary stateful overworld runtime.
- `src/mcp/server.ts` owns registered public MCP names, descriptions, and
  argument schemas; `src/mcp/tools.ts` owns the tested transport-independent
  ToolApi handlers.
- `src/validate/rpg_foundation_validator.ts` carries high-depth RPG foundation
  checks.
- `docs/STARTING_SLICE.md` is the active durable product milestone and
  `docs/starting_slice_causal_matrix.json` is its machine-readable proof ledger.
- `docs/CURRENT_PLAN.md` is the durable short router to the milestone contract,
  matrix, loop history, and current local evidence. An ultraplan writes its sole
  fresh-implementer handoff to ignored
  `ai-runs/<cycle>/current-plan.md` and records that path as `currentPlanRecord`
  in `ai-runs/latest-cycle.json`; it never overwrites the router.
  `AI_LOOP_STATE.md` is the rotating per-cycle result log (machine-parsed).
  Superseded planning docs move to `docs/archive/`; detail not worth keeping
  goes to git history.

## Priority Order

1. Engine stability: harden reducer invariants, event lifecycle state, restore
   validation, and trace replay.
2. Gameplay depth: mature combat formulas, stat tables, scaling progression,
   environmental flags, quest stages, and stateful NPC/event consequences.
3. Token efficiency: keep MCP/ToolApi payloads compact by default; add hash-only
   reads, stale-write guards, capped arrays, and id-first layouts.
4. Open-world consolidation: flatten package-era shortcuts into world graph
   identity and move toward coordinate or matrix navigation where it improves
   play.
5. Content expansion: add or polish quest content only after the relevant engine,
   gameplay, and token surfaces are mature enough to support it.

## Near-Term Work Queue

(Refreshed 2026-08-05. The causal matrix now records 19 implemented, proven
forks, but the milestone remains `active_unproven` until one current,
authenticated cohort satisfies every final gate in `docs/STARTING_SLICE.md`.)

The active product milestone is now the bounded Albany → Wolf-Winter → truthful
Albany-return starting slice. New towns and unrelated quest ports are frozen
until its contract in `docs/STARTING_SLICE.md` is proven.

- Keep routine pure-blind evidence flowing from clean, frozen builds: the
  playtest loop (`playtest-loop.sh`) plays each landed build independently of
  the dev loop, which no longer plays a journey per cycle (`docs/two_loop_workflow.md`);
  compile when at least three new verified reports exist. Treat the tracked feedback ledger as a historical snapshot;
  current decisions must use the intended local report set and newest compiled
  hot spots.
- Use accumulated evidence to reduce repeated Albany setup and Station-planning
  density and to test the observed strategy skew without deleting causal
  choices. All four Wolf-Winter strategy families and all 16 accepted non-death
  endings must remain truthful and reachable.
- Run a fresh, homogeneous, no-resume/no-retry ten-player pilot on the exact
  candidate build. It must pass the documented completion, pacing, clarity,
  enjoyment, continuation, severity, and organic-strategy gates before any
  authoritative spend.
- Only after a passing comparable pilot, freeze that build and run the
  authenticated 100-player cohort, then evaluate it with
  `npm run starting-slice:certify`. Only that evidence can change the milestone
  from `active_unproven`.
- Preserve the 19 proven matrix forks across full and compact MCP, terminal, UI,
  save/restore, and tamper/sequence checks. Any causal change must update
  `docs/starting_slice_causal_matrix.json` and its focused proofs in the same
  increment.
- Keep the visible Albany authored boundary closed. New towns, unrelated quest
  ports, generic district transactions, and prose-only branches remain outside
  this milestone until certification succeeds.

## Verification

Every cycle that changes source, docs, tests, content, schemas, or tooling must
finish with `npm run health` — the bar already chains `npm run validate` and
`npm test` (plus integrity, typecheck, lint, format, and UI typecheck), so do not
re-run them on top of it.

Focused tests should run first when a change has a clear local guard. Do not
weaken validators, protected assets, or `scripts/verify-integrity.ts` to make a
change pass.

## Completion Checks

The consolidation-era checks were all met as of 2026-07-06 and are now standing
invariants (regressions are bugs): world-graph identity everywhere (raw package
paths rejected at every public boundary), no active docs or prompts directing
work at retired variants, restore paths rejecting malformed/forged/stale/
cross-source snapshots, compact loop surfaces bounded enough for long blind
sessions, and a green bar (`npm run validate` and `npm test` via health).

The roadmap's open horizon is Priority 2 (gameplay depth) and Priority 5
(content expansion through story ports) — the Near-Term Work Queue above is the
live frontier.
