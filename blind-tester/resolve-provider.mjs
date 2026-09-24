#!/usr/bin/env node
/**
 * Resolve one provider + model against the registry, for shell callers.
 *
 * Plain ESM with no dependencies, deliberately. `run.sh` has to resolve a provider
 * before it can launch anything, and it runs in places with no TypeScript loader and
 * no installed dev dependencies — a bare temp clone in a test, a fresh machine, a
 * sandbox with no network. A `tsx` invocation here fails in exactly those places, and
 * the failure looks like "your provider is invalid" rather than "the toolchain is
 * missing", which is the worst possible error to debug.
 *
 * The typed module (src/blind/providers.ts) parses the SAME JSON file, so there is one
 * source of truth and nothing to keep in sync. Validation here is intentionally thin —
 * enough to give the shell an actionable message — because the typed module and its
 * tests own the full schema.
 *
 * ISOLATION IS DERIVED HERE, NOT COPIED. See `deriveProviderIsolation` below: the one
 * thing this file must never do is hand `run.sh` a `runner_enforced` label it did not
 * check, because that label is what decides whether a session counts as evidence.
 *
 * Output formats — one resolution, three renderings, so they cannot drift:
 *
 *   (default)   kind<TAB>isolation<TAB>model<TAB>tier, one line.
 *               The ORIGINAL contract, kept byte-compatible on purpose: `run.sh` used
 *               to cut those exact fields and `playtest-loop.sh` still cuts field 3.
 *   --records   key<TAB>value lines, repeated keys for list-valued fields. This is what
 *               `run.sh` consumes: columns cannot carry an argv array, and Bash has no
 *               JSON parser, so a JSON mode would only force a second Node process whose
 *               absence is the entire reason this file exists. Values are guaranteed
 *               free of tabs and newlines (enforced below), so `IFS=$'\t' read -r k v`
 *               is exact rather than best-effort. Absent fields are OMITTED rather than
 *               emitted empty, so a shell reader keeps its own initialized default.
 *   --json      one JSON document, for callers that have a parser (tests, tooling, and
 *               any future non-Bash launcher).
 *
 * Exits 2 with a human-readable reason on failure; the caller surfaces it verbatim.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

export function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Does the named reader module exist in THIS checkout, as a file? */
function captureReaderExists(readerModule, repoRoot) {
  try {
    return statSync(join(repoRoot, readerModule)).isFile();
  } catch {
    // Missing, unreadable, a directory, or a path that will not even resolve — all of
    // which mean the same thing here: no reader, therefore no proof.
    return false;
  }
}

/**
 * Does blind-tester/run.sh actually have a launch path for this provider's capture reader?
 *
 * Separate from isolation on purpose. Isolation answers "is this vendor's blindness
 * provable here"; this answers "can run.sh spawn it at all". Both must hold before a live
 * lane exists, and they genuinely came apart: when the claude_code reader landed the
 * derived gate opened while run.sh still had no branch, so playtest-loop would have
 * dispatched a wave of players that every one of which run.sh refused.
 *
 * Reads the same file run.sh and bin/doctor.ts read. Fails CLOSED: if the list cannot be
 * read, nothing is drivable, because "we could not tell" must never render as "yes".
 */
export function deriveProviderDrivable(provider, derived, repoRoot = REPO_ROOT) {
  if (derived.isolation !== "runner_enforced" || !derived.readerModule) {
    return { drivable: false, reason: derived.reason };
  }
  let implemented;
  try {
    const parsed = JSON.parse(
      readFileSync(join(repoRoot, "blind-tester", "implemented-launch-paths.json"), "utf8"),
    );
    implemented = parsed.implementedCaptureReaders;
    if (!Array.isArray(implemented) || implemented.some((r) => typeof r !== "string" || r === "")) {
      throw new Error("implementedCaptureReaders must be a non-empty string[]");
    }
  } catch (error) {
    return {
      drivable: false,
      reason: `blind-tester/implemented-launch-paths.json could not be read (${error.message}), so no provider can be treated as launchable here`,
    };
  }
  if (!implemented.includes(derived.readerModule)) {
    return {
      drivable: false,
      reason: `provider "${provider.id}" has a capture reader (${derived.readerModule}) but blind-tester/run.sh has no launch path written against it yet, so it cannot be played live here`,
    };
  }
  return { drivable: true, reason: derived.reason };
}

/**
 * Compute a provider's evidence class, and say why.
 *
 * This is a deliberate, TESTED MIRROR of `derivePlaytestIsolation` in
 * src/blind/providers.ts. That function is the authority; read it first. The mirror
 * exists only because the authority is TypeScript and this file must answer on a
 * machine with no TypeScript loader (see the header) — a shell path that cannot resolve
 * a provider without `tsx` is a shell path that dies on the machines the harness most
 * needs to work on.
 *
 * What keeps a mirror from becoming a second opinion:
 *
 *   1. The reason sentences are reproduced verbatim from src/blind/providers.ts so the
 *      two stay comparable line for line. The parity test that imported BOTH and
 *      asserted identical results was retired in the 2026-09-23 suite halving, so a
 *      change to either side must be mirrored by hand.
 *   2. `resolveProvider` refuses outright when this derivation disagrees with the
 *      `isolation` literal stored in the registry. src/blind/providers.ts makes that
 *      disagreement a hard parse failure; a runner that shrugged it off would be the one
 *      component still willing to act on a label the type-checked path had rejected.
 *
 * The rule itself: `runner_enforced` IFF the runner spawns it (`kind === "headless_cli"`),
 * it declares a complete `capture` block, and that block's reader module exists on disk.
 * Anything else is `operator_attested` — not as a penalty, but because "a human asserts
 * it" is then the only true description of the evidence.
 */
export function deriveProviderIsolation(provider, repoRoot = REPO_ROOT) {
  if (provider.kind !== "headless_cli") {
    return {
      isolation: "operator_attested",
      code: "kind_is_not_headless_cli",
      reason:
        `provider "${provider.id}" is ${provider.kind}, which the runner never spawns, ` +
        `so its isolation can only be operator_attested`,
      readerModule: provider.capture?.readerModule ?? null,
    };
  }
  const capture = provider.capture;
  if (capture === undefined || capture === null) {
    return {
      isolation: "operator_attested",
      code: "no_capture_block",
      reason:
        `provider "${provider.id}" declares no capture block, so nothing here can read ` +
        `its session log: every session it produces is hand-played`,
      readerModule: null,
    };
  }
  // A capture block whose reader is missing, absolute, or path-walking is not a weaker
  // claim to be downgraded — it is a malformed registry that src/blind/providers.ts
  // refuses to parse at all. Say so instead of picking a reason code for it, because the
  // filesystem probe below is what mints the strongest label in this pipeline and it must
  // never be pointed at an attacker-chosen path.
  const readerModule = capture.readerModule;
  if (typeof readerModule !== "string" || readerModule.length === 0) {
    fail(`provider "${provider.id}" declares a capture block with no readerModule`);
  }
  if (/^(?:[/\\]|[A-Za-z]:)/u.test(readerModule)) {
    fail(`provider "${provider.id}" capture readerModule must be repo-relative: ${readerModule}`);
  }
  if (readerModule.split(/[\\/]/u).includes("..")) {
    fail(`provider "${provider.id}" capture readerModule must not contain a ".." segment`);
  }
  if (!captureReaderExists(readerModule, repoRoot)) {
    return {
      isolation: "operator_attested",
      code: "capture_reader_module_missing",
      reason:
        `provider "${provider.id}" names capture reader "${readerModule}", which ` +
        `does not exist in this checkout, so no session of it can be witnessed`,
      readerModule,
    };
  }
  return {
    isolation: "runner_enforced",
    code: "runner_captures_this_vendor",
    reason:
      `provider "${provider.id}" is a headless CLI whose session log is read by ` +
      `${readerModule}`,
    readerModule,
  };
}

/**
 * Resolve provider + model into the single object every output format renders.
 *
 * One resolution, rendered three ways, so the legacy line and the richer formats can
 * never disagree about what was resolved.
 */
/**
 * The provider a launch uses when none is named: the FIRST registered one.
 *
 * run.sh carried `DEFAULT_PROVIDER="codex"` with a comment explaining that codex was
 * "the vendor this runner has a live launch path for". That stopped being true when the
 * claude_code reader and its launch branch landed, and a stale comment beside a hardcoded
 * vendor name is how a default quietly reads as a requirement.
 *
 * Registry order is the tie-break, so the resolved value is unchanged today — this
 * removes the vendor name from the runner, not the choice from the operator, who still
 * has --provider and BLIND_PROVIDER. Which providers may actually produce pure evidence
 * is decided downstream by the derived isolation gate, never by being first here.
 */
export function defaultProviderId(repoRoot = REPO_ROOT) {
  const registry = readJson(join(repoRoot, "blind-tester", "providers.json"));
  const providers = Array.isArray(registry?.providers) ? registry.providers : [];
  const first = providers.find(
    (candidate) => typeof candidate?.id === "string" && candidate.id !== "",
  );
  if (!first) fail("blind-tester/providers.json declares no providers");
  return first.id;
}

/**
 * One transport component path, refused unless it stays inside `blind-tester/`.
 *
 * The typed schema (`PlaytestModelTransportSchema` in ../src/blind/providers.ts) already
 * rejects an absolute path or a `..` segment. That is not enough on its own, because the
 * LAUNCH path never goes through it: `blind-tester/run.sh` reads these records from this
 * dependency-free resolver and hands the value to fill-prompt.mjs, which reads the named
 * file into the player's prompt. A catalog typo — or an edit by someone who only ran the
 * shell path — could therefore pull a file from outside the checkout into a prompt that
 * gets sent to an external model, with the typed guard never consulted.
 *
 * So the rule is enforced in BOTH readers, the same way the isolation derivation is
 * mirrored here rather than imported: whichever path resolves a provider has to be the
 * one that applies the constraint. Same containment rule as the capture block above.
 */
function transportPath(provider, model, field) {
  const value = model.transport?.[field];
  if (typeof value !== "string" || value === "") return null;
  if (value.split(/[\\/]/u).includes("..")) {
    fail(
      `provider "${provider.id}" model "${model.id}" transport ${field} must not contain a ".." segment`,
    );
  }
  if (/^(?:[/\\]|[A-Za-z]:)/u.test(value)) {
    fail(
      `provider "${provider.id}" model "${model.id}" transport ${field} must be relative to blind-tester/, not an absolute path`,
    );
  }
  return value;
}

export function resolveProvider(providerId, requestedModel, repoRoot = REPO_ROOT) {
  const registryPath = join(repoRoot, "blind-tester", "providers.json");
  const registry = readJson(registryPath);
  const providers = Array.isArray(registry?.providers) ? registry.providers : [];
  if (providers.length === 0) fail("blind-tester/providers.json declares no providers");

  const provider = providers.find((candidate) => candidate.id === providerId);
  if (!provider) {
    const known = providers
      .map((candidate) => candidate.id)
      .sort()
      .join(", ");
    fail(`--provider "${providerId}" is not registered; known providers: ${known}`);
  }

  const catalog = readJson(join(repoRoot, provider.catalogPath));
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  if (catalog?.provider !== provider.id) {
    fail(
      `catalog ${provider.catalogPath} declares provider "${catalog?.provider}" but is registered for "${provider.id}"`,
    );
  }
  if (models.length === 0) fail(`catalog ${provider.catalogPath} lists no models`);
  const defaults = models.filter((candidate) => candidate.default === true);
  if (defaults.length > 1) {
    fail(
      `catalog ${provider.catalogPath} marks ${defaults.length} models as default; at most one is allowed`,
    );
  }

  // An alias is refused on purpose: it resolves to different weights over time, so a
  // session recorded under one would stop meaning what its record says it means.
  // With no model requested, the catalog's one explicit `default: true` entry wins;
  // the volume-first heuristic remains only for catalogs that never marked one.
  const model = requestedModel
    ? models.find((candidate) => candidate.id === requestedModel)
    : (defaults[0] ?? models.find((candidate) => candidate.tier === "volume") ?? models[0]);

  if (!model) {
    const known = models.map((candidate) => candidate.id).join(", ");
    fail(`model "${requestedModel}" is not in the ${provider.id} catalog; known models: ${known}`);
  }

  const derived = deriveProviderIsolation(provider, repoRoot);
  // The registry literal is not the answer; it is a second witness that has to agree
  // with the checkout. src/blind/providers.ts fails to parse on this disagreement, so a
  // runner that quietly preferred either side would be laundering a label the typed path
  // had already rejected — and the direction that matters most (stored says enforced,
  // checkout has no reader) is exactly the unverifiable-evidence failure.
  if (provider.isolation !== derived.isolation) {
    fail(
      `provider "${provider.id}" declares isolation "${provider.isolation}" but this ` +
        `checkout derives "${derived.isolation}": ${derived.reason}.\n` +
        `src/blind/providers.ts treats that disagreement as a hard parse failure; this ` +
        `resolver refuses it for the same reason. Fix the registry entry or restore the reader.`,
    );
  }

  const launch = provider.launch ?? null;
  const sessionLog = provider.capture?.sessionLog ?? null;
  return {
    id: provider.id,
    kind: provider.kind,
    isolation: derived.isolation,
    isolationCode: derived.code,
    drivable: deriveProviderDrivable(provider, derived, repoRoot).drivable,
    drivableReason: deriveProviderDrivable(provider, derived, repoRoot).reason,
    isolationReason: derived.reason,
    captureReaderModule: derived.readerModule,
    // `capture.sessionLog` is the client's own private state root. It is also the one
    // directory the registry knows a vendor owns, which is why the runner's
    // "never write evidence inside the client's own login home" rule reads it from here
    // rather than from a hard-coded `~/.codex`.
    sessionLog: sessionLog
      ? {
          rootEnv: typeof sessionLog.rootEnv === "string" ? sessionLog.rootEnv : null,
          rootDefault: sessionLog.rootDefault ?? null,
          pathTemplate: sessionLog.pathTemplate ?? null,
        }
      : null,
    launch: launch
      ? {
          executable: launch.executable ?? null,
          argv: Array.isArray(launch.argv) ? launch.argv.map(String) : [],
          binaryOverrideEnv: launch.binaryOverrideEnv ?? null,
        }
      : null,
    model: model.id,
    modelTier: model.tier,
    modelDefault: model.default === true,
    // Catalog settings are operator-owned launch intent. Only the knobs the
    // runner actually enforces are rendered as records; the JSON form carries
    // the full block for tooling.
    modelSettings:
      model.settings !== null &&
      typeof model.settings === "object" &&
      !Array.isArray(model.settings)
        ? model.settings
        : {},
    catalogPath: provider.catalogPath,
    // The model's own transport wins over the provider default. Before this, run.sh
    // recomputed the same distinction from an if-chain on `$CODEX_TRANSPORT_CONTRACT`
    // and carried its own copy of the required client version and the two injected
    // vendor catalog paths — facts that already lived in the catalog and had no business
    // being restated in shell.
    transportContract: model.transport?.contract ?? provider.transportContract ?? null,
    transportKind: model.transport?.kind ?? "direct_mcp",
    transportRequiredCliVersion: model.transport?.requiredCliVersion ?? null,
    transportPromptTemplate: transportPath(provider, model, "promptTemplate"),
    transportPlayerCatalog: transportPath(provider, model, "playerCatalog"),
    transportFragment: transportPath(provider, model, "fragment"),
    modelCertified: model.certified === true,
  };
}

/** The original one-line contract: kind, isolation, model, tier. */
export function renderLegacyLine(resolved) {
  return `${resolved.kind}\t${resolved.isolation}\t${resolved.model}\t${resolved.modelTier}\n`;
}

/**
 * Flat key/value records for the shell.
 *
 * Keys mirror the registry's own field names rather than the runner's variable names, so
 * a reader of providers.json can see where each one came from. Repeated keys are a list.
 */
export function renderRecords(resolved) {
  const rows = [
    ["id", resolved.id],
    ["kind", resolved.kind],
    ["isolation", resolved.isolation],
    ["isolation_code", resolved.isolationCode],
    ["isolation_reason", resolved.isolationReason],
    ["drivable", resolved.drivable ? "1" : "0"],
    ["drivable_reason", resolved.drivableReason],
    ["capture_reader_module", resolved.captureReaderModule],
    ["session_log_root_env", resolved.sessionLog?.rootEnv ?? null],
    ["session_log_root_default", resolved.sessionLog?.rootDefault ?? null],
    ["session_log_path_template", resolved.sessionLog?.pathTemplate ?? null],
    ["launch_executable", resolved.launch?.executable ?? null],
    ["launch_binary_override_env", resolved.launch?.binaryOverrideEnv ?? null],
    ...(resolved.launch?.argv ?? []).map((argument) => ["launch_argv", argument]),
    ["model", resolved.model],
    ["model_tier", resolved.modelTier],
    ["model_default", resolved.modelDefault ? "1" : "0"],
    [
      "model_reasoning_effort",
      typeof resolved.modelSettings?.reasoning_effort === "string"
        ? resolved.modelSettings.reasoning_effort
        : null,
    ],
    [
      "model_context_window",
      Number.isSafeInteger(resolved.modelSettings?.context_window) &&
      resolved.modelSettings.context_window > 0
        ? String(resolved.modelSettings.context_window)
        : null,
    ],
    ["catalog_path", resolved.catalogPath],
    ["transport_contract", resolved.transportContract],
    ["transport_kind", resolved.transportKind],
    ["transport_required_cli_version", resolved.transportRequiredCliVersion],
    ["transport_prompt_template", resolved.transportPromptTemplate],
    ["transport_player_catalog", resolved.transportPlayerCatalog],
    ["transport_fragment", resolved.transportFragment],
    ["model_certified", resolved.modelCertified ? "1" : "0"],
  ];
  let out = "";
  for (const [key, value] of rows) {
    // ABSENT is omitted; EMPTY is not absent. `claude_code` legitimately declares
    // `--tools ""` in its argv, and dropping that element would silently rewrite the
    // launch command into one nobody wrote — the exact class of corruption a column
    // format invites and this format exists to avoid.
    if (value === null || value === undefined) continue;
    const text = String(value);
    // The shell reader splits on TAB and on newline. A registry value carrying either
    // would silently become two records or a truncated one, so refuse rather than emit a
    // record set that parses into something nobody wrote.
    if (/[\t\r\n]/u.test(text)) {
      fail(
        `registry value for "${key}" contains a tab or newline, which the record format cannot carry`,
      );
    }
    out += `${key}\t${text}\n`;
  }
  return out;
}

export function renderJson(resolved) {
  return `${JSON.stringify(resolved)}\n`;
}

function main(argv) {
  let format = "legacy";
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json" || argument === "--format=json") {
      format = "json";
    } else if (argument === "--records" || argument === "--format=records") {
      format = "records";
    } else if (argument === "--format") {
      index += 1;
      const value = argv[index];
      if (value !== "legacy" && value !== "records" && value !== "json") {
        fail(`--format takes legacy, records, or json (got "${value ?? ""}")`);
      }
      format = value;
    } else if (argument === "--format=legacy") {
      format = "legacy";
    } else if (argument === "--default-provider") {
      // Answered without a provider argument, because the caller is asking WHICH
      // provider to use.
      process.stdout.write(`${defaultProviderId()}\n`);
      return;
    } else if (typeof argument === "string" && argument.startsWith("--")) {
      fail(
        `unknown option "${argument}"; usage: resolve-provider.mjs [--records|--json] <provider> [model]`,
      );
    } else {
      positional.push(argument);
    }
  }

  const [providerId, requestedModel] = positional;
  if (!providerId) fail("usage: resolve-provider.mjs [--records|--json] <provider> [model]");

  const resolved = resolveProvider(providerId, requestedModel);
  if (format === "json") {
    process.stdout.write(renderJson(resolved));
  } else if (format === "records") {
    process.stdout.write(renderRecords(resolved));
  } else {
    process.stdout.write(renderLegacyLine(resolved));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
