import {
  overworldContactTalkJournalId,
  type OverworldCharacter,
  type OverworldCharacterVariant,
  type OverworldCharacterView,
} from "./overworld.js";
import type { CampaignCharacterState } from "./campaign_character_state.js";

export type OverworldContactPresentation = Readonly<{
  character: OverworldCharacter;
  contact: OverworldCharacterView;
  presentationId: string | null;
  journalId: string;
  afterQuestIds: readonly string[];
  afterRelationshipMemoryIds: readonly string[];
  afterWorldFactIds: readonly string[];
  afterEventOptions: readonly Readonly<{ eventId: string; optionId: string }>[];
}>;

type OverworldContactPresentationState = Readonly<{
  character: CampaignCharacterState;
  completedQuestIds: ReadonlySet<string>;
  worldFactIds?: ReadonlySet<string>;
  eventOptionIdFor?: (eventId: string) => string | null;
}>;

function contactView(
  character: OverworldCharacter,
  variant: OverworldCharacterVariant | null,
): OverworldCharacterView {
  const { campaign_npc_id: _campaignNpcId, variants: _variants, ...base } = character;
  return Object.freeze({
    ...base,
    ...(variant?.summary !== undefined ? { summary: variant.summary } : {}),
    ...(variant?.agenda !== undefined ? { agenda: variant.agenda } : {}),
  });
}

function presentation(
  character: OverworldCharacter,
  variant: OverworldCharacterVariant | null,
): OverworldContactPresentation {
  const presentationId = variant?.id ?? null;
  return Object.freeze({
    character,
    contact: contactView(character, variant),
    presentationId,
    journalId: overworldContactTalkJournalId(character.id, presentationId),
    afterQuestIds: Object.freeze([...(variant?.after_quests ?? [])]),
    afterRelationshipMemoryIds: Object.freeze([...(variant?.after_relationship_memories ?? [])]),
    afterWorldFactIds: Object.freeze([...(variant?.after_world_facts ?? [])]),
    afterEventOptions: Object.freeze(
      (variant?.after_event_options ?? []).map(({ event_id: eventId, option_id: optionId }) =>
        Object.freeze({ eventId, optionId }),
      ),
    ),
  });
}

function relationshipMemoryIdsForContact(
  character: OverworldCharacter,
  state: CampaignCharacterState,
): ReadonlySet<string> {
  if (character.campaign_npc_id === undefined) return new Set();
  const relationship = state.relationships.find(
    (candidate) => candidate.npcId === character.campaign_npc_id,
  );
  return new Set(relationship?.memories ?? []);
}

/** Resolve the first authored contact variant whose campaign proof is satisfied. */
export function presentOverworldContact(
  character: OverworldCharacter,
  state: OverworldContactPresentationState,
): OverworldContactPresentation {
  const relationshipMemoryIds = relationshipMemoryIdsForContact(character, state.character);
  const worldFactIds = state.worldFactIds ?? new Set<string>();
  const eventOptionIdFor = state.eventOptionIdFor ?? (() => null);
  const variant =
    character.variants?.find(
      (candidate) =>
        (candidate.after_quests ?? []).every((questId) => state.completedQuestIds.has(questId)) &&
        (candidate.after_relationship_memories ?? []).every((memoryId) =>
          relationshipMemoryIds.has(memoryId),
        ) &&
        (candidate.after_world_facts ?? []).every((factId) => worldFactIds.has(factId)) &&
        (candidate.after_event_options ?? []).every(
          ({ event_id: eventId, option_id: optionId }) => eventOptionIdFor(eventId) === optionId,
        ),
    ) ?? null;
  return presentation(character, variant);
}

/** Enumerate every stable journal-bound presentation for manifest and restore indexes. */
export function allOverworldContactPresentations(
  character: OverworldCharacter,
): readonly OverworldContactPresentation[] {
  return Object.freeze([
    presentation(character, null),
    ...(character.variants ?? []).map((variant) => presentation(character, variant)),
  ]);
}
