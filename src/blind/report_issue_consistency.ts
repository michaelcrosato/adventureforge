import type { ExitInterview } from "./exit_interview.js";

type IssueSeverity = ExitInterview["bugs"][number]["severity"];

type ProseFinding = Readonly<{
  severity: IssueSeverity;
  text: string;
  tokens: ReadonlySet<string>;
}>;

type ReportIssueConsistencyResult = { ok: true } | { ok: false; reason: string };

const BUGS_HEADING =
  /^\s*(?:#{1,6}\s*)?(?:5[.)]\s*)?(?:\*\*)?Bugs or design flaws(?:\*\*)?(?:\s*[,.:\-\u2014]\s*(.*))?\s*$/iu;
const EXIT_INTERVIEW_OPENING = /^\s*```json exit-interview\b/imu;
const FENCED_PROSE_BLOCK = /^```[^\r\n]*\r?\n[\s\S]*?^```[^\S\r\n]*$/gmu;
const SEVERITY = /\bS[0-4]\b/giu;
const ANNOTATED_SEVERITY_SOURCE = "\\bS[0-4]\\b(?:\\s*\\([^)]{1,30}\\))?";
const SEVERITY_RANGE = new RegExp(
  `${ANNOTATED_SEVERITY_SOURCE}\\s*(?:-|\\u2013|\\u2014|to|through)\\s*${ANNOTATED_SEVERITY_SOURCE}`,
  "giu",
);

const NON_IDENTITY_TOKENS = new Set([
  "actual",
  "action",
  "also",
  "board",
  "blocking",
  "bugs",
  "bug",
  "concern",
  "confused",
  "confusing",
  "cosmetic",
  "design",
  "departure",
  "difficult",
  "difficulty",
  "flaws",
  "finding",
  "game",
  "hard",
  "harder",
  "issue",
  "major",
  "minor",
  "moderate",
  "observed",
  "optional",
  "opaque",
  "player",
  "report",
  "row",
  "serious",
  "severity",
  "scan",
  "scanned",
  "scanning",
  "that",
  "the",
  "their",
  "there",
  "these",
  "this",
  "through",
  "unclear",
  "visible",
  "was",
  "were",
  "with",
]);

function extractReportProse(text: string): string | null {
  const interviewOpening = EXIT_INTERVIEW_OPENING.exec(text);
  if (interviewOpening?.index === undefined) return null;
  const prose = text.slice(0, interviewOpening.index);
  if (!prose.split(/\r?\n/u).some((line) => BUGS_HEADING.test(line))) return null;
  return prose.replace(FENCED_PROSE_BLOCK, "");
}

function isNegatedOrHistorical(args: {
  clause: string;
  start: number;
  end: number;
  previousSeverityEnd: number;
  nextSeverityStart: number;
}): boolean {
  const { clause, start, end, previousSeverityEnd, nextSeverityStart } = args;
  for (const range of clause.matchAll(SEVERITY_RANGE)) {
    const rangeStart = range.index ?? -1;
    if (rangeStart <= start && start < rangeStart + range[0]!.length) return true;
  }

  // Exempt only language local to this severity token. A fixed historical S2
  // must not hide a later current S2 in the same sentence.
  const before = clause.slice(previousSeverityEnd, start).trimEnd();
  const after = clause.slice(end, nextSeverityStart).trimStart();
  const exactNegationBefore =
    /(?:^|\b)(?:no|zero|without)(?:\s+(?:actual|any))?\s*$/iu.test(before) ||
    /(?:^|\b)(?:not(?:\s+an?)?|isn['’]t|below|under)\s*$/iu.test(before) ||
    /(?:^|\b)none\s+(?:was\s+)?encountered\s+at\s*$/iu.test(before);
  const exactNegationAfter =
    /^(?:[-+ ]*level)?\s*(?:(?:issue|bug|finding|concern)s?\s+)?(?:is\s+|are\s+|was\s+|were\s+)?(?:absent|none|not observed|no longer occurs?|did not occur|does not occur)\b/iu.test(
      after,
    );
  const historicalPrefix = /(?:^|\b)(?:former|formerly|historical|past|previous|prior)\s*$/iu.test(
    before,
  );
  const historicalResolution = /\b(?:fixed|resolved|corrected|removed)\b/iu.test(after);
  const praise = /^[- ]*level\s+(?:quality|resilience|polish)\b/iu.test(after);
  return (
    exactNegationBefore ||
    exactNegationAfter ||
    (historicalPrefix && historicalResolution) ||
    praise
  );
}

function identityTokens(value: string): ReadonlySet<string> {
  const tokens = value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => (token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token))
    .filter(
      (token) => token.length >= 3 && !/^s[0-4]$/u.test(token) && !NON_IDENTITY_TOKENS.has(token),
    );
  return new Set(tokens);
}

function proseFindings(section: string): ProseFinding[] {
  const findings: ProseFinding[] = [];
  const clauses = section
    .replace(/;/gu, "\n")
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, "").trim())
    .filter(Boolean);
  for (const clause of clauses) {
    const severityMatches = [...clause.matchAll(SEVERITY)];
    for (const [index, match] of severityMatches.entries()) {
      const severity = match[0]!.toLocaleUpperCase("en-US") as IssueSeverity;
      const start = match.index ?? 0;
      if (
        isNegatedOrHistorical({
          clause,
          start,
          end: start + match[0]!.length,
          previousSeverityEnd:
            index === 0
              ? 0
              : (severityMatches[index - 1]!.index ?? 0) + severityMatches[index - 1]![0]!.length,
          nextSeverityStart: severityMatches[index + 1]?.index ?? clause.length,
        })
      ) {
        continue;
      }
      findings.push({ severity, text: clause, tokens: identityTokens(clause) });
    }
  }
  return findings;
}

function sharesIdentity(finding: ProseFinding, bug: ExitInterview["bugs"][number]): boolean {
  if (finding.severity !== bug.severity) return false;
  const whereTokens = identityTokens(bug.where);
  const noteTokens = new Set(
    [...identityTokens(bug.note)].filter((token) => !whereTokens.has(token)),
  );
  const whereOverlap = [...finding.tokens].filter((token) => whereTokens.has(token));
  const concernOverlap = [...finding.tokens].filter((token) => noteTokens.has(token));
  if (whereOverlap.length > 0 && concernOverlap.length > 0) return true;
  if (concernOverlap.length >= 2) return true;

  // A terse item such as "S1 — Moor Trail checkpoint" has no concern prose to
  // compare. Permit it only when at least two discriminative location tokens
  // account for the complete identity; one generic place word is insufficient.
  const proseOutsideWhere = [...finding.tokens].filter((token) => !whereTokens.has(token));
  return whereOverlap.length >= 2 && proseOutsideWhere.length === 0;
}

function sharesStrongConcernIdentity(
  left: ProseFinding,
  right: ProseFinding,
  bug: ExitInterview["bugs"][number],
): boolean {
  if (left.severity !== right.severity || left.severity !== bug.severity) return false;
  const whereTokens = identityTokens(bug.where);
  const sharedConcernTokens = [...left.tokens].filter(
    (token) => !whereTokens.has(token) && right.tokens.has(token),
  );
  return sharedConcernTokens.length >= 2;
}

function groupRepeatedConcernMentions(
  findings: readonly ProseFinding[],
  bugs: ExitInterview["bugs"],
): ProseFinding[][] {
  const groups: ProseFinding[][] = [];
  for (const finding of findings) {
    const repeatedGroup = groups.find((group) =>
      bugs.some(
        (bug) =>
          sharesIdentity(finding, bug) &&
          group.every(
            (existing) =>
              sharesIdentity(existing, bug) && sharesStrongConcernIdentity(existing, finding, bug),
          ),
      ),
    );
    if (repeatedGroup) repeatedGroup.push(finding);
    else groups.push([finding]);
  }
  return groups;
}

function hasCompleteDistinctMatching(
  findings: readonly ProseFinding[],
  bugs: ExitInterview["bugs"],
): boolean {
  const concerns = groupRepeatedConcernMentions(findings, bugs);
  const matchedConcernByBug = new Map<number, number>();
  const match = (concernIndex: number, visited: Set<number>): boolean => {
    const concern = concerns[concernIndex]!;
    for (const [bugIndex, bug] of bugs.entries()) {
      if (visited.has(bugIndex) || !concern.every((finding) => sharesIdentity(finding, bug))) {
        continue;
      }
      visited.add(bugIndex);
      const previous = matchedConcernByBug.get(bugIndex);
      if (previous === undefined || match(previous, visited)) {
        matchedConcernByBug.set(bugIndex, concernIndex);
        return true;
      }
    }
    return false;
  };
  return concerns.every((_concern, index) => match(index, new Set()));
}

/**
 * Certification reports must not place severity-bearing findings only in prose.
 * Matching is severity-exact and one-to-one per distinct concern. Repeated
 * mentions may share one bug only with two strong non-location identity tokens.
 * The audit covers all prose before the structured interview; explicit rubric
 * text, fixed history, clear negation, fenced data, and praise are excluded.
 */
export function verifyStructuredIssueConsistency(
  text: string,
  bugs: ExitInterview["bugs"],
): ReportIssueConsistencyResult {
  const prose = extractReportProse(text);
  if (prose === null) {
    return { ok: false, reason: "missing Bugs or design flaws section for issue consistency" };
  }
  const findings = proseFindings(prose);
  if (findings.length === 0 || hasCompleteDistinctMatching(findings, bugs)) return { ok: true };
  const structuredCounts = new Map<IssueSeverity, number>();
  for (const bug of bugs) {
    structuredCounts.set(bug.severity, (structuredCounts.get(bug.severity) ?? 0) + 1);
  }
  const firstUnaccounted = findings.find(
    (finding) =>
      !bugs.some((bug) => sharesIdentity(finding, bug)) ||
      findings.filter((candidate) => candidate.severity === finding.severity).length >
        (structuredCounts.get(finding.severity) ?? 0),
  );
  const finding = firstUnaccounted ?? findings[0]!;
  const excerpt = finding.text.length > 120 ? `${finding.text.slice(0, 117)}...` : finding.text;
  return {
    ok: false,
    reason: `severity-bearing prose finding is missing a distinct matching bugs[] entry (${finding.severity}: ${excerpt})`,
  };
}
