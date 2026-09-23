# QA ticket bucket

The QA triage bucket that feeds the dev loop's inbox (`intake/queue/`). Written by
`npm run qa:triage`, which `loop.sh` runs at the start of every cycle and which
promotes corroborated findings into `intake/queue/`; read by `npm run qa:bucket`.

Tracked in git on purpose: the dev loop runs against a checkout, so a ticket that
only exists on the QA machine is a ticket it cannot act on. Keeping tickets here
also puts a finding's whole life — filed, worked, fixed — next to the commits
that closed it.

One JSON file per ticket, named `<severity>-<kind>-<id>.json`, so a plain `ls` groups
tickets by severity and two people editing different tickets never conflict. Mind the
direction: severity is ASCENDING (S0 is the mildest, S4 the most severe — the reverse of
the usual S1-is-critical scale), so `ls` lists the mildest first; `ls -r` puts the worst
on top, and `npm run qa:bucket` is the real triaged view.

An empty bucket is normal. It means the fleet has not yet corroborated anything
new, and the dev loop proceeds on the assessor's own candidates — it never stalls
waiting for QA.

## Promotion, and the single-lineage trap

A ticket reaches the dev loop's queue at `corroborated` (two distinct lineages, or reference
tier) or `verified` (something with no opinion reproduced it). `report_count` is recorded but
deliberately does NOT promote: twenty reports from one model lineage are one opinion repeated.

That leaves a real gap when a cohort runs one vendor, and the answer is reproduction rather
than a weaker threshold. The cycle prompt surfaces accumulating BUG tickets with two or more
reports as **unverified leads**; a worker may act on one only after reproducing it
deterministically, and records that with

```bash
npm run qa:triage -- --verified <ticket_id> --verified-by tests/regression/<the test>.ts
```

which writes `verified_by` onto the ticket file. Triage carries that field forward by
identity, so the promotion is durable rather than a one-run override, and it also exempts the
ticket from staleness — a proved defect should not age out for want of fresh reports.
`experience` tickets are never offered as leads: how the game reads is not a thing a test can
settle.

## Retention

The bucket is bounded, and this is the one place that says how.

Triage merges rather than replaces, so for a long time nothing ever left: a
ticket the current corpus said nothing about was carried forward untouched. That
is right for a ticket somebody decided something about and wrong for the rest,
and the arithmetic showed it — four playtest waves grew this directory to **633
tracked files, every one of them `stale`**, which is 27% of the repository's file
count for 3% of its bytes. A stale ticket is by definition one the dev loop may
not pick up, so the whole bucket was noise in every `ls`, every `rg`, and every
agent's index, and the signal it was supposed to carry was buried in it.

So `isRetireable` in [`../../src/qa/triage.ts`](../../src/qa/triage.ts) drops a
carried-forward ticket when **all** of these hold, and keeps it otherwise:

- its status is `stale` — it went more than `STALE_AFTER_BUILDS` builds without a
  fresh report while unverified, and then the corpus stopped mentioning it at all;
- it carries no `notes`, the one field nothing can regenerate;
- it has no `superseded_by` links, which preserve the history of a corrected identity;
- the current corpus produced at least one cluster, so triage has some basis for
  concluding anything went quiet. Against an empty or half-synced store — a fresh
  clone, a lane worktree, one machine's shard — every ticket looks silent, and
  nothing retires.

`open`, `in_progress`, `fixed`, `verified_fixed` and `wont_fix` are somebody's
live position and never retire, whatever their age.

Retirement is a decision about the file, not the finding. A ticket's id is derived
from its cluster's stable identity and its evidence is recomputed from the
contributing sessions every run, so a recurrence rebuilds the same ticket under the
same filename. What it does cost is the trail of a finding nobody acted on — a
deliberate trade, since the retired file stays in Git history, which is where
[`AGENTS.md`](../../AGENTS.md) ("Token Economy") already keeps old detail.

`tests/unit/qa_playtest_pipeline.test.ts` pins both halves of the rule.

## Corrected region identities

Schema v2 includes `superseded_by` for old whole-region tickets whose identities
omitted the region. Migration requires every original session and reproduces the
exact old identity, evidence and excerpts. A partial corpus leaves the old ticket
untouched. Version 1 tickets remain readable.

A superseded ticket keeps its status, notes and evidence, but is excluded from
actionable work. `qa:bucket --all` shows its replacement IDs. A single unambiguous
successor inherits workflow state unless it already has its own; a split inherits
neither the old claim nor its corroboration.

Triage also declines an already-promoted pending intake item with that exact old
identity, retaining its body, evidence, claim and tracker pointers and adding
replacement references. Completed and declined decisions remain intact. Tracker
pointers stay on the predecessor. Reconciliation uses the saved links, so a retry
after writing the ticket bucket still corrects the intake queue.

See [`../../docs/two_loop_workflow.md`](../../docs/two_loop_workflow.md).
