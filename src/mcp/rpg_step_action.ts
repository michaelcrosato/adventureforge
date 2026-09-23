import { rpgActionOptionForInputId, type RpgActionOption } from "../rpg/legal_actions.js";
import { activeDialogue } from "../rpg/model.js";
import { rpgRoomTitle, type RpgMcpSessionRuntime } from "./rpg_session_runtime.js";
import type { SessionStore } from "./sessions.js";
import {
  publicRpgStateHash,
  rpgStateHashMatches,
  rpgStateHashRejection,
  type RpgStateHashRejection,
} from "./rpg_state_guards.js";
import {
  rpgStepEventVersion,
  rpgStepEvents,
  type RpgEventOptions,
  type RpgStepEvents,
  type RpgStepEventVersion,
} from "./transcript_projection.js";
import {
  rpgObservationNeedsActions,
  rpgViewField,
  type RpgViewField,
  type RpgViewOptions,
} from "./rpg_view_projection.js";
import { compactMcpActionLabel, compactMcpTranscriptActionId } from "./action_labels.js";
import { classifyRpgJourneyDecision, excludedJourneyDecision } from "../world/journey_decision.js";
import type { JourneyDecisionClassification } from "../world/journey_contract.js";

type RpgStepActionArgs = {
  session_id: string;
  action_id: string;
  expected_state_hash?: string;
  hide_graph?: boolean;
} & RpgViewOptions &
  RpgEventOptions;

type RpgJourneyDecisionFields = {
  journeyDecision: JourneyDecisionClassification;
  journeyActionId: string | null;
};

type RpgStepActionBase<Args extends RpgViewOptions & RpgEventOptions> = {
  events: RpgStepEvents<Args>;
  state_hash: string;
} & RpgStepEventVersion<Args> &
  RpgViewField<Args> &
  RpgJourneyDecisionFields;

type RpgStepResponseOptions = RpgViewOptions & RpgEventOptions & { expected_state_hash?: string };

export type RpgStepActionResponse<Args extends RpgStepResponseOptions> =
  | ({ ok: true } & RpgStepActionBase<Args>)
  | ({ ok: false; rejection_reason: string } & RpgStepActionBase<Args>)
  | (Args extends { expected_state_hash: string }
      ? RpgStateHashRejection & RpgJourneyDecisionFields
      : never);

function actionOptionForId(
  actions: readonly RpgActionOption[],
  id: string,
  active: ReturnType<typeof activeDialogue>,
): RpgActionOption | null {
  const exact = rpgActionOptionForInputId(actions, id);
  if (exact) return exact;
  if (!active || !id.startsWith("ask_")) return null;
  const topicAlias = id.slice("ask_".length);
  const aliasedTopic = active.node.topics.find((topic) =>
    (topic.aliases ?? []).includes(topicAlias),
  );
  if (!aliasedTopic) return null;
  return (
    actions.find(
      (action) => action.action.type === "ASK" && action.action.topic === aliasedTopic.id,
    ) ?? null
  );
}

function obsLocation(obs: { room: string }): string {
  return obs.room;
}

export function runRpgStepAction<Args extends RpgStepActionArgs>(
  deps: {
    sessions: SessionStore;
    rpgRuntime: RpgMcpSessionRuntime;
  },
  args: Args,
): RpgStepActionResponse<Args> {
  const { sessions, rpgRuntime } = deps;
  const s = sessions.get(args.session_id);
  const currentStateHash = s.stateHash;
  if (
    args.expected_state_hash !== undefined &&
    !rpgStateHashMatches(args.expected_state_hash, currentStateHash)
  ) {
    const rejection = rpgStateHashRejection(currentStateHash);
    return {
      ...rejection,
      rejection_reason: s.embeddedCharacterContinuity
        ? `${rejection.rejection_reason} To restore the embedded character context, call ` +
          "get_observation with include_character_continuity:true."
        : rejection.rejection_reason,
      journeyDecision: excludedJourneyDecision("rejected"),
      journeyActionId: null,
    } as RpgStepActionResponse<Args>;
  }
  const actionOptions = rpgRuntime.legalActionsFor(s);
  const blockedActionOption = rpgRuntime
    .blockedActionsFor(s)
    .find((action) => action.id === args.action_id);
  const active = activeDialogue(s.index, s.state);
  const actionOption = actionOptionForId(actionOptions, args.action_id, active);
  const beforeState = s.state;
  const beforeStep = s.state.step;
  const beforeSceneId = s.state.current;
  const beforeTitle = rpgRoomTitle(s.index, s.state);
  if (actionOption === null) {
    const rejectionReason =
      blockedActionOption?.reason ?? "That action is not available right now.";
    const rejectionEvents = [{ type: "rejected" as const, reason: rejectionReason }];
    const beforeObsOpts = {
      hideGraph: args.hide_graph ?? s.hideGraph ?? false,
      includeAvailableActions: rpgObservationNeedsActions(args),
    };
    sessions.appendTranscript(s.id, {
      step: beforeStep,
      scene_id: beforeSceneId,
      title: beforeTitle,
      action_id: compactMcpTranscriptActionId(args.action_id),
      action_text: blockedActionOption ? compactMcpActionLabel(blockedActionOption.command) : null,
      events: rejectionEvents,
      result_scene_id: beforeSceneId,
      ended: s.state.ended,
      ending_id: s.state.endingId,
    });
    return {
      ok: false,
      rejection_reason: rejectionReason,
      events: rpgStepEvents(rejectionEvents, args),
      ...rpgStepEventVersion(args),
      ...rpgViewField(
        sessions,
        s,
        () => rpgRuntime.observationOf(s, beforeObsOpts, args.compact_observation !== true),
        args,
        beforeObsOpts,
      ),
      state_hash: publicRpgStateHash(currentStateHash),
      journeyDecision: excludedJourneyDecision("rejected"),
      journeyActionId: null,
    } as RpgStepActionResponse<Args>;
  }
  const result = s.step(s.state, actionOption.action);
  sessions.update(s.id, result.state);
  const afterObsOpts = {
    hideGraph: args.hide_graph ?? s.hideGraph ?? false,
    includeAvailableActions: rpgObservationNeedsActions(args),
  };
  const after = rpgRuntime.observationOf(s, afterObsOpts, args.compact_observation !== true);
  sessions.appendTranscript(s.id, {
    step: beforeStep,
    scene_id: beforeSceneId,
    title: beforeTitle,
    action_id: compactMcpTranscriptActionId(actionOption.id),
    action_text: compactMcpActionLabel(actionOption.command),
    events: result.events,
    result_scene_id: obsLocation(after),
    ended: after.ended,
    ending_id: after.ending_id,
  });
  if (!result.ok) {
    return {
      ok: false,
      rejection_reason: result.rejectionReason ?? "Action rejected.",
      events: rpgStepEvents(result.events, args),
      ...rpgStepEventVersion(args),
      ...rpgViewField(sessions, s, after, args, afterObsOpts),
      state_hash: publicRpgStateHash(s.stateHash),
      journeyDecision: classifyRpgJourneyDecision({
        action: actionOption.action,
        before: beforeState,
        after: result.state,
        events: result.events,
        accepted: false,
        isSkillCheck: actionOption.skill_check !== undefined,
      }),
      journeyActionId: actionOption.id,
    } as RpgStepActionResponse<Args>;
  }
  return {
    ok: true,
    events: rpgStepEvents(result.events, args),
    ...rpgStepEventVersion(args),
    ...rpgViewField(sessions, s, after, args, afterObsOpts),
    state_hash: publicRpgStateHash(s.stateHash),
    journeyDecision: classifyRpgJourneyDecision({
      action: actionOption.action,
      before: beforeState,
      after: result.state,
      events: result.events,
      accepted: true,
      isSkillCheck: actionOption.skill_check !== undefined,
    }),
    journeyActionId: actionOption.id,
  } as RpgStepActionResponse<Args>;
}
