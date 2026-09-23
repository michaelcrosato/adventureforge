/**
 * Plan a Grok MCP playtest wave. The live player is grok-4.6 at instant thinking
 * (catalog reasoning_effort=low) through AdventureForge MCP — not playtest-loop.sh.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findCatalogModel,
  findPlaytestProvider,
  parsePlaytestCatalog,
} from "../blind/providers.js";

export const GROK_MCP_WAVE_COUNT = 100;
export const GROK_MCP_WAVE_MODEL = "grok-4.6";
/** Lowest advertised grok-4.6 effort — instant thinking. */
export const GROK_MCP_INSTANT_THINKING_EFFORT = "low";
export const GROK_MCP_WAVE_SURFACE = "mcp";
export const GROK_MCP_WAVE_PROVIDER = "grok_cli";
export const GROK_MCP_WAVE_PROMPT = "blind-tester/prompt-grok-mcp-instant.md";
export const GROK_MCP_WAVE_LIVE_CHILD_CAP = 32;
const GROK_MCP_WAVE_SEED_BASE = 1_700_000_000;
const GROK_MCP_WAVE_MANIFEST = "ai-runs/playtest/grok-100-manifest.json";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export type GrokMcpWavePlan = {
  count: number;
  model: string;
  effort: string;
  instantThinking: true;
  playSurface: typeof GROK_MCP_WAVE_SURFACE;
  provider: typeof GROK_MCP_WAVE_PROVIDER;
  promptPath: string;
  concurrency: number;
  store: string;
  manifest: string;
  seedBase: number;
  planOnly: boolean;
};

type GrokStreamingOutput = {
  reportText: string;
  clientSessionId: string | null;
  gameToolCalls: number;
  stopReason: string | null;
  error: string | null;
  ended: boolean;
};

type GrokMcpProjectConfigInput = {
  repoRoot: string;
  evidencePath: string;
  seed: number;
  buildCommit: string;
  trackedWorktreeClean: boolean;
};

/**
 * npm argv for handing the wave's own store to `qa:triage` once play finishes — the same
 * post-wave step `playtest-loop.sh` already runs after every wave (see `run_wave` there),
 * which the Grok wave lacked entirely: sessions were saved but nothing folded them into
 * `qa/tickets`/`intake/queue` without a human running this by hand (bug_0622).
 */
export function grokWaveTriageArgs(store: string): string[] {
  return ["run", "--silent", "qa:triage", "--", "--store", store];
}

function argValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function argFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function grokMcpInstantThinkingSettings(): Record<string, string | number | boolean> {
  const provider = findPlaytestProvider(GROK_MCP_WAVE_PROVIDER);
  if (!provider) throw new Error(`missing provider ${GROK_MCP_WAVE_PROVIDER}`);
  const catalog = parsePlaytestCatalog(
    provider,
    JSON.parse(readFileSync(join(REPO_ROOT, provider.catalogPath), "utf8")),
  );
  const model = findCatalogModel(catalog, GROK_MCP_WAVE_MODEL);
  return model.settings;
}

/**
 * Native project config wins over compatibility imports and gives each Grok child its
 * own pure server, seed, build stamp, and private evidence file.
 */
export function grokMcpProjectConfig(input: GrokMcpProjectConfigInput): string {
  if (!Number.isSafeInteger(input.seed)) throw new Error("Grok MCP seed must be a safe integer");
  if (!/^[0-9a-f]{40}$/u.test(input.buildCommit)) {
    throw new Error("Grok MCP buildCommit must be a full lowercase Git commit");
  }
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = [
    "--silent",
    "--prefix",
    input.repoRoot,
    "run",
    "mcp",
    "--",
    "--play-mode",
    "pure",
    "--run-evidence",
    input.evidencePath,
    "--run-seed",
    String(input.seed),
    "--build-commit",
    input.buildCommit,
    "--tracked-worktree-clean",
    String(input.trackedWorktreeClean),
  ];
  return [
    "[mcp_servers.adventureforge]",
    `command = ${JSON.stringify(executable)}`,
    `args = ${JSON.stringify(args)}`,
    "enabled = true",
    "startup_timeout_sec = 60",
    "tool_timeout_sec = 1200",
    "",
  ].join("\n");
}

/** Parse Grok's documented NDJSON stream without assuming its event union is closed. */
export function parseGrokStreamingOutput(stdout: string): GrokStreamingOutput {
  let reportText = "";
  let clientSessionId: string | null = null;
  let gameToolCalls = 0;
  let stopReason: string | null = null;
  let error: string | null = null;
  let ended = false;
  const lines = stdout.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("event is not an object");
      }
      event = parsed as Record<string, unknown>;
    } catch (parseError) {
      const detail = parseError instanceof Error ? parseError.message : String(parseError);
      return {
        reportText,
        clientSessionId,
        gameToolCalls,
        stopReason,
        error: `Grok streaming JSON line ${index + 1} is invalid: ${detail}`,
        ended,
      };
    }
    if (event.type === "text" && typeof event.data === "string") {
      reportText += event.data;
      continue;
    }
    if (event.type === "tool_call" && event.toolName === "use_tool") {
      const rawInput =
        event.rawInput !== null && typeof event.rawInput === "object"
          ? (event.rawInput as Record<string, unknown>)
          : null;
      if (
        rawInput !== null &&
        typeof rawInput.tool_name === "string" &&
        rawInput.tool_name.startsWith("adventureforge__")
      ) {
        gameToolCalls += 1;
      }
      continue;
    }
    if (event.type === "error") {
      error = typeof event.message === "string" ? event.message : "Grok emitted an error event";
      continue;
    }
    if (event.type === "end") {
      ended = true;
      clientSessionId = typeof event.sessionId === "string" ? event.sessionId : null;
      stopReason = typeof event.stopReason === "string" ? event.stopReason : null;
    }
  }
  if (!ended && error === null) error = "Grok stream ended without a terminal end event";
  return { reportText, clientSessionId, gameToolCalls, stopReason, error, ended };
}

export function parseGrokMcpWaveArgs(argv: string[]): GrokMcpWavePlan {
  const count = Number.parseInt(argValue(argv, "--count") ?? String(GROK_MCP_WAVE_COUNT), 10);
  if (!Number.isInteger(count) || count < 1) throw new Error("--count must be a positive integer");
  const model = argValue(argv, "--model") ?? GROK_MCP_WAVE_MODEL;
  const effort = argValue(argv, "--effort") ?? GROK_MCP_INSTANT_THINKING_EFFORT;
  const concurrencyRaw = Number.parseInt(argValue(argv, "--concurrency") ?? "4", 10);
  if (!Number.isInteger(concurrencyRaw) || concurrencyRaw < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  const concurrency = Math.min(concurrencyRaw, GROK_MCP_WAVE_LIVE_CHILD_CAP);
  const seedBase = Number.parseInt(
    argValue(argv, "--seed-base") ?? String(GROK_MCP_WAVE_SEED_BASE),
    10,
  );
  if (!Number.isSafeInteger(seedBase) || !Number.isSafeInteger(seedBase + count - 1)) {
    throw new Error("--seed-base and the requested count must stay within safe integers");
  }
  if (model !== GROK_MCP_WAVE_MODEL) {
    throw new Error(`this wave only plays ${GROK_MCP_WAVE_MODEL} (got ${model})`);
  }
  if (effort !== GROK_MCP_INSTANT_THINKING_EFFORT) {
    throw new Error(
      `instant thinking requires --effort ${GROK_MCP_INSTANT_THINKING_EFFORT} (got ${effort})`,
    );
  }
  const settings = grokMcpInstantThinkingSettings();
  if (settings.reasoning_effort !== GROK_MCP_INSTANT_THINKING_EFFORT) {
    throw new Error(
      `${GROK_MCP_WAVE_MODEL} catalog settings.reasoning_effort must be ${GROK_MCP_INSTANT_THINKING_EFFORT}`,
    );
  }
  return {
    count,
    model,
    effort,
    instantThinking: true,
    playSurface: GROK_MCP_WAVE_SURFACE,
    provider: GROK_MCP_WAVE_PROVIDER,
    promptPath: GROK_MCP_WAVE_PROMPT,
    concurrency,
    store: argValue(argv, "--store") ?? "ai-runs/playtest/sessions",
    manifest: argValue(argv, "--manifest") ?? GROK_MCP_WAVE_MANIFEST,
    seedBase,
    planOnly: argFlag(argv, "--plan-only"),
  };
}
