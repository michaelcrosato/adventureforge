# The AdventureForge dev loop

> **This is one of two loops.** Playtesting runs separately and in parallel —
> see [`two_loop_workflow.md`](./two_loop_workflow.md). Either loop runs on any
> model.

An autonomous improvement loop that **constantly evaluates the next-best
improvement** across the whole project, makes one focused change per cycle, and
lands it under **trust-but-verify** (see `AGENTS.md`). It consumes quality
feedback as QA tickets produced asynchronously by the playtest loop; it does not
produce that feedback itself, and it never waits for it. It draws on the agent's broad knowledge to
_choose and craft_ improvements, and on the deterministic verification suite to
_prove_ they're correct.

## One cycle

```
loop.sh  (outer driver — orchestration + the bar)
│
├─ 0. QA BUCKET     npm run work -- --list  (the intake queue, which is what
│     report_qa_bucket actually shells out to; `npm run qa:bucket -- --summary` is the
│     operator-facing view of the ticket bucket behind it. Informational only: it can
│     never fail the cycle, and an empty queue is normal — the assessor's own
│     maintenance candidates carry the cycle)
│
├─ 1. ASSESS        npm run ai:loop → src/ai-loop.ts (uses src/afk/assessor.ts)
│     Deterministically scans every pack + repo signals and ranks
│     improvement candidates across four categories:
│        content_fix · content_new · engine · repo
│     Compiled feedback hot spots (docs/testing_pyramid.md), when present, are
│     a primary input to the ranking.
│     Emits: ai-runs/<id>/{assessment.md, prompt.md} plus latest-cycle.json at
│     the ai-runs/ root (which records the improvement source, fresh-overworld
│     playtest contract, report path, and ultraplan handoff path when applicable).
│
├─ 2. CRAWL GATE (pre)   npm run crawl:smoke — Tier 1 of the testing pyramid.
│     Must be green before the agent touches anything; red here means the
│     world was already broken, so the cycle halts and reverts (loop.sh).
│
├─ 3. WORK          the operating agent (first installed of codex/claude/gemini,
│     or AI_AGENT / AI_AGENT_CMD)
│     Reads the cycle prompt and:
│       a. ONE improvement — content edit / apply_content_patch, or an engine/repo
│          change (full authority; new mechanics need no §14 ceremony, but stay
│          verified). Bugs get a traces/bugs/ artifact + a tests/regression/ test.
│       b. FOCUSED CHECKS + LOCAL PROVISIONAL COMMIT — freezes every tracked
│          implementation change without pushing, then requires an exactly clean
│          `git status --porcelain`. Before freezing, the agent records the actual
│          chosen candidate id (or null for off-list work) in the scaffold's
│          machine-owned `feedback_cycle_selection` marker. This is the revision
│          the player will exercise.
│       c. NO PLAYTEST IN THIS LOOP — the dev cycle never plays the game and
│          cannot be failed for lacking a session. Experience evidence is
│          produced asynchronously by the playtest loop (playtest-loop.sh)
│          against the published build and enters LATER cycles as triaged
│          intake tickets (docs/two_loop_workflow.md). When pure cycle
│          artifacts DO exist under ai-runs/<runId>/, the seal verifies them
│          exactly as it always did — server evidence and the V2 receipt
│          independently cross-checked (docs/blind_playtest_protocol.md) —
│          and evidence or a sidecar published WITHOUT a report is rejected
│          as an incomplete publication. Direct quest starts and crawler/
│          smoke/mock modes are structural QA, never pure retention evidence.
│          Milestone/harvest fleets belong to the playtest loop
│          (`npm run fleet -- --count 100`, docs/testing_pyramid.md).
│       d. FEEDBACK + LEDGER — run `npm run feedback:status`, which verifies the
│          unseen ledger plus accepted pending-cycle cohort. Run `npm run
│          feedback:compile` only when it reports a one-time bootstrap or ≥3 new
│          actionable reports. Mocks remain accounted for but cannot trigger or
│          steer a compile. Complete AI_LOOP_STATE.md after the change; it must be
│          the only tracked change left outside the provisional commit.
│
├─ 4. CRAWL GATE (post)  npm run crawl:smoke again — a new finding here is a
│     regression the cycle itself just introduced; the cycle halts and reverts.
│
├─ 5. VERIFY        the bar, all blocking (a red gate reverts the cycle's scratch
│                    to the pre-cycle ref, skips the commit, and the outer loop
│                    continues under circuit breakers — see Failure handling):
│       npm run health / health:fast   (verify:integrity + typecheck + lint +
│                                  format:check + tests + ui:typecheck + validate;
│                                  which one is read off the cycle's diff — see
│                                  "Which health bar" below)
│       verify:integrity --against <pre-cycle ref>   (don't route around the verifier:
│                                                      hard-block only on weakening —
│                                                      deleted/disabled tests, dropped
│                                                      test count, or a re-pin with no
│                                                      content change; legit re-pins warn)
│       require_final_ledger_only  (only AI_LOOP_STATE.md may differ after the gates)
│       loop:seal-feedback         (verify any present cycle playtest artifacts —
│                                    optional since 2026-08-29, but an incomplete
│                                    publication fails closed; atomically promote
│                                    any compile manifest and queue this report)
│
└─ 6. FINALIZE/PUSH   commit only the completed, machine-sealed AI_LOOP_STATE.md
       after the outer bar passes. AI_LOOP_COMMIT=1 enables both the provisional
       implementation commit and this final ledger commit; AI_LOOP_PUSH=1 may push
       only afterward.
       Note: a bare push of fresh commits to protected
       main is always rejected (the required 'verify' check can't have run yet) —
       land loop commits via a scratch branch/PR and leave AI_LOOP_PUSH=0.
```

**Which health bar.** The bar is blocking either way, but not every cycle needs the
full one, and the driver does not decide by hand. `select_health_bar` asks
`npm run loop:bar` (`scripts/cycle-bar.ts`), which classifies the cycle's whole diff —
the provisional commit _and_ whatever is still in the working tree — against
`CENSUS_PROOF_SOURCE_SCOPES`, the same list `npm run ship` reads for a landing. Nothing
in the census proofs' reach ⇒ `npm run health:fast`; one path inside it ⇒ the full
`npm run health`. Every uncertain case resolves to the full bar: an unreadable ref, a
failed helper, an empty answer, or any verdict the driver does not recognise, and
`AI_LOOP_FULL_HEALTH=1` forces it outright. This is worth doing because the six census
proofs are the large majority of a cycle's wall clock (~79 minutes of CI body time
together), so a docs or tooling cycle used to spend most of its hour re-proving packs it
never touched. The trade is the one the fast lane already states out loud: a regression
only a census proof catches is not caught by that cycle. On `main` the nightly
`deep-audit.yml` census is the backstop; **on a lane branch it is not**, so run
`npm run test:exhaustive` against the branch head periodically and after any cycle that
touched the engine or content.

**Failure handling.** loop.sh refuses to start on a dirty tree, and re-checks that at
every cycle boundary in both modes (AI_LOOP_ALLOW_DIRTY=1 overrides it for commit mode
only, accepting the risk below). Each cycle snapshots
its exact non-ignored untracked paths. A red gate fails explicitly (`|| return 1`, not
`set -e`): tracked work and the provisional commit reset to the pre-cycle ref, and
only untracked paths absent from that snapshot are cleaned, across the whole repo.
Preexisting untracked paths are not intentionally deleted. Under the dirty override,
however, reset still destroys tracked edits and no cleanup can restore a preexisting
untracked file that the agent staged/committed, edited, moved, or removed. A
nonzero or timed-out agent turn is itself a failed cycle; partial output does not
fall through to the gates. Every failure is classified and appended atomically to
the bounded ignored `ai-runs/failure-ledger.json` history (100 entries by default),
which `npm run loop:status` displays even when no wrapper log was captured. The
outer loop continues until its circuit breakers stop it (5 consecutive / 15 total
failures by default).

**Feedback-compile ownership.** The prompted agent runs `npm run feedback:status`;
the command, not prose bookkeeping, verifies and counts stable report identities
against the last accepted manifest. With no flags, inputs are the local
`blind-tester/reports` ledger and cycle reports named in the committed acceptance marker
whose exact report/evidence/sidecar hashes still match. Crawler files remain explicit
`--in` evidence until they have an equivalent accepted-artifact receipt.
Existing report/receipt/provider gates still decide admission, and copied pure runs
count once. A no-flags compile ranks only the fresh actionable report delta;
explicit standalone inputs can also add crawler findings, while `retention.json`
remains a cumulative verified-corpus view. Deterministic structural mocks enter the seen/excluded partition so they cannot
retrigger, but never enter product hot spots or experience metrics.

Each compile writes a canonical, digest-bound `report-manifest.json`. That ignored
artifact is provisional: the assessor ignores it, as well as any newer or tampered
compile, until `loop:seal-feedback` promotes its exact digest into the tracked
`AI_LOOP_STATE.md` marker after every outer gate. The same seal consumes a feedback
recommendation only when the provisional commit's actual-selection attestation names
it (the assessor's offered recommendation is not authority) and queues the just-tested
pure report for a later cohort. In commit mode `loop.sh` also checks that attestation seconds
after the provisional commit (`npm run --silent loop:seal-feedback -- --check-attestation --meta
ai-runs/latest-cycle.json`), so a worker that leaves `AI_LOOP_STATE.md` out of its commit
fails before the bar runs rather than after it; the generated prompt hands the worker the
same command to run before it ends its turn. This one-cycle lag prevents that canonical cycle
bundle from entering after a failed, reset, or uncommitted build and does not depend
on Git ancestry, so squash merges preserve identity. Fully verified fleet/legacy/smoke
ledger reports retain their existing local-ledger admission path. Ordinary explicit
compiler flags remain standalone forensic paths and never write an acceptance pointer;
the recovery-only `--rebootstrap` is the sole exception. If a tracked manifest
points to missing/corrupt ignored local artifacts, feedback reads fail closed; restore
the bundle or run `npm run feedback:rebootstrap`. That recovery command is refused
unless committed state already names an accepted compile whose exact ignored bundle
is unavailable or invalid; it cannot replace a healthy accepted compile or create the
initial baseline.
`loop.sh` does not count or invoke the compiler; it only performs the post-gate seal.

If the whole `ai-runs/` directory was cleared, start a new dev cycle before recovery:
record the cycle-start HEAD, pass the pre-crawl gate, and run `npm run ai:loop` with
`AI_LOOP_COMMIT=1` in the environment. This command is the deterministic assessor;
it recreates `latest-cycle.json` and the tracked cycle scaffold without `loop.sh`
or a coding-agent CLI. Review and freeze that scaffold in the provisional commit
as usual; a recovery-only cycle keeps its actual-selection marker at null. Then
run `npm run feedback:rebootstrap` for that frozen revision. The compiler checks
cycle metadata before writing a bundle and explains this setup when it is missing.
The replacement remains provisional: `feedback:status` will still reject the old,
missing accepted bundle until it is sealed and committed. After the normal outer
gates pass, run `npm run loop:seal-feedback -- --start-ref <saved-cycle-start-HEAD>
--expected-commit <frozen-HEAD>` with the two full commit hashes, then commit the
ledger update. Recreating metadata supplies no playtest evidence.

**Evidence-only mode.** With `AI_LOOP_COMMIT=0`, `npm run ai:loop` does not rotate or
append to the tracked loop ledger before the agent starts. The prompt requires an
exactly clean `git status --porcelain` before any uncommitted edit (no play of any
kind — the dev loop never plays). Work can be checked locally, but nothing produced
against the uncommitted revision may be represented as published evidence for it.
The driver enforces a clean start again at every cycle boundary;
`AI_LOOP_ALLOW_DIRTY=1` cannot bypass that provenance gate. If a successful
evidence-only cycle leaves work uncommitted, continuous mode stops before launching
another baseline and tells the operator to commit, stash, or discard the pending work.

## Saturation-triggered ultraplan

The deterministic assessor is cheap and good at routine work, but it has no
strategic imagination: once every high-value lever has disarmed (content clean,
world quests at the breadth target, no engine/repo/frontier candidate), every remaining
candidate collapses to the **0.5 routine-blind-pass floor** — `isSaturated(a)` in
`src/afk/assessor.ts`. That is the diminishing-returns state that once pinned the
loop to clockwork-polish.

When the loop hits it, a cycle **re-aims with a bounded multi-agent ultraplan**
instead of spending another pass on polish:

```
ASSESS → isSaturated?  ── no ──▶ standard cycle (as above)
                       └─ yes, and off cooldown ──▶ ULTRAPLAN cycle:
   1. Workflow ultraplan (≈4-6 agents: LOCAL repo reviewers + synthesis — NO web
      researchers; web tools force an interactive approval prompt that stalls the
      unattended loop) picks the single highest-value STRUCTURAL move, grounded in
      docs/ROADMAP.md and recent AI_LOOP_STATE.md (advance them, don't restart).
   2. Writes the sole fresh-agent handoff to ignored
      ai-runs/<cycle>/current-plan.md; latest-cycle.json records it as
      currentPlanRecord. The handoff never goes into a tracked doc.
   3. A FRESH implementation subagent reads ONLY that per-cycle handoff + the files
      it names (clean context, not the whole repo) and makes the one change.
   4. Same provisional-commit → outer green bar → final ledger-commit sequence
      as every commit-enabled cycle (no playtest — this loop never plays).
```

**Cost control.** An ultraplan is multi-agent (≈4-6 agents) / multi-minute work, so it must not fire
every ~15-min cycle while saturation persists. A **cooldown** (`ai-runs/
saturation-state.json`, default 8 cycles, `AI_LOOP_ULTRAPLAN_COOLDOWN`) bounds it to
at most once per N cycles. Ultraplan cycles also get a larger agent budget
(`AI_LOOP_ULTRAPLAN_TIMEOUT_SECONDS`, default 3600s) via the per-cycle
`agentTimeoutSeconds` that `ai-loop.ts` writes into `latest-cycle.json`.

The fresh-context-per-phase shape is free here: each cycle's automatic agent is a new
agent process (`codex exec`, `claude -p`, `gemini`, or whatever `AI_AGENT_CMD` names),
and Step 3's implementer is a fresh subagent — so the plan is
handed off as a _document_, not a context window.

### The decision log (durable memory of settled questions)

The ignored per-cycle handoff is intentionally disposable, so it cannot remember what
was already ruled out across re-aims. `docs/DECISION_LOG.md` supplies that durable
memory: it is an **append-only** ledger of settled questions.
Each ultraplan reads it first and treats its "Confirmed CLOSED" list as a hard boundary for
every reviewer subagent (do not re-nominate or re-investigate a closed gap — the file:line
proof is recorded), then appends the gaps it confirmed closed this cycle. This is the missing
fourth piece of the reviewer subagent contract — _objective · output format · tool guidance ·
**boundaries**_ — and the cure for redundant fan-out across re-aims.

## Why this shape (grounded in 2025–26 practice)

- **Hard, machine-readable verification gate + "don't route around the verifier"**
  are the two highest-value techniques for unattended loops (Anthropic
  long-running-agents harness; EvilGenie reward-hacking benchmark). We enforce both:
  `npm run health` is the gate, and `scripts/verify-integrity.ts` makes
  test-weakening / silent hash re-pins fail loudly.
- **Evidence-driven work selection** (not a hand-fed TODO list): the assessor turns
  real signals — validator warnings, thin modes, engine TODOs, missing tooling,
  generated-pack drift — into a ranked backlog, so the loop always works the
  highest-value thing and a human can see _why_.
- **An LLM playtest is the quality oracle, one of three tiers, one oracle chain —
  see docs/testing_pyramid.md.** Dev tests (validators + exhaustive solver) prove
  _structure_ (every ending reachable, no soft-locks, sound scoring); the mechanical
  crawler (`crawl:smoke`/`crawl:deep`) sweeps every quest and the overworld for
  mechanical defects with zero LLM cost; a reasoning agent playing the same
  game-native contract as a human measures the _experience_, including its real
  continue/end retention choice, and the feedback compiler
  turns both crawler findings and blind reports into ranked hot spots. The crawl
  gate is mandatory around every change. The blind playtest is **not** a per-cycle
  gate — that coupling is exactly what the two-loop split removed
  (`docs/two_loop_workflow.md`); `loop:seal-feedback` verifies cycle playtest
  artifacts in full when present and seals the acceptance marker alone when not.
- **Externalized state + one change per cycle**: `AI_LOOP_STATE.md` is the durable
  history; `ai-runs/<id>/` holds ignored per-cycle evidence, playtest report, and any
  ultraplan fresh-agent handoff.

## Running it

```bash
npm run assess          # just print the ranked next-best-improvement backlog
npm run ai:loop         # one cycle: assess + emit the cycle prompt + artifacts
./loop.sh --once        # full cycle (pre-crawl → change/provisional/play → outer gates → ledger commit)
./loop.sh               # continuous (AI_LOOP_MAX_CYCLES, AI_LOOP_DELAY_SECONDS to bound)
npm run loop:status     # project-scoped status + durable latest failure; optional
npm run loop:stop       #   velocity telemetry uses: ./loop.sh 2>&1 | tee ai-runs/wrapper.log

npm run crawl:smoke               # the crawl gate itself, run standalone (docs/testing_pyramid.md)
npm run blind                     # canonical pure player, fresh overworld
npm run fleet -- --count 100      # milestone/harvest pure fleet (real tokens)
npm run fleet:mock -- --count 2   # explicit structural, zero-token dry run
npm run feedback:status           # verify/count the accepted uncompiled cohort
npm run feedback:compile          # when status says ready; writes delta + manifest
npm run feedback:rebootstrap      # recovery only: replace a missing/corrupt accepted bundle
```

`loop.sh` installs missing root and UI dependencies before starting cycles because
`npm run health` includes `ui:typecheck`.

The scheduled deep audit wraps the isolated `ending-render-proof` and standard
coverage suite with non-blocking performance warnings at 420 s and 4,200 s. It
caches the last five green durations per proof and also warns above 1.5× their
rolling median. These warnings never change the commands' exit status, hard job
timeouts, state caps, or proof completeness. The instrumented standard suite has
a coverage-command-only 300-second per-test ceiling for full-suite V8 worker
contention; ordinary standard tests retain their 60-second fail-fast ceiling.

Key env (loop.sh's header comment is the authoritative reference): `AI_LOOP_COMMIT=1`
to enable the local provisional and final-ledger commits, `AI_LOOP_PUSH=1` to push
(rejected against protected main — see the cycle
diagram), `AI_LOOP_DELAY_SECONDS` between cycles (default 10), `AI_AGENT=<id>` to pick a dev
agent (`codex`, `claude`, `gemini`) and `AI_AGENT_CMD` to set an explicit command for
anything else — otherwise the loop auto-detects the FIRST of those ids that is
installed, so the same checkout runs under whichever vendor a machine happens to have.
Asking for an agent that is absent fails loudly rather than silently substituting
another vendor, which would make the ledger claim work an agent never did. The outer
loop does not inspect local credential files or choose a fallback provider —
`AI_AGENT_TIMEOUT_SECONDS` (default 2400)
to hang-kill a stuck turn, `AI_LOOP_MAX_CONSECUTIVE_FAILURES` / `AI_LOOP_MAX_TOTAL_FAILURES`
for the circuit breakers, and `AI_LOOP_ALLOW_VERIFIER_EDITS=1` to acknowledge a
deliberate verifier change. `AI_LOOP_FAILURE_LEDGER_MAX_ENTRIES` bounds retained
failure records (default 100). `AI_LOOP_STOP_FILE` (default `ai-runs/loop.stop`) is the
graceful stop: touch it and the loop finishes the cycle in flight, pushes it if pushing is
enabled, and exits at the next safe point (it is checked before a cycle starts and again
after one returns, never inside a cycle), so landing a change on a running lane no longer
means catching the inter-cycle sleep or killing a paid worker turn. A leftover stop file is
cleared at startup rather than honoured.

The generated cycle prompt carries the intake queue (with its claim and close commands and
a live-lease filter) and two standing contracts for headless workers: `HEADLESS_TURN_CONTRACT`
(one non-interactive turn; the provisional commit must exist before the turn ends and must
absorb any untracked `intake/queue` or `qa/tickets` output the cycle-start triage produced)
and `FOCUSED_CHECKS_CONTRACT` (run only the checks for what you touched; the driver runs the
bar off the diff after the provisional commit).

### A hardened `claude` launcher for unattended runs

For any unattended Claude run, use `agents/claude-headless-worker.sh` as the
`AI_AGENT_CMD` (`AI_AGENT=claude AI_AGENT_CMD=agents/claude-headless-worker.sh ./loop.sh`).
The registry's bare `claude` entry (`claude -p --permission-mode acceptEdits`) is only
the auto-detect default: `acceptEdits` approves file edits, not shell commands, and a
headless `-p` run has nobody to approve them, so unless the operator's own Claude settings
happen to allow them, that worker cannot run `npm`/`git` — no focused checks, no
provisional commit — and a commit-mode cycle fails. The launcher packages what a
multi-day unattended run showed a headless worker needs:

- **One turn, stated outright.** A `claude -p` run is a single non-interactive turn; nothing
  resumes it. The launcher appends that contract to the system prompt (never background a
  command, never schedule, do not stop before the provisional commit exists, run only
  focused checks because the driver runs the bar) and disallows the scheduling, subagent,
  messaging, and worktree tool families, so the worker cannot "end its turn expecting a
  wake-up" — the way the first lost cycles went.
- **Explicit permissions.** A tool allowlist (`--allowedTools`) under `acceptEdits` instead
  of a blanket permission bypass, which the CLI refuses for a root process anyway. It is a
  guardrail, not a sandbox: `node`/`npx`/`npm` can still run anything, but there is no
  generic command runner (`bash`, `env`, `xargs`, `command`, `python3`), git is allowed
  only per subcommand a cycle uses, and `git push`/remote-mutating git is denied outright.
- **A clean process.** `env -i` with only PATH, HOME, the proxy/CA settings, and the loop's
  own `AI_*` knobs; a fresh `--session-id` with `--no-session-persistence`, so the worker
  never writes into an operator's transcript and the CLI's session registry cannot fail a
  finished run at its last step ("Session ID already in use" killed two green cycles).
- **Telemetry and a cap.** `--max-budget-usd` (default 25) ends a runaway turn nonzero, which
  fails and reverts the cycle; the streamed JSON record lands under `ai-runs/dev-agent/`
  and a one-line `dev-agent summary: {...}` (turns, seconds, cost, tokens, denials) goes to
  the cycle log.
- **A stop that stops.** The agent runs in its own process group; on TERM (the driver's
  timeout path or a manual stop) the launcher TERMs then KILLs the group inside the
  driver's `--kill-after` budget. Without this a claude child survived the wrapper's death
  and kept editing the checkout for 18 minutes after the cycle was recorded as failed.

Knobs: `DEV_AGENT_MODEL` (default `claude-sonnet-5`), `DEV_AGENT_EFFORT` (default `max`),
`DEV_AGENT_MAX_BUDGET_USD`, `DEV_AGENT_RUN_DIR`, and `DEV_AGENT_CONTROL_FILE`, a KEY=value
file re-read at every launch so an operator can retune between cycles without restarting
`loop.sh`.

## Honest limits

- When a cycle publishes playtest artifacts, the seal (`loop:seal-feedback`, not
  the driver) verifies them in full: the pure runner's sidecar-last publication,
  a schema-valid V2 interview, an exact game receipt match,
  `tracked_worktree_clean: true`, and a build commit equal to provisional HEAD.
  This rejects empty, fabricated-shape, interrupted, dirty-build, and
  stale-revision artifacts — and an evidence file or sidecar published without
  its report fails closed as an incomplete publication. The artifacts themselves
  are optional (the dev loop plays nothing); verification cannot prove the
  model's private motivation, but it does prove a recorded session followed the
  enforced player surface and ended through the game contract.
- The verifier-integrity guard catches _mechanical_ tampering (skip/delete/empty/
  re-pin), not _semantic_ weakening (a future LLM-judge could).
- The loop makes one change per cycle by design; broad multi-step work should be
  several cycles, each verified.
