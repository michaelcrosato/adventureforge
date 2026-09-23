/**
 * `npm run qa:triage` — the command that turns the playtest corpus into the dev loop's
 * inbox, exercised as the loop actually runs it: a real process, real directories, real
 * git history.
 *
 * Everything the triage functions do is unit-tested elsewhere by handing them evidence
 * directly. What only shows up here is what the CLI supplies AROUND those functions —
 * the recency spine it reads from git, and the bucket directory it rewrites in place.
 * Both of those had a silent failure that no in-process test could see.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { buildHistoryWarning, readBuildHistory } from "../../src/qa/build_history.js";
import { sealPlaytestSession, type PlaytestSessionBody } from "../../src/qa/session_record.js";
import { sha256Hex, writePlaytestSession } from "../../src/qa/session_store.js";
import { QaTicketSchema } from "../../src/qa/ticket.js";

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const TRANSCRIPT = "line one\nline two\n";

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Commits of this checkout, newest first — the same spine `bin/triage.ts` reads. */
function commits(): string[] {
  return execFileSync("git", ["log", "--format=%H"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
}

function session(
  build: string,
  index: number,
  overrides: Partial<Pick<PlaytestSessionBody, "provider" | "model">> = {},
): PlaytestSessionBody {
  return {
    schema_version: 1,
    recorded_at: `2026-08-28T12:0${index}:00.000Z`,
    game_session_id: `o-${index}`,
    run_seed: 500 + index,
    build: {
      git_commit: build,
      tracked_worktree_clean: true,
      world_id: "new_york_overworld",
      world_hash: "b".repeat(64),
    },
    provider: overrides.provider ?? {
      id: "codex",
      vendor: "openai",
      family: "gpt",
      isolation: "runner_enforced",
      transport_contract: "game-direct-mcp-v1",
    },
    model: overrides.model ?? { id: "gpt-5.3-codex-spark", tier: "volume", settings: {} },
    persona: { id: "default", title: "default", source_sha256: "c".repeat(64) },
    outcome: "abandoned",
    log: {
      turns: 12,
      accepted_decisions: null,
      transcript_filename: "transcript.jsonl",
      transcript_sha256: sha256Hex(TRANSCRIPT),
      transcript_bytes: Buffer.byteLength(TRANSCRIPT, "utf8"),
    },
    exit_interview: {
      clarity: 3,
      enjoyment: 3,
      goal_understood: true,
      got_stuck: false,
      confusions: [],
      bugs: [
        {
          where: "quest wolf_winter, room steading_yard, blocked exit north",
          severity: "S3",
          note: "Blocked reason claims both approaches selected; exactly one was.",
        },
      ],
      best_moment: "the wolf fight",
      worst_moment: "the blocked exit",
      would_replay: true,
      verdict: "Playable, but the blocked-exit copy is wrong and misleads.",
    },
    journey_receipt: null,
    failure_note: "stopped early",
  };
}

function corpus(build: string): string {
  const store = temp("af-triage-store-");
  writePlaytestSession(store, sealPlaytestSession(session(build, 0)), TRANSCRIPT);
  return store;
}

function triage(
  store: string,
  tickets: string,
  queue: string = temp("af-triage-q-"),
  extra: readonly string[] = [],
): { out: string; code: number | null } {
  const result = spawnSync(
    process.execPath,
    [TSX, "bin/triage.ts", "--store", store, "--tickets", tickets, "--queue", queue, ...extra],
    { cwd: ROOT, encoding: "utf8", timeout: 180_000 },
  );
  return { out: `${result.stdout ?? ""}\n${result.stderr ?? ""}`, code: result.status };
}

/** A git command in `cwd` that works on a machine with no global identity or signing. */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=qa-test",
      "-c",
      "user.email=qa-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function onlyTicket(dir: string): unknown {
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  return QaTicketSchema.parse(JSON.parse(readFileSync(join(dir, files[0]!), "utf8")));
}

describe("qa:triage on disk", () => {
  // AGENTS.md tells agents to rely on this: "triage ages findings out after
  // STALE_AFTER_BUILDS; do not hand-wave past either." Aging fails OPEN for a build the
  // checkout does not recognise, which is right for a build that was never published —
  // but the CLI used to hand triage only `git log -n200` of a repository long past 1,500
  // commits, so every session played on an older build was permanently exempt from the
  // rule. Those are exactly the findings most likely to be fixed already.
  //
  // Needs real history, which is why it runs against the checkout rather than a fixture;
  // CI checks out at fetch-depth 0 for the test shards.
  it("ages a finding whose build is older than any fixed recency window", () => {
    const history = commits();
    expect(history.length).toBeGreaterThan(300);
    const ancient = history.at(-1)!;

    const tickets = temp("af-triage-t-");
    const { out } = triage(corpus(ancient), tickets);

    expect(out).toMatch(/stale 1/);
    expect(onlyTicket(tickets)).toMatchObject({ status: "stale" });
  });

  it("leaves a finding on the current build alone", () => {
    const tickets = temp("af-triage-t-");
    const { out } = triage(corpus(commits()[0]!), tickets);

    expect(out).toMatch(/stale 0/);
    expect(onlyTicket(tickets)).toMatchObject({ status: "open" });
  });

  // The automatic promotion path (triage -> reconcileTicketSubmissions -> intake/queue)
  // had never been exercised end to end through the real CLI: every case above stops at
  // the ticket bucket. Two independent lineages reporting the same defect is what
  // `derivePromotion` requires to reach `corroborated`, the rung that actually crosses
  // into the queue.
  it("promotes a corroborated finding into intake/queue via the real CLI", () => {
    const build = commits()[0]!;
    const store = temp("af-triage-store-");
    writePlaytestSession(store, sealPlaytestSession(session(build, 0)), TRANSCRIPT);
    writePlaytestSession(
      store,
      sealPlaytestSession(
        session(build, 1, {
          provider: {
            id: "claude_code",
            vendor: "anthropic",
            family: "claude",
            isolation: "runner_enforced",
            transport_contract: "game-direct-mcp-v1",
          },
          model: { id: "claude-haiku-4-5-20251001", tier: "volume", settings: {} },
        }),
      ),
      TRANSCRIPT,
    );

    const tickets = temp("af-triage-t-");
    const queue = temp("af-triage-q-");
    const { out } = triage(store, tickets, queue);

    expect(onlyTicket(tickets)).toMatchObject({
      promotion: "corroborated",
      evidence: expect.objectContaining({ report_count: 2 }),
    });
    expect(out).toMatch(/Promoted 1 submission/);
    const submissionFiles = readdirSync(queue).filter((name) => name.endsWith(".json"));
    expect(submissionFiles).toHaveLength(1);
    const submission = JSON.parse(readFileSync(join(queue, submissionFiles[0]!), "utf8"));
    expect(submission).toMatchObject({ source: "playtest", kind: "bug", status: "open" });
  });

  // The bucket is rewritten wholesale every run, and a ticket file that stopped parsing
  // is not in the list triage carries forward — so it used to be deleted, taking a
  // maintainer's `wont_fix` and notes with it and reporting nothing at all.
  it("reports a ticket file it cannot parse and leaves it on disk", () => {
    const tickets = temp("af-triage-t-");
    const damaged = join(tickets, `S3-bug-${"f".repeat(16)}.json`);
    writeFileSync(damaged, '{ "schema_version": 1, "ticket_id": "half-writ', "utf8");

    const { out } = triage(corpus(commits()[0]!), tickets);

    expect(existsSync(damaged)).toBe(true);
    expect(readFileSync(damaged, "utf8")).toContain("half-writ");
    expect(out).toContain("unreadable ticket");
  });

  // bug_0652. `--verified` was a silent no-op for any id this corpus did not cluster:
  // exit 0, nothing stamped, nothing said. An id is a request, so one that promoted
  // nothing fails the run, by name, before anything is written.
  it("refuses a --verified id that matched no ticket, naming it and writing nothing", () => {
    const tickets = temp("af-triage-t-");
    const typo = "0123456789abcdef";
    const { out, code } = triage(corpus(commits()[0]!), tickets, undefined, [
      "--verified",
      typo,
      "--verified-by",
      "tests/regression/some_repro.test.ts",
    ]);

    expect(code).toBe(1);
    expect(out).toContain(`--verified ${typo} matched no current ticket`);
    expect(out).toContain("Nothing was written");
    expect(readdirSync(tickets).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("stamps a bucket ticket the corpus no longer mentions, even from an empty store", () => {
    // First run writes a real ticket; then it goes stale and its evidence leaves the store,
    // which is exactly what a later maintainer reproducing it would find.
    const tickets = temp("af-triage-t-");
    triage(corpus(commits()[0]!), tickets);
    const [file] = readdirSync(tickets).filter((name) => name.endsWith(".json"));
    const path = join(tickets, file!);
    const written = QaTicketSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    writeFileSync(path, `${JSON.stringify({ ...written, status: "stale" }, null, 2)}\n`);

    const queue = temp("af-triage-q-");
    const { out, code } = triage(temp("af-triage-empty-"), tickets, queue, [
      "--verified",
      written.ticket_id,
      "--verified-by",
      "tests/regression/some_repro.test.ts",
    ]);

    expect(code, out).toBe(0);
    expect(onlyTicket(tickets)).toMatchObject({
      ticket_id: written.ticket_id,
      status: "open",
      promotion: "verified",
      verified_by: "tests/regression/some_repro.test.ts",
    });
    expect(readdirSync(queue).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });
});

// bug_0650. Triage now ages a build a COMPLETE history cannot place, so whether the spine
// is complete is load-bearing: a shallow clone reported as complete would stale every
// ticket at once. Proven against a real shallow clone of a throwaway repository rather
// than trusted.
describe("the recency spine triage ages against", () => {
  function repoWithCommits(count: number): string {
    const dir = temp("af-spine-origin-");
    git(dir, ["init", "--quiet"]);
    for (let i = 0; i < count; i += 1) {
      writeFileSync(join(dir, "f.txt"), `${i}\n`);
      git(dir, ["add", "f.txt"]);
      git(dir, ["commit", "--quiet", "-m", `c${i}`]);
    }
    return dir;
  }

  it("reports a full clone as complete, newest commit first", () => {
    const origin = repoWithCommits(3);
    const history = readBuildHistory(origin);
    expect(history).toMatchObject({ truncated: false, reason: null });
    expect(history.commits).toHaveLength(3);
    expect(history.commits[0]).toBe(git(origin, ["rev-parse", "HEAD"]).trim());
    expect(buildHistoryWarning(history)).toBeNull();
  });

  it("reports a shallow clone as truncated and tells the operator how to fix it", () => {
    const origin = repoWithCommits(3);
    const clone = join(temp("af-spine-clone-"), "shallow");
    git(tmpdir(), ["clone", "--quiet", "--depth", "1", pathToFileURL(origin).href, clone]);

    const history = readBuildHistory(clone);
    expect(history).toMatchObject({ truncated: true, reason: "shallow" });
    expect(history.commits).toHaveLength(1);
    expect(buildHistoryWarning(history)).toContain("git fetch --unshallow");
  });

  it("reports a directory git cannot read as truncated, never as complete", () => {
    const history = readBuildHistory(temp("af-spine-none-"));
    expect(history).toEqual({ commits: [], truncated: true, reason: "unreadable" });
    expect(buildHistoryWarning(history)).toContain("could not be read");
  });
});
