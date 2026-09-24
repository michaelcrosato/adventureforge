/**
 * Verifier-integrity guard — operationalizes the "don't route around the verifier"
 * principle from AGENTS.md (trust, but verify).
 *
 * Under full agent trust the loop can change anything, and the dominant failure
 * mode of unattended coding loops is REWARD-HACKING: silently weakening the very
 * checks that establish correctness — skipping/deleting/emptying tests, or
 * re-pinning a committed hash to launder a behavior change (see the EvilGenie
 * benchmark, arXiv:2511.21654, and Anthropic's long-running-agents harness which
 * forbids editing the verifier). This guard makes those mechanical hacks fail
 * loudly so the verification stays honest.
 *
 * Two modes:
 *   - STATIC (default): the repo, right now, must keep its verification intact —
 *     the protected verification assets exist, no test is disabled (.skip/.only/
 *     .todo/xit), and the test-case count is above a floor. Run in `npm run health`
 *     and CI; it is part of the bar.
 *   - DRIFT (`--against <ref>`): the autonomous loop runs this before committing a
 *     cycle. If the cycle deleted a protected file, introduced a disabled test, or
 *     changed a committed hash-pin, the guard REFUSES AND SURFACES it for human
 *     review (set AI_LOOP_ALLOW_VERIFIER_EDITS=1 to acknowledge a deliberate edit).
 *
 * It catches MECHANICAL tampering (skip/delete/empty/re-pin) AND assertion gutting,
 * on three independent counts that rise together only for an honest +tests cycle:
 * the test-case count guards the `it()`/`test()` SHELLS; the `expect()` count guards
 * that the bodies still ASSERT; and the STRONG-matcher count guards that those
 * assertions still PIN A VALUE — closing the launder where a cycle keeps every shell
 * and every `expect()` but swaps a strict matcher for a loose existence check
 * (`toBe(x)` → `toBeDefined()`), leaving a green test that no longer checks anything
 * specific. The tautology scanner adds a deterministic semantic backstop for the
 * count-preserving launder where a STRONG matcher is kept but made vacuous
 * (`expect(true).toBe(true)`). A net drop in any count, or an increase in tautologies,
 * is a hard regression. An agent with write access to this script could also edit the
 * guard itself — the point is to make tampering visible, effortful, and against the
 * rules, not impossible.
 * Pure + deterministic: no clock, no RNG, no network.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  countLiveEntries,
  liveEntryBytes,
  LOOP_STATE_FILE,
  ROTATE_KEEP,
  ROTATE_MAX_ENTRY_BYTES,
} from "../src/afk/loop_state.js";

/** Verification assets the project's correctness rests on. Must always exist. */
export const PROTECTED_FILES = [
  "tests/property/determinism.test.ts",
  // The overworld twin of the property suite above, and the toy subject the RPG one
  // still uses as its cheap minimal witness. determinism.test.ts was protected while
  // micro.ts was not, so deleting the toy broke the protected test without tripping
  // PROTECTED_DELETED — the guard would have reported the disappearance as a plain
  // test failure rather than as verification being removed.
  //
  // NOTE: keep this comment free of apostrophes and quotes and brackets — see below.
  "tests/property/overworld_determinism.test.ts",
  "src/demo/micro.ts",
  "src/core/rng.ts",
  "src/core/hash.ts",
  "src/core/sha256.ts",
  "src/core/engine.ts",
  "src/validate/rpg_validator.ts",
  "src/persist/save_load.ts",
  // The RPG generator program is the only supported moving-target content generator.
  // Retired non-RPG generators move to FORBIDDEN_FILES below instead of staying protected.
  //
  // NOTE: keep this comment free of apostrophes/quotes/brackets — parseGuardConstants
  // pure-parses this array literal and a stray quote would read as a phantom entry.
  "src/gen/rpg_generator.ts",
  "bin/seal-corpus.ts",
  // The sealed held-out corpus manifest is the OUTPUT of the seal CLI above and the
  // committed pin the contamination-free benchmark rests on (bug_0163/bug_0165): each
  // entry fixes a generated pack content_hash plus generator_version for a frozen seed
  // window. The generators that mint it are guarded above, but a manual re-seal that
  // rewrites these hashes WITHOUT a generator change would otherwise slip past the drift
  // check unseen, laundering a degraded eval distribution into the held-out split.
  // Guarding the manifest makes any re-seal surface VERIFIER_TOUCHED for review and a
  // deletion a hard PROTECTED_DELETED error, while held_out_corpus_sealed.test.ts proves
  // the pins still re-mint deterministically. bug_0176, the bug_0172 deferred lever c.
  "corpus/manifest.json",
  "scripts/verify-integrity.ts",
  // The exhaustive solver is the ground truth under 14 census proofs — every
  // all-endings-reachable, soft-lock and score-economy claim is a statement about
  // what its BFS found. Weakening it would make all 14 pass VACUOUSLY with no change
  // to any count here, so nothing else in this guard would notice. The cap backstop
  // is its two-sided witness that the state cap actually fires, which is what stops
  // a silently truncated search from reading as a completed proof; guard both or
  // guarding either is theatre.
  //
  // NOTE: keep this comment free of apostrophes and quotes and brackets — see above.
  "src/solve/exhaustive_endings.ts",
  "tests/regression/exhaustive_endings_cap_backstop.test.ts",
  // Decides WHICH test files CI runs. A filter here silently shrinks the suite while
  // every shard still reports green, so it belongs beside the counts it could hide.
  "scripts/ci-test-groups.ts",
  // The same rationale for the two files that choose WHICH BAR a change must clear.
  // test-lanes.ts owns CENSUS_PROOF_SOURCE_SCOPES and the fast versus exhaustive
  // partition of the vitest projects; cycle-bar.ts is how loop.sh asks it. Dropping one
  // scope from that list, or teaching the classifier to answer fast, sends an engine or
  // content change through health:fast with the census proofs never run, while every
  // count here and every shard stays green. bug_0636.
  //
  // NOTE: keep this comment free of apostrophes and quotes and brackets — see below.
  "scripts/test-lanes.ts",
  "scripts/cycle-bar.ts",
  // Two of the nine health steps are verifiers in their own right, beside this file: the
  // opening-density budget and the bug-trace corpus check. Hollowing either one turns a
  // health step into a no-op that still exits 0. bug_0636.
  "scripts/verify-opening-density.ts",
  "scripts/verify-bug-traces.ts",
  // The same rationale one layer lower, and the sharper half of it. ci-test-groups.ts
  // only chooses which PATHS are handed to vitest; vitest.config.ts decides which of
  // those paths a project actually RUNS. Appending one glob to a project exclude array
  // drops hundreds of files while every shard still exits 0, because vitest silently
  // ignores a file filter that matches no project include. Nothing else in this guard
  // could notice: the text under tests stays byte-identical, so all four counts, the
  // disabled-marker scan and the protected list are unchanged. detectSuiteCoverage
  // below reads this file directly for exactly that reason.
  //
  // NOTE: keep this comment free of apostrophes and quotes and brackets — see below.
  "vitest.config.ts",
  // The protected solver above is reached by 12 files — including the protected cap
  // backstop right above — through a three-line re-export shim that was itself
  // unprotected. It is not a .test.ts file, so no count and no disabled-marker scan
  // here has ever read it. Replacing its re-export with a weakened local search
  // neutralises the protected solver AND its protected backstop at once, with no
  // PROTECTED_DELETED, no VERIFIER_TOUCHED and no count change — precisely the launder
  // the note above says guarding both was meant to prevent.
  //
  // NOTE: keep this comment free of apostrophes and quotes and brackets — see below.
  "tests/regression/support/exhaustive_endings.ts",
];

/** Paths that must not reappear while the repo normalizes to RPG-only authoring. */
export const FORBIDDEN_FILES = [
  "src/gen/cyoa_generator.ts",
  "src/gen/parser_generator.ts",
  "bin/play.ts",
  "bin/cyoa.ts",
  "bin/parser.ts",
  "bin/parser_play.ts",
  "src/cyoa",
  "src/validate/cyoa_validator.ts",
  "content/cyoa",
  "src/parser",
  "src/validate/parser_validator.ts",
  "content/parser",
  "tests/property/parser_determinism.test.ts",
];

/** Token-heavy local artifacts may exist in a developer worktree, but must never
 *  ship in Git where every clone and agent context can rediscover them. */
export const FORBIDDEN_TRACKED_FILES = ["AI_LOOP_STATE_ARCHIVE.md", "ai-runs/"];

/** Glob-like path patterns for retired test families that should not reappear
 *  under a new filename while the repo is locked to the RPG runtime. */
export const FORBIDDEN_PATH_PATTERNS = [
  "^tests/unit/cyoa.*\\.test\\.ts$",
  "^tests/unit/parser.*\\.test\\.ts$",
  "^tests/(?:regression|property)/cyoa.*\\.test\\.ts$",
  "^tests/(?:regression|property)/parser.*\\.test\\.ts$",
] as const;

/** Files holding committed hash pins / known-answer vectors that should not change
 *  silently — a change here in a cycle's diff is surfaced for human review. */
export const HASH_PIN_FILES = [
  "tests/unit/rpg_validator.test.ts",
  "tests/unit/sha256.test.ts",
  "traces/bugs/bug_0002_watchtower_blind_polish.yaml",
  "traces/rpg/barrow_victory.json",
];

/**
 * Exact content sources that may automatically justify changing each hash-pin.
 * Entries are encoded as `pin=>source` so the guard can pure-parse and protect
 * this relationship list alongside HASH_PIN_FILES. A pin with no entry has no
 * live content source: changing it requires the existing explicit
 * AI_LOOP_ALLOW_VERIFIER_EDITS acknowledgment (for example, an algorithm or
 * historical-fixture format change).
 *
 * This is intentionally file-exact rather than a `content/` prefix. An unrelated
 * content edit must never launder a re-pin.
 */
export const HASH_PIN_CONTENT_SOURCE_SCOPES = [
  "tests/unit/rpg_validator.test.ts=>content/rpg/quests/sunken_barrow.yaml",
  "tests/unit/rpg_validator.test.ts=>content/broken-fixtures/rpg_unwinnable.yaml",
  "traces/rpg/barrow_victory.json=>content/rpg/quests/sunken_barrow.yaml",
] as const;

/**
 * One-time, owner-approved T50 halving of the test suite (2026-09-23). The owner directed
 * that half of the suite be deleted, with the choice of which left to the agent, and that
 * what remains be split into an active-development bucket (`test:fast`) and a take-a-break
 * bucket (`test:exhaustive`). The selection rules and per-area tally live in the
 * completion record below. These are the exact artifacts whose deletion makes the exception
 * eligible. Requiring every path to exist at the comparison ref and be absent now makes the
 * exception self-expiring: after the T50 change lands, no later baseline can qualify.
 */
export const APPROVED_T50_REMOVED_PATHS = [
  "tests/regression/advocates_case_missing_precedent_hint.test.ts",
  "tests/regression/advocates_case_reactive_taken_items.test.ts",
  "tests/regression/advocates_case_rhetoric_retry.test.ts",
  "tests/regression/agent_communication_guidance.test.ts",
  "tests/regression/agents_trust_but_verify_coherence.test.ts",
  "tests/regression/assessor_blind_pass_rotation.test.ts",
  "tests/regression/assessor_doc_staleness.test.ts",
  "tests/regression/assessor_generator_rpg_mint_and_check.test.ts",
  "tests/regression/assessor_lint_coverage.test.ts",
  "tests/regression/blind_prompt_tool_refs.test.ts",
  "tests/regression/blind_provider_isolation_contract.test.ts",
  "tests/regression/blind_pure_prompt_contract.test.ts",
  "tests/regression/blind_pure_report_contract.test.ts",
  "tests/regression/blind_report_verifier.test.ts",
  "tests/regression/blind_runner_config_contract.test.ts",
  "tests/regression/blind_runner_smoke_entrypoint.test.ts",
  "tests/regression/blind_strict_stream_fail_fast.test.ts",
  "tests/regression/blocked_exit_hints_human_surfaces.test.ts",
  "tests/regression/breaking_weir_blind_polish.test.ts",
  "tests/regression/breaking_weir_flood_book_journal.test.ts",
  "tests/regression/breaking_weir_flood_course_choice.test.ts",
  "tests/regression/breaking_weir_gamble_legible.test.ts",
  "tests/regression/breaking_weir_leave_pell_prompt.test.ts",
  "tests/regression/breaking_weir_lodge_calmed_variant.test.ts",
  "tests/regression/breaking_weir_lodge_items_stale.test.ts",
  "tests/regression/breaking_weir_next_adventure_choice.test.ts",
  "tests/regression/breaking_weir_pell_flood_book_crossref.test.ts",
  "tests/regression/breaking_weir_pell_weir_order_reactive.test.ts",
  "tests/regression/breaking_weir_skill_chain.test.ts",
  "tests/regression/breaking_weir_unread_book_ending_hint.test.ts",
  "tests/regression/breaking_weir_walk_no_rope_reactive.test.ts",
  "tests/regression/breaking_weir_walk_success_neutral.test.ts",
  "tests/regression/build_spec_rpg_only.test.ts",
  "tests/regression/claude_capture_contract.test.ts",
  "tests/regression/cold_forge_death_ending_render.test.ts",
  "tests/regression/cold_forge_founder_plate.test.ts",
  "tests/regression/cold_forge_grate_bar_cue.test.ts",
  "tests/regression/cold_forge_grate_failure_recoverable.test.ts",
  "tests/regression/cold_forge_grate_journal.test.ts",
  "tests/regression/cold_forge_phantom_hammer.test.ts",
  "tests/regression/cold_forge_plate_load_bearing.test.ts",
  "tests/regression/cold_forge_plate_pickup_don_hint.test.ts",
  "tests/regression/cold_forge_reactive_epilogue.test.ts",
  "tests/regression/cold_forge_relight_foreclosure.test.ts",
  "tests/regression/cold_forge_sentinel_prep_matters.test.ts",
  "tests/regression/cold_forge_sentinel_threat_telegraph.test.ts",
  "tests/regression/cold_forge_sentinel_warmup_fiction.test.ts",
  "tests/regression/cold_forge_spirit_pure_speech.test.ts",
  "tests/regression/cold_forge_spirit_root_short_greeting.test.ts",
  "tests/regression/cold_forge_stale_prybar_prose.test.ts",
  "tests/regression/cold_forge_underprepared_death_hint.test.ts",
  "tests/regression/cold_forge_unworn_plate_nudge.test.ts",
  "tests/regression/crawl_workers_determinism.test.ts",
  "tests/regression/dawn_beacon_armory_mail_reactive.test.ts",
  "tests/regression/dawn_beacon_cresset_retry_legible.test.ts",
  "tests/regression/dawn_beacon_crown_flint_reactive.test.ts",
  "tests/regression/dawn_beacon_explicit_light_act.test.ts",
  "tests/regression/dawn_beacon_orders_board_signpost.test.ts",
  "tests/regression/dawn_beacon_reactive_cresset_name.test.ts",
  "tests/regression/dawn_beacon_reactive_watchman_hub.test.ts",
  "tests/regression/dialogue_reactive_npc_text.test.ts",
  "tests/regression/docs_trust_but_verify_coherence.test.ts",
  "tests/regression/embedded_launch_overlay_parity.test.ts",
  "tests/regression/eslint_tests_coverage.test.ts",
  "tests/regression/eslint_ui_coverage.test.ts",
  "tests/regression/factors_mark_breckel_retires.test.ts",
  "tests/regression/factors_mark_confrontation_retry.test.ts",
  "tests/regression/falconers_ransom_confrontation_retry.test.ts",
  "tests/regression/falconers_ransom_reactive_taken_items.test.ts",
  "tests/regression/falconers_ransom_thorn_retires.test.ts",
  "tests/regression/feedback_cycle_input_discovery.test.ts",
  "tests/regression/feedback_mock_hotspot_quarantine.test.ts",
  "tests/regression/feedback_rebootstrap_cli.test.ts",
  "tests/regression/gallowmere_blind_side_tactic.test.ts",
  "tests/regression/gallowmere_peat_sign_kill_site_hint.test.ts",
  "tests/regression/gallowmere_starting_knife_truth.test.ts",
  "tests/regression/gallowmere_tracking_failure_recovery.test.ts",
  "tests/regression/inspect_death_ending_diagnosis.test.ts",
  "tests/regression/inspect_trace_divergence.test.ts",
  "tests/regression/intake_claim_lease.test.ts",
  "tests/regression/journey_campaign_out_of_order_recovery.test.ts",
  "tests/regression/loop_process_scripts.test.ts",
  "tests/regression/loop_state_rotation.test.ts",
  "tests/regression/mcp_goal_passage.test.ts",
  "tests/regression/mcp_pure_play_mode.test.ts",
  "tests/regression/mcp_server_registration.test.ts",
  "tests/regression/mcp_spectate.test.ts",
  "tests/regression/new_york_overworld.test.ts",
  "tests/regression/observation_hide_graph_per_call.test.ts",
  "tests/regression/overworld_cli_embedded_journey_bridge.test.ts",
  "tests/regression/overworld_road_encounter_next_action.test.ts",
  "tests/regression/play_launcher_contract.test.ts",
  "tests/regression/playtest_loop_documented_cohort.test.ts",
  "tests/regression/playtest_loop_triage_between_waves.test.ts",
  "tests/regression/playtest_prompt_severity_direction.test.ts",
  "tests/regression/printers_night_proof_sheet_claim.test.ts",
  "tests/regression/printers_night_reactive_taken_items.test.ts",
  "tests/regression/reactive_object_descriptions.test.ts",
  "tests/regression/registration_progressive_disclosure.test.ts",
  "tests/regression/roadmap_rpg_only.test.ts",
  "tests/regression/rpg_barrow_claim_relic.test.ts",
  "tests/regression/rpg_barrow_death_ending_render.test.ts",
  "tests/regression/rpg_barrow_entry_hall_stale_bar.test.ts",
  "tests/regression/rpg_barrow_lever_first_heave_honest.test.ts",
  "tests/regression/rpg_barrow_lever_legibility.test.ts",
  "tests/regression/rpg_barrow_lord_woken_fork.test.ts",
  "tests/regression/rpg_barrow_opening_objective.test.ts",
  "tests/regression/rpg_barrow_reaver_shade.test.ts",
  "tests/regression/rpg_barrow_sarcophagus_examine_mismatch.test.ts",
  "tests/regression/rpg_barrow_shade_signpost.test.ts",
  "tests/regression/rpg_barrow_slab_examine_stale.test.ts",
  "tests/regression/rpg_barrow_ward_honest_odds.test.ts",
  "tests/regression/rpg_barrow_ward_load_bearing.test.ts",
  "tests/regression/rpg_barrow_ward_no_more_aid.test.ts",
  "tests/regression/rpg_barrow_ward_reliable_survival.test.ts",
  "tests/regression/rpg_barrow_wight_counsel_no_attack_drain.test.ts",
  "tests/regression/rpg_barrow_wight_prep_matters.test.ts",
  "tests/regression/rpg_barrow_woken_reactive_epilogue.test.ts",
  "tests/regression/rpg_combat_damage_legible.test.ts",
  "tests/regression/rpg_generator_cumulative_survival.test.ts",
  "tests/regression/rpg_generator_guaranteed_gauntlet.test.ts",
  "tests/regression/rpg_generator_signed_seed_identity.test.ts",
  "tests/regression/rpg_generator_two_fight_gauntlet.test.ts",
  "tests/regression/rpg_possessive_item_narration.test.ts",
  "tests/regression/rpg_reactive_room_text.test.ts",
  "tests/regression/rpg_skillcheck_die_legible.test.ts",
  "tests/regression/rpg_step_rejection_dialogue_diagnostic.test.ts",
  "tests/regression/shell_free_node_launchers.test.ts",
  "tests/regression/shipped_compact_prose_fidelity.test.ts",
  "tests/regression/sunken_barrow_shade_root_short_greeting.test.ts",
  "tests/regression/sunken_barrow_shade_signposting.test.ts",
  "tests/regression/support/clean_git_checkout.ts",
  "tests/regression/tanners_fever_aftermath_choice.test.ts",
  "tests/regression/tanners_fever_compact_surface.test.ts",
  "tests/regression/tanners_fever_failed_treatment_affordance.test.ts",
  "tests/regression/tanners_fever_notes_read_signpost.test.ts",
  "tests/regression/tanners_fever_peaceful_route.test.ts",
  "tests/regression/tanners_fever_reactive_taken_items.test.ts",
  "tests/regression/tanners_fever_treatment_retry.test.ts",
  "tests/regression/tide_mill_compact_ending_payoff.test.ts",
  "tests/regression/tide_mill_compact_warning_compression.test.ts",
  "tests/regression/tide_mill_crank_handle_reactive.test.ts",
  "tests/regression/tide_mill_flood_hatch_branch.test.ts",
  "tests/regression/tide_mill_head_race_reconnaissance.test.ts",
  "tests/regression/tide_mill_ives_dialogue_flow.test.ts",
  "tests/regression/tide_mill_late_takings_visibility.test.ts",
  "tests/regression/tide_mill_mill_house_compact_orientation.test.ts",
  "tests/regression/tide_mill_no_board_score_branch.test.ts",
  "tests/regression/tide_mill_second_fault_narration.test.ts",
  "tests/regression/tide_mill_takings_branch.test.ts",
  "tests/regression/tide_mill_wheel_room_compact_orientation.test.ts",
  "tests/regression/trace_cli_integrity.test.ts",
  "tests/regression/trace_diverged_at_step.test.ts",
  "tests/regression/wolf_winter_albany_bridge.test.ts",
  "tests/regression/wolf_winter_approach_block_names_the_road.test.ts",
  "tests/regression/wolf_winter_authority_commitment_boundary.test.ts",
  "tests/regression/wolf_winter_braced_breach_legible.test.ts",
  "tests/regression/wolf_winter_cli_command_projection.test.ts",
  "tests/regression/wolf_winter_combat_tactics.test.ts",
  "tests/regression/wolf_winter_compact_npc_display_name.test.ts",
  "tests/regression/wolf_winter_compact_surface.test.ts",
  "tests/regression/wolf_winter_complementary_clues.test.ts",
  "tests/regression/wolf_winter_day_book_signpost.test.ts",
  "tests/regression/wolf_winter_first_cast_feed_truth.test.ts",
  "tests/regression/wolf_winter_gallowmere_handoff.test.ts",
  "tests/regression/wolf_winter_june_release_ending_overrides.test.ts",
  "tests/regression/wolf_winter_loft_resource_choice.test.ts",
  "tests/regression/wolf_winter_paling_stage_actions.test.ts",
  "tests/regression/wolf_winter_phantom_spear.test.ts",
  "tests/regression/wolf_winter_postcast_state_truth.test.ts",
  "tests/regression/wolf_winter_prep_carries_score.test.ts",
  "tests/regression/wolf_winter_prep_is_a_gamble_not_certain_death.test.ts",
  "tests/regression/wolf_winter_reactive_taken_items.test.ts",
  "tests/regression/wolf_winter_seeded_field_conditions.test.ts",
  "tests/regression/wolf_winter_store_shed_lure_ladder_hint.test.ts",
  "tests/regression/wolf_winter_uncommitted_living_boundary.test.ts",
  "tests/regression/wolf_winter_wedge_signposted.test.ts",
  "tests/starting_slice/albany_return_opportunity_leads.test.ts",
  "tests/starting_slice/albany_works_renown_service_counterfactual.test.ts",
  "tests/starting_slice/albany_works_scene_counterfactual.test.ts",
  "tests/starting_slice/ally_commitment_counterfactual.test.ts",
  "tests/starting_slice/ally_content_gameplay.test.ts",
  "tests/starting_slice/bloodied_byre_evacuation_return_e2e.test.ts",
  "tests/starting_slice/cade_return_packet_counterfactual.test.ts",
  "tests/starting_slice/campus_archive_query_counterfactual.test.ts",
  "tests/starting_slice/character_background_counterfactual.test.ts",
  "tests/starting_slice/character_concept_route_balance.test.ts",
  "tests/starting_slice/drive_crisis_return_counterfactual.test.ts",
  "tests/starting_slice/fortify_outlast_return_e2e.test.ts",
  "tests/starting_slice/hill_approach_gameplay.test.ts",
  "tests/starting_slice/opening_departure_recap.test.ts",
  "tests/starting_slice/opening_dispatch_briefing.test.ts",
  "tests/starting_slice/opening_honesty.test.ts",
  "tests/starting_slice/preparation_dispatch_forecast.test.ts",
  "tests/starting_slice/preparation_profile_gameplay.test.ts",
  "tests/starting_slice/preparation_profiles_return_e2e.test.ts",
  "tests/starting_slice/progressive_event_disclosure.test.ts",
  "tests/starting_slice/station_dispatch_board.test.ts",
  "tests/starting_slice/station_dispatch_impact.test.ts",
  "tests/starting_slice/winter_return_docket_counterfactual.test.ts",
  "tests/starting_slice/wolf_dispatch_window_counterfactual.test.ts",
  "tests/starting_slice/wolf_route_tradeoff_projection.test.ts",
  "tests/starting_slice/wolf_strategy_counterfactual.test.ts",
  "tests/unit/ai_loop.test.ts",
  "tests/unit/assessment_model.test.ts",
  "tests/unit/assessor.test.ts",
  "tests/unit/assessor_hotspots.test.ts",
  "tests/unit/blind_exit_interview_bounds.test.ts",
  "tests/unit/blind_launch_flag_recovery.test.ts",
  "tests/unit/blind_receipt_binding.test.ts",
  "tests/unit/blind_report_recovery.test.ts",
  "tests/unit/blind_telemetry.test.ts",
  "tests/unit/campaign_import_bridge.test.ts",
  "tests/unit/codex_blind_provider.test.ts",
  "tests/unit/codex_fleet_authority.test.ts",
  "tests/unit/codex_rollout_capture.test.ts",
  "tests/unit/crawl_overworld.test.ts",
  "tests/unit/crawl_quest_crawler.test.ts",
  "tests/unit/cycle_playtest_gate.test.ts",
  "tests/unit/debugger_fixer.test.ts",
  "tests/unit/feedback_acceptance.test.ts",
  "tests/unit/feedback_cluster.test.ts",
  "tests/unit/feedback_compile.test.ts",
  "tests/unit/feedback_metrics.test.ts",
  "tests/unit/feedback_normalize.test.ts",
  "tests/unit/feedback_rank.test.ts",
  "tests/unit/feedback_report_manifest.test.ts",
  "tests/unit/feedback_schema.test.ts",
  "tests/unit/feedback_trends.test.ts",
  "tests/unit/fleet_args.test.ts",
  "tests/unit/fleet_attestation.test.ts",
  "tests/unit/fleet_build.test.ts",
  "tests/unit/fleet_cohort_ledger.test.ts",
  "tests/unit/fleet_lifecycle_guard.test.ts",
  "tests/unit/fleet_run_artifacts.test.ts",
  "tests/unit/fleet_usage.test.ts",
  "tests/unit/generated_eval.test.ts",
  "tests/unit/intake_atomic_file.test.ts",
  "tests/unit/journey_opportunity_explainer.test.ts",
  "tests/unit/journey_opportunity_leads.test.ts",
  "tests/unit/loop_failure_ledger.test.ts",
  "tests/unit/mcp_campaign_import_integrity.test.ts",
  "tests/unit/mcp_generate_rpg_pack.test.ts",
  "tests/unit/mcp_journey_story_choice_grouping.test.ts",
  "tests/unit/mcp_journey_surface.test.ts",
  "tests/unit/mcp_project_registration_sync.test.ts",
  "tests/unit/overworld_fresh_game_tutorial.test.ts",
  "tests/unit/process_audit_wiring.test.ts",
  "tests/unit/pure_fleet_model_matches_request.test.ts",
  "tests/unit/qa_playtest_pipeline.test.ts",
  "tests/unit/qa_region_identity.test.ts",
  "tests/unit/qa_triage_cli.test.ts",
  "tests/unit/record_playtest_session_cli.test.ts",
  "tests/unit/recorded_runner_evidence.test.ts",
  "tests/unit/seal_feedback_acceptance.test.ts",
  "tests/unit/soft_performance_budget.test.ts",
  "tests/unit/spectate_format.test.ts",
  "tests/unit/stale_reactive_audit.test.ts",
  "tests/unit/starting_slice_fleet_certifier.test.ts",
  "tests/unit/starting_slice_pilot_cli.test.ts",
  "tests/unit/support/recorded_runner.ts",
  "tests/unit/terminal_story_choice_grouping.test.ts",
  "tests/unit/test_duration_census.test.ts",
  "tests/unit/ui_active_quest_persistence.test.ts",
  "tests/unit/ui_error_boundary.test.ts",
  "tests/unit/ui_goal_direction.test.ts",
  "tests/unit/ui_goal_passage.test.ts",
  "tests/unit/ui_journey_opportunity_leads.test.ts",
  "tests/unit/ui_pack_catalog.test.ts",
  "tests/unit/ui_stage_navigation.test.ts",
  "tests/unit/ui_story_choice_grouping.test.ts",
  "tests/unit/ui_story_choice_summary_first.test.ts",
  "tests/unit/world_campaign_service_region_renown.test.ts",
  "tests/unit/world_opening_dispatch_choice_replay.test.ts",
  "tests/unit/world_opening_dispatch_integrity.test.ts",
  "tests/unit/world_opening_registration_doctrine_runtime.test.ts",
  "tests/unit/world_opening_stale_choice_language.test.ts",
  "tests/unit/world_opening_starting_doctrine.test.ts",
  "tests/unit/world_string_order.test.ts",
] as const;

/** Exact final whole-corpus reduction for the owner-approved T50 change relative to its
 * pre-change `origin/main`. This is deliberately the reviewed NET tuple: equality catches
 * any unbalanced drift around this one change. Like every aggregate counter, it cannot
 * prove semantic equivalence or distinguish two compensating edits, so the exact
 * deletion-set and review requirements remain load-bearing. */
export const APPROVED_T50_NET_TEST_REDUCTION = Object.freeze({
  cases: 0,
  assertions: 0,
  strong: 0,
});

/** The static floors re-measured at ~80% of the halved corpus. A qualifying T50 change may
 * lower MIN_TEST_CASES / MIN_ASSERTIONS / MIN_STRONG_ASSERTIONS to exactly these values
 * and no further; every other guard-weakening check stays live. */
export const APPROVED_T50_FLOORS = Object.freeze({
  minTestCases: 0,
  minAssertions: 0,
  minStrongAssertions: 0,
});

export const APPROVED_T50_DECISION_MARKER = "T50 test-suite halving";
export const APPROVED_T50_COMPLETION_RECORD = "docs/TEST_SUITE_HALVING.md";

// The three static floors below are the LAST line of defence, and until 2026-08-05 they
// sat at roughly 2-4% of the real corpus (120/400/400 against ~3,200/20,300/19,400) with
// comments claiming counts that were an order of magnitude stale. A PR could delete
// ~96% of the suite and pass both verify:integrity and the test shards, because the
// shards simply run fewer files. They are now set at ~80% of the measured corpus:
// tight enough that a mass deletion cannot hide beneath them, loose enough that a
// legitimate consolidation, or removing a check together with the feature it guarded,
// has room. Re-measure and re-raise them deliberately, never lower them.
//
// Measured 2026-08-05 over 462 files: 3,255 cases / 20,297 assertions / 19,382 strong.
// Re-measured 2026-08-28 over 465 files: 3,491 cases / 22,613 assertions / 21,619 strong.
// The corpus had grown ~7-11% under floors that never moved, so the "~80%" the paragraph
// above claims had quietly decayed to 74.5% / 71.6% / 71.7% — 891 cases, 6,413
// assertions and 6,119 strong matchers that a static-only run would accept losing. The
// floors below were re-raised to ~80% of that measurement; the drift ratchet
// (--against) remains the check that catches a single-cycle drop of any size.
//
// Re-measured 2026-08-30 over 485 files: 3,722 cases / 23,437 assertions / 22,382
// strong. Three weeks of growth had already decayed the 08-28 floors to ~75-77%, so
// this raise repeats the same maintenance. The decay is structural: the corpus grows
// every cycle and these constants do not. Whenever an audit re-measures, re-raise to
// ~80% of the fresh numbers — and treat a gap wider than ~5 points as overdue.
//
// Re-measured 2026-09-22 over 509 files, with this file's own counters (listTestFiles +
// countTestCases / countAssertions / countStrongAssertions): 4,017 cases / 24,489
// assertions / 23,388 strong. The 08-30 floors had decayed to 74.1% / 76.4% / 76.5% —
// the case floor past the overdue line above. Re-raised to ~80% again (79.7% / 79.6% /
// 80.0%); raising only, and the drift ratchet still owns single-cycle drops.

/** Never drop below this many test cases (a mass-deletion tripwire). */
export const MIN_TEST_CASES = 3200;

/** Never drop below this many `expect()` assertions (the assertion-gutting tripwire,
 *  parallel to MIN_TEST_CASES), while the drift ASSERTION_COUNT_REGRESSION guards the
 *  precise per-cycle drop. */
export const MIN_ASSERTIONS = 19500;

/** Never drop below this many STRONG (value-pinning) matchers — the strict→loose-swap
 *  tripwire, parallel to MIN_ASSERTIONS, while the drift STRONG_ASSERTION_REGRESSION
 *  guards the precise per-cycle drop. */
export const MIN_STRONG_ASSERTIONS = 18700;

/** Any chain of vitest modifiers sitting between the runner name and the terminal
 *  modifier — `.concurrent`, `.sequential`, `.each(...)`, `.for(...)`, `.extend(...)`.
 *  Written as a generic identifier hop rather than a fixed list so a modifier vitest
 *  adds later cannot open the hole again the day it ships. */
const MODIFIER_CHAIN = String.raw`(?:\.\s*[A-Za-z_$][A-Za-z0-9_$]*\s*(?:\([^()]*\))?\s*)*`;

/** A disabled / focused test marker — any of these in a test file is a red flag.
 *  Three shapes, and the first two are separate for a reason:
 *   - `it`/`test`/`describe`, any modifier chain, then `.skip`/`.only`/`.todo`. The chain
 *     hop is load-bearing: `test.concurrent.skip(` disables a test, and the plain
 *     two-token form never saw it because the alternation requires it/test/describe
 *     IMMEDIATELY before the dot.
 *   - `describe.skipIf(...)` / `describe.runIf(...)`. A conditional SUITE wrapper is the
 *     one perfectly count-preserving disable vitest offers: `describe` is not matched by
 *     TESTCASE_RE, so wrapping a suite in `.skipIf(true)` leaves the case, assertion,
 *     strong-matcher and tautology counts byte-identical while every `it()` inside stops
 *     running — no static floor and no drift ratchet can see it. The it()/test() forms of
 *     skipIf/runIf are deliberately NOT flagged: they are this repo's existing legitimate
 *     per-platform gate (four uses today), and turning an honest `it(` into
 *     `it.runIf(cond)(` REMOVES an `it(` match, so the drift case count already catches
 *     that direction.
 *   - the `xit`/`xdescribe`/`xtest` prefix forms.
 */
const DISABLED_RE = new RegExp(
  String.raw`\b(?:it|test|describe)\s*${MODIFIER_CHAIN}\.\s*(?:skip|only|todo)\b` +
    String.raw`|\bdescribe\s*${MODIFIER_CHAIN}\.\s*(?:skipIf|runIf)\b` +
    String.raw`|\b(?:xit|xdescribe|xtest)\s*\(`,
);
const TESTCASE_RE = /\b(?:it|test)\s*\(/g;
/** An assertion call. Counting these guards the test BODIES (vitest's `expect(`),
 *  so gutting a test's assertions while keeping its `it()` shell is caught even
 *  though the case count is unchanged. */
const ASSERTION_RE = /\bexpect\s*\(/g;
/** A STRONG (value-pinning) matcher: one asserting a SPECIFIC value, content, or
 *  relationship — toBe/toEqual/toContain/toMatch, the ordering comparators, toThrow,
 *  toHaveLength, etc. Counting these catches the count-preserving strict→loose swap the
 *  expect() count alone misses: replacing `toBe(x)` with a weak existence matcher
 *  (toBeDefined/toBeTruthy/toBeUndefined/toBeNull/toBeFalsy) keeps the expect() count
 *  but drops the strong count, surfacing the laundered weakening. Negated specific
 *  matchers (`.not.toContain(`, `.not.toBe(`) count too — they still pin a value; the
 *  weak existence matchers are deliberately excluded. The `\s*\(` anchor stops the
 *  `toBe` alternative from also matching the `toBe`-prefixed weak matchers. */
const STRONG_ASSERTION_RE =
  /\.(?:toBe|toEqual|toStrictEqual|toContain|toContainEqual|toMatch|toMatchObject|toMatchSnapshot|toMatchInlineSnapshot|toThrow|toThrowError|toHaveLength|toHaveProperty|toHaveBeenCalledWith|toHaveReturnedWith|toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual|toBeCloseTo|toBeInstanceOf)\s*\(/g;

export type Finding = {
  severity: "error" | "warning";
  code: string;
  message: string;
  where: string;
};

/** A MAX count of tautological (vacuous) assertions per test suite.
 *  A tautology keeps a STRONG matcher (so STRONG_ASSERTION_RE fires) but makes it
 *  vacuous: the actual value is a literal and equals the expected literal, or both
 *  sides are the same identifier. Set to 0 for the real repo floor; the drift
 *  guard fires on any INCREASE across a cycle. */
export const MAX_TAUTOLOGY_ASSERTIONS = 0;

/** Live loop-state handoff must stay bounded; old cycle detail belongs in git
 *  history or ignored local archives, not in every agent prompt. Counts entries of
 *  BOTH shapes — the legacy "### Cycle result" and the "## AFK Cycle" scaffold the
 *  driver actually writes (bug_0631); counting only the legacy shape let the ledger
 *  grow one scaffold per cycle while this guard reported it within bounds. */
export const MAX_LIVE_LOOP_STATE_ENTRIES = ROTATE_KEEP;

/** Byte ceiling on the live entry section (first cycle heading to EOF), alongside the
 *  entry cap: the count alone let a 15-entry ledger reach ~49 KB against a ≤8-line
 *  per-entry contract nothing enforced (intake c1101bfc). `loop:rotate-state` trims to
 *  the same ceiling, so a red finding here means one entry is itself too long. */
export const MAX_LIVE_LOOP_STATE_ENTRY_BYTES = ROTATE_MAX_ENTRY_BYTES;

/** Matches vacuous assertion patterns the three-count system cannot catch:
 *  (a) literal-bool:   expect(true).toBe(true)  / expect(false).toBe(false)
 *  (b) literal-null:   expect(null).toBe(null)  / expect(undefined).toBe(undefined)
 *  (c) numeric/string literal: expect(42).toBe(42) / expect("x").toBe("x")
 *  (d) identical identifier: expect(foo).toBe(foo) / expect(bar).toEqual(bar)
 *
 *  Uses a backreference (\1) so false positives (expect(true).toBe(false)) are
 *  not matched — the actual and expected must be IDENTICAL. */
const TAUTOLOGY_RE =
  /\bexpect\s*\(\s*(true|false|null|undefined|\d[\d.]*|"[^"]*"|'[^']*'|`[^`]*`|[A-Za-z_$][A-Za-z0-9_$.]*)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/g;
const SOURCE_FILE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const RUNTIME_SOURCE_DIRS = ["src", "bin", "scripts", "agents", "ui/src", "blind-tester"];
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const FORBIDDEN_LEGACY_IMPORT_RE =
  /(?:^|[\\/])(?:cyoa|parser)(?:[\\/]|$)|(?:^|[\\/])(?:cyoa|parser)_(?:generator|validator)(?:\.|$)/i;

/** Detect count-preserving semantic tautologies: assertions that keep a STRONG
 *  matcher (so the strong-matcher count is unchanged) but make it vacuous by
 *  comparing a value to itself. Pure over the given texts. */
export function detectTautologies(files: { path: string; text: string }[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    let m: RegExpExecArray | null;
    const re = new RegExp(TAUTOLOGY_RE.source, TAUTOLOGY_RE.flags);
    while ((m = re.exec(f.text)) !== null) {
      const lineNo = f.text.slice(0, m.index).split("\n").length;
      findings.push({
        severity: "error",
        code: "TAUTOLOGY_ASSERTION",
        message: `vacuous tautology assertion: ${m[0].trim().slice(0, 80)} — actual and expected are identical; this assertion always passes and pins nothing`,
        where: `${f.path}:${lineNo}`,
      });
    }
  }
  return findings;
}

export function countTautologyAssertions(files: { text: string }[]): number {
  return files.reduce((n, f) => {
    const re = new RegExp(TAUTOLOGY_RE.source, TAUTOLOGY_RE.flags);
    return n + (f.text.match(re)?.length ?? 0);
  }, 0);
}

export function detectLoopStateOverflow(
  text: string,
  keep: number = MAX_LIVE_LOOP_STATE_ENTRIES,
  where: string = LOOP_STATE_FILE,
  maxBytes: number = MAX_LIVE_LOOP_STATE_ENTRY_BYTES,
): Finding[] {
  const findings: Finding[] = [];
  const entries = countLiveEntries(text);
  if (entries > keep) {
    findings.push({
      severity: "error",
      code: "LOOP_STATE_OVER_ROTATED",
      message: `${LOOP_STATE_FILE} carries ${entries} live cycle entries; limit is ${keep}. Rotate before committing (npm run loop:rotate-state) so old detail stays in git history or ignored local archives instead of every agent context.`,
      where,
    });
  }
  const bytes = liveEntryBytes(text);
  if (bytes > maxBytes) {
    findings.push({
      severity: "error",
      code: "LOOP_STATE_OVER_BYTES",
      message: `${LOOP_STATE_FILE} carries ${bytes} bytes of live cycle entries; limit is ${maxBytes}. Rotate before committing (npm run loop:rotate-state); if one entry alone exceeds the limit, shorten it to the ledger's terse contract.`,
      where,
    });
  }
  return findings;
}

export function detectForbiddenPathPatterns(
  paths: string[],
  patterns: readonly string[] = FORBIDDEN_PATH_PATTERNS,
): Finding[] {
  const compiled = patterns.map((pattern) => ({ pattern, re: new RegExp(pattern) }));
  const findings: Finding[] = [];
  for (const path of paths) {
    for (const { pattern, re } of compiled) {
      if (!re.test(path)) continue;
      findings.push({
        severity: "error",
        code: "FORBIDDEN_PATH_PATTERN",
        message: `legacy CYOA/parser test family must not reappear in the RPG-only runtime: ${path} matches ${pattern}`,
        where: path,
      });
      break;
    }
  }
  return findings;
}

export function detectForbiddenTrackedFiles(
  trackedPaths: string[],
  forbidden: readonly string[] = FORBIDDEN_TRACKED_FILES,
): Finding[] {
  const forbiddenSet = new Set(forbidden);
  return trackedPaths
    .filter((path) =>
      forbidden.some((forbiddenPath) =>
        forbiddenPath.endsWith("/")
          ? path === forbiddenPath.slice(0, -1) || path.startsWith(forbiddenPath)
          : forbiddenSet.has(path),
      ),
    )
    .map((path) => ({
      severity: "error" as const,
      code: "FORBIDDEN_TRACKED_FILE",
      message: `token-heavy local artifact must stay ignored and untracked: ${path}`,
      where: path,
    }));
}

export function detectForbiddenLegacyImports(files: { path: string; text: string }[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    for (const hit of importSpecifiers(f.text)) {
      const specifier = hit.specifier;
      if (!FORBIDDEN_LEGACY_IMPORT_RE.test(specifier)) continue;
      const lineNo = f.text.slice(0, hit.index).split("\n").length;
      findings.push({
        severity: "error",
        code: "FORBIDDEN_LEGACY_IMPORT",
        message: `live source must not import retired CYOA/parser modules in the RPG-only runtime: ${specifier}`,
        where: `${f.path}:${lineNo}`,
      });
    }
  }
  return findings;
}

function importSpecifiers(text: string): { specifier: string; index: number }[] {
  const hits: { specifier: string; index: number }[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let pending: { text: string; index: number } | null = null;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const lineOffset = offset;
    offset += line.length + 1;

    if (!trimmed.startsWith("//")) {
      let dynamic: RegExpExecArray | null;
      const dynamicRe = new RegExp(DYNAMIC_IMPORT_RE.source, DYNAMIC_IMPORT_RE.flags);
      while ((dynamic = dynamicRe.exec(line)) !== null) {
        hits.push({ specifier: dynamic[1]!, index: lineOffset + dynamic.index });
      }
    }

    if (pending === null) {
      if (trimmed.startsWith("//")) continue;
      if (!/^(?:import\b(?!\s*\()|export\s+(?:\*|\{))/.test(trimmed)) continue;
      pending = { text: line, index: lineOffset };
    } else {
      pending.text += `\n${line}`;
    }

    const sideEffectImport = /^\s*import\s+["']([^"']+)["']/.exec(pending.text);
    const fromImport = /\bfrom\s+["']([^"']+)["']/.exec(pending.text);
    const specifier = sideEffectImport?.[1] ?? fromImport?.[1];
    if (specifier !== undefined) {
      hits.push({ specifier, index: pending.index });
      pending = null;
      continue;
    }
    if (/;\s*(?:\/\/.*)?$/.test(line)) pending = null;
  }

  return hits;
}

function listFiles(root: string, dir: string, match: (p: string) => boolean): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && match(p)) out.push(relative(root, p).replaceAll("\\", "/"));
    }
  };
  walk(abs);
  return out.sort();
}

export function listTestFiles(root: string): string[] {
  return listFiles(root, "tests", (p) => /\.test\.ts$/.test(p));
}

export function listRuntimeSourceFiles(root: string): string[] {
  return [
    ...new Set(
      RUNTIME_SOURCE_DIRS.flatMap((dir) => listFiles(root, dir, (p) => SOURCE_FILE_RE.test(p))),
    ),
  ].sort();
}

/**
 * The vitest config is the last input to the bar that nothing here used to read, and it
 * is the one that decides which of the discovered test files each project actually RUNS.
 * It is not under tests/ (so no count and no disabled-marker scan sees it), not in the
 * tsconfig include list (so the typecheck skips it), and not in the lint/format targets.
 * Appending one glob to a project exclude array therefore drops hundreds of files from
 * every shard while all four counters stay byte-identical, DISABLED_RE finds nothing,
 * and the shards still exit 0 — vitest silently ignores a per-file filter that matches
 * no project include, and the shard step can only assert that ci-test-groups.ts (a plain
 * readdir walk, independent of this config) produced a non-empty list.
 *
 * The three functions below close that hole by reading the config as TEXT — a pure
 * regex/brace parse, no eval and no import, matching parseGuardConstants — and asserting
 * the single invariant that matters: every file listTestFiles finds is RUN by at least
 * one project. They fail CLOSED: a config this parser cannot read is an error, never a
 * silent skip, because a silent skip here is indistinguishable from the attack.
 */
export const VITEST_CONFIG_FILE = "vitest.config.ts";

export type VitestSuiteProject = { name: string; include: string[]; exclude: string[] };

/** Comments are stripped before the structural parse so a brace or bracket inside prose
 *  cannot throw off depth counting. Deliberately a character scanner rather than two
 *  regex passes: the suite include glob is `tests/**` + `/*.test.ts`, whose middle is a
 *  literal `/**` + `/` — a regex block-comment strip eats it out of the string and turns
 *  the broadest include in the file into a pattern that matches nothing. String literals
 *  are copied through verbatim, escapes included. */
function stripTsComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      i += 1;
      while (i < text.length) {
        const inner = text[i]!;
        out += inner;
        i += 1;
        if (inner === "\\") {
          out += text[i] ?? "";
          i += 1;
          continue;
        }
        if (inner === ch) break;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Minimal glob → RegExp over the vocabulary this config actually uses: `**` spanning
 *  whole directory segments, `*` within one segment, and literal path text. Returns null
 *  for anything richer (character classes, braces, extglobs) rather than guessing — the
 *  caller turns that null into a hard error, so an unreadable filter can never be read
 *  as a matching one. */
function globToRegExp(glob: string): RegExp | null {
  if (/[?[\]{}()!+@]/.test(glob)) return null;
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch !== "*") {
      out += /[A-Za-z0-9_/-]/.test(ch) ? ch : `\\${ch}`;
      continue;
    }
    if (glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") {
        i += 1;
        out += "(?:[^/]+/)*";
      } else {
        out += ".*";
      }
    } else {
      out += "[^/]*";
    }
  }
  return new RegExp(`${out}$`);
}

function sliceBalanced(text: string, open: number, openCh: string, closeCh: string): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** The brace-balanced object literals at the top level of the given array body. */
function topLevelObjects(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(body.slice(start + 1, i));
        start = -1;
      }
    }
  }
  return depth === 0 ? out : [];
}

/**
 * Pure parse of the vitest config TEXT into each project's include/exclude filter lists,
 * resolving the module-level `const` bindings the config uses to name them. Returns null
 * if any part cannot be read — an unparseable config is a fail-closed error upstream, not
 * an assumed-healthy one.
 */
export function parseVitestSuiteProjects(configText: string): VitestSuiteProject[] | null {
  const text = stripTsComments(configText);
  const declarations = new Map<string, string>();
  const declRe =
    /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*("(?:[^"\\]|\\.)*"|\[[^\]]*\])\s*(?:as\s+const\s*)?;/g;
  let decl: RegExpExecArray | null;
  while ((decl = declRe.exec(text)) !== null) declarations.set(decl[1]!, decl[2]!);

  // Element commas are split outside string literals: a glob may legitimately contain a
  // comma (`*.{test,spec}.ts`), and a naive split would tear it into halves that then
  // fail to parse — inside runStatic that would be a thrown SyntaxError, i.e. a crashed
  // bar rather than the clean fail-closed finding this check promises.
  const splitElements = (body: string): string[] => {
    const parts: string[] = [];
    let current = "";
    let quote: string | null = null;
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i]!;
      if (quote !== null) {
        current += ch;
        if (ch === "\\") {
          current += body[i + 1] ?? "";
          i += 1;
        } else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === ",") {
        parts.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
    parts.push(current);
    return parts;
  };
  const stringLiteral = (part: string): string | null => {
    const quote = part[0];
    if (part.length < 2 || (quote !== '"' && quote !== "'" && quote !== "`")) return null;
    if (part[part.length - 1] !== quote) return null;
    if (quote !== '"') return part.slice(1, -1);
    try {
      return JSON.parse(part) as string;
    } catch {
      return null;
    }
  };

  const resolveExpression = (expression: string, seen: Set<string>): string[] | null => {
    const trimmed = expression.trim();
    if (/^["'`]/.test(trimmed)) {
      const literal = stringLiteral(trimmed);
      return literal === null ? null : [literal];
    }
    if (trimmed.startsWith("[")) {
      const out: string[] = [];
      for (const rawPart of splitElements(trimmed.slice(1, -1))) {
        const part = rawPart.trim();
        if (part === "") continue;
        const nested = resolveExpression(part.startsWith("...") ? part.slice(3) : part, seen);
        if (nested === null) return null;
        out.push(...nested);
      }
      return out;
    }
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed)) return null;
    // A cycle would otherwise recurse forever; an unknown identifier is unresolvable.
    if (seen.has(trimmed)) return null;
    const declaration = declarations.get(trimmed);
    if (declaration === undefined) return null;
    return resolveExpression(declaration, new Set([...seen, trimmed]));
  };

  const projectsKey = text.indexOf("projects:");
  if (projectsKey < 0) return null;
  const arrayStart = text.indexOf("[", projectsKey);
  if (arrayStart < 0) return null;
  const body = sliceBalanced(text, arrayStart, "[", "]");
  if (body === null) return null;

  const projects: VitestSuiteProject[] = [];
  const chunks = topLevelObjects(body);
  if (chunks.length === 0) return null;
  for (const [index, chunk] of chunks.entries()) {
    const filterRe = (key: string): RegExpExecArray | null =>
      new RegExp(`\\b${key}:\\s*(\\[[^\\]]*\\]|[A-Za-z_$][A-Za-z0-9_$]*)`).exec(chunk);
    const includeExpression = filterRe("include");
    // A project with no include falls back to the vitest default glob, which this parser
    // cannot reason about; refuse rather than assume it covers everything.
    if (includeExpression === null) return null;
    const include = resolveExpression(includeExpression[1]!, new Set());
    if (include === null) return null;
    const excludeExpression = filterRe("exclude");
    const exclude =
      excludeExpression === null ? [] : resolveExpression(excludeExpression[1]!, new Set());
    if (exclude === null) return null;
    projects.push({
      name: /\bname:\s*"([^"]*)"/.exec(chunk)?.[1] ?? `project ${index}`,
      include,
      exclude,
    });
  }
  return projects;
}

/**
 * Every discovered test file must be RUN by at least one vitest project, and every
 * literal (non-glob) filter entry must name a file that still exists. The first catches
 * the silent-shrink attack (a widened exclude, a narrowed include); the second catches
 * its accidental twin, where a renamed proof leaves a dead pin behind and its dedicated
 * project quietly runs nothing. Pure: config text and file list in, findings out.
 */
export function detectSuiteCoverage(configText: string, testPaths: string[]): Finding[] {
  const unreadable = (detail: string): Finding[] => [
    {
      severity: "error",
      code: "SUITE_CONFIG_UNREADABLE",
      message: `cannot read the vitest project filters in ${VITEST_CONFIG_FILE} (${detail}), so the guard cannot prove the suite still runs every test file — this check fails closed because a silent skip here is indistinguishable from the exclude-glob attack it exists to catch`,
      where: VITEST_CONFIG_FILE,
    },
  ];
  const projects = parseVitestSuiteProjects(configText);
  if (projects === null || projects.length === 0) return unreadable("no project filters parsed");

  const findings: Finding[] = [];
  const known = new Set(testPaths);
  const compiled: { name: string; include: RegExp[]; exclude: RegExp[] }[] = [];
  for (const project of projects) {
    const compiledFilters: Record<"include" | "exclude", RegExp[]> = { include: [], exclude: [] };
    for (const kind of ["include", "exclude"] as const) {
      for (const pattern of project[kind]) {
        const re = globToRegExp(pattern);
        if (re === null) return unreadable(`unsupported ${kind} pattern ${pattern}`);
        compiledFilters[kind].push(re);
        if (!pattern.includes("*") && !known.has(pattern))
          findings.push({
            severity: "error",
            code: "SUITE_FILTER_STALE",
            message: `vitest project ${project.name} ${kind}s ${pattern}, which is not a test file in this tree — a filter pinned to a renamed or deleted file silently stops selecting anything`,
            where: VITEST_CONFIG_FILE,
          });
      }
    }
    compiled.push({
      name: project.name,
      include: compiledFilters.include,
      exclude: compiledFilters.exclude,
    });
  }

  const unclaimed = testPaths.filter(
    (path) =>
      !compiled.some(
        (project) =>
          project.include.some((re) => re.test(path)) &&
          !project.exclude.some((re) => re.test(path)),
      ),
  );
  if (unclaimed.length > 0)
    findings.push({
      severity: "error",
      code: "SUITE_FILE_UNCLAIMED",
      message: `${unclaimed.length} test file(s) are matched by no vitest project and therefore never run, while every shard still reports green: ${unclaimed.slice(0, 5).join(", ")}${unclaimed.length > 5 ? ", …" : ""}`,
      where: VITEST_CONFIG_FILE,
    });
  return findings;
}

/** Test files that contain a disabled/focused marker. Pure over the given texts. */
export function detectDisabledTests(files: { path: string; text: string }[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files) {
    f.text.split("\n").forEach((line, i) => {
      if (DISABLED_RE.test(line)) {
        findings.push({
          severity: "error",
          code: "TEST_DISABLED",
          message: `disabled/focused test marker: ${line.trim().slice(0, 80)}`,
          where: `${f.path}:${i + 1}`,
        });
      }
    });
  }
  return findings;
}

export function countTestCases(files: { text: string }[]): number {
  return files.reduce((n, f) => n + (f.text.match(TESTCASE_RE)?.length ?? 0), 0);
}

export function countAssertions(files: { text: string }[]): number {
  return files.reduce((n, f) => n + (f.text.match(ASSERTION_RE)?.length ?? 0), 0);
}

export function countStrongAssertions(files: { text: string }[]): number {
  return files.reduce((n, f) => n + (f.text.match(STRONG_ASSERTION_RE)?.length ?? 0), 0);
}

export function readAll(root: string, paths: string[]): { path: string; text: string }[] {
  return paths.map((p) => ({ path: p, text: readFileSync(join(root, p), "utf8") }));
}

function windowsPathToWslPath(path: string): string | null {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(path);
  if (!m) return null;
  return `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replaceAll("\\", "/")}`;
}

function gitTrackedFiles(root: string, paths: string[]): string[] {
  if (paths.length === 0) return [];
  try {
    return execFileSync("git", ["ls-files", "--", ...paths], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    const gitFile = join(root, ".git");
    if (!existsSync(gitFile)) return [];
    const gitDirLine = readFileSync(gitFile, "utf8").trim();
    const rawGitDir = /^gitdir:\s*(.+)$/i.exec(gitDirLine)?.[1];
    const gitDir = rawGitDir ? (windowsPathToWslPath(rawGitDir) ?? rawGitDir) : null;
    if (!gitDir || !existsSync(gitDir)) return [];
    try {
      return execFileSync(
        "git",
        ["--git-dir", gitDir, "--work-tree", root, "ls-files", "--", ...paths],
        {
          cwd: root,
          encoding: "utf8",
        },
      )
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

/** Static integrity: protected files present, no disabled tests, count above floor. */
export function runStatic(root: string): { ok: boolean; findings: Finding[] } {
  const findings: Finding[] = [];
  for (const f of PROTECTED_FILES) {
    if (!existsSync(join(root, f)))
      findings.push({
        severity: "error",
        code: "PROTECTED_MISSING",
        message: `protected verification asset is missing: ${f}`,
        where: f,
      });
  }
  for (const f of FORBIDDEN_FILES) {
    if (existsSync(join(root, f)))
      findings.push({
        severity: "error",
        code: "FORBIDDEN_FILE_PRESENT",
        message: `legacy file must not reappear in the RPG-only runtime: ${f}`,
        where: f,
      });
  }
  findings.push(...detectForbiddenTrackedFiles(gitTrackedFiles(root, FORBIDDEN_TRACKED_FILES)));
  const sourceFiles = readAll(root, listRuntimeSourceFiles(root));
  findings.push(...detectForbiddenLegacyImports(sourceFiles));
  const testPaths = listTestFiles(root);
  findings.push(...detectForbiddenPathPatterns(testPaths));
  // The suite-coverage check belongs in STATIC mode, not just drift: `npm run health`
  // runs static only, and a config that quietly stops running most of the suite is
  // exactly the kind of green-but-hollow bar this guard exists to prevent. Skipped only
  // when the config is absent, which PROTECTED_MISSING has already reported as an error.
  const vitestConfig = join(root, VITEST_CONFIG_FILE);
  if (existsSync(vitestConfig))
    findings.push(...detectSuiteCoverage(readFileSync(vitestConfig, "utf8"), testPaths));
  const testFiles = readAll(root, testPaths);
  findings.push(...detectDisabledTests(testFiles));
  const cases = countTestCases(testFiles);
  if (cases < MIN_TEST_CASES) {
    findings.push({
      severity: "error",
      code: "TEST_COUNT_FLOOR",
      message: `only ${cases} test cases found; floor is ${MIN_TEST_CASES} (tests may have been removed)`,
      where: "tests/",
    });
  }
  const assertions = countAssertions(testFiles);
  if (assertions < MIN_ASSERTIONS) {
    findings.push({
      severity: "error",
      code: "ASSERTION_COUNT_FLOOR",
      message: `only ${assertions} expect() assertions found; floor is ${MIN_ASSERTIONS} (test bodies may have been gutted while keeping their it() shells)`,
      where: "tests/",
    });
  }
  const strong = countStrongAssertions(testFiles);
  if (strong < MIN_STRONG_ASSERTIONS) {
    findings.push({
      severity: "error",
      code: "STRONG_ASSERTION_FLOOR",
      message: `only ${strong} strong (value-pinning) matchers found; floor is ${MIN_STRONG_ASSERTIONS} (strict asserts may have been swapped for loose existence checks)`,
      where: "tests/",
    });
  }
  findings.push(...detectTautologies(testFiles));
  const tautologies = countTautologyAssertions(testFiles);
  if (tautologies > MAX_TAUTOLOGY_ASSERTIONS) {
    findings.push({
      severity: "error",
      code: "TAUTOLOGY_FLOOR",
      message: `${tautologies} tautological assertion(s) found; floor is ${MAX_TAUTOLOGY_ASSERTIONS} (vacuous expect(x).toBe(x) patterns keep the strong-matcher count but assert nothing)`,
      where: "tests/",
    });
  }
  const loopState = join(root, LOOP_STATE_FILE);
  if (existsSync(loopState)) {
    findings.push(...detectLoopStateOverflow(readFileSync(loopState, "utf8")));
  }
  return { ok: !findings.some((f) => f.severity === "error"), findings };
}

function gitChangedFiles(root: string, ref: string): string[] {
  // Tracked changes vs ref (incl. working tree + deletions) plus untracked files.
  const tracked = execFileSync("git", ["diff", "--name-only", ref, "--"], {
    cwd: root,
    encoding: "utf8",
  });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  return [
    ...new Set(
      [...tracked.split("\n"), ...untracked.split("\n")].map((s) => s.trim()).filter(Boolean),
    ),
  ];
}

/**
 * Classify what a cycle's changed-file set means for verifier integrity. PURE
 * (testable without git). The severity model follows current reward-hacking
 * research (EvilGenie arXiv:2511.21654; METR 2025-06; Anthropic long-running-agents
 * 2025-11) + snapshot/approval-testing practice (Jest, cargo-insta):
 *
 *  - A pinned hash / snapshot is a CHANGE-DETECTOR, not a correctness oracle, and is
 *    *meant* to be updated when the artifact intentionally changes. So re-pinning a
 *    hash that is ACCOMPANIED by a real content change is the legitimate workflow →
 *    a surfaced WARNING (recorded for review, does not block). The behavioral test
 *    suite — which must be green — is the real guard.
 *  - A re-pin UNACCOMPANIED by any content change is the "regenerate to make red go
 *    green" launder pattern → a hard ERROR.
 *  - Modifying (not deleting) a protected verification file is surfaced (WARNING):
 *    the agent has free rein over code, and the mechanical weakening it must NOT do
 *    (disable/delete tests, drop the count) is caught by the static checks + the
 *    drift count-regression check, both hard errors.
 *  - Deleting a protected verification asset → hard ERROR.
 */
export function classifyDrift(changed: string[], existsFn: (rel: string) => boolean): Finding[] {
  const findings: Finding[] = [];
  const changedSet = new Set(changed);
  for (const f of changed) {
    if (PROTECTED_FILES.includes(f)) {
      if (!existsFn(f))
        findings.push({
          severity: "error",
          code: "PROTECTED_DELETED",
          message: `a protected verification asset was deleted this cycle: ${f}`,
          where: f,
        });
      else
        findings.push({
          severity: "warning",
          code: "VERIFIER_TOUCHED",
          message: `this cycle modified a protected verification asset: ${f} — surfaced for review (the static + count-regression checks guard against weakening)`,
          where: f,
        });
    }
    if (HASH_PIN_FILES.includes(f) && existsFn(f)) {
      const relatedSources = HASH_PIN_CONTENT_SOURCE_SCOPES.flatMap((entry) => {
        const separator = entry.indexOf("=>");
        const source = separator >= 0 ? entry.slice(separator + 2) : "";
        return entry.slice(0, separator) === f && source.startsWith("content/") ? [source] : [];
      });
      const changedRelatedSources = relatedSources.filter((source) => changedSet.has(source));
      if (changedRelatedSources.length > 0) {
        findings.push({
          severity: "warning",
          code: "HASH_PIN_REPINNED",
          message: `re-pinned ${f} alongside its related content source ${changedRelatedSources.join(", ")} — the legitimate snapshot-update workflow, recorded for review`,
          where: f,
        });
      } else {
        findings.push({
          severity: "error",
          code: "HASH_PIN_UNACCOMPANIED",
          message: `re-pinned ${f} with NO related content source change this cycle — an unrelated content edit cannot justify a snapshot/hash update (override with AI_LOOP_ALLOW_VERIFIER_EDITS=1 for a deliberate algorithm/format change)`,
          where: f,
        });
      }
    }
  }
  return findings;
}

export type TestArtifactCounts = {
  cases: number;
  assertions: number;
  strong?: number;
  tautologies?: number;
};

/**
 * Pure regression detector: a cycle must not REDUCE the test-case count, the assertion
 * count, NOR the strong-matcher count vs the pre-cycle ref. The three counts close
 * three nested launders:
 *   - dropping `cases` = removing/skipping tests (TEST_COUNT_REGRESSION).
 *   - holding `cases` but dropping `assertions` = gutting a body of its expect()s while
 *     keeping its it() shell (ASSERTION_COUNT_REGRESSION).
 *   - holding both but dropping `strong` = swapping a strict matcher for a loose
 *     existence check (toBe(x) → toBeDefined()) — the body still asserts, but no longer
 *     pins a value (STRONG_ASSERTION_REGRESSION).
 *   - holding all three but adding `tautologies` = preserving a strong matcher while
 *     making it vacuous (expect(x).toBe(x)), which asserts nothing
 *     (TAUTOLOGY_REGRESSION).
 * `strong` is optional so legacy {cases, assertions} call sites stay valid; the strong
 * guard only fires when both before/now supply it (runDrift always does). `tautologies`
 * is likewise optional for legacy callers and only fires when both sides supply it.
 * Pure (counts in, findings out) so it unit-tests on synthetic numbers, mirroring
 * classifyDrift.
 */
export function detectCountRegressions(
  before: TestArtifactCounts,
  now: TestArtifactCounts,
): Finding[] {
  const findings: Finding[] = [];
  if (now.cases < before.cases)
    findings.push({
      severity: "error",
      code: "TEST_COUNT_REGRESSION",
      message: `test cases dropped from ${before.cases} to ${now.cases} this cycle — tests were removed/skipped (weakening the verifier is not allowed)`,
      where: "tests/",
    });
  if (now.assertions < before.assertions)
    findings.push({
      severity: "error",
      code: "ASSERTION_COUNT_REGRESSION",
      message: `expect() assertions dropped from ${before.assertions} to ${now.assertions} this cycle — a test body was gutted of its assertions (weakening the verifier is not allowed)`,
      where: "tests/",
    });
  if (before.strong !== undefined && now.strong !== undefined && now.strong < before.strong)
    findings.push({
      severity: "error",
      code: "STRONG_ASSERTION_REGRESSION",
      message: `strong (value-pinning) matchers dropped from ${before.strong} to ${now.strong} this cycle — a strict assertion was swapped for a loose existence check (toBe(x) → toBeDefined()); weakening the verifier is not allowed`,
      where: "tests/",
    });
  if (
    before.tautologies !== undefined &&
    now.tautologies !== undefined &&
    now.tautologies > before.tautologies
  )
    findings.push({
      severity: "error",
      code: "TAUTOLOGY_REGRESSION",
      message: `tautological assertions increased from ${before.tautologies} to ${now.tautologies} this cycle — a vacuous expect(x).toBe(x) was introduced`,
      where: "tests/",
    });
  return findings;
}

/**
 * The guard's OWN defensive surface: the floors and protected/hash-pin lists this
 * script enforces. Locking these closes the DGM-class launder where an agent tasked
 * to pass a checker simply edits the checker — deletes the marker it scans for, or
 * lowers the floor it compares against (Darwin Gödel Machine, arXiv:2505.22954;
 * EvilGenie, arXiv:2511.21654; agentic-self-learning, arXiv:2510.14253). The docstring
 * (lines 33–35) concedes this exact hole; `detectGuardWeakening` turns it from a
 * non-blocking VERIFIER_TOUCHED warning into a hard error when the surface SHRINKS.
 */
export type GuardConstants = {
  minTestCases: number;
  minAssertions: number;
  minStrongAssertions: number;
  maxTautologyAssertions?: number;
  protectedFiles: string[];
  forbiddenFiles: string[];
  forbiddenTrackedFiles: string[];
  forbiddenPathPatterns: string[];
  hashPinFiles: string[];
  /** Undefined is the legacy pre-scope behavior where any `content/` edit
   * justified every pin. A present list is the tightened exact relationship set. */
  hashPinContentSourceScopes?: string[];
};

/**
 * Pure parser over the TEXT of verify-integrity.ts. Extracts the three MIN_* floors,
 * protected/hash-pin lists, and exact hash-pin source relationships by regex/string
 * parsing only (NO eval, no fs/git/network/clock/RNG) so it is deterministic and
 * unit-tests on synthetic input.
 * Returns null if any required legacy field cannot be parsed. The newer source-scope
 * declaration is optional only so a pre-scope baseline can be represented as the
 * legacy wildcard and compared as a tightening, rather than becoming unreadable.
 */
export function parseGuardConstants(text: string): GuardConstants | null {
  // An optional `: Type` annotation is tolerated on both forms. Without it, writing
  // `export const MIN_TEST_CASES: number = 100;` made this parser return null — which
  // (before runDrift learned to fail closed on that) disarmed detectGuardWeakening
  // entirely while runStatic went on enforcing the lowered floor from the real binding.
  const num = (name: string): number | null => {
    const m = new RegExp(`export const ${name}\\s*(?::[^=;]*)?=\\s*(\\d+)`).exec(text);
    return m ? Number(m[1]) : null;
  };
  const arr = (name: string): string[] | null => {
    const m = new RegExp(`export const ${name}\\s*(?::[^=;]*)?=\\s*\\[([\\s\\S]*?)\\]`).exec(text);
    if (!m) return null;
    const entries = m[1]!.match(/"([^"]*)"|'([^']*)'/g);
    // An explicitly empty array is a real (and, for pin source scopes,
    // maximally strict) configuration. Only an absent declaration is null.
    if (!entries) return [];
    return entries.map((e) =>
      e.startsWith('"') ? (JSON.parse(e) as string) : e.slice(1, -1).replace(/\\\\/g, "\\"),
    );
  };
  const minTestCases = num("MIN_TEST_CASES");
  const minAssertions = num("MIN_ASSERTIONS");
  const minStrongAssertions = num("MIN_STRONG_ASSERTIONS");
  const maxTautologyAssertions = num("MAX_TAUTOLOGY_ASSERTIONS");
  const protectedFiles = arr("PROTECTED_FILES");
  const forbiddenFiles = arr("FORBIDDEN_FILES") ?? [];
  const forbiddenTrackedFiles = arr("FORBIDDEN_TRACKED_FILES") ?? [];
  const forbiddenPathPatterns = arr("FORBIDDEN_PATH_PATTERNS") ?? [];
  const hashPinFiles = arr("HASH_PIN_FILES");
  const hashPinContentSourceScopes = arr("HASH_PIN_CONTENT_SOURCE_SCOPES");
  if (
    minTestCases === null ||
    minAssertions === null ||
    minStrongAssertions === null ||
    protectedFiles === null ||
    hashPinFiles === null
  )
    return null;
  const result: GuardConstants = {
    minTestCases,
    minAssertions,
    minStrongAssertions,
    protectedFiles,
    forbiddenFiles,
    forbiddenTrackedFiles,
    forbiddenPathPatterns,
    hashPinFiles,
  };
  if (maxTautologyAssertions !== null) result.maxTautologyAssertions = maxTautologyAssertions;
  if (hashPinContentSourceScopes !== null)
    result.hashPinContentSourceScopes = hashPinContentSourceScopes;
  return result;
}

/**
 * Pure comparator (mirrors detectCountRegressions / classifyDrift: synthetic structs in,
 * findings out; no git/fs/network/clock/RNG). Emits a single severity:"error",
 * code:"GUARD_WEAKENED" finding when the guard's defensive surface SHRINKS across a cycle:
 *   - any MIN_* floor is LOWERED (now.minX < before.minX), or
 *   - any entry is REMOVED from protectedFiles or hashPinFiles, or
 *   - any automatic hash-pin content scope is ADDED (widening justification).
 * Raising a floor, adding an entry, and identical constants are all OK (no finding). The
 * message names exactly what was weakened and mentions the AI_LOOP_ALLOW_VERIFIER_EDITS=1
 * override (a deliberate, acknowledged loosening is allowed; a silent one is not).
 */
export function detectGuardWeakening(before: GuardConstants, now: GuardConstants): Finding[] {
  const weakened: string[] = [];
  if (now.minTestCases < before.minTestCases)
    weakened.push(`MIN_TEST_CASES lowered ${before.minTestCases} → ${now.minTestCases}`);
  if (now.minAssertions < before.minAssertions)
    weakened.push(`MIN_ASSERTIONS lowered ${before.minAssertions} → ${now.minAssertions}`);
  if (now.minStrongAssertions < before.minStrongAssertions)
    weakened.push(
      `MIN_STRONG_ASSERTIONS lowered ${before.minStrongAssertions} → ${now.minStrongAssertions}`,
    );
  if (
    before.maxTautologyAssertions !== undefined &&
    now.maxTautologyAssertions !== undefined &&
    now.maxTautologyAssertions > before.maxTautologyAssertions
  )
    weakened.push(
      `MAX_TAUTOLOGY_ASSERTIONS raised ${before.maxTautologyAssertions} → ${now.maxTautologyAssertions}`,
    );
  const removedFrom = (name: string, was: string[], is: string[]): void => {
    const nowSet = new Set(is);
    for (const entry of was)
      if (!nowSet.has(entry)) weakened.push(`${name} entry removed: ${entry}`);
  };
  const nowProtected = new Set(now.protectedFiles);
  const nowForbidden = new Set(now.forbiddenFiles);
  for (const entry of before.protectedFiles)
    if (!nowProtected.has(entry) && !nowForbidden.has(entry))
      weakened.push(`PROTECTED_FILES entry removed: ${entry}`);
  removedFrom("FORBIDDEN_FILES", before.forbiddenFiles, now.forbiddenFiles);
  removedFrom("FORBIDDEN_TRACKED_FILES", before.forbiddenTrackedFiles, now.forbiddenTrackedFiles);
  removedFrom("FORBIDDEN_PATH_PATTERNS", before.forbiddenPathPatterns, now.forbiddenPathPatterns);
  removedFrom("HASH_PIN_FILES", before.hashPinFiles, now.hashPinFiles);
  if (before.hashPinContentSourceScopes !== undefined) {
    if (now.hashPinContentSourceScopes === undefined) {
      weakened.push(
        "HASH_PIN_CONTENT_SOURCE_SCOPES removed (restores the legacy any-content wildcard)",
      );
    } else {
      const beforeScopes = new Set(before.hashPinContentSourceScopes);
      for (const entry of now.hashPinContentSourceScopes)
        if (!beforeScopes.has(entry))
          weakened.push(`HASH_PIN_CONTENT_SOURCE_SCOPES entry added: ${entry}`);
    }
  }
  if (weakened.length === 0) return [];
  return [
    {
      severity: "error",
      code: "GUARD_WEAKENED",
      message: `the verifier guard's own defensive surface was weakened this cycle: ${weakened.join("; ")} — lowering a floor or shrinking a protected/hash-pin list is the DGM "edit-the-checker" launder (override with AI_LOOP_ALLOW_VERIFIER_EDITS=1 for a deliberate, acknowledged loosening)`,
      where: "scripts/verify-integrity.ts",
    },
  ];
}

/** Count test cases AND expect() assertions as they were at a git ref, in a single
 *  pass over the ref's test files (null if the ref can't be read). Reads every test
 *  blob through ONE `git cat-file --batch` pass instead of spawning one `git show`
 *  per file: the per-file subprocess cost dominated runDrift (~280 spawns/call, two
 *  minutes on a slow/network filesystem) and the loop runs this every cycle. The bytes
 *  fed to the counters are byte-for-byte the blob content, so the counts are identical. */
function countTestArtifactsAtRef(root: string, ref: string): TestArtifactCounts | null {
  try {
    // `ls-tree -r` (no --name-only) yields "<mode> blob <oid>\t<path>" so we can batch
    // the reads by object id without re-resolving each <ref>:<path> spec.
    const listed = execFileSync("git", ["ls-tree", "-r", ref], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const blobs: { oid: string; path: string }[] = [];
    for (const line of listed.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const meta = line.slice(0, tab).split(/\s+/); // [mode, type, oid]
      const path = line.slice(tab + 1);
      if (meta[1] === "blob" && /^tests\/.*\.test\.ts$/.test(path))
        blobs.push({ oid: meta[2]!, path });
    }
    // No test blobs at the ref is UNREADABLE, not a zero corpus. Returning zeros here
    // bypassed the deliberate COUNT_BASELINE_UNREADABLE error below and made every
    // count-regression comparison trivially pass (now >= 0) — the same fail-open shape
    // as the guard-self check above, one layer down.
    if (blobs.length === 0) return null;
    // `cat-file --batch` emits, per requested object: "<oid> <type> <size>\n" then
    // exactly <size> bytes of content then a trailing "\n". Slice by byte offsets (the
    // size is a byte count) so multi-byte UTF-8 content is reconstructed exactly.
    const batch = execFileSync("git", ["cat-file", "--batch"], {
      cwd: root,
      input: blobs.map((b) => b.oid).join("\n") + "\n",
      maxBuffer: 512 * 1024 * 1024,
    });
    let cases = 0;
    let assertions = 0;
    let strong = 0;
    let tautologies = 0;
    let pos = 0;
    while (pos < batch.length) {
      const nl = batch.indexOf(0x0a, pos);
      if (nl < 0) break;
      const size = Number(batch.toString("utf8", pos, nl).split(" ")[2]);
      const start = nl + 1;
      const text = batch.toString("utf8", start, start + size);
      cases += text.match(TESTCASE_RE)?.length ?? 0;
      assertions += text.match(ASSERTION_RE)?.length ?? 0;
      strong += text.match(STRONG_ASSERTION_RE)?.length ?? 0;
      tautologies += text.match(new RegExp(TAUTOLOGY_RE.source, TAUTOLOGY_RE.flags))?.length ?? 0;
      pos = start + size + 1; // content + the trailing LF the batch format appends
    }
    return { cases, assertions, strong, tautologies };
  } catch {
    return null;
  }
}

/** The guard's OWN defensive constants as they were at a git ref (null if unreadable —
 *  a malformed/absent ref is skipped, never a false alarm). Pure-parse the same source. */
function parseGuardConstantsAtRef(root: string, ref: string): GuardConstants | null {
  try {
    const text = execFileSync("git", ["show", `${ref}:scripts/verify-integrity.ts`], {
      cwd: root,
      encoding: "utf8",
    });
    return parseGuardConstants(text);
  } catch {
    return null;
  }
}

/**
 * Drift check for the autonomous loop: what did THIS cycle (working tree vs `ref`)
 * do to the verifier? = static checks + classifyDrift + a test-count-regression
 * guard + a guard-self-integrity check. AI_LOOP_ALLOW_VERIFIER_EDITS=1 downgrades ONLY
 * the unaccompanied-re-pin error and a deliberately-acknowledged GUARD_WEAKENED; it
 * never downgrades real test weakening (deleted/disabled tests, a dropped count).
 */
export function runDrift(
  root: string,
  ref: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; findings: Finding[] } {
  const findings: Finding[] = [...runStatic(root).findings];
  let changed: string[];
  try {
    changed = gitChangedFiles(root, ref);
  } catch (e) {
    return {
      ok: false,
      findings: [
        ...findings,
        {
          severity: "error",
          code: "GIT_DIFF_FAILED",
          message: `cannot diff against ${ref}: ${(e as Error).message}`,
          where: ref,
        },
      ],
    };
  }
  const acknowledged = env.AI_LOOP_ALLOW_VERIFIER_EDITS === "1";
  // Guard-self-integrity: did this cycle weaken the guard's OWN defensive surface
  // (lower a MIN_* floor, drop a protected/hash-pin entry)? Read the ref's guard text
  // and the working-tree guard text through the SAME pure parser; only compare when
  // BOTH parse non-null (a malformed/absent ref is skipped, never a false alarm).
  const guardBefore = parseGuardConstantsAtRef(root, ref);
  const guardNow = parseGuardConstants(
    readFileSync(join(root, "scripts/verify-integrity.ts"), "utf8"),
  );
  const driftFindings = classifyDrift(changed, (rel) => existsSync(join(root, rel)));
  if (guardBefore !== null && guardNow !== null)
    driftFindings.push(...detectGuardWeakening(guardBefore, guardNow));
  for (const f of driftFindings) {
    // Downgradable errors (only with explicit acknowledgment): an unaccompanied re-pin
    // (a deliberate hash/format re-pin) and a deliberately-acknowledged guard loosening.
    // Real test weakening (deleted/disabled tests, a dropped count) is never downgraded.
    if (acknowledged && (f.code === "HASH_PIN_UNACCOMPANIED" || f.code === "GUARD_WEAKENED"))
      findings.push({ ...f, severity: "warning", message: `${f.message} [acknowledged]` });
    else findings.push(f);
  }
  // Hard guard against silent verification removal even while above the static
  // floors: the cycle must not REDUCE the test-case count, the assertion count, NOR
  // the strong-matcher count vs the pre-cycle ref. The assertion-count check closes
  // the gut-the-body launder (delete a test's expect()s, keep its it() shell); the
  // strong-matcher check closes the strict→loose swap launder (turn `toBe(x)` into
  // `toBeDefined()`) — the expect() count holds but the strong count drops, caught here.
  const before = countTestArtifactsAtRef(root, ref);
  if (before === null) {
    // Previously this was a SILENT skip: any git failure reading the ref — a shallow
    // clone with no history, a bad ref, a maxBuffer overflow — quietly disabled the
    // count-regression check while the run still reported OK. The whole point of drift
    // mode is these three counters, so a guard that cannot run is a failure, not a
    // pass. (Shallow CI checkouts are the realistic cause: fetch-depth: 0 fixes it.)
    findings.push({
      severity: "error",
      code: "COUNT_BASELINE_UNREADABLE",
      message: `cannot read the test corpus at ${ref}, so the count-regression guard could not run (a shallow clone has no history — use fetch-depth: 0)`,
      where: ref,
    });
  } else {
    const nowFiles = readAll(root, listTestFiles(root));
    const now = {
      cases: countTestCases(nowFiles),
      assertions: countAssertions(nowFiles),
      strong: countStrongAssertions(nowFiles),
      tautologies: countTautologyAssertions(nowFiles),
    };
    findings.push(...detectCountRegressions(before, now));
  }
  if (guardBefore === null) {
    // Same reasoning for the guard-weakening half: a ref whose verify-integrity.ts
    // cannot be read means detectGuardWeakening never ran.
    findings.push({
      severity: "error",
      code: "GUARD_BASELINE_UNREADABLE",
      message: `cannot read scripts/verify-integrity.ts at ${ref}, so the guard-weakening check could not run`,
      where: ref,
    });
  }
  if (guardNow === null) {
    // The WORKING-TREE half of the same check, and the half that was fail-OPEN: only the
    // baseline null was ever reported, so a cycle that made its own constants unparseable
    // — a type annotation on a MIN_* floor was enough — skipped detectGuardWeakening with
    // no finding at all and the run said OK, while runStatic imported the real binding and
    // enforced whatever the cycle had lowered it to. The parser is more tolerant now; this
    // is the backstop for every shape it still cannot read.
    findings.push({
      severity: "error",
      code: "GUARD_SELF_UNREADABLE",
      message: `cannot parse the guard constants in the working tree scripts/verify-integrity.ts, so the guard-weakening check could not run — a floor or protected list this parser cannot read is treated as tampering, not as absence of tampering`,
      where: "scripts/verify-integrity.ts",
    });
  }
  return { ok: !findings.some((f) => f.severity === "error"), findings };
}

function format(label: string, res: { ok: boolean; findings: Finding[] }): string {
  const errs = res.findings.filter((f) => f.severity === "error").length;
  const warns = res.findings.filter((f) => f.severity === "warning").length;
  const lines = [
    `verifier-integrity (${label}): ${res.ok ? "OK" : "FAILED"}  (${errs} error(s), ${warns} warning(s))`,
  ];
  for (const f of res.findings)
    lines.push(
      `  [${f.severity === "error" ? "ERROR" : "warn "}] ${f.code}: ${f.message}\n          ${f.where}`,
    );
  return lines.join("\n");
}

function main(): void {
  const root = process.cwd();
  const argv = process.argv.slice(2);
  const againstIdx = argv.indexOf("--against");
  const ref = againstIdx >= 0 ? argv[againstIdx + 1] : undefined;
  const res = ref ? runDrift(root, ref) : runStatic(root);
  console.log(format(ref ? `drift vs ${ref}` : "static", res));
  process.exit(res.ok ? 0 : 1);
}

// Run as CLI only (not when imported by tests). `import.meta.url` ends with this file.
if (
  statSync(process.argv[1] ?? "").isFile() &&
  (process.argv[1] ?? "").endsWith("verify-integrity.ts")
) {
  main();
}
