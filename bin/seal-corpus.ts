#!/usr/bin/env -S npx tsx
/**
 * bin/seal-corpus — seal the held-out generator corpus (bug_0163).
 *
 * The procedural RPG generator already mints fresh, schema-valid, validator-clean packs the
 * assessor checks every cycle — but those windows are minted-and-DISCARDED in memory. This CLI
 * converts a FIXED, explicit seed window into a committed, content-hash-sealed artifact under the
 * top-level `corpus/` dir: the contamination-control substrate the benchmark thesis requires (a
 * sealed, timestamped, held-out split whose git commit timestamp — post the relevant model cutoffs
 * — supplies the chain-of-custody, and whose `hashState` seal is the wall-clock-free
 * reproducibility proof, §8.5/§8.6).
 *
 * Usage:
 *   npm run corpus:seal      # emit corpus/rpg/<pack_id>.yaml + corpus/manifest.json
 *
 * Deterministic and key-free: a fixed seed window, the pure mulberry32 generators, the same
 * `hashState` the MCP generate_pack/generate_rpg_pack tools emit, and a key-sorted manifest, so
 * re-running produces a BYTE-IDENTICAL tree (the regression test + a second run prove it). It
 * REFUSES to seal a dirty corpus: every minted pack must clear the SAME production RPG validator
 * the curated packs do (validateRpg, zero findings) or it throws.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { generateRpgPack, RPG_GENERATOR_VERSION } from "../src/gen/rpg_generator.js";
import { validateRpg } from "../src/validate/rpg_validator.js";
import { hashState } from "../src/core/hash.js";

// Fixed, explicit seed windows — a STABLE committed snapshot, NOT a moving window. Do not source
// these from AI_LOOP_STATE.md: the corpus must stay byte-identical across re-seals.
const RPG_SEEDS = [0, 1, 2, 3] as const;

type ManifestEntry = {
  mode: "rpg";
  seed: number;
  pack_id: string;
  generator_version: number;
  content_hash: string;
};

/** Serialize an object with keys sorted recursively, so the committed JSON is byte-stable. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortDeep(obj[key]);
    return out;
  }
  return value;
}

function main(): void {
  const root = process.cwd();
  const entries: ManifestEntry[] = [];

  for (const seed of RPG_SEEDS) {
    const pack = generateRpgPack(seed);
    const report = validateRpg(pack);
    if (report.findings.length > 0) {
      throw new Error(
        `refusing to seal a dirty RPG pack (seed ${seed}, ${pack.meta.id}): ` +
          report.findings.map((f) => `${f.severity}/${f.code}: ${f.message}`).join(" | "),
      );
    }
    const dir = join(root, "corpus", "rpg");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${pack.meta.id}.yaml`), stringify(pack));
    entries.push({
      mode: "rpg",
      seed,
      pack_id: pack.meta.id,
      generator_version: RPG_GENERATOR_VERSION,
      content_hash: hashState(pack),
    });
  }

  // Deterministic, key-sorted entry order so the committed manifest is byte-stable.
  entries.sort((a, b) => a.seed - b.seed);
  const manifest = { generated_by: "bin/seal-corpus.ts", entries: entries.map(sortDeep) };
  writeFileSync(join(root, "corpus", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(`Sealed ${entries.length} RPG packs into corpus/rpg/; manifest written.`);
}

main();
