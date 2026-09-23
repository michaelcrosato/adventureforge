/**
 * bug_0645 — completion journals must name every promise the return broke.
 *
 * The "Promise broken: …" sentence is read from the same character-selected export
 * effects as the "Promise kept: …" receipt. Its wording table is hand-authored, so
 * this proves the table covers every `broken` resolution the shipped world can emit
 * (a new one without wording would otherwise throw at quest completion).
 */
import { describe, expect, it } from "vitest";
import type { OverworldQuestCampaignExport } from "../../src/world/overworld.js";
import {
  BROKEN_PROMISE_TERMS,
  deriveBrokenPromiseFoldbackReceipt,
} from "../../src/world/registration_promise_receipt.js";
import { createInitialCampaignCharacterState } from "../../src/world/campaign_character_state.js";
import { loadOverworldManifest } from "../../src/world/source.js";

const WORLD = loadOverworldManifest(process.cwd());

function brokenResolutions(node: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(node)) {
    for (const child of node) brokenResolutions(child, into);
  } else if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (record.type === "resolve_promise" && record.status === "broken") {
      into.add(String(record.promise_id));
    }
    for (const child of Object.values(record)) brokenResolutions(child, into);
  }
  return into;
}

describe("bug_0645 — broken-promise completion wording", () => {
  it("covers exactly the promises a shipped quest export can resolve as broken", () => {
    const authored = brokenResolutions(
      WORLD.quests.map((quest) => quest.campaign_exports ?? []),
      new Set(),
    );
    expect(authored.size).toBeGreaterThan(0);
    expect([...BROKEN_PROMISE_TERMS.keys()].sort()).toEqual([...authored].sort());
  });

  it("names each broken promise in order and stays silent when nothing broke", () => {
    const character = createInitialCampaignCharacterState();
    const exportWith = (
      effects: OverworldQuestCampaignExport["effects"],
    ): OverworldQuestCampaignExport =>
      ({
        ending_id: "ending_test",
        ending_title: "Test Ending",
        effects,
      }) as OverworldQuestCampaignExport;

    expect(
      deriveBrokenPromiseFoldbackReceipt(
        exportWith([
          {
            type: "resolve_promise",
            promise_id: "albany:promise_wolf_full_compact_duty",
            status: "kept",
          },
        ]),
        character,
      ),
    ).toBeUndefined();
    expect(
      deriveBrokenPromiseFoldbackReceipt(
        exportWith([
          {
            type: "resolve_promise",
            promise_id: "albany:promise_wolf_unaffiliated_bond",
            status: "broken",
          },
          {
            type: "resolve_promise",
            promise_id: "albany:promise_june_cattle_first",
            status: "broken",
          },
        ]),
        character,
      ),
    ).toBe(
      "Promise broken: claim no Albany authority. Promise broken: keep June's cattle-first terms.",
    );
    expect(() =>
      deriveBrokenPromiseFoldbackReceipt(
        exportWith([{ type: "resolve_promise", promise_id: "unknown:promise", status: "broken" }]),
        character,
      ),
    ).toThrow(/no completion-journal wording/);
  });
});
