/**
 * `claude_code` is the second vendor the runner can WITNESS — and the first proof that
 * the provider registry is a seam rather than a Codex-shaped hole.
 *
 * The registry derives `runner_enforced` from three facts (headless CLI, a complete
 * `capture` block, a reader module on disk), and `src/blind/providers.ts` calls a
 * provider stamped with that label which the runner cannot actually witness "the worst
 * possible error in this file". Adding the block is therefore only half the change: the
 * label is now backed by `blind-tester/claude-session.mjs`, and these tests exist to
 * pin what that module must be able to establish before the label means anything.
 *
 * The single most important test in this file is
 * "refuses an init event that offered a tool the transcript never called". A Claude Code
 * session log records what the model CALLED; it never records what it was OFFERED. So a
 * transcript containing nothing but game tools is exactly as consistent with "the player
 * had nothing else" as with "the player had a shell and did not reach for it today".
 * Only the client's own `system`/`init` event reports the resolved surface, which makes
 * it the load-bearing artifact — and makes a reader that audits the transcript alone a
 * reader that certifies an unproven habit.
 *
 * PROVENANCE OF THE FIXTURES. The transcript rows and the init event below are copied
 * verbatim out of a real Claude Code session recorded on this machine, not reconstructed
 * from documentation:
 *
 *   transcript  ~/.claude/projects/C--Users-micha-AppData-Local-Temp-claude-…-blindprobe/
 *               11111111-2222-4333-8444-777777777777.jsonl
 *               sha256 e269e586d7d9f6742ece2f8848c2294c187f0b176fe40f7c3f49394735c6a0ef
 *   init event  first line of that run's `--output-format stream-json` stdout capture
 *               sha256 b477a333af1ba8bf09167e45014259380c77c0c08057f75a5d9b2ca8056d87bb
 *
 * That probe pointed Claude Code at a stub MCP server advertising the FULL server's
 * tools, so its one recorded call is `mcp__adventureforge__get_state` — a real MCP tool
 * that is not in the pure player surface. That is a gift rather than a gap: it makes the
 * "outside the pure surface" refusal below a test against genuinely recorded bytes. Where
 * a pure-only session is needed the tests rewrite exactly two fields of these real rows
 * (the tool name and the cwd/session id that bind them to a temp directory) and nothing
 * else; every other byte, including the bookkeeping row types Claude Code interleaves, is
 * as the client wrote it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs module without type declarations
import * as claudeSession from "../../blind-tester/claude-session.mjs";
import {
  derivePlaytestIsolation,
  findPlaytestProvider,
  parsePlaytestCatalog,
  resolvePlaytestArgv,
  resolvePlaytestSessionLogLocator,
} from "../../src/blind/providers.js";
import { PURE_PLAYER_TOOLS } from "../../src/mcp/server.js";

const {
  CLAUDE_MCP_SERVER_NAME,
  CLAUDE_MCP_TOOL_PREFIX,
  auditClaudeInitEvent,
  auditClaudeToolCalls,
  auditClaudeTranscriptBinding,
  buildClaudeEnvelope,
  captureClaudeSession,
  claudeProjectSlug,
  claudeSessionLogPath,
  extractClaudeToolCalls,
  parseClaudeJsonl,
  readClaudeInitEvent,
  readStableClaudeFile,
} = claudeSession;

/** Real recorded transcript rows, verbatim. See PROVENANCE above. */
const REAL_TRANSCRIPT_ROWS: readonly string[] = [
  String.raw`{"type":"queue-operation","operation":"enqueue","timestamp":"2026-08-29T14:50:46.843Z","sessionId":"11111111-2222-4333-8444-777777777777","content":"Call get_state once, then reply DONE. Nothing else.\n"}`,
  String.raw`{"parentUuid":null,"isSidechain":false,"promptId":"249fd725-50a6-45e6-9210-0f54c61e7070","type":"user","message":{"role":"user","content":"Call get_state once, then reply DONE. Nothing else.\n"},"uuid":"80de9e6e-0451-40ae-bb0b-9a5b0521f06f","timestamp":"2026-08-29T14:50:46.876Z","permissionMode":"bypassPermissions","promptSource":"sdk","userType":"external","entrypoint":"sdk-cli","cwd":"C:\\Users\\micha\\AppData\\Local\\Temp\\claude\\C--dev-adventureforge\\dc7baa4f-a5ac-4b70-b250-94fa9a4df2e0\\scratchpad\\blindprobe","sessionId":"11111111-2222-4333-8444-777777777777","version":"2.1.251","gitBranch":"main"}`,
  String.raw`{"type":"atis-latch","atis":"","sessionId":"11111111-2222-4333-8444-777777777777"}`,
  String.raw`{"parentUuid":"afeff4ba-49a9-4c03-bc06-59cd5272f326","isSidechain":false,"message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CeXE7jtdR8mcfZDHSarPM","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_011Um6tWYGWSMeFcJ5iT7ji2","name":"mcp__adventureforge__get_state","input":{},"caller":{"type":"direct"}}],"stop_reason":"tool_use","usage":{"input_tokens":9,"output_tokens":85},"diagnostics":null},"requestId":"req_011CeXE7jFvq92cXT1kLYChE","type":"assistant","uuid":"9051bf31-2207-4e05-afcd-1b2c0aca034b","timestamp":"2026-08-29T14:50:48.230Z","userType":"external","entrypoint":"sdk-cli","cwd":"C:\\Users\\micha\\AppData\\Local\\Temp\\claude\\C--dev-adventureforge\\dc7baa4f-a5ac-4b70-b250-94fa9a4df2e0\\scratchpad\\blindprobe","sessionId":"11111111-2222-4333-8444-777777777777","version":"2.1.251","gitBranch":"main"}`,
  String.raw`{"parentUuid":"9051bf31-2207-4e05-afcd-1b2c0aca034b","isSidechain":false,"promptId":"249fd725-50a6-45e6-9210-0f54c61e7070","type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_011Um6tWYGWSMeFcJ5iT7ji2","type":"tool_result","content":"(mcp__adventureforge__get_state completed with no output)"}]},"uuid":"efc34150-7e55-4c52-b2de-b99a612d9d24","timestamp":"2026-08-29T14:50:48.238Z","toolUseResult":[],"sourceToolAssistantUUID":"9051bf31-2207-4e05-afcd-1b2c0aca034b","userType":"external","entrypoint":"sdk-cli","cwd":"C:\\Users\\micha\\AppData\\Local\\Temp\\claude\\C--dev-adventureforge\\dc7baa4f-a5ac-4b70-b250-94fa9a4df2e0\\scratchpad\\blindprobe","sessionId":"11111111-2222-4333-8444-777777777777","version":"2.1.251","gitBranch":"main"}`,
  String.raw`{"type":"last-prompt","lastPrompt":"Call get_state once, then reply DONE. Nothing else.","leafUuid":"7650d1d1-286d-4e3b-9992-5b45543f2b14","sessionId":"11111111-2222-4333-8444-777777777777"}`,
];

/** The real `system`/`init` event from the same run, verbatim. See PROVENANCE above. */
const REAL_INIT_EVENT = String.raw`{"type":"system","subtype":"init","cwd":"C:\\Users\\micha\\AppData\\Local\\Temp\\claude\\C--dev-adventureforge\\dc7baa4f-a5ac-4b70-b250-94fa9a4df2e0\\scratchpad\\blindprobe","session_id":"11111111-2222-4333-8444-777777777777","tools":["mcp__adventureforge__get_state","mcp__adventureforge__new_game","mcp__adventureforge__step_action"],"mcp_servers":[{"name":"adventureforge","status":"connected"}],"model":"claude-haiku-4-5-20251001","permissionMode":"bypassPermissions","slash_commands":[],"apiKeySource":"none","claude_code_version":"2.1.251","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup"],"skills":[],"plugins":[],"capabilities":["interrupt_receipt_v1"],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"40367200-afc0-4dda-b39e-a1c6e5ed0181","fast_mode_state":"off"}`;

const RECORDED_SESSION_ID = "11111111-2222-4333-8444-777777777777";
const RECORDED_TOOL = "mcp__adventureforge__get_state";
/** A pure-surface tool, used where a session has to be one the audit can accept. */
const PURE_TOOL = "mcp__adventureforge__get_observation";

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type Row = Record<string, unknown>;

/**
 * Rebind the real rows to a temp player directory, optionally renaming the one tool call.
 *
 * Only `cwd`, `sessionId` and the tool NAME are ever touched — every other field stays as
 * Claude Code wrote it — because a fixture that has been reshaped to suit the parser
 * proves the parser handles the fixture, not the format.
 */
function transcriptRows(over: { cwd: string; sessionId?: string; toolName?: string }): Row[] {
  const sessionId = over.sessionId ?? RECORDED_SESSION_ID;
  return REAL_TRANSCRIPT_ROWS.map((line) => {
    const row = JSON.parse(line) as Row;
    if (typeof row.cwd === "string") row.cwd = over.cwd;
    if (typeof row.sessionId === "string") row.sessionId = sessionId;
    const content = (row.message as { content?: unknown } | undefined)?.content;
    if (over.toolName !== undefined && Array.isArray(content)) {
      for (const block of content as Row[]) {
        if (block.type === "tool_use" && block.name === RECORDED_TOOL) block.name = over.toolName;
      }
    }
    return row;
  });
}

function initEvent(over: Partial<Row> & { cwd: string; sessionId: string }): Row {
  const event = JSON.parse(REAL_INIT_EVENT) as Row;
  event.cwd = over.cwd;
  event.session_id = over.sessionId;
  // The recorded probe used a stub advertising the FULL server, so the default offered
  // surface here is the pure one; individual tests put the dirt back deliberately.
  event.tools = [PURE_TOOL, "mcp__adventureforge__list_legal_actions"];
  for (const [key, value] of Object.entries(over)) {
    if (key !== "cwd" && key !== "sessionId") event[key] = value;
  }
  return event;
}

function jsonl(rows: readonly unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

/** Lay one pinned session down on disk exactly where the reader will look for it. */
function layDownSession(over: { toolName?: string; init?: Partial<Row>; sessionId?: string }): {
  home: string;
  player: string;
  sessionId: string;
  streamPath: string;
} {
  const root = temp("af-cc-");
  const home = join(root, "home");
  const player = join(root, "player");
  const sessionId = over.sessionId ?? RECORDED_SESSION_ID;
  mkdirSync(player, { recursive: true });
  const logPath = claudeSessionLogPath({ home, cwd: player, sessionId });
  mkdirSync(join(logPath, ".."), { recursive: true });
  writeFileSync(
    logPath,
    jsonl(transcriptRows({ cwd: player, sessionId, toolName: over.toolName ?? PURE_TOOL })),
  );
  const streamPath = join(root, "stream.jsonl");
  writeFileSync(
    streamPath,
    jsonl([initEvent({ cwd: player, sessionId, ...(over.init ?? {}) }), { type: "result" }]),
  );
  return { home, player, sessionId, streamPath };
}

describe("claude_code earns runner_enforced from a reader that exists", () => {
  it("derives the label from the shipped registry entry, not from the literal in it", () => {
    const provider = findPlaytestProvider("claude_code")!;
    expect(provider.kind).toBe("headless_cli");
    const derived = derivePlaytestIsolation(provider);
    expect(derived.isolation).toBe("runner_enforced");
    expect(derived.code).toBe("runner_captures_this_vendor");
    expect(derived.readerModule).toBe("blind-tester/claude-session.mjs");
    // The whole point of the derivation is that this is a question for the filesystem.
    expect(existsSync(join(process.cwd(), derived.readerModule!))).toBe(true);
    // And the stored literal is a checksum on it, never an override.
    expect(provider.isolation).toBe(derived.isolation);
  });

  it("pins the session id, so the log path is exact before the client starts", () => {
    // This is the property that lets the reader stay small. Codex announces its id after
    // the fact, so its reader must WALK a sessions tree and match; a pinned id means the
    // runner reads exactly the log of the process it spawned, and can never pick up a
    // session a human played on the same machine minutes earlier.
    const capture = findPlaytestProvider("claude_code")!.capture!;
    expect(capture.sessionId.source).toBe("runner_pinned");
    expect(capture.sessionId.locator).toContain("--session-id");

    const locator = resolvePlaytestSessionLogLocator(capture, {
      home: "/home/p",
      sessionId: RECORDED_SESSION_ID,
      cwdSlug: claudeProjectSlug("/tmp/player"),
    });
    expect(locator.exact).toBe(true);
    expect(locator.path).not.toContain("*");
  });

  it("resolves the registry template and the reader module to the same one path", () => {
    // Two independent implementations of "where is the log": the registry's dumb token
    // substitution, and the reader's own knowledge of the vendor's layout. They have to
    // land on the same file or the entry describes a log nobody reads.
    const capture = findPlaytestProvider("claude_code")!.capture!;
    const home = resolve("/tmp/home");
    const cwd = resolve("/tmp/player");
    const fromRegistry = resolvePlaytestSessionLogLocator(capture, {
      home,
      sessionId: RECORDED_SESSION_ID,
      cwdSlug: claudeProjectSlug(cwd),
    }).path;
    const fromReader = claudeSessionLogPath({ home, cwd, sessionId: RECORDED_SESSION_ID });
    const normalize = (value: string) =>
      resolve(value)
        .replace(/[\\/]+/gu, "/")
        .toLowerCase();
    expect(normalize(fromRegistry)).toBe(normalize(fromReader));
  });

  it("launches with flags that let the game be played and nothing else be reached", () => {
    // The entry this replaces was decorative and wrong in two specific ways, and both
    // are worth naming so a future edit cannot quietly restore either.
    const provider = findPlaytestProvider("claude_code")!;
    const { executable, argv } = resolvePlaytestArgv(provider, {
      model: "claude-haiku-4-5-20251001",
      cwd: "/tmp/player",
      mcpConfig: "/tmp/mcp.json",
    });
    expect(executable).toBe("claude");

    // 1. Permission is ONE explicit grant, not a mode. `--permission-mode plan` REFUSES
    //    state-mutating tools, so every session under the original entry would have died
    //    on its first `step_action`; the blanket bypass mode that replaced it was the
    //    opposite error — more privilege than a player holding no built-in tools can use,
    //    and refused outright by the client when the process is root, which is how a whole
    //    live cohort once died six seconds after launch with nothing recorded. So the
    //    launch asks for no permission mode at all and grants exactly one thing.
    const allowRule = argv[argv.indexOf("--allowedTools") + 1];
    expect(allowRule).toBe(`mcp__${CLAUDE_MCP_SERVER_NAME}`);
    expect(argv).not.toContain("--permission-mode");
    expect(argv).not.toContain("plan");
    //    That grant names the ONE server blind-tester/run.sh writes into the config it
    //    hands over. The registry cannot interpolate the name (PlaytestLaunchSchema
    //    substitutes only {MODEL}, {CWD} and {MCP_CONFIG}), so the two are pinned together
    //    here: a rename on one side alone leaves the rule covering nothing, and every game
    //    tool is then denied silently, mid-wave.
    const runner = readFileSync(join(process.cwd(), "blind-tester", "run.sh"), "utf8");
    expect(runner).toContain(`"${CLAUDE_MCP_SERVER_NAME}": {`);
    // 2. `--add-dir` grants filesystem access a blind player must never have.
    expect(argv).not.toContain("--add-dir");

    // The surface-closing flags, each load-bearing on its own.
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--disable-slash-commands");
    // The init event only exists on a stream-json stdout, and that is the only proof of
    // the offered surface — so these two flags are part of the evidence chain, not
    // formatting preferences.
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(argv).toContain("--verbose");
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe("/tmp/mcp.json");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-haiku-4-5-20251001");
  });

  it("declares no model setting the launch cannot actually apply", () => {
    // Catalog `settings` are copied verbatim onto every sealed session record, so a
    // `thinking: on` that no flag in the argv above ever applies would put an unenforced
    // claim about how a run was configured into the corpus. Exactly one knob IS
    // applied: run.sh appends `--effort <settings.reasoning_effort>` to the launch
    // argv (claude 2.1.251 accepts low|medium|high|xhigh|max), so that key alone may
    // appear here, and only with a value the flag accepts.
    const appliedSettings = ["reasoning_effort"];
    const claudeEffortLevels = ["low", "medium", "high", "xhigh", "max"];
    const provider = findPlaytestProvider("claude_code")!;
    const catalog = parsePlaytestCatalog(
      provider,
      JSON.parse(
        readStableClaudeFile(join(process.cwd(), provider.catalogPath), "catalog").toString("utf8"),
      ),
    );
    for (const model of catalog.models) {
      const unappliedKeys = Object.keys(model.settings).filter(
        (key) => !appliedSettings.includes(key),
      );
      expect(unappliedKeys, model.id).toEqual([]);
      if (Object.hasOwn(model.settings, "reasoning_effort")) {
        expect(claudeEffortLevels, model.id).toContain(model.settings.reasoning_effort);
      }
    }
    expect(catalog.models.some((model) => model.tier === "reference")).toBe(true);
  });
});

describe("reading a real Claude Code session log", () => {
  it("extracts every tool call from real recorded bytes", () => {
    // The format is not reconstructed from documentation: Claude Code writes ONE record
    // per content block, so a tool call lives in `.message.content[]` of an `assistant`
    // record alongside bookkeeping rows (`queue-operation`, `atis-latch`, `last-prompt`)
    // that carry no message at all. A parser that assumed one record per message, or
    // that every record has a `message`, would have failed on this file.
    const rows = parseClaudeJsonl(jsonl(transcriptRows({ cwd: "/tmp/p" })), "transcript");
    expect(rows).toHaveLength(REAL_TRANSCRIPT_ROWS.length);

    const calls = extractClaudeToolCalls(rows);
    expect(calls).toEqual([
      {
        name: RECORDED_TOOL,
        id: "toolu_011Um6tWYGWSMeFcJ5iT7ji2",
        input: {},
        record_uuid: "9051bf31-2207-4e05-afcd-1b2c0aca034b",
      },
    ]);
  });

  it("binds every row to the runner's own session and player directory", () => {
    const bound = auditClaudeTranscriptBinding(
      parseClaudeJsonl(jsonl(transcriptRows({ cwd: "/tmp/p" })), "transcript"),
      { sessionId: RECORDED_SESSION_ID, cwd: "/tmp/p" },
    );
    expect(bound.model).toBe("claude-haiku-4-5-20251001");
    expect(bound.client_version).toBe("2.1.251");
    expect(bound.bound_records).toBeGreaterThan(0);

    // A log belonging to some other session of the same client is the failure a
    // pinned id exists to make impossible; the reader must still refuse it outright
    // rather than trust the path it was handed.
    const rows = parseClaudeJsonl(jsonl(transcriptRows({ cwd: "/tmp/p" })), "transcript");
    expect(() =>
      auditClaudeTranscriptBinding(rows, {
        sessionId: "22222222-3333-4444-8555-666666666666",
        cwd: "/tmp/p",
      }),
    ).toThrow(/not the runner's/);
    expect(() =>
      auditClaudeTranscriptBinding(rows, { sessionId: RECORDED_SESSION_ID, cwd: "/tmp/elsewhere" }),
    ).toThrow(/not the isolated player directory/);
  });

  it("computes the project directory Claude Code actually uses", () => {
    // Verified against real directories under ~/.claude/projects on the machine this was
    // written on. `_` and `@` collapsing to `-` is what rules out "replace separators".
    // The win32 case is the one with real directories to check against; elsewhere the
    // same character substitution is asserted on an absolute path that platform's
    // `resolve` will leave alone, so the test is about the transform rather than about
    // how a foreign drive letter happens to be rewritten.
    if (process.platform === "win32") {
      expect(claudeProjectSlug("C:/dev/adventureforge")).toBe("C--dev-adventureforge");
    } else {
      expect(claudeProjectSlug("/dev/adventureforge")).toBe("-dev-adventureforge");
    }
    const slug = claudeProjectSlug(resolve("/tmp/node_modules/@types/three"));
    expect(slug).toContain("node-modules--types-three");
    expect(slug).not.toMatch(/[^A-Za-z0-9-]/u);
  });

  it("captures a pinned session end to end and reports facts, not a verdict", () => {
    const { home, player, sessionId, streamPath } = layDownSession({});
    const receipt = captureClaudeSession({ home, cwd: player, sessionId, streamPath });

    expect(receipt.provider).toBe("claude_code");
    expect(receipt.session_id).toBe(sessionId);
    expect(receipt.called_tools).toEqual([
      { name: PURE_TOOL, id: "toolu_011Um6tWYGWSMeFcJ5iT7ji2" },
    ]);
    expect(receipt.tool_call_counts).toEqual({ get_observation: 1 });
    expect(receipt.offered_tools).toContain(PURE_TOOL);
    expect(receipt.mcp_servers).toEqual([{ name: "adventureforge", status: "connected" }]);
    expect(receipt.client).toMatchObject({
      version: "2.1.251",
      permission_mode: "bypassPermissions",
    });
    expect(receipt.transcript.sha256).toMatch(/^[0-9a-f]{64}$/u);

    // The reader must NOT stamp an isolation class. `derivePlaytestIsolation` is the only
    // authority on that label, and a second one that could disagree with it is exactly
    // the shape of failure the derivation was introduced to remove.
    expect(Object.keys(receipt)).not.toContain("isolation");
  });

  it("refuses anything that is not one private regular file", () => {
    const root = temp("af-cc-stat-");
    expect(() => readStableClaudeFile(root, "transcript")).toThrow(
      /one private regular non-linked file/,
    );
    expect(() => readStableClaudeFile(join(root, "absent.jsonl"), "transcript")).toThrow();
  });
});

describe("the closed whitelist over what was called", () => {
  it("refuses a transcript containing a non-MCP tool call", () => {
    // The plainest failure: the built-in tool surface was never actually disabled. A
    // session in which the player could run a shell is not a blind playtest, whatever
    // the rest of the transcript says.
    const rows = parseClaudeJsonl(
      jsonl(transcriptRows({ cwd: "/tmp/p", toolName: "Bash" })),
      "transcript",
    );
    expect(() => auditClaudeToolCalls(extractClaudeToolCalls(rows))).toThrow(
      /is not an AdventureForge MCP tool/,
    );

    // And end to end, so the refusal cannot be bypassed by calling the parts differently.
    const laid = layDownSession({ toolName: "Read" });
    expect(() =>
      captureClaudeSession({
        home: laid.home,
        cwd: laid.player,
        sessionId: laid.sessionId,
        streamPath: laid.streamPath,
      }),
    ).toThrow(/the player was not blind/);
  });

  it("refuses an MCP tool that is outside the pure player surface", () => {
    // Against the genuinely recorded call: `get_state` is a real AdventureForge MCP tool
    // and would pass a namespace-only check, but it belongs to the developer server. Its
    // presence means the game was started outside pure play mode, which is a different
    // bug from a leaked built-in and is reported as one.
    const rows = parseClaudeJsonl(jsonl(transcriptRows({ cwd: "/tmp/p" })), "transcript");
    expect(() => auditClaudeToolCalls(extractClaudeToolCalls(rows))).toThrow(
      /outside the pure player tool surface/,
    );
  });

  it("uses the game server's own tool set rather than a fourth copy of it", () => {
    // `PURE_PLAYER_TOOLS` in src/mcp/server.ts is what the server enforces. The reader
    // imports the mirror the Codex envelope already keeps, so a tool added to the game
    // cannot be pure for the server and unknown to the auditor.
    for (const tool of PURE_PLAYER_TOOLS) {
      const rows = parseClaudeJsonl(
        jsonl(transcriptRows({ cwd: "/tmp/p", toolName: `${CLAUDE_MCP_TOOL_PREFIX}${tool}` })),
        "transcript",
      );
      expect(auditClaudeToolCalls(extractClaudeToolCalls(rows)), tool).toEqual({ [tool]: 1 });
    }
  });

  it("refuses a tool call made on behalf of something other than the player", () => {
    const rows = transcriptRows({ cwd: "/tmp/p", toolName: PURE_TOOL });
    for (const row of rows) {
      const content = (row.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Row[]) {
        if (block.type === "tool_use") block.caller = { type: "agent" };
      }
    }
    expect(() => extractClaudeToolCalls(parseClaudeJsonl(jsonl(rows), "transcript"))).toThrow(
      /rather than the player/,
    );
  });
});

describe("the init event is the only proof of what the player was OFFERED", () => {
  it("refuses an init event that offered a tool the transcript never called", () => {
    // THE test this file exists for. The transcript is spotless — one pure game tool and
    // nothing else — and the session is still not blind, because the client reports that
    // a shell was on the table the whole time. No amount of reading the transcript can
    // reach that fact, which is why the stream is captured at all.
    const laid = layDownSession({ init: { tools: [PURE_TOOL, "Bash"] } });
    const rows = parseClaudeJsonl(
      jsonl(transcriptRows({ cwd: laid.player, toolName: PURE_TOOL })),
      "transcript",
    );
    expect(auditClaudeToolCalls(extractClaudeToolCalls(rows))).toEqual({ get_observation: 1 });

    expect(() =>
      captureClaudeSession({
        home: laid.home,
        cwd: laid.player,
        sessionId: laid.sessionId,
        streamPath: laid.streamPath,
      }),
    ).toThrow(/client init offered "Bash"/);
  });

  it("refuses an init event declaring a second MCP server", () => {
    // A second server is a second source of capability, arriving from the operator's
    // machine rather than from the game. `--strict-mcp-config` is supposed to make this
    // impossible; the init event is where the runner finds out whether it did.
    const cwd = "/tmp/p";
    const twoServers = initEvent({
      cwd,
      sessionId: RECORDED_SESSION_ID,
      mcp_servers: [
        { name: "adventureforge", status: "connected" },
        { name: "filesystem", status: "connected" },
      ],
    });
    expect(() => auditClaudeInitEvent(twoServers, { sessionId: RECORDED_SESSION_ID, cwd })).toThrow(
      /exactly one MCP server/,
    );

    // …and the one server has to be the game's, connected.
    expect(() =>
      auditClaudeInitEvent(
        initEvent({
          cwd,
          sessionId: RECORDED_SESSION_ID,
          mcp_servers: [{ name: "notes", status: "connected" }],
        }),
        { sessionId: RECORDED_SESSION_ID, cwd },
      ),
    ).toThrow(/rather than "adventureforge"/);
    expect(() =>
      auditClaudeInitEvent(
        initEvent({
          cwd,
          sessionId: RECORDED_SESSION_ID,
          mcp_servers: [{ name: "adventureforge", status: "failed" }],
        }),
        { sessionId: RECORDED_SESSION_ID, cwd },
      ),
    ).toThrow(/reports the adventureforge server as failed/);
  });

  it("refuses skills, plugins or slash commands loaded from the operator's machine", () => {
    const cwd = "/tmp/p";
    for (const field of ["skills", "plugins", "slash_commands"]) {
      expect(
        () =>
          auditClaudeInitEvent(
            initEvent({ cwd, sessionId: RECORDED_SESSION_ID, [field]: ["something"] }),
            { sessionId: RECORDED_SESSION_ID, cwd },
          ),
        field,
      ).toThrow(new RegExp(`loaded 1 ${field}`, "u"));
    }
  });

  it("refuses a stream that is not one session", () => {
    const cwd = "/tmp/p";
    const one = initEvent({ cwd, sessionId: RECORDED_SESSION_ID });
    expect(() => readClaudeInitEvent(parseClaudeJsonl(jsonl([{ type: "result" }]), "s"))).toThrow(
      /carries no system\/init event/,
    );
    expect(() => readClaudeInitEvent(parseClaudeJsonl(jsonl([one, one]), "s"))).toThrow(
      /2 system\/init events/,
    );
    // A clean init event for a DIFFERENT session must not vouch for this transcript.
    expect(() =>
      auditClaudeInitEvent(one, { sessionId: "22222222-3333-4444-8555-666666666666", cwd }),
    ).toThrow(/not the runner's/);
  });

  it("accepts the real recorded init event once its offered tools are pure", () => {
    // The positive half, so the refusals above are not passing for the trivial reason
    // that everything fails. Every field but `tools`, `cwd` and `session_id` is exactly
    // as the client wrote it, including the non-empty `agents` list — which is
    // deliberately NOT refused, because an agent type is unreachable without a Task tool
    // and the tools whitelist already forbids one.
    const cwd = "/tmp/p";
    const audited = auditClaudeInitEvent(initEvent({ cwd, sessionId: RECORDED_SESSION_ID }), {
      sessionId: RECORDED_SESSION_ID,
      cwd,
    });
    expect(audited.offered_tools).toEqual([
      "mcp__adventureforge__get_observation",
      "mcp__adventureforge__list_legal_actions",
    ]);
    expect(audited.permission_mode).toBe("bypassPermissions");
    expect(audited.client_version).toBe("2.1.251");
  });
});

/**
 * The final `result` event on the same stream, in the shape `--output-format stream-json`
 * emits it (a field subset; every field asserted below is one the client writes). The
 * fixture is synthetic where the transcript rows above are verbatim, because the recorded
 * probe predates the launch branch — the shape is pinned against claude 2.1.251's stream.
 */
function resultEvent(over: Partial<Row> = {}): Row {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 6042,
    duration_api_ms: 5310,
    num_turns: 3,
    result: "## Playthrough log\n\n…the player's report…",
    session_id: RECORDED_SESSION_ID,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 9, output_tokens: 85 },
    ...over,
  };
}

describe("the launch envelope run.sh publishes as <out>.json", () => {
  /** A receipt for the pinned fixture session, captured end to end off disk. */
  function fixtureReceipt(): { receipt: Row; player: string } {
    const laid = layDownSession({});
    return {
      receipt: captureClaudeSession({
        home: laid.home,
        cwd: laid.player,
        sessionId: laid.sessionId,
        streamPath: laid.streamPath,
      }) as Row,
      player: laid.player,
    };
  }

  function streamRows(rows: readonly Row[]): Row[] {
    return parseClaudeJsonl(jsonl(rows), "stream") as Row[];
  }

  it("carries the client's own result event on top of the audited receipt", () => {
    // The envelope exists so the generic tail of run.sh — `.result` extraction,
    // telemetry, receipt binding — reads one artifact per run regardless of vendor.
    // Every telemetry field it forwards is the client's own report of the run.
    const { receipt, player } = fixtureReceipt();
    const envelope = buildClaudeEnvelope({
      receipt,
      streamRows: streamRows([
        initEvent({ cwd: player, sessionId: RECORDED_SESSION_ID }),
        resultEvent(),
      ]),
      model: "claude-haiku-4-5-20251001",
      cliVersion: "2.1.251",
      transportContract: "game-direct-mcp-v1",
    });
    expect(envelope.provider).toBe("claude_code");
    expect(envelope.transport_contract).toBe("game-direct-mcp-v1");
    expect(envelope.model).toBe("claude-haiku-4-5-20251001");
    expect(envelope.session_id).toBe(RECORDED_SESSION_ID);
    expect(envelope.is_error).toBe(false);
    expect(envelope.result).toBe("## Playthrough log\n\n…the player's report…");
    expect(envelope.duration_ms).toBe(6042);
    expect(envelope.num_turns).toBe(3);
    expect(envelope.total_cost_usd).toBe(0.0123);
    expect(envelope.usage).toEqual({ input_tokens: 9, output_tokens: 85 });
    // The receipt travels whole, so the envelope is self-contained evidence.
    expect(envelope.capture).toEqual(receipt);
    // And like the receipt, it states facts, never the isolation verdict.
    expect(Object.keys(envelope)).not.toContain("isolation");
  });

  it("recovers a closing reply the model split around its one permitted retry", () => {
    // Observed live with claude-sonnet-5 (68 clean turns): the model wrote the
    // report's prose sections, made the prompt's single permitted evidence-retry
    // call, then emitted the exit-interview block alone — and Claude Code's own
    // `result` field carries only that last message, so the report verifier
    // rejected an otherwise-good run. The envelope's report is the model's full
    // closing reply: trailing assistant texts tolerating AT MOST ONE tool
    // interaction, with the final text still anchored to the client's own
    // authenticated result event.
    const { receipt, player } = fixtureReceipt();
    const prose = "## Playthrough log\n\nsections…\n\n## Verdict\n\nyes";
    const fence = "```json exit-interview\n{}\n```";
    const assistantText = (text: string): Row =>
      ({ type: "assistant", message: { content: [{ type: "text", text }] } }) as unknown as Row;
    const toolUse: Row = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "end", input: {} }] },
    } as unknown as Row;
    const toolResult: Row = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [] }] },
    } as unknown as Row;
    const build = (rows: readonly Row[]) =>
      buildClaudeEnvelope({
        receipt,
        streamRows: streamRows(rows),
        model: "claude-haiku-4-5-20251001",
        cliVersion: "2.1.251",
        transportContract: "game-direct-mcp-v1",
      });

    const split = build([
      initEvent({ cwd: player, sessionId: RECORDED_SESSION_ID }),
      assistantText(prose),
      toolUse,
      toolResult,
      assistantText(fence),
      resultEvent({ result: fence }),
    ]);
    expect(split.result).toBe(`${prose}\n\n${fence}`);

    // A second tool interaction inside the tail ends the reply: only what
    // follows it is the report, so mid-game commentary can never leak in.
    const twoGaps = build([
      initEvent({ cwd: player, sessionId: RECORDED_SESSION_ID }),
      assistantText("mid-game commentary"),
      toolUse,
      toolResult,
      assistantText(prose),
      toolUse,
      toolResult,
      assistantText(fence),
      resultEvent({ result: fence }),
    ]);
    expect(twoGaps.result).toBe(`${prose}\n\n${fence}`);
    expect(twoGaps.result).not.toContain("commentary");

    // If the last trailing text does not match the authenticated result, the
    // recovery is discarded and the client's own text stands alone.
    const anchorBroken = build([
      initEvent({ cwd: player, sessionId: RECORDED_SESSION_ID }),
      assistantText(prose),
      toolUse,
      toolResult,
      assistantText("something else entirely"),
      resultEvent({ result: fence }),
    ]);
    expect(anchorBroken.result).toBe(fence);
  });

  it("refuses a stream with no result event, or with two", () => {
    const { receipt, player } = fixtureReceipt();
    const init = initEvent({ cwd: player, sessionId: RECORDED_SESSION_ID });
    const build = (rows: readonly Row[]) =>
      buildClaudeEnvelope({
        receipt,
        streamRows: streamRows(rows),
        model: "claude-haiku-4-5-20251001",
        cliVersion: "2.1.251",
        transportContract: "game-direct-mcp-v1",
      });
    expect(() => build([init])).toThrow(/carries 0 result events/);
    expect(() => build([init, resultEvent(), resultEvent()])).toThrow(/carries 2 result events/);
  });

  it("refuses an errored, unsuccessful, or textless result", () => {
    // An is_error result is a run that did not finish as one playtest; publishing its
    // partial text as a report would be the quiet version of accepting a timeout.
    const { receipt, player } = fixtureReceipt();
    const init = initEvent({ cwd: player, sessionId: RECORDED_SESSION_ID });
    const build = (over: Partial<Row>) =>
      buildClaudeEnvelope({
        receipt,
        streamRows: streamRows([init, resultEvent(over)]),
        model: "claude-haiku-4-5-20251001",
        cliVersion: "2.1.251",
        transportContract: "game-direct-mcp-v1",
      });
    expect(() => build({ is_error: true })).toThrow(/did not end in one successful result/);
    expect(() => build({ subtype: "error_during_execution" })).toThrow(
      /did not end in one successful result/,
    );
    expect(() => build({ result: "" })).toThrow(/carries no report text/);
    expect(() => build({ result: 7 })).toThrow(/carries no report text/);
  });

  it("refuses a result event belonging to some other session", () => {
    // A clean result for a different session must not vouch for this receipt — the same
    // splice the transcript- and init-binding checks refuse, closed on the third artifact.
    const { receipt, player } = fixtureReceipt();
    expect(() =>
      buildClaudeEnvelope({
        receipt,
        streamRows: streamRows([
          initEvent({ cwd: player, sessionId: RECORDED_SESSION_ID }),
          resultEvent({ session_id: "22222222-3333-4444-8555-666666666666" }),
        ]),
        model: "claude-haiku-4-5-20251001",
        cliVersion: "2.1.251",
        transportContract: "game-direct-mcp-v1",
      }),
    ).toThrow(/not the runner's/);
  });

  it("refuses a session answered by a model other than the one requested", () => {
    // The catalog refuses aliases so a run means what its record says; the envelope is
    // where that promise is checked against what the transcript actually recorded.
    const { receipt, player } = fixtureReceipt();
    expect(() =>
      buildClaudeEnvelope({
        receipt,
        streamRows: streamRows([
          initEvent({ cwd: player, sessionId: RECORDED_SESSION_ID }),
          resultEvent(),
        ]),
        model: "claude-opus-5",
        cliVersion: "2.1.251",
        transportContract: "game-direct-mcp-v1",
      }),
    ).toThrow(/model/);
  });

  it("copies the audited transcript out of the client-owned home, exactly and exclusively", () => {
    // Evidence inside the directory the client owns is evidence the client can rewrite,
    // so the codex lane copies its rollout beside the report and the claude lane must do
    // the same. The copy is the exact bytes the audits ran over — written by the capture
    // itself, so byte identity with the receipt's sha256 holds by construction.
    const laid = layDownSession({});
    const copyPath = join(temp("af-cc-copy-"), "session-copy.jsonl");
    const receipt = captureClaudeSession({
      home: laid.home,
      cwd: laid.player,
      sessionId: laid.sessionId,
      streamPath: laid.streamPath,
      transcriptOut: copyPath,
    });
    const copied = readFileSync(copyPath);
    expect(createHash("sha256").update(copied).digest("hex")).toBe(receipt.transcript.sha256);
    expect(copied.byteLength).toBe(receipt.transcript.bytes);
    // Exclusive: a pre-existing file at the destination is refused, never clobbered.
    expect(() =>
      captureClaudeSession({
        home: laid.home,
        cwd: laid.player,
        sessionId: laid.sessionId,
        streamPath: laid.streamPath,
        transcriptOut: copyPath,
      }),
    ).toThrow();
  });

  it("wires resolve-log, capture --transcript-out and envelope through the CLI run.sh calls", () => {
    // The flag surface is what run.sh actually drives, so it is exercised as a process
    // rather than trusted to match the exported functions.
    const laid = layDownSession({});
    const streamWithResult = join(temp("af-cc-cli-"), "stream.jsonl");
    writeFileSync(
      streamWithResult,
      jsonl([initEvent({ cwd: laid.player, sessionId: laid.sessionId }), resultEvent()]),
    );
    const reader = join(process.cwd(), "blind-tester", "claude-session.mjs");
    const run = (args: readonly string[]) => {
      const result = spawnSync(process.execPath, [reader, ...args], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.status, `${args[0]}: ${result.stderr}`).toBe(0);
      return result.stdout;
    };

    const resolved = run([
      "resolve-log",
      "--home",
      laid.home,
      "--cwd",
      laid.player,
      "--session-id",
      laid.sessionId,
    ]).trim();
    expect(resolved).toBe(
      claudeSessionLogPath({ home: laid.home, cwd: laid.player, sessionId: laid.sessionId }),
    );

    const copyPath = join(temp("af-cc-cli-copy-"), "copy.jsonl");
    const receipt = JSON.parse(
      run([
        "capture",
        "--home",
        laid.home,
        "--cwd",
        laid.player,
        "--session-id",
        laid.sessionId,
        "--stream",
        streamWithResult,
        "--transcript-out",
        copyPath,
      ]),
    ) as Row;
    expect(receipt.provider).toBe("claude_code");
    expect(existsSync(copyPath)).toBe(true);

    const receiptPath = join(temp("af-cc-cli-receipt-"), "capture.json");
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const envelope = JSON.parse(
      run([
        "envelope",
        "--receipt",
        receiptPath,
        "--stream",
        streamWithResult,
        "--model",
        "claude-haiku-4-5-20251001",
        "--cli-version",
        "2.1.251",
        "--transport-contract",
        "game-direct-mcp-v1",
      ]),
    ) as Row;
    expect(envelope.result).toBe("## Playthrough log\n\n…the player's report…");
    expect(envelope.capture).toEqual(receipt);
  });
});
