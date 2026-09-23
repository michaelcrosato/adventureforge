/**
 * bug_0655 — the playtest loop triaged into tracked files between waves.
 *
 * `npm run qa:triage` writes qa/tickets/ and intake/queue/, both tracked. After every
 * wave the loop then either fetch-and-reset to its upstream (throwing that output away)
 * or, with no upstream, kept going on a dirty tree — and blind-tester/run.sh refuses every
 * pure player on a dirty tracked worktree, so wave 2 onward dispatched only refusals that
 * the unconditional recorder filed as failed sessions under a real vendor's name.
 *
 * Exercised the way tests/unit/doctor_cli.test.ts exercises the loop's other gates: the
 * shipped text is cut out of playtest-loop.sh and run under `bash -s`, with every command
 * that touches the world replaced by a stub. Running the script itself would dispatch a
 * live cohort.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const LOOP_SH = readFileSync(join(ROOT, "playtest-loop.sh"), "utf8");

/** The exact shipped text from `start` up to (not including) `end`, or to EOF. */
function loopSection(start: string, end: string | null): string {
  const from = LOOP_SH.indexOf(start);
  expect(from, `playtest-loop.sh no longer contains: ${start}`).toBeGreaterThanOrEqual(0);
  const to = end === null ? LOOP_SH.length : LOOP_SH.indexOf(end, from);
  expect(to, `playtest-loop.sh no longer contains: ${end}`).toBeGreaterThan(from);
  return LOOP_SH.slice(from, to);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Run a shell script and return the lines it appended to its CALLS file. */
function runRecording(lines: readonly string[]): {
  status: number | null;
  calls: string[];
  out: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "af-loop-triage-"));
  const callsFile = join(dir, "calls");
  try {
    const result = spawnSync("bash", ["-s"], {
      cwd: ROOT,
      input: [`CALLS=${shellQuote(callsFile)}`, ': > "$CALLS"', ...lines].join("\n"),
      encoding: "utf8",
      timeout: 60_000,
    });
    return {
      status: result.status,
      calls: readFileSync(callsFile, "utf8").split("\n").filter(Boolean),
      out: `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("playtest-loop.sh triage between waves (bug_0655)", () => {
  const TRIAGE_FN = loopSection("triage_after_wave() {", "\nrun_wave() {");
  const MAIN_LOOP = loopSection("\nwave=0\nwhile true; do", null);

  function triage(final: "0" | "1", enabled = "1") {
    return runRecording([
      "set -uo pipefail",
      `STORE=${shellQuote("/tmp/corpus")}`,
      `PLAYTEST_TRIAGE=${shellQuote(enabled)}`,
      // The one command the function may issue; record its arguments exactly.
      'npm() { printf "%s\\n" "$*" >> "$CALLS"; }',
      TRIAGE_FN,
      `triage_after_wave ${final}`,
    ]);
  }

  it("reports a dry run between waves, so the tracked bucket is never dirtied", () => {
    const { status, calls, out } = triage("0");
    expect(status, out).toBe(0);
    expect(calls).toEqual(["run --silent qa:triage -- --store /tmp/corpus --dry-run"]);
  });

  it("writes the bucket after the final wave, when no reset or next wave follows", () => {
    const { status, calls, out } = triage("1");
    expect(status, out).toBe(0);
    expect(calls).toEqual(["run --silent qa:triage -- --store /tmp/corpus"]);
  });

  it("still honors PLAYTEST_TRIAGE=0", () => {
    const { status, calls, out } = triage("1", "0");
    expect(status, out).toBe(0);
    expect(calls).toEqual([]);
  });

  function waves(options: { once: string; maxWaves: string }) {
    return runRecording([
      "set -uo pipefail",
      `once=${shellQuote(options.once)}`,
      `PLAYTEST_MAX_WAVES=${shellQuote(options.maxWaves)}`,
      "SEED_BASE=1",
      "DELAY=0",
      'run_wave() { printf "wave %s final %s\\n" "$1" "$2" >> "$CALLS"; }',
      // No upstream: exactly the configuration whose dirty tree used to refuse wave 2.
      "git() { return 1; }",
      "sleep() { :; }",
      "await_new_build() { :; }",
      MAIN_LOOP,
    ]);
  }

  it("marks only the last of PLAYTEST_MAX_WAVES waves final", () => {
    const { status, calls, out } = waves({ once: "0", maxWaves: "3" });
    expect(status, out).toBe(0);
    expect(calls).toEqual(["wave 1 final 0", "wave 2 final 0", "wave 3 final 1"]);
  });

  it("treats --once as a single final wave", () => {
    const { status, calls, out } = waves({ once: "1", maxWaves: "" });
    expect(status, out).toBe(0);
    expect(calls).toEqual(["wave 1 final 1"]);
  });
});
