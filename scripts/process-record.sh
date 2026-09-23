# shellcheck shell=bash
# Process-identity records shared by BOTH loop drivers: loop.sh (the dev loop) and
# playtest-loop.sh (the QA loop). Source it; it defines functions and sets nothing else
# except a default AFK_PROC_ROOT.
#
# A pid alone is not an identity: after a crash leaves a stale file, the kernel may
# reuse that number for an unrelated process. Linux exposes a process's immutable
# start tick in /proc/<pid>/stat field 22. A record holds both values, and a reader
# trusts it only when both still match. The two drivers used to disagree here — loop.sh
# authenticated its own record while playtest-loop.sh refused to start on the bare
# existence of ai-runs/loop.pid, so a stale file blocked QA forever, and QA wrote no
# record at all, so a dev loop started second in the same checkout was unguarded
# (bug_0634). One copy of these helpers is what keeps the two answering alike.
#
# scripts/loop-status.sh and scripts/loop-stop.sh source it too, from their own directory
# (or the working directory when a test feeds a script body on stdin).

AFK_PROC_ROOT="${AFK_PROC_ROOT:-/proc}"

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

# Succeeds, printing "<pid> <start>", only when <path> names a LIVE process whose start
# tick still matches the record. A missing file, a malformed record, a dead pid, or a pid
# the kernel has since reused all fail: those are stale records, not holders.
live_process_record() {
  local path="$1" pid="" recorded_start="" rest="" start
  [[ -f "$path" ]] || return 1
  read -r pid recorded_start rest < "$path" 2>/dev/null || [[ -n "$pid" ]] || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  start="$(process_start_time "$pid")" || return 1
  [[ "$start" == "$recorded_start" ]] || return 1
  printf '%s %s\n' "$pid" "$start"
}
