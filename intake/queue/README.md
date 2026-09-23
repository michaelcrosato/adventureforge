# Intake queue

**The dev loop's inbox.** One JSON file per submission, named
`<priority>-<source>-<id>.json`, so a plain `ls` is already the queue order.

Anything can file here — playtest triage after corroboration, an independent
audit agent, a research or design proposal, the deterministic crawler, or a
person. Playtest feedback is *one* source, not the only one.

```bash
npm run work                     # what to build next
npm run work -- --list           # the whole open queue
npm run submit -- --source research --kind feature --title "..." --body "..."
```

## Why it is tracked in git

The dev loop runs against a checkout, so a submission that only exists on the
machine that filed it is one the dev loop cannot act on. Closed (`done` /
`declined`) items are pruned from the tree once resolved; git history keeps each one next to the commits that closed it. A pruned key that
is filed again starts over as a fresh open item.

## Priority is not severity

Severity says how bad it is; priority says when we do it. A cosmetic defect on
the opening screen can outrank a severe one in content nobody reaches.

See [`../../docs/two_loop_workflow.md`](../../docs/two_loop_workflow.md).
