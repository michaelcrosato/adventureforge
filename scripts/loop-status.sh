#!/usr/bin/env bash
# loop-status.sh — one-command monitoring snapshot for THIS project's AFK loop.
#
# PROJECT-SCOPED (2026-06-09): several projects run identical-looking `./loop.sh` /
# headless-agent processes, so pattern-matching across all of them mis-reads (and risks
# killing) other projects' work. This reads ONLY the process identities THIS loop
# recorded (pid + immutable /proc start tick for loop.sh and its worker). A live pid
# whose start tick differs is a DIFFERENT process and is never reported as this loop.
# Systems without compatible /proc identity data fail closed with an anomaly.
#
# Usage:  bash scripts/loop-status.sh [BASELINE_REF]   (default origin/main)
# Reads only; never kills. Exit: 0 healthy/stopped, 3 anomaly (orphan/desync/fail).
set -uo pipefail
baseline="${1:-origin/main}"
rc=0
AFK_PROC_ROOT="/proc"
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# process_start_time and the record helpers are shared with both loop drivers.
# shellcheck source=scripts/process-record.sh
source "$(dirname "${BASH_SOURCE[0]:-.}")/process-record.sh"

# Output: pid recorded_start trusted_alive identity_state. Placeholders keep the
# four fields stable for `read`, while user-facing output maps "-" back to "none".
record_status() {
  local path="$1" raw pid start extra actual
  if [[ ! -f "$path" ]]; then
    printf '%s\n' "- - 0 missing"
    return
  fi
  raw="$(<"$path")"
  set -- $raw
  pid="${1:-}"
  start="${2:-}"
  extra="${3:-}"
  if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s\n' "- - 0 invalid"
    return
  fi
  # A dead pid is merely stale. Its incomplete legacy record can be cleaned by
  # loop-stop without risk because there is no process to signal.
  if ! alive "$pid"; then
    printf '%s\n' "$pid ${start:--} 0 stale"
    return
  fi
  if [[ ! "$start" =~ ^[0-9]+$ || -n "$extra" ]]; then
    printf '%s\n' "$pid ${start:--} 0 invalid"
    return
  fi
  actual="$(process_start_time "$pid")" || {
    printf '%s\n' "$pid $start 0 unverifiable"
    return
  }
  if [[ "$actual" != "$start" ]]; then
    printf '%s\n' "$pid $start 0 mismatch"
    return
  fi
  printf '%s\n' "$pid $start 1 verified"
}

read -r loop_pid loop_start loopsh loop_identity <<< "$(record_status ai-runs/loop.pid)"
read -r agent_pid agent_start worker agent_identity <<< "$(record_status ai-runs/agent.pid)"
loop_display="$loop_pid"; [[ "$loop_display" == "-" ]] && loop_display="none"
agent_display="$agent_pid"; [[ "$agent_display" == "-" ]] && agent_display="none"

echo "=== AFK LOOP STATUS  ($(date '+%Y-%m-%d %H:%M:%S')) ==="
echo "this project's loop: loop.sh pid=$loop_display (alive=$loopsh identity=$loop_identity)   worker pid=$agent_display (alive=$worker identity=$agent_identity)"

identity_anomaly=0
for identity_row in "loop.sh:$loop_display:$loop_identity" "worker:$agent_display:$agent_identity"; do
  IFS=: read -r identity_label identity_pid identity_state <<< "$identity_row"
  case "$identity_state" in
    invalid|mismatch|unverifiable)
      echo "  *** PROCESS-IDENTITY ANOMALY: $identity_label pid $identity_pid is $identity_state; refusing to treat it as this project's process."
      identity_anomaly=1
      rc=3
      ;;
  esac
done

# Orphan detection (project-scoped): worker alive but loop.sh dead = runaway worker.
if [ "$worker" -eq 1 ] && [ "$loopsh" -eq 0 ] && [ "$identity_anomaly" -eq 0 ]; then
  echo "  *** ORPHAN-WORKER ANOMALY: this loop's worker (pid $agent_pid) is alive but loop.sh (pid $loop_display) is dead."
  echo "      -> run: npm run loop:stop   (kills exactly this loop's recorded pids)"
  rc=3
fi

echo "--- git ---"
echo "HEAD:            $(git log --oneline -1 2>/dev/null)"
newc=$(git log --oneline "${baseline}..HEAD" 2>/dev/null | wc -l | tr -d ' ')
echo "commits since ${baseline}: ${newc}"
git log --oneline "${baseline}..HEAD" 2>/dev/null | sed 's/^/  /' | head -8
unpushed=$(git log --oneline origin/main..HEAD 2>/dev/null | wc -l | tr -d ' ')
if [ "$unpushed" -gt 0 ]; then echo "push: ${unpushed} local commit(s) NOT on origin/main"; else echo "push: in sync with origin/main"; fi

if [ -f ai-runs/latest-cycle.json ]; then
  echo "--- current cycle (latest-cycle.json) ---"
  node <<'NODE' 2>/dev/null
try {
  const c = JSON.parse(require("fs").readFileSync("ai-runs/latest-cycle.json", "utf8"));
  const rec = c.recommendationId
    ? `${c.recommendationCategory ? `${c.recommendationCategory}/` : ""}${c.recommendationId}`
    : c.recommendation || "";
  console.log(
    `  runId=${c.runId}  budget=${c.agentTimeoutSeconds || "default"}s\n` +
      `  target=${c.target}\n` +
      `  rec=${rec.slice(0, 90)}`,
  );
} catch {
  console.log("  (unreadable)");
}
NODE
fi

if [ -f ai-runs/wrapper.log ]; then
  echo "--- wrapper.log fail/timeout/breaker markers (recent) ---"
  fails="$(grep -iE "no committed progress|push failed|health failed|Circuit breaker|Agent exceeded" ai-runs/wrapper.log | tail -4 || true)"
  if [ -n "$fails" ]; then printf '%s\n' "$fails" | sed 's/^/  /'; else echo "  (none)"; fi
  grep -qE "Circuit breaker" ai-runs/wrapper.log && { echo "  *** CIRCUIT BREAKER tripped"; rc=3; }
fi

if [ -f ai-runs/failure-ledger.json ]; then
  echo "--- durable failure ledger ---"
  failure_summary="$(npm run --silent loop:failures -- summary 2>&1)"
  failure_summary_rc=$?
  if [ "$failure_summary_rc" -eq 0 ]; then
    printf '%s\n' "$failure_summary"
  else
    echo "  *** FAILURE-LEDGER ANOMALY: retained failure history is unreadable."
    printf '%s\n' "$failure_summary" | sed 's/^/  /'
    rc=3
  fi
fi

newest_pt="$(ls -t ai-runs/*/playtest.md 2>/dev/null | head -1 || true)"
if [ -n "$newest_pt" ]; then
  echo "--- newest playtest ($newest_pt) ---"
  grep -ioE "clarity:? [0-9]/5|enjoyment:? [0-9]/5|verdict" "$newest_pt" | head -3 | sed 's/^/  /'
fi

# Velocity / technical-debt telemetry (evolutionary view, not just liveness).
if [ -f ai-runs/wrapper.log ]; then
  echo "--- telemetry (velocity / debt) ---"
  done_n=$(grep -cE "cycle .* complete" ai-runs/wrapper.log 2>/dev/null); done_n=${done_n:-0}
  to_n=$(grep -cE "Agent exceeded" ai-runs/wrapper.log 2>/dev/null); to_n=${to_n:-0}
  np_n=$(grep -cE "no committed progress" ai-runs/wrapper.log 2>/dev/null); np_n=${np_n:-0}
  np_consec=$(grep -oE "no committed progress \([0-9]+/[0-9]+" ai-runs/wrapper.log 2>/dev/null | tail -1 | grep -oE "[0-9]+/[0-9]+" || echo "0/5")
  echo "  cycles completed: ${done_n}   timeouts(Agent exceeded): ${to_n}   no-progress: ${np_n} (consec ${np_consec} vs breaker 5)"
  [ "${to_n:-0}" -ge 2 ] && { echo "  ⚠ repeated timeouts — authoring may need decomposition, not just budget"; rc=3; }
  case "$np_consec" in 3/*|4/*|5/*) echo "  ⚠ nearing circuit breaker"; rc=3;; esac
  echo "  recent fix-class (last 8 commits):"
  git log -8 --pretty='%s' 2>/dev/null | sed -E 's/:.*//' | sort | uniq -c | sort -rn | sed 's/^/    /'
fi

echo "--- summary ---"
if [ "$identity_anomaly" -eq 1 ]; then echo "IDENTITY ANOMALY — recorded pid cannot be authenticated; no process is trusted";
elif [ "$worker" -eq 1 ] && [ "$loopsh" -eq 0 ]; then echo "ORPHAN-WORKER — run npm run loop:stop";
elif [ "$loopsh" -eq 1 ]; then echo "RUNNING (this project's loop.sh pid $loop_pid alive)";
else echo "STOPPED (this project's loop not running) — paused/idle"; fi
exit $rc
