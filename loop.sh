#!/usr/bin/env bash
# The DEV loop driver. Usage: ./loop.sh [--once]   (protocol: docs/afk_loop.md)
#
# ANY MODEL CAN RUN THIS LOOP. The driver resolves whichever supported headless
# coding agent is installed (see DEV_AGENT_IDS below) without inspecting credential
# files; AI_AGENT names one explicitly and AI_AGENT_CMD overrides the command
# outright. No vendor is privileged, and adding one is a single table entry.
#
# This loop DOES NOT PLAY THE GAME. Blind playtesting is a separate, independently
# paced loop (playtest-loop.sh). Its corroborated findings arrive here as submissions
# in intake/queue/ — the same queue an audit agent, a research proposal, the crawler,
# or a person files into, because playtest feedback is not the only way the game
# changes. That split is the point: this loop used to spend most of its wall
# clock blocked on one blind playthrough of the exact commit under test, which
# capped throughput at roughly one change per playtest. Now the mechanical bar —
# crawl, health, verifier integrity — is the whole gate, and quality evidence
# arrives asynchronously from a fleet that never has to wait for a build.
#
# Env knobs (defaults in brackets):
#   AI_AGENT=<id>                    pick a dev agent by id (codex|claude|gemini) [auto-detect]
#   AI_LOOP_IDLE_WHEN_EMPTY=1        wait for queued work instead of falling back to the
#                                    assessor's own candidates [0]
#   AI_LOOP_IDLE_POLL_SECONDS=N      how often to re-check the queue while idling [300]
#   AI_LOOP_TRIAGE_STORE=<dir>       triage this shared playtest corpus at cycle start,
#                                    so QA worktrees never have to sync tickets []
#   AI_LOOP_COMMIT=1                 provisional + final-ledger commits [0 = evidence-only]
#   AI_LOOP_PUSH=1                   push after commit [0]; see the push note below
#   AI_LOOP_MAX_CYCLES=N             stop after N cycles [unbounded]
#   AI_LOOP_STOP_FILE=<path>         touch this file to stop cleanly at the next cycle
#                                    boundary; cleared at startup [ai-runs/loop.stop]
#   AI_LOOP_DELAY_SECONDS=N          pause between cycles [10]
#   AI_AGENT_CMD="..."               explicit full agent command (overrides the registry)
#   AI_CODEX_SANDBOX=...             sandbox for the codex entry only [workspace-write]
#   AI_AGENT_TIMEOUT_SECONDS=N       hang-kill budget per agent turn [2400]
#   AI_LOOP_FULL_HEALTH=1            force the FULL health bar even when the cycle's
#                                    diff does not require it [0 = read it off the diff]
#   AI_LOOP_MAX_CONSECUTIVE_FAILURES / AI_LOOP_MAX_TOTAL_FAILURES   breakers [5 / 15]
#   AI_LOOP_FAILURE_LEDGER_MAX_ENTRIES=N   retained durable failure records [100]
#   AI_LOOP_ALLOW_DIRTY=1            allow risky dirty commit-mode start; never waives clean evidence [0]
#   AI_LOOP_ALLOW_VERIFIER_EDITS=1   acknowledge a deliberate verifier change [0]
#   AI_LOOP_COMMIT_MESSAGE="..."     final ledger commit message override
#
# Companions: npm run loop:status / loop:stop (project-scoped, pid-file based).
# loop-status.sh's breaker/velocity telemetry reads ai-runs/wrapper.log, which
# this script does NOT write — launch with `./loop.sh 2>&1 | tee ai-runs/wrapper.log`
# when you want that telemetry.
set -euo pipefail

cycles="${AI_LOOP_MAX_CYCLES:-}"
once=0
if [[ "${1:-}" == "--once" ]]; then
  once=1
fi

# Refuse to start on a dirty tree: _revert_failed_cycle hard-resets tracked work
# to the cycle-start ref. It snapshots preexisting untracked paths and deletes
# only untracked paths created during the failed cycle, but it cannot restore a
# preexisting untracked file the agent stages/commits, edits, moves, or removes.
# Commit-mode scratch is committed (green) or reverted (red); evidence-only mode
# stops once it leaves pending work. AI_LOOP_ALLOW_DIRTY=1 opts back in deliberately
# for commit mode — the operator accepts those reset/mutation risks. It NEVER waives
# the exact-clean start an evidence-only cycle requires before it commits.
if [[ "${AI_LOOP_ALLOW_DIRTY:-0}" != "1" ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to start: the working tree is dirty, and a failed cycle's"
  echo "self-recovery would hard-reset tracked edits. Cycle-created untracked"
  echo "paths are cleaned from a start-of-cycle snapshot, but existing untracked"
  echo "files cannot be restored if the agent stages, mutates, or moves them."
  echo "Commit or stash first, or set AI_LOOP_ALLOW_DIRTY=1 to accept the risk."
  exit 1
fi

# ── Graceful stop (AI_LOOP_STOP_FILE) ────────────────────────────────────────────
# Landing a repo change while an UNBOUNDED loop runs used to mean one of two bad
# options: catch the inter-cycle sleep, which is ten seconds by default, or kill a
# cycle mid-flight and throw away a worker turn that had already cost real money.
# Neither is a boundary. A file the operator can touch at any moment is one: the loop
# finishes what it is doing, pushes it, and exits 0 at the next safe point, so "stop
# after this cycle" costs nothing and loses nothing.
#
# It is checked twice. Before a cycle begins, so a stop never starts work it would
# throw away; and again after a cycle returns — which is after its push, the last
# thing run_cycle does — so a landed cycle stops immediately instead of racing the
# delay. Both are outside run_cycle on purpose: a stop is an operator decision about
# the SCHEDULE, and must never be able to fail a cycle or alter its gates.
#
# The file is CLEARED at startup rather than honoured. One left behind by an earlier
# run would otherwise stop the next launch before it did anything, which looks exactly
# like a loop that failed to start — the most confusing possible failure for a knob
# whose whole job is to make stopping predictable.
STOP_FILE="${AI_LOOP_STOP_FILE:-ai-runs/loop.stop}"
stop_requested() {
  [[ -e "$STOP_FILE" ]]
}

clear_stop_request() {
  rm -f -- "$STOP_FILE" 2>/dev/null || true
}

# ── Project-scoped PID files (so orchestrator tooling tracks THIS loop only) ──────
# With several projects running identical-looking `./loop.sh` / headless-agent processes,
# pattern-matching across all of them is unsafe (mis-reads + risks killing another
# project's loop). loop.sh records its OWN pid here; run_agent records the actual
# worker pid. scripts/loop-status.sh and scripts/loop-stop.sh act ONLY on these pids.
LOOP_PID_FILE="ai-runs/loop.pid"
AGENT_PID_FILE="ai-runs/agent.pid"
AFK_PROC_ROOT="/proc"

# A pid alone is not an identity: after a crash leaves a stale file, the kernel may
# reuse that number for an unrelated process. Linux exposes a process's immutable
# start tick in /proc/<pid>/stat field 22. Record both values and require both before
# status/stop trusts the record. Systems without a compatible /proc fail closed: the
# unattended loop refuses to start rather than creating a record that cannot be
# authenticated later.
process_start_time() {
  local pid="$1" stat tail start
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -r "$AFK_PROC_ROOT/$pid/stat" ]] || return 1
  stat="$(<"$AFK_PROC_ROOT/$pid/stat")" || return 1
  [[ "$stat" == *") "* ]] || return 1
  # The comm field is parenthesized and may contain spaces. Strip through its LAST
  # closing ") "; the remaining token 20 is original field 22 (starttime).
  tail="${stat##*) }"
  set -- $tail
  [[ "$#" -ge 20 ]] || return 1
  start="${20:-}"
  [[ "$start" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$start"
}

write_process_record() {
  local path="$1" pid="$2" start
  start="$(process_start_time "$pid")" || return 1
  printf '%s %s\n' "$pid" "$start" > "$path"
}

cleanup_pid_records() {
  rm -f "$LOOP_PID_FILE" "$AGENT_PID_FILE" 2>/dev/null || true
}

# A second loop in the same checkout is destructive, not merely confusing: a failed
# cycle hard-resets tracked work and cleans cycle-created untracked paths, so loop B
# would revert loop A's provisional commit mid-flight. The pid record carries the
# start tick precisely so this check can tell a LIVE holder from a stale file left
# by a crash (dead pid, or pid reused by an unrelated process) — stale records are
# overwritten as before; only an authenticated live holder refuses startup.
refuse_if_live_loop() {
  local path="$1" pid recorded_start start rest
  [[ -f "$path" ]] || return 0
  read -r pid recorded_start rest < "$path" 2>/dev/null || return 0
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  start="$(process_start_time "$pid")" || return 0
  [[ "$start" == "$recorded_start" ]] || return 0
  echo "Refusing to start: $path names a live loop (pid $pid, start tick $start)."
  echo "Two dev loops in one checkout destroy each other's cycles. Stop the running"
  echo "one with 'npm run loop:stop', or run this lane in its own git worktree."
  return 1
}

on_loop_signal() {
  local status="$1"
  cleanup_pid_records
  trap - EXIT INT TERM
  exit "$status"
}

mkdir -p ai-runs
refuse_if_live_loop "$LOOP_PID_FILE" || exit 1
if ! write_process_record "$LOOP_PID_FILE" "$$"; then
  rm -f "$LOOP_PID_FILE" 2>/dev/null || true
  echo "Refusing to start: cannot authenticate this process through /proc/<pid>/stat."
  echo "The AFK loop requires PID + process start-time identity so a stale pid file"
  echo "can never target an unrelated reused process."
  exit 1
fi
trap cleanup_pid_records EXIT
trap 'on_loop_signal 130' INT
trap 'on_loop_signal 143' TERM
clear_stop_request

# The worker-recording shell below inherits these helpers before it execs the real
# agent. exec preserves its pid and start time, so the record stays valid for the
# lifetime of the worker it names.
export AFK_PROC_ROOT
export -f process_start_time write_process_record

if [[ ! -d node_modules ]]; then
  npm install
fi
if [[ ! -d ui/node_modules ]]; then
  npm --prefix ui install
fi

require_clean_evidence_cycle_start() {
  # Pure evidence must name one exact revision. The startup guard runs only once,
  # so enforce this again at EVERY evidence-only cycle boundary; in particular,
  # do not let continuous mode call a prior cycle's dirty tree another success.
  [[ "${AI_LOOP_COMMIT:-0}" != "1" ]] || return 0
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Evidence-only cycle requires an exact-clean worktree at cycle start."
    echo "Commit, stash, or discard the pending work before collecting another baseline;"
    echo "AI_LOOP_ALLOW_DIRTY=1 does not waive pure-play evidence provenance."
    return 1
  fi
}

remove_new_untracked_since_cycle_start() {
  # Input is a NUL-delimited `git ls-files --others --exclude-standard` snapshot.
  # Compare exact path strings, then ask Git to clean only paths absent from that
  # snapshot. This covers src/docs/ui/scripts/bin/etc without broad directory wipes
  # and never selects a snapshot-listed path for cleanup under the dirty override.
  local snapshot="$1" current_snapshot path known existed
  local -a before=() current=() created=()
  if [[ ! -f "$snapshot" ]]; then
    echo "Missing cycle-start untracked snapshot; refusing broad cleanup."
    return 1
  fi
  mapfile -d '' -t before < "$snapshot" || return 1
  current_snapshot="$(mktemp)" || return 1
  git ls-files --others --exclude-standard -z > "$current_snapshot" || {
    rm -f -- "$current_snapshot"
    return 1
  }
  mapfile -d '' -t current < "$current_snapshot" || {
    rm -f -- "$current_snapshot"
    return 1
  }
  rm -f -- "$current_snapshot"
  for path in "${current[@]}"; do
    existed=0
    for known in "${before[@]}"; do
      if [[ "$known" == "$path" ]]; then
        existed=1
        break
      fi
    done
    [[ "$existed" == "1" ]] || created+=("$path")
  done
  if (( ${#created[@]} > 0 )); then
    git clean -fdq -- "${created[@]}"
  fi
}

latest_prompt() {
  # ai-loop.ts writes the cycle prompt as prompt.md (older runs used agent-prompt.md).
  # Newest first by mtime through POSIX `ls -t`: GNU find's printf action is absent on macOS
  # and BSD, where the old form printed nothing and was misread as a missing agent
  # prompt (bug_0613).
  find ai-runs \( -path '*/prompt.md' -o -path '*/agent-prompt.md' \) -type f -exec ls -t {} + 2>/dev/null | head -n 1
}

# ── Dev-agent registry ───────────────────────────────────────────────────────────
# The contract an entry must satisfy — the ONLY things this loop assumes about the
# agent, and therefore everything you need to add a vendor:
#
#   1. reads its instructions from STDIN (never argv: the cycle prompt is long, and
#      argv leaks it into the process table)
#   2. can create and edit files in $PWD, and run the repo's own commands
#   3. runs to completion non-interactively, with no approval prompt
#   4. exits 0 on success and nonzero on failure — a nonzero exit fails the cycle,
#      because partial output is not evidence the requested work completed
#
# Anything meeting that contract works, whether or not it is listed here. The list
# exists so the common cases need no configuration, not to restrict the field.
#
# Flags are operator-verifiable: CLIs change, and a wrong flag here should be a
# one-line fix rather than a reason to distrust the loop. Confirm yours once with
# `AI_AGENT=<id> AI_LOOP_MAX_CYCLES=1 ./loop.sh`.
# The list itself lives in dev-agents.json, which bin/doctor.ts reads too. It used to be
# duplicated here and there, in an order doctor.ts's output depended on, with nothing
# checking the two copies agreed.
DEV_AGENT_REGISTRY="$PWD/dev-agents.json"
# The node used to read that JSON. An absolute override exists for the same reason
# blind-tester/run.sh has BLIND_NODE_CMD: a caller that has node but cannot put its
# directory on PATH must still be able to resolve an agent. It matters for the driver
# gates in particular, which run agent selection with an EMPTY PATH so that only their
# own stub functions can satisfy `command -v <agent>` — exposing node's directory there
# would also expose whatever agent binaries share it.
AI_LOOP_NODE_CMD="${AI_LOOP_NODE_CMD:-node}"

# Read one field of one agent entry. Prints nothing and returns 1 for an unknown id, so
# every caller keeps the "not a known dev agent" behaviour the case statements had.
dev_agent_field() {
  local id="$1" field="$2"
  "$AI_LOOP_NODE_CMD" -e '
const { readFileSync } = require("node:fs");
const [file, id, field] = process.argv.slice(1);
let agents;
try {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  agents = Array.isArray(parsed.agents) ? parsed.agents : null;
} catch {
  process.exit(2);
}
if (!agents) process.exit(2);
const agent = agents.find((candidate) => candidate && candidate.id === id);
if (!agent || typeof agent[field] !== "string" || agent[field] === "") process.exit(1);
process.stdout.write(agent[field]);
' "$DEV_AGENT_REGISTRY" "$id" "$field"
}

# Auto-detect precedence. A registry that cannot be read yields an EMPTY list rather than
# a guessed one: the loop then reports "no supported dev agent" and stops, which is the
# honest outcome. Silently falling back to a built-in list would mean a corrupted
# registry still launched an agent the operator did not configure.
dev_agent_ids() {
  "$AI_LOOP_NODE_CMD" -e '
const { readFileSync } = require("node:fs");
try {
  const parsed = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
  process.stdout.write(agents.map((a) => a && a.id).filter((id) => typeof id === "string" && id).join("\n"));
} catch {
  process.exit(0);
}
' "$DEV_AGENT_REGISTRY"
}

mapfile -t DEV_AGENT_IDS < <(dev_agent_ids)

dev_agent_binary() {
  dev_agent_field "$1" binary
}

dev_agent_command() {
  local template
  template="$(dev_agent_field "$1" command)" || return 1
  # Placeholders become QUOTED POSITIONAL REFERENCES, never the values themselves
  # (bug_0632, intake cdae46f8). run_agent executes this string with `bash -c`, so a value
  # spliced in here would be re-parsed as shell: a repo path with a space split `--cd`
  # into two words, and one containing `;` or `$(...)` ran as a command. launch_agent
  # passes the values as $1 (cwd) and $2 (sandbox), which bash expands as single words
  # and never parses again.
  template="${template//\{CWD\}/\"\$1\"}"
  template="${template//\{SANDBOX\}/\"\$2\"}"
  printf '%s' "$template"
}

# Resolve the headless agent that does each cycle's WORK. Precedence:
#   1. $AI_AGENT_CMD  — explicit full command, wins over everything
#   2. $AI_AGENT      — a registry id; fails loudly if that agent is not installed,
#                       because silently substituting another vendor would make the
#                       cycle ledger claim work an agent never did
#   3. auto-detect    — first installed agent in DEV_AGENT_IDS order
#   4. none installed — evidence-only: the prompt is written, no work is done
agent_cmd() {
  if [[ -n "${AI_AGENT_CMD:-}" ]]; then echo "$AI_AGENT_CMD"; return 0; fi

  if [[ -n "${AI_AGENT:-}" ]]; then
    local requested_bin
    # An explicitly requested agent that cannot run FAILS the resolution (and the
    # cycle) rather than degrading to an agent-less pass: the operator asked for
    # specific work to happen, and "loudly" must mean the exit code, not just a
    # stderr line a detached loop never shows anyone.
    if ! requested_bin="$(dev_agent_binary "$AI_AGENT")"; then
      echo "AI_AGENT=\"$AI_AGENT\" is not a known dev agent (${DEV_AGENT_IDS[*]}); set AI_AGENT_CMD for anything else." >&2
      return 1
    fi
    if ! command -v "$requested_bin" >/dev/null 2>&1; then
      echo "AI_AGENT=\"$AI_AGENT\" was requested but \"$requested_bin\" is not on PATH." >&2
      return 1
    fi
    dev_agent_command "$AI_AGENT"
    return 0
  fi

  local id bin
  for id in "${DEV_AGENT_IDS[@]}"; do
    bin="$(dev_agent_binary "$id")" || continue
    if command -v "$bin" >/dev/null 2>&1; then
      dev_agent_command "$id"
      return 0
    fi
  done
}

# Run one resolved agent command under the hang-kill budget with the prompt on STDIN.
# Record the ACTUAL worker identity: the bash -c writes its pid + immutable start tick,
# then `exec`s the agent (exec preserves both), so loop-stop cannot mistake a later
# process that reused the pid for this worker. The command string is shell-parsed by
# that bash -c — a registry template is a tracked repo file and AI_AGENT_CMD is the
# operator's own command — but the VALUES a template names are not spliced into it:
# the cwd and sandbox arrive as positional $1 and $2 (see dev_agent_command, bug_0632).
launch_agent() {
  local cmd="$1" budget="$2" prompt="$3"
  AFK_AGENT_PID_FILE="$AGENT_PID_FILE" timeout --kill-after=30 "$budget" bash -c \
    'write_process_record "$AFK_AGENT_PID_FILE" "$$" || { echo "Cannot authenticate worker process identity." >&2; exit 125; }; exec '"$cmd" \
    bash "$PWD" "${AI_CODEX_SANDBOX:-workspace-write}" < "$prompt"
}

run_agent() {
  local prompt cmd
  AGENTLESS_CYCLE=0
  prompt="$(latest_prompt)"
  if [[ -z "$prompt" ]]; then echo "No AFK agent prompt found; skipping agent handoff."; return 0; fi
  if [[ "${AI_LOOP_RUN_AGENT:-1}" != "1" ]]; then echo "AI_LOOP_RUN_AGENT is not 1; prompt is ready at $prompt."; return 0; fi
  if ! cmd="$(agent_cmd)"; then
    echo "The requested agent cannot run — failing this cycle rather than proceeding without it."
    return 1
  fi
  if [[ -z "$cmd" ]]; then
    echo "No supported dev agent found on PATH (tried: ${DEV_AGENT_IDS[*]})."
    echo "Install one, set AI_AGENT=<id>, or set AI_AGENT_CMD to any command that reads the prompt from STDIN."
    echo "Evidence-only this cycle. Prompt at $prompt."
    # Mark the cycle agent-less so continuous mode can stop instead of looping
    # gate-only "successes" forever: each such pass burns the pre+post crawl and
    # the full health bar while the breakers (which count only FAILURES) never
    # trip. One informative pass is useful; an unattended chain of them is not.
    AGENTLESS_CYCLE=1
    return 0
  fi
  local budget="${AI_AGENT_TIMEOUT_SECONDS:-2400}"
  # Per-cycle override: ai-loop.ts writes agentTimeoutSeconds into latest-cycle.json
  # for ultraplan cycles, which run a bounded multi-agent Workflow and need a larger
  # budget than a routine cycle. Falls back to the default when absent.
  local override
  override="$(node -e 'try{const t=JSON.parse(require("node:fs").readFileSync("ai-runs/latest-cycle.json","utf8")).agentTimeoutSeconds;if(typeof t==="number"&&t>0)process.stdout.write(String(t))}catch{}' 2>/dev/null || true)"
  [[ -n "$override" ]] && budget="$override"
  echo "Agent: $cmd   (prompt: $prompt, timeout: ${budget}s, \$1=$PWD, \$2=${AI_CODEX_SANDBOX:-workspace-write})"
  # Bound the agent turn. The loop has NO other recovery for an agent that never
  # returns (a hung headless agent once wedged the loop for ~9h: the circuit breaker
  # only counts COMPLETED no-progress cycles, so it can't catch a stuck turn). On
  # timeout, SIGTERM then SIGKILL after a 30s grace. A nonzero agent result fails
  # the cycle: partial output is not evidence that the requested work completed.
  local rc=0
  launch_agent "$cmd" "$budget" "$prompt" || rc=$?
  rm -f "$AGENT_PID_FILE" 2>/dev/null || true
  if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then
    echo "⏱ Agent exceeded ${budget}s and was terminated — failing this cycle."
  elif [[ "$rc" -eq 125 ]]; then
    echo "Worker launch refused: PID + start-time identity was unavailable."
  elif [[ "$rc" -ne 0 ]]; then
    echo "Agent exited nonzero (status $rc) — failing this cycle."
  fi
  return "$rc"
}

require_provisional_commit() {
  # In commit-enabled mode the operating agent must freeze the implementation in a
  # LOCAL provisional commit before pure play. Do not constrain the branch: a short-
  # lived feature branch is expected. We only require that the pre-cycle revision is
  # still an ancestor and HEAD advanced, so a failed outer gate can reset it exactly.
  [[ "${AI_LOOP_COMMIT:-0}" == "1" ]] || return 0
  local start_ref="$1" current_ref
  current_ref="$(git rev-parse HEAD)" || return 1
  if [[ "$current_ref" == "$start_ref" ]]; then
    echo "No provisional implementation commit was created before pure play; reverting."
    return 1
  fi
  if ! git merge-base --is-ancestor "$start_ref" "$current_ref"; then
    echo "The provisional revision does not descend from the cycle start; reverting."
    return 1
  fi
  echo "✓ local provisional revision present: $current_ref"
}

require_selection_attestation() {
  # Fail fast on the seal's OWN precondition. A provisional commit whose ledger entry
  # carries no actual-selection attestation is already dead — loop:seal-feedback will
  # refuse it at the end of the cycle no matter how green the gates are — and one such
  # cycle spent seventy minutes proving a full bar (4771 tests) before being thrown away
  # at the last step. Asking the seal itself, in --check-attestation mode, rather than
  # re-parsing the marker here: a check that drifts from the gate it stands in for is
  # worse than none, because it would fail cycles the seal would have accepted.
  #
  # Commit mode only, exactly like require_provisional_commit and safe_commit_if_enabled
  # (bug_0630). The attestation lives in the PROVISIONAL COMMIT's ledger scaffold, which
  # ai-loop.ts writes only when AI_LOOP_COMMIT=1; an evidence-only cycle has no such
  # commit, is never sealed, and so has nothing to attest. Running the check there asked
  # HEAD — the untouched cycle start — for a marker it could not carry, so every
  # evidence-only cycle failed here and was hard-reset, whatever its agent did.
  [[ "${AI_LOOP_COMMIT:-0}" == "1" ]] || return 0
  npm run --silent loop:seal-feedback -- --check-attestation --meta ai-runs/latest-cycle.json
}

require_final_ledger_only() {
  # After the outer gates pass, the sole tracked mutation still allowed is completion
  # of this cycle's terse ledger entry. (Historically this fenced off the exact-clean
  # blind run; the fence is still worth keeping now that the run is gone, because it
  # is what stops a cycle from quietly growing a second change after it verified.)
  [[ "${AI_LOOP_COMMIT:-0}" == "1" ]] || return 0
  local changed
  changed="$({
    git diff --name-only
    git diff --cached --name-only
    git ls-files --others --exclude-standard
  } | LC_ALL=C sort -u)"
  # A CLEAN tree passes too, and this is not a loosening. What the gate exists to stop is a
  # cycle quietly growing a SECOND change after it verified, and nothing at all cannot be a
  # second change. A worker may legitimately have put the completed ledger entry inside its
  # own provisional commit — an early ledger, not a missing one — and rejecting that cost a
  # real cycle: a green run was reverted with "got: (none)", which is the gate refusing a
  # tree because it was too clean.
  if [[ -n "$changed" && "$changed" != "AI_LOOP_STATE.md" ]]; then
    echo "Expected AI_LOOP_STATE.md to be the only post-play tracked change; got:"
    echo "$changed"
    return 1
  fi
  if [[ -z "$changed" ]]; then
    echo "✓ post-play tree is clean (the ledger entry was frozen in the provisional commit)"
  else
    echo "✓ post-play changes are ledger-only"
  fi
}

# Which post-change bar THIS cycle has to clear. `npm run ship` already reads that off
# the diff for a landing (scripts/ship.ts): the whole-state-space census proofs import
# only CENSUS_PROOF_SOURCE_SCOPES, so a change confined outside them cannot move a census
# verdict, while a change touching one gets the full bar because there the proofs ARE the
# ground truth. Running the full bar on EVERY cycle spent the large majority of a docs or
# tooling cycle's wall clock re-proving packs the cycle never touched. This asks the same
# helper the same question, so the loop and the landing path cannot drift apart.
#
# It fails safe in exactly one direction. A nonzero exit, an unreadable ref, an empty
# answer, or any word other than `fast` selects the FULL bar, and AI_LOOP_FULL_HEALTH=1
# forces it outright. Being wrong the other way lands an engine or content regression that
# only a nightly census proof would catch.
select_health_bar() {
  local start_ref="$1" verdict
  if [[ "${AI_LOOP_FULL_HEALTH:-0}" == "1" ]]; then
    printf 'health\n'
    return 0
  fi
  verdict="$(npm run --silent loop:bar -- --against "$start_ref" 2>/dev/null | tr -d '[:space:]')" ||
    verdict=""
  if [[ "$verdict" == "fast" ]]; then
    printf 'health:fast\n'
  else
    printf 'health\n'
  fi
}

safe_commit_if_enabled() {
  # The implementation is already frozen in the provisional commit. Only after
  # post-crawl, health, integrity drift, and report checks pass do we land the
  # completed ledger as a second local commit. Seal the exact report and any
  # hash-bound feedback compile into its tracked authority marker before staging.
  # Optional push happens later.
  if [[ "${AI_LOOP_COMMIT:-0}" != "1" ]]; then
    return 0
  fi
  local meta="ai-runs/latest-cycle.json" current_ref ledger_already_frozen=0
  current_ref="$(git rev-parse HEAD)" || return 1
  # Whether the ledger entry was already frozen in the provisional commit, checked BEFORE the
  # seal runs. It decides how to read an empty stage afterwards: with an early ledger, a seal
  # that adds nothing is the normal outcome; without one, it means the ledger never got
  # written and failing is right. Collapsing the two would hide a genuinely missing ledger.
  if git diff --quiet && git diff --cached --quiet; then ledger_already_frozen=1; fi
  npm run --silent loop:seal-feedback -- --meta "$meta" --expected-commit "$current_ref" --start-ref "$cycle_failure_start_ref" || return 1
  git add -- AI_LOOP_STATE.md
  if git diff --cached --quiet; then
    if [[ "$ledger_already_frozen" == "1" ]]; then
      echo "Ledger was already frozen in the provisional commit and the seal added nothing further; no second commit needed."
      return 0
    fi
    echo "No final ledger change to commit."
    return 1
  fi
  git commit -m "${AI_LOOP_COMMIT_MESSAGE:-Autonomous dev cycle: record verified change}"
}

refresh_intake_queue() {
  # Human triage first: adopt new Linear-filed requests and priority edits into the
  # queue before assessing. The sync script is fail-open by design — no credential,
  # a network outage, or an API error prints one line and leaves the queue as it
  # stands, so this can run unconditionally without wedging the loop. Queue edits it
  # makes are ordinary tracked changes that ride the cycle's provisional commit, and
  # a reverted cycle re-adopts them idempotently by their [16-hex] markers.
  # AI_LOOP_LINEAR_PULL=0 opts a lane out entirely (for example an offline worktree).
  if [[ "${AI_LOOP_LINEAR_PULL:-1}" == "1" ]]; then
    npm run --silent intake:sync:linear -- --pull-only || {
      echo "Linear pull failed; continuing on the queue as it stands."
    }
  fi
  # If several QA worktrees are pooling into one corpus, triage it HERE at cycle start
  # rather than having each QA loop push tickets around. Triage is pure over the corpus,
  # so running it in the dev worktree produces exactly what running it in a QA worktree
  # would — which means the queue never needs syncing between checkouts at all.
  [[ -n "${AI_LOOP_TRIAGE_STORE:-}" ]] || return 0
  npm run --silent qa:triage -- --store "$AI_LOOP_TRIAGE_STORE" || {
    echo "Shared-corpus triage failed; continuing on the queue as it stands."
    return 0
  }
}

report_qa_bucket() {
  # The dev loop no longer plays the game, so there is no per-cycle playtest gate to
  # satisfy here. What replaces it is not another gate but an INPUT: the QA bucket
  # (qa/tickets/), filled asynchronously by playtest-loop.sh.
  #
  # This is informational and NEVER fails the cycle. An empty bucket is a normal,
  # expected state — it means the fleet has not yet corroborated anything new — and a
  # dev loop that stopped there would have simply moved the old blocking dependency
  # from "wait for one playtest" to "wait for the fleet". When the bucket is empty the
  # assessor's own maintenance candidates carry the cycle, exactly as they already do
  # when no hot spots are compiled.
  npm run --silent work -- --list || {
    echo "Intake queue unreadable; continuing on assessor candidates."
    return 0
  }
}

await_queued_work() {
  # Opt-in idle mode. Default behaviour is unchanged — an empty queue falls through to
  # the assessor's own maintenance candidates, so the loop always has something to do.
  # Set AI_LOOP_IDLE_WHEN_EMPTY=1 when you would rather the loop WAIT than invent work:
  # useful once the queue is the real roadmap and speculative churn costs more than it
  # returns.
  [[ "${AI_LOOP_IDLE_WHEN_EMPTY:-0}" == "1" ]] || return 0
  local poll="${AI_LOOP_IDLE_POLL_SECONDS:-300}"
  while true; do
    refresh_intake_queue
    if [[ -n "$(npm run --silent work -- --next-id 2>/dev/null)" ]]; then
      return 0
    fi
    echo "Queue empty; idling ${poll}s before re-checking (AI_LOOP_IDLE_WHEN_EMPTY=1)."
    sleep "$poll"
  done
}

cycle_failure_stage="unclassified"
cycle_failure_reason="cycle returned without a classified gate failure"
cycle_failure_start_ref=""
cycle_failure_run_id=""

mark_cycle_failure() {
  cycle_failure_stage="$1"
  cycle_failure_reason="$2"
  return 1
}

run_cycle() {
  # Each gate fails the cycle EXPLICITLY (|| return 1) rather than relying on
  # `set -e`, so a bad cycle skips its commit and the outer loop continues to the
  # next one (resilient unattended operation) instead of the whole script dying.
  cycle_failure_stage="unclassified"
  cycle_failure_reason="cycle returned without a classified gate failure"
  cycle_failure_start_ref=""
  cycle_failure_run_id=""
  require_clean_evidence_cycle_start || {
    mark_cycle_failure "clean-start" "evidence-only cycle started with a dirty worktree"
    return 1
  }
  local start_ref untracked_snapshot
  start_ref="$(git rev-parse HEAD)" || {
    mark_cycle_failure "snapshot" "could not resolve the cycle-start revision"
    return 1
  }
  cycle_failure_start_ref="$start_ref"
  untracked_snapshot="$(mktemp)" || {
    echo "Could not create cycle-start snapshot."
    mark_cycle_failure "snapshot" "could not create the untracked-path snapshot"
    return 1
  }
  git ls-files --others --exclude-standard -z > "$untracked_snapshot" || {
    rm -f -- "$untracked_snapshot"
    echo "Could not snapshot cycle-start untracked paths."
    mark_cycle_failure "snapshot" "could not capture cycle-start untracked paths"
    return 1
  }
  # Self-recovery: revert a FAILED cycle's provisional commit and scratch back to the
  # pre-cycle state. Without this, a single bad authored artifact (observed: an over-complex RPG
  # pack that blows the global RPG tests' 200k-state cap) stays UNTRACKED in the tree
  # and fails `npm run health` on EVERY subsequent cycle — wedging the loop to the
  # circuit breaker with no progress. Reverting after a pre-commit gate fails lets the
  # captured cycle start (normally clean), ready to retry or rotate targets.
  # Only the pre-final-commit gates revert; a post-commit push failure must NOT (the
  # verified two-commit cycle is real). Ignored ai-runs evidence remains, while the
  # exact untracked-path delta is cleaned across every first-party directory.
  _revert_failed_cycle() {
    git reset --hard "$start_ref" >/dev/null 2>&1 || true
    remove_new_untracked_since_cycle_start "$untracked_snapshot" >/dev/null 2>&1 || \
      echo "Warning: failed to remove all cycle-created untracked paths."
    rm -f -- "$untracked_snapshot"
  }
  _reject_cycle() {
    local stage="$1" reason="$2"
    _revert_failed_cycle
    mark_cycle_failure "$stage" "$reason"
  }
  # Queue first: a corroborated or reproduced submission is stronger evidence than any
  # candidate the assessor can synthesize, and it may have come from an audit or a person
  # rather than from playtesting at all.
  refresh_intake_queue
  await_queued_work
  report_qa_bucket
  npm run ai:loop || {
    echo "ai:loop failed"
    _reject_cycle "assess" "ai:loop could not assess or initialize the cycle"
    return 1
  }
  cycle_failure_run_id="$(node -e 'try{const c=JSON.parse(require("node:fs").readFileSync("ai-runs/latest-cycle.json","utf8"));if(typeof c.runId==="string")process.stdout.write(c.runId)}catch{}' 2>/dev/null || true)"
  npm run crawl:smoke || {
    echo "crawl:smoke red before work — world is already broken; halting cycle"
    _reject_cycle "crawl-pre" "pre-change crawl:smoke failed"
    return 1
  }
  # Commit-enabled prompt contract: one change → focused checks → LOCAL provisional
  # commit (never push) → exact-clean pure play → ledger-only edit. Evidence-only
  # prompts instead capture the clean baseline before making uncommitted changes.
  local agent_rc=0
  run_agent || agent_rc=$?
  if [[ "$agent_rc" -ne 0 ]]; then
    _reject_cycle "agent" "headless agent exited with status $agent_rc"
    return 1
  fi
  # The evidence-only mirror of require_provisional_commit below: with
  # AI_LOOP_COMMIT=0 no commit is allowed at all. The prompt says so, but a
  # disobedient agent's commit used to leave a clean tree, so the cycle
  # "succeeded" and unsealed commits (no selection attestation, no
  # acceptance-marker update) quietly accumulated on the branch. The charter
  # states this as a driver property (AGENTS.md, evidence-only mode); this makes
  # the driver actually own it.
  if [[ "${AI_LOOP_COMMIT:-0}" != "1" ]] && [[ "$(git rev-parse HEAD)" != "$start_ref" ]]; then
    _reject_cycle "evidence-commit" "evidence-only cycle advanced HEAD; no commit is allowed with AI_LOOP_COMMIT=0"
    return 1
  fi
  require_provisional_commit "$start_ref" || {
    _reject_cycle "provisional-commit" "required provisional implementation commit is absent or invalid"
    return 1
  }
  # Fail fast on the seal's own precondition, right after the provisional commit and
  # before anything expensive (see require_selection_attestation; commit mode only).
  require_selection_attestation || {
    _reject_cycle "attestation" "provisional commit carries no actual-selection attestation; the seal would reject it"
    return 1
  }
  # The agent has now completed the current ledger entry. Rotate at this boundary,
  # after evidence-only baseline play and before integrity runs, so both modes keep
  # exactly the configured live history without mutating an evidence-only baseline.
  npm run --silent loop:rotate-state || {
    echo "loop-state rotation failed — reverting"
    _reject_cycle "loop-state-rotation" "deterministic final loop-state rotation failed"
    return 1
  }
  npm run crawl:smoke || {
    echo "crawl:smoke red after work — reverting"
    _reject_cycle "crawl-post" "post-change crawl:smoke failed"
    return 1
  }
  # Trust, but verify: the health bar is a BLOCKING gate (it runs the static
  # verifier-integrity check too). A red check ⇒ no commit this cycle. WHICH health
  # script runs is not a flag — select_health_bar reads it off this cycle's own diff,
  # exactly as `npm run ship` does for a landing, and defaults to the full bar.
  local health_script
  health_script="$(select_health_bar "$start_ref")"
  echo "post-change bar: npm run $health_script"
  npm run "$health_script" || {
    echo "$health_script failed — reverting cycle scratch, skipping commit"
    _reject_cycle "health" "npm run $health_script failed"
    return 1
  }
  # Don't route around the verifier. A content cycle that re-pins a hash ALONGSIDE a
  # real content change is the legitimate snapshot-update workflow → surfaced, allowed.
  # This blocks only actual weakening: deleted/disabled tests, a dropped test count,
  # a deleted protected asset, or a re-pin with NO content change (the launder pattern).
  # AI_LOOP_ALLOW_VERIFIER_EDITS=1 overrides only the unaccompanied-re-pin and
  # acknowledged guard-loosening cases; real test weakening is never downgradable.
  npm run verify:integrity -- --against "$start_ref" || {
    echo "verifier weakened/laundered — reverting, skipping commit"
    _reject_cycle "integrity" "verifier-integrity drift check failed"
    return 1
  }
  # No playtest gate. Experience evidence is an INPUT, consumed from the intake queue
  # at the start of the cycle, never a condition on landing a change. The queue was
  # already printed there; reprinting it here would only duplicate the cycle log.
  require_final_ledger_only || {
    _reject_cycle "ledger-only" "post-play changes were not limited to AI_LOOP_STATE.md"
    return 1
  }
  safe_commit_if_enabled || {
    echo "final ledger commit failed — reverting"
    _reject_cycle "final-commit" "final ledger-only commit failed"
    return 1
  }
  rm -f -- "$untracked_snapshot"
  if [[ "${AI_LOOP_PUSH:-0}" == "1" ]]; then
    # A push failure must not fail the cycle: the verified commit is real progress
    # (the comment above _revert_failed_cycle already forbids reverting it), and
    # counting it as "no progress" would let rejected pushes trip the circuit
    # breakers. Note: main is protected by a required 'verify' status check, so a
    # bare push of a fresh local commit is ALWAYS rejected — land loop commits via
    # a scratch branch/PR instead, and leave AI_LOOP_PUSH=0 in normal operation.
    git push || echo "⚠ committed locally but push was rejected (protected main" \
      "needs a green 'verify' run on the commit first) — not counted as a failure."
  fi
  return 0
}

record_cycle_failure() {
  local cycle_number="$1" consecutive="$2" total="$3"
  local run_id="${cycle_failure_run_id:-none}"
  local start_ref="${cycle_failure_start_ref:-none}"
  local max_entries="${AI_LOOP_FAILURE_LEDGER_MAX_ENTRIES:-100}"
  npm run --silent loop:failures -- append \
    --cycle "$cycle_number" \
    --stage "$cycle_failure_stage" \
    --reason "$cycle_failure_reason" \
    --consecutive "$consecutive" \
    --total "$total" \
    --run-id "$run_id" \
    --start-ref "$start_ref" \
    --max "$max_entries" || \
    echo "Warning: could not persist this failure to ai-runs/failure-ledger.json."
}

count=0
fails=0
fails_total=0
max_fails="${AI_LOOP_MAX_CONSECUTIVE_FAILURES:-5}"
# The consecutive-failure breaker never fires on an alternating pass/fail
# pattern, so an unattended loop could churn indefinitely at ~50% waste. A
# total-failure budget bounds that: generous enough for a long healthy run,
# small enough to stop a structurally sick one.
max_fails_total="${AI_LOOP_MAX_TOTAL_FAILURES:-15}"
delay="${AI_LOOP_DELAY_SECONDS:-10}"
while true; do
  if stop_requested; then
    echo "Graceful stop requested ($STOP_FILE) — exiting before cycle $((count + 1)) begins."
    break
  fi
  if run_cycle; then
    fails=0
    echo "✓ cycle $((count + 1)) complete."
    if [[ "${AI_LOOP_COMMIT:-0}" != "1" ]] && [[ -n "$(git status --porcelain)" ]]; then
      echo "Evidence-only work remains uncommitted; stopping before another cycle so"
      echo "the next pure baseline cannot be mislabeled. Commit, stash, or discard it first."
      break
    fi
    # A cycle that ran no agent (auto-detect found none) proves the gates and
    # writes a prompt, and one of those is informative — but repeating it can
    # only burn the ~50-minute bar per lap with zero possible progress, and the
    # failure breakers never see it because the cycle "succeeds". Stop unless
    # the operator explicitly asked for agent-less cycles (AI_LOOP_RUN_AGENT=0).
    if [[ "${AGENTLESS_CYCLE:-0}" == "1" && "${AI_LOOP_RUN_AGENT:-1}" == "1" ]]; then
      echo "No dev agent is installed, so further cycles cannot make progress — stopping"
      echo "continuous mode. Install codex/claude/gemini or set AI_AGENT_CMD, then relaunch."
      break
    fi
  else
    fails=$((fails + 1))
    fails_total=$((fails_total + 1))
    record_cycle_failure "$((count + 1))" "$fails" "$fails_total"
    echo "✗ cycle $((count + 1)) made no committed progress ($fails/$max_fails consecutive, $fails_total/$max_fails_total total)."
    if [[ "$fails" -ge "$max_fails" ]]; then
      echo "Circuit breaker: $max_fails consecutive cycles without progress — stopping. Check ai-runs/ and AI_LOOP_STATE.md."
      break
    fi
    if [[ "$fails_total" -ge "$max_fails_total" ]]; then
      echo "Circuit breaker: $fails_total total failed cycles — stopping. Check ai-runs/ and AI_LOOP_STATE.md."
      break
    fi
  fi
  count=$((count + 1))
  if stop_requested; then
    echo "Graceful stop requested ($STOP_FILE) — cycle $count is finished and pushed; exiting."
    break
  fi
  if [[ "$once" == "1" ]]; then
    break
  fi
  if [[ -n "$cycles" && "$count" -ge "$cycles" ]]; then
    break
  fi
  sleep "$delay"
done
