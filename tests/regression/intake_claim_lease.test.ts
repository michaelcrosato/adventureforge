/**
 * Work claims carry an owner and a lease — because `npm run work -- --claim` is how
 * parallel dev lanes divide the intake queue, and a claim that is only a status flip
 * divides nothing: every lane sees `in_progress`, nobody can tell whose it is, and the
 * next lane either duplicates the work or skips it forever. A lease keeps the other
 * failure out too: a lane that crashed mid-task must not hold its item hostage.
 *
 * The claim contract, pinned end-to-end through the real CLI (exit codes are the
 * interface a driver script sees):
 *   - a claim stamps who took it (env AI_LANE_ID, else AI_AGENT, else user@host) and when;
 *   - a FRESH claim held by another lane refuses nonzero and names the holder;
 *   - the same lane re-claiming refreshes its own lease;
 *   - an EXPIRED lease (AI_CLAIM_LEASE_HOURS, default 24) is reclaimable;
 *   - `--force` overrides a fresh foreign claim, loudly;
 *   - `--done`/`--decline` record who resolved it and keep the claim as history;
 *   - queue files written before these fields existed still parse and claim cleanly,
 *     and a source re-filing an item never clobbers the claim a lane holds on it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  SUBMISSION_SCHEMA_VERSION,
  SubmissionSchema,
  submissionId,
  titleKey,
  type Submission,
} from "../../src/intake/submission.js";
import {
  claimSubmission,
  readQueue,
  resolveClaimIdentity,
  upsertSubmission,
} from "../../src/intake/queue.js";

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const dirs: string[] = [];
function tempQueue(): string {
  const dir = mkdtempSync(join(tmpdir(), "af-claim-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

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
    ...over,
  });
}

/** Seed one submission into a temp queue and return it as stored. */
function seed(dir: string, over: Partial<Submission> = {}): Submission {
  return upsertSubmission(make(over), dir);
}

function stored(dir: string, id: string): Submission {
  const found = readQueue(dir).submissions.find((s) => s.id === id);
  expect(found, `submission ${id} should exist in ${dir}`).toBeDefined();
  return found!;
}

/** Run `bin/work.ts` as the loop does — a real child process, isolated claim env. */
function work(
  args: string[],
  env: Record<string, string> = {},
): { out: string; code: number | null } {
  const base = { ...process.env };
  // The machine running the tests may itself be a lane; its identity and lease
  // settings must not leak into the scenarios below.
  delete base.AI_LANE_ID;
  delete base.AI_AGENT;
  delete base.AI_CLAIM_LEASE_HOURS;
  const result = spawnSync(process.execPath, [TSX, "bin/work.ts", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...base, ...env },
  });
  return { out: `${result.stdout ?? ""}\n${result.stderr ?? ""}`, code: result.status };
}

describe("claim identity resolution", () => {
  it("prefers the lane id over the agent id over the machine", () => {
    expect(resolveClaimIdentity({ AI_LANE_ID: "lane-7", AI_AGENT: "codex" })).toBe("lane-7");
    expect(resolveClaimIdentity({ AI_AGENT: "codex" })).toBe("codex");
    expect(resolveClaimIdentity({})).toBe(`${userInfo().username}@${hostname()}`);
  });

  it("ignores blank env values rather than minting an empty identity", () => {
    expect(resolveClaimIdentity({ AI_LANE_ID: "  ", AI_AGENT: "codex" })).toBe("codex");
    expect(resolveClaimIdentity({ AI_LANE_ID: "", AI_AGENT: "" })).toBe(
      `${userInfo().username}@${hostname()}`,
    );
  });
});

describe("claiming through the CLI", () => {
  it("stamps who took the item and when", () => {
    const dir = tempQueue();
    const filed = seed(dir, { title: "claim me" });

    const { out, code } = work(["--claim", filed.id, "--queue", dir], { AI_LANE_ID: "lane-a" });

    expect(code).toBe(0);
    expect(out).toContain("lane-a");
    const after = stored(dir, filed.id);
    expect(after.status).toBe("in_progress");
    expect(after.claimed_by).toBe("lane-a");
    expect(Date.parse(after.claimed_at ?? "")).toBeGreaterThan(Date.now() - 3_600_000);
  });

  it("refuses a fresh claim held by another lane, nonzero, naming the holder", () => {
    const dir = tempQueue();
    const filed = seed(dir, {
      title: "already taken",
      status: "in_progress",
      claimed_by: "lane-a",
      claimed_at: hoursAgo(1),
    });

    const { out, code } = work(["--claim", filed.id, "--queue", dir], { AI_LANE_ID: "lane-b" });

    expect(code).toBe(1);
    expect(out).toContain("lane-a");
    expect(out).toMatch(/--force/);
    // The refusal must leave the holder's claim untouched.
    const after = stored(dir, filed.id);
    expect(after.claimed_by).toBe("lane-a");
    expect(after.claimed_at).toBe(filed.claimed_at);
  });

  it("lets the same lane re-claim, refreshing its lease", () => {
    const dir = tempQueue();
    const filed = seed(dir, {
      title: "mine already",
      status: "in_progress",
      claimed_by: "lane-a",
      claimed_at: hoursAgo(10),
    });

    const { code } = work(["--claim", filed.id, "--queue", dir], { AI_LANE_ID: "lane-a" });

    expect(code).toBe(0);
    const after = stored(dir, filed.id);
    expect(after.claimed_by).toBe("lane-a");
    expect(Date.parse(after.claimed_at ?? "")).toBeGreaterThan(Date.parse(filed.claimed_at!));
  });

  it("lets another lane take over once the default 24h lease has expired", () => {
    const dir = tempQueue();
    const filed = seed(dir, {
      title: "abandoned",
      status: "in_progress",
      claimed_by: "lane-a",
      claimed_at: hoursAgo(25),
    });

    const { out, code } = work(["--claim", filed.id, "--queue", dir], { AI_LANE_ID: "lane-b" });

    expect(code).toBe(0);
    // The takeover is announced, not silent — the old holder's logs should be explicable.
    expect(out).toMatch(/expired/i);
    expect(out).toContain("lane-a");
    const after = stored(dir, filed.id);
    expect(after.claimed_by).toBe("lane-b");
  });

  it("honours AI_CLAIM_LEASE_HOURS in both directions", () => {
    const dir = tempQueue();
    const filed = seed(dir, {
      title: "short lease",
      status: "in_progress",
      claimed_by: "lane-a",
      claimed_at: hoursAgo(2),
    });

    // 2h-old claim, 4h lease: still fresh, still refused.
    const refused = work(["--claim", filed.id, "--queue", dir], {
      AI_LANE_ID: "lane-b",
      AI_CLAIM_LEASE_HOURS: "4",
    });
    expect(refused.code).toBe(1);
    expect(stored(dir, filed.id).claimed_by).toBe("lane-a");

    // Same claim, 1h lease: expired, reclaimable.
    const taken = work(["--claim", filed.id, "--queue", dir], {
      AI_LANE_ID: "lane-b",
      AI_CLAIM_LEASE_HOURS: "1",
    });
    expect(taken.code).toBe(0);
    expect(stored(dir, filed.id).claimed_by).toBe("lane-b");
  });

  it("overrides a fresh foreign claim with --force, loudly", () => {
    const dir = tempQueue();
    const filed = seed(dir, {
      title: "contested",
      status: "in_progress",
      claimed_by: "lane-a",
      claimed_at: hoursAgo(1),
    });

    const { out, code } = work(["--claim", filed.id, "--queue", dir, "--force"], {
      AI_LANE_ID: "lane-b",
    });

    expect(code).toBe(0);
    expect(out).toMatch(/forc/i);
    expect(out).toContain("lane-a");
    expect(stored(dir, filed.id).claimed_by).toBe("lane-b");
  });

  it("records who resolved an item on --done, keeping the claim as history", () => {
    const dir = tempQueue();
    const filed = seed(dir, {
      title: "finished",
      status: "in_progress",
      claimed_by: "lane-a",
      claimed_at: hoursAgo(1),
    });

    const { code } = work(["--done", filed.id, "--queue", dir], { AI_LANE_ID: "lane-a" });

    expect(code).toBe(0);
    const after = stored(dir, filed.id);
    expect(after.status).toBe("done");
    expect(after.resolved_by).toBe("lane-a");
    expect(after.claimed_by).toBe("lane-a");
    expect(after.claimed_at).toBe(filed.claimed_at);
  });

  it("records who resolved an item on --decline too", () => {
    const dir = tempQueue();
    const filed = seed(dir, { title: "not doing this" });

    const { code } = work(["--decline", filed.id, "--queue", dir], { AI_AGENT: "codex" });

    expect(code).toBe(0);
    const after = stored(dir, filed.id);
    expect(after.status).toBe("declined");
    expect(after.resolved_by).toBe("codex");
  });

  it("still refuses an id the queue does not have", () => {
    const dir = tempQueue();
    const { out, code } = work(["--claim", "feedfacefeedface", "--queue", dir], {
      AI_LANE_ID: "lane-a",
    });
    expect(code).toBe(1);
    expect(out).toMatch(/no submission/);
  });
});

describe("compatibility with queue files from before claims existed", () => {
  const LEGACY_ID = "00000000000000aa";

  function writeLegacy(dir: string, status: "open" | "in_progress"): void {
    // The exact pre-claim schema shape, byte-written rather than built through today's
    // helpers, so a helper picking up new defaults cannot quietly modernise the fixture.
    const legacy = {
      schema_version: 1,
      id: LEGACY_ID,
      title: "filed before claims existed",
      body: "still needs doing",
      source: "audit",
      kind: "bug",
      priority: "P2",
      status,
      labels: [],
      area: null,
      evidence: { summary: "because", refs: [], lineages: [], observations: 1 },
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    };
    writeFileSync(
      join(dir, `P2-audit-${LEGACY_ID}.json`),
      `${JSON.stringify(legacy, null, 2)}\n`,
      "utf8",
    );
  }

  it("parses and claims an open legacy file cleanly", () => {
    const dir = tempQueue();
    writeLegacy(dir, "open");

    expect(readQueue(dir).unreadable).toEqual([]);
    const { code } = work(["--claim", LEGACY_ID, "--queue", dir], { AI_LANE_ID: "lane-a" });

    expect(code).toBe(0);
    const after = stored(dir, LEGACY_ID);
    expect(after.claimed_by).toBe("lane-a");
    expect(after.claimed_at).toBeDefined();
  });

  it("treats a legacy in_progress file with no claimant as claimable, not held", () => {
    const dir = tempQueue();
    writeLegacy(dir, "in_progress");

    const { code } = work(["--claim", LEGACY_ID, "--queue", dir], { AI_LANE_ID: "lane-b" });

    expect(code).toBe(0);
    expect(stored(dir, LEGACY_ID).claimed_by).toBe("lane-b");
  });
});

describe("re-filing does not clobber a claim", () => {
  it("preserves claim fields when a source re-files a claimed item", () => {
    const dir = tempQueue();
    const filed = seed(dir, { title: "recurring finding" });
    claimSubmission(filed.id, { identity: "lane-a" }, dir);

    // A playtest wave re-triages and re-files with fresh evidence, knowing nothing
    // about lanes. The claim a lane holds must survive that.
    upsertSubmission({ ...filed, body: "new evidence arrived" }, dir);

    const after = stored(dir, filed.id);
    expect(after.status).toBe("in_progress");
    expect(after.claimed_by).toBe("lane-a");
    expect(after.claimed_at).toBeDefined();
    expect(after.body).toBe("new evidence arrived");
  });

  it("keeps an unchanged re-file of a claimed item a byte-for-byte no-op", () => {
    const dir = tempQueue();
    const filed = seed(dir, { title: "idempotent while claimed" });
    claimSubmission(filed.id, { identity: "lane-a" }, dir);
    const name = readdirSync(dir)[0]!;
    const before = readFileSync(join(dir, name), "utf8");

    upsertSubmission(filed, dir);

    expect(readdirSync(dir)).toEqual([name]);
    expect(readFileSync(join(dir, name), "utf8")).toBe(before);
  });

  it("carries resolved_by through a re-file of finished work", () => {
    const dir = tempQueue();
    const filed = seed(dir, { title: "done and refiled" });
    claimSubmission(filed.id, { identity: "lane-a" }, dir);
    work(["--done", filed.id, "--queue", dir], { AI_LANE_ID: "lane-a" });

    upsertSubmission({ ...filed, body: "the source files it again" }, dir);

    const after = stored(dir, filed.id);
    expect(after.status).toBe("done");
    expect(after.resolved_by).toBe("lane-a");
  });
});
