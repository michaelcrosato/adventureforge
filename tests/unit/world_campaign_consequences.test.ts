import { describe, expect, it } from "vitest";

import {
  CAMPAIGN_CHARACTER_MAX_OWED,
  CAMPAIGN_CHARACTER_MAX_HEALTH,
  CAMPAIGN_CHARACTER_MAX_RANK,
  CAMPAIGN_CHARACTER_MAX_SCORE,
  CAMPAIGN_CHARACTER_MIN_SCORE,
  buildCampaignCharacterState,
  cloneCampaignCharacterState,
  type CampaignCharacterState,
} from "../../src/world/campaign_character_state.js";
import {
  AddCompanionConsequenceSchema,
  AffirmValueConsequenceSchema,
  CampaignCharacterConditionsSchema,
  CampaignConsequenceEffectSchema,
  CampaignConsequenceEffectsSchema,
  LearnKnowledgeConsequenceSchema,
  RaiseFactionStandingConsequenceSchema,
  RecordPromiseConsequenceSchema,
  RememberRelationshipConsequenceSchema,
  RemoveCompanionConsequenceSchema,
  ResolvePromiseConsequenceSchema,
  SetWorldFactConsequenceSchema,
  SufferWoundConsequenceSchema,
  TreatWoundConsequenceSchema,
  applyCampaignConsequences,
  campaignCharacterConditionsAreMutuallyExclusive,
  campaignCharacterMatchesConditions,
  campaignConsequenceEffectKey,
  deriveCampaignWorldFactIds,
  type CampaignConsequenceEffect,
  type CampaignConsequenceEffects,
} from "../../src/world/campaign_consequences.js";
import { overworldQuestCampaignEffectsForCharacter } from "../../src/world/overworld.js";

function baseCharacter(): CampaignCharacterState {
  return buildCampaignCharacterState({
    health: { current: 24, max: 30 },
    knowledge: ["knowledge:private_map"],
    relationships: [
      {
        npcId: "npc:synthetic_guide",
        trust: -20,
        regard: 10,
        owesPlayer: 1,
        playerOwes: 2,
        memories: ["memory:first_met"],
      },
    ],
  });
}

function syntheticEffects(): CampaignConsequenceEffects {
  return CampaignConsequenceEffectsSchema.parse([
    {
      type: "affirm_value",
      value_id: "value:archive_stewardship",
      strength_at_least: 3,
    },
    {
      type: "raise_faction_standing",
      faction_id: "faction:archive_collective",
      standing_at_least: 12,
    },
    {
      type: "learn_knowledge",
      knowledge_id: "knowledge:archive_route",
    },
    {
      type: "remember_relationship",
      npc_id: "npc:synthetic_guide",
      memory_id: "memory:rescued_archive",
      trust_at_least: 25,
      regard_at_least: 30,
      owes_player_at_least: 4,
    },
    {
      type: "remember_relationship",
      npc_id: "npc:synthetic_archivist",
      memory_id: "memory:shared_evidence",
    },
    {
      type: "suffer_wound",
      wound_id: "wound:archive_fall",
      severity: 2,
      treatment: "stabilized",
      health_loss: 6,
    },
    {
      type: "set_world_fact",
      fact_id: "fact:archive_preserved",
    },
  ]);
}

describe("generic campaign consequences", () => {
  it("matches exact relationship-memory and wound-treatment predicates", () => {
    const character = buildCampaignCharacterState({
      relationships: [
        {
          npcId: "npc:synthetic_guide",
          trust: 0,
          regard: 0,
          owesPlayer: 0,
          playerOwes: 0,
          memories: ["memory:witnessed_fall"],
        },
      ],
      wounds: [
        {
          woundId: "wound:archive_fall",
          severity: 2,
          treatment: "untreated",
        },
      ],
    });
    const required = CampaignCharacterConditionsSchema.parse({
      requires_all_relationship_memories: [
        {
          npc_id: "npc:synthetic_guide",
          memory_id: "memory:witnessed_fall",
        },
      ],
      requires_all_wounds: [{ wound_id: "wound:archive_fall", treatment: "untreated" }],
    });
    expect(campaignCharacterMatchesConditions(character, required)).toBe(true);
    expect(
      campaignCharacterMatchesConditions(character, {
        forbids_any_wounds: [{ wound_id: "wound:archive_fall", treatment: "untreated" }],
      }),
    ).toBe(false);
    const absentOrTreated = CampaignCharacterConditionsSchema.parse({
      forbids_any_wounds: [
        { wound_id: "wound:archive_fall", treatment: "untreated" },
        { wound_id: "wound:archive_fall", treatment: "stabilized" },
      ],
    });
    expect(campaignCharacterMatchesConditions(character, absentOrTreated)).toBe(false);
    expect(
      campaignCharacterMatchesConditions(
        buildCampaignCharacterState({
          wounds: [
            {
              woundId: "wound:archive_fall",
              severity: 2,
              treatment: "treated",
            },
          ],
        }),
        absentOrTreated,
      ),
    ).toBe(true);
    expect(() =>
      CampaignCharacterConditionsSchema.parse({
        forbids_any_wounds: [
          { wound_id: "wound:archive_fall", treatment: "untreated" },
          { wound_id: "wound:archive_fall", treatment: "untreated" },
        ],
      }),
    ).toThrow(/repeat forbidden wound/i);
    expect(
      campaignCharacterConditionsAreMutuallyExclusive(required, {
        requires_all_wounds: [{ wound_id: "wound:archive_fall", treatment: "treated" }],
      }),
    ).toBe(true);
    expect(() =>
      CampaignCharacterConditionsSchema.parse({
        requires_all_wounds: [
          { wound_id: "wound:archive_fall", treatment: "untreated" },
          { wound_id: "wound:archive_fall", treatment: "treated" },
        ],
      }),
    ).toThrow(/mutually exclusive treatments/i);
    expect(() =>
      CampaignCharacterConditionsSchema.parse({
        requires_all_relationship_memories: [
          {
            npc_id: "npc:synthetic_guide",
            memory_id: "memory:witnessed_fall",
          },
        ],
        forbids_any_relationship_memories: [
          {
            npc_id: "npc:synthetic_guide",
            memory_id: "memory:witnessed_fall",
          },
        ],
      }),
    ).toThrow(/cannot require and forbid relationship memory/i);
  });

  it("advances wound treatment once, caps healing, and fails closed on unknown or mismatched wounds", () => {
    const source = buildCampaignCharacterState({
      health: { current: 26, max: 30 },
      wounds: [
        {
          woundId: "wound:archive_fall",
          severity: 2,
          treatment: "untreated",
        },
      ],
    });
    const effect = TreatWoundConsequenceSchema.parse({
      type: "treat_wound",
      wound_id: "wound:archive_fall",
      from_treatment: "untreated",
      to_treatment: "treated",
      health_restore: 6,
    });
    const treated = applyCampaignConsequences({ character: source, effects: [effect] });
    expect(treated.characterAfter.health).toEqual({ current: 30, max: 30 });
    expect(treated.characterAfter.wounds[0]?.treatment).toBe("treated");
    expect(
      applyCampaignConsequences({
        character: treated.characterAfter,
        effects: [effect],
      }),
    ).toEqual(treated);
    expect(source.health.current).toBe(26);
    expect(source.wounds[0]?.treatment).toBe("untreated");

    expect(() =>
      TreatWoundConsequenceSchema.parse({
        ...effect,
        from_treatment: "treated",
        to_treatment: "untreated",
      }),
    ).toThrow(/must advance/i);
    expect(() =>
      applyCampaignConsequences({
        character: buildCampaignCharacterState(),
        effects: [effect],
      }),
    ).toThrow(/unknown wound/i);
    expect(() =>
      applyCampaignConsequences({
        character: buildCampaignCharacterState({
          wounds: [
            {
              woundId: "wound:archive_fall",
              severity: 2,
              treatment: "stabilized",
            },
          ],
        }),
        effects: [effect],
      }),
    ).toThrow(/not required source treatment/i);
  });

  it("parses the complete strict monotonic vocabulary", () => {
    expect(
      AffirmValueConsequenceSchema.parse({
        type: "affirm_value",
        value_id: "value:accountability",
        strength_at_least: CAMPAIGN_CHARACTER_MAX_RANK,
      }),
    ).toEqual({
      type: "affirm_value",
      value_id: "value:accountability",
      strength_at_least: CAMPAIGN_CHARACTER_MAX_RANK,
    });
    expect(
      RaiseFactionStandingConsequenceSchema.parse({
        type: "raise_faction_standing",
        faction_id: "faction:municipal_ledger",
        standing_at_least: CAMPAIGN_CHARACTER_MAX_SCORE,
      }),
    ).toEqual({
      type: "raise_faction_standing",
      faction_id: "faction:municipal_ledger",
      standing_at_least: CAMPAIGN_CHARACTER_MAX_SCORE,
    });
    expect(
      LearnKnowledgeConsequenceSchema.parse({
        type: "learn_knowledge",
        knowledge_id: "knowledge:archive_route",
      }),
    ).toEqual({ type: "learn_knowledge", knowledge_id: "knowledge:archive_route" });
    expect(
      RememberRelationshipConsequenceSchema.parse({
        type: "remember_relationship",
        npc_id: "npc:synthetic_guide",
        memory_id: "memory:shared_evidence",
        trust_at_least: CAMPAIGN_CHARACTER_MIN_SCORE,
        regard_at_least: CAMPAIGN_CHARACTER_MAX_SCORE,
        owes_player_at_least: CAMPAIGN_CHARACTER_MAX_OWED,
      }),
    ).toEqual({
      type: "remember_relationship",
      npc_id: "npc:synthetic_guide",
      memory_id: "memory:shared_evidence",
      trust_at_least: CAMPAIGN_CHARACTER_MIN_SCORE,
      regard_at_least: CAMPAIGN_CHARACTER_MAX_SCORE,
      owes_player_at_least: CAMPAIGN_CHARACTER_MAX_OWED,
    });
    expect(
      SufferWoundConsequenceSchema.parse({
        type: "suffer_wound",
        wound_id: "wound:archive_fall",
        severity: 2,
        treatment: "stabilized",
        health_loss: 6,
      }),
    ).toEqual({
      type: "suffer_wound",
      wound_id: "wound:archive_fall",
      severity: 2,
      treatment: "stabilized",
      health_loss: 6,
    });
    expect(
      SetWorldFactConsequenceSchema.parse({
        type: "set_world_fact",
        fact_id: "fact:archive_preserved",
      }),
    ).toEqual({ type: "set_world_fact", fact_id: "fact:archive_preserved" });
    expect(CampaignConsequenceEffectSchema.parse(syntheticEffects()[0])).toEqual(
      syntheticEffects()[0],
    );
    expect(
      AddCompanionConsequenceSchema.parse({
        type: "add_companion",
        npc_id: "npc:synthetic_guide",
      }),
    ).toEqual({ type: "add_companion", npc_id: "npc:synthetic_guide" });
    expect(
      RemoveCompanionConsequenceSchema.parse({
        type: "remove_companion",
        npc_id: "npc:synthetic_guide",
      }),
    ).toEqual({ type: "remove_companion", npc_id: "npc:synthetic_guide" });
    expect(
      RecordPromiseConsequenceSchema.parse({
        type: "record_promise",
        promise_id: "promise:hold_the_lane",
        recipient_id: "npc:synthetic_guide",
      }),
    ).toEqual({
      type: "record_promise",
      promise_id: "promise:hold_the_lane",
      recipient_id: "npc:synthetic_guide",
    });
    expect(
      ResolvePromiseConsequenceSchema.parse({
        type: "resolve_promise",
        promise_id: "promise:hold_the_lane",
        status: "kept",
      }),
    ).toEqual({
      type: "resolve_promise",
      promise_id: "promise:hold_the_lane",
      status: "kept",
    });
  });

  it("rejects unknown effects and unknown fields on either variant", () => {
    expect(() =>
      CampaignConsequenceEffectSchema.parse({
        type: "learn_knowledge",
        knowledge_id: "knowledge:archive_route",
        confidence: 1,
      }),
    ).toThrow();
    expect(() =>
      ResolvePromiseConsequenceSchema.parse({
        type: "resolve_promise",
        promise_id: "promise:hold_the_lane",
        status: "active",
      }),
    ).toThrow(/kept, broken, or released/i);
    expect(() =>
      CampaignConsequenceEffectSchema.parse({
        type: "rewrite_character",
        character: {},
      }),
    ).toThrow();
    expect(() =>
      CampaignConsequenceEffectSchema.parse({
        type: "remember_relationship",
        npc_id: "npc:synthetic_guide",
        memory_id: "memory:shared_evidence",
        trust_delta: 100,
      }),
    ).toThrow();
    expect(() =>
      CampaignConsequenceEffectSchema.parse({
        type: "set_world_fact",
        fact_id: "fact:archive_preserved",
        value: false,
      }),
    ).toThrow();
    expect(() =>
      CampaignConsequenceEffectSchema.parse({
        type: "suffer_wound",
        wound_id: "wound:archive_fall",
        severity: 2,
        treatment: "stabilized",
        health_loss: 6,
        source: "falling_shelf",
      }),
    ).toThrow();
  });

  it.each([
    [
      "unscoped npc id",
      {
        type: "remember_relationship",
        npc_id: "guide",
        memory_id: "memory:shared_evidence",
      },
    ],
    [
      "uppercase memory id",
      {
        type: "remember_relationship",
        npc_id: "npc:synthetic_guide",
        memory_id: "Memory:shared_evidence",
      },
    ],
    ["unscoped fact id", { type: "set_world_fact", fact_id: "archive_preserved" }],
    ["unscoped knowledge id", { type: "learn_knowledge", knowledge_id: "archive_route" }],
    [
      "unscoped wound id",
      {
        type: "suffer_wound",
        wound_id: "archive_fall",
        severity: 2,
        treatment: "stabilized",
        health_loss: 6,
      },
    ],
    [
      "zero wound severity",
      {
        type: "suffer_wound",
        wound_id: "wound:archive_fall",
        severity: 0,
        treatment: "stabilized",
        health_loss: 6,
      },
    ],
    [
      "wound severity above five",
      {
        type: "suffer_wound",
        wound_id: "wound:archive_fall",
        severity: 6,
        treatment: "stabilized",
        health_loss: 6,
      },
    ],
    [
      "fractional wound severity",
      {
        type: "suffer_wound",
        wound_id: "wound:archive_fall",
        severity: 2.5,
        treatment: "stabilized",
        health_loss: 6,
      },
    ],
    [
      "unknown wound treatment",
      {
        type: "suffer_wound",
        wound_id: "wound:archive_fall",
        severity: 2,
        treatment: "healed",
        health_loss: 6,
      },
    ],
    [
      "zero wound health loss",
      {
        type: "suffer_wound",
        wound_id: "wound:archive_fall",
        severity: 2,
        treatment: "stabilized",
        health_loss: 0,
      },
    ],
    [
      "negative wound health loss",
      {
        type: "suffer_wound",
        wound_id: "wound:archive_fall",
        severity: 2,
        treatment: "stabilized",
        health_loss: -1,
      },
    ],
    [
      "fractional wound health loss",
      {
        type: "suffer_wound",
        wound_id: "wound:archive_fall",
        severity: 2,
        treatment: "stabilized",
        health_loss: 1.5,
      },
    ],
    [
      "wound health loss above bound",
      {
        type: "suffer_wound",
        wound_id: "wound:archive_fall",
        severity: 2,
        treatment: "stabilized",
        health_loss: CAMPAIGN_CHARACTER_MAX_HEALTH + 1,
      },
    ],
    [
      "trust floor below score range",
      {
        type: "remember_relationship",
        npc_id: "npc:synthetic_guide",
        memory_id: "memory:shared_evidence",
        trust_at_least: -101,
      },
    ],
    [
      "trust floor above score range",
      {
        type: "remember_relationship",
        npc_id: "npc:synthetic_guide",
        memory_id: "memory:shared_evidence",
        trust_at_least: 101,
      },
    ],
    [
      "non-integer regard floor",
      {
        type: "remember_relationship",
        npc_id: "npc:synthetic_guide",
        memory_id: "memory:shared_evidence",
        regard_at_least: 1.5,
      },
    ],
    [
      "negative owed floor",
      {
        type: "remember_relationship",
        npc_id: "npc:synthetic_guide",
        memory_id: "memory:shared_evidence",
        owes_player_at_least: -1,
      },
    ],
    [
      "owed floor above range",
      {
        type: "remember_relationship",
        npc_id: "npc:synthetic_guide",
        memory_id: "memory:shared_evidence",
        owes_player_at_least: 101,
      },
    ],
    [
      "unscoped affirmed value id",
      {
        type: "affirm_value",
        value_id: "accountability",
        strength_at_least: 1,
      },
    ],
    [
      "zero affirmed value strength",
      {
        type: "affirm_value",
        value_id: "value:accountability",
        strength_at_least: 0,
      },
    ],
    [
      "affirmed value strength above rank range",
      {
        type: "affirm_value",
        value_id: "value:accountability",
        strength_at_least: CAMPAIGN_CHARACTER_MAX_RANK + 1,
      },
    ],
    [
      "fractional affirmed value strength",
      {
        type: "affirm_value",
        value_id: "value:accountability",
        strength_at_least: 1.5,
      },
    ],
    [
      "unscoped faction id",
      {
        type: "raise_faction_standing",
        faction_id: "municipal_ledger",
        standing_at_least: 1,
      },
    ],
    [
      "zero faction standing floor",
      {
        type: "raise_faction_standing",
        faction_id: "faction:municipal_ledger",
        standing_at_least: 0,
      },
    ],
    [
      "faction standing floor above score range",
      {
        type: "raise_faction_standing",
        faction_id: "faction:municipal_ledger",
        standing_at_least: CAMPAIGN_CHARACTER_MAX_SCORE + 1,
      },
    ],
    [
      "fractional faction standing floor",
      {
        type: "raise_faction_standing",
        faction_id: "faction:municipal_ledger",
        standing_at_least: 1.5,
      },
    ],
  ] satisfies readonly [string, unknown][])(
    "rejects malformed consequence: %s",
    (_label, effect) => {
      expect(() => CampaignConsequenceEffectSchema.parse(effect)).toThrow();
    },
  );

  it("rejects duplicate semantic effects without conflating distinct memories", () => {
    expect(() =>
      CampaignConsequenceEffectsSchema.parse([
        { type: "learn_knowledge", knowledge_id: "knowledge:archive_route" },
        { type: "learn_knowledge", knowledge_id: "knowledge:archive_route" },
      ]),
    ).toThrow(/duplicate campaign consequence effect/i);

    expect(() =>
      CampaignConsequenceEffectsSchema.parse([
        {
          type: "affirm_value",
          value_id: "value:accountability",
          strength_at_least: 2,
        },
        {
          type: "affirm_value",
          value_id: "value:accountability",
          strength_at_least: 4,
        },
      ]),
    ).toThrow(/duplicate campaign consequence effect/i);

    expect(() =>
      CampaignConsequenceEffectsSchema.parse([
        {
          type: "raise_faction_standing",
          faction_id: "faction:municipal_ledger",
          standing_at_least: 20,
        },
        {
          type: "raise_faction_standing",
          faction_id: "faction:municipal_ledger",
          standing_at_least: 40,
        },
      ]),
    ).toThrow(/duplicate campaign consequence effect/i);

    expect(() =>
      CampaignConsequenceEffectsSchema.parse([
        {
          type: "suffer_wound",
          wound_id: "wound:archive_fall",
          severity: 2,
          treatment: "stabilized",
          health_loss: 6,
        },
        {
          type: "suffer_wound",
          wound_id: "wound:archive_fall",
          severity: 3,
          treatment: "untreated",
          health_loss: 9,
        },
      ]),
    ).toThrow(/duplicate campaign consequence effect/i);

    expect(() =>
      CampaignConsequenceEffectsSchema.parse([
        { type: "set_world_fact", fact_id: "fact:archive_preserved" },
        { type: "set_world_fact", fact_id: "fact:archive_preserved" },
      ]),
    ).toThrow(/duplicate campaign consequence effect/i);

    expect(() =>
      CampaignConsequenceEffectsSchema.parse([
        {
          type: "remember_relationship",
          npc_id: "npc:synthetic_guide",
          memory_id: "memory:shared_evidence",
          trust_at_least: 10,
        },
        {
          type: "remember_relationship",
          npc_id: "npc:synthetic_guide",
          memory_id: "memory:shared_evidence",
          trust_at_least: 20,
        },
      ]),
    ).toThrow(/duplicate campaign consequence effect/i);

    expect(
      CampaignConsequenceEffectsSchema.parse([
        {
          type: "remember_relationship",
          npc_id: "npc:synthetic_guide",
          memory_id: "memory:shared_evidence",
        },
        {
          type: "remember_relationship",
          npc_id: "npc:synthetic_guide",
          memory_id: "memory:returned_archive",
        },
      ]),
    ).toHaveLength(2);

    expect(() =>
      CampaignConsequenceEffectsSchema.parse([
        {
          type: "resolve_promise",
          promise_id: "promise:hold_the_lane",
          status: "kept",
        },
        {
          type: "resolve_promise",
          promise_id: "promise:hold_the_lane",
          status: "broken",
        },
      ]),
    ).toThrow(/duplicate campaign consequence effect/i);
  });

  it("uses collision-safe semantic keys for namespaced ids", () => {
    const left: CampaignConsequenceEffect = {
      type: "remember_relationship",
      npc_id: "npc:a",
      memory_id: "memory:b:c",
    };
    const right: CampaignConsequenceEffect = {
      type: "remember_relationship",
      npc_id: "npc:a:memory",
      memory_id: "b:c",
    };

    expect(campaignConsequenceEffectKey(left)).not.toBe(campaignConsequenceEffectKey(right));
  });

  it("applies every primitive to a synthetic non-quest-specific character", () => {
    const source = baseCharacter();
    const sourceBefore = cloneCampaignCharacterState(source);
    const effects = syntheticEffects();
    const effectsBefore = structuredClone(effects);
    const result = applyCampaignConsequences({ character: source, effects });

    expect(source).toEqual(sourceBefore);
    expect(effects).toEqual(effectsBefore);
    expect(result.worldFactIds).toEqual(["fact:archive_preserved"]);
    expect(result.characterAfter.knowledge).toEqual([
      "knowledge:archive_route",
      "knowledge:private_map",
    ]);
    expect(result.characterAfter.health).toEqual({ current: 18, max: 30 });
    expect(result.characterAfter.values).toEqual([
      { valueId: "value:archive_stewardship", strength: 3 },
    ]);
    expect(result.characterAfter.factionStanding).toEqual([
      { factionId: "faction:archive_collective", standing: 12 },
    ]);
    expect(result.characterAfter.wounds).toEqual([
      {
        woundId: "wound:archive_fall",
        severity: 2,
        treatment: "stabilized",
      },
    ]);
    expect(result.characterAfter.relationships).toEqual([
      {
        npcId: "npc:synthetic_archivist",
        trust: 0,
        regard: 0,
        owesPlayer: 0,
        playerOwes: 0,
        memories: ["memory:shared_evidence"],
      },
      {
        npcId: "npc:synthetic_guide",
        trust: 25,
        regard: 30,
        owesPlayer: 4,
        playerOwes: 2,
        memories: ["memory:first_met", "memory:rescued_archive"],
      },
    ]);
  });

  it("treats floors monotonically and never lowers existing relationship state", () => {
    const source = buildCampaignCharacterState({
      relationships: [
        {
          npcId: "npc:synthetic_guide",
          trust: 80,
          regard: 70,
          owesPlayer: 9,
          playerOwes: 3,
          memories: [],
        },
      ],
    });
    const result = applyCampaignConsequences({
      character: source,
      effects: [
        {
          type: "remember_relationship",
          npc_id: "npc:synthetic_guide",
          memory_id: "memory:minor_favor",
          trust_at_least: 20,
          regard_at_least: 30,
          owes_player_at_least: 2,
        },
      ],
    });

    expect(result.characterAfter.relationships[0]).toEqual({
      npcId: "npc:synthetic_guide",
      trust: 80,
      regard: 70,
      owesPlayer: 9,
      playerOwes: 3,
      memories: ["memory:minor_favor"],
    });
  });

  it("affirms values and raises faction standing as canonical replay-idempotent floors", () => {
    const source = buildCampaignCharacterState({
      values: [{ valueId: "value:stewardship", strength: 4 }],
      factionStanding: [
        { factionId: "faction:road_wardens", standing: 80 },
        { factionId: "faction:former_rivals", standing: -20 },
      ],
    });
    const sourceBefore = cloneCampaignCharacterState(source);
    const effects: CampaignConsequenceEffects = [
      {
        type: "affirm_value",
        value_id: "value:accountability",
        strength_at_least: 3,
      },
      {
        type: "affirm_value",
        value_id: "value:stewardship",
        strength_at_least: 2,
      },
      {
        type: "raise_faction_standing",
        faction_id: "faction:municipal_ledger",
        standing_at_least: 25,
      },
      {
        type: "raise_faction_standing",
        faction_id: "faction:road_wardens",
        standing_at_least: 50,
      },
      {
        type: "raise_faction_standing",
        faction_id: "faction:former_rivals",
        standing_at_least: 10,
      },
    ];

    const first = applyCampaignConsequences({ character: source, effects });
    const second = applyCampaignConsequences({ character: first.characterAfter, effects });

    expect(source).toEqual(sourceBefore);
    expect(first.characterAfter.values).toEqual([
      { valueId: "value:accountability", strength: 3 },
      { valueId: "value:stewardship", strength: 4 },
    ]);
    expect(first.characterAfter.factionStanding).toEqual([
      { factionId: "faction:former_rivals", standing: 10 },
      { factionId: "faction:municipal_ledger", standing: 25 },
      { factionId: "faction:road_wardens", standing: 80 },
    ]);
    expect(second).toEqual(first);
  });

  it("adds and removes companions and records and resolves promises idempotently", () => {
    const source = baseCharacter();
    const effects = CampaignConsequenceEffectsSchema.parse([
      { type: "add_companion", npc_id: "npc:synthetic_guide" },
      {
        type: "record_promise",
        promise_id: "promise:hold_the_lane",
        recipient_id: "npc:synthetic_guide",
      },
      {
        type: "resolve_promise",
        promise_id: "promise:hold_the_lane",
        status: "kept",
      },
    ]);

    const joined = applyCampaignConsequences({ character: source, effects });
    const replayed = applyCampaignConsequences({ character: joined.characterAfter, effects });

    expect(joined.characterAfter.companions).toEqual(["npc:synthetic_guide"]);
    expect(joined.characterAfter.promises).toEqual([
      {
        promiseId: "promise:hold_the_lane",
        recipientId: "npc:synthetic_guide",
        status: "kept",
      },
    ]);
    expect(replayed).toEqual(joined);

    const removed = applyCampaignConsequences({
      character: joined.characterAfter,
      effects: [{ type: "remove_companion", npc_id: "npc:synthetic_guide" }],
    });
    const removedAgain = applyCampaignConsequences({
      character: removed.characterAfter,
      effects: [{ type: "remove_companion", npc_id: "npc:synthetic_guide" }],
    });
    expect(removed.characterAfter.companions).toEqual([]);
    expect(removedAgain).toEqual(removed);
    expect(source.companions).toEqual([]);
    expect(source.promises).toEqual([]);
  });

  it("applies a synthetic non-Wolf wound once and floors campaign health at one", () => {
    const effect = {
      type: "suffer_wound",
      wound_id: "wound:archive_collapse",
      severity: 4,
      treatment: "untreated",
      health_loss: CAMPAIGN_CHARACTER_MAX_HEALTH,
    } as const;
    const source = buildCampaignCharacterState({ health: { current: 3, max: 30 } });

    const first = applyCampaignConsequences({ character: source, effects: [effect] });
    const replayed = applyCampaignConsequences({
      character: first.characterAfter,
      effects: [effect],
    });

    expect(first.characterAfter.health).toEqual({ current: 1, max: 30 });
    expect(first.characterAfter.wounds).toEqual([
      {
        woundId: "wound:archive_collapse",
        severity: 4,
        treatment: "untreated",
      },
    ]);
    expect(replayed).toEqual(first);
    expect(source.health.current).toBe(3);
    expect(source.wounds).toEqual([]);
  });

  it("records a wound without resurrecting a zero-health character", () => {
    const source = buildCampaignCharacterState({ health: { current: 0, max: 30 } });

    const result = applyCampaignConsequences({
      character: source,
      effects: [
        {
          type: "suffer_wound",
          wound_id: "wound:post_defeat_record",
          severity: 1,
          treatment: "stabilized",
          health_loss: 1,
        },
      ],
    });

    expect(result.characterAfter.health).toEqual({ current: 0, max: 30 });
    expect(result.characterAfter.wounds).toContainEqual({
      woundId: "wound:post_defeat_record",
      severity: 1,
      treatment: "stabilized",
    });
    expect(source.health.current).toBe(0);
    expect(source.wounds).toEqual([]);
  });

  it.each([
    [3, "stabilized"],
    [2, "treated"],
  ] as const)(
    "rejects conflicting wound identity (severity %i, treatment %s) atomically",
    (severity, treatment) => {
      const source = buildCampaignCharacterState({
        health: { current: 12, max: 30 },
        wounds: [
          {
            woundId: "wound:archive_fall",
            severity: 2,
            treatment: "stabilized",
          },
        ],
      });
      const before = cloneCampaignCharacterState(source);

      expect(() =>
        applyCampaignConsequences({
          character: source,
          effects: [
            { type: "learn_knowledge", knowledge_id: "knowledge:would_not_commit" },
            {
              type: "suffer_wound",
              wound_id: "wound:archive_fall",
              severity,
              treatment,
              health_loss: 5,
            },
          ],
        }),
      ).toThrow(/already exists with severity 2 and treatment "stabilized"/i);
      expect(source).toEqual(before);
      expect(source.knowledge).not.toContain("knowledge:would_not_commit");
      expect(source.health.current).toBe(12);
    },
  );

  it("rejects invalid promise transitions without partially applying prior effects", () => {
    const source = buildCampaignCharacterState({
      promises: [
        {
          promiseId: "promise:hold_the_lane",
          recipientId: "npc:synthetic_guide",
          status: "broken",
        },
      ],
    });
    const before = cloneCampaignCharacterState(source);

    expect(() =>
      applyCampaignConsequences({
        character: source,
        effects: [
          { type: "add_companion", npc_id: "npc:synthetic_scout" },
          {
            type: "resolve_promise",
            promise_id: "promise:hold_the_lane",
            status: "kept",
          },
        ],
      }),
    ).toThrow(/already resolved as "broken"/i);
    expect(source).toEqual(before);
    expect(source.companions).toEqual([]);

    expect(() =>
      applyCampaignConsequences({
        character: source,
        effects: [
          {
            type: "record_promise",
            promise_id: "promise:hold_the_lane",
            recipient_id: "npc:synthetic_scout",
          },
        ],
      }),
    ).toThrow(/already bound to recipient/i);
    expect(() =>
      applyCampaignConsequences({
        character: source,
        effects: [
          {
            type: "resolve_promise",
            promise_id: "promise:unknown_bond",
            status: "released",
          },
        ],
      }),
    ).toThrow(/unknown promise/i);
    expect(source).toEqual(before);
  });

  it("is idempotent when the identical outcome is replayed", () => {
    const effects = syntheticEffects();
    const first = applyCampaignConsequences({ character: baseCharacter(), effects });
    const second = applyCampaignConsequences({ character: first.characterAfter, effects });

    expect(second).toEqual(first);
    expect(deriveCampaignWorldFactIds([effects, effects])).toEqual(["fact:archive_preserved"]);
  });

  it("derives a sorted, deduplicated fact collection across outcome groups", () => {
    const first = CampaignConsequenceEffectsSchema.parse([
      { type: "set_world_fact", fact_id: "fact:zeta_recorded" },
      {
        type: "remember_relationship",
        npc_id: "npc:synthetic_guide",
        memory_id: "memory:saw_zeta",
      },
      { type: "set_world_fact", fact_id: "fact:alpha_recorded" },
    ]);
    const second = CampaignConsequenceEffectsSchema.parse([
      { type: "set_world_fact", fact_id: "fact:middle_recorded" },
      { type: "set_world_fact", fact_id: "fact:alpha_recorded" },
    ]);
    const derived = deriveCampaignWorldFactIds([first, second]);

    expect(derived).toEqual(["fact:alpha_recorded", "fact:middle_recorded", "fact:zeta_recorded"]);
    derived.push("fact:caller_mutation");
    expect(deriveCampaignWorldFactIds([first, second])).not.toContain("fact:caller_mutation");
  });

  // The integrity pass validates authored predicates once and evaluates them through
  // unchecked internals; the exported boundaries must still reject untrusted input
  // exactly as before.
  it("keeps rejecting invalid input at every exported boundary", () => {
    const character = baseCharacter();
    const invalidConditions = [
      {},
      { requires_all_companions: [] },
      { requires_all_companions: ["npc:a", "npc:a"] },
      { requires_all_companions: ["npc:a"], forbids_any_companions: ["npc:a"] },
      { requires_all_promises: [{ promise_id: "promise:x", status: "sworn" }] },
      { requires_all_companions: ["npc:a"], unknown_predicate: true },
    ];
    for (const conditions of invalidConditions) {
      expect(() => campaignCharacterMatchesConditions(character, conditions as never)).toThrow();
      expect(() =>
        campaignCharacterConditionsAreMutuallyExclusive(conditions as never, {
          requires_all_companions: ["npc:b"],
        }),
      ).toThrow();
      expect(() =>
        overworldQuestCampaignEffectsForCharacter(
          {
            ending_id: "ending_test",
            ending_title: "Test",
            effects: [],
            conditional_effects: [
              {
                id: "test:group",
                when: conditions,
                effects: [{ type: "add_companion", npc_id: "npc:a" }],
              },
            ],
          } as never,
          character,
        ),
      ).toThrow();
    }

    const duplicateFacts = [
      { type: "set_world_fact", fact_id: "fact:same" },
      { type: "set_world_fact", fact_id: "fact:same" },
    ];
    expect(() => deriveCampaignWorldFactIds([duplicateFacts as never])).toThrow(
      /Duplicate campaign consequence effect/,
    );
    expect(() =>
      deriveCampaignWorldFactIds([
        [{ type: "set_world_fact", fact_id: "not_namespaced" }] as never,
      ]),
    ).toThrow();
    expect(() => applyCampaignConsequences({ character, effects: duplicateFacts })).toThrow(
      /Duplicate campaign consequence effect/,
    );
  });

  it("rolls back the complete effect list when a later effect is invalid", () => {
    const source = baseCharacter();
    const before = cloneCampaignCharacterState(source);
    const effects: unknown[] = [
      {
        type: "remember_relationship",
        npc_id: "npc:synthetic_guide",
        memory_id: "memory:would_have_applied",
        trust_at_least: 100,
      },
      { type: "set_world_fact", fact_id: "not_namespaced" },
    ];

    expect(() => applyCampaignConsequences({ character: source, effects })).toThrow();
    expect(source).toEqual(before);
    expect(source.relationships[0]?.memories).not.toContain("memory:would_have_applied");
  });

  it("returns detached graphs even for fact-only and empty applications", () => {
    const source = baseCharacter();
    const factOnly = applyCampaignConsequences({
      character: source,
      effects: [{ type: "set_world_fact", fact_id: "fact:archive_preserved" }],
    });
    const empty = applyCampaignConsequences({ character: source, effects: [] });

    expect(factOnly.characterAfter).toEqual(source);
    expect(factOnly.characterAfter).not.toBe(source);
    expect(factOnly.characterAfter.relationships[0]).not.toBe(source.relationships[0]);
    expect(empty.characterAfter).toEqual(source);
    expect(empty.characterAfter).not.toBe(source);

    factOnly.characterAfter.relationships[0]!.memories.push("memory:caller_mutation");
    factOnly.worldFactIds.push("fact:caller_mutation");
    empty.characterAfter.health.current = 1;
    expect(source.relationships[0]?.memories).toEqual(["memory:first_met"]);
    expect(source.health.current).toBe(24);
    expect(
      applyCampaignConsequences({
        character: source,
        effects: [{ type: "set_world_fact", fact_id: "fact:archive_preserved" }],
      }).worldFactIds,
    ).toEqual(["fact:archive_preserved"]);
  });
});
