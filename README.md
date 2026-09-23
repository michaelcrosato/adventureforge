# AdventureForge

An **AI-coded, AI-playtested** text RPG: one deterministic engine, one
persistent world, and a feedback flywheel — dev agent → verification bar →
blind playtest → structured exit interview — that compounds quality every
cycle. Development and playtesting run as **two independent loops**, either of
which any model can drive
([`docs/two_loop_workflow.md`](./docs/two_loop_workflow.md)). The why lives in [`docs/VISION.md`](./docs/VISION.md); what's next in
[`docs/ROADMAP.md`](./docs/ROADMAP.md); the standing architecture contract is
[`ADVENTUREFORGE_BUILD_SPEC.md`](./ADVENTUREFORGE_BUILD_SPEC.md); settled decisions
live in [`docs/DECISION_LOG.md`](./docs/DECISION_LOG.md).

> **Trust, but verify.** The coding agent has free rein over all game code — no
> human-approval gate, no §14 engine-extension ceremony; it decides _what_ to
> build. But the automated verification stays the **bar**: tests, the determinism
> property checks, the validators, trace replay/regression, and green CI must pass —
> the autonomous loop and CI won't land red work. Freedom in design, honesty in
> verification (don't route around the verifier). Governing doc:
> [`AGENTS.md`](./AGENTS.md).

## One world, one engine

Everything runs on a single **RPG foundation engine** inside a single
persistent world (the 2026-07-06 consolidation — see
[How we got here](#how-we-got-here)):

- **Deterministic core** (`src/core/`) — a pure `step` reducer over a unified
  `GameState`, a closed condition/effect DSL, a seeded PRNG, an event log, and a
  canonical state hash: no wall clock, no ambient randomness, same seed ⇒
  byte-identical run. Save/load with content-hash integrity
  (`src/persist/save_load.ts`) and trace record/replay (`src/trace/`).
- **RPG foundation layer** (`src/rpg/`) — rooms, objects, containers, locked
  doors, NPC dialogue, USE puzzles, scoring, character stats, seeded turn-based
  combat, and d20 skill checks, behind a legal-action menu runner and structured
  observations. Two static validators (`src/validate/rpg_validator.ts`,
  `src/validate/rpg_foundation_validator.ts` — dozens of finding codes)
  conservatively reject structural and configuration defects. Separate dynamic
  proofs enumerate shipped-pack state spaces to witness every declared ending,
  progress-action liveness, and score-economy soundness; those claims apply to the
  tested shipped packs, not to arbitrary authored numeric gates.
- **The New York overworld** (`content/world/new_york_overworld.json`,
  `src/world/`) — a 247-node, 9-region procedurally populated travel and discovery
  substrate around one deeply authored Albany opening/campaign chapter. It supports
  roads, encounters, jobs, local events, and renown, and is the sole registry for the
  **12 shipped quests** under `content/rpg/quests/` (`advocates_case`,
  `breaking_weir`, `cold_forge`,
  `dawn_beacon`, `factors_mark`, `falconers_ransom`, `gallowmere`,
  `printers_night`, `sunken_barrow`, `tanners_fever`, `tide_mill`,
  `wolf_winter`). The current authored campaign scenes and service overrides are
  concentrated in Albany; the rest of the node count should not be read as 247
  equally authored locations.
- **Web UI** (`ui/`) — a React + Vite view over the same headless engine; it
  renders observations and never decides legality. See
  [`ui/README.md`](./ui/README.md).
- **Procedural eval packs** (`src/gen/rpg_generator.ts`) — pure, deterministic
  seed→pack minting held to the identical validator bar. Seeds select among five
  themes and vary difficulty and awards over one fixed, validated two-fight
  gauntlet skeleton; this is a moving proof input, not a generator of wholly new
  quest structures. Generated packs are deliberately not committed under
  `content/`.
- **Debugger + fixer agents** (`agents/debugger.ts`, `agents/fixer.ts`) —
  replay a trace, classify the failure, and propose a closed, whitelisted
  content patch that deterministic code applies and re-validates; a model never
  edits files or runs shell. Exposed over MCP as `apply_content_patch`.

Most of the quest library — plus engine mechanics like reactive room prose,
opt-in deadlines, and natural USE verbs — was produced by the flywheel itself,
each change blind-playtested and gated green.

## Quickstart

**Just want to play?** Double-click **`PLAY.bat`** (Windows). It checks and
refreshes dependencies, rebuilds the game from the current code, and opens it
in your default browser — no terminal needed. The build it opens
(`ui/dist/index.html`) is a single self-contained file, so it also works
copied anywhere and opened directly.

**Prerequisite:** Node 22+ — `.nvmrc` pins the toolchain (matching
`package.json`'s `engines` and CI).

```bash
npm install
npm --prefix ui install                           # required by npm run health
npm run ship -- "what you changed"               # the whole landing loop (see below)
npm run health:fast                              # the pre-commit bar: every check, fast test lane
npm run health                                   # the full verification bar (see below)
npm run validate                                 # validate all 12 shipped quests
npm run validate -- sunken_barrow               # validate one quest by world quest id
npm run play -- sunken_barrow                    # play a shipped world quest
npm run overworld                                # play the full game: overworld map -> quests
npm run inspect -- sunken_barrow                 # summarize a world quest
npm run replay                                   # replay the committed RPG smoke trace
npm run test:coverage                            # report standard-suite V8 coverage
npm run ui:dev                                   # web UI (after: npm --prefix ui install)
```

Non-interactive play (scriptable / CI): add
`--commands "go north; take rope; attack wight; ..."`. Use
`--record traces/run.json` to save a replayable trace; shipped quest traces
embed their `worldQuestId`, so `npm run replay -- <recorded-trace>` needs no
pack path. All public play, validation, inspection, and replay selectors take a **world
quest id** — raw pack paths are internal source metadata.

`npm run health` is the bar the loop and CI must leave green: the integrity
guard (`scripts/verify-integrity.ts`, which also forbids retired-runtime assets
from reappearing), bug-trace parsing/identity/reference integrity, the compact
opening's density ceilings, typecheck, ESLint, Prettier, the vitest suite, the UI
typecheck (`npm run ui:typecheck`), and validation of every shipped quest.

The vitest step runs in two lanes. `npm run test:fast` is the `standard` project
— every ordinary unit, property, regression and acceptance file — and
`npm run test:exhaustive` is the six whole-state-space census proofs, which BFS
the complete reachable region of every shipped pack and are the large majority of
the suite's wall clock. `npm run health:fast` is the nine checks over the fast
lane and is the bar to run before a commit; `npm run health` still runs
everything and is what a lane branch must be green on before it lands. The lanes
are a choice of which named vitest projects a script selects, so `vitest.config.ts`
still claims every discovered test file and the verifier's suite-coverage guard
still proves it. `scripts/test-lanes.ts` and `tests/unit/test_lanes.test.ts`
assert the two lanes partition the config's projects, so a project can never end
up in neither while both lanes still exit 0.

CI enforces the same checks but does not invoke `npm run health` itself: running
it there would double-execute the whole pipeline, so `.github/workflows/ci.yml`
splits it into a prerequisites job, two sharded fast-lane test jobs, and a
`crawl:smoke` job, then requires all three through the `verify` check. The census
proofs run nightly in [`Deep audit`](./.github/workflows/deep-audit.yml) instead
of on every PR — the trade being that a content or engine regression only they
catch can sit on `main` until that run goes red. CI also builds the UI
(`npm run ui:build`), which `health` does not, and `crawl:smoke` is required in
CI while remaining deliberately outside `health`. A fifth job, `windows-smoke`,
runs the static gates plus the path-sensitive CLI suites on `windows-latest`: the
other jobs are ubuntu-only, and that blind spot is exactly how a repo-root bug that
made `npm run health` red on Windows shipped and stayed green. It is advisory —
outside `verify`'s `needs` — so a Windows-runner hiccup cannot block a merge. All
five jobs carry a `timeout-minutes` ceiling. A separate scheduled/manual
[`Deep audit`](./.github/workflows/deep-audit.yml) runs the long crawl, the
exhaustive census proofs, and a standard-suite V8 coverage report without
lengthening the PR critical path.

## Landing a change

`main` is the only long-lived branch. `npm run ship -- "what you changed"` runs the bar,
commits, pushes, opens a PR, waits for the required `verify` check, squash-merges, deletes
the branch, and leaves you on an updated `main`. Nothing is committed or pushed until the
bar passes — a red bar stops with your work still in the tree.

The bar it picks comes from the diff, not from a flag: a change outside the scopes the
census proofs read runs `health:fast`; a change that touches `src/core`, `src/rpg`,
`src/validate`, `src/world`, `content/` or `vitest.config.ts` runs the full `health`,
because for those the proofs are the ground truth. `--full` forces the full bar,
`--no-merge` stops after the PR, `--dry-run` prints the plan and the chosen bar.

Because each ship squash-merges, `main` gains exactly one commit per landing with a PR
beside it, so rolling back a change is reverting a single commit. Shipping small and often
is what makes that useful. Requires the GitHub CLI (`gh`).

## MCP server — how an agent plays

The engine is exposed as an MCP server (`npm run mcp`, `src/mcp/server.ts`) so
any agent harness (Claude Code, Codex, Gemini CLI, …) plays via native tool
calls over the structured observation/action loop — never a raw parser. The
repo ships `.mcp.json`, so an MCP client opened here connects automatically.

**42 tools**, in four groups:

- **World catalog** (1): `list_overworld` — the overworld is both the world and
  the quest registry.
- **Overworld sessions** (26): `start_overworld`, then travel, care, rest,
  resupply, route planning, POI scouting, contacts, events, jobs, area
  exploration, export/restore — and `start_overworld_session_quest` /
  `complete_overworld_session_quest` bridging a discovered lead into quest play,
  plus `choose_overworld_session_journey` at game-presented retention pauses,
  `inspect_overworld_session_story` / `choose_overworld_session_story` for
  game-presented authored choices, and
  `follow_overworld_session_goal` committing to the current objective's road as
  one interruptible Goal Passage.
  This is how a player reaches a shipped quest: in-world, through the overworld.
- **RPG quest sessions** (12): `start_world_quest` (a dev/QA entry point that
  starts a shipped quest by id; `new_game` does the same for generated packs) →
  `get_observation` / `list_legal_actions` → `step_action`, repeated until the
  session ends; plus `get_state`, `get_transcript`, `save_game`, `load_game`,
  `validate_quest`, `load_quest`, and `generate_rpg_pack`.
- **Repair & traces** (3): `apply_content_patch`, `replay_trace`, `inspect_trace`.

Observations are **compact and self-describing**: session-creating responses
carry an initial `legend` for the positional fields used there, later responses
add same-response `legend_delta` definitions before a field's first use (dotted
keys name exact nested result paths), events arrive as tagged tuples, and
state-hash guards skip unchanged payloads — terse enough for a blind agent to
play a long session in one context window. RPG `context.npcs` rows preserve
stable authored ids while pairing them with player-facing names as
`[npc_id, display_name]`; executable action ids remain stable.
`tests/unit/compact_legend.test.ts` holds the tool descriptions and legends to
that contract; the handlers (`src/mcp/tools.ts`) are unit-tested without a live
client. All paths are confined to the project root; content and traces are data
only.

Every overworld session also carries one versioned **journey contract**, shared
unchanged by UI and MCP. Contract v3 keeps v2's meaningful-decision classifier:
movement, new clues, substantive dialogue topics, combat, skill checks,
preparation, authored story choices, and other situation changes advance the
shared counter. Context-only or repeated narration, dialogue
opening/navigation/closure, unchanged services, legal-action listings,
persistence operations, rejections, technical quest foldback, and the
continue/end retention choice do not.

The initial goal is “Complete Wolf-Winter in Albany.” (`INITIAL_JOURNEY_GOAL` in
`src/world/journey_contract.ts`). Goals
are now versioned and ordered: completing one appends it to goal history and
offers a continue/end choice bound to that exact goal, at once if completion is
before the next fixed checkpoint. If the player continues after Wolf-Winter,
the game presents an ending-sensitive Albany story choice and installs the
chosen authored objective; ending installs nothing. Fixed checkpoint thresholds
remain at 40, 80, 120, and every additional 40 meaningful decisions. Once a
threshold is due, its choice materializes at the first safe break at or after
that threshold, without interrupting active combat or dialogue. The exit receipt
records the current goal, completed goals, goal-bound retention choices,
decision proof, checkpoint history, and exit reason.

When an active follow-up goal names another town, that same journey object and
the UI journey card present one Goal Passage choice with the destination,
road/time forecast, and honest supply/fatigue consequences. Selecting it applies
every real road cost but stops at authored road choices, objective arrival, or a
new resource boundary. The player may still take roads manually; the pure
harness supplies neither route nor recommendation.

## Testing: a three-tier pyramid on a Tier 0 dev foundation

Full reference: [`docs/testing_pyramid.md`](./docs/testing_pyramid.md).

- **Tier 0 — dev tests**: the vitest unit/property/regression suite, the
  validators, exhaustive shipped-pack proofs, bug-trace integrity, and the
  opening-density budget — all inside `npm run health`. Every validator finding
  code needs a rejection witness in `content/broken-fixtures/` (or an explicit
  allowlist entry), so a new code cannot arrive unwitnessed and green.
- **Tier 1 — mechanical crawler** (`src/crawl/`, zero LLM): drives the pure engine
  across every shipped quest plus a full overworld sweep and emits deduped,
  replayable findings. `npm run crawl:smoke` is the loop's gate; `npm run crawl:deep`
  soaks nightly in `.github/workflows/deep-audit.yml`.
- **Tier 2 — pure blind LLM playtest**: a fresh agent with NO repo access plays
  through a player-only MCP surface (`blind-tester/`, protocol in
  [`docs/blind_playtest_protocol.md`](./docs/blind_playtest_protocol.md)) and ends
  with a structured exit interview the verifier cross-checks against server
  evidence. Which transport a model uses is catalog data in
  `blind-tester/catalogs/`: Spark uses direct-MCP capture receipt v4
  (`spark-direct-mcp-v1`) and Terra uses
  game-direct capture receipt v5 (`game-direct-mcp-v1`); each direct model is
  launched through its own tracked game-only model catalog. Fleet attestation v9 binds
  the exact provider, model, transport, CLI, rollout, and receipt; older schemas
  are historical readers only.
- **Tier 3 — feedback compiler** (`src/feedback/`): `npm run feedback:compile`
  clusters crawler findings and verified reports into ranked hot spots and a
  pure-exit retention summary that feeds the assessor.

```bash
npm run crawl:smoke                               # Tier 1: mechanical gate, all quests + overworld
npm run blind                                     # Tier 2 DEFAULT: canonical pure fresh-world player
npm run blind:smoke                               # explicit structural harness check, no LLM/tokens
npm run fleet -- --count 100                      # milestone: 100 pure fresh-world players
npm run fleet:mock -- --count 2                   # structural zero-token CI lane
npm run feedback:compile                          # Tier 3: hot spots + pure retention summary
```

Live play is NOT part of CI or the health bar; the engine and CI need no LLM or
third-party API key. Optional blind playtests use the operator's installed
subscription clients, and credentials never reach the game or the repository.

## The flywheel — two independent loops

Full reference: [`docs/two_loop_workflow.md`](./docs/two_loop_workflow.md).

- **Dev loop** (`loop.sh`, protocol in [`docs/afk_loop.md`](./docs/afk_loop.md)):
  assess (`npm run ai:loop`), make one focused change, then verify with
  `crawl:smoke`, the health bar, and an integrity check against the pre-cycle ref.
  It does not play the game, and it runs on any agent listed in `dev-agents.json`.
- **Playtest loop** (`playtest-loop.sh`): plays the latest published build in
  parallel, records every session, and promotes corroborated findings.
- **Intake** (`intake/queue/`, `npm run work` / `npm run submit`): the dev loop's
  one inbox, shared by playtest triage, audits, research, the crawler, and people.

`npm run doctor` reports which vendors this checkout can launch;
`npm run loop:status` / `npm run loop:stop` manage a running loop, and
`npm run assess` previews the ranking.

## How we got here

The engine was bootstrapped through staged prototypes — CYOA choices, a parser
adventure, Sierra-style scoring, then the Hero's-Quest RPG and the web UI —
each stage re-proving the deterministic core under a new rule system. On
**2026-07-06** the repo consolidated on their union: the CYOA and parser
runtimes were retired, their best mechanics folded into the RPG foundation
layer, and 36 of 52 shipped stories retired with them — the last full tree is
tagged `stories-52-pre-rpg-consolidation`, and porting those stories back as
RPG quests is standing flywheel work. The parser-era negative fixtures were
converted to the RPG-foundation corpus so no rejection direction lost its
witness. Full rationale: the 2026-07-06 entry in
[`docs/DECISION_LOG.md`](./docs/DECISION_LOG.md); stage-era plans and gate
records live in git history.

## License

Released under the [MIT License](LICENSE). Copyright (c) 2026 Michael Crosato.
