import { z } from "zod";
import { canonicalize } from "../core/hash.js";

export const CRAWL_FINDING_CODES = [
  "CRASH",
  "INTEGRITY",
  "DESYNC",
  "PERSIST",
  "LEGALITY",
  "SOFTLOCK",
  "RENDER",
  "WORLD",
  "ORPHAN",
] as const;

export type CrawlFindingCode = (typeof CRAWL_FINDING_CODES)[number];

export type CrawlSeverity = "S0" | "S1" | "S2" | "S3" | "S4";

/** Fixed severity per code; SOFTLOCK escalates to S4 when zero legal actions. */
export const CODE_SEVERITY: Record<CrawlFindingCode, CrawlSeverity> = {
  CRASH: "S4",
  INTEGRITY: "S4",
  DESYNC: "S4",
  PERSIST: "S4",
  LEGALITY: "S3",
  SOFTLOCK: "S3",
  RENDER: "S2",
  WORLD: "S3",
  ORPHAN: "S0",
};

export const CrawlLocationSchema = z
  .object({
    region: z.string().nullable(),
    node: z.string().nullable(),
    questId: z.string().nullable(),
    sceneId: z.string().nullable(),
  })
  .strict();

const CrawlReproSchema = z
  .object({
    kind: z.enum(["rpg-trace", "overworld-actions", "none"]),
    trace: z.unknown().nullable(),
    minimized: z.boolean(),
  })
  .strict();

export const CrawlFindingSchema = z
  .object({
    code: z.enum(CRAWL_FINDING_CODES),
    severity: z.enum(["S0", "S1", "S2", "S3", "S4"]),
    seed: z.number().int(),
    policy: z.string().min(1),
    step: z.number().int().nonnegative(),
    location: CrawlLocationSchema,
    action: z.unknown().nullable(),
    message: z.string().min(1),
    stateHash: z.string().nullable(),
    commit: z.string(),
    repro: CrawlReproSchema,
  })
  .strict();

export type CrawlFinding = z.infer<typeof CrawlFindingSchema>;

/** lowercase; hex runs >=8 chars → "<hash>"; digit runs → "#"; whitespace collapsed. */
export function normalizeFindingMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/\b[0-9a-f]{8,}\b/g, "<hash>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/** `${code}|${questId ?? node ?? "?"}|${sceneId ?? "-"}|${normalizeFindingMessage(message)}` */
export function findingFingerprint(f: Pick<CrawlFinding, "code" | "location" | "message">): string {
  const { code, location, message } = f;
  const locStr = location.questId ?? location.node ?? "?";
  const sceneStr = location.sceneId ?? "-";
  const normalizedMsg = normalizeFindingMessage(message);
  return `${code}|${locStr}|${sceneStr}|${normalizedMsg}`;
}

export class FindingCollector {
  private base: { seed: number; policy: string; commit: string };
  private seenFingerprints = new Set<string>();
  private _findings: CrawlFinding[] = [];
  private _totalRaw = 0;

  constructor(base: { seed: number; policy: string; commit: string }) {
    this.base = base;
  }

  get findings(): CrawlFinding[] {
    return this._findings;
  }

  get totalRaw(): number {
    return this._totalRaw;
  }

  /**
   * Cheap dedupe pre-check: true iff a finding with this fingerprint has already been
   * kept. Lets a caller skip building an expensive repro trace before knowing `add`
   * would just discard it anyway — a defect that fires every step must not pay
   * `recordTrace`'s O(actions-so-far) replay cost on every duplicate occurrence, only
   * on the fingerprint's first occurrence (Task 5 review fix).
   */
  has(f: Pick<CrawlFinding, "code" | "location" | "message">): boolean {
    return this.seenFingerprints.has(findingFingerprint(f));
  }

  add(
    f: Omit<CrawlFinding, "seed" | "policy" | "commit" | "severity"> & {
      severity?: CrawlSeverity;
    },
  ): boolean {
    // Build the full finding with base fields and severity
    const severity = f.severity ?? CODE_SEVERITY[f.code];
    const finding: CrawlFinding = {
      ...f,
      severity,
      seed: this.base.seed,
      policy: this.base.policy,
      commit: this.base.commit,
    };

    // Validate via schema (throws on any invalid finding, unconditionally)
    CrawlFindingSchema.parse(finding);

    // Increment totalRaw after successful validation
    this._totalRaw++;

    // Get fingerprint to check for dedup
    const fp = findingFingerprint({
      code: f.code,
      location: f.location,
      message: f.message,
    });

    // Return false if already seen (deduped)
    if (this.seenFingerprints.has(fp)) {
      return false;
    }

    // Add to collection
    this.seenFingerprints.add(fp);
    this._findings.push(finding);

    return true;
  }

  countsByCode(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const finding of this._findings) {
      counts[finding.code] = (counts[finding.code] ?? 0) + 1;
    }
    return counts;
  }

  toJsonl(): string {
    const rows = this._findings.map((f) => canonicalize(f)).join("\n");
    return rows.length > 0 ? rows + "\n" : "";
  }
}
