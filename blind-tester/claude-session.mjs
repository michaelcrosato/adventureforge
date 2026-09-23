#!/usr/bin/env node
/**
 * Claude Code session-log reader — the capture half of the `claude_code` registry entry.
 *
 * `src/blind/providers.ts` derives a provider's evidence class from three facts: the
 * runner spawns it, it declares a complete `capture` block, and that block's reader
 * module EXISTS. This is that module. Until it landed, `claude_code` derived
 * `operator_attested` — correctly, because nothing here could read a Claude Code
 * session, so every session it produced was a human's word. The point of writing it is
 * not to make a label prettier; it is to make the seam real by qualifying a SECOND
 * vendor on the same terms as the first, so "model-agnostic" stops being an aspiration
 * in a comment.
 *
 * It is far smaller than `codex-rollout.mjs`, and the reason is worth stating because it
 * is the strongest property this vendor has: Claude Code accepts `--session-id <uuid>`,
 * so the RUNNER picks the id and the log's path is fully determined BEFORE the process
 * starts. Codex announces its own thread id after the fact, which forces that reader to
 * walk a sessions tree, match an announced id against a private rollout, and defend the
 * whole walk against symlinks, renames, and a second Codex the operator happened to be
 * running. None of that exists here. One path, computed up front, read once.
 *
 * WHAT THIS MODULE PROVES, AND WHAT IT CANNOT
 *
 * Two artifacts, and they answer different questions. Confusing them is how a reader
 * ends up certifying a session it never actually constrained:
 *
 *   1. The private JSONL transcript under `<home>/.claude/projects/<cwd-slug>/<id>.jsonl`
 *      records what the model CALLED. It is written by the client itself, after the
 *      fact, and it is the only durable record of the run.
 *   2. The `system`/`init` event on the client's own stdout stream records what the model
 *      was OFFERED — the resolved tool list and the resolved MCP server set, as the
 *      client computed them from the argv the runner supplied.
 *
 * The transcript alone is NOT sufficient, and that is the single most important sentence
 * in this file. A transcript containing only AdventureForge tool calls is equally
 * consistent with "the player had nothing else" and with "the player had a shell and a
 * web fetch and simply did not reach for them this run". The first is blindness; the
 * second is an unproven habit that will break the day a model gets curious. So the init
 * event is load-bearing: it is the ONLY place the offered surface is observable, and
 * `auditClaudeInitEvent` is what turns "it did not misbehave" into "it could not".
 *
 * Both checks are closed whitelists over the same set the game server itself enforces
 * (`PURE_PLAYER_TOOLS` in `src/mcp/server.ts`, mirrored as `CODEX_PURE_PLAYER_TOOLS` in
 * `codex-pure-envelope.mjs` and imported here rather than copied). A fourth copy of that
 * list would be a fourth thing to forget to update, and the failure mode of a stale copy
 * is that a newly added authoring tool silently counts as pure.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 *
 * It does not stamp an `isolation` value onto its receipt. The derivation in
 * `src/blind/providers.ts` is the only authority on that label, and a reader that also
 * announced one would create a second authority that could disagree with the first —
 * which is precisely the shape of failure the derivation was introduced to remove. This
 * module emits FACTS (which tools were offered, which were called, which session, which
 * directory); the registry decides what class of evidence those facts constitute.
 *
 * It also does not close the record-TYPE vocabulary the way `codex-pure-envelope.mjs`
 * closes Codex's. Claude Code writes a large and version-dependent set of bookkeeping
 * rows (`queue-operation`, `atis-latch`, `file-history-delta`, `frame-link`, `ai-title`,
 * …; sixteen distinct types in one real 2939-row log on this machine). None of them is
 * evidence about the tool boundary, so an allowlist over them would fail honest sessions
 * on a client upgrade while proving nothing. The whitelists live exactly where the
 * evidence is: the offered tools, and the called tools.
 */

import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CODEX_PURE_PLAYER_TOOLS } from "./codex-pure-envelope.mjs";
import { parseJsonRejectingDuplicateKeys } from "./strict-json.mjs";

/**
 * The MCP server name the runner injects, and therefore the namespace prefix Claude Code
 * builds its tool names from. `blind-tester/run.sh` writes `mcpServers.adventureforge`
 * and the player prompt refers to `mcp__adventureforge__*`; both halves of that name are
 * the same fact, so it is written once here.
 */
export const CLAUDE_MCP_SERVER_NAME = "adventureforge";
export const CLAUDE_MCP_TOOL_PREFIX = `mcp__${CLAUDE_MCP_SERVER_NAME}__`;

/** Where Claude Code keeps per-project session logs, relative to the state root. */
export const CLAUDE_PROJECTS_DIRNAME = "projects";
/** State root under `$HOME` when the operator has not relocated it. */
export const CLAUDE_STATE_ROOT_DIRNAME = ".claude";

/**
 * `--session-id` takes a UUID and the client refuses anything else, so the runner's
 * pinned id is constrained before launch. Matching the same shape here means a
 * malformed id is reported as a bad ARGUMENT rather than as a missing log file, which
 * are two very different bugs to be handed.
 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Read ceiling for one transcript. Generous rather than tight: a long playtest is a few
 * megabytes and a real development session on this machine measured 5.1 MB, so a small
 * ceiling would reject honest runs. Its job is to stop the reader being pointed at
 * something that is not a transcript at all.
 */
export const CLAUDE_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
/** The stdout stream is one line per event and orders of magnitude smaller. */
export const CLAUDE_STREAM_MAX_BYTES = 64 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

/**
 * Read one file while proving it stayed one private regular file throughout.
 *
 * Deliberately the same posture as `readStablePrivateFile` in `codex-rollout.mjs`, and
 * for the same reason: this file is EVIDENCE. A symlink means someone else chose what
 * the reader audits; `nlink !== 1` means a second name for the same inode can rewrite it
 * from outside the run; and identity that changes between the lstat, the open and the
 * final fstat means the bytes audited are not the bytes that were on disk when the
 * checks passed. Each of those turns a proof into a description of a proof.
 *
 * The lstat/open/fstat/re-fstat dance is not paranoia about a hostile operator — it is
 * about a second Claude Code, a sync client, or a log rotation touching the file while
 * the runner reads it. The honest outcome in every one of those cases is to refuse.
 */
export function readStableClaudeFile(path, label, { maxBytes } = {}) {
  const linked = lstatSync(path, { bigint: true });
  if (linked.isSymbolicLink() || !linked.isFile() || linked.nlink !== 1n) {
    fail(`${label} must be one private regular non-linked file`);
  }
  const maximum = maxBytes === undefined ? null : BigInt(maxBytes);
  if (maximum !== null && linked.size > maximum) {
    fail(`${label} exceeds the ${maxBytes}-byte read ceiling`);
  }
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      linked.dev !== before.dev ||
      linked.ino !== before.ino ||
      linked.size !== before.size ||
      linked.mtimeNs !== before.mtimeNs ||
      linked.ctimeNs !== before.ctimeNs
    ) {
      fail(`${label} must remain one private regular non-linked file`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      after.nlink !== 1n ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(bytes.byteLength) !== after.size
    ) {
      fail(`${label} changed while it was being captured`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Claude Code's cwd → project-directory transform: every non-alphanumeric byte becomes
 * `-`.
 *
 * This is THE vendor-specific rule, and it lives here rather than in the registry on
 * purpose — `PlaytestSessionLogSchema` in `src/blind/providers.ts` says so explicitly:
 * the template does dumb token substitution and nothing else, because the moment that
 * file learns one vendor's naming convention it stops being a seam.
 *
 * Verified by observation, not documentation, against real directories on this machine:
 *
 *   C:\dev\adventureforge                       → C--dev-adventureforge
 *   C:\dev\rcproam\node_modules\@types\three    → C--dev-rcproam-node-modules--types-three
 *
 * The second is the interesting one: `_` and `@` both collapse to `-`, which rules out
 * "replace path separators" and confirms the character class. The transform is a pure
 * character substitution in the client and so does not vary by platform, but only the
 * win32 form is verified here; if it is wrong anywhere else the reader fails to find a
 * file, which is a refusal rather than a false certification, and refusing is the
 * correct direction for a mistake in an evidence reader to fall.
 */
export function claudeProjectSlug(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) fail("cwd must be a non-empty path");
  return resolve(cwd).replace(/[^A-Za-z0-9]/gu, "-");
}

/**
 * The one path a pinned session writes to.
 *
 * `exact` in the registry's `resolvePlaytestSessionLogLocator` sense: no wildcard, no
 * search, no "newest file wins". That last one is the failure this vendor gets to skip
 * entirely — picking the newest log in a directory is how a reader ends up auditing a
 * session a human played on the same machine three minutes earlier and reporting it as
 * runner-witnessed.
 *
 * It also means the runner does not need to relocate the client's state root to keep
 * concurrent players apart: two cohort members share `~/.claude/projects` safely because
 * their ids differ. (Claude Code does expose `CLAUDE_CONFIG_DIR`, but this checkout has
 * not verified that it relocates the per-session log, so the registry entry declares no
 * `rootEnv` rather than naming a variable on faith. `home` is a parameter here, so a
 * caller that establishes the answer can point the reader anywhere without a code change.)
 */
export function claudeSessionLogPath({ home, cwd, sessionId }) {
  if (typeof home !== "string" || home.length === 0) fail("home must be a non-empty path");
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    fail(`session id ${JSON.stringify(sessionId)} is not the UUID --session-id accepts`);
  }
  const root = resolve(home, CLAUDE_STATE_ROOT_DIRNAME);
  return resolve(root, CLAUDE_PROJECTS_DIRNAME, claudeProjectSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * Compare two paths the way the filesystem this runs on would.
 *
 * The transcript records the cwd as the client saw it; the runner knows the player
 * directory it created. Those are the same directory written two ways — separators and
 * drive-letter case differ freely on win32 — so a raw string compare would reject honest
 * sessions. Case is folded only on win32, because a posix filesystem really does treat
 * `/tmp/Player` and `/tmp/player` as two different directories and folding there would
 * accept a run from the wrong one.
 */
function samePath(left, right, platform = process.platform) {
  const normalize = (value) => {
    const absolute = resolve(value)
      .replace(/[\\/]+/gu, "/")
      .replace(/\/+$/u, "");
    return platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  return normalize(left) === normalize(right);
}

/**
 * Parse a JSONL artifact into rows, refusing anything ambiguous.
 *
 * `parseJsonRejectingDuplicateKeys` rather than bare `JSON.parse`: a row carrying
 * `{"name":"get_observation","name":"Bash"}` parses cleanly under the standard parser
 * and yields whichever key came last, so the audited value and the value a human reading
 * the file would see can differ. In an evidence artifact that is not a curiosity.
 */
export function parseClaudeJsonl(text, label) {
  const rows = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    const parsed = parseJsonRejectingDuplicateKeys(line, `${label} line ${index + 1}`);
    if (!parsed.ok) fail(parsed.reason);
    if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
      fail(`${label} line ${index + 1} must be a JSON object`);
    }
    rows.push(parsed.value);
  }
  if (rows.length === 0) fail(`${label} contains no records`);
  return rows;
}

/**
 * Every tool call in the transcript, in order.
 *
 * Claude Code writes ONE record per content block, so a single assistant message with a
 * thinking block and a tool call arrives as two `assistant` rows sharing one
 * `message.id`. That is why this walks blocks rather than messages, and why the
 * uniqueness check below is on the tool-use id rather than the record: 478 tool calls in
 * a real session on this machine produced 478 distinct ids and no repeats, so a repeated
 * id means the file is not what it appears to be, not that the format is chattier than
 * expected.
 */
export function extractClaudeToolCalls(rows) {
  const calls = [];
  const seen = new Set();
  for (const row of rows) {
    if (row.type !== "assistant") continue;
    const content = row.message?.content;
    // A plain-string assistant message carries no tool calls. It is not an error.
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block === null || typeof block !== "object" || block.type !== "tool_use") continue;
      if (typeof block.name !== "string" || block.name.length === 0) {
        fail("transcript records a tool call with no name");
      }
      if (typeof block.id !== "string" || block.id.length === 0) {
        fail(`transcript records a call to ${JSON.stringify(block.name)} with no tool-use id`);
      }
      if (seen.has(block.id)) fail(`transcript repeats tool-use id ${JSON.stringify(block.id)}`);
      seen.add(block.id);
      // `caller` distinguishes the model's own turn from a call made on behalf of
      // something else (a subagent, say). A blind player is launched with no Task tool,
      // so nothing but `direct` should ever appear; a present-but-different caller means
      // some other actor drove a game tool and the session is not one player's run.
      // Absence is tolerated rather than rejected: an older client that does not write
      // the field is not evidence of an indirect caller, and rejecting on absence would
      // fail honest transcripts for a reason unrelated to the tool boundary.
      const caller = block.caller;
      if (caller !== undefined && caller !== null && caller.type !== "direct") {
        fail(
          `transcript records ${JSON.stringify(block.name)} called by ` +
            `${JSON.stringify(caller.type)} rather than the player`,
        );
      }
      calls.push({
        name: block.name,
        id: block.id,
        input: block.input === undefined ? {} : block.input,
        record_uuid: typeof row.uuid === "string" ? row.uuid : null,
      });
    }
  }
  return calls;
}

/**
 * The closed whitelist over what was CALLED.
 *
 * Two separate refusals, because they mean different things to whoever reads the error.
 * A bare `Bash` says the built-in tool surface was never actually disabled — the launch
 * is wrong. A namespaced `mcp__adventureforge__generate_rpg_pack` says the MCP server
 * was started outside pure play mode — the transport is wrong. Both void the run; being
 * told which one saves an hour.
 */
export function auditClaudeToolCalls(toolCalls) {
  const counts = new Map();
  for (const call of toolCalls) {
    if (!call.name.startsWith(CLAUDE_MCP_TOOL_PREFIX)) {
      fail(
        `transcript records a call to ${JSON.stringify(call.name)}, which is not an ` +
          `AdventureForge MCP tool: the player was not blind`,
      );
    }
    const bare = call.name.slice(CLAUDE_MCP_TOOL_PREFIX.length);
    if (!CODEX_PURE_PLAYER_TOOLS.has(bare)) {
      fail(
        `transcript records a call to ${JSON.stringify(call.name)}, which is outside the ` +
          `pure player tool surface`,
      );
    }
    counts.set(bare, (counts.get(bare) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * Bind the transcript to the run the runner believes it launched.
 *
 * Without this the reader audits "a Claude Code session" rather than "THIS session".
 * Both fields are written on nearly every row by the client itself, so checking every
 * row that carries them costs nothing and catches a spliced file as readily as a
 * mistargeted one. The client version and the model are collected on the same pass
 * because they are the evidence a session record wants stamped on it, and because a
 * transcript in which the model changes mid-run is not one comparable playtest.
 */
export function auditClaudeTranscriptBinding(rows, { sessionId, cwd }) {
  const versions = new Set();
  const models = new Set();
  let bound = 0;
  for (const row of rows) {
    if (typeof row.sessionId === "string") {
      if (row.sessionId !== sessionId) {
        fail(
          `transcript row belongs to session ${JSON.stringify(row.sessionId)}, not the ` +
            `runner's ${JSON.stringify(sessionId)}`,
        );
      }
      bound += 1;
    }
    if (typeof row.cwd === "string" && !samePath(row.cwd, cwd)) {
      fail(
        `transcript row ran in ${JSON.stringify(row.cwd)}, not the isolated player ` +
          `directory ${JSON.stringify(cwd)}`,
      );
    }
    // A sidechain row is a subagent's turn. The blind launch offers no Task tool, so one
    // appearing means the player's context was not the only context in the run.
    if (row.isSidechain === true) fail("transcript contains a sidechain (subagent) record");
    if (typeof row.version === "string") versions.add(row.version);
    if (row.type === "assistant" && typeof row.message?.model === "string") {
      models.add(row.message.model);
    }
  }
  if (bound === 0) fail("transcript carries no session id on any record");
  if (versions.size > 1) {
    fail(`transcript spans more than one client version: ${[...versions].sort().join(", ")}`);
  }
  if (models.size > 1) {
    fail(`transcript spans more than one model: ${[...models].sort().join(", ")}`);
  }
  return {
    client_version: [...versions][0] ?? null,
    model: [...models][0] ?? null,
    bound_records: bound,
  };
}

/**
 * The `system`/`init` event from the client's own stdout stream.
 *
 * Exactly one is required. A stream carrying two of them is two sessions concatenated,
 * and auditing the first while the transcript belongs to the second is the quiet version
 * of certifying the wrong run.
 */
export function readClaudeInitEvent(streamRows) {
  const inits = streamRows.filter((row) => row.type === "system" && row.subtype === "init");
  if (inits.length === 0) {
    fail("client stream carries no system/init event, so the offered tool surface is unknown");
  }
  if (inits.length > 1) {
    fail(`client stream carries ${inits.length} system/init events, so it is not one session`);
  }
  return inits[0];
}

/**
 * THE LOAD-BEARING CHECK: what the player was OFFERED.
 *
 * The on-disk JSONL records what was CALLED but never what was AVAILABLE, so a
 * transcript full of nothing but game tools cannot distinguish a player that had no
 * other tools from a player that had a shell and did not use it this run. The init
 * event is the only place the resolved surface is observable — it is the client
 * reporting back what the runner's argv actually produced — which makes it the only
 * thing standing between `runner_enforced` and an unverified habit.
 *
 * So this asserts the whole surface, not just the tools:
 *
 *   - exactly one MCP server, named `adventureforge`, connected. A second server is a
 *     second source of capability; a disconnected one means the tools listed are stale.
 *   - every offered tool namespaced to that server AND inside the pure player set. The
 *     namespace check catches built-ins (`Bash`, `Read`) surviving `--tools ""`; the set
 *     check catches the game server being started outside pure play mode, which offers
 *     authoring and raw-state tools that no player should ever see.
 *   - no skills, no plugins, no slash commands. These are not tools, but they are
 *     instructions and capability that arrive from the operator's machine rather than
 *     from the game, and a blind player must be reading the game and nothing else.
 *   - the id and the directory, so the offered surface provably belongs to the same run
 *     as the transcript rather than to some other session that happened to be captured.
 *
 * `agents` is deliberately NOT asserted empty: the client lists agent TYPES it knows
 * about regardless of whether they are reachable, and none is reachable without a Task
 * tool — which the tools whitelist above already forbids. Asserting it would fail honest
 * sessions for a fact that carries no capability.
 */
export function auditClaudeInitEvent(init, { sessionId, cwd }) {
  if (init.session_id !== sessionId) {
    fail(
      `client init reports session ${JSON.stringify(init.session_id)}, not the runner's ` +
        `${JSON.stringify(sessionId)}`,
    );
  }
  if (typeof init.cwd !== "string" || !samePath(init.cwd, cwd)) {
    fail(
      `client init reports cwd ${JSON.stringify(init.cwd)}, not the isolated player ` +
        `directory ${JSON.stringify(cwd)}`,
    );
  }

  const servers = init.mcp_servers;
  if (!Array.isArray(servers) || servers.length !== 1) {
    const named = Array.isArray(servers)
      ? servers.map((server) => server?.name).join(", ")
      : "none";
    fail(`client init must declare exactly one MCP server; it declared: ${named}`);
  }
  const [server] = servers;
  if (server?.name !== CLAUDE_MCP_SERVER_NAME) {
    fail(
      `client init declares MCP server ${JSON.stringify(server?.name)} rather than ` +
        `${JSON.stringify(CLAUDE_MCP_SERVER_NAME)}`,
    );
  }
  if (server.status !== "connected") {
    fail(`client init reports the ${CLAUDE_MCP_SERVER_NAME} server as ${server.status}`);
  }

  const tools = init.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    fail("client init offers no tools, so no game was reachable");
  }
  for (const tool of tools) {
    if (typeof tool !== "string" || !tool.startsWith(CLAUDE_MCP_TOOL_PREFIX)) {
      fail(
        `client init offered ${JSON.stringify(tool)}, which is not an AdventureForge MCP ` +
          `tool: the player was not blind`,
      );
    }
    const bare = tool.slice(CLAUDE_MCP_TOOL_PREFIX.length);
    if (!CODEX_PURE_PLAYER_TOOLS.has(bare)) {
      fail(
        `client init offered ${JSON.stringify(tool)}, which is outside the pure player ` +
          `tool surface`,
      );
    }
  }

  for (const field of ["skills", "plugins", "slash_commands"]) {
    const value = init[field];
    if (!Array.isArray(value)) fail(`client init must report ${field} as an array`);
    if (value.length > 0) {
      fail(`client init loaded ${value.length} ${field}, so the player read more than the game`);
    }
  }

  return {
    offered_tools: [...tools].sort(),
    mcp_servers: servers.map((entry) => ({ name: entry.name, status: entry.status })),
    model: typeof init.model === "string" ? init.model : null,
    permission_mode: typeof init.permissionMode === "string" ? init.permissionMode : null,
    client_version: typeof init.claude_code_version === "string" ? init.claude_code_version : null,
  };
}

/**
 * Read and audit one pinned Claude Code session end to end.
 *
 * Returns facts, never a verdict about evidence class — see the header. Throws on the
 * first thing it cannot establish, because a partially-audited session is worth exactly
 * as much as an unaudited one and returning a "mostly fine" object invites a caller to
 * treat it as proof.
 */
export function captureClaudeSession({
  home,
  cwd,
  sessionId,
  streamPath,
  maxBytes,
  transcriptOut,
}) {
  const path = claudeSessionLogPath({ home, cwd, sessionId });
  const transcriptBytes = readStableClaudeFile(path, "Claude Code session transcript", {
    maxBytes: maxBytes ?? CLAUDE_TRANSCRIPT_MAX_BYTES,
  });
  const streamBytes = readStableClaudeFile(streamPath, "Claude Code client stream", {
    maxBytes: CLAUDE_STREAM_MAX_BYTES,
  });
  const receipt = inspectClaudeSessionBytes({ transcriptBytes, streamBytes, sessionId, cwd, path });
  if (transcriptOut !== undefined) {
    writeFileSync(transcriptOut, transcriptBytes, { flag: "wx" });
  }
  return receipt;
}

/** Re-audit the retained bytes without reopening a client's private state directory. */
export function inspectClaudeSessionBytes({ transcriptBytes, streamBytes, sessionId, cwd, path }) {
  const rows = parseClaudeJsonl(transcriptBytes.toString("utf8"), "Claude Code session transcript");
  const binding = auditClaudeTranscriptBinding(rows, { sessionId, cwd });
  const toolCalls = extractClaudeToolCalls(rows);
  const toolCallCounts = auditClaudeToolCalls(toolCalls);

  const streamRows = parseClaudeJsonl(streamBytes.toString("utf8"), "Claude Code client stream");
  const offered = auditClaudeInitEvent(readClaudeInitEvent(streamRows), { sessionId, cwd });

  // The transcript's model and the init event's model are two independent reports of the
  // same fact. Disagreement means the stream and the transcript describe different runs,
  // which would let a clean init event vouch for a transcript it never constrained.
  if (binding.model !== null && offered.model !== null && binding.model !== offered.model) {
    fail(
      `client init reports model ${JSON.stringify(offered.model)} but the transcript ` +
        `records ${JSON.stringify(binding.model)}`,
    );
  }

  return {
    schema_version: 1,
    provider: "claude_code",
    session_id: sessionId,
    cwd: resolve(cwd),
    transcript: {
      path,
      sha256: createHash("sha256").update(transcriptBytes).digest("hex"),
      bytes: transcriptBytes.byteLength,
      records: rows.length,
    },
    client: {
      version: offered.client_version ?? binding.client_version,
      model: binding.model ?? offered.model,
      permission_mode: offered.permission_mode,
    },
    offered_tools: offered.offered_tools,
    mcp_servers: offered.mcp_servers,
    called_tools: toolCalls.map((call) => ({ name: call.name, id: call.id })),
    tool_call_counts: toolCallCounts,
  };
}

/** A finite number or null — the telemetry fields are forwarded, never invented. */
function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The model's complete closing reply: every assistant text message after its
 * last tool interaction, in stream order.
 *
 * Claude Code's own `result` field carries only the LAST assistant message, and
 * a model may legitimately split its final report across messages — observed
 * live with claude-sonnet-5 (68 clean turns): it wrote the prose sections, made
 * the prompt's one permitted evidence-retry check, then emitted the closing
 * JSON block alone, so `result` lost every earlier section and the report
 * verifier rejected an otherwise-good run. The recovered prefix stays anchored
 * to the event this envelope already authenticates: the final text of the
 * closing reply must equal `result.result`, or the recovery is discarded and
 * the client's own text stands alone.
 */
function closingReplyText(streamRows, resultText) {
  // Flatten the stream into text items and tool breaks (one break per
  // contiguous run of tool_use/tool_result rows — a call and its result are one
  // interaction, not two).
  const items = [];
  for (const row of streamRows) {
    if (row?.type === "result") continue;
    const content = row?.message?.content;
    if (!Array.isArray(content)) continue;
    const touchesTools =
      row.type !== "assistant" ||
      content.some((block) => block?.type === "tool_use" || block?.type === "tool_result");
    if (touchesTools) {
      if (items.at(-1)?.kind !== "tool") items.push({ kind: "tool" });
      continue;
    }
    const text = content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n\n");
    if (text.trim().length > 0) items.push({ kind: "text", text });
  }
  // Walk back from the end: the closing reply is the trailing text messages,
  // tolerating AT MOST ONE tool interaction inside it — the prompt's single
  // permitted evidence-retry. A second interaction ends the reply.
  const texts = [];
  let toolGaps = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "tool") {
      toolGaps += 1;
      if (toolGaps > 1) break;
      continue;
    }
    texts.unshift(item.text);
  }
  if (texts.length < 2) return resultText;
  if (texts[texts.length - 1].trim() !== resultText.trim()) return resultText;
  return texts.join("\n\n");
}

/**
 * The one artifact the generic tail of run.sh reads per run: the client's own final
 * `result` event, audited and stapled to the capture receipt.
 *
 * The codex lane builds its `<out>.json` in `codex-pure-envelope.mjs` from three
 * artifacts; this vendor needs far less because the receipt already carries the audited
 * tool boundary, so the envelope's only new job is the RESULT: exactly one successful
 * result event, bound to the same pinned session as everything else, answered by the
 * model the run was requested for. Everything the runner's telemetry reads
 * (`is_error`, `duration_ms`, `num_turns`, `total_cost_usd`, `usage`) is forwarded
 * from that event verbatim — the client's report of its own run, never a synthesis.
 *
 * Like the receipt, it emits FACTS and no isolation verdict — see the module header.
 */
export function buildClaudeEnvelope({ receipt, streamRows, model, cliVersion, transportContract }) {
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    receipt.provider !== "claude_code" ||
    typeof receipt.session_id !== "string"
  ) {
    fail("envelope requires a claude_code capture receipt with a session id");
  }
  if (typeof model !== "string" || model.length === 0) {
    fail("envelope requires the requested model id");
  }
  if (typeof transportContract !== "string" || transportContract.length === 0) {
    fail("envelope requires the transport contract id");
  }

  const results = streamRows.filter((row) => row.type === "result");
  if (results.length !== 1) {
    fail(
      `client stream carries ${results.length} result events, so it is not one ` +
        `completed session`,
    );
  }
  const [result] = results;
  if (result.subtype !== "success" || result.is_error !== false) {
    fail(
      `client run did not end in one successful result (subtype ` +
        `${JSON.stringify(result.subtype)}, is_error ${JSON.stringify(result.is_error)})`,
    );
  }
  if (typeof result.result !== "string" || result.result.length === 0) {
    fail("client result carries no report text");
  }
  if (result.session_id !== receipt.session_id) {
    fail(
      `client result belongs to session ${JSON.stringify(result.session_id)}, not the ` +
        `runner's ${JSON.stringify(receipt.session_id)}`,
    );
  }

  // The catalog refuses aliases so a sealed run means what its record says; this is
  // where that promise meets what the transcript actually recorded. Absence is
  // tolerated on the recorded side only — a client that wrote no model is not evidence
  // of a substitution — but a recorded model that differs from the requested one is.
  const recordedModel = receipt.client?.model ?? null;
  if (recordedModel !== null && recordedModel !== model) {
    fail(
      `session was answered by model ${JSON.stringify(recordedModel)}, not the ` +
        `requested ${JSON.stringify(model)}`,
    );
  }
  const recordedVersion = receipt.client?.version ?? null;
  if (
    cliVersion !== undefined &&
    cliVersion !== null &&
    recordedVersion !== null &&
    recordedVersion !== cliVersion
  ) {
    fail(
      `session was written by client ${JSON.stringify(recordedVersion)}, not the ` +
        `preflighted ${JSON.stringify(cliVersion)}`,
    );
  }

  return {
    schema_version: 1,
    provider: "claude_code",
    transport_contract: transportContract,
    model,
    session_id: receipt.session_id,
    is_error: false,
    duration_ms: finiteOrNull(result.duration_ms),
    num_turns: finiteOrNull(result.num_turns),
    total_cost_usd: finiteOrNull(result.total_cost_usd),
    usage:
      result.usage !== null && typeof result.usage === "object" && !Array.isArray(result.usage)
        ? result.usage
        : null,
    result: closingReplyText(streamRows, result.result),
    capture: receipt,
  };
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === "resolve-log") {
    const home = option(argv, "--home");
    const cwd = option(argv, "--cwd");
    const sessionId = option(argv, "--session-id");
    if (!home || !cwd || !sessionId) {
      fail("resolve-log requires --home, --cwd and --session-id");
    }
    process.stdout.write(`${claudeSessionLogPath({ home, cwd, sessionId })}\n`);
    return;
  }
  if (command === "capture") {
    const home = option(argv, "--home");
    const cwd = option(argv, "--cwd");
    const sessionId = option(argv, "--session-id");
    const streamPath = option(argv, "--stream");
    const transcriptOut = option(argv, "--transcript-out");
    if (!home || !cwd || !sessionId || !streamPath) {
      fail("capture requires --home, --cwd, --session-id and --stream");
    }
    const receipt = captureClaudeSession({ home, cwd, sessionId, streamPath, transcriptOut });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return;
  }
  if (command === "envelope") {
    const receiptPath = option(argv, "--receipt");
    const streamPath = option(argv, "--stream");
    const model = option(argv, "--model");
    const cliVersion = option(argv, "--cli-version");
    const transportContract = option(argv, "--transport-contract");
    if (!receiptPath || !streamPath || !model || !transportContract) {
      fail("envelope requires --receipt, --stream, --model and --transport-contract");
    }
    const receiptText = readStableClaudeFile(receiptPath, "Claude Code capture receipt", {
      maxBytes: CLAUDE_STREAM_MAX_BYTES,
    }).toString("utf8");
    const parsedReceipt = parseJsonRejectingDuplicateKeys(
      receiptText,
      "Claude Code capture receipt",
    );
    if (!parsedReceipt.ok) fail(parsedReceipt.reason);
    const streamRows = parseClaudeJsonl(
      readStableClaudeFile(streamPath, "Claude Code client stream", {
        maxBytes: CLAUDE_STREAM_MAX_BYTES,
      }).toString("utf8"),
      "Claude Code client stream",
    );
    const envelope = buildClaudeEnvelope({
      receipt: parsedReceipt.value,
      streamRows,
      model,
      cliVersion,
      transportContract,
    });
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return;
  }
  fail(
    "Usage: claude-session.mjs resolve-log|capture|envelope --home <dir> --cwd <dir> " +
      "--session-id <uuid> [--stream <path>] [--transcript-out <path>] " +
      "[--receipt <path>] [--model <id>] [--cli-version <v>] [--transport-contract <id>]",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
