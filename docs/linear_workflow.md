# Linear workflow - the human ticket surface

The repo's machine work-queue is `intake/queue/` (see `docs/parallel_lanes.md`
and `intake/queue/README.md`). Linear mirrors it for human visibility,
prioritization, and assignment:

- **Workspace/project**: Linear project **AdventureForge**
  (linear.app/michael-crosato, team `MIC`).
- **Join key**: every mirrored issue's title starts with the repo submission id
  as `[16-hex]`. That id is the handle for `npm run work -- --claim/--done`.
- **Priority map**: repo `P0/P1/P2/P3` -> Linear Urgent/High/Medium/Low.
- **Labels**: `intake-mirror` (mirrored item), `source:audit|playtest|...`
  (submission source), `lane:content|dev|playtest|ops` (routing suggestion).

## Source of truth

The JSON file in `intake/queue/` wins every disagreement. Linear is a mirror:
closing an issue in Linear does **not** close the repo item, and vice versa,
until a sync runs. Never let an agent treat Linear state as authoritative.

## How it syncs

The repository provides a scripted two-way sync:

```bash
LINEAR_API_KEY=... npm run intake:sync:linear -- --dry-run
LINEAR_API_KEY=... npm run intake:sync:linear
```

`LINEAR_PROJECT` defaults to `adventureforge-59cb5298fba1` and `LINEAR_TEAM`
defaults to `MIC`; both can be overridden for a fork. The key is read only from
the local environment. `--push-only`, `--pull-only`, and `--queue <dir>` are
available for bounded runs.

- repo -> Linear: local submissions are upserted by the `[16-hex]` title marker,
  with priority, metadata, labels, and local lifecycle state mirrored; local
  `done`, `declined`, and `stale` items move to a completed Linear state.
- Linear -> repo: unmarked issues are adopted as open human submissions, remote
  priority changes become queue priority edits, and assignees are printed as
  claim suggestions.

Linear workflow state is never imported as a local close. If somebody closes an
issue in Linear while the queue still says `open` or `in_progress`, the next
push reopens it to match the repository. Run `--dry-run` before the first write
and after manual Linear changes.

The Linear MCP connection is useful for interactive work, but the scripted sync
uses the same public GraphQL API directly so it can run from a checkout. If the
MCP connection or API key is unavailable, the local queue remains usable and the
sync reports the reason without failing the dev loop.

The dev loop pulls automatically: `loop.sh` runs
`npm run intake:sync:linear -- --pull-only` at every cycle start (and while
idling on an empty queue), best-effort and fail-open — no credential or a
tracker outage prints one line and the cycle continues on the queue as it
stands. Set `AI_LOOP_LINEAR_PULL=0` to opt a lane out (for example an offline
worktree). Queue edits the pull makes are ordinary tracked changes that ride the
cycle's provisional commit; a reverted cycle re-adopts them idempotently by
marker.

## First-time setup

One credential, three commands. The workspace side (team `MIC`, project
`AdventureForge`, and the `intake-mirror` / `source:*` / `lane:*` labels)
already exists; the sync creates any label it is missing.

1. Create a personal API key in Linear: **linear.app → Settings → Security &
   access → Personal API keys → New API key** (label it something like
   `adventureforge sync`). Copy the key when it is shown.
2. In the repo root, create a file named `.env` containing one line:
   `LINEAR_API_KEY=<the key>`. `.env` is gitignored, the sync loads it itself
   (real environment variables win over the file), and the key is sent only to
   `api.linear.app`. Never commit or paste the key anywhere else.
3. Prove the wiring read-only, then live:

   ```bash
   npm run intake:sync:linear -- --dry-run
   npm run intake:sync:linear
   ```

## Submitting requests from the Linear side

File an ordinary issue **in the AdventureForge project** — no marker, no special
format. On the next pull (the dev loop's cycle start, or a manual sync) it is
adopted into `intake/queue/` as an open `human` submission: title and
description become the work item, Linear Urgent/High/Medium/Low maps to
`P0/P1/P2/P3`, and an optional `kind:bug|feature|...` label picks the submission
kind (default `feature`). The issue then gains the `[16-hex]` marker and
`intake-mirror` label on the next push, which is how you know the repo has it.
Closing the issue in Linear never closes the repo item — agents close work with
`npm run work -- --done <id>`, and the sync moves the issue to Done.

## What humans do in Linear

Reprioritize, assign to a lane (set the `lane:*` label or assignee), and comment
context. Agents pull work from the repo queue; the sync carries priority changes
into queue files and prints claim suggestions for assignees. Linear is the human
project surface for this workflow, not the local source of truth.
