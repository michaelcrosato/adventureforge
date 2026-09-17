# Agent Charter

This is the entry point every coding agent (Codex, Claude, Gemini, …) reads
first, and the single source of truth for how work happens here. Codex loads this
file by convention; [`CLAUDE.md`](./CLAUDE.md) and [`GEMINI.md`](./GEMINI.md) are
one-line pointers back to it so the other vendors land here too, because the dev
loop runs on whichever agent a machine has installed and a charter only one vendor
auto-loads is a charter the rest silently skip. Those pointers are deliberately not
copies: duplicated rules drift, and a stale copy is worse than none.

This project runs on **trust, but verify**.

## What this is

AdventureForge is a deterministic, text-based TTRPG engine **designed to be
AI-coded and AI-playtested**. The engine and content are the product; the web UI
(`ui/`) is only a human-facing layer. Quality compounds through an autonomous
improvement loop, and this charter orients the agent driving it.

## Communication

- Use ordinary game-development language in status updates: name the game behavior,
  code change, and check result directly.
- If a required service is unavailable, note it briefly and stop or continue with
  repo-local work as appropriate. Do not inspect personal application state.

## Two loops

Development and playtesting are **separate loops that run in parallel**, and
**any model can drive either one**. The full reference is
`docs/two_loop_workflow.md`.

- **Dev loop** — `loop.sh`. Makes changes and lands them against a mechanical
  bar. It does NOT play the game.
- **Playtest loop** — `playtest-loop.sh`. Plays the published build over and
  over, across as many provable vendors as the operator's quota allows, and
  promotes corroborated findings into the intake queue. Live pure waves take only
  the `default` persona — persona-directed play changes the thing retention
  measures — so the persona library rotates on the structural lanes instead
  (`PLAYTEST_MOCK=1`, or `npm run fleet:mock -- --personas …`).

Other teams are optional and use the same intake: an audit agent, a research or
design agent, the crawler, or a person. **Playtest feedback is not the only way
the game changes.** Everything files a submission into `intake/queue/` with
`npm run submit`, and the dev loop reads only that queue.

The dev loop reads it at the start of a cycle; it never waits for it. An empty
queue is normal and means the assessor's own candidates carry the cycle (set
`AI_LOOP_IDLE_WHEN_EMPTY=1` to wait instead).

Running several lanes at once — worktree-per-lane, claim identity/leases, and
the single-writer map — is `docs/parallel_lanes.md`. The human-facing ticket
mirror of the intake queue is `docs/linear_workflow.md`; the repo queue always
wins disagreements.

## The dev loop (one cycle)

`loop.sh` is the repository's reference driver for this protocol;
`docs/afk_loop.md` is the full protocol; the three-tier testing pyramid (on its
always-on Tier 0 dev foundation) is `docs/testing_pyramid.md`. Each cycle:

1. **Assess** — read the intake queue first (`npm run work`): a queued
   submission is somebody's actual request, and a `verified` or `corroborated`
   playtest item is the strongest evidence available. Claim it with
   `npm run work -- --claim <id>` and close it with `--done <id>`. Then
   `npm run ai:loop` ranks the next-best improvement when the queue is empty —
   which is normal, not a stall.
2. **Crawl gate (pre)** — `npm run crawl:smoke` must be green before touching anything.
3. **One change** — make a single focused improvement (engine, content, or tooling).
4. **Freeze the revision** — run focused checks, then make a local provisional
   commit. Before committing, set the scaffold's machine-owned
   `feedback_cycle_selection` to the exact candidate id actually implemented (or
   null only for off-list work); this is what can consume an accepted feedback
   recommendation. Never push the provisional commit. Pure evidence starts only
   when `git status --porcelain` is exactly empty; a later red gate resets it.
5. **No playtest gate.** The dev loop does not play the game. Experience evidence is
   produced asynchronously by the playtest loop and consumed as QA tickets at the
   START of a cycle, not proven at the end of one. `loop.sh` prints the bucket for the
   cycle log and can never fail the cycle, `require_playtest_record` is gone from the
   driver, and the generated cycle prompt no longer asks for a blind run.

   This was half-finished until 2026-08-29: the driver was migrated but
   `loop:seal-feedback` still hard-required `ai-runs/<runId>/playtest.{md,evidence.jsonl,run.json}`,
   so a cycle that trusted this section passed every gate and was then hard-reset at
   the seal — and because only Codex could mint that sidecar, a Claude-driven loop
   still needed Codex installed. The seal now treats those artifacts as **optional**:
   absent, it seals the acceptance marker alone; present, it verifies them exactly as
   it always did, including the pure-V2-sidecar-bound-to-the-provisional-commit check.
   Publishing evidence or a sidecar _without_ a report is rejected as an incomplete
   publication rather than silently skipped, so the weakest state cannot masquerade as
   the strongest.

   A dev cycle is therefore vendor-neutral end to end: any agent that reads STDIN,
   edits files and exits nonzero on failure can drive it, with no second vendor
   required to land the work.

6. **Compile feedback (prompted-agent step)** — run `npm run feedback:status`.
   It verifies the local report ledger plus hash-bound pending cycle reports against
   the last accepted report manifest. Run `npm run feedback:compile` only when status
   says the one-time bootstrap or a ≥3-actionable-report delta is ready. Pure,
   legacy-guided, and structural-smoke reports count; deterministic structural mocks
   remain recorded but never satisfy the threshold or steer product findings. The
   current cycle's pure report becomes pending only after its outer gates, so it is
   intentionally eligible for a later compile. `loop.sh` does not invoke the compiler.
   Crawler findings require explicit `--in` until crawler artifacts gain an equivalent
   tracked acceptance receipt; the mandatory pre/post crawl gates remain unchanged.
7. **Outer gates** — `npm run crawl:smoke` again, then the health bar, and
   integrity drift against the cycle-start ref. That is the whole bar. A new crawl
   finding is YOUR regression; any red gate resets the provisional commit.
   Which health bar is not a flag: `loop.sh` reads it off the cycle's own diff — the
   provisional commit plus the working tree — through the same
   `CENSUS_PROOF_SOURCE_SCOPES` list `npm run ship` uses, so a cycle out of the census
   proofs' reach runs `health:fast` and a cycle touching the engine, a validator, the
   world, or a shipped pack runs the full `npm run health`. Anything uncertain (an
   unreadable ref, a failed classifier, an unrecognised answer) takes the full bar, and
   `AI_LOOP_FULL_HEALTH=1` forces it. The cost is the same one the fast lane already
   carries: a regression only a census proof catches waits for the nightly
   `deep-audit.yml` census — which covers `main`, not a lane branch, so a long-running
   lane needs its own periodic `npm run test:exhaustive`.
8. **Finalize** — after every gate is green, the driver seals any provisional
   feedback manifest into the machine-owned acceptance marker in `AI_LOOP_STATE.md`,
   then commits that ledger-only update. Optional push happens only afterward, and
   publishing the build is what the playtest loop picks up. Missing or
   digest-mismatched ignored feedback artifacts fail closed.

With `AI_LOOP_COMMIT=0`, no provisional commit is allowed: the cycle runs its
checks and leaves the work uncommitted. The driver rechecks cleanliness at every
cycle boundary and stops continuous mode after a successful evidence-only cycle
leaves pending work.

Never claim a build was exercised by evidence that was produced against a
different one. Session records carry the exact commit they played, and triage
ages findings out after `STALE_AFTER_BUILDS`; do not hand-wave past either.

## Authority

- Agents may change engine code, schemas, DSLs, mechanics, content, tooling, and docs.
- Normal implementation decisions have no human-approval gate and no §14 ceremony
  (the retired engine-extension approval gate from the original numbered build
  spec; its history lives in `docs/archive/`).
- Keep changes scoped to the task and the repo's existing patterns.

## Verification Bar

`npm run health` is the bar for anything that lands. The granular scripts
(`npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`) are
strict subsets of it — use them for fast iteration, not as an additional
requirement on top of health.

`npm run health` runs nine steps, in this order: verifier integrity, bug-trace
integrity, the opening-density budget, typecheck, lint, format check, UI
typecheck, pack validation, and finally the vitest suite. Everything cheap runs
first on purpose — the suite is the large majority of the bar's wall clock, so
a broken pack or a UI type error that used to surface half an hour in now fails in
about a minute. The UI typecheck means UI deps
(`npm --prefix ui install`) are required for the bar, not just for running the
UI server. Do not commit or merge red.

### Two suite lanes

The vitest step splits into two lanes. `vitest.config.ts` is UNCHANGED by the
split — it still claims every discovered test file, and `detectSuiteCoverage`
still proves it — so the lanes are only a choice of which named projects a script
hands to vitest, exactly as `test:coverage` already did.

| Script                        | Runs                             | When                         |
| ----------------------------- | -------------------------------- | ---------------------------- |
| `npm run test:fast`           | the `standard` project           | every commit                 |
| `npm run test:exhaustive`     | 4 census-proof projects, 6 files | nightly                      |
| `npm run health:fast`         | the nine checks, fast lane       | the pre-commit bar           |
| `npm run health` / `npm test` | everything, unchanged            | before landing a lane branch |

The exhaustive lane is the six whole-state-space census proofs
(`rpg_metamorphic_observation_stream`, `rpg_action_id_unique`,
`rpg_variant_liveness`, `rpg_score_economy_sound`, `rpg_metamorphic_relabel`,
`rpg_all_endings_reachable`). Each BFSes the complete reachable region of every
shipped pack; `scripts/ci-test-groups.ts` measured them at ~79 minutes of CI body
time together, and `vitest.config.ts` deliberately serializes them one or two
workers wide, so most of that is a single-threaded tail with the other cores idle.

What licenses deferring them, and it is the ONLY thing that does: they import
only the engine scopes listed in `CENSUS_PROOF_SOURCE_SCOPES`
(`scripts/test-lanes.ts`) — the `content/` packs, `src/api`, `src/core`, `src/gen`,
`src/persist`, `src/rpg`, `src/solve`, `src/trace`, `src/validate`, `src/world`,
`tests/regression/support/` and `vitest.config.ts`; that list is the source of
truth, and `npm run ship` reads it off the diff. A change to the fleet runner,
blind tester, feedback compiler, crawler, MCP layer, CLIs, docs or intake tooling
cannot move their verdict. **If your change touches
the engine, a validator, the world, or a shipped pack, run `npm run health`, not
`health:fast`** — the fast lane is not evidence about that change.

The trade is real and stated rather than buried: a content or engine regression
that only a census proof catches can now sit on `main` until `deep-audit.yml`
goes red overnight, instead of blocking the PR.

Nothing is skipped, and the guard against that is mechanical. `test:fast` and
`test:exhaustive` must PARTITION the config's projects — together every project,
neither twice — because the dangerous failure here is silent and sits one level
above the one `detectSuiteCoverage` catches: add a sixth project, name it in
neither script, and it runs in NO lane while both still exit 0.
`scripts/test-lanes.ts` parses the actual script bodies out of `package.json`
rather than a parallel list, and `tests/unit/test_lanes.test.ts` asserts the
partition on every suite run.

The shipped world is proved once per bar, not once per process: `npm run validate`
records the integrity verdict under `ai-runs/world-integrity/` keyed on the world
bytes and the engine source, and every later process that loads the same bytes
reuses it (`src/world/source.ts`, bug_0611; `ADVENTUREFORGE_WORLD_INTEGRITY_CACHE`
selects `use`, `refresh` or `off`).

Budget the wall clock: the vitest step dominates the full bar, and under load a
handful of subprocess-spawning CLI tests can exceed their 60s/120s timeouts and
fail for reasons unrelated to the change under test — check what actually failed
before assuming your work broke something.

`npm run crawl:smoke` is the mechanical gate (docs/testing_pyramid.md); it is
deliberately NOT part of `health`.

### Landing a change

`main` is the only branch that survives. One command does the whole loop:

```bash
npm run ship -- "what you changed"
```

It runs the bar, commits, pushes, opens a PR, waits for the required `verify` check,
squash-merges, deletes the branch, and leaves you on an updated `main`. Nothing is
committed or pushed until the bar is green: a red bar exits nonzero with the work still
in the tree. `--no-merge` stops after opening the PR; `--dry-run` prints the plan.

**Which bar it runs is not a flag — it is read off the diff.** A change confined outside
`CENSUS_PROOF_SOURCE_SCOPES` gets `health:fast`; a change that touches any of them gets
the full `health` automatically, because there the census proofs are the ground truth.
`--full` forces the full bar; there is deliberately no flag to force the fast one.

Squash-merging is what makes rollback cheap: `main` gains exactly ONE commit per ship,
with a PR beside it explaining itself, so reverting a landing is reverting a commit.
Ship small and often — every ship is another point to go back to.

## Do Not Weaken Verification

- Do not disable, skip, delete, or hollow out tests to make a change pass.
- Do not weaken `scripts/verify-integrity.ts` or protected assets to route around the bar.
- If content behavior intentionally changes, update tests and traces honestly.
- When fixing a bug, add or keep a regression and a `traces/bugs/` artifact when the
  surrounding workflow calls for it.

## Runtime

- Node.js 22+.
- Install root deps with `npm install`.
- Install UI deps with `npm --prefix ui install` (required for `npm run health`).
- Optional UI server: `npm run ui:dev` at `http://localhost:5173`.
- Any supported coding agent can run the dev loop. The agent registry is
  `dev-agents.json` at the repo root — one file, read by both `loop.sh` and
  `bin/doctor.ts`, so the loop cannot auto-detect an agent the doctor fails to
  report (it was previously a hand-kept list in each, in an order doctor's output
  depended on). `loop.sh` auto-detects the first installed entry (`codex`,
  `claude`, `gemini` today); `AI_AGENT=<id>` selects one explicitly and
  `AI_AGENT_CMD` overrides the command entirely. Adding a vendor is one entry in
  that file. The only contract is: read the prompt from STDIN, edit files in
  `$PWD`, run non-interactively, and exit nonzero on failure.
- Connecting to the engine MCP server. The repo ships `.mcp.json`, which any
  client reading the standard project MCP config — Claude Code among them —
  discovers automatically; the command is always `npm --silent run mcp` from the
  repo root. Discovery is not approval: Claude Code asks once per checkout before
  starting a server declared in project config and records the answer in the
  gitignored `.claude/settings.local.json`, so a fresh clone or a new lane
  worktree comes up with no engine tools until that approval — silently, since a
  headless `-p` run has nobody to ask. Enabling all project MCP servers at the
  user level stops project approval mattering. A client that keeps its own
  registry instead needs the server added there once.
- Codex needs one extra step, and it fails silently without it. `.codex/config.toml`
  registers the same server, but Codex loads project config **only when the project
  is trusted**, and trust does not cascade from a parent directory — trust this exact
  repo path. Untrusted, the server is simply absent and a headless `codex exec` runs
  with no engine tools rather than erroring. Most robust for the autonomous loop is to
  register it at the user level so project trust stops mattering:
  `codex mcp add adventureforge -- npm --silent run mcp`.
- CLI RPG play requires no server: `npm run play`.
- MCP and live LLM playtests are optional and belong to the playtest loop; CI uses deterministic mocks.

### Sharp edges in a fresh checkout

Each of these cost a real cycle before it was written down. They are cheap to avoid
and expensive to rediscover, which is the only reason they are in the charter.

- **Neither driver parses flags. An unrecognized one is IGNORED, and the run starts
  for real.** `./loop.sh --help` does not print help — it begins a cycle.
  `./playtest-loop.sh --help` is worse: the only flag it reads is `--once`, so
  anything else leaves it unbounded and it starts dispatching live players. There is
  no dry-run flag to probe with; read the header comment instead — both files
  document their env knobs in the first ~45 lines.
- **Always set `PLAYTEST_COHORT` explicitly.** Unset, it resolves to the registry's
  first provider, which is whichever vendor `blind-tester/providers.json` lists first
  — not whichever vendor you have installed. If that binary is absent every player
  fails instantly, and without `--once`/`PLAYTEST_MAX_WAVES` the loop keeps minting
  failed sessions into the corpus every `PLAYTEST_DELAY_SECONDS` until stopped.
  `npm run doctor` prints what this checkout can actually launch; ask it first.
- **A shallow clone fails `verify:bug-traces`, and therefore `npm run health`.** The
  gate resolves ~770 historical path references through git history and reports
  `GIT_HISTORY_TRUNCATED` when it cannot. CI runners and cloud checkouts often clone
  shallow. `git fetch --unshallow` once fixes it; worktrees share the object store,
  so it only needs doing once per clone.
- **Install `node_modules` for real; do not symlink it from another checkout.**
  `.gitignore` lists `node_modules/` with a trailing slash, which matches directories
  only — a symlink of that name shows as untracked, and `loop.sh` then refuses to
  start on a dirty tree. Reaching for `AI_LOOP_ALLOW_DIRTY=1` to get past that is
  waiving a guard to paper over a self-inflicted problem; `npm install` takes seconds.
- **A sandboxed host may refuse the spawned-worker path entirely, and the two
  failures look nothing alike.** A headless `claude -p` worker has no one to approve
  its Bash calls, so every `npm`/`git add`/`git commit` is auto-denied and the cycle
  dies at `require_provisional_commit` having written nothing; and a host permission
  classifier may refuse to launch `agents/claude-headless-worker.sh` at all, since an
  unattended process carrying an explicit mutating-tool allowlist is the shape such
  classifiers exist to stop. Narrowing the allowlist does not help — the pattern is
  what is refused. Where that holds, the loop's machinery (assess, gates, triage,
  revert, breakers) still works; only the "spawn an agent to make the change" step is
  unavailable, so make the change in-session against the same protocol and bar. Do
  not add `--dangerously-skip-permissions` (the CLI refuses it for a root process
  anyway) and do not route the launch through another agent or session — that
  launders a permission decision that was not yours to make.

## Token Economy

- Prefer targeted `rg`, `git grep`, `git ls-files`, and ranged file reads over broad
  whole-file dumps.
- Treat `AI_LOOP_STATE.md` as a terse index, not a transcript. Old detail is preserved
  by Git history.
- Keep raw evidence in ignored paths: `ai-runs/`, `blind-tester/reports/`, logs,
  coverage, build output, and local runtime directories.
- Large content packs, generated world JSON, traces, lockfiles, and historical docs are
  on-demand context. Open them only when the task needs them.

## Git

- Commit in clear increments when asked to land work.
- Branch policy: `main` is the only long-lived branch and the default. Work lands
  through short-lived feature branches merged into `main` via PR; the required
  status check is `verify` (`.github/workflows/ci.yml`), with strict up-to-date
  branches and force-pushes disabled. A direct push to `main` is rejected unless
  that commit already has a green `verify` run, so fresh work always goes through a
  branch — **for everyone except a repository admin**. `enforce_admins` is
  currently disabled, so an admin push bypasses the required check entirely. Treat
  the rule as binding on yourself regardless: the protection is not what stops you,
  the charter is. (Enabling `enforce_admins` would make the two agree, at the cost
  of removing the owner's manual override.) Keep every landing green — the bar is
  `npm run health`.
- **One agent, one checkout.** Two agents sharing a working directory will
  eventually switch branches or reset the tree under each other mid-task (it has
  happened). Interactive sessions follow the same rule the loops already
  enforce: take your own worktree off `origin/main`
  (`git worktree add .claude/worktrees/<lane> -b lane/<lane> origin/main` — that
  path is gitignored for exactly this, and `lane/` is the branch namespace in
  use) unless you are the only writer in the checkout. See
  `docs/parallel_lanes.md`.
- A local branch that outlives its merged PR may hold content the squash never
  landed (#309 did). Before deleting or ignoring one, check
  `git diff origin/main <branch>` — an empty diff is the only proof it is dead.
- Never print or commit secrets. Use local env files only when a task explicitly needs
  credentials.
