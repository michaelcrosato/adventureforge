#!/usr/bin/env -S npx tsx
/**
 * One command for the whole landing loop: test, commit, push, PR, merge, delete.
 *
 *   npm run ship -- "what you changed"
 *
 * The point is that `main` is the only branch that survives. Each ship is a short-lived
 * branch that exists just long enough to carry a PR, and the PR is squash-merged so main
 * gains exactly ONE commit per ship. That is what makes rollback cheap: every landing is
 * a single revertable commit with a PR next to it explaining itself. A workflow nobody
 * runs protects nothing, so this is deliberately one line to type.
 *
 * WHICH BAR IT RUNS IS NOT A FLAG. It is read off the diff. The census proofs
 * (`test:exhaustive`) import only the scopes in CENSUS_PROOF_SOURCE_SCOPES, so a change
 * outside them cannot move a census verdict and the fast lane is sufficient evidence. A
 * change INSIDE them gets the full bar automatically, because there the proofs ARE the
 * ground truth. Choosing correctly by hand every time is exactly the thing people stop
 * doing at 2am, so the script does it and prints why.
 *
 * Nothing is pushed until the bar is green. A red bar exits nonzero with the work still
 * in the tree, uncommitted and unpushed.
 *
 * Flags:
 *   --full        force the full bar even when the diff does not require it
 *   --no-merge    open/update the PR and stop; do not merge or delete the branch
 *   --dry-run     print the plan and the chosen bar, touch nothing
 */
import { execFileSync, spawnSync } from "node:child_process";
import { npmCliInvocation } from "./npm-cli.js";
import { barForChangedFiles } from "./test-lanes.js";

function gh(args: string[]): { ok: true } | { ok: false; reason: string } {
  try {
    execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message.split("\n").slice(0, 3).join(" ").trim() };
  }
}

/**
 * Is the GitHub CLI usable here? "gh is not installed" and "gh is installed but you are
 * logged out" are different fixes, so the reason names which one this machine hit.
 */
function gitHubAvailable(): { ok: true } | { ok: false; reason: string } {
  if (!gh(["--version"]).ok) return { ok: false, reason: "the GitHub CLI (`gh`) is not on PATH" };
  const auth = gh(["auth", "status"]);
  if (!auth.ok)
    return { ok: false, reason: `\`gh\` is installed but not authenticated: ${auth.reason}` };
  return { ok: true };
}

const PROTECTED_BRANCH = "main";
/** The `verify` check is the repo's required gate; branch protection blocks the merge
 *  until it passes, so this is a wait, not a second opinion. */
const CHECK_POLL_SECONDS = 20;
const CHECK_TIMEOUT_SECONDS = 60 * 60;

export interface ShipOptions {
  message: string;
  full: boolean;
  merge: boolean;
  dryRun: boolean;
}

export function parseShipArguments(args: readonly string[]): ShipOptions {
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  for (const flag of flags)
    if (!["--full", "--no-merge", "--dry-run"].includes(flag))
      throw new Error(
        `Unknown flag ${flag}. Usage: npm run ship -- "message" [--full] [--no-merge] [--dry-run]`,
      );
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const message = positional.join(" ").trim();
  if (message === "")
    throw new Error('A commit message is required: npm run ship -- "what you changed"');
  return {
    message,
    full: flags.has("--full"),
    merge: !flags.has("--no-merge"),
    dryRun: flags.has("--dry-run"),
  };
}

/**
 * A branch name that is unique per ship and readable in the PR list. Short-lived by
 * design: it is deleted on merge, so it only has to survive one landing.
 */
export function shipBranchName(message: string, now: Date): string {
  const slug =
    message
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "change";
  const stamp = now.toISOString().replace(/[:-]/g, "").replace("T", "-").slice(0, 15);
  return `ship/${slug}-${stamp}`;
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function run(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  return result.status === 0;
}

/** npm through its JS entrypoint rather than the `npm` shim: on win32 the bare name is
 *  `npm.cmd`, and spawning it without a shell fails outright. Same reason
 *  run-with-soft-budget.ts resolves it this way. `runNpmScript`'s 120s default timeout is
 *  far too short for a bar, so this spawns directly with none. */
function runNpm(script: string): boolean {
  const npm = npmCliInvocation();
  const result = spawnSync(npm.command, [...npm.args, "run", script], {
    stdio: "inherit",
    shell: false,
  });
  return result.status === 0;
}

/** A portable synchronous pause. `sleep` is not a win32 executable, and this loop has to
 *  block between poll attempts without pulling in an async rewrite of main(). */
function sleepSeconds(seconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function ghJson(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}

function step(label: string): void {
  console.log(`\n=== ${label} ===`);
}

/** Both halves of a rename. `src/core/engine.ts -> scripts/engine.ts` moves a file OUT of
 *  census reach: keeping only the destination sees `scripts/` and picks the fast lane,
 *  while the engine file it removed is exactly what the proofs read. The NUL-delimited
 *  porcelain form is also the only one that survives a path containing a space or a
 *  literal " -> ", which the arrow-splitting version silently mangled. */
export function parsePorcelainPaths(porcelainZ: string): string[] {
  const fields = porcelainZ.split("\0").filter((field) => field !== "");
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]!;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    // For a rename or copy, git emits the ORIGINAL path as the very next NUL-separated
    // field. Consume it here so both sides reach the classifier.
    if (/[RC]/.test(status)) {
      const original = fields[index + 1];
      if (original !== undefined) {
        paths.push(original);
        index += 1;
      }
    }
  }
  return paths;
}

export interface ShipDiff {
  /** Every path the landing would carry: the working tree plus commits ahead of main. */
  paths: string[];
  /** True when the commits ahead of origin/main could not be read, so `paths` may be
   *  missing some of what the landing would carry. The bar must not be chosen off it. */
  committedUnreadable: boolean;
}

/**
 * Tracked-and-untracked changed paths, plus EVERYTHING committed on this checkout but not
 * yet on origin/main — a resumed ship must weigh its whole diff, not just today's.
 *
 * That includes a ship started ON `main` (bug_0635). Local commits on main are carried into
 * the new ship branch by `git checkout -b` and land in the PR, but the committed diff used
 * to be read only on a non-main branch — so a docs-only working tree on top of an unpushed
 * engine or content commit chose `health:fast` and shipped that commit without the census
 * proofs. `origin/main...HEAD` is empty when nothing is ahead, so asking unconditionally
 * costs nothing in the common case.
 *
 * `runGit` returns git's RAW stdout (no trim — porcelain -z fields may begin with a space).
 */
export function shipDiff(runGit: (args: string[]) => string): ShipDiff {
  const working = parsePorcelainPaths(runGit(["status", "--porcelain=v1", "-z"]));
  let committed: string[] = [];
  let committedUnreadable = false;
  try {
    // --no-renames so a rename is reported as the delete AND the add rather than as one
    // destination path, for the same reason parsePorcelainPaths keeps both sides.
    committed = runGit(["diff", "--name-only", "--no-renames", `origin/${PROTECTED_BRANCH}...HEAD`])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    // Unknown is not empty. Treating an unreadable ref as "nothing committed" picked the
    // fast bar for whatever the commits held; the caller escalates instead.
    committedUnreadable = true;
  }
  return { paths: [...new Set([...working, ...committed])], committedUnreadable };
}

/** Pure bar choice for a landing: the full bar whenever the diff touches a census scope,
 *  --full was asked for, or the diff could not be fully read. */
export function chooseShipBar(
  diff: ShipDiff,
  full: boolean,
): { bar: "full" | "fast"; reason: string } {
  if (diff.committedUnreadable)
    return {
      bar: "full",
      reason: `the commits ahead of origin/${PROTECTED_BRANCH} could not be read, so the fast lane cannot vouch for the whole diff`,
    };
  if (barForChangedFiles(diff.paths) === "full")
    return {
      bar: "full",
      reason:
        "the diff touches a scope the census proofs read, so the fast lane cannot vouch for it",
    };
  if (full) return { bar: "full", reason: "--full was requested" };
  return { bar: "fast", reason: "the diff touches nothing the census proofs read" };
}

/** gh reports "no required checks reported" as a plain error, not as pending. The CI
 *  workflow registers `verify` only after its prerequisite jobs finish, so this can
 *  remain normal for most of the run. It shares the overall wait deadline. */
function noChecksRegisteredYet(output: string): boolean {
  return /no (required )?checks? reported/i.test(output);
}

export function waitForChecks(branch: string): boolean {
  const deadline = Date.now() + CHECK_TIMEOUT_SECONDS * 1000;
  while (Date.now() < deadline) {
    const result = spawnSync("gh", ["pr", "checks", branch, "--required"], {
      encoding: "utf8",
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    // gh exits 0 when every required check passed, 8 while any is still pending, and 1
    // on a real failure. Treating "pending" as failure would abandon a healthy ship.
    if (result.status === 0) return true;
    if (result.status !== 8) {
      if (!noChecksRegisteredYet(output)) {
        console.error(output.trim());
        return false;
      }
      console.log("  …waiting for the required checks to register");
      sleepSeconds(CHECK_POLL_SECONDS);
      continue;
    }
    console.log(`  …required checks still running (${new Date().toISOString().slice(11, 19)})`);
    sleepSeconds(CHECK_POLL_SECONDS);
  }
  console.error("Timed out waiting for required checks.");
  return false;
}

function main(): void {
  const options = parseShipArguments(process.argv.slice(2));

  // A dry run must not contact the remote. Fetching first made the "touch nothing" preview
  // update git metadata, and fail outright when origin was unreachable — which is exactly
  // when someone reaches for a preview. With a stale tracking ref the preview weighs the
  // commits ahead of that ref; with a missing one shipDiff reports the diff unreadable
  // and the plan shows the full bar rather than guessing.
  if (!options.dryRun) git(["fetch", "origin", PROTECTED_BRANCH]);
  const startingBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch =
    startingBranch === PROTECTED_BRANCH
      ? shipBranchName(options.message, new Date())
      : startingBranch;

  const diff = shipDiff((args) => execFileSync("git", args, { encoding: "utf8" }));
  const paths = diff.paths;
  if (paths.length === 0 && !diff.committedUnreadable && startingBranch === PROTECTED_BRANCH) {
    console.log("Nothing to ship: no changes against main.");
    return;
  }
  const { bar, reason } = chooseShipBar(diff, options.full);
  const barScript = bar === "full" ? "health" : "health:fast";

  step("Plan");
  console.log(`  branch:  ${branch}${startingBranch === PROTECTED_BRANCH ? " (new)" : ""}`);
  console.log(`  changed: ${paths.length} path(s)`);
  console.log(`  bar:     npm run ${barScript} — ${reason}`);
  console.log(
    `  merge:   ${options.merge ? "squash into main, delete the branch" : "no (--no-merge)"}`,
  );
  if (options.dryRun) {
    console.log("\nDry run: nothing was changed.");
    return;
  }

  // Checked here rather than up front so `--dry-run` still previews the plan (and the
  // chosen bar) on a machine without the CLI — the preview needs git, not GitHub.
  const available = gitHubAvailable();
  if (!available.ok) {
    console.error(`\nCannot ship — ${available.reason}.`);
    process.exit(1);
  }

  if (startingBranch === PROTECTED_BRANCH) git(["checkout", "-b", branch]);

  step(`Bar (npm run ${barScript})`);
  if (!runNpm(barScript)) {
    console.error(
      `\nThe bar is red. Nothing was committed or pushed; your work is still in the tree.`,
    );
    process.exit(1);
  }

  step("Commit and push");
  if (git(["status", "--porcelain"]) !== "") {
    git(["add", "-A"]);
    if (!run("git", ["commit", "-m", options.message])) process.exit(1);
  } else {
    console.log("  (nothing new to commit; shipping what is already on the branch)");
  }
  if (!run("git", ["push", "-u", "origin", branch])) process.exit(1);

  step("Pull request");
  const existing = ghJson([
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    '.[0].number // ""',
  ]);
  if (existing === "") {
    if (
      !run("gh", [
        "pr",
        "create",
        "--base",
        PROTECTED_BRANCH,
        "--head",
        branch,
        "--title",
        options.message,
        "--body",
        `Shipped with \`npm run ship\`. Bar: \`npm run ${barScript}\` (${reason}).`,
      ])
    )
      process.exit(1);
  } else {
    console.log(`  reusing open PR #${existing}`);
  }

  if (!options.merge) {
    console.log("\n--no-merge: the PR is open and CI is running. Nothing else to do.");
    return;
  }

  step("Wait for required checks");
  if (!waitForChecks(branch)) {
    console.error("\nRequired checks did not pass. The PR is open; fix it and re-run ship.");
    process.exit(1);
  }

  step("Merge and clean up");
  if (!run("gh", ["pr", "merge", branch, "--squash", "--delete-branch"])) {
    console.error("\nMerge failed. The PR is open and green; resolve it there.");
    process.exit(1);
  }
  git(["checkout", PROTECTED_BRANCH]);
  // The merge already happened remotely, so a failure here is not fatal to the landing —
  // but reporting success while leaving the operator on stale local main is worse than
  // saying so. Exit nonzero and name the one command that fixes it.
  if (!run("git", ["pull", "--ff-only", "origin", PROTECTED_BRANCH])) {
    console.error(
      `\nMerged, but refreshing local ${PROTECTED_BRANCH} failed. Your checkout is behind the landing; run: git pull --ff-only origin ${PROTECTED_BRANCH}`,
    );
    process.exit(1);
  }
  console.log(`\nLanded on ${PROTECTED_BRANCH}. Only ${PROTECTED_BRANCH} remains.`);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("ship.ts")) {
  main();
}
