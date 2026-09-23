# Parallel lanes — running several agents against this repo at once

This is the protocol for operating multiple coding/playtest agents — from any
vendor — against adventureforge **at the same time** without them destroying
each other's work. It exists because the failure mode is not hypothetical: a
dev-loop cycle that goes red hard-resets tracked work and cleans cycle-created
untracked paths, so two writers in one checkout revert each other mid-flight
(see `loop.sh`'s startup guards).

The certified core — engine, tests, gates, the pure playtest protocol — is not
changed by any of this. Lanes are a coordination convention layered on top.

## The iron rule: one writer per checkout

Every lane that edits files gets its **own git worktree on its own branch**.
The primary checkout belongs to whoever is landing/merging (normally the
orchestrator), and is otherwise left clean.

```bash
# one-time, per lane (from the primary checkout)
git worktree add .claude/worktrees/<lane-name> -b lane/<lane-name> origin/main
cd .claude/worktrees/<lane-name>
npm install && npm --prefix ui install
# Windows tip: junctioning node_modules from the primary checkout works and is
# much faster (New-Item -ItemType Junction), as long as the lane adds no deps.
```

Each worktree has its own `ai-runs/` (per-checkout, gitignored), its own pid
records, and its own branch; `loop.sh` additionally refuses to start when a
live loop already holds the checkout's `ai-runs/loop.pid` (stale records from
crashes are detected via the pid + start-tick identity and overwritten).
`playtest-loop.sh` likewise refuses to share a checkout with a live dev loop, and
writes its own `ai-runs/playtest-loop.pid` that `loop.sh` checks the same way.

## Lane types

| Lane                  | Does                                                                                              | Verifies with                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **content**           | Quest YAML, world copy, doctrine text, new packs                                                  | `npm run validate -- <quest_id>` + `verify:opening-density` + `crawl:smoke`, full `npm run health` before landing |
| **dev / engineering** | Engine, schemas, tooling, bugfixes (+ `traces/bugs/` artifact + regression per charter)           | `npm run health` (the bar), `crawl:smoke` pre/post if running loop cycles                                         |
| **playtest**          | Blind sessions against the **published build** (never the lane's own tree), triage, corroboration | `npm run doctor` for lane readiness; sessions record commit-bound evidence                                        |
| **ops**               | Queue hygiene, Linear mirror, CI, orchestration                                                   | n/a (no product edits)                                                                                            |

Any vendor can drive a dev/content lane: `loop.sh` auto-detects the first
installed of `codex`, `claude`, `gemini`; `AI_AGENT=<id>` selects explicitly;
`AI_AGENT_CMD="<command>"` accepts **any** CLI meeting the contract (prompt on
STDIN, edits `$PWD`, non-interactive, nonzero exit on failure) — e.g. a Grok
CLI can drive a lane today via `AI_AGENT_CMD` even before it has a registry
entry. Playtest lane vendor status is derived, not declared — `npm run doctor`
prints who is provable/drivable right now.

## Work routing: the intake queue is the bus

All work flows through `intake/queue/` (one JSON per submission,
content-addressed id — collision-free by construction):

```bash
npm run work -- --list          # what's open
npm run work -- --claim <id>    # take it (stamps your identity + timestamp)
npm run work -- --done <id>     # close it (stamps resolver)
```

Claims carry an owner and a lease so lanes don't duplicate work: identity
comes from `AI_LANE_ID` (set one per lane, e.g. `AI_LANE_ID=content-albany`),
falling back to `AI_AGENT`, then `<user>@<host>`. A fresh foreign claim
(younger than `AI_CLAIM_LEASE_HOURS`, default 24) refuses with the holder's
name; an expired lease is reclaimable; `--force` overrides loudly. Set
`AI_LANE_ID` in every lane's environment.

A human-facing mirror of the queue lives in Linear — see
`docs/linear_workflow.md`. The repo file is always the source of truth.

## Single-writer map (what still cannot be parallelized)

These are last-writer-wins or conflict-prone surfaces. One owner each:

- `content/world/new_york_overworld.json` — one content lane at a time, or
  partition edits by region and land quickly; every edit moves the world hash.
- `AI_LOOP_STATE.md` — written only by a dev loop, in its own worktree, sealed
  per cycle. Never hand-edit the machine-owned markers.
- `traces/bugs/` sequential ids — check the current max before minting; when
  two lanes fix bugs concurrently, the orchestrator assigns each lane a
  starting id range (e.g. lane B starts at the next free hundred).
- `docs/DECISION_LOG.md` — append-only; expect conflicts if two lanes append
  in one landing window; rebase keeps both.
- `package-lock.json` — dep changes are one-lane-at-a-time by convention.

## Landing protocol

1. Lane finishes; its branch is green on the granular gates it touched.
2. Full `npm run health` on the lane branch (the bar; budget it — the exhaustive
   census proofs are the large majority of its wall clock). `npm run health:fast`
   is the per-commit bar DURING the lane, not the one it lands on.
3. **Independent review by an agent that didn't write the change** — proven
   necessary: a 552-cycle AFK branch once passed every gate with two major
   semantic bugs still in it (gate-green ≠ review-clean; see PR #84 history).
4. PR to `main`; required CI check `verify` must pass; branches are strict
   up-to-date, so landings serialize — the orchestrator sequences them.
5. Never push directly to `main` (admin bypass exists but the charter forbids
   relying on it).

## The orchestrator

One interactive session (any capable agent harness) runs the room: it
dispatches lanes, watches `npm run loop:status` per worktree, triages the
queue, syncs the Linear mirror, sequences landings, and is the only place
push/merge decisions get made. Lanes never merge themselves.
