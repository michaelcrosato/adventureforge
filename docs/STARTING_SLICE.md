# Albany Winter Relief — Starting Slice Contract

Status: `active_unproven` — structural depth is proven; fleet certification is not

Scope owner: Albany fresh journey → The Wolf-Winter → truthful Albany return  
Machine-readable ledger: [`starting_slice_causal_matrix.json`](starting_slice_causal_matrix.json)

## Product promise

This slice is AdventureForge's defining demo: a compact opening that establishes
the gameplay grammar and quality bar for everything built afterward, in the way
a great standalone demo can define the finished game.

The comparison target is **greater systemic role-playing depth and reactivity
per scene than Baldur's Gate 3 inside this bounded opening footprint**. It is an
engineering and playtest criterion, not a claim about total content volume.
More rooms, towns, prose, endings, or dormant flags do not satisfy it.

A choice counts as depth only when a reachable counterfactual changes
non-presentational state and later changes at least one of:

- legal actions or solution families;
- risk, resource pressure, or encounter state;
- NPC behaviour, availability, cost, or relationship state;
- failure recovery;
- an overworld service, scene, opportunity, or persistent outcome.

The player must see truthful feedback when the change happens and when it is
consumed. A text-only variant, score-only difference, duplicate route, mandatory
pickup, unused flag, or last-line ending label does not count.

## Fixed scope

Included:

- the fresh Albany journey and player-role introduction;
- Albany's six districts, their authored discovery, and preparation;
- the roads and travel pressure immediately surrounding Wolf-Winter;
- Cade's steading and every Wolf-Winter resolution family;
- the return to Albany and its mechanically changed state.

Excluded until this milestone is certified:

- new towns;
- unrelated quest ports or new quest chains;
- broad rewrites of the other eleven shipped quests;
- world-map growth used as a substitute for local depth.

A typical blind completion of the first Albany goal must remain at or below 45
meaningful decisions. Optionality, interaction, and consequences create depth;
mandatory length does not.

The proof-hashed opening goal is “Complete Wolf-Winter in Albany.”
(`INITIAL_JOURNEY_GOAL` in `src/world/journey_contract.ts`). Shared player
guidance states the chapter boundary separately: finishing The Wolf-Winter
completes the opening, which ends the opening chapter, and the player then
chooses End to stop there or Continue to carry its results into the optional
Gallowmere chapter.

## Local canon and player role

Albany is a functioning civic and transport corridor serving hill communities
whose final miles still depend on stable yards, hand tools, and local knowledge
when winter closes roads or strands powered equipment. Rail, buses, I-90,
municipal counters, old byres, issued spears, and supernatural wildlife hazards
belong to one jurisdiction; Wolf-Winter is not a portal into an unrelated
fantasy world. The Albany relief spear is a repairable close-quarters livestock
defence tool issued to a courier, not evidence that the city ceased to be modern.

The player begins as a traveller registering under Albany's emergency relief
compact. Albany can provision and provisionally deputize that person, but the
player chooses who they were before the docket, what authority they accept, and
which promises bind them. Background is persistent lived history, not a class or
a separate game mode.

The starting cast grows from Albany's existing six district contacts and Cade:

| Character                         | Starting-slice agenda and memory                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rowan Quill — Municipal Ledger    | Wants a defensible public record; remembers certified claims, lies, and unauthorized dispatch.                                                                                                                           |
| Jamie Tanner — Merchants Exchange | Protects scarce winter stock; remembers purchases, coercion, credit, and diverted goods.                                                                                                                                 |
| Hayden Hale — Road Wardens        | Prioritizes corridor relief; remembers wagon promises and abandoned travellers.                                                                                                                                          |
| Reese Pryce — Ironhands Local     | Protects workers and the only repair shift; remembers which asset received it.                                                                                                                                           |
| Emery Sloane — Greenway Stewards  | Protects people without destroying the wildlife corridor; remembers evidence custody and needless killing.                                                                                                               |
| Blair Drake — Survey College      | Wants accurate hazard evidence published; remembers findings shared or concealed.                                                                                                                                        |
| Old Cade — hill steading          | Protects household and cattle; remembers truth, demands, promises, trespass, and violence.                                                                                                                               |
| June Pike — Road Warden ally      | Has independent cattle-first authority; she can refuse unequal terms, accept an amicable pre-HUNT release, leave after the first wolf death if retained, solve herd pressure differently, and change return opportunity. |

At least five of these people must remain mechanically relevant after
Wolf-Winter. June is the initial ally grammar; implementation may rename her
only if the replacement preserves the same authored role and agency contract.

## Honest baseline — 2026-07-14

The engine foundation is unusually strong. A 6,000-step pre-change crawl reached
247/247 overworld nodes, 344/344 edges, all 12 boards, and entered all 12 quests.
Deterministic replay, save integrity, action legality, UI/MCP projection, blind
playtest receipts, and exhaustive journey proofs already have substantial
coverage.

Wolf-Winter is the strongest existing gameplay proof:

- preparation affects three linked fights;
- a failed rail check creates a salvage route;
- Cade's finite feed now supports a fully noncombat three-encounter route and a
  bounded one-fight hybrid recovery;
- cattle alarm is a visible three-band pressure track whose threshold changes
  cattle survival, ending identity, Albany memory, and a later service;
- a risky saved-brace choice can beat or lose to the safe pin under different
  fixed rolls;
- saved wood creates an equal-score post-hunt tradeoff whose world fact now
  changes a one-time Albany service;
- Albany's dawn dispatch creates a mutually exclusive return fork between
  Jamie's Market resupply credit and Emery's Greenway rest claim;
- sixteen truthful accepted non-death outcome identities reach Albany's
  campaign presentation: eight hunt, three lure, two fortify, and three drive
  endings.

Relevant guards include
[`wolf_winter_cross_encounter_agency.test.ts`](../tests/regression/wolf_winter_cross_encounter_agency.test.ts)
and
[`wolf_winter_post_hunt_consequence.test.ts`](../tests/regression/wolf_winter_post_hunt_consequence.test.ts).

The current slice now satisfies the twelve-fork structural proof threshold, but
it is **not yet milestone-certified**:

- Wolf-Winter is now withheld from Albany's FIFO discovery and requires one of
  three certified source packets. All six Albany district jobs and all six
  district events are authored.
  Works' optional pre-Wolf hazard charter adds only its matching post-return
  shift method, and its slower cold-set line can cross the 13-standing threshold
  for a Civic recovery cot; Civic's
  first authored event fixes a public-or-protected policy before Wolf-Winter,
  then its return docket exposes exactly one lawful closure from that policy
  and the truthful held-or-evacuated outcome. Campus now requires its
  post-Wolf return-evidence mandate: choosing clinic exposure thresholds or
  traceable route provenance opens only the matching extra Archive Query
  method, while preserving the two established methods. The selected method
  records one exclusive Campus service and consolidates any overlapping
  Drover/mobile credit. Jamie's
  post-Wolf
  Market policy then binds either named household/kitchen prices or an open-bid
  ceiling and visible buyer board. From the reachable 10-standing post-policy
  state, the household fast release takes 30 minutes, earns 3 standing, and
  exposes the existing Civic cot; the open-bid fast release takes 20 minutes and
  earns 1. Their thorough settlements preserve the frontier at 75 minutes/+5
  versus 60 minutes/+4. Greenway adds a post-Wolf
  public-access-or-wildlife-corridor policy whose later survey
  exposes only the two lawful follow-ups for that exact choice. Station
  completes the event set after Wolf-Winter: Hayden binds either a quick
  operational route abstract or a slower named-witness return. Binding the
  standard does not itself close Cade's packet; the exact proof adds only its
  matching no-service administrative closure while preserving every truthful
  physical-loss dispatch. The filing event expires once any packet method is
  complete, and an unresolved investigation retains its exact journal proof
  across structural save/restore without inventing either filing choice. No generic
  district job or checklist event remains;
- Albany authors four permanent registration profiles. Road-Warden and Ledger
  sponsorship now change the actual terms of their matching source packet, and
  the Road-Warden retains its fieldcraft import. Ironhands Repairer,
  Unaffiliated Courier, and Ledger Advocate now also have distinct Repair,
  Streetwise, and Mediation preparation consumers; broader balance across all
  four completed resolution families remains unproven;
- June Pike supplies the persistent ally grammar: her visible cattle-first
  contract, subordinate-role refusal, independent Wolf action, first-wolf-death
  departure, promise state, testimony, and Station opportunity all replay
  across the Albany/quest boundary. Old Cade independently refuses Albany's
  recovery authority. Emery Sloane now supplies the third mechanically distinct
  agenda: a bloodless return permits quiet wildlife-corridor policy, while
  hybrid or full-combat bloodshed removes that legal option and opens an
  evidence-custody line with its own later survey work. The strict three-agenda
  floor is structurally proven; further independent agendas across the wider
  cast remain future depth;
- Wolf-Winter's saved-wood and clean living-pack facts now change Albany
  services, while its broken-paling, abandoned-line, and scattered-cattle facts
  feed distinct Station dispatches; broader Cade memory consumers remain future
  depth rather than an authored-Albany gap;
- fieldcraft now crosses the trusted boundary into both defence and the visible
  lure check, two certified reports alter combat routes, and three preparation
  skills change distinct checks or recoveries; campaign health remains outside
  the combat import to protect its guarantee, but the gate wound now exports
  back into persistent health and Cade's finite drive rig provides an
  origin-honest quest-local equipment pattern. The exact witnessed wound now
  opens one 45-minute Station care action that advances it from untreated to
  treated, restores 6 health up to the existing maximum, and changes which
  deep Greenway surveys are lawful without altering first-goal completion;
- prepared combat, fully noncombat diversion, bounded mixed recovery,
  drive/evacuate, and fortify/outlast now supply four distinct resolution
  families; all nineteen ledgered material forks have paired deterministic proof, while
  fleet-level strategy balance and the final numeric quality bar remain
  unproven;
- Wolf-Winter now starts through one visible, replay-bound hill-route choice
  whose exact time, supplies, fatigue, Hayden memory, quest import, first-cast
  risk, cattle pressure, ending, and return record diverge. A separate Station
  dispatch now spends Albany's last relief wagon and crew on exactly one of
  three named needs, changing the field or the truthful return. The opening
  relief oath now has paired proof for three binding terms, three different
  field consumers, unchanged failure recoveries, promise resolution, and three
  conditional return services. Preparation, relief allocation, and June now
  form an order-neutral support hub: all sixteen ordered subsets preserve legal
  launch and exact restore, timing cards fix prior selections while leaving only
  unresolved support optional, and launch persists a proof-bound selected-or-
  declined seal tied to the actual hill approach. Current v11 saves reject a
  stripped or altered seal; the sole supported structural predecessor, v10,
  upgrades without authored-copy rewriting. The
  human and CLI Station surfaces keep their established two-tier briefing:
  direct launch, one compressed selected-plan clock, and the three optional
  spoke names lead; opening a spoke shows human stakes, cost, and give-up, while
  check math, authenticated timing proof, and full consequence stay behind an
  exact read-only expansion. Compact MCP now stages those same optional spokes
  separately as described below. No action, outcome, or meaningful decision is
  removed;
- the launch-first Station follow-up preserves the existing terminal/browser
  road and support order while changing only the compact MCP hierarchy. The
  authenticated full board V6 carries the dispatch clock, all six selected/open plan rows, mapped
  support actions, and launch card; compact v49 emits
  `[6, questId, dispatchStatus, dispatch|null, rows, overview|null]`, with
  `dispatch=[state, minutes, timing|null, remainingOptionalCount]`, and retains
  canonical road detail in `quests` / `quest_starts`. It omits redundant compact
  `departure_recap`, `departure_interactions`, and `departure_contact_leads`
  only when every current action and status is exactly indexed; malformed or
  unmapped sources fall back to the established surfaces. Before review, the
  compact board omits all current `open_optional` rows and exposes one exact
  `[id, label]` read-only overview. Its label names only the support categories
  still open: specialist kits disclose their authenticated Repair, Streetwise,
  and Mediation domains; the relief wagon and cattle-first second rider appear
  only while their rows remain open. Calling
  `get_overworld_session_context` with that id records a separate durable,
  idempotent receipt; refresh and export/restore retain it, while a forged id
  fails and launch, a fully sealed support plan, or journey End clears it. After
  the canonical mutation, a pure reveal-only call returns a typed V1
  `station_dispatch_reveal` delta rather than repeating the full context. It is
  bound to the immediately retained `if_snapshot_hash` and contains that base
  hash plus the exact revealed board; the outer response carries the new
  `snapshot_hash` and `overworld_session_id` and omits `journey` / `context`.
  The player keeps the prior context, routes, `quests`, and `quest_starts`,
  replaces only the board, and adopts the outer hash. Missing or stale bases
  reject before mutation. Explicit Station-detail expansions still receive the
  complete canonical response, as do full and non-pure callers; an unexpected
  post-mutation board projection also degrades to that complete response rather
  than turning a successful receipt into an error. After
  review, the same V5 five-field optional rows and authenticated inspect/talk
  actions return in their established order. Each open row now starts its
  purpose with `Optional kit`, `Optional wagon`, or `Optional rider`, then says
  that inspection or June's talk happens before choosing; the named danger,
  one-crisis wagon boundary, one cattle-line boundary, and no-combat boundary
  remain explicit. Selected and non-actionable rows remain null/null. The shared
  authenticated dispatch briefing now separates the already-set background,
  promise, and report from support: support can be compared before a named choice
  commits, and starting Wolf-Winter declines everything still open. Its dynamic
  timing clause says exactly `all on time`, `support can delay dispatch`, or
  `already late`. The briefing appears once on the compact board; only then is
  that exact prefix removed from each compact road, so all route-specific time,
  supply, fatigue, alarm, and weather facts remain. Row staging is compact-MCP-
  only; full route cards, terminal, and browser share the same status line. The
  initial board is 578 UTF-8 bytes and its legend is 741 bytes. The pure prompt is 15,720 bytes
  and the pure catalogue is 16,773. With the unchanged 2,042-byte fresh context,
  the aggregate is 34,535 bytes, below sealed V6's 34,868 and V5's 35,207.
  First-Station prompt + catalogue + 4,921-byte context + newly delivered legend
  is 38,155 bytes versus sealed V6's 38,495, V5's 38,619, and the frozen v47/V4
  baseline 39,261. The exact current common V1 reveal fixture is 1,081 bytes;
  a natural Ledger Advocate / Aid-Only / Jamie threshold fixture is exactly
  1,098, both under the unchanged 1,100-byte regression budget. Substituting
  only the current shared briefing into the ten authenticated `e5310845` reveal
  bodies likewise serializes them at 1,083–1,098 bytes; the tested revision
  itself returned 1,090–1,099 before this correction. Those pilot substitutions
  are counterfactual exact-byte calculations, not live player responses. This
  is not a global runtime limit, and full detail-expansion
  responses are intentionally outside that narrow budget. The complete
  Road-Warden ready-dispatch response and canonical full-mode June response each
  carry the shared open status twice; replacing its old 153-byte form with the
  current 146-byte form reduces those fixtures by exactly 14
  bytes, to 9,181 and 8,916 respectively. Their fields and response shapes are
  unchanged. The receipt may change the save
  hash but accepts no gameplay or journey decision. Actions, terms, mechanics,
  costs, gameplay state/effects except that receipt, RNG, outcomes, and
  accepted-decision counts are unchanged, with
  focused proof in `station_dispatch_board.test.ts` (retired),
  `opening_dispatch_briefing.test.ts` (retired), `opening_departure_recap.test.ts` (retired),
  `overworld_cli.test.ts`, `mcp_pure_play_mode.test.ts` (retired),
  `blind_pure_prompt_contract.test.ts` (retired), `mcp_journey_surface.test.ts` (retired),
  `ui_overworld.test.ts`, and `compact_legend.test.ts`;
- the exact pure June talk authorized by a revealed V6 `field_team` row now has
  its own base-bound V1 modal transport. A non-consuming full observation first
  proves one open June talk row and no active story modal; only then does the
  server require the latest `expected_snapshot_hash`, before mutation. The
  response keeps outer `overworld_session_id` / new `snapshot_hash`, the full
  current compact `journey` including the mandatory ally `storyChoice`,
  `journeyDecision`, compact `result`, and the complete canonical
  `legend_delta` when present, then adds
  `station_dispatch_modal:{version:1,base_snapshot_hash}`. It omits raw
  `session_id` and repeated `context`. The retained context stays authoritative
  except that the new story modal supersedes its old board actions; the following
  exact ally choice remains a full canonical response and re-synchronizes
  context. Missing or stale bases reject before mutation, while an ineligible or
  unexpectedly shaped call stays canonical. The current deterministic envelope
  is exactly 3,908 UTF-8 bytes under a 4,000-byte budget. In the fresh exact-build
  pilot, the eight June responses were 71,191 bytes (seven 8,873 and one 9,080);
  replaying their exact fields through this complete-legend envelope is 31,264
  bytes, 39,927 / 56.08% less. The pure tool catalogue remains 16,773 bytes and
  every entry digest remains unchanged because no tool description or schema
  changed. All support commits, generic contacts, and full/non-pure June talks
  retain their complete canonical responses;
- four early decisions now drive replay-bound services through reusable
  world-fact, story-choice, companion, and promise predicates, but the other
  return facts still lack mechanical NPC and opportunity consumers.

The causal ledger marks all nineteen material forks as structurally proven. That
does not certify the greater-than-BG3 target: certification still requires the
current deep crawl, 100-player pure fleet, numeric thresholds, and severity
audit named below.

## Reusable foundation first

The first implementation sequence is:

1. **Campaign character state** _(foundation landed)_ — one versioned, validated
   campaign record: background, skills, values, health/wounds, equipment, money,
   abilities, knowledge, promises, crimes, NPC relationships, companions, and
   faction standing.
2. **Quest boundary contract** _(inbound and outbound foundation landed)_ —
   inject allowlisted state into an embedded quest and fold back only validated,
   explicit changes without resetting the protagonist or leaking quest-local
   objects.
3. **Data-driven consequences** _(outbound boundary and first service consumer
   landed)_ — quest content declares reusable, validated character/world
   effects; campaign code consumes generic state rather than adding
   Wolf-specific ending conditionals.
4. **Authored Albany** _(6/6 district jobs and 6/6 events converted)_ — replace
   the visible slice's generic local transactions with scenes whose evidence,
   time, relationships, resources, and promises alter Wolf-Winter and its
   return.
5. **Systemic Wolf-Winter** — combat, fully noncombat, and hybrid solutions share
   pressure state and produce truthful, mechanically distinct Albany returns.

The setting introduction must also explain the player's role and the coexistence
of contemporary New York infrastructure with the steading-scale TTRPG crisis.
That explanation must be playable context, not a lore dump.

Foundation status: campaign-character v1 now has strict canonical schemas,
deterministic cloning/serialization, overworld structural snapshot v11
persistence, a single v10 structural upgrade, full/UI read-only projection,
bounded compact projection, and tamper guards. Authored-copy changes do not
create migration branches: a world-content mismatch warns and uses current
content while identity and causal proofs remain strict. A generic quest-export catalog applies relationship
memories/floors and derives historical world facts from canonical outcome ids;
character-conditioned effects additionally resolve promises and add or remove
companions in canonical completion order.
Wolf-Winter's sixteen non-death endings create distinct Cade, Emery, and Hayden
memories plus byre/gate/timber/wolf/cattle/property/relief-stock facts; restore replays the character result,
rejects forged outcome/journal/state combinations, and validates the result
against the current manifest. Generic campaign service rules can now consume
those trusted facts or canonical story choices at an authored town and area,
project an optional same-district named provider, expose bounded one-time terms,
and bind consumption to replayed journal evidence across save/restore.

The trusted inbound boundary is also landed. Quest manifests declare strict,
pack-validated import rules; only the private overworld bridge supplies detached
campaign state; material imports occur before the opening observation and carry
a canonical receipt through save/hash/trace replay; public/direct starts remain
pack-default; and UI/MCP reset determinism is proven. Imported-only flags and
items participate in source validation, every catalog retains an
import-independent structural victory, and health imports are prohibited on a
`combat_guaranteed` pack until an authored minimum/recovery contract exists.
Wolf-Winter therefore maps `skill:fieldcraft` to its defence floor and its
publicly visible lure check, and maps the two exclusive Albany reports to
authored quest-local flags. The tempting Albany-kit
→ steading-brace alias remains rejected because it would lie about where saved
timber came from.

The first authored Albany increment is now landed. Speaking with Rowan after
the first civic lead writes a durable registration offer rather than relying on
an initial modal. The player chooses one of four complete canonical packages;
the choice survives save/restore, changes Rowan and the selected sponsor's
memory-conditioned responses, and crosses the private quest bridge. The
Road-Warden's Fieldcraft 4 raises Wolf-Winter's visible starting DEF from 3 to 4. With the same d20 roll of 7 at the broken paling, that profile braces the
rail while a Ledger Advocate at default DEF 3 splits it and receives the
authored bind-the-rail recovery action. Direct quest starts remain exact pack
defaults. Paired proof lives in
`character_background_counterfactual.test.ts` (retired in the 2026-09-23 suite halving).

The return now closes the selected background's opening obligation as carefully
as it closes the later relief oath. Every supported non-death Wolf-Winter
outcome marks the Road-Warden's honest Hayden packet, Ledger Advocate's truthful
account, Ironhands Repairer's borrowed tools, or Unaffiliated Courier's emergency
tag `kept` only when that exact active promise exists. The other backgrounds'
promises are never invented, unrelated quest completions leave the obligation
active, and the foldback adds no action or decision. Full, compact, and UI
character views expose the closed promise; replay and save/restore remain
idempotent. The ordinary terminal completion and bounded compact MCP result also
return one immediate authenticated receipt. It binds the selected profile,
relief term, lead source, quest-start approach, canonical ending, exact world
facts, and—when Reese's loan is involved—the authored 100/100 repair-roll
snapshot. Rowan accepts the Courier's returned tag under Emery's witness, while
lawful authority makes Rowan publicly void it. Restore rederives that receipt
from the complete current dispatch chain and rejects missing, swapped, or
unrelated proof. A content-hash mismatch is reported as provenance and never
grants a receipt or rewrites the promise; repeated structural restore remains
idempotent. Exhaustive four-background by eleven-ending proof, planner
fail-closed checks, terminal/MCP bounds, and replay coverage live in
[`registration_promise_return_counterfactual.test.ts`](../tests/starting_slice/registration_promise_return_counterfactual.test.ts)
and [`world_session_snapshot.test.ts`](../tests/unit/world_session_snapshot.test.ts).

The second authored Albany increment replaces Wolf-Winter's FIFO reveal with a
blocking, irreversible source certification. Rowan's public docket costs no
time or money and preserves the established routes. Jamie Tanner's testimony
costs 35 minutes and $6, reduced to 15 minutes and $0 by Ledger sponsorship. Without
committing Cade's finite feed plan, it alone opens the feed-hauler crawlboard as a
rail-free combat drop after the yearling falls. Cade can independently teach the same
physical board only as the second cast of his irreversible nonlethal plan; that local
instruction neither imports Jamie's evidence nor grants Jamie's combat opening. Hayden
Hale's report costs 20 minutes, reduced to 5 by
Road-Warden sponsorship; after a failed rail check it alone rewards leaving the
split rail unbound with an exposed high-variance frost-brace sequence. The
selection persists through save/restore. Each private report also changes its
source NPC's memory, crosses the trusted quest boundary, and is named at its
consumer; Rowan preserves the import-independent routes. Paired proof lives in
[`lead_source_counterfactual.test.ts`](../tests/starting_slice/lead_source_counterfactual.test.ts).

The informed-dispatch follow-up keeps that causal structure while removing a
blind planning interval exposed by the first authenticated fleet diagnostic.
Before registration binds, the journey surface reuses Wolf-Winter's authored
discovery as a concrete mission preview and names the three binding Civic
decisions—role, duty, and evidence—plus two later optional Station interactions:
preparation and relief allocation. Each Civic prompt identifies the completed
and still-open decisions; after source certification, Hayden's departure board
offers pull-based inspection of preparation, then allocation if preparation is
chosen, alongside both already-legal hill launches. June Pike remains a separate
optional field-team follow-up. Source certification reveals the real quest card
and a compact, authored cost/tradeoff comparison of both hill approaches; full
tactical route detail remains on the actual launch choice. Neither Station
interaction gates departure, and leaving without choosing invents no proof or
effect. A structurally supported save carrying a still-valid pending offer
remains finishable, while a resolved save with the discovery removed remains
invalid.
Presentation and state proof live in
`opening_dispatch_briefing.test.ts` (retired in the 2026-09-23 suite halving),
[`lead_source_counterfactual.test.ts`](../tests/starting_slice/lead_source_counterfactual.test.ts),
and
[`overworld_optional_departure_interactions.test.ts`](../tests/regression/overworld_optional_departure_interactions.test.ts).

The comparison-first follow-up keeps all six irreversible Albany decisions
truthful while reducing compulsory presentation load. Registration, Relief
Oath, Lead Source, Preparation, June, and Relief Allocation now share four
visible fields: commitment, field trigger, immediate cost, and tradeoff. Compact
active choices stage the long exact consequence for pull-based inspection of
one option; the canonical full view and human UI retain complete terms. Reads
do not mutate the snapshot, inspecting a choice does not change its result, and
siblings' complete terms are not repeated in a selected-detail response. The
Station departure card also stops repeating Wolf-Winter discovery and both
route previews immediately before the canonical launch card.

On the exact recent Road-Warden path, the six always-visible story payloads fall
from 4,191 to 3,558 `o200k_base` tokens (15.1%). Including the one Drover detail
inspection observed on that path, the comparable total falls from 4,992 to
4,308 (13.7%). This is a presentation saving rather than a game simplification:
legal choices, state transitions, delayed consumers, and decision counts are
unchanged. Presentation-only content revisions do not create a save migration;
structurally compatible state restores against current content with an explicit
provenance warning, after ordinary replay and integrity checks. Contract proof lives in
[`compact_journey_projection.test.ts`](../tests/unit/compact_journey_projection.test.ts),
`mcp_journey_surface.test.ts` (retired in the 2026-09-23 suite halving), and
[`world_session_snapshot.test.ts`](../tests/unit/world_session_snapshot.test.ts).

The first narrative-first selected-receipt follow-up left that disclosure
boundary intact. Its valid ten-player pilot put every player through the same
Road-Warden and ready-made Aid-Only/Hayden setup before four different
Wolf-Winter strategies, yet every report still described front-loaded Albany
terminology and the cohort missed clarity, enjoyment, and initial-goal
continuation. That correction led with the plain defense result and explained
the later plan benefits before their `LURE` and `HUNT` aliases, but deliberately
kept the complete Aid-Only and Hayden branch sequence in the selected receipt;
it added no progressive-disclosure flow.

The fresh exact-build follow-up on `360ada1e` completed Wolf-Winter 10/10 with
no stuck run and passed continuation and strategy-distribution gates, but still
missed clarity at 39/50 and enjoyment at 40/50. Seven players selected the exact
ready-made Road-Warden receipt. One filed a direct S1 against its premature plan
aliases and branch conditions; the cohort's only 3/5 clarity player also saw
that receipt, skipped Station support review, and still named route/support/
conditional-plan terminology as the worst moment. The selected preview now
keeps only defense 4, the Aid-Only clean/foul boundary, and Hayden's relevance
to holding Cade's ground. The byte-identical inspected card still carries the
exact 132-character benefit, and Wolf-Winter still states the public brace,
frost split, unbound rail, yearling, bare-spear, and Works exclusions at the
steading before commitment. The preview falls from 432 to 286 ASCII bytes and
the authenticated ready-dispatch counterfactual from 9,181 to 9,035 bytes under
the unchanged 9,250-byte cap. No glossary, choice, mechanic, route, support,
strategy, outcome, or decision changes; these are deterministic boundary
witnesses, not evidence of a rating or human-quality lift.

The following exact-build pilot diversified that opening into six Road-Wardens
and four Ledger Advocates while preserving 10/10 Wolf-Winter completion, all
four strategies, and clean Albany foldback, but it again missed clarity,
enjoyment, and initial-goal continuation. Every player opened the same Station
support reveal once; nine reports explicitly named Station, dispatch, or linked
setup density, while the remaining report named broader comparison and compact
density. The hidden V6 overview already kept Road-Wardens out of unmatched kit
comparisons—none of six chose a kit, while all four Mediation-aligned Ledger
Advocates did—so that overview and its Repair/Streetwise/Mediation scent remain
byte-identical. Only the three post-reveal purpose cells now lead with the plain
optional category and make the read-before-commit boundary explicit. Board
shape/version, receipt/modal envelopes, ids, actions, support breadth, costs,
checks, effects, roads, strategies, outcomes, Continue/End, and Gallowmere are
unchanged; this failed AI pilot diagnoses the copy target without validating
the replacement or constituting human research.

The adjacent-plan-recall follow-up keeps that summary-first boundary while
removing the remaining cross-screen memory test at Albany Station. Every
Preparation, Relief Allocation, and June comparison now carries the same
journal-authenticated title/status/timing recap as its surrounding launch
surface. Compact MCP inspection repeats only that bounded recap with its
unchanged receipt; terminal inspection prints it immediately before the
comparison, and the browser already renders it before the option cards. Exact
active terms remain an explicit read-only expansion, alternatives never leak,
and inspection changes no snapshot, hash, clock, or decision.

The cumulative-review follow-up makes that one-option expansion sufficient for
an optional Station decision. Its visible `reviewOption` action returns the
candidate consequence and timing beside the authenticated departure terms
already selected, avoiding a separate recap/context read. It remains read-only,
shows no sibling's full terms, and neither recommends a route nor requires
reviewing every candidate.

The embedded launch handoff then makes the Station-to-field transition explicit
without flattening it. A compact Wolf-Winter start names `Albany Station -> The
Wolf-Winter`, the accepted road, the imported or declined preparation, and the
actionable child state. Its accepted receipt retains the chosen route instead of
repeating the rejected route or a duplicate parent context; the full parent
journey remains pullable through its unchanged session handle. This launch-only
suppression is Wolf-Winter-specific; compact starts for other embedded quests
retain their established parent context and receipt. Active compact
quest turns carry a small parent focus—goal, status, accepted-decision count,
next checkpoint, and explicit `pendingChoice: null`—then carry the complete
Continue/End prompt or compact staged story-choice surface only when that blocker
is actually due. Character continuity appears at launch and at genuine restore
or resume boundaries; an explicit `get_observation` recovery read can request
it, while ordinary turns omit the repeated continuity recap and quest-profile
projection. Its compact scope note states that quest stats and kit are local
and that quest HP does not reduce or replace campaign health.
Cade's Byre-Yard arrival copy now points directly to his optional HUNT, LURE,
DRIVE, and FORTIFY comparison before commitment, without adding a seventh
Albany decision or forcing a strategy choice. On the same restored compact
launch fixture, the launch response falls from 11,044 to 6,724 UTF-8 JSON bytes
(39.1%) and the first field turn from 3,909 to 2,194 bytes (43.9%); actions,
state hashes, pressure, vitals, inventory, consequences, RNG, decisions,
foldback, and truthful parent return remain unchanged.

The current first Cade menu now explains the boundary in ordinary player
language: asking about a plan does not choose it, preparation helps without
choosing, HUNT begins only on the north crossing or an offered `RELEASE JUNE`,
and the other plans begin only when explicitly chosen. Choosing any plan still
closes the rest. Its four peer labels now share the visible `Goal`, `Cost`,
`Help`, and ask-only choice-boundary grammar. HUNT names the home/herd/stores,
wolf-death and cattle/outer-defense risk, Cade lessons plus jerkin, and its
north / `RELEASE JUNE` choice. LURE and DRIVE state that the wolves live and
name Fieldcraft; DRIVE also states its no-retreat boundary. FORTIFY states the
same living-wolf outcome, its no-retreat boundary, property exposure for Cade
aid or public-seal spend, and Repair. The card deliberately does not guarantee
Cade aid; the opt-in details retain its exact predicates. The stable HUNT,
LURE, DRIVE, and FORTIFY ids and aliases remain unchanged. LURE, DRIVE, and
FORTIFY use the exact same label at the first menu and after either support
lesson. The opt-in plan bodies, ground/oath/preparation/June variants, final
commitment actions, back/leave actions, and support actions retain their
detailed terms.

The base explanation is exactly 231 ASCII bytes. With the unchanged four
seeded-ground suffixes, complete first-root scorecards remain 343/340/343/336
characters (345/342/345/338 UTF-8 bytes), below the existing 360-character
boundary. Rendered `ask: ` commands are HUNT 158, LURE 151, DRIVE 159, and
FORTIFY 151 characters (160/153/161/153 UTF-8 bytes) under the unchanged
160-character MCP limit. In the fixed seed-541 open-ash witness, the complete
full observation is 5,177 UTF-8 JSON bytes, its compact projection is 2,599,
the compact choice array is 978, and the exact 193-character terminal LURE line
is 197 bytes. The exact compiled Wolf-Winter hash is now `08ddb7ce`; its
reviewed relabeled twin is `fe16b368`. These are deterministic projection
measurements, not global response limits or new player evidence.

The stage-purpose follow-up keeps those six Albany comparisons intact while
making the current commitment explicit in the vocabulary the cards already use.
Registration, duty, evidence, preparation, relief priority, and June's
field-team prompt each state what is being chosen and which adjacent decision
remains open or separate. June's prompt names the authored
`Leave with a Solo Field Team` choice instead of implying that an active story
choice can be dismissed. Route costs and tactics remain on Wolf-Winter's launch
card. This is a read-only terminal, full/compact MCP, and UI projection:
choices, action ids, exact terms, state, mechanics, RNG, saves, hashes, delayed
consumers, and outcomes are unchanged.

The role-actionable outcome-compass follow-up keeps the four-route comparison
without making it a compulsory read. After a registered role is chosen, its one
matched duty-and-evidence shortcut is immediately actionable; choosing it still
records exactly the same oath and source decisions, costs, promises, field
imports, and journal proof as the equivalent manual path. `Customize duty and
evidence` opens the read-only comparison and all three ordinary duties; evidence
then follows only for a manually chosen duty. HUNT, LURE, DRIVE, and FORTIFY each
lead with the people, herd, stores, home, or living pack they try to preserve and
pair that aim with their actual death, feed, cattle, line, wound, rig, property,
or public-seal risk. No route is recommended or committed.

Terminal, browser, and compact MCP use the same boundary. The canonical prompt
retains every legal choice, while the initial compact surface contains only the
matched shortcut and the Customize affordance. Opening Customize changes no
snapshot, clock, journal, RNG, or accepted-decision count. Compact MCP keeps an
exact-session presentation receipt: the shortcut is authorized immediately,
but a hidden ordinary duty cannot be inspected or chosen before the exact
reveal. The developer-only `compact_result:false` read may return the canonical
prompt for structural QA without authorizing hidden choices. The receipt is
part of the exported snapshot and hash and survives restore, so the same state
has the same legal options on every transport. The established reveal id,
canonical option order, terminal `customize` alias, and numeric mappings remain
stable; legal choices and durable gameplay are unchanged.

Restore is deliberately fail-closed at this causal boundary. A progressed
post-registration suffix without its replayable source proof is rejected rather
than falsely certified as source-free: mutable state cannot prove that a
zero-effect source decision was not deleted before an otherwise plausible later
action. Opaque pre-registration quest progress is likewise rejected because it
has no replayable registration-and-source path and would otherwise load into an
unwinnable starting-slice goal. A content-hash warning never relaxes those proofs.

The third authored increment makes Wolf-Winter's equal-score timber decision
matter after the return. Carrying sound guard wood into dawn returns Hayden's
unused repair-wagon stores for a one-time 15-minute Station Quarter resupply;
committing that wood to the cattle gate releases a one-time 15-minute Road
Warden rest cot instead. The alternative remains the ordinary 45-minute
resupply or 180-minute minimum rest. Full, compact, and UI views state the cause
and terms before use; a rule-and-area journal proof consumes the offer through
save/restore. Paired reachable states prove that neither branch dominates:
retained timber wins when supplies are low, while the barred gate wins after
identical road strain creates fatigue. Proof lives in
[`saved_wood_world_state_counterfactual.test.ts`](../tests/starting_slice/saved_wood_world_state_counterfactual.test.ts).

The fourth authored increment makes Albany's post-Wolf allocation mechanically
real. Sending the only dawn wagon back to Cade leaves the player carrying
Hedrick's packet alone and causes Jamie Tanner to hold a one-time Market
road-store credit: a 15-minute resupply instead of 45. Sending the wagon and
wardens north causes Emery Sloane to hold a mutually exclusive Greenway
watch-shelter claim: a 15-minute rest instead of 180. Both terms are visible
before commitment; the selected goal remains their trusted source even after it
moves into goal history. Full, compact, UI, structural save/restore, and causal
replay proofs reject contradictory branches or retroactive service use. The
paired runs visit all six Albany districts, use the same Wolf-Winter strategy
and ending, and differ only at the dispatch. Proof lives in
[`albany_return_counterfactual.test.ts`](../tests/starting_slice/albany_return_counterfactual.test.ts).

The fifth authored increment removes the mandatory three-kill path. Cade gives
a free explanation before a separate, explicit commitment of one finite
winter-feed sack across the paling, loft, and outer scent gate. A reusable
`pressure_tracks` authoring primitive projects the ordinary `cattle_alarm`
variable as Steady, Restless, or
Breaking in full MCP, compact MCP, and the browser. A clean route leaves every
wolf alive and the herd whole. A failed first cast cannot repeat: spending a
failed split rail preserves the noncombat route but loses two cattle, while
fighting only the yearling creates a truthful mixed ending with the other two
wolves alive and the same cattle loss. Each identity has distinct Cade/Emery
memory and world facts; only the all-alive, whole-herd return unlocks Emery's
one-time Greenway nonlethal-response cache. Same-character/source/seed paired
proof, RPG save/replay, journey foldback, compact/full/UI parity, overworld
restore, and service consumption live in
[`wolf_strategy_return_e2e.test.ts`](../tests/starting_slice/wolf_strategy_return_e2e.test.ts).

The combat route now has one costly, state-specific failure-forward exit rather
than forcing a wounded player through old grey or into death. After both younger
wolves are dead, at 12 health or less, and before committing to any old-grey
maneuver, the player may evacuate Cade and every rider through the rear cattle
door. This is not a combat victory or a strategy reset: old grey remains in the
abandoned byre, two cattle go missing, the outer line is lost, and the journey
returns that exact account to Albany. HP 13, either younger wolf still living,
any redirected/defeated leader state, a committed lure/drive/fortification, or
any old-grey maneuver withholds the exit. Quest legality, terminal replay,
campaign facts and memories, June's broken cattle-first agreement when retained
(or her intact amicable release when released before HUNT), Albany dawn
dispatch, and save/restore are proved by
[`wolf_winter_bloodied_byre_evacuation.test.ts`](../tests/regression/wolf_winter_bloodied_byre_evacuation.test.ts)
and
[`bloodied_byre_evacuation_return_e2e.test.ts` (retired)](../tests/starting_slice/bloodied_byre_evacuation_return_e2e.test.ts).

The sixth authored increment makes Albany preparation a durable, finite choice
instead of a promise in the matrix. After source certification, every one of the
four backgrounds can select any of three affordable specialist packets. The
expanded terms derive each character's current matching skill modifier and d20
success range from generic profile data without crowding the initial comparison.
Reese's Works sequence replaces the public paling wedge with a Repair check and
turns a miss into a noisy deterministic cold-set. Emery's drover route creates
one shared Streetwise recovery after a failed first lure cast or DRIVE shutter.
On the lure it can turn the yearling and lower cattle alarm; on DRIVE it can
remove the failed shutter's extra pack-pressure beat while the loose hurdle
remains mandatory. A miss spends the route. Unrecovered DRIVE pressure reaches
Overrun after the final signal and requires a persistent -2 HP swing-gate brace
before the unchanged three crisis priorities become legal. Jamie's relief
protocol creates a one-shot Mediation pressure adjustment only after the public
split-rail recovery. The three plans import as knowledge plus their actual
background skill, remember their providers, retain direct-start defaults, and
do not add or relabel an ending. On a truthful held-byre return they respectively
unlock one 15-minute Works resupply, Campus rest, or Civic resupply. Paired
reachable low-supply and fatigue states include preparation cost, shortest
Albany relocation, and both alternatives' best matching service; each plan
beats both others somewhere and none dominates globally. The irreversible
choice is replay-locked for all profiles. The representative Drover route
proves overworld restore, RPG save/replay, quest foldback, full/compact MCP,
and browser-engine parity; paired core proofs cover all three consumers and
return services. Proof lives in
[`preparation_profiles_counterfactual.test.ts`](../tests/starting_slice/preparation_profiles_counterfactual.test.ts)
and
[`preparation_profiles_return_e2e.test.ts` (retired)](../tests/starting_slice/preparation_profiles_return_e2e.test.ts).

The seventh authored increment makes June Pike a persistent ally rather than a
proposed cast note. After preparation, the Station Quarter presents three exact
terms: spend 15 minutes and grant June cattle-first authority, spend 5 minutes
asking for a subordinate relay that she refuses, or leave solo without delay.
Direct departure without contacting her also stays truthfully solo. The accepted
contract records June as a companion plus an active promise and imports only
that state into Wolf-Winter. Before June permits an uncommitted crossing into
the paling, she holds the north gate and states that Cade's ordinary rail is a
hunt-and-hold combat funnel whose first wolf death ends her agreement. Keeping the
cattle-first terms leaves lure, drive, and fortification available; explicit
acknowledgement opens the disclosed uncommitted crossing, while living commitments
remain available until crossing. If a committed lure's one
feed cast fouls, either a successful brace turned into a scent-pen or the
existing failed-rail bind recovery redirects the yearling alive with distinct
provenance. The ordinary rail remains combat-only. A first spear strike after
the fouled lure irreversibly commits the hybrid line and retires every living
recovery; June's agreement breaks only when the wolf dies. On a living recovery, June's
named legal conversation blocks the final cast until she refuses the old-grey
line, independently takes the lower cattle rail, and lowers cattle alarm by 1.
That changes the identical route from a scattered herd to a whole-herd return.
Her already-paid authority has two more pressure-specific consumers. A failed
DRIVE signal that reaches Overrun uses June's lower swing-gate instead of the
solo rider's persistent 2 HP brace; a clean signal gains nothing. An
unstabilized failed FORTIFY seal reaches Strained pressure 3 at the dawn watch.
June's lower cattle brace absorbs that persistent 2 HP strain without lowering
pressure or changing the stance ending, while solo or broken-June routes pay
it. A clean pressure-2 line already costs no HP. A mobile-stabilized line also
costs no HP and gains no extra June benefit, including when delayed dispatch
leaves its displayed pressure at 3. The opening terms and field dialogue
disclose both conditions before their resolution actions.
At that same pre-HUNT boundary, the player can instead release June amicably and
commit HUNT immediately. This preserves the relationship but closes LURE, DRIVE,
and FORTIFY at once, removes June's later lure, drive, and fortify interventions,
and grants no combat or cattle bonus. Ordinary yard preparation, Cade's two HUNT
lessons, store gear, and backtracking remain. The bloodied evacuation plus the
three held-byre resource outcomes retain their exact non-June
consequences and tactical ending reactivity under four explicit release ending
identities. Albany then records the cattle-first promise
`released`, removes June from the party, preserves her distinct amicable
testimony, and offers no kept-companion service. Retaining June through the
crossing keeps the original first-death breakage instead. The release boundary,
all four HUNT consequences, save/restore, intervention loss, export truth, and
content-revision warning behavior are proven in
[`june_hunt_release_counterfactual.test.ts`](../tests/starting_slice/june_hunt_release_counterfactual.test.ts)
and [`world_session_snapshot.test.ts`](../tests/unit/world_session_snapshot.test.ts).
The first wolf death removes the action but preserves hybrid/combat completion, then
resolves the promise broken and June out of the party. Clean cooperation,
negotiated refusal, explicit solo, and relationship loss produce distinct
memories, Station testimony, and one-time service availability. Companion and
promise state, chronological quest replay, RPG import receipts, overworld and
RPG save/restore, and full/compact/UI parity are tamper-checked. Proof lives in
`ally_commitment_counterfactual.test.ts` (retired in the 2026-09-23 suite halving)
and
`ally_content_gameplay.test.ts` (retired in the 2026-09-23 suite halving),
with the paired rail proof in
`wolf_strategy_counterfactual.test.ts` (retired in the 2026-09-23 suite halving).

Compact v29 adds a read-only `departure_contact_leads` tuple beside the existing
pull-based departure choices. Before preparation it names June's optional field
team and the remaining prerequisite without exposing an invalid action; after
preparation the same lead names the exact contact and talk action. Either state
keeps immediate solo launch visibly legal and changes no snapshot or decision.
The full view, MCP/pure prompt, browser, and overworld CLI consume that same
derived lead. Compact v29 retains v28's separation of current town actions from
authored one-time terms.
`service_actions` is the canonical planner-backed care/rest/resupply surface: each
entry carries availability, ordinary or campaign-override provenance, exact
minutes, and supplies/fatigue before and after. `service_offers` remains the
matching authored terms surface and never adds a duplicate action. Actions are
omitted while a road encounter, journey checkpoint, ending, or mandatory story
choice pauses ordinary gameplay; no-op actions remain available with zero cost.
The full view, compact/MCP context, and UI consume the same projection.

The eighth authored increment adds `drive_and_evacuate` as a complete third
resolution family rather than renaming the failed-lure hybrid. Cade first
explains, then takes an explicit mutually exclusive commitment to a finite
two-charge signal-and-rope plan. Its preview discloses that committing starts
the moving herd immediately: preparation and the outer yard close behind the
player, and the route can no longer switch to lure or spear combat. The player
also knowingly forfeits the steading's outer defense line on every completion
so the moving herd and pack can separate. The player turns the yearling at the
broken paling and the flank wolf at the byre door while the visible Pack Drive
track advances. A missed opening cannot be retried: it reaches Crisis early and
opens one authored loose-hurdle recovery. At the byre mouth, the player must choose
one irreversible priority before the only matching evacuation becomes legal:
keep the whole herd and returned rig by taking an untreated gate wound, save
every person and return the rig while two cattle scatter, or keep people and
the whole herd unharmed by sacrificing the rig. All three drive the living pack
away bloodlessly. June, when present, first exercises her remembered
cattle-first authority at the lower gate. A failed first signal otherwise leaves
Pack Drive at Overrun and forces a persistent -2 HP swing-gate brace; June's line
absorbs only that extra beat and returns pressure to Crisis without the injury. A
clean signal is already at Crisis and gains no extra reduction. The hard commitment withholds every
enemy and combat action before the first signal, through failed-signal recovery,
and at the threshold. The ordinary spear route remains available only when the
player declines the drive before the cattle move, so combat cannot be sampled
and folded back into a bloodless ending.

The three endings export distinct cattle, wound, and reserve facts. The wound
crosses into persistent campaign health and remains untreated through ordinary
rest and resupply. Cade's exact witness memory and the wound's exact untreated
state open one 45-minute Station care action: it restores 6 health up to the
existing maximum and advances only that wound to treated, spending no supplies
and changing no fatigue. Returned-rig and whole-herd facts independently gate
the established one-time Station rest and Greenway resupply offers.
June and Emery retain outcome-specific testimony. Same-boundary proofs vary
only the ending and preserve those differences through chronological journey
foldback, structural snapshot integrity, full/compact MCP, UI, and
service consumption. Proof lives in
[`crisis_priority_counterfactual.test.ts`](../tests/starting_slice/crisis_priority_counterfactual.test.ts)
and
`drive_crisis_return_counterfactual.test.ts` (retired in the 2026-09-23 suite halving),
with the persistent care and downstream-action proof in
[`wolf_wound_care_counterfactual.test.ts`](../tests/starting_slice/wolf_wound_care_counterfactual.test.ts).

The ninth authored increment completes `fortify_and_outlast` and rewrites
`SS-F08-cade-trust` as an honest conduct fork. Cade discloses two mutually
exclusive stances before commitment: accept his household boundary and take two
shutters with his failed-seal help, or invoke lawful Albany authority and take
finite public relief seals while he refuses that recovery. The commitment
closes lure, drive, preparation, retreat, and combat. A visible Winter Siege
track then advances through an outer repair and a separate threshold seal. The
outer Repair check is one-shot: a miss raises pressure and opens only the
stance-specific deterministic recovery, never an identical retry. June, when
present, independently holds the lower cattle brace without erasing or changing
the siege pressure. At the dawn boundary, a failed unstabilized line at pressure
3 costs the solo or broken-June rider 2 persistent HP; intact June absorbs that
strain under the cattle-first authority already paid for. A clean pressure-2
line costs neither route HP. A mobile-stabilized line also costs no HP and
creates no synthetic June benefit, even when delayed dispatch leaves it at
displayed pressure 3. Both counterfactuals retain the same legal dawn action,
pressure-6 completion, stance ending, living wolves, and whole herd.

Cade's route truthfully leaves outer property exposed and returns Albany's
public seals unused; the authority route protects that property by spending the
public seals and records Cade's refusal. Two endings export those facts into
distinct Cade, Hayden, and June memories, every Albany dawn dispatch preserves
the selected cost, and Hayden offers a mutually exclusive Station resupply or
rest. Best/worst repair, solo/June, RPG save/replay, chronological foldback,
full/compact/browser parity, structural save/restore, and one-use service
consumption are covered by
[`cade_trust_counterfactual.test.ts`](../tests/starting_slice/cade_trust_counterfactual.test.ts)
and
[`fortify_outlast_return_e2e.test.ts` (retired)](../tests/starting_slice/fortify_outlast_return_e2e.test.ts).

The tenth authored increment turns `SS-F07-hill-route` into the actual
Wolf-Winter launch instead of adding a detached travel menu. Hayden's Station
Quarter dispatch presents two exact commitments on the quest card. The exposed
ridge costs 30 minutes, one supply, and 25 fatigue. Its open crest reveals the
crosswind, lowering the first feed cast to DC 10, but the visible descent starts
cattle alarm at 1. The sheltered stockway costs 75 minutes, two supplies, and
10 fatigue. Its lee keeps the herd calm at arrival but conceals the crosswind,
leaving the first cast at DC 12. Both cards disclose actual cost, projected
arrival time, remaining supplies, resulting fatigue/condition, known field
effect, and any blocked reason before commitment.

Choosing either card is the quest-start decision itself. A generic atomic
launch contract prepares the route's resource and campaign-character effects,
boots the embedded RPG from that post-choice state, and only then commits one
route-qualified journey action. Exactly one route knowledge and Hayden memory
persist; the generic campaign import catalog produces exactly one quest flag
and one legal last-mile action. Direct structural starts retain the old neutral
entry, while contradictory route flags fail closed. The route action replaces
the old first local movement input, so it adds systemic optionality without
raising first-goal length.

The human UI and pure MCP share that session-owned launch. MCP names the normal
player bridge `start_overworld_session_quest`; compact `context.quest_starts`
lists its exact currently executable quest-and-approach tuples. `start_world_quest`
bypasses that state and remains a structural QA drop-in, never a pure-play action.

At seed 9 the ridge's DC 10 cast succeeds while the stockway's DC 12 cast fails
and enters the authored no-retry split-rail recovery, proving the faster route's
advantage. At seed 26 both casts succeed, but the ridge's clean three-cast line
reaches alarm 4 and scatters two cattle while the stockway reaches alarm 3 and
keeps the whole herd, proving the sheltered route's advantage. Launch costs,
proof boundary, relationship memory, import receipt, outcome, and exact return
summary survive RPG/overworld replay, chronological foldback, full/compact MCP,
browser and CLI parity, and structural v11 save/restore with the v10 upgrade.
Proof lives in
`hill_approach_gameplay.test.ts` (retired in the 2026-09-23 suite halving),
[`hill_approach_return_e2e.test.ts`](../tests/starting_slice/hill_approach_return_e2e.test.ts),
and [`world_session_snapshot.test.ts`](../tests/unit/world_session_snapshot.test.ts).

The eleventh authored increment turns `SS-F06-relief-allocation` into a finite
public-capacity decision rather than a decorative reserve meter. At the Station
Quarter, preparation is a pull-based interaction beside the legal hill launches;
choosing it exposes allocation as a second optional interaction. The player may
inspect either without mutation, select preparation only, select both, or depart
with neither. Albany has one unassigned winter-relief wagon and crew. Every
allocation option costs five minutes, and every card names both what it protects
and the two needs left exposed: send Emery's fodder and drovers to Cade's herd,
keep Jamie's Market warm room staffed for vulnerable residents, or hold Hayden's
wagon as a mobile failure crew. A selection, once made, is irreversible and
mutually exclusive; it records one allocation knowledge, one provider memory,
one journey decision, and no invented stock meter. Skipping it records none.

Each allocation has a different delayed consumer. Cade's pre-feed changes only
a successful first lure cast from the exposed ridge: at seed 26 it suppresses
one ordinary cattle-alarm step, reaching alarm 3 and the whole-herd ending where
the identical resident allocation reaches alarm 4 and scatters two cattle. It
does not create feed, a retry, or protection from a fouled cast or the sheltered
route. The resident allocation adds no Wolf action; after a return carrying the
trusted `fact:wolf_winter_byre_held` outcome, its exact story-choice proof opens
one 15-minute Market fatigue recovery instead of the ordinary 240-minute rest.
The mobile allocation imports one failure-crew flag. Only after the first
fortification seat has failed and Cade's help or Albany's emergency strip has
already recovered that same seam can the crew act once, lower Winter Siege
pressure by 1, preserve the failed-check and stance-cost record, and reach a
truthful mobile-stabilized dawn branch. On the same byre-held return, its exact
choice proof instead opens one 15-minute Campus resupply instead of the ordinary
45-minute service. Thus resident shelter and mobile reserve are advantageous in
different return states, while Cade's wagon is advantageous on the clean
exposed-ridge lure line; none gates hunt, lure, drive, or fortify commitment.

Allocation offer, five-minute cost, provider memory, quest import, field
consumer, return fact, and service eligibility replay across save/restore and
the overworld-to-quest-to-overworld boundary. Structural restore retains a real
selected allocation and composes it with an already-proven ally choice; it never
invents allocation knowledge, memory, time, field aid, or service from a content
hash. A second restore retains the same proofs. Paired proof lives in
[`relief_allocation_counterfactual.test.ts`](../tests/starting_slice/relief_allocation_counterfactual.test.ts)
and [`world_session_snapshot.test.ts`](../tests/unit/world_session_snapshot.test.ts).
The nonblocking inspection, skip/select permutations, launch legality, surface
parity, and trusted mandatory-offer compatibility are proven in
[`overworld_optional_departure_interactions.test.ts`](../tests/regression/overworld_optional_departure_interactions.test.ts).

The twelfth authored increment proves `SS-F02-relief-oath` as the final counted
fork. Immediately after permanent registration
and before source certification, Rowan requires one exact Wolf-Winter term. Full
Compact Duty costs ten minutes and records public duty, Relief Compact standing,
Rowan's official memory, a boundary-annex knowledge import, and an active
full-duty promise. Aid-Only Duty costs five minutes and records bounded
authority, limited Compact standing, Rowan's negotiated memory, a witnessed-count
knowledge import, and an active limited promise. The Unaffiliated Personal Bond
costs no time and records voluntary aid, Independent Carriers standing, Rowan's
personal-bond memory, an ash-lane knowledge import, and an active return promise.
Each term is a dispatch obligation, not a replacement background or sponsor, and
the source screen cannot appear until one has been selected.

The three field consumers are narrow and nonexclusive. Full Duty lowers only the
first Albany-authority public-seal Repair check by 2 DC: ordinary DC 14 becomes
12 and Works-prepared DC 12 becomes 10. Cade still refuses the failed-seat hand,
the attempt and public stock are still spent, and the Albany-strip recovery is
unchanged. Aid-Only suppresses only the final ordinary +1 cattle-alarm step when
the first lure cast stayed clean; a fouled opening keeps that final pressure even
after a living recovery. It erases no approach pressure, failed cast, or recovery
cost. The Unaffiliated Bond lowers only the first drive
shutter from DC 12 to 10; its finite charge, miss pressure, no-retry rule, and
loose-hurdle recovery stay intact. Hunt, lure, drive, fortify, June, and solo
play remain legal under all three terms. An oath changes advantage and
accountability, not the set of available strategy families.

Return foldback closes the promises truthfully. Full Duty is kept on its lawful
line and broken if the player substitutes Cade's household shutters for the
required public-seal fortification. Aid-Only is kept unless the player invokes
Albany property authority, which releases the narrow promise with Rowan's bend
memory. The Unaffiliated Bond is kept unless that same authority claim breaks
it. If the permanent background is Unaffiliated Courier, its separate
registration emergency-tag promise also closes as kept on any truthful
Wolf-Winter return, regardless of the selected dispatch term; other backgrounds
never acquire that promise. A kept oath promise plus the matching outcome facts can open one bounded
15-minute service: a Civic resupply audit after lawful full-duty authority
fortification, a Market rest after an aid-only living-pack/whole-herd return, or
a Greenway resupply after a qualifying unaffiliated living-drive returned-rig
line. Nonmatching outcomes and bent or broken promises do not receive those
services. Equivalent same-counter claims do not duplicate stock or recovery:
Jamie's Relief Protocol consolidates with the full-duty Civic cache, the
Resident Shelter cot consolidates with the aid-only Market rest, and a
whole-herd drive consolidates the unaffiliated returned-rig claim with Emery's
existing Greenway cache. Each oath card discloses that consolidation before the
player commits.

Unit, schema, chronology, and UI evidence covers the authored choice, durable
character effects, journal ordering, lead-source handoff, generic value and
faction floors, and the three-card presentation. The dedicated paired
field/return proof at
[`relief_oath_counterfactual.test.ts`](../tests/starting_slice/relief_oath_counterfactual.test.ts)
uses identical rolls to isolate all three consumers, proves established
miss/recovery paths remain intact, resolves kept/released/broken promises, and
checks positive and negative eligibility for every conditional service.
Anti-relabel rejection, repeated structural restore, and the shared Independent
Carriers standing case live in that proof and
[`world_session_snapshot.test.ts`](../tests/unit/world_session_snapshot.test.ts).
The causal row is therefore `implemented`, `proven`, and counted.

This proves `SS-F01-character-background`, `SS-F02-relief-oath`, `SS-F03-lead-source`,
`SS-F04-ally-commitment`, `SS-F05-preparation-profile`,
`SS-F06-relief-allocation`, `SS-F07-hill-route`, `SS-F08-cade-trust`,
`SS-F09-wolf-strategy`, `SS-F10-crisis-priority`, `SS-F11-saved-wood`, and
`SS-F12-albany-return`: all twelve required material forks. It proves
the ally-agency clause, three preparation profiles, all four resolution
families, and distinct consumers for all four concepts. It does not yet prove
fleet-level balance, verified player-completion/clarity/enjoyment/continuation
thresholds, or the absence of recurring severe issues. Those remain the next
work; twelve deterministic fork proofs are necessary evidence, not final
greater-than-BG3 certification.

The concept anti-dominance proof now also runs sixteen independent fresh Albany
launches under identical fixed rolls. Road-Warden Fieldcraft owns the clean LURE
opening, Ironhands Repair owns the FORTIFY outer seal, Courier Streetwise owns
the DRIVE recovery, and Ledger Mediation owns the Relief Protocol recovery;
each concept loses the other three witnesses. Together with the existing
Road-Warden HUNT rail counterfactual, this proves native, nonpresentational
advantages without locking any route or claiming fleet-level strategy balance.
Proof lives in
`character_concept_route_balance.test.ts` (retired in the 2026-09-23 suite halving)
and
`character_background_counterfactual.test.ts` (retired in the 2026-09-23 suite halving).

## Required resolution families

The four primary signatures must diverge well before the last input. The current
combat and lure routes diverge at Cade; Albany preparation now changes their
opening checks, recoveries, pressure, and return services without turning
background into a class lock:

| Signature             | Method                                                      | Principal costs and risks                                   |
| --------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| `hunt_and_hold`       | Prepared tactical combat against the pack                   | wounds, damaged gear, Greenway standing, and time           |
| `lure_and_divert`     | Fully noncombat bait and spoor work that redirects the pack | market stock, route knowledge, and cattle risk if late      |
| `fortify_and_outlast` | Fully noncombat sealing and pressure management until dawn  | Works capacity, relief supplies, and exposed outer property |
| `drive_and_evacuate`  | Two-charge signal-and-rope drive while evacuating the herd  | untreated wound, scattered cattle, or sacrificed relief rig |

No preparation profile may dominate all four. Each family needs at least one
authored failure-forward recovery and a distinct persistent Albany aftermath.
All four families now have end-to-end proof. The drive uses two finite spatial execution beats, a visible
pressure threshold, a disclosed no-errand spatial commitment, an authored
failed-check recovery, and a three-way crisis;
it is distinct from the failed-lure one-fight recovery. Fortification uses two
mutually exclusive conduct/resources, a one-shot Repair check, stance-specific
failure recovery, a separate threshold seal, and truthful property/public-stock
aftermath; it is not another lure, drive, or last-action label.

## Depth Contract v1

Certification requires all of the following simultaneously:

1. At least 12 material fork sites. At least 8 have delayed consequences, 5
   cross system boundaries, and 3 cross an Albany/Wolf/return phase boundary.
2. At least four materially different non-death resolution strategies, including
   combat, fully noncombat, and hybrid routes with distinct prior actions, costs,
   risks, and aftermaths.
3. At least four viable character concepts and three preparation/build profiles;
   deterministic counterexamples prove that no profile or route dominates every
   reachable state.
4. At least five named NPCs remember specific conduct. Three have independent
   agendas, and two remain mechanically relevant after Wolf-Winter.
5. At least one ally relationship has independent agency: the ally can refuse,
   leave, disagree, or solve a problem differently because of remembered conduct.
6. At least one visible pressure system—time, weather, cattle safety, winter
   siege, or pack drive—has multiple thresholds and cross-system effects.
   It is never a hidden real-time trap.
7. Combat can be avoided, shortened, redirected, surrendered from, or transformed
   by earlier play. The mandatory three-kill golden path is removed.
8. Every failed check has an authored complication, altered route, or recovery;
   it never offers an unchanged repeat-until-success loop.
9. At least three irreversible tradeoffs have deterministic counterexamples
   showing either side can be advantageous under different reachable conditions.
10. At least three early decisions mechanically alter returned Albany state,
    including NPC availability, services/prices, resources, faction state,
    jobs/events, or the next opportunity.
11. Generic one-click Albany jobs and checklist events are absent from the
    visible slice; authored scenes replace them.
12. One playthrough cannot expose every meaningful scene, relationship state,
    resolution family, or outcome.

Depth Contract #11 is closed. Albany Works proves the reusable authored-job
grammar, one exclusive post-return priority, and a delayed 13-standing Civic
service consumer. Its hazard-shift charter now also proves a pre-Wolf authored
event whose exact option adds one legal return method without replacing either
base Works priority. Civic adds the reusable authored-event grammar: equal
pre-Wolf terms bind a public-or-protected charter policy, and the post-Wolf job
selects exactly one of four policy/outcome closures with outcome-dependent
duration and policy-dependent standing. The paired held/evacuated, restore,
structural replay, and surface
proof is
`winter_return_docket_counterfactual.test.ts` (retired in the 2026-09-23 suite halving).
Campus is the fifth authored Albany event. Blair's post-Wolf return-evidence
mandate requires the Campus POI, Blair's contact, and an explicit investigation
before a player records either clinic exposure thresholds or traceable route
provenance. Each proof keeps Archive Query's two established methods and opens
only its matching additional method. Each completed method creates the matching
exclusive Campus service, consolidating an overlapping Drover rest or mobile
resupply credit rather than duplicating a same-action offer. Exact event and job
proof, save/restore, full/compact/UI/MCP projection, current-state causal checks,
and chronology/tamper failures are covered by
[`campus_return_evidence_mandate_counterfactual.test.ts`](../tests/starting_slice/campus_return_evidence_mandate_counterfactual.test.ts).
Station completes the six-event set with Hayden's optional post-Wolf Cade Return
Filing Standard. After the Station POI, Hayden contact, and explicit
investigation, the player binds either an operational route abstract or a
named-witness return. Both cost 20 minutes and earn 1 standing. The exact event
proof adds only its matching Cade Return Packet close: the abstract retires the
record in 30 minutes for 3 standing, while the witnessed return takes 45 minutes
for 4. Neither administrative close dispatches a crew, repairs a loss, creates a
service claim, or erases the packet's physical evidence; all three existing
loss-backed dispatches remain available when their facts and dawn choice permit.
From the lowest 8-standing held return, the quick path ends at 12 and wins by 15
minutes when rested, while the witnessed path ends at 13 and opens Rowan's
existing 15-minute Civic recovery cot when fatigued. A content-hash mismatch
unlocks neither close. Exact proof, save/restore, full/compact/UI/MCP
projection, opportunity leads, content-revision warning behavior,
chronology/tamper failure, and the standing/fatigue reversal are covered by
[`albany_station_return_filing_standard_counterfactual.test.ts`](../tests/starting_slice/albany_station_return_filing_standard_counterfactual.test.ts).
Cade's Return Packet adds an outcome-authored Station job after Wolf-Winter:
broken outer paling, an abandoned evacuation line, and scattered cattle expose
different mutually exclusive repair dispatches, while fortified no-loss
returns expose none. The chosen dispatch consumes time, changes standing, and
creates or consolidates an exact one-use Albany service without duplicating a
pre-existing returned-rig cache. Restore, replay, action-order, full/compact/UI/MCP,
and all eleven Cade-packet outcome rows across both dawn-dispatch choices are
proved by
`cade_return_packet_counterfactual.test.ts` (retired in the 2026-09-23 suite halving).
Jamie's Market policy and disputed-crates pair adds a second authored event and
fifth authored job: household-price protection consistently buys more standing
for more time than the open-bid board at both fast and thorough settlement depths.
Its exact policy predicate, Civic-cot counterfactual, structural restore, replay,
and full/compact/UI/MCP proof live
in [`albany_market_scene_counterfactual.test.ts`](../tests/starting_slice/albany_market_scene_counterfactual.test.ts).
Greenway adds a third authored event and completes the six-job district set
after Wolf-Winter. Emery Sloane always permits an obvious accessible public
detour. A bloodless return also permits quiet low-profile markers that preserve
the winter wildlife corridor; a hybrid or full-combat return instead permits an
evidence-custody policy and forbids relabeling bloodshed as quiet conservation.
The later corridor survey reads that exact event proof and exposes only its
matching two actions. Public and quiet policy each take 35 minutes/+2 standing
to record; internal custody takes 30/+1. Quiet follow-up offers 20/+1 or 60/+4,
while custody creates a distinct 15/+1 minimum seal or 70/+5 witnessed chain.
Public work remains 30/+3 or 75/+5. From the reachable 8-standing post-Wolf
state, short public work totals 65 minutes and reaches Rowan's existing
13-standing Civic recovery threshold; short quiet work totals 55 minutes and
ends at 11; short custody totals 45 minutes and ends at 10. The deep custody
record instead totals 100 minutes and reaches 14. Wolf strategy therefore
changes Emery's legal policy and its time/standing frontier, not just her
dialogue. The policies change legal action, copy, time, standing, and a delayed
existing service without adding a new rest/resupply coupon or delaying
first-goal completion. Full/compact/UI/MCP projection, current replay,
structural restore, content-revision warning behavior, and chronology/tamper
guards live in the paired proof below. A content-hash mismatch never relabels a
selected quiet policy as custody, while new bloodshed decisions cannot select
quiet policy.
[`albany_greenway_scene_counterfactual.test.ts`](../tests/starting_slice/albany_greenway_scene_counterfactual.test.ts).
The cattle-first drive wound now adds a character-state consequence to the
public and quiet survey frontiers without changing their policy proof. While
Cade's witnessed byre-mouth wound is untreated, each policy keeps its fast
field action legal but withholds only its deep witnessed survey. Taking the
exact Station care advances the wound, restores health, and reopens that deep
action. Rest and resupply cannot substitute for treatment. Care consumption,
chronological character replay, full/compact/UI/MCP parity, forged and duplicate
evidence rejection, and repeated restore of already-completed deep options are proved by
[`wolf_wound_care_counterfactual.test.ts`](../tests/starting_slice/wolf_wound_care_counterfactual.test.ts).
Works adds the fourth authored district event without gating departure or
lengthening the mandatory path. Reese's witnessed-count and cold-set-bypass
charters each cost 20 minutes and earn 1 standing before Wolf-Winter, then add
only their matching 45-minute/+3 or 60-minute/+4 method to the existing Works
return job.
The original 80-minute/+5 public-shift protection and 35-minute/+2 reserve
inventory remain legal. From the lowest 8-standing held return, the witnessed
method ends at 12 and beats the bypass by 15 minutes when already rested; the
bypass ends at 13 and opens Rowan's existing 15-minute Civic cot, beating
ordinary 180-minute recovery when fatigued. The unresolved charter expires
after Wolf-Winter and is not projected as a return lead, while an
already-discovered Works job remains
eligible for the normal lead. Full/compact-v29/UI/MCP parity, event/job replay,
structural save/restore, explicit content-revision warnings, and the
standing/fatigue reversal live in
[`albany_works_hazard_charter_counterfactual.test.ts`](../tests/starting_slice/albany_works_hazard_charter_counterfactual.test.ts).
The journey now also projects optional return opportunities without adding a
counted fork: unresolved post-quest event roots in visited towns and eligible
authored jobs whose roots were already discovered remain visible beside the
current objective after the player leaves. Each lead exposes only its title,
district, kind, and exact `here` / `mapped` / `route_unmapped` access state;
choices, outcomes, rewards, and scene terms remain undisclosed until normal
play reaches them. The structured journey object is authoritative, while the
versioned compact v29 context receives only a bounded additive tuple and legend.
Projection is read-only, adds no decision or action, and is covered across the
Wolf completion, dawn choice, northward departure, restore, MCP, and UI surfaces
by `albany_return_opportunity_leads.test.ts` (retired in the 2026-09-23 suite halving).
Five verified exact-feature Terra journeys completed Wolf-Winter and continued,
but none organically named, pursued, or declined a listed Return Opportunity;
the separate Cade dawn dispatch does not count. Deterministic visibility therefore
passes while the original discoverability hypothesis fails at 0/5. A shared,
state-honest pursuit sentence now sits beside every full, compact, and UI lead:
finish setup before using a lead that is here, return and walk to a mapped
district, or return and Explore Area to reveal an unmapped local route. This
adds no action or forced decision, creates no objective, and remains truthful
when the preceding objective has already completed.
In the first exact-feature follow-up cohort, one journey never received a
non-null lead and is excluded; one of the three eligible players organically
recognized the optional Albany opportunities, none pursued one, and none named
an individual decline. Recognition therefore improves to 1/3 eligible
players, while actual return-route uptake remains unproven.
No generic district job or checklist event remains in the visible Albany slice.
The filing standard is optional after Wolf-Winter, so completing the authored
event set does not add a decision to first-goal completion.

## Evidence contract

The causal matrix is the source of truth for counted forks. Each row records:

- the visible choice and phase;
- immediate state deltas;
- delayed mechanical consumers;
- player-visible feedback at both points;
- systems crossed and persistence boundaries crossed;
- paired deterministic counterfactual tests;
- implementation and proof status.

`counts_toward_contract` stays `false` until the implementation exists and its
test would fail if the delayed consumer were removed. Planned rows are design
commitments, not evidence.

Required proof:

- paired counterfactual tests for every counted fork;
- end-to-end traces for every resolution family and at least three seeded
  failure-forward routes;
- schema validation, a negative fixture, and a synthetic or second-quest proof
  for every new reusable consequence primitive;
- save/restore, seed determinism, compact/full MCP parity, UI parity, action
  legality, journey proofs, and the documented structural v11/v10 snapshot
  boundary; content-only hash mismatch warns but never relaxes state proof;
- `npm run crawl:smoke` before and after every increment;
- `npm run health` before each green commit; pure fresh-overworld blind playtests
  come from the playtest loop's fleets on a frozen build, not from the dev cycle;
- milestone `npm run crawl:deep -- --seconds 120 --workers 8` and a current
  100-player pure fleet.

### Authenticated milestone fleet

Before spending live-player tokens, fleet preflight freezes the full tracked Git
commit and the canonical fresh-overworld world id/hash. The tracked worktree must
be clean; a dirty tree or Git/provenance error fails before launch. Untracked
notes do not dirty this check. It also freezes the contiguous planned seed range,
current journey contract, default pure fresh-overworld player contract, and the
repository-standard homogeneous Codex `gpt-5.6-terra` model plan.

The same shared preflight freezes one Codex client authority and exact semantic
version for every member. Official Windows npm shims and canonical Unix npm
symlinks bind the selected launcher (including symlink identity when present),
manifest, JavaScript entrypoint, and native payload; members execute only that
pinned native payload. Unsupported scripts cannot silently become direct
one-file authority, and the runner never inspects login or model-cache state.

Spark is the ordinary live fleet launcher's default so routine blind feedback
uses the dedicated Spark allowance. The canonical certification workflow pins
Terra explicitly for both pilot and authority. Exact homogeneous Sol, Terra,
Luna, and Spark plans can certify; Codex aliases, fallback, and mixing are
forbidden. Before the 100-player spend, a fresh ten-player homogeneous pilot
must pass this go/no-go pair:

```bash
npm run fleet -- --provider codex --model gpt-5.6-terra --count 10 --concurrency 4 --seed-base <fresh-pilot-seed-base> --label <fresh-pilot-label> --no-resume --max-retries 0
npm run starting-slice:pilot -- --fleet ai-runs/fleet/<fresh-pilot-label>
```

The pilot requires all ten primary subjective reports to authenticate without
resume, retry, model-assisted recovery, or failed attempts; ten unique game and provider sessions; one
exact provider-evidence model value; recognized Wolf-Winter
outcomes; at least three organic strategy families; and no family above 7/10.
It also evaluates the slice's completion-speed, clarity, enjoyment,
continuation, stuck, and severity gates. A passing pilot is readiness evidence,
never milestone certification. If the later authority cohort resolves to a
different exact provider model id, run a new pilot before treating that cohort
as comparable. The authority checker validates only the submitted 100-member
bundle; retaining and reviewing the corresponding fresh same-model pilot is an
explicit operational prerequisite rather than an automatically linked authority
field.

Only after that pilot passes, launch the canonical authoritative cohort:

```bash
npm run fleet -- --provider codex --model gpt-5.6-terra --count 100 --concurrency 4 --seed-base <fresh-seed-base> --label <fresh-label> --no-resume --max-retries 0
```

A live fleet label must be fresh and its bundle is a closed cohort; an existing
label directory is rejected rather than appended to or mixed with stale rows.
Resume is enabled by default for diagnostic fleets and may reuse a report only
after reverifying its report and
evidence sidecar: sidecar schema v2, the current journey contract, exact planned
seed, and the exact clean commit and world id/hash must all match the frozen
cohort. Generic evidence readers retain historical schema-v1 readability, but v1
evidence cannot enter or resume this cohort. Manifest rows expose the
authenticated seed, build, world, and canonical quest outcomes so a bundle can
be audited independently. They also retain every ordered launcher attempt and
classify timeouts, launcher/run failures, verifier failures, and success. Before
a retry can overwrite its prefix, all failed artifacts and a diagnostic are
copied into a digest-indexed per-attempt bundle archive. Summary failure and
timeout counts are recomputed from all histories. An eventual success therefore
leaves that label non-certifying. Resume-enabled bundles and skipped slots are
also non-certifying; a new authoritative label must use
`--no-resume --max-retries 0` and run every slot exactly once. A recovered final
report is historical compatibility data only and is declared only when the
adjacent `.initial-report.txt`,
`.repair.meta.json`, and `.repair.json` bytes form a complete set that
deterministically reproduces it; the rejected original is not another
feedback-discoverable Markdown report. Such a model-recovered report remains diagnostic-only:
its confusion, bug, stuck, and replay-intent fields were generated after the
primary prose and cannot participate in authoritative certification.

Each live member has an adjacent runner-owned provider-discriminated attestation.
Historical Claude v2 remains compatible, as do ordinary historical Codex v3,
receipt-bound v4, strict-v1 v5, pre-client-pin strict-v2 v6, client-bound v7,
and transport-bound v8. Current Codex v9 is model-discriminated: exact Spark
binds `spark-direct-mcp-v1` with capture receipt v4 and its tracked player catalog,
Terra binds `game-direct-mcp-v1` with capture receipt v5 and its distinct tracked
player catalog, disabled multi-agent topology, API-request reasoning-summary mode
`none`, and the exact 0.146 compatibility-only rollout sentinel `summary: "auto"`,
while Sol/Luna bind
`strict-code-mode-v2` with capture receipt v3. All branches bind fleet-wide
frozen effective-client authority and exact CLI version, the exact CLI-recorded
selected model, provider/session/turn, effort, isolated cwd, completed lifecycle,
unique game session, and all artifact hashes. They may also declare deterministic
`report_receipt_bound` provenance: `.initial-report.txt` remains the exact
provider message, `.receipt-bind.json` hashes the envelope/report/raw evidence
and one replaced field, and certification must reproduce the final report from
those bytes. Because this starts no model turn and preserves every subjective
field and all prose outside the receipt value, it is not report recovery and is
eligible when every v9 check passes. The selected capture receipt binds the
copied rollout hash to the exact canonical expected/session/turn cwd and native
filesystem identity; later validation reparses it and rejects abort/error
history or any row after terminal `task_complete`.
Every current pure Codex transport rejects `compacted`, `context_compacted`, or
any second `world_state` or `turn_context`. The CLI's encrypted replacement
history cannot be locally proven to derive only from the audited player-visible
transcript. A catalog `auto_compact_token_limit: null` preserves default maximum
headroom rather than disabling compaction; crossing the boundary therefore
fails closed instead of entering certification evidence.
`turn_context.model` is durable CLI provenance, not a provider-signed
remote-backend snapshot. Diagnostic resume reparses these retained facts;
certification rejects model-assisted recovery, reuse, links, and path escape.
The cwd receipt is likewise trusted local runner provenance recorded while the
temporary player directory still exists. After cleanup, later validation reparses
the receipt and hashes but cannot re-stat that deleted directory or resist a
privileged actor coherently rewriting the whole bundle; it is not a cryptographic
attestation.

The authoritative check is:

```bash
npm run starting-slice:certify -- --fleet ai-runs/fleet/<label>
```

It reparses and reverifies every report and sidecar instead of trusting summary
counts. Certification requires exactly 100 unique rows for the contiguous
planned seeds, all using one supported homogeneous provider/model plan bound to
one exact provider-evidence model value, all successful and present, under the
frozen pure/default/build/world contract, with unique game and provider sessions, `--no-resume`, the cohort's
current-stamp report basename, exactly one verified attempt per slot, and zero
report-recovered rows or artifacts. The ten-player pilot uses a separate result
kind and artifact and can never satisfy this 100-player authority boundary.
Malformed or unauthenticated evidence exits 2; a valid
cohort that misses a quality threshold exits 1; a pass exits 0.

Wolf-Winter outcomes map to strategy families as follows:

| Strategy family       | Accepted Wolf-Winter ending ids                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hunt_and_hold`       | `ending_bloodied_byre_evacuated`, `ending_held_gate_barred`, `ending_held_timber_saved`, `ending_held`, and the four corresponding `*_june_released` identities |
| `lure_and_divert`     | `ending_pack_diverted`, `ending_pack_diverted_cattle_scattered`, `ending_pack_diverted_after_blood`                                                             |
| `fortify_and_outlast` | `ending_fortified_cade_terms`, `ending_fortified_albany_authority`                                                                                              |
| `drive_and_evacuate`  | `ending_drive_cattle_wounded`, `ending_drive_person_cattle_lost`, `ending_drive_reserve_spent`                                                                  |

`ending_pack_diverted_after_blood` is the lure family's bounded hybrid recovery,
and `ending_bloodied_byre_evacuated` (including its June-release identity) is the
hunt family's costly terminal failure-forward exit; neither is a fifth strategy. A missing Wolf-Winter outcome is an incomplete
starting-goal run. A death ending or any unknown Wolf-Winter ending invalidates
the certification bundle rather than being silently bucketed.

Final experiential certification requires all of these gates simultaneously:

- verified starting-goal completion at or above 90%;
- median meaningful decisions to first-goal completion at or below 45;
- `got_stuck` at or below 5%;
- mean clarity at or above 4.2 and mean enjoyment at or above 4.2;
- continuation at the initial goal-completion choice at or above 70%;
- at least three of the four strategy families observed organically, with no
  family above 75% of completed runs;
- no in-scope S3/S4 issue and no in-scope S2 cluster present in five or more
  distinct runs.

`would_replay` is a separate post-exit attitude and never substitutes for the
game-recorded continuation choice. The certifier uses only this authenticated
fleet and treats ambiguous issue scope conservatively; global historical
feedback and compiler aggregates remain useful diagnosis, never certification
evidence. This tooling enables the later diagnostic and authoritative 100-player
fleets. It does not change the current `active_unproven` status by itself.

## Increment discipline

Each increment must create one reusable or player-visible causal improvement,
update the matrix truthfully, preserve unrelated work, pass the repository's
gates, and complete its terse `## AFK Cycle` entry in `AI_LOOP_STATE.md`. Under the
two-loop model (`AGENTS.md`, `docs/two_loop_workflow.md`) a dev increment does not
play the game: fresh pure reports come from the playtest loop against the landed
build and reach later increments through the intake queue. A green increment lands
the way every change does — `npm run ship`, a short-lived branch squash-merged into
`main` behind the required `verify` check — never by a direct push.

The milestone is complete only when current evidence proves every contract item.
Until then, the next move is the highest-leverage missing foundation inside this
fixed slice—not another map node, quest port, or prose-only branch.
