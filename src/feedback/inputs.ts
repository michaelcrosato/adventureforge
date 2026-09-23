import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  pendingAcceptedCycleReportPaths,
  readCommittedFeedbackAcceptanceState,
  type FeedbackAcceptanceState,
} from "./acceptance.js";
import { sha256File } from "./report_manifest.js";

const CYCLE_STAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u;

function portablePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function physicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function pathSegmentEquals(actual: string, expected: string): boolean {
  return process.platform === "win32"
    ? actual.toLocaleLowerCase("en-US") === expected.toLocaleLowerCase("en-US")
    : actual === expected;
}

/** True only for the exact wall-clock id emitted by ai-loop's cycleStamp(). */
export function isCycleStamp(value: string): boolean {
  const match = CYCLE_STAMP_RE.exec(value);
  if (!match) return false;
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  const date = new Date(iso);
  return !Number.isNaN(date.valueOf()) && date.toISOString().replace(/[:.]/gu, "-") === value;
}

/**
 * Return the stable evidence ref for an exact immediate
 * `ai-runs/<cycle-stamp>/playtest.md` path, or null for every other path.
 * This is deliberately a path-shape check; report admission still happens in
 * collectInputs through the existing sidecar, receipt, and provider gates.
 */
function canonicalRefFromRelative(rel: string): string | null {
  if (rel.length === 0 || isAbsolute(rel)) return null;
  const parts = portablePath(rel).split("/");
  if (
    parts.length !== 3 ||
    !pathSegmentEquals(parts[0]!, "ai-runs") ||
    !isCycleStamp(parts[1]!) ||
    !pathSegmentEquals(parts[2]!, "playtest.md")
  ) {
    return null;
  }
  return `ai-runs/${parts[1]!}/playtest.md`;
}

export function canonicalCycleReportRef(root: string, path: string): string | null {
  // Lexical shape keeps a canonical slot pure even when an explicit path walks
  // through a symlink/junction. Physical shape handles Windows case aliases and
  // callers that reach the same real file through another in-root spelling.
  const lexical = canonicalRefFromRelative(relative(resolve(root), resolve(path)));
  if (lexical) return lexical;
  return canonicalRefFromRelative(relative(physicalPath(root), physicalPath(path)));
}

/**
 * Explicit --in arguments replace discovery completely. With no explicit
 * inputs, keep the local report ledger first so it wins dedupe precedence,
 * then outer-gate-accepted pending cycle reports from committed loop state.
 * Merely complete ignored cycle bundles and unaccepted crawler outputs are not
 * default authority; either remains available through explicit `--in`.
 *
 * WHERE THE CORPUS COMES FROM NOW THAT THE DEV LOOP NO LONGER PLAYS
 *
 * The second default — `pendingAcceptedCycleReportPaths` — was always ADDITIVE, and a
 * migrated dev cycle publishes no playtest, so it is now usually empty. That narrows the
 * corpus; it does not starve it. `blind-tester/reports` is still the first-precedence
 * input and still the destination every ad-hoc and corroboration run lands in by default:
 * `npm run blind` (blind-tester/run.sh) and `npm run fleet` (blind-tester/fleet.mjs) both
 * resolve an omitted `--out` to exactly this directory. An empty ledger is a real state,
 * but it is the "nobody has played recently" state, which `feedback:status` reports as
 * not-ready and the loop records as a skip — not a broken wiring.
 *
 * What is NOT wired here, deliberately, is the playtest loop's own corpus. Under the
 * two-loop design (docs/two_loop_workflow.md) a cohort writes run artifacts to
 * `ai-runs/playtest/runs/` and content-addressed session records to the session store
 * (src/qa/session_store.ts), and reaches the dev loop through TRIAGE into `intake/queue`
 * rather than through this compiler. Pointing the compiler at either one is a bigger
 * change than it looks:
 *
 *   - the session store holds `session.json` + a transcript, not the `<report>.md` +
 *     adjacent `.run.json` pair collectInputs reads, so it needs a real adapter in
 *     src/feedback/compile.ts before it can be named here at all; and
 *   - `ai-runs/playtest/runs/` uses ONE unstamped prefix per (provider, seed, persona),
 *     so a later run overwrites the earlier report at the same path. Manifests record
 *     evidence by ref, so admitting that directory would mint refs that silently stop
 *     meaning what they said — precisely what the ledger's stamped filenames prevent.
 *
 * Both are fixable, and neither is fixable safely from this function alone. Until then
 * the honest statement is: the compiler's live default corpus is the report ledger, and
 * the fleet reaches the dev loop through the intake queue, not through here.
 *
 * The first-default invariant is pinned by tests/regression/feedback_cycle_input_discovery.test.ts.
 */
export function resolveFeedbackInputs(
  root: string,
  explicitInputs: readonly string[],
  acceptedState?: FeedbackAcceptanceState,
): string[] {
  if (explicitInputs.length > 0) return [...explicitInputs];
  let state = acceptedState;
  if (!state) {
    const acceptance = readCommittedFeedbackAcceptanceState(root);
    if (!acceptance.ok) {
      throw new Error(`feedback input acceptance unavailable: ${acceptance.reason}`);
    }
    state = acceptance.state;
  }
  const inputs = [
    "blind-tester/reports",
    ...pendingAcceptedCycleReportPaths(root, state, sha256File),
  ];
  return inputs;
}
