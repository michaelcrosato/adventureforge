/**
 * The recency spine triage ages findings against, and whether it can be trusted.
 *
 * Read from git rather than from the sessions themselves so that a build nobody has
 * played yet still counts as "newer" — otherwise a quiet period in the fleet would make
 * every ticket look freshly seen.
 *
 * The whole history, deliberately, not a window: with the previous `-n200` on a repository
 * already past 1,500 commits, every session played on a build older than the last two
 * hundred was permanently exempt from STALE_AFTER_BUILDS, which is precisely the ticket most
 * likely to describe something already fixed. Full history costs one 41-byte line per
 * commit and is read once.
 *
 * It lives here rather than in `bin/triage.ts` because that file runs `main()` at import,
 * and whether the spine is TRUNCATED is a claim that has to be testable: triage treats a
 * build missing from a complete history as stale (bug_0650), so a shallow clone reported as
 * complete would age every ticket it holds at once.
 */
import { execFileSync } from "node:child_process";

export type BuildHistory = {
  /** Commits reachable from HEAD, newest first. */
  commits: string[];
  /**
   * The spine may be missing builds that really are ancestors — a shallow clone, or a
   * checkout where either git probe failed. Triage then gives an unplaceable build the
   * benefit of the doubt instead of aging it.
   */
  truncated: boolean;
  /** Why `truncated` is set, for the operator; null when it is not. */
  reason: "shallow" | "unreadable" | null;
};

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Read the spine and say whether it is whole.
 *
 * Fails OPEN on every uncertainty, the opposite of `repositoryHistoryIsShallow` in
 * scripts/verify-bug-traces.ts. There, a failed probe only chooses which failure message
 * prints; here, answering "complete" wrongly would age every finding in the bucket, while
 * answering "truncated" wrongly only restores the pre-bug_0650 behaviour. So a probe that
 * errors, or prints anything but a literal `false`, reads as truncated.
 */
export function readBuildHistory(root: string): BuildHistory {
  let commits: string[];
  try {
    commits = git(root, ["log", "--format=%H"]).split(/\r?\n/).filter(Boolean);
  } catch {
    return { commits: [], truncated: true, reason: "unreadable" };
  }
  let shallow: string;
  try {
    shallow = git(root, ["rev-parse", "--is-shallow-repository"]).trim();
  } catch {
    return { commits, truncated: true, reason: "unreadable" };
  }
  if (shallow === "false") return { commits, truncated: false, reason: null };
  return { commits, truncated: true, reason: shallow === "true" ? "shallow" : "unreadable" };
}

/**
 * The line an operator must see when aging is running on a partial spine.
 *
 * A warning rather than a failure: triage runs inside the playtest loop, and stopping it
 * would stop evidence flowing to fix a condition that only weakens one rule. But it is
 * never silent, because AGENTS.md tells agents to rely on STALE_AFTER_BUILDS, and an agent
 * trusting it in a shallow checkout would be trusting a rule that is only half running.
 */
export function buildHistoryWarning(history: BuildHistory): string | null {
  if (!history.truncated) return null;
  const why =
    history.reason === "shallow"
      ? `this is a shallow clone (${history.commits.length} commit(s) of history)`
      : "git history could not be read in full";
  const remedy =
    history.reason === "shallow" ? " Run `git fetch --unshallow` once to restore it." : "";
  return (
    `! ${why}, so a finding whose build is not in it cannot be aged: STALE_AFTER_BUILDS ` +
    `applies only to builds this checkout can place, and older findings may still read as ` +
    `actionable.${remedy}`
  );
}
