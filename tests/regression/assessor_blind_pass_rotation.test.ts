/**
 * Regression — bug_0128: the AFK assessor's blind-pass RECENCY ROTATION must track
 * true recency from the log AS IT IS ACTUALLY WRITTEN.
 *
 * The rotation was added to cure a "cold_forge lock-in" (one quest re-nominated
 * every cycle). It then silently broke two ways: (1) it matched only the legacy
 * "Mandatory LLM playtest target this cycle: <path>" header, abandoned ~15 cycles ago
 * for prose "Mandated blind pass ran on <pack>", so recent attendance was invisible;
 * and (2) it assumed an oldest-first log ("last write wins (most recent)") while
 * AI_LOOP_STATE.md is newest-first (prepended), so it kept each pack's OLDEST mention
 * and the sort direction inverted. With stale/inverted data the tiebreak fell back to
 * alphabetical — re-nominating cold_forge, the very lock-in it was meant to cure.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assess,
  attendanceScanText,
  blindReportAttendanceOffsets,
  mergeAttendanceOffsets,
  packStem,
  parseAttendanceOffsets,
  parseBlindReportAttendanceOffsets,
} from "../../src/afk/assessor.js";

function realRepoAttendanceOffsets(): Map<string, number> {
  const loopState = join(process.cwd(), "AI_LOOP_STATE.md");
  const loopOffsets = existsSync(loopState)
    ? parseAttendanceOffsets(readFileSync(loopState, "utf8"))
    : new Map<string, number>();
  return mergeAttendanceOffsets(loopOffsets, blindReportAttendanceOffsets(process.cwd()));
}

describe("bug_0128 — blind-pass rotation tracks true recency", () => {
  it("recognizes the CURRENT prose format the log actually uses (the stale-marker bug)", () => {
    const text = "- Mandated blind pass ran on sunken_barrow (rpg, seed 7).";
    const offsets = parseAttendanceOffsets(text);
    // Pre-fix this matched nothing → the pack looked never-attended.
    expect(offsets.has("sunken_barrow")).toBe(true);
  });

  it("treats the log as NEWEST-FIRST: a pack's topmost mention is its most recent", () => {
    // Realistic prepend order: newest cycle entry on top, oldest at the bottom.
    const text = [
      "- Mandated blind pass ran on wolf_winter (rpg, seed 1).", // newest (topmost)
      "- Mandated blind pass ran on cold_forge (rpg, seed 2).",
      "- Mandated blind pass ran on wolf_winter (rpg, seed 3).", // older repeat
    ].join("\n");
    const offsets = parseAttendanceOffsets(text);
    // wolf_winter kept its FIRST/topmost (most recent) offset, which precedes cold_forge's.
    expect(offsets.get("wolf_winter")!).toBeLessThan(offsets.get("cold_forge")!);
  });

  it("does NOT lock onto a freshly-attended pack: most-recent sorts LAST in the rotation", () => {
    // cold_forge is the MOST recent attendance here; dawn_beacon is never mentioned. The
    // rotation must surface the never-attended quest first and cold_forge last — not the
    // alphabetical-first cold_forge the stale matcher produced.
    const log = [
      "- Mandated blind pass ran on cold_forge (rpg, seed 5).",
      "- Mandated blind pass ran on sunken_barrow (rpg, seed 7).",
    ].join("\n");
    const offsets = parseAttendanceOffsets(log);
    const rank = (stem: string): number => {
      const off = offsets.get(stem);
      return off === undefined ? Number.MIN_SAFE_INTEGER : -off;
    };
    const order = ["cold_forge", "sunken_barrow", "dawn_beacon"].sort(
      (x, y) => rank(x) - rank(y) || x.localeCompare(y),
    );
    expect(order[0]).toBe("dawn_beacon"); // never attended -> first
    expect(order[order.length - 1]).toBe("cold_forge"); // most recent -> last
  });

  it("on the real repo, the rotation no longer re-nominates the MOST-recently-attended pack", () => {
    const loopState = join(process.cwd(), "AI_LOOP_STATE.md");
    if (!existsSync(loopState)) return;
    const offsets = realRepoAttendanceOffsets();
    const a = assess(process.cwd());
    const reviews = a.candidates.filter((c) => c.id.startsWith("playtest-"));
    if (reviews.length < 2) return;
    const topStem = packStem(reviews[0]!.target);
    const topOff = offsets.get(topStem);
    // The nominated pack is either never-attended, or strictly LESS recent than the
    // single most-recently-attended pack (smallest offset). It must not BE that pack.
    const attendedOffs = reviews
      .map((c) => offsets.get(packStem(c.target)))
      .filter((o): o is number => o !== undefined);
    if (topOff !== undefined && attendedOffs.length > 0) {
      const mostRecentOff = Math.min(...attendedOffs);
      expect(topOff).toBeGreaterThanOrEqual(mostRecentOff);
      // The rotation must not put the single MOST-recently-attended pack first. Compute
      // that pack dynamically from the same merged evidence the assessor uses: the
      // tracked log plus accepted local blind reports created before the log is prepended.
      const mostRecentStem = reviews
        .map((c) => ({ stem: packStem(c.target), off: offsets.get(packStem(c.target)) }))
        .filter((x): x is { stem: string; off: number } => x.off !== undefined)
        .sort((x, y) => x.off - y.off)[0]!.stem;
      expect(topStem).not.toBe(mostRecentStem);
    }
  });
});

describe("bug_0235 — recency rotation sees BACKTICK/BOLD-wrapped attendance entries", () => {
  it("parses the `backtick`-wrapped format the log ACTUALLY writes (the blindness recurrence)", () => {
    // The live log writes the pack bold+backticked:
    //   - **Mandated blind pass ran on `bellfounders_alarm`** (rpg, seed 4) — …
    // Pre-fix the capture class excluded the backtick, so the match FAILED at the opening
    // tick and the entry was invisible -> the just-played quest looked never-attended.
    const text = [
      "- **Mandated blind pass ran on `bellfounders_alarm`** (rpg, seed 4) — clean.", // newest
      "- **Mandated blind pass ran on `gallowmere`** (rpg, seed 41).",
      "- Mandated blind pass ran on `cold_forge` (rpg, seed 2).", // oldest
    ].join("\n");
    const offsets = parseAttendanceOffsets(text);
    expect(offsets.has("bellfounders_alarm")).toBe(true); // pre-fix: false (backtick-blind)
    expect(offsets.has("gallowmere")).toBe(true);
    expect(offsets.has("cold_forge")).toBe(true);
    // newest-first log ⇒ the topmost (just-played) pack carries the SMALLEST offset.
    expect(offsets.get("bellfounders_alarm")!).toBeLessThan(offsets.get("cold_forge")!);
  });

  it("a freshly-attended backtick pack sorts LAST in the rotation, never first", () => {
    const log = [
      "- **Mandated blind pass ran on `bellfounders_alarm`** (rpg, seed 4).", // most recent
      "- Mandated blind pass ran on `cold_forge` (rpg, seed 2).",
    ].join("\n");
    const offsets = parseAttendanceOffsets(log);
    const rank = (stem: string): number => {
      const off = offsets.get(stem);
      return off === undefined ? Number.MIN_SAFE_INTEGER : -off;
    };
    // factors_mark is never mentioned (genuinely never-attended).
    const order = ["bellfounders_alarm", "cold_forge", "factors_mark"].sort(
      (x, y) => rank(x) - rank(y) || x.localeCompare(y),
    );
    // Pre-fix bellfounders_alarm was INVISIBLE (undefined ⇒ MIN_SAFE_INTEGER) and, being
    // alphabetically before factors_mark, sorted FIRST — the exact "re-nominate the
    // just-played pack" bug. Post-fix it carries a real recent offset and sorts last.
    expect(order[0]).toBe("factors_mark"); // never attended -> first
    expect(order[order.length - 1]).toBe("bellfounders_alarm"); // most recent -> last
  });

  it("on the real repo, the most-recent backtick pack is parsed and NOT re-nominated first", () => {
    const loopState = join(process.cwd(), "AI_LOOP_STATE.md");
    if (!existsSync(loopState)) return;
    const raw = readFileSync(loopState, "utf8");
    // Independently locate the log's single most-recent "ran on `X`" mention.
    const m = raw.match(/Mandated blind pass ran on\s+`([a-z0-9_]+)`/i);
    if (!m) return;
    const mostRecent = m[1]!;
    const offsets = parseAttendanceOffsets(raw);
    // The matcher MUST see it (pre-fix this was undefined — the vacuous-skip that let the
    // bug_0128 real-repo guard pass while the bug was live).
    expect(offsets.has(mostRecent)).toBe(true);
    const a = assess(process.cwd());
    const reviews = a.candidates.filter((c) => c.id.startsWith("playtest-"));
    if (reviews.length >= 2) {
      // The just-played pack must not be the rotation's top nominee.
      expect(packStem(reviews[0]!.target)).not.toBe(mostRecent);
    }
  });
});

describe("bug_0293 — recency rotation survives the SONNET phrasing + uses the code-written line", () => {
  // Third recurrence of the cold_forge lock-in. After the cycle agent defaulted to
  // Sonnet, its entries wrote "blind pass on `cold_forge`" (no "Mandated …ran"), so
  // the canonical-only matcher saw nothing -> repeated cold_forge cycles. The durable cure
  // parses the MODEL-INDEPENDENT recommendation line the assessor emits every cycle —
  // `Blind-playtest "<id>"` — and tolerates the looser agent phrasing too.
  it("recognizes the Sonnet-era prose 'blind pass on `X`' form", () => {
    const offsets = parseAttendanceOffsets("…(bug_0292): blind pass on `cold_forge` (seed 7).");
    expect(offsets.has("cold_forge")).toBe(true);
  });

  it('recognizes the code-written `Blind-playtest "<id>"` line and normalizes the _v1 id', () => {
    // The exact shape ai-loop.ts prepends every cycle (the assessor's recommendation).
    const line =
      '- Next best improvement (recommended): [content_fix] Blind-playtest "cold_forge_v1" — structurally clean.';
    const offsets = parseAttendanceOffsets(line);
    // Keyed by the path-stem (no _v1) so it matches packStem(candidate.target).
    expect(offsets.has("cold_forge")).toBe(true);
    expect(offsets.has("cold_forge_v1")).toBe(false);
  });

  it('recognizes the current code-written `Blind-playtest quest "<world_quest_id>"` line', () => {
    const line =
      '- Next best improvement (recommended): [content_fix] Blind-playtest quest "bellfounders_alarm" — structurally clean.';
    const offsets = parseAttendanceOffsets(line);
    expect(offsets.has("bellfounders_alarm")).toBe(true);
    expect(offsets.has("quest")).toBe(false);
  });

  it("a freshly-attended pack (new forms) sorts LAST in the rotation, never first", () => {
    // Realistic newest-first entry: code line + Sonnet prose both name cold_forge on top.
    const log = [
      "- Rec: playtest-cold_forge (content_fix/S; score=0.5).",
      "### Cycle result — (bug_0292): blind pass on `cold_forge` (seed 7).",
      '- Next best improvement (recommended): [content_fix] Blind-playtest quest "bellfounders_alarm" — clean.',
    ].join("\n");
    const offsets = parseAttendanceOffsets(log);
    const rank = (stem: string): number => {
      const off = offsets.get(stem);
      return off === undefined ? Number.MIN_SAFE_INTEGER : -off;
    };
    // factors_mark is never mentioned (genuinely never-attended).
    const order = ["cold_forge", "bellfounders_alarm", "factors_mark"].sort(
      (x, y) => rank(x) - rank(y) || x.localeCompare(y),
    );
    expect(order[0]).toBe("factors_mark"); // never attended -> first
    expect(order[order.length - 1]).toBe("cold_forge"); // most recent -> last
  });

  it("on the real repo, the live code line is parsed and the newest attendance is NOT re-nominated", () => {
    const loopState = join(process.cwd(), "AI_LOOP_STATE.md");
    if (!existsSync(loopState)) return;
    const raw = readFileSync(loopState, "utf8");
    // Locate the single most-recent attendance the way the log ACTUALLY writes it today —
    // the code-written recommendation line (model-independent) OR the Sonnet prose form.
    // (The bug_0235 guard greps only "Mandated …ran on `X`", which the live Sonnet log no
    // longer contains, so it vacuously skips — exactly how bug_0293 slipped past.)
    const m =
      raw.match(/Blind-playtest(?:\s+quest)? "([a-z0-9_]+)"/i) ??
      raw.match(/blind pass on\s+`([a-z0-9_]+)`/i);
    if (!m) return;
    const loggedMostRecent = packStem(m[1]!);
    const logOffsets = parseAttendanceOffsets(raw);
    expect(logOffsets.has(loggedMostRecent)).toBe(true); // pre-fix: false (phrasing-blind)
    const a = assess(process.cwd());
    const reviews = a.candidates.filter((c) => c.id.startsWith("playtest-"));
    if (reviews.length >= 2) {
      const attendance = realRepoAttendanceOffsets();
      const mostRecent = reviews
        .map((c) => ({ stem: packStem(c.target), off: attendance.get(packStem(c.target)) }))
        .filter((x): x is { stem: string; off: number } => x.off !== undefined)
        .sort((x, y) => x.off - y.off)[0];
      if (mostRecent) {
        expect(packStem(reviews[0]!.target)).not.toBe(mostRecent.stem);
      }
    }
  });
});

describe("local blind reports — rotation sees accepted report artifacts before the log is prepended", () => {
  it("parses accepted blind report filenames and ignores sidecar/log files", () => {
    const offsets = parseBlindReportAttendanceOffsets([
      "20260619T191648Z_aleconners_seal_seed7.md",
      "20260619T191648Z_aleconners_seal_seed7.json",
      "20260619T191648Z_aleconners_seal_seed7.log",
      "20260619T190607Z_aleconners_seal_seed7.md",
      "20260619T192222Z_alnagers_fault_seed11.md",
    ]);

    expect(offsets.has("aleconners_seal")).toBe(true);
    expect(offsets.has("alnagers_fault")).toBe(true);
    expect(offsets.get("alnagers_fault")!).toBeLessThan(offsets.get("aleconners_seal")!);
  });

  it("merged attendance treats local accepted reports as newer than AI_LOOP_STATE.md", () => {
    const logOffsets = parseAttendanceOffsets(
      '- Next best improvement (recommended): [content_fix] Blind-playtest quest "aleconners_seal" — clean.',
    );
    const reportOffsets = parseBlindReportAttendanceOffsets([
      "20260619T191648Z_aleconners_seal_seed7.md",
    ]);
    const merged = mergeAttendanceOffsets(logOffsets, reportOffsets);

    expect(logOffsets.get("aleconners_seal")).toBeGreaterThanOrEqual(0);
    expect(reportOffsets.get("aleconners_seal")).toBeLessThan(0);
    expect(merged.get("aleconners_seal")).toBe(reportOffsets.get("aleconners_seal"));
  });

  it("on this worktree, an accepted local report can move its pack out of the first slot", () => {
    const reportsDir = join(process.cwd(), "blind-tester", "reports");
    if (!existsSync(reportsDir)) return;
    const reportOffsets = blindReportAttendanceOffsets(process.cwd());
    if (reportOffsets.size === 0) return;
    const attendance = realRepoAttendanceOffsets();
    const a = assess(process.cwd());
    const reviews = a.candidates.filter((c) => c.id.startsWith("playtest-"));
    if (reviews.length < 2) return;

    const newestLocalStem = [...reportOffsets.entries()].sort((x, y) => x[1] - y[1])[0]![0];
    expect(attendance.get(newestLocalStem)).toBeLessThan(0);
    expect(packStem(reviews[0]!.target)).not.toBe(newestLocalStem);
  });
});

describe("bug_0638 — recency is chronological across BOTH ledger entry shapes", () => {
  // Since the 2026-08-29 two-loop migration the driver APPENDS each cycle's "## AFK Cycle"
  // entry at the END of AI_LOOP_STATE.md, after the legacy "### Cycle result" entries
  // (which are newest-first). Scanning raw file order gave the NEWEST AFK entry the
  // LARGEST offset, so the pack it had just attended looked stalest of all.
  const liveShapedLog = [
    "# AI Loop State",
    "",
    "Entry contract: the blind-pass rotation derives attendance from entry names.",
    "",
    "### Cycle result - newest_legacy",
    "- Mandated blind pass ran on `sunken_barrow` (rpg, seed 3).",
    "",
    "### Cycle result - older_legacy",
    "- Mandated blind pass ran on `bellfounders_alarm` (rpg, seed 2).",
    "## AFK Cycle 2026-09-06T04-13-53-054Z",
    "- Rec: playtest-cold_forge (content_fix/M; score=0.5).",
    "## AFK Cycle 2026-09-06T06-59-18-840Z",
    "- Rec: playtest-breaking_weir (content_fix/M; score=0.5).",
    "## AFK Cycle 2026-09-06T09-16-39-619Z",
    "- Rec: playtest-dawn_beacon (content_fix/M; score=0.5).",
    "",
  ].join("\n");

  it("ranks a quest named only in the newest APPENDED AFK entry as the most recent", () => {
    const offsets = parseAttendanceOffsets(liveShapedLog);
    const newest = offsets.get("dawn_beacon");
    expect(newest).toBeDefined();
    // Pre-fix dawn_beacon had the LARGEST offset in the file (it is the last line).
    for (const older of ["breaking_weir", "cold_forge", "sunken_barrow", "bellfounders_alarm"]) {
      expect(offsets.get(older), older).toBeDefined();
      expect(newest!, older).toBeLessThan(offsets.get(older)!);
    }
    // The whole chronology, newest to oldest: AFK entries last-appended first, then the
    // legacy entries top-down.
    const order = [...offsets.entries()].sort((a, b) => a[1] - b[1]).map(([stem]) => stem);
    expect(order).toEqual([
      "dawn_beacon",
      "breaking_weir",
      "cold_forge",
      "sunken_barrow",
      "bellfounders_alarm",
    ]);
  });

  it("so the rotation sorts the just-attended AFK pack LAST, never first", () => {
    const offsets = parseAttendanceOffsets(liveShapedLog);
    const rank = (stem: string): number => {
      const off = offsets.get(stem);
      return off === undefined ? Number.MIN_SAFE_INTEGER : -off;
    };
    const order = ["cold_forge", "dawn_beacon", "factors_mark", "sunken_barrow"].sort(
      (x, y) => rank(x) - rank(y) || x.localeCompare(y),
    );
    expect(order[0]).toBe("factors_mark"); // never attended
    expect(order[order.length - 1]).toBe("dawn_beacon"); // attended by the newest entry
  });

  it("keeps a pack's NEWEST mention when an old legacy entry also names it", () => {
    const log = liveShapedLog.replace(
      "- Rec: playtest-dawn_beacon (content_fix/M; score=0.5).",
      "- Rec: playtest-bellfounders_alarm (content_fix/M; score=0.5).",
    );
    const offsets = parseAttendanceOffsets(log);
    // bellfounders_alarm is in the OLDEST legacy entry and the NEWEST AFK entry: newest wins.
    expect(offsets.get("bellfounders_alarm")!).toBeLessThan(offsets.get("breaking_weir")!);
    expect(offsets.get("bellfounders_alarm")!).toBeLessThan(offsets.get("sunken_barrow")!);
  });

  it("never lets the intro outrank a real entry, and leaves heading-free text as it was", () => {
    const withIntroMention = liveShapedLog.replace(
      "Entry contract: the blind-pass rotation derives attendance from entry names.",
      "- Mandated blind pass ran on `dawn_beacon` (an example in the contract prose).",
    );
    const offsets = parseAttendanceOffsets(withIntroMention);
    // Still attended by the newest AFK entry; the intro copy sits after every entry.
    expect(offsets.get("dawn_beacon")!).toBeLessThan(offsets.get("breaking_weir")!);
    const scan = attendanceScanText(withIntroMention);
    expect(scan.indexOf("an example in the contract prose")).toBeGreaterThan(
      scan.indexOf("### Cycle result - older_legacy"),
    );

    // Free-form text with no entry headings keeps the plain top-is-newest reading
    // every earlier regression in this file relies on.
    const plain = "- Mandated blind pass ran on cold_forge (rpg, seed 3).\n- noise\n";
    expect(attendanceScanText(plain)).toBe(plain);
  });

  it("on the real repo, the newest AFK entry's first attendance is the freshest in the ledger", () => {
    // Skips when the live ledger's newest AFK entry names no pack in a recognised form
    // (true at the time of writing: it says "Rec playtest-…" with no colon), and bites as
    // soon as one does.
    const loopState = join(process.cwd(), "AI_LOOP_STATE.md");
    if (!existsSync(loopState)) return;
    const raw = readFileSync(loopState, "utf8");
    const lastAfk = raw.lastIndexOf("\n## AFK Cycle ");
    if (lastAfk < 0) return;
    const freshestOf = (text: string): string | undefined =>
      [...parseAttendanceOffsets(text).entries()].sort((a, b) => a[1] - b[1])[0]?.[0];
    const inNewestEntry = freshestOf(raw.slice(lastAfk + 1));
    if (inNewestEntry === undefined) return;
    expect(freshestOf(raw)).toBe(inNewestEntry);
  });
});
