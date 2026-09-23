/**
 * The playtest session store — an append-only, content-addressed corpus on disk.
 *
 * Design constraint that shapes everything here: MANY WRITERS, NO COORDINATOR. The
 * point of splitting the loops is that playtest cohorts run in mass parallel, on
 * different machines, under different vendors, with nothing arbitrating between them.
 * A store that needed a lock, a queue, or a single writer would put the coupling
 * straight back.
 *
 * Content addressing gives that for free. A session's directory name ends in its
 * record id, which is the hash of its own content, so two writers either produce
 * byte-identical output (same directory, idempotent) or different output (different
 * directory, no conflict). There is no merge, so there is nothing to merge wrongly.
 *
 * Writes are atomic by staging into a sibling temp directory and renaming into place.
 * `rename(2)` within one filesystem is atomic, so a reader scanning the store mid-write
 * sees either nothing or a complete session — never a record whose transcript has not
 * landed yet. This matters more than usual here because the triage pass runs
 * continuously against a store that is being written to the whole time.
 *
 * Nothing in this module ever deletes or rewrites a session. `nothing thrown away` is
 * not a policy applied on top of the store; it is the only behaviour the store has.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  parsePlaytestSession,
  playtestSessionDirName,
  type PlaytestSessionRecord,
} from "./session_record.js";

/** Default staging root. Gitignored: the corpus is published, not committed inline. */
export const DEFAULT_SESSION_STORE = "ai-runs/playtest/sessions";

const RECORD_FILE = "session.json";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Write one session atomically.
 *
 * Returns the directory it landed in. Re-writing an identical session is a no-op that
 * returns the existing directory rather than an error: a retried publish, a resumed
 * cohort, or two workers that somehow produced the same run must not fail the caller.
 */
export function writePlaytestSession(
  storeRoot: string,
  record: PlaytestSessionRecord,
  transcript: string,
): string {
  const expectedHash = sha256Hex(transcript);
  if (expectedHash !== record.log.transcript_sha256) {
    throw new Error(
      `transcript hash mismatch for session ${record.record_id}: record claims ${record.log.transcript_sha256}, content hashes to ${expectedHash}`,
    );
  }
  const transcriptBytes = Buffer.byteLength(transcript, "utf8");
  if (transcriptBytes !== record.log.transcript_bytes) {
    throw new Error(
      `transcript size mismatch for session ${record.record_id}: record claims ${record.log.transcript_bytes} bytes, content is ${transcriptBytes}`,
    );
  }

  const root = resolve(storeRoot);
  mkdirSync(root, { recursive: true });
  const finalDir = join(root, playtestSessionDirName(record));
  if (existsSync(finalDir)) return finalDir;

  // Stage inside the store root so the rename stays on one filesystem — a rename
  // across devices is a copy, which is not atomic and would reintroduce the
  // half-written-session race this is here to avoid.
  const staging = mkdtempSync(join(root, ".staging-"));
  try {
    writeFileSync(join(staging, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    writeFileSync(join(staging, record.log.transcript_filename), transcript, "utf8");
    try {
      renameSync(staging, finalDir);
    } catch (error) {
      // Another worker won the race and produced the same content. Identical content
      // means an identical directory name, so their copy is as good as ours.
      if (existsSync(finalDir)) return finalDir;
      throw error;
    }
    return finalDir;
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

/** Read and fully verify one session directory. */
export function readPlaytestSession(sessionDir: string): {
  record: PlaytestSessionRecord;
  transcript: string;
} {
  const recordPath = join(sessionDir, RECORD_FILE);
  const record = parsePlaytestSession(JSON.parse(readFileSync(recordPath, "utf8")));
  const transcript = readFileSync(join(sessionDir, record.log.transcript_filename), "utf8");
  const actual = sha256Hex(transcript);
  if (actual !== record.log.transcript_sha256) {
    throw new Error(
      `session ${record.record_id} transcript does not match its recorded hash (${actual} vs ${record.log.transcript_sha256})`,
    );
  }
  return { record, transcript };
}

type PlaytestStoreEntry = {
  dir: string;
  record: PlaytestSessionRecord;
};

/**
 * List every session in the store, oldest first.
 *
 * A directory that fails to parse is REPORTED, never skipped silently and never
 * removed: in an append-only corpus an unreadable entry is a fact about the corpus,
 * and swallowing it would hide exactly the kind of corruption the content addressing
 * exists to surface.
 */
export function listPlaytestSessions(storeRoot: string): {
  entries: PlaytestStoreEntry[];
  unreadable: { dir: string; reason: string }[];
} {
  const root = resolve(storeRoot);
  const entries: PlaytestStoreEntry[] = [];
  const unreadable: { dir: string; reason: string }[] = [];
  if (!existsSync(root)) return { entries, unreadable };

  for (const name of readdirSync(root).sort()) {
    if (name.startsWith(".")) continue;
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    if (!existsSync(join(dir, RECORD_FILE))) continue;
    try {
      entries.push({ dir, record: readPlaytestSession(dir).record });
    } catch (error) {
      unreadable.push({ dir, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  entries.sort((a, b) => {
    const byTime = a.record.recorded_at.localeCompare(b.record.recorded_at);
    return byTime !== 0 ? byTime : a.record.record_id.localeCompare(b.record.record_id);
  });
  return { entries, unreadable };
}

type PlaytestStoreSummary = {
  total: number;
  byOutcome: Record<string, number>;
  byProvider: Record<string, number>;
  byTier: Record<string, number>;
  byIsolation: Record<string, number>;
  families: string[];
  metricsEligible: number;
  builds: string[];
};

/** A countable overview of the corpus — what the QA lead reads before triaging. */
export function summarizePlaytestStore(
  entries: readonly PlaytestStoreEntry[],
): PlaytestStoreSummary {
  const bump = (table: Record<string, number>, key: string): void => {
    table[key] = (table[key] ?? 0) + 1;
  };
  const byOutcome: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  const byIsolation: Record<string, number> = {};
  const families = new Set<string>();
  const builds = new Set<string>();
  let metricsEligible = 0;

  for (const { record } of entries) {
    bump(byOutcome, record.outcome);
    bump(byProvider, record.provider.id);
    bump(byTier, record.model.tier);
    bump(byIsolation, record.provider.isolation);
    families.add(record.provider.family);
    builds.add(record.build.git_commit);
    if (
      record.outcome === "completed" &&
      record.provider.isolation === "runner_enforced" &&
      record.build.tracked_worktree_clean
    ) {
      metricsEligible += 1;
    }
  }

  return {
    total: entries.length,
    byOutcome,
    byProvider,
    byTier,
    byIsolation,
    families: [...families].sort(),
    metricsEligible,
    builds: [...builds].sort(),
  };
}
