import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clusterIssues, type IssueRecord } from "../../src/feedback/cluster.js";
import type { LocationIndex } from "../../src/feedback/normalize.js";
import type { CanonicalLocation } from "../../src/feedback/schema.js";
import { sealPlaytestSession } from "../../src/qa/session_record.js";
import { readQueue, upsertSubmission } from "../../src/intake/queue.js";
import { isOpenWork, type Submission } from "../../src/intake/submission.js";
import { sha256Hex, writePlaytestSession } from "../../src/qa/session_store.js";
import { isActionable, QaTicketSchema, type QaTicket } from "../../src/qa/ticket.js";
import {
  reconcileTicketSubmissions,
  submissionFromTicket,
  submissionsFromTickets,
} from "../../src/qa/ticket_submission.js";
import { readTickets, summarizeBucket, writeTickets } from "../../src/qa/ticket_store.js";
import { triagePlaytestCorpus } from "../../src/qa/triage.js";

const BUILD = "a".repeat(40);
const TRANSCRIPT = "structural QA fixture\n";
const tempDirs: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "af-region-migration-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function diskSnapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  );
}
const region = (name: string): Omit<CanonicalLocation, "raw"> => ({
  kind: "overworld",
  questId: null,
  region: name,
  node: null,
  sceneId: null,
});
const locationIndex: LocationIndex = {
  ids: new Map([
    ["capital_mohawk", [region("Capital / Mohawk")]],
    ["central_new_york", [region("Central New York")]],
  ]),
  names: [],
};

function report(
  where: string,
  family: "gpt" | "claude",
  note = "Travel time is doubled",
  recordedAt = "2026-09-05T08:00:00.000Z",
) {
  const transcript = TRANSCRIPT;
  return sealPlaytestSession({
    schema_version: 1,
    recorded_at: recordedAt,
    game_session_id: `fixture-${family}-${where}`,
    run_seed: 7,
    build: {
      git_commit: BUILD,
      tracked_worktree_clean: true,
      world_id: "new_york_overworld",
      world_hash: "b".repeat(64),
    },
    provider: {
      id: family === "gpt" ? "codex" : "claude_code",
      vendor: family === "gpt" ? "openai" : "anthropic",
      family,
      isolation: "runner_enforced",
      transport_contract: "game-direct-mcp-v1",
    },
    model: {
      id: family === "gpt" ? "gpt-5.3-codex-spark" : "claude-sonnet-5",
      tier: "volume",
      settings: {},
    },
    persona: { id: "default", title: "default", source_sha256: "c".repeat(64) },
    outcome: "abandoned",
    log: {
      turns: 1,
      accepted_decisions: null,
      transcript_filename: "transcript.jsonl",
      transcript_sha256: sha256Hex(transcript),
      transcript_bytes: Buffer.byteLength(transcript, "utf8"),
    },
    exit_interview: {
      clarity: 3,
      enjoyment: 3,
      goal_understood: true,
      got_stuck: false,
      confusions: [],
      bugs: [{ where, severity: "S2", note }],
      best_moment: "travel",
      worst_moment: "travel cost",
      would_replay: true,
      verdict: "Check the travel cost.",
    },
    journey_receipt: null,
    failure_note: "structural fixture",
  });
}

const triage = (sessions: ReturnType<typeof report>[]) =>
  triagePlaytestCorpus({ sessions, locationIndex, buildHistory: [BUILD] });

/** Reproduce the persisted v1 identity: whole regions had no distinguishing key. */
function legacyTicket(sessions: ReturnType<typeof report>[]): QaTicket {
  const legacyIndex: LocationIndex = {
    ids: new Map(
      [...locationIndex.ids].map(([id, locations]) => [
        id,
        locations.map((location) => ({ ...location, region: null })),
      ]),
    ),
    names: [],
  };
  const result = triagePlaytestCorpus({
    sessions,
    locationIndex: legacyIndex,
    buildHistory: [BUILD],
  });
  expect(result.tickets).toHaveLength(1);
  return { ...result.tickets[0]!, schema_version: 1 };
}

function retriage(sessions: ReturnType<typeof report>[], existingTickets: QaTicket[]) {
  return triagePlaytestCorpus({ sessions, existingTickets, locationIndex, buildHistory: [BUILD] });
}

describe("region-level QA identity", () => {
  it.each(["Travel time is doubled", "Travel duration was doubled on the road"])(
    "does not corroborate separate regions with matching issue text: %s",
    (secondNote) => {
      const sessions = [
        report("capital_mohawk", "gpt"),
        report("central_new_york", "claude", secondNote),
      ];
      const result = triage(sessions);
      expect(result.tickets).toHaveLength(2);
      expect(result.tickets.map((ticket) => ticket.location).sort()).toEqual([
        "Capital / Mohawk",
        "Central New York",
      ]);
      for (const ticket of result.tickets) {
        expect(ticket.promotion).toBe("accumulating");
        expect(ticket.evidence.report_count).toBe(1);
        expect(ticket.evidence.families).toHaveLength(1);
      }
      expect(triage([...sessions].reverse()).tickets).toEqual(result.tickets);
    },
  );

  it("corroborates the same region and labels it with its canonical name", () => {
    const result = triage([report("capital_mohawk", "gpt"), report(" CAPITAL_MOHAWK ", "claude")]);
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0]).toMatchObject({
      location: "Capital / Mohawk",
      promotion: "corroborated",
      evidence: { report_count: 2, families: ["claude", "gpt"] },
    });
  });

  it("keeps a known node's identity independent of its region display name", () => {
    const atNode = (regionName: string, ref: string): IssueRecord => ({
      source: "fleet",
      ref,
      location: { ...region(regionName), node: "albany_city", raw: ["Albany"] },
      severity: "S2",
      text: "Travel time is doubled",
      persona: null,
      target: "overworld",
    });
    const before = atNode("Capital / Mohawk", "before");
    const after = atNode("Renamed region", "after");
    expect(clusterIssues([before])[0]!.key).toBe(clusterIssues([after])[0]!.key);
    expect(clusterIssues([before, after])).toHaveLength(1);
  });
});

describe("saved region tickets", () => {
  const sessions = [report("capital_mohawk", "gpt"), report("central_new_york", "claude")];

  it("supersedes an exactly reproduced false corroboration and preserves its history", () => {
    const prior = {
      ...legacyTicket(sessions),
      status: "in_progress" as const,
      notes: "Investigating.",
    };
    expect(isActionable(prior)).toBe(true);
    expect(prior.ticket_id).toBe("957bf394c9a47611"); // persisted pre-fix identity
    const result = retriage(sessions, [prior]);
    const successors = result.tickets.filter((ticket) => ticket.ticket_id !== prior.ticket_id);
    expect(successors).toHaveLength(2);
    expect(result.tickets.find((ticket) => ticket.ticket_id === prior.ticket_id)).toEqual({
      ...prior,
      schema_version: 2,
      superseded_by: successors.map((ticket) => ticket.ticket_id).sort(),
    });
    for (const successor of successors) {
      expect(successor.status).toBe("open");
      expect(successor.notes).toBeUndefined();
      expect(successor.promotion).toBe("accumulating");
    }
    expect(result.actionable).toEqual([]);
    expect(submissionsFromTickets(result.tickets)).toEqual([]);
    expect(result.stats).toMatchObject({ corroborated: 0, accumulating: 2, superseded: 1 });
    expect(retriage([...sessions].reverse(), [...result.tickets].reverse()).tickets).toEqual(
      result.tickets,
    );
    expect(retriage([], result.tickets).tickets).toEqual(result.tickets);
    result.tickets.forEach((ticket) => expect(QaTicketSchema.parse(ticket)).toEqual(ticket));
    expect(summarizeBucket(result.tickets)).toMatchObject({
      total: 3,
      actionable: 0,
      superseded: 1,
      byPromotion: { accumulating: 2 },
    });
  });

  it.each(["in_progress", "wont_fix", "verified_fixed"] as const)(
    "transfers %s and notes only to a single unambiguous successor",
    (status) => {
      const sameRegion = [report("capital_mohawk", "gpt"), report(" CAPITAL_MOHAWK ", "claude")];
      const prior = { ...legacyTicket(sameRegion), status, notes: "Keep this decision." };
      const result = retriage(sameRegion, [prior]);
      expect(result.tickets).toHaveLength(2);
      const successor = result.tickets.find((ticket) => ticket.ticket_id !== prior.ticket_id)!;
      expect(successor).toMatchObject({ location: "Capital / Mohawk", status, notes: prior.notes });
      expect(result.tickets.find((ticket) => ticket.ticket_id === prior.ticket_id)).toMatchObject({
        status,
        notes: prior.notes,
        superseded_by: [successor.ticket_id],
      });
      expect(retriage(sameRegion, result.tickets).tickets).toEqual(result.tickets);
    },
  );

  it("preserves an already-edited successor over the predecessor's workflow state", () => {
    const sameRegion = [report("capital_mohawk", "gpt"), report(" CAPITAL_MOHAWK ", "claude")];
    const prior = {
      ...legacyTicket(sameRegion),
      status: "in_progress" as const,
      notes: "Old note.",
    };
    const current = {
      ...triage(sameRegion).tickets[0]!,
      status: "wont_fix" as const,
      notes: "New decision.",
    };
    const result = retriage(sameRegion, [prior, current]);
    expect(result.tickets.find((ticket) => ticket.ticket_id === current.ticket_id)).toEqual(
      current,
    );
  });

  it.each(["wont_fix", "in_progress"] as const)(
    "restores %s and notes when only the saved predecessor survived an interrupted bucket write",
    (status) => {
      const sameRegion = [report("capital_mohawk", "gpt"), report(" CAPITAL_MOHAWK ", "claude")];
      const prior = { ...legacyTicket(sameRegion), status, notes: "Original workflow decision." };
      const migrated = retriage(sameRegion, [prior]);
      const histories = migrated.tickets.filter((ticket) => ticket.superseded_by);
      expect(histories).toHaveLength(1);
      const restored = retriage(sameRegion, histories);
      expect(restored.tickets).toEqual(migrated.tickets);
      for (const ticket of restored.tickets) expect(QaTicketSchema.parse(ticket)).toEqual(ticket);
    },
  );

  it("does not guess replacements from partial or unrecognized evidence", () => {
    const prior = legacyTicket(sessions);
    const partial = retriage(sessions.slice(0, 1), [prior]);
    expect(partial.tickets.find((ticket) => ticket.ticket_id === prior.ticket_id)).toEqual(prior);
    const unknown = { ...prior, ticket_id: "f".repeat(16) };
    expect(retriage(sessions, [unknown]).tickets).toContainEqual(unknown);
    const changedEvidence = { ...prior, evidence: { ...prior.evidence, report_count: 3 } };
    expect(retriage(sessions, [changedEvidence]).tickets).toContainEqual(changedEvidence);
  });

  it("does not transfer a reproduction of the old cross-region identity to either new region", () => {
    const prior = { ...legacyTicket(sessions), promotion: "verified" as const };
    const result = triagePlaytestCorpus({
      sessions,
      existingTickets: [prior],
      locationIndex,
      buildHistory: [BUILD],
      verifiedTicketIds: [prior.ticket_id],
    });
    expect(result.actionable).toEqual([]);
    expect(
      result.tickets
        .filter((ticket) => ticket.ticket_id !== prior.ticket_id)
        .every((ticket) => ticket.promotion === "accumulating"),
    ).toBe(true);
  });

  it("keeps supersession history even when its original status was stale and had no notes", () => {
    const prior = { ...legacyTicket(sessions), status: "stale" as const };
    const result = retriage(sessions, [prior]);
    const unrelated = [report("capital_mohawk", "gpt", "Inventory lost my brass compass")];
    expect(retriage(unrelated, result.tickets).tickets).toContainEqual(
      result.tickets.find((ticket) => ticket.ticket_id === prior.ticket_id),
    );
  });

  it("reads v1 history but rejects malformed or v1 supersession metadata", () => {
    const prior = legacyTicket(sessions);
    expect(QaTicketSchema.parse(prior)).toEqual(prior);
    const successor = triage(sessions).tickets[0]!.ticket_id;
    for (const malformed of [
      { ...prior, superseded_by: [successor] },
      { ...prior, schema_version: 2, superseded_by: [] },
      { ...prior, schema_version: 2, superseded_by: [prior.ticket_id] },
      { ...prior, schema_version: 2, superseded_by: [successor, successor] },
    ])
      expect(QaTicketSchema.safeParse(malformed).success).toBe(false);
  });

  it("does not choose one of several predecessors as the successor's owner", () => {
    const sameRegion = [report("capital_mohawk", "gpt"), report(" CAPITAL_MOHAWK ", "claude")];
    const priors = sameRegion.map((session, index) => ({
      ...legacyTicket([session]),
      notes: `Owner ${index}`,
      status: "in_progress" as const,
    }));
    const result = retriage(sameRegion, priors);
    const successor = result.tickets.find((ticket) => !ticket.superseded_by)!;
    expect(successor.status).toBe("open");
    expect(successor.notes).toBeUndefined();
    expect(result.tickets.filter((ticket) => ticket.superseded_by)).toHaveLength(2);
  });
});

describe("region supersession reaches the intake queue", () => {
  const sessions = [report("capital_mohawk", "gpt"), report("central_new_york", "claude")];
  const sameRegion = [report("capital_mohawk", "gpt"), report(" CAPITAL_MOHAWK ", "claude")];
  function queuedTicket(
    ticket: QaTicket,
    status: Submission["status"] = "in_progress",
  ): Submission {
    return {
      ...submissionFromTicket(ticket),
      status,
      body: "An investigator's amended reproduction steps.",
      claimed_by: "lane/investigator",
      claimed_at: "2026-09-04T12:00:00.000Z",
      created_at: "2026-09-03T12:00:00.000Z",
      updated_at: "2026-09-04T12:00:00.000Z",
    };
  }

  it("retires a promoted split without losing body, evidence or ownership", () => {
    const dir = temp();
    const prior = legacyTicket(sessions);
    const submission = upsertSubmission(queuedTicket(prior), dir);
    const result = retriage(sessions, [prior]);
    expect(reconcileTicketSubmissions(result.tickets, dir)).toEqual({ promoted: 0, superseded: 1 });
    const stored = readQueue(dir).submissions;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      ...submission,
      status: "declined",
      resolved_by: "qa:triage:region-supersession",
      updated_at: expect.any(String),
      evidence: { ...submission.evidence, refs: expect.arrayContaining(submission.evidence.refs) },
    });
    expect(stored[0]!.evidence.refs.filter((ref) => ref.startsWith("qa-ticket:"))).toHaveLength(2);
    expect(stored.filter(isOpenWork)).toEqual([]);
    const snapshot = diskSnapshot(dir);
    expect(reconcileTicketSubmissions(result.tickets, dir)).toEqual({ promoted: 0, superseded: 0 });
    expect(diskSnapshot(dir)).toEqual(snapshot);
  });

  it.each(["in_progress", "done", "declined", "stale"] as const)(
    "preserves %s on a newly created one-to-one successor",
    (status) => {
      const dir = temp();
      const prior = legacyTicket(sameRegion);
      const submission = upsertSubmission(queuedTicket(prior, status), dir);
      const result = retriage(sameRegion, [prior]);
      reconcileTicketSubmissions(result.tickets, dir);
      const stored = readQueue(dir).submissions;
      const next = stored.find((item) => item.id !== submission.id)!;
      expect(next).toMatchObject({
        status,
        claimed_by: submission.claimed_by,
        claimed_at: submission.claimed_at,
      });
      if (status !== "in_progress") expect(stored).toContainEqual(submission);
      const snapshot = diskSnapshot(dir);
      reconcileTicketSubmissions(result.tickets, dir);
      expect(diskSnapshot(dir)).toEqual(snapshot);
    },
  );

  it("keeps an existing successor's claim and preserves unrelated or partial-corpus queue items", () => {
    const dir = temp();
    const prior = legacyTicket(sameRegion);
    const old = upsertSubmission(queuedTicket(prior), dir);
    const current = upsertSubmission(
      {
        ...queuedTicket(triage(sameRegion).tickets[0]!),
        claimed_by: "lane/new-owner",
        status: "done",
      },
      dir,
    );
    const unrelated = upsertSubmission({ ...old, id: "f".repeat(16), source: "audit" }, dir);
    reconcileTicketSubmissions(retriage(sameRegion, [prior]).tickets, dir);
    expect(readQueue(dir).submissions.find((item) => item.id === current.id)).toMatchObject({
      status: "done",
      claimed_by: "lane/new-owner",
      claimed_at: current.claimed_at,
    });
    expect(readQueue(dir).submissions).toContainEqual(unrelated);

    const partialDir = temp();
    const partialPrior = legacyTicket(sessions);
    upsertSubmission(queuedTicket(partialPrior), partialDir);
    const snapshot = diskSnapshot(partialDir);
    reconcileTicketSubmissions(retriage(sessions.slice(0, 1), [partialPrior]).tickets, partialDir);
    expect(diskSnapshot(partialDir)).toEqual(snapshot);
  });

  it("revives an inherited stale successor when a fresh report actually arrives", () => {
    const dir = temp();
    const prior = legacyTicket(sameRegion);
    const old = upsertSubmission(queuedTicket(prior, "stale"), dir);
    const migrated = retriage(sameRegion, [prior]);
    reconcileTicketSubmissions(migrated.tickets, dir);
    expect(readQueue(dir).submissions.find((item) => item.id !== old.id)!.status).toBe("stale");
    const fresh = retriage([...sameRegion, report("capital_mohawk ", "gpt")], migrated.tickets);
    reconcileTicketSubmissions(fresh.tickets, dir);
    expect(readQueue(dir).submissions.find((item) => item.id !== old.id)).toMatchObject({
      status: "open",
      evidence: { observations: 3 },
    });
  });

  it("compares full evidence when the changed report falls beyond the intake reference limit", () => {
    const dir = temp();
    const reports = Array.from({ length: 21 }, (_, i) =>
      report(`capital_mohawk${" ".repeat(i)}`, i % 2 === 0 ? "gpt" : "claude"),
    ).sort((a, b) => a.record_id.localeCompare(b.record_id));
    const prior = legacyTicket(reports);
    const old = upsertSubmission(queuedTicket(prior, "stale"), dir);
    const migrated = retriage(reports, [prior]);
    reconcileTicketSubmissions(migrated.tickets, dir);
    const replacement = Array.from({ length: 100 }, (_, i) =>
      report(
        `capital_mohawk${" ".repeat(i + 100)}`,
        "claude",
        undefined,
        "2026-09-06T08:00:00.000Z",
      ),
    ).find((session) => session.record_id > reports[19]!.record_id);
    expect(replacement).toBeDefined();
    const fresh = retriage([...reports.slice(0, 20), replacement!], migrated.tickets);
    const beforeTicket = migrated.tickets.find((ticket) => !ticket.superseded_by)!;
    const afterTicket = fresh.tickets.find((ticket) => !ticket.superseded_by)!;
    // The flattened intake payload cannot distinguish these two valid corpora.
    expect(submissionFromTicket(afterTicket).evidence).toEqual(
      submissionFromTicket(beforeTicket).evidence,
    );
    expect(afterTicket.evidence).not.toEqual(beforeTicket.evidence);
    reconcileTicketSubmissions(fresh.tickets, dir);
    expect(readQueue(dir).submissions.find((item) => item.id !== old.id)!.status).toBe("open");
  });

  it("does not inherit stale when migration already has a newer corpus", () => {
    const dir = temp();
    const prior = legacyTicket(sameRegion);
    const old = upsertSubmission(queuedTicket(prior, "stale"), dir);
    const result = retriage([...sameRegion, report("capital_mohawk ", "gpt")], [prior]);
    expect(
      result.tickets.find((ticket) => ticket.ticket_id === prior.ticket_id)!.superseded_by,
    ).toHaveLength(1);
    reconcileTicketSubmissions(result.tickets, dir);
    expect(readQueue(dir).submissions.find((item) => item.id !== old.id)!.status).toBe("open");
  });

  it("waits for a complete saved replacement set and ignores unrelated tickets on an empty-store retry", () => {
    const dir = temp();
    const prior = legacyTicket(sessions);
    const old = upsertSubmission(queuedTicket(prior), dir);
    const migrated = retriage(sessions, [prior]);
    const successors = migrated.tickets.filter((ticket) => !ticket.superseded_by);
    const partial = migrated.tickets.filter(
      (ticket) => ticket.ticket_id !== successors[0]!.ticket_id,
    );
    reconcileTicketSubmissions(partial, dir, { supersededOnly: true });
    expect(readQueue(dir).submissions).toEqual([old]);
    const unrelated = { ...prior, ticket_id: "e".repeat(16) };
    expect(
      reconcileTicketSubmissions([...migrated.tickets, unrelated], dir, { supersededOnly: true }),
    ).toEqual({ promoted: 0, superseded: 1 });
    expect(readQueue(dir).submissions).toHaveLength(1);
    expect(readQueue(dir).submissions.filter(isOpenWork)).toEqual([]);
    const snapshot = diskSnapshot(dir);
    reconcileTicketSubmissions(migrated.tickets, dir, { supersededOnly: true });
    expect(diskSnapshot(dir)).toEqual(snapshot);
  });

  it("reconciles through the CLI, leaves dry runs untouched, and keeps saved history readable", () => {
    const store = temp();
    const tickets = temp();
    const queue = temp();
    const prior = legacyTicket(sessions);
    for (const session of sessions) writePlaytestSession(store, session, TRANSCRIPT);
    writeTickets([prior], tickets);
    upsertSubmission(queuedTicket(prior), queue);
    const run = (dry = false, targetStore = store, targetQueue = queue) =>
      spawnSync(
        process.execPath,
        [
          join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
          "bin/triage.ts",
          "--store",
          targetStore,
          "--tickets",
          tickets,
          "--queue",
          targetQueue,
          ...(dry ? ["--dry-run"] : []),
        ],
        { cwd: process.cwd(), encoding: "utf8", timeout: 180_000 },
      );
    const before = { tickets: diskSnapshot(tickets), queue: diskSnapshot(queue) };
    const dry = run(true);
    expect(dry.status, dry.stderr).toBe(0);
    expect({ tickets: diskSnapshot(tickets), queue: diskSnapshot(queue) }).toEqual(before);
    const written = run();
    expect(written.status, written.stderr).toBe(0);
    expect(written.stdout).toContain("Superseded 1 pending submission(s)");
    expect(readTickets(tickets).unreadable).toEqual([]);
    expect(readTickets(tickets).tickets).toHaveLength(3);
    expect(readQueue(queue).submissions.filter(isOpenWork)).toEqual([]);
    const after = { tickets: diskSnapshot(tickets), queue: diskSnapshot(queue) };
    expect(run().status).toBe(0);
    expect({ tickets: diskSnapshot(tickets), queue: diskSnapshot(queue) }).toEqual(after);
    const emptyStore = temp();
    const interruptedQueue = temp();
    upsertSubmission(queuedTicket(prior), interruptedQueue);
    const interrupted = diskSnapshot(interruptedQueue);
    expect(run(true, emptyStore, interruptedQueue).status).toBe(0);
    expect(diskSnapshot(interruptedQueue)).toEqual(interrupted);
    const recovered = run(false, emptyStore, interruptedQueue);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(recovered.stdout).toContain("Reconciled saved replacements: promoted 0, superseded 1");
    expect(readQueue(interruptedQueue).submissions.filter(isOpenWork)).toEqual([]);
    expect(diskSnapshot(tickets)).toEqual(after.tickets);
  }, 180_000);
});
