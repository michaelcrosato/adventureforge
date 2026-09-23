#!/usr/bin/env bash
# loop-stop.sh — RELIABLY stop THIS project's AFK loop, and ONLY this project's.
#
# Project-scoped pid files are necessary but not sufficient: a stale pid can be
# reused by an unrelated process. loop.sh therefore records `pid start_ticks`, where
# start_ticks is /proc/<pid>/stat field 22. This script validates BOTH before it
# enumerates descendants and again immediately before every signal. Descendants get
# their current start tick snapshotted too, closing the enumerate-then-reuse race.
#
# A dead stale record is safe to remove. A live malformed, mismatched, or
# unverifiable record is not safe to act on: stop fails closed and preserves the
# files for inspection. No global process-name search is ever used.
#
# NOTE: also TaskStop the harness background task that launched ./loop.sh (not from bash).
# Usage:  bash scripts/loop-stop.sh [--dry-run]
set -uo pipefail
dry=0; [ "${1:-}" = "--dry-run" ] && dry=1
AFK_PROC_ROOT="/proc"
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# process_start_time and the record helpers are shared with both loop drivers.
# shellcheck source=scripts/process-record.sh
source "$(dirname "${BASH_SOURCE[0]:-.}")/process-record.sh"

identity_matches() {
  local pid="$1" expected="$2" actual
  alive "$pid" || return 1
  actual="$(process_start_time "$pid")" || return 1
  [[ "$actual" == "$expected" ]]
}

declare -a target_pids=()
declare -a target_starts=()
unsafe_record=0

add_target() {
  local pid="$1" start="$2" index
  for ((index = 0; index < ${#target_pids[@]}; index += 1)); do
    [[ "${target_pids[index]}" == "$pid" ]] && return
  done
  target_pids+=("$pid")
  target_starts+=("$start")
}

consider_record() {
  local path="$1" label="$2" raw pid start extra actual
  [[ -f "$path" ]] || return
  raw="$(<"$path")"
  set -- $raw
  pid="${1:-}"
  start="${2:-}"
  extra="${3:-}"

  if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]]; then
    echo "invalid $label record (no numeric pid); refusing to signal anything from it"
    unsafe_record=1
    return
  fi
  # A dead process cannot be harmed. This also lets stop clean old one-field pid
  # records after an ordinary crash without treating their obsolete format as live.
  if ! alive "$pid"; then
    echo "stale $label record: pid $pid is not alive"
    return
  fi
  if [[ ! "$start" =~ ^[0-9]+$ || -n "$extra" ]]; then
    echo "REFUSING: live $label pid $pid has no valid recorded start time"
    unsafe_record=1
    return
  fi
  actual="$(process_start_time "$pid")" || {
    echo "REFUSING: live $label pid $pid cannot be authenticated through /proc"
    unsafe_record=1
    return
  }
  if [[ "$actual" != "$start" ]]; then
    echo "REFUSING: live $label pid $pid has start time $actual, not recorded $start (pid was reused)"
    unsafe_record=1
    return
  fi
  add_target "$pid" "$start"
}

# Recursively capture descendants of a VERIFIED parent. Each output target gets a
# start-time identity now and is revalidated before kill. If a child exits while the
# tree is being read it simply disappears; if its pid is reused, the recheck skips it.
capture_descendants() {
  local parent="$1" child start
  for child in $(ps -ef 2>/dev/null | awk -v p="$parent" '$3==p {print $2}'); do
    start="$(process_start_time "$child")" || continue
    add_target "$child" "$start"
    identity_matches "$child" "$start" && capture_descendants "$child"
  done
}

loop_raw="$(cat ai-runs/loop.pid 2>/dev/null || true)"
agent_raw="$(cat ai-runs/agent.pid 2>/dev/null || true)"
loop_pid="${loop_raw%%[[:space:]]*}"
agent_pid="${agent_raw%%[[:space:]]*}"

echo "=== loop-stop $([ $dry -eq 1 ] && echo '(DRY RUN)') — THIS project only ==="
echo "recorded: loop.sh pid=${loop_pid:-none}  worker pid=${agent_pid:-none}"

consider_record ai-runs/loop.pid "loop.sh"
consider_record ai-runs/agent.pid "worker"

if [ "$unsafe_record" -ne 0 ]; then
  echo "No signals sent: at least one live recorded pid could not be authenticated."
  exit 3
fi

if [ "${#target_pids[@]}" -eq 0 ]; then
  echo "No live authenticated processes for THIS project's loop — already stopped."
  rm -f ai-runs/loop.pid ai-runs/agent.pid 2>/dev/null || true
  exit 0
fi

if ! command -v ps >/dev/null 2>&1 || ! ps -ef >/dev/null 2>&1; then
  echo "No signals sent: cannot enumerate the authenticated process tree."
  exit 3
fi

# Capture from both roots; add_target deduplicates a worker that is also a loop child.
root_count=${#target_pids[@]}
for ((index = 0; index < root_count; index += 1)); do
  capture_descendants "${target_pids[index]}"
done

# Validate the complete snapshot before sending even the first signal. This avoids a
# partial stop if a recorded root changed during descendant enumeration.
for ((index = 0; index < ${#target_pids[@]}; index += 1)); do
  if ! identity_matches "${target_pids[index]}" "${target_starts[index]}"; then
    echo "No signals sent: pid ${target_pids[index]} changed identity during enumeration."
    exit 3
  fi
done

targets=""
for ((index = 0; index < ${#target_pids[@]}; index += 1)); do
  targets="$targets ${target_pids[index]}(start=${target_starts[index]})"
done
echo "will kill (authenticated loop pids + descendants):$targets"
if [ "$dry" -eq 1 ]; then echo "(dry run) no kills performed"; exit 0; fi

# Deepest descendants were appended after their parents, so reverse order keeps a
# parent from orphaning its children before their already-captured identities are used.
runtime_mismatch=0
for ((index = ${#target_pids[@]} - 1; index >= 0; index -= 1)); do
  pid="${target_pids[index]}"
  start="${target_starts[index]}"
  if ! identity_matches "$pid" "$start"; then
    echo "skipped $pid: process identity changed before kill"
    runtime_mismatch=1
  elif kill -9 "$pid" 2>/dev/null; then
    echo "killed $pid"
  else
    echo "$pid gone"
  fi
done

sleep 1
survivors=0
for ((index = 0; index < ${#target_pids[@]}; index += 1)); do
  pid="${target_pids[index]}"
  start="${target_starts[index]}"
  if identity_matches "$pid" "$start"; then
    echo "authenticated survivor: $pid"
    survivors=1
  fi
done

if [ "$runtime_mismatch" -ne 0 ] || [ "$survivors" -ne 0 ]; then
  echo "STOP INCOMPLETE — pid files preserved for inspection."
  exit 3
fi

rm -f ai-runs/loop.pid ai-runs/agent.pid 2>/dev/null || true
echo "CONFIRMED STOPPED — authenticated loop processes are gone (other processes untouched)."
exit 0
