import {
  compactOverworldQuestRef,
  compactRouteOption,
  type OverworldCompactQuestRef,
  type OverworldCompactRouteOption,
} from "../world/compact_view.js";
import {
  compactOpeningDepartureRecapTerms,
  type OpeningCompactDepartureRecap,
  type OpeningCompactDepartureRecapTerms,
} from "../world/opening_departure_recap.js";
import type { OverworldManifest, OverworldNode } from "../world/overworld.js";
import {
  type OverworldActionResult,
  type OverworldAreaTravelResult,
  type OverworldJourneyGoalPassageResult,
  type OverworldJourneyStoryChoiceResult,
  type OverworldQuestCompletionResult,
  type OverworldQuestView,
  type OverworldRoadEncounterResult,
  type OverworldRoadEncounterStrategy,
  type OverworldServiceResult,
  type OverworldSession,
  type OverworldSessionRoutePlan,
  type TravelLogEntry,
} from "../world/session.js";
import type { JourneyOpportunityKind } from "../world/journey_contract.js";
import type { JourneyOpportunityExplanation } from "../world/journey_opportunity_explainer.js";
import {
  compactOverworldActionResultLegendKeys,
  compactOverworldActionResult,
  compactOverworldAreaTravelResult,
  compactOverworldGoalPassageResult,
  compactOverworldJourneyStoryChoiceResult,
  compactOverworldJourneyChoiceResult,
  compactOverworldOpportunityExplanation,
  compactOverworldQuestCompletionResult,
  compactOverworldRoadEncounterResult,
  compactOverworldQuestCompletionResultLegendKeys,
  compactOverworldServiceResultLegendKeys,
  compactOverworldServiceResult,
  compactOverworldTravelResult,
  OVERWORLD_COMPACT_RESULT_LEGEND_KEYS,
  type OverworldCompactActionResult,
  type OverworldCompactAreaTravelResult,
  type OverworldCompactGoalPassageResult,
  type OverworldCompactJourneyStoryChoiceResult,
  type OverworldCompactJourneyChoiceResult,
  type OverworldCompactOpportunityExplanation,
  type OverworldCompactQuestCompletionResult,
  type OverworldCompactRoadEncounterResult,
  type OverworldCompactServiceResult,
  type OverworldCompactTravelResult,
} from "./compact_overworld_result.js";
import {
  isOverworldMcpRejectedSessionPayload,
  type OverworldMcpContextResponse,
  type OverworldMcpExportArgs,
  type OverworldMcpExportResponse,
  type OverworldMcpJourneyField,
  type OverworldMcpJourneyForArgs,
  type OverworldMcpLegendPatch,
  type OverworldMcpReadArgs,
  type OverworldMcpReadResponse,
  type OverworldMcpRejectedSessionPayload,
  type OverworldMcpResponseOptions,
  type OverworldMcpRestoreResponse,
  type OverworldMcpSessionResponse,
  type OverworldMcpSessionStore,
  type OverworldMcpStartResponse,
  type OverworldMcpViewField,
} from "./overworld_sessions.js";
import {
  overworldQuestCompletionFromRpgSession,
  startOverworldQuestThroughRpg,
  type EmbeddedOverworldQuestStartContext,
  type OverworldQuestRpgStartArgs,
} from "./overworld_quest_bridge.js";
import {
  rpgStateHashMatches,
  rpgStateHashRejection,
  type RpgStateHashRejection,
} from "./rpg_state_guards.js";
import { embeddedQuestCharacterContinuityField } from "./embedded_quest_character_continuity_projection.js";
import {
  rpgSourceFields,
  type RpgMcpSessionRuntime,
  type RpgSessionPayload,
  type RpgSessionPayloadBody,
} from "./rpg_session_runtime.js";
import { runRpgGetObservation } from "./rpg_session_tools.js";
import type { EmbeddedQuestPersistence } from "./embedded_quest_persistence.js";
import type { RpgViewOptions } from "./rpg_view_projection.js";
import type { SessionStore } from "./sessions.js";
import {
  compactJourneyStoryChoiceComparison,
  compactJourneyPresentation,
  embeddedJourneyFocus,
  journeyBlocksGameplay,
  storyChoiceSupportsDepartureRecapTerms,
  suppressRpgGameplayActions,
  type EmbeddedJourneyField,
  type EmbeddedJourneyFocus,
  type JourneyStoryChoiceComparison,
  type JourneyStoryChoiceDetail,
  type JourneyStoryChoiceSummaryComparison,
} from "./journey_projection.js";
import {
  embeddedQuestLaunchHandoff,
  type EmbeddedQuestLaunchHandoff,
} from "./embedded_quest_launch_handoff.js";
import type {
  JourneyDecisionClassification,
  JourneyStoryChoicePrompt,
} from "../world/journey_contract.js";

type OverworldResponseOptions = OverworldMcpResponseOptions;

type DefaultCompactOverworldContext<Args extends OverworldResponseOptions> = Args extends {
  compact_context: false;
}
  ? Args
  : Args & { compact_context: true };

type DefaultCompactOverworldResult<Args extends OverworldResponseOptions> = Args extends {
  compact_result: false;
}
  ? Args
  : Args & { compact_result: true };

type DefaultCompactOverworldResponse<Args extends OverworldResponseOptions> =
  DefaultCompactOverworldResult<DefaultCompactOverworldContext<Args>>;

type DefaultCompactRpgObservation<Args extends RpgViewOptions> = Args extends {
  compact_observation: false;
}
  ? Args
  : Args & { compact_observation: true };

type DefaultCompactOverworldQuestStart<Args extends OverworldResponseOptions & RpgViewOptions> =
  DefaultCompactRpgObservation<DefaultCompactOverworldResponse<Args>>;

function defaultCompactOverworldContext<Args extends OverworldResponseOptions>(
  args: Args,
): DefaultCompactOverworldContext<Args> {
  return { compact_context: true, ...args } as DefaultCompactOverworldContext<Args>;
}

function defaultCompactOverworldResponse<Args extends OverworldResponseOptions>(
  args: Args,
): DefaultCompactOverworldResponse<Args> {
  return {
    compact_context: true,
    compact_result: true,
    ...args,
  } as DefaultCompactOverworldResponse<Args>;
}

function defaultCompactOverworldQuestStart<Args extends OverworldResponseOptions & RpgViewOptions>(
  args: Args,
): DefaultCompactOverworldQuestStart<Args> {
  return {
    compact_context: true,
    compact_result: true,
    compact_observation: true,
    ...args,
  } as DefaultCompactOverworldQuestStart<Args>;
}

function defaultCompactJourneyChoice<Args extends OverworldResponseOptions & RpgViewOptions>(
  args: Args,
): DefaultCompactOverworldQuestStart<Args> {
  return {
    compact_context: true,
    compact_result: true,
    compact_observation: true,
    include_actions: true,
    ...args,
  } as DefaultCompactOverworldQuestStart<Args>;
}

type OverworldListOptions = {
  include_design_notes?: boolean;
};

type OverworldViewField<Args extends OverworldResponseOptions> = OverworldMcpViewField<Args>;

type OverworldResultValue<
  Args extends OverworldResponseOptions,
  Value,
  CompactValue,
> = Args extends { compact_result: true } ? CompactValue : Value;

type OverworldRejectedSessionPayload<Args extends OverworldResponseOptions> =
  OverworldMcpRejectedSessionPayload<Args>;

type OverworldGuardedRejection<Args extends OverworldResponseOptions> = Args extends {
  expected_snapshot_hash: string;
}
  ? OverworldRejectedSessionPayload<Args>
  : never;

type OverworldStartResponse<Args extends OverworldResponseOptions> =
  OverworldMcpStartResponse<Args>;

type OverworldRestoreResponse<Args extends OverworldResponseOptions> =
  OverworldMcpRestoreResponse<Args>;

type OverworldExportResponse<Args extends OverworldMcpExportArgs> =
  OverworldMcpExportResponse<Args>;

type OverworldListSummary = {
  world: Pick<OverworldManifest, "id" | "name" | "start" | "premise">;
  town_count: number;
  road_count: number;
  region_count: number;
  regional_arc_count: number;
  area_count: number;
  area_route_count: number;
  character_count: number;
  local_event_count: number;
  local_job_count: number;
  road_event_count: number;
  exploration_site_count: number;
  quest_count: number;
  start: OverworldNode;
};

type OverworldDesignNotes = {
  sources: OverworldManifest["sources"];
  design_rules: string[];
};

type OverworldListResponse<Args extends OverworldListOptions> = OverworldListSummary &
  (Args extends { include_design_notes: true } ? OverworldDesignNotes : Record<string, never>);

type OverworldQuestStartViewField<Args extends OverworldResponseOptions> = Args extends {
  compact_context: true;
}
  ? Partial<OverworldViewField<Args>> & { legend_delta?: OverworldMcpLegendPatch }
  : OverworldViewField<Args>;

type OverworldQuestStartJourney<Args extends OverworldResponseOptions> = Args extends {
  compact_context: true;
}
  ? EmbeddedJourneyFocus | OverworldMcpJourneyForArgs<Args>
  : OverworldMcpJourneyForArgs<Args>;

type OverworldQuestStartResponse<Args extends OverworldResponseOptions & RpgViewOptions> =
  | ({
      ok: true;
      session_id: string;
      snapshot_hash: string;
      overworld_snapshot_hash: string;
      journey: OverworldQuestStartJourney<Args>;
      quest: OverworldResultValue<Args, OverworldQuestView, OverworldCompactQuestRef>;
      launch_handoff?: EmbeddedQuestLaunchHandoff;
      rpg_session_id: string;
      rpg_session: RpgSessionPayload<Args>;
      journeyDecision: JourneyDecisionClassification;
    } & OverworldQuestStartViewField<Args>)
  | OverworldGuardedRejection<Args>;

type OverworldSessionResponse<
  Key extends string,
  Value,
  Args extends OverworldResponseOptions,
  CompactValue = Value,
> = OverworldMcpSessionResponse<Key, Value, Args, CompactValue>;

type ResumedEmbeddedJourneyForArgs<Args extends RpgViewOptions & OverworldResponseOptions> =
  Args extends { compact_context: true } ? EmbeddedJourneyFocus : OverworldMcpJourneyForArgs<Args>;

type ResumedEmbeddedRpgField<Args extends RpgViewOptions & OverworldResponseOptions> = {
  rpg_session_id: string;
  rpg_session: RpgSessionPayloadBody<Args> &
    EmbeddedJourneyField<ResumedEmbeddedJourneyForArgs<Args>>;
};

type OverworldJourneyChoiceResponse<Args extends OverworldResponseOptions & RpgViewOptions> =
  OverworldSessionResponse<
    "result",
    JourneyChoiceResult,
    Args,
    OverworldCompactJourneyChoiceResult
  > &
    Partial<ResumedEmbeddedRpgField<Args>>;

type OverworldCompactJourneyStoryInspection<Story extends JourneyStoryChoiceComparison> = Readonly<{
  ok: true;
  session_id: string;
  snapshot_hash: string;
  unchanged: true;
  story: Story;
  departure_recap?: OpeningCompactDepartureRecap;
  departure_recap_terms?: OpeningCompactDepartureRecapTerms;
  legend_delta?: OverworldMcpLegendPatch;
}>;

type JourneyStoryInspectionForArgs<Args> = Args extends { option_id: string }
  ? JourneyStoryChoiceDetail
  : Args extends { reveal_id: string }
    ? JourneyStoryChoiceSummaryComparison
    : "option_id" extends keyof Args
      ? JourneyStoryChoiceSummaryComparison | JourneyStoryChoiceDetail
      : "reveal_id" extends keyof Args
        ? JourneyStoryChoiceSummaryComparison
        : JourneyStoryChoiceSummaryComparison;

type OverworldJourneyStoryInspectionResponse<Args extends OverworldResponseOptions> =
  DefaultCompactOverworldResponse<Args> extends { compact_result: false }
    ? OverworldSessionResponse<
        "story",
        JourneyStoryChoicePrompt,
        DefaultCompactOverworldResponse<Args>,
        JourneyStoryChoiceComparison
      >
    :
        | OverworldCompactJourneyStoryInspection<JourneyStoryInspectionForArgs<Args>>
        | OverworldGuardedRejection<DefaultCompactOverworldResponse<Args>>;

type JourneyChoice = Parameters<OverworldSession["chooseJourney"]>[0];
type JourneyChoiceResult = ReturnType<OverworldSession["chooseJourney"]>;

export type OverworldToolHandlerDeps = {
  sessions: SessionStore;
  rpgRuntime: RpgMcpSessionRuntime;
  overworldSessions: OverworldMcpSessionStore;
  loadOverworldManifest: () => OverworldManifest;
  startEmbeddedWorldQuest: <Args extends OverworldQuestRpgStartArgs>(
    args: Args,
    context: EmbeddedOverworldQuestStartContext,
  ) => RpgSessionPayload<Args>;
  /** Persists an active quest's child beside its parent across export/restore (bug_0654). */
  embeddedQuests: EmbeddedQuestPersistence;
};

export function createOverworldToolHandlers(deps: OverworldToolHandlerDeps) {
  const { sessions, overworldSessions } = deps;
  // OverworldSession owns both reveal receipts and option legality. Protocol handlers
  // only select the appropriate session operation, so UI, terminal, MCP, restore, and
  // direct callers all observe one durable state transition and one hard gate.

  return {
    list_overworld<Args extends OverworldListOptions = Record<string, never>>(
      args?: Args,
    ): OverworldListResponse<Args> {
      const world = deps.loadOverworldManifest();
      const start = world.nodes.find((node) => node.id === world.start);
      if (!start) throw new Error(`Overworld start node "${world.start}" is missing.`);
      const summary: OverworldListSummary = {
        world: {
          id: world.id,
          name: world.name,
          start: world.start,
          premise: world.premise,
        },
        town_count: world.nodes.length,
        road_count: world.edges.length,
        region_count: world.regions.length,
        regional_arc_count: world.regional_arcs.length,
        area_count: world.areas.length,
        area_route_count: world.area_edges.length,
        character_count: world.characters.length,
        local_event_count: world.local_events.length,
        local_job_count: world.local_jobs.length,
        road_event_count: world.road_events.length,
        exploration_site_count: world.exploration_sites.length,
        quest_count: world.quests.length,
        start,
      };
      if (args?.include_design_notes === true) {
        return {
          ...summary,
          sources: world.sources,
          design_rules: world.design_rules,
        } as unknown as OverworldListResponse<Args>;
      }
      return summary as OverworldListResponse<Args>;
    },

    start_overworld<Args extends OverworldResponseOptions = { compact_context: true }>(
      args?: Args,
    ): OverworldStartResponse<DefaultCompactOverworldContext<Args>> {
      const responseOptions = defaultCompactOverworldContext((args ?? {}) as Args);
      return overworldSessions.startResponse(responseOptions);
    },

    get_overworld_session<Args extends OverworldMcpReadArgs>(
      args: Args,
    ): OverworldMcpReadResponse<Args> {
      return overworldSessions.read(args);
    },

    get_overworld_session_context<Args extends OverworldMcpReadArgs>(
      args: Args,
    ): OverworldMcpContextResponse<Args> {
      return overworldSessions.readContext(args);
    },

    explain_overworld_session_opportunity<
      Args extends {
        session_id: string;
        kind: JourneyOpportunityKind;
        id: string;
      } & OverworldResponseOptions,
    >(
      args: Args,
    ): OverworldSessionResponse<
      "explanation",
      JourneyOpportunityExplanation,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactOpportunityExplanation
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      return overworldSessions.run(
        responseOptions,
        args.session_id,
        "explanation",
        (session) => session.explainOpportunity({ kind: args.kind, id: args.id }),
        compactOverworldOpportunityExplanation,
        OVERWORLD_COMPACT_RESULT_LEGEND_KEYS.opportunity_explanation,
      );
    },

    export_overworld_session<Args extends OverworldMcpExportArgs>(
      args: Args,
    ): OverworldExportResponse<Args> {
      return overworldSessions.exportSnapshot(args, deps.embeddedQuests.exportChild);
    },

    restore_overworld_session<
      Args extends { snapshot: unknown; embedded_quest?: unknown } & OverworldResponseOptions,
    >(args: Args): OverworldRestoreResponse<DefaultCompactOverworldContext<Args>> {
      const responseOptions = defaultCompactOverworldContext(args);
      return overworldSessions.restoreResponse(responseOptions, args.snapshot, (session) =>
        deps.embeddedQuests.prepareRestore(session, args.embedded_quest),
      );
    },

    plan_overworld_session_route<
      Args extends {
        session_id: string;
        destination_town_id: string;
      } & OverworldResponseOptions,
    >(
      args: Args,
    ): OverworldSessionResponse<
      "route",
      OverworldSessionRoutePlan,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactRouteOption
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      return overworldSessions.run(
        responseOptions,
        args.session_id,
        "route",
        (session) => session.planRoute(args.destination_town_id),
        compactRouteOption,
        OVERWORLD_COMPACT_RESULT_LEGEND_KEYS.route,
      );
    },

    travel_overworld_session<
      Args extends {
        session_id: string;
        road_id?: string;
        destination_town_id?: string;
      } & OverworldResponseOptions,
    >(
      args: Args,
    ): OverworldSessionResponse<
      "travel",
      TravelLogEntry,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactTravelResult
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      const travelByRoadId = args.road_id !== undefined;
      const travelByDestination = args.destination_town_id !== undefined;
      if (travelByRoadId === travelByDestination) {
        throw new Error("Pass exactly one: road_id or destination_town_id.");
      }
      if (args.road_id !== undefined) {
        const roadId = args.road_id;
        return overworldSessions.run(
          responseOptions,
          args.session_id,
          "travel",
          (session) => session.travel(roadId),
          compactOverworldTravelResult,
          OVERWORLD_COMPACT_RESULT_LEGEND_KEYS.travel,
        );
      }
      const destinationTownId = args.destination_town_id;
      if (destinationTownId === undefined) {
        throw new Error("Pass exactly one: road_id or destination_town_id.");
      }
      return overworldSessions.run(
        responseOptions,
        args.session_id,
        "travel",
        (session) => session.travelTo(destinationTownId),
        compactOverworldTravelResult,
        OVERWORLD_COMPACT_RESULT_LEGEND_KEYS.travel,
      );
    },

    follow_overworld_session_goal<Args extends { session_id: string } & OverworldResponseOptions>(
      args: Args,
    ): OverworldSessionResponse<
      "passage",
      OverworldJourneyGoalPassageResult,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactGoalPassageResult
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      return overworldSessions.run(
        responseOptions,
        args.session_id,
        "passage",
        (session) => session.followGoalPassage(),
        compactOverworldGoalPassageResult,
        OVERWORLD_COMPACT_RESULT_LEGEND_KEYS.goal_passage,
      );
    },

    resolve_overworld_session_road_encounter<
      Args extends {
        session_id: string;
        strategy: OverworldRoadEncounterStrategy;
      } & OverworldResponseOptions,
    >(
      args: Args,
    ): OverworldSessionResponse<
      "result",
      OverworldRoadEncounterResult,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactRoadEncounterResult
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      return overworldSessions.run(
        responseOptions,
        args.session_id,
        "result",
        (session) => session.resolveRoadEncounter(args.strategy),
        compactOverworldRoadEncounterResult,
        OVERWORLD_COMPACT_RESULT_LEGEND_KEYS.road_encounter,
      );
    },

    care_overworld_session<Args extends { session_id: string } & OverworldResponseOptions>(
      args: Args,
    ): OverworldSessionResponse<
      "result",
      OverworldServiceResult,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactServiceResult
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      return overworldSessions.run(
        responseOptions,
        args.session_id,
        "result",
        (session) => session.careAtTown(),
        compactOverworldServiceResult,
        compactOverworldServiceResultLegendKeys,
      );
    },

    resupply_overworld_session<Args extends { session_id: string } & OverworldResponseOptions>(
      args: Args,
    ): OverworldSessionResponse<
      "result",
      OverworldServiceResult,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactServiceResult
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      return overworldSessions.run(
        responseOptions,
        args.session_id,
        "result",
        (session) => session.resupplyAtTown(),
        compactOverworldServiceResult,
        compactOverworldServiceResultLegendKeys,
      );
    },

    rest_overworld_session<Args extends { session_id: string } & OverworldResponseOptions>(
      args: Args,
    ): OverworldSessionResponse<
      "result",
      OverworldServiceResult,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactServiceResult
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      return overworldSessions.run(
        responseOptions,
        args.session_id,
        "result",
        (session) => session.restAtTown(),
        compactOverworldServiceResult,
        compactOverworldServiceResultLegendKeys,
      );
    },

    scout_overworld_session_poi<
      Args extends { session_id: string; poi_id: string } & OverworldResponseOptions,
    >(
      args: Args,
    ): OverworldSessionResponse<
      "result",
      OverworldActionResult,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactActionResult
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      return overworldSessions.run(
        responseOptions,
        args.session_id,
        "result",
        (session) => session.scoutPoi(args.poi_id),
        compactOverworldActionResult,
        compactOverworldActionResultLegendKeys,
      );
    },

    talk_overworld_session_contact<
      Args extends { session_id: string; character_id: string } & OverworldResponseOptions,
    >(
      args: Args,
    ): OverworldSessionResponse<
      "result",
      OverworldActionResult,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactActionResult
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      return overworldSessions.run(
        responseOptions,
        args.session_id,
        "result",
        (session) => session.talkToCharacter(args.character_id),
        compactOverworldActionResult,
        compactOverworldActionResultLegendKeys,
      );
    },

    investigate_overworld_session_event<
      Args extends { session_id: string; event_id: string } & OverworldResponseOptions,
    >(
      args: Args,
    ): OverworldSessionResponse<
      "result",
      OverworldActionResult,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactActionResult
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      return overworldSessions.run(
        responseOptions,
        args.session_id,
        "result",
        (session) => session.investigateEvent(args.event_id),
        compactOverworldActionResult,
        compactOverworldActionResultLegendKeys,
      );
    },

    resolve_overworld_session_event<
      Args extends {
        session_id: string;
        event_id: string;
        option_id?: string;
      } & OverworldResponseOptions,
    >(
      args: Args,
    ): OverworldSessionResponse<
      "result",
      OverworldActionResult,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactActionResult
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      return overworldSessions.run(
        responseOptions,
        args.session_id,
        "result",
        (session) => session.resolveEvent(args.event_id, args.option_id),
        compactOverworldActionResult,
        compactOverworldActionResultLegendKeys,
      );
    },

    explore_overworld_session_site<
      Args extends { session_id: string; site_id: string } & OverworldResponseOptions,
    >(
      args: Args,
    ): OverworldSessionResponse<
      "result",
      OverworldActionResult,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactActionResult
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      return overworldSessions.run(
        responseOptions,
        args.session_id,
        "result",
        (session) => session.exploreSite(args.site_id),
        compactOverworldActionResult,
        compactOverworldActionResultLegendKeys,
      );
    },

    explore_overworld_session_area<
      Args extends { session_id: string; area_id: string } & OverworldResponseOptions,
    >(
      args: Args,
    ): OverworldSessionResponse<
      "result",
      OverworldActionResult,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactActionResult
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      return overworldSessions.run(
        responseOptions,
        args.session_id,
        "result",
        (session) => session.exploreArea(args.area_id),
        compactOverworldActionResult,
        compactOverworldActionResultLegendKeys,
      );
    },

    work_overworld_session_job<
      Args extends {
        session_id: string;
        job_id: string;
        option_id?: string;
      } & OverworldResponseOptions,
    >(
      args: Args,
    ): OverworldSessionResponse<
      "result",
      OverworldActionResult,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactActionResult
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      return overworldSessions.run(
        responseOptions,
        args.session_id,
        "result",
        (session) => session.workLocalJob(args.job_id, args.option_id),
        compactOverworldActionResult,
        compactOverworldActionResultLegendKeys,
      );
    },

    start_overworld_session_quest<
      Args extends {
        session_id: string;
        quest_id: string;
        approach_id?: string;
        seed?: number;
        hide_graph?: boolean;
        compact_actions?: boolean;
        compact_observation?: boolean;
        include_actions?: boolean;
      } & OverworldResponseOptions,
    >(args: Args): OverworldQuestStartResponse<DefaultCompactOverworldQuestStart<Args>> {
      const responseOptions = defaultCompactOverworldQuestStart(args);
      const guarded = overworldSessions.guardedSession(responseOptions, args.session_id);
      if (isOverworldMcpRejectedSessionPayload(guarded)) {
        return guarded as unknown as OverworldQuestStartResponse<
          DefaultCompactOverworldQuestStart<Args>
        >;
      }
      const { session } = guarded;
      session.assertJourneyAcceptingDecision();
      const departureRecap = session.view().departureRecap;
      const started = startOverworldQuestThroughRpg({
        session,
        overworldSessionId: args.session_id,
        questId: args.quest_id,
        ...(args.approach_id !== undefined ? { approachId: args.approach_id } : {}),
        startOptions: responseOptions,
        startEmbeddedWorldQuest: deps.startEmbeddedWorldQuest,
      });
      const launchHandoff = embeddedQuestLaunchHandoff({
        quest: started.quest,
        departureRecap,
        journeyGoalId: session.journey().goal.id,
      });
      const questResult =
        responseOptions.compact_result === true
          ? compactOverworldQuestRef(started.quest, false, false, launchHandoff !== null)
          : started.quest;
      const journey = session.journey();
      const responseJourney =
        responseOptions.compact_context === true
          ? launchHandoff
            ? embeddedJourneyFocus(journey)
            : compactJourneyPresentation(journey)
          : journey;
      if (journey.pendingChoice !== null) {
        sessions.markEmbeddedJourneyPause(started.rpgSession.session_id);
      }
      const rpgSession = journeyBlocksGameplay(journey)
        ? suppressRpgGameplayActions(started.rpgSession)
        : started.rpgSession;
      const overworldSnapshotHash = overworldSessions.snapshotHash(session);
      const resultLegendKeys =
        responseOptions.compact_result === true
          ? OVERWORLD_COMPACT_RESULT_LEGEND_KEYS.quest_start
          : [];
      const view =
        responseOptions.compact_context === true && launchHandoff !== null
          ? {
              beforeResult: overworldSessions.resultLegendField(session, resultLegendKeys),
              afterResult: {},
            }
          : overworldSessions.resultViewFields(responseOptions, session, resultLegendKeys);
      return {
        ok: true,
        session_id: args.session_id,
        snapshot_hash: overworldSnapshotHash,
        overworld_snapshot_hash: overworldSnapshotHash,
        journey: responseJourney,
        journeyDecision: started.quest.journeyDecision,
        ...view.beforeResult,
        quest: questResult,
        ...(launchHandoff ? { launch_handoff: launchHandoff } : {}),
        rpg_session_id: rpgSession.session_id,
        rpg_session: rpgSession,
        ...view.afterResult,
      } as unknown as OverworldQuestStartResponse<DefaultCompactOverworldQuestStart<Args>>;
    },

    choose_overworld_session_journey<
      Args extends {
        session_id: string;
        choice: JourneyChoice;
      } & OverworldResponseOptions &
        RpgViewOptions,
    >(args: Args): OverworldJourneyChoiceResponse<DefaultCompactOverworldQuestStart<Args>> {
      const responseOptions = defaultCompactJourneyChoice(args);
      const response = overworldSessions.run(
        responseOptions,
        args.session_id,
        "result",
        (session) => session.chooseJourney(args.choice),
        compactOverworldJourneyChoiceResult,
      );
      if (response.ok !== true) {
        return response as OverworldJourneyChoiceResponse<DefaultCompactOverworldQuestStart<Args>>;
      }

      const pausedRpgSession = sessions.embeddedJourneyPause(args.session_id);
      const canResume =
        args.choice === "continue" &&
        pausedRpgSession !== null &&
        !pausedRpgSession.state.ended &&
        !journeyBlocksGameplay(response.journey);
      if (!canResume || !pausedRpgSession) {
        sessions.clearEmbeddedJourneyPause(args.session_id);
        return response as OverworldJourneyChoiceResponse<DefaultCompactOverworldQuestStart<Args>>;
      }

      const rpgView = runRpgGetObservation(
        { sessions, rpgRuntime: deps.rpgRuntime },
        { ...responseOptions, session_id: pausedRpgSession.id },
      );
      const liveJourney = overworldSessions.get(args.session_id).journey();
      const embeddedJourney: EmbeddedJourneyField<
        ResumedEmbeddedJourneyForArgs<typeof responseOptions>
      > = {
        journey: (responseOptions.compact_context === true
          ? embeddedJourneyFocus(liveJourney)
          : liveJourney) as ResumedEmbeddedJourneyForArgs<typeof responseOptions>,
        overworld_snapshot_hash: response.snapshot_hash,
      };
      sessions.clearEmbeddedJourneyPause(args.session_id);
      return {
        ...response,
        rpg_session_id: pausedRpgSession.id,
        rpg_session: {
          session_id: pausedRpgSession.id,
          ...rpgView,
          ...rpgSourceFields(pausedRpgSession),
          ...embeddedQuestCharacterContinuityField(pausedRpgSession, responseOptions),
          ...embeddedJourney,
        },
      } as OverworldJourneyChoiceResponse<DefaultCompactOverworldQuestStart<Args>>;
    },

    choose_overworld_session_story<
      Args extends {
        session_id: string;
        choice: string;
        story_choice_id?: string;
      } & OverworldResponseOptions,
    >(
      args: Args,
    ): OverworldSessionResponse<
      "result",
      OverworldJourneyStoryChoiceResult,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactJourneyStoryChoiceResult
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      const response = overworldSessions.run(
        responseOptions,
        args.session_id,
        "result",
        (session) => session.chooseJourneyStory(args.choice, args.story_choice_id),
        compactOverworldJourneyStoryChoiceResult,
        OVERWORLD_COMPACT_RESULT_LEGEND_KEYS.journey_story_choice,
      );
      return response;
    },

    inspect_overworld_session_story<
      Args extends {
        session_id: string;
        story_choice_id: string;
        option_id?: string;
        reveal_id?: string;
      } & OverworldResponseOptions,
    >(args: Args): OverworldJourneyStoryInspectionResponse<Args> {
      const responseOptions = defaultCompactOverworldResponse(args);
      const inspectStory = (session: OverworldSession): JourneyStoryChoicePrompt => {
        if (args.option_id !== undefined && args.reveal_id !== undefined) {
          throw new Error("Story choice inspection accepts option_id or reveal_id, not both.");
        }
        if (args.option_id !== undefined) {
          return session.inspectJourneyStoryOption(args.story_choice_id, args.option_id);
        }
        if (args.reveal_id !== undefined) {
          return session.revealJourneyStory(args.story_choice_id, args.reveal_id);
        }
        return session.inspectJourneyStory(args.story_choice_id);
      };
      if (args.compact_result === false) {
        const response = overworldSessions.run(
          responseOptions,
          args.session_id,
          "story",
          (session) => inspectStory(session),
        );
        return response as unknown as OverworldJourneyStoryInspectionResponse<Args>;
      }
      const guarded = overworldSessions.guardedSession(responseOptions, args.session_id);
      if (isOverworldMcpRejectedSessionPayload(guarded)) {
        return guarded as unknown as OverworldJourneyStoryInspectionResponse<Args>;
      }
      const story = inspectStory(guarded.session);
      const departureRecap = guarded.session.compactView().departure_recap;
      const fullDepartureRecap = guarded.session.view().departureRecap;
      const departureRecapTerms =
        args.option_id !== undefined &&
        storyChoiceSupportsDepartureRecapTerms(story) &&
        fullDepartureRecap
          ? compactOpeningDepartureRecapTerms(fullDepartureRecap)
          : null;
      const response = {
        ok: true,
        session_id: args.session_id,
        snapshot_hash: overworldSessions.snapshotHash(guarded.session),
        // The story projection is read-only; `unchanged` describes the JOURNEY, which a
        // reveal does not advance — no decision is recorded and no goal moves.
        unchanged: true,
        ...(departureRecap && departureRecapTerms === null
          ? { departure_recap: departureRecap }
          : {}),
        ...(departureRecapTerms
          ? {
              ...overworldSessions.resultLegendField(guarded.session, ["departure_recap_terms"]),
              departure_recap_terms: departureRecapTerms,
            }
          : {}),
        story:
          args.option_id !== undefined
            ? compactJourneyStoryChoiceComparison(story, args.option_id)
            : args.reveal_id !== undefined
              ? story.progressiveDisclosure
                ? compactJourneyStoryChoiceComparison(story, undefined, args.reveal_id)
                : compactJourneyStoryChoiceComparison(story)
              : compactJourneyStoryChoiceComparison(story),
      } as OverworldJourneyStoryInspectionResponse<Args>;
      return response;
    },

    complete_overworld_session_quest<
      Args extends {
        session_id: string;
        rpg_session_id: string;
        expected_rpg_state_hash?: string;
      } & OverworldResponseOptions,
    >(
      args: Args,
    ):
      | OverworldSessionResponse<
          "result",
          OverworldQuestCompletionResult,
          DefaultCompactOverworldResponse<Args>,
          OverworldCompactQuestCompletionResult
        >
      | (Args extends { expected_rpg_state_hash: string }
          ? RpgStateHashRejection &
              OverworldMcpJourneyField<DefaultCompactOverworldResponse<Args>> & {
                overworld_snapshot_hash: string;
              }
          : never) {
      const responseOptions = defaultCompactOverworldResponse(args);
      const guarded = overworldSessions.guardedSession(responseOptions, args.session_id);
      if (isOverworldMcpRejectedSessionPayload(guarded)) {
        return guarded as OverworldSessionResponse<
          "result",
          OverworldQuestCompletionResult,
          DefaultCompactOverworldResponse<Args>,
          OverworldCompactQuestCompletionResult
        >;
      }
      const { session } = guarded;
      const rpgSession = sessions.get(args.rpg_session_id);
      if (
        args.expected_rpg_state_hash !== undefined &&
        !rpgStateHashMatches(args.expected_rpg_state_hash, rpgSession.stateHash)
      ) {
        return {
          ...rpgStateHashRejection(rpgSession.stateHash),
          journey:
            responseOptions.compact_context === true
              ? compactJourneyPresentation(session.journey())
              : session.journey(),
          overworld_snapshot_hash: overworldSessions.snapshotHash(session),
        } as Args extends { expected_rpg_state_hash: string }
          ? RpgStateHashRejection &
              OverworldMcpJourneyField<DefaultCompactOverworldResponse<Args>> & {
                overworld_snapshot_hash: string;
              }
          : never;
      }
      const completion = overworldQuestCompletionFromRpgSession(rpgSession, args.session_id);
      const result = session.completeQuest(completion.questId, completion.outcome);
      const responseValue =
        responseOptions.compact_result === true
          ? compactOverworldQuestCompletionResult(result)
          : result;
      const view = overworldSessions.resultViewFields(
        responseOptions,
        session,
        responseOptions.compact_result === true
          ? compactOverworldQuestCompletionResultLegendKeys(
              responseValue as OverworldCompactQuestCompletionResult,
            )
          : [],
      );
      return {
        ok: true,
        session_id: args.session_id,
        snapshot_hash: overworldSessions.snapshotHash(session),
        journey:
          responseOptions.compact_context === true
            ? compactJourneyPresentation(session.journey())
            : session.journey(),
        journeyDecision: result.journeyDecision,
        ...view.beforeResult,
        result: responseValue,
        ...view.afterResult,
      } as OverworldSessionResponse<
        "result",
        OverworldQuestCompletionResult,
        DefaultCompactOverworldResponse<Args>,
        OverworldCompactQuestCompletionResult
      >;
    },

    move_overworld_session_area<
      Args extends { session_id: string; area_route_id: string } & OverworldResponseOptions,
    >(
      args: Args,
    ): OverworldSessionResponse<
      "result",
      OverworldAreaTravelResult,
      DefaultCompactOverworldResponse<Args>,
      OverworldCompactAreaTravelResult
    > {
      const responseOptions = defaultCompactOverworldResponse(args);
      return overworldSessions.run(
        responseOptions,
        args.session_id,
        "result",
        (session) => session.moveArea(args.area_route_id),
        compactOverworldAreaTravelResult,
        OVERWORLD_COMPACT_RESULT_LEGEND_KEYS.area_travel,
      );
    },
  };
}
