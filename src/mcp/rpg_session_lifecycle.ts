import { SAVE_MODE, assertSaveContentHash, load } from "../persist/save_load.js";
import { assertCampaignImportReceiptCatalogCompatibility } from "../persist/campaign_import_integrity.js";
import { resolveGameSource, resolveSaveGameSource } from "../world/source.js";
import {
  rpgObservationNeedsActions,
  rpgViewField,
  type RpgViewOptions,
} from "./rpg_view_projection.js";
import {
  rpgSessionLegendField,
  rpgSourceFields,
  type RpgMcpSessionRuntime,
  type RpgSessionPayload,
} from "./rpg_session_runtime.js";
import { publicRpgStateHash } from "./rpg_state_guards.js";
import type { RpgSourceRuntime } from "./rpg_source_runtime.js";
import type { SessionStore } from "./sessions.js";
import { embeddedQuestCharacterContinuityField } from "./embedded_quest_character_continuity_projection.js";

type RpgNewGameToolArgs = {
  generate_rpg_seed?: number;
  seed?: number;
  hide_graph?: boolean;
  include_world_intro?: boolean;
} & RpgViewOptions;

export type RpgStartWorldQuestToolArgs = {
  world_quest_id: string;
  seed?: number;
  hide_graph?: boolean;
  include_world_intro?: boolean;
} & RpgViewOptions;

type RpgLoadGameToolArgs = {
  world_quest_id?: string;
  generate_rpg_seed?: number;
  save: string;
  hide_graph?: boolean;
  include_world_intro?: boolean;
} & RpgViewOptions;

export type RpgWorldQuestStartPayload<Args extends RpgStartWorldQuestToolArgs> =
  RpgSessionPayload<Args>;

type RpgLifecycleDeps = {
  root: string;
  sessions: SessionStore;
  rpgRuntime: RpgMcpSessionRuntime;
  rpgSources: RpgSourceRuntime;
};

const EMBEDDED_START_FIELDS = [
  "overworldSessionId",
  "overworld_session_id",
  "campaignCharacter",
  "campaign_character",
  "campaignImports",
  "campaign_imports",
  "embeddedCharacterContinuity",
  "embedded_character_continuity",
  "characterContinuity",
  "character_continuity",
] as const;

function assertPublicWorldQuestStart(args: object): void {
  for (const field of EMBEDDED_START_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(args, field)) {
      throw new Error(`start_world_quest does not accept embedded field "${field}".`);
    }
  }
}

export function runRpgNewGame<Args extends RpgNewGameToolArgs>(
  deps: Pick<RpgLifecycleDeps, "root" | "rpgRuntime" | "rpgSources">,
  args: Args,
): RpgSessionPayload<Args> {
  const source = resolveGameSource(deps.root, args, "new_game");
  const compiled = deps.rpgSources.requireGeneratedRpgPlayable(source.generateRpgSeed);
  return deps.rpgRuntime.startRpgSession(compiled, args, {
    generatedRpgSeed: source.generateRpgSeed,
  });
}

export function runRpgStartWorldQuest<Args extends RpgStartWorldQuestToolArgs>(
  deps: Pick<RpgLifecycleDeps, "rpgRuntime" | "rpgSources">,
  args: Args,
): RpgWorldQuestStartPayload<Args> {
  assertPublicWorldQuestStart(args);
  if ((args as { quest_id?: unknown }).quest_id !== undefined) {
    throw new Error("Pass world_quest_id to start_world_quest. Do not pass quest_id.");
  }
  if ((args as { world_quest_id?: unknown }).world_quest_id === undefined) {
    throw new Error("start_world_quest requires world_quest_id.");
  }
  const source = deps.rpgSources.requireWorldQuestPlayable(args.world_quest_id);
  // This public structural/QA entry point has no trusted campaign parent.
  // Preserve standalone pack semantics even when the quest catalog declares
  // campaign imports; only the closure-private overworld bridge may project a
  // persistent campaign character into the initial RPG state.
  const started = deps.rpgRuntime.startRpgSession(source.compiled, args, {
    worldQuestId: source.questId,
  });
  return started as RpgWorldQuestStartPayload<Args>;
}

export function runRpgLoadGame<Args extends RpgLoadGameToolArgs>(
  deps: RpgLifecycleDeps,
  args: Args,
): RpgSessionPayload<Args> {
  const bundle = load(args.save, undefined, SAVE_MODE);
  const source = resolveSaveGameSource(deps.root, args, bundle, "load_game");
  const playable =
    source.kind === "worldQuest"
      ? deps.rpgSources.requireWorldQuestPlayable(source.worldQuestId)
      : {
          compiled: deps.rpgSources.requireGeneratedRpgPlayable(source.generateRpgSeed),
          campaignImports: undefined,
        };
  const { compiled } = playable;
  assertSaveContentHash(bundle, compiled.contentHash);
  assertCampaignImportReceiptCatalogCompatibility(bundle.state, playable.campaignImports);
  const session = deps.rpgRuntime.startSession(compiled, bundle.state, {
    ...(source.worldQuestId ? { worldQuestId: source.worldQuestId } : {}),
    ...(source.generateRpgSeed !== null ? { generatedRpgSeed: source.generateRpgSeed } : {}),
    ...(bundle.embedded_character_continuity
      ? {
          embeddedCharacterContinuity: bundle.embedded_character_continuity.character_continuity,
        }
      : {}),
    ...(args.hide_graph ? { hideGraph: true } : {}),
  });
  const openingOpts = deps.rpgRuntime.openingObservationOptions(session, {
    includeWorldIntro: args.compact_observation !== true || args.include_world_intro === true,
  });
  openingOpts.includeAvailableActions = rpgObservationNeedsActions(args);
  return {
    session_id: session.id,
    // Session-creating response: carry the legend once, like
    // new_game/start_world_quest do via RpgMcpSessionRuntime.startRpgSession.
    ...rpgSessionLegendField(),
    ...rpgViewField(
      deps.sessions,
      session,
      () =>
        deps.rpgRuntime.openingObservationOf(
          session,
          openingOpts,
          args.compact_observation !== true,
        ),
      args,
      openingOpts,
    ),
    ...rpgSourceFields(session),
    ...embeddedQuestCharacterContinuityField(session, args),
    state_hash: publicRpgStateHash(session.stateHash),
  } as RpgSessionPayload<Args>;
}
