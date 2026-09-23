#!/usr/bin/env bash
# Headless `claude` worker launcher for loop.sh (AI_AGENT_CMD=agents/claude-headless-worker.sh).
# Satisfies the dev-agents.json contract: reads the cycle prompt from STDIN, edits files in
# $PWD, runs non-interactively, exits nonzero on failure. Compared with the registry's bare
# `claude -p` it adds what an unattended run turned out to need:
#   - an explicit tool allowlist instead of a blanket permission bypass, and the scheduling /
#     subagent / messaging tool families disallowed outright (a one-turn worker has no use
#     for them, and they were the source of every "ended its turn expecting a wake-up" loss).
#     The allowlist is a GUARDRAIL, NOT A SANDBOX, and should be read that way: a dev cycle
#     must run the repo's own tooling, and `node`/`npx`/`npm` (and `find -exec`, `awk`,
#     `sed`, `timeout`) can each still execute an arbitrary program. What the list does do
#     is keep the obvious doors shut: no generic command runners (`bash`, `env`, `xargs`,
#     `command`, `python3` were removed — bug_0637), git only through the subcommands a
#     cycle uses, and `git push` / remote-mutating git on the disallowed list, which wins
#     over any allow rule. Isolation, if you need it, is the checkout and the OS account.
#   - a minimal environment (env -i) so nothing leaks in from the operator's own session
#   - a fresh session id with no persistence, so the worker never writes into anyone else's
#     transcript and the CLI's session registry cannot kill a finished run at the last step
#   - a per-run spend cap, a streamed JSON record under ai-runs/dev-agent/, and a one-line
#     cost/turn summary on stdout for the cycle log
#   - the whole agent process group is stopped on TERM (the driver's timeout path), so a
#     stuck worker cannot keep editing the checkout after the cycle was recorded as failed
# Knobs (env, all optional): DEV_AGENT_MODEL (default claude-sonnet-5), DEV_AGENT_EFFORT
# (default max), DEV_AGENT_MAX_BUDGET_USD (default 25), DEV_AGENT_CONTROL_FILE (a file of
# KEY=value lines re-read at every launch, so an operator can retune between cycles
# without restarting loop.sh), DEV_AGENT_RUN_DIR (default ai-runs/dev-agent).
set -uo pipefail
DEV_AGENT_MODEL="${DEV_AGENT_MODEL:-claude-sonnet-5}"
DEV_AGENT_EFFORT="${DEV_AGENT_EFFORT:-max}"
DEV_AGENT_MAX_BUDGET_USD="${DEV_AGENT_MAX_BUDGET_USD:-25}"
CONTROL="${DEV_AGENT_CONTROL_FILE:-}"
# shellcheck disable=SC1090
[[ -n "$CONTROL" && -f "$CONTROL" ]] && source "$CONTROL"
SESSION_ID="$(uuidgen 2>/dev/null || node -e 'console.log(require("crypto").randomUUID())')"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="${DEV_AGENT_RUN_DIR:-$PWD/ai-runs/dev-agent}"; mkdir -p "$RUN_DIR"
OUT="$RUN_DIR/$STAMP-$SESSION_ID.jsonl"
ERR="$RUN_DIR/$STAMP-$SESSION_ID.stderr"
echo "dev-agent: model=$DEV_AGENT_MODEL effort=$DEV_AGENT_EFFORT budget_usd=$DEV_AGENT_MAX_BUDGET_USD session=$SESSION_ID cwd=$PWD record=$OUT"
ALLOWED=(
  "Edit" "Write" "MultiEdit" "Read" "Glob" "Grep" "LS" "NotebookEdit" "TodoWrite" "WebFetch"
  "Bash(npm:*)" "Bash(npx:*)" "Bash(node:*)" "Bash(tsx:*)" "Bash(cd:*)"
  # git: only what a cycle does — read the tree, stage, make and amend the provisional
  # commit, restore/move/remove paths, and stash (workers prove a regression red-before by
  # stashing the fix and re-running). No push, fetch, reset, checkout, or config.
  "Bash(git status:*)" "Bash(git diff:*)" "Bash(git add:*)" "Bash(git commit:*)" "Bash(git log:*)"
  "Bash(git show:*)" "Bash(git rev-parse:*)" "Bash(git ls-files:*)" "Bash(git grep:*)"
  "Bash(git restore:*)" "Bash(git rm:*)" "Bash(git mv:*)" "Bash(git blame:*)" "Bash(git stash:*)"
  "Bash(git branch --show-current)"
  "Bash(rg:*)" "Bash(grep:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(head:*)" "Bash(tail:*)" "Bash(sed:*)"
  "Bash(awk:*)" "Bash(wc:*)" "Bash(find:*)" "Bash(diff:*)" "Bash(sort:*)" "Bash(uniq:*)" "Bash(cut:*)"
  "Bash(tr:*)" "Bash(jq:*)" "Bash(echo:*)" "Bash(printf:*)" "Bash(test:*)" "Bash(true:*)"
  "Bash(false:*)" "Bash(date:*)" "Bash(pwd:*)" "Bash(mkdir:*)" "Bash(cp:*)" "Bash(mv:*)" "Bash(rm:*)"
  "Bash(touch:*)" "Bash(chmod:*)" "Bash(timeout:*)" "Bash(which:*)" "Bash(stat:*)"
  "Bash(sha256sum:*)" "Bash(nproc:*)" "Bash(free:*)" "Bash(df:*)" "Bash(du:*)" "Bash(ps:*)" "Bash(sleep:*)"
  "Bash(tee:*)" "Bash(comm:*)" "Bash(basename:*)" "Bash(dirname:*)" "Bash(realpath:*)" "Bash(readlink:*)"
  "Bash(prettier:*)" "Bash(eslint:*)" "Bash(tsc:*)" "Bash(vitest:*)"
  "Bash(for:*)" "Bash(while:*)" "Bash(if:*)" "Bash(jobs:*)" "Bash(export:*)" "Bash(set:*)"
  "Bash(type:*)" "Bash(seq:*)" "Bash(read:*)" "Bash(exit:*)" "Bash(pgrep:*)" "Bash(kill:*)" "Bash(wait:*)"
  "Bash(less:*)" "Bash(more:*)" "Bash(whoami:*)" "Bash(hostname:*)" "Bash(id:*)" "Bash(uname:*)"
)
# Remote-mutating git is DENIED outright. A deny rule beats every allow rule, so this holds
# even if someone re-widens the git allowances above. The driver owns pushing (AI_LOOP_PUSH).
DISALLOWED_BASH=(
  "Bash(git push:*)" "Bash(git remote:*)" "Bash(git send-email:*)" "Bash(git request-pull:*)"
  "Bash(git config:*)" "Bash(git -c:*)" "Bash(gh:*)"
)
# HEADLESS CONTRACT. A `claude -p` run is ONE non-interactive turn: when the model ends its
# turn the process exits and nothing resumes it. Cycle 2026-09-05T22-57-25 was lost exactly
# this way — the worker backgrounded its test run, "ended its turn" expecting a wake-up, and
# the loop found no provisional commit. CLAUDE_AUTO_BACKGROUND_TASKS is inherited from the
# orchestrator's environment and makes long commands go to the background automatically, so
# it is dropped here, and the appended system prompt states the contract outright.
HEADLESS_CONTRACT="EXECUTION CONTRACT FOR THIS RUN: you are a single non-interactive turn inside an automated dev-loop cycle (loop.sh). Nothing resumes you after you stop: there are no wake-ups, no scheduled follow-ups, and no notifications, and ending your turn with work unfinished FAILS the cycle and reverts everything you did. Therefore: never run commands in the background (never set run_in_background; wait for every command in the foreground, using a long timeout when a check is slow), never schedule anything, never say you will continue later. Do not stop until the cycle prompt's deliverables exist on disk — in commit mode that means the provisional commit is made and \`git status --porcelain\` is empty apart from the ledger file the prompt tells you to leave. Stay inside this repository checkout. CHECKS: run only FOCUSED checks — the specific test files for what you touched plus lint and format on those files; do NOT run npm run health, npm run health:fast, npm test, or the whole vitest suite yourself. The driver runs the correct bar after your provisional commit (and a red bar reverts the cycle), so a whole-suite run inside your turn only burns your time budget; the last worker ran the fast bar three times and nearly timed out."
# NO SESSION PERSISTENCE + STREAMED OUTPUT (v4). Cycles 2026-09-05T23-14-29 and 23-53-04 both
# finished their work and committed, then the CLI printed "Session ID <id> is already in use"
# and exited 1 without its result JSON. Subagent use did not separate survivors from victims,
# so the session registry is taken out of the picture: workers keep no persisted session
# (nothing to be "in use"), and the stream is written incrementally so a crash at the very
# end can no longer erase the cost/turn record or the worker's final report.
# MINIMAL ENVIRONMENT. Cycle 2026-09-05T23-14-29 died at the very end with "Session ID ... is
# already in use" right after the worker used the subagent tool twice; the orchestrator's
# remote-session environment (messaging socket, session ingress, scheduling backends,
# auto-background, autocompact override) had leaked into every worker. Verified: the CLI
# authenticates with only PATH/HOME, the proxy + CA settings, ANTHROPIC_BASE_URL and the
# host-provider marker. The loop's own AI_* knobs pass through so claim identity is the lane's.
MINIMAL_ENV=(
  "PATH=$PATH" "HOME=$HOME" "USER=${USER:-root}" "LANG=${LANG:-C.UTF-8}" "TERM=${TERM:-dumb}"
  "HTTPS_PROXY=${HTTPS_PROXY:-}" "https_proxy=${https_proxy:-}" "HTTP_PROXY=${HTTP_PROXY:-}" "http_proxy=${http_proxy:-}"
  "NO_PROXY=${NO_PROXY:-}" "no_proxy=${no_proxy:-}"
  "ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-}" "NODE_EXTRA_CA_CERTS=${NODE_EXTRA_CA_CERTS:-}" "SSL_CERT_FILE=${SSL_CERT_FILE:-}"
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=${CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST:-}"
)
for v in AI_AGENT AI_LANE_ID AI_LOOP_COMMIT AI_LOOP_PUSH AI_LOOP_TRIAGE_STORE AI_CLAIM_LEASE_HOURS AI_AGENT_TIMEOUT_SECONDS AI_LOOP_FULL_HEALTH ADVENTUREFORGE_WORLD_INTEGRITY_CACHE; do
  [[ -n "${!v:-}" ]] && MINIMAL_ENV+=("$v=${!v}")
done
# The agent runs in its OWN process group (setsid), started in the background and
# waited on, so a stop can take the whole tree with it. Observed 2026-09-07 00:11Z:
# a TERM to this launcher (loop.sh's timeout path or a manual stop) killed the wrapper,
# but the claude child ignored SIGTERM, was reparented to init, and kept editing the
# primary checkout for 18 minutes AFTER loop.sh had recorded the cycle as failed and
# exited. Now: TERM the group, wait up to 6s, KILL the group - inside the driver's 30s
# --kill-after budget. `wait` (not a foreground command) is what lets the trap run.
CLAUDE_PID=""
kill_agent_group() {
  [ -n "$CLAUDE_PID" ] || return 0
  kill -TERM -- "-$CLAUDE_PID" 2>/dev/null || kill -TERM "$CLAUDE_PID" 2>/dev/null || return 0
  for _ in 1 2 3 4 5 6; do
    kill -0 "$CLAUDE_PID" 2>/dev/null || return 0
    sleep 1
  done
  kill -KILL -- "-$CLAUDE_PID" 2>/dev/null || kill -KILL "$CLAUDE_PID" 2>/dev/null || true
  echo "dev-agent: agent group $CLAUDE_PID did not exit on TERM; sent KILL" >&2
}
trap 'kill_agent_group; exit 143' TERM INT HUP
# Background jobs in a non-interactive shell get /dev/null as stdin unless redirected
# explicitly; the prompt arrives on OUR stdin, so hand that exact fd to the agent.
exec 3<&0
env -i "${MINIMAL_ENV[@]}" \
  setsid claude -p --model "$DEV_AGENT_MODEL" --effort "$DEV_AGENT_EFFORT" \
  --append-system-prompt "$HEADLESS_CONTRACT" \
  --disallowedTools "Agent" "Task" "TaskCreate" "TaskGet" "TaskList" "TaskOutput" "TaskStop" "TaskUpdate" "CronCreate" "CronDelete" "CronList" "ScheduleWakeup" "PushNotification" "RemoteTrigger" "SendMessage" "Monitor" "ListAgents" "EnterWorktree" "ExitWorktree" "${DISALLOWED_BASH[@]}" \
  --permission-mode acceptEdits --session-id "$SESSION_ID" --setting-sources project \
  --allowedTools "${ALLOWED[@]}" \
  --max-budget-usd "$DEV_AGENT_MAX_BUDGET_USD" \
  --no-session-persistence \
  --output-format stream-json --verbose --add-dir "$PWD" > "$OUT" 2> "$ERR" <&3 &
CLAUDE_PID=$!
exec 3<&-
echo "dev-agent: agent pid/pgid=$CLAUDE_PID" >&2
wait "$CLAUDE_PID"
rc=$?
node - "$OUT" "$rc" <<'NODE'
const fs = require("node:fs");
const [out, rcArg] = process.argv.slice(2);
let rc = Number(rcArg);
let doc = null;
let events = 0;
try {
  for (const line of fs.readFileSync(out, "utf8").split("\n")) {
    if (!line.trim()) continue;
    events += 1;
    try { const ev = JSON.parse(line); if (ev.type === "result") doc = ev; } catch {}
  }
} catch (e) { console.log(`dev-agent: unreadable stream (${e.message}); exit=${rc}`); process.exit(rc || 1); }
if (!doc) { console.log(`dev-agent: stream ended without a result event after ${events} events; exit=${rc}`); process.exit(rc || 1); }
const u = doc.usage || {};
const summary = {
  subtype: doc.subtype, is_error: doc.is_error, turns: doc.num_turns, duration_s: Math.round((doc.duration_ms || 0) / 1000),
  cost_usd: doc.total_cost_usd, in: u.input_tokens, cache_w: u.cache_creation_input_tokens, cache_r: u.cache_read_input_tokens, out: u.output_tokens,
  denials: (doc.permission_denials || []).length,
};
console.log("dev-agent summary: " + JSON.stringify(summary));
if (summary.denials) console.log("dev-agent permission denials: " + JSON.stringify(doc.permission_denials).slice(0, 2000));
const text = typeof doc.result === "string" ? doc.result : "";
if (text) console.log("dev-agent result (tail): " + text.slice(-1500).replace(/\n/g, "\n  "));
if (rc === 0 && (doc.is_error || (doc.subtype && doc.subtype !== "success"))) rc = 3;
process.exit(rc);
NODE
