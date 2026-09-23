# The testing pyramid

One always-on Tier 0 development foundation plus a three-tier evidence pyramid:
mechanical structure, blind experience, and a compiler that turns the evidence
into ranked fixes.
`AGENTS.md` and `docs/afk_loop.md` wire this into the loop; this is the canonical
reference for what each tier does, when it runs, and its exact shapes. What each
lane COSTS is measured per file, not estimated: `npm run test:durations` then
`npm run test:census` regenerate that census on demand.

## 1. The pyramid

- **Tier 0 — dev tests** (always, inside `npm run health`): the vitest
  unit/property/regression suite, the two validators, exhaustive shipped-pack
  proofs, bug-trace integrity, and the opening-density budget. Proves
  _structure_: tested endings reachable, progress-action liveness, sound
  scoring, valid evidence references, and no test/schema/density regressions.
  The vitest part runs in two lanes over one unchanged project set — `test:fast`
  (the `standard` project) on every commit and in the PR gate, `test:exhaustive`
  (the six whole-state-space census proofs) nightly. §2's budget table gives the
  split and §2.1 the reasoning; `npm run health` still runs both.
- **Tier 1 — mechanical crawler** (`src/crawl/`, zero LLM): drives the pure
  engine in-process across every shipped quest plus a full overworld sweep,
  checking nine finding codes every step — eight true invariants (CRASH,
  INTEGRITY, DESYNC, PERSIST, LEGALITY, SOFTLOCK, RENDER, WORLD) plus ORPHAN,
  which reports coverage rather than a violation. `crawl:smoke` runs every loop
  cycle (pre- and post-work gate); `crawl:deep` is a longer soak, nightly or
  manual.
- **Tier 2 — pure blind LLM playtests** (`blind-tester/`, driven by the
  independent playtest loop — see [`two_loop_workflow.md`](./two_loop_workflow.md)):
  a fresh agent on a registered provider with an implemented lane starts a
  brand-new overworld game and receives only the
  human player surface, and follows its versioned current goals, authored story
  choices, and goal/checkpoint continue-or-end choices. Under current contract
  v3, every goal-completion retention event identifies the goal it closed and a
  post-continue authored choice may install the next objective. The harness
  interviews only after a confirmed exit and cross-checks the schema-V2 report
  receipt against server evidence. Evidence-sidecar v2 binds seed, clean tracked
  commit, canonical world id/hash, and quest outcomes. The generic hardened
  runner proves the full client boundary for the vendors with capture readers in
  this checkout — Codex and Claude Code today; the list is
  `blind-tester/implemented-launch-paths.json` and `npm run doctor` explains every
  provider. The dedicated Grok wave uses the same pure server evidence but remains
  operator-attested and therefore cannot enter retention metrics. Playtests run in
  their own loop, not per dev cycle; when a cycle does publish one, the seal
  verifies the V2 sidecar's exact receipt and rejects evidence whose build commit
  is not the current provisional HEAD. The
  milestone/feedback-harvest `fleet` runs 100 seed/model variants of that same
  neutral pure contract. Direct quest, persona-coverage, crawler, smoke, and
  mock paths are explicit structural QA and never pure retention evidence.
- **Tier 3 — feedback compiler** (`src/feedback/`): verifies stable Tier-2 report
  identities, diffs them against the accepted manifest, and ranks the fresh
  actionable report cohort by severity and source agreement. Explicit standalone
  runs may also combine supplied Tier-1 findings. It emits `hotspots.{json,md}`, cumulative mode-separated
  `retention.json`, and a digest-bound `report-manifest.json`. Structural smoke
  and legacy reports remain useful QA/experience inputs; deterministic structural
  mocks remain visible in accounting but cannot create product hot spots, metrics,
  or threshold progress. Only sidecar-verified pure exits enter retention.

```
   Tier 0 (always)              Tier 1: crawl:smoke/deep        Tier 2: pure blind / fleet
   vitest+validators+solver     zero-LLM engine sweep           game-led play + exit receipt
   proves structure                    │ findings.jsonl                │ reports/*.md
                                        ▼                                ▼
                                  Tier 3: feedback:compile  ◄────────────┘
                                        │
                                        ▼
          ai-runs/feedback/<ts>/{hotspots.json,hotspots.md,retention.json,report-manifest.json}
                                        │
                              outer-gate acceptance marker
                                        │
                                        ▼
                          npm run assess / ai:loop (assessor)
                                        │
                                        ▼
                            ONE ranked next-best fix → loop
```

## 2. When each runs + budgets

| Lane                          | Trigger                                                                                                     | Budget                                                                                                                                                                                                               | Cost                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `test:fast`                   | every commit (`health:fast`) and both PR shards                                                             | the `standard` project: every ordinary unit/property/regression/acceptance file; 60s per-test ceiling                                                                                                                | free                        |
| `test:exhaustive`             | nightly (`deep-audit.yml`) / manual dispatch                                                                | the six census proofs, ~79 min of measured CI body time, serialized one or two workers wide by `vitest.config.ts`                                                                                                    | free, long-running          |
| `crawl:smoke`                 | every loop cycle (pre- and post-work gate)                                                                  | fixed two-seed, 250-step-per-quest single-worker sweep; runtime is machine-dependent                                                                                                                                 | free                        |
| `crawl:deep`                  | nightly (`deep-audit.yml`) / manual dispatch                                                                | 64 seeds, 2,000 steps per quest, 20,000-state solver budget, and eight workers with 900s soft cutoffs; runtime is machine-dependent, and any cutoff is loud via `truncated` / `skippedItems`                         | free                        |
| `verify:bug-traces`           | every health/CI run; repeated nightly                                                                       | parse all `traces/bugs/*.yaml`; validate mapping/ID/narrative essentials and current-or-historical concrete path references                                                                                          | free                        |
| `verify:opening-density`      | every health/CI run                                                                                         | canonical compact start: at most 732 word tokens and 12 immediately actionable options before the first player action; reductions do not require a re-pin                                                            | free                        |
| `test:coverage`               | nightly / manual non-player audit                                                                           | V8 statement/branch/function/line report for root `src`, `bin`, `scripts`, and `agents` exercised by Vitest's standard project; coverage-only 300 s per-test ceiling; JSON summary + browsable HTML retained 30 days | free, long-running          |
| `blind` (single)              | every normal cycle                                                                                          | one pure journey; game-native goal/checkpoints govern exit                                                                                                                                                           | $ (one LLM playtest)        |
| `fleet -- --admission-canary` | before expanding Spark spend or a Spark transport change                                                    | three planned serial fresh Spark pure runs; first failure suppresses unlaunched slots; isolated transport go/no-go, never certification                                                                              | up to $ × 3                 |
| `fleet -- --count 100`        | milestone / feedback-harvest cycles (~every 10, or when the ledger's open questions outgrow single reports) | 100 pure fresh-overworld runs at `--concurrency C`                                                                                                                                                                   | $ × 100 (real LLM tokens)   |
| `playtest:grok-wave`          | deliberate cross-family corroboration against a clean published revision                                    | 100 Grok 4.6 low-effort players by default; private pure MCP server + V2 evidence per member; operator-attested client boundary                                                                                      | $ × count (real LLM tokens) |
| `starting-slice:pilot`        | after authority/model tooling changes and before an authoritative spend                                     | reverify one exact fresh 10-member homogeneous-provider/model no-retry cohort as a go/no-go pilot; never certification                                                                                               | free                        |
| `starting-slice:certify`      | after an authoritative starting-slice fleet closes                                                          | reverify the exact 100-report authenticated bundle and evaluate the milestone gates                                                                                                                                  | free                        |
| `fleet:mock`                  | every CI run (rides `npm test`)                                                                             | explicit structural acceptance e2e; never retention evidence                                                                                                                                                         | zero tokens                 |
| `feedback:status` / `compile` | status reports a bootstrap or ≥3 new accepted actionable reports (structural mocks excluded)                | seconds (deterministic verification, identity diff, and clustering)                                                                                                                                                  | free                        |

The world-integrity verdict is cached across processes since 2026-09-05
(`src/world/source.ts`, bug_0611): `npm run validate` proves the shipped world and
leaves a marker under `ai-runs/world-integrity/` keyed on the world bytes and the
engine source, and every later test process that loads the same bytes reuses it
instead of spending 19 seconds re-proving it. That is why `validate` runs before
the suite in both `health` scripts and in the CI test shards.

## 2.1 Why the census proofs are the nightly half

The split is not "slow tests are less important". It is that these six proofs
cannot answer a question most changes ask. Each BFSes the complete reachable state
region of every shipped pack, and each imports only the engine scopes named in
`CENSUS_PROOF_SOURCE_SCOPES` (`scripts/test-lanes.ts`: the `content/` packs,
`src/api`, `src/core`, `src/gen`, `src/persist`, `src/rpg`, `src/solve`, `src/trace`,
`src/validate`, `src/world`, `tests/regression/support/` and `vitest.config.ts`) — so
a change to the fleet
runner, blind tester, feedback compiler, crawler, MCP layer, CLIs, docs or intake
tooling cannot move their verdict, while still costing the large majority of the
bar's wall clock. Deferring them buys back that time for exactly the changes they
say nothing about.

The converse is the rule that matters: **a change to the engine, a validator, the
world, or a shipped pack must run `npm run health`, not `health:fast`.** For those
the proofs are the ground truth, and the fast lane is not evidence about the
change.

The accepted cost is that a content or engine regression only a census proof
catches can sit on `main` until the nightly `Deep audit` goes red, rather than
blocking the PR that introduced it.

Nothing is skipped. The lanes must PARTITION the vitest projects — together every
project, neither twice — because the dangerous failure here is silent and sits one
level above the one `detectSuiteCoverage` catches: add a project, name it in
neither lane script, and it runs in NO lane while both still exit 0.
`scripts/test-lanes.ts` reads the actual `package.json` script bodies rather than
a parallel list, and `tests/unit/test_lanes.test.ts` asserts the partition, the
file-level split, and that the proof list it duplicates still equals the
exhaustive projects' `include` lists in `vitest.config.ts`.

## 3. Exact commands

```bash
# Tier 1 — mechanical crawler
npm run crawl:smoke                                # loop gate: all quests + overworld sweep, exit 1 on any non-ORPHAN finding
npm run crawl:deep                                 # nightly/manual soak (multi-worker)
npm run crawl -- --workers 4 --seeds 7             # custom invocation (flags in bin/crawl.ts)

# Non-player integrity and measurement
npm run verify:bug-traces                          # strict YAML/identity/current-or-historical path gate
npm run verify:opening-density                     # real compact opening against 732-token / 12-option ceilings
npm run test:coverage                              # standard-project V8 report in coverage/

# Tier 0 — the two suite lanes
npm run test:fast                                  # the standard project (every commit)
npm run test:exhaustive                            # the six census proofs (nightly)
npm run health:fast                                # the nine checks over the fast lane
npm run health                                     # the nine checks over both lanes
npm run audit:non-player                           # all three checks above

# Tier 2 — blind playtests
npm run blind                                      # canonical pure player, fresh overworld
npm run blind:smoke                                # explicit structural MCP check, no LLM/tokens
bash blind-tester/run.sh --smoke --quest sunken_barrow --seed 7 # targeted structural check, no LLM
npm run fleet -- --admission-canary --label <fresh-spark-admission-label> --out <separate-report-dir> --seed-base <fresh-spark-seed-base>
npm run fleet -- --provider codex --model gpt-5.3-codex-spark --count <n-greater-than-3> --admission-receipt ai-runs/fleet/<fresh-spark-admission-label>/admission.json --seed-base <fresh-seed-base> --label <fresh-label> --no-resume --max-retries 0
npm run fleet -- --provider codex --model gpt-5.6-terra --count 10 --concurrency 4 --seed-base <fresh-pilot-seed-base> --label <fresh-pilot-label> --no-resume --max-retries 0
npm run starting-slice:pilot -- --fleet ai-runs/fleet/<fresh-pilot-label>
npm run fleet -- --provider codex --model gpt-5.6-terra --count 100 --concurrency 4 --seed-base <fresh-seed-base> --label <fresh-label> --no-resume --max-retries 0
npm run playtest:grok-wave -- --plan-only            # deterministic no-spend plan
npm run playtest:grok-wave -- --count 100 --concurrency 4 # evidence-bound, operator-attested Grok batch
npm run fleet:mock -- --count 2                    # structural, zero-token, CI-safe
npm run starting-slice:certify -- --fleet ai-runs/fleet/<label>

# Tier 3 — feedback compiler
npm run feedback:status                            # verify/count identities since the accepted manifest
npm run feedback:compile                           # only when status says ready; accepted report inputs
npm run feedback:compile -- --in <dir|jsonl> --out <dir> --top 10 --prev <dir> --llm-labels

# Consuming the pyramid
npm run assess                                     # preview the ranked next-best-improvement backlog
npm run ai:loop                                    # one cycle: assess + emit prompt/artifacts
```

`crawl:deep`, a live (non-mock) `fleet`, and `playtest:grok-wave` spend real
time/tokens. The
zero-token deep crawl runs nightly or by manual workflow dispatch, never inside
the PR smoke gate; live fleets remain deliberate operator launches. Before launching a
live member, fleet preflight freezes the full clean tracked Git commit,
canonical world id/hash, contiguous seeds, and run/model plan. Dirty state or a
Git/provenance error fails before token spend; untracked notes do not dirty the
check. A live fleet label must be fresh and names one closed cohort, so an
existing label is rejected rather than appended to or mixed with stale rows.
Live pure starts also share a fail-closed Git-common cohort ledger across linked
worktrees: an active lease blocks every concurrent launch, while immutable
intent records reject exact or overlapping member plans unless an operator
supplies the current exact cohort fingerprint for a persisted exact duplicate.
The runner never performs PID-based stale-lock recovery; after confirming no
runner remains, an operator may remove only the active lease manually. See the
fleet section of `docs/blind_playtest_protocol.md` for the record and recovery
limits.

The opening-density budget measures the actual default `start_overworld`
payload before the player's first action. Its word total includes tutorial,
goal/guidance, the compact legend, and compact context; its option total includes
immediately available roads, areas, points of interest, contacts, events, and
available services. The 2026-08-05 baseline is 732 word tokens and 12 actionable
options. Either number may fall without changing the ceiling; exceeding either
fails health and CI. This counter-metric prevents a wording or schema change from
silently paying for clarity by adding still more opening material.

Bug artifacts are historical evidence, so their concrete file references may
resolve in the current tree or in reachable Git history. CI checks out full
history for this reason. Ignored ad-hoc recorder output is generated evidence,
not a source-file reference.
The scheduled coverage report is deliberately separate from `npm run health`:
it makes standard-suite reach measurable without running the already long suite
twice on every pull request or turning an uncalibrated percentage into a gate.
V8 instrumentation plus full-suite worker contention pushes the largest standard
restore properties and counterfactual matrices past the ordinary 60-second
fail-fast ceiling, so `test:coverage` alone allows 300 seconds per test. The
normal standard suite keeps its 60-second ceiling, and the coverage audit keeps
its separate 4,200-second soft budget.

Live fleets enforce `play_mode: pure`, `start_surface: fresh_overworld`, and the
neutral default persona. The live fleet defaults to Codex
`gpt-5.3-codex-spark` for ordinary feedback harvests and
accepts only exact homogeneous `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`,
or `gpt-5.3-codex-spark` plans. The canonical pilot and authority commands pin
Terra explicitly so both cohorts use the same model. Before the 100-player
spend, `starting-slice:pilot` must pass one fresh ten-member homogeneous cohort
with 10/10 primary
unrecovered members, unique game and provider sessions, one exact actual
model id, at least three recognized Wolf-Winter strategies, and no strategy
above 7/10. The pilot has a distinct result kind and cannot certify the slice.
Exact Spark uses audited `spark-direct-mcp-v1`, and Terra uses Terra-only
`game-direct-mcp-v1`: the pure AdventureForge tools are preloaded through an exact
model-specific tracked game-only player catalog and the first native call is
`start_overworld({})`. Each catalog disables coding/search surfaces, selects
native direct tool mode, supplies the exact game-only base instructions, and is
bound with the optional-context disables by the clean build commit. Terra also
pins disabled multi-agent topology and API-request reasoning-summary mode
`none`; its catalog also declares the summary parameter unsupported. Exact
Codex 0.146 rollout evidence records its compatibility-only `summary: "auto"`
sentinel, which does not override that request setting; strict Terra remains v2.
Terra keeps its native 10,000-token truncation policy and
272,000-token context capacity.
Subsequent calls must stay in the
attested pure set while the game server enforces current legality. Sol and Luna
retain `strict-code-mode-v2` wrappers. Lifecycle ids are validated within each stream;
both direct transports require exact `codex-cli 0.146.0` before launch.
Ordered tools, arguments, results, and visible outputs must cross-bind between
public and private streams under the selected transport;
tool/resource discovery, cross-server calls, or a transport
mismatch reject the run. Before larger Spark spend, `--admission-canary` must
pass its three serial fresh pure runs. Its separate `admission.json` is marked
noncertifying and does not count as pilot or authority evidence. A live Spark
fleet larger than three must supply it through `--admission-receipt`; the exact
clean build/world, transport fingerprint, model, client authority/version, and
gate configuration must still match or the fleet fails before player launch.
Every current Codex model also rejects opaque CLI compaction from pure evidence,
including a second world or turn context; `auto_compact_token_limit: null`
preserves default headroom but is not a proof that compaction is disabled.
Resume is a diagnostic
convenience and requires a
reverified evidence-sidecar-v2 report with the current journey contract and
exact planned seed/build/world. Generic readers retain historical sidecar-v1
readability, but v1, legacy, and structural reports cannot enter the cohort. The
20-minute member timeout is a technical failure/failsafe, not the intended
endpoint. Failed artifacts are digest-indexed in a per-attempt bundle archive
before retry; strict-stream exit 43 is terminal, publishes no playtest, and is
never retried. The closed manifest and summary count every attempt, so an eventual
success cannot erase a prior timeout or verification/launcher failure. Any such
label exits nonzero and cannot certify. A resume-enabled fleet or skipped slot
is also non-certifying: an authoritative fresh label must use
`--no-resume --max-retries 0` and launch exactly one successful attempt for each
of its 100 slots. The current Codex launcher has no model-recovery turn. A
historical recovered report remains readable only with a complete, byte-bound
`.initial-report.txt` / `.repair.meta.json` / `.repair.json` set, never another
discoverable Markdown report, and remains diagnostic-only because its
subjective interview was generated after the primary report. Targeted quest
starts remain available only to non-LLM smoke/mock lanes and the mechanical
crawler.

## 4. Schemas

**Crawl finding** (`src/crawl/findings.ts`, zod `.strict()`), one JSONL row:
`{ code, severity, seed, policy, step, location: {region,node,questId,sceneId},
action, message, stateHash, commit, repro: {kind,trace,minimized} }`. Nine
finding codes: `CRASH · INTEGRITY · DESYNC · PERSIST · LEGALITY · SOFTLOCK ·
RENDER · WORLD · ORPHAN`, each with a fixed severity (`CODE_SEVERITY`);
`findingFingerprint` (code + canonical location + normalized message) dedupes
repeats, and `repro` holds a replayable trace where one exists. `repro.minimized`
says whether it was cut down: quest-crawler `rpg-trace` repros are ddmin-minimized
(best effort, `src/crawl/minimize.ts`), while overworld `overworld-actions` repros
are the full action journal up to the finding and always carry `minimized: false`,
and a `kind: "none"` repro has no trace at all.

**Pure exit evidence** (`src/blind/exit_interview.ts` plus the server-authored
run JSONL): report-schema V2 reports declare `play_mode: pure`,
`start_surface: fresh_overworld`, `retention_eligible: true`, and carry the exact
journey receipt returned on exit. The receipt records the versioned game
contract, meaningful-decision proof/count, current goal, ordered completed-goal
history, every goal-bound or checkpoint continue/end choice, and the exit
reason. Report schema V2 and journey contract v3 are independent version axes.
Follow-up objective routing is also game-owned: UI and MCP receive the same
Goal Passage choice and aggregate consequence forecast. Passage applies each
real road leg but yields at authored choices, objective arrival, and resource
boundaries; intermediate route and future-event knowledge remain hidden before
travel, while the pure harness remains route-blind and non-prescriptive.
An independently verified evidence-sidecar v2 and fleet manifest preserve that
metadata plus the private run seed, full Git commit, tracked-worktree-clean bit,
canonical world id/hash, and sorted quest outcomes. Fresh-start and exit events
must carry identical provenance. Historical sidecar v1 remains readable by the
generic evidence parser but is ineligible for current fleet resume or
certification; structural and legacy outputs are explicitly
retention-ineligible.
Each live member's runner-owned attestation binds its planned provider/model,
exact singleton provider-evidence model provenance, unique provider session, completed clean
primary envelope, game session, and artifact hashes. Historical Claude v2
attestations remain compatible. Codex v3 also binds actual provider, effort,
turn id, working directory, public events, exactly one copied rollout, and its
strict canonical-cwd/filesystem-identity capture receipt. The receipt and rollout
are independently rehashed; `task_complete` must be the last row and abort/error
lifecycle history is forbidden. Historical Codex v4 additionally distinguishes
deterministic receipt binding: the provider's original report and strict
`.receipt-bind.json` metadata are hashed, the final report must reproduce by
replacing only the existing receipt value from raw server evidence, and the
unchanged report verifier must pass. This zero-model transformation preserves
all subjective evidence, so it is certifiable; model-assisted report recovery
remains forbidden. Codex v9 is the current contract: it authenticates the exact
selected model-specific transport, Spark capture schema v4, Terra game-direct
capture schema v5, or Sol/Luna strict capture schema v3 as applicable,
public/private cross-binding, and the fleet-wide frozen
effective client authority plus exact CLI version. That authority binds the original
canonical Unix npm symlink when present, the exact package/entrypoint/native
closure, and a native-only final execution target; unsupported script launchers
cannot downgrade to one-file authority. Current resume and certification require
v9. Receipt schemas v1-v2 are historical; v3 remains current only for strict
Sol/Luna and v4 only for Spark direct, while none of v1-v4 can establish
Terra's current v5 capture. Codex v3-v8 is historical-readable only. Codex
`turn_context.model` is a CLI-recorded selected-model value, not a provider-signed
remote-backend identity. Resume and certification reparse these retained facts.
The cwd receipt is a trusted capture-time runner assertion: after cleanup they
cannot re-stat the deleted temporary directory or defend against a privileged
actor coherently rewriting the entire artifact bundle.

**Retention compile** (`src/feedback/evidence_summary.ts`) writes
`retention.json`: verified report counts split by pure/structural/legacy-guided,
plus pure-only decision statistics and actual continue/end choices by
trigger/checkpoint within each journey-contract version. Historical v1 and
v2 curves and current v3 curves remain independently verifiable but are never
pooled.
`would_replay` remains a separate post-exit attitude metric.

**Starting-slice pilot/certification** reparses every report and sidecar in one
closed fleet bundle. Both require unique contiguous planned seeds, no
failed/missing/resumed/recovered slots, exactly one verified attempt per slot,
one clean build/world, unique game and provider sessions, one exact authenticated
actual model id, and a homogeneous supported provider/model under the current
pure fresh-overworld/default-player contract. The pilot fixes the count to ten and requires 10/10 completion plus
its 7/10 strategy cap; its distinct artifact is readiness evidence only. The
authority checker does not automatically discover or link that artifact, so
retaining and reviewing a fresh same-model pilot is an operational prerequisite
before the 100-player spend.
Certification fixes the count to 100 and is the only authority result. Report
basenames must carry the cohort's current stamp, preventing historical reports
from being relabeled as fresh. Receipt-bound Codex members remain eligible only
when current v9 attestation, original provider bytes, binding metadata, raw evidence,
and the reproduced final report all agree; manifests and summaries count them
separately from report recovery.
Malformed evidence exits 2, a threshold miss exits 1, and a pass exits 0. Exact
quality gates, outcome mapping, and the conservative fleet-local issue-scope rule
live in [`STARTING_SLICE.md`](STARTING_SLICE.md); `would_replay` is not
continuation, and global feedback history never certifies the slice.

**Hotspots file v2** (`src/feedback/schema.ts`, zod `.strict()`),
`hotspots.json` top level: `{ version, generated_at, commit, inputs, metrics,
sycophancy, hotspots, recommended_next_fix }`. Each `Hotspot`: `{ id, title,
location, severity_band, max_severity, count, sources, personas, score,
fix_layer, evidence, trend, prev_score }`. `score = count × severity_weight ×
source_diversity` (§ `src/feedback/rank.ts`: `S0=1 … S4=16`; both sources
agreeing doubles the score). `inputs` reconciles `verified_reports` as
`actionable_reports + excluded_mock_reports`; `sycophancy` carries zero-negative
rates and 1–5 histograms over actionable reports, overall and per-persona.

**Severity polarity**: S0 = cosmetic, S4 = blocking.

**Fix-layer taxonomy**: `content | hint_text | quest_structure | engine_rule |
validator | test`.

## 5. How findings become fixes

- **Crawler → fix**: a finding's repro is ddmin-minimized to the shortest
  reproducing action sequence, written as a `traces/bugs/` artifact plus a
  regression test that fails if the defect returns. First real catch:
  `bug_0496` (`traces/bugs/bug_0496_overworld_renown_restore.yaml`).
- **Fleet → fix**: authenticated fleet reports accumulate in the local
  `blind-tester/reports/` ledger. Exact pure cycle bundles become default inputs
  only after the outer-gate seal records their hashes in committed loop state.
  `feedback:status` verifies and identity-diffs those inputs; a ready
  `feedback:compile` clusters only its fresh actionable cohort. The assessor reads
  only the exact digest-bound compile promoted by a later outer-gate seal — never a
  merely newer ignored directory — and the loop makes ONE fix per cycle. A feedback
  recommendation is consumed only by the actual candidate id frozen in the provisional
  loop-state scaffold, not merely because the assessor offered it.
- **Comparison signal**: an accepted delta compile compares with its exact accepted
  predecessor and tags each hotspot `improved | regressed | new | flat`. This is
  cohort-to-cohort movement, not causal proof that a fix worked. Explicit `--prev`
  remains available only for standalone forensic comparisons.
