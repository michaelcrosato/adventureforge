/**
 * The intake queue: one inbox, many sources.
 *
 * These tests pin the properties that make a queue fed by continuously-running agents
 * survivable — stable identity, idempotent re-filing, lifecycle state the sources cannot
 * stomp, and an ordering that a loud source cannot hijack.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  compareSubmissions,
  defaultPriority,
  isOpenWork,
  SUBMISSION_SCHEMA_VERSION,
  SubmissionSchema,
  submissionFileName,
  submissionId,
  titleKey,
  type Submission,
} from "../../src/intake/submission.js";
import {
  nextWork,
  readQueue,
  setSubmissionStatus,
  summarizeQueue,
  upsertSubmission,
} from "../../src/intake/queue.js";
import {
  LINEAR_PRIORITY,
  linearAuthorization,
  linearIssueLabels,
  linearIssueTitle,
  linearUpsertPlan,
  parseLinearTitleId,
  pushLinearIssue,
} from "../../src/intake/linear.js";
import { submissionFromTicket, ticketPriority } from "../../src/qa/ticket_submission.js";
import type { QaTicket } from "../../src/qa/ticket.js";

const dirs: string[] = [];
function tempQueue(): string {
  const dir = mkdtempSync(join(tmpdir(), "af-intake-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function make(over: Partial<Submission> = {}): Submission {
  const source = over.source ?? "audit";
  const kind = over.kind ?? "bug";
  const now = "2026-08-28T12:00:00.000Z";
  return SubmissionSchema.parse({
    schema_version: SUBMISSION_SCHEMA_VERSION,
    id: submissionId({ source, kind, key: over.title ? titleKey(over.title) : "k" }),
    title: "a thing",
    body: "do the thing",
    source,
    kind,
    priority: "P2",
    status: "open",
    labels: [],
    area: null,
    evidence: { summary: "because", refs: [], lineages: [], observations: 1 },
    created_at: now,
    updated_at: now,
    external: null,
    ...over,
  });
}

describe("submission identity", () => {
  it("is stable across re-filing regardless of body or evidence", () => {
    const a = submissionId({ source: "audit", kind: "bug", key: "session-too-big" });
    const b = submissionId({ source: "audit", kind: "bug", key: "session-too-big" });
    expect(a).toBe(b);
  });

  it("separates the same key filed by different sources", () => {
    const audit = submissionId({ source: "audit", kind: "bug", key: "same" });
    const human = submissionId({ source: "human", kind: "bug", key: "same" });
    expect(audit).not.toBe(human);
  });

  it("defaults a human request above an unprompted agent proposal", () => {
    expect(defaultPriority("human", "feature")).toBe("P1");
    expect(defaultPriority("research", "feature")).toBe("P3");
    // A crawler bug is a reproduced invariant violation, not an opinion.
    expect(defaultPriority("crawler", "bug")).toBe("P0");
  });
});

describe("queue ordering", () => {
  it("sorts by priority before anything else", () => {
    const p0 = make({ priority: "P0", title: "p0" });
    const p3 = make({ priority: "P3", title: "p3" });
    expect([p3, p0].sort(compareSubmissions)[0]!.priority).toBe("P0");
  });

  it("does not let a loud source outrank a higher priority", () => {
    // 500 observations from one source must not beat a P1 with a single observation:
    // priority is a decision, and observation count is only an input to it.
    const loud = make({
      priority: "P2",
      title: "loud",
      evidence: { summary: "s", refs: [], lineages: ["gemini"], observations: 500 },
    });
    const considered = make({ priority: "P1", title: "considered" });
    expect([loud, considered].sort(compareSubmissions)[0]!.title).toBe("considered");
  });

  // `maxPriority` was declared in nextWork's signature and never applied, so a caller
  // asking for "nothing below P1" was handed the whole queue — the worst shape of no-op,
  // because a P3 answer to that question looks perfectly plausible.
  it("honours a maxPriority ceiling rather than accepting and ignoring it", () => {
    const p0 = make({ priority: "P0", title: "p0" });
    const p3 = make({ priority: "P3", title: "p3" });
    expect(nextWork([p0, p3], { maxPriority: "P1" })!.priority).toBe("P0");
    // The ceiling has to be able to answer "nothing that urgent is queued".
    expect(nextWork([p3], { maxPriority: "P1" })).toBeNull();
    expect(nextWork([p3])!.priority).toBe("P3");
  });

  it("breaks ties on independent lineages before raw counts", () => {
    const broad = make({
      title: "broad",
      evidence: { summary: "s", refs: [], lineages: ["a", "b", "c"], observations: 5 },
    });
    const deep = make({
      title: "deep",
      evidence: { summary: "s", refs: [], lineages: ["a"], observations: 50 },
    });
    expect([deep, broad].sort(compareSubmissions)[0]!.title).toBe("broad");
  });
});

describe("queue persistence", () => {
  it("round-trips a submission", () => {
    const dir = tempQueue();
    const stored = upsertSubmission(make({ title: "round trip" }), dir);
    const { submissions, unreadable } = readQueue(dir);
    expect(unreadable).toEqual([]);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.id).toBe(stored.id);
  });

  it("re-filing does NOT reset lifecycle state a dev agent set", () => {
    const dir = tempQueue();
    const filed = make({ title: "recurring" });
    upsertSubmission(filed, dir);
    setSubmissionStatus(filed.id, "in_progress", dir);

    // The source re-files every wave and must not stomp work already in flight.
    upsertSubmission({ ...filed, body: "new evidence arrived" }, dir);

    const stored = readQueue(dir).submissions.find((s) => s.id === filed.id)!;
    expect(stored.status).toBe("in_progress");
    expect(stored.body).toBe("new evidence arrived");
  });

  it("re-filing preserves the tracker issue it was mirrored to", () => {
    const dir = tempQueue();
    const filed = make({ title: "mirrored" });
    upsertSubmission(
      {
        ...filed,
        external: { provider: "github", number: 42, url: "u", synced_status: "open" },
      },
      dir,
    );
    upsertSubmission({ ...filed, body: "updated" }, dir);
    expect(readQueue(dir).submissions[0]!.external?.number).toBe(42);
  });

  it("revives a stale submission when fresh evidence re-files it", () => {
    const dir = tempQueue();
    const filed = make({ title: "revivable" });
    upsertSubmission(filed, dir);
    setSubmissionStatus(filed.id, "stale", dir);
    upsertSubmission(filed, dir);
    expect(readQueue(dir).submissions[0]!.status).toBe("open");
  });

  // These files are tracked, and loop.sh runs `qa:triage` — which upserts every
  // actionable ticket — inside the dev cycle, after the cycle-start cleanliness check.
  // An unconditional `updated_at` bump therefore manufactured a tracked-file diff out
  // of a corpus where nothing had moved, leaving every cycle with a dirty tree.
  it("re-filing an unchanged submission leaves the bytes on disk untouched", () => {
    const dir = tempQueue();
    const filed = make({ title: "idempotent" });
    upsertSubmission(filed, dir);
    const name = readdirSync(dir)[0]!;
    const before = readFileSync(join(dir, name), "utf8");

    const returned = upsertSubmission(filed, dir);

    expect(readdirSync(dir)).toEqual([name]);
    expect(readFileSync(join(dir, name), "utf8")).toBe(before);
    expect(returned.updated_at).toBe(filed.updated_at);
  });

  it("still stamps updated_at when a re-file genuinely changes something", () => {
    const dir = tempQueue();
    const filed = make({ title: "moved" });
    upsertSubmission(filed, dir);
    upsertSubmission({ ...filed, body: "new evidence arrived" }, dir);
    const stored = readQueue(dir).submissions[0]!;
    expect(stored.body).toBe("new evidence arrived");
    expect(stored.updated_at).not.toBe(filed.updated_at);
  });

  // A mirror sync calls upsert immediately after creating the issue, precisely to record
  // where it landed ("so the next sync is a no-op rather than a search"). Keeping
  // existing.external unconditionally discarded that, so the number was never stored.
  it("records an external mirror supplied by the sync", () => {
    const dir = tempQueue();
    const filed = make({ title: "mirrored" });
    upsertSubmission(filed, dir);
    upsertSubmission(
      {
        ...filed,
        external: {
          provider: "github",
          number: 7,
          url: "https://github.com/o/r/issues/7",
          synced_status: "open",
        },
      },
      dir,
    );
    expect(readQueue(dir).submissions[0]!.external).toMatchObject({ number: 7 });
  });

  it("never holds one id twice when its priority changes", () => {
    const dir = tempQueue();
    const filed = make({ title: "escalating", priority: "P3" });
    upsertSubmission(filed, dir);
    upsertSubmission({ ...filed, priority: "P0" }, dir);
    const { submissions } = readQueue(dir);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.priority).toBe("P0");
  });

  // readQueue parses strictly, so anything the write path lets through off-schema is a
  // file the queue can never read back: reported unreadable on every subsequent read,
  // invisible to `npm run work` and to the GitHub push loop, and re-minted identically
  // by whatever wrote it. `npm run submit -- --area ""` reached exactly that dead end.
  it("refuses to write a submission it could never read back", () => {
    const dir = tempQueue();
    const offSchema = { ...make({ title: "poison" }), area: "" } as Submission;
    expect(() => upsertSubmission(offSchema, dir)).toThrow(/refusing to write submission/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("reports an unreadable submission instead of hiding it", () => {
    const dir = tempQueue();
    writeFileSync(join(dir, "P1-human-deadbeefdeadbeef.json"), "{ not json", "utf8");
    const { submissions, unreadable } = readQueue(dir);
    expect(submissions).toHaveLength(0);
    expect(unreadable).toHaveLength(1);
  });

  it("hides finished work from the dev loop but keeps it in the queue", () => {
    const dir = tempQueue();
    const filed = make({ title: "finished" });
    upsertSubmission(filed, dir);
    setSubmissionStatus(filed.id, "done", dir);
    const { submissions } = readQueue(dir);
    expect(summarizeQueue(submissions).total).toBe(1);
    expect(summarizeQueue(submissions).open).toBe(0);
    expect(nextWork(submissions)).toBeNull();
    expect(isOpenWork(submissions[0]!)).toBe(false);
  });

  it("names files so a plain listing is already the queue order", () => {
    expect(submissionFileName(make({ priority: "P0", source: "crawler" }))).toMatch(
      /^P0-crawler-[0-9a-f]{16}\.json$/,
    );
  });
});

describe("playtest tickets crossing into the queue", () => {
  function ticket(over: Partial<QaTicket> = {}): QaTicket {
    return {
      schema_version: 1,
      ticket_id: "1234567890abcdef",
      title: "dispatch board unclear @ albany",
      kind: "bug",
      severity: "S2",
      status: "open",
      promotion: "corroborated",
      location: "albany_city",
      excerpts: ["the board does not say which option commits"],
      evidence: {
        report_count: 4,
        families: ["claude", "gemini", "gpt"],
        providers: ["claude_code", "gemini_cli", "codex"],
        tiers: ["reference", "volume"],
        has_runner_enforced_report: true,
        session_ids: ["s1", "s2"],
        first_seen_build: "a".repeat(40),
        last_seen_build: "a".repeat(40),
        first_seen_at: "2026-08-28T12:00:00.000Z",
        last_seen_at: "2026-08-28T13:00:00.000Z",
      },
      priority: 79.7,
      ...over,
    };
  }

  it("lifts a reproduced ticket above a merely corroborated one", () => {
    expect(ticketPriority(ticket({ promotion: "corroborated" }))).toBe("P2");
    expect(ticketPriority(ticket({ promotion: "verified" }))).toBe("P1");
  });

  it("carries the corroboration through as queue evidence", () => {
    const submission = submissionFromTicket(ticket());
    expect(submission.source).toBe("playtest");
    expect(submission.evidence.lineages).toEqual(["claude", "gemini", "gpt"]);
    expect(submission.evidence.observations).toBe(4);
    expect(submission.body).toContain("claude, gemini, gpt");
  });

  it("keeps one queue item for a finding's whole life", () => {
    const first = submissionFromTicket(
      ticket({ evidence: { ...ticket().evidence, report_count: 4 } }),
    );
    const later = submissionFromTicket(
      ticket({ evidence: { ...ticket().evidence, report_count: 40 }, severity: "S3" }),
    );
    expect(later.id).toBe(first.id);
  });

  it("says so when only unattestable sessions back a finding", () => {
    const submission = submissionFromTicket(
      ticket({ evidence: { ...ticket().evidence, has_runner_enforced_report: false } }),
    );
    expect(submission.body).toContain("operator-attested");
  });
});

describe("grok-4.6 wave playtest intake", () => {
  it("submit CLI upserts a playtest cluster on --key without duplicating", () => {
    const queue = tempQueue();
    const bodyFile = join(queue, "body.md");
    writeFileSync(bodyFile, "Steading Yard north blocked after one road.\n");
    const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const run = () =>
      execFileSync(
        "node",
        [
          tsx,
          "bin/submit.ts",
          "--source",
          "playtest",
          "--kind",
          "bug",
          "--priority",
          "P1",
          "--title",
          "Steading Yard north blocked: both approach routes selected after one road",
          "--body-file",
          bodyFile,
          "--key",
          "grok46-wave-steading-north-both-routes",
          "--label",
          "lane:content",
          "--observations",
          "63",
          "--lineage",
          "grok",
          "--queue",
          queue,
        ],
        { encoding: "utf8" },
      );
    const id = submissionId({
      source: "playtest",
      kind: "bug",
      key: "grok46-wave-steading-north-both-routes",
    });
    const first = run();
    const second = run();
    expect(first).toContain(id);
    expect(second).toContain(id);
    const files = readdirSync(queue).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    const stored = JSON.parse(readFileSync(join(queue, files[0]!), "utf8"));
    expect(stored.id).toBe(id);
    expect(stored.source).toBe("playtest");
    expect(stored.kind).toBe("bug");
    expect(stored.priority).toBe("P1");
    expect(stored.status).toBe("open");
    expect(stored.labels).toContain("lane:content");
    expect(stored.evidence.observations).toBe(63);
    expect(stored.evidence.lineages).toContain("grok");
  });
});

describe("two-surface playtest visibility intake", () => {
  it("submit CLI upserts the auto-corroboration ticket on --key without duplicating", () => {
    const queue = tempQueue();
    const bodyFile = join(queue, "body.md");
    writeFileSync(
      bodyFile,
      [
        "derivePromotion auto-corroborates reference-tier clusters.",
        "Linear/intake/queue is the short working board; qa/tickets is the idle shelf.",
        "",
      ].join("\n"),
    );
    const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const run = () =>
      execFileSync(
        "node",
        [
          tsx,
          "bin/submit.ts",
          "--source",
          "audit",
          "--kind",
          "bug",
          "--priority",
          "P1",
          "--title",
          "Grok-4.6 reference-tier auto-corroboration floods intake and Linear",
          "--body-file",
          bodyFile,
          "--key",
          "grok-reference-tier-autocorroboration",
          "--label",
          "lane:playtest",
          "--queue",
          queue,
        ],
        { encoding: "utf8" },
      );
    const id = submissionId({
      source: "audit",
      kind: "bug",
      key: "grok-reference-tier-autocorroboration",
    });
    const first = run();
    const second = run();
    expect(first).toContain(id);
    expect(second).toContain(id);
    const files = readdirSync(queue).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    const stored = JSON.parse(readFileSync(join(queue, files[0]!), "utf8"));
    expect(stored.id).toBe(id);
    expect(stored.source).toBe("audit");
    expect(stored.status).toBe("open");
  });
});

describe("Linear intake mapping", () => {
  it("prefixes titles with the 16-hex join key and maps P0–P3 to Urgent/High/Medium/Low", () => {
    expect(linearIssueTitle("33c83cbe8ead954b", "Steading Yard north blocked")).toBe(
      "[33c83cbe8ead954b] Steading Yard north blocked",
    );
    expect(parseLinearTitleId("[33c83cbe8ead954b] edited by a human")).toBe("33c83cbe8ead954b");
    expect(parseLinearTitleId("no prefix")).toBeNull();
    expect(LINEAR_PRIORITY.P0).toBe(1);
    expect(LINEAR_PRIORITY.P1).toBe(2);
    expect(LINEAR_PRIORITY.P2).toBe(3);
    expect(LINEAR_PRIORITY.P3).toBe(4);
  });

  it("emits intake-mirror, source:<source>, and lane:* labels", () => {
    const labels = linearIssueLabels(make({ source: "playtest", labels: ["lane:content"] }));
    expect(labels).toEqual(["intake-mirror", "source:playtest", "lane:content"]);
  });

  it("sends personal API keys raw and OAuth tokens as Bearer", () => {
    expect(linearAuthorization({ apiKey: "lin_api_test" })).toEqual({
      ok: true,
      header: "lin_api_test",
    });
    expect(linearAuthorization({ oauthAccessToken: "tok" })).toEqual({
      ok: true,
      header: "Bearer tok",
    });
    expect(linearAuthorization({})).toMatchObject({ ok: false });
  });

  it("upserts by [16-hex] title prefix instead of opening a duplicate", () => {
    const id = "33c83cbe8ead954b";
    expect(linearUpsertPlan([], id)).toEqual({ action: "create" });
    expect(
      linearUpsertPlan([{ id: "issue-1", title: `[${id}] Steading Yard north blocked` }], id),
    ).toEqual({ action: "update", issueId: "issue-1" });
    expect(
      linearUpsertPlan([{ id: "issue-1", title: `[${id}] title changed after filing` }], id),
    ).toEqual({ action: "update", issueId: "issue-1" });
    expect(linearUpsertPlan([{ id: "other", title: "[4806c6f8ade14c0b] room prose" }], id)).toEqual(
      { action: "create" },
    );
  });

  it("pushLinearIssue updates the existing Linear issue when the title prefix matches", async () => {
    const submission = make({
      source: "playtest",
      kind: "bug",
      priority: "P1",
      labels: ["lane:content"],
      title: "Steading Yard north blocked",
    });
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      calls.push(body);
      const issue = {
        id: "linear-issue-1",
        identifier: "MIC-40",
        url: "https://linear.app/michael-crosato/issue/MIC-40",
        title: linearIssueTitle(submission.id, submission.title),
        priority: 2,
        state: { name: "Todo" },
        labels: {
          nodes: [{ name: "intake-mirror" }, { name: "source:playtest" }, { name: "lane:content" }],
        },
      };
      return new Response(JSON.stringify({ data: { issueUpdate: { success: true, issue } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const result = await pushLinearIssue(
      "lin_api_test",
      {
        teamId: "team-1",
        projectId: "proj-1",
        labelIds: ["l1", "l2", "l3"],
        existing: [{ id: "linear-issue-1", title: `[${submission.id}] old wording` }],
        submission,
      },
      fetchImpl,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.action).toBe("updated");
    expect(result.issue.identifier).toBe("MIC-40");
    expect(calls[0]!.query).toContain("issueUpdate");
    expect((calls[0]!.variables as { id: string }).id).toBe("linear-issue-1");
  });
});
