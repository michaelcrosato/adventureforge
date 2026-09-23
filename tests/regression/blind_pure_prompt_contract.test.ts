import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs module without type declarations
import { classifyCodexGameplayWrapper } from "../../blind-tester/codex-pure-envelope.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { fillPrompt } from "../../blind-tester/fill-prompt.mjs";

const ROOT = process.cwd();
const promptTemplate = readFileSync(join(ROOT, "blind-tester", "prompt-overworld.md"), "utf8");
const sparkPromptTemplate = readFileSync(
  join(ROOT, "blind-tester", "prompt-overworld-spark.md"),
  "utf8",
);
const strictTransport = readFileSync(
  join(ROOT, "blind-tester", "prompt-transports", "strict-code-mode-v2.md"),
  "utf8",
);
const directTransport = readFileSync(
  join(ROOT, "blind-tester", "prompt-transports", "spark-direct-mcp-v1.md"),
  "utf8",
);
const gameDirectTransport = readFileSync(
  join(ROOT, "blind-tester", "prompt-transports", "game-direct-mcp-v1.md"),
  "utf8",
);
const prompt = fillPrompt(promptTemplate, {
  startInstruction: "start",
  seed: 1,
  persona: "",
  transport: strictTransport,
});
const sparkPrompt = fillPrompt(sparkPromptTemplate, {
  startInstruction: "start",
  seed: 1,
  persona: "",
  transport: directTransport,
});
const terraPrompt = fillPrompt(promptTemplate, {
  startInstruction: "start",
  seed: 1,
  persona: "",
  transport: gameDirectTransport,
});
const protocol = readFileSync(join(ROOT, "docs", "blind_playtest_protocol.md"), "utf8");
const readme = readFileSync(join(ROOT, "blind-tester", "README.md"), "utf8");
const rootReadme = readFileSync(join(ROOT, "README.md"), "utf8");
const startingSlice = readFileSync(join(ROOT, "docs", "STARTING_SLICE.md"), "utf8");
const testingPyramid = readFileSync(join(ROOT, "docs", "testing_pyramid.md"), "utf8");
const runner = readFileSync(join(ROOT, "blind-tester", "run.sh"), "utf8");
const mockAgent = readFileSync(join(ROOT, "blind-tester", "mock-agent.mjs"), "utf8");
const CODEX_EXEC_YIELD_PRAGMA = '// @exec: {"yield_time_ms": 120000}';

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function promptBullet(start: string): string {
  const startIndex = prompt.indexOf(start);
  if (startIndex < 0) throw new Error(`Missing prompt bullet: ${start}`);
  const endIndex = prompt.indexOf("\n- ", startIndex + start.length);
  if (endIndex < 0) throw new Error(`Unterminated prompt bullet: ${start}`);
  return normalizeWhitespace(prompt.slice(startIndex, endIndex));
}

function protocolParagraph(marker: string): string {
  const paragraph = protocol.split(/\r?\n\r?\n/).find((block) => block.includes(marker));
  if (!paragraph) throw new Error(`Missing protocol paragraph: ${marker}`);
  return normalizeWhitespace(paragraph);
}

describe("pure blind prompt + runner contract", () => {
  it("documents the exact Terra-direct v9 boundary without rewriting historical v8", () => {
    expect(rootReadme).toContain("game-direct capture receipt v5 (`game-direct-mcp-v1`)");
    expect(rootReadme).toContain(
      "each direct model is\n  launched through its own tracked game-only model catalog",
    );
    expect(rootReadme).toContain("Fleet attestation v9 binds");
    expect(readme).toContain("Terra's live prompt, catalog,\n  and game-direct fragment");
    expect(readme).toContain("`codex-model-catalog-terra-v1.json`");
    expect(readme).toContain("ambient cache contents do not choose shell\nor tool mode");
    expect(readme).toContain("current Codex v9 binds");
    expect(protocol).toContain("Terra-only `game-direct-mcp-v1`");
    expect(protocol).toContain("Current fleet publication uses Codex attestation v9");
    expect(protocol).toContain("Terra's catalog and model-scoped launch record the");
    expect(protocol).toContain('`multi_agent_version: "disabled"`, no\n`multi_agent_mode`');
    expect(protocol).toContain('compatibility-only rollout sentinel `summary: "auto"`');
    expect(protocol).toContain(
      "Responses request omits `reasoning.summary` when that value is `none`",
    );
    expect(protocol).toContain(
      "The verifier also requires every private\nreasoning response item to retain an empty summary array",
    );
    expect(protocol).toMatch(/Strict Terra keeps its\s+v2 team\/mode profile/u);
    expect(protocol).toContain('`comp_hash: "3000"`');
    expect(protocol).toContain(
      "Both direct transports reject every\ninterim assistant message before the one final interview",
    );
    expect(protocol).toContain(
      "fresh live reduced-profile game-direct\ncanary must still confirm the repo-owned override before fleet spend",
    );
    expect(protocol).toContain("Spark's and Terra's tracked player catalogs preload");
    expect(protocol).toContain("There is no cache-derived transport\nfallback");
    expect(protocol).not.toContain("Sol and Terra use the\nv2 `explicitRequestOnly` profile");
    expect(startingSlice).toContain("Current Codex v9 is model-discriminated");
    expect(testingPyramid).toContain("Terra game-direct\ncapture schema v5");

    for (const currentContract of [rootReadme, readme, protocol, startingSlice, testingPyramid]) {
      expect(currentContract).not.toMatch(/current Codex v8/i);
      expect(currentContract).not.toMatch(/Sol, Terra, and\s+Luna use\s+(?:a )?strict/i);
    }
    expect(protocol).toContain("Codex attestations v3-v8\nremain readable historical evidence");
    expect(startingSlice).toContain("transport-bound v8");
  });

  it("pins one non-yielding Codex exec lifecycle without weakening historical evidence", () => {
    const transport = promptBullet(
      "- For every Codex `functions.exec` AdventureForge gameplay wrapper",
    );
    // Do not restore the separated wording that preceded a 32-byte incomplete wrapper.
    expect(transport).not.toBe(
      '- For every Codex `functions.exec` AdventureForge gameplay wrapper, make the first source line exactly `// @exec: {"yield_time_ms": 120000}`. After that comment, use exactly one executable expression: `text(await tools.mcp__adventureforge__<tool>({literalArgs}));`. The tool must be one legal AdventureForge gameplay tool and `{literalArgs}` must be an object literal containing only JSON-valued literals (prefer `{}` for `start_overworld`). A bare `text` forwards nothing. Never call `functions.wait`; the MCP completion and visible output must remain in that single wrapper lifecycle. A truly wedged or yielded wrapper remains an invalid run. The pragma key is spelled `yield_time_ms` exactly (never `yield-time`). Make the next game choice only after you have seen that response.',
    );
    const promptLines = prompt.replace(/\r\n/gu, "\n").split("\n");
    const wrapperFence = promptLines.indexOf("```text");
    expect(promptLines.slice(wrapperFence, wrapperFence + 4)).toEqual([
      "```text",
      CODEX_EXEC_YIELD_PRAGMA,
      "text(await tools.mcp__adventureforge__start_overworld({}));",
      "```",
    ]);
    const displayedSource = `${promptLines.slice(wrapperFence + 1, wrapperFence + 3).join("\n")}\n`;
    expect(Buffer.byteLength(displayedSource, "utf8")).toBe(96);
    expect(
      classifyCodexGameplayWrapper(displayedSource, {
        codeModeContract: "strict-code-mode-v2",
      }),
    ).toMatchObject({ ok: true });
    expect(transport).toContain("exact initial two-line wrapper as one indivisible input");
    expect(transport).toContain(
      "Markdown fence and its `text` language tag below are display-only",
    );
    expect(transport).toContain("first character `/`, last non-newline character `;`");
    expect(transport).toContain(
      "Add no Markdown fence, language label, prose, or literal `functions.exec(...)` call",
    );
    expect(prompt).toContain("Never submit either source line alone");
    expect(prompt).toContain("Add no other comment or executable statement");
    for (const contract of [prompt, protocol, readme]) {
      expect(contract).toContain(CODEX_EXEC_YIELD_PRAGMA);
      expect(contract).toContain("functions.wait");
    }
    expect(protocol).toContain("does not retrofit a pragma requirement onto\nhistorical evidence");
    expect(protocol).toContain(
      "Only schema v1/null-contract evidence retains\n" +
        "the legacy direct-result/content-block renderers; strict v1 requires the exact",
    );
    expect(readme).toContain("Historical evidence is not retroactively required");
  });

  it("contains transport and game-owned exit instructions without guided coverage", () => {
    expect(prompt).toContain("text-based TTRPG for the first time");
    expect(prompt).toContain("PLAY AS A NEW PLAYER");
    expect(prompt).toContain("Use only AdventureForge gameplay actions exposed for this pure run");
    expect(prompt).toContain("text(await tools.mcp__adventureforge__start_overworld({}));");
    expect(prompt).toContain("`yield_time_ms` exactly (never `yield-time`)");
    expect(prompt).toContain("Never submit either source line alone");
    expect(prompt).toContain("only after\n  seeing the response");
    expect(prompt).toContain("mcp__adventureforge__start_overworld");
    expect(prompt).toContain("first **game action**");
    expect(prompt).toContain("with `{}`, an object containing no\n  fields");
    expect(prompt).toMatch(/Make no other\s+pre-game action/);
    expect(prompt).toMatch(/the game could\s+not start/);
    expect(prompt).toContain("Use the `functions.exec` gameplay wrapper below for every call");
    expect(prompt).toContain("contains exactly one `mcp__adventureforge__...` action");
    expect(prompt).toMatch(/`tool_search` is not a gameplay\s+action/);
    for (const forbidden of [
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
      "ToolSearch",
    ]) {
      expect(prompt).not.toContain(forbidden);
    }
    expect(prompt).toContain("current in-game goal");
    expect(prompt).toContain("Keep the initial `legend`");
    expect(prompt).toContain("merge\n  every later `legend_delta` into it by key");
    expect(prompt).toMatch(/same response that first uses\s+it/);
    expect(prompt).toContain("dotted keys such as `result.entry`");
    expect(prompt).toContain("exact nested paths");
    expect(prompt).toContain("game presents its actual journey choice");
    expect(prompt).toContain("If you choose continue");
    expect(prompt).toContain("If you choose end");
    expect(prompt).toContain("mcp__adventureforge__choose_overworld_session_journey");
    expect(prompt).toContain("mcp__adventureforge__follow_overworld_session_goal");
    expect(prompt).not.toContain("advance_overworld_session_goal");
    expect(prompt).toContain("visible `id` value as the tool's `choice`");
    expect(prompt).toContain("`overworld_snapshot_hash`");
    expect(prompt).toContain("state-bearing compact embedded-quest");
    expect(prompt).toContain("current legal ids in `context.actions`");
    expect(prompt).toMatch(
      /`mcp__adventureforge__step_action`, passing\s+`session_id: current rpg_session_id`, `action_id: exact visible id`, and\s+`expected_state_hash: latest state_hash`/,
    );
    expect(prompt).toMatch(/replace\s+any older menu/);
    expect(prompt).toContain("unchanged hash reply has no context");
    expect(prompt).toContain("journey-choice pause suppresses");
    expect(prompt).toContain("mcp__adventureforge__list_legal_actions");
    expect(prompt).toContain("defaults to labeled `{ id, command }`");
    expect(prompt).toContain("`compact_actions: true`");
    expect(prompt).toContain("defaults to labeled `available_actions`");
    expect(prompt).toContain("Preserve both");
    expect(prompt).toContain("`overworld_session_id`");
    expect(prompt).toContain("`rpg_session_id`");
    expect(prompt).toContain("recoverable errors also repeat");
    expect(prompt).toContain("non-death quest ending folds back");
    expect(prompt).toContain("A death");
    expect(prompt).toContain("end-only journey choice");
    expect(prompt).toContain("truthful unfinished-goal");
    expect(prompt).toContain("Never invent a resurrection");
    expect(prompt).toContain("or request a separate technical foldback");
    expect(prompt).toContain("complete source for rules, choices, and state");
    expect(prompt).toContain("mcp__adventureforge__start_overworld_session_quest");
    expect(prompt).toContain("normal player");
    expect(prompt).toContain("context.quest_starts");
    expect(prompt).toContain("pass those values unchanged");
    expect(prompt).toContain("Station v49 `station_dispatch_board`");
    expect(prompt).toContain("`[6,quest_id,dispatch_status,dispatch,rows,overview|null]`");
    expect(prompt).toContain("remaining_optional_count");
    expect(prompt).toContain("`[slot,status,selected_title|null,purpose|null,action|null]`");
    expect(prompt).toContain(
      "`role/duty/evidence/preparation/relief_allocation/field_team` mean\n  background/promise/report/kit/wagon/rider",
    );
    expect(prompt).toContain(
      "`context.quests` plus\n  `context.quest_starts` are the roads; you may depart with support unfinished",
    );
    expect(prompt).toContain("Before review, hidden open rows are summarized");
    expect(prompt).toContain("`overview=[id,label]`");
    expect(prompt).toContain("If a\n  category interests you");
    expect(prompt).toContain("`reveal_station_dispatch_support`");
    expect(prompt).toContain("latest `if_snapshot_hash`");
    expect(prompt).toContain("pure delta has outer `overworld_session_id`/`snapshot_hash`");
    expect(prompt).toContain(
      "`station_dispatch_reveal:{version:1,base_snapshot_hash,station_dispatch_board}`",
    );
    expect(prompt).toContain("base matches your retained hash");
    expect(prompt).toContain("keep journey/context and replace\n  the board and hash");
    expect(prompt).toContain("otherwise refresh without reveal");
    expect(prompt).toContain("After review `overview=null`");
    expect(prompt).toContain("open rows expose purpose/action");
    expect(prompt).toContain("Support changes cost/aftermath, not access");
    expect(prompt).toContain("Inspect at most one desired row");
    expect(prompt).toContain("never enumerate");
    expect(prompt).toContain("`['inspect',story_choice_id]`");
    expect(prompt).toContain("`['talk',character_id,contact_name]`");
    expect(prompt).toContain("null is illegal");
    expect(prompt).toContain("revealed field-team talk can present a mandatory ally modal");
    expect(prompt).toContain("`expected_snapshot_hash:latest snapshot_hash`");
    expect(prompt).toContain("pure delta omits raw\n  session/context");
    expect(prompt).toContain("outer `overworld_session_id`/`snapshot_hash`, full");
    expect(prompt).toContain("`journey`/`storyChoice`");
    expect(prompt).toContain("`journeyDecision`, compact `result`, any `legend_delta`");
    expect(prompt).toContain("`station_dispatch_modal:{version:1,base_snapshot_hash}`");
    expect(prompt).toContain("base matches\n  retained state, keep context and adopt those fields");
    expect(prompt).toContain("modal voids old board\n  actions");
    expect(prompt).toContain("do not repeat the talk");
    expect(prompt).toContain("inspect it or choose a visible ally option");
    expect(prompt).toContain("Missing/stale bases do not mutate");
    expect(prompt).toContain("choice returns full context to resync");
    expect(Buffer.byteLength(promptTemplate, "utf8")).toBe(15_720);
    expect(prompt).not.toMatch(/legacy v[23]/iu);
    expect(prompt).not.toContain("older session");
    expect(prompt).not.toContain("`include_station_dispatch_support: true`");
    expect(prompt).toContain("Without `station_dispatch_board`");
    expect(prompt).toContain("only exact actions are legal");
    expect(prompt).toContain("context.job_scenes");
    expect(prompt).toContain("context.job_choices");
    expect(prompt).toContain("exact `[job_id, option_id]` tuple");
    expect(prompt).toMatch(/passing\s+both values unchanged/);
    expect(prompt).toContain("visible `reviewOption`");
    expect(prompt).toContain("one exact\n  option `id` as `option_id`");
    expect(prompt).toContain("authenticated selected terms");
    expect(prompt).toMatch(/separately read recap,\s+or expand every option/u);
    expect(prompt).toContain("option detail may");
    expect(prompt).not.toContain("never the exact active terms");
    expect(prompt).toContain("compact prompt\n  carries one review instruction in its message");
    expect(prompt).toContain("required per-option `consequence` is intentionally blank");
    expect(prompt).not.toContain("consequence line stages rather than repeats");
    expect(prompt).toContain("visible `revealOption`");
    expect(prompt).toContain(
      "records that the comparison was viewed but accepts no\n  gameplay decision",
    );
    expect(prompt).toContain("result may include `displaySummary`");
    expect(prompt).toContain("read that concise\n  player-language outcome first");
    expect(prompt).toContain("`consequence` remains the exact\n  authoritative receipt");
    expect(prompt).toContain("`reveal_id`");
    expect(prompt).toContain("then choose only from the expanded visible");
    expect(prompt).toMatch(/expand every\s+option/);
    expect(prompt).toContain("add `story_choice_id`\n  only to disambiguate a shared id");
    expect(prompt).not.toContain("with both that\n  `story_choice_id`");
    expect(prompt).toContain("does not repeat the\n  Station board or other world context");
    expect(prompt).not.toContain("mcp__adventureforge__start_world_quest");
    expect(prompt).toContain("direct quest drop-in bypasses the overworld");
    expect(prompt).toContain("not part of this playthrough");
    expect(prompt).toContain("Only then conduct the exit interview");
    expect(prompt).toContain("`exitReceipt`");
    expect(prompt).toContain("`run_evidence.recorded: false`");
    expect(prompt).toContain("make exactly one more call");
    expect(prompt).toContain("same `end` choice");
    expect(prompt).toContain("`retryable: false`");
    expect(prompt).toContain('"journey_exit_receipt": {}');
    expect(prompt).toContain('"issue_consistency_version": 1');
    expect(prompt).toContain("Every severity-tagged finding anywhere in the report");
    expect(prompt).toMatch(/Do not leave a severity-bearing concern only in\s+prose/u);
    expect(prompt).toContain("Distinct concerns need distinct objects");
    expect(prompt).not.toMatch(/"journey_exit_receipt"\s*:\s*"/);

    expect(prompt).not.toMatch(/30\s*[–-]\s*45|30\s+to\s+45/i);
    expect(prompt).not.toMatch(
      /(?:stop|end|exit|finish|quit).{0,80}(?:after|at|around|within|once).{0,50}(?:\d+|ten|twenty|thirty|forty|fifty).{0,30}(?:mcp|tool)?\s*(?:calls?|invocations?|requests?|turns?)/is,
    );
    expect(prompt).not.toMatch(/(?:call|turn|request|invocation)\s*(?:budget|limit|quota)/i);
    expect(prompt).not.toMatch(/aim for roughly|take at least|if budget allows|watch for/i);
    expect(prompt).not.toMatch(/Albany|Colonie|Wolf-Winter|breaking_weir|cautious_scout/i);
    expect(prompt).not.toContain("resolve_overworld_session_road_encounter");
    expect(prompt).not.toContain("include_actions: false");
  });

  it("gives Spark a compact game-only prompt with one native start and a complete interview", () => {
    expect(sparkPrompt).toContain("`mcp__adventureforge__start_overworld({})` exactly once");
    expect(sparkPrompt).toContain("Before any words or other action");
    expect(sparkPrompt).toContain("call only preloaded");
    expect(sparkPrompt).toContain("gameplay functions authorized by the latest game");
    expect(sparkPrompt).toContain("Never use any other tool");
    expect(sparkPrompt).toContain("first-time player");
    expect(sparkPrompt).toContain(
      "do not\nseek test coverage, follow a preset route, or impose a turn limit",
    );
    expect(sparkPrompt).toContain("Keep the initial `legend` and merge later `legend_delta` keys");
    expect(sparkPrompt).toContain(
      "parent overworld and child RPG handles are\nnever interchangeable",
    );
    expect(sparkPrompt).toContain("Replace old legal menus with the latest one");
    expect(sparkPrompt).toContain("honestly continue or end");
    expect(sparkPrompt).toContain("Report only after an end response returns `exitReceipt`");
    expect(sparkPrompt).toContain("`run_evidence.recorded` is false and `retryable` is true");
    for (const heading of [
      "Playthrough log",
      "Did it work mechanically?",
      "Understandable & fun?",
      "Confusion / friction points",
      "Bugs or design flaws",
      "Verdict",
    ]) {
      expect(sparkPrompt).toContain(`\`${heading}\``);
    }
    expect(sparkPrompt).toContain(
      "Do not stop after\nthe JSON `}`: your response is invalid unless its final line is the closing\nthree-backtick fence",
    );
    expect(sparkPrompt).toContain(
      "each bug is\nexactly an object with `where`, `severity` (`S0`-`S4`), and `note`",
    );
    expect(sparkPrompt).toContain("Use `[]`\nwhen there are none");
    expect(sparkPrompt).toContain('never put `"none"`, `"none observed"`');
    expect(sparkPrompt.trimEnd().endsWith("```")).toBe(true);
    expect(sparkPrompt.match(/^```json exit-interview\r?$/gmu)).toHaveLength(1);
    expect(sparkPrompt).toContain('"schema_version":2');
    expect(sparkPrompt).toContain('"issue_consistency_version":1');
    expect(sparkPrompt).toContain("Every severity-tagged finding anywhere in the report");
    expect(sparkPrompt).toContain("Distinct concerns need distinct objects");
    expect(sparkPrompt).toContain("Never leave a severity concern only in prose");
    expect(sparkPrompt).toContain('"play_mode":"pure"');
    expect(sparkPrompt).toContain('"start_surface":"fresh_overworld"');
    expect(sparkPrompt).toContain('"journey_exit_receipt":{}');
    expect(sparkPrompt).not.toMatch(/Albany|Colonie|Wolf-Winter|breaking_weir/i);
    expect(sparkPrompt).not.toContain("functions.exec");
    expect(sparkPrompt).not.toContain("apply_patch");
    expect(sparkPrompt).not.toContain("tool_search");
    expect(sparkPrompt).not.toContain("list_mcp_resources");
    expect(sparkPrompt).not.toContain('tool_search({"query"');
    expect(sparkPrompt).not.toContain(CODEX_EXEC_YIELD_PRAGMA);
    expect(sparkPrompt).not.toContain("text(await tools.");
    expect(sparkPrompt).not.toContain("{{TRANSPORT_INSTRUCTIONS}}");
    expect(sparkPrompt).not.toContain("{{PERSONA}}");
    expect(terraPrompt).toContain("`mcp__adventureforge__start_overworld({})` exactly once");
    expect(terraPrompt).toContain("Before any words or other action");
    expect(terraPrompt).toContain("Never use any other tool");
    expect(terraPrompt).not.toContain("functions.exec");
    expect(terraPrompt).not.toContain(CODEX_EXEC_YIELD_PRAGMA);
    expect(terraPrompt).not.toContain("{{TRANSPORT_INSTRUCTIONS}}");
    expect(prompt).not.toContain("{{TRANSPORT_INSTRUCTIONS}}");
    expect(prompt).toContain('Never put `"none"`,\n  `"none observed"`');
    expect(prompt.trimEnd().endsWith("```")).toBe(true);
  });

  it("locks quest-only legal-action transport and exact session handles across prompt and protocol", () => {
    expect({
      promptLegalActions: promptBullet(
        "- Call `mcp__adventureforge__list_legal_actions` only while",
      ),
      protocolLegalActions: protocolParagraph("`list_legal_actions` is a child-quest tool"),
      promptSessionHandles: promptBullet("- Use only ids and choices visible"),
      protocolSessionHandles: protocolParagraph(
        "Pure mode repeats the parent `overworld_session_id`",
      ),
    }).toEqual({
      promptLegalActions:
        "- Call `mcp__adventureforge__list_legal_actions` only while an embedded quest is active and only with `session_id: exact current rpg_session_id` for that child. Never pass the parent `overworld_session_id` to this quest-only tool. Ordinary overworld legal choices are already in the current overworld response; use the corresponding overworld tools for them.",
      protocolLegalActions:
        "For an embedded quest, pure mode enforces `hide_graph = true`. State-bearing compact quest start, read, and `step_action` responses default to `compact_observation = true` and enforce `include_actions = true`, so the same response carries a bounded `context.actions` menu of current legal ids while quest play is active. An unchanged hash reply has no context, and a journey-choice pause suppresses quest actions until that choice is answered. The player replaces any older menu with the current one and guards `step_action` with `expected_state_hash = latest state_hash`. `list_legal_actions` defaults to labeled `{ id, command }` options in pure mode; `compact_actions = true` remains an explicit id-only transport option. Verbose pure observations likewise default to labeled `available_actions`. These projections expose only the same current commands a human sees; they neither select an action nor reveal authoring structure. `list_legal_actions` is a child-quest tool: the player calls it only while an embedded quest is active, with the exact current `rpg_session_id`, never the parent `overworld_session_id`. Ordinary overworld legal choices already appear in the current overworld response and use their corresponding overworld tools.",
      promptSessionHandles:
        "- Use only ids and choices visible in the current player response. Preserve both session handles: every overworld tool after the fresh start takes the parent `session_id`, while an embedded quest uses its child `rpg_session_id`. Embedded quest responses echo the parent as `overworld_session_id`; while a quest is unresolved, pure responses and recoverable errors also repeat its current `rpg_session_id`. Copy each exact current handle from the latest response; never reconstruct, shorten, or hand-type a handle or its suffix, and never substitute either handle for the other. Use the latest `state_hash` for the child and `snapshot_hash` for the parent when a tool offers those guards. Embedded quest responses can also return `overworld_snapshot_hash`; keep the latest one as the overworld guard when returning from that quest.",
      protocolSessionHandles:
        "Pure mode repeats the parent `overworld_session_id` on every successful player response. While an embedded quest is unresolved, it also repeats the current child `rpg_session_id`; the two handles are never interchangeable. Missing, mistyped, stale, or wrong-domain handles receive a structured error containing the authoritative recoverable handle(s) and the expected field. Starting again cannot mint a second fresh run, and parent gameplay mutations cannot orphan an active child. The player copies each exact current handle from the latest response and never reconstructs, shortens, or hand-types a handle or its suffix. Pure overworld reads always remain on the compact player surface; verbose observation, graph, id-catalog, and route-expansion knobs are absent.",
    });
  });

  it("makes the latest authored-event choice menu authoritative", () => {
    expect(promptBullet("- An authored local event is described")).toBe(
      "- An authored local event is described in `context.event_scenes`. Its nested option tuples preview terms; they are not current legal choices. Resolve it only when the latest `context.event_choices` presents an exact `[event_id, option_id]` tuple, passing both values unchanged to `mcp__adventureforge__resolve_overworld_session_event`. If the latest state-bearing context omits `event_choices`, no authored event option is legal; an `unchanged: true` reply preserves the prior state-bearing menu. A visible legacy event absent from `event_scenes` still follows the shown investigate/resolve flow with its `event_id` only.",
    );
  });

  it("locks the visible goal-passage id to its exact route-neutral transport", () => {
    expect({
      promptGoalPassage: promptBullet("- A non-null `journey.goalPassage`"),
      protocolGoalPassage: protocolParagraph(
        "A non-null `journey.goalPassage` exposes the optional player movement action",
      ),
    }).toEqual({
      promptGoalPassage:
        "- A non-null `journey.goalPassage` is a visible optional movement choice. If you choose its exact `id: follow_current_goal`, call `mcp__adventureforge__follow_overworld_session_goal` with the parent `session_id` and `expected_snapshot_hash: latest snapshot_hash`; do not invent, infer, or substitute a differently named goal tool. The game, not the harness, decides where that passage stops.",
      protocolGoalPassage:
        "A non-null `journey.goalPassage` exposes the optional player movement action `id: follow_current_goal`. If the player chooses it, the transport binding is exactly `follow_overworld_session_goal` with the parent `session_id` and latest `snapshot_hash` passed as `expected_snapshot_hash`; the player never invents, infers, or substitutes a differently named goal tool. This binding adds no route advice: the game owns the passage and stops it at the objective, a road choice, or a resource boundary.",
    });
  });

  it("keeps the deterministic selector on exact authored job tuples", () => {
    expect(mockAgent).toContain("ctx.job_choices");
    expect(mockAgent).toContain("optionId");
    expect(mockAgent).toContain("{ option_id: optionId }");
    expect(mockAgent).toContain("authoredJobIds");
    expect(mockAgent).toContain("ctx?.service_actions");
    expect(mockAgent).toContain('"care_overworld_session"');
    expect(mockAgent).toMatch(/activeCareStep\(ctx\).*pickOverworldAction\(ctx, rng\)/s);
  });

  it("pins live mode to pure/default and treats the 1200-second failsafe as failure only", () => {
    expect(runner).toContain('TIMEOUT="${BLIND_TIMEOUT:-1200}"');
    expect(runner).toContain('PLAY_MODE="pure"');
    expect(runner).toContain('if [[ "$PLAY_MODE" == "pure" && "$PERSONA" != "default" ]]');
    expect(runner).toContain("no exit interview or retention result is accepted");
    expect(runner).toContain("--play-mode");
    expect(runner).toContain("--run-evidence");
    expect(runner).toContain("--require-mode pure");
    expect(runner.match(/--require-issue-consistency/g)).toHaveLength(3);
    expect(runner).toContain('rm -f "$PRIVATE_RUN_SIDECAR"');
    expect(runner).toContain("PURE_PUBLICATION_COMPLETE=1");
  });
});
