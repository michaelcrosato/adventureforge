/**
 * AI_LOOP_STATE.md rotation (token efficiency, this session).
 *
 * Every cycle agent reads the loop log; unbounded it reached ~1.7 MB / ~420k tokens.
 * rotateLoopState() trims the live log to the most recent ROTATE_KEEP entries of EITHER
 * shape — legacy "### Cycle result" (prepended, newest-first) and the "## AFK Cycle"
 * scaffold the driver appends (oldest-first, all newer than any legacy entry) — and to
 * ROTATE_MAX_ENTRY_BYTES of entry text, moving the oldest to the gitignored archive
 * while the TOTAL cycle count (live + archive) stays exact, so the generator seed window
 * (assessor.generatedEvalSeedBase) never resets. Before bug_0631 it keyed on the legacy
 * shape alone, so a ledger holding exactly ROTATE_KEEP legacy entries never rotated again.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFeedbackCycleSelection } from "../../src/feedback/acceptance.js";
import {
  rotateLoopState,
  totalCycleCount,
  countCycleEntries,
  countLiveEntries,
  countScaffoldEntries,
  historicalCycleCount,
  completedCycleCount,
  liveEntryBytes,
  ROTATE_KEEP,
  ROTATE_MAX_ENTRY_BYTES,
  LOOP_STATE_FILE,
  LOOP_ARCHIVE_FILE,
} from "../../src/afk/loop_state.js";

const RUN_ID = "2026-01-02T03-04-05-006Z";
const SELECTION_MARKER = `<!-- feedback_cycle_selection: {"run_id":"${RUN_ID}","selected_recommendation_id":null} -->`;
const SELECTION_NEAR_MISS = "- feedback_cycle_selection is described here, not asserted.";

/**
 * A newest-first log of `n` legacy entries (entry n-1 at the top) followed by ONE
 * "## AFK Cycle" scaffold — n + 1 live entries, the scaffold the newest of them.
 */
function makeLog(n: number): string {
  const entries: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    entries.push(
      `### Cycle result — cycle ${i} did a thing (bug_${1000 + i})\n\n- detail for ${i}.\n`,
    );
  }
  return `# AI Loop State\n\n${entries.join("\n")}\n## AFK Cycle old-driver-entry\n- terse.\n`;
}

function makeLogWithCycleScaffold(n: number, selectionLines: readonly string[]): string {
  return makeLog(n).replace(
    "## AFK Cycle old-driver-entry\n- terse.\n",
    `## AFK Cycle ${RUN_ID}\n${selectionLines.join("\n")}\n${SELECTION_NEAR_MISS}\n- pending.\n`,
  );
}

/**
 * Selection lines left in the OLDEST entry (legacy cycle 0, the bottom of the legacy
 * section) — the entry rotation archives first. The in-progress scaffold never carries
 * them to the archive (it is the newest entry), so this is the shape the relocation
 * guard still has to handle: stale or malformed lines in an entry that IS archived.
 */
function makeLogWithArchivedSelection(n: number, selectionLines: readonly string[]): string {
  return makeLog(n).replace(
    "### Cycle result — cycle 0 did a thing (bug_1000)\n\n- detail for 0.\n",
    `### Cycle result — cycle 0 did a thing (bug_1000)\n\n${selectionLines.join("\n")}\n${SELECTION_NEAR_MISS}\n- detail for 0.\n`,
  );
}

/** A post-migration log: `n` "## AFK Cycle" entries, appended oldest-first. */
function makeScaffoldLog(n: number, body = "- done."): string {
  const entries = Array.from(
    { length: n },
    (_, i) =>
      `## AFK Cycle 2026-09-${String(i).padStart(2, "0")}T00-00-00-000Z\n${body} scaffold ${i}\n`,
  );
  return `# AI Loop State\n\n<!-- historical_cycle_count: 100 -->\n\nIntro.\n\n${entries.join("")}`;
}

/** Replace makeLog's single scaffold tail with `scaffolds`. */
function withScaffolds(log: string, scaffolds: string): string {
  return log.replace("## AFK Cycle old-driver-entry\n- terse.\n", scaffolds);
}

describe("AI_LOOP_STATE rotation (token efficiency)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "loopstate-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is a no-op at/below the keep window and leaves no archive", () => {
    // ROTATE_KEEP - 1 legacy entries plus the "## AFK Cycle" scaffold: exactly ROTATE_KEEP.
    writeFileSync(join(root, LOOP_STATE_FILE), makeLog(ROTATE_KEEP - 1));
    expect(rotateLoopState(root)).toBe(0);
    expect(existsSync(join(root, LOOP_ARCHIVE_FILE))).toBe(false);
    expect(totalCycleCount(root)).toBe(ROTATE_KEEP);
  });

  it("counts the '## AFK Cycle' scaffold toward the window and archives the OLDEST entry (bug_0631)", () => {
    // Pre-fix this returned 0: rotation keyed on "### Cycle result" alone, so ROTATE_KEEP
    // legacy entries plus any number of driver-written scaffolds never rotated.
    writeFileSync(join(root, LOOP_STATE_FILE), makeLog(ROTATE_KEEP));
    const before = readFileSync(join(root, LOOP_STATE_FILE), "utf8");
    expect(countCycleEntries(before)).toBe(ROTATE_KEEP);
    expect(countScaffoldEntries(before)).toBe(1);
    expect(countLiveEntries(before)).toBe(ROTATE_KEEP + 1);

    expect(rotateLoopState(root)).toBe(1);
    const live = readFileSync(join(root, LOOP_STATE_FILE), "utf8");
    expect(countLiveEntries(live)).toBe(ROTATE_KEEP);
    // The oldest legacy entry goes; the scaffold — the newest cycle — stays, last.
    expect(live).not.toContain("cycle 0 did a thing");
    expect(live).toContain(`cycle ${ROTATE_KEEP - 1} did a thing`);
    expect(live.trimEnd().endsWith("## AFK Cycle old-driver-entry\n- terse.")).toBe(true);
    expect(readFileSync(join(root, LOOP_ARCHIVE_FILE), "utf8")).toContain("cycle 0 did a thing");
    expect(totalCycleCount(root)).toBe(ROTATE_KEEP + 1);
  });

  it("rotates the live ledger's real shape: ROTATE_KEEP legacy entries plus a scaffold tail (bug_0631)", () => {
    const scaffolds = Array.from(
      { length: 4 },
      (_, i) => `## AFK Cycle 2026-09-06T0${i}-00-00-000Z\n- Assess: cycle ${i}.\n`,
    ).join("");
    writeFileSync(join(root, LOOP_STATE_FILE), withScaffolds(makeLog(ROTATE_KEEP), scaffolds));
    const before = completedCycleCount(readFileSync(join(root, LOOP_STATE_FILE), "utf8"));

    expect(rotateLoopState(root)).toBe(4);
    const live = readFileSync(join(root, LOOP_STATE_FILE), "utf8");
    expect(countCycleEntries(live)).toBe(ROTATE_KEEP - 4);
    expect(countScaffoldEntries(live)).toBe(4);
    for (const gone of [0, 1, 2, 3]) expect(live).not.toContain(`cycle ${gone} did a thing`);
    expect(live).toContain("cycle 4 did a thing");
    expect(completedCycleCount(live)).toBe(before);
    expect(rotateLoopState(root)).toBe(0);
  });

  it("archives the top of an all-scaffold log first, keeping the newest at the bottom", () => {
    writeFileSync(join(root, LOOP_STATE_FILE), makeScaffoldLog(ROTATE_KEEP + 5));
    expect(rotateLoopState(root)).toBe(5);
    const live = readFileSync(join(root, LOOP_STATE_FILE), "utf8");
    expect(countScaffoldEntries(live)).toBe(ROTATE_KEEP);
    expect(historicalCycleCount(live)).toBe(105);
    for (let i = 0; i < 5; i++) expect(live).not.toContain(`scaffold ${i}\n`);
    expect(live).toContain("scaffold 5\n");
    expect(live).toContain("Intro.");
    expect(live.trimEnd().endsWith(`scaffold ${ROTATE_KEEP + 4}`)).toBe(true);
    const archive = readFileSync(join(root, LOOP_ARCHIVE_FILE), "utf8");
    expect(countScaffoldEntries(archive)).toBe(5);
    expect(totalCycleCount(root)).toBe(100 + ROTATE_KEEP + 5);
  });

  it("archives every legacy entry before any scaffold when both overflow", () => {
    // 3 legacy (older) + ROTATE_KEEP + 1 scaffolds: all 3 legacy go, then the top scaffold.
    const scaffolds = Array.from(
      { length: ROTATE_KEEP + 1 },
      (_, i) => `## AFK Cycle s${String(i).padStart(2, "0")}\n- scaffold body ${i}.\n`,
    ).join("");
    writeFileSync(join(root, LOOP_STATE_FILE), withScaffolds(makeLog(3), scaffolds));
    expect(rotateLoopState(root)).toBe(4);
    const live = readFileSync(join(root, LOOP_STATE_FILE), "utf8");
    expect(countCycleEntries(live)).toBe(0);
    expect(countScaffoldEntries(live)).toBe(ROTATE_KEEP);
    expect(live).not.toContain("## AFK Cycle s00\n");
    expect(live).toContain("## AFK Cycle s01\n");
    expect(historicalCycleCount(live)).toBe(4);
  });

  it("also trims to the entry-byte ceiling, oldest first, never the newest entry (c1101bfc)", () => {
    const fat = `- ${"x".repeat(4000)}.`;
    writeFileSync(join(root, LOOP_STATE_FILE), makeScaffoldLog(ROTATE_KEEP, fat));
    const before = readFileSync(join(root, LOOP_STATE_FILE), "utf8");
    expect(countLiveEntries(before)).toBe(ROTATE_KEEP); // within the COUNT window
    expect(liveEntryBytes(before)).toBeGreaterThan(ROTATE_MAX_ENTRY_BYTES);

    const moved = rotateLoopState(root);
    const live = readFileSync(join(root, LOOP_STATE_FILE), "utf8");
    // 4 KB entries under a 30 KiB ceiling: exactly 7 stay.
    expect(moved).toBe(ROTATE_KEEP - 7);
    expect(liveEntryBytes(live)).toBeLessThanOrEqual(ROTATE_MAX_ENTRY_BYTES);
    expect(live.trimEnd().endsWith(`scaffold ${ROTATE_KEEP - 1}`)).toBe(true);
    expect(live).not.toContain("scaffold 0\n");
    expect(completedCycleCount(live)).toBe(completedCycleCount(before));
    expect(rotateLoopState(root)).toBe(0);

    // A single oversized newest entry is kept — only the guard can say it is too long.
    writeFileSync(join(root, LOOP_STATE_FILE), makeScaffoldLog(2, `- ${"y".repeat(40_000)}`));
    expect(rotateLoopState(root)).toBe(1);
    const lone = readFileSync(join(root, LOOP_STATE_FILE), "utf8");
    expect(countScaffoldEntries(lone)).toBe(1);
    expect(lone).toContain("scaffold 1\n");
  });

  it("trims to the keep window, archives the rest, and preserves the total count", () => {
    const N = ROTATE_KEEP + 40;
    writeFileSync(join(root, LOOP_STATE_FILE), makeLog(N));
    // N legacy entries plus the scaffold; the scaffold is the newest and stays.
    expect(rotateLoopState(root)).toBe(N + 1 - ROTATE_KEEP);

    const live = readFileSync(join(root, LOOP_STATE_FILE), "utf8");
    expect(countCycleEntries(live)).toBe(ROTATE_KEEP - 1);
    expect(countScaffoldEntries(live)).toBe(1);
    expect(historicalCycleCount(live)).toBe(N + 1 - ROTATE_KEEP);
    expect(live.startsWith("# AI Loop State")).toBe(true); // the intro survives
    expect(live).toContain(`cycle ${N - 1} did a thing`); // newest kept
    expect(live).not.toContain("cycle 0 did a thing"); // oldest archived

    expect(countCycleEntries(readFileSync(join(root, LOOP_ARCHIVE_FILE), "utf8"))).toBe(
      N + 1 - ROTATE_KEEP,
    );
    // Monotonic count exactly preserved across the split. (Before bug_0631 this read N:
    // the old single cut archived the scaffold tail without counting it into the marker.)
    expect(totalCycleCount(root)).toBe(N + 1);
  });

  it("uses the compact historical marker on a fresh clone without a local archive", () => {
    writeFileSync(
      join(root, LOOP_STATE_FILE),
      "# AI Loop State\n\n<!-- historical_cycle_count: 40 -->\n\n### Cycle result — recent\n",
    );
    expect(totalCycleCount(root)).toBe(41);
  });

  it("is idempotent — a second rotation moves nothing more", () => {
    writeFileSync(join(root, LOOP_STATE_FILE), makeLog(ROTATE_KEEP + 10));
    expect(rotateLoopState(root)).toBe(11);
    expect(rotateLoopState(root)).toBe(0);
    expect(totalCycleCount(root)).toBe(ROTATE_KEEP + 11);
  });

  it("preserves the machine-owned feedback acceptance marker in the live intro", () => {
    const marker =
      '<!-- feedback_acceptance: {"accepted_compile":null,"pending_cycle_reports":[],"schema_version":1} -->';
    const text = makeLog(ROTATE_KEEP + 2).replace(
      "# AI Loop State\n\n",
      `# AI Loop State\n\n${marker}\n\n`,
    );
    writeFileSync(join(root, LOOP_STATE_FILE), text);

    expect(rotateLoopState(root)).toBe(3);
    expect(readFileSync(join(root, LOOP_STATE_FILE), "utf8")).toContain(marker);
    expect(readFileSync(join(root, LOOP_ARCHIVE_FILE), "utf8")).not.toContain(marker);
  });

  it("keeps the in-progress scaffold and its frozen selection live, in place (bug_0631)", () => {
    writeFileSync(
      join(root, LOOP_STATE_FILE),
      makeLogWithCycleScaffold(ROTATE_KEEP + 1, [SELECTION_MARKER]),
    );
    const before = readFileSync(join(root, LOOP_STATE_FILE), "utf8");
    const scaffoldBefore = before.slice(before.indexOf(`## AFK Cycle ${RUN_ID}`));

    // ROTATE_KEEP + 1 legacy entries plus the scaffold: the two OLDEST legacy entries go.
    expect(rotateLoopState(root)).toBe(2);
    const live = readFileSync(join(root, LOOP_STATE_FILE), "utf8");
    expect(live.slice(live.indexOf(`## AFK Cycle ${RUN_ID}`))).toBe(scaffoldBefore);
    expect(live).toContain(SELECTION_NEAR_MISS);
    expect(readFileSync(join(root, LOOP_ARCHIVE_FILE), "utf8")).not.toContain(
      "feedback_cycle_selection:",
    );
    expect(parseFeedbackCycleSelection(live, RUN_ID)).toEqual({
      ok: true,
      selection: { run_id: RUN_ID, selected_recommendation_id: null },
    });
  });

  it("relocates selection lines out of an ARCHIVED entry into the live preamble", () => {
    writeFileSync(
      join(root, LOOP_STATE_FILE),
      makeLogWithArchivedSelection(ROTATE_KEEP, [SELECTION_MARKER]),
    );

    expect(rotateLoopState(root)).toBe(1);
    const live = readFileSync(join(root, LOOP_STATE_FILE), "utf8");
    const archive = readFileSync(join(root, LOOP_ARCHIVE_FILE), "utf8");
    expect(countLiveEntries(live)).toBe(ROTATE_KEEP);
    expect(historicalCycleCount(live)).toBe(1);
    expect(
      live.split(/\r?\n/u).filter((line) => line.includes("feedback_cycle_selection:")),
    ).toEqual([SELECTION_MARKER]);
    expect(live.indexOf(SELECTION_MARKER)).toBeLessThan(live.indexOf("### Cycle result"));
    expect(live).not.toContain(SELECTION_NEAR_MISS);
    expect(archive).toContain(SELECTION_NEAR_MISS);
    expect(archive).not.toContain("feedback_cycle_selection:");
    expect(parseFeedbackCycleSelection(live, RUN_ID)).toEqual({
      ok: true,
      selection: { run_id: RUN_ID, selected_recommendation_id: null },
    });
    expect(totalCycleCount(root)).toBe(ROTATE_KEEP + 1);

    expect(rotateLoopState(root)).toBe(0);
    expect(readFileSync(join(root, LOOP_STATE_FILE), "utf8")).toBe(live);
    expect(readFileSync(join(root, LOOP_ARCHIVE_FILE), "utf8")).toBe(archive);
  });

  it.each([
    ["malformed", ['<!-- feedback_cycle_selection: {"run_id": -->']],
    ["duplicate", [SELECTION_MARKER, SELECTION_MARKER]],
  ])("keeps %s selection lines live for the seal to reject", (_kind, selectionLines) => {
    writeFileSync(
      join(root, LOOP_STATE_FILE),
      makeLogWithArchivedSelection(ROTATE_KEEP, selectionLines),
    );

    expect(rotateLoopState(root)).toBe(1);
    const live = readFileSync(join(root, LOOP_STATE_FILE), "utf8");
    expect(
      live.split(/\r?\n/u).filter((line) => line.includes("feedback_cycle_selection:")),
    ).toEqual(selectionLines);
    expect(parseFeedbackCycleSelection(live, RUN_ID).ok).toBe(false);
    expect(readFileSync(join(root, LOOP_ARCHIVE_FILE), "utf8")).not.toContain(
      "feedback_cycle_selection:",
    );
  });

  it.each([
    ["selection-like prose", "- feedback_cycle_selection: prose is not a marker"],
    ["an indented marker", `  ${SELECTION_MARKER}`],
    [
      "a Unicode line separator",
      "- feedback_cycle_selection: prose\u2028continuation must stay on this LF-delimited line",
    ],
    [
      "a lone carriage return",
      "- feedback_cycle_selection: prose\rcontinuation must stay on this LF-delimited line",
    ],
  ])("does not launder %s beside a canonical selection", (_kind, malformedLine) => {
    const selectionLines = [SELECTION_MARKER, malformedLine];
    writeFileSync(
      join(root, LOOP_STATE_FILE),
      makeLogWithArchivedSelection(ROTATE_KEEP, selectionLines),
    );

    expect(rotateLoopState(root)).toBe(1);
    const live = readFileSync(join(root, LOOP_STATE_FILE), "utf8");
    expect(
      live.split(/\r?\n/u).filter((line) => line.includes("feedback_cycle_selection:")),
    ).toEqual(selectionLines);
    expect(parseFeedbackCycleSelection(live, RUN_ID).ok).toBe(false);
    const archive = readFileSync(join(root, LOOP_ARCHIVE_FILE), "utf8");
    expect(archive).not.toContain("feedback_cycle_selection:");
    expect(archive).not.toContain("continuation must stay on this LF-delimited line");
  });
});

describe("completedCycleCount", () => {
  it("counts both historical marker and rich entries", () => {
    const text = `# AI Loop State\n\n<!-- historical_cycle_count: 42 -->\n\n### Cycle result 1\n\n### Cycle result 2\n`;
    expect(completedCycleCount(text)).toBe(44);
  });

  it("works with no historical marker", () => {
    const text = `# AI Loop State\n\n### Cycle result 1\n\n### Cycle result 2\n`;
    expect(completedCycleCount(text)).toBe(2);
  });

  it("works with no rich entries", () => {
    const text = `# AI Loop State\n\n<!-- historical_cycle_count: 42 -->\n`;
    expect(completedCycleCount(text)).toBe(42);
  });

  it("counts '## AFK Cycle' scaffolds completed in place alongside rich entries (bug_0619)", () => {
    const text = `# AI Loop State\n\n### Cycle result 1\n\n## AFK Cycle 2026-01-02T03-04-05-006Z\n- Assess: done.\n`;
    expect(completedCycleCount(text)).toBe(2);
  });

  it("adds the historical marker to a mix of rich entries and scaffolds", () => {
    const text = `# AI Loop State\n\n<!-- historical_cycle_count: 5 -->\n\n### Cycle result 1\n\n## AFK Cycle 2026-01-02T03-04-05-006Z\n- pending.\n`;
    expect(completedCycleCount(text)).toBe(7);
  });

  it("works with empty string", () => {
    expect(completedCycleCount("")).toBe(0);
  });

  it("works with garbage text", () => {
    expect(completedCycleCount("just some random text without markers")).toBe(0);
  });
});

describe("countScaffoldEntries", () => {
  it("counts '## AFK Cycle' scaffold headings and ignores legacy rich entries", () => {
    const text =
      "# AI Loop State\n\n### Cycle result — legacy\n\n" +
      "## AFK Cycle 2026-01-02T03-04-05-006Z\n- pending.\n\n" +
      "## AFK Cycle 2026-01-03T00-00-00-000Z\n- pending.\n";
    expect(countScaffoldEntries(text)).toBe(2);
    expect(countCycleEntries(text)).toBe(1);
  });

  it("does not match a bare '## AFK Cycle' mention without the scaffold's own heading form", () => {
    expect(countScaffoldEntries("- see the AFK Cycle above for detail\n")).toBe(0);
  });
});
