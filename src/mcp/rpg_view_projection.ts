import type { ObservationOptions, RpgObservation } from "../rpg/observation.js";
import type { RpgActionOption, RpgBlockedActionOption } from "../rpg/legal_actions.js";
import { SessionStore, type Session } from "./sessions.js";
import type { McpActionOption, McpBlockedActionOption, McpObservation } from "./types.js";
import { compactMcpActionLabel } from "./action_labels.js";
import {
  compactRpgObservation,
  compactRpgBlockedActionReason,
  RPG_COMPACT_OBSERVATION_VERSION,
  type RpgCompactObservation,
} from "./compact_rpg_observation.js";

export type RpgViewOptions = {
  compact_actions?: boolean;
  compact_observation?: boolean;
  include_actions?: boolean;
  include_context_version?: boolean;
};

export type RpgViewField<Args extends RpgViewOptions> = Args extends {
  compact_observation: true;
}
  ? { context: RpgCompactObservation }
  : { observation: McpObservation };

export type RpgLegalActionsArgs = {
  compact_actions?: boolean;
};

export type RpgLegalActionRows<Args extends RpgLegalActionsArgs> = Args extends {
  compact_actions: true;
}
  ? string[]
  : McpActionOption[];

export type RpgBlockedActionRows<Args extends RpgLegalActionsArgs> = Args extends {
  compact_actions: true;
}
  ? Array<readonly [id: string, reason: string]>
  : McpBlockedActionOption[];

type PublicObservationOptions = { compactActions?: boolean };

export type RpgObservationViewOptions = Pick<
  ObservationOptions,
  "hideGraph" | "includeWorldIntro" | "includeAvailableActions"
>;

const OBSERVATION_PROJECTION_COMPACT = `compact-observation:v${RPG_COMPACT_OBSERVATION_VERSION}`;
const OBSERVATION_PROJECTION_PUBLIC = "public-observation:v2";
const LEGAL_ACTION_ROWS_PROJECTION = "legal-action-rows:v2";
const BLOCKED_ACTION_ROWS_PROJECTION = "blocked-action-rows:v1";

function publicObservationOptions(args: { compact_actions?: boolean }): PublicObservationOptions {
  return args.compact_actions ? { compactActions: true } : {};
}

export function publicActions(
  actions: readonly RpgActionOption[],
  opts: PublicObservationOptions = {},
): McpActionOption[] {
  return actions.map((option) => ({
    id: option.id,
    ...(opts.compactActions ? {} : { command: compactMcpActionLabel(option.command) }),
    ...(option.skill_check ? { skill_check: { ...option.skill_check } } : {}),
    ...(option.combat ? { combat: { ...option.combat } } : {}),
    ...(option.resources
      ? { resources: { gains: [...option.resources.gains], costs: [...option.resources.costs] } }
      : {}),
  }));
}

export function publicActionRows<Args extends RpgLegalActionsArgs>(
  actions: readonly RpgActionOption[],
  args: Args,
): RpgLegalActionRows<Args> {
  return (
    args.compact_actions === true
      ? actions.map((option) => option.id)
      : publicActions(actions, publicObservationOptions(args))
  ) as RpgLegalActionRows<Args>;
}

export function publicBlockedActions(
  actions: readonly RpgBlockedActionOption[],
): McpBlockedActionOption[] {
  return actions.map((option) => ({
    id: option.id,
    command: compactMcpActionLabel(option.command),
    reason: option.reason,
  }));
}

export function publicBlockedActionRows<Args extends RpgLegalActionsArgs>(
  actions: readonly RpgBlockedActionOption[],
  args: Args,
): RpgBlockedActionRows<Args> {
  return (
    args.compact_actions === true
      ? actions.map((option) => [option.id, compactRpgBlockedActionReason(option.reason)] as const)
      : publicBlockedActions(actions)
  ) as RpgBlockedActionRows<Args>;
}

export function legalActionRowsFor<Args extends RpgLegalActionsArgs>(
  sessions: SessionStore,
  session: Session,
  actions: readonly RpgActionOption[],
  args: Args,
): RpgLegalActionRows<Args> {
  const rows = sessions.legalActionProjection(
    session.id,
    `${LEGAL_ACTION_ROWS_PROJECTION}:compact:${args.compact_actions === true ? 1 : 0}`,
    () => publicActionRows(actions, args),
  );
  return cloneLegalActionRows(rows) as RpgLegalActionRows<Args>;
}

export function blockedActionRowsFor<Args extends RpgLegalActionsArgs>(
  sessions: SessionStore,
  session: Session,
  actions: readonly RpgBlockedActionOption[],
  args: Args,
): RpgBlockedActionRows<Args> {
  const rows = sessions.legalActionProjection(
    session.id,
    `${BLOCKED_ACTION_ROWS_PROJECTION}:compact:${args.compact_actions === true ? 1 : 0}`,
    () => publicBlockedActionRows(actions, args),
  );
  return cloneBlockedActionRows(rows) as RpgBlockedActionRows<Args>;
}

export function publicObservation(
  obs: RpgObservation,
  opts: PublicObservationOptions = {},
): McpObservation {
  return cloneMcpObservation({
    ...obs,
    available_actions: publicActions(obs.available_actions, opts),
    blocked_actions: publicBlockedActions(obs.blocked_actions),
  });
}

function cloneMcpObservation(obs: McpObservation): McpObservation {
  return {
    ...obs,
    ...(obs.world !== undefined ? { world: obs.world ? { ...obs.world } : null } : {}),
    visible_objects: obs.visible_objects.map((object) => ({ ...object })),
    npcs_present: obs.npcs_present.map((npc) => ({ ...npc })),
    exits: obs.exits.map((exit) => ({ ...exit })),
    blocked_exits: obs.blocked_exits.map((exit) => ({ ...exit })),
    blocked_actions: obs.blocked_actions.map((action) => ({ ...action })),
    inventory: [...obs.inventory],
    state: {
      flags: [...obs.state.flags],
      vars: { ...obs.state.vars },
      journal: [...obs.state.journal],
    },
    dialogue: obs.dialogue ? { ...obs.dialogue } : null,
    enemies_present: obs.enemies_present.map((enemy) => ({ ...enemy })),
    stats: { ...obs.stats },
    available_actions: obs.available_actions.map((action) => ({
      ...action,
      ...(action.skill_check ? { skill_check: { ...action.skill_check } } : {}),
      ...(action.combat ? { combat: { ...action.combat } } : {}),
      ...(action.resources
        ? { resources: { gains: [...action.resources.gains], costs: [...action.resources.costs] } }
        : {}),
    })),
    ending: obs.ending ? { ...obs.ending } : null,
  };
}

function cloneLegalActionRows(
  rows: readonly (string | McpActionOption)[],
): (string | McpActionOption)[] {
  return rows.map((row) =>
    typeof row === "string"
      ? row
      : {
          ...row,
          ...(row.skill_check ? { skill_check: { ...row.skill_check } } : {}),
          ...(row.combat ? { combat: { ...row.combat } } : {}),
          ...(row.resources
            ? { resources: { gains: [...row.resources.gains], costs: [...row.resources.costs] } }
            : {}),
        },
  );
}

function cloneBlockedActionRows(
  rows: readonly (readonly [string, string] | McpBlockedActionOption)[],
): Array<readonly [string, string] | McpBlockedActionOption> {
  return rows.map((row) => (Array.isArray(row) ? ([...row] as [string, string]) : { ...row }));
}

function cloneCompactTupleList<Tuple extends readonly unknown[]>(
  values: readonly Tuple[],
): Tuple[] {
  return values.map((value) => [...value] as unknown as Tuple);
}

export function cloneCompactRpgObservation(context: RpgCompactObservation): RpgCompactObservation {
  return {
    ...context,
    here: [...context.here],
    vitals: [...context.vitals],
    ...(context.exits
      ? {
          exits: context.exits.map((exit) =>
            typeof exit === "string" ? exit : ([...exit] as typeof exit),
          ),
        }
      : {}),
    ...(context.actions ? { actions: [...context.actions] } : {}),
    ...(context.checks ? { checks: cloneCompactTupleList(context.checks) } : {}),
    ...(context.objects ? { objects: [...context.objects] } : {}),
    ...(context.npcs ? { npcs: cloneCompactTupleList(context.npcs) } : {}),
    ...(context.blocked ? { blocked: cloneCompactTupleList(context.blocked) } : {}),
    ...(context.unavailable ? { unavailable: cloneCompactTupleList(context.unavailable) } : {}),
    ...(context.inv ? { inv: [...context.inv] } : {}),
    ...(context.flags ? { flags: [...context.flags] } : {}),
    ...(context.vars ? { vars: { ...context.vars } } : {}),
    ...(context.journal ? { journal: [...context.journal] } : {}),
    ...(context.more ? { more: [...context.more] } : {}),
    ...(context.dialogue ? { dialogue: [...context.dialogue] } : {}),
    ...(context.choices ? { choices: cloneCompactTupleList(context.choices) } : {}),
    ...(context.enemies ? { enemies: cloneCompactTupleList(context.enemies) } : {}),
    ...(context.ending ? { ending: { ...context.ending } } : {}),
  };
}

export function observationProjectionSuffix(
  opts: RpgObservationViewOptions,
  extra: string,
): string {
  return `hide:${opts.hideGraph === true ? 1 : 0}:intro:${opts.includeWorldIntro === true ? 1 : 0}:actions:${opts.includeAvailableActions === false ? 0 : 1}:${extra}`;
}

export function rpgObservationNeedsActions(args: RpgViewOptions): boolean {
  return args.compact_observation !== true || args.include_actions === true;
}

type RpgObservationSource = RpgObservation | (() => RpgObservation);

function observationFrom(source: RpgObservationSource): RpgObservation {
  return typeof source === "function" ? source() : source;
}

export function rpgViewField<Args extends RpgViewOptions>(
  sessions: SessionStore,
  session: Session,
  obs: RpgObservationSource,
  args: Args,
  opts: RpgObservationViewOptions = {},
): RpgViewField<Args> {
  if (args.compact_observation === true) {
    const includeActions = args.include_actions === true;
    const includeVersion = args.include_context_version === true;
    const context = sessions.observationProjection(
      session.id,
      `${OBSERVATION_PROJECTION_COMPACT}:${observationProjectionSuffix(
        opts,
        `rows:actions:${includeActions ? 1 : 0}:version:${includeVersion ? 1 : 0}`,
      )}`,
      () => {
        const built = observationFrom(obs);
        const actionRows = includeActions ? built.available_actions : [];
        return compactRpgObservation(built, actionRows, { includeActions, includeVersion });
      },
    );
    return {
      context: cloneCompactRpgObservation(context),
    } as RpgViewField<Args>;
  }
  const observation = sessions.observationProjection(
    session.id,
    `${OBSERVATION_PROJECTION_PUBLIC}:${observationProjectionSuffix(
      opts,
      `compact-actions:${args.compact_actions === true ? 1 : 0}`,
    )}`,
    () => publicObservation(observationFrom(obs), publicObservationOptions(args)),
  );
  return {
    observation: cloneMcpObservation(observation),
  } as RpgViewField<Args>;
}
