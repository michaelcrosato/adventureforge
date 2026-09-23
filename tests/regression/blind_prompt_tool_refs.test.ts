/**
 * The blind-playtest prompts (blind-tester/prompt*.md) name the AdventureForge MCP
 * tools that blind agents may call directly or expose through one ToolSearch
 * fallback. If a tool is renamed or removed, a prompt that still names it silently
 * sends the blind agent after a tool that no longer exists. This guard keeps every
 * prompt's tool references honest against the server's actual registration.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — plain .mjs module without type declarations
import { fillPrompt } from "../../blind-tester/fill-prompt.mjs";
import { TOOL_REGISTRATIONS } from "../../src/mcp/server.js";

const PROMPT_DIR = join(process.cwd(), "blind-tester");
const registered = new Set(TOOL_REGISTRATIONS.map((t) => t.name));
const promptFiles = readdirSync(PROMPT_DIR)
  .filter((f) => f.startsWith("prompt") && f.endsWith(".md"))
  .sort();
const transportByPrompt = new Map([
  ["prompt-overworld-spark.md", join(PROMPT_DIR, "prompt-transports", "spark-direct-mcp-v1.md")],
]);

function effectivePrompt(file: string): string {
  const template = readFileSync(join(PROMPT_DIR, file), "utf8");
  const transportPath = transportByPrompt.get(file);
  if (!transportPath) return template;
  return fillPrompt(template, {
    startInstruction: "",
    seed: 0,
    persona: "",
    transport: readFileSync(transportPath, "utf8"),
  });
}

describe("blind prompts reference only registered adventureforge tools", () => {
  it("finds the blind prompt files", () => {
    // At least the quest-mode and overworld core-game prompts.
    expect(promptFiles).toEqual(
      expect.arrayContaining(["prompt-overworld-spark.md", "prompt-overworld.md", "prompt.md"]),
    );
  });

  it.each(promptFiles)("%s names only real mcp__adventureforge__* tools", (file) => {
    const text = effectivePrompt(file);
    const refs = [...text.matchAll(/mcp__adventureforge__([a-z_]+)/g)].map((m) => m[1]!);
    expect(refs.length, `${file} references no adventureforge tools`).toBeGreaterThan(0);
    const unknown = [...new Set(refs)].filter((name) => !registered.has(name)).sort();
    expect(unknown, `${file} references unregistered tool(s)`).toEqual([]);
  });

  it.each(promptFiles)("%s uses only real Grok adventureforge__* bridge names", (file) => {
    const text = effectivePrompt(file);
    const refs = [...text.matchAll(/(?<!mcp__)adventureforge__([a-z_]+)/g)].map(
      (match) => match[1]!,
    );
    const unknown = [...new Set(refs)].filter((name) => !registered.has(name)).sort();
    expect(unknown, `${file} references unregistered Grok bridge tool(s)`).toEqual([]);
  });

  it("keeps the Terra game-direct transport on registered gameplay tools", () => {
    const template = readFileSync(join(PROMPT_DIR, "prompt-overworld.md"), "utf8");
    const transport = readFileSync(
      join(PROMPT_DIR, "prompt-transports", "game-direct-mcp-v1.md"),
      "utf8",
    );
    const text = fillPrompt(template, {
      startInstruction: "",
      seed: 0,
      persona: "",
      transport,
    });
    const refs = [...text.matchAll(/mcp__adventureforge__([a-z_]+)/g)].map((match) => match[1]!);
    expect([...new Set(refs)].filter((name) => !registered.has(name))).toEqual([]);
  });
});
