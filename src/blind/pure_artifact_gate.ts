import { existsSync, readFileSync } from "node:fs";
import { parseBlindRunSidecar } from "./run_evidence.js";
import { parseJsonRejectingDuplicateKeys } from "./strict_json.js";
import {
  CertifiedCodexModelSchema,
  PureFleetPrimaryClaudeEnvelopeSchema,
  pureFleetModelMatchesRequest,
  pureFleetRunArtifactPaths,
  validatePureFleetRunArtifactBytes,
  type CertifiedClaudeModel,
  type CertifiedFleetModel,
  type PureFleetProvider,
  type PureFleetRunArtifactBytes,
} from "../starting_slice/fleet_run_artifacts.js";
import { certifiedModelIdsForProvider } from "./providers.js";

type AdjacentPureArtifactGate =
  | { ok: true; provider: PureFleetProvider | "legacy" }
  | { ok: false; reason: string };

/**
 * The identities a Claude pure-fleet run may be certified under.
 *
 * Was a hardcoded `["haiku", "sonnet", "opus"]`, which is the launch-ALIAS spelling of
 * three models the catalog holds under their full names (`claude-sonnet-5` and friends).
 * Two hand-kept spellings of one set, in different files, with nothing checking they
 * agreed: certifying a fourth Claude model meant remembering to edit both, and forgetting
 * the one here failed at the least legible point — "primary Claude envelope model is not
 * a supported fleet model", for a model the operator had just certified.
 *
 * The catalog now carries the mapping explicitly on each entry (`certifiedAs`), so this
 * derives. Read at call time rather than frozen at import, because catalogs are
 * operator-editable and a long-running QA process should see an edit without a restart.
 */
function claudeCertifiedIdentities(): string[] {
  return certifiedModelIdsForProvider("claude_code");
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalBytes(path: string): Uint8Array | null {
  return existsSync(path) ? readFileSync(path) : null;
}

function inferProviderExpectation(
  primaryEnvelope: Uint8Array,
):
  | { ok: true; provider: PureFleetProvider; model: CertifiedFleetModel }
  | { ok: false; reason: string } {
  let text: string;
  try {
    text = utf8Decoder.decode(primaryEnvelope);
  } catch {
    return { ok: false, reason: "primary provider envelope is not valid UTF-8" };
  }
  const raw = parseJsonRejectingDuplicateKeys(text, "primary provider envelope");
  if (!raw.ok) return raw;
  if (!isRecord(raw.value)) {
    return { ok: false, reason: "primary provider envelope is not an object" };
  }
  if (raw.value.provider === "codex") {
    const model = CertifiedCodexModelSchema.safeParse(raw.value.requested_model);
    return model.success
      ? { ok: true, provider: "codex", model: model.data }
      : { ok: false, reason: "primary Codex envelope has no certified requested model" };
  }
  if (raw.value.provider !== undefined && raw.value.provider !== "claude") {
    return { ok: false, reason: "primary provider envelope has an unknown provider" };
  }

  const claude = PureFleetPrimaryClaudeEnvelopeSchema.safeParse(raw.value);
  if (!claude.success) {
    return { ok: false, reason: "primary provider envelope has no valid provider authority" };
  }
  const actualModels = Object.keys(claude.data.modelUsage);
  if (actualModels.length !== 1) {
    return { ok: false, reason: "primary Claude envelope has ambiguous model authority" };
  }
  const aliases = claudeCertifiedIdentities().filter((alias) =>
    pureFleetModelMatchesRequest(actualModels[0]!, alias),
  );
  if (aliases.length !== 1) {
    return { ok: false, reason: "primary Claude envelope model is not a supported fleet model" };
  }
  return { ok: true, provider: "claude", model: aliases[0] as CertifiedClaudeModel };
}

/**
 * Re-authenticate current pure evidence before feedback reuse. Schema-v2 runs
 * must reproduce the complete fleet authority chain, not just a verified
 * sidecar or a transplantable provider trace. Schema-v1 evidence retains its
 * historical Claude-compatible gate, but can never claim Codex raw artifacts.
 */
export function validateAdjacentPureProviderAuthority(
  reportPath: string,
): AdjacentPureArtifactGate {
  const paths = pureFleetRunArtifactPaths(reportPath);
  if (!existsSync(paths.runSidecar)) {
    return { ok: false, reason: "adjacent pure run sidecar is missing" };
  }
  const parsedSidecar = parseBlindRunSidecar(readFileSync(paths.runSidecar, "utf8"));
  if (!parsedSidecar.ok || parsedSidecar.sidecar.play_mode !== "pure") {
    return { ok: false, reason: "adjacent pure run sidecar is invalid" };
  }
  if (parsedSidecar.sidecar.schema_version === 1) {
    if (
      existsSync(paths.providerEvents) ||
      existsSync(paths.providerRollout) ||
      existsSync(paths.providerCapture)
    ) {
      return { ok: false, reason: "legacy pure evidence cannot authenticate Codex artifacts" };
    }
    if (existsSync(paths.primaryEnvelope)) {
      try {
        const raw = parseJsonRejectingDuplicateKeys(
          readFileSync(paths.primaryEnvelope, "utf8"),
          "legacy primary provider envelope",
        );
        if (raw.ok && isRecord(raw.value) && raw.value.provider === "codex") {
          return { ok: false, reason: "legacy pure evidence cannot claim Codex authority" };
        }
      } catch {
        // Legacy Claude evidence keeps its historical sidecar-only acceptance.
      }
    }
    return { ok: true, provider: "legacy" };
  }

  const requiredPaths = [paths.report, paths.runSidecar, paths.runEvidence, paths.primaryEnvelope];
  if (requiredPaths.some((path) => !existsSync(path))) {
    return { ok: false, reason: "current pure evidence authority artifacts are incomplete" };
  }
  if (parsedSidecar.sidecar.build.tracked_worktree_clean !== true) {
    return { ok: false, reason: "current pure evidence did not use a clean tracked build" };
  }
  const primaryEnvelope = readFileSync(paths.primaryEnvelope);
  const expectedProvider = inferProviderExpectation(primaryEnvelope);
  if (!expectedProvider.ok) return expectedProvider;

  const input: PureFleetRunArtifactBytes = {
    report: readFileSync(paths.report),
    runSidecar: readFileSync(paths.runSidecar),
    runEvidence: readFileSync(paths.runEvidence),
    primaryEnvelope,
    initialReport: optionalBytes(paths.initialReport),
    receiptBinding: optionalBytes(paths.receiptBinding),
    recoveryMetadata: optionalBytes(paths.recoveryMetadata),
    recoveryEnvelope: optionalBytes(paths.recoveryEnvelope),
    providerEvents: optionalBytes(paths.providerEvents),
    providerRollout: optionalBytes(paths.providerRollout),
    providerCapture: optionalBytes(paths.providerCapture),
  };
  const validated = validatePureFleetRunArtifactBytes(input, {
    seed: parsedSidecar.sidecar.run_seed,
    provider: expectedProvider.provider,
    model: expectedProvider.model,
    build: { ...parsedSidecar.sidecar.build, tracked_worktree_clean: true },
  });
  return validated.ok
    ? { ok: true, provider: expectedProvider.provider }
    : { ok: false, reason: `adjacent pure provider authority rejected: ${validated.reason}` };
}
