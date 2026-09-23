#!/usr/bin/env -S npx tsx
/**
 * Report ground truth about what this machine can actually run, and why the corpus is
 * or is not producing work.
 *
 * This exists because of a specific failure. The documentation asserted "nothing in this
 * repo privileges a vendor" and offered a worked cohort in which most players could not
 * launch at all; separately, a whole two-loop exercise produced 55 findings and promoted
 * none of them, for reasons no command would tell you. Both were discoverable only by
 * running the thing and reading source afterwards. An operator planning a cohort should
 * not have to do that.
 *
 * So this answers three questions, in the order they bite:
 *
 *   1. Which vendors can I actually launch here, and which must be hand-played?
 *   2. What is in the corpus, and is it the SHAPE that can promote?
 *   3. If nothing is queued, why not — and what specifically would change it?
 *
 * Question 3 is the one that matters. "Nothing promoted" is the correct outcome for a
 * single-vendor corpus and also the symptom of a broken pipeline, and those look
 * identical from outside. This names which one you are looking at.
 *
 * Read-only: it never writes to the corpus, the bucket, or the queue.
 *
 * Usage:
 *   npm run doctor                       # uses the default corpus and queue
 *   npm run doctor -- --store /d/af-corpus
 */
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  derivePlaytestIsolation,
  PLAYTEST_PROVIDERS,
  runnerCanDriveProvider,
} from "../src/blind/providers.js";
import { listPlaytestSessions, summarizePlaytestStore } from "../src/qa/session_store.js";
import { DEFAULT_SESSION_STORE } from "../src/qa/session_store.js";
import { readQueue, summarizeQueue } from "../src/intake/queue.js";
import { DEFAULT_QUEUE_DIR } from "../src/intake/submission.js";
import { readTickets } from "../src/qa/ticket_store.js";
import { DEFAULT_TICKET_DIR, isActionable } from "../src/qa/ticket.js";

process.stdout.on("error", () => process.exit(0));

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

/**
 * Is this executable resolvable from PATH?
 *
 * Resolved by walking PATH directly rather than shelling out. The previous
 * implementation ran `command -v <bin>` with `shell: true`, which on Windows spawns
 * cmd.exe — where `command` is not a builtin, so the call threw for EVERY binary and
 * this function returned false unconditionally. That made the whole point of this
 * command inverted on Windows: the one tool whose job is to tell an operator what they
 * can launch reported that they could launch nothing, including when Codex was
 * installed and logged in. It even reported `node` as absent, while running under node.
 *
 * PATHEXT matters: on Windows the npm shims are `codex.cmd` / `codex.ps1`, and a bare
 * `codex` (the POSIX shim) is present too but is not executable by cmd. Accepting any
 * PATHEXT match is what "can a launcher find it" actually means there.
 */
export function onPath(binary: string): boolean {
  const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const windows = process.platform === "win32";
  const suffixes = windows
    ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const dir of entries) {
    // A malformed PATH entry (quotes, a stray delimiter) must not abort the scan.
    for (const suffix of suffixes) {
      try {
        if (existsSync(join(dir.replace(/^"|"$/g, ""), binary + suffix))) return true;
      } catch {
        /* unreadable PATH entry — keep looking */
      }
    }
  }
  return false;
}

/*
 * There is deliberately NO `LIVE_LAUNCHABLE_PROVIDER` constant here any more.
 *
 * There used to be one — `const LIVE_LAUNCHABLE_PROVIDER = "codex"` — and it was the
 * second of three hand-written copies of the same policy (the others being
 * blind-tester/run.sh and playtest-loop.sh's cohort preflight). Three copies of a rule
 * is three chances to disagree, and this copy was the one an operator READS: it decided
 * both the ✓/· marks below and the paragraph explaining them, so the day a second
 * vendor's capture reader lands, this file would have gone on telling the operator that
 * vendor must be hand-played. A diagnostic that is confidently wrong is worse than no
 * diagnostic, because it is believed.
 *
 * `derivePlaytestIsolation` in src/blind/providers.ts is now the single authority, and
 * it answers from facts rather than a name: the provider's `kind`, whether it declares a
 * complete `capture` block, and whether that block's reader module exists in THIS
 * checkout. So this command reports what the machine can actually do today, and it
 * changes the moment the checkout does — no edit here required.
 */

/**
 * The dev-loop agents, read from the same file `loop.sh` resolves them from.
 *
 * This was a second copy of loop.sh's `DEV_AGENT_IDS`, in an order the output below
 * depends on ("loop.sh takes the first match in this order"). Two hand-kept lists that
 * must agree, with nothing checking that they do, is a promise this command cannot
 * honour: an agent added to loop.sh alone would be auto-detected but never reported, and
 * one added here alone would be advertised and never launched.
 *
 * A registry that cannot be read yields an empty list, and the "none on PATH" branch
 * below then prints the actionable message. That is the same fail-closed answer loop.sh
 * gives, rather than a built-in list that disagrees with what the loop would really do.
 *
 * BOTH fields are kept, because they answer different questions and are not always the
 * same string. `loop.sh` probes `binary` to decide whether an agent can run; an earlier
 * version of this reader kept only `id` and probed THAT, so an entry whose executable is
 * named differently from its id would have been reported unavailable here while the loop
 * happily auto-detected it — reintroducing, in the reporting layer, exactly the
 * disagreement the shared registry exists to remove. `id` is what an operator types into
 * AI_AGENT, so it stays what gets displayed.
 */
interface DevAgentEntry {
  id: string;
  binary: string;
}

function readDevAgents(): DevAgentEntry[] {
  try {
    const raw = readFileSync(new URL("../dev-agents.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const agents =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { agents?: unknown }).agents
        : undefined;
    if (!Array.isArray(agents)) return [];
    const entries: DevAgentEntry[] = [];
    for (const agent of agents) {
      if (typeof agent !== "object" || agent === null) continue;
      const { id, binary } = agent as { id?: unknown; binary?: unknown };
      if (typeof id !== "string" || id.length === 0) continue;
      // A malformed entry falls back to the id rather than being dropped: an agent the
      // loop might still run must not vanish from the report that is supposed to explain
      // what the loop will do.
      entries.push({ id, binary: typeof binary === "string" && binary.length > 0 ? binary : id });
    }
    return entries;
  } catch {
    return [];
  }
}

const DEV_AGENTS = readDevAgents();

function section(title: string): void {
  console.log(`\n${title}\n${"─".repeat(title.length)}`);
}

function main(): void {
  const store = arg("--store") ?? process.env.PLAYTEST_STORE ?? DEFAULT_SESSION_STORE;
  const queueDir = arg("--queue") ?? DEFAULT_QUEUE_DIR;
  const ticketDir = arg("--tickets") ?? DEFAULT_TICKET_DIR;

  section("Dev loop");
  // Report ALL of them, not just the auto-detected one. loop.sh takes the first match in
  // DEV_AGENTS order, so an operator who wants a different installed agent has to know
  // that AI_AGENT selects it — and that is invisible if only the winner is printed.
  // Probe the executable, report the id — see readDevAgents.
  const devAgents = DEV_AGENTS.filter((agent) => onPath(agent.binary)).map((agent) => agent.id);
  if (devAgents.length === 0) {
    console.log(
      `  ✗ none of ${DEV_AGENTS.map((agent) => agent.id).join(", ")} is on PATH.\n` +
        `    Install one, or point AI_AGENT_CMD at any agent that reads STDIN.`,
    );
  } else {
    console.log(`  ✓ ${devAgents[0]} is on PATH — \`./loop.sh\` auto-detects it.`);
    const alternatives = devAgents.slice(1);
    if (alternatives.length > 0) {
      console.log(
        `    also installed: ${alternatives.join(", ")} — select one with ` +
          `AI_AGENT=${alternatives[0]} ./loop.sh`,
      );
    }
  }

  section("Playtest loop — what can launch here");
  // Two independent facts, and BOTH must hold before this table may promise a live lane.
  // `derivePlaytestIsolation` answers "can this vendor's blindness be proven here" (a
  // capture reader exists). implemented-launch-paths.json answers "does run.sh know how
  // to spawn it at all". They genuinely came apart: the moment the claude_code reader
  // landed, the derived gate opened and this table said "live via playtest-loop.sh" while
  // run.sh refused the very same run. Reading run.sh's own list is what stops that.
  const liveIds: string[] = [];
  for (const provider of PLAYTEST_PROVIDERS) {
    const derived = derivePlaytestIsolation(provider);
    const binary = provider.launch?.executable ?? null;
    const installed = binary !== null && onPath(binary);
    const proven = derived.isolation === "runner_enforced";
    const canRunLive = runnerCanDriveProvider(provider).drivable;
    if (canRunLive) liveIds.push(provider.id);
    const mark = canRunLive && installed ? "✓" : "·";
    const how = canRunLive
      ? installed
        ? "live via playtest-loop.sh, runner_enforced"
        : `live-capable, but '${binary ?? "?"}' is not on PATH`
      : proven
        ? // Provable but not yet drivable: the honest middle state, and the one worth
          // naming loudly because it is one launch branch away from working.
          `blindness is provable, but run.sh has no launch path for ${derived.readerModule} yet — ` +
          `hand-play and npm run playtest:ingest until it does`
        : "not live in playtest-loop.sh; use a documented dedicated lane when available, otherwise npm run playtest:ingest (operator_attested)";
    console.log(`  ${mark} ${provider.id.padEnd(14)} ${provider.family.padEnd(8)} ${how}`);
    // The derivation's own sentence, printed VERBATIM and per provider — never a shared
    // house summary. Two vendors can miss `runner_enforced` for completely different
    // reasons (claude_code has a reader but no launch branch, grok_cli has a dedicated
    // operator-attested lane but no capture reader, and grok_desktop is never spawned).
    // Those facts imply different work. The old single sentence flattened all of them
    // into "not codex", which told an operator nothing they could act on. It is printed
    // for the qualifying vendor too, because "why is THIS one trusted" is the same
    // question and the answer names the module doing the trusting.
    console.log(`      ${derived.reason}`);
  }
  console.log(
    `\n  runner_enforced means the runner PROVED the agent saw nothing but the game's MCP\n` +
      `  tools, by reading that client's own session log with the reader module named above.\n` +
      `  In this checkout that holds for: ${liveIds.join(", ") || "no provider at all"}.\n` +
      `  That is a fact about which capture readers exist here today, not a ranking of\n` +
      `  vendors — it flips for a vendor the moment its reader lands. Ingested sessions\n` +
      `  still count toward bug corroboration; they are excluded from experience metrics\n` +
      `  only.\n` +
      `  PLAYTEST_MOCK=1 dry-runs the wiring for any provider, free, recording nothing.`,
  );

  section(`Corpus (${store})`);
  if (!existsSync(store)) {
    console.log(`  empty — no sessions yet. Nothing to triage, which is not an error.`);
    reportBlockers(0, [], queueDir, ticketDir);
    return;
  }
  const { entries, unreadable } = listPlaytestSessions(store);
  for (const bad of unreadable) console.log(`  ! unreadable: ${bad.dir} — ${bad.reason}`);
  const summary = summarizePlaytestStore(entries);
  console.log(`  ${summary.total} session(s); metrics-eligible ${summary.metricsEligible}`);
  console.log(`  families:   ${summary.families.join(", ") || "none"}`);
  console.log(`  tiers:      ${describe(summary.byTier)}`);
  console.log(`  isolation:  ${describe(summary.byIsolation)}`);
  console.log(`  outcomes:   ${describe(summary.byOutcome)}`);

  reportBlockers(summary.total, summary.families, queueDir, ticketDir, summary.byTier);
}

function describe(table: Record<string, number>): string {
  const parts = Object.entries(table).map(([k, v]) => `${k} ${v}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/**
 * Why is nothing queued?
 *
 * A promotion needs a cluster carrying either two distinct model families or one
 * reference-tier report. Both "we have not sampled enough vendors yet" and "the pipeline
 * is broken" present as an empty queue, so say which, and say what would change it.
 */
function reportBlockers(
  sessions: number,
  families: readonly string[],
  queueDir: string,
  ticketDir: string,
  byTier: Record<string, number> = {},
): void {
  const { tickets } = readTickets(ticketDir);
  // `isActionable`, not a promotion-only filter. The dev loop's gate is a CONJUNCTION —
  // corroborated/verified AND still open — and this command used only the second half.
  // So a bucket whose every corroborated ticket had aged out to `stale` was reported
  // here as hundreds of actionable tickets while `qa:triage` promoted zero and
  // `npm run work` saw nothing: 633 tickets, "351 actionable", 0 submissions, on the one
  // command whose whole job is question 3 above. `summarizeBucket` has always used the
  // real predicate; using it here too means the two surfaces cannot disagree again.
  const actionable = tickets.filter(isActionable);
  // Promotion-eligible but held back by status. This is the number that EXPLAINS the
  // gap, so it is printed rather than left for someone to derive from two commands.
  const agedOut = tickets.filter(
    (t) => !isActionable(t) && (t.promotion === "verified" || t.promotion === "corroborated"),
  );
  const queue = summarizeQueue(readQueue(queueDir).submissions);

  section("Can anything reach the dev loop?");
  console.log(`  tickets ${tickets.length} (${actionable.length} actionable)`);
  if (agedOut.length > 0) {
    console.log(
      `          ${agedOut.length} reached corroborated/verified and then aged out to \`stale\``,
    );
  }
  console.log(`  queue   ${queue.total} (${queue.open} open)`);

  const playtestContributesNothing = tickets.length > 0 && actionable.length === 0;
  if (queue.open > 0) {
    console.log(`\n  ✓ The dev loop has work. \`npm run work -- --list\` shows it.`);
    // An open queue is NOT evidence that the playtest side is feeding it. The queue
    // takes audit, human and research submissions too, so a single open audit chore
    // used to end this report right here — swallowing the paragraphs below, which are
    // the only ones that answer question 3. A dead playtest flywheel therefore looked
    // identical to a healthy one, and did for hundreds of tickets.
    if (!playtestContributesNothing) return;
    console.log(
      `\n  ! Not from the playtest side, though: ${tickets.length} ticket(s) in the bucket,` +
        ` none actionable.`,
    );
  }
  // Only an EMPTY bucket means "nothing has happened yet". A corpus that lives in
  // another worktree (or an ignored one this checkout cannot see) still leaves its
  // tickets behind, and telling that operator "no sessions yet" would describe the
  // store while the bucket in front of them holds hundreds of findings.
  if (sessions === 0 && tickets.length === 0) {
    console.log(`\n  No sessions yet, so nothing can promote. Run a cohort, or file work`);
    console.log(`  directly: npm run submit -- --source human --kind feature --title "..."`);
    return;
  }
  if (tickets.length === 0) {
    console.log(`\n  ${sessions} session(s) produced no tickets. Either no session carried an`);
    console.log(`  exit interview, or triage has not run: npm run qa:triage -- --store <path>`);
    return;
  }
  if (actionable.length === 0) {
    // Two different stalls wear the same "none actionable" face, and they need opposite
    // actions. Aged-out tickets already CLEARED corroboration — adding a second family
    // would change nothing, and re-running triage here cannot revive them either, since
    // staleness is re-derived against THIS checkout's HEAD every pass. Only fresh play
    // on a current build does. Say that instead of the corroboration advice below.
    if (agedOut.length > 0) {
      console.log(
        `\n  ${agedOut.length} of ${tickets.length} ticket(s) DID reach corroborated/verified,` +
          ` then aged out:`,
      );
      console.log(`  their last-seen build is more than STALE_AFTER_BUILDS commits behind this`);
      console.log(`  checkout's HEAD, or is a commit its full history does not contain (a`);
      console.log(`  squash-merged lane build), and \`isActionable\` excludes a stale ticket.`);
      console.log(`  Re-running triage here will NOT revive them — staleness is recomputed`);
      console.log(`  against HEAD every pass. Only fresh sessions on the build under test, or`);
      console.log(`  a reproduction recorded with \`qa:triage -- --verified\`, will.`);
      return;
    }
    const hasReference = (byTier.reference ?? 0) > 0;
    console.log(`\n  ${tickets.length} ticket(s), none actionable yet. That is a real state, not`);
    console.log(`  a fault: promotion needs corroboration, and this corpus has neither rung.`);
    console.log(`\n  families so far: ${families.join(", ") || "none"}`);
    if (families.length < 2 && !hasReference) {
      console.log(`\n  → Add a SECOND model family, or one reference-tier session. One vendor`);
      console.log(`    sampled many times is one instrument, not many witnesses, so more runs`);
      console.log(`    of ${families[0] ?? "the same vendor"} will never promote anything.`);
    }
    // Total non-merging across MANY sessions is the fingerprint of a clustering fault —
    // it is what a live run looked like when 55 findings produced 55 tickets. Needs at
    // least three sessions to mean anything: with one session every ticket has exactly
    // one report by construction, so warning there would be pure noise. Even above that
    // it stays a prompt to look rather than a verdict, since a genuinely diverse corpus
    // can honestly produce singletons.
    const biggest = tickets.map((t) => t.evidence.report_count).reduce((a, b) => Math.max(a, b), 0);
    if (biggest === 1 && sessions >= 3 && tickets.length >= sessions * 2) {
      console.log(`\n  ! No ticket has more than one report — ${tickets.length} tickets from`);
      console.log(`    ${sessions} sessions, nothing merged at all. Worth a look: independent`);
      console.log(`    reports of one defect should cluster. If two sessions clearly described`);
      console.log(`    the same thing and still produced two tickets, that is a triage bug,`);
      console.log(`    not a shortage of evidence.`);
    }
  }
}

// Guarded so the module can be imported (onPath is unit-tested directly). Same idiom as
// scripts/verify-bug-traces.ts and bin/feedback.ts; `npm run doctor` still runs main().
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
