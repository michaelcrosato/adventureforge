/**
 * The engine MCP server is registered twice, by hand: `.mcp.json` for clients that read
 * the standard project config (Claude Code among them) and `.codex/config.toml` for Codex.
 * The TOML's own header says "Keep in sync with .mcp.json", and AGENTS.md promises both
 * start the same `npm --silent run mcp`. Nothing checked it, so an edit to one file — a
 * renamed server, a changed script — would leave one vendor's agents silently without
 * engine tools while the other kept working. This pins the two registrations together.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

type Registration = { command: unknown; args: unknown; cwd?: unknown };

function mcpJsonServers(): Map<string, Registration> {
  const parsed = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8")) as {
    mcpServers: Record<string, Registration & { env?: Record<string, string> }>;
  };
  return new Map(Object.entries(parsed.mcpServers));
}

/**
 * Just enough TOML for `[mcp_servers.<name>]` tables whose values are JSON-compatible
 * literals (strings, string arrays, numbers, booleans) — which is all this file holds.
 * A value that is not JSON-compatible fails loudly instead of being guessed at.
 */
function codexServers(): Map<string, Record<string, unknown>> {
  const text = readFileSync(join(ROOT, ".codex", "config.toml"), "utf8");
  const servers = new Map<string, Record<string, unknown>>();
  let current: Record<string, unknown> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      const name = /^mcp_servers\.([A-Za-z0-9_-]+)$/.exec(table[1]!)?.[1];
      current = name === undefined ? null : {};
      if (name !== undefined) servers.set(name, current!);
      continue;
    }
    if (current === null) continue;
    const pair = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) throw new Error(`Unparseable .codex/config.toml line: ${raw}`);
    current[pair[1]!] = JSON.parse(pair[2]!);
  }
  return servers;
}

describe("project MCP registrations", () => {
  it("register the same servers with the same command and args", () => {
    const json = mcpJsonServers();
    const toml = codexServers();
    expect([...toml.keys()].sort()).toEqual([...json.keys()].sort());
    expect(json.size).toBeGreaterThan(0);
    for (const [name, registration] of json) {
      const codex = toml.get(name)!;
      expect(codex.command, name).toEqual(registration.command);
      expect(codex.args, name).toEqual(registration.args);
      // .mcp.json servers start in the project root; Codex must say so explicitly.
      expect(codex.cwd ?? ".", name).toBe(".");
    }
  });

  it("start the engine server through the package's own mcp script", () => {
    const adventureforge = mcpJsonServers().get("adventureforge");
    expect(adventureforge).toMatchObject({ command: "npm", args: ["--silent", "run", "mcp"] });
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts.mcp).toBeDefined();
  });
});
