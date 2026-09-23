#!/usr/bin/env bash
# The PLAYTEST (QA) loop driver. Usage: ./playtest-loop.sh [--once]
#
# Runs completely independently of ./loop.sh. It plays the most recently published
# build over and over, across as many vendors and models as you point it at,
# and turns what the players say into QA tickets the dev loop reads. It never blocks
# the dev loop and the dev loop never blocks it — that separation is the entire reason
# this file exists.
#
# WHY MASS PARALLEL, AND WHY MOSTLY CHEAP MODELS. Experiential findings only become
# trustworthy through repetition across INDEPENDENT instruments. One expensive player
# is one opinion; forty cheap players across four vendors is a measurement. The game
# does not need frontier reasoning to be played, so the fleet is deliberately lopsided:
# a large `volume` cohort for throughput, and a small `reference` cohort as the
# calibration instrument that tells you whether the cheap cohort's silence means
# anything (see PlaytestTier in src/blind/providers.ts).
#
# Env knobs (defaults in brackets):
#   PLAYTEST_COHORT="claude_code:8,codex:2"  provider:count pairs ["codex:1"]
#                                            Live waves take only live-capable
#                                            providers; `npm run doctor` lists them.
#   PLAYTEST_MODELS="codex=gpt-5.6-terra"    pin a model per provider [catalog default]
#   PLAYTEST_CONCURRENCY=N                   players in flight at once [4]
#   PLAYTEST_SEED_BASE=N                     first seed; each player gets base+i [epoch seconds]
#   PLAYTEST_TRIAGE=1                        re-triage after each wave [1]
#   PLAYTEST_PUBLISH=0                       push the corpus after each wave [0]
#   PLAYTEST_DELAY_SECONDS=N                 pause between waves [30]
#   PLAYTEST_NEW_BUILD_ONLY=1                after the pause, wait for the upstream tip to
#                                            CHANGE before the next wave [0]
#   PLAYTEST_NEW_BUILD_POLL_SECONDS=N        how often to look while waiting [60]
#   PLAYTEST_NEW_BUILD_MAX_WAIT_SECONDS=N    give up waiting and replay the current build
#                                            after this long [3600]
#   PLAYTEST_MAX_WAVES=N                     stop after N waves [unbounded]
#   PLAYTEST_STORE=<dir>                     session corpus [ai-runs/playtest/sessions]
#                                            Point several QA worktrees at ONE absolute
#                                            path and they pool into a single corpus —
#                                            content addressing means no lock is needed.
#   PLAYTEST_ALLOW_SHARED_CHECKOUT=1         permit running beside a live dev loop [0]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

once=0
[[ "${1:-}" == "--once" ]] && once=1

# A playtest loop and a dev loop in ONE checkout will fight: the dev loop hard-resets
# the tree on a failed cycle, and a player mid-run would then be playing a build that
# no longer exists on disk. Run the QA loop from its own clone or worktree. This is a
# refusal rather than a warning because the failure it prevents is silent — you would
# get sessions stamped with a commit whose content had already changed.
#
# Both directions are guarded, with the same authenticated records (bug_0634). The dev
# loop's ai-runs/loop.pid counts only when it names a LIVE process whose start tick still
# matches — a bare file left by a crash used to block this loop forever. And this loop now
# writes ai-runs/playtest-loop.pid, which loop.sh checks the same way, so starting the dev
# loop SECOND in this checkout is refused too.
# shellcheck source=scripts/process-record.sh
source "$REPO_ROOT/scripts/process-record.sh"
PLAYTEST_PID_FILE="ai-runs/playtest-loop.pid"
mkdir -p ai-runs
if [[ "${PLAYTEST_ALLOW_SHARED_CHECKOUT:-0}" != "1" ]] &&
  dev_loop_holder="$(live_process_record "ai-runs/loop.pid")"; then
  echo "A dev loop is running in this checkout (ai-runs/loop.pid, pid ${dev_loop_holder% *})."
  echo "Run the playtest loop from a separate clone or git worktree so a failed dev"
  echo "cycle's hard reset cannot change the build out from under a player mid-run."
  echo "Set PLAYTEST_ALLOW_SHARED_CHECKOUT=1 to override."
  exit 1
fi
# Two QA loops in one checkout reset the tree under each other's players between waves,
# and one's exit would delete the other's record, so only one may hold it.
if qa_holder="$(live_process_record "$PLAYTEST_PID_FILE")"; then
  echo "Another playtest loop is running in this checkout ($PLAYTEST_PID_FILE, pid ${qa_holder% *})."
  echo "Run a second QA loop from its own git worktree; point both at one PLAYTEST_STORE to pool."
  exit 1
fi
# Where /proc cannot authenticate a process (e.g. macOS), no record is written. loop.sh
# fails closed on such a system and cannot run here at all, so there is nothing to guard.
if write_process_record "$PLAYTEST_PID_FILE" "$$"; then
  # Remove the record only if it is still THIS process's. BASHPID, not $$: a player
  # subshell shares $$ with this shell, and must never delete the loop's record.
  cleanup_playtest_record() {
    local mine=""
    mine="$(live_process_record "$PLAYTEST_PID_FILE" 2>/dev/null)" || mine=""
    [[ "${mine% *}" == "$BASHPID" ]] && rm -f "$PLAYTEST_PID_FILE" 2>/dev/null
    return 0
  }
  trap cleanup_playtest_record EXIT
  trap 'cleanup_playtest_record; trap - EXIT; exit 130' INT
  trap 'cleanup_playtest_record; trap - EXIT; exit 143' TERM
else
  rm -f "$PLAYTEST_PID_FILE" 2>/dev/null || true
  echo "Note: cannot authenticate this process through /proc; no $PLAYTEST_PID_FILE written."
fi

# Default cohort: one player on the registry's first provider. The vendor name used to
# be written here as `codex:1`; it is now asked for, for the same reason run.sh no longer
# hardcodes its default provider — a default with a vendor's name baked in reads as a
# preference the harness holds, and this one outlived the claim behind it. Registry order
# is unchanged, so an operator who sets nothing gets exactly what they got before.
DEFAULT_COHORT_PROVIDER="$(node blind-tester/resolve-provider.mjs --default-provider 2>/dev/null || true)"
if [[ -z "$DEFAULT_COHORT_PROVIDER" ]]; then
  echo "Cannot resolve a default provider from blind-tester/providers.json." >&2
  echo "Set PLAYTEST_COHORT=\"<provider>:<count>\" explicitly." >&2
  exit 1
fi
COHORT="${PLAYTEST_COHORT:-$DEFAULT_COHORT_PROVIDER:1}"
CONCURRENCY="${PLAYTEST_CONCURRENCY:-4}"
DELAY="${PLAYTEST_DELAY_SECONDS:-30}"
SEED_BASE="${PLAYTEST_SEED_BASE:-$(date +%s)}"
STORE="${PLAYTEST_STORE:-ai-runs/playtest/sessions}"
export PLAYTEST_STORE="$STORE"

# Play each build a couple of times instead of playing one build to exhaustion.
#
# WHY THIS IS NOT JUST A LONGER DELAY. A fixed pause is a guess about how fast the dev loop
# lands changes, and it is wrong in both directions: too short and the corpus fills with
# repeat sessions on a build nobody changed, too long and a freshly pushed build sits
# unplayed. What the playtest lane actually wants is an EVENT — a new build — so this waits
# for the event and uses time only as the failsafe. The delay above still applies first, so
# this cannot dispatch faster than the operator's pacing floor.
#
# MAX WAIT EXISTS SO A DEV OUTAGE DOES NOT SILENCE QA. If the dev loop stops pushing, an
# unbounded wait would turn this loop into a process that is running and producing nothing,
# which looks identical to a healthy idle loop from the outside. After the ceiling it
# replays the current build and says so, because a repeat session on a known build is worth
# more than no evidence at all.
NEW_BUILD_ONLY="${PLAYTEST_NEW_BUILD_ONLY:-0}"
NEW_BUILD_POLL="${PLAYTEST_NEW_BUILD_POLL_SECONDS:-60}"
NEW_BUILD_MAX_WAIT="${PLAYTEST_NEW_BUILD_MAX_WAIT_SECONDS:-3600}"
if [[ "$NEW_BUILD_ONLY" == "1" ]]; then
  case "$NEW_BUILD_POLL" in
    ''|*[!0-9]*|0)
      echo "PLAYTEST_NEW_BUILD_POLL_SECONDS requires a positive whole number of seconds." >&2
      exit 2 ;;
  esac
  case "$NEW_BUILD_MAX_WAIT" in
    ''|*[!0-9]*|0)
      echo "PLAYTEST_NEW_BUILD_MAX_WAIT_SECONDS requires a positive whole number of seconds." >&2
      exit 2 ;;
  esac
fi

# The exact commit the last wave PLAYED, which is what "new build" is measured against —
# not the tip at the moment we look, because the dev loop may have pushed while the wave
# was still running and that push is already unplayed work.
LAST_WAVE_BUILD=""

# PLAYTEST_MOCK=1 is a zero-token WIRING CHECK, not a playtest.
#
# Every other way to find out whether this loop is plumbed correctly — the cohort
# string, the model pins, the store path, the recorder invocation — costs a real vendor
# a real cohort of tokens, which is a bad way to discover a typo. A mock wave drives
# run.sh with its bundled scripted agent instead.
#
# It deliberately records NOTHING: bin/record-playtest-session.ts refuses a structural
# run, because a scripted agent has no opinion and filing its canned exit interview as a
# vendor's would let three mock runs read as three vendors agreeing. So a green mock wave
# proves the wiring and leaves the corpus untouched — which is exactly what a dry run
# should do.
MOCK="${PLAYTEST_MOCK:-0}"
MOCK_QUEST="${PLAYTEST_MOCK_QUEST:-breaking_weir}"
if [[ "$MOCK" == "1" ]]; then
  echo "PLAYTEST_MOCK=1 — wiring check on quest '$MOCK_QUEST'. No model runs and"
  echo "nothing is recorded; the recorder is expected to skip every structural run."
fi

if [[ ! -d node_modules ]]; then npm install; fi

# Refuse a cohort this runner cannot actually launch, BEFORE dispatching anyone.
#
# WHY THE GATE EXISTS AT ALL. A provider the runner cannot witness makes run.sh refuse
# the pure run, and the recorder — which cannot tell a launch refusal from a genuine
# mid-play crash — then files each dead player as a `failed` session. That seeds the
# corpus with fake data points carrying a real vendor family which say nothing whatsoever
# about the game. Catching it here, once, before dispatch, is the difference between a
# one-line refusal and a wave of poisoned evidence.
#
# WHY IT NO LONGER SAYS "codex". This block used to BE the policy: `[[ "$provider" !=
# "codex" ]]`, a third hand-written copy of a rule also written out in bin/doctor.ts and
# blind-tester/run.sh. A rule with three copies has three chances to disagree, and this
# copy was load-bearing in the worst direction — it would keep refusing a vendor whose
# capture reader had already landed, so the reward for doing the work to make a second
# vendor provable was a runner that still would not launch it.
#
# src/blind/providers.ts is the single authority: `derivePlaytestIsolation` returns
# `runner_enforced` only for a headless CLI that declares a complete `capture` block whose
# reader module exists in THIS checkout. A shell cannot import TypeScript, so it ASKS that
# rule instead of re-deriving it: `blind-tester/resolve-provider.mjs --records <id>` is the
# dependency-free mirror written for shell callers, and it refuses outright when its answer
# and the registry's stored literal disagree. Either way the cohort is judged by a
# derivation, never by a vendor name spelled out here.
#
# Vendors that do not qualify are still first-class evidence; they arrive through
# `npm run playtest:ingest` as `operator_attested`. See docs/two_loop_workflow.md.

# The one seam between this shell and the registry, kept as its own function so the
# regression test can substitute a stub for it. Everything below is refusal COPY — the
# part an operator reads at 2am — and it has to be exercisable on its own, because the
# suite may run this file under a bash whose `node` is not this checkout's.
#
# --records is the resolver's shell format: `key<TAB>value` lines, guaranteed free of
# embedded tabs and newlines, absent fields omitted. The keys read here are `isolation`
# and `isolation_reason`.
provider_isolation() {
  node blind-tester/resolve-provider.mjs --records "$1"
}

preflight_cohort() {
  local groups=() group id seen="" records blocked=() entry key value isolation reason drivable drivable_reason
  IFS=',' read -ra groups <<< "$COHORT"
  for group in "${groups[@]}"; do
    id="${group%%:*}"
    [[ -z "$id" ]] && continue
    # Ask about each distinct provider once, however many players the cohort wants from
    # it: the answer is a fact about the provider, and repeating it per requested player
    # would bury a second blocked vendor under the first one's copies.
    case ",$seen," in *",$id,"*) continue ;; esac
    seen="$seen,$id"

    # stderr is folded in deliberately. A resolver failure here is never noise: it is an
    # unregistered id, a broken catalog, or the registry's stored isolation disagreeing
    # with what this checkout derives — and that last one is the exact failure the whole
    # derivation exists to catch, so it must reach the operator word for word.
    if ! records="$(provider_isolation "$id" 2>&1)"; then
      blocked+=("$id — could not be resolved, so it certainly cannot be proved blind:"$'\n'"$records")
      continue
    fi

    isolation=""
    reason=""
    while IFS=$'\t' read -r key value; do
      case "$key" in
        isolation) isolation="$value" ;;
        isolation_reason) reason="$value" ;;
        drivable) drivable="$value" ;;
        drivable_reason) drivable_reason="$value" ;;
      esac
    done <<< "$records"

    # Two conditions, not one. `isolation` says this vendor's blindness is PROVABLE here
    # (a capture reader exists); `drivable` says blind-tester/run.sh actually knows how to
    # LAUNCH it. Gating on isolation alone dispatched a whole wave of players that run.sh
    # then refused one by one — which burns the wave's wall clock and reports as a cohort
    # of failures rather than as the one configuration fact it is.
    [[ "$isolation" == "runner_enforced" && "$drivable" == "1" ]] && continue
    blocked+=("$id — ${drivable_reason:-${reason:-the resolver reported isolation \"${isolation:-unknown}\" and no reason}}")
  done

  if (( ${#blocked[@]} == 0 )); then return 0; fi

  echo "Refusing the cohort: this runner cannot prove blindness for part of it."
  # First line carries the mark, continuation lines are indented under it, so a
  # multi-line resolver message stays visibly attached to the provider it is about.
  for entry in "${blocked[@]}"; do
    printf '%s\n' "$entry" | sed '1s/^/  ✗ /; 2,$s/^/      /'
  done
  echo
  echo "A live run needs runner_enforced blindness: the runner PROVED the agent saw"
  echo "nothing but the AdventureForge MCP tools, by reading that client's own session"
  echo "log. Which vendors qualify is DERIVED from what this checkout contains, so it"
  echo "changes as capture readers land — \`npm run doctor\` prints the current table"
  echo "with the reason for every provider."
  echo
  echo "Play those vendors in their own client and ingest the result instead:"
  echo "  npx tsx bin/ingest-playtest-session.ts --provider <id> --attested-by <you> ..."
  echo "They land operator_attested — still counted for bug corroboration, excluded from"
  echo "experience metrics. Set PLAYTEST_MOCK=1 to dry-run the wiring for any provider."
  return 1
}

if [[ "$MOCK" != "1" ]]; then
  preflight_cohort || exit 1
else
  # A wiring check drives run.sh's bundled scripted agent, so no vendor client is
  # launched and there is nothing to prove blind. Gating it would make the one free way
  # to test this loop's plumbing unavailable for exactly the vendors that most need it.
  echo "PLAYTEST_MOCK=1 — cohort launchability gate skipped; no vendor client is launched."
fi

# Model pin lookup: PLAYTEST_MODELS="codex=gpt-5.6-terra,gemini_cli=gemini-2.5-pro".
model_for() {
  local provider="$1" pair
  IFS=',' read -ra pairs <<< "${PLAYTEST_MODELS:-}"
  for pair in "${pairs[@]}"; do
    [[ "${pair%%=*}" == "$provider" ]] && { echo "${pair#*=}"; return 0; }
  done
}

run_player() {
  local provider="$1" seed="$2" persona="$3" model="$4"
  # Own the output prefix rather than letting run.sh choose one: the recorder needs to
  # find these artifacts afterwards, and parsing the prefix back out of stdout would
  # break the moment a log line changed.
  local out="ai-runs/playtest/runs/${provider}_seed${seed}_${persona}"
  mkdir -p "$(dirname "$out")"
  # The runner log MUST live outside the "$out.*" namespace. run.sh refuses to start when
  # any file named "<prefix>.*" already exists — a deliberate guard against mixing a new
  # run's artifacts with a stale one's — and the shell creates a redirect target BEFORE
  # the command runs. Writing the log to "$out.runner.log" therefore made run.sh find its
  # own log and refuse, so every player failed instantly with "Refusing to reuse report
  # prefix". Keep these two namespaces apart.
  local log_dir="ai-runs/playtest/logs"
  mkdir -p "$log_dir"
  local runner_log="${log_dir}/${provider}_seed${seed}_${persona}.runner.log"
  local args=(--provider "$provider" --seed "$seed" --persona "$persona" --out "$out")
  [[ -n "$model" ]] && args+=(--model "$model")
  # --mock owns run.sh's bundled agent and requires a quest target; the overworld start
  # is reserved for real players.
  [[ "$MOCK" == "1" ]] && args+=(--quest "$MOCK_QUEST" --mock)
  echo "  ▸ $provider seed=$seed persona=$persona ${model:+model=$model}"

  # One player failing is expected and uninteresting — a timeout, a rate limit, a client
  # hiccup. The wave carries on.
  blind-tester/run.sh "${args[@]}" >"$runner_log" 2>&1 ||     echo "    (player exited nonzero — still recorded; log at $runner_log)"

  # A wiring check records nothing. Leaning on the recorder's structural guard is not
  # enough: a run that dies BEFORE writing its sidecar is indistinguishable from a real
  # failed playtest, so a broken mock wave would file junk "failed" sessions carrying
  # real vendor families. The loop knows it is a dry run; it should not ask.
  if [[ "$MOCK" == "1" ]]; then
    echo "    (wiring check — not recorded; log at $runner_log)"
    return 0
  fi

  # Record UNCONDITIONALLY. A run that timed out or crashed is evidence about the game
  # just as much as a finished one, and the recorder is what decides the outcome label
  # from the artifacts that actually landed. Dropping failures here is precisely how a
  # QA corpus quietly becomes a highlight reel.
  local record_args=(--out "$out" --provider "$provider" --persona "$persona" --store "$STORE")
  # We witnessed the launch even when a crash prevented client proof. The recorder
  # uses this explicit weaker attestation only when retained proof cannot verify.
  record_args+=(--attested-by playtest-loop --method "playtest-loop invoked blind-tester/run.sh with the pure player boundary; retained client isolation proof did not verify")
  [[ -n "$model" ]] && record_args+=(--model "$model")
  if [[ -z "$model" ]]; then
    # No pin: ask the registry which model this provider defaulted to, so the record
    # names the model that actually played rather than a guess.
    local resolved
    resolved="$(node blind-tester/resolve-provider.mjs "$provider" 2>/dev/null | cut -f3)" || resolved=""
    [[ -n "$resolved" ]] && record_args+=(--model "$resolved")
  fi
  npx tsx bin/record-playtest-session.ts "${record_args[@]}" 2>&1 | sed "s/^/    /" ||     echo "    (could not record this session — artifacts remain at $out.*)"
}

# Triage after a wave WITHOUT writing tracked files, except after the loop's final wave.
#
# Triage writes qa/tickets/ and intake/queue/, which are tracked. Between waves that was
# wrong both ways (bug_0655): with an upstream, the fetch-and-reset below threw the
# output away every wave; without one, the tracked edits stayed and blind-tester/run.sh
# refused every player of the next wave, because a pure run needs a clean tracked tree
# (and the unconditional recorder then filed each refusal as a failed session). Triage is
# pure over the corpus, so nothing is lost by reporting it as a dry run between waves:
# the store under ai-runs/ survives the reset, and whoever triages that corpus in a
# committing checkout (the dev loop via AI_LOOP_TRIAGE_STORE, or npm run qa:triage)
# derives the identical bucket. The final wave (--once or PLAYTEST_MAX_WAVES) still
# writes the bucket, since no reset and no next wave follow it.
triage_after_wave() {
  local final="$1"
  [[ "${PLAYTEST_TRIAGE:-1}" == "1" ]] || return 0
  local args=(--store "$STORE")
  [[ "$final" == "1" ]] || args+=(--dry-run)
  npm run --silent qa:triage -- "${args[@]}" || \
    echo "  triage failed; corpus is intact, retrying next wave"
}

run_wave() {
  local wave="$1" final="$2" index=0 pids=()
  local build
  build="$(git rev-parse --short HEAD)"
  LAST_WAVE_BUILD="$(git rev-parse HEAD)"
  echo "── wave $wave on build $build ──────────────────────────────────"

  IFS=',' read -ra groups <<< "$COHORT"
  for group in "${groups[@]}"; do
    local provider="${group%%:*}" count="${group#*:}"
    [[ "$count" == "$provider" ]] && count=1
    local model
    model="$(model_for "$provider" || true)"

    local i
    for ((i = 0; i < count; i++)); do
      run_player "$provider" "$((SEED_BASE + index))" default "$model" &
      pids+=($!)
      index=$((index + 1))
      # Bounded fan-out: the cap is about the vendor's rate limits and this machine's
      # memory, not about correctness — every player is independent.
      while (( $(jobs -rp | wc -l) >= CONCURRENCY )); do wait -n || true; done
    done
  done
  wait || true
  echo "  wave $wave: $index player(s) dispatched"

  echo "  corpus: $(npx tsx bin/qa.ts --store-summary --store "$STORE" 2>/dev/null || echo "unavailable")"
  triage_after_wave "$final"
  if [[ "${PLAYTEST_PUBLISH:-0}" == "1" ]]; then
    npm run --silent qa:publish -- --store "$STORE" || \
      echo "  publish failed; sessions remain staged locally"
  fi
}

# Block until the upstream tip differs from the build the last wave played. A no-op unless
# PLAYTEST_NEW_BUILD_ONLY=1, so the default path below is byte-for-byte the old behaviour.
await_new_build() {
  [[ "$NEW_BUILD_ONLY" == "1" ]] || return 0
  if ! git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    # Refusing here would strand an operator whose only mistake was setting a knob on a
    # detached mirror; playing on is the safe reading, but it must be said out loud,
    # because silently ignoring the knob is how someone concludes the feature is broken.
    echo "  PLAYTEST_NEW_BUILD_ONLY=1, but this checkout tracks no upstream — playing the current build."
    return 0
  fi
  local waited=0 tip
  while (( waited < NEW_BUILD_MAX_WAIT )); do
    git fetch --quiet origin || true
    tip="$(git rev-parse '@{u}' 2>/dev/null || true)"
    if [[ -n "$tip" && "$tip" != "$LAST_WAVE_BUILD" ]]; then
      git reset --quiet --hard '@{u}' || true
      echo "  new build $(git rev-parse --short HEAD) after ${waited}s; starting the next wave"
      return 0
    fi
    sleep "$NEW_BUILD_POLL"
    waited=$((waited + NEW_BUILD_POLL))
  done
  echo "  no new build after ${waited}s (PLAYTEST_NEW_BUILD_MAX_WAIT_SECONDS); replaying $(git rev-parse --short HEAD)"
}

wave=0
while true; do
  wave=$((wave + 1))
  final=0
  [[ "$once" == "1" ]] && final=1
  if [[ -n "${PLAYTEST_MAX_WAVES:-}" ]] && (( wave >= PLAYTEST_MAX_WAVES )); then final=1; fi
  run_wave "$wave" "$final"
  SEED_BASE=$((SEED_BASE + 1000))

  [[ "$final" == "1" ]] && break

  # Pick up whatever the dev loop has landed since the last wave. Fetch-and-reset
  # rather than pull: this checkout is a read-only mirror of the build under test, so
  # a merge here would be meaningless and a conflict would wedge the loop.
  if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    git fetch --quiet origin && git reset --quiet --hard '@{u}' || \
      echo "  could not refresh the build; continuing on the current checkout"
  fi
  sleep "$DELAY"
  await_new_build
done
