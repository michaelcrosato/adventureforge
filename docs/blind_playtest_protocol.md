# Blind playtest protocol

> **Any model can be a blind playtester. Only Codex and Claude Code can
> currently be PROVEN blind.** Those are different claims and the difference
> decides how you run a cohort.
>
> Providers are declared in `src/blind/providers.ts` with their playable models in
> operator-owned catalogs under `blind-tester/catalogs/`, and the corpus, triage,
> ranking and intake layers know no vendor names at all — a session from any
> vendor is first-class evidence there.
>
> The launch path is where the asymmetry lives. `runner_enforced` means this
> repo VERIFIED that the agent saw nothing but the AdventureForge MCP tools. For
> Codex that verification is read back out of its own rollout logs by
> `blind-tester/codex-rollout.mjs` (plus `codex-process-anchor.mjs`,
> `codex-pure-envelope.mjs`, `codex-strict-stream.mjs`); for Claude Code it is
> read out of the transcript the runner-pinned `--session-id` names before launch,
> plus the client's own init event, by `blind-tester/claude-session.mjs`. A vendor
> with no such reader-plus-launch-branch pair is refused outright:
> `Provider "<id>" cannot produce pure evidence …`. Until 2026-08-29 that refusal
> did not exist — a `claude_code` or
> `gemini_cli` pure run passed the registry's `headless_cli` gate and then executed
> `codex exec` under the other vendor's name. The only thing that stopped it was
> the unrelated missing-`~/.codex` error, which does not fire on the documented AFK
> machine at all. Structural `--smoke`/`--mock` runs are unaffected: they launch no
> live client, so any provider may exercise the plumbing. The Codex-specific
> sections below describe the deepest of the implemented hardened paths; the
> Claude Code branch mirrors their order (preflight, spawn, capture, envelope,
> verification, publication) with the pinned session id doing the work the rollout
> walk does for Codex.
>
> `gemini_cli` is played through its own client and recorded
> with `npm run playtest:ingest` until the generic runner can audit and launch it.
> Grok Build now has a separate headless `playtest:grok-wave` lane: it verifies a
> private pure server's session, seed, build, world, and receipt, but no reader here
> audits Grok's complete offered client tool surface. All three therefore remain
> `operator_attested`: kept in full and counted toward bug corroboration, but
> excluded from experience metrics. One consequence is worth stating plainly:
> every headline retention and clarity number in this repo measures only the
> runner-enforced vendors — Codex and Claude Code — rather than players in
> general, so check which provider and model a figure came from before
> generalizing it.
>
> `npm run doctor` reports what the generic hardened runner can launch;
> `npm run playtest:grok-wave -- --plan-only` reports the dedicated Grok plan. See
> [`two_loop_workflow.md`](./two_loop_workflow.md).

Blind playtests measure the experience a new player actually receives. They are
Tier 2 of `docs/testing_pyramid.md`: a fresh reasoning agent has no repository,
content, solution, authoring, or diagnostic access and plays only through the
player-facing AdventureForge MCP surface.

The dev loop plays nothing (`docs/two_loop_workflow.md`): routine play is the
playtest loop (`playtest-loop.sh`) running cohorts against each landed build, a
single ad-hoc run is `npm run blind`, and a milestone or feedback harvest uses 100
independent players (`npm run fleet -- --count 100`).

The alternative Grok batch is explicit and never part of the dev gate:

```bash
npm run playtest:grok-wave -- --plan-only
npm run playtest:grok-wave -- --count 100 --concurrency 4
```

It refuses a dirty worktree before model spend, creates one native project MCP
config per child, starts the server with `--play-mode pure` plus V2 provenance,
captures Grok's NDJSON stream, and updates an ignored manifest after each member.
The report must match the private server receipt exactly. This proves the game
run, not the entire Grok client boundary, so the resulting session remains
`operator_attested` and retention-ineligible.

## Two contracts that must not be mixed

### Pure live play (canonical default)

`npm run blind` and every live `npm run fleet` member run with:

- `play_mode: pure`;
- `start_surface: fresh_overworld`;
- the neutral `default` first-time-player persona; and
- one new overworld session, never a restore or direct quest drop-in.

The pure MCP server exposes only actions available through the human game. The
agent receives the same one-screen tutorial, current goal, world/quest state,
legal choices, meaningful-decision count, checkpoint choice, and consequences a
human receives. The harness may explain MCP transport and hash-guard syntax. It
must not prescribe routes, coverage tasks, content targets, solutions, deliberate
invalid calls, or a test-only stopping rule.

### Structural development/QA (explicit only)

Crawler, smoke, and mock paths may inspect structure or use a direct quest start
when their explicit flags say so. They prove plumbing and deterministic
mechanics; they do not simulate a new player. Structural output must be labeled
non-pure and retention-ineligible. It must never satisfy or resume a live pure
fleet member.

## When the runner repairs a receipt, and when it refuses

A pure run's exit interview must carry the journey exit receipt, and the verifier requires
it to deep-equal the receipt the SERVER authored into run evidence. Players restate that
receipt by hand, which means they sometimes fumble it: one observed session played 195
turns and then wrote a `decisionProofHash` with twelve characters dropped out of the middle
of a 64-character value, its prefix and suffix intact. Verification correctly rejected it,
and an entire paid session was discarded over a transcription slip.

The runner may therefore REPAIR such a report, on attempt zero only: it substitutes the
server-authored receipt for the player's, preserves every other byte, and requires the
UNCHANGED verifier to accept the result. The substituted value is the server's, so the
repair cannot invent evidence — it can only restore what the server already recorded. Every
repair is stamped on the binder metadata (`replaced_field`, `binding_count`,
`initial_failure`) and carried onto the session record as `receipt_repair`, because a
repaired session is honest evidence but is not the same thing as a player that transcribed
its own receipt correctly, and a reader deserves to see which one they have.

Repair is available to any provider whose envelope the runner can authenticate; it was
briefly Codex-only, not by policy but because the binder had only one envelope shape it
knew how to check.

What the runner will NOT repair is a receipt that is well-formed and CONTRADICTS the
server. That is not a transcription slip, it is a report of a journey that did not happen,
and substituting the truth underneath it would let the run pass as though the player had
reported accurately. It is a hard failure for every provider. The two cases separate
themselves without a judgement call: a malformed value fails the schema, and a well-formed
wrong value passes the schema and fails the deep-equal.

## The game-native journey contract

The game owns session length. Current contract version 3 has this initial goal,
rendered
identically in UI and MCP:

> Complete Wolf-Winter in Albany.

The proof-hashed goal text stays exactly that short (`INITIAL_JOURNEY_GOAL` in
`src/world/journey_contract.ts`). Its shared terminal/UI/MCP `goalGuidance`
explains the chapter boundary separately: finishing The Wolf-Winter completes the
opening and ends the opening chapter, after which the player chooses End or
Continue into the optional Gallowmere chapter.

The baseline is 40 meaningful accepted gameplay decisions. Fixed checkpoint
thresholds remain 40, 80, 120, 160, and every additional 40. The game offers
the actual continue/end choice at the first safe accepted boundary at or after
the due threshold: embedded combat and dialogue continue without interruption,
with their accepted decisions and proof still accumulating. A terminal state is
safe; otherwise the player's current room must have no active enemy and no
active dialogue. If the current goal is completed earlier, the game offers the
same choice immediately and binds that retention event to the completed goal's
version and id. An overdue checkpoint merges into a goal-completion or
character-death choice. Continuing from a checkpoint advances to the first
fixed multiple strictly after the accepted decision where it surfaced.

A decision is one successfully accepted, consequential gameplay choice shared
by the human and MCP surfaces. Movement, a stateful clue, substantive dialogue,
combat, skill-check attempts, preparation, and other situation changes count.
Context-only LOOK or INVENTORY, repeated narration or examination, dialogue
opening/navigation/closure, unchanged rest or resupply, legal-action listings,
save/export/restore, rejected or stale calls, technical quest foldback, and the
continue/end choice itself do not.
The engine emits the same `countsTowardJourney` classification and reason on
both player surfaces; the harness never infers it from transport calls.

The initial goal completes only when the player successfully completes a quest
whose home is Albany. Discovering or starting a lead, doing a job or event,
visiting a site, or dying inside a quest does not complete it.

Contract v3 carries one versioned current goal plus an ordered completed-goal
history. Completing a goal adds it to that history before the game-owned
continue/end pause. If the player ends, no follow-up state is installed. If the
player continues, the game may present an authored `storyChoice`; selecting one
visible option is an accepted `situation_changed` gameplay decision, persists
its consequence, and activates the next versioned goal. Completing that goal
can therefore trigger another goal-bound retention choice before a fixed
checkpoint. The story choice is distinct from the non-counting continue/end
retention choice.

The opening handoff demonstrates the rule without giving the harness hidden
content knowledge. Wolf-Winter's recorded non-death ending determines truthful
Albany return context and a non-mutating teaser on the initial goal-completion
screen. Only after `continue` does the game offer the player-facing Albany dawn
dispatch choice and install its chosen objective. UI and MCP receive the same
message, option ids, labels, consequences, current-goal text, and goal history.
For every later goal in another town, the shared journey presentation also gives
the next road and remaining route estimate from the player's current location;
the harness adds no navigation advice of its own.

While a continue/end choice is due, further gameplay decisions pause. Choosing
continue records retention evidence and resumes play. Choosing end records the
final retention choice, ends the journey, and returns a signed-by-state receipt
containing the contract version, meaningful-decision count and proof, current
goal, completed-goal history, goal-bound retention history, checkpoints, and
exit reason.

## One pure run

1. Run the deterministic pre-crawl gate: `npm run crawl:smoke`.
2. Start `npm run blind --seed=<fresh>` with a fresh seed. With no provider or
   model given it uses the registry's first provider (`codex`) and that provider's
   catalog default (`"default": true` in `blind-tester/catalogs/codex.json`, currently
   `gpt-5.6-luna`); Spark (`gpt-5.3-codex-spark`) is the cheap volume model and must
   be asked for with `--model`. It launches MCP in `pure` mode and supplies
   a private JSONL evidence path. The runner does not permit an arbitrary
   `BLIND_AGENT_CMD` to claim pure evidence.
3. The player calls `start_overworld` once and plays independently. It follows
   only game-presented goals and choices, including any quest reached naturally
   through the normal `start_overworld_session_quest` bridge. A compact
   `context.quest_starts` tuple is the executable authority for that
   human-equivalent player action; its quest and approach values are passed
   unchanged, with a null approach omitted. `start_world_quest` and any other
   quest drop-in that bypasses the overworld remain forbidden in pure play.
4. At every game-presented journey choice, the player honestly chooses continue
   or end. After continuing, it also answers any game-presented authored story
   choice by passing a visible option id to
   `choose_overworld_session_story`, then follows the resulting current goal. It
   does not stop because of elapsed tool calls or presumed coverage.
5. After the game confirms end and returns the journey receipt, the MCP run is
   closed. The only exception is a response explicitly carrying
   `run_evidence.recorded: false` and `retryable: true`: the player repeats that
   exact parent-session `end` once, makes no other call, and waits for evidence
   confirmation before reporting. A non-retryable recorder failure closes an
   invalid run truthfully. Only then does the harness collect the exit interview.
6. `scripts/verify-blind-report.ts` verifies the V2 pure interview against the
   server evidence using a work-private sidecar. A report counts only when
   fresh-start and journey-exit events share the same session, the receipt
   matches exactly, and the exit is the last gameplay event. After exact raw
   evidence, recovery evidence when applicable, and final Git provenance all
   pass, the runner exclusively copies that private sidecar to adjacent
   `.run.json` as the last, byte-checked publication commit.

The runner's 20-minute timeout is a technical failsafe. A timeout is a failed
run with no retention-eligible interview, not an intended gameplay endpoint.
Likewise, a discoverable `.md` or durable `.evidence.jsonl` without the adjacent
`.run.json` commit marker is an interrupted/rejected pure publication, not a
legacy report. Normal unsuccessful exits remove those unfinished artifacts;
the missing marker keeps hard-kill remnants out of feedback and attendance.

Codex runs reuse the same unchanged evidence verifier and sidecar-last
publication transaction and never start a second model turn. If the attempt-zero
provider report has exactly one final, otherwise-valid pure V2 interview and its
only verifier failure is an invalid or mismatched `journey_exit_receipt`, the
runner may perform deterministic receipt binding. It authenticates the completed
audited Codex envelope, exact original report bytes, current v2 raw evidence,
launch seed/commit/cleanliness, singleton requested model, subjective schema,
and prose ratings; rejects duplicate JSON keys or any other defect; and replaces
only the existing top-level receipt JSON value with the server-authored receipt.
The original provider message remains byte-for-byte in `.json` and
`.initial-report.txt`. Strict `.receipt-bind.json` metadata hashes those inputs,
the receipt, and the bound output; reproduction plus the unchanged verifier must
pass before publication. This is machine evidence binding, not report recovery:
no prose, rating, bug, confusion, verdict, or replay answer may change.
It is available only while the private attempt-zero evidence exists inside the
live publication transaction and never retroactively accepts a historically
rejected report.

The runner starts Codex in an isolated temporary player directory while leaving
subscription state CLI-owned in the operator's existing `CODEX_HOME`; repository
code never opens or copies the login store and never cleans or mutates that shared
home. Standalone report prefixes and fleet report roots are canonicalized outside
it before any directory, lock, or run artifact is created.

Live runs also have a read-only effective-client preflight. The literal default
external command `codex`, or one absolute executable path supplied as
`BLIND_CODEX_BIN`, is resolved once to canonical regular targets and identities.
For the official npm launcher, the frozen closure contains its shim, package
manifest, JavaScript entrypoint, and platform-native payload. Canonical Unix npm
symlinks additionally bind their original path, exact target text, and symlink
identity before realpath resolution. Gameplay executes the pinned native
payload directly instead of traversing that delegation chain. The override is
never parsed as arguments or evaluated by a shell, and there is no alternate
executable/provider fallback. Only a self-contained PE, ELF, or Mach-O override
is supported; unsupported, oversized, foreign, or changed scripts and
JavaScript launchers fail closed. The effective target must return one
`codex-cli <semver>` line for `--version`; the probe has a fixed five-second
timeout, one-second forced-kill grace, and 1,024-byte capture ceiling.

`spark-direct-mcp-v1` and Terra-only `game-direct-mcp-v1` are audited only for
exact `codex-cli 0.146.0`. A different version fails the initial client gate
with exit 42 before provider launch and an actionable `BLIND_CODEX_BIN`
diagnostic. This compatibility restriction does not change the existing
version-pinning policy for strict Sol or Luna runs.

The preflight does not read or interpret `CODEX_HOME/models_cache.json`. Cache
version eligibility, remote refresh, and persistence are selected-client
behavior; a cache written by a different Codex version is an ordinary cache miss,
not a runner compatibility or authentication failure. Repository code never
repairs or deletes that client-owned cache and never inspects login data.
Direct-player launch supplies the exact tracked model-specific
`model_catalog_json`, selecting the CLI's static catalog manager so ambient cache
contents cannot choose shell or tool mode. There is no cache-derived transport
fallback.
`--preflight-only`, used by the shared fleet gate, does not resolve, read, or
enumerate `CODEX_HOME` and creates no report or player artifacts. Fleets perform
that shared 15-second and output-bounded check before directory or lock creation,
then freeze its canonical selected/effective paths, closure token/digest, and
exact semantic version into every member. Each player compares initial,
immediately-pre-launch, and final post-provider bounded probes to that same
authority. Failure is nonretryable, and there is no CLI update, fallback, or
model/provider substitution.

User/project config and
rules are ignored, `project_doc_max_bytes=0` prevents
project-document ingestion, shell/web/apps/plugins/browser/computer/subagents and
the unused shell snapshot are disabled, and only the exact pure AdventureForge
MCP tools are enabled. After the CLI exits, the runner parses the run-owned public
`thread.started` UUID and copies only the filename-matched rollout under
`CODEX_HOME/sessions`. Its private session identity and cwd must match that public
thread and the isolated player directory, so unrelated concurrent Codex sessions
cannot be substituted. Transport is selected by the exact requested model. Exact
`gpt-5.3-codex-spark` uses the audited native `spark-direct-mcp-v1` transport:
code mode and native tool search are disabled, and the exact pure AdventureForge
tool set is preloaded through the tracked game-only player catalog. Spark and
Terra each have one exact model-specific catalog that removes shell, patch,
search, skills, and model-message surfaces; selects native direct tool mode; and
applies the exact game-only base instructions. The same runner flags remove
optional instruction injectors, and the required clean build commit binds the
selected catalog and launch configuration. Terra retains its bundled
10,000-token truncation policy and 272,000-token context capacity; it does not
inherit Spark's 16 KiB byte policy. Exact `gpt-5.6-terra` uses Terra-only
`game-direct-mcp-v1` with the same reduced, game-only native lifecycle and no
code mode or freeform wrapper. Exact
`gpt-5.6-sol` and `gpt-5.6-luna` retain `strict-code-mode-v2`, with
`--enable code_mode_only`. A run cannot silently fall back or cross a
model-specific transport boundary.

All current pure Codex transports fail closed on any `compacted` or
`context_compacted` lifecycle and on any second `world_state` or
`turn_context`. Codex's opaque encrypted replacement history has no locally
verifiable derivation from the audited player-visible transcript. A model
catalog `auto_compact_token_limit: null` preserves the client's default maximum
headroom; it does not establish that compaction is disabled. A journey that
crosses that boundary is useful diagnostic evidence only and cannot publish a
verified pure report.

Spark and Terra begin by calling the preloaded `start_overworld({})` function directly.
Tool search, resource/template discovery, planning/task tools, another MCP
server, non-game tools, or any other unexpected lifecycle event reject the run.
After the start, each native function must remain in the build-attested pure
tool set; its exact name need not be repeated in the immediately prior prose
because its descriptor was preloaded. Current call legality and exact values
remain game-server decisions. IDs are validated for uniqueness and linkage
within their own public or private stream; the two transports use different ID
namespaces. Ordered tool, arguments, status, result, and player-visible output
are cross-bound between streams; the first
game call must be successful `start_overworld({})`.
While that provider process is live, a rejection-only guard reads only
newline-complete public JSONL and the exact UUID-matched private rollout. It can
stop an already-invalid run for a forbidden public server/tool or a complete
private wrapper/lifecycle defect, but never accepts evidence and never rejects
for a missing future row or an in-flight adjacency. The private reader first
binds the rollout filename, open file identity, session id, session cwd, and
turn cwd to the public thread and isolated player directory. A rejection
terminates the runner-owned detached Codex/MCP process tree and publishes no
report, capture receipt, or evidence; fleets classify exit 43 as
`strict_stream_rejected`. If Codex exits first, the guard stops and the
unchanged stable capture plus full selected-transport audit below remain the sole acceptance
authority.
The copied rollout independently audits the transport lifecycle. Strict-code-mode
v2 requires one adjacent `exec -> MCP completion -> visible output` lifecycle
per game call. Each wrapper starts with the exact transport line
`// @exec: {"yield_time_ms": 120000}` and has one canonical awaited AdventureForge
call; aliases, extra statements, `functions.wait`, malformed
literals, or altered visible bytes reject. Spark-direct-mcp-v1 instead requires
adjacent preloaded native
`function_call -> MCP completion -> function_call_output` game lifecycles. In
both transports, public and private rows cross-bind tool, arguments, result,
identifiers, order, count, and exact visible bytes; missing, duplicate,
orphaned, truncated, injected, or mismatched rows reject before publication.
This live prompt requirement does not retrofit a pragma requirement onto
historical evidence. Only schema v1/null-contract evidence retains
the legacy direct-result/content-block renderers; strict v1 requires the exact
historical declaration/emitter and remains subject to the full topology audit.

The private rollout has one finite task/input/context topology, a byte-bound
text-only prompt, and the model-specific prelude profile. Strict Sol uses the v2
`explicitRequestOnly` profile; strict Luna uses its native v1 profile. Their
strict code-mode transport permits progress commentary only when each private
assistant message is immediately paired to the CLI's exact `agent_message`
event, appears either once after the authenticated prompt and before the first
game call or after one visible game result and before the next game call, and
cross-binds in text and order to the public event stream. Exactly one paired
`final_answer` must follow the last visible game result. Native-direct Spark and
Terra instead disable optional context injectors and admit one exact
global-AGENTS input before the bound world, turn, prompt, and user-message rows.
Spark records `multi_agent_version: "disabled"` and `comp_hash: "2911"` under
its custom game-only catalog. Terra's catalog and model-scoped launch record the
reduced Codex 0.146 profile: `multi_agent_version: "disabled"`, no
`multi_agent_mode`, the compatibility-only rollout sentinel `summary: "auto"`,
the exact game-only base instructions, and `comp_hash: "3000"`. Codex 0.146
hard-codes that serialized summary sentinel; its effective turn configuration
instead resolves the explicit runner setting before the catalog default, and the
Responses request omits `reasoning.summary` when that value is `none`. The catalog
and runner both pin that actual request setting to `none`; the catalog additionally
declares the summary parameter unsupported so the request builder cannot send it
even if the setting drifts. The catalog uses a null multi-agent version and the
runner pins `agents.enabled=false`. The verifier also requires every private
reasoning response item to retain an empty summary array. Strict Terra keeps its
v2 team/mode profile. Both direct transports reject every
interim assistant message before the one final interview.
The Terra hash matches the CLI's exact bundled Terra metadata and a retained
exact-0.146 strict-profile capture. A fresh live reduced-profile game-direct
canary must still confirm the repo-owned override before fleet spend; any
mismatch rejects rather than falling back.
Injected permissions, skills,
environment, apps, or collaboration-mode messages reject that profile. These
profiles do not authorize a different transport.
The Luna compatibility does not rehabilitate retained seed `4398`: its capture
still contains unsuccessful gameplay results and its report receipt does not
reproduce authoritative evidence, so it remains unpublished diagnostic data.
Feedback compilation and ledger refresh rerun the full provider authority
validator for current evidence, binding report, envelope, run evidence, provider
session/model, copied rollout, and capture hash. Failure text exposes no hidden
response.
A Codex report outside that single receipt-only case remains rejected and must
use a fresh seed. For a fleet member, the runner also captures the one non-linked
rollout JSONL whose filename and session id match the public `thread.started`
UUID in the CLI-owned home. It verifies that rollout's recorded cwd resolves to
the still-live isolated `player` directory by exact
canonical path and native filesystem identity before publication. It writes an
exclusive `.codex-capture.json` receipt binding the canonical expected/session/turn
cwd values, directory identities, and copied rollout SHA-256. Certification
independently revalidates that strict receipt against the rollout bytes and
requires one `session_meta`, one `task_started`, one `turn_context`, one final
assistant response, and one terminal `task_complete` in order; any abort/error
lifecycle history or row after `task_complete` rejects the run. The lifecycle
shares one turn id, the public thread/session agree, provider is
`openai`, sandbox is read-only, effort is `xhigh`, and both final-message fields
equal the original provider report. For a historical receipt-bound run, Codex
attestation v4 hashes the original report and binding metadata and requires
deterministic reproduction of the verified final report; ordinary Codex v3
attestations remain readable. `turn_context.model` is Codex CLI-recorded selected-model
provenance bound to the artifact, not a provider-signed snapshot proving which
remote backend served the turn. The primary envelope's requested model and
synthesized `modelUsage` are never model authority.
Current Spark capture receipts use schema v4 with
`transport_contract: "spark-direct-mcp-v1"`; Terra game-direct receipts use
schema v5 with `transport_contract: "game-direct-mcp-v1"`; Sol/Luna strict
receipts retain schema v3 with `code_mode_contract: "strict-code-mode-v2"`.
Receipt schemas v1-v4 remain readable for history, but do not establish the
current Terra transport. Current fleet publication uses Codex attestation v9, binding the
selected model-specific transport, frozen effective-client authority and CLI
version, public/private cross-binding, rollout, capture receipt, and provider
facts. Current resume and certification require v9. Codex attestations v3-v8
remain readable historical evidence but cannot be mixed into a new current
cohort.
The receipt is a trusted local runner assertion made while the isolated directory
still exists. Once cleanup deletes that directory, resume and certification can
reparse the receipt and reject inconsistent hashes or fields but cannot re-stat
the old cwd or resist a privileged actor coherently rewriting the entire bundle;
it is neither cryptographic nor provider-signed attestation.

## Pure prompt boundary

`blind-tester/prompt-overworld.md` is the locked live template used with either
the strict fragment or the Terra game-direct fragment;
`blind-tester/prompt-overworld-spark.md` is the compact locked Spark-direct
equivalent. Either may tell the agent how to call the player MCP tools, retain
the initial compact legend and
merge same-response `legend_delta` patches by exact field or dotted result path,
use session ids and state hashes, recognize game-presented continue/end and
authored story choices, and copy the returned receipt. It may not restate hidden
content, recommend an opening route, require particular mechanics or locations,
list defects to hunt, or impose a call/turn/time budget. Gameplay behavior must
come from the game contract. A visible optional-Station `reviewOption` is
transport instruction only: it may return one candidate's consequence/timing
beside authenticated already-selected departure terms, without directing the
player to inspect more candidates or choose either one.

For an embedded quest, pure mode enforces `hide_graph = true`. State-bearing
compact quest start, read, and `step_action` responses default to
`compact_observation = true` and enforce `include_actions = true`, so the same
response carries a bounded `context.actions` menu of current legal ids while
quest play is active. An unchanged hash reply has no context, and a journey-choice
pause suppresses quest actions until that choice is answered. The player replaces
any older menu with the current one and guards `step_action` with
`expected_state_hash = latest state_hash`. `list_legal_actions` defaults to
labeled `{ id, command }` options in pure mode; `compact_actions = true` remains
an explicit id-only transport option. Verbose pure observations likewise
default to labeled `available_actions`. These projections expose only the same
current commands a human sees; they neither select an action nor reveal
authoring structure. `list_legal_actions` is a child-quest tool: the player calls
it only while an embedded quest is active, with the exact current
`rpg_session_id`, never the parent `overworld_session_id`. Ordinary overworld
legal choices already appear in the current overworld response and use their
corresponding overworld tools.

Compact `context.npcs` rows pair each stable authored NPC id with its
player-facing display name as `[npc_id, display_name]`; executable action ids
such as `talk_<npc_id>` remain unchanged.

Pure mode repeats the parent `overworld_session_id` on every successful player
response. While an embedded quest is unresolved, it also repeats the current
child `rpg_session_id`; the two handles are never interchangeable. Missing,
mistyped, stale, or wrong-domain handles receive a structured error containing
the authoritative recoverable handle(s) and the expected field. Starting again
cannot mint a second fresh run, and parent gameplay mutations cannot orphan an
active child. The player copies each exact current handle from the latest
response and never reconstructs, shortens, or hand-types a handle or its suffix.
Pure overworld reads always remain on the compact player surface;
verbose observation, graph, id-catalog, and route-expansion knobs are absent.

A non-null `journey.goalPassage` exposes the optional player movement action
`id: follow_current_goal`. If the player chooses it, the transport binding is
exactly `follow_overworld_session_goal` with the parent `session_id` and latest
`snapshot_hash` passed as `expected_snapshot_hash`; the player never invents, infers, or substitutes a
differently named goal tool. This binding adds no route advice: the game owns
the passage and stops it at the objective, a road choice, or a resource boundary.

Spark's and Terra's tracked player catalogs preload the complete pure tool
descriptor set, remove coding surfaces, and select direct native function calls. The audit
requires the first call to be exact `start_overworld({})` and every later call to
remain inside that build-attested set; a legal tool does not have to be named in
the preceding result because its descriptor was already visible at start. The
pure server still decides whether each current call, handle, hash, id, and
argument is legal. Complete outputs are cross-bound byte-for-byte; any client
truncation marker or public/private mismatch rejects the run.

At the build bar, a regression launches the real pure MCP server, reads its
actual `tools/list`, projects the canonical build catalogue shape
`{name, description, input_schema}`, and requires every description and input
schema to match a reviewed digest. It does not claim to reproduce Codex's
provider-specific namespace wrapper or outbound request. The required clean
commit binds that server, regression, catalog, and runner at launch. The copied
Codex rollout does not contain the preloaded descriptor catalogue, so catalogue
authority is explicitly build-bound rather than provider-signed runtime proof.

Direct-model fingerprints hash the selected model's prompt template, model
catalog, transport fragment, runner, filler, and audits. Strict-model
fingerprints instead hash the strict prompt/fragment and never inherit a direct
catalog. This makes any profile-input drift invalidate admission before a cohort
spends model tokens.

A non-death terminal quest step folds its result back automatically and stops
echoing the child. A death ending does not complete that quest or resurrect the
character: it retains the ended child and opens an end-only journey pause on the
parent. Choosing `end` produces the normal read-only exit receipt with the
current goal still active and `character_died` in its exit reasons. The separate
technical quest-completion tool is therefore absent from pure mode. Both
terminal responses retain the parent handle, and only the death receipt retires
the ended child. Save/restore binds this terminal to the exact unfinished quest,
fatal ending id, accepted-decision count, and full journey decision proof.

The runner enforces this boundary independently of the prose prompt:

- live quest targets and non-default personas are rejected before model launch;
- the MCP server exposes a pure allowlist and permits one fresh start;
- session recovery echoes only the singleton parent and its current unresolved
  child, never handles from full-mode or unrelated sessions;
- authored choices are available only when the same player-facing choice is due;
- authoring, validation, raw state, save/import/restore, direct quest, and other
  structural tools are absent;
- calls after a confirmed journey exit are rejected; and
- evidence metadata is written by the server, not trusted from model prose.

## Exit interview and evidence

The report ends with one fenced `json exit-interview` block. A pure report uses
schema V2 and includes:

```json
{
  "schema_version": 2,
  "issue_consistency_version": 1,
  "play_mode": "pure",
  "start_surface": "fresh_overworld",
  "retention_eligible": true,
  "journey_exit_receipt": {},
  "clarity": 3,
  "enjoyment": 3,
  "goal_understood": true,
  "got_stuck": false,
  "confusions": [],
  "bugs": [],
  "best_moment": "one line",
  "worst_moment": "one line",
  "would_replay": true,
  "verdict": "one paragraph"
}
```

Current pure, cycle, and certification reports must declare
`issue_consistency_version: 1`. Every explicit S0-S4 finding anywhere in the
report prose must be mirrored by a same-severity `bugs[]` entry with a
recognizable place or concern identity; distinct concerns require distinct
entries. Marker-absent historical V2 reports remain readable by generic
historical readers.

The player copies `journey_exit_receipt` verbatim from the confirmed end
response. The verifier cross-checks it against server-authored evidence and
writes a verified `.run.json` sidecar. Manifest and summary rows retain play
mode, start surface, contract version, meaningful decisions, current and
completed goals, checkpoint/goal choices, exit reason, and evidence status. The
continue/end decisions themselves are the primary retention signal;
`would_replay` remains the post-exit attitudinal question.

Evidence-sidecar schema v2 also binds the run to its private integer seed, full
40-character Git commit, tracked-worktree cleanliness, canonical world id/hash,
and sorted quest outcomes. The server writes the same seed/build/world at fresh
start and journey exit; any mismatch fails verification. This sidecar version is
separate from report schema V2 and journey contract v3. Generic readers keep
historical evidence-sidecar schema v1 readable for old feedback, but v1 lacks
the provenance needed for an authenticated current fleet.

`npm run feedback:status` verifies stable report identities against the last
outer-gate-accepted manifest. When its actionable threshold is ready,
`npm run feedback:compile` writes cumulative `retention.json` beside the ranked
fresh-cohort hot spots and digest-bound `report-manifest.json`; the manifest is
not authoritative until a later outer-gate seal records its exact digest in
committed loop state. Retention separates pure, structural, and legacy-guided
report counts and aggregates only sidecar-verified pure continue/end choices. Pure
decision counts, checkpoint choices, and continuation curves are grouped by
the receipt's journey-contract version; historical v1 and v2 evidence remains
valid but is never pooled with current v3 evidence.
Character-death exits remain valid observational evidence but are classified in
their own `character_died` trigger buckets, never as voluntary checkpoint or
goal-completion retention. `character_died` is an additive current-v3 reason, so
this separation is reason-level rather than something the contract-version cohort
provides by itself. Starting-slice certification rejects death exits explicitly.

Legacy interview-schema V1/guided reports may remain in historical feedback
compiles, clearly labeled as such; they never count as pure retention evidence.
Previously verified schema-V2 pure reports carrying journey-contract-v1 or v2
receipts remain valid historical pure evidence in their own cohorts, but cannot
resume a current-contract fleet slot.

## Fleet mode

Fleet attestation retains read-only support for historical Claude/Sonnet cohorts.
Current homogeneous Codex cohorts use exactly `gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna`, or `gpt-5.3-codex-spark`. Codex aliases, fallback, and
mixed-model plans are forbidden.

```bash
npm run fleet -- --admission-canary --label <fresh-spark-admission-label> --out <separate-report-dir> --seed-base <fresh-spark-seed-base>
npm run fleet -- --provider codex --model gpt-5.3-codex-spark --count <n-greater-than-3> --admission-receipt ai-runs/fleet/<fresh-spark-admission-label>/admission.json --seed-base <fresh-seed-base> --label <fresh-label> --no-resume --max-retries 0
npm run fleet -- --provider codex --model gpt-5.6-terra --count 10 --concurrency 4 --seed-base <fresh-pilot-seed-base> --label <fresh-pilot-label> --no-resume --max-retries 0
npm run starting-slice:pilot -- --fleet ai-runs/fleet/<fresh-pilot-label>
npm run fleet -- --provider codex --model gpt-5.6-terra --count 100 --concurrency 4 --seed-base <fresh-seed-base> --label <fresh-label> --no-resume --max-retries 0
```

Before expanding live Spark spend or accepting a Spark transport change, run the
isolated admission canary. It plans three serial, fresh-overworld,
neutral-persona Spark pure runs with no resume and no retries; the first failure
suppresses every remaining unlaunched slot, while a pass launches and verifies
all three. It writes an `admission.json` marked `certification_eligible: false`.
It is a transport go/no-go gate, not a pilot or certification cohort; use a
fresh label and an output directory outside the fleet bundle. Every live Spark
fleet larger than three must provide that receipt. Before filesystem side
effects or player launch, the fleet recomputes its pass/count invariants and
requires an exact match on clean build and world identity, transport
fingerprint, selected model, Codex CLI/client authority, and pure gate
configuration. Any drift requires a fresh canary.

Every live member is the same canonical pure contract with a different seed
(and, for diagnostic experiments, optionally a different model). Pure fleets
use the neutral default persona; persona mixtures are structural experiments
only. The fleet command defaults to Codex with homogeneous
`gpt-5.3-codex-spark` for ordinary feedback harvests; canonical certification
commands pin Terra for both pilot and authority. All four exact Codex model ids
listed above are eligible when their CLI rollout provenance verifies.

Before any live member launches, preflight freezes one full tracked Git commit,
the canonical fresh-overworld world id/hash, the contiguous planned seeds, and
the run/model contract. The tracked worktree must be clean; dirty state or a Git
or world-provenance error aborts before tokens are spent. Untracked local notes
are ignored by the cleanliness test. The runner repeats that exact build capture
at every slot boundary and immediately before every token-spending attempt. Those
check-and-spawn starts are serialized through one fleet-wide abort gate: the
first drift blocks every queued sibling slot and retry while already-started
players are allowed to settle. On Windows, the real launcher is created
suspended and assigned to its Job Object while that gate remains held. The
runner repeats the build capture after the custody-ready receipt, resumes only
an exact match, and waits for the provider-started receipt before releasing the
gate.

On `SIGINT` or `SIGTERM`, persistent handlers first block new starts, terminate
the tracked process tree, and wait for every spawned child to close. POSIX
launchers run in their own process group and the group must be proven absent.
Windows launchers are created suspended, assigned to a kill-on-close Job Object,
and resumed only after assignment; the anchor verifies that the Job Object's
active-process count reached zero. Only then may report and cohort locks be
released. An error event, bare root-process close, or unsettled descendant is
not treated as proof of closure and leaves cleanup fail-closed.

Each plan and lock row records the exact provider and model. Each live fleet
label must be fresh and names one closed cohort. An existing
label directory is rejected rather than appended to or mixed with stale rows.

#### Cross-worktree cohort ledger

Before a live pure fleet creates its report directory, it resolves the exact
Git worktree root and uses the shared Git common directory's
`adventureforge-fleet-cohort-ledger/` registry. That registry has only the
short-lived `active-fleet.lock` lease and immutable `intents/*.json` records.
The lease rejects every concurrent start unconditionally, including a lock that
looks old or has malformed/dead-looking contents: the runner never probes a PID,
checks a timestamp, or recovers a lease automatically. Structural `fleet:mock`
runs do not enter this live-cohort ledger.

After the normal executable/build preflight, a live plan derives canonical exact
member fingerprints and its cohort fingerprint from the captured clean-build
identity at preflight, client authority, contract, and every planned member
identity. Once it holds the active lease and report lock, it scans every
persisted intent. Any exact, partial, or superset member overlap stops the run. The only acknowledgement is
`--allow-duplicate-cohort <current-cohort-fingerprint>`; it is accepted only
for one or more persisted _exact_ cohort matches, never for a partial/superset
overlap, no-overlap invocation, mock fleet, or active lease.

The runner atomically publishes one no-clobber canonical intent before its pool
starts. It includes every member identity plus local audit fields: stamp, label,
canonical worktree root, the explicit duplicate override, and the sorted prior
intent/member overlap evidence. These audit fields never change the cohort or
member fingerprints. A failed start before publication removes only the empty
label directory it created and releases the report lock then the lease. After
publication the intent remains conservative even if a later startup/pool step
fails; normal clean completion releases the active/report locks but never
rewrites or deletes an intent.

If exclusive lease acquisition itself faults after creating the lock, the runner
first verifies its random lease token and attempts to remove only that owned
lock; an incomplete rollback is reported rather than hidden. This is separate
from stale-lock recovery, which remains manual.

If a process is killed while `active-fleet.lock` remains, first verify that no
fleet runner or child launch is still active. Only then may an operator manually
remove that one lock from the shared Git-common registry and retry. Do not delete
or edit intent records as routine recovery: a stranded intent intentionally
requires the exact duplicate acknowledgement above. Malformed, symlinked,
multiply-linked, or unexpected registry records fail closed and require manual
inspection rather than automatic cleanup.

This ledger protects against ordinary accidental duplicate or overlapping live
starts across linked worktrees. It does not create an immutable execution
snapshot or isolate later filesystem/client drift; the existing runner
preflight and per-member verification retain their separate responsibilities.

Bounded concurrency and normal retry/backoff remain deterministic. Before each
retry, the runner copies every failed out-prefix artifact and its diagnostic into
a per-seed/per-attempt bundle archive indexed by byte count and SHA-256. Strict
stream exit 43 is terminal: it publishes no playtest and is never retried.
Manifest rows retain the complete ordered attempt history; summary timeout/failure
counts cover every attempt, including failures before an eventual success. Such a
label closes nonzero and is ineligible for certification. Resume remains the
default for diagnostic fleets, but every resume-enabled bundle and every skipped
slot is non-certifying. A fresh authoritative label must run all slots with
`--no-resume --max-retries 0`; historical successes cannot be relabeled into it.
The current Codex launcher has no model-recovery turn. Historical
report-only recovery remains readable only when it has the complete adjacent
`.initial-report.txt`, `.repair.meta.json`, and `.repair.json` set, and must
deterministically reproduce the accepted report bytes. The text suffix keeps
the rejected response out of feedback `*.md` discovery. It remains diagnostic
evidence only: its confusion, bug, stuck, and replay-intent answers were not
byte-bound to the primary report. Diagnostic resume may reuse a report only
when an independent reverify finds evidence-sidecar
schema v2, the current journey contract, exact planned seed, and exact clean
commit and world id/hash. Historical sidecar v1 remains readable but never
resumes a slot. Manifest rows expose the authenticated seed, build, world, quest
outcomes, and journey result rather than relying on a filename or summary count.
An adjacent runner-owned attestation binds each live member to its planned
provider/model, selected model-specific transport, exact singleton model
provenance, unique provider session, completed clean primary envelope, game
session, and artifact hashes. Current Codex v9 additionally binds actual
provider, reasoning effort, turn id, working directory, public provider events,
copied rollout JSONL, cross-bound capture receipt, receipt-binding provenance,
exact CLI version, and fleet-wide effective-client authority. Diagnostic resume
can reparse historical evidence; current resume and certification require v9 and
reject reuse, links, path escape, model recovery, or a transport mismatch.
Historical Claude v2 and Codex v3-v8 attestations remain readable only; v8
retains its original Spark-direct/strict-Sol-Terra-Luna meaning.

### Starting-slice certification

Before the authority spend, close and validate a fresh ten-Terra pilot:

```bash
npm run fleet -- --provider codex --model gpt-5.6-terra --count 10 --concurrency 4 --seed-base <fresh-pilot-seed-base> --label <fresh-pilot-label> --no-resume --max-retries 0
npm run starting-slice:pilot -- --fleet ai-runs/fleet/<fresh-pilot-label>
```

The pilot requires 10/10 primary-subjective/no-model-recovery/no-retry reports, unique game and
provider sessions, one exact provider-evidence model value, recognized Wolf-Winter outcomes, at
least three strategy families, and no family above 7/10. It checks the other
slice gates but writes a distinct readiness result and can never certify the
milestone. If the exact provider model id later changes, repilot. The authority
checker validates only its submitted homogeneous 100-member bundle; the
corresponding fresh same-model pilot remains an explicit operational gate that
operators retain and review, not an automatically linked authority field.

After the authoritative live cohort is closed, run:

```bash
npm run starting-slice:certify -- --fleet ai-runs/fleet/<label>
```

The certifier independently reparses every authenticated artifact. It requires
exactly 100 unique contiguous planned seeds, no failed or missing slots, the
default pure fresh-overworld contract, `--no-resume`, exactly one verified
attempt per slot, zero skipped/resumed or report-recovered slots, and the
homogeneous supported provider/model plan bound to one exact provider-evidence
model value, with unique game and provider sessions, on one clean build/world. Malformed or unauthenticated evidence
exits 2, an authenticated cohort that misses a threshold exits 1, and a pass
exits 0.

The exact numeric gates and Wolf-Winter ending-to-strategy mapping are the
certification contract in [`STARTING_SLICE.md`](STARTING_SLICE.md). In
particular, `would_replay` is not continuation, `after_blood` is a lure hybrid
recovery, a missing Wolf outcome is incomplete, and a death or unknown Wolf
ending invalidates the bundle. Issue scope is conservative: ambiguity remains in
scope. Only issues in this exact authenticated cohort can decide the severity
gates; global historical feedback and compiler clusters are diagnostic context,
not certification evidence. These checks define a future certification run and
do not claim that the current slice has passed.

`npm run fleet:mock -- --count 2` is the zero-token CI pipeline. It is explicitly
structural even when it exercises the same journey mechanics. Direct quest
targets are allowed only on such mock/smoke/crawler paths.

## Feedback handling

Reports are evidence, not votes. Keep positive reports, but inspect suspicious
score/persona patterns through compiler telemetry. Reproduce concrete mechanical
claims deterministically before changing code. Classify fixes as content,
hint-text, quest structure, engine rule, validator, or test work, then let the
assessor rank the next focused loop increment.

Fixes follow **trust, but verify** with **no human-approval gate**: an
`engine_rule` change is locked by the relevant `validator` and `schema` checks,
plus focused regressions and the unchanged health bar.
