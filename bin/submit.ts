#!/usr/bin/env -S npx tsx
/**
 * File a submission into the intake queue.
 *
 * This is how anything that is not the playtest loop gets work to the dev loop: an audit
 * agent that found a structural problem, a research agent proposing a mechanic, a person
 * who wants a feature. One command, no clone of the tracker, no API token required —
 * the queue is a directory in the repo.
 *
 * Re-filing the same thing is safe and expected. Identity is content-addressed on
 * source + kind + key, so an agent that re-runs its audit every night updates its own
 * submissions instead of filing a hundred duplicates. Lifecycle state the queue owns
 * (status, and the tracker issue it is mirrored to) survives a re-file, so re-filing
 * never resets something a dev agent is already working.
 *
 * Usage:
 *   npm run submit -- --source audit --kind bug --title "..." --body "..." \
 *     [--priority P1] [--area src/world/session.ts] [--key stable-identity] \
 *     [--ref path/or/url ...] [--label perf]
 *
 *   # body from a file or stdin, for anything longer than a line
 *   npm run submit -- --source research --kind feature --title "..." --body-file plan.md
 *   cat plan.md | npm run submit -- --source research --kind feature --title "..." --body -
 */
import { readFileSync } from "node:fs";
import {
  defaultPriority,
  externalMirrors,
  SubmissionEvidenceSchema,
  SubmissionKindSchema,
  SubmissionPrioritySchema,
  SubmissionSourceSchema,
  SUBMISSION_SCHEMA_VERSION,
  submissionId,
  titleKey,
  type Submission,
} from "../src/intake/submission.js";
import { DEFAULT_QUEUE_DIR } from "../src/intake/submission.js";
import { upsertSubmission } from "../src/intake/queue.js";

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || (value.startsWith("--") && value !== "-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function required(flag: string): string {
  const value = arg(flag);
  if (value === null) throw new Error(`${flag} is required`);
  return value;
}

/** Every occurrence of a repeatable flag, so `--ref a --ref b` collects both. */
function allArgs(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === flag && process.argv[i + 1] !== undefined)
      out.push(process.argv[i + 1]!);
  }
  return out;
}

function resolveBody(): string {
  const file = arg("--body-file");
  if (file) return readFileSync(file, "utf8");
  const inline = arg("--body");
  // `--body -` reads stdin, which is how an agent hands over a long markdown plan
  // without shell-quoting it.
  if (inline === "-") return readFileSync(0, "utf8");
  if (inline) return inline;
  throw new Error("one of --body, --body-file, or --body - is required");
}

function main(): void {
  const source = SubmissionSourceSchema.parse(required("--source"));
  const kind = SubmissionKindSchema.parse(required("--kind"));
  const title = required("--title");
  const body = resolveBody().trim();
  if (body.length === 0) throw new Error("the submission body is empty");

  const priority = arg("--priority")
    ? SubmissionPrioritySchema.parse(arg("--priority"))
    : defaultPriority(source, kind);

  // An explicit --key is how a repeating agent keeps ONE submission across runs even
  // when it rewords the title. Without one the slugged title is the identity, which is
  // right for a person filing once.
  const key = arg("--key") ?? titleKey(title);

  const now = new Date().toISOString();
  const submission: Submission = {
    schema_version: SUBMISSION_SCHEMA_VERSION,
    id: submissionId({ source, kind, key }),
    title,
    body,
    source,
    kind,
    priority,
    status: "open",
    labels: allArgs("--label"),
    area: arg("--area"),
    evidence: SubmissionEvidenceSchema.parse({
      summary: arg("--summary") ?? `Filed by ${source}.`,
      refs: allArgs("--ref"),
      lineages: allArgs("--lineage"),
      observations: Number.parseInt(arg("--observations") ?? "1", 10),
    }),
    created_at: now,
    updated_at: now,
    external: null,
  };

  const dir = arg("--queue") ?? DEFAULT_QUEUE_DIR;
  const stored = upsertSubmission(submission, dir);
  console.log(
    `${stored.priority} ${stored.source}/${stored.kind} ${stored.id} — ${stored.title}` +
      `\n  status ${stored.status}; queued in ${dir}` +
      (externalMirrors(stored).length > 0
        ? `; mirrored as ${externalMirrors(stored)
            .map((mirror) =>
              mirror.provider === "github"
                ? `GitHub #${mirror.number}`
                : `Linear ${mirror.identifier}`,
            )
            .join(", ")}`
        : "") +
      `\n  run \`npm run intake:sync:linear\` to mirror it`,
  );
}

main();
