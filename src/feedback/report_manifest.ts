/**
 * Deterministic identity manifest for one feedback compile.
 *
 * The manifest separates the cumulative report corpus from the actionable
 * cohort compiled on this pass. Its digest is suitable for a small tracked
 * acceptance marker, so ignored feedback artifacts cannot become authoritative
 * merely by having the newest directory name.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { parseJsonRejectingDuplicateKeys } from "../blind/strict_json.js";
import { canonicalize } from "../core/hash.js";

const REPORT_MANIFEST_SCHEMA_VERSION = 1;

const SHA256_RE = /^[0-9a-f]{64}$/u;
const REPORT_ID_RE = /^(?:pure|report):[0-9a-f]{64}$/u;

const ReportIdSchema = z.string().regex(REPORT_ID_RE);

const SortedReportIdsSchema = z.array(ReportIdSchema).superRefine((ids, ctx) => {
  for (let index = 1; index < ids.length; index += 1) {
    if (ids[index - 1]! >= ids[index]!) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: "report ids must be strictly sorted and unique",
      });
    }
  }
});

type ReportBuckets = {
  verified_report_ids: string[];
  actionable_report_ids: string[];
  excluded_mock_report_ids: string[];
};

function isExactPartition(value: ReportBuckets): boolean {
  const verified = new Set(value.verified_report_ids);
  const actionable = new Set(value.actionable_report_ids);
  const excluded = new Set(value.excluded_mock_report_ids);
  if (actionable.size + excluded.size !== verified.size) return false;
  for (const id of actionable) {
    if (!verified.has(id) || excluded.has(id)) return false;
  }
  for (const id of excluded) {
    if (!verified.has(id)) return false;
  }
  return true;
}

function refinePartition(value: ReportBuckets, ctx: z.RefinementCtx): void {
  if (!isExactPartition(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verified_report_ids"],
      message: "actionable and excluded mock report ids must exactly partition verified report ids",
    });
  }
}

export const ReportCorpusSchema = z
  .object({
    verified_report_ids: SortedReportIdsSchema,
    actionable_report_ids: SortedReportIdsSchema,
    excluded_mock_report_ids: SortedReportIdsSchema,
    seen_report_ids: SortedReportIdsSchema,
  })
  .strict()
  .superRefine(refinePartition);

export const ReportCohortSchema = z
  .object({
    verified_report_ids: SortedReportIdsSchema,
    actionable_report_ids: SortedReportIdsSchema,
    excluded_mock_report_ids: SortedReportIdsSchema,
  })
  .strict()
  .superRefine(refinePartition);

const ReportManifestOutputsSchema = z
  .object({
    hotspots_sha256: z.string().regex(SHA256_RE),
    retention_sha256: z.string().regex(SHA256_RE),
    markdown_sha256: z.string().regex(SHA256_RE),
  })
  .strict();

const ReportManifestKindSchema = z.enum(["bootstrap", "initial", "delta", "standalone"]);

function isSubset(subset: readonly string[], superset: readonly string[]): boolean {
  const allowed = new Set(superset);
  return subset.every((id) => allowed.has(id));
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export const ReportManifestSchema = z
  .object({
    schema_version: z.literal(REPORT_MANIFEST_SCHEMA_VERSION),
    kind: ReportManifestKindSchema,
    generated_at: z.string().datetime({ offset: true }),
    commit: z.string().min(1),
    previous_manifest_sha256: z.string().regex(SHA256_RE).nullable(),
    corpus: ReportCorpusSchema,
    cohort: ReportCohortSchema,
    outputs: ReportManifestOutputsSchema,
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (!isSubset(manifest.corpus.verified_report_ids, manifest.corpus.seen_report_ids)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["corpus", "verified_report_ids"],
        message: "corpus verified report ids must be a subset of seen report ids",
      });
    }

    const cohortKeys = [
      "verified_report_ids",
      "actionable_report_ids",
      "excluded_mock_report_ids",
    ] as const;
    for (const key of cohortKeys) {
      if (!isSubset(manifest.cohort[key], manifest.corpus[key])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cohort", key],
          message: `cohort ${key} must be a subset of corpus ${key}`,
        });
      }
    }

    if (manifest.kind === "delta") {
      if (manifest.previous_manifest_sha256 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["previous_manifest_sha256"],
          message: "delta manifests require a previous manifest digest",
        });
      }
    } else if (manifest.previous_manifest_sha256 !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["previous_manifest_sha256"],
        message: `${manifest.kind} manifests forbid a previous manifest digest`,
      });
    }

    if (manifest.kind === "bootstrap") {
      if (cohortKeys.some((key) => manifest.cohort[key].length !== 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cohort"],
          message: "bootstrap manifests require an empty cohort",
        });
      }
    } else if (manifest.kind === "initial" || manifest.kind === "standalone") {
      if (cohortKeys.some((key) => !arraysEqual(manifest.cohort[key], manifest.corpus[key]))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cohort"],
          message: `${manifest.kind} manifest cohorts must equal their corpus`,
        });
      }
    }
  });

export type ReportCorpus = z.infer<typeof ReportCorpusSchema>;
export type ReportCohort = z.infer<typeof ReportCohortSchema>;
export type ReportManifest = z.infer<typeof ReportManifestSchema>;

export type LoadedReportManifest = {
  manifest: ReportManifest;
  digest: string;
};

/** SHA-256 of exact bytes, encoded as 64 lowercase hexadecimal characters. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** SHA-256 of a string's exact UTF-8 bytes. */
export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA-256 of a file's exact bytes. */
export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

/** Strict schema validation followed by recursively key-sorted JSON and one newline. */
export function serializeReportManifest(manifest: ReportManifest): string {
  return `${canonicalize(ReportManifestSchema.parse(manifest))}\n`;
}

/**
 * Load one canonical manifest from a regular, non-symlink file.
 *
 * Malformed JSON, duplicate keys, invalid schemas, non-canonical bytes, symbolic
 * links, I/O races, and an optional accepted-digest mismatch all fail closed.
 */
export function loadReportManifest(
  path: string,
  expectedDigest?: string,
): LoadedReportManifest | null {
  if (expectedDigest !== undefined && !SHA256_RE.test(expectedDigest)) return null;
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;

    const bytes = readFileSync(path);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const raw = parseJsonRejectingDuplicateKeys(text, "feedback report manifest");
    if (!raw.ok) return null;
    const parsed = ReportManifestSchema.safeParse(raw.value);
    if (!parsed.success) return null;
    if (text !== serializeReportManifest(parsed.data)) return null;

    const digest = sha256Bytes(bytes);
    if (expectedDigest !== undefined && digest !== expectedDigest) return null;
    return { manifest: parsed.data, digest };
  } catch {
    return null;
  }
}
