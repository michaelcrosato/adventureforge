/**
 * AI_LOOP_STATE.md rotation — keep the live loop log small (token-efficient for the
 * cycle agent) while preserving full history and the monotonic cycle count.
 *
 * Every cycle agent reads AI_LOOP_STATE.md; left unbounded it grew to ~1.7 MB / ~420k
 * tokens, so each cycle re-ingested a huge log. This keeps only the most recent
 * {@link ROTATE_KEEP} cycle entries — and no more than {@link ROTATE_MAX_ENTRY_BYTES} of
 * them — in the live log and moves older ones to an append-only AI_LOOP_STATE_ARCHIVE.md.
 * The archive is gitignored — git history already preserves every old version of the
 * live log, so the archive is a local convenience, not a second source of truth.
 *
 * The total completed-cycle count (which the generator seed window rides on, see
 * assessor.ts `generatedEvalSeedBase`) is recovered from a tiny historical marker plus
 * the live entries, so trimming the live log never resets it.
 *
 * Two entry shapes exist, in two orders:
 *   - LEGACY "### Cycle result - <slug>" entries, which agents used to PREPEND directly
 *     below the intro, so that section is NEWEST-FIRST.
 *   - "## AFK Cycle <stamp>" entries. Since the 2026-08-29 two-loop migration this is
 *     the only shape the driver writes: `ai-loop.ts` APPENDS each cycle's scaffold at the
 *     end of the file and the agent completes that same heading in place — no rename, no
 *     prepended replacement. That section is OLDEST-FIRST, and every one of them is newer
 *     than every legacy entry.
 * {@link countScaffoldEntries} counted the second shape for the cycle total (bug_0619),
 * but rotation and the overflow guard kept keying on the legacy heading alone, so once
 * the legacy section sat at exactly {@link ROTATE_KEEP} nothing ever rotated again and the
 * ledger grew one scaffold per cycle, unbounded (bug_0631). Rotation now counts BOTH
 * shapes and archives in true chronological order — the bottom of the legacy section
 * first, then the top of the scaffold tail — so the newest cycle, including the
 * in-progress one, is always the last thing to go.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export const LOOP_STATE_FILE = "AI_LOOP_STATE.md";
export const LOOP_ARCHIVE_FILE = "AI_LOOP_STATE_ARCHIVE.md";
const HISTORICAL_CYCLE_COUNT_RE = /^<!--\s*historical_cycle_count:\s*(\d+)\s*-->/m;
const FEEDBACK_CYCLE_SELECTION_SENTINEL = "feedback_cycle_selection:";

/**
 * How many recent cycle entries (either shape) stay in the live log. Sized so the agent
 * keeps useful recent context AND the blind-pass rotation sees a recent attendance for
 * the packs in active rotation; a pack absent from the window correctly sorts as
 * least-recently-attended (rotated first), so the rotation degrades gracefully.
 */
export const ROTATE_KEEP = 15;

/**
 * Byte ceiling on the live ENTRY section — from the first cycle heading to the end of
 * the file (intake c1101bfc). The entry count alone does not bound what every agent
 * reads: the ledger asks for ≤8 lines per entry, but entries averaged ~2.6 KB and the
 * live file sat at ~49 KB. 30 KiB is {@link ROTATE_KEEP} entries at ~2 KiB each, which
 * is what eight terse lines actually cost; verbose entries simply rotate out sooner.
 * The intro and its machine-owned markers are deliberately outside the measure: the
 * post-gate seal rewrites them AFTER the bar ran, and a ceiling the seal could push a
 * verified cycle over would fail the next bar for bytes no agent wrote.
 */
export const ROTATE_MAX_ENTRY_BYTES = 30 * 1024;

const CYCLE_ENTRY = /^### Cycle result/gm;

/** Matches the "## AFK Cycle <stamp>" scaffold `formatLoopStateAppend` emits. */
const SCAFFOLD_ENTRY = /^## AFK Cycle /gm;

/** Either entry heading, at line start. */
const ANY_ENTRY = /^(?:### Cycle result|## AFK Cycle )/gm;

/** Count completed "### Cycle result" entries in a log text. Pure. */
export function countCycleEntries(text: string): number {
  return (text.match(CYCLE_ENTRY) ?? []).length;
}

/** Count "## AFK Cycle" scaffold entries (completed in place, not renamed). Pure. */
export function countScaffoldEntries(text: string): number {
  return (text.match(SCAFFOLD_ENTRY) ?? []).length;
}

/** Count live cycle entries of EITHER shape — what rotation and its guard bound. Pure. */
export function countLiveEntries(text: string): number {
  return countCycleEntries(text) + countScaffoldEntries(text);
}

/** UTF-8 bytes of the live entry section (first cycle heading to EOF; 0 if none). Pure. */
export function liveEntryBytes(text: string): number {
  const first = text.search(ANY_ENTRY);
  return first < 0 ? 0 : Buffer.byteLength(text.slice(first), "utf8");
}

/** Count completed cycles intentionally removed from the live log. */
export function historicalCycleCount(text: string): number {
  const m = HISTORICAL_CYCLE_COUNT_RE.exec(text);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Total completed cycles represented by one loop-state file. */
export function completedCycleCount(text: string): number {
  return historicalCycleCount(text) + countLiveEntries(text);
}

function upsertHistoricalCycleCount(text: string, count: number): string {
  const line = `<!-- historical_cycle_count: ${count} -->`;
  if (HISTORICAL_CYCLE_COUNT_RE.test(text)) return text.replace(HISTORICAL_CYCLE_COUNT_RE, line);
  return text.replace(/^# AI Loop State\s*/, `# AI Loop State\n\n${line}\n\n`);
}

/**
 * A selection marker normally lives in the NEWEST entry (the in-progress cycle's
 * scaffold), which rotation never archives before anything older. But an entry being
 * archived can still carry selection lines — an unsealed older scaffold, or a malformed
 * or duplicate line. Relocate every line the selection parser counts, without
 * interpreting it, into the live intro just above the first kept entry: canonical bytes
 * stay stable, while malformed or duplicate lines remain available for the seal to
 * reject instead of being laundered away by archival.
 */
function relocateFeedbackCycleSelectionLines(
  keptText: string,
  movedText: string,
): { keptText: string; movedText: string } {
  const selectionLines: string[] = [];
  const archiveLines: string[] = [];
  for (let start = 0; start < movedText.length; ) {
    const lf = movedText.indexOf("\n", start);
    const end = lf < 0 ? movedText.length : lf + 1;
    const line = movedText.slice(start, end);
    (line.includes(FEEDBACK_CYCLE_SELECTION_SENTINEL) ? selectionLines : archiveLines).push(line);
    start = end;
  }
  if (selectionLines.length === 0) return { keptText, movedText };

  const firstEntry = keptText.search(ANY_ENTRY);
  const insertionPoint = firstEntry < 0 ? keptText.length : firstEntry;
  const before = keptText.slice(0, insertionPoint).replace(/\s+$/u, "");
  const after = keptText.slice(insertionPoint);
  const selectionBlock = selectionLines.join("");

  return {
    keptText: `${before}\n\n${selectionBlock}\n${after}`,
    movedText: archiveLines.join(""),
  };
}

/**
 * Total completed cycles across the live log + the archive — the monotonic count the
 * generator seed window rides on. New trimmed files carry a historical-cycle marker in
 * AI_LOOP_STATE.md so a fresh clone preserves the count without reading archived prose.
 * Legacy worktrees with no marker still count entries from the local ignored archive.
 */
export function totalCycleCount(root: string): number {
  const live = join(root, LOOP_STATE_FILE);
  const arch = join(root, LOOP_ARCHIVE_FILE);
  const liveText = existsSync(live) ? readFileSync(live, "utf8") : "";
  const liveN = liveText ? completedCycleCount(liveText) : 0;
  if (historicalCycleCount(liveText) > 0) return liveN;
  const archiveText = existsSync(arch) ? readFileSync(arch, "utf8") : "";
  const archN = archiveText ? countLiveEntries(archiveText) : 0;
  return liveN + archN;
}

/** One cycle entry's span in the log text (`text.slice(start, end)`), and its UTF-8 size. */
export type LoopStateEntry = { start: number; end: number; bytes: number };
type LiveEntry = LoopStateEntry;

/**
 * Split the log into its entries, returned OLDEST FIRST. Each entry runs from its heading
 * to the next heading of either shape (or EOF). Legacy entries are prepend-ordered, so
 * they reverse; scaffolds are append-ordered and all newer, so they follow in file order.
 * Text before the first heading (the intro) belongs to no entry. Pure. This is the ONE
 * definition of the ledger's chronology: rotation archives from its front, and the
 * assessor's attendance recency (assessor.ts parseAttendanceOffsets) reads it backwards.
 */
export function loopStateEntriesOldestFirst(text: string): LoopStateEntry[] {
  const headings = [...text.matchAll(ANY_ENTRY)];
  const legacy: LiveEntry[] = [];
  const scaffolds: LiveEntry[] = [];
  headings.forEach((match, index) => {
    const start = match.index!;
    const end = headings[index + 1]?.index ?? text.length;
    const entry = { start, end, bytes: Buffer.byteLength(text.slice(start, end), "utf8") };
    (match[0].startsWith("###") ? legacy : scaffolds).push(entry);
  });
  return [...legacy.reverse(), ...scaffolds];
}

/**
 * Trim the live log to its most recent {@link ROTATE_KEEP} entries of either shape, then
 * keep archiving the oldest while the entry section exceeds `maxBytes` — but never the
 * last remaining (newest) entry. Moved entries go to the append-only archive; the intro,
 * its machine-owned markers and the historical count are preserved, so the agent's edit
 * target is unchanged. Deterministic; a no-op when the log is within both limits.
 * Returns entries moved.
 */
export function rotateLoopState(
  root: string,
  keep: number = ROTATE_KEEP,
  maxBytes: number = ROTATE_MAX_ENTRY_BYTES,
): number {
  const live = join(root, LOOP_STATE_FILE);
  if (!existsSync(live)) return 0;
  const text = readFileSync(live, "utf8");
  const chronological = loopStateEntriesOldestFirst(text);
  if (chronological.length === 0) return 0;

  let movedCount = Math.max(0, chronological.length - keep);
  let keptBytes = chronological.slice(movedCount).reduce((sum, entry) => sum + entry.bytes, 0);
  while (keptBytes > maxBytes && chronological.length - movedCount > 1) {
    keptBytes -= chronological[movedCount]!.bytes;
    movedCount += 1;
  }
  if (movedCount === 0) return 0;

  const archived = new Set(chronological.slice(0, movedCount));
  const inFileOrder = [...chronological].sort((a, b) => a.start - b.start);
  const intro = text.slice(0, inFileOrder[0]!.start);
  const keptEntries = inFileOrder.filter((entry) => !archived.has(entry));
  const movedEntries = inFileOrder.filter((entry) => archived.has(entry));
  const slice = (entry: LiveEntry): string => {
    const body = text.slice(entry.start, entry.end);
    return body.endsWith("\n") ? body : `${body}\n`;
  };

  let kept = upsertHistoricalCycleCount(
    `${intro}${keptEntries.map(slice).join("")}`.replace(/\s+$/u, "") + "\n",
    historicalCycleCount(text) + movedCount,
  );
  let moved = movedEntries.map(slice).join("");
  ({ keptText: kept, movedText: moved } = relocateFeedbackCycleSelectionLines(kept, moved));

  appendFileSync(join(root, LOOP_ARCHIVE_FILE), moved.startsWith("\n") ? moved : "\n" + moved);
  writeFileSync(live, kept);
  return movedCount;
}
