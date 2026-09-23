import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs module without type declarations
import { fillPrompt } from "../../blind-tester/fill-prompt.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { publishRegularArtifact } from "../../blind-tester/publish-artifact.mjs";
import { useCleanTrackedGitCheckout } from "./support/clean_git_checkout.js";

/**
 * The codex catalog, which is now where per-model transport lives.
 *
 * These contract tests used to assert that blind-tester/run.sh CONTAINED literal model
 * ids, prompt filenames, contract ids and vendor catalog paths. That checked the right
 * guarantee against the wrong file: those facts moved into the catalog, and asserting
 * them here against the catalog (plus checking run.sh threads them through from the
 * resolver) verifies the configuration a launch will actually use, not the presence of
 * a string in a script.
 */
interface CodexCatalogModel {
  id: string;
  certified?: boolean;
  transport?: {
    kind: "direct_mcp" | "code_mode";
    contract: string;
    requiredCliVersion?: string;
    promptTemplate?: string;
    playerCatalog?: string;
    fragment?: string;
  };
}

function readCodexCatalog(): CodexCatalogModel[] {
  const raw = readFileSync(join(process.cwd(), "blind-tester", "catalogs", "codex.json"), "utf8");
  return (JSON.parse(raw) as { models: CodexCatalogModel[] }).models;
}

function codexCatalogModel(id: string): CodexCatalogModel {
  const model = readCodexCatalog().find((candidate) => candidate.id === id);
  if (!model) throw new Error(`codex catalog has no model "${id}"`);
  return model;
}

const CODEX_LOGIN_FILENAME = ["auth", ".json"].join("");
const RETIRED_CLAUDE_LOGIN_FILENAME = [".credentials", ".json"].join("");
const RETIRED_CLAUDE_OAUTH_FIELD = ["claude", "AiOauth"].join("");
const RETIRED_HOME_COMMAND = ["prepare", "-home"].join("");
const RETIRED_SOURCE_OPTION = ["--source", "-auth"].join("");
const RETIRED_PERMISSION_MODE = ["bypass", "Permissions"].join("");
const SPARK_PLAYER_INSTRUCTIONS =
  "You are an autonomous first-time player of an AdventureForge text TTRPG. " +
  "Follow the user play request. Use only preloaded AdventureForge gameplay functions and " +
  "exact current player-visible values. Never use coding, planning, search, or MCP resource tools.";

interface DirectModelCatalog {
  models: Array<{
    slug: string;
    display_name: string;
    description: string;
    default_reasoning_level: string;
    supported_reasoning_levels: Array<{ effort: string; description: string }>;
    shell_type: string;
    visibility: string;
    supported_in_api: boolean;
    priority: number;
    availability_nux: null;
    upgrade: null;
    base_instructions: string;
    model_messages: null;
    include_skills_usage_instructions: boolean;
    support_verbosity: boolean;
    default_verbosity: string | null;
    apply_patch_tool_type: null;
    truncation_policy: { mode: string; limit: number };
    supports_parallel_tool_calls: boolean;
    supports_image_detail_original: boolean;
    context_window: number;
    auto_compact_token_limit: number | null;
    comp_hash: string;
    experimental_supported_tools: unknown[];
    supports_search_tool: boolean;
    use_responses_lite: boolean;
    tool_mode: string;
    multi_agent_version: string | null;
  }>;
}

interface PurePreflightTripwire {
  home: string;
  providerMarker: string;
  selected: string;
  versionMarker: string;
}

function bashPath(path: string): string {
  return path
    .replace(/^([A-Za-z]):\\/u, (_match, drive: string) => `/${drive.toLowerCase()}/`)
    .replaceAll("\\", "/");
}

function installPurePreflightTripwire(root: string): PurePreflightTripwire {
  const home = join(root, "codex-home");
  const selected = join(root, "preflight-tripwire-codex");
  const versionMarker = join(root, "selected-binary-version.txt");
  const providerMarker = join(root, "provider-exec.txt");
  mkdirSync(home);
  writeFileSync(
    selected,
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf 'version\\n' >> "\${FAKE_VERSION_MARKER}"
  probe=0
  if [[ -n "\${FAKE_PROBE_COUNT:-}" ]]; then
    if [[ -f "\${FAKE_PROBE_COUNT}" ]]; then read -r probe < "\${FAKE_PROBE_COUNT}"; fi
    probe=$((probe + 1))
    printf '%s' "\${probe}" > "\${FAKE_PROBE_COUNT}"
  fi
  if [[ -n "\${FAKE_DRIFT_TARGET:-}" && "\${probe}" == "\${FAKE_DRIFT_ON_PROBE:-0}" ]]; then
    printf '\\ntracked setup drift\\n' >> "\${FAKE_DRIFT_TARGET}"
  fi
  printf 'codex-cli 0.146.0\\n'
  exit 0
fi
printf 'provider-exec\\n' > "\${FAKE_PROVIDER_MARKER}"
exit 93
`,
    "utf8",
  );
  chmodSync(selected, 0o755);
  return { home, providerMarker, selected, versionMarker };
}

function launchPureTripwire(
  checkout: string,
  tripwire: PurePreflightTripwire,
  out: string,
  extraEnv: NodeJS.ProcessEnv = {},
  extraArgs: string[] = [],
) {
  return spawnSync(
    process.execPath,
    ["blind-tester/blind-launch.mjs", "--out", out, ...extraArgs],
    {
      cwd: checkout,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        CODEX_HOME: tripwire.home,
        BLIND_CODEX_BIN: bashPath(tripwire.selected),
        BLIND_CODEX_TEST_SCRIPT_CLIENT: "1",
        FAKE_PROVIDER_MARKER: bashPath(tripwire.providerMarker),
        FAKE_VERSION_MARKER: bashPath(tripwire.versionMarker),
        ...extraEnv,
      },
      timeout: 30_000,
    },
  );
}

function expectNoOutputArtifacts(out: string): void {
  const directory = dirname(out);
  if (!existsSync(directory)) return;
  const ownedPrefix = `${basename(out)}.`;
  expect(readdirSync(directory).filter((name) => name.startsWith(ownedPrefix))).toEqual([]);
}

function expectRejectedBeforeSelectedBinary(
  result: ReturnType<typeof spawnSync>,
  tripwire: PurePreflightTripwire,
  out: string,
): void {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
  expect(result.status, output).toBe(4);
  expect(output).toContain(
    "Pure blind runs require a clean tracked worktree; no provider was launched.",
  );
  expect(existsSync(tripwire.versionMarker)).toBe(false);
  expect(existsSync(tripwire.providerMarker)).toBe(false);
  expectNoOutputArtifacts(out);
}

function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env });
  expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
  return result;
}

describe("blind runner MCP config contract", () => {
  const cleanGit = useCleanTrackedGitCheckout();

  it("resolves caller-relative report prefixes before entering the isolated provider cwd", () => {
    const runner = readFileSync(join(process.cwd(), "blind-tester", "run.sh"), "utf8");

    const normalization = runner.indexOf('OUT="$GAME_DIR/$OUT"');
    const providerReportArg = runner.indexOf('CODEX_REPORT_ARG="$(node_path_arg "$OUT.md")"');
    expect(runner).toContain('elif ! is_absolute_output_prefix "$OUT"; then');
    expect(normalization).toBeGreaterThan(0);
    expect(providerReportArg).toBeGreaterThan(normalization);
  });

  it("canonicalizes one relative linked Codex home before the provider cwd switch", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-codex-cli-owned-home-"));
    const bin = join(dir, "bin");
    const home = join(dir, "codex-home");
    const linkedHome = join(dir, "linked-codex-home");
    const capture = join(dir, "codex-invocation.txt");
    const fallbackCapture = join(dir, "fallback-invocation.txt");
    const relativeDirectory = `.tmp/blind-relative-out-${process.pid}-${Date.now()}`;
    const relativeOut = `${relativeDirectory}/attempt`;
    const auth = join(home, CODEX_LOGIN_FILENAME);
    const authBytes = '{"sentinel":"runner-must-not-copy-or-rewrite"}\n';
    const bashPath = (path: string): string =>
      path
        .replace(/^([A-Za-z]):\\/u, (_match, drive: string) => `/${drive.toLowerCase()}/`)
        .replaceAll("\\", "/");
    const comparablePath = (path: string): string =>
      path
        .replace(/^\/([A-Za-z])\//u, "$1:/")
        .replaceAll("\\", "/")
        .toLowerCase();

    try {
      mkdirSync(bin);
      mkdirSync(home);
      symlinkSync(home, linkedHome, "junction");
      writeFileSync(auth, authBytes);
      const fakeCodex = join(dir, "selected codex");
      writeFileSync(
        fakeCodex,
        `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf 'phase=version\\nhome=%s\\n' "\${CODEX_HOME:-}" >> "\${FAKE_CODEX_CAPTURE}"
  printf 'codex-cli 0.146.0\\n'
  exit 0
fi
{
  printf 'phase=exec\\n'
  printf 'home=%s\\n' "\${CODEX_HOME:-}"
  printf 'arg=%s\\n' "$@"
} >> "\${FAKE_CODEX_CAPTURE}"
exit 93
`,
        "utf8",
      );
      chmodSync(fakeCodex, 0o755);
      const fallbackCodex = join(bin, "codex");
      writeFileSync(
        fallbackCodex,
        `#!/usr/bin/env bash
printf 'fallback-used\\n' > "\${FAKE_FALLBACK_CAPTURE}"
printf 'codex-cli 9.9.9\\n'
exit 0
`,
        "utf8",
      );
      chmodSync(fallbackCodex, 0o755);

      const result = spawnSync(
        process.execPath,
        ["blind-tester/blind-launch.mjs", "--out", relativeOut],
        {
          cwd: cleanGit.path,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
            CODEX_HOME: relative(cleanGit.path, linkedHome).replaceAll("\\", "/"),
            BLIND_CODEX_BIN: bashPath(fakeCodex),
            BLIND_CODEX_TEST_SCRIPT_CLIENT: "1",
            FAKE_CODEX_CAPTURE: bashPath(capture),
            FAKE_FALLBACK_CAPTURE: bashPath(fallbackCapture),
          },
          timeout: 30_000,
        },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
      expect(result.status, output).toBe(93);

      const invocation = readFileSync(capture, "utf8").trim().split(/\r?\n/u);
      const activeHomes = invocation
        .filter((line) => line.startsWith("home="))
        .map((line) => line.slice(5));
      const args = invocation
        .filter((line) => line.startsWith("arg="))
        .map((line) => line.slice(4));
      const reportIndex = args.indexOf("--output-last-message");
      const reportPath = args[reportIndex + 1] ?? "";
      expect(invocation.filter((line) => line === "phase=version")).toHaveLength(3);
      expect(invocation.filter((line) => line === "phase=exec")).toHaveLength(1);
      expect(activeHomes).toHaveLength(4);
      expect(activeHomes.map(comparablePath)).toEqual([
        comparablePath(realpathSync.native(home)),
        comparablePath(realpathSync.native(home)),
        comparablePath(realpathSync.native(home)),
        comparablePath(realpathSync.native(home)),
      ]);
      expect(reportIndex).toBeGreaterThan(0);
      expect(reportPath).toMatch(/^(?:\/|[A-Za-z]:[\\/])/u);
      expect(reportPath.replaceAll("\\", "/")).toContain(`/${relativeOut}.md`);
      expect(args).toContain("--ignore-user-config");
      expect(args).toContain("--ignore-rules");
      expect(args).toContain("project_doc_max_bytes=0");
      expect(existsSync(fallbackCapture)).toBe(false);
      expect(readFileSync(auth, "utf8")).toBe(authBytes);
    } finally {
      rmSync(join(cleanGit.path, relativeDirectory), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed when the bounded final client probe differs from launch", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-codex-final-version-drift-"));
    const home = join(dir, "home");
    const selected = join(dir, "selected-codex");
    const probeCount = join(dir, "probe-count.txt");
    const out = join(dir, "reports", "attempt");
    const bashPath = (path: string): string =>
      path
        .replace(/^([A-Za-z]):\\/u, (_match, drive: string) => `/${drive.toLowerCase()}/`)
        .replaceAll("\\", "/");
    try {
      mkdirSync(home);
      writeFileSync(
        selected,
        `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  count=0
  [[ -f "\${PROBE_COUNT}" ]] && count="$(cat "\${PROBE_COUNT}")"
  count=$((count + 1))
  printf '%s' "$count" > "\${PROBE_COUNT}"
  if [[ "$count" -lt 3 ]]; then
    printf 'codex-cli 0.146.0\\n'
  else
    printf 'codex-cli 0.147.0\\n'
  fi
  exit 0
fi
exit 93
`,
      );
      chmodSync(selected, 0o755);
      const result = spawnSync(process.execPath, ["blind-tester/blind-launch.mjs", "--out", out], {
        cwd: cleanGit.path,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: home,
          BLIND_CODEX_BIN: bashPath(selected),
          BLIND_CODEX_TEST_SCRIPT_CLIENT: "1",
          PROBE_COUNT: bashPath(probeCount),
        },
        timeout: 30_000,
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
      expect(result.status, output).toBe(42);
      expect(output).toContain("expected cli=0.146.0");
      expect(output).toContain("observed cli=0.147.0");
      expect(readFileSync(probeCount, "utf8")).toBe("3");
      expect(existsSync(`${out}.md`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("preserves caller errexit state so a post-probe capture failure reaches mapped diagnostics", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-codex-final-probe-errexit-"));
    const home = join(dir, "home");
    const selected = join(dir, "selected-codex");
    const probeCount = join(dir, "probe-count.txt");
    const out = join(dir, "reports", "attempt");
    const bashPath = (path: string): string =>
      path
        .replace(/^([A-Za-z]):\\/u, (_match, drive: string) => `/${drive.toLowerCase()}/`)
        .replaceAll("\\", "/");
    try {
      mkdirSync(home);
      writeFileSync(
        selected,
        `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  count=0
  [[ -f "\${PROBE_COUNT}" ]] && count="$(cat "\${PROBE_COUNT}")"
  printf '%s' "$((count + 1))" > "\${PROBE_COUNT}"
  printf 'codex-cli 0.146.0\\n'
  exit 0
fi
printf '{"type":"thread.started","thread_id":"77777777-7777-4777-8777-777777777777"}\\n'
exit 0
`,
      );
      chmodSync(selected, 0o755);
      const result = spawnSync(process.execPath, ["blind-tester/blind-launch.mjs", "--out", out], {
        cwd: cleanGit.path,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: home,
          BLIND_CODEX_BIN: bashPath(selected),
          BLIND_CODEX_TEST_SCRIPT_CLIENT: "1",
          PROBE_COUNT: bashPath(probeCount),
        },
        timeout: 30_000,
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
      expect(result.status, output).toBe(4);
      expect(readFileSync(probeCount, "utf8")).toBe("3");
      expect(output).toContain("blind run failed (exit 4)");
      expect(output).toContain("telemetry:");
      expect(existsSync(`${out}.md`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("preflight-only validates the selected CLI without resolving or inspecting CODEX_HOME", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-codex-client-preflight-"));
    const bin = join(dir, "bin");
    const homeTripwire = join(dir, "codex-home-is-a-file");
    const selected = join(dir, "selected-codex");
    const selectedCapture = join(dir, "selected-capture.txt");
    const fallbackCapture = join(dir, "fallback-capture.txt");
    const out = join(dir, "reports", "attempt");
    const homeTripwireBytes = "preflight-only must not require this path to be a directory\n";
    const bashPath = (path: string): string =>
      path
        .replace(/^([A-Za-z]):\\/u, (_match, drive: string) => `/${drive.toLowerCase()}/`)
        .replaceAll("\\", "/");

    try {
      mkdirSync(bin);
      writeFileSync(homeTripwire, homeTripwireBytes);
      writeFileSync(
        selected,
        `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf 'version home=%s\\n' "\${CODEX_HOME:-}" >> "\${SELECTED_CAPTURE}"
  printf 'codex-cli 0.146.0\\n'
  exit 0
fi
printf 'gameplay reached\\n' >> "\${SELECTED_CAPTURE}"
exit 0
`,
      );
      chmodSync(selected, 0o755);
      const fallback = join(bin, "codex");
      writeFileSync(
        fallback,
        `#!/usr/bin/env bash
printf 'fallback reached\\n' > "\${FALLBACK_CAPTURE}"
printf 'codex-cli 0.145.0\\n'
exit 0
`,
      );
      chmodSync(fallback, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          "blind-tester/blind-launch.mjs",
          "--preflight-only",
          "--client-authority-json",
          "--model",
          "gpt-5.3-codex-spark",
          "--out",
          out,
        ],
        {
          cwd: cleanGit.path,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
            CODEX_HOME: homeTripwire,
            BLIND_CODEX_BIN: bashPath(selected),
            BLIND_CODEX_TEST_SCRIPT_CLIENT: "1",
            SELECTED_CAPTURE: bashPath(selectedCapture),
            FALLBACK_CAPTURE: bashPath(fallbackCapture),
          },
          timeout: 30_000,
        },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
      expect(result.status, output).toBe(0);
      expect(output).toContain('"cli_version":"0.146.0"');
      expect(output).toContain("selected-codex");
      expect(JSON.parse(result.stdout ?? "")).toMatchObject({
        schema_version: 2,
        launcher_kind: "direct",
        cli_version: "0.146.0",
        test_script: true,
      });
      expect(output).not.toContain("models_cache");
      expect(readFileSync(selectedCapture, "utf8")).toMatch(/^version home=/u);
      expect(readFileSync(selectedCapture, "utf8")).not.toContain("gameplay reached");
      expect(existsSync(fallbackCapture)).toBe(false);
      expect(existsSync(`${out}.md`)).toBe(false);
      expect(existsSync(`${out}.log`)).toBe(false);
      expect(readFileSync(homeTripwire, "utf8")).toBe(homeTripwireBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("requires exact CLI compatibility for every native direct transport", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-spark-cli-compatibility-"));
    const home = join(dir, "home");
    const selected = join(dir, "selected-codex");
    const capture = join(dir, "selected-capture.txt");
    const out = join(dir, "reports", "attempt");
    try {
      mkdirSync(home);
      writeFileSync(
        selected,
        `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf 'version\\n' >> "\${SELECTED_CAPTURE}"
  printf 'codex-cli 0.144.1\\n'
  exit 0
fi
printf 'provider-launch\\n' >> "\${SELECTED_CAPTURE}"
exit 93
`,
        "utf8",
      );
      chmodSync(selected, 0o755);

      // The catalog default is now the strict-code-mode Luna lane, which pins
      // no CLI version, so the direct-transport version gate is exercised by
      // naming Spark explicitly.
      const result = spawnSync(
        process.execPath,
        ["blind-tester/blind-launch.mjs", "--model", "gpt-5.3-codex-spark", "--out", out],
        {
          cwd: cleanGit.path,
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_ENV: "test",
            CODEX_HOME: home,
            BLIND_CODEX_BIN: bashPath(selected),
            BLIND_CODEX_TEST_SCRIPT_CLIENT: "1",
            SELECTED_CAPTURE: bashPath(capture),
          },
          timeout: 30_000,
        },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
      expect(result.status, output).toBe(42);
      expect(output).toContain("spark-direct-mcp-v1 requires exact codex-cli 0.146.0");
      expect(output).toContain("observed cli=0.144.1");
      expect(output).toContain("BLIND_CODEX_BIN");
      expect(readFileSync(capture, "utf8")).toBe("version\n");
      expectNoOutputArtifacts(out);

      const terraResult = spawnSync(
        process.execPath,
        [
          "blind-tester/blind-launch.mjs",
          "--preflight-only",
          "--client-authority-json",
          "--model",
          "gpt-5.6-terra",
          "--out",
          out,
        ],
        {
          cwd: cleanGit.path,
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_ENV: "test",
            CODEX_HOME: home,
            BLIND_CODEX_BIN: bashPath(selected),
            BLIND_CODEX_TEST_SCRIPT_CLIENT: "1",
            SELECTED_CAPTURE: bashPath(capture),
          },
          timeout: 30_000,
        },
      );
      const terraOutput = `${terraResult.stdout ?? ""}\n${terraResult.stderr ?? ""}\n${terraResult.error?.message ?? ""}`;
      expect(terraResult.status, terraOutput).toBe(42);
      expect(terraOutput).toContain("game-direct-mcp-v1 requires exact codex-cli 0.146.0");
      expect(readFileSync(capture, "utf8")).toBe("version\nversion\n");
      expectNoOutputArtifacts(out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("treats BLIND_CODEX_BIN as one executable path, never a command plus arguments", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-codex-bin-one-argv-"));
    const bin = join(dir, "bin");
    const home = join(dir, "home");
    const selected = join(dir, "selected-codex");
    const selectedCapture = join(dir, "selected-used");
    const fallbackCapture = join(dir, "fallback-used");
    const bashPath = (path: string): string =>
      path
        .replace(/^([A-Za-z]):\\/u, (_match, drive: string) => `/${drive.toLowerCase()}/`)
        .replaceAll("\\", "/");
    try {
      mkdirSync(bin);
      mkdirSync(home);
      writeFileSync(
        selected,
        `#!/usr/bin/env bash
printf used > "\${SELECTED_CAPTURE}"
printf 'codex-cli 0.144.1\\n'
`,
      );
      chmodSync(selected, 0o755);
      const fallback = join(bin, "codex");
      writeFileSync(
        fallback,
        `#!/usr/bin/env bash
printf used > "\${FALLBACK_CAPTURE}"
printf 'codex-cli 0.144.1\\n'
`,
      );
      chmodSync(fallback, 0o755);

      const result = spawnSync(process.execPath, ["blind-tester/blind-launch.mjs"], {
        cwd: cleanGit.path,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          CODEX_HOME: home,
          BLIND_CODEX_BIN: `${bashPath(selected)} --version`,
          SELECTED_CAPTURE: bashPath(selectedCapture),
          FALLBACK_CAPTURE: bashPath(fallbackCapture),
        },
        timeout: 30_000,
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
      expect(result.status, output).toBe(42);
      expect(output).toContain("selected executable");
      expect(output).toContain("BLIND_CODEX_BIN");
      expect(existsSync(selectedCapture)).toBe(false);
      expect(existsSync(fallbackCapture)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("bounds a hung or noisy selected CLI version probe before gameplay", () => {
    for (const scenario of ["hung", "noisy"] as const) {
      const dir = mkdtempSync(join(tmpdir(), `af-codex-version-${scenario}-`));
      const bin = join(dir, "bin");
      const home = join(dir, "home");
      const selected = join(dir, "selected-codex");
      const selectedCapture = join(dir, "selected-capture");
      const fallbackCapture = join(dir, "fallback-capture");
      const out = join(dir, "reports", "attempt");
      const loginPath = join(home, CODEX_LOGIN_FILENAME);
      const loginBytes = `{"sentinel":"${scenario}-probe-bound"}\n`;
      const bashPath = (path: string): string =>
        path
          .replace(/^([A-Za-z]):\\/u, (_match, drive: string) => `/${drive.toLowerCase()}/`)
          .replaceAll("\\", "/");
      try {
        mkdirSync(bin);
        mkdirSync(home);
        writeFileSync(loginPath, loginBytes);
        writeFileSync(
          selected,
          `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf 'version\\n' >> "\${SELECTED_CAPTURE}"
  if [[ "\${VERSION_SCENARIO}" == "hung" ]]; then
    trap '' TERM
    while :; do sleep 1; done
  fi
  head -c 4096 /dev/zero | tr '\\0' x
  exit 0
fi
printf 'gameplay\\n' >> "\${SELECTED_CAPTURE}"
exit 0
`,
        );
        chmodSync(selected, 0o755);
        const fallback = join(bin, "codex");
        writeFileSync(
          fallback,
          `#!/usr/bin/env bash
printf used > "\${FALLBACK_CAPTURE}"
printf 'codex-cli 0.144.1\\n'
`,
        );
        chmodSync(fallback, 0o755);

        const startedAt = Date.now();
        const result = spawnSync(
          process.execPath,
          ["blind-tester/blind-launch.mjs", "--model", "gpt-5.3-codex-spark", "--out", out],
          {
            cwd: cleanGit.path,
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
              CODEX_HOME: home,
              BLIND_CODEX_BIN: bashPath(selected),
              BLIND_CODEX_TEST_SCRIPT_CLIENT: "1",
              SELECTED_CAPTURE: bashPath(selectedCapture),
              FALLBACK_CAPTURE: bashPath(fallbackCapture),
              VERSION_SCENARIO: scenario,
            },
            timeout: 15_000,
          },
        );
        const elapsed = Date.now() - startedAt;
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
        expect(result.status, `${scenario}: ${output}`).toBe(42);
        expect(elapsed, scenario).toBeLessThan(12_000);
        expect(output.length, scenario).toBeLessThan(5_000);
        expect(readFileSync(selectedCapture, "utf8"), scenario).toBe("version\n");
        expect(existsSync(fallbackCapture), scenario).toBe(false);
        expect(existsSync(`${out}.log`), scenario).toBe(false);
        expect(output, scenario).not.toContain("Blind playtest");
        expect(readFileSync(loginPath, "utf8"), scenario).toBe(loginBytes);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it("rejects pure and structural output prefixes inside an existing CODEX_HOME", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-codex-output-boundary-"));
    const home = join(dir, "codex-home");
    const auth = join(home, CODEX_LOGIN_FILENAME);
    const authBytes = '{"sentinel":"output-guard"}\n';
    mkdirSync(home);
    writeFileSync(auth, authBytes);
    try {
      for (const modeArgs of [[], ["--mock"]]) {
        const result = spawnSync(
          process.execPath,
          ["blind-tester/blind-launch.mjs", ...modeArgs, "--out", join(home, "reports", "attempt")],
          {
            cwd: cleanGit.path,
            encoding: "utf8",
            env: { ...process.env, CODEX_HOME: home },
            timeout: 30_000,
          },
        );
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
        expect(result.status, `${modeArgs.join(" ")}: ${output}`).toBe(4);
        expect(output).toContain("Report output prefix must remain outside the Codex home");
        expect(output).toContain("no run artifacts were created");
        expect(readdirSync(home), modeArgs.join(" ")).toEqual([CODEX_LOGIN_FILENAME]);
        expect(readFileSync(auth, "utf8"), modeArgs.join(" ")).toBe(authBytes);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("applies the login-home output boundary to the provider that owns the home, not to all", () => {
    // "Never write evidence inside the client's own login home" is a vendor-neutral rule
    // that used to be enforced with a vendor-specific home: every provider's output was
    // checked against `${CODEX_HOME:-$HOME/.codex}`, so a `--provider gemini_cli --mock`
    // run resolved and could die on a Codex home it would never touch. The rule survives;
    // the accident does not. Both halves are asserted together because either one alone
    // could be satisfied by deleting the check.
    const dir = mkdtempSync(join(tmpdir(), "af-client-home-boundary-"));
    const home = join(dir, "codex-home");
    const auth = join(home, CODEX_LOGIN_FILENAME);
    const authBytes = '{"sentinel":"per-provider-guard"}\n';
    mkdirSync(home);
    writeFileSync(auth, authBytes);
    try {
      // codex OWNS this home, so its evidence may not land inside it.
      const owner = spawnSync(
        process.execPath,
        [
          "blind-tester/blind-launch.mjs",
          "--mock",
          "--provider",
          "codex",
          "--out",
          join(home, "reports", "owner"),
        ],
        {
          cwd: cleanGit.path,
          encoding: "utf8",
          env: { ...process.env, CODEX_HOME: home },
          timeout: 120_000,
        },
      );
      const ownerOutput = `${owner.stdout ?? ""}\n${owner.stderr ?? ""}\n${owner.error?.message ?? ""}`;
      expect(owner.status, ownerOutput).toBe(4);
      expect(ownerOutput).toContain("Report output prefix must remain outside the Codex home");
      expect(readdirSync(home)).toEqual([CODEX_LOGIN_FILENAME]);

      // gemini_cli does not own it, declares no state root of its own, and must not be
      // measured against another vendor's login directory.
      const stranger = spawnSync(
        process.execPath,
        [
          "blind-tester/blind-launch.mjs",
          "--mock",
          "--provider",
          "gemini_cli",
          "--out",
          join(home, "reports", "stranger"),
        ],
        {
          cwd: cleanGit.path,
          encoding: "utf8",
          env: { ...process.env, CODEX_HOME: home },
          timeout: 120_000,
        },
      );
      const strangerOutput = `${stranger.stdout ?? ""}\n${stranger.stderr ?? ""}\n${stranger.error?.message ?? ""}`;
      expect(stranger.status, strangerOutput).toBe(0);
      expect(strangerOutput).not.toContain("Report output prefix");
      expect(existsSync(join(home, "reports", "stranger.md"))).toBe(true);
      expect(readFileSync(auth, "utf8")).toBe(authBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it("takes the pure client's executable and override env var from the registry", () => {
    // `BLIND_CODEX_BIN` and the literal `codex` used to be spelled out here, which made
    // the registry's launch block dead data — it described a launch nobody performed. The
    // runner reads both from the resolved provider now, and the registry still declares
    // exactly those two values, so every message and every lookup renders identically.
    // The live preflight tripwire tests in this file all set BLIND_CODEX_BIN and reach
    // the selection, so they only pass while the indirect lookup resolves that name.
    const runner = readFileSync(join(process.cwd(), "blind-tester", "run.sh"), "utf8");
    const registry = JSON.parse(
      readFileSync(join(process.cwd(), "blind-tester", "providers.json"), "utf8"),
    ) as { providers: Array<{ id: string; launch?: Record<string, unknown> }> };
    const codexLaunch = registry.providers.find((p) => p.id === "codex")?.launch;
    expect(codexLaunch?.executable).toBe("codex");
    expect(codexLaunch?.binaryOverrideEnv).toBe("BLIND_CODEX_BIN");

    expect(runner).toContain('if [[ -n "${!PROVIDER_LAUNCH_BINARY_ENV+x}" ]]; then');
    expect(runner).toContain('CODEX_BIN_REQUEST="${!PROVIDER_LAUNCH_BINARY_ENV}"');
    expect(runner).toContain('type -P "$PROVIDER_LAUNCH_EXECUTABLE"');
    // An env var NAME out of a data file reaches indirect expansion, so it is checked
    // against an identifier shape first.
    expect(runner).toContain('"$PROVIDER_LAUNCH_BINARY_ENV" =~ ^[A-Za-z_][A-Za-z0-9_]*$');
    expect(runner).not.toContain('"${BLIND_CODEX_BIN+x}"');
    expect(runner).not.toContain("type -P codex");
  });

  it("rejects directory and dot-segment output forms before suffixes can enter CODEX_HOME", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-codex-output-lexical-boundary-"));
    const home = join(dir, "codex-home");
    const auth = join(home, CODEX_LOGIN_FILENAME);
    const authBytes = '{"sentinel":"lexical-output-guard"}\n';
    mkdirSync(home);
    writeFileSync(auth, authBytes);
    const portableHome = home.replaceAll("\\", "/");
    try {
      for (const unsafeOut of [
        `${portableHome}/`,
        `${portableHome}/.`,
        `${portableHome}/scratch/../..`,
      ]) {
        const result = spawnSync(
          process.execPath,
          ["blind-tester/blind-launch.mjs", "--out", unsafeOut],
          {
            cwd: cleanGit.path,
            encoding: "utf8",
            env: { ...process.env, CODEX_HOME: home },
            timeout: 30_000,
          },
        );
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
        expect(result.status, `${unsafeOut}: ${output}`).toBe(4);
        expect(output).toContain("must name a file prefix");
        expect(output).toContain("no run artifacts were created");
        expect(readdirSync(home), unsafeOut).toEqual([CODEX_LOGIN_FILENAME]);
        expect(readFileSync(auth, "utf8"), unsafeOut).toBe(authBytes);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects an NTFS alternate-stream-shaped prefix before creating artifacts", () => {
    if (process.platform !== "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "af-codex-output-ads-boundary-"));
    const home = join(dir, "codex-home");
    const auth = join(home, CODEX_LOGIN_FILENAME);
    const authBytes = '{"sentinel":"ads-output-guard"}\n';
    mkdirSync(home);
    writeFileSync(auth, authBytes);
    try {
      const result = spawnSync(
        process.execPath,
        ["blind-tester/blind-launch.mjs", "--mock", "--out", `${home}:audit`],
        {
          cwd: cleanGit.path,
          encoding: "utf8",
          env: { ...process.env, CODEX_HOME: home },
          timeout: 30_000,
        },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
      expect(result.status, output).toBe(4);
      expect(output).toContain("must not name a Windows alternate data stream");
      expect(output).toContain("no run artifacts were created");
      expect(readdirSync(home)).toEqual([CODEX_LOGIN_FILENAME]);
      expect(readFileSync(auth, "utf8")).toBe(authBytes);
      expect(readdirSync(dir)).toEqual(["codex-home"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("launches the MCP server cwd-independently on every platform", () => {
    const runner = readFileSync(join(process.cwd(), "blind-tester", "run.sh"), "utf8");

    expect(runner).toContain('"command": "cmd.exe"');
    expect(runner).toContain("cd /d");
    expect(runner).toContain('"command": "npm"');
    // npm --prefix makes npm itself cd to the game dir. The config must NOT rely
    // on a `cwd` field: native Windows CLIs can ignore stdio-server
    // cwd, so the server would inherit the agent's isolated temp cwd and die
    // ("Missing script: mcp") — tools never load and the report is rejected.
    expect(runner).toContain('"args": ["--silent", "--prefix", "$GAME_DIR_MCP", "run", "mcp"');
    expect(runner).not.toContain('"cwd":');
    // Native Windows (Git Bash) must hand the native path form to the provider.
    expect(runner).toContain("cygpath -m");
    expect(runner).not.toContain('"command": "bash"');
    expect(runner).not.toContain('"command": "wsl.exe"');
  });

  it("forwards spectate mode to the server as argv (clients may ignore env/cwd)", () => {
    const runner = readFileSync(join(process.cwd(), "blind-tester", "run.sh"), "utf8");
    expect(runner).toContain("--spectate");
    expect(runner).toContain("--spectate-delay-ms");
    // The launcher shim keeps `npm run blind` off the WSL System32 bash trap.
    const pkg = readFileSync(join(process.cwd(), "package.json"), "utf8");
    expect(pkg).toContain('"blind": "node blind-tester/blind-launch.mjs"');
  });

  it("binds every MCP launch form to runner-owned seed and Git provenance", () => {
    const runner = readFileSync(join(process.cwd(), "blind-tester", "run.sh"), "utf8");
    expect(runner).toContain("--run-seed");
    expect(runner).toContain("--build-commit");
    expect(runner).toContain("--tracked-worktree-clean");
    expect(runner).toContain("RUN_PROVENANCE_ARGS_JSON");
    expect(runner).toContain("RUN_PROVENANCE_CMD_SUFFIX");
    expect(runner).toContain("cmd.exe metacharacter");
    expect(runner).toContain('git --git-dir="$GAME_DIR/.git" --work-tree="$GAME_DIR"');
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ]) {
      expect(runner).toContain(`-u ${key}`);
    }
    expect(runner).toContain("game_git ls-files -v -z --");
    expect(runner).toContain("S|[a-z]) found=true");
    expect(runner).toContain("game_git diff --quiet --no-ext-diff --no-textconv");
    expect(runner).toContain("game_git diff --cached --quiet --no-ext-diff --no-textconv");
    expect(runner).not.toContain("git status --porcelain");

    const initialGuard = runner.indexOf(
      'if [[ "$PLAY_MODE" == "pure" && "$TRACKED_WORKTREE_CLEAN" != "true" ]]',
    );
    expect(initialGuard).toBeGreaterThan(0);
    expect(initialGuard).toBeLessThan(runner.indexOf('ACTIVE_CLIENT_HOME=""'));
    expect(initialGuard).toBeLessThan(runner.indexOf('SELECTED_CODEX_BIN=""'));

    const gameplaySpawn = runner.indexOf('printf "%s" "$PROMPT" | "$NODE_CMD"');
    const finalClientProbe = runner.lastIndexOf("if ! preflight_codex_client 1", gameplaySpawn);
    const preSpawnProvenance = runner.indexOf(
      "if ! assert_launch_provenance_unchanged",
      finalClientProbe,
    );
    expect(finalClientProbe).toBeGreaterThan(initialGuard);
    expect(preSpawnProvenance).toBeGreaterThan(finalClientProbe);
    expect(preSpawnProvenance).toBeLessThan(gameplaySpawn);
  });

  it("emits canonical private provenance while ignoring untracked files", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-blind-provenance-"));
    const out = join(dir, "capture");
    const untracked = join(
      cleanGit.path,
      `.af-untracked-provenance-${process.pid}-${Date.now()}.tmp`,
    );
    try {
      writeFileSync(untracked, "untracked provenance fixture\n", "utf8");
      const result = spawnSync(
        process.execPath,
        ["blind-tester/blind-launch.mjs", "--mock", "--seed", "-17", "--out", out],
        {
          cwd: cleanGit.path,
          encoding: "utf8",
          env: {
            ...process.env,
            BLIND_MOCK_AGENT_CMD: 'cat "$BLIND_MCP_CONFIG"; exit 93',
            BLIND_PERSONA: "default",
          },
          timeout: 30_000,
        },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
      expect(result.status, output).toBe(93);

      const config = JSON.parse(readFileSync(`${out}.md`, "utf8")) as {
        mcpServers: { adventureforge: { args: string[] } };
      };
      const args = config.mcpServers.adventureforge.args;
      const valueAfter = (flag: string) => args[args.indexOf(flag) + 1];

      const head = spawnSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
        cwd: cleanGit.path,
        encoding: "utf8",
      });
      expect(head.status).toBe(0);
      const unstaged = spawnSync(
        "git",
        ["diff", "--quiet", "--ignore-submodules=untracked", "--"],
        { cwd: cleanGit.path },
      );
      const staged = spawnSync(
        "git",
        ["diff", "--cached", "--quiet", "--ignore-submodules=untracked", "--"],
        { cwd: cleanGit.path },
      );
      const expectedClean = unstaged.status === 0 && staged.status === 0;

      expect(valueAfter("--run-seed")).toBe("-17");
      expect(valueAfter("--build-commit")).toBe(head.stdout.trim());
      expect(valueAfter("--tracked-worktree-clean")).toBe(String(expectedClean));
    } finally {
      rmSync(untracked, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects staged pure and fleet preflight before client execution while structural QA stays available", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-pure-staged-preflight-"));
    const tripwire = installPurePreflightTripwire(dir);
    const pureOut = join(dir, "pure", "attempt");
    const fleetOut = join(dir, "fleet", "attempt");
    const structuralOut = join(dir, "structural", "attempt");
    const structuralMarker = join(dir, "structural-launch.txt");
    const fixtureName = `.af-pure-clean-preflight-${process.pid}-${Date.now()}`;
    const untracked = join(cleanGit.path, `${fixtureName}.tmp`);
    const ignored = join(cleanGit.path, "ai-runs", `${fixtureName}.tmp`);
    let indexRestored = false;
    try {
      writeFileSync(untracked, "untracked files are outside tracked provenance\n", "utf8");
      mkdirSync(join(cleanGit.path, "ai-runs"), { recursive: true });
      writeFileSync(ignored, "ignored files are outside tracked provenance\n", "utf8");
      expect(
        spawnSync("git", ["check-ignore", "-q", "--", ignored], {
          cwd: cleanGit.path,
        }).status,
      ).toBe(0);

      runGit(cleanGit.path, ["update-index", "--force-remove", "--", "AGENTS.md"]);
      expectRejectedBeforeSelectedBinary(
        launchPureTripwire(cleanGit.path, tripwire, pureOut),
        tripwire,
        pureOut,
      );
      expectRejectedBeforeSelectedBinary(
        launchPureTripwire(cleanGit.path, tripwire, fleetOut, {}, ["--preflight-only"]),
        tripwire,
        fleetOut,
      );

      const structural = spawnSync(
        process.execPath,
        ["blind-tester/blind-launch.mjs", "--mock", "--out", structuralOut],
        {
          cwd: cleanGit.path,
          encoding: "utf8",
          env: {
            ...process.env,
            BLIND_MOCK_AGENT_CMD:
              'printf structural-launch > "$STRUCTURAL_LAUNCH"; cat "$BLIND_MCP_CONFIG"; exit 93',
            STRUCTURAL_LAUNCH: bashPath(structuralMarker),
          },
          timeout: 30_000,
        },
      );
      const structuralOutput = `${structural.stdout ?? ""}\n${structural.stderr ?? ""}\n${structural.error?.message ?? ""}`;
      expect(structural.status, structuralOutput).toBe(93);
      expect(readFileSync(structuralMarker, "utf8")).toBe("structural-launch");
      const structuralConfig = JSON.parse(readFileSync(`${structuralOut}.md`, "utf8")) as {
        mcpServers: { adventureforge: { args: string[] } };
      };
      const structuralArgs = structuralConfig.mcpServers.adventureforge.args;
      expect(structuralArgs[structuralArgs.indexOf("--tracked-worktree-clean") + 1]).toBe("false");

      const smoke = spawnSync(process.execPath, ["blind-tester/blind-launch.mjs", "--smoke"], {
        cwd: cleanGit.path,
        encoding: "utf8",
        env: { ...process.env },
        timeout: 30_000,
      });
      const smokeOutput = `${smoke.stdout ?? ""}\n${smoke.stderr ?? ""}\n${smoke.error?.message ?? ""}`;
      expect(smoke.status, smokeOutput).toBe(0);

      runGit(cleanGit.path, ["read-tree", "HEAD"]);
      indexRestored = true;
      const allowed = launchPureTripwire(cleanGit.path, tripwire, join(dir, "allowed", "attempt"));
      const allowedOutput = `${allowed.stdout ?? ""}\n${allowed.stderr ?? ""}\n${allowed.error?.message ?? ""}`;
      expect(allowed.status, allowedOutput).toBe(93);
      expect(existsSync(tripwire.versionMarker)).toBe(true);
      expect(existsSync(tripwire.providerMarker)).toBe(true);
    } finally {
      if (!indexRestored) runGit(cleanGit.path, ["read-tree", "HEAD"]);
      rmSync(untracked, { force: true });
      rmSync(ignored, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("rejects ordinary unstaged tracked bytes before selected-client execution", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-pure-unstaged-preflight-"));
    const tripwire = installPurePreflightTripwire(dir);
    const out = join(dir, "reports", "attempt");
    const target = join(cleanGit.path, "AGENTS.md");
    const original = readFileSync(target, "utf8");
    try {
      writeFileSync(target, `${original}\nunstaged provenance fixture\n`, "utf8");
      expectRejectedBeforeSelectedBinary(
        launchPureTripwire(cleanGit.path, tripwire, out),
        tripwire,
        out,
      );
    } finally {
      writeFileSync(target, original, "utf8");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects modified assume-unchanged tracked bytes before selected-client execution", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-pure-assume-unchanged-"));
    const tripwire = installPurePreflightTripwire(dir);
    const out = join(dir, "reports", "attempt");
    const target = join(cleanGit.path, "AGENTS.md");
    const original = readFileSync(target, "utf8");
    try {
      runGit(cleanGit.path, ["update-index", "--assume-unchanged", "--", "AGENTS.md"]);
      writeFileSync(target, `${original}\nassume-unchanged provenance fixture\n`, "utf8");
      expectRejectedBeforeSelectedBinary(
        launchPureTripwire(cleanGit.path, tripwire, out),
        tripwire,
        out,
      );
    } finally {
      writeFileSync(target, original, "utf8");
      runGit(cleanGit.path, ["update-index", "--no-assume-unchanged", "--", "AGENTS.md"]);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects modified skip-worktree tracked bytes before selected-client execution", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-pure-skip-worktree-"));
    const tripwire = installPurePreflightTripwire(dir);
    const out = join(dir, "reports", "attempt");
    const target = join(cleanGit.path, "AGENTS.md");
    const original = readFileSync(target, "utf8");
    try {
      runGit(cleanGit.path, ["update-index", "--skip-worktree", "--", "AGENTS.md"]);
      writeFileSync(target, `${original}\nskip-worktree provenance fixture\n`, "utf8");
      expectRejectedBeforeSelectedBinary(
        launchPureTripwire(cleanGit.path, tripwire, out),
        tripwire,
        out,
      );
    } finally {
      writeFileSync(target, original, "utf8");
      runGit(cleanGit.path, ["update-index", "--no-skip-worktree", "--", "AGENTS.md"]);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("ignores hostile Git repository redirection and checks the script checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-pure-hostile-git-env-"));
    const tripwire = installPurePreflightTripwire(dir);
    const out = join(dir, "reports", "attempt");
    const hostile = join(dir, "hostile-clean-repo");
    const target = join(cleanGit.path, "AGENTS.md");
    const original = readFileSync(target, "utf8");
    try {
      mkdirSync(hostile);
      runGit(hostile, ["init"]);
      writeFileSync(join(hostile, "sentinel.txt"), "clean hostile repository\n", "utf8");
      runGit(hostile, ["add", "sentinel.txt"]);
      runGit(hostile, [
        "-c",
        "user.name=AdventureForge test",
        "-c",
        "user.email=tests@example.invalid",
        "commit",
        "--no-gpg-sign",
        "-m",
        "clean hostile repository",
      ]);
      writeFileSync(target, `${original}\nhostile Git environment fixture\n`, "utf8");
      expectRejectedBeforeSelectedBinary(
        launchPureTripwire(cleanGit.path, tripwire, out, {
          GIT_DIR: bashPath(join(hostile, ".git")),
          GIT_WORK_TREE: bashPath(hostile),
          GIT_INDEX_FILE: bashPath(join(hostile, ".git", "index")),
          GIT_COMMON_DIR: bashPath(join(hostile, ".git")),
          GIT_OBJECT_DIRECTORY: bashPath(join(hostile, ".git", "objects")),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: bashPath(join(hostile, ".git", "objects")),
        }),
        tripwire,
        out,
      );
    } finally {
      writeFileSync(target, original, "utf8");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("rechecks provenance after setup and before the gameplay process", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-pure-setup-drift-"));
    const tripwire = installPurePreflightTripwire(dir);
    const out = join(dir, "reports", "attempt");
    const target = join(cleanGit.path, "AGENTS.md");
    const original = readFileSync(target, "utf8");
    const probeCount = join(dir, "probe-count.txt");
    try {
      const result = launchPureTripwire(cleanGit.path, tripwire, out, {
        FAKE_PROBE_COUNT: bashPath(probeCount),
        FAKE_DRIFT_TARGET: bashPath(target),
        FAKE_DRIFT_ON_PROBE: "2",
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
      expect(result.status, output).toBe(4);
      expect(output).toContain("Blind-run provenance changed after launch");
      expect(readFileSync(probeCount, "utf8")).toBe("2");
      expect(readFileSync(tripwire.versionMarker, "utf8")).toBe("version\nversion\n");
      expect(existsSync(tripwire.providerMarker)).toBe(false);
      expectNoOutputArtifacts(out);
    } finally {
      writeFileSync(target, original, "utf8");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects non-integer and unsafe seeds before constructing MCP argv", () => {
    for (const seed of ["7&whoami", "1.5", "9007199254740992"]) {
      const result = spawnSync(
        process.execPath,
        ["blind-tester/blind-launch.mjs", "--mock", "--seed", seed],
        {
          cwd: cleanGit.path,
          encoding: "utf8",
          env: { ...process.env, BLIND_MOCK_AGENT_CMD: "exit 93" },
          timeout: 30_000,
        },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
      expect(result.status, `${seed}: ${output}`).toBe(2);
      expect(output).toContain("--seed requires a JavaScript safe integer");
      expect(output).not.toContain("Using structural BLIND_AGENT_CMD override");
    }
  }, 30_000);

  it("DEFAULTS live play to the CORE GAME overworld and reserves quest mode for structural tests", () => {
    const runner = readFileSync(join(process.cwd(), "blind-tester", "run.sh"), "utf8");
    const owPrompt = readFileSync(
      join(process.cwd(), "blind-tester", "prompt-overworld.md"),
      "utf8",
    );
    const sparkPrompt = readFileSync(
      join(process.cwd(), "blind-tester", "prompt-overworld-spark.md"),
      "utf8",
    );
    const directTransport = readFileSync(
      join(process.cwd(), "blind-tester", "prompt-transports", "spark-direct-mcp-v1.md"),
      "utf8",
    );
    const directPrompt = fillPrompt(sparkPrompt, {
      startInstruction: "start",
      seed: 1,
      persona: "",
      transport: directTransport,
    });
    const launcher = readFileSync(join(process.cwd(), "blind-tester", "blind-launch.mjs"), "utf8");

    // The overworld core game is the DEFAULT blind test: with no quest id from
    // any source, run.sh resolves to overworld mode. Targeted single-quest mode
    // remains only for --smoke/--mock structural coverage; a real agent cannot
    // opt into it through CLI args, env, or an arbitrary BLIND_AGENT_CMD.
    expect(runner).toContain('if [[ -z "$QUEST_ID" ]]; then\n  OVERWORLD=1\nfi');
    expect(runner).toContain('if [[ "$OVERWORLD" == "1" && -n "$QUEST_ID" ]]; then');
    expect(runner).toContain('if [[ -n "$QUEST_ID" && "$SMOKE" != "1" && "$MOCK" != "1" ]]; then');
    expect(runner).toContain("Live blind LLM runs must start a fresh overworld game");
    expect(runner).toContain("Ambiguous: --overworld and a quest id were both given");
    expect(runner).not.toContain('QUEST_ID="breaking_weir"');
    expect(runner).toContain("--overworld");
    expect(runner).toContain("prompt-overworld.md");
    // The spark prompt template is catalog data now; run.sh only threads it through.
    expect(codexCatalogModel("gpt-5.3-codex-spark").transport?.promptTemplate).toBe(
      "prompt-overworld-spark.md",
    );
    expect(runner).toContain('PROMPT_FILE="$SCRIPT_DIR/$PROVIDER_TRANSPORT_PROMPT_TEMPLATE"');
    expect(runner).toContain("mcp__adventureforge__start_overworld");
    // The pure prompt carries only transport syntax. Gameplay objectives,
    // routes, coverage targets, and stopping are owned by the game itself.
    expect(owPrompt).toContain("mcp__adventureforge__start_overworld");
    expect(owPrompt).toContain("first **game action**");
    expect(owPrompt).not.toContain("Begin with one pre-game tool invocation");
    expect(directPrompt).toContain("`mcp__adventureforge__start_overworld({})` exactly once");
    expect(directPrompt).toContain("call only preloaded");
    expect(directPrompt).toContain("gameplay functions authorized by the latest game");
    expect(directPrompt).toContain("Never use any other tool");
    expect(directPrompt).not.toContain("functions.exec");
    expect(directPrompt).not.toContain("tool_search");
    expect(directPrompt).not.toContain('tool_search({"query"');
    expect(owPrompt).toContain("one-time tutorial");
    expect(owPrompt).not.toMatch(/30.?45|tool calls|take at least one road/i);
    expect(owPrompt).not.toMatch(
      /(?:stop|end|exit|finish|quit).{0,80}(?:after|at|around|within|once).{0,50}(?:\d+|ten|twenty|thirty|forty|fifty).{0,30}(?:mcp|tool)?\s*(?:calls?|invocations?|requests?|turns?)/is,
    );
    expect(owPrompt).not.toMatch(/(?:call|turn|request|invocation)\s*(?:budget|limit|quota)/i);
    expect(owPrompt).not.toContain("resolve_overworld_session_road_encounter");
    expect(owPrompt).toContain("mcp__adventureforge__start_overworld_session_quest");
    expect(owPrompt).toContain("context.quest_starts");
    expect(owPrompt).not.toContain("mcp__adventureforge__start_world_quest");
    expect(owPrompt).toContain("direct quest drop-in bypasses the overworld");
    expect(owPrompt).toContain("not part of this playthrough");
    expect(owPrompt).toContain("game presents its actual journey choice");
    expect(owPrompt).toContain("After the game confirms the end");
    expect(owPrompt).toContain("Before you send your report, check every item:");
    expect(owPrompt).toContain(
      "Do not write any part of the report until a game response contains",
    );
    expect(owPrompt).toContain("An active goal, checkpoint progress, or having enough material");
    expect(owPrompt).toContain("never invent an early receipt");
    expect(owPrompt).toContain("a `journey_exit_receipt` that is `null`, empty, partial");
    expect(owPrompt).toContain("current-state snapshot substituted for");
    expect(owPrompt).toContain("rejects the entire playtest");
    expect(owPrompt).toContain("Copy the entire `exitReceipt` object without omitting");
    expect(owPrompt).toContain("if you do not have it, continue playing instead of");
    expect(owPrompt).toContain("A plain `json` fence is invalid");
    expect(owPrompt).toContain("literal heading `Playthrough log`");
    expect(owPrompt.indexOf("Before you send your report")).toBeGreaterThan(
      owPrompt.indexOf("After the game confirms the end"),
    );
    expect(owPrompt).toContain("json exit-interview");
    expect(owPrompt.match(/^```json exit-interview\r?$/gm)).toHaveLength(1);
    expect(owPrompt.indexOf("\n```json exit-interview")).toBeGreaterThan(
      owPrompt.indexOf("Before you send your report"),
    );
    expect(owPrompt).toContain('"play_mode": "pure"');
    expect(owPrompt).not.toContain("pack_path");
    expect(runner).toContain("--play-mode");
    expect(runner).toContain("--run-evidence");
    expect(runner).toContain("--require-mode pure");
    expect(runner.match(/--require-issue-consistency/g)).toHaveLength(3);
    expect(runner).not.toContain(`--permission-mode ${RETIRED_PERMISSION_MODE}`);
    // Structural flags survive PowerShell's `--` stripping via launcher recovery.
    expect(launcher).toContain('"--overworld"');
    expect(launcher).toContain('"--mock"');
    // Explicit --mock owns the bundled command; ambient agent overrides cannot
    // impersonate structural mode to bypass the live quest guard.
    expect(runner).toContain("printf -v BLIND_AGENT_CMD");
    expect(runner).toContain("$SCRIPT_DIR/mock-agent.mjs");
    expect(runner).toContain("BLIND_AGENT_CMD cannot produce pure retention evidence");
  });

  it("rejects an arbitrary agent override instead of labeling it pure", () => {
    const result = spawnSync(process.execPath, ["blind-tester/blind-launch.mjs"], {
      cwd: cleanGit.path,
      encoding: "utf8",
      env: { ...process.env, BLIND_AGENT_CMD: "exit 93" },
      timeout: 30_000,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
    expect(result.status, output).toBe(2);
    expect(output).toContain("cannot produce pure retention evidence");
    expect(output).toContain("file/shell/web isolation is not enforceable");
    expect(output).not.toContain("Using structural BLIND_AGENT_CMD override");
  }, 30_000);

  it("offers a first-class fail-closed Codex pure provider without reopening overrides", () => {
    const runner = readFileSync(join(process.cwd(), "blind-tester", "run.sh"), "utf8");
    const launcher = readFileSync(join(process.cwd(), "blind-tester", "blind-launch.mjs"), "utf8");
    const envelope = readFileSync(
      join(process.cwd(), "blind-tester", "codex-pure-envelope.mjs"),
      "utf8",
    );
    const strictStream = readFileSync(
      join(process.cwd(), "blind-tester", "codex-strict-stream.mjs"),
      "utf8",
    );

    // The default provider is still a named constant with a stated reason, and still only
    // a DEFAULT — the pure gate asks the registry what the chosen provider can PROVE,
    // never what it is called. It is no longer the literal `codex`: the runner asks the
    // registry for its first entry, so the vendor name lives in providers.json alone.
    // Registry order is unchanged, so this still resolves to codex today.
    expect(runner).toContain(
      'DEFAULT_PROVIDER="$("$NODE_CMD" "$SCRIPT_DIR/resolve-provider.mjs" --default-provider',
    );
    expect(runner).not.toContain('DEFAULT_PROVIDER="codex"');
    expect(runner).toContain('PROVIDER="${BLIND_PROVIDER:-$DEFAULT_PROVIDER}"');
    // …and it still resolves to codex, which is the half a source-text check cannot see.
    expect(
      spawnSync(
        process.execPath,
        [join("blind-tester", "resolve-provider.mjs"), "--default-provider"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      ).stdout.trim(),
    ).toBe("codex");
    expect(runner).toContain("--provider)");
    // Provider and model are validated through the registry, never against a vendor
    // list embedded here: a runner that has to be edited to gain a vendor is a runner
    // that stays single-vendor.
    expect(runner).toContain("resolve-provider.mjs");
    expect(runner).not.toContain("--provider must be exactly codex");
    expect(runner).toContain("this runner cannot launch it");
    expect(launcher).toContain('["provider", "--provider", true]');

    const launchAt = runner.indexOf('CODEX_EVENTS="$OUT.codex.jsonl"');
    const launchEnd = runner.indexOf("if [[ $STATUS -ne 0 ]]", launchAt);
    expect(launchAt).toBeGreaterThan(0);
    expect(launchEnd).toBeGreaterThan(launchAt);
    const codexLaunch = runner.slice(launchAt, launchEnd);
    expect(codexLaunch).toContain('"$NODE_CMD" "$CODEX_STRICT_STREAM_SCRIPT"');
    expect(codexLaunch).toContain('--binary "$SELECTED_CODEX_BIN"');
    expect(codexLaunch).toContain("\n    exec \\");
    expect(codexLaunch).toContain("--sandbox read-only");
    expect(codexLaunch).not.toContain("--ephemeral");
    expect(codexLaunch).toContain('--cwd "$CODEX_PLAYER_CWD_ARG"');
    expect(strictStream).toContain("detached: true");
    expect(strictStream).toContain("CODEX_HOME: codexHome");
    expect(strictStream).toContain('spawnSync("taskkill.exe"');
    expect(codexLaunch).toContain('CODEX_ROLLOUT="$OUT.codex-rollout.jsonl"');
    expect(codexLaunch).toContain('--home "$ACTIVE_CLIENT_HOME_ARG"');
    expect(codexLaunch).toContain('--events "$CODEX_EVENTS_ARG"');
    expect(codexLaunch).toContain('--rollout "$CODEX_ROLLOUT_ARG"');
    expect(codexLaunch).toContain('CODEX_CAPTURE="$OUT.codex-capture.json"');
    expect(codexLaunch).toContain('--receipt "$CODEX_CAPTURE_ARG"');
    expect(codexLaunch).toContain('--expected-cwd "$CODEX_PLAYER_CWD_ARG"');
    expect(codexLaunch).toContain('--transport-contract "$CODEX_TRANSPORT_CONTRACT"');
    expect(codexLaunch).toContain('--cli-version "$CODEX_CLI_VERSION"');
    expect(runner).toContain("codex-rollout.mjs");
    expect(codexLaunch).toContain("--ignore-user-config");
    expect(codexLaunch).toContain("--ignore-rules");
    expect(codexLaunch).toContain("--strict-config");
    expect(codexLaunch).toContain("-c 'project_doc_max_bytes=0'");
    expect(codexLaunch).toContain("--enable code_mode_only");
    expect(codexLaunch).toContain("--disable code_mode_only");
    expect(codexLaunch).toContain("--disable tool_suggest");
    expect(codexLaunch).not.toContain("--enable tool_suggest");
    // run.sh takes the contract from the resolver rather than branching on model ids,
    // and strict-code-mode remains the hardcoded fall-through for anything with no
    // declared transport — a model must OPT IN to a direct-MCP lane.
    expect(runner).toContain('CODEX_TRANSPORT_CONTRACT="$PROVIDER_TRANSPORT_CONTRACT"');
    expect(runner).toContain('CODEX_TRANSPORT_CONTRACT="strict-code-mode-v2"');
    expect(runner).not.toContain('CODEX_TRANSPORT_CONTRACT="spark-direct-mcp-v1"');
    expect(runner).toContain('PROMPT_TRANSPORT_FILE="$SCRIPT_DIR/$PROVIDER_TRANSPORT_FRAGMENT"');
    // Every certified model's declared transport components must exist on disk. This is
    // strictly stronger than the old string check: it covers models added after this
    // test was written, and it fails on a fragment that was renamed but not repointed.
    const declaredContracts = new Set<string>();
    for (const model of readCodexCatalog()) {
      if (model.certified !== true) continue;
      const transport = model.transport;
      expect(transport, `certified model ${model.id} declares no transport`).toBeDefined();
      declaredContracts.add(transport!.contract);
      for (const component of [transport!.promptTemplate, transport!.fragment]) {
        expect(component, `certified model ${model.id} names an empty component`).toBeTruthy();
        expect(existsSync(join(process.cwd(), "blind-tester", component!))).toBe(true);
      }
    }
    expect([...declaredContracts].sort()).toEqual([
      "game-direct-mcp-v1",
      "spark-direct-mcp-v1",
      "strict-code-mode-v2",
    ]);
    expect(codexLaunch).toContain("--disable apps");
    expect(codexLaunch).toContain("--disable browser_use");
    expect(codexLaunch).toContain("--disable computer_use");
    expect(codexLaunch).toContain("--disable multi_agent");
    expect(codexLaunch).toContain("--disable plugins");
    expect(codexLaunch).toContain("--disable shell_snapshot");
    expect(codexLaunch).toContain("features.shell_tool=false");
    expect(codexLaunch).toContain('web_search="disabled"');
    expect(codexLaunch).toContain('approval_policy="never"');
    expect(codexLaunch).toContain("mcp_servers.adventureforge.enabled_tools");
    expect(codexLaunch).toContain("mcp_servers.adventureforge.required=true");
    expect(codexLaunch).not.toContain("dangerously-bypass");
    expect(codexLaunch).not.toContain("danger-full-access");

    expect(envelope).toContain('new Set(["agent_message", "reasoning", "mcp_tool_call"])');
    expect(envelope).toContain('item.server !== "adventureforge"');
    expect(envelope).toContain("CODEX_PURE_PLAYER_TOOLS.has(item.tool)");
    expect(envelope).toContain('rows.at(-1)?.type !== "turn.completed"');
    // The branch is provider-agnostic: it always passed --provider "$PROVIDER" through and
    // let the binder decide, but its wording named one vendor regardless of who played.
    expect(runner).toContain("A pure run has no resumed report turn");
    expect(runner).toContain("scripts/blind-receipt-binding.ts bind");
    expect(runner).toContain('--verifier-status "$VERIFY_STATUS" --attempt 0');
    expect(runner).toContain("was not eligible for receipt-only binding");

    const overrideGuard = runner.indexOf(
      'if [[ "$PLAY_MODE" == "pure" && -n "${BLIND_AGENT_CMD:-}" ]]',
    );
    expect(overrideGuard).toBeGreaterThan(0);
    expect(overrideGuard).toBeLessThan(launchAt);
    expect(runner.indexOf('DURABLE_RUN_EVIDENCE="$OUT.evidence.jsonl"')).toBeLessThan(launchAt);
    expect(runner.indexOf("PURE_PUBLICATION_COMPLETE=1")).toBeGreaterThan(launchEnd);
  });

  it("pins Spark and Terra to exact repo-owned game-only direct catalogs", () => {
    const runner = readFileSync(join(process.cwd(), "blind-tester", "run.sh"), "utf8");
    const sparkCatalogPath = join(
      process.cwd(),
      "blind-tester",
      "codex-model-catalog-spark-v1.json",
    );
    const terraCatalogPath = join(
      process.cwd(),
      "blind-tester",
      "codex-model-catalog-terra-v1.json",
    );
    const sparkCatalog = JSON.parse(readFileSync(sparkCatalogPath, "utf8")) as DirectModelCatalog;
    const terraCatalog = JSON.parse(readFileSync(terraCatalogPath, "utf8")) as DirectModelCatalog;

    const profileStart = runner.indexOf("  CODEX_PLAYER_PROFILE_ARGS=()");
    const profileEnd = runner.indexOf("\n  fi", profileStart);
    expect(profileStart).toBeGreaterThan(0);
    expect(profileEnd).toBeGreaterThan(profileStart);
    const sparkProfile = runner.slice(profileStart, profileEnd);

    // The two vendor catalogs are still pinned to exact repo-owned files, but the pin
    // now lives with the model that needs it instead of in a two-branch if-chain that a
    // third direct-MCP model would have fallen straight through.
    expect(codexCatalogModel("gpt-5.3-codex-spark").transport?.playerCatalog).toBe(
      "codex-model-catalog-spark-v1.json",
    );
    expect(codexCatalogModel("gpt-5.6-terra").transport?.playerCatalog).toBe(
      "codex-model-catalog-terra-v1.json",
    );
    // Code-mode models take no injected vendor catalog, exactly as before.
    for (const id of ["gpt-5.6-sol", "gpt-5.6-luna"]) {
      expect(codexCatalogModel(id).transport?.playerCatalog).toBeUndefined();
    }
    // run.sh names no model and no catalog filename; it injects whatever the resolver
    // handed it, from under blind-tester/ only.
    expect(runner).not.toContain('"$MODEL" == "gpt-5.3-codex-spark"');
    expect(runner).not.toContain("codex-model-catalog-spark-v1.json");
    expect(runner).not.toContain("codex-model-catalog-terra-v1.json");
    expect(sparkProfile).toContain(
      '--config "model_catalog_json=\\"$GAME_DIR_MCP/blind-tester/$PROVIDER_TRANSPORT_PLAYER_CATALOG\\""',
    );
    expect(sparkProfile).toContain('if [[ -n "$PROVIDER_TRANSPORT_PLAYER_CATALOG" ]]; then');
    expect(sparkProfile).toContain(`--config 'instructions="${SPARK_PLAYER_INSTRUCTIONS}"'`);
    for (const config of [
      "tools.update_plan.enabled=false",
      "tools.experimental_request_user_input.enabled=false",
      "skills.include_instructions=false",
      "include_environment_context=false",
      "include_apps_instructions=false",
      "include_permissions_instructions=false",
      "include_collaboration_mode_instructions=false",
    ]) {
      expect(sparkProfile).toContain(`--config '${config}'`);
      expect(runner.match(new RegExp(config.replaceAll(".", "\\."), "gu"))).toHaveLength(1);
    }
    expect(runner).toContain('"${CODEX_PLAYER_PROFILE_ARGS[@]}"');
    expect(runner.match(/CODEX_PLAYER_PROFILE_ARGS=/gu)).toHaveLength(2);

    expect(sparkCatalog.models).toHaveLength(1);
    expect(sparkCatalog.models[0]).toEqual({
      slug: "gpt-5.3-codex-spark",
      display_name: "GPT-5.3-Codex-Spark",
      description: "AdventureForge blind player",
      default_reasoning_level: "xhigh",
      supported_reasoning_levels: [{ effort: "xhigh", description: "Blind gameplay reasoning" }],
      shell_type: "disabled",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      availability_nux: null,
      upgrade: null,
      base_instructions: SPARK_PLAYER_INSTRUCTIONS,
      model_messages: null,
      include_skills_usage_instructions: false,
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      truncation_policy: { mode: "bytes", limit: 16_384 },
      supports_parallel_tool_calls: false,
      supports_image_detail_original: false,
      context_window: 272_000,
      auto_compact_token_limit: null,
      comp_hash: "2911",
      experimental_supported_tools: [],
      supports_search_tool: false,
      use_responses_lite: false,
      tool_mode: "direct",
      multi_agent_version: null,
    });
    expect(terraCatalog.models).toHaveLength(1);
    expect(terraCatalog.models[0]).toEqual({
      slug: "gpt-5.6-terra",
      display_name: "GPT-5.6-Terra",
      description: "AdventureForge blind player",
      default_reasoning_level: "xhigh",
      supported_reasoning_levels: [{ effort: "xhigh", description: "Blind gameplay reasoning" }],
      shell_type: "disabled",
      visibility: "list",
      supported_in_api: true,
      priority: 2,
      availability_nux: null,
      upgrade: null,
      base_instructions: SPARK_PLAYER_INSTRUCTIONS,
      model_messages: null,
      include_skills_usage_instructions: false,
      default_reasoning_summary: "none",
      supports_reasoning_summary_parameter: false,
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      truncation_policy: { mode: "tokens", limit: 10_000 },
      supports_parallel_tool_calls: false,
      supports_image_detail_original: false,
      context_window: 272_000,
      max_context_window: 272_000,
      auto_compact_token_limit: null,
      comp_hash: "3000",
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
      supports_search_tool: false,
      use_responses_lite: false,
      tool_mode: "direct",
      multi_agent_version: null,
    });
    expect(terraCatalog.models[0]?.truncation_policy).not.toEqual({
      mode: "bytes",
      limit: 16_384,
    });
    expect(terraCatalog.models[0]).not.toHaveProperty("additional_speed_tiers");
    expect(terraCatalog.models[0]).not.toHaveProperty("service_tiers");
    expect(terraCatalog.models[0]).not.toHaveProperty("default_service_tier");
  });

  it("passes the game-only direct profile only to Spark and Terra", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-spark-profile-scope-"));
    const home = join(dir, "home");
    const selected = join(dir, "selected-codex");
    const malformedModelsCache = '{"models":[{"slug":"broken"}]}\n';
    try {
      mkdirSync(home);
      writeFileSync(join(home, "models_cache.json"), malformedModelsCache);
      writeFileSync(
        selected,
        `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  printf 'codex-cli 0.146.0\\n'
  exit 0
fi
printf '%s\\n' "$@" > "\${FAKE_CODEX_CAPTURE}"
exit 93
`,
        "utf8",
      );
      chmodSync(selected, 0o755);

      for (const [model, catalogName, isDirect] of [
        ["gpt-5.3-codex-spark", "codex-model-catalog-spark-v1.json", true],
        ["gpt-5.6-sol", null, false],
        ["gpt-5.6-terra", "codex-model-catalog-terra-v1.json", true],
        ["gpt-5.6-luna", null, false],
      ] as const) {
        const capture = join(dir, `${model}.argv.txt`);
        const out = join(dir, "reports", model);
        const result = spawnSync(
          process.execPath,
          ["blind-tester/blind-launch.mjs", "--model", model, "--out", out],
          {
            cwd: cleanGit.path,
            encoding: "utf8",
            env: {
              ...process.env,
              NODE_ENV: "test",
              CODEX_HOME: home,
              BLIND_CODEX_BIN: bashPath(selected),
              BLIND_CODEX_TEST_SCRIPT_CLIENT: "1",
              FAKE_CODEX_CAPTURE: bashPath(capture),
            },
            timeout: 30_000,
          },
        );
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
        expect(result.status, `${model}: ${output}`).toBe(93);
        const args = readFileSync(capture, "utf8");
        expect(args).toContain("code_mode_only");
        const sharedDirectArgs = [
          SPARK_PLAYER_INSTRUCTIONS,
          "tools.update_plan.enabled=false",
          "skills.include_instructions=false",
          "include_environment_context=false",
        ];
        for (const sharedDirectArg of sharedDirectArgs) {
          if (isDirect) expect(args).toContain(sharedDirectArg);
          else expect(args).not.toContain(sharedDirectArg);
        }
        for (const candidateCatalog of [
          "codex-model-catalog-spark-v1.json",
          "codex-model-catalog-terra-v1.json",
        ]) {
          if (candidateCatalog === catalogName) expect(args).toContain(candidateCatalog);
          else expect(args).not.toContain(candidateCatalog);
        }
        expect(args.match(/model_catalog_json=/gu) ?? []).toHaveLength(isDirect ? 1 : 0);
        for (const terraOnlyArg of ["agents.enabled=false", 'model_reasoning_summary="none"']) {
          if (model === "gpt-5.6-terra") expect(args).toContain(terraOnlyArg);
          else expect(args).not.toContain(terraOnlyArg);
        }
      }
      expect(readFileSync(join(home, "models_cache.json"), "utf8")).toBe(malformedModelsCache);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("allows the local MCP server to cold-start while parallel verification is busy", () => {
    const runner = readFileSync(join(process.cwd(), "blind-tester", "run.sh"), "utf8");
    const projectConfig = readFileSync(join(process.cwd(), ".codex", "config.toml"), "utf8");

    expect(runner.match(/mcp_servers\.adventureforge\.startup_timeout_sec=60/g)).toHaveLength(2);
    expect(runner).not.toContain("mcp_servers.adventureforge.startup_timeout_sec=20");
    expect(projectConfig).toContain("startup_timeout_sec = 60");
    expect(projectConfig).not.toContain("startup_timeout_sec = 20");
  });

  it("leaves Codex login state CLI-owned and captures only the public thread", () => {
    const runner = readFileSync(join(process.cwd(), "blind-tester", "run.sh"), "utf8");
    const rolloutCapture = readFileSync(
      join(process.cwd(), "blind-tester", "codex-rollout.mjs"),
      "utf8",
    );

    // Codex login state stays CLI-owned in the operator's EXISTING home — unchanged.
    // What changed is where that home's location comes from. It used to be the literal
    // `${CODEX_HOME:-$HOME/.codex}`, applied to every provider, so `--provider gemini_cli
    // --mock` resolved a Codex home it would never touch and could die on it. The runner
    // now reads the SELECTED provider's own state root out of the registry, which for
    // codex is exactly the same two values — asserted here against the registry itself,
    // so this stays a check on behaviour rather than on a string.
    const registry = JSON.parse(
      readFileSync(join(process.cwd(), "blind-tester", "providers.json"), "utf8"),
    ) as { providers: Array<{ id: string; capture?: { sessionLog: Record<string, string> } }> };
    const codexSessionLog = registry.providers.find((p) => p.id === "codex")?.capture?.sessionLog;
    expect(codexSessionLog?.rootEnv).toBe("CODEX_HOME");
    expect(codexSessionLog?.rootDefault).toBe("{HOME}/.codex");
    expect(runner).not.toContain("RAW_CODEX_HOME");
    expect(runner).toContain(
      'RAW_CLIENT_HOME="${PROVIDER_SESSION_LOG_ROOT_DEFAULT//\\{HOME\\}/"$HOME"}"',
    );
    expect(runner).toContain('RAW_CLIENT_HOME="${!PROVIDER_SESSION_LOG_ROOT_ENV}"');
    expect(runner).toContain("resolve-home-if-present --home");
    expect(runner).toContain('ACTIVE_CLIENT_HOME_ARG="$(node_path_arg "$ACTIVE_CLIENT_HOME")"');
    expect(runner).toContain("validate-output");
    expect(runner.indexOf("validate-output")).toBeLessThan(runner.indexOf('WORK="$(mktemp -d)"'));
    expect(runner.indexOf("validate-output")).toBeLessThan(
      runner.indexOf('mkdir -p "$(dirname "$OUT")"'),
    );
    expect(runner).not.toContain("SOURCE_CODEX_AUTH");
    expect(runner).not.toContain("STERILE_CODEX_HOME");
    expect(runner).not.toContain("CODEX_HOME_RUNTIME_ROOT");
    expect(runner).not.toContain(RETIRED_HOME_COMMAND);
    expect(runner).not.toContain(RETIRED_SOURCE_OPTION);
    expect(runner).not.toContain(CODEX_LOGIN_FILENAME);
    expect(rolloutCapture).not.toContain(RETIRED_HOME_COMMAND);
    expect(rolloutCapture).not.toContain(RETIRED_SOURCE_OPTION);
    expect(rolloutCapture).not.toContain(CODEX_LOGIN_FILENAME);
    expect(rolloutCapture).not.toContain("models_cache.json");
    expect(rolloutCapture).toContain("publicCodexThreadId(eventsPath)");
    expect(rolloutCapture).toContain("walkMatchingRollouts(");
    expect(rolloutCapture).toContain("recorded.threadId !== threadId");
  });

  it("rejects unknown, explicit Claude, and ambient Claude providers before launch", () => {
    const result = spawnSync(
      process.execPath,
      ["blind-tester/blind-launch.mjs", "--provider", "not-a-provider"],
      {
        cwd: cleanGit.path,
        encoding: "utf8",
        env: { ...process.env, BLIND_PROVIDER: "claude" },
        timeout: 30_000,
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
    expect(result.status, output).toBe(2);
    expect(output).toContain("is not registered");
    expect(output).toContain("claude_code");
    expect(output).not.toContain("Blind playtest →");

    for (const [args, env] of [
      [["--provider", "claude"], { ...process.env }],
      [[], { ...process.env, BLIND_PROVIDER: "claude" }],
    ] as const) {
      const retired = spawnSync(process.execPath, ["blind-tester/blind-launch.mjs", ...args], {
        cwd: cleanGit.path,
        encoding: "utf8",
        env,
        timeout: 30_000,
      });
      const retiredOutput = `${retired.stdout ?? ""}\n${retired.stderr ?? ""}\n${retired.error?.message ?? ""}`;
      // "claude" is not a registered id — the Claude Code entry is `claude_code`.
      // A near-miss must be refused outright and the message must name the real ids,
      // never silently resolved to whichever provider looks closest.
      expect(retired.status, retiredOutput).toBe(2);
      expect(retiredOutput).toContain('"claude" is not registered');
      expect(retiredOutput).toContain("claude_code");
      expect(retiredOutput).not.toContain("Blind playtest →");
    }
  }, 30_000);

  it("parses direct equals-form values and never reclassifies unknown options as quests", () => {
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      BLIND_AGENT_CMD: "exit 93",
      BLIND_OVERWORLD: "0",
      BLIND_QUEST_ID: "",
      BLIND_PROVIDER: "codex",
    };
    for (const key of [
      "npm_config_quest",
      "npm_config_quest_id",
      "npm_config_seed",
      "npm_config_provider",
      "npm_config_model",
      "npm_config_out",
      "npm_config_delay_ms",
      "npm_config_persona",
    ]) {
      delete baseEnv[key];
    }

    const inline = spawnSync(
      process.execPath,
      [
        "blind-tester/blind-launch.mjs",
        "--seed=72525",
        "--provider=not-a-provider",
        "--model=gpt-5.6-terra",
        "--persona=default",
        "--delay-ms=0",
      ],
      {
        cwd: cleanGit.path,
        encoding: "utf8",
        env: baseEnv,
        timeout: 30_000,
      },
    );
    const inlineOutput = `${inline.stdout ?? ""}\n${inline.stderr ?? ""}\n${inline.error?.message ?? ""}`;
    expect(inline.status, inlineOutput).toBe(2);
    expect(inlineOutput).toContain("is not registered");
    expect(inlineOutput).not.toContain("Live blind LLM runs must start");
    expect(inlineOutput).not.toContain("Ambiguous:");

    const unknown = spawnSync(
      process.execPath,
      ["blind-tester/blind-launch.mjs", "--seed=72525", "--bogus=value"],
      {
        cwd: cleanGit.path,
        encoding: "utf8",
        env: baseEnv,
        timeout: 30_000,
      },
    );
    const unknownOutput = `${unknown.stdout ?? ""}\n${unknown.stderr ?? ""}\n${unknown.error?.message ?? ""}`;
    expect(unknown.status, unknownOutput).toBe(2);
    expect(unknownOutput).toContain(
      'Unknown blind-run option "--bogus=value"; use --help for supported syntax.',
    );
    expect(unknownOutput).not.toContain("Live blind LLM runs must start");
    expect(unknownOutput).not.toContain("Ambiguous:");
  }, 30_000);

  it("rejects every live quest source before launching an override agent", () => {
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      BLIND_AGENT_CMD: "exit 93",
      BLIND_OVERWORLD: "0",
      BLIND_QUEST_ID: "",
    };
    delete baseEnv.npm_config_quest;
    delete baseEnv.npm_config_quest_id;

    const cases = [
      { label: "--quest", args: ["--quest", "breaking_weir"], env: baseEnv },
      { label: "positional", args: ["breaking_weir"], env: baseEnv },
      {
        label: "BLIND_QUEST_ID",
        args: [],
        env: { ...baseEnv, BLIND_QUEST_ID: "breaking_weir" },
      },
    ];

    for (const source of cases) {
      const result = spawnSync(
        process.execPath,
        ["blind-tester/blind-launch.mjs", ...source.args],
        {
          cwd: cleanGit.path,
          encoding: "utf8",
          env: source.env,
          timeout: 30_000,
        },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
      expect(result.status, `${source.label}: ${output}`).toBe(2);
      expect(output, source.label).toContain(
        "Live blind LLM runs must start a fresh overworld game",
      );
      expect(output, source.label).not.toContain("Using BLIND_AGENT_CMD override");
    }
  }, 30_000);

  it("rejects non-default live personas before launching an override agent", () => {
    const result = spawnSync(
      process.execPath,
      ["blind-tester/blind-launch.mjs", "--persona", "breaker"],
      {
        cwd: cleanGit.path,
        encoding: "utf8",
        env: { ...process.env, BLIND_AGENT_CMD: "exit 93", BLIND_PERSONA: "default" },
        timeout: 30_000,
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
    expect(result.status, output).toBe(2);
    expect(output).toContain("Pure live blind runs require --persona default");
    expect(output).not.toContain("Using BLIND_AGENT_CMD override");
  }, 30_000);

  it("keeps a 1200-second default failsafe and treats timeout as failure, never an exit", () => {
    const runner = readFileSync(join(process.cwd(), "blind-tester", "run.sh"), "utf8");
    expect(runner).toContain('TIMEOUT="${BLIND_TIMEOUT:-1200}"');
    const dir = mkdtempSync(join(tmpdir(), "af-blind-timeout-"));
    try {
      const result = spawnSync(
        process.execPath,
        ["blind-tester/blind-launch.mjs", "--mock", "--out", join(dir, "timed-out")],
        {
          cwd: cleanGit.path,
          encoding: "utf8",
          env: {
            ...process.env,
            BLIND_AGENT_CMD: "exit 93",
            BLIND_MOCK_AGENT_CMD: "sleep 5",
            BLIND_TIMEOUT: "1",
          },
          timeout: 15_000,
        },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
      expect(result.status, output).toBe(124);
      expect(output).toContain("technical timeout");
      expect(output).toContain("no exit interview or retention result is accepted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects a reused output prefix before launching an agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-blind-prefix-"));
    const out = join(dir, "attempt");
    const codexHome = join(dir, "codex-home");
    try {
      mkdirSync(codexHome);
      writeFileSync(`${out}.md`, "prior accepted report\n", "utf8");
      writeFileSync(`${out}.run.json`, '{"prior":"sidecar"}\n', "utf8");
      const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
      delete env.BLIND_AGENT_CMD;
      delete env.BLIND_MOCK_AGENT_CMD;
      const result = spawnSync(process.execPath, ["blind-tester/blind-launch.mjs", "--out", out], {
        cwd: cleanGit.path,
        encoding: "utf8",
        env,
        timeout: 30_000,
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
      expect(result.status, output).toBe(4);
      expect(output).toContain("Refusing to reuse report prefix");
      expect(output).not.toContain("Using structural BLIND_AGENT_CMD override");
      expect(readFileSync(`${out}.md`, "utf8")).toBe("prior accepted report\n");
      expect(readFileSync(`${out}.run.json`, "utf8")).toBe('{"prior":"sidecar"}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("launches Claude Code only via the pinned preflighted binary, never touching credentials", () => {
    // This test used to assert run.sh contained NO Claude runtime at all — the honest
    // state after the retired direct-Claude harness was removed and before the
    // claude-session launch branch landed. The branch exists now, so the pins changed
    // job: what must stay true is everything that made the retired harness dangerous,
    // not the absence of the vendor.
    const runner = readFileSync(join(process.cwd(), "blind-tester", "run.sh"), "utf8");

    expect(existsSync(join(process.cwd(), "blind-tester", "loadtest.sh"))).toBe(false);
    expect(existsSync(join(process.cwd(), "blind-tester", "loadtest-fleet.sh"))).toBe(false);

    // The launch branch is keyed on the capture READER, exactly like the implemented
    // list itself, and drives the runner_pinned session-id contract end to end: pin the
    // id, resolve the one log that id may write BEFORE launch, capture it afterwards
    // with the same module, and audit the client's own result event into the envelope.
    expect(runner).toContain('CLAUDE_SESSION_READER_MODULE="blind-tester/claude-session.mjs"');
    expect(runner).toContain('"$CLAUDE_SESSION_SCRIPT" resolve-log');
    expect(runner).toContain('--session-id "$CLAUDE_SESSION_ID"');
    expect(runner).toContain('"$CLAUDE_SESSION_SCRIPT" capture');
    expect(runner).toContain('"$CLAUDE_SESSION_SCRIPT" envelope');
    // The argv comes from the registry template records, so the surface-closing flags
    // live in providers.json once rather than being re-spelled here — which is also why
    // the retired-flag pin below can stay meaningful.
    expect(runner).toContain('PROVIDER_LAUNCH_ARGV+=("$provider_record_value")');

    // What must stay true from the retirement: no state-root relocation on faith, no
    // credential file handling, no report-recovery turn, and never a PATH-resolved
    // literal client under the gameplay timeout — only the preflighted selected binary.
    expect(runner).not.toContain("CLAUDE_CONFIG_DIR");
    expect(runner).not.toContain(RETIRED_CLAUDE_LOGIN_FILENAME);
    expect(runner).not.toContain(RETIRED_CLAUDE_OAUTH_FIELD);
    expect(runner).not.toMatch(/\btimeout\b[^\n]*\bclaude\b/u);
    expect(runner).toContain('timeout -k 10 "$TIMEOUT" "$SELECTED_CLAUDE_BIN"');
    expect(runner).not.toContain("scripts/blind-report-recovery.ts");
  });

  it("commits pure publication with an exclusive canonical sidecar only after every gate", () => {
    const runner = readFileSync(join(process.cwd(), "blind-tester", "run.sh"), "utf8");
    expect(runner).toContain('DURABLE_RUN_EVIDENCE="$OUT.evidence.jsonl"');
    expect(runner).toContain('PRIVATE_RUN_SIDECAR="$WORK/verified-run-sidecar.json"');
    expect(runner).toContain('PUBLISH_ARTIFACT_SCRIPT="$(node_path_arg');
    expect(runner).toContain("assert_launch_provenance_unchanged");
    expect(runner).not.toContain('--write-run-sidecar "$RUN_SIDECAR_ARG"');
    expect(runner.match(/--write-run-sidecar "\$PRIVATE_RUN_SIDECAR_ARG"/g)).toHaveLength(2);
    expect(runner.match(/--require-issue-consistency/g)).toHaveLength(3);

    const privateVerification = runner.indexOf('--write-run-sidecar "$PRIVATE_RUN_SIDECAR_ARG"');
    const evidencePublication = runner.indexOf('--destination "$DURABLE_RUN_EVIDENCE_ARG"');
    const finalProvenanceGate = runner.lastIndexOf("if ! assert_launch_provenance_unchanged");
    const canonicalSidecarPublication = runner.indexOf('--destination "$RUN_SIDECAR_ARG"');
    const publicationComplete = runner.indexOf("PURE_PUBLICATION_COMPLETE=1");
    const testScriptPublicationGuard = runner.indexOf(
      "Codex test-script client reached a synthetic success",
    );

    expect(testScriptPublicationGuard).toBeGreaterThan(0);
    expect(testScriptPublicationGuard).toBeLessThan(privateVerification);
    expect(runner.slice(testScriptPublicationGuard, privateVerification)).toContain("STATUS=4");
    expect(privateVerification).toBeGreaterThan(0);
    expect(evidencePublication).toBeGreaterThan(privateVerification);
    expect(finalProvenanceGate).toBeGreaterThan(evidencePublication);
    expect(canonicalSidecarPublication).toBeGreaterThan(finalProvenanceGate);
    expect(publicationComplete).toBeGreaterThan(canonicalSidecarPublication);
    expect(runner.slice(publicationComplete)).not.toContain("assert_launch_provenance_unchanged");

    // An ordinary exit anywhere before the final marker removes the canonical
    // report/evidence too, while SIGKILL still leaves no sidecar for consumers.
    expect(runner).toContain('"${PURE_OUTPUT_PREFIX_OWNED:-0}" == "1"');
    expect(runner).toContain('"${PURE_PUBLICATION_COMPLETE:-0}" != "1"');
    expect(runner).toContain('rm -f -- "$OUT.md"');
    expect(runner).toContain('rm -f -- "$RUN_SIDECAR"');
    expect(runner).toContain('rm -f -- "$DURABLE_RUN_EVIDENCE"');
    expect(runner).toContain('rm -f -- "$RECEIPT_BINDING_METADATA"');

    expect(runner).toContain("record_playthrough_terminal verified");
    expect(runner).toContain("record_playthrough_terminal verified_receipt_bound");
    expect(runner).toContain("record_playthrough_terminal verification_failed");
    expect(runner).not.toContain("transport_completed");
    expect(
      runner.match(/record_blind_telemetry "\$OUT\.json" playthrough "\$outcome"/g),
    ).toHaveLength(1);
  });

  it("publishes stale private bytes as an ordered atomic regular artifact", () => {
    const dir = mkdtempSync(join(tmpdir(), "af-blind-publication-"));
    const report = join(dir, "playtest.md");
    const privateEvidence = join(dir, "private-evidence.jsonl");
    const publishedEvidence = join(dir, "playtest.evidence.jsonl");
    try {
      writeFileSync(report, "report\n", "utf8");
      writeFileSync(privateEvidence, '{"type":"run_receipt"}\n', "utf8");
      const stale = new Date("2020-01-01T00:00:00.000Z");
      const reportTime = new Date("2025-01-01T00:00:00.000Z");
      utimesSync(privateEvidence, stale, stale);
      utimesSync(report, reportTime, reportTime);

      publishRegularArtifact(privateEvidence, publishedEvidence, { after: report });

      const published = lstatSync(publishedEvidence);
      expect(published.isFile()).toBe(true);
      expect(published.isSymbolicLink()).toBe(false);
      expect(published.mtimeMs).toBeGreaterThanOrEqual(lstatSync(report).mtimeMs);
      expect(readFileSync(publishedEvidence)).toEqual(readFileSync(privateEvidence));
      expect(lstatSync(privateEvidence).mtimeMs).toBeLessThan(lstatSync(report).mtimeMs);
      expect(readdirSync(dir).filter((name) => name.includes(".publish-"))).toEqual([]);

      expect(() =>
        publishRegularArtifact(privateEvidence, publishedEvidence, { after: report }),
      ).toThrow();
      expect(readFileSync(publishedEvidence, "utf8")).toBe('{"type":"run_receipt"}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("smokes BOTH start surfaces — the default overworld and the quest drop-in", () => {
    const smoke = readFileSync(join(process.cwd(), "blind-tester", "smoke.mjs"), "utf8");
    expect(smoke).toContain('"start_overworld"');
    expect(smoke).toContain('"get_overworld_session_context"');
    expect(smoke).toContain("compact_context: true");
    expect(smoke).toContain("if_snapshot_hash");
    expect(smoke).toContain('"--play-mode", "structural"');
  });

  it("keeps structural targeted quest runs on world quest ids instead of raw pack starts", () => {
    const runner = readFileSync(join(process.cwd(), "blind-tester", "run.sh"), "utf8");
    const prompt = readFileSync(join(process.cwd(), "blind-tester", "prompt.md"), "utf8");
    const smoke = readFileSync(join(process.cwd(), "blind-tester", "smoke.mjs"), "utf8");

    // The smoke's quest leg keeps a fallback id, but the real-run default is
    // the overworld — no quest id is baked into the run itself.
    expect(runner).toContain('"${QUEST_ID:-breaking_weir}"');
    expect(runner).toContain("--quest|--quest-id");
    expect(runner).toContain("mcp__adventureforge__start_world_quest");
    expect(runner).toContain("compact_observation = true");
    expect(runner).not.toContain("mcp__adventureforge__new_game");
    expect(runner).not.toContain("BLIND_PACK=");
    expect(runner).not.toContain("pack_path");
    expect(prompt).toContain("mcp__adventureforge__start_world_quest");
    expect(prompt).toContain("mcp__adventureforge__get_state");
    expect(prompt).toContain("compact_observation: true");
    expect(prompt).toContain("compact_state: true");
    expect(prompt).toContain("summary_only: true");
    expect(prompt).toContain("compact_summary: true");
    expect(prompt).toContain("compact_turns: true");
    expect(prompt).toContain("context");
    expect(prompt).toContain("{{START_INSTRUCTION}}");
    expect(prompt).not.toContain("mcp__adventureforge__new_game");
    expect(prompt).not.toContain("mcp__adventureforge__start_game");
    expect(prompt).not.toContain("pack_path");
    expect(prompt).not.toContain("story_path");
    expect(smoke).toContain('"breaking_weir"');
    expect(smoke).toContain('"start_world_quest"');
    expect(smoke).toContain("compact_observation: true");
    expect(smoke).toContain('"get_transcript"');
    expect(smoke).toContain('"get_state"');
    expect(smoke).toContain("compact_state: true");
    expect(smoke).toContain("summary_only: true");
    expect(smoke).toContain("compact_summary: true");
    expect(smoke).toContain("context");
    expect(smoke).not.toContain("start.mode");
    expect(smoke).not.toContain("mode ${start.mode}");
    expect(smoke).not.toContain('"new_game"');
    expect(smoke).not.toContain("pack_path");
    expect(smoke).not.toContain('"start_game"');
  });

  it("asks for replay intent without prefilling a boolean answer", () => {
    const promptPaths = [
      join(process.cwd(), "blind-tester", "prompt.md"),
      join(process.cwd(), "blind-tester", "prompt-overworld.md"),
    ];

    for (const promptPath of promptPaths) {
      const prompt = readFileSync(promptPath, "utf8");
      expect(prompt).toContain(
        "Before writing the block, answer independently: “Would you personally choose to",
      );
      expect(prompt).toContain('"would_replay": <JSON boolean chosen after play>');
      expect(prompt).not.toMatch(/"would_replay"\s*:\s*(?:true|false)\b/);
    }
  });
});
