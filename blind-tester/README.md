# blind-tester — subscription-only blind playtesting over MCP

A self-contained harness that has a frontier model **play an AdventureForge game
blind** — through the MCP server, with no access to the source — and write a
ruthless first-time-player critique. Pure single runs use a hardened subscription
CLI provider — **Codex and Claude Code** both have live launch paths and capture
readers here (`implemented-launch-paths.json` is the list): no API key is passed
to the game or harness.

## Why no API key

The repo's own code never calls a model. The player is an isolated external vendor
CLI (`codex`, `claude`) using its existing subscription login, and it reaches
the game **only** through the `mcp__adventureforge__*` MCP tools. That uses your
subscription allowance, which is the best value — exactly per the project goal.

## Pure live and structural modes

- **Pure live mode (canonical default):** every reasoning agent starts one fresh
  overworld session with `play_mode: pure` and
  `start_surface: fresh_overworld`. It receives only the tutorial, current goal,
  completed-goal history, state, legal and authored story choices,
  meaningful-decision/checkpoint status, and consequences a human receives.
  Current journey contract v3 presents continue/end choices bound to the goal
  just completed. Its fixed checkpoint thresholds materialize choices only at
  the first safe break at or after each threshold, without interrupting active
  combat or dialogue. After a goal continuation, a game-authored story choice
  may install the next objective. The harness interviews only after the player
  ends through a retention choice; it supplies no route, coverage assignment,
  solution, or call-count stopping rule.
  Follow-up navigation comes only from the game's shared Goal Passage choice,
  which yields at real road choices and resource boundaries, never from the
  harness.
- **Structural development/QA (explicit only):** `--smoke`, `--mock`, crawler,
  and direct `--quest <id>` paths prove plumbing/mechanics. They are labeled
  non-pure and retention-ineligible, and can never resume or count as pure live
  evidence.

The goal/checkpoint continue-or-end choice is retention evidence and does not
advance the decision counter. A post-continue `journey.storyChoice` is ordinary
gameplay: choosing one of its visible options records the authored consequence,
counts once as `situation_changed`, and activates the next current goal.

## Quickstart

```bash
# 0) Explicit structural MCP check — NO LLM/tokens, not retention evidence.
npm run blind:smoke

# 1) Canonical pure player — fresh game, game-native goal/checkpoint exit:
npm run blind

# 2) Same, watched live:
npm run blind --spectate                  # then `npm run spectate` in another terminal

# 3) Targeted quest plumbing — explicit structural smoke, NO LLM/tokens:
bash blind-tester/run.sh --smoke --quest sunken_barrow --seed 11

# Luna at max effort is the default pure player (PowerShell-safe equals form):
npm run blind --seed=2875

```

The report is written to `blind-tester/reports/<stamp>_<source>_seed<n>.md`
(`<source>` is `overworld` for the default core-game run, or the quest id)
(and the provider envelope alongside as `.json`; Codex also keeps its audited
`.codex.jsonl` transport). `reports/` is gitignored.

The built-in Codex path starts from an isolated temporary player directory while
leaving subscription state entirely owned by the Codex CLI in its existing
`CODEX_HOME`. The runner never opens or copies the CLI's login store and never
deletes or mutates that shared home. Standalone report prefixes and fleet report
roots are canonicalized outside it before any directory, lock, or run artifact
is created.

Before live gameplay, the runner resolves one effective client closure and pins
its canonical regular-file identities. The default is the literal external
command `codex`. When that is the official npm launcher, the closure includes
the exact Windows npm shim or canonical Unix npm symlink/entrypoint, package
manifest, JavaScript entrypoint, and platform-native payload. A Unix symlink's
original path, target text, and file identity are bound before resolution and
rechecked with the closure. Gameplay bypasses the mutable delegation chain and
executes the pinned native payload directly. `BLIND_CODEX_BIN` may instead name
exactly one absolute, self-contained PE, ELF, or Mach-O executable path. Its
value is always one quoted argv element: scripts, JavaScript launchers,
delegating wrappers, arguments, aliases, shell evaluation, fallback
executables, and provider substitution are not supported. The pinned native
target must emit exactly one
`codex-cli <semver>` line for `--version`.
That probe has a fixed five-second timeout, one-second forced-kill grace, and
1,024-byte capture ceiling. The preflight deliberately does not read or
interpret `CODEX_HOME/models_cache.json`: model-catalog cache compatibility,
refresh, and persistence belong to the selected Codex client, which treats a
different client version as an ordinary cache miss. Repository code does not
repair or delete that cache and does not inspect login data.
At direct-player launch, the exact model-specific `model_catalog_json` selects
the CLI's static catalog manager, so ambient cache contents do not choose shell
or tool mode. The catalog is argv-bound and tracked; there is no cache-derived
transport fallback.

The audited `spark-direct-mcp-v1` and Terra-only `game-direct-mcp-v1`
transports require exact `codex-cli 0.146.0`. Any other version exits at client
preflight with code 42 before the model starts; set `BLIND_CODEX_BIN` to the
absolute path of the compatible executable. On this machine a pinned client is
kept at `~/.adventureforge-tools/codex-0146/node_modules/.bin/codex`
(`npm install --prefix ~/.adventureforge-tools/codex-0146 @openai/codex@0.146.0`
recreates it anywhere); the live client may auto-update, the pinned one never
does. The strict lane pins no CLI version;
it pins the exact rollout vocabulary instead, in two dialects. Codex ≤0.146
wrote dedicated `user_message`/`agent_message`/`mcp_tool_call_end` event rows;
≥0.147 (verified live against 0.151.0) replaced them with `item_completed`
mirrors, stamped ids on every response item, added `create_time`/
`content_item_kinds` passthrough bookkeeping, and serializes the skills block
before the permissions block in the developer prelude. The strict audit selects
the dialect from the captured `session_meta.cli_version`, requires it to agree
with the preflighted client's version, and fails closed on any row outside the
selected dialect — including `thread_settings_applied`, free-floating
`McpToolCall` mirrors, and every tool-shaped or compaction item mirror.

Every launch resolves one reasoning effort: `--effort <level>` (or
`BLIND_REASONING_EFFORT`) wins, then the selected model's catalog
`settings.reasoning_effort`, then the historical `xhigh` for codex. The value
is whitelisted (`minimal|low|medium|high|xhigh|max`), passed to the codex
player as `model_reasoning_effort`, appended to a claude_code launch as
`--effort`, and bound in the terminal audit against the captured
`turn_context.effort`. With no `--model`, the catalog's one `default: true`
entry is launched — `gpt-5.6-luna` at `max` for codex, `claude-sonnet-5` at
`medium` for claude_code — so `npm run blind` needs no flags. Fleet cohorts pin
`BLIND_REASONING_EFFORT=xhigh` explicitly and keep their own model defaults.

`--preflight-only`, used by a live fleet's shared gate, does not resolve, read,
or enumerate `CODEX_HOME` and creates no report or player artifacts. It returns
one bounded machine-readable authority containing the canonical selected
launcher, effective executable, closure-identity token, digest, and exact
semantic version. The fleet freezes that authority into every member. Each
member compares the initial, immediately-pre-launch, and final post-provider
bounded probes to it, outside the retry path. There is no CLI update, retry,
fallback, or provider substitution. The shared fleet process also has a fixed
15-second runtime and bounded diagnostic capture.

For example, when two installed clients exist, select the intended one without
adding flags:

```bash
BLIND_CODEX_BIN=/absolute/path/to/codex npm run blind
```

After this read-only gate, the runner passes `--ignore-user-config`,
`--ignore-rules`, `project_doc_max_bytes=0`, and the existing feature disables so
user/project instructions, shell/web/apps/plugins/browser/computer, the unused
shell snapshot, and subagent capabilities cannot enter the player turn. It also
selects one audited transport by exact requested model. Exact
`gpt-5.3-codex-spark` uses native `spark-direct-mcp-v1`, while exact Terra uses
Terra-only `game-direct-mcp-v1`: code mode and native tool search are disabled,
all pure AdventureForge tools are preloaded, and the player's first tool call is
`start_overworld({})`. Their tracked `codex-model-catalog-spark-v1.json` and
`codex-model-catalog-terra-v1.json` remove shell, patch, search, skills, and
model-message surfaces; select native direct tool mode; and supply the exact
game-only base instructions. Spark retains an explicit 16 KiB byte truncation
policy (above the measured 12,098-byte framed response that exposed the former
10,000-byte setting). Terra preserves its native 10,000-token policy and 272,000-
token context capacity rather than inheriting Spark's smaller byte ceiling. These
limits do not enlarge ordinary responses. Each catalog's `null`
`auto_compact_token_limit` preserves the client's maximum default headroom; it
does not turn compaction off. Because an opaque encrypted replacement history
cannot yet be independently proven to contain only player-visible evidence, any
compaction lifecycle fails closed for Spark, Sol, Terra, and Luna pure runs. The
clean build commit binds the selected catalog along with the prompt and runner.
Exact Sol and Luna use
`strict-code-mode-v2` with `--enable code_mode_only` and canonical
`functions.exec` wrappers. The runner reads the public `thread.started` UUID,
copies only the UUID-matched rollout under `CODEX_HOME/sessions`, and cross-binds
its private session/cwd/file identity to the isolated player directory.
Terra direct fails closed unless its exact 0.146 turn profile retains compatibility
hash `3000`, disabled multi-agent topology with no mode block, and the CLI's
compatibility-only `summary: "auto"` rollout sentinel. Codex 0.146 hard-codes that
serialized sentinel; it does not report or override the effective request setting.
The tracked catalog removes Terra's native v2 team prelude, pins the actual
API-request reasoning summary to `none`, and declares the summary parameter
unsupported so Codex cannot send it even if that setting drifts. The Terra-only
launch redundantly pins the request setting to `none` plus `agents.enabled=false`.
Strict Terra evidence retains its historical v2 profile. Hash `3000` matches both
the CLI's exact bundled Terra metadata and a
retained exact-CLI Terra strict capture. A fresh live reduced-profile game-direct
canary must still confirm that the repo-owned overrides are applied before fleet spend.

The health bar starts the real pure MCP server, reads its actual `tools/list`,
projects the canonical build catalogue shape `{name, description, input_schema}`,
and matches every description and input schema to a reviewed digest;
name-only/redacted fixtures are not accepted. This is deliberately not a model
of Codex's provider-specific namespace wrapper or outbound request. The clean
commit binds those server and test bytes for launch. Codex rollout files do not
repeat the preloaded descriptor catalogue, so this is build-bound local
authority, not a claim that the remote provider signed runtime descriptors.

The direct Spark and Terra audits accept only preloaded native
`function_call -> MCP completion -> function_call_output` lifecycles. After the
single exact `start_overworld({})` call, every later name must remain in the
build-attested pure player catalog; it need not be repeated as prose in the
immediately prior result. The pure server independently enforces current state,
handles, hashes, legal arguments, and terminal boundaries. The private audit
also authenticates the exact applied game-only base instructions and selected
catalog compatibility hash. Both permit only one final assistant message after gameplay;
interim narration is rejected. The strict
audit accepts only canonical `exec -> MCP completion -> visible output`
lifecycles, including the exact `// @exec: {"yield_time_ms": 120000}` pragma and
awaited forwarder; `functions.wait` is forbidden. Strict code-mode progress
commentary is accepted only as an immediate private CLI event/message pair after
a visible result and before the next game call, or once after the prompt and
before the first call, with exact text/order binding to the public stream; one
paired final answer must follow the last result. Both
transports reject tool/resource/
template discovery, planning/task tools, another server,
non-game tools, malformed or unbounded payloads, and every id/tool/argument/
result/output mismatch. Historical evidence is not retroactively required to use
the current transport shape; its schema-specific parser and topology checks
still apply. Codex never uses a report-recovery model turn. On attempt zero only,
an otherwise-valid
report whose sole verifier defect is its existing `journey_exit_receipt` value
may use deterministic server-receipt binding. The runner preserves the exact
provider message in `.json` and `.initial-report.txt`, replaces only that JSON
value, and writes strict `.receipt-bind.json` hashes; duplicate keys, subjective
or prose-rating drift, other report defects, provenance mismatch, or failure to
reproduce and pass the unchanged verifier rejects the run. Fleet runs capture the
thread-matched rollout JSONL from the CLI-owned home and
verify its cwd against the still-live isolated player directory by exact
canonical path and native filesystem identity. An exclusive adjacent
`.codex-capture.json` receipt records that capture-time check and binds it to the
copied rollout's SHA-256; resume and certification revalidate its strict fields
and rollout bytes. Because the temporary directory is then deleted, later checks
cannot re-stat it: this is trusted local runner provenance, not a cryptographic
attestation against a privileged actor coherently rewriting the whole bundle.
The CLI-recorded selected model/provider/session/effort/turn and completed
lifecycle are bound independently of requested-model and synthesized usage
fields. This is durable Codex CLI provenance, not a provider-signed snapshot of
the remote backend.

During the live turn, a negative-only stream guard reads newline-complete public
events and only the UUID/cwd/file-identity-bound private rollout. It stops token
spend once a complete row proves a forbidden public server/tool or an invalid
private wrapper/lifecycle, but treats missing future completion/output rows as
in flight. It never accepts evidence: normal Codex exit still goes through the
same stable rollout copy and full selected-transport audit. Stream rejection exits 43,
terminates the runner-owned Codex/MCP process tree, leaves no report/evidence
publication, appears in fleet history as `strict_stream_rejected`, and is never
retried by fleet.

## Watching a playthrough live (spectate mode)

To see what the LLM is doing while it plays — and verify it with your own eyes —
run the playtest in spectate mode and tail the feed from a second terminal:

```bash
# terminal 1: the playtest, with a 1.5s pause per tool response so a human can follow
npm run blind -- --spectate --delay-ms 1500

# terminal 2: the live feed (every tool call: args + the scene the agent saw)
npm run spectate
```

The feed (default `ai-runs/spectate.log`, gitignored) is written by the MCP
server itself, so it works for ANY client — not just blind runs. To spectate any
MCP session, start the server with `npm run mcp -- --spectate [path]
--spectate-delay-ms <n>` (or env `AF_SPECTATE=1|<path>`,
`AF_SPECTATE_DELAY_MS=<n>`). The delay paces every tool response; leave it off
for a full-speed feed. Spectate is fully inert when not enabled.

## Fleet mode — 100 fresh-game blind playtests

`blind-tester/fleet.mjs` (Tier 2 of the testing pyramid,
`docs/testing_pyramid.md`) runs the 100 independent pure fresh-overworld players
required at a milestone or feedback-harvest cycle, with bounded concurrency,
optional authenticated diagnostic resume, and a closed manifest bundle — each
one an ordinary `run.sh` spawn. The starting-slice pilot and authority commands
are:

```bash
npm run fleet -- --admission-canary --label <fresh-spark-admission-label> --out <separate-report-dir> --seed-base <fresh-spark-seed-base>
npm run fleet -- --provider codex --model gpt-5.3-codex-spark --count <n-greater-than-3> --admission-receipt ai-runs/fleet/<fresh-spark-admission-label>/admission.json --seed-base <fresh-seed-base> --label <fresh-label> --no-resume --max-retries 0
npm run fleet -- --provider codex --model gpt-5.6-terra --count 10 --concurrency 4 --seed-base <fresh-pilot-seed-base> --label <fresh-pilot-label> --no-resume --max-retries 0
npm run starting-slice:pilot -- --fleet ai-runs/fleet/<fresh-pilot-label>
npm run fleet -- --provider codex --model gpt-5.6-terra --count 100 --concurrency 4 --seed-base <fresh-seed-base> --label <fresh-label> --no-resume --max-retries 0
npm run fleet:mock -- --count 2     # structural zero-token dry run
npm run fleet:mock -- --count 2 --target quest:sunken_barrow # structural drop-in
npm run fleet -- --help             # list accepted flags; unknown arguments abort before fleet work
```

The admission canary is an isolated, noncertifying Spark gate: it plans three
serial fresh pure runs with no resume or retries and suppresses every unlaunched
slot after the first failure. A pass therefore launches and verifies exactly
three. It writes `admission.json` with `certification_eligible: false`; it is
neither pilot nor certification evidence. Every live Spark fleet larger than
three must supply that file through `--admission-receipt`. The launcher
recomputes its pass counts and requires the same exact clean build, transport
fingerprint, selected model, Codex CLI version, client authority, and pure gate
configuration before any member can launch. Its `--out` directory must be
outside and non-overlapping with `ai-runs/fleet/<label>`.

- **Preflight**: before spending tokens, a live fleet freezes the full clean
  tracked Git commit, canonical world id/hash, contiguous planned seeds, and
  run/model plan. Its model-specific transport fingerprint hashes Spark's
  compact prompt, catalog, and direct fragment; Terra's live prompt, catalog,
  and game-direct fragment; or the strict prompt and strict fragment for Sol/Luna.
  A dirty tree, fingerprint drift, or Git/provenance error aborts launch.
  Untracked notes do not dirty this check.
- **Persona**: only the neutral `default` first-time-player persona ships;
  prescribed play styles would change the retention measurement.
- **Provider/model**: the live fleet default is Codex
  `gpt-5.3-codex-spark`, using the dedicated Spark allowance for ordinary blind
  feedback. Current plans accept only exact homogeneous
  `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, or
  `gpt-5.3-codex-spark` plans; aliases, fallback, and mixing fail before launch.
- **Resume**: resume is enabled by default for diagnostic fleets only. Only a
  reverified report plus evidence-sidecar schema v2 with the
  current journey contract, exact planned seed, and exact clean commit and world
  id/hash may skip a pure member. Generic readers retain historical sidecar-v1
  readability, but v1, historical contract-v1/v2, guided, legacy, mock, and
  structural evidence never enters a diagnostic pure cohort. `--no-resume`
  disables lookup entirely and is mandatory for certification. Failed attempts normally back off
  exponentially up to `--max-retries` (default 2), except strict stream exit 43,
  which is terminal and never retried. Before a retry, every
  generated artifact and a diagnostic log are copied into the bundle's
  per-seed/per-attempt archive with byte counts and SHA-256 digests.
- **Runner attestation**: current Codex v9 binds the exact selected
  model-specific transport, actual provider/model/effort/session/turn,
  isolated cwd, public events, copied rollout, cross-bound capture receipt,
  original provider report, exact CLI version, and frozen client authority.
  Spark receipts are schema v4 with `spark-direct-mcp-v1`; Terra receipts are
  schema v5 with `game-direct-mcp-v1`; Sol/Luna strict receipts retain schema v3
  with `strict-code-mode-v2`. The audit requires the selected controlled native
  direct or strict code-mode lifecycle,
  and rejects every cross-binding, topology, or transport mismatch. Current
  resume and certification require v9. Receipt schemas v1-v2 are historical;
  v3 remains current only for strict Sol/Luna and v4 only for Spark direct, and
  none of v1-v4 can establish Terra's current v5 capture. Codex attestations
  v3-v8 (plus Claude v2) remain readable only. Historical v8 keeps its original
  Spark-direct/strict-Sol-Terra-Luna meaning. `task_complete` must be
  final; abort/error history, recovery, reuse, links, path escape, ambiguous
  rollout proof, and model recovery reject. Receipt binding remains a
  deterministic one-value replacement, never a new model turn.
- **Output**: reports plus verified `.run.json` evidence sidecars in `reports/`
  (or `--out <dir>`). For pure runs the adjacent sidecar is the final publication
  commit marker: verification uses a work-private sidecar, then the runner
  publishes exact raw JSONL, completes the provenance gates, and creates
  `.run.json` last with an exclusive byte-checked copy. A `.md` or
  `.evidence.jsonl` left without that marker is rejected, never treated as
  legacy evidence; ordinary unsuccessful exits also remove those unfinished
  acceptance artifacts. A manifest at
  `ai-runs/fleet/<label>/manifest.jsonl` and `summary.json` preserve play mode,
  start surface, journey contract, authenticated seed/build/world/quest
  outcomes, current/completed goals, goal/checkpoint choices, exit reason, and
  eligibility. Every row carries the complete ordered attempt history and
  retains historical report-only recovery markers only when `.initial-report.txt`,
  `.repair.meta.json`, and `.repair.json` form a complete, deterministically
  reproducible byte-bound set; rejected originals stay outside feedback
  compiler `*.md` discovery. Deterministic Codex receipt binding is recorded
  separately in each attempt, manifest row, current v9 attestation, and the summary's
  `receipt_bound_runs`; it does not change subjective fields and remains
  certification-eligible. Historical Claude recovery is diagnostic only: subjective fields
  such as confusion, bugs, stuck state, and replay intent were generated after
  the primary report and therefore cannot certify the slice. Summary
  failure/timeout counts are reduced from all attempts, not only each slot's
  final result. Each live label must be fresh and identifies one frozen cohort;
  an existing label is rejected rather than appended to or mixed with stale
  rows. Resume, a skipped slot, any retry, or any failed attempt makes a bundle
  diagnostic and non-certifying. A new authoritative label must launch all 100
  slots with `--no-resume --max-retries 0`; historical successes cannot be
  relabeled into that cohort.
- Live (non-mock) fleets spend real tokens. A live fleet always enforces
  pure/fresh-overworld/default-persona; `quest:<id>` and
  non-default personas are accepted only by explicit mock structural runs.

### Certifying the starting slice

First close a fresh 10-player homogeneous provider/model pilot bundle and run
its distinct go/no-go checker:

```bash
npm run fleet -- --provider codex --model gpt-5.6-terra --count 10 --concurrency 4 --seed-base <fresh-pilot-seed-base> --label <fresh-pilot-label> --no-resume --max-retries 0
npm run starting-slice:pilot -- --fleet ai-runs/fleet/<fresh-pilot-label>
```

The pilot requires 10/10 primary unrecovered/no-retry members, unique game and
provider sessions, one exact provider-evidence model value, at least three
recognized Wolf-Winter strategies, and no strategy above 7/10. It writes a
separate pilot artifact and never certifies the slice. If the exact provider
model id changes before authority, repilot. The authority checker validates only
the submitted 100-member bundle; retaining and reviewing the corresponding
fresh same-model pilot is an explicit operational prerequisite, not an
automatically linked field in the authority artifact.

Then close the authoritative 100-player homogeneous bundle and run, for example:

```bash
npm run fleet -- --provider codex --model gpt-5.6-terra --count 100 --concurrency 4 --seed-base <fresh-seed-base> --label <fresh-label> --no-resume --max-retries 0
npm run starting-slice:certify -- --fleet ai-runs/fleet/<label>
```

The certifier reparses and reverifies all reports and sidecars. It requires
exactly 100 unique contiguous planned seeds, no failed/missing slots, one clean
build/world, zero failed attempts or report-recovered members across the closed
histories, the current pure fresh-overworld/default-player contract, and a
homogeneous supported provider/model bound to one exact provider-evidence model
value, with unique game and provider sessions. Malformed or unauthenticated
evidence exits 2; valid evidence that misses a gate exits 1; a pass exits 0.

The exact simultaneous quality gates and Wolf-Winter outcome mapping live in
[`docs/STARTING_SLICE.md`](../docs/STARTING_SLICE.md). The certifier uses the
receipt's initial-goal choice, never `would_replay`; treats absent Wolf completion
as incomplete and death/unknown endings as invalid; and keeps ambiguous issue
scope in-scope. Only this fleet can decide certification—global historical
feedback remains diagnostic. This command defines the later certification run;
the slice remains `active_unproven` until a bundle passes.

## Mock mode — zero-token CI fleet

`--mock` sets `BLIND_AGENT_CMD` to `mock-agent.mjs`, a deterministic
MCP-speaking scripted QA agent with no LLM or tokens. `npm run fleet:mock` is
what CI runs (small acceptance e2e), exercising the structural fleet → verified
reports → `feedback:compile` plumbing on every push. Mock reports are always
`play_mode: structural` and `retention_eligible: false`, even when the script
also exercises the journey state machine.

## Platforms

Works natively on Linux, macOS, WSL, and Windows (PowerShell, cmd, or Git Bash —
`npm run blind` resolves Git Bash itself, so the System32 WSL `bash.exe` can
never hijack the run).

**Passing flags from PowerShell:** PowerShell strips a bare `--` (it's PS's own
end-of-options token), after which npm eats `--flags` as npm configs. The
launcher recovers them automatically, but the reliable shapes are the equals
form without `--` — `npm run blind --smoke --quest=breaking_weir --seed=11` —
or `BLIND_*` env vars. In Git Bash / Linux / macOS,
`npm run blind -- --smoke --quest breaking_weir` also works as usual. These are
structural smoke invocations; omitting `--smoke` from a quest target is rejected
before tokens are spent. One Windows-specific rule the harness already handles:
the MCP server launch never relies on the client honoring a `cwd` field
(`npm --prefix` self-cds instead), because native Windows provider clients may
ignore stdio-server `cwd`. Note a checkout `npm install`-ed on Windows cannot
run under WSL's Linux node (native esbuild binary mismatch) — the runner detects
this and says so instead of failing cryptically.

## Telemetry — measured, not guessed

Every completed run appends one JSONL row (turns, duration, token usage, the
run's NOMINAL API cost — the subscription covers it; it's an efficiency signal,
not a bill) to the gitignored `ai-runs/blind-telemetry.jsonl`:

```bash
npm run blind:telemetry     # per-source summary: runs, mean turns/minutes, tokens, nominal $
```

Recording is best-effort (a telemetry failure never fails the run) and happens
on the built-in Codex pure path. Structural mock runs do not produce a provider
envelope to measure.

## Dedicated Grok Build wave

Grok Build does not go through `run.sh`: this checkout has no Grok session-log
reader capable of proving the complete client tool boundary. It has a separate
operator-attested batch lane for cross-family bug corroboration:

```bash
npm run playtest:grok-wave -- --plan-only
npm run playtest:grok-wave -- --count 100 --concurrency 4
```

The lane pins `grok_cli` / `grok-4.6` / low reasoning effort, refuses dirty
tracked state before spend, gives every child a private native `.grok/config.toml`
whose AdventureForge server runs in pure mode, and parses the Grok NDJSON stream.
The private server writes V2 run evidence; a completed report is accepted only
when its game session, seed, build/world provenance, and exact receipt match that
evidence. The ignored manifest is rewritten after each child and the command exits
nonzero if any requested member is incomplete.

That server proof does not prove which unrelated tools the Grok client may have
been offered from ambient client configuration. The session is therefore honestly
`operator_attested`: useful for issue corroboration, excluded from retention and
clarity metrics. Manual Grok desktop/web sessions continue to use
`npm run playtest:ingest -- --provider grok_desktop ...`.

## How pure blindness is enforced

1. **Isolation.** The agent runs from an isolated temporary directory. File,
   shell, source, and web access are disallowed; it cannot read the repository,
   content, instructions, or solutions. Codex uses its CLI-owned canonical home
   only for subscription/session state while user config, rules, project docs,
   hooks, plugins, skills, apps, and unrelated tools are disabled at launch.
2. **Player-only server.** The runner launches MCP with `--play-mode pure`.
   The exposed tool set contains only human-equivalent world/quest reads and decisions,
   one fresh overworld start, the journey choice, and an authored story-choice
   tool that works only when the same UI choice is due. Raw state, save/import,
   restore, direct quest, validation, replay, generation, and authoring tools
   are absent. Calls after game-confirmed exit are rejected.
3. **Server-authored evidence.** A private JSONL records the fresh start and
   final journey exit, including identical seed, full Git commit, tracked-clean
   bit, and canonical world id/hash, plus exit quest outcomes. The report
   verifier matches their session, provenance, and exact receipt before writing
   a verified evidence-sidecar v2. Model prose cannot relabel a structural run
   as pure.

This mirrors the canonical procedure in [`docs/blind_playtest_protocol.md`](../docs/blind_playtest_protocol.md);
the live [`prompt-overworld.md`](./prompt-overworld.md) carries only the MCP
transport boundary and schema-V2 interview format; current journey contract v3
and the game carry every objective, authored handoff, consequence, and session
rhythm. At an optional Station comparison, its visible read-only `reviewOption`
returns one candidate's consequence/timing and the already-selected departure
terms together; it does not prescribe a route or extra inspection. The
structural-only [`prompt.md`](./prompt.md) is a QA fixture.

## Files

- `run.sh` — the runner: builds the pure MCP config and private evidence path,
  fills the transport-only prompt, runs the selected provider's CLI (one launch
  branch per implemented capture reader: Codex via the strict-stream harness,
  Claude Code via a runner-pinned `--session-id` whose private transcript path is
  exact before launch) from an isolated directory, and verifies the
  report/receipt after game-confirmed exit.
  `--smoke` selects the structural no-LLM path.
- `smoke.mjs` — token-free MCP smoke test via the MCP SDK client: spawn server,
  `tools/list`, exercise overworld and direct quest starts, step a few actions,
  assert. Run
  this anytime to verify the plumbing without spending budget.
- `prompt-overworld.md` — the locked-down live new-player prompt.
- `prompt.md` — the direct-quest prompt retained for non-LLM structural fixtures.
- `prompt-grok-mcp-instant.md` — Grok's search_tool/use_tool transport contract
  and the same terminal pure-V2 interview contract.
- `reports/` — run outputs (gitignored).

## Options

```
--quest <id>     target ONE shipped quest for a structural dev/QA drop-in;
                 requires --smoke (or --mock through fleet), never a live agent
--seed <n>       deterministic seed (default: 7)
--provider <id>  run.sh: codex (default) or claude_code — the providers with a live
                 launch branch here; every other provider is refused before launch
--model <id>     exact catalog id (default: the provider's volume model)
--out <prefix>   report path prefix (default: reports/<stamp>_<source>_seed<n>)
--smoke          run the no-LLM MCP smoke test instead of a real playtest
--overworld      explicit fresh-overworld target (already fixed for pure live play)
--spectate       write the human-watchable feed (watch with: npm run spectate)
--delay-ms <n>   pace every tool response by n ms (implies --spectate)
```

Environment: `BLIND_QUEST_ID` (structural runs only), `BLIND_MODEL`,
`BLIND_TIMEOUT` (seconds, default 1200; technical failure/failsafe, never a play budget),
`BLIND_SPECTATE=1`, `BLIND_SPECTATE_DELAY_MS`, `BLIND_BASH` (Windows: path to Git
Bash if auto-detection fails). `BLIND_CLAUDE_BIN` pins the Claude Code lane to one
absolute executable exactly the way `BLIND_CODEX_BIN` pins the Codex lane.

## Why arbitrary provider overrides are not pure evidence

The canonical live player is the runner-owned Codex launch, defaulting to Spark
inside an isolated temporary directory with file, shell, web, configuration,
and unrelated tools denied. An arbitrary external command may connect only to the player MCP
server yet still retain filesystem or shell access outside MCP; a valid exit
receipt cannot prove that it stayed blind. Therefore `BLIND_AGENT_CMD` is
rejected on live pure runs instead of relying on operator discipline. Additional
providers require an equally hardened adapter and acceptance regression.
Explicit `--smoke` and `--mock` remain non-pure development/QA instruments.
