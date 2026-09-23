/**
 * The autonomous loop's shell driver is a safety boundary, not just glue: it must run
 * the verification bar before committing, and — since the two loops split — it must do
 * that WITHOUT depending on a playtest of its own. Blind game agents cannot observe this
 * layer, so the test suite has to lock it directly.
 */
import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { classifyCycleBar } from "../../scripts/cycle-bar.js";

const REPO_ROOT = process.cwd();
const loopText = readFileSync("loop.sh", "utf8");
const bashRuntime = spawnSync("bash", ["-c", 'pwd; node -p "process.platform"'], {
  cwd: REPO_ROOT,
  env: process.env,
  encoding: "utf8",
});
if (bashRuntime.status !== 0) {
  throw new Error(`Could not resolve the loop-test bash runtime: ${bashRuntime.stderr}`);
}
const [BASH_REPO_ROOT = "", BASH_NODE_PLATFORM = ""] = bashRuntime.stdout.trim().split(/\r?\n/u);
if (!BASH_REPO_ROOT || !BASH_NODE_PLATFORM) {
  throw new Error("Could not resolve the loop-test bash repository path and Node platform.");
}

function sectionBetween(start: string, end: string): string {
  const startAt = loopText.indexOf(start);
  const endAt = loopText.indexOf(end, startAt);
  expect(startAt, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(endAt, `missing ${end}`).toBeGreaterThan(startAt);
  return loopText.slice(startAt, endAt);
}

function runGateHarness(
  body: string,
  env: Record<string, string> = {},
  invocation = "require_playtest_record",
  setup?: (root: string) => void,
): {
  status: number | null;
  output: string;
} {
  const root = mkdtempSync(join(tmpdir(), "loop-gate-"));
  try {
    setup?.(root);
    const exports = Object.entries(env).map(([key, value]) => {
      expect(key).toMatch(/^[A-Z0-9_]+$/);
      return `${key}='${value.replaceAll("'", "'\\''")}'; export ${key}`;
    });
    const script = ["set -uo pipefail", ...exports, body, invocation].join("\n");
    const result = spawnSync("bash", ["-s"], {
      cwd: root,
      env: process.env,
      input: script,
      encoding: "utf8",
    });
    return {
      status: result.status,
      output: `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`,
    };
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Git Bash can briefly retain its cwd handle on Windows after spawnSync returns.
      // The directory is under the OS temp root and contains only this test harness.
    }
  }
}

const initRepo = [
  "git init -q",
  "git config user.email loop@example.invalid",
  "git config user.name loop-test",
  "printf '%s\\n' '# state' > AI_LOOP_STATE.md",
  "git add AI_LOOP_STATE.md",
  "git commit -qm baseline",
  "start_ref=$(git rev-parse HEAD)",
].join("\n");

describe("loop.sh verification gates", () => {
  it("is syntactically valid bash", () => {
    const result = spawnSync("bash", ["-n", "loop.sh"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("keeps the provisional and final commits in the exact-clean evidence order", () => {
    const runCycle = sectionBetween("run_cycle() {", "\n}\n\ncount=0");
    const ordered = [
      "require_clean_evidence_cycle_start",
      "refresh_intake_queue",
      "report_qa_bucket",
      "npm run ai:loop",
      "run_agent",
      'require_provisional_commit "$start_ref"',
      "npm run --silent loop:rotate-state",
      "npm run crawl:smoke",
      // The bar is chosen off the cycle's diff and only then run, so both steps are
      // pinned in order: a selector that ran after the bar would decide nothing.
      'select_health_bar "$start_ref"',
      'npm run "$health_script"',
      'npm run verify:integrity -- --against "$start_ref"',
      "require_final_ledger_only",
      "safe_commit_if_enabled",
      "git push",
    ];

    let previous = -1;
    for (const needle of ordered) {
      const index = runCycle.indexOf(needle, previous + 1);
      expect(index, `run_cycle is missing ${needle}`).toBeGreaterThan(previous);
      previous = index;
    }
  });

  it("rejects an unattested provisional commit immediately, not after the bar", () => {
    // A provisional commit whose ledger entry carries no actual-selection marker is dead
    // the moment it exists: loop:seal-feedback refuses it at the END of the cycle whatever
    // the gates said. One such cycle spent seventy minutes proving a full bar green — 4771
    // tests — and was discarded at the last step. The check therefore has to sit right
    // after the commit and BEFORE anything expensive.
    const runCycle = sectionBetween("run_cycle() {", "\n}\n\ncount=0");
    const gate = sectionBetween(
      "require_selection_attestation() {",
      "\n}\n\nrequire_final_ledger_only()",
    );
    const provisional = runCycle.indexOf('require_provisional_commit "$start_ref"');
    const attestation = runCycle.indexOf("require_selection_attestation ||", provisional);
    const rotate = runCycle.indexOf("loop:rotate-state", attestation);
    const bar = runCycle.indexOf('npm run "$health_script"', attestation);

    expect(provisional).toBeGreaterThanOrEqual(0);
    expect(attestation).toBeGreaterThan(provisional);
    // Before the rotation, the post-crawl and the bar — everything the wasted cycle paid for.
    expect(rotate).toBeGreaterThan(attestation);
    expect(bar).toBeGreaterThan(attestation);
    expect(runCycle).toContain('_reject_cycle "attestation"');
    // It asks the SEAL rather than re-parsing the marker in bash: a check that drifts from
    // the gate it stands in for would fail cycles the seal would have accepted.
    expect(gate).toContain(
      "npm run --silent loop:seal-feedback -- --check-attestation --meta ai-runs/latest-cycle.json",
    );
    expect(runCycle).not.toMatch(/feedback_cycle_selection[^\n]*grep/u);
    expect(gate).not.toMatch(/feedback_cycle_selection[^\n]*grep/u);
  });

  it("asks for the attestation in commit mode only (bug_0630)", () => {
    // The attestation lives in the provisional commit's ledger scaffold, which ai-loop.ts
    // writes only when AI_LOOP_COMMIT=1. Asked unconditionally, the check exited 1 on
    // every evidence-only cycle (HEAD is the untouched cycle start) and _reject_cycle
    // hard-reset it, so the default mode could never succeed. The guard sits BEFORE the
    // seal call, the same shape require_provisional_commit and safe_commit_if_enabled use.
    const gate = `${sectionBetween(
      "require_selection_attestation() {",
      "\n}\n\nrequire_final_ledger_only()",
    )}\n}`;
    expect(gate.indexOf('[[ "${AI_LOOP_COMMIT:-0}" == "1" ]] || return 0')).toBeGreaterThan(0);
    expect(gate.indexOf('[[ "${AI_LOOP_COMMIT:-0}" == "1" ]] || return 0')).toBeLessThan(
      gate.indexOf("npm run --silent loop:seal-feedback"),
    );

    // Behaviourally: a stub `npm` records whether the seal was asked and answers with
    // the status the case needs.
    const stub = (sealStatus: number): string =>
      ["npm() {", '  printf "SEAL-ASKED %s\\n" "$*"', `  return ${sealStatus}`, "}", gate].join(
        "\n",
      );

    const evidenceOnly = runGateHarness(
      stub(1),
      { AI_LOOP_COMMIT: "0" },
      "require_selection_attestation",
    );
    expect(evidenceOnly.status, evidenceOnly.output).toBe(0);
    expect(evidenceOnly.output).not.toContain("SEAL-ASKED");

    const unsetMode = runGateHarness(stub(1), {}, "require_selection_attestation");
    expect(unsetMode.status, unsetMode.output).toBe(0);
    expect(unsetMode.output).not.toContain("SEAL-ASKED");

    const commitUnattested = runGateHarness(
      stub(1),
      { AI_LOOP_COMMIT: "1" },
      "require_selection_attestation",
    );
    expect(commitUnattested.status).toBe(1);
    expect(commitUnattested.output).toContain(
      "SEAL-ASKED run --silent loop:seal-feedback -- --check-attestation --meta ai-runs/latest-cycle.json",
    );

    const commitAttested = runGateHarness(
      stub(0),
      { AI_LOOP_COMMIT: "1" },
      "require_selection_attestation",
    );
    expect(commitAttested.status, commitAttested.output).toBe(0);
    expect(commitAttested.output).toContain("SEAL-ASKED");
  });

  it("rotates completed loop state in both modes before post-change verification", () => {
    const runCycle = sectionBetween("run_cycle() {", "\n}\n\ncount=0");
    const provisional = runCycle.indexOf('require_provisional_commit "$start_ref"');
    const rotation = runCycle.indexOf("npm run --silent loop:rotate-state", provisional);
    const postCrawl = runCycle.indexOf("npm run crawl:smoke", rotation);
    const health = runCycle.indexOf('npm run "$health_script"', rotation);
    const rotationBlock = runCycle.slice(rotation, postCrawl);
    const scripts = (
      JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;

    expect(rotation).toBeGreaterThan(provisional);
    expect(postCrawl).toBeGreaterThan(rotation);
    expect(health).toBeGreaterThan(postCrawl);
    expect(runCycle.match(/npm run --silent loop:rotate-state/gu)).toHaveLength(1);
    expect(rotationBlock).toContain(
      '_reject_cycle "loop-state-rotation" "deterministic final loop-state rotation failed"',
    );
    // Between the provisional commit and the rotation, the ONLY commit-mode-gated step is
    // the attestation check, and it is gated inside its own function (bug_0630) — so the
    // rotation itself stays unconditional and runs in both modes. Pinned both ways: the
    // attestation function carries the guard, and nothing inline in run_cycle between the
    // two steps does, so a guard cannot creep over the rotation.
    const attestationGate = sectionBetween(
      "require_selection_attestation() {",
      "\n}\n\nrequire_final_ledger_only()",
    );
    expect(attestationGate).toContain('[[ "${AI_LOOP_COMMIT:-0}" == "1" ]] || return 0');
    expect(runCycle.slice(provisional, rotation)).toContain("require_selection_attestation ||");
    expect(runCycle.slice(provisional, rotation)).not.toContain("AI_LOOP_COMMIT");
    expect(scripts["loop:rotate-state"]).toBe("tsx scripts/rotate-loop-state.ts");
  });

  it("accepts a clean tree as well as a ledger-only one, and still refuses a second change", () => {
    // The gate exists to stop a cycle quietly growing a SECOND change after it verified.
    // Nothing at all cannot be a second change — but the gate rejected it anyway, and a
    // green cycle was reverted with "got: (none)" because its worker had frozen the
    // completed ledger inside its own provisional commit. An early ledger, not a missing one.
    const gate = `${sectionBetween("require_final_ledger_only() {", "\n}\n\n# Which post-change bar")}\n}`;
    const ask = (setup?: (root: string) => void): { status: number | null; output: string } =>
      runGateHarness(gate, { AI_LOOP_COMMIT: "1" }, "require_final_ledger_only", (root) => {
        spawnSync("git", ["init", "-q"], { cwd: root });
        spawnSync("git", ["config", "user.email", "t@t"], { cwd: root });
        spawnSync("git", ["config", "user.name", "t"], { cwd: root });
        writeFileSync(join(root, "AI_LOOP_STATE.md"), "seed\n");
        spawnSync("git", ["add", "-A"], { cwd: root });
        spawnSync("git", ["commit", "-qm", "seed"], { cwd: root });
        setup?.(root);
      });

    const clean = ask();
    expect(clean.status, clean.output).toBe(0);
    expect(clean.output).toContain("frozen in the provisional commit");

    const ledgerOnlyChange = ask((root) => {
      writeFileSync(join(root, "AI_LOOP_STATE.md"), "seed\nentry\n");
    });
    expect(ledgerOnlyChange.status, ledgerOnlyChange.output).toBe(0);
    expect(ledgerOnlyChange.output).toContain("ledger-only");

    // The thing it must still refuse: any OTHER change, with or without the ledger.
    const secondChange = ask((root) => {
      writeFileSync(join(root, "src.ts"), "grown after verification\n");
    });
    expect(secondChange.status).not.toBe(0);
    expect(secondChange.output).toContain("src.ts");
  });

  it("does not demand a second commit when the ledger was already frozen", () => {
    // The other half of the same bug: with the ledger committed early the seal has nothing
    // left to write, and failing "No final ledger change to commit" would lose the cycle at
    // the very last step. That tolerance is scoped — it applies ONLY when the tree was
    // already clean before the seal ran, so a genuinely missing ledger still fails.
    const commit = sectionBetween("safe_commit_if_enabled() {", "\n}\n\nreport_qa_bucket()");
    const frozenAt = commit.indexOf("ledger_already_frozen=1");
    const seal = commit.indexOf("loop:seal-feedback");
    expect(frozenAt).toBeGreaterThanOrEqual(0);
    // Checked BEFORE the seal runs; reading it afterwards would always see a clean tree.
    expect(seal).toBeGreaterThan(frozenAt);
    expect(commit).toContain("no second commit needed");
    expect(commit).toContain("No final ledger change to commit.");
  });

  it("safe_commit_if_enabled is inert unless AI_LOOP_COMMIT=1", () => {
    const safeCommit = sectionBetween("safe_commit_if_enabled() {", "\n}\n\nreport_qa_bucket()");

    expect(safeCommit.indexOf('[[ "${AI_LOOP_COMMIT:-0}" != "1" ]]')).toBeLessThan(
      safeCommit.indexOf("loop:seal-feedback"),
    );
    expect(safeCommit.indexOf("loop:seal-feedback")).toBeLessThan(
      safeCommit.indexOf("git add -- AI_LOOP_STATE.md"),
    );
    expect(safeCommit).toContain('--expected-commit "$current_ref"');
    expect(safeCommit).toContain('--start-ref "$cycle_failure_start_ref"');
    expect(safeCommit.indexOf("git add -- AI_LOOP_STATE.md")).toBeLessThan(
      safeCommit.indexOf("git commit"),
    );
    expect(safeCommit).not.toContain("git add -A");
  });

  it("installs both root and UI dependencies before cycles can reach health", () => {
    const rootInstall = loopText.indexOf("if [[ ! -d node_modules ]]");
    const uiInstall = loopText.indexOf("if [[ ! -d ui/node_modules ]]");
    const cycle = loopText.indexOf("run_cycle() {");

    expect(rootInstall).toBeGreaterThanOrEqual(0);
    expect(uiInstall).toBeGreaterThan(rootInstall);
    expect(loopText.slice(uiInstall, cycle)).toContain("npm --prefix ui install");
    expect(cycle).toBeGreaterThan(uiInstall);
  });

  it("stops continuous evidence-only mode when a successful cycle leaves pending work", () => {
    const mainLoop = loopText.slice(loopText.indexOf("while true; do"));
    const success = mainLoop.indexOf('echo "✓ cycle');
    const pending = mainLoop.indexOf("Evidence-only work remains uncommitted");
    const stop = mainLoop.indexOf("break", pending);

    expect(success).toBeGreaterThanOrEqual(0);
    expect(pending).toBeGreaterThan(success);
    expect(stop).toBeGreaterThan(pending);
  });
});

describe("loop.sh latest_prompt (bug_0613)", () => {
  const latestPrompt = `${sectionBetween("latest_prompt() {", "\n}\n\n# ── Dev-agent registry")}\n}`;

  it("names the newest cycle prompt by mtime without GNU find extensions", () => {
    const result = runGateHarness(latestPrompt, {}, "latest_prompt", (root) => {
      mkdirSync(join(root, "ai-runs", "older"), { recursive: true });
      mkdirSync(join(root, "ai-runs", "newer"), { recursive: true });
      writeFileSync(join(root, "ai-runs", "older", "agent-prompt.md"), "old", "utf8");
      writeFileSync(join(root, "ai-runs", "newer", "prompt.md"), "new", "utf8");
      const past = new Date(Date.now() - 600_000);
      utimesSync(join(root, "ai-runs", "older", "agent-prompt.md"), past, past);
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output.trim()).toBe("ai-runs/newer/prompt.md");
  });

  it("prints nothing when no cycle prompt exists", () => {
    const result = runGateHarness(latestPrompt, {}, "latest_prompt", (root) => {
      mkdirSync(join(root, "ai-runs"), { recursive: true });
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output.trim()).toBe("");
  });

  it("does not use the GNU-only -printf action", () => {
    expect(latestPrompt).not.toContain("-printf");
  });
});

describe("loop.sh per-cycle clean baseline and scoped cleanup", () => {
  const cleanEvidence = `${sectionBetween(
    "require_clean_evidence_cycle_start() {",
    "\n}\n\nremove_new_untracked_since_cycle_start()",
  )}\n}`;
  const cleanup = `${sectionBetween(
    "remove_new_untracked_since_cycle_start() {",
    "\n}\n\nlatest_prompt()",
  )}\n}`;

  it("requires every evidence-only cycle to start clean, even with the dirty override", () => {
    const clean = runGateHarness(
      [initRepo, cleanEvidence].join("\n"),
      { AI_LOOP_COMMIT: "0", AI_LOOP_ALLOW_DIRTY: "1" },
      "require_clean_evidence_cycle_start",
    );
    expect(clean.status, clean.output).toBe(0);

    const dirty = runGateHarness(
      [initRepo, "mkdir -p docs", "printf '%s\\n' pending > docs/pending.md", cleanEvidence].join(
        "\n",
      ),
      { AI_LOOP_COMMIT: "0", AI_LOOP_ALLOW_DIRTY: "1" },
      "require_clean_evidence_cycle_start",
    );
    expect(dirty.status).toBe(1);
    expect(dirty.output).toContain("exact-clean worktree at cycle start");
    expect(dirty.output).toContain("does not waive pure-play evidence provenance");

    const explicitRisk = runGateHarness(
      [initRepo, "printf '%s\\n' pending > pending.md", cleanEvidence].join("\n"),
      { AI_LOOP_COMMIT: "1", AI_LOOP_ALLOW_DIRTY: "1" },
      "require_clean_evidence_cycle_start",
    );
    expect(explicitRisk.status, explicitRisk.output).toBe(0);
  });

  it("removes only cycle-created untracked paths across the repo", () => {
    expect(cleanup).not.toContain("git clean -fdq content traces tests");
    const result = runGateHarness(
      [
        initRepo,
        "printf '%s\\n' 'ai-runs/' > .gitignore",
        "git add .gitignore",
        "git commit -qm ignore-evidence",
        "mkdir -p src ai-runs",
        "printf '%s\\n' precious > src/preexisting.ts",
        "snapshot=$(mktemp)",
        'git ls-files --others --exclude-standard -z > "$snapshot"',
        "mkdir -p docs ui/new scripts bin traces content tests ai-runs",
        "printf '%s\\n' cycle > src/cycle.ts",
        "printf '%s\\n' cycle > 'docs/cycle note.md'",
        "printf '%s\\n' cycle > ui/new/cycle.tsx",
        "printf '%s\\n' cycle > scripts/cycle.mjs",
        "printf '%s\\n' cycle > bin/cycle.ts",
        "printf '%s\\n' cycle > traces/cycle.yaml",
        "printf '%s\\n' cycle > content/cycle.yaml",
        "printf '%s\\n' cycle > tests/cycle.test.ts",
        "printf '%s\\n' evidence > ai-runs/evidence.md",
        cleanup,
      ].join("\n"),
      {},
      [
        'remove_new_untracked_since_cycle_start "$snapshot"',
        "test -f src/preexisting.ts",
        'test "$(cat src/preexisting.ts)" = precious',
        "test -f ai-runs/evidence.md",
        "test ! -e src/cycle.ts",
        "test ! -e 'docs/cycle note.md'",
        "test ! -e ui/new/cycle.tsx",
        "test ! -e scripts/cycle.mjs",
        "test ! -e bin/cycle.ts",
        "test ! -e traces/cycle.yaml",
        "test ! -e content/cycle.yaml",
        "test ! -e tests/cycle.test.ts",
        'rm -f -- "$snapshot"',
      ].join("\n"),
    );

    expect(result.status, result.output).toBe(0);
  });

  it("refuses cleanup when its exact cycle-start snapshot is unavailable", () => {
    const result = runGateHarness(
      [initRepo, "printf '%s\\n' precious > preexisting.md", cleanup].join("\n"),
      {},
      'remove_new_untracked_since_cycle_start "missing.snapshot"',
    );

    expect(result.status).toBe(1);
    expect(result.output).toContain("refusing broad cleanup");
  });

  it("captures untracked paths before assessment and wires delta cleanup after reset", () => {
    const runCycle = sectionBetween("run_cycle() {", "\n}\n\ncount=0");
    const snapshot = runCycle.indexOf(
      'git ls-files --others --exclude-standard -z > "$untracked_snapshot"',
    );
    const assess = runCycle.indexOf("npm run ai:loop");
    const reset = runCycle.indexOf('git reset --hard "$start_ref"');
    const cleanDelta = runCycle.indexOf(
      'remove_new_untracked_since_cycle_start "$untracked_snapshot"',
      reset,
    );

    expect(snapshot).toBeGreaterThanOrEqual(0);
    expect(assess).toBeGreaterThan(snapshot);
    expect(reset).toBeGreaterThanOrEqual(0);
    expect(cleanDelta).toBeGreaterThan(reset);
    expect(runCycle).not.toContain("git clean -fdq content traces tests");
  });
});

describe("loop.sh provisional/final commit contracts", () => {
  const provisional = `${sectionBetween(
    "require_provisional_commit() {",
    "\n}\n\nrequire_selection_attestation()",
  )}\n}`;
  const ledgerOnly = `${sectionBetween(
    "require_final_ledger_only() {",
    // select_health_bar now sits between these two functions, so the old end anchor cut a
    // section three times the intended size. Anchor on what actually follows the gate.
    "\n}\n\n# Which post-change bar",
  )}\n}`;
  it("requires an advancing local commit in commit-enabled mode", () => {
    const missing = runGateHarness(
      [initRepo, provisional].join("\n"),
      { AI_LOOP_COMMIT: "1" },
      'require_provisional_commit "$start_ref"',
    );
    expect(missing.status).toBe(1);
    expect(missing.output).toContain("No provisional implementation commit");

    const present = runGateHarness(
      [
        initRepo,
        "printf '%s\\n' implementation > game.txt",
        "git add game.txt",
        "git commit -qm provisional",
        provisional,
      ].join("\n"),
      { AI_LOOP_COMMIT: "1" },
      'require_provisional_commit "$start_ref"',
    );
    expect(present.status, present.output).toBe(0);
    expect(present.output).toContain("local provisional revision present");
  });

  it("allows exactly one post-play tracked change: AI_LOOP_STATE.md", () => {
    const valid = runGateHarness(
      [initRepo, "printf '%s\\n' result >> AI_LOOP_STATE.md", ledgerOnly].join("\n"),
      { AI_LOOP_COMMIT: "1" },
      "require_final_ledger_only",
    );
    expect(valid.status, valid.output).toBe(0);

    const invalid = runGateHarness(
      [
        initRepo,
        "printf '%s\\n' result >> AI_LOOP_STATE.md",
        "printf '%s\\n' late-fix > late.ts",
        ledgerOnly,
      ].join("\n"),
      { AI_LOOP_COMMIT: "1" },
      "require_final_ledger_only",
    );
    expect(invalid.status).toBe(1);
    expect(invalid.output).toContain("Expected AI_LOOP_STATE.md to be the only");
    expect(invalid.output).toContain("late.ts");
  });
});

describe("loop.sh agent selection", () => {
  const agentCommand = `${sectionBetween("agent_cmd() {", "\n}\n\n# Run one resolved agent")}\n}`;
  const launchAgent = `${sectionBetween("launch_agent() {", "\n}\n\nrun_agent()")}\n}`;
  // The whole registry block, not two functions picked out of it: the ids and the
  // per-agent fields now come from dev-agents.json (which bin/doctor.ts also reads), so
  // dev_agent_binary and dev_agent_command are no longer self-contained case statements.
  // Slicing the block whole is also what keeps this harness honest — it exercises the
  // real registry rather than a list retyped here that could drift from the file.
  const registry = `${sectionBetween('DEV_AGENT_REGISTRY="', "\n}\n\n# Resolve")}\n}`;
  // Empty PATH so ONLY the stub functions below resolve. Without this the test inherits
  // whatever agents happen to be installed on the machine running it, and "no agent
  // available" becomes unassertable on a developer box. That is not hypothetical: node's
  // own directory turned out to hold a `claude` binary here, so putting it on PATH to
  // reach node made the no-agent case resolve claude.
  //
  // loop.sh needs node to read dev-agents.json, so it is handed the interpreter by
  // ABSOLUTE PATH instead — the AI_LOOP_NODE_CMD override exists for exactly this.
  const preamble = [
    "set -uo pipefail",
    'PATH=""',
    `AI_LOOP_NODE_CMD=${JSON.stringify(process.execPath)}`,
    registry,
  ].join("\n");

  function resolve(lines: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync("bash", ["-s"], {
      cwd: process.cwd(),
      env: process.env,
      input: [preamble, ...lines, agentCommand, "agent_cmd"].join("\n"),
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("never inspects a vendor credential file to decide which agent to run", () => {
    expect(agentCommand).not.toMatch(new RegExp(["auth", "json"].join("\\."), "i"));
    expect(agentCommand).not.toMatch(/credential/i);
  });

  it("auto-detects any supported agent, not one privileged vendor", () => {
    const codexOnly = resolve(["unset AI_AGENT AI_AGENT_CMD AI_CODEX_SANDBOX", "codex() { :; }"]);
    expect(codexOnly.status, codexOnly.stderr).toBe(0);
    // The placeholders resolve to quoted positional references, not spliced values
    // (bug_0632): launch_agent supplies the cwd as $1 and the sandbox as $2.
    expect(codexOnly.stdout).toBe('codex -a never exec --sandbox "$2" --cd "$1" -');

    // With no codex installed the loop still runs — on whatever IS installed.
    const claudeOnly = resolve(["unset AI_AGENT AI_AGENT_CMD", "claude() { :; }"]);
    expect(claudeOnly.status, claudeOnly.stderr).toBe(0);
    expect(claudeOnly.stdout).toContain("claude -p");

    const geminiOnly = resolve(["unset AI_AGENT AI_AGENT_CMD", "gemini() { :; }"]);
    expect(geminiOnly.status, geminiOnly.stderr).toBe(0);
    expect(geminiOnly.stdout).toContain("gemini");
  });

  it("honours AI_AGENT over auto-detection order", () => {
    const result = resolve([
      "unset AI_AGENT_CMD",
      "codex() { :; }",
      "claude() { :; }",
      'AI_AGENT="claude"',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("claude -p");
    expect(result.stdout).not.toContain("codex");
  });

  it("refuses to silently substitute another vendor when the requested one is absent", () => {
    // Substituting would make the cycle ledger claim work an agent never did.
    const result = resolve(["unset AI_AGENT_CMD", "codex() { :; }", 'AI_AGENT="gemini"']);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain("gemini");
    expect(result.stderr).toContain("not on PATH");
  });

  it("rejects an unknown AI_AGENT id instead of guessing", () => {
    const result = resolve(["unset AI_AGENT_CMD", "codex() { :; }", 'AI_AGENT="not-an-agent"']);
    expect(result.stdout.trim()).toBe("");
    expect(result.stderr).toContain("is not a known dev agent");
  });

  it("gives an explicit AI_AGENT_CMD precedence over every registry entry", () => {
    const result = resolve([
      "unset AI_CODEX_SANDBOX",
      "codex() { :; }",
      'AI_AGENT="codex"',
      'AI_AGENT_CMD="explicit-agent --headless"',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("explicit-agent --headless\n");
  });

  it("emits nothing when no agent is available, so the cycle degrades to evidence-only", () => {
    const result = resolve(["unset AI_AGENT AI_AGENT_CMD"]);
    expect(result.stdout.trim()).toBe("");
  });

  it("launches a registry agent without re-parsing the cwd or sandbox as shell (bug_0632)", () => {
    // intake cdae46f8: {CWD} used to be spliced into the string launch_agent hands to
    // `bash -c`, so a checkout path with a space split --cd, and one containing `;` or
    // `$(...)` executed. Drive the REAL registry entry through the REAL launch line from a
    // hostile directory and a hostile sandbox value; the stub agent records its argv.
    const root = mkdtempSync(join(tmpdir(), "loop-launch-"));
    const hostile = "repo dir;touch PWNED_SEMI;$(touch PWNED_SUB)";
    const sandbox = "workspace-write;touch PWNED_SANDBOX";
    try {
      mkdirSync(join(root, "stub"));
      mkdirSync(join(root, hostile));
      writeFileSync(
        join(root, "stub", "codex"),
        '#!/usr/bin/env bash\nfor a in "$@"; do printf "%s\\n" "$a"; done > "$ARGS_OUT"\n',
        { mode: 0o755 },
      );
      writeFileSync(join(root, hostile, "prompt.md"), "prompt\n");
      const script = [
        "set -uo pipefail",
        `AI_LOOP_NODE_CMD=${JSON.stringify(process.execPath)}`,
        registry,
        `DEV_AGENT_REGISTRY=${JSON.stringify(`${BASH_REPO_ROOT}/dev-agents.json`)}`,
        agentCommand,
        launchAgent,
        "AGENT_PID_FILE=unused.pid",
        'timeout() { shift 2; "$@"; }',
        "write_process_record() { :; }",
        "export -f write_process_record",
        'export ARGS_OUT="$PWD/args.txt"',
        'PATH="$PWD/stub:$PATH"',
        `cd ${JSON.stringify(hostile).replaceAll("$", "\\$")}`,
        `AI_CODEX_SANDBOX=${JSON.stringify(sandbox)}`,
        'cmd="$(dev_agent_command codex)"',
        'launch_agent "$cmd" 60 prompt.md',
        'printf "rc=%s\\n" "$?"',
        'printf "cwd=%s\\n" "$PWD"',
      ].join("\n");
      const result = spawnSync("bash", ["-s"], {
        cwd: root,
        env: process.env,
        input: script,
        encoding: "utf8",
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(result.stdout).toContain("rc=0");
      const bashCwd = /cwd=(.*)/u.exec(result.stdout)?.[1];
      expect(bashCwd, output).toBeDefined();
      expect(bashCwd!.endsWith(hostile)).toBe(true);

      const argv = readFileSync(join(root, "args.txt"), "utf8").split("\n").slice(0, -1);
      expect(argv).toEqual(["-a", "never", "exec", "--sandbox", sandbox, "--cd", bashCwd, "-"]);
      for (const marker of ["PWNED_SEMI", "PWNED_SUB", "PWNED_SANDBOX"]) {
        expect(existsSync(join(root, marker)), marker).toBe(false);
        expect(existsSync(join(root, hostile, marker)), marker).toBe(false);
      }
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // Git Bash can briefly retain its cwd handle on Windows; the temp dir is harmless.
      }
    }
  });
});

describe("the dev loop does not gate on a playtest", () => {
  const driver = readFileSync("loop.sh", "utf8");

  it("has no playtest gate left to fail a cycle", () => {
    // The whole point of splitting the loops: experience evidence is an INPUT to a
    // cycle, never a condition on landing one.
    expect(driver).not.toContain("require_playtest_record");
    expect(driver).not.toContain("loop:verify-playtest");
  });

  it("reads the intake queue instead, and cannot fail the cycle on it", () => {
    const bucket = `${sectionBetween("report_qa_bucket() {", "\n}\n\nawait_queued_work")}\n}`;
    // The queue, not just the QA bucket: an audit finding or a human request is work
    // too, and a loop that could only see playtest output would be blind to both.
    expect(bucket).toContain("run --silent work");
    // Every path returns 0: an empty or unreadable bucket is a normal state.
    expect(bucket).toContain("return 0");
    expect(bucket).not.toMatch(/return 1/);
  });

  it("keeps the mechanical gates as the whole bar", () => {
    // Assert against the EXECUTABLE driver, not its prose. `npm run health` does still
    // occur in loop.sh — but only inside a comment recounting an old wedged-loop
    // incident, so a toContain over the whole file would keep passing even if the gate
    // itself were deleted. A comment is exactly where a pin goes quietly vacuous.
    const code = driver.replace(/^\s*#.*$/gmu, "");
    expect(code).toContain("crawl:smoke");
    // The bar is still blocking; WHICH health script runs is read off the cycle's diff
    // (select_health_bar, below), the same way `npm run ship` chooses a landing's bar.
    expect(code).toContain("select_health_bar");
    expect(code).toContain('npm run "$health_script"');
    // Those two are the selector's ONLY possible answers, so "the bar" cannot quietly
    // become some third, weaker script.
    expect(code).toContain("printf 'health\\n'");
    expect(code).toContain("printf 'health:fast\\n'");
    expect(code).toContain("verify:integrity");
  });

  it("still rejects a cycle whose outer gates go red", () => {
    expect(driver).toContain('_reject_cycle "health"');
    expect(driver).toContain('_reject_cycle "integrity"');
    expect(driver).toContain('_reject_cycle "crawl-post"');
  });

  it("never launches a player, and its commit path carries no playtest dependency", () => {
    // The last hard playtest requirement in commit mode was not visible in loop.sh at
    // all: it lived inside `loop:seal-feedback`, which demanded ai-runs/<runId>/playtest.*
    // plus a pure V2 sidecar bound to the provisional commit. A cycle that skipped the
    // run therefore passed every gate named above and was hard-reset at the seal — and
    // since only one vendor could mint that sidecar, this is also what kept a
    // Claude-driven dev loop needing Codex installed. The seal now treats those
    // artifacts as optional (tests/unit/seal_feedback_acceptance.test.ts), so what has
    // to stay true here is that the commit path never re-acquires the dependency.
    expect(driver).not.toContain("npm run blind");
    expect(driver).not.toContain("run --silent blind");
    const commit = `${sectionBetween("safe_commit_if_enabled() {", "\n}\n")}\n}`;
    expect(commit).toContain("loop:seal-feedback");
    expect(commit).not.toMatch(/playtest\.(?:md|run\.json|evidence\.jsonl)/u);
  });
});

/**
 * The driver runs the full `health` on every cycle, and the six whole-state-space census
 * proofs inside it are the large majority of that wall clock — so a docs or tooling cycle
 * spent most of its hour re-proving packs it never touched. `npm run ship` had already
 * solved this for landings by reading the bar off the diff; these lock the loop doing the
 * same thing, and — far more importantly — locking WHICH WAY it errs when it cannot tell.
 */
describe("loop.sh graceful stop", () => {
  const stopKnob = `${sectionBetween(
    'STOP_FILE="${AI_LOOP_STOP_FILE:-ai-runs/loop.stop}"',
    "\n}\n\nclear_stop_request",
  )}\n}`;

  const ask = (env: Record<string, string> = {}, setup?: (root: string) => void): string =>
    runGateHarness(
      stopKnob,
      env,
      "if stop_requested; then echo STOP; else echo GO; fi",
      setup,
    ).output.trim();

  it("stops only when the file is actually there", () => {
    expect(ask()).toBe("GO");
    expect(
      ask({}, (root) => {
        mkdirSync(join(root, "ai-runs"), { recursive: true });
        writeFileSync(join(root, "ai-runs", "loop.stop"), "");
      }),
    ).toBe("STOP");
  });

  it("honours an operator-chosen path", () => {
    expect(
      ask({ AI_LOOP_STOP_FILE: "halt-here" }, (root) => {
        // The default path must NOT be what stops it when another was named.
        mkdirSync(join(root, "ai-runs"), { recursive: true });
        writeFileSync(join(root, "ai-runs", "loop.stop"), "");
      }),
    ).toBe("GO");
    expect(
      ask({ AI_LOOP_STOP_FILE: "halt-here" }, (root) => {
        writeFileSync(join(root, "halt-here"), "");
      }),
    ).toBe("STOP");
  });

  it("clears a stale stop file at startup instead of obeying it", () => {
    // A file left by an earlier run would otherwise stop the next launch before it did
    // anything — which reads as a loop that failed to start, the worst failure for a
    // knob whose whole job is to make stopping predictable.
    const startup = loopText.indexOf(
      "\nclear_stop_request\n",
      loopText.indexOf("trap cleanup_pid_records EXIT"),
    );
    const scheduler = loopText.indexOf("while true; do");
    expect(startup).toBeGreaterThanOrEqual(0);
    expect(scheduler).toBeGreaterThan(startup);
  });

  it("asks before a cycle starts and again after it has pushed", () => {
    const scheduler = loopText.slice(loopText.indexOf("while true; do"));
    const before = scheduler.indexOf("stop_requested");
    const runCycle = scheduler.indexOf("if run_cycle; then");
    const after = scheduler.indexOf("stop_requested", runCycle);
    const sleeps = scheduler.indexOf('sleep "$delay"');

    expect(before).toBeGreaterThanOrEqual(0);
    expect(runCycle).toBeGreaterThan(before);
    // The second check is after the cycle returns — i.e. after its push, the last thing
    // run_cycle does — so a landed cycle stops at once instead of racing the delay.
    expect(after).toBeGreaterThan(runCycle);
    expect(sleeps).toBeGreaterThan(after);
    // A stop is a decision about the SCHEDULE: it must never sit inside run_cycle, where
    // it could fail a cycle or alter a gate.
    const cycle = sectionBetween("run_cycle() {", "\n}\n\ncount=0");
    expect(cycle).not.toContain("stop_requested");
  });
});

describe("loop.sh post-change bar selection", () => {
  const selectBar = `${sectionBetween("select_health_bar() {", "\n}\n\nsafe_commit_if_enabled()")}\n}`;

  /** The selector shells out to `npm run loop:bar`; stubbing npm controls its answer. */
  function selectWith(npmStub: string, env: Record<string, string> = {}): string {
    return runGateHarness(
      `${npmStub}\n${selectBar}`,
      env,
      "select_health_bar 1111111111111111111111111111111111111111",
    ).output.trim();
  }

  it("takes the fast bar only when the cycle's diff is out of census reach", () => {
    expect(selectWith("npm() { printf 'fast\\n'; }")).toBe("health:fast");
    expect(selectWith("npm() { printf 'full\\n'; }")).toBe("health");
    // Whitespace and a stray CR must not read as an unrecognised answer and cost the
    // cycle its whole point.
    expect(selectWith("npm() { printf ' fast \\r\\n'; }")).toBe("health:fast");
  });

  it("defaults to the FULL bar whenever the classification is uncertain", () => {
    // Wrong in this direction costs one cycle some wall clock. Wrong in the other lands an
    // engine or content regression that only a nightly census proof would catch, on a
    // branch where that nightly proof may never run.
    expect(selectWith("npm() { return 1; }")).toBe("health");
    expect(selectWith("npm() { printf 'boom\\n' >&2; return 3; }")).toBe("health");
    expect(selectWith("npm() { printf 'maybe\\n'; }")).toBe("health");
    expect(selectWith("npm() { printf ''; }")).toBe("health");
    expect(selectWith("npm() { printf 'fast full\\n'; }")).toBe("health");
  });

  it("lets AI_LOOP_FULL_HEALTH=1 force the full bar over any verdict", () => {
    expect(selectWith("npm() { printf 'fast\\n'; }", { AI_LOOP_FULL_HEALTH: "1" })).toBe("health");
  });

  it("weighs BOTH halves of a cycle's diff", () => {
    // A cycle's change is split across the provisional commit (`<start-ref>..HEAD`) and
    // whatever is still in the tree at gate time (the rotated ledger, at minimum).
    expect(classifyCycleBar(" M AI_LOOP_STATE.md\0", "docs/afk_loop.md\nloop.sh\n")).toBe("fast");
    expect(classifyCycleBar(" M AI_LOOP_STATE.md\0", "src/rpg/runner.ts\n")).toBe("full");
    // An untracked pack the agent authored is part of the change even before it is added.
    expect(classifyCycleBar("?? content/rpg/quests/new.yaml\0", "")).toBe("full");
    // A rename OUT of census reach counts as the delete AND the add, or moving an engine
    // file to scripts/ would read as a plain tooling edit.
    expect(classifyCycleBar("R  scripts/engine.ts\0src/core/engine.ts\0", "")).toBe("full");
    expect(classifyCycleBar("", "")).toBe("fast");
  });

  it("wires the selector into run_cycle ahead of the bar it chooses", () => {
    const runCycle = sectionBetween("run_cycle() {", "\n}\n\ncount=0");
    const chosen = runCycle.indexOf('select_health_bar "$start_ref"');
    const ran = runCycle.indexOf('npm run "$health_script"');
    const integrity = runCycle.indexOf("verify:integrity");

    expect(chosen).toBeGreaterThanOrEqual(0);
    expect(ran).toBeGreaterThan(chosen);
    expect(integrity).toBeGreaterThan(ran);
    // The bar is still blocking: a red one reverts the cycle rather than committing.
    expect(runCycle).toContain('_reject_cycle "health"');
  });
});
