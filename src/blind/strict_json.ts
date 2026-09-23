// ONE definition for both runtimes: the runner-side blind-tester/*.mjs modules run under
// plain node and cannot import TypeScript, so the parser lives in plain ESM and this module
// only gives it a type (the same pattern as fleet_attestation.ts's frozen v9 profiles).
// @ts-expect-error -- plain ESM without declarations, typed below.
import { parseJsonRejectingDuplicateKeys as parseStrictJson } from "../../blind-tester/strict-json.mjs";

type StrictJsonParseResult = { ok: true; value: unknown } | { ok: false; reason: string };

/** Parse one JSON value and fail closed when any object contains a duplicate decoded key. */
export const parseJsonRejectingDuplicateKeys = parseStrictJson as (
  text: string,
  label: string,
) => StrictJsonParseResult;
