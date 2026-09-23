import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashState } from "../../src/core/hash.js";
import {
  INITIAL_JOURNEY_GOAL,
  JOURNEY_BASELINE_DECISIONS,
  JOURNEY_CONTRACT_VERSION,
} from "../../src/world/journey_contract.js";
// vitest can import .mjs fine:
// @ts-expect-error — plain .mjs module without type declarations
import { fillPrompt } from "../../blind-tester/fill-prompt.mjs";
import {
  acquireFleetReportLock,
  archiveFailedFleetAttemptArtifacts,
  assertSparkMassAdmissionConfigured,
  classifyFleetAttempt,
  CODEX_CLIENT_AUTHORITY_PROOF_NAME,
  codexFleetMemberEnv,
  createPureFleetBuildFingerprint,
  createSparkAdmissionReceipt,
  createFleetLaunchControl,
  createFleetTransportFingerprint,
  executeRun,
  FLEET_USAGE,
  fleetTransportProfile,
  fleetAttestationPathFor,
  fleetReportLockSpec,
  fleetSummaryExitSucceeded,
  isTrustedFleetArtifactFile,
  normalizeShellHomeForNode,
  normalizeShellPathForNode,
  parseFleetArgs,
  planFleetRuns,
  pureFleetReportWasRecovered,
  pureFleetArtifactHashes,
  PURE_BASELINE_DECISIONS,
  PURE_FLEET_ATTESTATION_SCHEMA_VERSION,
  PURE_FLEET_EVIDENCE_SCHEMA_VERSION,
  PURE_FLEET_SUMMARY_SCHEMA_VERSION,
  PURE_SESSION_CONTRACT_VERSION,
  pureFleetSummaryAccounting,
  releaseFleetReportLock,
  requireSparkMassAdmissionReceipt,
  renderClosedFleetManifest,
  reportPathFor,
  resumeCandidatesFor,
  runPool,
  runSidecarPathFor,
  strictRejectionFleetDiagnostic,
  shouldRetryFleetAttempt,
  sparkAdmissionReceiptMismatch,
  sparkMassAdmissionRequired,
  SPARK_ADMISSION_RECEIPT_SCHEMA_VERSION,
  summarizeFleetAttemptHistory,
  usageRecordFromFailedFleetAttemptArchive,
  validateFleetLabel,
  validateAdmissionReportsSeparation,
  validateFleetReportsDirectory,
  verifyReportForResume,
  writePrivateCodexClientAuthorityProof,
  writeFreshPureFleetAttestation,
  // @ts-expect-error — plain .mjs module without type declarations
} from "../../blind-tester/fleet.mjs";
// @ts-expect-error — runner helper is intentionally plain ESM.
import { writeStrictRejectionDiagnostic } from "../../blind-tester/codex-strict-stream.mjs";
import {
  codexClientAuthorityRecord,
  resolveCodexClientBinary,
  // @ts-expect-error — plain .mjs module without type declarations
} from "../../blind-tester/codex-rollout.mjs";
import { useCleanTrackedGitCheckout } from "../regression/support/clean_git_checkout.js";

const cleanGit = useCleanTrackedGitCheckout();

function sparkAdmissionAuthorityFixture() {
  const resolved = resolveCodexClientBinary(process.execPath);
  return {
    build: {
      git_commit: "a".repeat(40),
      tracked_worktree_clean: true as const,
      world_hash: "b".repeat(64),
      world_id: "new_york_overworld",
    },
    client: codexClientAuthorityRecord(resolved.identity_token, "0.146.0"),
    transportFingerprint: "c".repeat(64),
  };
}

it("keeps the fleet resume contract pinned to the engine journey contract", () => {
  expect(PURE_SESSION_CONTRACT_VERSION).toBe(JOURNEY_CONTRACT_VERSION);
  expect(PURE_BASELINE_DECISIONS).toBe(JOURNEY_BASELINE_DECISIONS);
});

it("fails current live fleets on incomplete usage without changing legacy success", () => {
  const closedSlots = {
    count: 1,
    verified: 1,
    "skipped-resume": 0,
    failed_attempts: 0,
  };
  expect(fleetSummaryExitSucceeded(closedSlots)).toBe(true);
  expect(
    fleetSummaryExitSucceeded({
      ...closedSlots,
      schema_version: PURE_FLEET_SUMMARY_SCHEMA_VERSION - 1,
      usage: { complete: false, unrecoverable_attempt_count: 1 },
    }),
  ).toBe(true);
  expect(
    fleetSummaryExitSucceeded({
      ...closedSlots,
      schema_version: PURE_FLEET_SUMMARY_SCHEMA_VERSION,
      usage: { complete: true, unrecoverable_attempt_count: 0 },
    }),
  ).toBe(true);
  expect(
    fleetSummaryExitSucceeded({
      ...closedSlots,
      schema_version: PURE_FLEET_SUMMARY_SCHEMA_VERSION,
      usage: { complete: false, unrecoverable_attempt_count: 0 },
    }),
  ).toBe(false);
  expect(
    fleetSummaryExitSucceeded({
      ...closedSlots,
      schema_version: PURE_FLEET_SUMMARY_SCHEMA_VERSION,
      usage: { complete: true, unrecoverable_attempt_count: 1 },
    }),
  ).toBe(false);
});

it("freezes one shared Codex authority and version into every live member environment", () => {
  const resolved = resolveCodexClientBinary(process.execPath);
  const client = codexClientAuthorityRecord(resolved.identity_token, "1.2.3");
  const environment = codexFleetMemberEnv(
    {
      KEEP: "yes",
      BLIND_CODEX_BIN: "substitute",
      BLIND_CODEX_EXPECTED_AUTHORITY: "substitute",
      BLIND_CODEX_EXPECTED_VERSION: "9.9.9",
    },
    client,
  );
  expect(environment).toMatchObject({
    KEEP: "yes",
    BLIND_CODEX_BIN: client.selected_binary,
    BLIND_CODEX_EXPECTED_AUTHORITY: client.authority_token,
    BLIND_CODEX_EXPECTED_VERSION: "1.2.3",
  });
  expect(() => codexFleetMemberEnv({}, { ...client, authority_sha256: "0".repeat(64) })).toThrow(
    /exact Codex client authority/i,
  );

  const testRoot = mkdtempSync(join(tmpdir(), "af-fleet-test-script-client-"));
  try {
    const testScript = join(testRoot, "selected-codex");
    writeFileSync(testScript, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(testScript, 0o755);
    const testResolved = resolveCodexClientBinary(testScript, { allowTestScript: true });
    const testClient = codexClientAuthorityRecord(testResolved.identity_token, "1.2.3");
    expect(testClient.test_script).toBe(true);
    expect(() => codexFleetMemberEnv({}, testClient)).toThrow(/exact Codex client authority/i);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

it("normalizes Git Bash, Cygwin, and WSL drive paths for Windows Node", () => {
  expect(normalizeShellPathForNode("/c/Users/player/.codex", "win32")).toBe(
    "C:/Users/player/.codex",
  );
  expect(normalizeShellPathForNode("/cygdrive/d/home/player/.codex", "win32")).toBe(
    "D:/home/player/.codex",
  );
  expect(normalizeShellPathForNode("/mnt/e/home/player/.codex", "win32")).toBe(
    "E:/home/player/.codex",
  );
  expect(normalizeShellPathForNode("/mnt/e/home/player/.codex", "linux")).toBe(
    "/mnt/e/home/player/.codex",
  );
  expect(
    normalizeShellHomeForNode("/home/player", "win32", (path: string) =>
      path === "/home/player" ? "D:/cygwin64/home/player" : "",
    ),
  ).toBe("D:/cygwin64/home/player");
});

it("rejects direct and linked fleet report roots inside CODEX_HOME before writing", () => {
  const root = mkdtempSync(join(tmpdir(), "af-fleet-codex-output-boundary-"));
  const home = join(root, "codex-home");
  const linkedHome = join(root, "linked-codex-home");
  const loginFilename = ["auth", ".json"].join("");
  const loginPath = join(home, loginFilename);
  const loginBytes = '{"sentinel":"fleet-output-guard"}\n';
  mkdirSync(home);
  writeFileSync(loginPath, loginBytes);
  const candidates = [home];
  const windowsHomeForms = [home];
  if (process.platform === "win32") {
    const match = home.replaceAll("\\", "/").match(/^([A-Za-z]):\/(.*)$/u);
    if (match) {
      const drive = match[1]!;
      const remainder = match[2]!;
      windowsHomeForms.push(`/${drive.toLowerCase()}/${remainder}`);
      windowsHomeForms.push(`/mnt/${drive.toLowerCase()}/${remainder}`);
    }
  }
  try {
    try {
      symlinkSync(home, linkedHome, "junction");
      candidates.push(linkedHome);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EACCES" && code !== "ENOSYS") throw error;
    }

    for (const [index, reportsDir] of candidates.entries()) {
      expect(() => validateFleetReportsDirectory(reportsDir, home), reportsDir).toThrow(
        /outside the Codex home/i,
      );
      const homeForms = index === 0 ? windowsHomeForms : [home];
      for (const [homeIndex, configuredHome] of homeForms.entries()) {
        const label = `codex-output-guard-${process.pid}-${Date.now()}-${index}-${homeIndex}`;
        const fleetDir = join(process.cwd(), "ai-runs", "fleet", label);
        const result = spawnSync(
          process.execPath,
          [
            "blind-tester/fleet.mjs",
            "--mock",
            "--count",
            "1",
            "--out",
            reportsDir,
            "--label",
            label,
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: { ...process.env, CODEX_HOME: configuredHome },
            timeout: 30_000,
          },
        );
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
        expect(result.status, `${configuredHome} -> ${reportsDir}: ${output}`).toBe(1);
        expect(output).toContain("must remain outside the Codex home");
        expect(existsSync(fleetDir), reportsDir).toBe(false);
        expect(readdirSync(home), reportsDir).toEqual([loginFilename]);
        expect(readFileSync(loginPath, "utf8"), reportsDir).toBe(loginBytes);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("uses a normalized custom HOME for the default fleet Codex-home boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "af-fleet-custom-shell-home-"));
  const customHome = join(root, "custom-home");
  const codexHome = join(customHome, ".codex");
  const loginFilename = ["auth", ".json"].join("");
  const loginPath = join(codexHome, loginFilename);
  const loginBytes = '{"sentinel":"custom-shell-home-guard"}\n';
  const label = `custom-shell-home-${process.pid}-${Date.now()}`;
  const fleetDir = join(process.cwd(), "ai-runs", "fleet", label);
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(loginPath, loginBytes);
  let shellHome = customHome;
  if (process.platform === "win32") {
    const match = customHome.replaceAll("\\", "/").match(/^([A-Za-z]):\/(.*)$/u);
    if (match) shellHome = `/${match[1]!.toLowerCase()}/${match[2]!}`;
  }
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: shellHome };
  delete env.CODEX_HOME;
  try {
    const result = spawnSync(
      process.execPath,
      ["blind-tester/fleet.mjs", "--mock", "--count", "1", "--out", codexHome, "--label", label],
      { cwd: process.cwd(), encoding: "utf8", env, timeout: 30_000 },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
    expect(result.status, output).toBe(1);
    expect(output).toContain("must remain outside the Codex home");
    expect(existsSync(fleetDir)).toBe(false);
    expect(readdirSync(codexHome)).toEqual([loginFilename]);
    expect(readFileSync(loginPath, "utf8")).toBe(loginBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps structural mock fleets independent from an absent configured Codex home", () => {
  const root = mkdtempSync(join(tmpdir(), "af-fleet-missing-codex-home-"));
  const missingHome = join(root, "not-created-codex-home");
  const reportsDir = join(root, "reports");
  const label = `missing-codex-home-${process.pid}-${Date.now()}`;
  const fleetDir = join(process.cwd(), "ai-runs", "fleet", label);
  try {
    const result = spawnSync(
      process.execPath,
      [
        "blind-tester/fleet.mjs",
        "--mock",
        "--count",
        "1",
        "--max-retries",
        "0",
        "--out",
        reportsDir,
        "--label",
        label,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: missingHome },
        timeout: 60_000,
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
    expect(result.status, output).toBe(0);
    expect(existsSync(missingHome)).toBe(false);
    expect(readdirSync(reportsDir).some((name) => name.endsWith(".md"))).toBe(true);
    const structuralSummary = JSON.parse(readFileSync(join(fleetDir, "summary.json"), "utf8"));
    expect(structuralSummary).not.toHaveProperty("schema_version");
    expect(structuralSummary).not.toHaveProperty("usage");
    expect(structuralSummary).not.toHaveProperty("codex_client");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fleetDir, { recursive: true, force: true });
  }
}, 90_000);

it("runs one fleet-wide executable preflight before directories and never retries failure", () => {
  const root = mkdtempSync(join(tmpdir(), "af-fleet-codex-preflight-"));
  const home = join(root, "codex-home");
  const reportsDir = join(root, "reports");
  const selected = join(root, "selected-codex");
  const capture = join(root, "version-probes.txt");
  const loginFilename = ["auth", ".json"].join("");
  const loginPath = join(home, loginFilename);
  const loginBytes = '{"sentinel":"fleet-preflight-auth"}\n';
  const label = `codex-preflight-${process.pid}-${Date.now()}`;
  const fleetDir = join(cleanGit.path, "ai-runs", "fleet", label);
  const bashPath = (path: string): string =>
    path
      .replace(/^([A-Za-z]):\\/u, (_match, drive: string) => `/${drive.toLowerCase()}/`)
      .replaceAll("\\", "/");
  try {
    mkdirSync(home);
    writeFileSync(loginPath, loginBytes);
    writeFileSync(
      selected,
      `#!/usr/bin/env bash
printf 'probe\\n' >> "\${PROBE_CAPTURE}"
printf 'not-codex 0.144.1\\n'
`,
    );
    chmodSync(selected, 0o755);

    const result = spawnSync(
      process.execPath,
      [
        "blind-tester/fleet.mjs",
        "--count",
        "2",
        "--concurrency",
        "2",
        "--max-retries",
        "3",
        "--out",
        reportsDir,
        "--label",
        label,
      ],
      {
        cwd: cleanGit.path,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: home,
          BLIND_CODEX_BIN: bashPath(selected),
          BLIND_CODEX_TEST_SCRIPT_CLIENT: "1",
          BLIND_PROVIDER: "claude",
          BLIND_MODEL: "ambient-alias",
          BLIND_PERSONA: "breaker",
          PROBE_CAPTURE: bashPath(capture),
        },
        timeout: 30_000,
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
    expect(result.status, output).toBe(1);
    expect(output).toContain("before report directories, locks, or player launches");
    expect(output).toContain("no fleet retry was attempted");
    expect(output).toMatch(/exactly one.*codex-cli <semver>/is);
    expect(output).not.toContain("live Claude blind provider is retired");
    expect(output).not.toContain("models_cache");
    expect(readFileSync(capture, "utf8")).toBe("probe\n");
    expect(existsSync(reportsDir)).toBe(false);
    expect(existsSync(fleetDir)).toBe(false);
    expect(readFileSync(loginPath, "utf8")).toBe(loginBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fleetDir, { recursive: true, force: true });
  }
}, 30_000);

it("does not classify a structural mock exit 42 as Codex preflight drift", () => {
  const root = mkdtempSync(join(tmpdir(), "af-fleet-mock-exit-42-"));
  const reportsDir = join(root, "reports");
  const missingHome = join(root, "missing-codex-home");
  const label = `mock-exit-42-${process.pid}-${Date.now()}`;
  const fleetDir = join(process.cwd(), "ai-runs", "fleet", label);
  try {
    const result = spawnSync(
      process.execPath,
      [
        "blind-tester/fleet.mjs",
        "--mock",
        "--count",
        "1",
        "--max-retries",
        "0",
        "--out",
        reportsDir,
        "--label",
        label,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: missingHome,
          BLIND_MOCK_AGENT_CMD: "exit 42",
        },
        timeout: 30_000,
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
    expect(result.status, output).toBe(1);
    expect(output).not.toContain("Codex client preflight changed");
    const manifest = readFileSync(join(fleetDir, "manifest.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      exit: 42,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fleetDir, { recursive: true, force: true });
  }
}, 30_000);

it("drains active fleet lanes before propagating a nonretryable failure", async () => {
  let releaseSibling = (): void => undefined;
  const siblingGate = new Promise<void>((resolve) => {
    releaseSibling = resolve;
  });
  let siblingStarted = false;
  let siblingClosed = false;
  const failure = new Error("nonretryable client preflight");

  const pool = runPool([0, 1], 2, async (item: number) => {
    if (item === 0) throw failure;
    siblingStarted = true;
    await siblingGate;
    siblingClosed = true;
  });
  let poolRejected = false;
  const observedPool = pool.catch((error: unknown) => {
    poolRejected = true;
    throw error;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(siblingStarted).toBe(true);
  expect(poolRejected).toBe(false);

  releaseSibling();
  await expect(observedPool).rejects.toBe(failure);
  expect(siblingClosed).toBe(true);
  expect(poolRejected).toBe(true);
});

describe("fill-prompt", () => {
  const template = "Intro.\n{{PERSONA}}\nRules __SEED__.\nGo: {{START_INSTRUCTION}}\n";
  it("substitutes all three placeholders", () => {
    const out = fillPrompt(template, {
      startInstruction: "start overworld",
      seed: 42,
      persona: "You are the BREAKER.",
    });
    expect(out).toContain("You are the BREAKER.");
    expect(out).toContain("Rules 42.");
    expect(out).toContain("Go: start overworld");
    expect(out).not.toMatch(/\{\{|__SEED__/);
  });
  it("empty persona leaves zero residue — byte-compatible with the pre-persona prompt", () => {
    const out = fillPrompt(template, { startInstruction: "x", seed: 1, persona: "" });
    expect(out).toBe("Intro.\nRules 1.\nGo: x\n");
  });
  it("injects exactly one required transport fragment without leaving a template slot", () => {
    const transportTemplate = "Intro.\n{{PERSONA}}\n{{TRANSPORT_INSTRUCTIONS}}\nGo.\n";
    const out = fillPrompt(transportTemplate, {
      startInstruction: "unused",
      seed: 1,
      persona: "",
      transport: "- Call only the game.",
    });
    expect(out).toBe("Intro.\n- Call only the game.\nGo.\n");
    expect(() =>
      fillPrompt(transportTemplate, {
        startInstruction: "unused",
        seed: 1,
        persona: "",
      }),
    ).toThrow(/transport instructions are required/);
    expect(() =>
      fillPrompt(template, {
        startInstruction: "x",
        seed: 1,
        persona: "",
        transport: "unexpected",
      }),
    ).toThrow(/without a slot/);
  });
  it("real prompts contain exactly one persona slot each", () => {
    for (const p of ["blind-tester/prompt.md", "blind-tester/prompt-overworld.md"])
      expect(readFileSync(p, "utf8").match(/\{\{PERSONA\}\}/g)).toHaveLength(1);
  });
  it("the overworld prompt has one transport slot and both transport fragments are concrete", () => {
    const overworld = readFileSync("blind-tester/prompt-overworld.md", "utf8");
    expect(overworld.match(/\{\{TRANSPORT_INSTRUCTIONS\}\}/g)).toHaveLength(1);
    for (const p of [
      "blind-tester/prompt-transports/strict-code-mode-v2.md",
      "blind-tester/prompt-transports/spark-direct-mcp-v1.md",
      "blind-tester/prompt-transports/game-direct-mcp-v1.md",
    ]) {
      const fragment = readFileSync(p, "utf8");
      expect(fragment.trim().length).toBeGreaterThan(0);
      expect(fragment).not.toMatch(/\{\{/);
    }
  });
});

describe("fleet planning", () => {
  it("prints help and exits before any fleet side effect", () => {
    for (const helpFlag of ["--help", "-h"]) {
      const root = mkdtempSync(join(tmpdir(), "af-fleet-help-"));
      const reportsDir = join(root, "reports-that-must-not-exist");
      const label = `help-${helpFlag === "--help" ? "long" : "short"}-${Date.now()}`;
      try {
        const result = spawnSync(
          process.execPath,
          [
            "blind-tester/fleet.mjs",
            helpFlag,
            "--label",
            label,
            "--out",
            reportsDir,
            "--count",
            "100",
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            timeout: 5_000,
            env: {
              ...process.env,
              BLIND_CODEX_BIN: join(root, "client-that-must-not-run"),
            },
          },
        );

        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toBe(`${FLEET_USAGE}\n`);
        expect(existsSync(reportsDir)).toBe(false);
        expect(existsSync(join(process.cwd(), "ai-runs", "fleet", label))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects mass Spark without a receipt before preflight or filesystem side effects", () => {
    const root = mkdtempSync(join(tmpdir(), "af-fleet-admission-required-"));
    const reportsDir = join(root, "reports-that-must-not-exist");
    const label = `admission-required-${Date.now()}`;
    try {
      const result = spawnSync(
        process.execPath,
        ["blind-tester/fleet.mjs", "--count", "4", "--label", label, "--out", reportsDir],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 5_000,
          env: {
            ...process.env,
            BLIND_CODEX_BIN: join(root, "client-that-must-not-run"),
          },
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/requires --admission-receipt/i);
      expect(existsSync(reportsDir)).toBe(false);
      expect(existsSync(join(process.cwd(), "ai-runs", "fleet", label))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["--unknown", "positional", "--count=1"])(
    "rejects unknown argument %j before planning",
    (argument) => {
      expect(() => parseFleetArgs([argument])).toThrow(
        `fleet: unknown argument ${JSON.stringify(argument)}; run with --help`,
      );
    },
  );

  it.each([
    "--count",
    "--concurrency",
    "--model",
    "--provider",
    "--personas",
    "--target",
    "--seed-base",
    "--label",
    "--max-retries",
    "--out",
    "--allow-duplicate-cohort",
  ])("rejects missing values for %s before planning", (flag) => {
    expect(() => parseFleetArgs([flag])).toThrow(`fleet: ${flag} requires a value`);
    expect(() => parseFleetArgs([flag, "--mock"])).toThrow(`fleet: ${flag} requires a value`);
  });

  it("defaults milestone fleets to exactly 100 homogeneous-Spark fresh-overworld runs", () => {
    const opts = parseFleetArgs([]);
    expect(opts.count).toBe(100);
    expect(opts.target).toBe("overworld");
    expect(opts.personas).toBe("default");
    expect(opts.provider).toBe("codex");
    expect(opts.model).toBe("gpt-5.3-codex-spark");
    expect(opts.resume).toBe(true);
    const runs = planFleetRuns(opts);
    expect(runs).toHaveLength(100);
    expect(
      runs.every(
        (run: { provider: string; model: string }) =>
          run.provider === "codex" && run.model === "gpt-5.3-codex-spark",
      ),
    ).toBe(true);
  });

  it("keeps parser-bypassing programmatic plans on the Codex default", () => {
    const programmatic = { ...parseFleetArgs(["--count", "1"]), provider: undefined };

    expect(planFleetRuns(programmatic)).toEqual([
      {
        seed: 1000,
        persona: "default",
        provider: "codex",
        model: "gpt-5.3-codex-spark",
        target: "overworld",
      },
    ]);
  });

  it("makes authoritative no-resume behavior explicit without changing diagnostic defaults", () => {
    expect(parseFleetArgs([]).resume).toBe(true);
    expect(parseFleetArgs(["--no-resume"]).resume).toBe(false);
  });

  it("constrains the Spark admission canary to one isolated fresh pure cohort", () => {
    const opts = parseFleetArgs([
      "--admission-canary",
      "--label",
      "spark-admission-1",
      "--out",
      "ai-runs/admission/spark-admission-1/reports",
    ]);
    expect(opts).toMatchObject({
      admissionCanary: true,
      count: 3,
      concurrency: 1,
      model: "gpt-5.3-codex-spark",
      target: "overworld",
      personas: "default",
      resume: false,
      maxRetries: 0,
    });
    for (const args of [
      ["--admission-canary", "--label", "a", "--out", "b", "--count", "4"],
      ["--admission-canary", "--label", "a", "--out", "b", "--concurrency", "2"],
      ["--admission-canary", "--label", "a", "--out", "b", "--max-retries", "1"],
      ["--admission-canary", "--label", "a", "--out", "b", "--model", "gpt-5.6-terra"],
      ["--admission-canary", "--label", "a", "--out", "b", "--mock"],
      ["--admission-canary", "--label", "a"],
    ]) {
      expect(() => parseFleetArgs(args)).toThrow(/admission-canary/i);
    }
  });

  it("rejects an admission report directory that overlaps its fleet bundle", () => {
    const fleetDir = join(process.cwd(), "ai-runs", "fleet", "spark-admission-1");
    expect(() => validateAdmissionReportsSeparation(fleetDir, fleetDir)).toThrow(
      /outside its ai-runs\/fleet\/<label> bundle/i,
    );
    expect(() => validateAdmissionReportsSeparation(join(fleetDir, "reports"), fleetDir)).toThrow(
      /outside its ai-runs\/fleet\/<label> bundle/i,
    );
    expect(() => validateAdmissionReportsSeparation(join(fleetDir, ".."), fleetDir)).toThrow(
      /outside its ai-runs\/fleet\/<label> bundle/i,
    );
    expect(
      validateAdmissionReportsSeparation(
        join(process.cwd(), "ai-runs", "admission-reports", "spark-admission-1"),
        fleetDir,
      ),
    ).toMatch(/admission-reports/u);
  });

  it("requires one explicit admission receipt only at the mass Spark launch boundary", () => {
    const massSpark = parseFleetArgs(["--count", "4"]);
    expect(sparkMassAdmissionRequired(massSpark)).toBe(true);
    expect(() => assertSparkMassAdmissionConfigured(massSpark)).toThrow(
      /requires --admission-receipt/i,
    );

    const receiptPath = "ai-runs/fleet/spark-admission/admission.json";
    const admitted = parseFleetArgs(["--count", "4", "--admission-receipt", receiptPath]);
    expect(assertSparkMassAdmissionConfigured(admitted).admissionReceipt).toBe(receiptPath);
    expect(sparkMassAdmissionRequired(parseFleetArgs(["--count", "3"]))).toBe(false);
    expect(sparkMassAdmissionRequired(parseFleetArgs(["--model", "gpt-5.6-terra"]))).toBe(false);
    expect(sparkMassAdmissionRequired(parseFleetArgs(["--mock"]))).toBe(false);

    for (const args of [
      ["--count", "3", "--admission-receipt", receiptPath],
      ["--mock", "--admission-receipt", receiptPath],
      ["--model", "gpt-5.6-terra", "--admission-receipt", receiptPath],
      [
        "--admission-canary",
        "--label",
        "new-canary",
        "--out",
        "ai-runs/admission/new-canary",
        "--admission-receipt",
        receiptPath,
      ],
    ]) {
      expect(() => parseFleetArgs(args)).toThrow(/admission-receipt/i);
    }
  });

  it("builds and validates a passed admission receipt against every launch authority", () => {
    const authority = sparkAdmissionAuthorityFixture();
    const receipt = createSparkAdmissionReceipt({
      counts: { verified: 3, "skipped-resume": 0, failed: 0, suppressed: 0 },
      ...authority,
    });
    expect(receipt).toMatchObject({
      schema_version: SPARK_ADMISSION_RECEIPT_SCHEMA_VERSION,
      purpose: "spark_admission_canary",
      certification_eligible: false,
      passed: true,
      required_verified: 3,
      verified: 3,
      skipped_resume: 0,
      failed: 0,
      suppressed: 0,
      model: "gpt-5.3-codex-spark",
      build: authority.build,
      build_fingerprint: createPureFleetBuildFingerprint(authority.build),
      transport_fingerprint: authority.transportFingerprint,
      codex_cli_version: authority.client.cli_version,
      codex_client_authority_sha256: authority.client.authority_sha256,
      strict_stream_rejection_fingerprints: [],
    });
    expect(
      sparkAdmissionReceiptMismatch(receipt, {
        ...authority,
        model: "gpt-5.3-codex-spark",
      }),
    ).toBeNull();

    const failed = createSparkAdmissionReceipt({
      counts: { verified: 1, "skipped-resume": 0, failed: 1, suppressed: 1 },
      ...authority,
      strictRejectedTransportFingerprints: [authority.transportFingerprint],
    });
    expect(failed.passed).toBe(false);
    expect(
      sparkAdmissionReceiptMismatch(failed, {
        ...authority,
        model: "gpt-5.3-codex-spark",
      }),
    ).toMatch(/did not pass/i);
  });

  it.each([
    [
      "build identity",
      (receipt: Record<string, unknown>) => {
        receipt.build = {
          ...(receipt.build as Record<string, unknown>),
          git_commit: "d".repeat(40),
        };
        receipt.build_fingerprint = createPureFleetBuildFingerprint(
          receipt.build as Parameters<typeof createPureFleetBuildFingerprint>[0],
        );
      },
      /build does not match/i,
    ],
    [
      "build fingerprint",
      (receipt: Record<string, unknown>) => (receipt.build_fingerprint = "d".repeat(64)),
      /build fingerprint/i,
    ],
    [
      "tracked clean state",
      (receipt: Record<string, unknown>) => {
        receipt.build = {
          ...(receipt.build as Record<string, unknown>),
          tracked_worktree_clean: false,
        };
      },
      /invalid or dirty/i,
    ],
    [
      "transport fingerprint",
      (receipt: Record<string, unknown>) => (receipt.transport_fingerprint = "d".repeat(64)),
      /transport fingerprint/i,
    ],
    [
      "client version",
      (receipt: Record<string, unknown>) => (receipt.codex_cli_version = "0.147.0"),
      /client authority or version/i,
    ],
    [
      "client authority",
      (receipt: Record<string, unknown>) =>
        (receipt.codex_client_authority_sha256 = "d".repeat(64)),
      /client authority or version/i,
    ],
    [
      "model",
      (receipt: Record<string, unknown>) => (receipt.model = "gpt-5.6-terra"),
      /model does not match/i,
    ],
    [
      "configuration",
      (receipt: Record<string, unknown>) => {
        receipt.configuration = {
          ...(receipt.configuration as Record<string, unknown>),
          concurrency: 2,
        };
      },
      /configuration/i,
    ],
    [
      "unexpected field",
      (receipt: Record<string, unknown>) => (receipt.untrusted = true),
      /unexpected or missing fields/i,
    ],
  ])("rejects admission receipt drift in %s", (_label, mutate, reason) => {
    const authority = sparkAdmissionAuthorityFixture();
    const receipt = createSparkAdmissionReceipt({
      counts: { verified: 3, "skipped-resume": 0, failed: 0, suppressed: 0 },
      ...authority,
    }) as Record<string, unknown>;
    mutate(receipt);
    expect(
      sparkAdmissionReceiptMismatch(receipt, {
        ...authority,
        model: "gpt-5.3-codex-spark",
      }),
    ).toMatch(reason);
  });

  it("reads only one stable exact admission receipt before authorizing mass Spark", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-spark-admission-"));
    const path = join(dir, "admission.json");
    const authority = sparkAdmissionAuthorityFixture();
    const receipt = createSparkAdmissionReceipt({
      counts: { verified: 3, "skipped-resume": 0, failed: 0, suppressed: 0 },
      ...authority,
    });
    try {
      const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
      writeFileSync(path, bytes);
      expect(
        requireSparkMassAdmissionReceipt({
          receiptPath: path,
          ...authority,
          model: "gpt-5.3-codex-spark",
        }),
      ).toEqual({
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        build_fingerprint: receipt.build_fingerprint,
        transport_fingerprint: authority.transportFingerprint,
      });

      writeFileSync(path, '{"schema_version":2,"schema_version":2}\n');
      expect(() =>
        requireSparkMassAdmissionReceipt({
          receiptPath: path,
          ...authority,
          model: "gpt-5.3-codex-spark",
        }),
      ).toThrow(/duplicate JSON object key/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a named persona as given", () => {
    // Every session record carries its persona id and the persona file's content hash;
    // run.sh is what refuses a name with no file behind it.
    expect(parseFleetArgs(["--personas", "breaker"]).personas).toBe("breaker");
    expect(parseFleetArgs(["--personas", "cynical_veteran"]).personas).toBe("cynical_veteran");
  });
  it("refuses an unregistered provider id and names the real ones", () => {
    // "claude" is a near-miss for the registered `claude_code`. A near-miss must be
    // refused outright rather than resolved to whichever entry looks closest, and the
    // message has to name the actual ids so the operator can fix it in one step.
    expect(() => parseFleetArgs(["--provider", "claude"])).toThrow(/is not registered/i);
    expect(() => parseFleetArgs(["--provider", "claude"])).toThrow(/claude_code/);
    expect(() =>
      planFleetRuns({ ...parseFleetArgs(["--count", "1"]), provider: "claude" }),
    ).toThrow(/claude/i);
    expect(parseFleetArgs(["--mock", "--model", "synthetic"]).model).toBe("synthetic");
  });

  it("refuses to launch a provider the fleet cannot own the process of", () => {
    // The desktop provider is intentionally distinct from the headless grok_cli lane. It
    // points at the ingest path instead of pretending the generic fleet launched it.
    expect(() => parseFleetArgs(["--provider", "grok_desktop"])).toThrow(/desktop_client/);
    expect(() => parseFleetArgs(["--provider", "grok_desktop"])).toThrow(/playtest:ingest/);
  });

  it("accepts any registered headless provider, not one privileged vendor", () => {
    expect(parseFleetArgs(["--provider", "gemini_cli"]).provider).toBe("gemini_cli");
    expect(parseFleetArgs(["--provider", "claude_code"]).provider).toBe("claude_code");
    // Each defaults to its own catalog's marked default (volume tier when none
    // is marked) — the fleet's job is throughput.
    expect(parseFleetArgs(["--provider", "gemini_cli"]).model).toBe("gemini-3.5-flash");
  });
  it("pins Codex fleets to exact provider/model pairs without mix, aliases, or fallback", () => {
    for (const model of [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.3-codex-spark",
    ] as const) {
      const opts = parseFleetArgs(["--provider", "codex", "--model", model, "--count", "2"]);
      expect(planFleetRuns(opts)).toEqual([
        { seed: 1000, persona: "default", provider: "codex", model, target: "overworld" },
        { seed: 1001, persona: "default", provider: "codex", model, target: "overworld" },
      ]);
    }
    expect(parseFleetArgs([]).model).toBe("gpt-5.3-codex-spark");
    // An alias is refused because it resolves to different weights over time, so a
    // session recorded under one stops meaning what its record says it means.
    expect(() => parseFleetArgs(["--provider", "codex", "--model", "sol"])).toThrow(
      /not in the codex catalog/i,
    );
    expect(() => parseFleetArgs(["--provider", "codex", "--model", "mix"])).toThrow(/mix/i);
  });
  it("explicit mock quest targets parse and reach the structural plan", () => {
    const runs = planFleetRuns(
      parseFleetArgs(["--mock", "--count", "2", "--target", "quest:sunken_barrow"]),
    );
    expect(runs.every((r: { target: string }) => r.target === "quest:sunken_barrow")).toBe(true);
    expect(runs.every((r: { provider: string }) => r.provider === "codex")).toBe(true);
  });

  it("rejects quest targets for live fleets regardless of flag order", () => {
    expect(() => parseFleetArgs(["--target", "quest:sunken_barrow"])).toThrow(
      /live blind LLM runs must target overworld/i,
    );
    expect(() => parseFleetArgs(["--target", "quest:sunken_barrow", "--count", "2"])).toThrow(
      /quest targets require explicit --mock/i,
    );
    expect(parseFleetArgs(["--target", "quest:sunken_barrow", "--mock"]).target).toBe(
      "quest:sunken_barrow",
    );

    const bypassedParser = parseFleetArgs([]);
    bypassedParser.target = "quest:sunken_barrow";
    expect(() => planFleetRuns(bypassedParser)).toThrow(
      /live blind LLM runs must target overworld/i,
    );
  });

  it("rejects malformed targets even for structural mock fleets", () => {
    expect(() => parseFleetArgs(["--mock", "--target", "sunken_barrow"])).toThrow(
      /overworld or quest:<id>/i,
    );
    expect(() => parseFleetArgs(["--mock", "--target", "quest:"])).toThrow(
      /overworld or quest:<id>/i,
    );
    expect(() => parseFleetArgs(["--mock", "--target", "quest:two words"])).toThrow(
      /overworld or quest:<id>/i,
    );
    for (const target of [
      "quest:../wolf_winter",
      "quest:wolf/winter",
      "quest:wolf\\winter",
      "quest:Wolf_Winter",
      "quest:wolf-winter",
      "quest:_wolf_winter",
      "quest:wolf__winter",
      "quest:wolf\nwinter",
    ]) {
      expect(() => parseFleetArgs(["--mock", "--target", target]), target).toThrow(
        /lowercase shipped quest id/i,
      );
    }
  });

  it("report filenames match the ledger regex", () => {
    const p = reportPathFor("blind-tester/reports", "20260709T010203Z", "overworld", 12);
    expect(p.replace(/\\/g, "/").split("/").pop()).toMatch(/^\d{8}T\d{6}Z_.+_seed-?\d+\.md$/);
  });
});

it("rejects symlinked or out-of-directory resume candidates", async () => {
  const reportsDir = mkdtempSync(join(tmpdir(), "af-fleet-symlink-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "af-fleet-outside-"));
  try {
    const target = join(reportsDir, "real-report.md");
    const alias = join(reportsDir, "20270101T000000Z_overworld_seed5.md");
    writeFileSync(target, "not parsed because trust checks run first\n");
    writeFileSync(runSidecarPathFor(alias), "{}\n");
    const outside = join(outsideDir, "outside.md");
    writeFileSync(outside, "ordinary but outside the reports root\n");
    expect(isTrustedFleetArtifactFile(outside, reportsDir)).toBe(false);
    try {
      symlinkSync(target, alias, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
        return;
      }
      throw error;
    }
    expect(isTrustedFleetArtifactFile(alias, reportsDir)).toBe(false);
    const rejected = await verifyReportForResume(alias, "structural", null, reportsDir);
    expect(rejected.ok).toBe(false);
    expect(rejected.stderr).toMatch(/regular non-symlink/i);
  } finally {
    rmSync(reportsDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

it("rejects hardlinked resume artifacts that certification cannot accept", async () => {
  const reportsDir = mkdtempSync(join(tmpdir(), "af-fleet-hardlink-"));
  try {
    const target = join(reportsDir, "real-report.md");
    const alias = join(reportsDir, "20270101T000000Z_overworld_seed5.md");
    writeFileSync(target, "not parsed because trust checks run first\n");
    try {
      linkSync(target, alias);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return;
      throw error;
    }
    writeFileSync(runSidecarPathFor(alias), "{}\n");
    expect(isTrustedFleetArtifactFile(alias, reportsDir)).toBe(false);
    const rejected = await verifyReportForResume(alias, "structural", null, reportsDir);
    expect(rejected.ok).toBe(false);
    expect(rejected.stderr).toMatch(/regular non-symlink/i);
  } finally {
    rmSync(reportsDir, { recursive: true, force: true });
  }
});

it("verifies a report beneath Windows shell-metacharacter paths without invoking a shell", async () => {
  const base = mkdtempSync(join(tmpdir(), "af-fleet-metachar-"));
  const reportsDir = join(base, "reports & %PATH% (literal)");
  mkdirSync(reportsDir);
  const reportPath = join(reportsDir, "structural report.md");
  try {
    writeFileSync(
      reportPath,
      `## Playthrough log

The structural opening completed.

## Verdict

The deterministic smoke route remained understandable.

\`\`\`json exit-interview
${JSON.stringify({
  schema_version: 2,
  play_mode: "structural",
  start_surface: "fresh_overworld",
  retention_eligible: false,
  structural_kind: "mock",
  clarity: 4,
  enjoyment: 4,
  goal_understood: true,
  got_stuck: false,
  confusions: [],
  bugs: [],
  best_moment: "The route exposed the opening state clearly.",
  worst_moment: "The smoke run was intentionally brief.",
  would_replay: true,
  verdict: "The deterministic route is suitable for structural verification only.",
})}
\`\`\`
`,
    );
    writeFileSync(
      runSidecarPathFor(reportPath),
      JSON.stringify({
        schema_version: 1,
        report_schema_version: 2,
        play_mode: "structural",
        start_surface: "fresh_overworld",
        retention_eligible: false,
        evidence_status: "not_applicable",
        structural_kind: "mock",
      }),
    );
    const verified = await verifyReportForResume(reportPath, "structural", null, reportsDir);
    expect(verified.ok).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

describe("resumeCandidatesFor", () => {
  it("anchors the seed so seed1 never matches seed10", () => {
    const entries = [
      "20260709T010203Z_overworld_seed10.md",
      "20260709T010203Z_overworld_seed1.md",
      "20260709T010203Z_overworld_seed1.md",
    ];
    expect(resumeCandidatesFor(entries, "overworld", 1)).toEqual([
      "20260709T010203Z_overworld_seed1.md",
    ]);
    expect(resumeCandidatesFor(entries, "overworld", 10)).toEqual([
      "20260709T010203Z_overworld_seed10.md",
    ]);
  });
  it("returns matches newest-stamp-first", () => {
    const entries = [
      "20260101T000000Z_overworld_seed5.md",
      "20260301T000000Z_overworld_seed5.md",
      "20260201T000000Z_overworld_seed5.md",
    ];
    expect(resumeCandidatesFor(entries, "overworld", 5)).toEqual([
      "20260301T000000Z_overworld_seed5.md",
      "20260201T000000Z_overworld_seed5.md",
      "20260101T000000Z_overworld_seed5.md",
    ]);
  });
  it("ignores non-matching slugs and unrelated files", () => {
    const entries = [
      "20260101T000000Z_sunken_barrow_seed5.md",
      "notes.txt",
      "20260101T000000Z_overworld_seed5.json",
    ];
    expect(resumeCandidatesFor(entries, "overworld", 5)).toEqual([]);
  });

  it("does not let a verifier-valid legacy report resume a pure fleet slot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "af-pure-resume-"));
    try {
      const reportPath = join(dir, "20260101T000000Z_overworld_seed5.md");
      writeFileSync(
        reportPath,
        `
1. Playthrough log: played a guided opening.
2. Did it work mechanically? Yes.
3. Understandable & fun? clarity 4/5 and enjoyment 4/5.
4. Confusion / friction points: none.
5. Bugs or design flaws: none.
6. Verdict: A real player could understand this legacy opening.
\`\`\`json exit-interview
${JSON.stringify({
  schema_version: 2,
  play_mode: "structural",
  start_surface: "fresh_overworld",
  retention_eligible: false,
  structural_kind: "mock",
  clarity: 4,
  enjoyment: 4,
  goal_understood: true,
  got_stuck: false,
  confusions: [],
  bugs: [],
  best_moment: "A visible choice landed clearly.",
  worst_moment: "One transition was slow.",
  would_replay: true,
  verdict: "A real player could understand this legacy opening and keep playing.",
})}
\`\`\`
`,
      );
      expect(runSidecarPathFor(reportPath)).toBe(reportPath.replace(/\.md$/, ".run.json"));
      expect((await verifyReportForResume(reportPath, "pure")).ok).toBe(false);
      writeFileSync(
        runSidecarPathFor(reportPath),
        JSON.stringify({
          schema_version: 1,
          report_schema_version: 2,
          play_mode: "structural",
          start_surface: "fresh_overworld",
          retention_eligible: false,
          evidence_status: "not_applicable",
          structural_kind: "mock",
        }),
      );
      expect((await verifyReportForResume(reportPath, "pure")).ok).toBe(false);
      expect((await verifyReportForResume(reportPath, "structural")).ok).toBe(true);

      const decisionProofHash = "a".repeat(64);
      const receiptPayload = {
        contractVersion: 1,
        exitReason: "player_ended_at_choice",
        goalVersion: 1,
        goalId: "albany_local_lead",
        goalStatus: "active",
        acceptedDecisions: 40,
        exitReasons: ["checkpoint"],
        checkpoint: 40,
        decisionProofHash,
        retentionHistory: [
          {
            sequence: 1,
            atDecision: 40,
            reasons: ["checkpoint"],
            checkpoint: 40,
            choice: "end",
            decisionProofHash,
          },
        ],
      };
      const receipt = { ...receiptPayload, receiptHash: hashState(receiptPayload) };
      const pureInterview = {
        schema_version: 2,
        play_mode: "pure",
        start_surface: "fresh_overworld",
        retention_eligible: true,
        journey_exit_receipt: receipt,
        clarity: 4,
        enjoyment: 4,
        goal_understood: true,
        got_stuck: false,
        confusions: [],
        bugs: [],
        best_moment: "A visible choice landed clearly.",
        worst_moment: "One transition was slow.",
        would_replay: true,
        verdict: "A real player could understand this pure opening and keep playing.",
      };
      writeFileSync(
        reportPath,
        `
1. Playthrough log: played naturally until the game offered an exit.
2. Did it work mechanically? Yes.
3. Understandable & fun? clarity 4/5 and enjoyment 4/5.
4. Confusion / friction points: none.
5. Bugs or design flaws: none.
6. Verdict: A real player could understand this pure opening.
\`\`\`json exit-interview
${JSON.stringify(pureInterview)}
\`\`\`
`,
      );
      writeFileSync(
        runSidecarPathFor(reportPath),
        JSON.stringify({
          schema_version: 1,
          report_schema_version: 2,
          play_mode: "pure",
          start_surface: "fresh_overworld",
          retention_eligible: true,
          evidence_status: "verified",
          session_id: "ow-resume",
          receipt,
        }),
      );
      const pureResume = await verifyReportForResume(reportPath, "pure");
      expect(pureResume.ok).toBe(false);
      expect(pureResume.run).toMatchObject({ play_mode: "pure", retention_eligible: true });

      const currentPayload = {
        ...receiptPayload,
        contractVersion: PURE_SESSION_CONTRACT_VERSION,
        goalText: INITIAL_JOURNEY_GOAL.text,
        goalCompletedAtDecision: null,
        completedGoals: [],
        retentionHistory: receiptPayload.retentionHistory.map((event) => ({
          ...event,
          goalVersion: null,
          goalId: null,
        })),
      };
      const currentReceipt = {
        ...currentPayload,
        receiptHash: hashState(currentPayload),
      };
      const expectedBuild = {
        git_commit: "b".repeat(40),
        tracked_worktree_clean: true,
        world_id: "new_york_overworld",
        world_hash: "c".repeat(64),
      };
      const expectedPure = { seed: 5, model: "haiku", build: expectedBuild };
      writeFileSync(
        reportPath,
        `
1. Playthrough log: played naturally until the game offered an exit.
2. Did it work mechanically? Yes.
3. Understandable & fun? clarity 4/5 and enjoyment 4/5.
4. Confusion / friction points: none.
5. Bugs or design flaws: none.
6. Verdict: A real player could understand this pure opening.
\`\`\`json exit-interview
${JSON.stringify({ ...pureInterview, journey_exit_receipt: currentReceipt })}
\`\`\`
`,
      );
      writeFileSync(
        runSidecarPathFor(reportPath),
        JSON.stringify({
          schema_version: 1,
          report_schema_version: 2,
          play_mode: "pure",
          start_surface: "fresh_overworld",
          retention_eligible: true,
          evidence_status: "verified",
          session_id: "ow-resume",
          receipt: currentReceipt,
        }),
      );
      const currentContractV1 = await verifyReportForResume(reportPath, "pure", expectedPure);
      expect(currentContractV1.ok).toBe(false);
      expect(currentContractV1.stderr).toMatch(/evidence schema v2/i);

      const validV2Sidecar = {
        schema_version: PURE_FLEET_EVIDENCE_SCHEMA_VERSION,
        report_schema_version: 2,
        play_mode: "pure",
        start_surface: "fresh_overworld",
        retention_eligible: true,
        evidence_status: "verified",
        session_id: "ow-resume",
        run_seed: 5,
        build: expectedBuild,
        quest_outcomes: [],
        receipt: currentReceipt,
      };
      writeFileSync(runSidecarPathFor(reportPath), JSON.stringify(validV2Sidecar));
      expect((await verifyReportForResume(reportPath, "pure", expectedPure)).ok).toBe(false);
      expect((await verifyReportForResume(reportPath, "pure")).ok).toBe(false);

      const claudeSessionId = "10852ae5-43b1-424a-aa39-7ba347361cec";
      const actualModel = "claude-haiku-4-5-20251001";
      const evidenceBody = `${[
        {
          schema_version: 2,
          play_mode: "pure",
          event: "fresh_start",
          start_surface: "fresh_overworld",
          session_id: validV2Sidecar.session_id,
          run_seed: 5,
          build: expectedBuild,
        },
        {
          schema_version: 2,
          play_mode: "pure",
          event: "journey_exit",
          start_surface: "fresh_overworld",
          session_id: validV2Sidecar.session_id,
          run_seed: 5,
          build: expectedBuild,
          quest_outcomes: [],
          receipt: currentReceipt,
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`;
      const primaryEnvelopeBody = JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: claudeSessionId,
        result: readFileSync(reportPath, "utf8"),
        stop_reason: "end_turn",
        terminal_reason: "completed",
        permission_denials: [],
        modelUsage: { [actualModel]: {} },
      });
      writeFileSync(reportPath.replace(/\.md$/, ".evidence.jsonl"), evidenceBody);
      writeFileSync(reportPath.replace(/\.md$/, ".json"), primaryEnvelopeBody);

      const {
        provider_events_sha256: _providerEventsSha256,
        provider_rollout_sha256: _providerRolloutSha256,
        provider_capture_sha256: _providerCaptureSha256,
        receipt_binding_sha256: _receiptBindingSha256,
        ...historicalClaudeArtifactHashes
      } = pureFleetArtifactHashes(reportPath);
      const validAttestation = {
        schema_version: PURE_FLEET_ATTESTATION_SCHEMA_VERSION,
        run_seed: 5,
        model: "haiku",
        persona: "default",
        target: "overworld",
        play_mode: "pure",
        start_surface: "fresh_overworld",
        build: expectedBuild,
        game_session_id: "ow-resume",
        claude_session_id: claudeSessionId,
        actual_model: actualModel,
        report_recovered: false,
        receipt_hash: currentReceipt.receiptHash,
        ...historicalClaudeArtifactHashes,
      };
      expect(fleetAttestationPathFor(reportPath)).toBe(reportPath.replace(/\.md$/, ".fleet.json"));
      writeFileSync(
        fleetAttestationPathFor(reportPath),
        JSON.stringify({ ...validAttestation, model: "sonnet" }),
      );
      expect((await verifyReportForResume(reportPath, "pure", expectedPure)).ok).toBe(false);
      writeFileSync(fleetAttestationPathFor(reportPath), JSON.stringify(validAttestation));
      const exactResume = await verifyReportForResume(reportPath, "pure", expectedPure);
      expect(exactResume.ok).toBe(true);
      expect(exactResume.attestation).toEqual(validAttestation);

      const reportBytes = readFileSync(reportPath);
      const sidecarBytes = readFileSync(runSidecarPathFor(reportPath));
      const qualitativelyTamperedReport = reportBytes
        .toString("utf8")
        .replace("clarity 4/5", "clarity 5/5")
        .replace('"clarity":4', '"clarity":5');
      writeFileSync(reportPath, qualitativelyTamperedReport);
      const markdownTamper = await verifyReportForResume(reportPath, "pure", expectedPure);
      expect(markdownTamper.ok).toBe(false);
      expect(markdownTamper.stderr).toMatch(/primary Claude result bytes/i);
      writeFileSync(reportPath, reportBytes);

      writeFileSync(
        runSidecarPathFor(reportPath),
        JSON.stringify({
          ...validV2Sidecar,
          quest_outcomes: [["wolf_winter", "ending_pack_diverted"]],
        }),
      );
      const sidecarTamper = await verifyReportForResume(reportPath, "pure", expectedPure);
      expect(sidecarTamper.ok).toBe(false);
      expect(sidecarTamper.stderr).toMatch(/raw run evidence/i);
      writeFileSync(runSidecarPathFor(reportPath), sidecarBytes);

      const freshReportPath = join(dir, "fresh.md");
      writeFileSync(freshReportPath, reportBytes);
      writeFileSync(runSidecarPathFor(freshReportPath), sidecarBytes);
      writeFileSync(freshReportPath.replace(/\.md$/, ".evidence.jsonl"), evidenceBody);
      writeFileSync(freshReportPath.replace(/\.md$/, ".json"), primaryEnvelopeBody);
      await expect(
        writeFreshPureFleetAttestation(freshReportPath, validV2Sidecar, expectedPure),
      ).resolves.toEqual(validAttestation);
      await expect(
        writeFreshPureFleetAttestation(freshReportPath, validV2Sidecar, expectedPure),
      ).rejects.toThrow();

      const attestationMismatches = [
        { ...validAttestation, game_session_id: "another-session" },
        { ...validAttestation, receipt_hash: "f".repeat(64) },
        {
          ...validAttestation,
          build: { ...expectedBuild, world_hash: "f".repeat(64) },
        },
      ];
      for (const attestation of attestationMismatches) {
        writeFileSync(fleetAttestationPathFor(reportPath), JSON.stringify(attestation));
        expect((await verifyReportForResume(reportPath, "pure", expectedPure)).ok).toBe(false);
      }
      writeFileSync(fleetAttestationPathFor(reportPath), JSON.stringify(validAttestation));

      const mismatches = [
        ["seed", { ...validV2Sidecar, run_seed: 6 }],
        [
          "commit",
          {
            ...validV2Sidecar,
            build: { ...expectedBuild, git_commit: "d".repeat(40) },
          },
        ],
        [
          "cleanliness",
          {
            ...validV2Sidecar,
            build: { ...expectedBuild, tracked_worktree_clean: false },
          },
        ],
        [
          "world id",
          {
            ...validV2Sidecar,
            build: { ...expectedBuild, world_id: "another_world" },
          },
        ],
        [
          "world hash",
          {
            ...validV2Sidecar,
            build: { ...expectedBuild, world_hash: "e".repeat(64) },
          },
        ],
      ];
      for (const [name, sidecar] of mismatches) {
        writeFileSync(runSidecarPathFor(reportPath), JSON.stringify(sidecar));
        expect(
          (await verifyReportForResume(reportPath, "pure", expectedPure)).ok,
          `${name} mismatch must fail closed`,
        ).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fleet attempt evidence", () => {
  it("classifies timeout, strict rejection, launcher, verifier, and verified attempts", () => {
    expect(
      classifyFleetAttempt({ runnerExit: 124, verifierAttempted: false, verified: false }),
    ).toBe("technical_timeout");
    expect(classifyFleetAttempt({ runnerExit: 9, verifierAttempted: false, verified: false })).toBe(
      "launcher_or_run_failure",
    );
    expect(
      classifyFleetAttempt({ runnerExit: 43, verifierAttempted: false, verified: false }),
    ).toBe("strict_stream_rejected");
    expect(classifyFleetAttempt({ runnerExit: 1, verifierAttempted: true, verified: false })).toBe(
      "verifier_failure",
    );
    expect(classifyFleetAttempt({ runnerExit: 0, verifierAttempted: true, verified: true })).toBe(
      "verified",
    );
    expect(
      classifyFleetAttempt({ runnerExit: 137, verifierAttempted: true, verified: false }),
    ).toBe("technical_timeout");
  });

  it("never retries a strict-stream rejection while retaining other retry behavior", () => {
    expect(
      shouldRetryFleetAttempt({
        classification: "strict_stream_rejected",
        attempt: 0,
        maxAttempts: 3,
      }),
    ).toBe(false);
    expect(
      shouldRetryFleetAttempt({
        classification: "launcher_or_run_failure",
        attempt: 0,
        maxAttempts: 3,
      }),
    ).toBe(true);
    expect(
      shouldRetryFleetAttempt({ classification: "technical_timeout", attempt: 2, maxAttempts: 3 }),
    ).toBe(false);
  });

  it("launches a strict-stream-rejected member exactly once even when retries are configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "af-fleet-strict-no-retry-"));
    const reportsDir = join(root, "reports");
    const fleetDir = join(root, "fleet");
    mkdirSync(reportsDir);
    mkdirSync(fleetDir);
    let launches = 0;
    const resolved = resolveCodexClientBinary(process.execPath);
    const client = codexClientAuthorityRecord(resolved.identity_token, "0.146.0");
    const fleetBuild = {
      git_commit: "a".repeat(40),
      tracked_worktree_clean: true,
      world_id: "new_york_overworld",
      world_hash: "b".repeat(64),
    };
    let buildCaptures = 0;
    try {
      const result = await executeRun(
        {
          seed: 7,
          persona: "default",
          provider: "codex",
          model: "gpt-5.6-terra",
          target: "overworld",
        },
        {
          reportsDir,
          stamp: "20260803T120000Z",
          opts: { mock: false, resume: false, maxRetries: 2, admissionCanary: false },
          bashPath: "fake-bash",
          fleetDir,
          fleetBuild,
          fleetClient: client,
          fleetControl: Object.assign(
            createFleetLaunchControl({
              captureBuild: async () => {
                buildCaptures += 1;
                return fleetBuild;
              },
            }),
            {
              admissionFailure: false,
              transportFingerprint: "b".repeat(64),
              strictRejectedTransportFingerprints: new Set<string>(),
            },
          ),
          spawnRun: async (_command: string, args: string[]) => {
            launches += 1;
            const out = args[args.indexOf("--out") + 1];
            writeFileSync(
              `${out}.strict-rejection.json`,
              `${JSON.stringify({
                schema_version: 1,
                acceptance_eligible: false,
                canonical: false,
                code_mode_contract: "strict-code-mode-v2",
                ignored: true,
                kind: "strict_wrapper_rejection_diagnostic",
                surface: "private_rollout",
                commitments: {
                  seed: "7",
                  build_commit: "a".repeat(40),
                  tracked_worktree_clean: true,
                  model: "gpt-5.6-terra",
                  cli_version: client.cli_version,
                  client_authority_sha256: client.authority_sha256,
                },
                binding: {
                  thread_id: "77777777-7777-4777-8777-777777777777",
                  rollout_file_identity: { device_id: "7", file_id: "9" },
                  wrapper_item_id_sha256: "c".repeat(64),
                  wrapper_call_id_sha256: "d".repeat(64),
                },
                wrapper: { failure: "syntax_error", input_bytes: 0, input_sha256: "e".repeat(64) },
              })}\n`,
            );
            return { status: 43, stdout: "", stderr: "" };
          },
        },
      );
      expect(launches).toBe(1);
      expect(buildCaptures).toBe(2);
      expect(result).toMatchObject({
        status: "failed",
        attempts: 1,
        exit: 43,
        failure_reason: "strict_stream_rejected",
        attempt_history: [{ attempt: 1, exit: 43, classification: "strict_stream_rejected" }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds each model's exact prompt surface into an isolated stable fingerprint", () => {
    const commonHashes = {
      runner: "a".repeat(64),
      envelope_audit: "c".repeat(64),
      strict_stream_guard: "d".repeat(64),
      prompt_filler: "e".repeat(64),
      rollout_capture: "4".repeat(64),
      process_anchor: "5".repeat(64),
    };
    const sparkHashes = {
      ...commonHashes,
      prompt_template: "b".repeat(64),
      player_catalog: "7".repeat(64),
      transport_fragment: "f".repeat(64),
    };
    const strictHashes = {
      ...commonHashes,
      prompt_template: "8".repeat(64),
      transport_fragment: "9".repeat(64),
    };
    const terraHashes = {
      ...strictHashes,
      player_catalog: "6".repeat(64),
    };
    const first = createFleetTransportFingerprint({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      componentHashes: sparkHashes,
    });
    const reordered = createFleetTransportFingerprint({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      componentHashes: {
        player_catalog: sparkHashes.player_catalog,
        prompt_filler: sparkHashes.prompt_filler,
        strict_stream_guard: sparkHashes.strict_stream_guard,
        envelope_audit: sparkHashes.envelope_audit,
        prompt_template: sparkHashes.prompt_template,
        runner: sparkHashes.runner,
        transport_fragment: sparkHashes.transport_fragment,
        rollout_capture: sparkHashes.rollout_capture,
        process_anchor: sparkHashes.process_anchor,
      },
    });
    const changedRunner = createFleetTransportFingerprint({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      componentHashes: { ...sparkHashes, runner: "0".repeat(64) },
    });
    const changedFragment = createFleetTransportFingerprint({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      componentHashes: { ...sparkHashes, transport_fragment: "1".repeat(64) },
    });
    const changedSparkPrompt = createFleetTransportFingerprint({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      componentHashes: { ...sparkHashes, prompt_template: "2".repeat(64) },
    });
    const changedSparkCatalog = createFleetTransportFingerprint({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      componentHashes: { ...sparkHashes, player_catalog: "3".repeat(64) },
    });
    const changedRolloutCapture = createFleetTransportFingerprint({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      componentHashes: { ...sparkHashes, rollout_capture: "6".repeat(64) },
    });
    const changedProcessAnchor = createFleetTransportFingerprint({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      componentHashes: { ...sparkHashes, process_anchor: "6".repeat(64) },
    });
    const terra = createFleetTransportFingerprint({
      provider: "codex",
      model: "gpt-5.6-terra",
      componentHashes: terraHashes,
    });
    const changedTerraFragment = createFleetTransportFingerprint({
      provider: "codex",
      model: "gpt-5.6-terra",
      componentHashes: { ...terraHashes, transport_fragment: "0".repeat(64) },
    });
    const changedTerraCatalog = createFleetTransportFingerprint({
      provider: "codex",
      model: "gpt-5.6-terra",
      componentHashes: { ...terraHashes, player_catalog: "0".repeat(64) },
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(reordered).toBe(first);
    expect(changedRunner).not.toBe(first);
    expect(changedFragment).not.toBe(first);
    expect(changedSparkPrompt).not.toBe(first);
    expect(changedSparkCatalog).not.toBe(first);
    expect(changedRolloutCapture).not.toBe(first);
    expect(changedProcessAnchor).not.toBe(first);
    expect(terra).not.toBe(first);
    expect(changedTerraFragment).not.toBe(terra);
    expect(changedTerraCatalog).not.toBe(terra);
    expect(fleetTransportProfile("gpt-5.3-codex-spark")).toEqual({
      transportContract: "spark-direct-mcp-v1",
      componentPaths: {
        envelope_audit: "codex-pure-envelope.mjs",
        player_catalog: "codex-model-catalog-spark-v1.json",
        prompt_filler: "fill-prompt.mjs",
        prompt_template: "prompt-overworld-spark.md",
        process_anchor: "codex-process-anchor.mjs",
        rollout_capture: "codex-rollout.mjs",
        runner: "run.sh",
        strict_stream_guard: "codex-strict-stream.mjs",
        transport_fragment: "prompt-transports/spark-direct-mcp-v1.md",
      },
    });
    expect(fleetTransportProfile("gpt-5.6-terra")).toEqual({
      transportContract: "game-direct-mcp-v1",
      componentPaths: {
        envelope_audit: "codex-pure-envelope.mjs",
        player_catalog: "codex-model-catalog-terra-v1.json",
        prompt_filler: "fill-prompt.mjs",
        prompt_template: "prompt-overworld.md",
        process_anchor: "codex-process-anchor.mjs",
        rollout_capture: "codex-rollout.mjs",
        runner: "run.sh",
        strict_stream_guard: "codex-strict-stream.mjs",
        transport_fragment: "prompt-transports/game-direct-mcp-v1.md",
      },
    });
    for (const strictModel of ["gpt-5.6-sol", "gpt-5.6-luna"] as const) {
      expect(fleetTransportProfile(strictModel)).toEqual({
        transportContract: "strict-code-mode-v2",
        componentPaths: {
          envelope_audit: "codex-pure-envelope.mjs",
          prompt_filler: "fill-prompt.mjs",
          prompt_template: "prompt-overworld.md",
          process_anchor: "codex-process-anchor.mjs",
          rollout_capture: "codex-rollout.mjs",
          runner: "run.sh",
          strict_stream_guard: "codex-strict-stream.mjs",
          transport_fragment: "prompt-transports/strict-code-mode-v2.md",
        },
      });
    }
    expect(() =>
      createFleetTransportFingerprint({
        provider: "codex",
        model: "gpt-5.6-terra",
        componentHashes: strictHashes,
      }),
    ).toThrow(/component digest set/i);
    expect(() =>
      createFleetTransportFingerprint({
        provider: "codex",
        model: "gpt-5.6-sol",
        componentHashes: { ...strictHashes, player_catalog: terraHashes.player_catalog },
      }),
    ).toThrow(/component digest set/i);
    expect(() =>
      createFleetTransportFingerprint({
        provider: "codex",
        model: "gpt-5.3-codex-spark",
        componentHashes: strictHashes,
      }),
    ).toThrow(/component digest set/i);
    expect(first).not.toContain("prompt");
    expect(first).not.toContain("seed");
    expect(() =>
      createFleetTransportFingerprint({
        provider: "codex",
        model: "gpt-5.3-codex-spark",
        componentHashes: { runner: "a".repeat(64) },
      }),
    ).toThrow(/component digest set/i);
  });

  it("archives failed artifacts before retry and reduces every attempt, not only the terminal one", () => {
    const root = mkdtempSync(join(tmpdir(), "af-fleet-attempts-"));
    const reportsDir = join(root, "reports");
    const fleetDir = join(root, "fleet");
    mkdirSync(reportsDir);
    mkdirSync(fleetDir);
    const outPrefix = join(reportsDir, "20260716T120000Z_overworld_seed7");
    const reportPath = `${outPrefix}.md`;
    const sidecarPath = `${outPrefix}.run.json`;
    const unrelatedPath = join(reportsDir, "unrelated.md");
    try {
      writeFileSync(reportPath, "rejected report\n");
      writeFileSync(sidecarPath, '{"rejected":true}\n');
      writeFileSync(unrelatedPath, "keep me\n");
      const archive = archiveFailedFleetAttemptArtifacts({
        outPrefix,
        fleetDir,
        seed: 7,
        attempt: 1,
        diagnostic: "attempt=1\nclassification=verifier_failure\n",
      });

      expect(archive.directory).toBe("attempts/seed_7/attempt_1");
      expect(archive.usage_artifacts).toEqual({
        primary_envelope: null,
        provider_events: null,
      });
      expect(archive.artifacts.map((artifact: { name: string }) => artifact.name)).toEqual([
        "20260716T120000Z_overworld_seed7.md",
        "20260716T120000Z_overworld_seed7.run.json",
        "fleet-diagnostic.log",
      ]);
      for (const artifact of archive.artifacts as {
        name: string;
        bytes: number;
        sha256: string;
      }[]) {
        expect(artifact.bytes).toBeGreaterThan(0);
        expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(existsSync(join(fleetDir, archive.directory, artifact.name))).toBe(true);
      }
      expect(existsSync(reportPath)).toBe(false);
      expect(existsSync(sidecarPath)).toBe(false);
      expect(readFileSync(unrelatedPath, "utf8")).toBe("keep me\n");

      const summary = summarizeFleetAttemptHistory([
        {
          report_recovered: false,
          attempt_history: [
            { classification: "technical_timeout" },
            { classification: "verifier_failure" },
            { classification: "verified" },
          ],
        },
        { report_recovered: true, attempt_history: [] },
      ]);
      expect(summary).toEqual({
        total_attempts: 3,
        failed_attempts: 2,
        technical_timeouts: 1,
        report_recovered_runs: 1,
        receipt_bound_runs: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("archives a strict rejection as diagnostic-only and excludes it from usage evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "af-fleet-strict-diagnostic-"));
    const reportsDir = join(root, "reports");
    const fleetDir = join(root, "fleet");
    mkdirSync(reportsDir);
    mkdirSync(fleetDir);
    const outPrefix = join(reportsDir, "20260716T120000Z_overworld_seed43");
    const diagnosticPath = `${outPrefix}.strict-rejection.json`;
    const eventsPath = `${outPrefix}.codex.jsonl`;
    const rawWrapper = "raw wrapper source must not be archived";
    const rawProviderStderr = "provider stderr sentinel C:/private/report-prefix";
    try {
      const resolved = resolveCodexClientBinary(process.execPath);
      const client = codexClientAuthorityRecord(resolved.identity_token, "0.144.1");
      expect(
        writeStrictRejectionDiagnostic(
          {
            path: diagnosticPath,
            seed: "43",
            buildCommit: "a".repeat(40),
            trackedWorktreeClean: true,
            model: "gpt-5.3-codex-spark",
            cliVersion: "0.144.1",
            clientAuthoritySha256: client.authority_sha256,
          },
          {
            threadId: "77777777-7777-4777-8777-777777777777",
            identity: { dev: 7n, ino: 9n },
          },
          {
            payload: {
              type: "custom_tool_call",
              id: "wrapper-item-7",
              call_id: "call-wrapper-7",
              input: rawWrapper,
            },
          },
          "syntax_error",
        ),
      ).toBe(true);
      writeFileSync(eventsPath, `${rawWrapper}\n`);
      writeFileSync(`${outPrefix}.json`, '{"usage":{"input_tokens":999}}\n');
      const archive = archiveFailedFleetAttemptArtifacts({
        outPrefix,
        fleetDir,
        seed: 43,
        attempt: 1,
        diagnostic: strictRejectionFleetDiagnostic({
          run: { seed: 43, model: "gpt-5.3-codex-spark" },
          attempt: 1,
          exit: 43,
          fleetClient: client,
        }),
        diagnosticOnly: true,
      });
      expect(archive.usage_artifacts).toEqual({ primary_envelope: null, provider_events: null });
      expect(archive.artifacts.map((artifact: { name: string }) => artifact.name)).toEqual([
        "20260716T120000Z_overworld_seed43.strict-rejection.json",
        "fleet-diagnostic.log",
      ]);
      expect(
        readFileSync(
          join(
            fleetDir,
            archive.directory,
            "20260716T120000Z_overworld_seed43.strict-rejection.json",
          ),
          "utf8",
        ),
      ).not.toContain(rawWrapper);
      const fleetDiagnostic = readFileSync(
        join(fleetDir, archive.directory, "fleet-diagnostic.log"),
        "utf8",
      );
      expect(fleetDiagnostic).not.toContain(rawProviderStderr);
      expect(fleetDiagnostic).not.toContain("C:/private/report-prefix");
      if (process.platform !== "win32") {
        expect(
          statSync(
            join(
              fleetDir,
              archive.directory,
              "20260716T120000Z_overworld_seed43.strict-rejection.json",
            ),
          ).mode & 0o777,
        ).toBe(0o600);
        expect(
          statSync(join(fleetDir, archive.directory, "fleet-diagnostic.log")).mode & 0o777,
        ).toBe(0o600);
      }
      const summary = pureFleetSummaryAccounting(
        [
          {
            attempt_history: [
              {
                usage: {
                  source: "unrecoverable",
                  input_tokens: null,
                  cached_input_tokens: null,
                  output_tokens: null,
                  reasoning_output_tokens: null,
                },
              },
            ],
            resume_usage: null,
          },
        ],
        client,
      );
      expect(summary.usage).toMatchObject({
        attempt_count: 1,
        launched_attempt_count: 1,
        unrecoverable_attempt_count: 1,
        complete: false,
        observed_input_tokens: 0,
        useful_tokens: 0,
      });
      expect(usageRecordFromFailedFleetAttemptArchive({ archive, fleetDir })).toMatchObject({
        source: "unrecoverable",
      });
      expect(existsSync(diagnosticPath)).toBe(false);
      expect(existsSync(eventsPath)).toBe(false);
      expect(existsSync(`${outPrefix}.json`)).toBe(false);
      const malformedPrefix = join(reportsDir, "20260716T120000Z_overworld_seed44");
      writeFileSync(`${malformedPrefix}.strict-rejection.json`, "{}\n");
      expect(() =>
        archiveFailedFleetAttemptArtifacts({
          outPrefix: malformedPrefix,
          fleetDir,
          seed: 44,
          attempt: 2,
          diagnostic: strictRejectionFleetDiagnostic({
            run: { seed: 44, model: "gpt-5.3-codex-spark" },
            attempt: 2,
            exit: 43,
            fleetClient: client,
          }),
          diagnosticOnly: true,
        }),
      ).toThrow(/strict rejection diagnostic is malformed or unsafe/i);
      const tailedPrefix = join(reportsDir, "20260716T120000Z_overworld_seed45");
      writeFileSync(
        `${tailedPrefix}.strict-rejection.json`,
        readFileSync(
          join(
            fleetDir,
            archive.directory,
            "20260716T120000Z_overworld_seed43.strict-rejection.json",
          ),
        ),
      );
      expect(() =>
        archiveFailedFleetAttemptArtifacts({
          outPrefix: tailedPrefix,
          fleetDir,
          seed: 45,
          attempt: 3,
          diagnostic: `${strictRejectionFleetDiagnostic({
            run: { seed: 45, model: "gpt-5.3-codex-spark" },
            attempt: 3,
            exit: 43,
            fleetClient: client,
          })}${rawProviderStderr}\n`,
          diagnosticOnly: true,
        }),
      ).toThrow(/strict rejection archive requires one safe structural diagnostic/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accounts failed Codex attempts only from digest-indexed semantic archive copies", () => {
    const root = mkdtempSync(join(tmpdir(), "af-fleet-usage-archive-"));
    const reportsDir = join(root, "reports");
    const fleetDir = join(root, "fleet");
    mkdirSync(reportsDir);
    mkdirSync(fleetDir);
    const model = "gpt-5.6-terra";
    const primaryUsage = {
      input_tokens: 101,
      cache_read_input_tokens: 40,
      output_tokens: 9,
      reasoning_output_tokens: 3,
    };
    const primary = JSON.stringify({
      type: "result",
      subtype: "success",
      provider: "codex",
      is_error: false,
      terminal_reason: "completed",
      num_turns: 1,
      result: "completed",
      session_id: "session-primary",
      requested_model: model,
      usage: primaryUsage,
      modelUsage: {
        [model]: {
          inputTokens: primaryUsage.input_tokens,
          cacheReadInputTokens: primaryUsage.cache_read_input_tokens,
          outputTokens: primaryUsage.output_tokens,
          reasoningOutputTokens: primaryUsage.reasoning_output_tokens,
        },
      },
    });
    const events = JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 999,
        cached_input_tokens: 1,
        output_tokens: 2,
        reasoning_output_tokens: 0,
      },
    });
    try {
      const withPrimary = join(reportsDir, "20260716T120000Z_overworld_seed8");
      writeFileSync(`${withPrimary}.json`, primary);
      writeFileSync(`${withPrimary}.codex.jsonl`, `${events}\n`);
      const primaryArchive = archiveFailedFleetAttemptArtifacts({
        outPrefix: withPrimary,
        fleetDir,
        seed: 8,
        attempt: 1,
        diagnostic: "failed\n",
      });
      expect(primaryArchive.usage_artifacts).toEqual({
        primary_envelope: "20260716T120000Z_overworld_seed8.json",
        provider_events: "20260716T120000Z_overworld_seed8.codex.jsonl",
      });
      expect(
        usageRecordFromFailedFleetAttemptArchive({ archive: primaryArchive, fleetDir }),
      ).toEqual({
        source: "primary_envelope",
        input_tokens: 101,
        cached_input_tokens: 40,
        output_tokens: 9,
        reasoning_output_tokens: 3,
      });

      const malformedPrimary = join(reportsDir, "20260716T120000Z_overworld_seed9");
      writeFileSync(`${malformedPrimary}.json`, "{ malformed primary");
      writeFileSync(`${malformedPrimary}.codex.jsonl`, `${events}\n`);
      const malformedArchive = archiveFailedFleetAttemptArtifacts({
        outPrefix: malformedPrimary,
        fleetDir,
        seed: 9,
        attempt: 1,
        diagnostic: "failed\n",
      });
      expect(
        usageRecordFromFailedFleetAttemptArchive({ archive: malformedArchive, fleetDir }),
      ).toMatchObject({
        source: "unrecoverable",
      });

      const eventsOnly = join(reportsDir, "20260716T120000Z_overworld_seed10");
      writeFileSync(`${eventsOnly}.codex.jsonl`, `${events}\n`);
      const eventsArchive = archiveFailedFleetAttemptArtifacts({
        outPrefix: eventsOnly,
        fleetDir,
        seed: 10,
        attempt: 1,
        diagnostic: "failed\n",
      });
      expect(
        usageRecordFromFailedFleetAttemptArchive({ archive: eventsArchive, fleetDir }),
      ).toMatchObject({
        source: "terminal_turn_completed",
        input_tokens: 999,
      });

      const archivedEventsPath = join(
        fleetDir,
        eventsArchive.directory,
        eventsArchive.usage_artifacts.provider_events!,
      );
      writeFileSync(archivedEventsPath, `${events}\nextra`);
      expect(
        usageRecordFromFailedFleetAttemptArchive({ archive: eventsArchive, fleetDir }),
      ).toMatchObject({
        source: "unrecoverable",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects v9 live summary usage without leaking Codex authority or paths", () => {
    const resolved = resolveCodexClientBinary(process.execPath);
    const client = codexClientAuthorityRecord(resolved.identity_token, "0.144.1");
    const summary = pureFleetSummaryAccounting(
      [
        {
          attempt_history: [
            {
              usage: {
                source: "primary_envelope",
                input_tokens: 100,
                cached_input_tokens: 25,
                output_tokens: 8,
                reasoning_output_tokens: 3,
              },
            },
          ],
          resume_usage: null,
        },
        {
          attempt_history: [],
          resume_usage: {
            source: "skipped_resume",
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
          },
        },
      ],
      client,
    );
    expect(summary).toMatchObject({
      schema_version: PURE_FLEET_SUMMARY_SCHEMA_VERSION,
      usage: {
        attempt_count: 2,
        launched_attempt_count: 1,
        skipped_resume_count: 1,
        observed_uncached_input_tokens: 75,
        useful_tokens: 83,
      },
      codex_client: {
        schema_version: 2,
        launcher_kind: client.launcher_kind,
        authority_sha256: client.authority_sha256,
        cli_version: client.cli_version,
      },
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(client.authority_token);
    expect(serialized).not.toContain(client.selected_binary);
    expect(serialized).not.toContain(client.executable_binary);
  });

  it("writes the full Codex authority once as a private digest-indexed artifact", () => {
    const fleetDir = mkdtempSync(join(tmpdir(), "af-fleet-client-proof-"));
    try {
      const resolved = resolveCodexClientBinary(process.execPath);
      const client = codexClientAuthorityRecord(resolved.identity_token, "0.144.1");
      const index = writePrivateCodexClientAuthorityProof(fleetDir, client);
      const proofPath = join(fleetDir, CODEX_CLIENT_AUTHORITY_PROOF_NAME);
      const bytes = readFileSync(proofPath);
      expect(index).toEqual({
        name: CODEX_CLIENT_AUTHORITY_PROOF_NAME,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(JSON.parse(bytes.toString("utf8"))).toEqual(client);
      expect(() => writePrivateCodexClientAuthorityProof(fleetDir, client)).toThrow();
    } finally {
      rmSync(fleetDir, { recursive: true, force: true });
    }
  });

  it("declares report recovery only from the trusted adjacent durable marker", () => {
    const reportsDir = mkdtempSync(join(tmpdir(), "af-fleet-recovered-"));
    const reportPath = join(reportsDir, "report.md");
    const markerPath = join(reportsDir, "report.initial-report.txt");
    try {
      writeFileSync(reportPath, "accepted\n");
      expect(pureFleetReportWasRecovered(reportPath, reportsDir)).toBe(false);
      writeFileSync(join(reportsDir, "report.initial.md"), "legacy discoverable marker\n");
      expect(pureFleetReportWasRecovered(reportPath, reportsDir)).toBe(false);
      writeFileSync(markerPath, "rejected initial response\n");
      expect(pureFleetReportWasRecovered(reportPath, reportsDir)).toBe(true);
    } finally {
      rmSync(reportsDir, { recursive: true, force: true });
    }
  });
});

it("renders a closed fleet manifest in deterministic planned order", () => {
  const later = { planned_index: 1, seed: 101, status: "verified" };
  const earlier = { planned_index: 0, seed: 100, status: "verified" };
  const rendered = renderClosedFleetManifest([later, earlier]);
  expect(rendered.trim().split("\n").map(JSON.parse)).toEqual([earlier, later]);
  expect(rendered.endsWith("\n")).toBe(true);
});

it("rejects incomplete or noncontiguous closed manifest rows", () => {
  expect(() =>
    renderClosedFleetManifest([{ planned_index: 1, seed: 101, status: "verified" }]),
  ).toThrow(/contiguous from zero/i);
  expect(() =>
    renderClosedFleetManifest([
      { planned_index: 0, seed: 100, status: "verified" },
      { planned_index: 2, seed: 102, status: "verified" },
    ]),
  ).toThrow(/contiguous from zero/i);
  const sparse = new Array(2);
  sparse[0] = { planned_index: 0, seed: 100, status: "verified" };
  expect(() => renderClosedFleetManifest(sparse)).toThrow(/complete nonempty row set/i);
});

it("atomically locks a same-stamp report namespace across labels and model plans", () => {
  const reportsDir = mkdtempSync(join(tmpdir(), "af-fleet-lock-"));
  const stamp = "20260716T120000Z";
  const haikuRuns = [
    { seed: 100, model: "haiku", target: "overworld" },
    { seed: 101, model: "haiku", target: "overworld" },
  ];
  const sonnetRuns = haikuRuns.map((run) => ({ ...run, model: "sonnet" }));
  try {
    const haikuSpec = fleetReportLockSpec(reportsDir, stamp, haikuRuns);
    const sonnetSpec = fleetReportLockSpec(reportsDir, stamp, sonnetRuns);
    expect(haikuSpec.path).toBe(sonnetSpec.path);
    expect(haikuSpec.identity.model_plan).not.toEqual(sonnetSpec.identity.model_plan);

    const lock = acquireFleetReportLock(reportsDir, stamp, haikuRuns);
    expect(existsSync(lock.path)).toBe(true);
    expect(() => acquireFleetReportLock(reportsDir, stamp, sonnetRuns)).toThrow(/already locked/i);
    releaseFleetReportLock(lock);
    expect(existsSync(lock.path)).toBe(false);

    const reacquired = acquireFleetReportLock(reportsDir, stamp, sonnetRuns);
    releaseFleetReportLock(reacquired);
  } finally {
    rmSync(reportsDir, { recursive: true, force: true });
  }
});

describe("fleet labels", () => {
  it("accepts one bounded safe path segment", () => {
    expect(validateFleetLabel("slice-v1.2_candidate")).toBe("slice-v1.2_candidate");
    expect(parseFleetArgs(["--label", "slice-v1.2_candidate"]).label).toBe("slice-v1.2_candidate");
  });

  it.each([
    "",
    ".",
    "..",
    "../escape",
    "a/b",
    "a\\b",
    ".hidden",
    "release.",
    "CON",
    "con.txt",
    "NUL.json",
    "COM1",
    "lpt9.log",
    "a".repeat(81),
  ])("rejects unsafe label %j", (label) => {
    expect(() => parseFleetArgs(["--label", label])).toThrow(/one non-reserved 1-80 character/i);
  });
});

it("keeps the live cohort duplicate override out of structural mock fleets", () => {
  expect(() => parseFleetArgs(["--mock", "--allow-duplicate-cohort", "a".repeat(64)])).toThrow(
    /only to live pure cohorts/i,
  );
});

it("allows programmatic structural plans that omit the live-only override field", () => {
  const opts = parseFleetArgs(["--mock"]);
  delete (opts as { allowDuplicateCohort?: string | null }).allowDuplicateCohort;
  expect(() => planFleetRuns(opts)).not.toThrow();
});

describe("parseFleetArgs numeric validation", () => {
  it("rejects --count 0 (would otherwise be vacuous success)", () => {
    expect(() => parseFleetArgs(["--count", "0"])).toThrow();
  });
  it("rejects a non-numeric --count", () => {
    expect(() => parseFleetArgs(["--count", "abc"])).toThrow();
  });
  it("rejects --concurrency 0", () => {
    expect(() => parseFleetArgs(["--concurrency", "0"])).toThrow();
  });
  it("rejects a non-integer --concurrency", () => {
    expect(() => parseFleetArgs(["--concurrency", "1.5"])).toThrow();
  });
  it("rejects a negative --max-retries", () => {
    expect(() => parseFleetArgs(["--max-retries", "-1"])).toThrow();
  });
  it("rejects a non-integer --seed-base", () => {
    expect(() => parseFleetArgs(["--seed-base", "NaN"])).toThrow();
  });
  it("accepts the sensible-minimum boundary values", () => {
    expect(() =>
      parseFleetArgs(["--count", "1", "--concurrency", "1", "--max-retries", "0"]),
    ).not.toThrow();
  });

  it("accepts the last two distinct safe seeds and rejects an unsafe final seed", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const edge = parseFleetArgs(["--count", "2", "--seed-base", String(max - 1)]);
    expect(planFleetRuns(edge).map((run: { seed: number }) => run.seed)).toEqual([max - 1, max]);
    expect(() => parseFleetArgs(["--count", "2", "--seed-base", String(max)])).toThrow(
      /seed range.*safe integers/i,
    );
    expect(() => parseFleetArgs(["--seed-base", String(max + 1)])).toThrow(/safe integer/i);
  });

  it("rechecks safe seed uniqueness for programmatic plans", () => {
    const opts = parseFleetArgs(["--count", "1", "--seed-base", String(Number.MAX_SAFE_INTEGER)]);
    opts.count = 2;
    expect(() => planFleetRuns(opts)).toThrow(/seed range.*safe integers/i);
  });
});
