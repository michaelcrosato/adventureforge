import { describe, it, expect } from "vitest";
import { instructsRetiredGateAsLive } from "../regression/support/gate_coherence.js";

describe("instructsRetiredGateAsLive", () => {
  it("returns empty array for coherent text (no retired gate instruction)", () => {
    const coherentText =
      "We have full authority. There is no §14 ceremony. No human-approval gate.";
    expect(instructsRetiredGateAsLive(coherentText)).toEqual([]);
  });

  it("returns empty array for technical spec references", () => {
    const specText = "See the (§14 testing strategy) or the §14 gate specifications.";
    expect(instructsRetiredGateAsLive(specText)).toEqual([]);
  });

  it("matches 'gated (§14)' variations", () => {
    expect(instructsRetiredGateAsLive("This is gated (§14)")).toEqual(["gated (§14)"]);
    expect(instructsRetiredGateAsLive("This is gated** (§14)")).toEqual(["gated** (§14)"]);
    expect(instructsRetiredGateAsLive("This is GATED(§14)")).toEqual(["GATED(§14)"]);
  });

  it("matches 'propose only; a human reviews' variations", () => {
    expect(instructsRetiredGateAsLive("propose only; a human reviews")).toEqual([
      "propose only; a human reviews",
    ]);
    expect(instructsRetiredGateAsLive("propose only a human   reviews")).toEqual([
      "propose only a human   reviews",
    ]);
  });

  it("matches 'do not silently change engine rules' variations", () => {
    expect(instructsRetiredGateAsLive("Do NOT silently change engine rules")).toEqual([
      "Do NOT silently change engine rules",
    ]);
  });

  it("matches 'proposals only (gated, §14)' variations", () => {
    expect(instructsRetiredGateAsLive("These are proposals only (gated, §14)")).toEqual([
      "proposals only (gated, §14)",
    ]);
    expect(instructsRetiredGateAsLive("This is a proposal only (gated §14)")).toEqual([
      "proposal only (gated §14)",
    ]);
  });

  it("matches 'code edits stay with the human supervisor' variations", () => {
    expect(instructsRetiredGateAsLive("Code edits stay with the human supervisor")).toEqual([
      "Code edits stay with the human supervisor",
    ]);
  });

  it("matches multiple signatures in the same text", () => {
    const text = "Propose only; a human reviews. Also, do not silently change engine rules.";
    expect(instructsRetiredGateAsLive(text)).toEqual([
      "Propose only; a human reviews",
      "do not silently change engine rules",
    ]);
  });
});
