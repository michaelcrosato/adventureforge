/**
 * UNIFIED STATE MODEL (spec §6).
 *
 * One state shape carries the RPG world runtime. The engine treats GameState
 * as immutable — every transition returns a fresh value (see core/engine.ts).
 */
import {
  cloneCampaignImportReceipt,
  type CampaignImportReceipt,
} from "./campaign_import_receipt.js";
import {
  cloneEmbeddedLaunchOverlayReceipt,
  type EmbeddedLaunchOverlayReceipt,
} from "./embedded_launch_overlay_receipt.js";

/**
 * Highest persisted action counter the engine will accept. The reducer needs
 * one safe integer of headroom for `step + 1`; beyond this, JavaScript number
 * precision can stop the monotonic counter from advancing.
 */
export const MAX_ENGINE_STEP = Number.MAX_SAFE_INTEGER - 1;

export function isRuntimeSeed(seed: unknown): seed is number {
  return typeof seed === "number" && Number.isSafeInteger(seed);
}

function runtimeSeedValidationMessage(label: string, seed: unknown): string {
  return `${label} must be an integer within JavaScript's safe range, got ${JSON.stringify(seed)}.`;
}

export function assertRuntimeSeed(seed: unknown, label: string): asserts seed is number {
  if (!isRuntimeSeed(seed)) throw new Error(runtimeSeedValidationMessage(label, seed));
}

function assertFiniteVars(vars: Record<string, number> | undefined, label: string): void {
  if (vars === undefined) return;
  for (const [name, value] of Object.entries(vars)) {
    if (!Number.isFinite(value)) {
      throw new Error(`${label}.${name} must be finite, got ${String(value)}.`);
    }
  }
}

/**
 * Read a numeric var, with an unwritten name reading as 0 (§7.1) — the semantics
 * every gate in the DSL and both validators' feasibility models are built on
 * (PHANTOM_VAR, IMPOSSIBLE_GATE).
 *
 * The bracket read has to be own-property-checked because `vars` is a plain
 * object and CONTENT controls the name: `set_var: { name: "__proto__" }` is
 * schema-valid (effects.ts spells the name as `z.string().min(1)`), and on any
 * vars object without an own `__proto__` key the plain read resolves the
 * INHERITED Object.prototype accessor instead. That value is an object, so the
 * usual `?? 0` fallback never fires: `inc_var` computed `prior + by` as the
 * string "[object Object]5", `guardFinite` rejected it and wrote the prototype
 * object back into a `Record<string, number>`, and the next `save()` died with
 * SaveIntegrityError ("vars.__proto__ expected number, received object") — a hard
 * crash for the MCP save path and the crawler's PERSIST oracle. Reading the same
 * name through a gate was wrong in both directions at once: on a fresh state both
 * `var_gte >= 1` and `var_lte <= 0` evaluated FALSE, which no unwritten var may do.
 *
 * Writes need no matching care: a COMPUTED key in an object literal
 * (`{ ...vars, [name]: value }`) defines an own data property rather than
 * invoking the legacy `__proto__` setter. So the numeric read path was the last
 * unguarded corner of the reserved-name hardening core already does in
 * `hash.ts` (bug_0247), `initState` and `cloneGameState`.
 */
export function readVar(vars: Record<string, number>, name: string): number {
  if (!Object.prototype.hasOwnProperty.call(vars, name)) return 0;
  const value = vars[name];
  // The reducer cannot produce a non-numeric own value, but a state that arrived
  // over the save boundary is only as trustworthy as the check that admitted it.
  // Fall back to the same 0 so comparisons stay total instead of propagating a
  // non-number through arithmetic.
  return typeof value === "number" ? value : 0;
}

export type ObjectRuntime = {
  open?: boolean;
  locked?: boolean;
  takenBy?: "player" | "world"; // location bookkeeping
  room?: string; // current room id if the object has been moved/dropped (Stage 2, §7.3)
};

export type GameState = {
  // identity / determinism
  seed: number;
  step: number; // monotonically increasing action counter

  // location
  current: string; // room/site id in the active RPG world graph
  visited: Record<string, boolean>;

  // world state
  flags: Record<string, boolean>; // boolean switches
  vars: Record<string, number>; // numeric variables / stats (HP, gold, skills…)
  inventory: string[]; // object ids carried by the player
  objectState: Record<string, ObjectRuntime>; // open/locked/location per world object

  // narrative
  journal: string[]; // append-only player-visible log
  questStage: Record<string, string>; // questId -> current stage id (Stage 3+)

  // termination
  ended: boolean;
  endingId: string | null;

  /** Present only when persistent campaign state materially changed this RPG's fresh state. */
  campaignImportReceipt?: CampaignImportReceipt;
  /** Quest-local opening condition from a trusted embedded overworld launch. */
  embeddedLaunchOverlayReceipt?: EmbeddedLaunchOverlayReceipt;
};

type InitOptions = {
  seed: number;
  start: string;
  varsInit?: Record<string, number>;
  flagsInit?: string[];
};

/** Build a fresh GameState. Pure: no clock, no global RNG. */
export function initState(opts: InitOptions): GameState {
  assertRuntimeSeed(opts.seed, "GameState seed");
  assertFiniteVars(opts.varsInit, "GameState varsInit");
  // Object.fromEntries defines reserved names such as `__proto__` as own data
  // properties. Bracket assignment on `{}` would invoke Object.prototype's
  // legacy setter and silently lose a schema-valid flag id.
  const flags = Object.fromEntries((opts.flagsInit ?? []).map((id) => [id, true])) as Record<
    string,
    boolean
  >;
  return {
    seed: opts.seed,
    step: 0,
    current: opts.start,
    visited: { [opts.start]: true },
    flags,
    vars: { ...(opts.varsInit ?? {}) },
    inventory: [],
    objectState: {},
    journal: [],
    questStage: {},
    ended: false,
    endingId: null,
  };
}

export function cloneGameState(state: GameState): GameState {
  // Object ids are arbitrary schema-valid strings. Object.fromEntries
  // defines an own data property even for `__proto__`; bracket assignment on `{}`
  // would invoke the legacy prototype setter and silently drop that state entry.
  const objectState = Object.fromEntries(
    Object.entries(state.objectState).map(([id, object]) => [id, { ...object }]),
  ) as GameState["objectState"];
  return {
    ...state,
    visited: { ...state.visited },
    flags: { ...state.flags },
    vars: { ...state.vars },
    inventory: [...state.inventory],
    objectState,
    journal: [...state.journal],
    questStage: { ...state.questStage },
    ...(state.campaignImportReceipt !== undefined
      ? { campaignImportReceipt: cloneCampaignImportReceipt(state.campaignImportReceipt) }
      : {}),
    ...(state.embeddedLaunchOverlayReceipt !== undefined
      ? {
          embeddedLaunchOverlayReceipt: cloneEmbeddedLaunchOverlayReceipt(
            state.embeddedLaunchOverlayReceipt,
          ),
        }
      : {}),
  };
}
