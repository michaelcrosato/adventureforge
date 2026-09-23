#!/usr/bin/env node
/**
 * blind-tester/fleet.mjs — one command that runs N independent blind playtests
 * with bounded concurrency, pacing/backoff, resume, and a manifest.
 *
 * Each run is a `blind-tester/run.sh` spawn (same script a solo `npm run blind`
 * uses), given a distinct seed/persona/model/target combination. There is NO
 * temperature/top_p knob — the built-in provider invocations do not expose
 * those controls. Seed × model is the live diversity mechanism here; pure live retention uses
 * the neutral default persona so a test-directed role cannot bias continuation.
 *
 * `--mock` asks run.sh to use its bundled mock agent (zero tokens). Only this
 * explicit structural mode may plan a targeted quest; every live fleet starts
 * each agent from a fresh overworld game.
 */
import { spawn, execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { codexClientAuthorityRecord, validateOutputPrefix } from "./codex-rollout.mjs";
import { acceptedCodexProfiles } from "./frozen-v9-codex-profiles.mjs";
import {
  CODEX_GAME_DIRECT_MCP_CONTRACT,
  CODEX_GAMEPLAY_WRAPPER_FAILURES,
  CODEX_SPARK_DIRECT_MCP_CONTRACT,
  CODEX_STRICT_CURRENT_CONTRACT,
  CODEX_STRICT_STREAM_DIAGNOSTIC_FAILURES,
} from "./codex-pure-envelope.mjs";
import {
  acquireFleetCohortLease,
  assertFleetCohortOverlapAllowed,
  createFleetCohort,
  createFleetCohortIntentAudit,
  findFleetCohortOverlaps,
  publishFleetCohortIntent,
  releaseFleetCohortLease,
  removeOwnedEmptyFleetDirectory,
  scanFleetCohortIntents,
} from "./fleet-cohort-ledger.mjs";
import {
  projectCodexClientForFleetSummary,
  skippedResumeUsageRecord,
  summarizeFleetUsage,
  usageRecordFromFailedAttempt,
  usageRecordFromStrictStreamDiagnostic,
  usageRecordFromVerifiedPrimaryEnvelope,
} from "./fleet-usage.mjs";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GAME_DIR = resolve(HERE, "..");
const RUN_SH = join(HERE, "run.sh");
const PROCESS_TREE_ANCHOR = join(HERE, "codex-process-anchor.mjs");
const CODEX_PREFLIGHT_EXIT = 42;
const CODEX_PREFLIGHT_PROCESS_TIMEOUT_MS = 15_000;
const CODEX_PREFLIGHT_PROCESS_MAX_OUTPUT_BYTES = 64 * 1024;
// Standalone JS mirror of src/world/journey_contract.ts; pure reports are
// independently schema-checked against these values before a row is verified.
export const PURE_SESSION_CONTRACT_VERSION = 3;
export const PURE_BASELINE_DECISIONS = 40;
export const PURE_FLEET_EVIDENCE_SCHEMA_VERSION = 2;
export const PURE_FLEET_ATTESTATION_SCHEMA_VERSION = 2;
export const HISTORICAL_PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION = 3;
export const HISTORICAL_RECEIPT_BOUND_CODEX_ATTESTATION_SCHEMA_VERSION = 4;
export const HISTORICAL_STRICT_CODEX_ATTESTATION_SCHEMA_VERSION = 5;
export const HISTORICAL_CODE_MODE_CODEX_ATTESTATION_SCHEMA_VERSION = 6;
export const HISTORICAL_CLIENT_BOUND_CODEX_ATTESTATION_SCHEMA_VERSION = 7;
export const HISTORICAL_TRANSPORT_CODEX_ATTESTATION_SCHEMA_VERSION = 8;
export const PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION = 9;
export const PURE_FLEET_SUMMARY_SCHEMA_VERSION = 9;
export const CODEX_CLIENT_AUTHORITY_PROOF_NAME = "codex-client-authority.private.json";
export const HISTORICAL_PURE_FLEET_CODE_MODE_CONTRACT = "strict-code-mode-v1";
export const PURE_FLEET_CODE_MODE_CONTRACT = "strict-code-mode-v2";
export const SPARK_DIRECT_MCP_TRANSPORT_CONTRACT = "spark-direct-mcp-v1";
export const GAME_DIRECT_MCP_TRANSPORT_CONTRACT = CODEX_GAME_DIRECT_MCP_CONTRACT;
export const SPARK_DIRECT_MCP_CODEX_CLI_VERSION = "0.146.0";
export const GAME_DIRECT_MCP_CODEX_CLI_VERSION = "0.146.0";
/**
 * The model id the frozen v9 direct-MCP spark profile was recorded under.
 *
 * Used ONLY by the historical attestation discriminators below, which must keep matching
 * records already sealed. It is deliberately NOT the admission-canary constant any more:
 * those two happened to be the same string, which made one vendor's model id do two
 * unrelated jobs — frozen history, and a live cost policy that should follow the volume
 * role wherever it goes.
 */
const HISTORICAL_SPARK_DIRECT_MODEL = "gpt-5.3-codex-spark";

/**
 * The admission canary: which model needs one, and how many players must pass first.
 *
 * A COST guard, not an evidence gate — a large live wave of the cheap volume model is the
 * one thing here that can burn a subscription in minutes, so it must first show a receipt
 * proving N canary players completed. It was a pair of `SPARK_*` constants, i.e. a policy
 * welded to one vendor's model id; declaring it as `admissionCanaryCount` on the catalog
 * entry lets the guard follow the volume role to whatever model next holds it.
 *
 * Returns null when no certified model declares a canary — then no fleet requires a
 * receipt, exactly as every non-Spark model behaved before.
 *
 * Exactly ONE model may declare it, because the receipt records a single model and count;
 * two would make "the canary" ambiguous and silently pick whichever sorted first.
 */
function fleetAdmissionCanary() {
  let declared = [];
  try {
    const provider = readFleetProviderRegistry().find((candidate) => candidate.id === "codex");
    if (provider) {
      declared = readFleetCatalog(provider)
        .models.filter(
          (model) => model.certified === true && Number.isInteger(model.admissionCanaryCount),
        )
        .map((model) => ({ model: model.id, count: model.admissionCanaryCount }));
    }
  } catch {
    declared = [];
  }
  if (declared.length === 0) return null;
  if (declared.length > 1) {
    throw new Error(
      `fleet: ${declared.length} certified models declare an admission canary ` +
        `(${declared.map((entry) => entry.model).join(", ")}); exactly one may`,
    );
  }
  return declared[0];
}

/**
 * The canary in force, resolved once at load.
 *
 * Falls back to the frozen Spark values if the catalog cannot be read. That direction is
 * deliberate: this is a spend guard, so an unreadable catalog must leave it STANDING
 * rather than quietly removing the one thing that stops a mistyped `--count` from
 * launching a hundred live players. Fail safe, not fail open.
 *
 * The names are unchanged so every call site reads the same as before; only where the
 * numbers come from has moved.
 */
const RESOLVED_ADMISSION_CANARY = (() => {
  try {
    return fleetAdmissionCanary() ?? { model: HISTORICAL_SPARK_DIRECT_MODEL, count: 3 };
  } catch {
    return { model: HISTORICAL_SPARK_DIRECT_MODEL, count: 3 };
  }
})();
const SPARK_ADMISSION_CANARY_MODEL = RESOLVED_ADMISSION_CANARY.model;
const SPARK_ADMISSION_CANARY_COUNT = RESOLVED_ADMISSION_CANARY.count;
// These tracked inputs are shared by every live player transport. Prompt and
// model-catalog inputs are selected below because they are model-specific. Their
// bytes never leave this process: summaries retain only one digest of each
// named semantic role.
const FLEET_COMMON_TRANSPORT_COMPONENTS = Object.freeze({
  prompt_filler: "fill-prompt.mjs",
  runner: "run.sh",
  strict_stream_guard: "codex-strict-stream.mjs",
  envelope_audit: "codex-pure-envelope.mjs",
  rollout_capture: "codex-rollout.mjs",
  process_anchor: "codex-process-anchor.mjs",
});
export const SPARK_ADMISSION_RECEIPT_SCHEMA_VERSION = 2;
/**
 * Certified Codex model ids, read from the catalog rather than duplicated here.
 *
 * This was a second copy of the four-id array that also lived in
 * ../src/starting_slice/fleet_run_artifacts.ts, with no check that the two agreed. Both
 * now answer from blind-tester/catalogs/codex.json.
 *
 * A function, not a const: catalogs are operator-editable and a long-running QA loop
 * re-reads them between waves, so freezing the answer at import time would make an
 * operator restart the fleet to pick up a model they just certified.
 */
export function certifiedCodexModels() {
  try {
    const provider = readFleetProviderRegistry().find((candidate) => candidate.id === "codex");
    if (!provider) return [];
    return readFleetCatalog(provider)
      .models.filter((model) => model.certified === true)
      .map((model) => model.id);
  } catch {
    // Fail closed: if the catalog cannot be read we know of no certified model, which
    // must never be reported as "every model is fine".
    return [];
  }
}
export const FLEET_USAGE = `Usage: npm run fleet -- [options]

Options:
  --count <n>                         Player count (default: 100)
  --concurrency <n>                   Concurrent players (default: 4)
  --provider <id>                     Live provider from blind-tester/providers.json (default: codex)
  --model <exact-model>               Exact model from that provider's catalog
  --personas <name>                   Structural mock persona
  --target <overworld|quest:id>       Start surface (live: overworld only)
  --seed-base <n>                     First player seed (default: 1000)
  --mock                              Structural zero-token mode
  --label <safe-name>                 Fleet artifact label
  --max-retries <n>                   Retries per player (default: 2)
  --no-resume                         Do not reuse verified reports
  --out <directory>                   Report output directory
  --admission-canary                  Run the isolated three-player Spark transport gate
  --admission-receipt <file>          Passed exact-build gate for a Spark fleet larger than three
  --allow-duplicate-cohort <sha256>   Acknowledge one exact persisted overlap
  -h, --help                          Show this help without starting a fleet

Unknown arguments abort before fleet work begins.`;

// Rotation order for explicit structural `--mock --personas mixed`; live pure
// fleets reject mixed/non-default personas. Every non-default file in
// blind-tester/personas/ belongs here (fleet_args.test.ts holds the two in step).
// The rotation is a LABEL on the structural path only: mock-agent.mjs reads and
// discards its prompt, so a mock member plays identically whatever persona it
// carries. It proves persona plumbing, never persona behavior.
const PERSONA_ROTATION = [
  "explorer",
  "speedrunner",
  "breaker",
  "casual",
  "lore-reader",
  "cynical_veteran",
];

/** Throw a usage error for an out-of-range/non-integer numeric flag. `min` is
 * the sensible floor per the brief (count/concurrency >= 1, maxRetries >= 0);
 * pass `undefined` for flags with no floor (seedBase — negative seeds are
 * legal, see reportPathFor's `-?\d+` ledger regex). */
function assertFleetInt(value, flag, min) {
  if (!Number.isSafeInteger(value) || (min !== undefined && value < min)) {
    const bound = min !== undefined ? `a safe integer >= ${min}` : "a safe integer";
    throw new Error(`fleet: --${flag} must be ${bound} (got ${value})`);
  }
}

function requiredFleetArgValue(argv, index, flag) {
  const value = argv[index + 1];
  if (
    value === undefined ||
    value === "-h" ||
    (typeof value === "string" && value.startsWith("--"))
  ) {
    throw new Error(`fleet: ${flag} requires a value`);
  }
  return value;
}

export function assertFleetSeedRange(opts) {
  assertFleetInt(opts.count, "count", 1);
  assertFleetInt(opts.seedBase, "seed-base", undefined);
  const offset = opts.count - 1;
  const finalSeed = opts.seedBase + offset;
  if (!Number.isSafeInteger(finalSeed) || finalSeed - opts.seedBase !== offset) {
    throw new Error(
      `fleet: seed range ${opts.seedBase}..${String(finalSeed)} must contain only safe integers`,
    );
  }
}

export function validateFleetLabel(label) {
  const windowsBase = typeof label === "string" ? label.split(".", 1)[0].toUpperCase() : "";
  if (
    typeof label !== "string" ||
    label === "." ||
    label === ".." ||
    label.endsWith(".") ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(windowsBase) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(label)
  ) {
    throw new Error(
      "fleet: --label must be one non-reserved 1-80 character path segment using only letters, numbers, '.', '_', or '-', beginning with a letter or number, and not ending in '.'",
    );
  }
  return label;
}

export function validateFleetReportsDirectory(reportsDir, codexHome) {
  return validateOutputPrefix(codexHome, reportsDir, GAME_DIR);
}

function sameOrNestedPath(candidate, boundary) {
  const offset = relative(resolve(boundary), resolve(candidate));
  return (
    offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`))
  );
}

export function validateAdmissionReportsSeparation(reportsDir, fleetDir) {
  if (sameOrNestedPath(reportsDir, fleetDir) || sameOrNestedPath(fleetDir, reportsDir)) {
    throw new Error(
      "fleet: --admission-canary --out must be separate from and outside its ai-runs/fleet/<label> bundle",
    );
  }
  return reportsDir;
}

export function normalizeShellPathForNode(path, platform = process.platform) {
  if (platform !== "win32") return path;
  const match = path.match(/^\/(?:(?:mnt|cygdrive)\/)?([A-Za-z])(?:\/(.*))?$/u);
  if (!match) return path;
  const [, drive, remainder = ""] = match;
  return `${drive.toUpperCase()}:/${remainder}`;
}

export function normalizeShellHomeForNode(path, platform = process.platform, translatePosixPath) {
  const normalized = normalizeShellPathForNode(path, platform);
  if (
    platform !== "win32" ||
    normalized !== path ||
    !path.startsWith("/") ||
    /^\/\/[^/]+\/[^/]+/u.test(path)
  ) {
    return normalized;
  }
  let translated;
  try {
    translated = (
      translatePosixPath ??
      ((value) =>
        execFileSync("cygpath", ["-w", value], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        }))
    )(path).trim();
  } catch (error) {
    throw new Error(`fleet: could not translate shell home path for Windows Node: ${path}`, {
      cause: error,
    });
  }
  if (!/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(translated)) {
    throw new Error(`fleet: shell home translation was not an absolute Windows path: ${path}`);
  }
  return translated;
}

/** Parse fleet CLI args into a plain options object (pure; exported for tests).
 * Throws a plain Error (message prefixed "fleet: ") on invalid numeric flags —
 * callers (main()) catch it, print the message, and exit 2 before spawning
 * anything. Valid-input shape is unchanged/backward-compatible. */
export function parseFleetArgs(argv) {
  const supplied = new Set();
  const opts = {
    count: 100,
    concurrency: 4,
    provider: "codex",
    model: null,
    personas: "default",
    target: "overworld",
    seedBase: 1000,
    mock: false,
    label: null,
    maxRetries: 2,
    resume: true,
    out: null,
    admissionCanary: false,
    admissionReceipt: null,
    allowDuplicateCohort: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--count":
        supplied.add("count");
        opts.count = Number(requiredFleetArgValue(argv, i, a));
        i++;
        break;
      case "--concurrency":
        supplied.add("concurrency");
        opts.concurrency = Number(requiredFleetArgValue(argv, i, a));
        i++;
        break;
      case "--model":
        supplied.add("model");
        opts.model = requiredFleetArgValue(argv, i, a);
        i++;
        break;
      case "--provider":
        supplied.add("provider");
        opts.provider = requiredFleetArgValue(argv, i, a);
        i++;
        break;
      case "--personas":
        supplied.add("personas");
        opts.personas = requiredFleetArgValue(argv, i, a);
        i++;
        break;
      case "--target":
        supplied.add("target");
        opts.target = requiredFleetArgValue(argv, i, a);
        i++;
        break;
      case "--seed-base":
        opts.seedBase = Number(requiredFleetArgValue(argv, i, a));
        i++;
        break;
      case "--mock":
        supplied.add("mock");
        opts.mock = true;
        break;
      case "--label":
        supplied.add("label");
        opts.label = requiredFleetArgValue(argv, i, a);
        i++;
        break;
      case "--max-retries":
        supplied.add("max-retries");
        opts.maxRetries = Number(requiredFleetArgValue(argv, i, a));
        i++;
        break;
      case "--no-resume":
        supplied.add("no-resume");
        opts.resume = false;
        break;
      case "--out":
        supplied.add("out");
        opts.out = requiredFleetArgValue(argv, i, a);
        i++;
        break;
      case "--admission-canary":
        opts.admissionCanary = true;
        break;
      case "--admission-receipt":
        if (opts.admissionReceipt !== null) {
          throw new Error("fleet: --admission-receipt may be supplied only once");
        }
        opts.admissionReceipt = requiredFleetArgValue(argv, i, a);
        i++;
        break;
      case "--allow-duplicate-cohort":
        if (opts.allowDuplicateCohort !== null) {
          throw new Error("fleet: --allow-duplicate-cohort may be supplied only once");
        }
        opts.allowDuplicateCohort = requiredFleetArgValue(argv, i, a);
        i++;
        break;
      default:
        throw new Error(`fleet: unknown argument ${JSON.stringify(a)}; run with --help`);
    }
  }
  if (opts.admissionCanary) {
    const fixed = [
      ["count", SPARK_ADMISSION_CANARY_COUNT, "--count"],
      ["concurrency", 1, "--concurrency"],
      ["max-retries", 0, "--max-retries"],
      ["model", SPARK_ADMISSION_CANARY_MODEL, "--model"],
      ["target", "overworld", "--target"],
      ["personas", "default", "--personas"],
    ];
    for (const [key, value, flag] of fixed) {
      const property = key === "max-retries" ? "maxRetries" : key === "target" ? "target" : key;
      if (supplied.has(key) && opts[property] !== value) {
        throw new Error(`fleet: --admission-canary requires ${flag} ${value}`);
      }
      opts[property] = value;
    }
    if (opts.mock) throw new Error("fleet: --admission-canary is live Spark-only, never --mock");
    if (opts.resume) opts.resume = false;
    if (opts.label === null || opts.out === null) {
      throw new Error("fleet: --admission-canary requires separate --label and --out values");
    }
    if (opts.allowDuplicateCohort !== null) {
      throw new Error("fleet: --admission-canary cannot reuse or overlap a persisted cohort");
    }
    if (opts.admissionReceipt !== null) {
      throw new Error(
        "fleet: --admission-canary creates admission.json and cannot consume --admission-receipt",
      );
    }
  }
  assertFleetInt(opts.count, "count", 1);
  assertFleetInt(opts.concurrency, "concurrency", 1);
  assertFleetInt(opts.seedBase, "seed-base", undefined);
  assertFleetInt(opts.maxRetries, "max-retries", 0);
  assertFleetSeedRange(opts);
  // Validated against blind-tester/providers.json, never a vendor list embedded here.
  // A fleet that can only be one vendor produces homogeneous evidence, and homogeneous
  // evidence is exactly what the ranking layer cannot safely count (see
  // scoreCluster: N runs of one lineage is one instrument sampled N times).
  const registered = readFleetProviderRegistry();
  const provider = registered.find((candidate) => candidate.id === opts.provider);
  if (!provider) {
    const known = registered
      .map((candidate) => candidate.id)
      .sort()
      .join(", ");
    throw new Error(`fleet: --provider "${opts.provider}" is not registered; known: ${known}`);
  }
  if (provider.kind !== "headless_cli") {
    throw new Error(
      `fleet: provider "${opts.provider}" is ${provider.kind} and cannot be launched by the fleet; ` +
        "play it through its own client and record it with `npm run playtest:ingest`",
    );
  }
  const catalog = readFleetCatalog(provider);
  if (opts.model === null) {
    // Default to the cheapest tier: the fleet's job is throughput, and the expensive
    // reference cohort is opt-in precisely so it is never spent by accident.
    const fallback = catalog.models.find((candidate) => candidate.tier === "volume");
    opts.model = (fallback ?? catalog.models[0]).id;
  }
  // A structural mock never contacts a vendor, so its model id is a synthetic label
  // rather than a real model — validating it against a live catalog would forbid the
  // zero-token CI lane for no benefit.
  if (!opts.mock && !catalog.models.some((candidate) => candidate.id === opts.model)) {
    const known = catalog.models.map((candidate) => candidate.id).join(", ");
    throw new Error(
      `fleet: model "${opts.model}" is not in the ${provider.id} catalog; known models: ${known}`,
    );
  }
  if (
    opts.admissionReceipt !== null &&
    (opts.mock ||
      opts.model !== SPARK_ADMISSION_CANARY_MODEL ||
      opts.count <= SPARK_ADMISSION_CANARY_COUNT)
  ) {
    throw new Error(
      `fleet: --admission-receipt applies only to a live ${SPARK_ADMISSION_CANARY_MODEL} fleet with --count greater than ${SPARK_ADMISSION_CANARY_COUNT}`,
    );
  }
  if (opts.label !== null) validateFleetLabel(opts.label);
  if (
    opts.allowDuplicateCohort !== null &&
    (typeof opts.allowDuplicateCohort !== "string" ||
      !/^[a-f0-9]{64}$/.test(opts.allowDuplicateCohort))
  ) {
    throw new Error("fleet: --allow-duplicate-cohort must be one lowercase SHA-256 fingerprint");
  }
  assertFleetTargetPolicy(opts);
  return opts;
}

/**
 * Read the provider registry and one provider's catalog.
 *
 * Read at call time rather than cached at import: an operator editing a catalog to add
 * a model their subscription just unlocked should not have to restart anything, and a
 * long-running QA loop re-reads on every wave.
 */
function readFleetProviderRegistry() {
  const raw = JSON.parse(readFileSync(join(HERE, "providers.json"), "utf8"));
  return Array.isArray(raw?.providers) ? raw.providers : [];
}

function readFleetCatalog(provider) {
  const raw = JSON.parse(readFileSync(join(HERE, "..", provider.catalogPath), "utf8"));
  if (raw?.provider !== provider.id) {
    throw new Error(
      `fleet: catalog ${provider.catalogPath} declares provider "${raw?.provider}" but is registered for "${provider.id}"`,
    );
  }
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    throw new Error(`fleet: catalog ${provider.catalogPath} lists no models`);
  }
  return raw;
}

function componentSha256(component) {
  return createHash("sha256")
    .update(readFileSync(join(HERE, component)))
    .digest("hex");
}

/**
 * One certified model's catalog entry, or null.
 *
 * This module is plain ESM by design — `blind-tester/run.sh` resolves providers in
 * contexts with no TypeScript loader — so it cannot import ../src/blind/providers.ts and
 * instead reads the same catalog JSON that module validates. The catalog is the shared
 * source of truth; this is a second reader of it, not a second copy of it.
 */
function certifiedCatalogModel(modelId, providerId = "codex") {
  const provider = readFleetProviderRegistry().find((candidate) => candidate.id === providerId);
  if (!provider) return null;
  const model = readFleetCatalog(provider).models.find((candidate) => candidate.id === modelId);
  if (!model || model.certified !== true) return null;
  return model;
}

/**
 * The transport one model plays through, read from its catalog entry.
 *
 * Was a three-branch switch on exact model ids, holding a contract, a prompt template, a
 * vendor model-catalog path and a transport fragment per model — the same four facts the
 * runner's if-chain and two attestation schemas also spelled out, with nothing keeping
 * the copies in step. Adding a certified model is now a catalog edit and this function
 * needs no change.
 *
 * It still THROWS for a model with no certified catalog entry rather than inventing a
 * default profile. A transport that nobody declared is not a transport this repo can
 * witness, and quietly guessing one is how a run gets recorded under a surface no one
 * audited.
 */
/**
 * Every (model, contract, client-version) shape a CURRENT Codex attestation may carry.
 *
 * Frozen v9 profiles unioned with whatever the catalog certifies now — the same rule the
 * TypeScript schema uses, from the same definition, so the runner and the certifier
 * cannot disagree about what a valid record looks like.
 *
 * Fails to an EMPTY live half if the catalog cannot be read, which leaves the frozen
 * profiles standing: unreadable catalogs must not widen what counts as valid evidence.
 */
function fleetAcceptedCodexProfiles() {
  let live = [];
  try {
    const provider = readFleetProviderRegistry().find((candidate) => candidate.id === "codex");
    if (provider) {
      live = readFleetCatalog(provider)
        .models.filter((model) => model.certified === true)
        .map((model) => ({
          model: model.id,
          kind: model.transport?.kind ?? "direct_mcp",
          contract: model.transport?.contract ?? provider.transportContract,
          requiredCliVersion: model.transport?.requiredCliVersion ?? null,
        }));
    }
  } catch {
    live = [];
  }
  return acceptedCodexProfiles(live);
}

/**
 * Does this attestation's (model, contract, version) triple match an accepted profile?
 *
 * Replaces a hardcoded pair of model/version equalities per contract. That form was a
 * TRAP rather than merely stale: a newly certified model passed every planning gate and
 * was then rejected here, at attestation time, AFTER a full playthrough's tokens had
 * been spent — and the rejection named the transport, not the missing entry.
 */
function matchesAcceptedCodexProfile(attestation, kind) {
  const contract =
    kind === "direct_mcp" ? attestation.transport_contract : attestation.code_mode_contract;
  return fleetAcceptedCodexProfiles().some(
    (profile) =>
      profile.kind === kind &&
      profile.model === attestation.model &&
      profile.contract === contract &&
      (profile.requiredCliVersion === null ||
        profile.requiredCliVersion === attestation.codex_cli_version),
  );
}

export function fleetTransportProfile(model, providerId = "codex") {
  const provider = readFleetProviderRegistry().find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw new Error(`fleet: provider ${String(providerId)} is not in the registry`);
  }
  const entry = certifiedCatalogModel(model, providerId);
  if (!entry) {
    throw new Error(`fleet: no certified transport profile for model ${String(model)}`);
  }
  // A model may OMIT `transport` and inherit its provider's contract — the catalog schema
  // says so and ../src/blind/providers.ts implements the merge. An earlier version of this
  // function read only the override and threw for anything without one, which made every
  // inheriting model unlaunchable: a newly certified Codex model with no special transport
  // would have died at the fingerprint gate with "no certified transport profile", naming
  // the one thing that was not actually wrong with it.
  const transport = entry.transport ?? null;
  const transportContract = transport?.contract ?? provider.transportContract;
  if (typeof transportContract !== "string" || transportContract === "") {
    throw new Error(
      `fleet: neither model ${String(model)} nor provider ${String(providerId)} declares a transport contract`,
    );
  }
  // The shared component set below is CODEX-SPECIFIC — codex-strict-stream.mjs,
  // codex-pure-envelope.mjs, codex-rollout.mjs, codex-process-anchor.mjs are four of its
  // six entries. Resolving an inherited contract for another vendor would therefore hand
  // back a profile whose fingerprint hashes another vendor's launch machinery: a wrong
  // answer wearing the shape of a right one. Until a vendor has its own fleet component
  // set, say that plainly instead.
  if (providerId !== "codex") {
    throw new Error(
      `fleet: provider ${String(providerId)} has no fleet transport component set yet ` +
        `(the shared set is Codex-specific), so no fleet profile can be built for ${String(model)}`,
    );
  }
  const componentPaths = { ...FLEET_COMMON_TRANSPORT_COMPONENTS };
  if (transport?.promptTemplate) componentPaths.prompt_template = transport.promptTemplate;
  // Only clients that accept an injected vendor model catalog declare one; omitting the
  // key entirely (rather than setting it null) keeps the hashed component-role set for
  // code-mode models exactly what it has always been.
  if (transport?.playerCatalog) componentPaths.player_catalog = transport.playerCatalog;
  if (transport?.fragment) componentPaths.transport_fragment = transport.fragment;
  return { transportContract, componentPaths };
}

/** A stable, non-secret profile key for transport-gate failures. It intentionally
 * excludes seed, labels, destination paths, rendered prompt values, and raw
 * component bytes so one broken transport is recognizable without publishing
 * player content or filesystem details. */
export function createFleetTransportFingerprint({ provider, model, componentHashes } = {}) {
  // `provider` was pinned to the literal "codex" here, which made the fingerprint — and
  // therefore the transport gate that consumes it — unavailable to any other vendor's
  // fleet. It is now merely required to be a registered provider that certifies this
  // model, which fleetTransportProfile establishes by throwing otherwise.
  //
  // The hashed payload is UNCHANGED: `provider` and `model` were already inputs, so
  // every fingerprint a Codex fleet produced before this still reproduces byte for byte,
  // and closed cohorts keep their duplicate-detection semantics.
  const profile = fleetTransportProfile(model, provider);
  const componentPaths = profile.componentPaths;
  const components =
    componentHashes ??
    Object.fromEntries(
      Object.entries(componentPaths).map(([role, component]) => [role, componentSha256(component)]),
    );
  const expectedRoles = Object.keys(componentPaths).sort();
  if (
    typeof provider !== "string" ||
    provider === "" ||
    typeof model !== "string" ||
    !isDeepStrictEqual(Object.keys(components).sort(), expectedRoles) ||
    !Object.values(components).every(
      (digest) => typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest),
    )
  ) {
    throw new Error(
      "fleet: transport fingerprint requires one certified provider/model pair and component digest set",
    );
  }
  const canonicalComponents = Object.fromEntries(
    expectedRoles.map((role) => [role, components[role]]),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        // This opaque diagnostic/admission fingerprint deliberately remains
        // outside fleet-cohort identities and immutable intent records. A
        // transport-input correction must not reinterpret already-closed
        // cohorts or change their duplicate-detection semantics.
        schema_version: 1,
        provider,
        model,
        transport_contract: profile.transportContract,
        components: canonicalComponents,
      }),
    )
    .digest("hex");
}

const SPARK_ADMISSION_CONFIGURATION = Object.freeze({
  admission_count: SPARK_ADMISSION_CANARY_COUNT,
  concurrency: 1,
  evidence_schema_version: PURE_FLEET_EVIDENCE_SCHEMA_VERSION,
  max_retries: 0,
  model_attestation_schema_version: PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION,
  personas: "default",
  play_mode: "pure",
  provider: "codex",
  reasoning_effort: "xhigh",
  report_schema_version: 2,
  resume_enabled: false,
  session_contract_version: PURE_SESSION_CONTRACT_VERSION,
  start_surface: "fresh_overworld",
  target: "overworld",
  transport_contract: SPARK_DIRECT_MCP_TRANSPORT_CONTRACT,
});
const SPARK_ADMISSION_RECEIPT_MAX_BYTES = 32 * 1024;

function exactSparkAdmissionConfiguration() {
  return { ...SPARK_ADMISSION_CONFIGURATION };
}

export function createPureFleetBuildFingerprint(build) {
  if (!isExactPureFleetBuild(build)) {
    throw new Error("fleet: build fingerprint requires one exact clean pure-fleet build");
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema_version: 1,
        build: {
          git_commit: build.git_commit,
          tracked_worktree_clean: build.tracked_worktree_clean,
          world_hash: build.world_hash,
          world_id: build.world_id,
        },
      }),
      "utf8",
    )
    .digest("hex");
}

export function sparkMassAdmissionRequired(opts) {
  return (
    opts?.mock !== true &&
    opts?.admissionCanary !== true &&
    opts?.model === SPARK_ADMISSION_CANARY_MODEL &&
    Number.isSafeInteger(opts?.count) &&
    opts.count > SPARK_ADMISSION_CANARY_COUNT
  );
}

/** Keep parser-only planning helpers backwards compatible while making the
 * executable launch boundary reject a large Spark plan before preflight or any
 * model process can start. */
export function assertSparkMassAdmissionConfigured(opts) {
  if (sparkMassAdmissionRequired(opts) && !opts?.admissionReceipt) {
    throw new Error(
      `fleet: a live ${SPARK_ADMISSION_CANARY_MODEL} fleet larger than ${SPARK_ADMISSION_CANARY_COUNT} requires --admission-receipt <passed-admission.json>`,
    );
  }
  return opts;
}

function assertAdmissionCounts(counts) {
  const values = [counts?.verified, counts?.["skipped-resume"], counts?.failed, counts?.suppressed];
  if (
    !values.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    values.reduce((total, value) => total + value, 0) !== SPARK_ADMISSION_CANARY_COUNT
  ) {
    throw new Error("fleet: Spark admission receipt requires exactly three closed canary slots");
  }
}

export function createSparkAdmissionReceipt({
  counts,
  build,
  transportFingerprint,
  client,
  strictRejectedTransportFingerprints = [],
} = {}) {
  assertAdmissionCounts(counts);
  if (!isExactCodexClientAuthority(client)) {
    throw new Error("fleet: Spark admission receipt requires exact Codex client authority");
  }
  if (!/^[0-9a-f]{64}$/u.test(transportFingerprint ?? "")) {
    throw new Error("fleet: Spark admission receipt requires one transport fingerprint");
  }
  const rejectionFingerprints = [...strictRejectedTransportFingerprints];
  if (
    !rejectionFingerprints.every(
      (fingerprint) => typeof fingerprint === "string" && /^[0-9a-f]{64}$/u.test(fingerprint),
    ) ||
    new Set(rejectionFingerprints).size !== rejectionFingerprints.length
  ) {
    throw new Error("fleet: Spark admission receipt rejection fingerprints are invalid");
  }
  rejectionFingerprints.sort();
  const passed =
    counts.verified === SPARK_ADMISSION_CANARY_COUNT &&
    counts["skipped-resume"] === 0 &&
    counts.failed === 0 &&
    counts.suppressed === 0 &&
    rejectionFingerprints.length === 0;
  return {
    schema_version: SPARK_ADMISSION_RECEIPT_SCHEMA_VERSION,
    purpose: "spark_admission_canary",
    certification_eligible: false,
    passed,
    required_verified: SPARK_ADMISSION_CANARY_COUNT,
    verified: counts.verified,
    skipped_resume: counts["skipped-resume"],
    failed: counts.failed,
    suppressed: counts.suppressed,
    model: SPARK_ADMISSION_CANARY_MODEL,
    configuration: exactSparkAdmissionConfiguration(),
    build: {
      git_commit: build?.git_commit,
      tracked_worktree_clean: build?.tracked_worktree_clean,
      world_hash: build?.world_hash,
      world_id: build?.world_id,
    },
    build_fingerprint: createPureFleetBuildFingerprint(build),
    transport_fingerprint: transportFingerprint,
    codex_cli_version: client.cli_version,
    codex_client_authority_sha256: client.authority_sha256,
    strict_stream_rejection_fingerprints: rejectionFingerprints,
  };
}

const SPARK_ADMISSION_RECEIPT_KEYS = [
  "build",
  "build_fingerprint",
  "certification_eligible",
  "codex_cli_version",
  "codex_client_authority_sha256",
  "configuration",
  "failed",
  "model",
  "passed",
  "purpose",
  "required_verified",
  "schema_version",
  "skipped_resume",
  "strict_stream_rejection_fingerprints",
  "suppressed",
  "transport_fingerprint",
  "verified",
];

/** Return a precise mismatch instead of treating a self-asserted `passed` bit
 * as authority. Every redundant field is recomputed and rebound to the exact
 * launch preflight. */
export function sparkAdmissionReceiptMismatch(
  receipt,
  { build, transportFingerprint, client, model } = {},
) {
  if (
    !isExactPureFleetBuild(build) ||
    !isExactCodexClientAuthority(client) ||
    model !== SPARK_ADMISSION_CANARY_MODEL ||
    !/^[0-9a-f]{64}$/u.test(transportFingerprint ?? "")
  ) {
    return "Spark admission comparison requires exact build, transport, client, and model authority";
  }
  if (!hasExactKeys(receipt, SPARK_ADMISSION_RECEIPT_KEYS)) {
    return "Spark admission receipt has unexpected or missing fields";
  }
  if (
    receipt.schema_version !== SPARK_ADMISSION_RECEIPT_SCHEMA_VERSION ||
    receipt.purpose !== "spark_admission_canary" ||
    receipt.certification_eligible !== false
  ) {
    return "Spark admission receipt identity is invalid";
  }
  if (!isDeepStrictEqual(receipt.configuration, exactSparkAdmissionConfiguration())) {
    return "Spark admission receipt configuration does not match the current gate";
  }
  if (
    receipt.required_verified !== SPARK_ADMISSION_CANARY_COUNT ||
    !Number.isSafeInteger(receipt.verified) ||
    !Number.isSafeInteger(receipt.skipped_resume) ||
    !Number.isSafeInteger(receipt.failed) ||
    !Number.isSafeInteger(receipt.suppressed) ||
    [receipt.verified, receipt.skipped_resume, receipt.failed, receipt.suppressed].some(
      (value) => value < 0,
    ) ||
    receipt.verified + receipt.skipped_resume + receipt.failed + receipt.suppressed !==
      SPARK_ADMISSION_CANARY_COUNT
  ) {
    return "Spark admission receipt does not describe exactly three closed canary slots";
  }
  if (
    !Array.isArray(receipt.strict_stream_rejection_fingerprints) ||
    !receipt.strict_stream_rejection_fingerprints.every(
      (fingerprint) => typeof fingerprint === "string" && /^[0-9a-f]{64}$/u.test(fingerprint),
    ) ||
    new Set(receipt.strict_stream_rejection_fingerprints).size !==
      receipt.strict_stream_rejection_fingerprints.length ||
    !isDeepStrictEqual(
      receipt.strict_stream_rejection_fingerprints,
      [...receipt.strict_stream_rejection_fingerprints].sort(),
    )
  ) {
    return "Spark admission receipt rejection fingerprints are invalid";
  }
  const recomputedPassed =
    receipt.verified === SPARK_ADMISSION_CANARY_COUNT &&
    receipt.skipped_resume === 0 &&
    receipt.failed === 0 &&
    receipt.suppressed === 0 &&
    receipt.strict_stream_rejection_fingerprints.length === 0;
  if (receipt.passed !== recomputedPassed) {
    return "Spark admission receipt passed status does not match its closed slots";
  }
  if (!receipt.passed) return "Spark admission canary did not pass";
  if (!isExactPureFleetBuild(receipt.build)) {
    return "Spark admission receipt build identity is invalid or dirty";
  }
  const receiptBuildFingerprint = createPureFleetBuildFingerprint(receipt.build);
  if (receipt.build_fingerprint !== receiptBuildFingerprint) {
    return "Spark admission receipt build fingerprint does not match its build identity";
  }
  if (
    !samePureFleetBuild(receipt.build, build) ||
    receipt.build_fingerprint !== createPureFleetBuildFingerprint(build)
  ) {
    return "Spark admission receipt build does not match the current exact clean build";
  }
  if (receipt.model !== model) return "Spark admission receipt model does not match the launch";
  if (receipt.transport_fingerprint !== transportFingerprint) {
    return "Spark admission receipt transport fingerprint does not match the launch";
  }
  if (
    receipt.codex_cli_version !== client.cli_version ||
    receipt.codex_client_authority_sha256 !== client.authority_sha256
  ) {
    return "Spark admission receipt Codex client authority or version does not match the launch";
  }
  return null;
}

function readStableSparkAdmissionReceipt(receiptPath) {
  if (typeof receiptPath !== "string" || receiptPath.length === 0) {
    throw new Error("fleet: Spark admission receipt path is missing");
  }
  let before;
  let canonicalPath;
  let bytes;
  try {
    before = lstatSync(receiptPath);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size <= 0 ||
      before.size > SPARK_ADMISSION_RECEIPT_MAX_BYTES
    ) {
      throw new Error("must be one bounded regular non-symlink file with one link");
    }
    canonicalPath = realpathSync.native(receiptPath);
    bytes = readFileSync(canonicalPath);
    const after = lstatSync(canonicalPath);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.nlink !== 1 ||
      after.size !== bytes.byteLength ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("changed while it was being read");
    }
  } catch (error) {
    throw new Error(
      `fleet: Spark admission receipt is unsafe or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error("fleet: Spark admission receipt must be valid UTF-8 JSON");
  }
  const parsed = parseJsonRejectingDuplicateKeys(text, "Spark admission receipt");
  if (!parsed.ok) throw new Error(`fleet: ${parsed.reason}`);
  return { path: canonicalPath, bytes, receipt: parsed.value };
}

export function requireSparkMassAdmissionReceipt({
  receiptPath,
  build,
  transportFingerprint,
  client,
  model,
}) {
  const loaded = readStableSparkAdmissionReceipt(receiptPath);
  const mismatch = sparkAdmissionReceiptMismatch(loaded.receipt, {
    build,
    transportFingerprint,
    client,
    model,
  });
  if (mismatch !== null) throw new Error(`fleet: ${mismatch}`);
  return {
    path: loaded.path,
    sha256: sha256Bytes(loaded.bytes),
    build_fingerprint: loaded.receipt.build_fingerprint,
    transport_fingerprint: loaded.receipt.transport_fingerprint,
  };
}

function assertFleetTargetPolicy(opts) {
  // Provider legality is settled against the registry in parseFleetArgs; this function
  // is only about the TARGET. A second vendor gate here was what made "add a provider"
  // a two-place edit, and two-place edits are how a registry silently stops being the
  // source of truth.
  if (
    opts.target !== "overworld" &&
    !/^quest:[a-z0-9]+(?:_[a-z0-9]+)*$/.test(String(opts.target ?? ""))
  ) {
    throw new Error(
      `fleet: --target must be overworld or quest:<id> using a lowercase shipped quest id (got ${opts.target})`,
    );
  }
  if (!opts.mock && opts.target !== "overworld") {
    throw new Error(
      "fleet: live blind LLM runs must target overworld; quest targets require explicit --mock",
    );
  }
  // Personas ARE allowed on live runs. They used to be refused so that pure retention
  // evidence came from one neutral contract, but every session record now carries its
  // persona id and the content hash of the persona file, and retention metrics already
  // group by persona — so a "20-year cynical veteran" cohort is a segment to read, not
  // a contamination to prevent. What must never happen is a persona going unrecorded.
  if (!opts.mock && opts.personas === "mixed") {
    throw new Error(
      "fleet: --personas mixed is a structural sampling mode; name the personas explicitly for a live cohort so every session records which one it ran",
    );
  }
  if (opts.mock && opts.allowDuplicateCohort != null) {
    throw new Error(
      "fleet: --allow-duplicate-cohort applies only to live pure cohorts, never --mock structural fleets",
    );
  }
  // Exact-model enforcement for live runs lives in parseFleetArgs, against the
  // provider's own catalog. Repeating a vendor-specific list here is what made the
  // registry stop being the source of truth.
}

/** Expand parsed fleet options into the concrete list of runs (pure; exported for tests). */
export function planFleetRuns(opts) {
  // Programmatic callers do not necessarily pass through parseFleetArgs; keep
  // the fresh-world live contract at the planning boundary as well.
  assertFleetTargetPolicy(opts);
  assertFleetSeedRange(opts);
  const provider = opts.provider ?? "codex";
  const runs = [];
  for (let i = 0; i < opts.count; i++) {
    const seed = opts.seedBase + i;
    const persona =
      opts.personas === "mixed" ? PERSONA_ROTATION[i % PERSONA_ROTATION.length] : opts.personas;
    const model = opts.model;
    if (!opts.mock && !isProviderModel(provider, model, false)) {
      throw new Error(
        `fleet: pure live plans require an exact registered provider/model pair (got ${provider}/${model})`,
      );
    }
    runs.push({
      seed,
      persona,
      // Structural mode still launches run.sh through one valid built-in
      // provider selector; --mock replaces the agent after runner validation.
      provider,
      model,
      target: opts.target,
    });
  }
  return runs;
}

/** "overworld" stays as-is; "quest:<id>" → run.sh's SOURCE_SLUG, the bare quest id. */
function sourceSlugFor(target) {
  return target === "overworld" ? "overworld" : target.replace(/^quest:/, "");
}

function questIdFor(target) {
  return target === "overworld" ? null : target.replace(/^quest:/, "");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the report .md path for one run. Matches the ledger regex the
 * assessor + feedback ledger parse: ^(\d{8}T\d{6}Z)_(.+)_seed(-?\d+)\.md$
 * (pure; exported for tests). run.sh's --out takes a PREFIX and appends
 * .md/.json/.log itself — callers that spawn run.sh must strip this ".md".
 */
export function reportPathFor(reportsDir, stamp, target, seed) {
  const slug = sourceSlugFor(target);
  return join(reportsDir, `${stamp}_${slug}_seed${seed}.md`);
}

/** UTC wall-clock stamp yyyymmddThhmmssZ — run metadata, not simulation state. */
function utcStamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

// --- Windows Git-Bash resolution, copied from blind-tester/blind-launch.mjs
// (isRealBash / gitBash) rather than imported: blind-launch.mjs only exports
// recoverNpmEatenFlags, and the brief for this task says copy-with-a-comment
// instead of modifying that file's exports. Keep in sync by hand if that
// resolution logic ever changes there.

/** A usable bash: exists and is NOT the System32 WSL launcher. */
function isRealBash(p) {
  return typeof p === "string" && p !== "" && existsSync(p) && !/system32/i.test(p);
}

function gitBash() {
  if (isRealBash(process.env.BLIND_BASH)) return process.env.BLIND_BASH;
  if (
    process.env.SHELL &&
    /bash(\.exe)?$/i.test(process.env.SHELL) &&
    isRealBash(process.env.SHELL)
  )
    return process.env.SHELL;
  if (process.env.EXEPATH && isRealBash(join(process.env.EXEPATH, "bash.exe")))
    return join(process.env.EXEPATH, "bash.exe");
  const candidates = [];
  try {
    const lines = execFileSync("where", ["git"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const git of lines) {
      for (const up of ["..", join("..", "..")]) {
        const root = resolve(dirname(git), up);
        candidates.push(join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe"));
      }
    }
  } catch {
    // fall through to the well-known install locations
  }
  candidates.push(
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
  );
  return candidates.find(isRealBash) ?? null;
}

// --- Async process helpers (spawnSync would serialize the whole pool; the
// fleet's bounded concurrency needs a real async child_process.spawn).

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function createFleetChildTracker({ terminationGraceMs = 2_000 } = {}) {
  const active = new Map();
  let shuttingDown = false;
  let terminationPromise = null;

  const finish = (entry) => {
    if (entry.finished) return;
    entry.finished = true;
    if (entry.groupPoll !== null) clearTimeout(entry.groupPoll);
    active.delete(entry.child);
    entry.settle();
  };

  const failVerification = (entry, error) => {
    if (entry.verificationFailure !== null) return;
    entry.verificationFailure = error;
    if (entry.groupPoll !== null) clearTimeout(entry.groupPoll);
    entry.settle();
  };

  const processGroupAlive = (pid) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ESRCH") return false;
      if (error && typeof error === "object" && error.code === "EPERM") return true;
      throw error;
    }
  };

  const inspectPosixGroup = (entry) => {
    if (entry.finished || entry.verificationFailure !== null || !entry.rootClosed) return;
    if (entry.child.pid === undefined) {
      finish(entry);
      return;
    }
    try {
      if (!processGroupAlive(entry.child.pid)) {
        entry.groupGone = true;
        finish(entry);
        return;
      }
      entry.groupPoll = setTimeout(() => {
        entry.groupPoll = null;
        inspectPosixGroup(entry);
      }, 25);
    } catch (error) {
      failVerification(
        entry,
        new Error(`fleet: could not prove child process group ${entry.child.pid} settled`, {
          cause: error,
        }),
      );
    }
  };

  const killEntry = (entry, force) => {
    const { child, tree } = entry;
    if (child.pid === undefined) return;
    if (entry.terminate !== null) {
      try {
        if (entry.terminate(force) === true) return;
        throw new Error("custody controller rejected termination");
      } catch (error) {
        failVerification(
          entry,
          new Error(`fleet: could not terminate the proven child tree ${child.pid}`, {
            cause: error,
          }),
        );
        return;
      }
    }
    if (tree && process.platform === "win32") {
      if (entry.windowsTreeTerminationConfirmed) return;
      try {
        execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          timeout: 5_000,
          stdio: "ignore",
        });
        entry.windowsTreeTerminationConfirmed = true;
        if (entry.rootClosed) finish(entry);
        return;
      } catch (error) {
        if (entry.rootClosed || child.exitCode !== null || child.signalCode !== null) {
          failVerification(
            entry,
            new Error(
              `fleet: taskkill could not prove Windows child tree ${child.pid} settled after its root exited`,
              { cause: error },
            ),
          );
          return;
        }
      }
    }
    if (tree && process.platform !== "win32") {
      if (!processGroupAlive(child.pid)) {
        entry.groupGone = true;
        if (entry.rootClosed) finish(entry);
        return;
      }
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      if (entry.rootClosed) inspectPosixGroup(entry);
      return;
    }
    if (child.exitCode === null && child.signalCode === null && !entry.rootClosed) {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    }
  };

  const track = (child, { tree = false, terminate = null, closeProof = null } = {}) => {
    if (shuttingDown) {
      try {
        if (terminate !== null) {
          terminate(true);
        } else if (child.pid !== undefined && tree && process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // The launch is rejected either way; the owning spawn reports failure.
      }
      throw new Error("fleet: child launch rejected after shutdown began");
    }
    let settle;
    const closed = new Promise((resolvePromise) => {
      settle = resolvePromise;
    });
    const entry = {
      child,
      tree,
      closed,
      settle,
      finished: false,
      rootClosed: false,
      groupGone: false,
      groupPoll: null,
      windowsTreeTerminationConfirmed: false,
      verificationFailure: null,
      lastProcessError: null,
      terminate,
      closeProof,
    };
    active.set(child, entry);
    child.once("close", () => {
      entry.rootClosed = true;
      if (child.pid === undefined) {
        finish(entry);
        return;
      }
      if (closeProof !== null) {
        try {
          if (closeProof()) {
            finish(entry);
          } else {
            failVerification(
              entry,
              new Error(`fleet: child custody proof failed after process ${child.pid} closed`),
            );
          }
        } catch (error) {
          failVerification(
            entry,
            new Error(`fleet: child custody proof could not be verified for process ${child.pid}`, {
              cause: error,
            }),
          );
        }
        return;
      }
      if (!tree) {
        finish(entry);
      } else if (process.platform === "win32") {
        if (entry.windowsTreeTerminationConfirmed) {
          finish(entry);
        } else {
          failVerification(
            entry,
            new Error(
              `fleet: Windows child tree ${child.pid} closed without a Job Object or taskkill termination proof`,
            ),
          );
        }
      } else {
        inspectPosixGroup(entry);
      }
    });
    child.on("error", (error) => {
      // An error can precede close; it is diagnostic, never custody proof.
      entry.lastProcessError = error;
    });
    return child;
  };

  const waitForChild = async (child) => {
    const entry = active.get(child);
    if (entry === undefined) return;
    await entry.closed;
    if (entry.verificationFailure !== null) throw entry.verificationFailure;
  };

  const waitForIdle = async () => {
    while (active.size > 0) {
      const entries = [...active.values()];
      const failed = entries.find((entry) => entry.verificationFailure !== null);
      if (failed !== undefined) throw failed.verificationFailure;
      await Promise.race(entries.map((entry) => entry.closed));
    }
  };

  const terminateAndWait = () => {
    if (terminationPromise !== null) return terminationPromise;
    shuttingDown = true;
    terminationPromise = (async () => {
      const firstWave = [...active.values()];
      for (const entry of firstWave) killEntry(entry, false);
      if (active.size > 0) {
        let graceTimer;
        try {
          await Promise.race([
            waitForIdle(),
            new Promise((resolvePromise) => {
              graceTimer = setTimeout(resolvePromise, terminationGraceMs);
            }),
          ]);
        } finally {
          if (graceTimer !== undefined) clearTimeout(graceTimer);
        }
      }
      for (const entry of [...active.values()]) killEntry(entry, true);
      await waitForIdle();
    })();
    return terminationPromise;
  };

  return {
    track,
    waitForChild,
    waitForIdle,
    terminateAndWait,
    terminateChild: (child, force = false) => {
      const entry = active.get(child);
      if (entry !== undefined) killEntry(entry, force);
    },
    canStart: () => !shuttingDown,
    activeCount: () => active.size,
  };
}

export async function settleFleetChildrenBeforeCleanup(
  childTracker,
  cleanup,
  { terminate = false } = {},
) {
  if (terminate) {
    await childTracker.terminateAndWait();
  } else {
    await childTracker.waitForIdle();
  }
  cleanup();
}

export function createFleetTerminationController({ fleetControl, childTracker }) {
  let signalExitCode = null;
  let shutdownPromise = null;
  const requestTermination = (exitCode, signalName) => {
    signalExitCode ??= exitCode;
    fleetControl.abortFailure ??= new Error(
      `fleet: ${signalName} requested; no later fleet slot or retry may start`,
    );
    shutdownPromise ??= childTracker.terminateAndWait();
    void shutdownPromise.catch(() => {
      // Main awaits this same promise and retains locks if custody cannot settle.
    });
  };
  return {
    requestTermination,
    get signalExitCode() {
      return signalExitCode;
    },
    get shutdownPromise() {
      return shutdownPromise;
    },
  };
}

export function installFleetSignalHandlers(requestTermination, signalTarget = process) {
  const onInterrupt = () => requestTermination(130, "SIGINT");
  const onTerminate = () => requestTermination(143, "SIGTERM");
  signalTarget.on("SIGINT", onInterrupt);
  signalTarget.on("SIGTERM", onTerminate);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    signalTarget.off("SIGINT", onInterrupt);
    signalTarget.off("SIGTERM", onTerminate);
  };
}

export function spawnFleetChild(cmd, args, opts, { tree = false, deferWindowsStart = false } = {}) {
  if (!(tree && process.platform === "win32")) {
    const child = spawn(cmd, args, {
      ...opts,
      ...(tree ? { detached: true } : {}),
    });
    return {
      child,
      trackerOptions: { tree },
      statusForClose: (code) => code ?? 1,
      readiness: Promise.resolve(),
      started: Promise.resolve(),
      resume: null,
      terminate: null,
    };
  }

  const anchorArgs = [PROCESS_TREE_ANCHOR, "--binary", cmd];
  if (deferWindowsStart) anchorArgs.push("--deferred-resume");
  anchorArgs.push("--", ...args);
  const child = spawn(process.execPath, anchorArgs, {
    ...opts,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const state = {
    ready: false,
    started: false,
    providerExit: null,
    launcherError: null,
    terminationRequested: false,
    controlError: null,
  };
  let resolveReady;
  let rejectReady;
  const readiness = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  let resolveStarted;
  let rejectStarted;
  const started = new Promise((resolvePromise, rejectPromise) => {
    resolveStarted = resolvePromise;
    rejectStarted = rejectPromise;
  });
  void readiness.catch(() => {});
  void started.catch(() => {});
  const terminate = (force = false) => {
    if (force) {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      const forced = new Error(
        "fleet: Windows Job Object anchor exceeded its proof grace and required forced cleanup",
      );
      state.controlError ??= forced;
      try {
        execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          timeout: 5_000,
        });
        return true;
      } catch (error) {
        throw new Error("fleet: Windows Job Object anchor could not be force-terminated", {
          cause: error,
        });
      }
    }
    if (state.terminationRequested) return true;
    state.terminationRequested = true;
    if (!child.connected) return false;
    try {
      child.send({ type: "terminate_owned_tree" }, (error) => {
        if (error) state.controlError ??= error;
      });
      return true;
    } catch (error) {
      state.controlError ??= error;
      return false;
    }
  };
  const resume = () => {
    if (!deferWindowsStart || state.started) return true;
    if (!state.ready || state.terminationRequested || !child.connected) return false;
    try {
      child.send({ type: "resume_owned_tree" }, (error) => {
        if (error) {
          state.controlError ??= error;
          rejectStarted(error);
        }
      });
      return true;
    } catch (error) {
      state.controlError ??= error;
      rejectStarted(error);
      return false;
    }
  };
  child.on("message", (message) => {
    if (message?.type === "custody_ready" && !state.ready) {
      state.ready = true;
      resolveReady();
    } else if (message?.type === "provider_started" && state.ready && !state.started) {
      state.started = true;
      resolveStarted();
    } else if (message?.type === "provider_exit" && state.started && state.providerExit === null) {
      state.providerExit = { code: message.code, signal: message.signal ?? null };
      terminate();
    } else if (
      (message?.type === "provider_spawn_error" || message?.type === "anchor_error") &&
      typeof message.message === "string"
    ) {
      state.launcherError ??= new Error(message.message);
      rejectReady(state.launcherError);
      rejectStarted(state.launcherError);
      terminate();
    }
  });
  child.once("error", (error) => {
    rejectReady(error);
    rejectStarted(error);
  });
  child.once("close", () => {
    if (!state.ready) rejectReady(new Error("Windows Job Object anchor closed before custody"));
    if (!state.started && !state.terminationRequested) {
      rejectStarted(new Error("Windows Job Object anchor closed before provider start"));
    }
  });
  return {
    child,
    trackerOptions: {
      tree: false,
      terminate,
      closeProof: () =>
        child.exitCode === 0 &&
        child.signalCode === null &&
        state.terminationRequested &&
        state.controlError === null &&
        state.launcherError === null,
    },
    statusForClose: () => {
      if (state.launcherError !== null || state.providerExit === null) return 1;
      return Number.isInteger(state.providerExit.code) ? state.providerExit.code : 1;
    },
    readiness,
    started,
    resume: deferWindowsStart ? resume : null,
    terminate,
  };
}

function spawnAsync(
  cmd,
  args,
  opts,
  childTracker = null,
  { tree = false, deferWindowsStart = false } = {},
) {
  let resolveLaunchReady;
  let rejectLaunchReady;
  const launchReady = new Promise((resolvePromise, rejectPromise) => {
    resolveLaunchReady = resolvePromise;
    rejectLaunchReady = rejectPromise;
  });
  let resolveLaunchStarted;
  let rejectLaunchStarted;
  const launchStarted = new Promise((resolvePromise, rejectPromise) => {
    resolveLaunchStarted = resolvePromise;
    rejectLaunchStarted = rejectPromise;
  });
  void launchReady.catch(() => {});
  void launchStarted.catch(() => {});
  let resumeLaunch = null;
  let abortLaunch = null;
  const resultPromise = new Promise((resolvePromise) => {
    if (childTracker !== null && !childTracker.canStart()) {
      const error = new Error("fleet: child launch rejected after shutdown began");
      rejectLaunchReady(error);
      rejectLaunchStarted(error);
      resolvePromise({ status: 1, stdout: "", stderr: error.message });
      return;
    }
    let child;
    let launch;
    try {
      launch = spawnFleetChild(cmd, args, opts, { tree, deferWindowsStart });
      child = launch.child;
      resumeLaunch = launch.resume;
      abortLaunch = launch.terminate;
      void launch.readiness.then(resolveLaunchReady, rejectLaunchReady);
      void launch.started.then(resolveLaunchStarted, rejectLaunchStarted);
      if (childTracker !== null) childTracker.track(child, launch.trackerOptions);
    } catch (err) {
      rejectLaunchReady(err);
      rejectLaunchStarted(err);
      resolvePromise({ status: 1, stdout: "", stderr: String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let processError = null;
    const finish = (status, error = null) => {
      if (settled) return;
      settled = true;
      resolvePromise({
        status,
        stdout,
        stderr: error === null ? stderr : `${stderr}${stderr ? "\n" : ""}${String(error)}`,
      });
    };
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      void (async () => {
        try {
          if (childTracker !== null) await childTracker.waitForChild(child);
          finish(processError === null ? launch.statusForClose(code) : 1, processError);
        } catch (error) {
          finish(1, error);
        }
      })();
    });
    child.on("error", (error) => {
      processError = error;
    });
  });
  resultPromise.launchReady = launchReady;
  resultPromise.launchStarted = launchStarted;
  resultPromise.hasDeferredStart = resumeLaunch !== null;
  resultPromise.resumeLaunch = () => (resumeLaunch === null ? true : resumeLaunch());
  resultPromise.abortLaunch = () => (abortLaunch === null ? false : abortLaunch(false));
  return resultPromise;
}

function spawnBoundedAsync(
  cmd,
  args,
  opts,
  { timeoutMs, maxOutputBytes, childTracker = null, tree = false },
) {
  return new Promise((resolvePromise) => {
    if (childTracker !== null && !childTracker.canStart()) {
      resolvePromise({
        status: CODEX_PREFLIGHT_EXIT,
        stdout: "",
        stderr: "fleet: child launch rejected after shutdown began",
        timedOut: false,
        outputExceeded: false,
      });
      return;
    }
    let child;
    let launch;
    try {
      launch = spawnFleetChild(cmd, args, opts, { tree });
      child = launch.child;
      if (childTracker !== null) childTracker.track(child, launch.trackerOptions);
    } catch (error) {
      resolvePromise({
        status: CODEX_PREFLIGHT_EXIT,
        stdout: "",
        stderr: String(error),
        timedOut: false,
        outputExceeded: false,
      });
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer;
    let killTimer;
    let stopReason = null;
    let processError = null;
    const captured = (chunks, currentBytes, chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxOutputBytes - currentBytes);
      if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
      return {
        bytes: currentBytes + Math.min(bytes.byteLength, remaining),
        exceeded: bytes.byteLength > remaining,
      };
    };
    const finish = (status) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        status: stopReason === null ? status : CODEX_PREFLIGHT_EXIT,
        stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderrChunks, stderrBytes).toString("utf8"),
        timedOut: stopReason === "timeout",
        outputExceeded: stopReason === "output",
      });
    };
    const requestStop = (reason) => {
      if (stopReason !== null) return;
      stopReason = reason;
      if (childTracker !== null) childTracker.terminateChild(child);
      else child.kill();
      killTimer = setTimeout(() => {
        if (childTracker !== null) childTracker.terminateChild(child, true);
        else child.kill("SIGKILL");
      }, 1_000);
    };
    child.stdout?.on("data", (chunk) => {
      const result = captured(stdoutChunks, stdoutBytes, chunk);
      stdoutBytes = result.bytes;
      if (result.exceeded) requestStop("output");
    });
    child.stderr?.on("data", (chunk) => {
      const result = captured(stderrChunks, stderrBytes, chunk);
      stderrBytes = result.bytes;
      if (result.exceeded) requestStop("output");
    });
    child.on("close", (code) => {
      void (async () => {
        try {
          if (childTracker !== null) await childTracker.waitForChild(child);
          if (processError !== null) {
            const message = String(processError);
            stderrChunks.push(Buffer.from(message));
            stderrBytes += Buffer.byteLength(message);
          }
          finish(processError === null ? launch.statusForClose(code) : 1);
        } catch (error) {
          const message = String(error);
          stderrChunks.push(Buffer.from(message));
          stderrBytes += Buffer.byteLength(message);
          finish(1);
        }
      })();
    });
    child.on("error", (error) => {
      processError = error;
    });
    timer = setTimeout(() => {
      requestStop("timeout");
    }, timeoutMs);
  });
}

/** Belt-and-braces re-verification: run.sh already ran the verifier as its own
 * last step, but this is a second, independent pass, per the brief. Returns
 * stdout/stderr too (not just ok) so failed-attempt diagnostics can surface
 * *why* the reverify rejected an exit-0 run.sh. */
export function runSidecarPathFor(reportMdPath) {
  return reportMdPath.endsWith(".md")
    ? `${reportMdPath.slice(0, -".md".length)}.run.json`
    : `${reportMdPath}.run.json`;
}

export function fleetAttestationPathFor(reportMdPath) {
  return reportMdPath.endsWith(".md")
    ? `${reportMdPath.slice(0, -".md".length)}.fleet.json`
    : `${reportMdPath}.fleet.json`;
}

export function pureFleetRunArtifactPathsFor(reportMdPath) {
  const prefix = reportMdPath.endsWith(".md") ? reportMdPath.slice(0, -".md".length) : reportMdPath;
  return {
    report: reportMdPath,
    run_sidecar: `${prefix}.run.json`,
    run_evidence: `${prefix}.evidence.jsonl`,
    primary_envelope: `${prefix}.json`,
    initial_report: `${prefix}.initial-report.txt`,
    receipt_binding: `${prefix}.receipt-bind.json`,
    recovery_metadata: `${prefix}.repair.meta.json`,
    recovery_envelope: `${prefix}.repair.json`,
    provider_events: `${prefix}.codex.jsonl`,
    provider_rollout: `${prefix}.codex-rollout.jsonl`,
    provider_capture: `${prefix}.codex-capture.json`,
  };
}

/** A resumable artifact must be an ordinary file, never a symlink, whose
 * resolved path stays within the selected reports directory. */
export function isTrustedFleetArtifactFile(filePath, reportsDir) {
  try {
    const metadata = lstatSync(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) return false;
    const reportsRoot = realpathSync(reportsDir);
    const artifact = realpathSync(filePath);
    const fromRoot = relative(reportsRoot, artifact);
    return (
      fromRoot !== "" &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot)
    );
  } catch {
    return false;
  }
}

function trustedArtifactIdentity(filePath) {
  const metadata = lstatSync(filePath);
  if (metadata.ino !== 0) return `${String(metadata.dev)}:${String(metadata.ino)}`;
  // realpathSync.native returns the filesystem's canonical spelling. Keep it
  // exact: lowercasing would alias distinct entries on case-sensitive Windows
  // directories.
  return `path:${realpathSync.native(filePath)}`;
}

const PURE_BUILD_KEYS = ["git_commit", "tracked_worktree_clean", "world_hash", "world_id"].sort();

function isExactPureFleetBuild(build) {
  if (build === null || typeof build !== "object" || Array.isArray(build)) return false;
  const keys = Object.keys(build).sort();
  return (
    keys.length === PURE_BUILD_KEYS.length &&
    keys.every((key, index) => key === PURE_BUILD_KEYS[index]) &&
    /^[0-9a-f]{40}$/.test(build.git_commit) &&
    build.tracked_worktree_clean === true &&
    typeof build.world_id === "string" &&
    build.world_id.length > 0 &&
    /^[0-9a-f]{64}$/.test(build.world_hash)
  );
}

function samePureFleetBuild(actual, expected) {
  return (
    isExactPureFleetBuild(actual) &&
    isExactPureFleetBuild(expected) &&
    actual.git_commit === expected.git_commit &&
    actual.tracked_worktree_clean === expected.tracked_worktree_clean &&
    actual.world_id === expected.world_id &&
    actual.world_hash === expected.world_hash
  );
}

const PURE_FLEET_CLAUDE_ATTESTATION_KEYS = [
  "actual_model",
  "build",
  "claude_session_id",
  "game_session_id",
  "initial_report_sha256",
  "model",
  "persona",
  "play_mode",
  "primary_envelope_sha256",
  "receipt_hash",
  "recovery_envelope_sha256",
  "recovery_metadata_sha256",
  "report_recovered",
  "report_sha256",
  "run_evidence_sha256",
  "run_seed",
  "run_sidecar_sha256",
  "schema_version",
  "start_surface",
  "target",
].sort();

const CURRENT_STRICT_CODEX_ATTESTATION_KEYS = [
  "actual_model",
  "actual_provider",
  "build",
  "codex_cli_version",
  "codex_client_authority_sha256",
  "code_mode_contract",
  "game_session_id",
  "initial_report_sha256",
  "model",
  "persona",
  "play_mode",
  "primary_envelope_sha256",
  "provider",
  "provider_cwd",
  "provider_events_sha256",
  "provider_rollout_sha256",
  "provider_capture_sha256",
  "provider_session_id",
  "provider_turn_id",
  "reasoning_effort",
  "receipt_hash",
  "receipt_binding_sha256",
  "recovery_envelope_sha256",
  "recovery_metadata_sha256",
  "report_receipt_bound",
  "report_recovered",
  "report_sha256",
  "run_evidence_sha256",
  "run_seed",
  "run_sidecar_sha256",
  "schema_version",
  "start_surface",
  "target",
].sort();

const CURRENT_DIRECT_CODEX_ATTESTATION_KEYS = CURRENT_STRICT_CODEX_ATTESTATION_KEYS.filter(
  (key) => key !== "code_mode_contract",
)
  .concat("transport_contract")
  .sort();

const HISTORICAL_CLIENT_BOUND_CODEX_ATTESTATION_KEYS = CURRENT_STRICT_CODEX_ATTESTATION_KEYS;

const HISTORICAL_CODE_MODE_CODEX_ATTESTATION_KEYS = CURRENT_STRICT_CODEX_ATTESTATION_KEYS.filter(
  (key) => key !== "codex_cli_version" && key !== "codex_client_authority_sha256",
);

const HISTORICAL_RECEIPT_BOUND_CODEX_ATTESTATION_KEYS =
  HISTORICAL_CODE_MODE_CODEX_ATTESTATION_KEYS.filter((key) => key !== "code_mode_contract");

const HISTORICAL_STRICT_CODEX_ATTESTATION_KEYS = HISTORICAL_CODE_MODE_CODEX_ATTESTATION_KEYS;

const HISTORICAL_PURE_FLEET_CODEX_ATTESTATION_KEYS =
  HISTORICAL_RECEIPT_BOUND_CODEX_ATTESTATION_KEYS.filter(
    (key) => key !== "receipt_binding_sha256" && key !== "report_receipt_bound",
  );

function isExactCodexClientAuthority(client) {
  if (client === null || typeof client !== "object" || Array.isArray(client)) return false;
  const keys = Object.keys(client).sort();
  if (
    !isDeepStrictEqual(keys, [
      "authority_sha256",
      "authority_token",
      "cli_version",
      "executable_binary",
      "launcher_kind",
      "schema_version",
      "selected_binary",
      "test_script",
    ])
  ) {
    return false;
  }
  if (
    client.schema_version !== 2 ||
    client.test_script !== false ||
    !["direct", "official_npm_shim"].includes(client.launcher_kind) ||
    typeof client.selected_binary !== "string" ||
    client.selected_binary.length === 0 ||
    typeof client.executable_binary !== "string" ||
    client.executable_binary.length === 0 ||
    typeof client.authority_token !== "string" ||
    !/^[0-9A-Za-z_-]+$/u.test(client.authority_token) ||
    !/^[0-9a-f]{64}$/u.test(client.authority_sha256) ||
    typeof client.cli_version !== "string"
  ) {
    return false;
  }
  try {
    return isDeepStrictEqual(
      codexClientAuthorityRecord(client.authority_token, client.cli_version),
      client,
    );
  } catch {
    return false;
  }
}

export function codexFleetMemberEnv(environment, client) {
  if (!isExactCodexClientAuthority(client)) {
    throw new Error("fleet: cannot launch a member without exact Codex client authority");
  }
  return {
    ...environment,
    BLIND_CODEX_BIN: client.selected_binary,
    BLIND_CODEX_EXPECTED_AUTHORITY: client.authority_token,
    BLIND_CODEX_EXPECTED_VERSION: client.cli_version,
    // Fleet cohorts attest reasoning_effort xhigh (see the frozen admission
    // configuration and attestation gates), so the launch effort is pinned here
    // explicitly instead of inheriting whatever the catalog's interactive
    // default happens to be.
    BLIND_REASONING_EFFORT: "xhigh",
  };
}

function isFleetModel(model) {
  return model === "haiku" || model === "sonnet" || model === "opus";
}

function isCodexFleetModel(model) {
  return certifiedCodexModels().includes(model);
}

/**
 * Is this an exact provider/model pair the registry recognizes?
 *
 * Reads the provider's own catalog rather than a per-vendor allowlist, so a newly
 * registered vendor works here with no edit. `allowMix` is kept for the historical
 * "mix" selector that older attestations may still carry; it is not a live path.
 */
function isProviderModel(provider, model, allowMix) {
  if (allowMix && model === "mix") return true;
  // The historical "claude" provider is no longer launchable, but its attestations must
  // stay READABLE: resume and verification paths still parse evidence recorded before
  // the registry existed, and refusing to recognize its models would retroactively
  // invalidate archived runs rather than merely stopping new ones.
  if (provider === "claude") return isFleetModel(model);
  try {
    const registered = readFleetProviderRegistry().find((candidate) => candidate.id === provider);
    if (!registered) return false;
    return readFleetCatalog(registered).models.some((candidate) => candidate.id === model);
  } catch {
    // An unreadable catalog is not a licence to accept an arbitrary model.
    return false;
  }
}

function isExactPureFleetAttestation(attestation) {
  if (attestation === null || typeof attestation !== "object" || Array.isArray(attestation)) {
    return false;
  }
  const keys = Object.keys(attestation).sort();
  const common =
    Number.isSafeInteger(attestation.run_seed) &&
    attestation.persona === "default" &&
    attestation.target === "overworld" &&
    attestation.play_mode === "pure" &&
    attestation.start_surface === "fresh_overworld" &&
    isExactPureFleetBuild(attestation.build) &&
    typeof attestation.game_session_id === "string" &&
    attestation.game_session_id.length > 0 &&
    /^[0-9a-f]{64}$/.test(attestation.receipt_hash) &&
    /^[0-9a-f]{64}$/.test(attestation.report_sha256) &&
    /^[0-9a-f]{64}$/.test(attestation.run_sidecar_sha256) &&
    /^[0-9a-f]{64}$/.test(attestation.run_evidence_sha256) &&
    /^[0-9a-f]{64}$/.test(attestation.primary_envelope_sha256);
  if (!common) return false;
  if (attestation.schema_version === PURE_FLEET_ATTESTATION_SCHEMA_VERSION) {
    return (
      keys.length === PURE_FLEET_CLAUDE_ATTESTATION_KEYS.length &&
      keys.every((key, index) => key === PURE_FLEET_CLAUDE_ATTESTATION_KEYS[index]) &&
      attestation.schema_version === PURE_FLEET_ATTESTATION_SCHEMA_VERSION &&
      isFleetModel(attestation.model) &&
      typeof attestation.claude_session_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        attestation.claude_session_id,
      ) &&
      typeof attestation.actual_model === "string" &&
      attestation.actual_model.length > 0 &&
      typeof attestation.report_recovered === "boolean" &&
      (attestation.initial_report_sha256 === null ||
        /^[0-9a-f]{64}$/.test(attestation.initial_report_sha256)) &&
      (attestation.recovery_metadata_sha256 === null ||
        /^[0-9a-f]{64}$/.test(attestation.recovery_metadata_sha256)) &&
      (attestation.recovery_envelope_sha256 === null ||
        /^[0-9a-f]{64}$/.test(attestation.recovery_envelope_sha256)) &&
      (attestation.report_recovered
        ? attestation.initial_report_sha256 !== null &&
          attestation.recovery_metadata_sha256 !== null &&
          attestation.recovery_envelope_sha256 !== null
        : attestation.initial_report_sha256 === null &&
          attestation.recovery_metadata_sha256 === null &&
          attestation.recovery_envelope_sha256 === null)
    );
  }
  const currentDirectCodex =
    attestation.schema_version === PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION &&
    keys.length === CURRENT_DIRECT_CODEX_ATTESTATION_KEYS.length &&
    keys.every((key, index) => key === CURRENT_DIRECT_CODEX_ATTESTATION_KEYS[index]);
  const currentStrictCodex =
    attestation.schema_version === PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION &&
    keys.length === CURRENT_STRICT_CODEX_ATTESTATION_KEYS.length &&
    keys.every((key, index) => key === CURRENT_STRICT_CODEX_ATTESTATION_KEYS[index]);
  const historicalTransportDirectCodex =
    attestation.schema_version === HISTORICAL_TRANSPORT_CODEX_ATTESTATION_SCHEMA_VERSION &&
    keys.length === CURRENT_DIRECT_CODEX_ATTESTATION_KEYS.length &&
    keys.every((key, index) => key === CURRENT_DIRECT_CODEX_ATTESTATION_KEYS[index]);
  const historicalTransportStrictCodex =
    attestation.schema_version === HISTORICAL_TRANSPORT_CODEX_ATTESTATION_SCHEMA_VERSION &&
    attestation.model !== HISTORICAL_SPARK_DIRECT_MODEL &&
    keys.length === CURRENT_STRICT_CODEX_ATTESTATION_KEYS.length &&
    keys.every((key, index) => key === CURRENT_STRICT_CODEX_ATTESTATION_KEYS[index]);
  const historicalClientBoundCodex =
    attestation.schema_version === HISTORICAL_CLIENT_BOUND_CODEX_ATTESTATION_SCHEMA_VERSION &&
    keys.length === HISTORICAL_CLIENT_BOUND_CODEX_ATTESTATION_KEYS.length &&
    keys.every((key, index) => key === HISTORICAL_CLIENT_BOUND_CODEX_ATTESTATION_KEYS[index]);
  const historicalCodeModeCodex =
    attestation.schema_version === HISTORICAL_CODE_MODE_CODEX_ATTESTATION_SCHEMA_VERSION &&
    keys.length === HISTORICAL_CODE_MODE_CODEX_ATTESTATION_KEYS.length &&
    keys.every((key, index) => key === HISTORICAL_CODE_MODE_CODEX_ATTESTATION_KEYS[index]);
  const historicalReceiptBoundCodex =
    attestation.schema_version === HISTORICAL_RECEIPT_BOUND_CODEX_ATTESTATION_SCHEMA_VERSION &&
    keys.length === HISTORICAL_RECEIPT_BOUND_CODEX_ATTESTATION_KEYS.length &&
    keys.every((key, index) => key === HISTORICAL_RECEIPT_BOUND_CODEX_ATTESTATION_KEYS[index]);
  const historicalCodex =
    attestation.schema_version === HISTORICAL_PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION &&
    keys.length === HISTORICAL_PURE_FLEET_CODEX_ATTESTATION_KEYS.length &&
    keys.every((key, index) => key === HISTORICAL_PURE_FLEET_CODEX_ATTESTATION_KEYS[index]);
  const historicalStrictCodex =
    attestation.schema_version === HISTORICAL_STRICT_CODEX_ATTESTATION_SCHEMA_VERSION &&
    keys.length === HISTORICAL_STRICT_CODEX_ATTESTATION_KEYS.length &&
    keys.every((key, index) => key === HISTORICAL_STRICT_CODEX_ATTESTATION_KEYS[index]);
  return (
    (currentDirectCodex ||
      currentStrictCodex ||
      historicalTransportDirectCodex ||
      historicalTransportStrictCodex ||
      historicalClientBoundCodex ||
      historicalCodeModeCodex ||
      historicalStrictCodex ||
      historicalReceiptBoundCodex ||
      historicalCodex) &&
    attestation.provider === "codex" &&
    isCodexFleetModel(attestation.model) &&
    attestation.actual_provider === "openai" &&
    attestation.actual_model === attestation.model &&
    attestation.reasoning_effort === "xhigh" &&
    typeof attestation.provider_session_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      attestation.provider_session_id,
    ) &&
    typeof attestation.provider_turn_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      attestation.provider_turn_id,
    ) &&
    typeof attestation.provider_cwd === "string" &&
    attestation.provider_cwd.length > 0 &&
    attestation.report_recovered === false &&
    /^[0-9a-f]{64}$/.test(attestation.provider_events_sha256) &&
    /^[0-9a-f]{64}$/.test(attestation.provider_rollout_sha256) &&
    /^[0-9a-f]{64}$/.test(attestation.provider_capture_sha256) &&
    attestation.recovery_metadata_sha256 === null &&
    attestation.recovery_envelope_sha256 === null &&
    (currentDirectCodex
      ? matchesAcceptedCodexProfile(attestation, "direct_mcp") &&
        /^[0-9a-f]{64}$/u.test(attestation.codex_client_authority_sha256)
      : currentStrictCodex
        ? matchesAcceptedCodexProfile(attestation, "code_mode") &&
          typeof attestation.codex_cli_version === "string" &&
          /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
            attestation.codex_cli_version,
          ) &&
          /^[0-9a-f]{64}$/u.test(attestation.codex_client_authority_sha256)
        : historicalTransportDirectCodex
          ? attestation.transport_contract === SPARK_DIRECT_MCP_TRANSPORT_CONTRACT &&
            attestation.model === HISTORICAL_SPARK_DIRECT_MODEL &&
            attestation.codex_cli_version === SPARK_DIRECT_MCP_CODEX_CLI_VERSION &&
            /^[0-9a-f]{64}$/u.test(attestation.codex_client_authority_sha256)
          : historicalTransportStrictCodex || historicalClientBoundCodex
            ? typeof attestation.codex_cli_version === "string" &&
              /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
                attestation.codex_cli_version,
              ) &&
              /^[0-9a-f]{64}$/u.test(attestation.codex_client_authority_sha256)
            : true) &&
    (currentDirectCodex
      ? fleetAcceptedCodexProfiles().some(
          (profile) =>
            profile.kind === "direct_mcp" && profile.contract === attestation.transport_contract,
        )
      : currentStrictCodex
        ? attestation.code_mode_contract === PURE_FLEET_CODE_MODE_CONTRACT
        : historicalTransportDirectCodex
          ? attestation.transport_contract === SPARK_DIRECT_MCP_TRANSPORT_CONTRACT
          : historicalTransportStrictCodex || historicalClientBoundCodex
            ? attestation.code_mode_contract === PURE_FLEET_CODE_MODE_CONTRACT
            : historicalCodeModeCodex
              ? attestation.code_mode_contract === PURE_FLEET_CODE_MODE_CONTRACT
              : historicalStrictCodex
                ? attestation.code_mode_contract === HISTORICAL_PURE_FLEET_CODE_MODE_CONTRACT
                : true) &&
    (historicalCodex
      ? attestation.initial_report_sha256 === null
      : typeof attestation.report_receipt_bound === "boolean" &&
        (attestation.receipt_binding_sha256 === null ||
          /^[0-9a-f]{64}$/.test(attestation.receipt_binding_sha256)) &&
        (attestation.initial_report_sha256 === null ||
          /^[0-9a-f]{64}$/.test(attestation.initial_report_sha256)) &&
        attestation.report_receipt_bound ===
          (attestation.initial_report_sha256 !== null &&
            attestation.receipt_binding_sha256 !== null) &&
        (attestation.initial_report_sha256 === null) ===
          (attestation.receipt_binding_sha256 === null))
  );
}

export function parsePureFleetAttestation(text) {
  const raw = parseJsonRejectingDuplicateKeys(text, "pure fleet attestation");
  if (!raw.ok) return raw;
  if (!isExactPureFleetAttestation(raw.value)) {
    return { ok: false, reason: "pure fleet attestation does not match its strict schema" };
  }
  return { ok: true, attestation: raw.value };
}

function sha256FileBytes(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function pureFleetArtifactHashes(reportMdPath) {
  const paths = pureFleetRunArtifactPathsFor(reportMdPath);
  return {
    report_sha256: sha256FileBytes(paths.report),
    run_sidecar_sha256: sha256FileBytes(paths.run_sidecar),
    run_evidence_sha256: sha256FileBytes(paths.run_evidence),
    primary_envelope_sha256: sha256FileBytes(paths.primary_envelope),
    initial_report_sha256: artifactEntryExists(paths.initial_report)
      ? sha256FileBytes(paths.initial_report)
      : null,
    receipt_binding_sha256: artifactEntryExists(paths.receipt_binding)
      ? sha256FileBytes(paths.receipt_binding)
      : null,
    recovery_metadata_sha256: artifactEntryExists(paths.recovery_metadata)
      ? sha256FileBytes(paths.recovery_metadata)
      : null,
    recovery_envelope_sha256: artifactEntryExists(paths.recovery_envelope)
      ? sha256FileBytes(paths.recovery_envelope)
      : null,
    provider_events_sha256: artifactEntryExists(paths.provider_events)
      ? sha256FileBytes(paths.provider_events)
      : null,
    provider_rollout_sha256: artifactEntryExists(paths.provider_rollout)
      ? sha256FileBytes(paths.provider_rollout)
      : null,
    provider_capture_sha256: artifactEntryExists(paths.provider_capture)
      ? sha256FileBytes(paths.provider_capture)
      : null,
  };
}

function isExactFleetArtifactHashes(hashes) {
  return (
    hashes !== null &&
    typeof hashes === "object" &&
    /^[0-9a-f]{64}$/.test(hashes.report_sha256) &&
    /^[0-9a-f]{64}$/.test(hashes.run_sidecar_sha256) &&
    /^[0-9a-f]{64}$/.test(hashes.run_evidence_sha256) &&
    /^[0-9a-f]{64}$/.test(hashes.primary_envelope_sha256) &&
    (hashes.initial_report_sha256 === null ||
      /^[0-9a-f]{64}$/.test(hashes.initial_report_sha256)) &&
    (hashes.receipt_binding_sha256 === null ||
      /^[0-9a-f]{64}$/.test(hashes.receipt_binding_sha256)) &&
    (hashes.recovery_metadata_sha256 === null ||
      /^[0-9a-f]{64}$/.test(hashes.recovery_metadata_sha256)) &&
    (hashes.recovery_envelope_sha256 === null ||
      /^[0-9a-f]{64}$/.test(hashes.recovery_envelope_sha256)) &&
    (hashes.provider_events_sha256 === null ||
      /^[0-9a-f]{64}$/.test(hashes.provider_events_sha256)) &&
    (hashes.provider_rollout_sha256 === null ||
      /^[0-9a-f]{64}$/.test(hashes.provider_rollout_sha256)) &&
    (hashes.provider_capture_sha256 === null ||
      /^[0-9a-f]{64}$/.test(hashes.provider_capture_sha256))
  );
}

function artifactEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isExactPureFleetRunArtifactFacts(facts) {
  return (
    facts !== null &&
    typeof facts === "object" &&
    facts.run !== null &&
    typeof facts.run === "object" &&
    typeof facts.game_session_id === "string" &&
    facts.game_session_id.length > 0 &&
    (facts.provider === "claude" || facts.provider === "codex") &&
    typeof facts.provider_session_id === "string" &&
    facts.provider_session_id.length > 0 &&
    typeof facts.actual_model === "string" &&
    facts.actual_model.length > 0 &&
    (facts.actual_provider === "anthropic" || facts.actual_provider === "openai") &&
    typeof facts.report_recovered === "boolean" &&
    typeof facts.report_receipt_bound === "boolean" &&
    (facts.code_mode_contract === null ||
      facts.code_mode_contract === HISTORICAL_PURE_FLEET_CODE_MODE_CONTRACT ||
      facts.code_mode_contract === PURE_FLEET_CODE_MODE_CONTRACT) &&
    (facts.transport_contract === null ||
      facts.transport_contract === SPARK_DIRECT_MCP_TRANSPORT_CONTRACT ||
      facts.transport_contract === GAME_DIRECT_MCP_TRANSPORT_CONTRACT) &&
    isExactFleetArtifactHashes(facts.hashes)
  );
}

async function validatePureFleetRunArtifacts(
  reportMdPath,
  expected,
  reportsDir,
  childTracker = null,
) {
  const expectedProvider = expected.provider ?? "claude";
  const paths = pureFleetRunArtifactPathsFor(reportMdPath);
  for (const [label, path] of [
    ["report", paths.report],
    ["run sidecar", paths.run_sidecar],
    ["raw run evidence", paths.run_evidence],
    ["primary provider envelope", paths.primary_envelope],
  ]) {
    if (!isTrustedFleetArtifactFile(path, reportsDir)) {
      return { ok: false, reason: `${label} must be a contained private regular file` };
    }
  }
  const codexEntries = [
    ["Codex provider events", paths.provider_events],
    ["Codex rollout", paths.provider_rollout],
    ["Codex capture receipt", paths.provider_capture],
  ];
  if (expectedProvider === "codex") {
    for (const [label, path] of codexEntries) {
      if (!isTrustedFleetArtifactFile(path, reportsDir)) {
        return { ok: false, reason: `${label} must be a contained private regular file` };
      }
    }
  } else if (codexEntries.some(([, path]) => artifactEntryExists(path))) {
    return { ok: false, reason: "Claude fleet slot must not contain Codex provider artifacts" };
  }
  if (expectedProvider === "codex") {
    const bindingEntries = [
      ["initial Codex report", paths.initial_report],
      ["receipt binding metadata", paths.receipt_binding],
    ];
    const bindingPresence = bindingEntries.map(([, path]) => artifactEntryExists(path));
    if (bindingPresence.some(Boolean) && !bindingPresence.every(Boolean)) {
      return {
        ok: false,
        reason: "Codex receipt-binding artifacts must be all present or all absent",
      };
    }
    if (
      artifactEntryExists(paths.recovery_metadata) ||
      artifactEntryExists(paths.recovery_envelope)
    ) {
      return { ok: false, reason: "Codex fleet slot must not contain report recovery artifacts" };
    }
    if (bindingPresence.every(Boolean)) {
      for (const [label, path] of bindingEntries) {
        if (!isTrustedFleetArtifactFile(path, reportsDir)) {
          return { ok: false, reason: `${label} must be a contained private regular file` };
        }
      }
    }
  } else {
    const recoveryEntries = [
      ["initial report", paths.initial_report],
      ["recovery metadata", paths.recovery_metadata],
      ["recovery Claude envelope", paths.recovery_envelope],
    ];
    const recoveryPresence = recoveryEntries.map(([, path]) => artifactEntryExists(path));
    if (recoveryPresence.some(Boolean) && !recoveryPresence.every(Boolean)) {
      return { ok: false, reason: "report recovery artifacts must be all present or all absent" };
    }
    if (artifactEntryExists(paths.receipt_binding)) {
      return { ok: false, reason: "Claude fleet slot must not contain receipt binding metadata" };
    }
    if (recoveryPresence.every(Boolean)) {
      for (const [label, path] of recoveryEntries) {
        if (!isTrustedFleetArtifactFile(path, reportsDir)) {
          return { ok: false, reason: `${label} must be a contained private regular file` };
        }
      }
    }
  }

  const tsxCli = join(GAME_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const validatorScript = join(GAME_DIR, "scripts", "validate-pure-fleet-run.ts");
  const result = await spawnAsync(
    process.execPath,
    [
      tsxCli,
      validatorScript,
      "--report",
      reportMdPath,
      "--seed",
      String(expected.seed),
      "--provider",
      expectedProvider,
      "--model",
      expected.model,
      "--git-commit",
      expected.build.git_commit,
      "--world-id",
      expected.build.world_id,
      "--world-hash",
      expected.build.world_hash,
    ],
    { cwd: GAME_DIR, env: { ...process.env } },
    childTracker,
  );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    return {
      ok: false,
      reason: `pure fleet artifact validator returned invalid JSON: ${firstErrorLine(result.stderr)}`,
    };
  }
  if (
    result.status !== 0 ||
    parsed?.ok !== true ||
    !isExactPureFleetRunArtifactFacts(parsed.facts)
  ) {
    return {
      ok: false,
      reason:
        typeof parsed?.reason === "string"
          ? parsed.reason
          : `pure fleet artifact validator failed: ${firstErrorLine(result.stderr)}`,
    };
  }
  return { ok: true, facts: parsed.facts };
}

export function pureFleetAttestationMismatch(attestation, run, expected, artifactFacts) {
  const expectedProvider = expected?.provider ?? "claude";
  if (!isExactPureFleetAttestation(attestation)) {
    return "pure resume requires a valid adjacent fleet attestation";
  }
  if (
    expected === null ||
    typeof expected !== "object" ||
    !Number.isSafeInteger(expected.seed) ||
    !isProviderModel(expectedProvider, expected.model, false) ||
    !isExactPureFleetBuild(expected.build) ||
    (expectedProvider === "codex" && !isExactCodexClientAuthority(expected.client))
  ) {
    return "pure resume requires an exact expected seed, model, clean fleet build, and Codex client authority";
  }
  if (attestation.run_seed !== expected.seed || attestation.run_seed !== run?.run_seed) {
    return "pure fleet attestation seed does not match the plan and run evidence";
  }
  if (attestation.model !== expected.model) {
    return "pure fleet attestation model does not match the planned model";
  }
  const attestationProvider = attestation.schema_version === 2 ? "claude" : attestation.provider;
  if (attestationProvider !== expectedProvider || artifactFacts.provider !== expectedProvider) {
    return "pure fleet attestation provider does not match the planned provider";
  }
  if (
    expectedProvider === "codex" &&
    attestation.schema_version !== PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION
  ) {
    return `current Codex resume requires attestation v${PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION}`;
  }
  if (
    expectedProvider === "codex" &&
    (attestation.codex_cli_version !== expected.client.cli_version ||
      attestation.codex_client_authority_sha256 !== expected.client.authority_sha256)
  ) {
    return "pure fleet attestation Codex client authority differs from the fleet-wide gate";
  }
  if (
    !samePureFleetBuild(attestation.build, expected.build) ||
    !samePureFleetBuild(attestation.build, run?.build)
  ) {
    return "pure fleet attestation build does not match the plan and run evidence";
  }
  if (!isExactPureFleetRunArtifactFacts(artifactFacts)) {
    return "pure fleet attestation requires semantically validated run artifacts";
  }
  if (!isDeepStrictEqual(artifactFacts.run, run)) {
    return "raw run evidence does not reproduce the verifier run sidecar";
  }
  if (
    attestation.game_session_id !== run?.session_id ||
    attestation.game_session_id !== artifactFacts.game_session_id
  ) {
    return "pure fleet attestation game session does not match the run evidence";
  }
  const attestedProviderSession =
    attestation.schema_version === 2
      ? attestation.claude_session_id
      : attestation.provider_session_id;
  if (attestedProviderSession !== artifactFacts.provider_session_id) {
    return "pure fleet attestation provider session does not match authenticated artifacts";
  }
  if (attestation.actual_model !== artifactFacts.actual_model) {
    return "pure fleet attestation actual model does not match the primary envelope";
  }
  if (
    expectedProvider === "codex" &&
    (attestation.actual_provider !== artifactFacts.actual_provider ||
      attestation.reasoning_effort !== artifactFacts.reasoning_effort ||
      attestation.provider_turn_id !== artifactFacts.provider_turn_id ||
      attestation.provider_cwd !== artifactFacts.provider_cwd)
  ) {
    return "pure fleet attestation Codex rollout facts do not match authenticated artifacts";
  }
  if (attestation.schema_version === PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION) {
    const expectedTransportContract = fleetTransportProfile(expected.model).transportContract;
    if (expectedTransportContract === PURE_FLEET_CODE_MODE_CONTRACT) {
      if (
        attestation.code_mode_contract !== PURE_FLEET_CODE_MODE_CONTRACT ||
        Object.hasOwn(attestation, "transport_contract") ||
        artifactFacts.code_mode_contract !== PURE_FLEET_CODE_MODE_CONTRACT ||
        artifactFacts.transport_contract !== null
      ) {
        return `current Codex attestation requires authenticated ${PURE_FLEET_CODE_MODE_CONTRACT} evidence`;
      }
    } else if (
      attestation.transport_contract !== expectedTransportContract ||
      Object.hasOwn(attestation, "code_mode_contract") ||
      artifactFacts.transport_contract !== expectedTransportContract ||
      artifactFacts.code_mode_contract !== null
    ) {
      return `current Codex attestation requires authenticated ${expectedTransportContract} evidence`;
    }
  }
  if (attestation.report_recovered !== artifactFacts.report_recovered) {
    return "pure fleet attestation recovery status does not match durable recovery evidence";
  }
  const attestedReceiptBound =
    attestation.schema_version === PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION ||
    attestation.schema_version === HISTORICAL_CLIENT_BOUND_CODEX_ATTESTATION_SCHEMA_VERSION ||
    attestation.schema_version === HISTORICAL_CODE_MODE_CODEX_ATTESTATION_SCHEMA_VERSION ||
    attestation.schema_version === HISTORICAL_STRICT_CODEX_ATTESTATION_SCHEMA_VERSION ||
    attestation.schema_version === HISTORICAL_RECEIPT_BOUND_CODEX_ATTESTATION_SCHEMA_VERSION
      ? attestation.report_receipt_bound
      : false;
  if (attestedReceiptBound !== artifactFacts.report_receipt_bound) {
    return "pure fleet attestation receipt-binding status does not match durable artifacts";
  }
  if (attestation.receipt_hash !== run?.receipt?.receiptHash) {
    return "pure fleet attestation receipt hash does not match the verified receipt";
  }
  if (
    !isExactFleetArtifactHashes(artifactFacts.hashes) ||
    attestation.report_sha256 !== artifactFacts.hashes.report_sha256 ||
    attestation.run_sidecar_sha256 !== artifactFacts.hashes.run_sidecar_sha256 ||
    attestation.run_evidence_sha256 !== artifactFacts.hashes.run_evidence_sha256 ||
    attestation.primary_envelope_sha256 !== artifactFacts.hashes.primary_envelope_sha256 ||
    attestation.initial_report_sha256 !== artifactFacts.hashes.initial_report_sha256 ||
    (attestation.schema_version === PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION ||
    attestation.schema_version === HISTORICAL_CLIENT_BOUND_CODEX_ATTESTATION_SCHEMA_VERSION ||
    attestation.schema_version === HISTORICAL_CODE_MODE_CODEX_ATTESTATION_SCHEMA_VERSION ||
    attestation.schema_version === HISTORICAL_STRICT_CODEX_ATTESTATION_SCHEMA_VERSION ||
    attestation.schema_version === HISTORICAL_RECEIPT_BOUND_CODEX_ATTESTATION_SCHEMA_VERSION
      ? attestation.receipt_binding_sha256 !== artifactFacts.hashes.receipt_binding_sha256
      : artifactFacts.hashes.receipt_binding_sha256 !== null) ||
    attestation.recovery_metadata_sha256 !== artifactFacts.hashes.recovery_metadata_sha256 ||
    attestation.recovery_envelope_sha256 !== artifactFacts.hashes.recovery_envelope_sha256 ||
    (expectedProvider === "codex" &&
      (attestation.provider_events_sha256 !== artifactFacts.hashes.provider_events_sha256 ||
        attestation.provider_rollout_sha256 !== artifactFacts.hashes.provider_rollout_sha256 ||
        attestation.provider_capture_sha256 !== artifactFacts.hashes.provider_capture_sha256))
  ) {
    return "pure fleet attestation artifact hashes do not match the authenticated run bytes";
  }
  return null;
}

function buildPureFleetAttestation(run, expected, artifactFacts) {
  const expectedProvider = expected.provider ?? "claude";
  const common = {
    run_seed: expected.seed,
    model: expected.model,
    persona: "default",
    target: "overworld",
    play_mode: "pure",
    start_surface: "fresh_overworld",
    build: expected.build,
    game_session_id: run.session_id,
    actual_model: artifactFacts.actual_model,
    report_recovered: artifactFacts.report_recovered,
    receipt_hash: run.receipt.receiptHash,
    report_sha256: artifactFacts.hashes.report_sha256,
    run_sidecar_sha256: artifactFacts.hashes.run_sidecar_sha256,
    run_evidence_sha256: artifactFacts.hashes.run_evidence_sha256,
    primary_envelope_sha256: artifactFacts.hashes.primary_envelope_sha256,
    initial_report_sha256: artifactFacts.hashes.initial_report_sha256,
    recovery_metadata_sha256: artifactFacts.hashes.recovery_metadata_sha256,
    recovery_envelope_sha256: artifactFacts.hashes.recovery_envelope_sha256,
  };
  const attestation =
    expectedProvider === "codex"
      ? {
          ...common,
          schema_version: PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION,
          provider: "codex",
          codex_cli_version: expected.client.cli_version,
          codex_client_authority_sha256: expected.client.authority_sha256,
          ...(artifactFacts.transport_contract === null
            ? { code_mode_contract: artifactFacts.code_mode_contract }
            : { transport_contract: artifactFacts.transport_contract }),
          provider_session_id: artifactFacts.provider_session_id,
          actual_provider: artifactFacts.actual_provider,
          reasoning_effort: artifactFacts.reasoning_effort,
          provider_turn_id: artifactFacts.provider_turn_id,
          provider_cwd: artifactFacts.provider_cwd,
          report_receipt_bound: artifactFacts.report_receipt_bound,
          receipt_binding_sha256: artifactFacts.hashes.receipt_binding_sha256,
          provider_events_sha256: artifactFacts.hashes.provider_events_sha256,
          provider_rollout_sha256: artifactFacts.hashes.provider_rollout_sha256,
          provider_capture_sha256: artifactFacts.hashes.provider_capture_sha256,
        }
      : {
          ...common,
          schema_version: PURE_FLEET_ATTESTATION_SCHEMA_VERSION,
          claude_session_id: artifactFacts.provider_session_id,
        };
  const mismatch = pureFleetAttestationMismatch(attestation, run, expected, artifactFacts);
  if (mismatch !== null) throw new Error(mismatch);
  return attestation;
}

export async function writeFreshPureFleetAttestation(
  reportMdPath,
  run,
  expected,
  reportsDir = dirname(reportMdPath),
  childTracker = null,
) {
  const validation = await validatePureFleetRunArtifacts(
    reportMdPath,
    expected,
    reportsDir,
    childTracker,
  );
  if (!validation.ok) throw new Error(validation.reason);
  const attestation = buildPureFleetAttestation(run, expected, validation.facts);
  writeFileSync(
    fleetAttestationPathFor(reportMdPath),
    `${JSON.stringify(attestation, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return attestation;
}

function pureFleetEvidenceMismatch(run, expected) {
  const expectedProvider = expected?.provider ?? "claude";
  if (
    expected === null ||
    typeof expected !== "object" ||
    !Number.isSafeInteger(expected.seed) ||
    !isProviderModel(expectedProvider, expected.model, false) ||
    !isExactPureFleetBuild(expected.build) ||
    (expectedProvider === "codex" && !isExactCodexClientAuthority(expected.client))
  ) {
    return "pure resume requires an exact expected seed, model, clean fleet build, and Codex client authority";
  }
  if (run?.schema_version !== PURE_FLEET_EVIDENCE_SCHEMA_VERSION) {
    return `pure resume requires evidence schema v${PURE_FLEET_EVIDENCE_SCHEMA_VERSION}`;
  }
  if (run?.receipt?.contractVersion !== PURE_SESSION_CONTRACT_VERSION) {
    return `pure resume requires journey contract v${PURE_SESSION_CONTRACT_VERSION}`;
  }
  if (run.run_seed !== expected.seed) {
    return `pure resume evidence seed ${String(run.run_seed)} does not match planned seed ${expected.seed}`;
  }
  if (!samePureFleetBuild(run.build, expected.build)) {
    return "pure resume evidence build does not match the authenticated fleet build";
  }
  return null;
}

async function verifyReportEvidence(
  reportMdPath,
  requiredMode,
  expectedPure = null,
  reportsDir = dirname(reportMdPath),
  childTracker = null,
) {
  const runSidecarPath = runSidecarPathFor(reportMdPath);
  if (
    !isTrustedFleetArtifactFile(reportMdPath, reportsDir) ||
    !isTrustedFleetArtifactFile(runSidecarPath, reportsDir)
  ) {
    return {
      ok: false,
      stdout: "",
      stderr: "fleet report and run sidecar must be contained regular non-symlink files",
      run: null,
    };
  }
  const tsxCli = join(GAME_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const verifierScript = join(GAME_DIR, "scripts", "verify-blind-report.ts");
  const result = await spawnAsync(
    process.execPath,
    [
      tsxCli,
      verifierScript,
      reportMdPath,
      "--require-mode",
      requiredMode,
      "--run-sidecar",
      runSidecarPath,
      "--json",
    ],
    { cwd: GAME_DIR, env: { ...process.env } },
    childTracker,
  );
  let run = null;
  if (result.status === 0) {
    try {
      run = JSON.parse(result.stdout.trim()).run ?? null;
    } catch {
      return {
        ok: false,
        stdout: result.stdout,
        stderr: "verifier returned invalid JSON",
        run: null,
      };
    }
    const pureMismatch =
      requiredMode === "pure" ? pureFleetEvidenceMismatch(run, expectedPure) : null;
    if (pureMismatch !== null) {
      return {
        ok: false,
        stdout: result.stdout,
        stderr: pureMismatch,
        run,
      };
    }
  }
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr, run };
}

export async function verifyReportForResume(
  reportMdPath,
  requiredMode,
  expectedPure = null,
  reportsDir = dirname(reportMdPath),
  childTracker = null,
) {
  const verified = await verifyReportEvidence(
    reportMdPath,
    requiredMode,
    expectedPure,
    reportsDir,
    childTracker,
  );
  if (!verified.ok || requiredMode !== "pure") {
    return { ...verified, attestation: null };
  }
  const attestationPath = fleetAttestationPathFor(reportMdPath);
  if (!isTrustedFleetArtifactFile(attestationPath, reportsDir)) {
    return {
      ...verified,
      ok: false,
      stderr:
        "pure resume requires an adjacent contained regular non-symlink runner-owned fleet attestation",
      attestation: null,
    };
  }
  let parsed;
  try {
    parsed = parsePureFleetAttestation(readFileSync(attestationPath, "utf8"));
  } catch (error) {
    return {
      ...verified,
      ok: false,
      stderr: `pure fleet attestation could not be read: ${error instanceof Error ? error.message : String(error)}`,
      attestation: null,
    };
  }
  if (!parsed.ok) {
    return { ...verified, ok: false, stderr: parsed.reason, attestation: null };
  }
  if (
    (expectedPure?.provider ?? "claude") === "codex" &&
    parsed.attestation.schema_version !== PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION
  ) {
    return {
      ...verified,
      ok: false,
      stderr: `current Codex resume requires attestation v${PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION}`,
      attestation: parsed.attestation,
    };
  }
  const artifactValidation = await validatePureFleetRunArtifacts(
    reportMdPath,
    expectedPure,
    reportsDir,
    childTracker,
  );
  if (!artifactValidation.ok) {
    return {
      ...verified,
      ok: false,
      stderr: artifactValidation.reason,
      attestation: parsed.attestation,
    };
  }
  const mismatch = pureFleetAttestationMismatch(
    parsed.attestation,
    verified.run,
    expectedPure,
    artifactValidation.facts,
  );
  if (mismatch !== null) {
    return { ...verified, ok: false, stderr: mismatch, attestation: parsed.attestation };
  }
  return { ...verified, attestation: parsed.attestation };
}

async function captureExpectedPureFleetBuild(childTracker = null) {
  const tsxCli = join(GAME_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const script = join(GAME_DIR, "scripts", "print-pure-fleet-build.ts");
  const result = await spawnAsync(
    process.execPath,
    [tsxCli, script, GAME_DIR],
    {
      cwd: GAME_DIR,
      env: { ...process.env },
    },
    childTracker,
  );
  if (result.status !== 0) {
    throw new Error(
      `fleet: pure build preflight failed: ${firstErrorLine(result.stderr || result.stdout)}`,
    );
  }
  let build;
  try {
    build = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("fleet: pure build preflight returned invalid JSON");
  }
  if (!isExactPureFleetBuild(build)) {
    throw new Error("fleet: pure build preflight returned an invalid or dirty build identity");
  }
  return build;
}

export function createFleetLaunchControl({ captureBuild, childTracker = null } = {}) {
  if (typeof captureBuild !== "function") {
    throw new Error("fleet: launch control requires an exact-build capture function");
  }
  return {
    abortFailure: null,
    captureBuild,
    childTracker,
    launchGateTail: Promise.resolve(),
  };
}

async function withSerializedFleetLaunchGate(control, operation) {
  const predecessor = control.launchGateTail;
  let releaseGate;
  control.launchGateTail = new Promise((resolvePromise) => {
    releaseGate = resolvePromise;
  });
  await predecessor;
  try {
    if (control.abortFailure !== null) throw control.abortFailure;
    return await operation();
  } finally {
    releaseGate();
  }
}

async function captureFleetBuildOrAbort(control, boundary) {
  if (control.abortFailure !== null) throw control.abortFailure;
  try {
    return await control.captureBuild();
  } catch (cause) {
    const error = new Error(
      `fleet: exact build capture failed at ${boundary}; no later fleet slot or retry may spend tokens`,
      { cause },
    );
    control.abortFailure ??= error;
    throw control.abortFailure;
  }
}

export async function assertExactBuildAtFleetBoundary(control, expectedBuild, boundary) {
  return withSerializedFleetLaunchGate(control, async () => {
    const actualBuild = await captureFleetBuildOrAbort(control, boundary);
    if (!samePureFleetBuild(actualBuild, expectedBuild)) {
      const error = new Error(
        `fleet: exact build drift detected at ${boundary}; no later fleet slot or retry may spend tokens`,
      );
      control.abortFailure ??= error;
      throw error;
    }
    return actualBuild;
  });
}

export async function launchAfterExactBuildGate(control, expectedBuild, boundary, launch) {
  let launchedPromise = null;
  await withSerializedFleetLaunchGate(control, async () => {
    const actualBuild = await captureFleetBuildOrAbort(control, boundary);
    if (!samePureFleetBuild(actualBuild, expectedBuild)) {
      const error = new Error(
        `fleet: exact build drift detected at ${boundary}; no later fleet slot or retry may spend tokens`,
      );
      control.abortFailure ??= error;
      throw error;
    }
    if (control.abortFailure !== null) throw control.abortFailure;
    launchedPromise = launch();
    if (launchedPromise?.hasDeferredStart === true) {
      try {
        await launchedPromise.launchReady;
        const preResumeBuild = await captureFleetBuildOrAbort(control, `${boundary} pre-resume`);
        if (!samePureFleetBuild(preResumeBuild, expectedBuild)) {
          const error = new Error(
            `fleet: exact build drift detected at ${boundary} pre-resume; no later fleet slot or retry may spend tokens`,
          );
          control.abortFailure ??= error;
          throw error;
        }
        if (control.abortFailure !== null) throw control.abortFailure;
        if (launchedPromise.resumeLaunch() !== true) {
          throw new Error(`fleet: Windows launcher could not resume at ${boundary}`);
        }
        await launchedPromise.launchStarted;
      } catch (error) {
        launchedPromise.abortLaunch();
        await launchedPromise;
        throw error;
      }
    }
  });
  return launchedPromise;
}

/** Pure matcher (exported for tests): which `readdirSync` entries are resume
 * candidates for (sourceSlug, seed), newest-stamp-first. The regex is fully
 * anchored (`^...$`) so e.g. seed `1` can never match a `seed10` filename —
 * the literal `\.md$` immediately after the seed digits rules that out.
 * Filenames sort newest-first by plain string descending order because the
 * leading stamp (yyyymmddThhmmssZ) is lexicographically monotonic with time. */
export function resumeCandidatesFor(entries, sourceSlug, seed) {
  const re = new RegExp(
    `^\\d{8}T\\d{6}Z_${escapeRegExp(sourceSlug)}_seed${escapeRegExp(String(seed))}\\.md$`,
  );
  return [...new Set(entries.filter((f) => re.test(f)))].sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );
}

/** Stamp-agnostic resume lookup: ALL existing reports matching this run's
 * source slug + seed, regardless of which fleet stamp produced them, newest
 * first — a stale FAILED report from an earlier invocation must not shadow a
 * later VERIFIED one from a subsequent invocation. */
function findExistingReport(reportsDir, target, seed) {
  const slug = sourceSlugFor(target);
  let entries;
  try {
    entries = readdirSync(reportsDir);
  } catch {
    return [];
  }
  const seenFiles = new Set();
  return resumeCandidatesFor(entries, slug, seed)
    .map((f) => join(reportsDir, f))
    .filter((candidate) => {
      if (!isTrustedFleetArtifactFile(candidate, reportsDir)) return false;
      try {
        const identity = trustedArtifactIdentity(candidate);
        if (seenFiles.has(identity)) return false;
        seenFiles.add(identity);
        return true;
      } catch {
        return false;
      }
    });
}

/** Last ~n chars of a string — bounded tail for per-attempt diagnostic logs. */
function tail(s, n = 2000) {
  return s.length > n ? s.slice(-n) : s;
}

/** First error-looking line of stderr (falls back to the first non-blank
 * line, then a placeholder) — the one-line summary printed to fleet's own
 * stderr on a failed attempt. */
function firstErrorLine(text) {
  if (!text) return "(no stderr)";
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /error/i.test(l)) ?? lines[0] ?? "(empty stderr)";
}

/**
 * A strict-stream rejection can include provider-controlled stderr, so its
 * fleet archive receives only this fixed structural diagnostic. Keep this
 * separate from ordinary failed-attempt tails: this record is noncanonical
 * and contains commitments, never provider output or paths.
 */
export function strictRejectionFleetDiagnostic({ run, attempt, exit, fleetClient }) {
  return (
    [
      "schema_version=1",
      "diagnostic=strict_stream_rejection",
      `classification=strict_stream_rejected`,
      `attempt=${attempt}`,
      `seed=${run.seed}`,
      `run.sh_exit=${exit}`,
      `model=${run.model}`,
      `cli_version=${fleetClient.cli_version}`,
      `client_authority_sha256=${fleetClient.authority_sha256}`,
    ].join("\n") + "\n"
  );
}

export const FLEET_ATTEMPT_CLASSIFICATIONS = Object.freeze([
  "technical_timeout",
  "strict_stream_rejected",
  "launcher_or_run_failure",
  "verifier_failure",
  "verified",
]);

/** Classify one launcher attempt from durable process/evidence facts. A
 * timeout wins over the stage marker because report-recovery itself may time
 * out after the first verifier ran. */
export function classifyFleetAttempt({ runnerExit, verifierAttempted, verified }) {
  if (verified) return "verified";
  if (runnerExit === 124 || runnerExit === 137) return "technical_timeout";
  if (runnerExit === 43) return "strict_stream_rejected";
  if (runnerExit === 0 || verifierAttempted) return "verifier_failure";
  return "launcher_or_run_failure";
}

/** Strict-stream rejection proves that this exact code-mode transport profile
 * is already invalid. Retrying it cannot produce canonical evidence and only
 * spends more tokens. Other operational failures retain the normal backoff. */
export function shouldRetryFleetAttempt({ classification, attempt, maxAttempts }) {
  return attempt + 1 < maxAttempts && classification !== "strict_stream_rejected";
}

function reportPrefixFor(reportMdPath) {
  return reportMdPath.endsWith(".md") ? reportMdPath.slice(0, -".md".length) : reportMdPath;
}

function recoveryMarkerPathFor(reportMdPath) {
  return `${reportPrefixFor(reportMdPath)}.initial-report.txt`;
}

/** `run.sh` writes `.initial-report.txt` before its one permitted same-session,
 * report-only repair. On an exit-0 run that regular adjacent file is the
 * durable fact that the accepted Markdown was recovered rather than the
 * model's first response. The `.txt` suffix deliberately keeps the rejected
 * response outside feedback compiler `*.md` discovery. */
export function pureFleetReportWasRecovered(reportMdPath, reportsDir = dirname(reportMdPath)) {
  const marker = recoveryMarkerPathFor(reportMdPath);
  if (!existsSync(marker)) return false;
  if (!isTrustedFleetArtifactFile(marker, reportsDir)) {
    throw new Error("report-recovery marker must be a contained regular non-symlink file");
  }
  const receiptBinding = `${reportPrefixFor(reportMdPath)}.receipt-bind.json`;
  if (existsSync(receiptBinding)) {
    if (!isTrustedFleetArtifactFile(receiptBinding, reportsDir)) {
      throw new Error("receipt-binding metadata must be a contained regular non-symlink file");
    }
    return false;
  }
  return true;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasExactKeys(value, expectedKeys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...expectedKeys].sort())
  );
}

function isSafeStrictRejectionDiagnostic(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength > 4 * 1024) return false;
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return false;
  const parsed = parseJsonRejectingDuplicateKeys(text, "strict rejection diagnostic");
  if (parsed.ok && parsed.value?.schema_version === 2) {
    const diagnostic = parsed.value;
    const failures = CODEX_STRICT_STREAM_DIAGNOSTIC_FAILURES[diagnostic.surface];
    const usage = diagnostic.usage_lower_bound;
    return (
      hasExactKeys(diagnostic, [
        "acceptance_eligible",
        "binding",
        "canonical",
        "commitments",
        "ignored",
        "kind",
        "rejection",
        "schema_version",
        "surface",
        "transport_contract",
        "usage_lower_bound",
      ]) &&
      diagnostic.acceptance_eligible === false &&
      diagnostic.canonical === false &&
      diagnostic.ignored === true &&
      diagnostic.kind === "strict_stream_rejection_diagnostic" &&
      Array.isArray(failures) &&
      [
        CODEX_STRICT_CURRENT_CONTRACT,
        CODEX_SPARK_DIRECT_MCP_CONTRACT,
        GAME_DIRECT_MCP_TRANSPORT_CONTRACT,
      ].includes(diagnostic.transport_contract) &&
      (diagnostic.surface !== "private_rollout" ||
        [CODEX_SPARK_DIRECT_MCP_CONTRACT, GAME_DIRECT_MCP_TRANSPORT_CONTRACT].includes(
          diagnostic.transport_contract,
        )) &&
      hasExactKeys(diagnostic.commitments, [
        "build_commit",
        "cli_version",
        "client_authority_sha256",
        "model",
        "seed",
        "tracked_worktree_clean",
      ]) &&
      /^-?[0-9]+$/u.test(diagnostic.commitments.seed) &&
      Number.isSafeInteger(Number(diagnostic.commitments.seed)) &&
      String(Number(diagnostic.commitments.seed)) === diagnostic.commitments.seed &&
      /^[0-9a-f]{40}$/u.test(diagnostic.commitments.build_commit) &&
      typeof diagnostic.commitments.tracked_worktree_clean === "boolean" &&
      /^[A-Za-z0-9._-]{1,128}$/u.test(diagnostic.commitments.model) &&
      /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(diagnostic.commitments.cli_version) &&
      /^[0-9a-f]{64}$/u.test(diagnostic.commitments.client_authority_sha256) &&
      hasExactKeys(diagnostic.binding, [
        "row_ordinal",
        "row_projection_bytes",
        "row_projection_sha256",
        "stream_file_identity",
        "thread_id",
      ]) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        diagnostic.binding.thread_id,
      ) &&
      Number.isSafeInteger(diagnostic.binding.row_ordinal) &&
      diagnostic.binding.row_ordinal > 0 &&
      Number.isSafeInteger(diagnostic.binding.row_projection_bytes) &&
      diagnostic.binding.row_projection_bytes > 0 &&
      /^[0-9a-f]{64}$/u.test(diagnostic.binding.row_projection_sha256) &&
      hasExactKeys(diagnostic.binding.stream_file_identity, ["device_id", "file_id"]) &&
      /^\d+$/u.test(diagnostic.binding.stream_file_identity.device_id) &&
      /^\d+$/u.test(diagnostic.binding.stream_file_identity.file_id) &&
      hasExactKeys(diagnostic.rejection, ["failure"]) &&
      failures.includes(diagnostic.rejection.failure) &&
      (usage === null ||
        (hasExactKeys(usage, [
          "cached_input_tokens",
          "input_tokens",
          "output_tokens",
          "reasoning_output_tokens",
        ]) &&
          [
            usage.input_tokens,
            usage.cached_input_tokens,
            usage.output_tokens,
            usage.reasoning_output_tokens,
          ].every((value) => Number.isSafeInteger(value) && value >= 0) &&
          usage.cached_input_tokens <= usage.input_tokens &&
          usage.reasoning_output_tokens <= usage.output_tokens))
    );
  }
  if (
    !parsed.ok ||
    !hasExactKeys(parsed.value, [
      "acceptance_eligible",
      "binding",
      "canonical",
      "code_mode_contract",
      "commitments",
      "ignored",
      "kind",
      "schema_version",
      "surface",
      "wrapper",
    ])
  ) {
    return false;
  }
  const diagnostic = parsed.value;
  if (
    diagnostic.schema_version !== 1 ||
    diagnostic.acceptance_eligible !== false ||
    diagnostic.canonical !== false ||
    diagnostic.code_mode_contract !== "strict-code-mode-v2" ||
    diagnostic.ignored !== true ||
    diagnostic.kind !== "strict_wrapper_rejection_diagnostic" ||
    diagnostic.surface !== "private_rollout" ||
    !hasExactKeys(diagnostic.commitments, [
      "build_commit",
      "cli_version",
      "client_authority_sha256",
      "model",
      "seed",
      "tracked_worktree_clean",
    ]) ||
    !/^-?[0-9]+$/u.test(diagnostic.commitments.seed) ||
    !Number.isSafeInteger(Number(diagnostic.commitments.seed)) ||
    String(Number(diagnostic.commitments.seed)) !== diagnostic.commitments.seed ||
    !/^[0-9a-f]{40}$/u.test(diagnostic.commitments.build_commit) ||
    typeof diagnostic.commitments.tracked_worktree_clean !== "boolean" ||
    !/^[A-Za-z0-9._-]{1,128}$/u.test(diagnostic.commitments.model) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(diagnostic.commitments.cli_version) ||
    !/^[0-9a-f]{64}$/u.test(diagnostic.commitments.client_authority_sha256) ||
    !hasExactKeys(diagnostic.binding, [
      "rollout_file_identity",
      "thread_id",
      "wrapper_call_id_sha256",
      "wrapper_item_id_sha256",
    ]) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      diagnostic.binding.thread_id,
    ) ||
    !/^[0-9a-f]{64}$/u.test(diagnostic.binding.wrapper_item_id_sha256) ||
    !/^[0-9a-f]{64}$/u.test(diagnostic.binding.wrapper_call_id_sha256) ||
    !hasExactKeys(diagnostic.binding.rollout_file_identity, ["device_id", "file_id"]) ||
    !/^\d+$/u.test(diagnostic.binding.rollout_file_identity.device_id) ||
    !/^\d+$/u.test(diagnostic.binding.rollout_file_identity.file_id) ||
    !hasExactKeys(diagnostic.wrapper, ["failure", "input_bytes", "input_sha256"]) ||
    !CODEX_GAMEPLAY_WRAPPER_FAILURES.includes(diagnostic.wrapper.failure) ||
    !Number.isSafeInteger(diagnostic.wrapper.input_bytes) ||
    diagnostic.wrapper.input_bytes < 0 ||
    !/^[0-9a-f]{64}$/u.test(diagnostic.wrapper.input_sha256)
  ) {
    return false;
  }
  return true;
}

function isSafeStrictFleetDiagnostic(diagnostic) {
  if (typeof diagnostic !== "string" || Buffer.byteLength(diagnostic, "utf8") > 4 * 1024) {
    return false;
  }
  const lines = diagnostic.split("\n");
  if (lines.length !== 10 || lines.at(-1) !== "") return false;
  const expected = [
    "schema_version=1",
    "diagnostic=strict_stream_rejection",
    "classification=strict_stream_rejected",
  ];
  if (!isDeepStrictEqual(lines.slice(0, 3), expected)) return false;
  const values = Object.fromEntries(
    lines.slice(3, -1).map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
  return (
    isDeepStrictEqual(Object.keys(values).sort(), [
      "attempt",
      "cli_version",
      "client_authority_sha256",
      "model",
      "run.sh_exit",
      "seed",
    ]) &&
    /^[1-9][0-9]*$/u.test(values.attempt) &&
    /^-?[0-9]+$/u.test(values.seed) &&
    Number.isSafeInteger(Number(values.seed)) &&
    String(Number(values.seed)) === values.seed &&
    /^[0-9]+$/u.test(values["run.sh_exit"]) &&
    /^[A-Za-z0-9._-]{1,128}$/u.test(values.model) &&
    /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(values.cli_version) &&
    /^[0-9a-f]{64}$/u.test(values.client_authority_sha256)
  );
}

function fleetRelativePath(fleetDir, path) {
  return relative(fleetDir, path).split(sep).join("/");
}

/** Copy every artifact owned by a failed out-prefix into a unique per-slot,
 * per-attempt directory before the next launcher can overwrite it. Only after
 * every exclusive copy and its diagnostic log exist are the source files
 * removed. The returned closed index is embedded in the final manifest. */
export function archiveFailedFleetAttemptArtifacts({
  outPrefix,
  fleetDir,
  seed,
  attempt,
  diagnostic,
  diagnosticOnly = false,
}) {
  const sourceDir = dirname(outPrefix);
  const sourceBase = basename(outPrefix);
  const attemptDir = join(fleetDir, "attempts", `seed_${seed}`, `attempt_${attempt}`);
  mkdirSync(dirname(attemptDir), { recursive: true });
  mkdirSync(attemptDir);

  const ownedSources = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith(`${sourceBase}.`))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const source = join(sourceDir, entry.name);
      const metadata = lstatSync(source);
      if (
        entry.isSymbolicLink() ||
        metadata.isSymbolicLink() ||
        !entry.isFile() ||
        !metadata.isFile() ||
        metadata.nlink !== 1
      ) {
        throw new Error(`fleet: failed-attempt artifact is not a private regular file: ${source}`);
      }
      return { source, name: entry.name };
    });
  // A strict-stream rejection is never retention or usage evidence. Preserve
  // only its bounded structural diagnostic. Filter names before any source
  // bytes are read, then discard every owned raw provider artifact after the
  // fleet log is sealed so a retry cannot inherit it.
  const sources = diagnosticOnly
    ? ownedSources.filter((source) => source.name === `${sourceBase}.strict-rejection.json`)
    : ownedSources;
  if (diagnosticOnly && !isSafeStrictFleetDiagnostic(diagnostic)) {
    throw new Error("fleet: strict rejection archive requires one safe structural diagnostic");
  }

  const usageArtifacts = {
    primary_envelope: null,
    provider_events: null,
  };
  const archived = [];
  for (const candidate of sources) {
    const source = { ...candidate, bytes: readFileSync(candidate.source) };
    if (diagnosticOnly && !isSafeStrictRejectionDiagnostic(source.bytes)) {
      throw new Error("fleet: strict rejection diagnostic is malformed or unsafe");
    }
    const destination = join(attemptDir, source.name);
    writeFileSync(destination, source.bytes, { flag: "wx", mode: 0o600 });
    if (source.name === `${sourceBase}.json`) usageArtifacts.primary_envelope = source.name;
    if (source.name === `${sourceBase}.codex.jsonl`) usageArtifacts.provider_events = source.name;
    archived.push({
      name: source.name,
      bytes: source.bytes.byteLength,
      sha256: sha256Bytes(source.bytes),
    });
  }
  const diagnosticName = "fleet-diagnostic.log";
  const diagnosticBytes = Buffer.from(diagnostic, "utf8");
  writeFileSync(join(attemptDir, diagnosticName), diagnosticBytes, { flag: "wx", mode: 0o600 });
  archived.push({
    name: diagnosticName,
    bytes: diagnosticBytes.byteLength,
    sha256: sha256Bytes(diagnosticBytes),
  });

  for (const source of ownedSources) unlinkSync(source.source);
  archived.sort((left, right) => left.name.localeCompare(right.name));
  return {
    directory: fleetRelativePath(fleetDir, attemptDir),
    artifacts: archived,
    usage_artifacts: usageArtifacts,
  };
}

function archivedArtifactText({ archive, fleetDir, name }) {
  if (
    archive === null ||
    typeof archive !== "object" ||
    Array.isArray(archive) ||
    typeof name !== "string" ||
    name.length === 0 ||
    basename(name) !== name ||
    !Array.isArray(archive.artifacts) ||
    typeof archive.directory !== "string" ||
    archive.directory.length === 0
  ) {
    return null;
  }
  const matches = archive.artifacts.filter(
    (artifact) => artifact !== null && typeof artifact === "object" && artifact.name === name,
  );
  if (
    matches.length !== 1 ||
    !Number.isSafeInteger(matches[0].bytes) ||
    matches[0].bytes < 0 ||
    typeof matches[0].sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(matches[0].sha256)
  ) {
    return null;
  }
  try {
    const fleetRoot = realpathSync(fleetDir);
    const artifactPath = resolve(fleetDir, archive.directory, name);
    const artifactReal = realpathSync.native(artifactPath);
    const fromRoot = relative(fleetRoot, artifactReal);
    if (
      fromRoot === "" ||
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      return null;
    }
    const metadata = lstatSync(artifactPath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) return null;
    const bytes = readFileSync(artifactReal);
    if (bytes.byteLength !== matches[0].bytes || sha256Bytes(bytes) !== matches[0].sha256)
      return null;
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}

function archivedUsageArtifactText({ archive, fleetDir, role }) {
  if (
    archive === null ||
    typeof archive !== "object" ||
    Array.isArray(archive) ||
    archive.usage_artifacts === null ||
    typeof archive.usage_artifacts !== "object" ||
    Array.isArray(archive.usage_artifacts) ||
    !Object.prototype.hasOwnProperty.call(archive.usage_artifacts, role)
  ) {
    return null;
  }
  const name = archive.usage_artifacts[role];
  return name === null ? null : archivedArtifactText({ archive, fleetDir, name });
}

function archivedStrictRejectionDiagnosticText({ archive, fleetDir }) {
  if (!Array.isArray(archive?.artifacts)) return null;
  const matches = archive.artifacts.filter(
    (artifact) =>
      artifact !== null &&
      typeof artifact === "object" &&
      typeof artifact.name === "string" &&
      artifact.name.endsWith(".strict-rejection.json"),
  );
  return matches.length === 1
    ? archivedArtifactText({ archive, fleetDir, name: matches[0].name })
    : null;
}

/**
 * Failed-attempt usage comes only from immutable copies named by the archive's
 * semantic usage map. A malformed archived primary remains authoritative and
 * deliberately prevents a provider-event fallback.
 */
export function usageRecordFromFailedFleetAttemptArchive({ archive, fleetDir }) {
  const primary = archivedUsageArtifactText({
    archive,
    fleetDir,
    role: "primary_envelope",
  });
  const hasPrimary =
    archive?.usage_artifacts !== null &&
    typeof archive?.usage_artifacts === "object" &&
    archive.usage_artifacts.primary_envelope !== null;
  const hasProviderEvents =
    archive?.usage_artifacts !== null &&
    typeof archive?.usage_artifacts === "object" &&
    archive.usage_artifacts.provider_events !== null;
  const ordinary = usageRecordFromFailedAttempt({
    archivedPrimaryEnvelopeText: hasPrimary ? (primary ?? "") : null,
    providerEventsText: hasPrimary
      ? null
      : archivedUsageArtifactText({ archive, fleetDir, role: "provider_events" }),
  });
  if (hasPrimary || hasProviderEvents || ordinary.source !== "unrecoverable") return ordinary;
  return usageRecordFromStrictStreamDiagnostic(
    archivedStrictRejectionDiagnosticText({ archive, fleetDir }),
  );
}

function usageRecordFromVerifiedFleetAttempt(reportMd, reportsDir) {
  try {
    const primaryEnvelope = pureFleetRunArtifactPathsFor(reportMd).primary_envelope;
    if (!isTrustedFleetArtifactFile(primaryEnvelope, reportsDir)) {
      return usageRecordFromVerifiedPrimaryEnvelope(null);
    }
    return usageRecordFromVerifiedPrimaryEnvelope(readFileSync(primaryEnvelope, "utf8"));
  } catch {
    return usageRecordFromVerifiedPrimaryEnvelope(null);
  }
}

/** Reduce only live-pure runner records into the v8 public accounting fields. */
export function pureFleetSummaryAccounting(rows, fleetClient) {
  const records = [];
  for (const row of rows) {
    for (const attempt of row?.attempt_history ?? []) {
      records.push(attempt.usage);
    }
    if (row?.resume_usage !== null && row?.resume_usage !== undefined) {
      records.push(row.resume_usage);
    }
  }
  return {
    schema_version: PURE_FLEET_SUMMARY_SCHEMA_VERSION,
    usage: summarizeFleetUsage(records),
    codex_client: projectCodexClientForFleetSummary(fleetClient),
  };
}

/**
 * Keep the full launcher closure out of the public summary while preserving
 * one immutable preimage that a certifier can independently authenticate.
 * The safe summary's authority_sha256 binds this private file's token.
 */
export function writePrivateCodexClientAuthorityProof(fleetDir, fleetClient) {
  if (!isExactCodexClientAuthority(fleetClient)) {
    throw new Error("fleet: private Codex client authority proof requires exact client authority");
  }
  const proofPath = join(fleetDir, CODEX_CLIENT_AUTHORITY_PROOF_NAME);
  const proofBytes = Buffer.from(`${JSON.stringify(fleetClient, null, 2)}\n`, "utf8");
  writeFileSync(proofPath, proofBytes, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return {
    name: CODEX_CLIENT_AUTHORITY_PROOF_NAME,
    bytes: proofBytes.byteLength,
    sha256: sha256Bytes(proofBytes),
  };
}

/**
 * Preserve the legacy closed-slot success rule for structural and historical
 * summaries, while current live-pure v9 fleets additionally fail closed when
 * any launched attempt's usage could not be recovered.
 */
export function fleetSummaryExitSucceeded(summary) {
  const closedSlotsSucceeded =
    summary?.verified + summary?.["skipped-resume"] === summary?.count &&
    summary?.failed_attempts === 0;
  if (!closedSlotsSucceeded || summary?.schema_version !== PURE_FLEET_SUMMARY_SCHEMA_VERSION) {
    return closedSlotsSucceeded;
  }
  return summary?.usage?.complete === true && summary?.usage?.unrecoverable_attempt_count === 0;
}

/** Summary counters are always reduced from every closed per-slot attempt,
 * never from only the terminal result. */
export function summarizeFleetAttemptHistory(rows) {
  let totalAttempts = 0;
  let failedAttempts = 0;
  let technicalTimeouts = 0;
  let reportRecoveredRuns = 0;
  let receiptBoundRuns = 0;
  for (const row of rows) {
    if (row?.report_recovered === true) reportRecoveredRuns += 1;
    if (row?.report_receipt_bound === true) receiptBoundRuns += 1;
    for (const attempt of row?.attempt_history ?? []) {
      totalAttempts += 1;
      if (attempt.classification !== "verified") failedAttempts += 1;
      if (attempt.classification === "technical_timeout") technicalTimeouts += 1;
    }
  }
  return {
    total_attempts: totalAttempts,
    failed_attempts: failedAttempts,
    technical_timeouts: technicalTimeouts,
    report_recovered_runs: reportRecoveredRuns,
    receipt_bound_runs: receiptBoundRuns,
  };
}

/** A promise pool of bounded size — the fleet's concurrency knob. */
export async function runPool(items, size, worker) {
  let next = 0;
  const laneCount = Math.max(1, Math.min(size, items.length || 1));
  const lanes = new Array(laneCount).fill(0).map(async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  // A failed lane may set shared abort state while sibling provider children
  // are already in flight. Keep the caller (and its fleet lock) alive until all
  // lanes close, then rethrow the first rejection in deterministic lane order.
  const settled = await Promise.allSettled(lanes);
  const rejection = settled.find((result) => result.status === "rejected");
  if (rejection?.status === "rejected") throw rejection.reason;
}

/** Run one fleet slot to completion: resume check, then launch (with pacing
 * retries up to opts.maxRetries), returning the manifest row for this run. */
export async function executeRun(
  run,
  {
    reportsDir,
    stamp,
    opts,
    bashPath,
    fleetDir,
    fleetBuild,
    fleetClient,
    fleetControl,
    spawnRun = spawnAsync,
  },
) {
  const target = run.target;
  const questId = questIdFor(target);
  const requiredMode = opts.mock ? "structural" : "pure";
  const expectedPure = opts.mock
    ? null
    : {
        seed: run.seed,
        provider: run.provider,
        model: run.model,
        build: fleetBuild,
        client: fleetClient,
      };

  // A serial admission canary closes its remaining slots without launching a
  // second player once one member fails. The closed manifest still records the
  // absence of a playthrough rather than pretending it was a zero-token exit.
  if (opts.admissionCanary && fleetControl.admissionFailure) {
    return {
      report: null,
      status: "suppressed",
      attempts: 0,
      attempt_history: [],
      resume_usage: null,
      exit: null,
      log: null,
      run: null,
      attestation: null,
      report_recovered: false,
      report_receipt_bound: false,
      failure_reason: "admission_canary_stopped_after_failure",
    };
  }

  if (!opts.mock) {
    await assertExactBuildAtFleetBoundary(fleetControl, fleetBuild, `pre-slot seed ${run.seed}`);
  }

  // Check ALL stamp-agnostic candidates, newest-stamp-first, stopping at the
  // first that re-verifies — a stale FAILED report must never shadow a later
  // VERIFIED one produced by a prior fleet invocation.
  if (opts.resume) {
    for (const candidate of findExistingReport(reportsDir, target, run.seed)) {
      const verify = await verifyReportForResume(
        candidate,
        requiredMode,
        expectedPure,
        reportsDir,
        fleetControl.childTracker,
      );
      if (verify.ok) {
        const reportRecovered =
          requiredMode === "pure" ? verify.attestation.report_recovered : false;
        const reportReceiptBound =
          requiredMode === "pure" ? (verify.attestation.report_receipt_bound ?? false) : false;
        return {
          report: candidate,
          status: "skipped-resume",
          attempts: 0,
          attempt_history: [],
          resume_usage: opts.mock ? undefined : skippedResumeUsageRecord(),
          exit: 0,
          run: verify.run,
          attestation: verify.attestation,
          report_recovered: reportRecovered,
          report_receipt_bound: reportReceiptBound,
        };
      }
    }
  }

  const reportMd = reportPathFor(reportsDir, stamp, target, run.seed);
  const outPrefix = reportMd.slice(0, -".md".length); // run.sh appends .md/.json/.log itself
  const maxAttempts = Math.max(1, opts.maxRetries + 1);

  let lastExit = 1;
  let lastLogPath = null;
  const attemptHistory = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (fleetControl.abortFailure !== null) throw fleetControl.abortFailure;
    const args = [
      "--seed",
      String(run.seed),
      "--model",
      run.model,
      "--provider",
      run.provider,
      "--persona",
      run.persona,
      "--out",
      outPrefix,
    ];
    args.push(...(questId ? ["--quest", questId] : ["--overworld"]));
    if (opts.mock) args.push("--mock");

    const launch = () =>
      spawnRun(
        bashPath,
        [RUN_SH, ...args],
        {
          cwd: GAME_DIR,
          env: opts.mock ? { ...process.env } : codexFleetMemberEnv(process.env, fleetClient),
        },
        fleetControl.childTracker,
        { tree: true, deferWindowsStart: !opts.mock },
      );
    const bashResult = opts.mock
      ? await launch()
      : await launchAfterExactBuildGate(
          fleetControl,
          fleetBuild,
          `pre-attempt seed ${run.seed} attempt ${attempt + 1}`,
          launch,
        );
    lastExit = bashResult.status ?? 1;
    if (!opts.mock && bashResult.status === CODEX_PREFLIGHT_EXIT) {
      const detail = firstErrorLine(bashResult.stderr || bashResult.stdout);
      const error = new Error(
        `fleet: Codex client preflight changed after the shared gate; seed ${run.seed} was not played and no retry will be attempted${detail ? `: ${detail}` : ""}`,
      );
      fleetControl.abortFailure ??= error;
      throw error;
    }
    let verifyResult = null;

    if (lastExit === 0) {
      verifyResult = await verifyReportEvidence(
        reportMd,
        requiredMode,
        expectedPure,
        reportsDir,
        fleetControl.childTracker,
      );
      if (verifyResult.ok) {
        let attestation = null;
        if (!opts.mock) {
          try {
            attestation = await writeFreshPureFleetAttestation(
              reportMd,
              verifyResult.run,
              expectedPure,
              reportsDir,
              fleetControl.childTracker,
            );
          } catch (error) {
            verifyResult = {
              ...verifyResult,
              ok: false,
              stderr: `pure fleet attestation could not be created exclusively: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
        if (!verifyResult.ok) {
          lastExit = 5;
        } else {
          const reportRecovered = attestation?.report_recovered ?? false;
          const reportReceiptBound = attestation?.report_receipt_bound ?? false;
          attemptHistory.push({
            attempt: attempt + 1,
            exit: 0,
            classification: "verified",
            report_recovered: reportRecovered,
            report_receipt_bound: reportReceiptBound,
            archive: null,
            ...(opts.mock
              ? {}
              : { usage: usageRecordFromVerifiedFleetAttempt(reportMd, reportsDir) }),
          });
          return {
            report: reportMd,
            status: "verified",
            attempts: attempt + 1,
            attempt_history: attemptHistory,
            resume_usage: opts.mock ? undefined : null,
            exit: 0,
            run: verifyResult.run,
            attestation,
            report_recovered: reportRecovered,
            report_receipt_bound: reportReceiptBound,
          };
        }
      } else {
        lastExit = 5; // run.sh exited 0 but the belt-and-braces re-verify rejected it
      }
    }

    // Failed attempt: persist stdout/stderr tails to a per-attempt log file
    // (verified runs never reach here — they returned above) and print a
    // one-line stderr summary to the fleet's own stderr for live monitoring.
    const verifierAttempted =
      verifyResult !== null || existsSync(`${outPrefix}.verify.initial.log`);
    const classification = classifyFleetAttempt({
      runnerExit: bashResult.status ?? 1,
      verifierAttempted,
      verified: false,
    });
    const strictRejection = classification === "strict_stream_rejected";
    if (strictRejection && fleetControl.transportFingerprint !== null) {
      fleetControl.strictRejectedTransportFingerprints.add(fleetControl.transportFingerprint);
    }
    const diagnostic = strictRejection
      ? strictRejectionFleetDiagnostic({
          run,
          attempt: attempt + 1,
          exit: lastExit,
          fleetClient,
        })
      : (() => {
          const sections = [
            `attempt=${attempt + 1}`,
            `classification=${classification}`,
            `run.sh exit=${bashResult.status ?? "null"}`,
            "--- run.sh stdout (tail) ---",
            tail(bashResult.stdout),
            "--- run.sh stderr (tail) ---",
            tail(bashResult.stderr),
          ];
          if (verifyResult) {
            sections.push(
              "--- verify stdout (tail) ---",
              tail(verifyResult.stdout),
              "--- verify stderr (tail) ---",
              tail(verifyResult.stderr),
            );
          }
          return `${sections.join("\n")}\n`;
        })();
    const archive = archiveFailedFleetAttemptArtifacts({
      outPrefix,
      fleetDir,
      seed: run.seed,
      attempt: attempt + 1,
      diagnostic,
      diagnosticOnly: strictRejection,
    });
    lastLogPath = join(fleetDir, archive.directory, "fleet-diagnostic.log");
    attemptHistory.push({
      attempt: attempt + 1,
      exit: lastExit,
      classification,
      report_recovered: false,
      report_receipt_bound: false,
      archive,
      ...(opts.mock
        ? {}
        : {
            usage: usageRecordFromFailedFleetAttemptArchive({ archive, fleetDir }),
          }),
    });
    const summarySource = strictRejection
      ? "strict stream rejected"
      : verifyResult && verifyResult.stderr
        ? verifyResult.stderr
        : bashResult.stderr;
    console.error(
      `[fleet] seed=${run.seed} attempt=${attempt + 1} failed (exit ${lastExit}): ${firstErrorLine(summarySource)}`,
    );

    if (!shouldRetryFleetAttempt({ classification, attempt, maxAttempts })) break;
    const delayMs = opts.mock ? 0 : 20_000 * 2 ** attempt;
    if (delayMs > 0) await sleep(delayMs);
  }
  return {
    report: reportMd,
    status: "failed",
    attempts: attemptHistory.length,
    attempt_history: attemptHistory,
    resume_usage: opts.mock ? undefined : null,
    exit: lastExit,
    log: lastLogPath,
    run: null,
    attestation: null,
    report_recovered: false,
    report_receipt_bound: false,
    failure_reason:
      lastExit === 124 || lastExit === 137
        ? "technical_timeout"
        : lastExit === 43
          ? "strict_stream_rejected"
          : "run_or_verification_failed",
  };
}

/** Render a complete manifest in planned order, independent of pool completion order. */
export function renderClosedFleetManifest(rows) {
  if (
    !Array.isArray(rows) ||
    rows.length === 0 ||
    Array.from({ length: rows.length }, (_, index) => rows[index]).some((row) => row === undefined)
  ) {
    throw new Error("fleet: closed manifest requires a complete nonempty row set");
  }
  const sorted = [...rows].sort((a, b) => a.planned_index - b.planned_index || a.seed - b.seed);
  for (const [expectedIndex, row] of sorted.entries()) {
    if (!Number.isSafeInteger(row.planned_index) || row.planned_index !== expectedIndex) {
      throw new Error("fleet: closed manifest planned indexes must be contiguous from zero");
    }
  }
  return `${sorted.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

export function fleetReportLockSpec(reportsDir, stamp, runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error("fleet: report lock requires at least one planned run");
  }
  const target = runs[0].target;
  if (runs.some((run) => run.target !== target)) {
    throw new Error("fleet: one report lock cannot cover mixed targets");
  }
  const identity = {
    schema_version: 1,
    stamp,
    target,
    seed_start: runs[0].seed,
    seed_end: runs.at(-1).seed,
    seeds: runs.map((run) => run.seed),
    model_plan: runs.map((run) => ({ seed: run.seed, provider: run.provider, model: run.model })),
  };
  // The exclusive filename intentionally covers the entire stamp+target report
  // namespace, so different labels, overlapping ranges, and different model
  // plans cannot race on ledger-compatible report paths. The full range/model
  // key remains inspectable in the lock payload.
  const namespace = createHash("sha256").update(JSON.stringify({ stamp, target })).digest("hex");
  return {
    path: join(reportsDir, `.fleet-report-${namespace}.lock`),
    identity,
  };
}

export function acquireFleetReportLock(reportsDir, stamp, runs) {
  const lock = fleetReportLockSpec(reportsDir, stamp, runs);
  try {
    writeFileSync(lock.path, `${JSON.stringify(lock.identity, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error(`fleet: report namespace is already locked by another fleet: ${lock.path}`, {
        cause: error,
      });
    }
    throw error;
  }
  return lock;
}

export function releaseFleetReportLock(lock) {
  unlinkSync(lock.path);
}

/**
 * Reserve the live-cohort ledger in the precise startup order. Report locking
 * stays in this file because it protects the runner's report namespace; the
 * Git-common ledger module only owns cross-worktree cohort coordination.
 *
 * The returned release function intentionally remains live around runPool().
 * Any failure before immutable intent publication reverses only the empty
 * local label directory this startup created, then releases report lock before
 * lease. Once an intent is published, it is never rolled back.
 */
export function beginLiveFleetCohortStartup({
  root = GAME_DIR,
  cohort,
  intentAudit,
  allowDuplicateCohort,
  createReportsDirectory,
  acquireReportLock,
  releaseReportLock,
  validateLocalFleetLabel,
  createLocalFleetDirectory,
  removeLocalFleetDirectory = removeOwnedEmptyFleetDirectory,
  publishIntent = publishFleetCohortIntent,
  releaseCohortLease = releaseFleetCohortLease,
}) {
  let lease = null;
  let reportLock = null;
  let createdLocalFleetDirectory = null;
  let intentPublished = false;
  try {
    lease = acquireFleetCohortLease(root, cohort);
    createReportsDirectory();
    reportLock = acquireReportLock();
    const overlaps = findFleetCohortOverlaps(cohort, scanFleetCohortIntents(lease));
    assertFleetCohortOverlapAllowed(cohort, overlaps, allowDuplicateCohort);
    const audit = createFleetCohortIntentAudit({
      ...intentAudit,
      duplicateOverride: allowDuplicateCohort,
      overlaps,
      cohort,
    });
    validateLocalFleetLabel();
    createdLocalFleetDirectory = createLocalFleetDirectory();
    if (typeof createdLocalFleetDirectory !== "string" || !isAbsolute(createdLocalFleetDirectory)) {
      throw new Error("fleet: local fleet directory creator must return its absolute path");
    }
    let intent;
    try {
      intent = publishIntent(lease, cohort, { audit });
      intentPublished = true;
    } catch (error) {
      intentPublished = error && typeof error === "object" && error.intentPublished === true;
      throw error;
    }

    let reportReleased = false;
    let leaseReleased = false;
    return {
      cohort,
      intent,
      lease,
      reportLock,
      release() {
        const releaseErrors = [];
        if (!reportReleased) {
          try {
            releaseReportLock(reportLock);
            reportReleased = true;
          } catch (releaseError) {
            releaseErrors.push(releaseError);
          }
        }
        if (!leaseReleased) {
          try {
            releaseCohortLease(lease);
            leaseReleased = true;
          } catch (releaseError) {
            releaseErrors.push(releaseError);
          }
        }
        if (releaseErrors.length === 1) throw releaseErrors[0];
        if (releaseErrors.length > 1) {
          throw new AggregateError(
            releaseErrors,
            "fleet: report lock and active cohort lease could not both be released",
            { cause: releaseErrors[0] },
          );
        }
      },
    };
  } catch (error) {
    const cleanupErrors = [];
    if (!intentPublished && createdLocalFleetDirectory !== null) {
      try {
        removeLocalFleetDirectory(createdLocalFleetDirectory);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (reportLock !== null) {
      try {
        releaseReportLock(reportLock);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (lease !== null) {
      try {
        releaseCohortLease(lease);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "fleet: live cohort startup failed and rollback could not complete",
        { cause: error },
      );
    }
    throw error;
  }
}

function npmCliInvocation() {
  if (process.env.npm_execpath) {
    return { command: process.execPath, args: [process.env.npm_execpath] };
  }

  const bundledNpmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(bundledNpmCli)) {
    return { command: process.execPath, args: [bundledNpmCli] };
  }

  if (process.platform !== "win32") {
    return { command: "npm", args: [] };
  }

  throw new Error("fleet: could not resolve npm's JavaScript CLI entrypoint");
}

function resolveFleetBashPath() {
  let bashPath;
  if (process.platform === "win32") {
    const found = gitBash();
    if (!found) {
      throw new Error(
        "fleet: could not find Git Bash; install Git for Windows or set BLIND_BASH to a real bash.exe path",
      );
    }
    bashPath = found;
  } else {
    try {
      execFileSync("bash", ["--version"], { stdio: "ignore" });
    } catch (error) {
      throw new Error("fleet: bash runtime is unavailable", { cause: error });
    }
    bashPath = "bash";
  }
  if (!existsSync(RUN_SH)) {
    throw new Error(`fleet: blind runner is unavailable: ${RUN_SH}`);
  }
  try {
    const npm = npmCliInvocation();
    execFileSync(npm.command, [...npm.args, "--version"], { stdio: "ignore" });
  } catch (error) {
    throw new Error("fleet: npm runtime is unavailable", { cause: error });
  }
  return bashPath;
}

async function preflightPureCodexClient(bashPath, run, childTracker) {
  const result = await spawnBoundedAsync(
    bashPath,
    [
      RUN_SH,
      "--preflight-only",
      "--client-authority-json",
      "--provider",
      run.provider,
      "--model",
      run.model,
      "--persona",
      run.persona,
      "--overworld",
    ],
    {
      cwd: GAME_DIR,
      env: { ...process.env },
    },
    {
      timeoutMs: CODEX_PREFLIGHT_PROCESS_TIMEOUT_MS,
      maxOutputBytes: CODEX_PREFLIGHT_PROCESS_MAX_OUTPUT_BYTES,
      childTracker,
      tree: true,
    },
  );
  if (result.status === 0) {
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("fleet: Codex client preflight returned malformed authority JSON");
    }
    if (!isExactCodexClientAuthority(parsed)) {
      throw new Error("fleet: Codex client preflight returned invalid client authority");
    }
    return parsed;
  }
  const boundaryReason = result.timedOut
    ? `shared preflight exceeded ${CODEX_PREFLIGHT_PROCESS_TIMEOUT_MS}ms`
    : result.outputExceeded
      ? `shared preflight exceeded ${CODEX_PREFLIGHT_PROCESS_MAX_OUTPUT_BYTES} captured bytes`
      : "";
  const detail = [result.stderr, result.stdout]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value.length > 0);
  throw new Error(
    `fleet: Codex client preflight failed before report directories, locks, or player launches; no fleet retry was attempted${boundaryReason ? `: ${boundaryReason}` : ""}${detail ? `: ${detail}` : ""}`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(FLEET_USAGE);
    return;
  }

  let opts;
  try {
    opts = parseFleetArgs(argv);
    assertSparkMassAdmissionConfigured(opts);
  } catch (err) {
    // Usage error (non-finite/out-of-range numeric flag, e.g. --count 0):
    // exit 2 before touching the filesystem or spawning anything.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
    return;
  }
  const requestedReportsDir = opts.out
    ? resolve(normalizeShellPathForNode(opts.out))
    : join(HERE, "reports");
  const configuredCodexHome = normalizeShellHomeForNode(process.env.CODEX_HOME?.trim() ?? "");
  const shellHome = normalizeShellHomeForNode(process.env.HOME?.trim() ?? "");
  const codexHome = configuredCodexHome
    ? isAbsolute(configuredCodexHome)
      ? configuredCodexHome
      : resolve(GAME_DIR, configuredCodexHome)
    : join(shellHome || homedir(), ".codex");
  const reportsDir =
    !opts.mock || existsSync(codexHome)
      ? validateFleetReportsDirectory(requestedReportsDir, codexHome)
      : requestedReportsDir;
  const runs = planFleetRuns(opts);
  const stamp = utcStamp();
  const label = validateFleetLabel(opts.label ?? stamp);
  const fleetDir = join(GAME_DIR, "ai-runs", "fleet", label);
  if (opts.admissionCanary) validateAdmissionReportsSeparation(reportsDir, fleetDir);

  // Resolve every launcher prerequisite before reserving a report namespace or
  // label directory. A missing runtime must leave no misleading fleet shell.
  const bashPath = resolveFleetBashPath();

  const childTracker = createFleetChildTracker();
  const fleetControl = createFleetLaunchControl({
    captureBuild: () => captureExpectedPureFleetBuild(childTracker),
    childTracker,
  });
  let reportLock = null;
  let liveCohortStartup = null;
  let locksReleased = false;
  const cleanupLocks = () => {
    if (locksReleased) return;
    locksReleased = true;
    if (liveCohortStartup !== null) liveCohortStartup.release();
    else if (reportLock !== null) releaseFleetReportLock(reportLock);
  };
  const termination = createFleetTerminationController({ fleetControl, childTracker });
  // Keep handlers installed across bootstrap, reservation, child shutdown, and
  // lock cleanup. Repeated signals share the same idempotent shutdown request.
  const uninstallSignalHandlers = installFleetSignalHandlers(termination.requestTermination);
  try {
    const fleetClient = opts.mock
      ? null
      : await preflightPureCodexClient(bashPath, runs[0], childTracker);
    const fleetBuild = opts.mock ? null : await captureExpectedPureFleetBuild(childTracker);
    const transportFingerprint = opts.mock
      ? null
      : createFleetTransportFingerprint({ provider: opts.provider, model: opts.model });
    if (sparkMassAdmissionRequired(opts)) {
      requireSparkMassAdmissionReceipt({
        receiptPath: resolve(GAME_DIR, normalizeShellPathForNode(String(opts.admissionReceipt))),
        build: fleetBuild,
        transportFingerprint,
        client: fleetClient,
        model: opts.model,
      });
    }
    const cohort = opts.mock
      ? null
      : createFleetCohort(runs, fleetBuild, fleetClient, PURE_SESSION_CONTRACT_VERSION);

    if (opts.mock) {
      // Structural mocks retain their existing report and local-label semantics;
      // only live pure cohorts participate in the cross-worktree ledger.
      mkdirSync(reportsDir, { recursive: true });
      reportLock = acquireFleetReportLock(reportsDir, stamp, runs);
      try {
        mkdirSync(dirname(fleetDir), { recursive: true });
        mkdirSync(fleetDir, { recursive: true });
      } catch (error) {
        releaseFleetReportLock(reportLock);
        reportLock = null;
        throw error;
      }
    } else {
      liveCohortStartup = beginLiveFleetCohortStartup({
        cohort,
        intentAudit: {
          stamp,
          label,
          canonicalWorktree: realpathSync.native(GAME_DIR),
        },
        allowDuplicateCohort: opts.allowDuplicateCohort,
        createReportsDirectory: () => mkdirSync(reportsDir, { recursive: true }),
        acquireReportLock: () => acquireFleetReportLock(reportsDir, stamp, runs),
        releaseReportLock: releaseFleetReportLock,
        validateLocalFleetLabel: () => {
          mkdirSync(dirname(fleetDir), { recursive: true });
          if (existsSync(fleetDir)) {
            throw new Error(
              `fleet: label directory already exists; choose a fresh label: ${fleetDir}`,
            );
          }
        },
        createLocalFleetDirectory: () => {
          try {
            mkdirSync(fleetDir);
          } catch (error) {
            if (error && typeof error === "object" && error.code === "EEXIST") {
              throw new Error(
                `fleet: label directory already exists; choose a fresh label: ${fleetDir}`,
                { cause: error },
              );
            }
            throw error;
          }
          return fleetDir;
        },
      });
      reportLock = liveCohortStartup.reportLock;
    }
    const codexClientProof = opts.mock
      ? null
      : writePrivateCodexClientAuthorityProof(fleetDir, fleetClient);
    const manifestPath = join(fleetDir, "manifest.jsonl");
    const summaryPath = join(fleetDir, "summary.json");
    const counts = { verified: 0, "skipped-resume": 0, failed: 0, suppressed: 0 };
    const rows = new Array(runs.length);
    fleetControl.admissionFailure = false;
    fleetControl.transportFingerprint = transportFingerprint;
    fleetControl.strictRejectedTransportFingerprints = new Set();

    await runPool(runs, Math.max(1, opts.concurrency), async (run, plannedIndex) => {
      const result = await executeRun(run, {
        reportsDir,
        stamp,
        opts,
        bashPath,
        fleetDir,
        fleetBuild,
        fleetClient,
        fleetControl,
      });
      counts[result.status] += 1;
      if (opts.admissionCanary && result.status === "failed") fleetControl.admissionFailure = true;
      const runMeta = result.run;
      const row = {
        planned_index: plannedIndex,
        seed: run.seed,
        persona: run.persona,
        provider: run.provider,
        model: run.model,
        target: run.target,
        report: result.report,
        status: result.status,
        attempts: result.attempts,
        attempt_history: result.attempt_history,
        ...(opts.mock ? {} : { resume_usage: result.resume_usage }),
        report_recovered: result.report_recovered,
        report_receipt_bound: result.report_receipt_bound,
        exit: result.exit,
        log: result.log ?? null,
        model_attestation: result.attestation ?? null,
        evidence_schema_version: runMeta?.schema_version ?? null,
        run_seed: runMeta?.run_seed ?? null,
        build: runMeta?.build ?? null,
        quest_outcomes: runMeta?.quest_outcomes ?? null,
        report_schema_version: runMeta?.report_schema_version ?? null,
        play_mode: runMeta?.play_mode ?? (opts.mock ? "structural" : "pure"),
        start_surface:
          runMeta?.start_surface ??
          (run.target === "overworld" ? "fresh_overworld" : "direct_quest"),
        retention_eligible: runMeta?.retention_eligible ?? false,
        evidence_status: runMeta?.evidence_status ?? "unverified",
        session_contract_version: runMeta?.receipt?.contractVersion ?? null,
        baseline_decisions: opts.mock ? null : PURE_BASELINE_DECISIONS,
        accepted_decisions: runMeta?.receipt?.acceptedDecisions ?? null,
        retention_choices: runMeta?.receipt?.retentionHistory ?? [],
        checkpoint: runMeta?.receipt?.checkpoint ?? null,
        exit_reason: runMeta?.receipt?.exitReason ?? null,
        exit_reasons: runMeta?.receipt?.exitReasons ?? [],
        receipt_hash: runMeta?.receipt?.receiptHash ?? null,
        failure_reason: result.failure_reason ?? null,
      };
      rows[plannedIndex] = row;
      console.log(
        `[fleet] seed=${run.seed} persona=${run.persona} model=${run.model} → ${result.status}`,
      );
    });

    writeFileSync(manifestPath, renderClosedFleetManifest(rows), {
      encoding: "utf8",
      flag: opts.mock ? "w" : "wx",
    });

    const attemptSummary = summarizeFleetAttemptHistory(rows);
    const summary = {
      label,
      stamp,
      count: runs.length,
      concurrency: opts.concurrency,
      reportsDir,
      seed_base: opts.seedBase,
      provider: opts.mock ? "mock" : opts.provider,
      model: opts.model,
      personas: opts.personas,
      target: opts.target,
      resume_enabled: opts.resume,
      evidence_schema_version: opts.mock ? 1 : PURE_FLEET_EVIDENCE_SCHEMA_VERSION,
      model_attestation_schema_version: opts.mock
        ? null
        : opts.provider === "codex"
          ? PURE_FLEET_CODEX_ATTESTATION_SCHEMA_VERSION
          : PURE_FLEET_ATTESTATION_SCHEMA_VERSION,
      build: fleetBuild,
      ...(opts.mock ? {} : pureFleetSummaryAccounting(rows, fleetClient)),
      ...(codexClientProof === null ? {} : { codex_client_proof: codexClientProof }),
      report_schema_version: 2,
      play_mode: opts.mock ? "structural" : "pure",
      start_surface: opts.target === "overworld" ? "fresh_overworld" : "direct_quest",
      retention_contract_eligible: !opts.mock,
      retention_eligible_verified_runs: opts.mock ? 0 : counts.verified + counts["skipped-resume"],
      retention_ineligible_or_unverified_runs:
        runs.length - (opts.mock ? 0 : counts.verified + counts["skipped-resume"]),
      session_contract_version: opts.mock ? null : PURE_SESSION_CONTRACT_VERSION,
      baseline_decisions: opts.mock ? null : PURE_BASELINE_DECISIONS,
      verified: counts.verified,
      "skipped-resume": counts["skipped-resume"],
      failed: counts.failed,
      ...attemptSummary,
    };
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
      encoding: "utf8",
      flag: opts.mock ? "w" : "wx",
    });

    if (opts.admissionCanary) {
      const admission = createSparkAdmissionReceipt({
        counts,
        build: fleetBuild,
        transportFingerprint,
        client: fleetClient,
        strictRejectedTransportFingerprints: fleetControl.strictRejectedTransportFingerprints,
      });
      writeFileSync(join(fleetDir, "admission.json"), `${JSON.stringify(admission, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    }

    const ok = fleetSummaryExitSucceeded(summary);
    console.log(
      `Fleet ${label}: ${counts.verified} verified, ${counts["skipped-resume"]} skipped-resume, ${counts.failed} failed slots${opts.admissionCanary ? `, ${counts.suppressed} suppressed` : ""}, ${attemptSummary.failed_attempts} failed attempts (of ${runs.length})`,
    );
    console.log(`Manifest: ${manifestPath}`);
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    if (termination.signalExitCode === null) throw error;
  } finally {
    await settleFleetChildrenBeforeCleanup(childTracker, cleanupLocks, {
      terminate: termination.shutdownPromise !== null,
    });
    uninstallSignalHandlers();
  }
  if (termination.signalExitCode !== null) process.exitCode = termination.signalExitCode;
}

// Entry guard so tests can import the pure planning functions without
// launching a fleet.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
