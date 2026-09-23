/**
 * RPG source loading + compilation. YAML -> validated RPG model, stamping the
 * content hash saves/traces bind to.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { hashState } from "../core/hash.js";
import { RpgPackSchema, type RpgPack } from "./schema.js";
import type { z } from "zod";

export type CompiledRpgSource = {
  pack: RpgPack;
  contentHash: string;
};

type RpgSourceCompileResult =
  | { ok: true; compiled: CompiledRpgSource }
  | { ok: false; error: z.ZodError };

export function compileRpgSource(source: string): RpgSourceCompileResult {
  const raw = parseYaml(source);
  const parsed = RpgPackSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error };
  return { ok: true, compiled: { pack: parsed.data, contentHash: hashState(parsed.data) } };
}

export function loadRpgSourceFile(path: string): RpgSourceCompileResult {
  return compileRpgSource(readFileSync(path, "utf8"));
}
