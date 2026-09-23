#!/usr/bin/env -S npx tsx
/**
 * Triage the playtest corpus into the QA bucket.
 *
 * This is the QA lead's pass: read every session record, cluster what players reported,
 * and write the promoted subset into `qa/tickets/` where the dev loop will find it.
 * Run it as often as you like — it is pure over the corpus, so re-running never
 * produces a different bucket for the same input, and an interrupted run leaves nothing
 * half-applied.
 *
 * Usage:
 *   npm run qa:triage                    triage and write the bucket
 *   npm run qa:triage -- --dry-run       report what would change, write nothing
 *   npm run qa:triage -- --store <dir>   triage a corpus somewhere else
 */
import { fileURLToPath } from "node:url";
import { buildLocationIndex } from "../src/feedback/normalize.js";
import { DEFAULT_QUEUE_DIR } from "../src/intake/submission.js";
import { buildHistoryWarning, readBuildHistory } from "../src/qa/build_history.js";
import { DEFAULT_TICKET_DIR } from "../src/qa/ticket.js";
import { reconcileTicketSubmissions } from "../src/qa/ticket_submission.js";
import { readTickets, summarizeBucket, writeTickets } from "../src/qa/ticket_store.js";
import { DEFAULT_SESSION_STORE, listPlaytestSessions } from "../src/qa/session_store.js";
import { triagePlaytestCorpus } from "../src/qa/triage.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

/** Every value given for a repeatable flag, so `--verified a --verified b` takes both. */
function allArgs(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === flag && process.argv[i + 1] !== undefined)
      out.push(process.argv[i + 1]!);
  }
  return out;
}

function main(): void {
  const store = argValue("--store", DEFAULT_SESSION_STORE);
  const ticketDir = argValue("--tickets", DEFAULT_TICKET_DIR);
  const queueDir = argValue("--queue", DEFAULT_QUEUE_DIR);
  const dryRun = process.argv.includes("--dry-run");
  // The `verified` rung existed and had no way to be set: triagePlaytestCorpus has always
  // accepted verifiedTicketIds, and nothing ever passed any. That left promotion to
  // reference-tier or two independent families, so a single-lineage fleet could corroborate
  // a defect twenty times over and never move it out of `accumulating`. Reproduction is the
  // other honest route to confidence, and this is how a cycle records having done it.
  const verifiedTicketIds = allArgs("--verified");
  const verifiedBy = argValue("--verified-by", "");
  if (verifiedTicketIds.length > 0 && verifiedBy === "") {
    throw new Error("--verified requires --verified-by <what reproduced it>");
  }

  const { entries, unreadable } = listPlaytestSessions(store);
  for (const bad of unreadable) console.error(`! unreadable session ${bad.dir}: ${bad.reason}`);

  // Unreadable tickets are reported here for the same reason unreadable sessions are,
  // one screen up: they are workflow state — somebody's `wont_fix`, somebody's notes —
  // that this run is about to write around without seeing. `writeTickets` leaves those
  // files in place, so the operator can repair one instead of discovering from git
  // history that triage removed it.
  const { tickets: existing, unreadable: unreadableTickets } = readTickets(ticketDir);
  for (const bad of unreadableTickets) {
    console.error(`! unreadable ticket ${bad.file}: ${bad.reason} (left in place)`);
  }

  // A `--verified` stamp needs no corpus: it names a ticket already in the bucket. This
  // early return used to swallow it — the flag was accepted, nothing was stamped, and the
  // run exited 0 (bug_0652) — so with ids to stamp, an empty store falls through to triage,
  // which carries every ticket forward and stamps the ones named.
  if (entries.length === 0 && verifiedTicketIds.length === 0) {
    console.log(`No playtest sessions in ${store}; the bucket is unchanged.`);
    // The previous run may have written proven replacements before intake failed.
    // Those persisted decisions can be retried without inventing new corpus evidence.
    if (!dryRun) {
      const { promoted, superseded } = reconcileTicketSubmissions(existing, queueDir, {
        supersededOnly: true,
      });
      if (promoted > 0 || superseded > 0) {
        console.log(
          `Reconciled saved replacements: promoted ${promoted}, superseded ${superseded} in ${queueDir}.`,
        );
      }
    }
    return;
  }

  const history = readBuildHistory(REPO_ROOT);
  const historyWarning = buildHistoryWarning(history);
  if (historyWarning !== null) console.error(historyWarning);

  const result = triagePlaytestCorpus({
    sessions: entries.map((entry) => entry.record),
    locationIndex: buildLocationIndex(REPO_ROOT),
    buildHistory: history.commits,
    buildHistoryTruncated: history.truncated,
    existingTickets: existing,
    verifiedTicketIds,
    ...(verifiedBy !== "" ? { verifiedBy } : {}),
  });

  // Refuse before writing anything. The operator asked for a promotion by id, so an id
  // that promoted nothing is a failed request, not a detail — and writing the ids that DID
  // match would leave a half-applied stamp to be discovered later in the bucket.
  if (result.unmatchedVerifiedIds.length > 0) {
    for (const id of result.unmatchedVerifiedIds) {
      console.error(
        `! --verified ${id} matched no current ticket in ${ticketDir} or the corpus in ${store}` +
          ` (mistyped, retired, or superseded — \`npm run qa:bucket -- --all\` lists ids).`,
      );
    }
    console.error("Nothing was written: fix the ids above and re-run.");
    process.exitCode = 1;
    return;
  }

  const { stats } = result;
  console.log(
    `Triaged ${stats.sessions} session(s) (${stats.sessionsWithInterview} with an interview): ` +
      `${stats.issues} issue(s) → ${stats.clusters} cluster(s).`,
  );
  console.log(
    `  verified ${stats.verified}, corroborated ${stats.corroborated}, ` +
      `accumulating ${stats.accumulating}, stale ${stats.stale}, superseded ${stats.superseded}`,
  );
  // Retirement removes tracked files, so it is reported rather than left to be noticed
  // in a diff.
  if (stats.retired > 0) {
    console.log(`  retired ${stats.retired} aged-out ticket(s) with no notes or decision`);
  }

  const summary = summarizeBucket(result.tickets);
  console.log(`  bucket: ${summary.actionable} actionable of ${summary.total}`);
  if (summary.next) {
    console.log(
      `  next: ${summary.next.severity} ${summary.next.ticket_id} — ${summary.next.title}`,
    );
  }

  if (dryRun) {
    console.log("[dry-run] bucket not written.");
    return;
  }
  writeTickets(result.tickets, ticketDir);
  console.log(`Wrote ${result.tickets.length} ticket(s) to ${ticketDir}.`);

  // Only actionable tickets cross into the dev loop's queue. The rest stay visible in
  // the bucket — they are real evidence, just not yet work.
  const { promoted, superseded } = reconcileTicketSubmissions(result.tickets, queueDir);
  console.log(
    promoted === 0
      ? `Nothing promoted to ${queueDir}: no ticket is corroborated or verified yet.`
      : `Promoted ${promoted} submission(s) to ${queueDir}.`,
  );
  if (superseded > 0) console.log(`Superseded ${superseded} pending submission(s) in ${queueDir}.`);
}

main();
