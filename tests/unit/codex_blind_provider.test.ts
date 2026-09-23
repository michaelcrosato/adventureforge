import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs module without type declarations
import * as codexProvider from "../../blind-tester/codex-pure-envelope.mjs";
import { PURE_PLAYER_TOOLS } from "../../src/mcp/server.js";

const {
  buildCodexPureEnvelope,
  classifyCodexGameplayWrapper,
  CODEX_GAMEPLAY_WRAPPER_FAILURES,
  CODEX_PURE_PLAYER_TOOLS,
  CODEX_GAME_DIRECT_MCP_CONTRACT,
  CODEX_SPARK_PLAYER_BASE_INSTRUCTIONS,
  CODEX_SPARK_DIRECT_MCP_CONTRACT,
  inspectCodexGameplayResultForwarding,
  inspectCodexGameplayResultForwardingPrefix,
  inspectCodexPureEvidence,
  inspectCodexPureEventPrefix,
  inspectCodexPureEvents,
  parseCodexGameplayWrapper,
} = codexProvider;

const THREAD_ID = "019f7250-1ed0-7102-be6c-4f1d5513d91e";
const PERMISSIONS_BLOCK = "<permissions instructions>read-only player</permissions instructions>";
const SKILLS_BLOCK = "<skills_instructions>player skills</skills_instructions>";
const V2_TEAM_BLOCK =
  "You are `/root`, the primary agent in a team of agents collaborating to fulfill the user's goals.";
const V2_MODE_BLOCK =
  "<multi_agent_mode>Only explicit requests permit delegation.</multi_agent_mode>";
const V2_0146_MODE_BLOCK =
  "<multi_agent_mode>Any earlier instruction enabling proactive multi-agent delegation no longer applies. Do not spawn sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or parallel agent work.</multi_agent_mode>";
const ENVIRONMENT_BLOCK = "<environment_context>isolated player</environment_context>";
const GLOBAL_AGENTS_BLOCK =
  "# AGENTS.md instructions\n\n" +
  "<INSTRUCTIONS>\n" +
  "# Global Codex Guidance\n\n" +
  "- Read the repository's own instructions, scripts, and existing patterns before changing code.\n" +
  "- Prefer the repo-local toolchain and package manager over global installs.\n" +
  "- Use `rg`/`rg --files` for code search when available.\n" +
  "- Check the worktree before editing, and do not overwrite unrelated user changes.\n" +
  "- Keep changes scoped to the requested task unless a broader fix is necessary.\n" +
  "- Run the most relevant tests, type checks, linters, builds, or browser smoke checks before finishing when the repo provides them.\n" +
  "- Do not print, commit, or move secrets. Use local env files such as `.env.local` only when a task explicitly needs credentials.\n" +
  "- For web apps, start the dev server and verify the local page when the app needs a server to run.\n" +
  "</INSTRUCTIONS>";
const CODEX_EXEC_YIELD_PRAGMA = '// @exec: {"yield_time_ms": 120000}';
const SPARK_MODEL = "gpt-5.3-codex-spark";
const CAPTURED_PRIVATE_RESOURCE_PROBE = {
  timestamp: "2026-08-09T18:48:15.455Z",
  type: "response_item",
  payload: {
    type: "function_call",
    id: "fc_03e7220d36f21d2d016a78cb6fac08819ab627628a0d144be7",
    name: "list_mcp_resources",
    arguments: "{}",
    call_id: "call_blDR18VQkrYjpIA0t8a1HPFC",
    internal_chat_message_metadata_passthrough: {
      turn_id: "019fe7da-a24d-7ac1-aa56-7c67d11cfba0",
    },
  },
};
const CAPTURED_PRIVATE_RESOURCE_PROBE_SHA256 =
  "027bc0038654b98e508b619c588dad78b8b1ee1a35e4b1f9d904562c9dfa065b";
const SPARK_UNSTABLE_WARNING_PREFIX =
  "Under-development features enabled: code_mode_only. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set `suppress_unstable_features_warning = true` in ";
const SPARK_METADATA_WARNING =
  "Code Mode is enabled in configuration, but model `gpt-5.3-codex-spark` does not advertise Code Mode support. This may degrade model performance. Disable `features.code_mode` and `features.code_mode_only`, or select a model whose metadata enables Code Mode.";
const TOOL_ERROR_RESULT = {
  content: [{ type: "text", text: '{"ok":false,"error":"move first"}' }],
  isError: true,
};

function canonicalGameplayWrapper(call: string): string {
  return `${CODEX_EXEC_YIELD_PRAGMA}\ntext(await ${call});\n`;
}

function legacyGameplayWrapper(call: string): string {
  return `const result = await ${call};\ntext(JSON.stringify(result));\n`;
}

type TestItem = {
  id: string;
  type: string;
  text?: string;
  message?: string;
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  status?: string;
};

type TestRow = {
  type: string;
  thread_id?: string;
  item?: TestItem;
  usage?: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
  };
};

function gameplayCallRows(
  id = "item_1",
  tool = "start_overworld",
  arguments_: Record<string, unknown> = {},
): TestRow[] {
  const common = {
    id,
    type: "mcp_tool_call",
    server: "adventureforge",
    tool,
    arguments: arguments_,
  };
  return [
    {
      type: "item.started",
      item: { ...common, result: null, error: null, status: "in_progress" },
    },
    {
      type: "item.completed",
      item: {
        ...common,
        result: { content: [], structured_content: null },
        error: null,
        status: "completed",
      },
    },
  ];
}

function validRows(): TestRow[] {
  return [
    { type: "thread.started", thread_id: THREAD_ID },
    { type: "turn.started" },
    ...gameplayCallRows(),
    {
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "report" },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 120,
        cached_input_tokens: 80,
        output_tokens: 40,
        reasoning_output_tokens: 10,
      },
    },
  ];
}

function sparkCodeModeRows(): TestRow[] {
  const rows = validRows();
  for (const row of rows) {
    if (row.item?.id === "item_0") row.item.id = "item_2";
    else if (row.item?.id === "item_1") row.item.id = "item_3";
  }
  rows.splice(
    1,
    0,
    {
      type: "item.completed",
      item: {
        id: "item_0",
        type: "error",
        message: `${SPARK_UNSTABLE_WARNING_PREFIX}C:\\Users\\operator\\.codex\\config.toml.`,
      },
    },
    {
      type: "item.completed",
      item: { id: "item_1", type: "error", message: SPARK_METADATA_WARNING },
    },
  );
  return rows;
}

function singleCodeModeWarningRows(): TestRow[] {
  const rows = validRows();
  for (const row of rows) {
    if (row.item?.id === "item_0") row.item.id = "item_1";
    else if (row.item?.id === "item_1") row.item.id = "item_2";
  }
  rows.splice(1, 0, {
    type: "item.completed",
    item: {
      id: "item_0",
      type: "error",
      message: `${SPARK_UNSTABLE_WARNING_PREFIX}C:\\Users\\operator\\.codex\\config.toml.`,
    },
  });
  return rows;
}

function forwardingRollout(
  output: unknown = undefined,
  result: Record<string, unknown> = {
    content: [{ type: "text", text: '{"state_hash":"next"}' }],
  },
): unknown[] {
  return [
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        id: "wrapper-item-1",
        status: "completed",
        call_id: "call-wrapper-1",
        name: "exec",
        input: canonicalGameplayWrapper("tools.mcp__adventureforge__start_overworld({})"),
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        call_id: "exec-gameplay-1",
        invocation: { server: "adventureforge", tool: "start_overworld", arguments: {} },
        result: { Ok: result },
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call-wrapper-1",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        output: output ?? [
          { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
          { type: "input_text", text: JSON.stringify(result) },
        ],
      },
    },
  ];
}

function rolloutPayload(rows: unknown[], index: number): Record<string, unknown> {
  return (rows[index] as { payload: Record<string, unknown> }).payload;
}

function twoPublicGameplayCalls(): TestRow[] {
  const rows = validRows();
  const finalAgentMessage = rows.findIndex((row) => row.item?.type === "agent_message");
  if (finalAgentMessage < 0) throw new Error("missing public final agent-message fixture");
  rows.splice(
    finalAgentMessage,
    0,
    ...gameplayCallRows("item_2", "get_overworld_session_context", {}),
  );
  return rows;
}

function twoPrivateGameplayCalls(
  result: Record<string, unknown> = {
    content: [{ type: "text", text: '{"state_hash":"next"}' }],
  },
  firstResult: Record<string, unknown> = result,
): unknown[] {
  const second = forwardingRollout(undefined, result);
  const start = rolloutPayload(second, 0);
  start.id = "wrapper-item-2";
  start.call_id = "call-wrapper-2";
  start.input = canonicalGameplayWrapper(
    "tools.mcp__adventureforge__get_overworld_session_context({})",
  );
  const completion = rolloutPayload(second, 1);
  completion.call_id = "exec-gameplay-2";
  const invocation = completion.invocation as Record<string, unknown>;
  invocation.tool = "get_overworld_session_context";
  rolloutPayload(second, 2).call_id = "call-wrapper-2";
  return [...forwardingRollout(undefined, firstResult), ...second];
}

function completeRollout(
  gameplayRows: unknown[],
  profile: "sol_v2" | "terra_v2" | "luna_v1" | "spark_disabled" = "sol_v2",
): unknown[] {
  const inputMessage = (role: "developer" | "user", ...texts: string[]) => ({
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: texts.map((text) => ({ type: "input_text", text })),
      internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
    },
  });
  const model =
    profile === "luna_v1"
      ? "gpt-5.6-luna"
      : profile === "spark_disabled"
        ? "gpt-5.3-codex-spark"
        : profile === "terra_v2"
          ? "gpt-5.6-terra"
          : "gpt-5.6-sol";
  const singleDeveloperPrelude = profile === "luna_v1" || profile === "spark_disabled";
  const prelude = singleDeveloperPrelude
    ? [
        inputMessage("developer", PERMISSIONS_BLOCK, SKILLS_BLOCK),
        inputMessage("user", ENVIRONMENT_BLOCK),
      ]
    : [
        inputMessage("developer", PERMISSIONS_BLOCK, SKILLS_BLOCK),
        inputMessage("developer", V2_TEAM_BLOCK),
        inputMessage("developer", V2_MODE_BLOCK),
        inputMessage("user", ENVIRONMENT_BLOCK),
      ];
  return [
    { type: "session_meta", payload: { id: THREAD_ID } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    ...prelude,
    { type: "world_state", payload: { full: true } },
    {
      type: "turn_context",
      payload: {
        turn_id: "turn-1",
        model,
        effort: "xhigh",
        collaboration_mode: {
          mode: "default",
          settings: {
            model,
            reasoning_effort: "xhigh",
            developer_instructions: null,
          },
        },
        multi_agent_version:
          profile === "luna_v1" ? "v1" : profile === "spark_disabled" ? "disabled" : "v2",
        ...(singleDeveloperPrelude ? {} : { multi_agent_mode: "explicitRequestOnly" }),
      },
    },
    inputMessage("user", "blind prompt"),
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "blind prompt",
        images: [],
        local_images: [],
        text_elements: [],
      },
    },
    ...gameplayRows,
    ...pairedPrivateAgentMessage("final-message", "report", "final_answer"),
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
  ];
}

function codex0146TerraRollout(gameplayRows = forwardingRollout(undefined, { content: [] })) {
  const rows = completeRollout(gameplayRows, "terra_v2") as Array<{
    type?: string;
    payload?: Record<string, unknown>;
  }>;
  let inputOrdinal = 0;
  let outputOrdinal = 0;
  for (const row of rows) {
    const payload = row.payload;
    if (!payload) continue;
    if (row.type === "session_meta") payload.cli_version = "0.146.0";
    if (row.type === "turn_context") delete payload.multi_agent_mode;
    if (
      row.type === "response_item" &&
      payload.type === "message" &&
      (payload.role === "developer" || payload.role === "user")
    ) {
      inputOrdinal += 1;
      payload.id = `msg-current-${inputOrdinal}`;
      const content = payload.content as Array<{ type?: string; text?: string }>;
      for (const block of content) {
        if (block.text === V2_MODE_BLOCK) block.text = V2_0146_MODE_BLOCK;
      }
    }
    if (row.type === "response_item" && payload.type === "custom_tool_call_output") {
      outputOrdinal += 1;
      payload.id = `output-current-${outputOrdinal}`;
    }
  }
  return rows;
}

function pairedPrivateAgentMessage(id: string, text: string, phase: "commentary" | "final_answer") {
  return [
    {
      type: "event_msg",
      payload: { type: "agent_message", message: text, phase, memory_citation: null },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        id,
        role: "assistant",
        content: [{ type: "output_text", text }],
        phase,
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      },
    },
  ];
}

function strictPublicAgentMessageRows(commentary = "I inspect the ruined gate.", final = "report") {
  const rows = singleCodeModeWarningRows();
  const initialAgentMessage = rows.findIndex((row) => row.item?.type === "agent_message");
  if (initialAgentMessage < 0) throw new Error("missing public agent-message fixture");
  rows.splice(initialAgentMessage, 1);

  const turnCompleted = rows.findIndex((row) => row.type === "turn.completed");
  if (turnCompleted < 0) throw new Error("missing public turn completion fixture");
  rows.splice(turnCompleted, 0, ...gameplayCallRows("item_3", "get_overworld_session_context", {}));

  const firstCompletion = rows.findIndex(
    (row) => row.type === "item.completed" && row.item?.type === "mcp_tool_call",
  );
  if (firstCompletion < 0) throw new Error("missing first public gameplay completion fixture");
  rows.splice(firstCompletion + 1, 0, {
    type: "item.completed",
    item: { id: "agent-commentary", type: "agent_message", text: commentary },
  });

  const secondCompletion = rows.findIndex(
    (row, index) =>
      index > firstCompletion &&
      row.type === "item.completed" &&
      row.item?.type === "mcp_tool_call",
  );
  if (secondCompletion < 0) throw new Error("missing second public gameplay completion fixture");
  rows.splice(secondCompletion + 1, 0, {
    type: "item.completed",
    item: { id: "agent-final", type: "agent_message", text: final },
  });
  return rows;
}

function strictTerraAgentMessageRollout(
  commentary = "I inspect the ruined gate.",
  final = "report",
) {
  const rows = codex0146TerraRollout(twoPrivateGameplayCalls({ content: [] }));
  const secondGameplay = rows.findIndex(
    (row) => row.payload?.type === "custom_tool_call" && row.payload.call_id === "call-wrapper-2",
  );
  if (secondGameplay < 0) throw new Error("missing second private gameplay fixture");
  rows.splice(
    secondGameplay,
    0,
    ...pairedPrivateAgentMessage("assistant-commentary", commentary, "commentary"),
  );

  const finalAssistant = rows.find(
    (row) =>
      row.payload?.type === "message" &&
      row.payload.role === "assistant" &&
      row.payload.phase === "final_answer",
  )?.payload;
  if (!finalAssistant) throw new Error("missing private final assistant fixture");
  finalAssistant.content = [{ type: "output_text", text: final }];

  const finalAssistantIndex = rows.findIndex((row) => row.payload === finalAssistant);
  if (finalAssistantIndex < 0) throw new Error("missing private final assistant index");
  const finalEvent = rows[finalAssistantIndex - 1]?.payload;
  if (finalEvent?.type !== "agent_message") throw new Error("missing private final agent event");
  finalEvent.message = final;
  return rows;
}

function codex0146SparkRollout(gameplayRows = forwardingRollout(undefined, { content: [] })) {
  const rows = completeRollout(gameplayRows, "spark_disabled") as Array<{
    type?: string;
    payload?: Record<string, unknown>;
  }>;
  let inputOrdinal = 0;
  let outputOrdinal = 0;
  for (const row of rows) {
    const payload = row.payload;
    if (!payload) continue;
    if (row.type === "session_meta") {
      payload.cli_version = "0.146.0";
      payload.base_instructions = { text: CODEX_SPARK_PLAYER_BASE_INSTRUCTIONS };
    }
    if (row.type === "turn_context") payload.comp_hash = "2911";
    if (
      row.type === "response_item" &&
      payload.type === "message" &&
      (payload.role === "developer" || payload.role === "user")
    ) {
      inputOrdinal += 1;
      payload.id = `msg-current-${inputOrdinal}`;
    }
    if (row.type === "response_item" && payload.type === "custom_tool_call_output") {
      outputOrdinal += 1;
      payload.id = `output-current-${outputOrdinal}`;
    }
  }
  return rows;
}

function environmentInputContent(
  rows: unknown[],
): Array<{ type?: string; text?: string; [key: string]: unknown }> {
  for (const row of rows) {
    if (
      typeof row !== "object" ||
      row === null ||
      (row as { type?: string }).type !== "response_item"
    ) {
      continue;
    }
    const payload = (row as { payload?: Record<string, unknown> }).payload;
    if (payload?.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content)) {
      continue;
    }
    const content = payload.content as Array<{
      type?: string;
      text?: string;
      [key: string]: unknown;
    }>;
    if (content.some((block) => block.type === "input_text" && block.text === ENVIRONMENT_BLOCK)) {
      return content;
    }
  }
  throw new Error("missing environment input fixture");
}

function sparkDirectMcpRollout(
  result: Record<string, unknown> = { content: [] },
): Array<{ type?: string; payload?: Record<string, unknown> }> {
  const rows = codex0146SparkRollout([]) as Array<{
    type?: string;
    payload?: Record<string, unknown>;
  }>;
  let userEventIndex = rows.findIndex(
    (row) => row.type === "event_msg" && row.payload?.type === "user_message",
  );
  if (userEventIndex < 0) throw new Error("missing direct-MCP user event fixture");
  const turnId = "turn-1";
  const metadata = { internal_chat_message_metadata_passthrough: { turn_id: turnId } };
  const taskStartIndex = rows.findIndex(
    (row) => row.type === "event_msg" && row.payload?.type === "task_started",
  );
  const worldStateIndex = rows.findIndex((row) => row.type === "world_state");
  if (taskStartIndex < 0 || worldStateIndex < 0) {
    throw new Error("missing direct-MCP prelude boundary fixture");
  }
  rows.splice(taskStartIndex + 1, worldStateIndex - taskStartIndex - 1, {
    type: "response_item",
    payload: {
      type: "message",
      id: "msg-current-global-agents",
      role: "user",
      content: [{ type: "input_text", text: GLOBAL_AGENTS_BLOCK }],
      ...metadata,
    },
  });
  userEventIndex = rows.findIndex(
    (row) => row.type === "event_msg" && row.payload?.type === "user_message",
  );
  if (userEventIndex < 0) throw new Error("missing reduced direct-MCP user event fixture");
  const directRows = [
    {
      type: "response_item",
      payload: {
        type: "function_call",
        id: "function-call-1",
        name: "start_overworld",
        namespace: "mcp__adventureforge",
        arguments: "{}",
        call_id: "function-call-1",
        ...metadata,
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        call_id: "function-call-1",
        invocation: { server: "adventureforge", tool: "start_overworld", arguments: {} },
        result: { Ok: result },
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        id: "function-output-1",
        call_id: "function-call-1",
        output: `Wall time: 1.0 seconds\nOutput:\n${JSON.stringify(result.content)}`,
        ...metadata,
      },
    },
  ];
  rows.splice(userEventIndex + 1, 0, ...directRows);
  return rows;
}

function terraDirectMcpRollout(
  result: Record<string, unknown> = { content: [] },
): ReturnType<typeof sparkDirectMcpRollout> {
  const rows = sparkDirectMcpRollout(result);
  const context = rows.find((row) => row.type === "turn_context")?.payload;
  if (!context) throw new Error("missing Terra direct turn context fixture");
  context.model = "gpt-5.6-terra";
  context.multi_agent_version = "disabled";
  context.comp_hash = "3000";
  context.summary = "auto";
  delete context.multi_agent_mode;
  const collaboration = context.collaboration_mode as Record<string, unknown>;
  const settings = collaboration.settings as Record<string, unknown>;
  settings.model = "gpt-5.6-terra";
  return rows;
}

function appendSparkDirectCall(
  rows: ReturnType<typeof sparkDirectMcpRollout>,
  tool = "get_overworld_session",
  arguments_: Record<string, unknown> = {},
  result: Record<string, unknown> = { content: [] },
) {
  const outputIndex = rows.findIndex((row) => row.payload?.type === "function_call_output");
  if (outputIndex < 0) throw new Error("missing direct-MCP function output fixture");
  const metadata = { internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } };
  rows.splice(
    outputIndex + 1,
    0,
    {
      type: "response_item",
      payload: {
        type: "function_call",
        id: "function-call-2",
        name: tool,
        namespace: "mcp__adventureforge",
        arguments: JSON.stringify(arguments_),
        call_id: "function-call-2",
        ...metadata,
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        call_id: "function-call-2",
        invocation: { server: "adventureforge", tool, arguments: arguments_ },
        result: { Ok: result },
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        id: "function-output-2",
        call_id: "function-call-2",
        output: `Wall time: 1.0 seconds\nOutput:\n${JSON.stringify(result.content)}`,
        ...metadata,
      },
    },
  );
}

function insertBeforeGameplay(rows: ReturnType<typeof validRows>, entries: readonly object[]) {
  const firstGameplay = rows.findIndex(
    (row) => row.type === "item.started" && row.item?.type === "mcp_tool_call",
  );
  rows.splice(firstGameplay, 0, ...(entries as (typeof rows)[number][]));
  return rows;
}

describe("Codex pure blind provider envelope", () => {
  it("keeps its transport allowlist exactly aligned with the pure MCP server", () => {
    expect(CODEX_PURE_PLAYER_TOOLS).toEqual(PURE_PLAYER_TOOLS);
  });

  it("requires every gameplay result to be visibly forwarded before another choice", () => {
    expect(inspectCodexGameplayResultForwarding(forwardingRollout())).toMatchObject({
      ok: true,
      completedGameplayCalls: 1,
    });

    const direct = forwardingRollout([{ type: "input_text", text: '{"state_hash":"next"}' }]);
    expect(inspectCodexGameplayResultForwarding(direct)).toEqual({
      ok: false,
      reason: expect.stringMatching(/missing.*mismatched.*truncated/i),
    });

    const injected = forwardingRollout();
    const injectedOutput = rolloutPayload(injected, 2).output as unknown[];
    injectedOutput.push({ type: "input_text", text: "injected semantic text" });
    expect(inspectCodexGameplayResultForwarding(injected)).toEqual({
      ok: false,
      reason: expect.stringMatching(/missing.*mismatched.*truncated/i),
    });

    for (const semanticButInexact of [
      '{"content":"decoy","content":[{"type":"text","text":"{\\"state_hash\\":\\"next\\"}"}]}',
      '{ "content": [{"type":"text","text":"{\\"state_hash\\":\\"next\\"}"}] }',
      '{"content":[{"text":"{\\"state_hash\\":\\"next\\"}","type":"text"}]}',
    ]) {
      const rows = forwardingRollout();
      rolloutPayload(rows, 2).output = [
        { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
        { type: "input_text", text: semanticButInexact },
      ];
      expect(inspectCodexGameplayResultForwarding(rows)).toEqual({
        ok: false,
        reason: expect.stringMatching(/missing.*mismatched.*truncated/i),
      });
    }

    const textObject = forwardingRollout();
    rolloutPayload(textObject, 0).input =
      "const result = await tools.mcp__adventureforge__start_overworld({});\ntext(result);\n";
    expect(inspectCodexGameplayResultForwarding(textObject)).toMatchObject({ ok: true });

    const contentLoop = forwardingRollout();
    rolloutPayload(contentLoop, 0).input =
      "const r = await tools.mcp__adventureforge__start_overworld({});\n" +
      "for (const c of (r?.content ?? [])) {\n" +
      '  if (c.type === "image") image(c);\n' +
      '  else if (c.type === "text") text(c.text);\n' +
      "}\n";
    rolloutPayload(contentLoop, 2).output = [
      { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
      { type: "input_text", text: '{"state_hash":"next"}' },
    ];
    expect(inspectCodexGameplayResultForwarding(contentLoop)).toMatchObject({ ok: true });
  });

  it("authenticates an exactly forwarded MCP tool error as failed gameplay", () => {
    expect(
      inspectCodexGameplayResultForwarding(forwardingRollout(undefined, TOOL_ERROR_RESULT)),
    ).toEqual({
      ok: true,
      completedGameplayCalls: 1,
      gameplayCalls: [
        {
          tool: "start_overworld",
          arguments: {},
          status: "failed",
          result: { content: TOOL_ERROR_RESULT.content },
          error: null,
        },
      ],
    });

    const omittedErrorMarker = forwardingRollout(undefined, TOOL_ERROR_RESULT);
    rolloutPayload(omittedErrorMarker, 2).output = [
      { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
      { type: "input_text", text: JSON.stringify({ content: TOOL_ERROR_RESULT.content }) },
    ];
    expect(inspectCodexGameplayResultForwarding(omittedErrorMarker)).toEqual({
      ok: false,
      reason: expect.stringMatching(/missing.*mismatched.*truncated/i),
    });

    const legacyRendererHidingErrorMarker = forwardingRollout(undefined, TOOL_ERROR_RESULT);
    rolloutPayload(legacyRendererHidingErrorMarker, 0).input =
      "const r = await tools.mcp__adventureforge__start_overworld({});\n" +
      "for (const c of (r?.content ?? [])) {\n" +
      '  if (c.type === "image") image(c);\n' +
      '  else if (c.type === "text") text(c.text);\n' +
      "}\n";
    rolloutPayload(legacyRendererHidingErrorMarker, 2).output = [
      { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
      { type: "input_text", text: TOOL_ERROR_RESULT.content[0]!.text },
    ];
    expect(inspectCodexGameplayResultForwarding(legacyRendererHidingErrorMarker)).toEqual({
      ok: false,
      reason: expect.stringMatching(/missing.*mismatched.*truncated/i),
    });
  });

  it.each([
    {
      label: "isError false",
      result: { content: TOOL_ERROR_RESULT.content, isError: false },
    },
    {
      label: "a non-boolean isError",
      result: { content: TOOL_ERROR_RESULT.content, isError: "true" },
    },
    {
      label: "an extra private field on a tool error",
      result: { ...TOOL_ERROR_RESULT, private_only: "hidden" },
    },
  ])("rejects $label in a private MCP result", ({ result }) => {
    expect(inspectCodexGameplayResultForwarding(forwardingRollout(undefined, result))).toEqual({
      ok: false,
      reason: expect.stringMatching(/no auditable immediate result/i),
    });
  });

  it("still rejects a malformed wrapper around a canonical tool error", () => {
    const rows = forwardingRollout(undefined, TOOL_ERROR_RESULT);
    rolloutPayload(rows, 0).input =
      "const result = await tools.mcp__adventureforge__start_overworld({});\n" +
      "text(JSON.stringify(result));\n" +
      'text("extra");\n';
    expect(inspectCodexGameplayResultForwarding(rows)).toEqual({
      ok: false,
      reason: expect.stringMatching(/forbidden wrapper program/i),
    });
  });

  it("accepts the canonical exec yield pragma without retroactively requiring it", () => {
    const current = forwardingRollout();
    expect(rolloutPayload(current, 0).input).toBe(
      canonicalGameplayWrapper("tools.mcp__adventureforge__start_overworld({})"),
    );
    expect(inspectCodexGameplayResultForwarding(current)).toMatchObject({ ok: true });

    const historical = structuredClone(current);
    rolloutPayload(historical, 0).input =
      "const result = await tools.mcp__adventureforge__start_overworld({});\n" +
      "text(JSON.stringify(result));\n";
    expect(inspectCodexGameplayResultForwarding(historical)).toMatchObject({ ok: true });
  });

  it("requires the exact single awaited forwarding expression in strict-current evidence", () => {
    const strict = { codeModeContract: "strict-code-mode-v2" };
    expect(inspectCodexGameplayResultForwarding(forwardingRollout(), strict)).toMatchObject({
      ok: true,
    });
    expect(
      inspectCodexGameplayResultForwarding(forwardingRollout(undefined, TOOL_ERROR_RESULT), strict),
    ).toMatchObject({ ok: true, gameplayCalls: [{ status: "failed" }] });
    expect(
      inspectCodexGameplayResultForwarding(forwardingRollout(), {
        codeModeContract: "strict-code-mode-v1",
      }),
    ).toMatchObject({ ok: false });

    const missingPragma = forwardingRollout();
    rolloutPayload(missingPragma, 0).input =
      "const result = await tools.mcp__adventureforge__start_overworld({});\n" +
      "text(JSON.stringify(result));\n";
    expect(inspectCodexGameplayResultForwarding(missingPragma, strict)).toMatchObject({
      ok: false,
    });

    const alteredPragma = forwardingRollout();
    rolloutPayload(alteredPragma, 0).input = String(rolloutPayload(alteredPragma, 0).input).replace(
      "120000",
      "120001",
    );
    expect(inspectCodexGameplayResultForwarding(alteredPragma, strict)).toMatchObject({
      ok: false,
    });

    const hyphenatedPragma = forwardingRollout();
    rolloutPayload(hyphenatedPragma, 0).input = String(
      rolloutPayload(hyphenatedPragma, 0).input,
    ).replace("yield_time_ms", "yield-time");
    expect(inspectCodexGameplayResultForwarding(hyphenatedPragma, strict)).toMatchObject({
      ok: false,
    });

    for (const extraComment of [
      `${CODEX_EXEC_YIELD_PRAGMA}\n// extra\n`,
      `${CODEX_EXEC_YIELD_PRAGMA}\n/* extra */\n`,
    ]) {
      const commented = forwardingRollout();
      rolloutPayload(commented, 0).input = String(rolloutPayload(commented, 0).input).replace(
        `${CODEX_EXEC_YIELD_PRAGMA}\n`,
        extraComment,
      );
      expect(inspectCodexGameplayResultForwarding(commented, strict)).toMatchObject({ ok: false });
    }

    const directResult = forwardingRollout();
    rolloutPayload(directResult, 0).input =
      `${CODEX_EXEC_YIELD_PRAGMA}\n` +
      "const result = await tools.mcp__adventureforge__start_overworld({});\ntext(result);\n";
    expect(inspectCodexGameplayResultForwarding(directResult)).toMatchObject({ ok: true });
    expect(inspectCodexGameplayResultForwarding(directResult, strict)).toMatchObject({ ok: false });

    const renamedResult = forwardingRollout();
    rolloutPayload(renamedResult, 0).input =
      `${CODEX_EXEC_YIELD_PRAGMA}\n` +
      "const r = await tools.mcp__adventureforge__start_overworld({});\n" +
      "text(JSON.stringify(r));\n";
    expect(inspectCodexGameplayResultForwarding(renamedResult)).toMatchObject({ ok: true });
    expect(inspectCodexGameplayResultForwarding(renamedResult, strict)).toMatchObject({
      ok: false,
    });

    const contentLoop = forwardingRollout();
    rolloutPayload(contentLoop, 0).input =
      `${CODEX_EXEC_YIELD_PRAGMA}\n` +
      "const r = await tools.mcp__adventureforge__start_overworld({});\n" +
      "for (const c of (r?.content ?? [])) {\n" +
      '  if (c.type === "image") image(c);\n' +
      '  else if (c.type === "text") text(c.text);\n' +
      "}\n";
    rolloutPayload(contentLoop, 2).output = [
      { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
      { type: "input_text", text: '{"state_hash":"next"}' },
    ];
    expect(inspectCodexGameplayResultForwarding(contentLoop)).toMatchObject({ ok: true });
    expect(inspectCodexGameplayResultForwarding(contentLoop, strict)).toMatchObject({ ok: false });

    for (const source of [
      `${CODEX_EXEC_YIELD_PRAGMA}\ntext(await tools.mcp__adventureforge__start_overworld(({})));\n`,
      `${CODEX_EXEC_YIELD_PRAGMA}\ntext(await tools.mcp__adventureforge__start_overworld({}));\ntext("extra");\n`,
      `${CODEX_EXEC_YIELD_PRAGMA}\ntext(await alias.mcp__adventureforge__start_overworld({}));\n`,
    ]) {
      const malformed = forwardingRollout();
      rolloutPayload(malformed, 0).input = source;
      expect(inspectCodexGameplayResultForwarding(malformed, strict)).toMatchObject({ ok: false });
    }

    for (const { label, argumentsSource, canonicalArgumentsSource, claimedArguments } of [
      {
        label: "deterministic property access",
        argumentsSource: '{ value: ({ known: "x" }).known }',
        canonicalArgumentsSource: '{ value: "x" }',
        claimedArguments: { value: "x" },
      },
      {
        label: "invoked arrow",
        argumentsSource: '{ value: (() => "x")() }',
        canonicalArgumentsSource: '{ value: "x" }',
        claimedArguments: { value: "x" },
      },
      {
        label: "object spread",
        argumentsSource: '{ ...{ session_id: "ow" } }',
        canonicalArgumentsSource: '{ session_id: "ow" }',
        claimedArguments: { session_id: "ow" },
      },
      {
        label: "property shorthand",
        argumentsSource: "{ session_id }",
        canonicalArgumentsSource: '{ session_id: "ow" }',
        claimedArguments: { session_id: "ow" },
      },
      {
        label: "computed property",
        argumentsSource: '{ ["session_id"]: "ow" }',
        canonicalArgumentsSource: '{ session_id: "ow" }',
        claimedArguments: { session_id: "ow" },
      },
      {
        label: "nested executable value",
        argumentsSource: '{ nested: [{ value: (() => "x")() }] }',
        canonicalArgumentsSource: '{ nested: [{ value: "x" }] }',
        claimedArguments: { nested: [{ value: "x" }] },
      },
    ]) {
      const literalControl = forwardingRollout();
      rolloutPayload(literalControl, 0).input =
        `${CODEX_EXEC_YIELD_PRAGMA}\n` +
        `text(await tools.mcp__adventureforge__start_overworld(${canonicalArgumentsSource}));\n`;
      const controlInvocation = rolloutPayload(literalControl, 1).invocation as Record<
        string,
        unknown
      >;
      controlInvocation.arguments = structuredClone(claimedArguments);
      expect(inspectCodexGameplayResultForwarding(literalControl, strict), label).toMatchObject({
        ok: true,
      });

      const executableLiteral = forwardingRollout();
      rolloutPayload(executableLiteral, 0).input =
        `${CODEX_EXEC_YIELD_PRAGMA}\n` +
        `text(await tools.mcp__adventureforge__start_overworld(${argumentsSource}));\n`;
      const adversarialInvocation = rolloutPayload(executableLiteral, 1).invocation as Record<
        string,
        unknown
      >;
      adversarialInvocation.arguments = structuredClone(claimedArguments);
      expect(inspectCodexGameplayResultForwarding(executableLiteral, strict), label).toEqual({
        ok: false,
        reason: expect.stringMatching(/forbidden wrapper program/i),
      });
    }

    const secondMissing = twoPrivateGameplayCalls();
    rolloutPayload(secondMissing, 3).input = String(rolloutPayload(secondMissing, 3).input).replace(
      `${CODEX_EXEC_YIELD_PRAGMA}\n`,
      "",
    );
    expect(inspectCodexGameplayResultForwarding(secondMissing, strict)).toMatchObject({
      ok: false,
    });
  });

  it("uses the exact terminal wrapper parser while leaving in-flight adjacency pending", () => {
    const strict = { codeModeContract: "strict-code-mode-v2" };
    const rows = forwardingRollout();
    expect(parseCodexGameplayWrapper(String(rolloutPayload(rows, 0).input), strict)).toEqual({
      tool: "start_overworld",
      arguments: {},
      emitter: "await_text",
    });
    expect(inspectCodexGameplayResultForwardingPrefix(rows.slice(0, 1), strict)).toMatchObject({
      ok: true,
      completedGameplayCalls: 0,
      pending: "mcp_completion",
    });
    expect(inspectCodexGameplayResultForwarding(rows.slice(0, 1), strict)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no immediate MCP completion/i),
    });
    expect(inspectCodexGameplayResultForwardingPrefix(rows.slice(0, 2), strict)).toMatchObject({
      ok: true,
      completedGameplayCalls: 0,
      pending: "visible_result",
    });
    expect(inspectCodexGameplayResultForwarding(rows.slice(0, 2), strict)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no paired visible result output/i),
    });

    const malformed = structuredClone(rows);
    rolloutPayload(malformed, 0).input =
      `// @exec: {"yield_time_ms":120000}\n` +
      "text(await tools.mcp__adventureforge__start_overworld({}));\n";
    // A refused wrapper stays pending for exactly one row: the host's refusal
    // receipt proves inertness, and anything else keeps the terminal rejection.
    expect(inspectCodexGameplayResultForwardingPrefix(malformed.slice(0, 1), strict)).toMatchObject(
      {
        ok: true,
        pending: "wrapper_attempt_output",
      },
    );
    expect(inspectCodexGameplayResultForwardingPrefix(malformed.slice(0, 2), strict)).toEqual({
      ok: false,
      reason: expect.stringMatching(/forbidden wrapper program/i),
    });
    expect(inspectCodexGameplayResultForwarding(malformed.slice(0, 1), strict)).toEqual({
      ok: false,
      reason: expect.stringMatching(/forbidden wrapper program/i),
    });
  });

  it("classifies wrapper rejection with a fixed structural enum while preserving parser acceptance", () => {
    const strict = { codeModeContract: "strict-code-mode-v2" };
    const accepted = `${CODEX_EXEC_YIELD_PRAGMA}\ntext(await tools.mcp__adventureforge__start_overworld({}));\n`;
    const classified = classifyCodexGameplayWrapper(accepted, strict);
    expect(CODEX_GAMEPLAY_WRAPPER_FAILURES).toEqual([
      "strict_yield_pragma_not_exact",
      "syntax_error",
      "single_statement_shape",
      "tool_call_shape",
      "tool_not_allowed",
      "arguments_shape",
      "two_statement_shape",
      "declaration_shape",
      "emitter_shape",
    ]);
    expect(classified).toEqual({
      ok: true,
      wrapper: parseCodexGameplayWrapper(accepted, strict),
    });
    const rejected = classifyCodexGameplayWrapper(
      "text(await tools.mcp__adventureforge__start_overworld({}));\n",
      strict,
    );
    expect(rejected).toEqual({ ok: false, failure: "strict_yield_pragma_not_exact" });
    expect(CODEX_GAMEPLAY_WRAPPER_FAILURES).toContain(rejected.failure);
    expect(rejected).not.toHaveProperty("reason");
    expect(rejected).not.toHaveProperty("input");

    const fenced = "```text\n" + accepted + "```\n";
    expect(classifyCodexGameplayWrapper(fenced, strict)).toEqual({
      ok: false,
      failure: "strict_yield_pragma_not_exact",
    });

    expect(classifyCodexGameplayWrapper(`${CODEX_EXEC_YIELD_PRAGMA}\n`, strict)).toEqual({
      ok: false,
      failure: "single_statement_shape",
    });
    const malformedCommentOnly = '//@exec:{"yield_time_ms":120000}';
    expect(Buffer.byteLength(malformedCommentOnly, "utf8")).toBe(32);
    expect(classifyCodexGameplayWrapper(malformedCommentOnly, strict)).toEqual({
      ok: false,
      failure: "strict_yield_pragma_not_exact",
    });
  });

  it("differentially rejects complete malformed wrappers exactly as the terminal audit does", () => {
    const strict = { codeModeContract: "strict-code-mode-v2" };
    const cases = [
      forwardingRollout(),
      ...[
        `${CODEX_EXEC_YIELD_PRAGMA}\ntext(await tools.mcp__adventureforge__start_overworld({});\n`,
        `${CODEX_EXEC_YIELD_PRAGMA}\ntext(await tools.mcp__adventureforge__start_overworld(({})));\n`,
        `// @exec: {"yield_time_ms":120000}\ntext(await tools.mcp__adventureforge__start_overworld({}));\n`,
      ].map((input) => {
        const rows = forwardingRollout();
        rolloutPayload(rows, 0).input = input;
        return rows;
      }),
    ];
    for (const rows of cases) {
      const streamed = inspectCodexGameplayResultForwardingPrefix(rows, strict);
      const terminal = inspectCodexGameplayResultForwarding(rows, strict);
      expect(streamed.ok).toBe(terminal.ok);
      if (!streamed.ok && !terminal.ok) expect(streamed.reason).toBe(terminal.reason);
    }
  });

  it("rejects a forbidden public MCP server from its complete start row", () => {
    const rows = sparkCodeModeRows();
    const started = rows.findIndex(
      (row) => row.type === "item.started" && row.item?.type === "mcp_tool_call",
    );
    if (started < 0) throw new Error("fixture is missing its gameplay start");
    rows[started]!.item!.server = "codex";
    expect(
      inspectCodexPureEventPrefix(rows.slice(0, started + 1), SPARK_MODEL, {
        codeModeContract: "strict-code-mode-v2",
      }),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/forbidden MCP server codex/i),
    });
  });

  it("rejects a yielded exec before its late MCP completion and native wait", () => {
    const [wrapper, completion] = forwardingRollout();
    const yielded = [
      wrapper,
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-wrapper-1",
          output: "Script running with cell ID 1\nWall time 10.5 seconds\nOutput:\n",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
      {
        type: "event_msg",
        payload: { type: "token_count", info: null, rate_limits: null },
      },
      completion,
      {
        type: "response_item",
        payload: {
          type: "reasoning",
          id: "reasoning-after-yield",
          summary: [],
          encrypted_content: "opaque",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          id: "wait-item-1",
          name: "wait",
          arguments: '{"cell_id":"1","yield_time_ms":30000,"max_tokens":10000}',
          call_id: "call-wait-1",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-wait-1",
          output: [
            {
              type: "input_text",
              text: "Script completed\nWall time 11.4 seconds\nOutput:\n",
            },
          ],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
    ];

    const inspected = inspectCodexGameplayResultForwarding(yielded);
    expect(inspected).toEqual({
      ok: false,
      reason:
        "Codex gameplay-result forwarding audit failed: gameplay call 1 has no immediate MCP completion",
    });
    expect(inspected.reason).not.toContain("state_hash");
  });

  it.each([
    {
      label: "the first bare text wrapper in the corrupt pattern",
      rows: forwardingRollout("Script completed\nWall time 0.0 seconds\nOutput:\n"),
      reason: /missing.*mismatched.*truncated/i,
    },
    {
      label: "the second bare text wrapper in the corrupt pattern",
      rows: forwardingRollout("Script completed\nWall time 0.0 seconds\nOutput:\n"),
      reason: /missing.*mismatched.*truncated/i,
    },
    {
      label: "the third bare text wrapper in the corrupt pattern",
      rows: forwardingRollout("Script completed\nWall time 0.0 seconds\nOutput:\n"),
      reason: /missing.*mismatched.*truncated/i,
    },
    {
      label: "a truncated wrapper payload",
      rows: forwardingRollout([{ type: "input_text", text: '{"content":[' }]),
      reason: /missing.*mismatched.*truncated/i,
    },
    {
      label: "a mismatched wrapper payload",
      rows: forwardingRollout([
        {
          type: "input_text",
          text: JSON.stringify({ content: [{ type: "text", text: "wrong" }] }),
        },
      ]),
      reason: /missing.*mismatched.*truncated/i,
    },
    {
      label: "an MCP result with unbound private fields",
      rows: forwardingRollout(undefined, {
        content: [{ type: "text", text: '{"state_hash":"next"}' }],
        private_only: "not present in the public result",
      }),
      reason: /no auditable immediate result/i,
    },
    {
      label: "an unpaired gameplay result",
      rows: forwardingRollout().slice(0, 2),
      reason: /no paired visible result output/i,
    },
    {
      label: "a duplicate wrapper output",
      rows: [...forwardingRollout(), structuredClone(forwardingRollout()[2])],
      reason: /orphan.*tool lifecycle/i,
    },
  ])("rejects $label without echoing hidden game content", ({ rows, reason }) => {
    const inspected = inspectCodexGameplayResultForwarding(rows);
    expect(inspected).toEqual({ ok: false, reason: expect.stringMatching(reason) });
    expect(inspected.reason).not.toContain("state_hash");
  });

  it("rejects every non-game raw tool lifecycle", () => {
    const rows = [
      {
        type: "event_msg",
        payload: {
          type: "mcp_tool_call_end",
          call_id: "exec-nongame",
          invocation: { server: "other", tool: "not-game", arguments: {} },
          result: { Ok: { content: [{ type: "text", text: "not player state" }] } },
        },
      },
    ];
    expect(inspectCodexGameplayResultForwarding(rows)).toEqual({
      ok: false,
      reason: expect.stringMatching(/orphan.*tool lifecycle/i),
    });

    const hiddenNativeCall = [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "local_shell",
          arguments: '{"command":"whoami"}',
        },
      },
      ...forwardingRollout(),
    ];
    expect(inspectCodexGameplayResultForwarding(hiddenNativeCall)).toEqual({
      ok: false,
      reason: expect.stringMatching(/forbidden private response item function_call/i),
    });

    const hiddenNativeEvent = [
      {
        type: "event_msg",
        payload: { type: "web_search_end", query: "hidden external lookup" },
      },
      ...forwardingRollout(),
    ];
    expect(inspectCodexGameplayResultForwarding(hiddenNativeEvent)).toEqual({
      ok: false,
      reason: expect.stringMatching(/forbidden private event/i),
    });

    const hiddenTopLevelActivity = [
      { type: "native_tool_activity", payload: { type: "completed" } },
      ...forwardingRollout(),
    ];
    expect(inspectCodexGameplayResultForwarding(hiddenTopLevelActivity)).toEqual({
      ok: false,
      reason: expect.stringMatching(/forbidden private rollout row/i),
    });
  });

  it.each([
    {
      label: "ALL_TOOLS inspection",
      input:
        "const hits = ALL_TOOLS.filter((tool) => tool.name.includes('adventureforge'));\ntext(hits);\n",
      server: "adventureforge",
      tool: "start_overworld",
    },
    {
      label: "resource access",
      input:
        "const result = await tools.mcp__adventureforge__list_mcp_resources({});\n" +
        "text(JSON.stringify(result));\n",
      server: "adventureforge",
      tool: "list_mcp_resources",
    },
    {
      label: "forbidden gameplay alias",
      input:
        "const result = await tools.mcp__adventureforge__step_rpg_session({});\n" +
        "text(JSON.stringify(result));\n",
      server: "adventureforge",
      tool: "step_rpg_session",
    },
    {
      label: "todo tool",
      input: "const result = await tools.update_plan({});\ntext(JSON.stringify(result));\n",
      server: "codex",
      tool: "update_plan",
    },
    {
      label: "extra wrapper activity",
      input:
        "const result = await tools.mcp__adventureforge__start_overworld({});\n" +
        "text(JSON.stringify(result));\ntext('extra');\n",
      server: "adventureforge",
      tool: "start_overworld",
    },
  ])("rejects $label in the raw wrapper", ({ input, server, tool }) => {
    const rows = forwardingRollout();
    rolloutPayload(rows, 0).input = input;
    const invocation = rolloutPayload(rows, 1).invocation as Record<string, unknown>;
    invocation.server = server;
    invocation.tool = tool;
    expect(inspectCodexGameplayResultForwarding(rows)).toEqual({
      ok: false,
      reason: expect.stringMatching(/forbidden wrapper program/i),
    });
  });

  it("cross-binds every ordered public/private gameplay lifecycle", () => {
    const publicRows = validRows();
    const privateRows = completeRollout(forwardingRollout(undefined, { content: [] }));
    expect(inspectCodexPureEvidence(publicRows, privateRows)).toMatchObject({
      ok: true,
      completedMcpCalls: 1,
    });

    const missing = inspectCodexPureEvidence(
      twoPublicGameplayCalls(),
      completeRollout(forwardingRollout(undefined, { content: [] })),
    );
    expect(missing).toEqual({ ok: false, reason: expect.stringMatching(/count differs/i) });

    const extra = inspectCodexPureEvidence(publicRows, completeRollout(twoPrivateGameplayCalls()));
    expect(extra).toEqual({ ok: false, reason: expect.stringMatching(/count differs/i) });

    const reordered = twoPrivateGameplayCalls();
    const first = reordered.splice(0, 3);
    reordered.push(...first);
    expect(inspectCodexPureEvidence(twoPublicGameplayCalls(), completeRollout(reordered))).toEqual({
      ok: false,
      reason: expect.stringMatching(/start_overworld exactly once/i),
    });

    const mismatched = forwardingRollout(undefined, { content: [] });
    rolloutPayload(mismatched, 0).input =
      "const result = await tools.mcp__adventureforge__get_overworld_session_context({});\n" +
      "text(JSON.stringify(result));\n";
    const mismatchedInvocation = rolloutPayload(mismatched, 1).invocation as Record<
      string,
      unknown
    >;
    mismatchedInvocation.tool = "get_overworld_session_context";
    expect(inspectCodexPureEvidence(publicRows, completeRollout(mismatched))).toEqual({
      ok: false,
      reason: expect.stringMatching(/differs at call 1/i),
    });

    expect(inspectCodexPureEvidence(publicRows, completeRollout(forwardingRollout()))).toEqual({
      ok: false,
      reason: expect.stringMatching(/differs at call 1/i),
    });

    const failedPublicCall = twoPublicGameplayCalls();
    const failedCompletion = failedPublicCall.find(
      (row) => row.type === "item.completed" && row.item?.id === "item_2",
    );
    if (!failedCompletion?.item) throw new Error("missing test gameplay completion");
    failedCompletion.item.status = "failed";
    expect(
      inspectCodexPureEvidence(
        failedPublicCall,
        completeRollout(twoPrivateGameplayCalls({ content: [], isError: true }, { content: [] })),
      ),
    ).toMatchObject({ ok: true, completedMcpCalls: 2 });

    expect(
      inspectCodexPureEvidence(
        failedPublicCall,
        completeRollout(twoPrivateGameplayCalls({ content: [] })),
      ),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/differs at call 2/i),
    });

    expect(
      inspectCodexPureEvidence(
        twoPublicGameplayCalls(),
        completeRollout(twoPrivateGameplayCalls({ content: [], isError: true }, { content: [] })),
      ),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/differs at call 2/i),
    });
  });

  it("accepts each exact native Codex capture profile", () => {
    const lunaGameplay = forwardingRollout(undefined, { content: [] });
    rolloutPayload(lunaGameplay, 0).input = legacyGameplayWrapper(
      "tools.mcp__adventureforge__start_overworld()",
    );
    const luna = completeRollout(lunaGameplay, "luna_v1");
    expect(inspectCodexPureEvidence(validRows(), luna, "gpt-5.6-luna")).toMatchObject({
      ok: true,
    });
    expect(
      buildCodexPureEnvelope({
        rows: validRows(),
        rolloutRows: luna,
        report: "report",
        model: "gpt-5.6-luna",
        durationMs: 1,
      }),
    ).toMatchObject({ ok: true, envelope: { requested_model: "gpt-5.6-luna" } });

    expect(
      inspectCodexPureEvidence(
        validRows(),
        completeRollout(forwardingRollout(undefined, { content: [] }), "sol_v2"),
        "gpt-5.6-sol",
      ),
    ).toMatchObject({ ok: true });
    expect(
      inspectCodexPureEvidence(
        validRows(),
        completeRollout(forwardingRollout(undefined, { content: [] }), "terra_v2"),
        "gpt-5.6-terra",
      ),
    ).toMatchObject({ ok: true });
    expect(
      inspectCodexPureEvidence(
        validRows(),
        completeRollout(forwardingRollout(undefined, { content: [] }), "spark_disabled"),
        "gpt-5.3-codex-spark",
      ),
    ).toMatchObject({ ok: true });
  });

  it("accepts only the exact Codex 0.146 Terra capture profile", () => {
    const rows = codex0146TerraRollout();
    expect(
      inspectCodexPureEvidence(validRows(), rows, "gpt-5.6-terra", {
        cliVersion: "0.146.0",
      }),
    ).toMatchObject({ ok: true, completedMcpCalls: 1 });
    expect(
      buildCodexPureEnvelope({
        rows: validRows(),
        rolloutRows: rows,
        report: "report",
        model: "gpt-5.6-terra",
        cliVersion: "0.146.0",
        durationMs: 1,
      }),
    ).toMatchObject({ ok: true, envelope: { requested_model: "gpt-5.6-terra" } });

    const wrongExpectedVersion = codex0146TerraRollout();
    expect(
      inspectCodexPureEvidence(validRows(), wrongExpectedVersion, "gpt-5.6-terra", {
        cliVersion: "0.146.1",
      }),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/capture profile is unsupported/i),
    });

    const wrongCapturedVersion = codex0146TerraRollout();
    const session = wrongCapturedVersion.find((row) => row.type === "session_meta")?.payload;
    if (!session) throw new Error("missing current session fixture");
    session.cli_version = "0.146.1";
    expect(
      inspectCodexPureEvidence(validRows(), wrongCapturedVersion, "gpt-5.6-terra", {
        cliVersion: "0.146.0",
      }),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/capture profile is unsupported/i),
    });

    for (const [label, mutate] of [
      [
        "altered no-delegation text",
        (candidate: typeof rows) => {
          const mode = candidate.find(
            (row) =>
              row.payload?.type === "message" &&
              Array.isArray(row.payload.content) &&
              (row.payload.content as Array<{ text?: string }>).some((block) =>
                block.text?.startsWith("<multi_agent_mode>"),
              ),
          )?.payload;
          const content = mode?.content as Array<{ text?: string }> | undefined;
          if (!content?.[0]) throw new Error("missing current mode fixture");
          content[0].text = `${V2_0146_MODE_BLOCK} `;
        },
      ],
      [
        "a stripped-id downgrade to the legacy metadata mode",
        (candidate: typeof rows) => {
          const context = candidate.find((row) => row.type === "turn_context")?.payload;
          if (!context) throw new Error("missing current context fixture");
          context.multi_agent_mode = "explicitRequestOnly";
          for (const row of candidate) {
            const candidatePayload = row.payload;
            if (
              candidatePayload?.type === "custom_tool_call_output" ||
              (candidatePayload?.type === "message" &&
                (candidatePayload.role === "developer" || candidatePayload.role === "user"))
            ) {
              delete candidatePayload.id;
            }
          }
        },
      ],
    ] as const) {
      const candidate = structuredClone(rows);
      mutate(candidate);
      expect(
        inspectCodexPureEvidence(validRows(), candidate, "gpt-5.6-terra", {
          cliVersion: "0.146.0",
        }),
        label,
      ).toMatchObject({ ok: false });
    }
  });

  it("requires exact, bounded, unique item ids throughout the Codex 0.146 profile", () => {
    const inspectCurrent = (rows: ReturnType<typeof codex0146TerraRollout>) =>
      inspectCodexPureEvidence(validRows(), rows, "gpt-5.6-terra", {
        cliVersion: "0.146.0",
      });
    const findInput = (rows: ReturnType<typeof codex0146TerraRollout>) => {
      const payload = rows.find(
        (row) =>
          row.payload?.type === "message" &&
          (row.payload.role === "developer" || row.payload.role === "user"),
      )?.payload;
      if (!payload) throw new Error("missing current input fixture");
      return payload;
    };
    const findOutput = (rows: ReturnType<typeof codex0146TerraRollout>) => {
      const payload = rows.find((row) => row.payload?.type === "custom_tool_call_output")?.payload;
      if (!payload) throw new Error("missing current output fixture");
      return payload;
    };

    for (const invalidId of ["", "x".repeat(129), 42, null]) {
      for (const locate of [findInput, findOutput]) {
        const rows = codex0146TerraRollout();
        locate(rows).id = invalidId;
        expect(inspectCurrent(rows)).toMatchObject({ ok: false });
      }
    }

    for (const locate of [findInput, findOutput]) {
      const missing = codex0146TerraRollout();
      delete locate(missing).id;
      expect(inspectCurrent(missing)).toMatchObject({ ok: false });

      const extra = codex0146TerraRollout();
      locate(extra).unexpected = true;
      expect(inspectCurrent(extra)).toMatchObject({ ok: false });
    }

    const duplicate = codex0146TerraRollout();
    findOutput(duplicate).id = findInput(duplicate).id;
    expect(inspectCurrent(duplicate)).toMatchObject({ ok: false });

    const legacyWithCurrentId = completeRollout(
      forwardingRollout(undefined, { content: [] }),
      "terra_v2",
    ) as Array<{ payload?: Record<string, unknown> }>;
    const legacyInput = legacyWithCurrentId.find(
      (row) => row.payload?.type === "message" && row.payload.role === "developer",
    )?.payload;
    if (!legacyInput) throw new Error("missing legacy input fixture");
    legacyInput.id = "unexpected-current-id";
    expect(
      inspectCodexPureEvidence(validRows(), legacyWithCurrentId, "gpt-5.6-terra"),
    ).toMatchObject({ ok: false });
  });

  it("accepts only the exact Codex 0.146 Spark capture profile", () => {
    const rows = codex0146SparkRollout();
    expect(
      inspectCodexPureEvidence(validRows(), rows, SPARK_MODEL, {
        cliVersion: "0.146.0",
      }),
    ).toMatchObject({ ok: true, completedMcpCalls: 1 });
    expect(
      buildCodexPureEnvelope({
        rows: validRows(),
        rolloutRows: rows,
        report: "report",
        model: SPARK_MODEL,
        cliVersion: "0.146.0",
        durationMs: 1,
      }),
    ).toMatchObject({ ok: true, envelope: { requested_model: SPARK_MODEL } });

    const wrongExpectedVersion = codex0146SparkRollout();
    expect(
      inspectCodexPureEvidence(validRows(), wrongExpectedVersion, SPARK_MODEL, {
        cliVersion: "0.146.1",
      }),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/capture profile is unsupported/i),
    });

    const wrongCapturedVersion = codex0146SparkRollout();
    const session = wrongCapturedVersion.find((row) => row.type === "session_meta")?.payload;
    if (!session) throw new Error("missing current session fixture");
    session.cli_version = "0.146.1";
    expect(
      inspectCodexPureEvidence(validRows(), wrongCapturedVersion, SPARK_MODEL, {
        cliVersion: "0.146.0",
      }),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/capture profile is unsupported/i),
    });
  });

  it("requires unique item ids throughout the Codex 0.146 Spark profile", () => {
    const inspectCurrent = (rows: ReturnType<typeof codex0146SparkRollout>) =>
      inspectCodexPureEvidence(validRows(), rows, SPARK_MODEL, {
        cliVersion: "0.146.0",
      });
    const findInput = (rows: ReturnType<typeof codex0146SparkRollout>) => {
      const payload = rows.find(
        (row) =>
          row.payload?.type === "message" &&
          (row.payload.role === "developer" || row.payload.role === "user"),
      )?.payload;
      if (!payload) throw new Error("missing current input fixture");
      return payload;
    };
    const findOutput = (rows: ReturnType<typeof codex0146SparkRollout>) => {
      const payload = rows.find((row) => row.payload?.type === "custom_tool_call_output")?.payload;
      if (!payload) throw new Error("missing current output fixture");
      return payload;
    };

    for (const locate of [findInput, findOutput]) {
      const missing = codex0146SparkRollout();
      delete locate(missing).id;
      expect(inspectCurrent(missing)).toMatchObject({ ok: false });
    }

    const duplicate = codex0146SparkRollout();
    findOutput(duplicate).id = findInput(duplicate).id;
    expect(inspectCurrent(duplicate)).toMatchObject({ ok: false });
  });

  it("retains Spark's legacy capture profile without item ids", () => {
    const legacy = completeRollout(forwardingRollout(undefined, { content: [] }), "spark_disabled");
    expect(inspectCodexPureEvidence(validRows(), legacy, SPARK_MODEL)).toMatchObject({ ok: true });

    const legacyInput = (legacy as Array<{ payload?: Record<string, unknown> }>).find(
      (row) => row.payload?.type === "message" && row.payload.role === "developer",
    )?.payload;
    if (!legacyInput) throw new Error("missing legacy Spark input fixture");
    legacyInput.id = "unexpected-current-id";
    expect(inspectCodexPureEvidence(validRows(), legacy, SPARK_MODEL)).toMatchObject({ ok: false });
  });

  it("accepts only the exact empty-audio user event added by Codex 0.145", () => {
    const publicRows = validRows();
    const current = completeRollout(forwardingRollout(undefined, { content: [] })) as Array<{
      payload?: Record<string, unknown>;
    }>;
    const currentUserEvent = current.find((row) => row.payload?.type === "user_message")?.payload;
    if (!currentUserEvent) throw new Error("missing private user-message fixture");
    currentUserEvent.audio = [];
    currentUserEvent.local_audio = [];
    expect(inspectCodexPureEvidence(publicRows, current, "gpt-5.6-sol")).toMatchObject({
      ok: true,
    });

    for (const [label, mutate] of [
      [
        "a missing local-audio field",
        (payload: Record<string, unknown>) => Reflect.deleteProperty(payload, "local_audio"),
      ],
      [
        "nonempty audio",
        (payload: Record<string, unknown>) => {
          payload.audio = ["hidden audio hint"];
        },
      ],
      [
        "nonempty local audio",
        (payload: Record<string, unknown>) => {
          payload.local_audio = ["hidden local-audio hint"];
        },
      ],
    ] as const) {
      const rows = structuredClone(current);
      const payload = rows.find((row) => row.payload?.type === "user_message")?.payload;
      if (!payload) throw new Error("missing private user-message fixture");
      mutate(payload);
      expect(inspectCodexPureEvidence(publicRows, rows, "gpt-5.6-sol"), label).toMatchObject({
        ok: false,
      });
    }
  });

  it("accepts the optional global AGENTS prelude without dropping bare environment support", () => {
    const profiles = [
      ["sol_v2", "gpt-5.6-sol"],
      ["terra_v2", "gpt-5.6-terra"],
      ["luna_v1", "gpt-5.6-luna"],
    ] as const;

    for (const [profile, model] of profiles) {
      const gameplay = forwardingRollout(undefined, { content: [] });
      if (profile === "luna_v1") {
        rolloutPayload(gameplay, 0).input = legacyGameplayWrapper(
          "tools.mcp__adventureforge__start_overworld()",
        );
      }
      const bare = completeRollout(gameplay, profile);
      expect(inspectCodexPureEvidence(validRows(), bare, model), `${profile} bare`).toMatchObject({
        ok: true,
      });

      const withGlobalAgents = structuredClone(bare);
      environmentInputContent(withGlobalAgents).unshift({
        type: "input_text",
        text: GLOBAL_AGENTS_BLOCK,
      });
      expect(
        inspectCodexPureEvidence(validRows(), withGlobalAgents, model),
        `${profile} global AGENTS`,
      ).toMatchObject({ ok: true });
    }
  });

  it.each([
    [
      "a project-scoped header",
      "# AGENTS.md instructions for C:\\dev\\adventureforge\n\n" +
        "<INSTRUCTIONS>\n- Follow the project charter.\n</INSTRUCTIONS>",
    ],
    [
      "AdventureForge contamination",
      GLOBAL_AGENTS_BLOCK.replace(
        "- Keep changes scoped to the requested task unless a broader fix is necessary.",
        "- Inspect AdventureForge before beginning.",
      ),
    ],
    [
      "game-specific contamination",
      GLOBAL_AGENTS_BLOCK.replace(
        "- Keep changes scoped to the requested task unless a broader fix is necessary.",
        "- Complete wolf_winter and return to Albany.",
      ),
    ],
    ["a missing closing wrapper", GLOBAL_AGENTS_BLOCK.replace("\n</INSTRUCTIONS>", "")],
    [
      "a malformed opening wrapper",
      GLOBAL_AGENTS_BLOCK.replace("<INSTRUCTIONS>", '<INSTRUCTIONS source="global">'),
    ],
  ])("rejects an optional global AGENTS block with $0", (_label, agentsBlock) => {
    const rows = completeRollout(forwardingRollout(undefined, { content: [] }), "sol_v2");
    environmentInputContent(rows).unshift({ type: "input_text", text: agentsBlock });
    expect(inspectCodexPureEvidence(validRows(), rows, "gpt-5.6-sol")).toEqual({
      ok: false,
      reason: expect.stringMatching(/input and initial context lifecycle is out of order/i),
    });
  });

  it("rejects a third environment input block after a valid global AGENTS prelude", () => {
    const rows = completeRollout(forwardingRollout(undefined, { content: [] }), "sol_v2");
    const content = environmentInputContent(rows);
    content.unshift({ type: "input_text", text: GLOBAL_AGENTS_BLOCK });
    content.push({ type: "input_text", text: "unexpected third block" });
    expect(inspectCodexPureEvidence(validRows(), rows, "gpt-5.6-sol")).toEqual({
      ok: false,
      reason: expect.stringMatching(/input and initial context lifecycle is out of order/i),
    });
  });

  it.each([
    [
      "an inner Terra model under outer Sol",
      (context: Record<string, unknown>) => {
        const collaboration = context.collaboration_mode as Record<string, unknown>;
        const settings = collaboration.settings as Record<string, unknown>;
        settings.model = "gpt-5.6-terra";
      },
    ],
    [
      "a missing collaboration mode",
      (context: Record<string, unknown>) => delete context.collaboration_mode,
    ],
    [
      "an extra collaboration field",
      (context: Record<string, unknown>) => {
        const collaboration = context.collaboration_mode as Record<string, unknown>;
        collaboration.extra = true;
      },
    ],
    [
      "a missing inner model",
      (context: Record<string, unknown>) => {
        const collaboration = context.collaboration_mode as Record<string, unknown>;
        const settings = collaboration.settings as Record<string, unknown>;
        delete settings.model;
      },
    ],
    [
      "an extra collaboration setting",
      (context: Record<string, unknown>) => {
        const collaboration = context.collaboration_mode as Record<string, unknown>;
        const settings = collaboration.settings as Record<string, unknown>;
        settings.extra = true;
      },
    ],
    [
      "a non-default collaboration mode",
      (context: Record<string, unknown>) => {
        const collaboration = context.collaboration_mode as Record<string, unknown>;
        collaboration.mode = "plan";
      },
    ],
    [
      "a reasoning-effort mismatch",
      (context: Record<string, unknown>) => {
        const collaboration = context.collaboration_mode as Record<string, unknown>;
        const settings = collaboration.settings as Record<string, unknown>;
        settings.reasoning_effort = "high";
      },
    ],
    [
      "a missing reasoning effort",
      (context: Record<string, unknown>) => {
        const collaboration = context.collaboration_mode as Record<string, unknown>;
        const settings = collaboration.settings as Record<string, unknown>;
        delete settings.reasoning_effort;
      },
    ],
    [
      "injected developer instructions",
      (context: Record<string, unknown>) => {
        const collaboration = context.collaboration_mode as Record<string, unknown>;
        const settings = collaboration.settings as Record<string, unknown>;
        settings.developer_instructions = "injected";
      },
    ],
    ["an outer effort mismatch", (context: Record<string, unknown>) => (context.effort = "high")],
  ])("rejects $0 in the native collaboration identity", (_label, mutate) => {
    const rows = completeRollout(forwardingRollout(undefined, { content: [] }), "sol_v2") as Array<{
      type?: string;
      payload?: Record<string, unknown>;
    }>;
    const context = rows.find((row) => row.type === "turn_context")?.payload;
    if (!context) throw new Error("missing collaboration context fixture");
    mutate(context);
    expect(inspectCodexPureEvidence(validRows(), rows, "gpt-5.6-sol")).toMatchObject({
      ok: false,
    });
  });

  it("rejects the inverse inner Sol model under outer Terra", () => {
    const rows = completeRollout(
      forwardingRollout(undefined, { content: [] }),
      "terra_v2",
    ) as Array<{ type?: string; payload?: Record<string, unknown> }>;
    const context = rows.find((row) => row.type === "turn_context")?.payload;
    const collaboration = context?.collaboration_mode as Record<string, unknown> | undefined;
    const settings = collaboration?.settings as Record<string, unknown> | undefined;
    if (!settings) throw new Error("missing Terra collaboration fixture");
    settings.model = "gpt-5.6-sol";
    expect(inspectCodexPureEvidence(validRows(), rows, "gpt-5.6-terra")).toMatchObject({
      ok: false,
    });
  });

  it.each([
    ["a Luna model alias", (context: Record<string, unknown>) => (context.model = "luna")],
    [
      "Luna serialized as v2",
      (context: Record<string, unknown>) => {
        context.multi_agent_version = "v2";
        context.multi_agent_mode = "explicitRequestOnly";
      },
    ],
    [
      "Luna with a multi-agent mode",
      (context: Record<string, unknown>) => {
        context.multi_agent_mode = "explicitRequestOnly";
      },
    ],
    [
      "Luna with the wrong version",
      (context: Record<string, unknown>) => {
        context.multi_agent_version = "v0";
      },
    ],
  ])("rejects $0", (_label, mutate) => {
    const rows = completeRollout(
      forwardingRollout(undefined, { content: [] }),
      "luna_v1",
    ) as Array<{
      type?: string;
      payload?: Record<string, unknown>;
    }>;
    const context = rows.find((row) => row.type === "turn_context")?.payload;
    if (!context) throw new Error("missing Luna context fixture");
    mutate(context);
    expect(inspectCodexPureEvidence(validRows(), rows)).toEqual({
      ok: false,
      reason: expect.stringMatching(/capture profile is unsupported/i),
    });
  });

  it.each(["gpt-5.6-sol", "gpt-5.6-terra"])("rejects %s serialized as v1", (model) => {
    const profile = model.endsWith("terra") ? "terra_v2" : "sol_v2";
    const rows = completeRollout(forwardingRollout(undefined, { content: [] }), profile) as Array<{
      type?: string;
      payload?: Record<string, unknown>;
    }>;
    const context = rows.find((row) => row.type === "turn_context")?.payload;
    if (!context) throw new Error("missing v2 context fixture");
    context.multi_agent_version = "v1";
    delete context.multi_agent_mode;
    expect(inspectCodexPureEvidence(validRows(), rows)).toMatchObject({ ok: false });
  });

  it("retains Spark's exact disabled multi-agent capture profile", () => {
    const rows = completeRollout(
      forwardingRollout(undefined, { content: [] }),
      "spark_disabled",
    ) as Array<{ type?: string; payload?: Record<string, unknown> }>;
    const context = rows.find((row) => row.type === "turn_context")?.payload;
    if (!context) throw new Error("missing Spark context fixture");
    context.multi_agent_version = "v1";
    expect(inspectCodexPureEvidence(validRows(), rows)).toMatchObject({ ok: false });
  });

  it("retains the exact v2 developer ordering and explicitRequestOnly mode", () => {
    const baseline = completeRollout(
      forwardingRollout(undefined, { content: [] }),
      "sol_v2",
    ) as Array<{ type?: string; payload?: Record<string, unknown> }>;
    const mutations: Array<[string, (rows: typeof baseline) => void]> = [
      ["swapped team and mode messages", (rows) => ([rows[3], rows[4]] = [rows[4]!, rows[3]!])],
      ["missing mode message", (rows) => rows.splice(4, 1)],
      [
        "wrong turn mode",
        (rows) => {
          const context = rows.find((row) => row.type === "turn_context")?.payload;
          if (context) context.multi_agent_mode = "auto";
        },
      ],
    ];
    for (const [label, mutate] of mutations) {
      const rows = structuredClone(baseline);
      mutate(rows);
      expect(inspectCodexPureEvidence(validRows(), rows), label).toMatchObject({ ok: false });
    }
  });

  it("rejects every Luna v1 prelude topology mutation", () => {
    const baseline = completeRollout(
      forwardingRollout(undefined, { content: [] }),
      "luna_v1",
    ) as Array<{
      type?: string;
      payload?: {
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
        internal_chat_message_metadata_passthrough?: { turn_id?: string };
      };
    }>;
    const mutations: Array<[string, (rows: typeof baseline) => void]> = [
      ["permission/skills block count", (rows) => rows[2]?.payload?.content?.pop()],
      [
        "permission/skills block order",
        (rows) => {
          const content = rows[2]?.payload?.content;
          if (content) content.reverse();
        },
      ],
      [
        "environment role",
        (rows) => {
          const environment = rows[3]?.payload;
          if (environment) environment.role = "developer";
        },
      ],
      [
        "environment turn",
        (rows) => {
          const metadata = rows[3]?.payload?.internal_chat_message_metadata_passthrough;
          if (metadata) metadata.turn_id = "other-turn";
        },
      ],
      ["world/context order", (rows) => ([rows[4], rows[5]] = [rows[5]!, rows[4]!])],
      ["extra prelude row", (rows) => rows.splice(4, 0, structuredClone(rows[2]!))],
    ];
    for (const [label, mutate] of mutations) {
      const rows = structuredClone(baseline);
      mutate(rows);
      expect(inspectCodexPureEvidence(validRows(), rows), label).toMatchObject({ ok: false });
    }
  });

  it("binds the requested model to the private capture profile", () => {
    const luna = completeRollout(forwardingRollout(undefined, { content: [] }), "luna_v1");
    expect(
      buildCodexPureEnvelope({
        rows: validRows(),
        rolloutRows: luna,
        report: "report",
        model: "gpt-5.6-sol",
        durationMs: 1,
      }),
    ).toEqual({ ok: false, reason: expect.stringMatching(/capture profile is unsupported/i) });
    expect(
      buildCodexPureEnvelope({
        rows: validRows(),
        rolloutRows: luna,
        report: "report",
        model: "gpt-5.6-luna-latest",
        durationMs: 1,
      }),
    ).toEqual({ ok: false, reason: "Codex pure run is missing its requested model" });
  });

  it("permits argumentless syntax only for the first start_overworld wrapper", () => {
    const argumentless = forwardingRollout();
    rolloutPayload(argumentless, 0).input = legacyGameplayWrapper(
      "tools.mcp__adventureforge__start_overworld()",
    );
    expect(inspectCodexGameplayResultForwarding(argumentless)).toMatchObject({ ok: true });

    const nonemptyRecordedArguments = structuredClone(argumentless);
    const recordedInvocation = rolloutPayload(nonemptyRecordedArguments, 1).invocation as Record<
      string,
      unknown
    >;
    recordedInvocation.arguments = { seed: 7 };
    expect(inspectCodexGameplayResultForwarding(nonemptyRecordedArguments)).toMatchObject({
      ok: false,
    });

    const otherTool = forwardingRollout();
    rolloutPayload(otherTool, 0).input = legacyGameplayWrapper(
      "tools.mcp__adventureforge__get_overworld_session_context()",
    );
    const otherInvocation = rolloutPayload(otherTool, 1).invocation as Record<string, unknown>;
    otherInvocation.tool = "get_overworld_session_context";
    expect(inspectCodexGameplayResultForwarding(otherTool)).toMatchObject({ ok: false });

    const laterStart = twoPrivateGameplayCalls();
    rolloutPayload(laterStart, 3).input = legacyGameplayWrapper(
      "tools.mcp__adventureforge__start_overworld()",
    );
    const laterInvocation = rolloutPayload(laterStart, 4).invocation as Record<string, unknown>;
    laterInvocation.tool = "start_overworld";
    expect(inspectCodexGameplayResultForwarding(laterStart)).toMatchObject({ ok: false });

    const nonemptyFreshStart = forwardingRollout();
    rolloutPayload(nonemptyFreshStart, 0).input = legacyGameplayWrapper(
      "tools.mcp__adventureforge__start_overworld({seed:7})",
    );
    const nonemptyInvocation = rolloutPayload(nonemptyFreshStart, 1).invocation as Record<
      string,
      unknown
    >;
    nonemptyInvocation.arguments = { seed: 7 };
    const publicRows = validRows();
    for (const row of publicRows) {
      if (row.item?.type === "mcp_tool_call") row.item.arguments = { seed: 7 };
    }
    expect(
      inspectCodexPureEvidence(publicRows, completeRollout(nonemptyFreshStart, "luna_v1")),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/must begin gameplay with start_overworld and no arguments/i),
    });
  });

  it("permits v2 zero-argument syntax only for the first fresh start", () => {
    const strict = { codeModeContract: "strict-code-mode-v2" };
    const freshStart = forwardingRollout();
    rolloutPayload(freshStart, 0).input =
      `${CODEX_EXEC_YIELD_PRAGMA}\n` +
      "text(await tools.mcp__adventureforge__start_overworld());\n";
    expect(inspectCodexGameplayResultForwarding(freshStart, strict)).toMatchObject({ ok: true });

    const otherTool = forwardingRollout();
    rolloutPayload(otherTool, 0).input =
      `${CODEX_EXEC_YIELD_PRAGMA}\n` +
      "text(await tools.mcp__adventureforge__get_overworld_session_context());\n";
    const otherInvocation = rolloutPayload(otherTool, 1).invocation as Record<string, unknown>;
    otherInvocation.tool = "get_overworld_session_context";
    expect(inspectCodexGameplayResultForwarding(otherTool, strict)).toMatchObject({ ok: false });

    const laterFreshStart = twoPrivateGameplayCalls();
    rolloutPayload(laterFreshStart, 3).input =
      `${CODEX_EXEC_YIELD_PRAGMA}\n` +
      "text(await tools.mcp__adventureforge__start_overworld());\n";
    const laterInvocation = rolloutPayload(laterFreshStart, 4).invocation as Record<
      string,
      unknown
    >;
    laterInvocation.tool = "start_overworld";
    expect(inspectCodexGameplayResultForwarding(laterFreshStart, strict)).toMatchObject({
      ok: false,
    });
  });

  it("rejects a second fresh start in both public and private pure evidence", () => {
    const publicRows = validRows();
    publicRows.splice(-1, 0, ...gameplayCallRows("item_2", "start_overworld", {}));
    expect(inspectCodexPureEvents(publicRows)).toEqual({
      ok: false,
      reason: expect.stringMatching(/start_overworld exactly once/i),
    });

    const privateRows = twoPrivateGameplayCalls();
    rolloutPayload(privateRows, 3).input = canonicalGameplayWrapper(
      "tools.mcp__adventureforge__start_overworld({})",
    );
    const invocation = rolloutPayload(privateRows, 4).invocation as Record<string, unknown>;
    invocation.tool = "start_overworld";
    expect(inspectCodexGameplayResultForwarding(privateRows)).toEqual({
      ok: false,
      reason: expect.stringMatching(/start_overworld exactly once/i),
    });
  });

  it("accepts harmless trailing commas in JSON-valued object literals", () => {
    const rows = twoPrivateGameplayCalls();
    rolloutPayload(rows, 3).input =
      `${CODEX_EXEC_YIELD_PRAGMA}\n` +
      'text(await tools.mcp__adventureforge__get_overworld_session_context({ session_id: "ow", fields: ["goal",], }));\n';
    const invocation = rolloutPayload(rows, 4).invocation as Record<string, unknown>;
    invocation.arguments = { session_id: "ow", fields: ["goal"] };
    expect(
      inspectCodexGameplayResultForwarding(rows, {
        codeModeContract: "strict-code-mode-v2",
      }),
    ).toMatchObject({ ok: true });
  });

  it.each([
    [
      "an aliased call",
      "const start = tools.mcp__adventureforge__start_overworld;\nconst result = await start();\ntext(JSON.stringify(result));\n",
    ],
    [
      "an optional call",
      "const result = await tools.mcp__adventureforge__start_overworld?.();\ntext(JSON.stringify(result));\n",
    ],
    [
      "a computed call",
      'const result = await tools["mcp__adventureforge__start_overworld"]();\ntext(JSON.stringify(result));\n',
    ],
    [
      "an extra statement",
      "const result = await tools.mcp__adventureforge__start_overworld();\ntext(JSON.stringify(result));\ntext('extra');\n",
    ],
    [
      "a truncated wrapper",
      "const result = await tools.mcp__adventureforge__start_overworld(\ntext(JSON.stringify(result));\n",
    ],
  ])("keeps rejecting $0 around the Luna argumentless exception", (_label, input) => {
    const rows = forwardingRollout();
    rolloutPayload(rows, 0).input = input;
    expect(inspectCodexGameplayResultForwarding(rows)).toEqual({
      ok: false,
      reason: expect.stringMatching(/forbidden wrapper program/i),
    });
  });

  it("rejects injected private input and orphan context lifecycles", () => {
    const publicRows = validRows();
    const baseline = completeRollout(forwardingRollout(undefined, { content: [] }));
    const firstGameplay = baseline.findIndex(
      (row) =>
        (row as { type?: string; payload?: { type?: string } }).type === "response_item" &&
        (row as { payload?: { type?: string } }).payload?.type === "custom_tool_call",
    );
    const initialTurnContext = baseline.find(
      (row) => (row as { type?: string }).type === "turn_context",
    );
    const mutations: Array<[string, unknown]> = [
      ["duplicate user input", { type: "event_msg", payload: { type: "user_message" } }],
      ["orphan world state", { type: "world_state", payload: { full: false } }],
      ["orphan turn context", structuredClone(initialTurnContext)],
      [
        "late developer input",
        { type: "response_item", payload: { type: "message", role: "developer", content: [] } },
      ],
      [
        "tool-role message",
        { type: "response_item", payload: { type: "message", role: "tool", content: [] } },
      ],
    ];
    for (const [label, injected] of mutations) {
      const rows = structuredClone(baseline);
      rows.splice(firstGameplay, 0, injected);
      expect(inspectCodexPureEvidence(publicRows, rows), label).toMatchObject({ ok: false });
    }

    const hiddenPrelude = structuredClone(baseline);
    const worldState = hiddenPrelude.findIndex(
      (row) => (row as { type?: string }).type === "world_state",
    );
    hiddenPrelude.splice(worldState, 0, structuredClone(baseline[2]));
    expect(inspectCodexPureEvidence(publicRows, hiddenPrelude)).toMatchObject({ ok: false });

    const auxiliaryInput = structuredClone(baseline) as Array<{
      type?: string;
      payload?: { type?: string; message?: string; images?: unknown[] };
    }>;
    const userMessage = auxiliaryInput.find((row) => row.payload?.type === "user_message");
    if (!userMessage?.payload?.images) throw new Error("missing private user-message fixture");
    userMessage.payload.images.push("hidden image hint");
    expect(inspectCodexPureEvidence(publicRows, auxiliaryInput)).toMatchObject({ ok: false });

    const mismatchedPrompt = structuredClone(baseline) as Array<{
      payload?: { type?: string; message?: string };
    }>;
    const promptEvent = mismatchedPrompt.find((row) => row.payload?.type === "user_message");
    if (!promptEvent?.payload) throw new Error("missing private prompt event fixture");
    promptEvent.payload.message = "different prompt";
    expect(inspectCodexPureEvidence(publicRows, mismatchedPrompt)).toMatchObject({ ok: false });

    for (const [label, payloadType, mutateMetadata] of [
      [
        "wrong wrapper turn",
        "custom_tool_call",
        (metadata: Record<string, unknown>) => {
          metadata.turn_id = "other-turn";
        },
      ],
      [
        "wrong output turn",
        "custom_tool_call_output",
        (metadata: Record<string, unknown>) => {
          metadata.turn_id = "other-turn";
        },
      ],
      ["missing wrapper metadata", "custom_tool_call", null],
      [
        "extra output metadata",
        "custom_tool_call_output",
        (metadata: Record<string, unknown>) => {
          metadata.hidden = true;
        },
      ],
    ] as const) {
      const rows = structuredClone(baseline) as Array<{
        payload?: {
          type?: string;
          internal_chat_message_metadata_passthrough?: Record<string, unknown>;
        };
      }>;
      const target = rows.find((row) => row.payload?.type === payloadType);
      if (!target?.payload) throw new Error(`missing ${label} fixture`);
      if (mutateMetadata === null) {
        delete target.payload.internal_chat_message_metadata_passthrough;
      } else {
        const metadata = target.payload.internal_chat_message_metadata_passthrough;
        if (!metadata) throw new Error(`missing ${label} metadata fixture`);
        mutateMetadata(metadata);
      }
      expect(inspectCodexPureEvidence(publicRows, rows), label).toMatchObject({ ok: false });
    }

    const invalidAssistantContent = structuredClone(baseline) as Array<{
      payload?: { type?: string; role?: string; content?: Array<{ type?: string }> };
    }>;
    const assistant = invalidAssistantContent.find(
      (row) => row.payload?.type === "message" && row.payload.role === "assistant",
    );
    if (!assistant?.payload?.content?.[0]) throw new Error("missing assistant fixture");
    assistant.payload.content[0].type = "input_image";
    expect(inspectCodexPureEvidence(publicRows, invalidAssistantContent)).toMatchObject({
      ok: false,
    });

    const reasoningRows = structuredClone(baseline) as Array<{
      payload?: Record<string, unknown>;
    }>;
    reasoningRows.splice(firstGameplay, 0, {
      type: "response_item",
      payload: {
        type: "reasoning",
        id: "reasoning-1",
        summary: [],
        encrypted_content: "opaque",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      },
    } as (typeof reasoningRows)[number]);
    expect(inspectCodexPureEvidence(publicRows, reasoningRows)).toMatchObject({ ok: true });
    const reasoning = reasoningRows.find((row) => row.payload?.type === "reasoning");
    if (!reasoning?.payload) throw new Error("missing reasoning fixture");
    for (const [label, summary] of [
      ["missing reasoning summary array", undefined],
      ["nonempty reasoning summary array", [{ type: "summary_text", text: "leaked" }]],
    ] as const) {
      const changedReasoning = structuredClone(reasoningRows) as Array<{
        payload?: Record<string, unknown>;
      }>;
      const changed = changedReasoning.find((row) => row.payload?.type === "reasoning")?.payload;
      if (!changed) throw new Error(`missing ${label} fixture`);
      if (summary === undefined) delete changed.summary;
      else changed.summary = summary;
      expect(inspectCodexPureEvidence(publicRows, changedReasoning), label).toMatchObject({
        ok: false,
      });
    }
    reasoning.payload.tool_input = "hidden";
    expect(inspectCodexPureEvidence(publicRows, reasoningRows)).toMatchObject({ ok: false });
  });

  it.each([
    ["Sol", "sol_v2", "gpt-5.6-sol"],
    ["Terra", "terra_v2", "gpt-5.6-terra"],
    ["Luna", "luna_v1", "gpt-5.6-luna"],
  ] as const)(
    "rejects compaction and repeated private state for strict %s evidence",
    (_label, profile, model) => {
      const publicRows = validRows();
      const gameplay = forwardingRollout(undefined, { content: [] });
      if (profile === "luna_v1") {
        rolloutPayload(gameplay, 0).input = legacyGameplayWrapper(
          "tools.mcp__adventureforge__start_overworld()",
        );
      }
      const baseline = completeRollout(gameplay, profile);
      const initialTurnContext = baseline.find(
        (row) => (row as { type?: string }).type === "turn_context",
      );
      if (!initialTurnContext) throw new Error(`missing ${model} turn-context fixture`);

      const mutations: Array<[string, unknown]> = [
        ["a compacted row", { type: "compacted", payload: { window_number: 2 } }],
        [
          "a context_compacted event",
          { type: "event_msg", payload: { type: "context_compacted" } },
        ],
        ["an additional world_state", { type: "world_state", payload: { full: true } }],
        ["an additional turn_context", structuredClone(initialTurnContext)],
      ];
      for (const [mutation, injected] of mutations) {
        const rows = structuredClone(baseline);
        rows.splice(-2, 0, injected);
        expect(inspectCodexPureEvidence(publicRows, rows, model), mutation).toEqual({
          ok: false,
          reason: expect.stringMatching(/does not permit context compaction/i),
        });
      }

      const fullLifecycle = structuredClone(baseline);
      fullLifecycle.splice(-2, 0, { type: "compacted", payload: { window_number: 2 } });
      fullLifecycle.splice(-2, 0, { type: "world_state", payload: { full: true } });
      fullLifecycle.splice(-2, 0, structuredClone(initialTurnContext));
      fullLifecycle.splice(-2, 0, {
        type: "event_msg",
        payload: { type: "context_compacted" },
      });
      expect(inspectCodexPureEvidence(publicRows, fullLifecycle, model)).toEqual({
        ok: false,
        reason: expect.stringMatching(/does not permit context compaction/i),
      });
    },
  );

  it("binds wrapper output ids and rejects duplicates and orphans anywhere", () => {
    const wrongOutputId = forwardingRollout();
    rolloutPayload(wrongOutputId, 2).call_id = "unrelated-output";
    expect(inspectCodexGameplayResultForwarding(wrongOutputId)).toEqual({
      ok: false,
      reason: expect.stringMatching(/missing.*mismatched.*truncated/i),
    });

    const duplicate = twoPrivateGameplayCalls();
    rolloutPayload(duplicate, 3).call_id = "call-wrapper-1";
    rolloutPayload(duplicate, 5).call_id = "call-wrapper-1";
    expect(inspectCodexGameplayResultForwarding(duplicate)).toEqual({
      ok: false,
      reason: expect.stringMatching(/duplicate wrapper start/i),
    });

    const wrapperReusesMcpId = twoPrivateGameplayCalls();
    rolloutPayload(wrapperReusesMcpId, 3).call_id = "exec-gameplay-1";
    rolloutPayload(wrapperReusesMcpId, 5).call_id = "exec-gameplay-1";
    expect(inspectCodexGameplayResultForwarding(wrapperReusesMcpId)).toEqual({
      ok: false,
      reason: expect.stringMatching(/invalid or duplicate wrapper start/i),
    });

    const mcpReusesWrapperId = twoPrivateGameplayCalls();
    rolloutPayload(mcpReusesWrapperId, 4).call_id = "call-wrapper-1";
    expect(inspectCodexGameplayResultForwarding(mcpReusesWrapperId)).toEqual({
      ok: false,
      reason: expect.stringMatching(/invalid or duplicate MCP call id/i),
    });

    const orphanStart = forwardingRollout();
    orphanStart.push(structuredClone(orphanStart[0]));
    expect(inspectCodexGameplayResultForwarding(orphanStart)).toEqual({
      ok: false,
      reason: expect.stringMatching(/duplicate wrapper start/i),
    });
  });

  it("accepts one completed AdventureForge-only thread and normalizes telemetry", () => {
    expect(inspectCodexPureEvents(validRows())).toEqual({
      ok: true,
      threadId: THREAD_ID,
      completedMcpCalls: 1,
      gameplayCalls: [
        {
          tool: "start_overworld",
          arguments: {},
          status: "completed",
          result: { content: [] },
          error: null,
        },
      ],
      usage: {
        input_tokens: 120,
        cached_input_tokens: 80,
        output_tokens: 40,
        reasoning_output_tokens: 10,
      },
    });

    const built = buildCodexPureEnvelope({
      rows: validRows(),
      rolloutRows: completeRollout(forwardingRollout(undefined, { content: [] })),
      report: "# Playthrough log\n\n# Verdict\n\n```json exit-interview\n{}\n```\n",
      model: "gpt-5.6-sol",
      durationMs: 1234,
    });
    expect(built).toMatchObject({
      ok: true,
      envelope: {
        provider: "codex",
        is_error: false,
        duration_ms: 1234,
        num_turns: 1,
        session_id: THREAD_ID,
        requested_model: "gpt-5.6-sol",
        terminal_reason: "completed",
        usage: {
          input_tokens: 120,
          cache_read_input_tokens: 80,
          output_tokens: 40,
          reasoning_output_tokens: 10,
        },
      },
    });
  });

  it("accepts only the exact ordered Spark code-mode compatibility prelude", () => {
    const publicRows = sparkCodeModeRows();
    const rolloutRows = completeRollout(
      forwardingRollout(undefined, { content: [] }),
      "spark_disabled",
    );
    expect(inspectCodexPureEvidence(publicRows, rolloutRows, SPARK_MODEL)).toMatchObject({
      ok: true,
      completedMcpCalls: 1,
    });
    const alternateIds = sparkCodeModeRows();
    alternateIds[1]!.item!.id = "compatibility-warning-a";
    alternateIds[2]!.item!.id = "compatibility-warning-b";
    expect(inspectCodexPureEvents(alternateIds, SPARK_MODEL)).toMatchObject({ ok: true });
    expect(
      buildCodexPureEnvelope({
        rows: publicRows,
        rolloutRows,
        report: "# Playthrough log\n\n# Verdict\n\n```json exit-interview\n{}\n```\n",
        model: SPARK_MODEL,
        durationMs: 1234,
      }),
    ).toMatchObject({ ok: true, envelope: { requested_model: SPARK_MODEL } });

    const rejected = [
      {
        label: "an unspecified model",
        rows: sparkCodeModeRows(),
        model: undefined,
      },
      {
        label: "another model",
        rows: sparkCodeModeRows(),
        model: "gpt-5.6-sol",
      },
      {
        label: "one warning only",
        rows: (() => {
          const rows = sparkCodeModeRows();
          rows.splice(2, 1);
          return rows;
        })(),
        model: SPARK_MODEL,
      },
      {
        label: "reversed warnings",
        rows: (() => {
          const rows = sparkCodeModeRows();
          [rows[1], rows[2]] = [rows[2]!, rows[1]!];
          return rows;
        })(),
        model: SPARK_MODEL,
      },
      {
        label: "a changed metadata warning",
        rows: (() => {
          const rows = sparkCodeModeRows();
          rows[2]!.item!.message = `${SPARK_METADATA_WARNING} changed`;
          return rows;
        })(),
        model: SPARK_MODEL,
      },
      {
        label: "a changed unstable-warning prefix",
        rows: (() => {
          const rows = sparkCodeModeRows();
          rows[1]!.item!.message = `Changed: ${rows[1]!.item!.message}`;
          return rows;
        })(),
        model: SPARK_MODEL,
      },
      {
        label: "a relative unstable-warning config path",
        rows: (() => {
          const rows = sparkCodeModeRows();
          rows[1]!.item!.message = `${SPARK_UNSTABLE_WARNING_PREFIX}config.toml.`;
          return rows;
        })(),
        model: SPARK_MODEL,
      },
      {
        label: "text prefixed to the config path",
        rows: (() => {
          const rows = sparkCodeModeRows();
          rows[1]!.item!.message = `${SPARK_UNSTABLE_WARNING_PREFIX}ALTERED EXTRA TEXT C:\\Users\\operator\\.codex\\config.toml.`;
          return rows;
        })(),
        model: SPARK_MODEL,
      },
      {
        label: "a dot-segment config path",
        rows: (() => {
          const rows = sparkCodeModeRows();
          rows[1]!.item!.message = `${SPARK_UNSTABLE_WARNING_PREFIX}C:\\Users\\operator\\.codex\\..\\config.toml.`;
          return rows;
        })(),
        model: SPARK_MODEL,
      },
      {
        label: "duplicate warning item ids",
        rows: (() => {
          const rows = sparkCodeModeRows();
          rows[2]!.item!.id = rows[1]!.item!.id;
          return rows;
        })(),
        model: SPARK_MODEL,
      },
      {
        label: "an invalid warning item id",
        rows: (() => {
          const rows = sparkCodeModeRows();
          rows[1]!.item!.id = "";
          return rows;
        })(),
        model: SPARK_MODEL,
      },
      {
        label: "an updated warning lifecycle",
        rows: (() => {
          const rows = sparkCodeModeRows();
          rows[1]!.type = "item.updated";
          return rows;
        })(),
        model: SPARK_MODEL,
      },
      {
        label: "an extra warning field",
        rows: (() => {
          const rows = sparkCodeModeRows();
          (rows[1]!.item as TestItem & { extra?: boolean }).extra = true;
          return rows;
        })(),
        model: SPARK_MODEL,
      },
      {
        label: "a warning after turn start",
        rows: (() => {
          const rows = sparkCodeModeRows();
          rows.splice(1, 2);
          rows.splice(2, 0, {
            type: "item.completed",
            item: { id: "item_1", type: "error", message: SPARK_METADATA_WARNING },
          });
          return rows;
        })(),
        model: SPARK_MODEL,
      },
      {
        label: "a third warning",
        rows: (() => {
          const rows = sparkCodeModeRows();
          rows.splice(3, 0, {
            type: "item.completed",
            item: { id: "item_extra", type: "error", message: SPARK_METADATA_WARNING },
          });
          return rows;
        })(),
        model: SPARK_MODEL,
      },
      {
        label: "a reused prelude warning object later in the turn",
        rows: (() => {
          const rows = sparkCodeModeRows();
          rows.splice(-1, 0, rows[1]!);
          return rows;
        })(),
        model: SPARK_MODEL,
      },
    ];
    for (const fixture of rejected) {
      expect(inspectCodexPureEvents(fixture.rows, fixture.model), fixture.label).toMatchObject({
        ok: false,
      });
    }
  });

  it.each([
    ["gpt-5.6-sol", "sol_v2"],
    ["gpt-5.6-terra", "terra_v2"],
    ["gpt-5.6-luna", "luna_v1"],
  ] as const)("accepts the exact generic code-mode notice for %s", (model, profile) => {
    const publicRows = singleCodeModeWarningRows();
    const rolloutRows = completeRollout(forwardingRollout(undefined, { content: [] }), profile);
    expect(inspectCodexPureEvidence(publicRows, rolloutRows, model)).toMatchObject({
      ok: true,
      completedMcpCalls: 1,
    });
    expect(inspectCodexPureEvents(publicRows)).toMatchObject({ ok: false });
    expect(inspectCodexPureEvents(publicRows, SPARK_MODEL)).toMatchObject({ ok: false });

    const withSparkNotice = singleCodeModeWarningRows();
    withSparkNotice.splice(2, 0, {
      type: "item.completed",
      item: { id: "item-extra", type: "error", message: SPARK_METADATA_WARNING },
    });
    expect(inspectCodexPureEvents(withSparkNotice, model)).toMatchObject({ ok: false });
  });

  it("requires the model-specific exact public prelude in strict-current mode", () => {
    const rolloutRows = completeRollout(forwardingRollout(undefined, { content: [] }), "sol_v2");
    expect(
      inspectCodexPureEvidence(singleCodeModeWarningRows(), rolloutRows, "gpt-5.6-sol", {
        codeModeContract: "strict-code-mode-v2",
      }),
    ).toMatchObject({ ok: true });
    expect(
      buildCodexPureEnvelope({
        rows: singleCodeModeWarningRows(),
        rolloutRows,
        report: "report",
        model: "gpt-5.6-sol",
        durationMs: 1,
        codeModeContract: "strict-code-mode-v2",
      }),
    ).toMatchObject({ ok: true });
    expect(
      inspectCodexPureEvidence(validRows(), rolloutRows, "gpt-5.6-sol", {
        codeModeContract: "strict-code-mode-v2",
      }),
    ).toEqual({ ok: false, reason: expect.stringMatching(/exact code-mode prelude/i) });

    const altered = singleCodeModeWarningRows();
    altered[1]!.item!.message = `${altered[1]!.item!.message} altered`;
    expect(
      inspectCodexPureEvidence(altered, rolloutRows, "gpt-5.6-sol", {
        codeModeContract: "strict-code-mode-v2",
      }),
    ).toMatchObject({ ok: false });

    expect(
      inspectCodexPureEvidence(
        sparkCodeModeRows(),
        completeRollout(forwardingRollout(undefined, { content: [] }), "spark_disabled"),
        SPARK_MODEL,
        { codeModeContract: "strict-code-mode-v2" },
      ),
    ).toMatchObject({ ok: true });

    const lunaRollout = completeRollout(forwardingRollout(undefined, { content: [] }), "luna_v1");
    expect(
      inspectCodexPureEvidence(singleCodeModeWarningRows(), lunaRollout, "gpt-5.6-luna", {
        codeModeContract: "strict-code-mode-v2",
      }),
    ).toMatchObject({ ok: true });

    const malformedLunaPragma = structuredClone(lunaRollout);
    const lunaWrapper = malformedLunaPragma.find(
      (row) => (row as { payload?: { type?: string } }).payload?.type === "custom_tool_call",
    ) as { payload: { input: string } };
    lunaWrapper.payload.input =
      '// @exec: {"yield-time": 120000}\n' +
      "text(await tools.mcp__adventureforge__start_overworld({}));\n";
    expect(lunaWrapper.payload.input).not.toContain("yield-time_ms");
    expect(
      inspectCodexGameplayResultForwarding(malformedLunaPragma, {
        codeModeContract: "strict-code-mode-v2",
      }),
    ).toMatchObject({ ok: false });
    expect(
      inspectCodexPureEvidence(singleCodeModeWarningRows(), malformedLunaPragma, "gpt-5.6-luna", {
        codeModeContract: "strict-code-mode-v2",
      }),
    ).toMatchObject({ ok: false });
  });

  it("accepts paired strict Terra commentary and terminal public/private agent messages", () => {
    const commentary = "I inspect the ruined gate.";
    const final = "The gate is locked, so I return to the road.";
    expect(
      inspectCodexPureEvidence(
        strictPublicAgentMessageRows(commentary, final),
        strictTerraAgentMessageRollout(commentary, final),
        "gpt-5.6-terra",
        { codeModeContract: "strict-code-mode-v2", cliVersion: "0.146.0" },
      ),
    ).toMatchObject({ ok: true, completedMcpCalls: 2 });
  });

  it("accepts one paired strict Terra commentary after the prompt and before gameplay", () => {
    const commentary = "I will start a fresh run.";
    const final = "The gate is locked, so I return to the road.";
    const publicRows = strictPublicAgentMessageRows(commentary, final);
    const publicCommentary = publicRows.findIndex((row) => row.item?.id === "agent-commentary");
    const publicGameplay = publicRows.findIndex(
      (row) => row.type === "item.started" && row.item?.type === "mcp_tool_call",
    );
    if (publicCommentary < 0 || publicGameplay < 0) throw new Error("missing public fixtures");
    const [publicMessage] = publicRows.splice(publicCommentary, 1);
    if (!publicMessage) throw new Error("missing public commentary fixture");
    publicRows.splice(publicGameplay, 0, publicMessage);

    const privateRows = strictTerraAgentMessageRollout(commentary, final);
    const privateCommentary = privateRows.findIndex(
      (row) => row.payload?.type === "message" && row.payload.id === "assistant-commentary",
    );
    if (privateCommentary < 0) throw new Error("missing private commentary fixture");
    const pair = privateRows.splice(privateCommentary - 1, 2);
    const privateGameplay = privateRows.findIndex(
      (row) => row.payload?.type === "custom_tool_call" && row.payload.call_id === "call-wrapper-1",
    );
    if (privateGameplay < 0) throw new Error("missing private gameplay fixture");
    privateRows.splice(privateGameplay, 0, ...pair);

    expect(
      inspectCodexPureEvidence(publicRows, privateRows, "gpt-5.6-terra", {
        codeModeContract: "strict-code-mode-v2",
        cliVersion: "0.146.0",
      }),
    ).toMatchObject({ ok: true, completedMcpCalls: 2 });
  });

  it.each([
    {
      label: "a missing commentary agent event",
      mutate: (rows: ReturnType<typeof strictTerraAgentMessageRollout>) => {
        const event = rows.findIndex(
          (row) =>
            row.payload?.type === "agent_message" &&
            row.payload.message === "I inspect the ruined gate.",
        );
        if (event < 0) throw new Error("missing commentary agent event fixture");
        rows.splice(event, 1);
      },
    },
    {
      label: "a mismatched commentary agent event",
      mutate: (rows: ReturnType<typeof strictTerraAgentMessageRollout>) => {
        const event = rows.find(
          (row) =>
            row.payload?.type === "agent_message" &&
            row.payload.message === "I inspect the ruined gate.",
        )?.payload;
        if (!event) throw new Error("missing commentary agent event fixture");
        event.message = "I inspect a different gate.";
      },
    },
    {
      label: "a nonadjacent commentary agent event",
      mutate: (rows: ReturnType<typeof strictTerraAgentMessageRollout>) => {
        const event = rows.findIndex(
          (row) =>
            row.payload?.type === "agent_message" &&
            row.payload.message === "I inspect the ruined gate.",
        );
        if (event < 0) throw new Error("missing commentary agent event fixture");
        const [agentEvent] = rows.splice(event, 1);
        const secondGameplay = rows.findIndex(
          (row) =>
            row.payload?.type === "custom_tool_call" && row.payload.call_id === "call-wrapper-2",
        );
        if (!agentEvent || secondGameplay < 0) throw new Error("missing private gameplay fixture");
        rows.splice(secondGameplay + 1, 0, agentEvent);
      },
    },
    {
      label: "an orphan extra agent event",
      mutate: (rows: ReturnType<typeof strictTerraAgentMessageRollout>) => {
        const taskComplete = rows.findIndex((row) => row.payload?.type === "task_complete");
        if (taskComplete < 0) throw new Error("missing task-complete fixture");
        rows.splice(taskComplete, 0, {
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: "This event has no paired assistant response.",
            phase: "commentary",
            memory_citation: null,
          },
        });
      },
    },
    {
      label: "a commentary message in the final phase",
      mutate: (rows: ReturnType<typeof strictTerraAgentMessageRollout>) => {
        const commentary = rows.find(
          (row) => row.payload?.type === "message" && row.payload.id === "assistant-commentary",
        )?.payload;
        if (!commentary) throw new Error("missing commentary assistant fixture");
        commentary.phase = "final_answer";
      },
    },
    {
      label: "commentary before the authenticated user prompt",
      mutate: (rows: ReturnType<typeof strictTerraAgentMessageRollout>) => {
        const commentary = rows.findIndex(
          (row) => row.payload?.type === "message" && row.payload.id === "assistant-commentary",
        );
        if (commentary < 0) throw new Error("missing commentary assistant fixture");
        const pair = rows.splice(commentary - 1, 2);
        const prompt = rows.findIndex(
          (row) => row.payload?.type === "message" && row.payload.role === "user",
        );
        if (prompt < 0) throw new Error("missing private prompt fixture");
        rows.splice(prompt, 0, ...pair);
      },
    },
    {
      label: "commentary between a gameplay call and its visible output",
      mutate: (rows: ReturnType<typeof strictTerraAgentMessageRollout>) => {
        const commentary = rows.findIndex(
          (row) => row.payload?.type === "message" && row.payload.id === "assistant-commentary",
        );
        if (commentary < 0) throw new Error("missing commentary assistant fixture");
        const pair = rows.splice(commentary - 1, 2);
        const firstGameplay = rows.findIndex(
          (row) =>
            row.payload?.type === "custom_tool_call" && row.payload.call_id === "call-wrapper-1",
        );
        if (firstGameplay < 0) throw new Error("missing first private gameplay fixture");
        rows.splice(firstGameplay + 1, 0, ...pair);
      },
    },
    {
      label: "commentary after the last visible gameplay output",
      mutate: (rows: ReturnType<typeof strictTerraAgentMessageRollout>) => {
        const commentary = rows.findIndex(
          (row) => row.payload?.type === "message" && row.payload.id === "assistant-commentary",
        );
        if (commentary < 0) throw new Error("missing commentary assistant fixture");
        const pair = rows.splice(commentary - 1, 2);
        const finalAssistant = rows.findIndex(
          (row) => row.payload?.type === "message" && row.payload.phase === "final_answer",
        );
        if (finalAssistant < 0) throw new Error("missing final assistant fixture");
        rows.splice(finalAssistant, 0, ...pair);
      },
    },
    {
      label: "a missing terminal answer",
      mutate: (rows: ReturnType<typeof strictTerraAgentMessageRollout>) => {
        const finalAssistant = rows.findIndex(
          (row) => row.payload?.type === "message" && row.payload.phase === "final_answer",
        );
        if (finalAssistant < 0) throw new Error("missing final assistant fixture");
        rows.splice(finalAssistant - 1, 2);
      },
    },
    {
      label: "a duplicate terminal answer",
      mutate: (rows: ReturnType<typeof strictTerraAgentMessageRollout>) => {
        const taskComplete = rows.findIndex((row) => row.payload?.type === "task_complete");
        if (taskComplete < 0) throw new Error("missing task-complete fixture");
        rows.splice(
          taskComplete,
          0,
          ...pairedPrivateAgentMessage("assistant-final-duplicate", "report", "final_answer"),
        );
      },
    },
    {
      label: "a non-final terminal answer",
      mutate: (rows: ReturnType<typeof strictTerraAgentMessageRollout>) => {
        const taskComplete = rows.findIndex((row) => row.payload?.type === "task_complete");
        if (taskComplete < 0) throw new Error("missing task-complete fixture");
        rows.splice(
          taskComplete,
          0,
          ...pairedPrivateAgentMessage("assistant-after-final", "I keep looking.", "commentary"),
        );
      },
    },
  ])("rejects $label in strict Terra evidence", ({ mutate }) => {
    const publicRows = strictPublicAgentMessageRows(
      "I inspect the ruined gate.",
      "The gate is locked, so I return to the road.",
    );
    const privateRows = strictTerraAgentMessageRollout(
      "I inspect the ruined gate.",
      "The gate is locked, so I return to the road.",
    );
    mutate(privateRows);
    expect(
      inspectCodexPureEvidence(publicRows, privateRows, "gpt-5.6-terra", {
        codeModeContract: "strict-code-mode-v2",
        cliVersion: "0.146.0",
      }),
    ).toMatchObject({ ok: false });
  });

  it("rejects a public commentary moved across a gameplay boundary", () => {
    const commentary = "I inspect the ruined gate.";
    const final = "The gate is locked, so I return to the road.";
    const publicRows = strictPublicAgentMessageRows(commentary, final);
    const publicCommentary = publicRows.findIndex((row) => row.item?.id === "agent-commentary");
    if (publicCommentary < 0) throw new Error("missing public commentary fixture");
    const [message] = publicRows.splice(publicCommentary, 1);
    if (!message) throw new Error("missing public commentary row");
    const firstGameplay = publicRows.findIndex(
      (row) => row.type === "item.started" && row.item?.type === "mcp_tool_call",
    );
    if (firstGameplay < 0) throw new Error("missing first public gameplay fixture");
    publicRows.splice(firstGameplay, 0, message);

    expect(
      inspectCodexPureEvidence(
        publicRows,
        strictTerraAgentMessageRollout(commentary, final),
        "gpt-5.6-terra",
        { codeModeContract: "strict-code-mode-v2", cliVersion: "0.146.0" },
      ),
    ).toMatchObject({ ok: false });
  });

  it("does not authenticate an agent-message item attached to turn.completed", () => {
    const commentary = "I inspect the ruined gate.";
    const final = "The gate is locked, so I return to the road.";
    const publicRows = strictPublicAgentMessageRows(commentary, final);
    const finalMessage = publicRows.findIndex((row) => row.item?.id === "agent-final");
    if (finalMessage < 0) throw new Error("missing public final agent-message fixture");
    const [removed] = publicRows.splice(finalMessage, 1);
    if (!removed?.item) throw new Error("missing public final agent-message item");
    const turnCompleted = publicRows.find((row) => row.type === "turn.completed");
    if (!turnCompleted) throw new Error("missing public turn completion fixture");
    turnCompleted.item = removed.item;

    expect(
      inspectCodexPureEvidence(
        publicRows,
        strictTerraAgentMessageRollout(commentary, final),
        "gpt-5.6-terra",
        { codeModeContract: "strict-code-mode-v2", cliVersion: "0.146.0" },
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects a public agent-message identity reused by another public item", () => {
    const commentary = "I inspect the ruined gate.";
    const final = "The gate is locked, so I return to the road.";
    for (const collision of ["agent", "gameplay"] as const) {
      const publicRows = strictPublicAgentMessageRows(commentary, final);
      const finalMessage = publicRows.find((row) => row.item?.id === "agent-final")?.item;
      const collidingItem = publicRows.find((row) =>
        collision === "agent"
          ? row.item?.id === "agent-commentary"
          : row.type === "item.started" && row.item?.type === "mcp_tool_call",
      )?.item;
      if (!finalMessage || !collidingItem) throw new Error(`missing public ${collision} fixture`);
      finalMessage.id = collidingItem.id;

      expect(
        inspectCodexPureEvidence(
          publicRows,
          strictTerraAgentMessageRollout(commentary, final),
          "gpt-5.6-terra",
          { codeModeContract: "strict-code-mode-v2", cliVersion: "0.146.0" },
        ),
        collision,
      ).toMatchObject({ ok: false });
    }
  });

  it.each([
    {
      label: "a missing public agent message",
      mutate: (rows: ReturnType<typeof strictPublicAgentMessageRows>) => {
        const final = rows.findIndex((row) => row.item?.id === "agent-final");
        if (final < 0) throw new Error("missing public final agent-message fixture");
        rows.splice(final, 1);
      },
    },
    {
      label: "a mismatched public agent-message text",
      mutate: (rows: ReturnType<typeof strictPublicAgentMessageRows>) => {
        const final = rows.find((row) => row.item?.id === "agent-final")?.item;
        if (!final) throw new Error("missing public final agent-message fixture");
        final.text = "a substituted public answer";
      },
    },
  ])("rejects $label in strict Terra evidence", ({ mutate }) => {
    const publicRows = strictPublicAgentMessageRows(
      "I inspect the ruined gate.",
      "The gate is locked, so I return to the road.",
    );
    mutate(publicRows);
    expect(
      inspectCodexPureEvidence(
        publicRows,
        strictTerraAgentMessageRollout(
          "I inspect the ruined gate.",
          "The gate is locked, so I return to the road.",
        ),
        "gpt-5.6-terra",
        { codeModeContract: "strict-code-mode-v2", cliVersion: "0.146.0" },
      ),
    ).toMatchObject({ ok: false });
  });

  it.each([
    {
      label: "AdventureForge resource listing",
      server: "adventureforge",
      tool: "list_mcp_resources",
    },
    {
      label: "AdventureForge resource template listing",
      server: "adventureforge",
      tool: "list_mcp_resource_templates",
    },
    { label: "AdventureForge resource read", server: "adventureforge", tool: "read_mcp_resource" },
    { label: "Codex resource listing", server: "codex", tool: "resources/list" },
  ])("rejects $label before gameplay", ({ server, tool }) => {
    const rows = insertBeforeGameplay(validRows(), [
      {
        type: "item.started",
        item: {
          id: `forbidden-${tool}`,
          type: "mcp_tool_call",
          server,
          tool,
          arguments: {},
          result: null,
          error: null,
          status: "in_progress",
        },
      },
    ]);

    expect(inspectCodexPureEvents(rows)).toEqual({
      ok: false,
      reason: expect.stringMatching(
        server === "adventureforge"
          ? new RegExp(`forbidden AdventureForge tool ${tool}`, "i")
          : new RegExp(`forbidden MCP server ${server}`, "i"),
      ),
    });
  });

  it("rejects a todo lifecycle instead of treating planning as gameplay", () => {
    const rows = insertBeforeGameplay(validRows(), [
      {
        type: "item.started",
        item: { id: "todo-1", type: "todo_list", items: [] },
      },
    ]);

    expect(inspectCodexPureEvents(rows)).toEqual({
      ok: false,
      reason: expect.stringMatching(/forbidden item type todo_list/i),
    });
  });

  it.each([
    {
      label: "a non-AdventureForge first MCP call",
      server: "filesystem",
      tool: "read_file",
      arguments_: {},
      reason: /forbidden MCP server filesystem/i,
    },
    {
      label: "a non-start AdventureForge first MCP call",
      server: "adventureforge",
      tool: "get_overworld_session",
      arguments_: {},
      reason: /must begin gameplay with start_overworld and no arguments/i,
    },
    {
      label: "an argument-bearing fresh start",
      server: "adventureforge",
      tool: "start_overworld",
      arguments_: { seed: 7 },
      reason: /must begin gameplay with start_overworld and no arguments/i,
    },
  ])("rejects $label", ({ server, tool, arguments_, reason }) => {
    const rows = validRows();
    const start = rows.find(
      (row) => row.type === "item.started" && row.item?.type === "mcp_tool_call",
    );
    const completed = rows.find(
      (row) => row.type === "item.completed" && row.item?.type === "mcp_tool_call",
    );
    if (!start?.item || !completed?.item) throw new Error("missing valid test gameplay pair");
    start.item.server = server;
    start.item.tool = tool;
    start.item.arguments = arguments_;
    completed.item.server = server;
    completed.item.tool = tool;
    completed.item.arguments = arguments_;

    expect(inspectCodexPureEvents(rows)).toEqual({
      ok: false,
      reason: expect.stringMatching(reason),
    });
  });

  it.each([
    {
      label: "unknown top-level event",
      mutate: (rows: ReturnType<typeof validRows>) =>
        rows.splice(-1, 0, { type: "error" } as (typeof rows)[number]),
      reason: /forbidden event type error/i,
    },
    {
      label: "shell command",
      mutate: (rows: ReturnType<typeof validRows>) =>
        rows.splice(-1, 0, {
          type: "item.completed",
          item: { id: "shell", type: "command_execution" },
        } as (typeof rows)[number]),
      reason: /forbidden item type command_execution/i,
    },
    {
      label: "file change",
      mutate: (rows: ReturnType<typeof validRows>) =>
        rows.splice(-1, 0, {
          type: "item.completed",
          item: { id: "file", type: "file_change" },
        } as (typeof rows)[number]),
      reason: /forbidden item type file_change/i,
    },
    {
      label: "web search",
      mutate: (rows: ReturnType<typeof validRows>) =>
        rows.splice(-1, 0, {
          type: "item.completed",
          item: { id: "web", type: "web_search" },
        } as (typeof rows)[number]),
      reason: /forbidden item type web_search/i,
    },
    {
      label: "wrong MCP server",
      mutate: (rows: ReturnType<typeof validRows>) => {
        const call = rows.find((row) => row.item?.type === "mcp_tool_call");
        if (call?.item) call.item.server = "filesystem";
      },
      reason: /forbidden MCP server filesystem/i,
    },
    {
      label: "structural AdventureForge tool",
      mutate: (rows: ReturnType<typeof validRows>) => {
        const call = rows.find((row) => row.item?.type === "mcp_tool_call");
        if (call?.item) call.item.tool = "start_world_quest";
      },
      reason: /forbidden AdventureForge tool start_world_quest/i,
    },
    {
      label: "gameplay before fresh start",
      mutate: (rows: ReturnType<typeof validRows>) => {
        const call = rows.find((row) => row.item?.type === "mcp_tool_call");
        if (call?.item) call.item.tool = "get_overworld_session_context";
      },
      reason: /must begin gameplay with start_overworld/i,
    },
    {
      label: "a completed-only fresh start",
      mutate: (rows: ReturnType<typeof validRows>) => {
        const started = rows.findIndex(
          (row) => row.type === "item.started" && row.item?.id === "item_1",
        );
        rows.splice(started, 1);
      },
      reason: /unpaired or invalid gameplay completion start_overworld/i,
    },
    {
      label: "a mismatched gameplay completion",
      mutate: (rows: ReturnType<typeof validRows>) => {
        const completed = rows.find(
          (row) => row.type === "item.completed" && row.item?.id === "item_1",
        );
        if (completed?.item) completed.item.tool = "get_overworld_session_context";
      },
      reason: /unpaired or invalid gameplay completion get_overworld_session_context/i,
    },
    {
      label: "gameplay before thread and turn startup",
      mutate: (rows: ReturnType<typeof validRows>) => {
        const gameplay = rows.splice(3, 2);
        rows.unshift(...gameplay);
      },
      reason: /must begin with thread\.started then turn\.started/i,
    },
    {
      label: "fresh start arguments",
      mutate: (rows: ReturnType<typeof validRows>) => {
        for (const row of rows) {
          if (row.item?.id === "item_1") row.item.arguments = { invented: true };
        }
      },
      reason: /must begin gameplay with start_overworld and no arguments/i,
    },
    {
      label: "a failed first fresh start",
      mutate: (rows: ReturnType<typeof validRows>) => {
        const completed = rows.find(
          (row) => row.type === "item.completed" && row.item?.id === "item_1",
        );
        if (completed?.item) completed.item.status = "failed";
      },
      reason: /did not complete its first fresh start successfully/i,
    },
    {
      label: "a duplicate gameplay call id",
      mutate: (rows: ReturnType<typeof validRows>) => {
        rows.splice(-1, 0, ...gameplayCallRows("item_1", "get_overworld_session_context", {}));
      },
      reason: /invalid or duplicate gameplay call get_overworld_session_context/i,
    },
    {
      label: "an unpaired gameplay start",
      mutate: (rows: ReturnType<typeof validRows>) => {
        rows.splice(-1, 0, gameplayCallRows("item_2", "get_overworld_session_context", {})[0]!);
      },
      reason: /unpaired gameplay call item_2/i,
    },
    {
      label: "duplicate thread",
      mutate: (rows: ReturnType<typeof validRows>) =>
        rows.splice(1, 0, { type: "thread.started", thread_id: THREAD_ID }),
      reason:
        /must begin with thread\.started then turn\.started|exactly one valid thread identity/i,
    },
    {
      label: "incomplete turn",
      mutate: (rows: ReturnType<typeof validRows>) => rows.pop(),
      reason: /exactly one started and completed turn/i,
    },
  ])("rejects $label", ({ mutate, reason }) => {
    const rows = validRows();
    mutate(rows);
    expect(inspectCodexPureEvents(rows)).toEqual({
      ok: false,
      reason: expect.stringMatching(reason),
    });
  });

  it("rejects missing reports and malformed usage", () => {
    expect(
      buildCodexPureEnvelope({
        rows: validRows(),
        rolloutRows: completeRollout(forwardingRollout(undefined, { content: [] })),
        report: "",
        model: "gpt-5.6-sol",
        durationMs: 1,
      }),
    ).toEqual({ ok: false, reason: "Codex pure run produced no final report" });

    expect(
      buildCodexPureEnvelope({
        rows: validRows(),
        report: "report",
        model: "gpt-5.6-sol",
        durationMs: 1,
      }),
    ).toEqual({
      ok: false,
      reason: expect.stringMatching(/forwarding audit failed: rollout is empty/i),
    });

    const rows = validRows();
    const completed = rows.at(-1);
    if (completed?.usage) completed.usage.output_tokens = -1;
    expect(inspectCodexPureEvents(rows)).toEqual({
      ok: false,
      reason: "Codex completed turn is missing valid token usage",
    });
  });

  it("reports malformed private JSON by path and line without echoing hidden bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "af-codex-json-sanitize-"));
    try {
      const events = join(root, "events.jsonl");
      const rollout = join(root, "rollout.jsonl");
      const report = join(root, "report.md");
      writeFileSync(events, '{"hidden_player_response":"SECRET_PLAYER_PAYLOAD"\n');
      writeFileSync(rollout, "{}\n");
      writeFileSync(report, "report\n");
      const result = spawnSync(
        process.execPath,
        [
          join(process.cwd(), "blind-tester", "codex-pure-envelope.mjs"),
          "--events",
          events,
          "--rollout",
          rollout,
          "--report",
          report,
          "--model",
          "gpt-5.6-sol",
          "--cli-version",
          "0.146.0",
          "--started-at-ms",
          "0",
          "--code-mode-contract",
          "strict-code-mode-v2",
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain(`${events} contains invalid JSON at line 1`);
      expect(output).not.toContain("SECRET_PLAYER_PAYLOAD");
      expect(output).not.toContain("hidden_player_response");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Terra game-direct MCP transport", () => {
  const direct = { transportContract: CODEX_GAME_DIRECT_MCP_CONTRACT, cliVersion: "0.146.0" };

  it("accepts only the pinned projected Terra disabled profile and exact runtime authority", () => {
    const rows = terraDirectMcpRollout();
    expect(inspectCodexPureEvidence(validRows(), rows, "gpt-5.6-terra", direct)).toMatchObject({
      ok: true,
    });

    const changed = structuredClone(rows);
    const session = changed.find((row) => row.type === "session_meta")?.payload;
    if (!session) throw new Error("missing Terra direct session fixture");
    session.base_instructions = { text: `${CODEX_SPARK_PLAYER_BASE_INSTRUCTIONS} drift` };
    expect(inspectCodexPureEvidence(validRows(), changed, "gpt-5.6-terra", direct)).toMatchObject({
      ok: false,
    });

    for (const compHash of ["3001", undefined]) {
      const changedHash = structuredClone(rows);
      const context = changedHash.find((row) => row.type === "turn_context")?.payload;
      if (!context) throw new Error("missing Terra direct turn-context fixture");
      if (compHash === undefined) delete context.comp_hash;
      else context.comp_hash = compHash;
      expect(
        inspectCodexPureEvidence(validRows(), changedHash, "gpt-5.6-terra", direct),
      ).toMatchObject({ ok: false });
    }

    for (const summary of ["none", "detailed", undefined]) {
      const changedSummary = structuredClone(rows);
      const context = changedSummary.find((row) => row.type === "turn_context")?.payload;
      if (!context) throw new Error("missing Terra direct turn-context fixture");
      if (summary === undefined) delete context.summary;
      else context.summary = summary;
      expect(
        inspectCodexPureEvidence(validRows(), changedSummary, "gpt-5.6-terra", direct),
      ).toMatchObject({ ok: false });
    }
  });

  it("rejects Terra v2 team/mode contamination and any non-disabled direct profile", () => {
    const baseline = terraDirectMcpRollout();
    const globalPreludeIndex = baseline.findIndex(
      (row) =>
        row.type === "response_item" &&
        row.payload?.type === "message" &&
        row.payload.role === "user" &&
        (row.payload.content as Array<{ text?: string }> | undefined)?.[0]?.text ===
          GLOBAL_AGENTS_BLOCK,
    );
    if (globalPreludeIndex < 0) throw new Error("missing Terra direct global prelude fixture");
    const metadata = { internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } };
    const developerMessage = (id: string, text: string) => ({
      type: "response_item",
      payload: {
        type: "message",
        id,
        role: "developer",
        content: [{ type: "input_text", text }],
        ...metadata,
      },
    });
    const mutations: Array<[string, (rows: ReturnType<typeof terraDirectMcpRollout>) => void]> = [
      [
        "a v2 team prelude",
        (rows) => rows.splice(globalPreludeIndex, 0, developerMessage("terra-team", V2_TEAM_BLOCK)),
      ],
      [
        "a v2 mode prelude",
        (rows) =>
          rows.splice(globalPreludeIndex, 0, developerMessage("terra-mode", V2_0146_MODE_BLOCK)),
      ],
      [
        "the exact team/mode/global ordering from the failed canary",
        (rows) =>
          rows.splice(
            globalPreludeIndex,
            0,
            developerMessage("terra-team", V2_TEAM_BLOCK),
            developerMessage("terra-mode", V2_0146_MODE_BLOCK),
          ),
      ],
      [
        "the v2 turn profile from the failed canary",
        (rows) => {
          const context = rows.find((row) => row.type === "turn_context")?.payload;
          if (!context) throw new Error("missing Terra direct turn context fixture");
          context.multi_agent_version = "v2";
        },
      ],
      [
        "an explicit multi-agent mode",
        (rows) => {
          const context = rows.find((row) => row.type === "turn_context")?.payload;
          if (!context) throw new Error("missing Terra direct turn context fixture");
          context.multi_agent_mode = "explicitRequestOnly";
        },
      ],
    ];

    for (const [label, mutate] of mutations) {
      const rows = structuredClone(baseline);
      mutate(rows);
      expect(
        inspectCodexPureEvidence(validRows(), rows, "gpt-5.6-terra", direct),
        label,
      ).toMatchObject({ ok: false });
    }
  });

  it("keeps strict Terra v2 and game-direct Terra disabled profiles transport-scoped", () => {
    const strict = { transportContract: "strict-code-mode-v2", cliVersion: "0.146.0" };
    const strictRows = codex0146TerraRollout(forwardingRollout(undefined, { content: [] }));
    expect(
      inspectCodexPureEvidence(singleCodeModeWarningRows(), strictRows, "gpt-5.6-terra", strict),
    ).toMatchObject({ ok: true });
    expect(
      inspectCodexPureEvidence(validRows(), strictRows, "gpt-5.6-terra", direct),
    ).toMatchObject({
      ok: false,
    });

    const directRows = terraDirectMcpRollout();
    expect(
      inspectCodexPureEvidence(singleCodeModeWarningRows(), directRows, "gpt-5.6-terra", strict),
    ).toMatchObject({ ok: false });
  });

  it("rejects a completed failed fresh start in the live prefix", () => {
    expect(
      inspectCodexGameplayResultForwardingPrefix(terraDirectMcpRollout(TOOL_ERROR_RESULT), direct),
    ).toEqual({
      ok: false,
      reason:
        "Codex gameplay-result forwarding audit failed: direct MCP fresh start completed with an error",
    });
  });

  it.each(["gpt-5.6-sol", "gpt-5.6-luna", SPARK_MODEL])(
    "rejects the Terra direct contract when requested as %s",
    (model) => {
      expect(inspectCodexPureEvidence(validRows(), terraDirectMcpRollout(), model, direct)).toEqual(
        {
          ok: false,
          reason: "Codex pure run has an unsupported transport for its requested model",
        },
      );
    },
  );

  it.each([
    [
      "reordered native completion/result rows",
      (rows: ReturnType<typeof terraDirectMcpRollout>) => {
        const callIndex = rows.findIndex((row) => row.payload?.type === "function_call");
        [rows[callIndex + 1], rows[callIndex + 2]] = [rows[callIndex + 2]!, rows[callIndex + 1]!];
      },
    ],
    [
      "noncanonical native arguments",
      (rows: ReturnType<typeof terraDirectMcpRollout>) => {
        const call = rows.find((row) => row.payload?.type === "function_call")?.payload;
        if (!call) throw new Error("missing Terra direct call fixture");
        call.arguments = "{ }";
      },
    ],
    [
      "a forbidden direct namespace",
      (rows: ReturnType<typeof terraDirectMcpRollout>) => {
        const call = rows.find((row) => row.payload?.type === "function_call")?.payload;
        if (!call) throw new Error("missing Terra direct call fixture");
        call.namespace = "mcp__filesystem";
      },
    ],
  ])("rejects $0", (_label, mutate) => {
    const rows = terraDirectMcpRollout();
    mutate(rows);
    expect(inspectCodexPureEvidence(validRows(), rows, "gpt-5.6-terra", direct)).toMatchObject({
      ok: false,
    });
  });
});

describe("Spark direct MCP transport", () => {
  const direct = { transportContract: CODEX_SPARK_DIRECT_MCP_CONTRACT, cliVersion: "0.146.0" };

  it("fails closed unless both authenticated and captured CLI versions are exactly 0.146.0", () => {
    for (const [expectedCliVersion, capturedCliVersion] of [
      ["0.145.0", "0.146.0"],
      ["0.146.0", "0.145.0"],
      ["0.144.1", "0.145.0"],
    ] as const) {
      const rolloutRows = sparkDirectMcpRollout();
      const session = rolloutRows.find((row) => row.type === "session_meta")?.payload;
      if (!session) throw new Error("missing Spark session fixture");
      session.cli_version = capturedCliVersion;
      expect(
        inspectCodexPureEvidence(validRows(), rolloutRows, SPARK_MODEL, {
          transportContract: CODEX_SPARK_DIRECT_MCP_CONTRACT,
          cliVersion: expectedCliVersion,
        }),
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining(
          "Spark direct MCP rollout requires authenticated and captured Codex CLI 0.146.0",
        ),
      });
    }
  });

  it("accepts exactly one byte-exact global AGENTS prelude in the reduced 0.146 profile", () => {
    const rolloutRows = sparkDirectMcpRollout();
    const taskStartIndex = rolloutRows.findIndex(
      (row) => row.type === "event_msg" && row.payload?.type === "task_started",
    );
    const worldStateIndex = rolloutRows.findIndex((row) => row.type === "world_state");
    expect(taskStartIndex).toBeGreaterThanOrEqual(0);
    expect(worldStateIndex).toBeGreaterThan(taskStartIndex);
    expect(rolloutRows.slice(taskStartIndex + 1, worldStateIndex)).toEqual([
      {
        type: "response_item",
        payload: {
          type: "message",
          id: "msg-current-global-agents",
          role: "user",
          content: [{ type: "input_text", text: GLOBAL_AGENTS_BLOCK }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
    ]);
    expect(inspectCodexPureEvidence(validRows(), rolloutRows, SPARK_MODEL, direct)).toMatchObject({
      ok: true,
    });

    const changed = structuredClone(rolloutRows);
    const changedPrelude = changed[taskStartIndex + 1]?.payload?.content as
      | Array<{ text?: string }>
      | undefined;
    if (!changedPrelude?.[0]) throw new Error("missing reduced Spark prelude fixture");
    changedPrelude[0].text = `${GLOBAL_AGENTS_BLOCK}\n`;
    expect(inspectCodexPureEvidence(validRows(), changed, SPARK_MODEL, direct)).toMatchObject({
      ok: false,
    });

    const duplicated = structuredClone(rolloutRows);
    const duplicatePrelude = structuredClone(duplicated[taskStartIndex + 1]!);
    duplicatePrelude.payload!.id = "msg-current-global-agents-duplicate";
    duplicated.splice(worldStateIndex, 0, duplicatePrelude);
    expect(inspectCodexPureEvidence(validRows(), duplicated, SPARK_MODEL, direct)).toMatchObject({
      ok: false,
    });
  });

  it("binds the applied Spark base instructions and catalog comp hash", () => {
    const rows = sparkDirectMcpRollout();
    expect(inspectCodexPureEvidence(validRows(), rows, SPARK_MODEL, direct)).toMatchObject({
      ok: true,
    });

    const changedInstructions = structuredClone(rows);
    const session = changedInstructions.find((row) => row.type === "session_meta")?.payload;
    if (!session) throw new Error("missing Spark session fixture");
    session.base_instructions = { text: "contaminated instructions" };
    expect(
      inspectCodexPureEvidence(validRows(), changedInstructions, SPARK_MODEL, direct),
    ).toMatchObject({ ok: false });

    const changedCompHash = structuredClone(rows);
    const context = changedCompHash.find((row) => row.type === "turn_context")?.payload;
    if (!context) throw new Error("missing Spark turn fixture");
    context.comp_hash = "changed";
    expect(
      inspectCodexPureEvidence(validRows(), changedCompHash, SPARK_MODEL, direct),
    ).toMatchObject({
      ok: false,
    });
  });

  it("rejects interim assistant prose before the final exit interview", () => {
    const rows = sparkDirectMcpRollout();
    const firstGameplay = rows.findIndex((row) => row.payload?.type === "function_call");
    if (firstGameplay < 0) throw new Error("missing Spark gameplay fixture");
    rows.splice(firstGameplay, 0, {
      type: "response_item",
      payload: {
        type: "message",
        id: "interim-assistant-message",
        role: "assistant",
        content: [{ type: "output_text", text: "I will begin now." }],
        phase: "commentary",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      },
    });
    expect(inspectCodexPureEvidence(validRows(), rows, SPARK_MODEL, direct)).toMatchObject({
      ok: false,
    });
  });

  it("rejects an orphan private agent-message event in direct Spark evidence", () => {
    const rows = sparkDirectMcpRollout();
    const taskComplete = rows.findIndex(
      (row) => row.type === "event_msg" && row.payload?.type === "task_complete",
    );
    if (taskComplete < 0) throw new Error("missing Spark task-complete fixture");
    rows.splice(taskComplete, 0, {
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "This event has no paired assistant response.",
        phase: "commentary",
        memory_citation: null,
      },
    });

    expect(inspectCodexPureEvidence(validRows(), rows, SPARK_MODEL, direct)).toMatchObject({
      ok: false,
    });
  });

  it.each([
    {
      label: "permissions/skills developer message",
      role: "developer",
      content: [
        { type: "input_text", text: PERMISSIONS_BLOCK },
        { type: "input_text", text: SKILLS_BLOCK },
      ],
    },
    {
      label: "environment user message",
      role: "user",
      content: [{ type: "input_text", text: ENVIRONMENT_BLOCK }],
    },
  ])("rejects an injected $label", ({ role, content }) => {
    const rows = sparkDirectMcpRollout();
    const worldStateIndex = rows.findIndex((row) => row.type === "world_state");
    if (worldStateIndex < 0) throw new Error("missing reduced Spark world-state fixture");
    rows.splice(worldStateIndex, 0, {
      type: "response_item",
      payload: {
        type: "message",
        id: `msg-current-injected-${role}`,
        role,
        content,
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      },
    });
    expect(inspectCodexPureEvidence(validRows(), rows, SPARK_MODEL, direct)).toMatchObject({
      ok: false,
    });
  });

  it("accepts preloaded native calls without a code-mode prelude", () => {
    const publicRows = validRows();
    const rolloutRows = sparkDirectMcpRollout();
    expect(inspectCodexPureEventPrefix(publicRows.slice(0, 2), SPARK_MODEL, direct)).toMatchObject({
      ok: true,
    });
    expect(inspectCodexGameplayResultForwarding(rolloutRows, direct)).toMatchObject({
      ok: true,
      completedGameplayCalls: 1,
      gameplayCalls: [
        { tool: "start_overworld", arguments: {}, status: "completed", result: { content: [] } },
      ],
    });
    expect(inspectCodexPureEvidence(publicRows, rolloutRows, SPARK_MODEL, direct)).toMatchObject({
      ok: true,
      completedMcpCalls: 1,
    });
    expect(
      buildCodexPureEnvelope({
        rows: publicRows,
        rolloutRows,
        report: "report",
        model: SPARK_MODEL,
        durationMs: 1,
        transportContract: CODEX_SPARK_DIRECT_MCP_CONTRACT,
        cliVersion: "0.146.0",
      }),
    ).toMatchObject({ ok: true, envelope: { requested_model: SPARK_MODEL } });
  });

  it.each([...CODEX_PURE_PLAYER_TOOLS].filter((tool) => tool !== "start_overworld"))(
    "permits pre-attested %s after start without requiring its name in the prior result",
    (tool) => {
      const rows = sparkDirectMcpRollout({
        content: [{ type: "text", text: "Choose naturally from the current visible state." }],
      });
      appendSparkDirectCall(rows, tool);
      expect(inspectCodexGameplayResultForwarding(rows, direct)).toMatchObject({
        ok: true,
        completedGameplayCalls: 2,
        gameplayCalls: [
          { tool: "start_overworld", arguments: {} },
          { tool, arguments: {} },
        ],
      });
    },
  );

  it("rejects a second native fresh start", () => {
    const rows = sparkDirectMcpRollout({
      content: [{ type: "text", text: "Choose naturally from the current visible state." }],
    });
    appendSparkDirectCall(rows, "start_overworld");
    expect(inspectCodexGameplayResultForwarding(rows, direct)).toEqual({
      ok: false,
      reason:
        "Codex gameplay-result forwarding audit failed: direct MCP run must call start_overworld exactly once",
    });
  });

  it("rejects context compaction because its replacement history is not purity-bound", () => {
    const rows = sparkDirectMcpRollout();
    const initialTurnContext = rows.find((row) => row.type === "turn_context");
    if (!initialTurnContext) throw new Error("missing Spark turn-context fixture");
    rows.splice(-2, 0, { type: "compacted", payload: { window_number: 2 } });
    rows.splice(-2, 0, { type: "world_state", payload: { full: true } });
    rows.splice(-2, 0, structuredClone(initialTurnContext));
    rows.splice(-2, 0, { type: "event_msg", payload: { type: "context_compacted" } });

    expect(inspectCodexPureEvidence(validRows(), rows, SPARK_MODEL, direct)).toEqual({
      ok: false,
      reason: expect.stringMatching(/does not permit context compaction/i),
    });
  });

  it("classifies the captured no-namespace resource probe before generic identity validation", () => {
    const rows = sparkDirectMcpRollout({
      content: [{ type: "text", text: "Choose naturally from the current visible state." }],
    });
    const callIndex = rows.findIndex((row) => row.payload?.type === "function_call");
    if (callIndex < 0) throw new Error("missing captured direct function-call fixture");
    const capturedRow = JSON.stringify(CAPTURED_PRIVATE_RESOURCE_PROBE);
    expect(Buffer.byteLength(capturedRow, "utf8")).toBe(342);
    expect(createHash("sha256").update(capturedRow).digest("hex")).toBe(
      CAPTURED_PRIVATE_RESOURCE_PROBE_SHA256,
    );
    rows[callIndex] = structuredClone(CAPTURED_PRIVATE_RESOURCE_PROBE);

    expect(Object.hasOwn(rows[callIndex]!.payload!, "namespace")).toBe(false);
    expect(
      inspectCodexGameplayResultForwardingPrefix(rows.slice(0, callIndex + 1), direct),
    ).toEqual({
      ok: false,
      reason:
        "Codex gameplay-result forwarding audit failed: direct MCP call 1 used a forbidden direct function",
    });
  });

  it("classifies a forbidden preloaded function after start with its gameplay ordinal", () => {
    const rows = sparkDirectMcpRollout({
      content: [{ type: "text", text: "Choose naturally from the current visible state." }],
    });
    appendSparkDirectCall(rows, "list_mcp_resources");
    expect(inspectCodexGameplayResultForwarding(rows, direct)).toEqual({
      ok: false,
      reason:
        "Codex gameplay-result forwarding audit failed: direct MCP call 2 used a forbidden direct function",
    });
  });

  it("accepts exact native output beyond the 16 KiB player cap and rejects a truncation splice", () => {
    const result = {
      content: [{ type: "text", text: "visible-state:" + "x".repeat(18 * 1024) }],
    };
    const rows = sparkDirectMcpRollout(result);
    const output = rows.find((row) => row.payload?.type === "function_call_output")?.payload;
    if (typeof output?.output !== "string") throw new Error("missing long direct output fixture");
    expect(Buffer.byteLength(output.output, "utf8")).toBeGreaterThan(16 * 1024);
    expect(inspectCodexGameplayResultForwarding(rows, direct)).toMatchObject({
      ok: true,
      completedGameplayCalls: 1,
    });

    const truncated = structuredClone(rows);
    const truncatedOutput = truncated.find(
      (row) => row.payload?.type === "function_call_output",
    )?.payload;
    if (typeof truncatedOutput?.output !== "string") {
      throw new Error("missing copied long direct output fixture");
    }
    truncatedOutput.output =
      truncatedOutput.output.slice(0, 6 * 1024) +
      "\n... 4096 chars truncated ...\n" +
      truncatedOutput.output.slice(-2 * 1024);
    expect(inspectCodexGameplayResultForwarding(truncated, direct)).toEqual({
      ok: false,
      reason: expect.stringMatching(/missing.*mismatched.*truncated/i),
    });
  });

  it.each([
    [
      "a duplicate native call id",
      2,
      (rows: ReturnType<typeof sparkDirectMcpRollout>) => {
        appendSparkDirectCall(rows);
        const second = rows.filter((row) => row.payload?.call_id === "function-call-2");
        for (const row of second) row.payload!.call_id = "function-call-1";
      },
    ],
    [
      "a duplicate response-item id",
      2,
      (rows: ReturnType<typeof sparkDirectMcpRollout>) => {
        appendSparkDirectCall(rows);
        const calls = rows.filter((row) => row.payload?.type === "function_call");
        if (!calls[1]?.payload) throw new Error("missing second direct function call");
        calls[1].payload.id = "function-call-1";
      },
    ],
    [
      "an empty response-item id on an allowed function",
      1,
      (rows: ReturnType<typeof sparkDirectMcpRollout>) => {
        const call = rows.find((row) => row.payload?.type === "function_call")?.payload;
        if (!call) throw new Error("missing direct function call");
        call.id = "";
      },
    ],
    [
      "an empty native call id on an allowed function",
      1,
      (rows: ReturnType<typeof sparkDirectMcpRollout>) => {
        const call = rows.find((row) => row.payload?.type === "function_call")?.payload;
        if (!call) throw new Error("missing direct function call");
        call.call_id = "";
      },
    ],
  ])("keeps $0 in the generic invalid-or-duplicate category", (_label, ordinal, mutate) => {
    const rows = sparkDirectMcpRollout({
      content: [{ type: "text", text: "Use get_overworld_session to refresh the view." }],
    });
    mutate(rows);
    expect(inspectCodexGameplayResultForwarding(rows, direct)).toEqual({
      ok: false,
      reason: `Codex gameplay-result forwarding audit failed: direct MCP call ${ordinal} has an invalid or duplicate start`,
    });
  });

  it("rejects wrong-turn direct rows in the live prefix instead of deferring to terminal audit", () => {
    const rows = sparkDirectMcpRollout();
    for (const row of rows) {
      if (
        row.type === "response_item" &&
        ["function_call", "function_call_output"].includes(String(row.payload?.type))
      ) {
        row.payload!.internal_chat_message_metadata_passthrough = { turn_id: "wrong-turn" };
      }
    }
    expect(inspectCodexGameplayResultForwardingPrefix(rows, direct)).toMatchObject({ ok: false });
  });

  it.each([
    [
      "a tool-search call",
      (rows: ReturnType<typeof sparkDirectMcpRollout>) => {
        const directCall = rows.findIndex((row) => row.payload?.type === "function_call");
        rows.splice(directCall, 0, {
          type: "response_item",
          payload: { type: "tool_search_call", id: "search-call", call_id: "search" },
        });
      },
    ],
    [
      "a tool-search output",
      (rows: ReturnType<typeof sparkDirectMcpRollout>) => {
        const call = rows.findIndex((row) => row.payload?.type === "function_call");
        rows.splice(call, 0, {
          type: "response_item",
          payload: { type: "tool_search_output", id: "search-output", call_id: "search" },
        });
      },
    ],
    [
      "a forbidden function namespace",
      (rows: ReturnType<typeof sparkDirectMcpRollout>) => {
        const call = rows.find((row) => row.payload?.type === "function_call")?.payload;
        if (!call) throw new Error("missing function call");
        call.namespace = "functions";
      },
    ],
    [
      "a non-start first function",
      (rows: ReturnType<typeof sparkDirectMcpRollout>) => {
        const call = rows.find((row) => row.payload?.type === "function_call")?.payload;
        const completion = rows.find((row) => row.payload?.type === "mcp_tool_call_end")?.payload;
        if (!call || !completion) throw new Error("missing direct function lifecycle");
        call.name = "get_overworld_session";
        completion.invocation = {
          server: "adventureforge",
          tool: "get_overworld_session",
          arguments: {},
        };
      },
    ],
    [
      "noncanonical function arguments",
      (rows: ReturnType<typeof sparkDirectMcpRollout>) => {
        const call = rows.find((row) => row.payload?.type === "function_call")?.payload;
        if (!call) throw new Error("missing function call");
        call.arguments = "{ }";
      },
    ],
    [
      "a mismatched native result",
      (rows: ReturnType<typeof sparkDirectMcpRollout>) => {
        const completion = rows.find((row) => row.payload?.type === "mcp_tool_call_end")?.payload;
        if (!completion) throw new Error("missing MCP completion");
        completion.invocation = {
          server: "adventureforge",
          tool: "get_overworld_session",
          arguments: {},
        };
      },
    ],
    [
      "a mismatched visible output",
      (rows: ReturnType<typeof sparkDirectMcpRollout>) => {
        const output = rows.find((row) => row.payload?.type === "function_call_output")?.payload;
        if (!output) throw new Error("missing function output");
        output.output = "Wall time: 1.0 seconds\nOutput:\n[]\n";
      },
    ],
    [
      "a wrapper row",
      (rows: ReturnType<typeof sparkDirectMcpRollout>) => {
        const call = rows.findIndex((row) => row.payload?.type === "function_call");
        rows.splice(call, 0, forwardingRollout()[0]!);
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const rows = sparkDirectMcpRollout();
    mutate(rows);
    expect(inspectCodexGameplayResultForwarding(rows, direct)).toMatchObject({ ok: false });
  });

  it("rejects a direct startup error in the streaming public prefix", () => {
    const rows = validRows();
    rows.splice(1, 0, {
      type: "item.completed",
      item: { id: "error-1", type: "error", message: "unexpected" },
    });
    expect(inspectCodexPureEventPrefix(rows, SPARK_MODEL, direct)).toEqual({
      ok: false,
      reason: "Codex direct MCP run used an unexpected startup error",
    });
  });
});

/**
 * Codex ≥0.147 rewrote the private rollout's event vocabulary: the dedicated
 * user_message / agent_message / mcp_tool_call_end rows became generic
 * item_completed mirrors, response items gained unique ids, passthrough
 * metadata gained bookkeeping fields, and the developer prelude serializes the
 * skills block before the permissions block. Every fixture below reproduces
 * the row shapes captured live from codex-cli 0.151.0 on 2026-08-30 (thread
 * 01a05585-2289-7f61-93ec-cbbe74d2da97).
 */
describe("Codex ≥0.147 item-lifecycle rollout dialect", () => {
  const CURRENT_CLI = "0.151.0";
  const strict = { codeModeContract: "strict-code-mode-v2" };

  function itemEventRow(item: Record<string, unknown>) {
    return {
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: THREAD_ID,
        turn_id: "turn-1",
        item,
        started_at_ms: 1,
        completed_at_ms: 2,
      },
    };
  }

  function reasoningPair(ordinal: number) {
    return [
      itemEventRow({
        type: "Reasoning",
        id: `rs-event-${ordinal}`,
        summary_text: [],
        raw_content: [],
      }),
      {
        type: "response_item",
        payload: {
          type: "reasoning",
          id: `rs-${ordinal}`,
          summary: [],
          encrypted_content: "opaque",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
    ];
  }

  function currentForwardingRollout(
    result: Record<string, unknown> = {
      content: [{ type: "text", text: '{"state_hash":"next"}' }],
    },
  ): unknown[] {
    return [
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          id: "ctc-1",
          status: "completed",
          call_id: "call-wrapper-1",
          name: "exec",
          input: canonicalGameplayWrapper("tools.mcp__adventureforge__start_overworld({})"),
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1", create_time: 1.5 },
        },
      },
      itemEventRow({
        type: "McpToolCall",
        id: "exec-gameplay-1",
        server: "adventureforge",
        tool: "start_overworld",
        arguments: {},
        status: "completed",
        result,
        duration: { secs: 0, nanos: 5 },
      }),
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          id: "ctco-1",
          call_id: "call-wrapper-1",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1", create_time: 1.6 },
          output: [
            { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
            { type: "input_text", text: JSON.stringify(result) },
          ],
        },
      },
    ];
  }

  function completeCurrentLunaRollout(
    // The public fixture's completed gameplay result is `{content: []}`, and the
    // evidence cross-bind compares the two lifecycles byte-for-byte.
    gameplayRows: unknown[] = currentForwardingRollout({ content: [] }),
    effort = "max",
  ): unknown[] {
    const inputMessage = (
      id: string,
      role: "developer" | "user",
      kinds: string[],
      ...texts: string[]
    ) => ({
      type: "response_item",
      payload: {
        type: "message",
        id,
        role,
        content: texts.map((text) => ({ type: "input_text", text })),
        internal_chat_message_metadata_passthrough: {
          turn_id: "turn-1",
          create_time: 1.1,
          content_item_kinds: kinds,
        },
      },
    });
    return [
      { type: "session_meta", payload: { id: THREAD_ID, cli_version: CURRENT_CLI } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      inputMessage(
        "msg-1",
        "developer",
        ["host_skills.instructions", "permissions.instructions"],
        SKILLS_BLOCK,
        PERMISSIONS_BLOCK,
      ),
      inputMessage(
        "msg-2",
        "user",
        ["agents_md.instructions", "environments.environment_context"],
        GLOBAL_AGENTS_BLOCK,
        ENVIRONMENT_BLOCK,
      ),
      { type: "world_state", payload: { full: true } },
      {
        type: "turn_context",
        payload: {
          turn_id: "turn-1",
          model: "gpt-5.6-luna",
          effort,
          collaboration_mode: {
            mode: "default",
            settings: {
              model: "gpt-5.6-luna",
              reasoning_effort: effort,
              developer_instructions: null,
            },
          },
          multi_agent_version: "v1",
        },
      },
      inputMessage("msg-3", "user", ["user.text"], "blind prompt"),
      itemEventRow({
        type: "UserMessage",
        id: "um-1",
        content: [{ type: "text", text: "blind prompt", text_elements: [] }],
      }),
      ...reasoningPair(1),
      ...gameplayRows,
      { type: "event_msg", payload: { type: "token_count", info: {}, rate_limits: {} } },
      ...reasoningPair(2),
      itemEventRow({
        type: "AgentMessage",
        id: "am-1",
        content: [{ type: "Text", text: "report" }],
        phase: "final_answer",
      }),
      {
        type: "response_item",
        payload: {
          type: "message",
          id: "msg-4",
          role: "assistant",
          content: [{ type: "output_text", text: "report" }],
          phase: "final_answer",
          internal_chat_message_metadata_passthrough: {
            turn_id: "turn-1",
            create_time: 2.5,
            content_item_kinds: ["unknown"],
          },
        },
      },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ];
  }

  function currentLunaEnvelopeInput(rolloutRows: unknown[] = completeCurrentLunaRollout()) {
    return {
      rows: singleCodeModeWarningRows(),
      rolloutRows,
      report: "report",
      model: "gpt-5.6-luna",
      durationMs: 1200,
      codeModeContract: "strict-code-mode-v2",
      cliVersion: CURRENT_CLI,
      expectedEffort: "max",
    };
  }

  it("authenticates a complete 0.151-dialect Luna run end to end", () => {
    expect(buildCodexPureEnvelope(currentLunaEnvelopeInput())).toMatchObject({ ok: true });
  });

  it("accepts the item-lifecycle gameplay triplet in the streaming prefix", () => {
    const rollout = completeCurrentLunaRollout();
    expect(inspectCodexGameplayResultForwardingPrefix(rollout, strict)).toMatchObject({
      ok: true,
      completedGameplayCalls: 1,
      pending: null,
    });
    const throughCompletion = rollout.slice(
      0,
      rollout.findIndex(
        (row) =>
          (row as { payload?: { item?: { type?: string } } }).payload?.item?.type === "McpToolCall",
      ) + 1,
    );
    expect(inspectCodexGameplayResultForwardingPrefix(throughCompletion, strict)).toMatchObject({
      ok: true,
      pending: "visible_result",
    });
  });

  it("rejects an item-lifecycle mirror inside a legacy-dialect rollout", () => {
    const rollout = completeRollout(forwardingRollout(), "luna_v1") as unknown[];
    rollout.splice(
      2,
      0,
      itemEventRow({ type: "Reasoning", id: "rs-x", summary_text: [], raw_content: [] }),
    );
    expect(inspectCodexGameplayResultForwardingPrefix(rollout, strict)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("forbidden private event"),
    });
  });

  it("rejects a free-floating McpToolCall mirror as an orphan tool lifecycle", () => {
    const rollout = completeCurrentLunaRollout();
    rollout.splice(
      8,
      0,
      itemEventRow({
        type: "McpToolCall",
        id: "exec-orphan",
        server: "adventureforge",
        tool: "get_overworld_session",
        arguments: {},
        status: "completed",
        result: { content: [] },
        duration: { secs: 0, nanos: 1 },
      }),
    );
    expect(inspectCodexGameplayResultForwardingPrefix(rollout, strict)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("orphan or unexpected tool lifecycle"),
    });
  });

  it("rejects tool-shaped and unknown item mirrors and legacy plain events", () => {
    for (const item of [
      { type: "CommandExecution", id: "ce-1" },
      { type: "ContextCompaction", id: "cc-1" },
      { type: "FileChange", id: "fc-1" },
    ]) {
      const rollout = completeCurrentLunaRollout();
      rollout.splice(8, 0, itemEventRow(item));
      expect(inspectCodexGameplayResultForwardingPrefix(rollout, strict)).toMatchObject({
        ok: false,
      });
    }
    const withSettings = completeCurrentLunaRollout();
    withSettings.splice(1, 0, {
      type: "event_msg",
      payload: { type: "thread_settings_applied", settings: {} },
    });
    expect(inspectCodexGameplayResultForwardingPrefix(withSettings, strict)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("forbidden private event"),
    });
    const withLegacyUserEvent = completeCurrentLunaRollout();
    withLegacyUserEvent.splice(8, 0, {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "blind prompt",
        images: [],
        local_images: [],
        text_elements: [],
      },
    });
    expect(inspectCodexGameplayResultForwardingPrefix(withLegacyUserEvent, strict)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("forbidden private event"),
    });
  });

  it("rejects a rollout whose dialect differs from the authenticated client version", () => {
    expect(
      buildCodexPureEnvelope({ ...currentLunaEnvelopeInput(), cliVersion: "0.146.0" }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("dialect differs"),
    });
  });

  it("binds the launched reasoning effort to the captured turn context", () => {
    const xhighRollout = completeCurrentLunaRollout(
      currentForwardingRollout({ content: [] }),
      "xhigh",
    );
    expect(buildCodexPureEnvelope(currentLunaEnvelopeInput(xhighRollout))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("capture profile is unsupported"),
    });
    expect(
      buildCodexPureEnvelope({
        ...currentLunaEnvelopeInput(xhighRollout),
        expectedEffort: "xhigh",
      }),
    ).toMatchObject({ ok: true });
  });

  it("requires unique response-item ids throughout the current Luna profile", () => {
    const rollout = completeCurrentLunaRollout() as Array<{
      type?: string;
      payload?: Record<string, unknown>;
    }>;
    const prompt = rollout.find(
      (row) => row.type === "response_item" && row.payload?.role === "user",
    );
    if (!prompt?.payload) throw new Error("missing prompt fixture");
    delete prompt.payload.id;
    expect(buildCodexPureEnvelope(currentLunaEnvelopeInput(rollout))).toMatchObject({ ok: false });
  });

  it("requires the 0.147+ skills-then-permissions developer prelude order", () => {
    const rollout = completeCurrentLunaRollout() as Array<{
      type?: string;
      payload?: { role?: string; content?: Array<{ text?: string }> };
    }>;
    const developer = rollout.find(
      (row) => row.type === "response_item" && row.payload?.role === "developer",
    );
    if (!developer?.payload?.content) throw new Error("missing developer prelude fixture");
    developer.payload.content.reverse();
    expect(buildCodexPureEnvelope(currentLunaEnvelopeInput(rollout))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("input and initial context lifecycle"),
    });
  });

  // Observed live (luna 0.151.0, gameplay call 20): the model dropped a closing
  // quote, the host refused the script, and the strict lane killed a 19-call
  // clean run. The refusal pair below reproduces that rollout byte shape.
  function inertAttemptPair(ordinal: number) {
    return [
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          id: `ctc-inert-${ordinal}`,
          status: "completed",
          call_id: `call-inert-${ordinal}`,
          name: "exec",
          input:
            '// @exec: {"yield_time_ms": 120000}\n' +
            'text(await tools.mcp__adventureforge__step_action({"session_id":"r1","action_id":"oops));\n',
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1", create_time: 1.7 },
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          id: `ctco-inert-${ordinal}`,
          call_id: `call-inert-${ordinal}`,
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1", create_time: 1.8 },
          output: [
            { type: "input_text", text: "Script failed\nWall time 0.0 seconds\nOutput:\n" },
            {
              type: "input_text",
              text: "Script error:\nSyntaxError: Invalid or unexpected token",
            },
          ],
        },
      },
    ];
  }

  it("tolerates a host-refused wrapper attempt as a visible rejected input", () => {
    const rollout = completeCurrentLunaRollout([
      ...currentForwardingRollout({ content: [] }),
      ...inertAttemptPair(1),
    ]);
    expect(buildCodexPureEnvelope(currentLunaEnvelopeInput(rollout))).toMatchObject({ ok: true });
    expect(inspectCodexGameplayResultForwarding(rollout, strict)).toMatchObject({
      ok: true,
      completedGameplayCalls: 1,
    });
  });

  it("tolerates the exec front end's bare pragma-refusal string receipt", () => {
    // Observed live (luna 0.151.0, gameplay call 73): a `yield_time` pragma
    // typo drew a plain-string refusal and executed nothing.
    const pragmaAttempt = inertAttemptPair(1) as Array<{
      payload: Record<string, unknown>;
    }>;
    pragmaAttempt[0]!.payload.input =
      '// @exec: {"yield_time": 120000}\n' +
      'text(await tools.mcp__adventureforge__step_action({"session_id":"r3","action_id":"x","expected_state_hash":"h"}));\n';
    pragmaAttempt[1]!.payload.output =
      "exec pragma only supports `yield_time_ms` and `max_output_tokens`; got `yield_time`";
    const rollout = completeCurrentLunaRollout([
      ...currentForwardingRollout({ content: [] }),
      ...pragmaAttempt,
    ]);
    expect(buildCodexPureEnvelope(currentLunaEnvelopeInput(rollout))).toMatchObject({ ok: true });

    const arbitraryString = inertAttemptPair(2) as Array<{
      payload: Record<string, unknown>;
    }>;
    arbitraryString[1]!.payload.output = "some other host prose";
    expect(
      inspectCodexGameplayResultForwarding(
        completeCurrentLunaRollout([
          ...currentForwardingRollout({ content: [] }),
          ...arbitraryString,
        ]),
        strict,
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining("forbidden wrapper program"),
    });
  });

  it("keeps a live prefix pending until the refusal receipt row lands", () => {
    const rollout = completeCurrentLunaRollout([
      ...currentForwardingRollout({ content: [] }),
      ...inertAttemptPair(1),
    ]);
    const throughAttempt = rollout.slice(
      0,
      rollout.findIndex(
        (row) => (row as { payload?: { id?: string } }).payload?.id === "ctc-inert-1",
      ) + 1,
    );
    expect(inspectCodexGameplayResultForwardingPrefix(throughAttempt, strict)).toMatchObject({
      ok: true,
      pending: "wrapper_attempt_output",
    });
  });

  it("still fails closed when a refused wrapper is not provably inert", () => {
    const completedBanner = completeCurrentLunaRollout([
      ...currentForwardingRollout({ content: [] }),
      ...inertAttemptPair(1),
    ]) as Array<{ payload?: { id?: string; output?: Array<{ text: string }> } }>;
    const receipt = completedBanner.find((row) => row.payload?.id === "ctco-inert-1");
    const banner = receipt?.payload?.output?.[0];
    if (!banner) throw new Error("missing refusal receipt fixture");
    banner.text = "Script completed\nWall time 0.0 seconds\nOutput:\n";
    expect(inspectCodexGameplayResultForwarding(completedBanner, strict)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("forbidden wrapper program"),
    });

    const executedBetween = completeCurrentLunaRollout([
      ...currentForwardingRollout({ content: [] }),
      ...inertAttemptPair(2),
    ]) as unknown[];
    const attemptIndex = executedBetween.findIndex(
      (row) => (row as { payload?: { id?: string } }).payload?.id === "ctc-inert-2",
    );
    executedBetween.splice(
      attemptIndex + 1,
      0,
      itemEventRow({
        type: "McpToolCall",
        id: "exec-sneak",
        server: "adventureforge",
        tool: "step_action",
        arguments: {},
        status: "completed",
        result: { content: [] },
        duration: { secs: 0, nanos: 1 },
      }),
    );
    expect(inspectCodexGameplayResultForwarding(executedBetween, strict)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("forbidden wrapper program"),
    });
  });
});
