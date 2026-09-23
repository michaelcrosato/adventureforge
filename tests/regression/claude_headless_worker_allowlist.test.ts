/**
 * bug_0637 — agents/claude-headless-worker.sh's tool allowlist must not be nominal.
 *
 * It allowed `Bash(bash:*)`, `Bash(env:*)`, `Bash(xargs:*)`, `Bash(python3:*)` and
 * `Bash(command:*)` — each a generic "run any program" door with no dev-cycle need — and
 * `Bash(git:*)`, which includes `git push`. These read the REAL arrays out of the script
 * with bash itself (no hand-rolled parser), so the check is on exactly what the CLI gets.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT = "agents/claude-headless-worker.sh";
const text = readFileSync(SCRIPT, "utf8");

function readArray(name: string): string[] {
  const start = text.indexOf(`\n${name}=(`);
  const end = text.indexOf("\n)", start);
  expect(start, `${name} array missing`).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const literal = `${text.slice(start + 1, end)}\n)`;
  const result = spawnSync("bash", ["-s"], {
    input: `${literal}\nprintf '%s\\n' "\${${name}[@]}"\n`,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split(/\r?\n/u).filter((line) => line !== "");
}

const ALLOWED = readArray("ALLOWED");
const DISALLOWED = readArray("DISALLOWED_BASH");
/** The git subcommands a dev cycle actually uses. Anything else must be argued in. */
const CYCLE_GIT = [
  "status",
  "diff",
  "add",
  "commit",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "grep",
  "restore",
  "rm",
  "mv",
  "blame",
  "stash",
  "branch --show-current",
];

describe("claude headless worker allowlist (bug_0637)", () => {
  it("allows no generic command runner", () => {
    for (const runner of ["bash", "sh", "zsh", "env", "xargs", "python", "python3", "command"]) {
      expect(ALLOWED, runner).not.toContain(`Bash(${runner}:*)`);
      expect(
        ALLOWED.some((rule) => rule.startsWith(`Bash(${runner} `)),
        runner,
      ).toBe(false);
    }
    expect(ALLOWED.some((rule) => /^Bash\((?:eval|exec|source)\b/u.test(rule))).toBe(false);
  });

  it("allows git only through the subcommands a cycle uses — never blanket git", () => {
    expect(ALLOWED).not.toContain("Bash(git:*)");
    const gitRules = ALLOWED.filter((rule) => rule.startsWith("Bash(git"));
    expect(gitRules.length).toBeGreaterThan(0);
    for (const rule of gitRules) {
      const sub = /^Bash\(git (.+?)(?::\*)?\)$/u.exec(rule)?.[1];
      expect(sub, rule).toBeDefined();
      expect(CYCLE_GIT, rule).toContain(sub);
    }
    // The provisional commit (and its amend) must still be possible.
    expect(ALLOWED).toContain("Bash(git add:*)");
    expect(ALLOWED).toContain("Bash(git commit:*)");
  });

  it("denies git push and remote-mutating git outright, and hands that list to the CLI", () => {
    for (const rule of ["Bash(git push:*)", "Bash(git remote:*)", "Bash(gh:*)"]) {
      expect(DISALLOWED).toContain(rule);
    }
    const launch = text.slice(text.indexOf("setsid claude -p"));
    const disallowedFlag = launch.slice(launch.indexOf("--disallowedTools"));
    expect(disallowedFlag.split("\n")[0]).toContain('"${DISALLOWED_BASH[@]}"');
    // Deny must not be undercut: nothing on the allow side matches what is denied.
    for (const rule of DISALLOWED) expect(ALLOWED).not.toContain(rule);
  });

  it("says honestly that it is a guardrail, not a sandbox", () => {
    expect(text).toContain("GUARDRAIL, NOT A SANDBOX");
    expect(text).toMatch(/`node`\/`npx`\/`npm`/u);
  });
});
