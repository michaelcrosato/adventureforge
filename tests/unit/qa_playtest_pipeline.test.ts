/**
 * The two-loop QA pipeline: provider registry → session record → store → triage.
 *
 * These tests pin the properties that make the split SAFE rather than merely fast.
 * Speed is easy; what is hard is keeping the evidence honest once playtests stop being
 * bound to the commit under test and start arriving in bulk from several providers at once.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  findCatalogModel,
  findPlaytestProvider,
  parsePlaytestCatalog,
  playtestFamilies,
  playtestProviderIds,
  PlaytestProviderSchema,
  PLAYTEST_PROVIDERS,
  resolvePlaytestArgv,
} from "../../src/blind/providers.js";
import {
  countsTowardExperienceMetrics,
  parsePlaytestSession,
  sealPlaytestSession,
  type PlaytestSessionBody,
} from "../../src/qa/session_record.js";
import {
  listPlaytestSessions,
  readPlaytestSession,
  sha256Hex,
  summarizePlaytestStore,
  writePlaytestSession,
} from "../../src/qa/session_store.js";
import { savePlaytestReport } from "../../src/qa/save_playtest_report.js";
import {
  GROK_MCP_INSTANT_THINKING_EFFORT,
  GROK_MCP_WAVE_COUNT,
  GROK_MCP_WAVE_LIVE_CHILD_CAP,
  GROK_MCP_WAVE_MODEL,
  GROK_MCP_WAVE_PROMPT,
  GROK_MCP_WAVE_SURFACE,
  grokMcpProjectConfig,
  grokWaveTriageArgs,
  parseGrokMcpWaveArgs,
  parseGrokStreamingOutput,
} from "../../src/qa/grok_mcp_wave.js";
import { extractExitInterview, isPureExitInterviewV2 } from "../../src/blind/exit_interview.js";
import {
  derivePromotion,
  isActionable,
  QaTicketSchema,
  ticketId,
  type QaTicket,
} from "../../src/qa/ticket.js";
import { readTickets, writeTickets } from "../../src/qa/ticket_store.js";
import { triagePlaytestCorpus } from "../../src/qa/triage.js";
import { submissionsFromTickets } from "../../src/qa/ticket_submission.js";
import { buildLocationIndex } from "../../src/feedback/normalize.js";
import { nextWork, readQueue, upsertSubmission } from "../../src/intake/queue.js";
import { scoreCluster } from "../../src/feedback/rank.js";
import type { IssueCluster } from "../../src/feedback/cluster.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "af-qa-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const INTERVIEW = {
  clarity: 3,
  enjoyment: 3,
  goal_understood: true,
  got_stuck: false,
  confusions: ["the dispatch board did not say which option commits"],
  bugs: [{ where: "Albany Station Quarter", severity: "S2" as const, note: "stale board text" }],
  best_moment: "the wolf fight",
  worst_moment: "the dispatch board",
  would_replay: true,
  verdict: "Solid, but the opening asks too much before the first real decision.",
};

function body(overrides: Partial<PlaytestSessionBody> = {}): PlaytestSessionBody {
  const transcript = "line one\nline two\n";
  return {
    schema_version: 1,
    recorded_at: "2026-08-28T12:00:00.000Z",
    game_session_id: "o-test",
    run_seed: 7,
    build: {
      git_commit: "a".repeat(40),
      tracked_worktree_clean: true,
      world_id: "new_york_overworld",
      world_hash: "b".repeat(64),
    },
    provider: {
      id: "codex",
      vendor: "openai",
      family: "gpt",
      isolation: "runner_enforced",
      transport_contract: "game-direct-mcp-v1",
    },
    model: { id: "gpt-5.3-codex-spark", tier: "volume", settings: {} },
    persona: { id: "default", title: "default", source_sha256: "c".repeat(64) },
    outcome: "abandoned",
    log: {
      turns: 12,
      accepted_decisions: null,
      transcript_filename: "transcript.jsonl",
      transcript_sha256: sha256Hex(transcript),
      transcript_bytes: Buffer.byteLength(transcript, "utf8"),
    },
    exit_interview: INTERVIEW,
    journey_receipt: null,
    failure_note: "player stopped before a confirmed exit",
    ...overrides,
  };
}

describe("playtest provider registry", () => {
  it("registers every vendor with a distinct id and exposes them sorted", () => {
    expect(playtestProviderIds()).toEqual([
      "claude_code",
      "codex",
      "gemini_cli",
      "grok_cli",
      "grok_desktop",
    ]);
  });

  it("counts DISTINCT LINEAGES, so one vendor twice is not two witnesses", () => {
    expect(playtestFamilies(["codex", "codex"])).toEqual(["gpt"]);
    expect(playtestFamilies(["codex", "gemini_cli", "grok_cli", "grok_desktop"])).toEqual([
      "gemini",
      "gpt",
      "grok",
    ]);
  });

  it("ignores unknown providers rather than letting them inflate independence", () => {
    expect(playtestFamilies(["codex", "not-a-provider"])).toEqual(["gpt"]);
  });

  it("refuses to let a desktop client claim runner-enforced blindness", () => {
    expect(() =>
      PlaytestProviderSchema.parse({
        id: "x",
        displayName: "X",
        vendor: "x",
        family: "x",
        kind: "desktop_client",
        isolation: "runner_enforced",
        catalogPath: "p.json",
        transportContract: "t",
      }),
    ).toThrow(/isolation can only be operator_attested/);
  });

  it("refuses a headless provider with no launch template", () => {
    expect(() =>
      PlaytestProviderSchema.parse({
        id: "x",
        displayName: "X",
        vendor: "x",
        family: "x",
        kind: "headless_cli",
        isolation: "runner_enforced",
        catalogPath: "p.json",
        transportContract: "t",
      }),
    ).toThrow(/must declare a launch template/);
  });

  it("substitutes launch tokens exactly, never expanding one argument into two", () => {
    const codex = findPlaytestProvider("codex")!;
    const { executable, argv } = resolvePlaytestArgv(codex, {
      model: "gpt-5.3-codex-spark",
      cwd: "/repo with space",
    });
    expect(executable).toBe("codex");
    expect(argv).toContain("/repo with space");
    expect(argv.filter((a) => a === "/repo with space")).toHaveLength(1);
  });

  it("will not launch a desktop provider", () => {
    const grok = findPlaytestProvider("grok_desktop")!;
    expect(() => resolvePlaytestArgv(grok, { model: "grok-4", cwd: "/repo" })).toThrow(
      /is not launched by the runner/,
    );
  });

  it("ships a parseable catalog for every registered provider", () => {
    for (const provider of PLAYTEST_PROVIDERS) {
      const raw = JSON.parse(readFileSync(provider.catalogPath, "utf8"));
      const catalog = parsePlaytestCatalog(provider, raw);
      expect(catalog.models.length).toBeGreaterThan(0);
      // Every vendor must offer a cheap player: the fleet's job is volume.
      expect(catalog.models.some((m) => m.tier === "volume")).toBe(true);
    }
  });

  it("rejects an alias that is not verbatim in the catalog", () => {
    const codex = findPlaytestProvider("codex")!;
    const catalog = parsePlaytestCatalog(
      codex,
      JSON.parse(readFileSync(codex.catalogPath, "utf8")),
    );
    expect(() => findCatalogModel(catalog, "latest")).toThrow(/is not in the codex catalog/);
  });
});

describe("playtest session record", () => {
  it("round-trips through its content address", () => {
    const record = sealPlaytestSession(body());
    expect(parsePlaytestSession(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it("detects a record edited after it was written", () => {
    const record = sealPlaytestSession(body());
    const tampered = { ...record, run_seed: 8 };
    expect(() => parsePlaytestSession(tampered)).toThrow(/modified after it was written/);
  });

  it("requires a completed session to carry both the interview and the receipt", () => {
    expect(() => sealPlaytestSession(body({ outcome: "completed", failure_note: null }))).toThrow(
      /journey receipt/,
    );
  });

  it("requires every non-completed session to explain itself", () => {
    expect(() => sealPlaytestSession(body({ failure_note: null }))).toThrow(/failure_note/);
  });

  it.each([
    "session.json",
    "SESSION.JSON",
    "../outside.jsonl",
    "nested/transcript.jsonl",
    "nested\\transcript.jsonl",
  ])("rejects unsafe transcript filename %s", (transcriptFilename) => {
    const candidate = body();
    expect(() =>
      sealPlaytestSession({
        ...candidate,
        log: { ...candidate.log, transcript_filename: transcriptFilename },
      }),
    ).toThrow(/transcript_filename must be a plain filename/);
  });

  it("keeps operator-attested sessions but excludes them from experience metrics", () => {
    const attested = sealPlaytestSession(
      body({
        provider: {
          id: "grok_desktop",
          vendor: "xai",
          family: "grok",
          isolation: "operator_attested",
          transport_contract: "operator-attested-mcp-v1",
          operator_attestation: {
            attested_by: "operator",
            method: "desktop client, AdventureForge MCP only",
            attested_at: "2026-08-28T12:00:00.000Z",
          },
        },
      }),
    );
    // Kept and readable …
    expect(attested.record_id).toMatch(/^[0-9a-f]{64}$/);
    // … but never counted as proven experience evidence.
    expect(countsTowardExperienceMetrics(attested)).toBe(false);
  });

  it("requires an attestation exactly when the runner could not prove isolation", () => {
    expect(() =>
      sealPlaytestSession(
        body({
          provider: {
            id: "grok_desktop",
            vendor: "xai",
            family: "grok",
            isolation: "operator_attested",
            transport_contract: "operator-attested-mcp-v1",
          },
        }),
      ),
    ).toThrow(/must record who attested/);
  });
});

describe("playtest session store", () => {
  const transcript = "line one\nline two\n";

  it("writes and reads a session, and is idempotent for identical content", () => {
    const store = tempDir();
    const record = sealPlaytestSession(body());
    const first = writePlaytestSession(store, record, transcript);
    const second = writePlaytestSession(store, record, transcript);
    expect(second).toBe(first);
    const { entries, unreadable } = listPlaytestSessions(store);
    expect(unreadable).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.record.record_id).toBe(record.record_id);
  });

  it("refuses a transcript that does not match the record's hash", () => {
    const store = tempDir();
    const record = sealPlaytestSession(body());
    expect(() => writePlaytestSession(store, record, "tampered\n")).toThrow(
      /transcript hash mismatch/,
    );
  });

  it("reports an unreadable session instead of silently skipping it", () => {
    const store = tempDir();
    const record = sealPlaytestSession(body());
    const dir = writePlaytestSession(store, record, transcript);
    writeFileSync(join(dir, "session.json"), '{"schema_version":1}', "utf8");
    const { entries, unreadable } = listPlaytestSessions(store);
    expect(entries).toHaveLength(0);
    expect(unreadable).toHaveLength(1);
  });

  it("summarizes the corpus by outcome, provider, tier and isolation", () => {
    const store = tempDir();
    writePlaytestSession(store, sealPlaytestSession(body()), transcript);
    writePlaytestSession(
      store,
      sealPlaytestSession(
        body({ run_seed: 99, model: { id: "gpt-5.6-terra", tier: "reference", settings: {} } }),
      ),
      transcript,
    );
    const summary = summarizePlaytestStore(listPlaytestSessions(store).entries);
    expect(summary.total).toBe(2);
    expect(summary.byTier).toEqual({ volume: 1, reference: 1 });
    expect(summary.families).toEqual(["gpt"]);
    // Neither is `completed`, so neither is metrics-eligible.
    expect(summary.metricsEligible).toBe(0);
  });
});

describe("ticket promotion", () => {
  it("keeps a stable id as evidence accumulates", () => {
    const identity = { kind: "bug" as const, location: "byre_yard", fingerprint: "abc" };
    expect(ticketId(identity)).toBe(ticketId({ ...identity }));
  });

  it("promotes on reference-tier confirmation alone", () => {
    expect(
      derivePromotion({ families: ["gemini"], tiers: ["reference"] }, { verified: false }),
    ).toBe("corroborated");
  });

  it("does NOT promote one cheap lineage no matter how loud it is", () => {
    expect(derivePromotion({ families: ["gemini"], tiers: ["volume"] }, { verified: false })).toBe(
      "accumulating",
    );
  });

  it("promotes once a second independent lineage agrees", () => {
    expect(
      derivePromotion({ families: ["gemini", "gpt"], tiers: ["volume"] }, { verified: false }),
    ).toBe("corroborated");
  });

  it("lets a reproduction outrank any amount of agreement", () => {
    expect(derivePromotion({ families: [], tiers: [] }, { verified: true })).toBe("verified");
  });

  it("hides accumulating tickets from the dev loop", () => {
    const base = {
      schema_version: 1 as const,
      ticket_id: "0".repeat(16),
      title: "t",
      kind: "bug" as const,
      severity: "S2" as const,
      status: "open" as const,
      location: "l",
      excerpts: [],
      evidence: {
        report_count: 1,
        families: ["gemini"],
        providers: ["gemini_cli"],
        tiers: ["volume" as const],
        has_runner_enforced_report: true,
        session_ids: ["s"],
        first_seen_build: "a",
        last_seen_build: "a",
        first_seen_at: "2026-08-28T12:00:00.000Z",
        last_seen_at: "2026-08-28T12:00:00.000Z",
      },
      priority: 1,
    };
    expect(isActionable({ ...base, promotion: "accumulating" })).toBe(false);
    expect(isActionable({ ...base, promotion: "corroborated" })).toBe(true);
    expect(isActionable({ ...base, promotion: "verified", status: "wont_fix" })).toBe(false);
  });
});

describe("the QA bucket on disk", () => {
  function ticketOnDisk(over: Partial<QaTicket> = {}): QaTicket {
    return {
      schema_version: 1,
      ticket_id: "0".repeat(16),
      title: "a ticket",
      kind: "bug",
      severity: "S2",
      status: "open",
      promotion: "corroborated",
      location: "steading_yard",
      excerpts: [],
      evidence: {
        report_count: 1,
        families: ["gpt"],
        providers: ["codex"],
        tiers: ["volume"],
        has_runner_enforced_report: true,
        session_ids: ["s"],
        first_seen_build: "a".repeat(40),
        last_seen_build: "a".repeat(40),
        first_seen_at: "2026-08-28T12:00:00.000Z",
        last_seen_at: "2026-08-28T12:00:00.000Z",
      },
      priority: 4,
      ...over,
    };
  }

  // Triage carries unmatched prior tickets forward so this cleanup only ever drops
  // something a caller deliberately dropped — but that protection needs the caller to
  // have been able to READ the ticket. A file that stopped parsing (schema bump,
  // hand-edit, partial write) never reaches the carried-forward list, so the cleanup
  // deleted it and took a maintainer's `wont_fix` and notes with it, silently.
  it("leaves a ticket file it cannot parse in place instead of deleting it", () => {
    const dir = tempDir();
    const damaged = join(dir, `S3-bug-${"f".repeat(16)}.json`);
    writeFileSync(damaged, '{ "schema_version": 1, "ticket_id": "trunc', "utf8");

    writeTickets([ticketOnDisk()], dir);

    expect(readFileSync(damaged, "utf8")).toContain("trunc");
    const reread = readTickets(dir);
    expect(reread.tickets).toHaveLength(1);
    expect(reread.unreadable).toHaveLength(1);
  });

  it("still removes a ticket the caller genuinely dropped", () => {
    const dir = tempDir();
    writeTickets([ticketOnDisk(), ticketOnDisk({ ticket_id: "1".repeat(16) })], dir);
    expect(readTickets(dir).tickets).toHaveLength(2);
    writeTickets([ticketOnDisk()], dir);
    expect(readTickets(dir).tickets).toHaveLength(1);
  });
});

describe("what kind of work a ticket is", () => {
  const transcript = "line one\nline two\n";

  function kindOf(interview: PlaytestSessionBody["exit_interview"]): string {
    const store = tempDir();
    writePlaytestSession(
      store,
      sealPlaytestSession(body({ exit_interview: interview })),
      transcript,
    );
    const { tickets } = triagePlaytestCorpus({
      sessions: listPlaytestSessions(store).entries.map((entry) => entry.record),
      locationIndex: buildLocationIndex(process.cwd()),
      buildHistory: ["a".repeat(40)],
    });
    expect(tickets).toHaveLength(1);
    return tickets[0]!.kind;
  }

  // S1 is the exit interview's "minor" rung, and a player may file a BUG at it. Reading
  // the kind off severity therefore routed every minor defect as experience work — and
  // since `kind` is part of `ticketId`, that ticket also re-keyed itself into a second
  // piece of work the first time an S2 report joined the same cluster.
  it("routes a minor bug as a bug rather than as experience", () => {
    expect(
      kindOf({
        ...INTERVIEW,
        confusions: [],
        bugs: [
          {
            where: "quest wolf_winter, room steading_yard",
            severity: "S1" as const,
            note: "The lantern's description still calls it lit after it burns out.",
          },
        ],
      }),
    ).toBe("bug");
  });

  it("still routes a bare confusion as experience work", () => {
    expect(
      kindOf({
        ...INTERVIEW,
        confusions: ["the dispatch board did not say which option commits"],
        bugs: [],
      }),
    ).toBe("experience");
  });
});

describe("ranking across a mixed-vendor fleet", () => {
  function cluster(over: Partial<IssueCluster>): IssueCluster {
    return {
      key: "k",
      issues: Array.from({ length: 3 }, () => ({}) as never),
      tokens: [],
      location: {
        kind: "unmapped",
        questId: null,
        region: null,
        node: null,
        sceneId: null,
        raw: ["x"],
      },
      maxSeverity: "S2",
      severityBand: "moderate",
      sources: ["fleet"],
      personas: [],
      families: [],
      tiers: [],
      ...over,
    } as IssueCluster;
  }

  it("scores legacy clusters with no provider metadata exactly as before", () => {
    expect(scoreCluster(cluster({}))).toBe(3 * 4);
  });

  it("ranks a small reference-only finding above a large single-lineage volume one", () => {
    const referenceOnly = cluster({
      issues: Array.from({ length: 3 }, () => ({}) as never),
      families: ["gpt"],
      tiers: ["reference"],
    });
    const volumeFlood = cluster({
      issues: Array.from({ length: 40 }, () => ({}) as never),
      families: ["gemini"],
      tiers: ["volume"],
    });
    expect(scoreCluster(referenceOnly)).toBeGreaterThan(scoreCluster(volumeFlood));
  });

  it("rewards independent lineages over repetition within one", () => {
    const fourVendors = cluster({
      issues: Array.from({ length: 8 }, () => ({}) as never),
      families: ["claude", "gemini", "gpt", "grok"],
      tiers: ["volume"],
    });
    const oneVendorLouder = cluster({
      issues: Array.from({ length: 64 }, () => ({}) as never),
      families: ["gemini"],
      tiers: ["volume"],
    });
    expect(scoreCluster(fourVendors)).toBeGreaterThan(scoreCluster(oneVendorLouder));
  });

  it("treats both tiers agreeing as the strongest experiential signal", () => {
    const both = cluster({ families: ["gpt", "gemini"], tiers: ["reference", "volume"] });
    const volumeOnly = cluster({ families: ["gpt", "gemini"], tiers: ["volume"] });
    expect(scoreCluster(both)).toBeGreaterThan(scoreCluster(volumeOnly));
  });
});

describe("provenance can be weakened by hand but never strengthened", () => {
  it("keeps a runner-launched session's proof intact", () => {
    const record = sealPlaytestSession(body());
    expect(record.provider.isolation).toBe("runner_enforced");
    expect(record.provider.operator_attestation).toBeUndefined();
    expect(countsTowardExperienceMetrics(record)).toBe(false); // not `completed`
  });

  it("refuses an attestation on a session the runner proved", () => {
    // A human vouching for something the machine already established is not extra
    // assurance — it is a claim nobody can check layered over one anybody can.
    expect(() =>
      sealPlaytestSession(
        body({
          provider: {
            id: "codex",
            vendor: "openai",
            family: "gpt",
            isolation: "runner_enforced",
            transport_contract: "game-direct-mcp-v1",
            operator_attestation: {
              attested_by: "someone",
              method: "trust me",
              attested_at: "2026-08-28T12:00:00.000Z",
            },
          },
        }),
      ),
    ).toThrow(/take no operator attestation/);
  });

  it("lets a normally-runner-launched provider be recorded as attested when hand-played", () => {
    // The case the live test surfaced: a Claude Code session played through MCP by hand.
    // The provider is `runner_enforced` in the registry, but THIS session was not
    // launched by the runner, so the record must say so.
    const handPlayed = sealPlaytestSession(
      body({
        provider: {
          id: "claude_code",
          vendor: "anthropic",
          family: "claude",
          isolation: "operator_attested",
          transport_contract: "game-direct-mcp-v1",
          operator_attestation: {
            attested_by: "operator",
            method: "played through the MCP server by hand",
            attested_at: "2026-08-28T12:00:00.000Z",
          },
        },
      }),
    );
    expect(handPlayed.provider.family).toBe("claude");
    expect(countsTowardExperienceMetrics(handPlayed)).toBe(false);
  });
});

/**
 * The whole chain, on disk, with realistically-worded reports.
 *
 * Every test above this point builds evidence by hand and calls one function with it.
 * That is why a total clustering failure survived them all: `derivePromotion` was
 * correct, `scoreCluster` was correct, and no test ever asked whether a finding written
 * the way a real playtester writes it could actually REACH the dev loop.
 *
 * A live run answered that: six sessions produced 55 issues and 55 clusters, so no
 * ticket ever exceeded one report and nothing could promote. The cause was upstream of
 * both functions — reporters cite machine ids in prose ("room steading_yard, blocked
 * exit north"), which failed to canonicalize and gave every report its own location.
 *
 * So this exercises the seam rather than the parts: session records on disk → triage →
 * clustering → promotion → the dev loop's queue. The `where` strings below are the
 * verbatim wordings three independent playtesters used for one defect.
 */
describe("end to end: a corroborated finding reaches the dev loop's queue", () => {
  const transcript = "line one\nline two\n";

  /** One reporter, one vendor, one wording of the same blocked exit. */
  function reporter(over: {
    provider: PlaytestSessionBody["provider"];
    model: PlaytestSessionBody["model"];
    where: string;
    seed: number;
  }): PlaytestSessionBody {
    return body({
      run_seed: over.seed,
      game_session_id: `o-${over.seed}`,
      provider: over.provider,
      model: over.model,
      exit_interview: {
        ...INTERVIEW,
        confusions: [],
        bugs: [
          {
            where: over.where,
            severity: "S3" as const,
            note: "Blocked reason claims both approach routes are selected; exactly one was.",
          },
        ],
      },
    });
  }

  const REPORTERS = [
    {
      seed: 101,
      where: "quest wolf_winter, room steading_yard, blocked exit north",
      provider: {
        id: "codex",
        vendor: "openai",
        family: "gpt",
        isolation: "runner_enforced" as const,
        transport_contract: "game-direct-mcp-v1",
      },
      model: { id: "gpt-5.3-codex-spark", tier: "volume" as const, settings: {} },
    },
    {
      seed: 201,
      where: "wolf_winter quest opening room steading_yard, blocked exit north",
      provider: {
        id: "gemini_cli",
        vendor: "google",
        family: "gemini",
        isolation: "runner_enforced" as const,
        transport_contract: "game-direct-mcp-v1",
      },
      model: { id: "gemini-3-flash", tier: "volume" as const, settings: {} },
    },
    {
      seed: 301,
      where: "steading_yard",
      provider: {
        id: "claude_code",
        vendor: "anthropic",
        family: "claude",
        isolation: "runner_enforced" as const,
        transport_contract: "game-direct-mcp-v1",
      },
      model: { id: "claude-haiku-4-5-20251001", tier: "volume" as const, settings: {} },
    },
  ];

  function triageCorpus(
    reporters: readonly (typeof REPORTERS)[number][],
    extra: Partial<Parameters<typeof triagePlaytestCorpus>[0]> = {},
  ) {
    const store = tempDir();
    for (const r of reporters) {
      writePlaytestSession(store, sealPlaytestSession(reporter(r)), transcript);
    }
    const { entries, unreadable } = listPlaytestSessions(store);
    expect(unreadable).toEqual([]);
    return triagePlaytestCorpus({
      sessions: entries.map((entry) => entry.record),
      locationIndex: buildLocationIndex(process.cwd()),
      buildHistory: ["a".repeat(40)],
      ...extra,
    });
  }

  it("cannot promote a single lineage on volume alone, however many reports it files", () => {
    // The gap this whole route exists to close: promotion needs reference tier or two
    // independent families, so a Sonnet-only fleet corroborating a real defect over and over
    // stays at `accumulating` and never becomes actionable work.
    const oneLineage = REPORTERS.filter((r) => r.model.id.startsWith("claude"));
    const ticket = triageCorpus(oneLineage).tickets[0]!;
    expect(ticket.evidence.families).toEqual(["claude"]);
    expect(ticket.promotion).toBe("accumulating");
    expect(isActionable(ticket)).toBe(false);
  });

  it("a reproduction promotes it, and the promotion OUTLIVES the run that recorded it", () => {
    const oneLineage = REPORTERS.filter((r) => r.model.id.startsWith("claude"));
    const id = triageCorpus(oneLineage).tickets[0]!.ticket_id;

    const stamped = triageCorpus(oneLineage, {
      verifiedTicketIds: [id],
      verifiedBy: "tests/regression/rowan_docket_options.test.ts",
    }).tickets[0]!;
    expect(stamped.promotion).toBe("verified");
    expect(stamped.verified_by).toBe("tests/regression/rowan_docket_options.test.ts");
    expect(isActionable(stamped)).toBe(true);

    // The point of the durable field: a later triage with NO flag must keep the rung. A
    // promotion that evaporated on the next run would be an override, not evidence.
    const later = triageCorpus(oneLineage, { existingTickets: [stamped] }).tickets[0]!;
    expect(later.promotion).toBe("verified");
    expect(later.verified_by).toBe("tests/regression/rowan_docket_options.test.ts");

    // And it round-trips through the strict schema rather than being dropped on read.
    expect(QaTicketSchema.parse(JSON.parse(JSON.stringify(later))).verified_by).toBe(
      "tests/regression/rowan_docket_options.test.ts",
    );
  });

  it("merges three wordings of one defect into a single ticket", () => {
    const { tickets, stats } = triageCorpus(REPORTERS);
    expect(stats.sessions).toBe(3);
    // The regression this whole block exists for: 3 issues must not be 3 clusters.
    expect(stats.issues).toBe(3);
    expect(stats.clusters).toBe(1);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.evidence.report_count).toBe(3);
  });

  it("promotes it, because three vendors are three independent witnesses", () => {
    const ticket = triageCorpus(REPORTERS).tickets[0]!;
    expect(ticket.evidence.families).toEqual(["claude", "gemini", "gpt"]);
    expect(ticket.promotion).toBe("corroborated");
    expect(isActionable(ticket)).toBe(true);
  });

  it("withholds the identical finding when one vendor reports it three times", () => {
    // Same three wordings, same count — but one lineage. Nothing may promote: one
    // instrument sampled three times is not three witnesses.
    const oneVendor = REPORTERS.map((r) => ({ ...r, provider: REPORTERS[2]!.provider }));
    const { tickets, stats } = triageCorpus(oneVendor);
    expect(stats.clusters).toBe(1);
    expect(tickets[0]!.evidence.report_count).toBe(3);
    expect(tickets[0]!.evidence.families).toEqual(["claude"]);
    expect(tickets[0]!.promotion).toBe("accumulating");
    expect(isActionable(tickets[0]!)).toBe(false);
  });

  it("hands the promoted finding to the dev loop as the next piece of work", () => {
    const queue = tempDir();
    const { tickets } = triageCorpus(REPORTERS);
    const promoted = submissionsFromTickets(tickets);
    expect(promoted).toHaveLength(1);
    for (const submission of promoted) upsertSubmission(submission, queue);

    const work = nextWork(readQueue(queue).submissions);
    expect(work).not.toBeNull();
    expect(work!.source).toBe("playtest");
    expect(work!.evidence.lineages).toEqual(["claude", "gemini", "gpt"]);
    expect(work!.evidence.observations).toBe(3);
    // The dev agent must be able to find the place from the queue item alone.
    expect(work!.body).toContain("steading_yard");
  });

  it("keeps one queue item as the same finding keeps arriving", () => {
    const queue = tempDir();
    const first = submissionsFromTickets(triageCorpus(REPORTERS).tickets);
    for (const s of first) upsertSubmission(s, queue);
    // A later wave re-triages the whole corpus from scratch, as the loop actually does.
    const second = submissionsFromTickets(triageCorpus(REPORTERS).tickets);
    for (const s of second) upsertSubmission(s, queue);
    expect(readQueue(queue).submissions).toHaveLength(1);
  });

  it("does not promote a finding only one vendor saw, even beside a promoted one", () => {
    const solo = {
      ...REPORTERS[0]!,
      seed: 999,
      where: "quest wolf_winter, room broken_paling, blocked exit north",
    };
    const { tickets } = triageCorpus([...REPORTERS, solo]);
    const promoted = submissionsFromTickets(tickets);
    expect(tickets.length).toBeGreaterThan(1);
    // Both are real evidence and both stay in the bucket; only one is work.
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.body).toContain("steading_yard");
  });
});

const GROK_V2_INTERVIEW = {
  schema_version: 2 as const,
  issue_consistency_version: 1 as const,
  play_mode: "pure" as const,
  start_surface: "fresh_overworld" as const,
  retention_eligible: true as const,
  journey_exit_receipt: {
    contractVersion: 3 as const,
    exitReason: "player_ended_at_choice" as const,
    goalVersion: 1,
    goalId: "albany_local_lead",
    goalText: "Find one local lead in Albany and see it through.",
    goalStatus: "completed" as const,
    goalCompletedAtDecision: 17,
    completedGoals: [
      {
        version: 1,
        id: "albany_local_lead",
        text: "Find one local lead in Albany and see it through.",
        status: "completed" as const,
        completedAtDecision: 17,
      },
    ],
    acceptedDecisions: 17,
    exitReasons: ["goal_completed" as const],
    checkpoint: null,
    decisionProofHash: "26fbe3f372ca587f38a3439e3c7bfa7c7a43688cc5ee7cdc3e27a13eef69c5ff",
    retentionHistory: [
      {
        sequence: 1,
        atDecision: 17,
        reasons: ["goal_completed" as const],
        checkpoint: null,
        goalVersion: 1,
        goalId: "albany_local_lead",
        choice: "end" as const,
        decisionProofHash: "26fbe3f372ca587f38a3439e3c7bfa7c7a43688cc5ee7cdc3e27a13eef69c5ff",
      },
    ],
    receiptHash: "2136b41c82e821ed7eee1cfc432b7903d57ae197bbc4c7497cd49cc94a5d06ff",
  },
  clarity: 3,
  enjoyment: 3,
  goal_understood: true,
  got_stuck: false,
  confusions: ["Tutorial local-lead goal vs Wolf-Winter chapter guidance"],
  bugs: [] as { where: string; severity: "S0" | "S1" | "S2" | "S3" | "S4"; note: string }[],
  best_moment: "Repair 17 vs 12 locking the first Albany seal while Cade refused to help.",
  worst_moment: "Parsing compact tuples before I understood what a lead even was.",
  would_replay: true,
  verdict:
    "A working compact TTRPG loop from Albany registration through a sealed-byre FORTIFY win and a real End receipt; readable once committed, but the opening is more ledger than story.",
};

function grokReport(interview: unknown, fence = "json exit-interview", trailing = ""): string {
  return [
    "Playthrough log",
    "Albany Civic Center to Wolf-Winter, then End.",
    "Verdict",
    "A real new player would keep going after the first lead.",
    "clarity 3 enjoyment 3",
    "Bugs or design flaws",
    "No bugs observed.",
    "",
    `\`\`\`${fence}`,
    JSON.stringify(interview, null, 2),
    "```",
    trailing,
  ].join("\n");
}

function grokEvidence(seed = 11, receipt = GROK_V2_INTERVIEW.journey_exit_receipt): string {
  const build = {
    git_commit: "a".repeat(40),
    tracked_worktree_clean: true,
    world_id: "new_york_overworld",
    world_hash: "b".repeat(64),
  };
  return [
    {
      schema_version: 2,
      play_mode: "pure",
      event: "fresh_start",
      start_surface: "fresh_overworld",
      session_id: `o-test-${seed}`,
      run_seed: seed,
      build,
    },
    {
      schema_version: 2,
      play_mode: "pure",
      event: "journey_exit",
      start_surface: "fresh_overworld",
      session_id: `o-test-${seed}`,
      run_seed: seed,
      build,
      quest_outcomes: [],
      receipt,
    },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n");
}

function saveGrokReport(store: string, reportText: string, seed = 11, runEvidenceText?: string) {
  return savePlaytestReport({
    reportText,
    transcript: reportText,
    store,
    providerId: "grok_cli",
    modelId: "grok-4.6",
    seed,
    gameSessionId: `o-test-${seed}`,
    attestedBy: "qa-test",
    method: "unit test, AdventureForge MCP only",
    recordedAt: "2026-08-29T12:00:00.000Z",
    buildCommit: "a".repeat(40),
    trackedWorktreeClean: true,
    ...(runEvidenceText === undefined ? {} : { runEvidenceText }),
  });
}

describe("grok MCP wave request", () => {
  it("targets 100 grok-4.6 instant-thinking MCP players, twice", () => {
    const first = parseGrokMcpWaveArgs([]);
    const second = parseGrokMcpWaveArgs([]);
    expect(first).toEqual(second);
    expect(first.count).toBe(GROK_MCP_WAVE_COUNT);
    expect(first.count).toBe(100);
    expect(first.model).toBe(GROK_MCP_WAVE_MODEL);
    expect(first.effort).toBe(GROK_MCP_INSTANT_THINKING_EFFORT);
    expect(first.instantThinking).toBe(true);
    expect(first.playSurface).toBe(GROK_MCP_WAVE_SURFACE);
    expect(first.provider).toBe("grok_cli");
    const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const run = () =>
      JSON.parse(
        execFileSync("node", [tsx, "bin/playtest-grok-wave.ts", "--plan-only"], {
          encoding: "utf8",
        }),
      ) as {
        count: number;
        model: string;
        effort: string;
        instantThinking: boolean;
        playSurface: string;
      };
    const cliFirst = run();
    const cliSecond = run();
    expect(cliFirst).toEqual(cliSecond);
    expect(cliFirst).toMatchObject({
      count: 100,
      model: "grok-4.6",
      effort: "low",
      instantThinking: true,
      playSurface: "mcp",
      provider: "grok_cli",
    });
  });

  it("caps live children at 32 even when the caller asks for more", () => {
    expect(GROK_MCP_WAVE_LIVE_CHILD_CAP).toBe(32);
    expect(parseGrokMcpWaveArgs(["--concurrency", "32"]).concurrency).toBe(32);
    expect(parseGrokMcpWaveArgs(["--concurrency", "100"]).concurrency).toBe(
      GROK_MCP_WAVE_LIVE_CHILD_CAP,
    );
  });

  it("demands high-standard gamer feedback and a V2 json exit-interview", () => {
    const prompt = readFileSync(GROK_MCP_WAVE_PROMPT, "utf8");
    expect(prompt).toMatch(/gamer with high standards/i);
    expect(prompt).toContain("Do not pander");
    expect(prompt).toContain("worst_moment");
    expect(prompt).toContain("would_replay");
    expect(prompt).toContain("json exit-interview");
    expect(prompt).toContain("journey_exit_receipt");
    expect(prompt).toContain("exitReceipt");
    expect(prompt).toContain('"bugs": []');
    expect(prompt).not.toContain('bugs": "none"');
  });

  it("rewrites the ignored manifest after each child, including spawn failures", () => {
    const driver = readFileSync(join(process.cwd(), "bin", "playtest-grok-wave.ts"), "utf8");
    expect(driver).toContain("rows[index] = await playOne(");
    expect(driver).toMatch(
      /rows\[index\] = await playOne\([\s\S]*?writeManifest\(manifestPath, rows\)/u,
    );
    expect(driver).toContain('requestedOutcome: "failed"');
    expect(driver).toContain("savePlaytestReport({");
  });

  it("hands the wave off to qa:triage against its own store once play finishes (bug_0622)", () => {
    // Unlike playtest-loop.sh's `run_wave` (which always re-triages after a wave), the
    // Grok wave used to stop at the manifest: sessions were saved but nothing folded them
    // into qa/tickets or intake/queue without an operator running qa:triage by hand.
    expect(grokWaveTriageArgs("ai-runs/playtest/grok-store")).toEqual([
      "run",
      "--silent",
      "qa:triage",
      "--",
      "--store",
      "ai-runs/playtest/grok-store",
    ]);
    const driver = readFileSync(join(process.cwd(), "bin", "playtest-grok-wave.ts"), "utf8");
    expect(driver).toMatch(
      /const rows = await runPool\([\s\S]*?handOffToTriage\(plan\.store\)[\s\S]*?const incomplete = /u,
    );
  });

  it("builds a private pure MCP server config with exact run provenance", () => {
    const config = grokMcpProjectConfig({
      repoRoot: "C:\\game",
      evidencePath: "C:\\work\\evidence.jsonl",
      seed: 1700000007,
      buildCommit: "a".repeat(40),
      trackedWorktreeClean: true,
    });
    expect(config).toContain("[mcp_servers.adventureforge]");
    expect(config).toContain('"--play-mode","pure"');
    expect(config).toContain('"--run-evidence","C:\\\\work\\\\evidence.jsonl"');
    expect(config).toContain('"--run-seed","1700000007"');
    expect(config).toContain(`"--build-commit","${"a".repeat(40)}"`);
    expect(config).toContain('"--tracked-worktree-clean","true"');
  });

  it("reassembles report text and counts only AdventureForge use_tool calls", () => {
    const stream = [
      { type: "thought", data: "playing" },
      {
        type: "tool_call",
        toolName: "use_tool",
        rawInput: { tool_name: "adventureforge__start_overworld", tool_input: {} },
      },
      { type: "tool_call", toolName: "search_tool", rawInput: { query: "journey" } },
      { type: "text", data: "Playthrough " },
      { type: "future_event", data: "ignored safely" },
      { type: "text", data: "log" },
      { type: "end", stopReason: "end_turn", sessionId: "grok-session" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    expect(parseGrokStreamingOutput(stream)).toEqual({
      reportText: "Playthrough log",
      clientSessionId: "grok-session",
      gameToolCalls: 1,
      stopReason: "end_turn",
      error: null,
      ended: true,
    });
  });
});

describe("playtest report save keeps interviews intact or fail-closed", () => {
  it("writes a valid V2 json exit-interview with the same subjective fields and receipt", () => {
    const store = tempDir();
    const reportText = grokReport(GROK_V2_INTERVIEW);
    const extracted = extractExitInterview(reportText);
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) throw new Error(extracted.reason);
    expect(isPureExitInterviewV2(extracted.interview)).toBe(true);
    const saved = saveGrokReport(store, reportText);
    expect(saved.record.outcome).toBe("completed");
    expect(saved.record.exit_interview).toMatchObject({
      clarity: GROK_V2_INTERVIEW.clarity,
      enjoyment: GROK_V2_INTERVIEW.enjoyment,
      goal_understood: GROK_V2_INTERVIEW.goal_understood,
      got_stuck: GROK_V2_INTERVIEW.got_stuck,
      confusions: GROK_V2_INTERVIEW.confusions,
      bugs: GROK_V2_INTERVIEW.bugs,
      best_moment: GROK_V2_INTERVIEW.best_moment,
      worst_moment: GROK_V2_INTERVIEW.worst_moment,
      would_replay: GROK_V2_INTERVIEW.would_replay,
      verdict: GROK_V2_INTERVIEW.verdict,
    });
    expect(saved.record.journey_receipt).toEqual(GROK_V2_INTERVIEW.journey_exit_receipt);
    expect(saved.record.model).toMatchObject({
      id: "grok-4.6",
      settings: { reasoning_effort: "low" },
    });
    const roundTrip = readPlaytestSession(saved.dir);
    expect(roundTrip.record.exit_interview).toEqual(saved.record.exit_interview);
    expect(roundTrip.record.journey_receipt).toEqual(saved.record.journey_receipt);
  });

  it("binds a completed report to the server session, seed, build, and receipt", () => {
    const store = tempDir();
    const saved = saveGrokReport(store, grokReport(GROK_V2_INTERVIEW), 11, grokEvidence(11));
    expect(saved.record.outcome).toBe("completed");
    expect(saved.record.game_session_id).toBe("o-test-11");
    expect(saved.record.run_seed).toBe(11);
    expect(saved.record.build).toEqual({
      git_commit: "a".repeat(40),
      tracked_worktree_clean: true,
      world_id: "new_york_overworld",
      world_hash: "b".repeat(64),
    });
  });

  it("does not record a plain json fence as a completed interview-bearing session", () => {
    const store = tempDir();
    const saved = saveGrokReport(store, grokReport(GROK_V2_INTERVIEW, "json"), 12);
    expect(saved.record.outcome).toBe("malformed_report");
    expect(saved.record.exit_interview).toBeNull();
    expect(saved.extract.ok).toBe(false);
  });

  it("does not record missing subjective fields as completed", () => {
    const store = tempDir();
    const { clarity: _clarity, ...incomplete } = GROK_V2_INTERVIEW;
    const saved = saveGrokReport(store, grokReport(incomplete), 13);
    expect(saved.record.outcome).toBe("malformed_report");
    expect(saved.record.exit_interview).toBeNull();
  });

  it("does not record trailing text after the interview fence as completed", () => {
    const store = tempDir();
    const saved = saveGrokReport(
      store,
      grokReport(GROK_V2_INTERVIEW, "json exit-interview", "USAGE NOTES: 1\n"),
      14,
    );
    expect(saved.record.outcome).toBe("malformed_report");
    expect(saved.record.exit_interview).toBeNull();
  });

  it("still writes a session when the player times out without a valid interview", () => {
    const store = tempDir();
    const saved = savePlaytestReport({
      reportText: "Playthrough log\nTimed out before exitReceipt.\n",
      transcript: "timed out\n",
      store,
      providerId: "grok_cli",
      modelId: "grok-4.6",
      seed: 15,
      gameSessionId: "o-test-15",
      attestedBy: "qa-test",
      method: "unit test, AdventureForge MCP only",
      recordedAt: "2026-08-29T12:00:00.000Z",
      requestedOutcome: "timed_out",
      buildCommit: "a".repeat(40),
      trackedWorktreeClean: true,
    });
    expect(saved.record.outcome).toBe("timed_out");
    expect(saved.record.exit_interview).toBeNull();
    expect(readPlaytestSession(saved.dir).record.outcome).toBe("timed_out");
    expect(readPlaytestSession(saved.dir).record.exit_interview).toBeNull();
  });

  it("still writes a session when the player fails without a valid interview", () => {
    const store = tempDir();
    const saved = savePlaytestReport({
      reportText: "",
      transcript: '{"type":"adventureforge_grok_harness","stderr":"spawn grok ENOENT"}\n',
      store,
      providerId: "grok_cli",
      modelId: "grok-4.6",
      seed: 16,
      gameSessionId: "unknown-grok-wave-16",
      attestedBy: "qa-test",
      method: "unit test, AdventureForge MCP only",
      recordedAt: "2026-08-29T12:00:00.000Z",
      requestedOutcome: "failed",
      buildCommit: "a".repeat(40),
      trackedWorktreeClean: true,
    });
    expect(saved.record.outcome).toBe("failed");
    expect(saved.record.exit_interview).toBeNull();
    const roundTrip = readPlaytestSession(saved.dir);
    expect(roundTrip.record.outcome).toBe("failed");
    expect(roundTrip.record.exit_interview).toBeNull();
    expect(roundTrip.transcript).toContain("spawn grok ENOENT");
  });
});

// `qa/tickets/` is tracked, and until this rule existed nothing ever left it: triage
// carried every prior ticket forward unconditionally, so four playtest waves grew the
// bucket to 633 files — every one `stale`, therefore invisible to the dev loop, and
// 27% of the repository's tracked file count for 3% of its bytes. These tests pin both
// halves of the rule: what retires, and the much longer list of what may not.
describe("retiring aged-out tickets so the bucket stays bounded", () => {
  const transcript = "line one\nline two\n";

  function prior(over: Partial<QaTicket> = {}): QaTicket {
    return {
      schema_version: 1,
      ticket_id: "9".repeat(16),
      title: "an old finding nobody is chasing",
      kind: "bug",
      severity: "S2",
      status: "stale",
      promotion: "accumulating",
      location: "somewhere_else",
      excerpts: [],
      evidence: {
        report_count: 1,
        families: ["gpt"],
        providers: ["codex"],
        tiers: ["volume"],
        has_runner_enforced_report: true,
        session_ids: ["s"],
        first_seen_build: "b".repeat(40),
        last_seen_build: "b".repeat(40),
        first_seen_at: "2026-08-01T12:00:00.000Z",
        last_seen_at: "2026-08-01T12:00:00.000Z",
      },
      priority: 4,
      ...over,
    };
  }

  /** Triage over a corpus that reports one real finding, plus the given prior tickets. */
  function reTriage(existingTickets: readonly QaTicket[]) {
    const store = tempDir();
    writePlaytestSession(store, sealPlaytestSession(body()), transcript);
    return triagePlaytestCorpus({
      sessions: listPlaytestSessions(store).entries.map((entry) => entry.record),
      locationIndex: buildLocationIndex(process.cwd()),
      buildHistory: ["a".repeat(40)],
      existingTickets,
    });
  }

  it("drops a stale ticket the corpus no longer mentions", () => {
    const { tickets, stats } = reTriage([prior()]);
    expect(stats.retired).toBe(1);
    expect(tickets.map((t) => t.ticket_id)).not.toContain("9".repeat(16));
  });

  // Everything below is a way of saying "this file holds something re-triage cannot
  // rebuild". Each one is a separate way the old unconditional carry-forward was right.
  it("keeps a stale ticket carrying a human's notes", () => {
    const { tickets, stats } = reTriage([prior({ notes: "waiting on the map rewrite" })]);
    expect(stats.retired).toBe(0);
    expect(tickets.map((t) => t.ticket_id)).toContain("9".repeat(16));
  });

  it.each(["open", "in_progress", "fixed", "verified_fixed", "wont_fix"] as const)(
    "keeps a ticket in the %s state, which is somebody's live position",
    (status) => {
      const { tickets, stats } = reTriage([prior({ status })]);
      expect(stats.retired).toBe(0);
      expect(tickets.map((t) => t.ticket_id)).toContain("9".repeat(16));
    },
  );

  // The dangerous case. Triage runs routinely against a store that is empty or holds
  // only one machine's shard — a fresh clone, a lane worktree, a half-synced corpus —
  // and there EVERY ticket looks like it went quiet. Retiring on that evidence would
  // empty the bucket in a single pass.
  it("retires nothing when the corpus itself produced no clusters", () => {
    const { tickets, stats } = triagePlaytestCorpus({
      sessions: [],
      locationIndex: buildLocationIndex(process.cwd()),
      buildHistory: ["a".repeat(40)],
      existingTickets: [prior(), prior({ ticket_id: "8".repeat(16) })],
    });
    expect(stats.clusters).toBe(0);
    expect(stats.retired).toBe(0);
    expect(tickets).toHaveLength(2);
  });

  // Retirement is not a decision about the finding, only about the file. Fresh evidence
  // revives the ticket at its original id, so a recurrence costs nothing.
  it("rebuilds the same ticket id when the finding comes back", () => {
    const first = reTriage([]);
    expect(first.tickets.length).toBeGreaterThan(0);
    const ids = first.tickets.map((t) => t.ticket_id);

    const again = reTriage(first.tickets.map((t) => ({ ...t, status: "stale" as const })));
    // Present in the current corpus, so each revives rather than retires.
    expect(again.stats.retired).toBe(0);
    expect(again.tickets.map((t) => t.ticket_id)).toEqual(ids);
    expect(again.tickets.every((t) => t.status === "open")).toBe(true);
  });
});

// bug_0650 / bug_0651. Playtests run on lane branches, and a squash-merge replaces every
// lane commit, so the build a session recorded routinely vanishes from `git log`. That
// build used to be exempt from aging forever, and a carried-forward `open` ticket was
// never re-aged at all — so neither kind of ticket could ever leave the dev loop's view.
describe("aging a finding the build history cannot place", () => {
  const transcript = "line one\nline two\n";
  const HEAD = "a".repeat(40);
  /** A lane commit its squash-merge replaced: real once, absent from history now. */
  const SQUASHED = "d".repeat(40);
  /** Newest first, STALE_AFTER_BUILDS + 2 long, so index 9 is past the threshold. */
  const WINDOW = [HEAD, ...Array.from({ length: 9 }, (_, i) => String(i + 1).repeat(40))];

  function sessionOn(build: string) {
    const store = tempDir();
    const played = body();
    writePlaytestSession(
      store,
      sealPlaytestSession({ ...played, build: { ...played.build, git_commit: build } }),
      transcript,
    );
    return listPlaytestSessions(store).entries.map((entry) => entry.record);
  }

  function carried(over: Partial<QaTicket> = {}): QaTicket {
    return {
      schema_version: 2,
      ticket_id: "7".repeat(16),
      title: "a finding the corpus stopped mentioning",
      kind: "bug",
      severity: "S3",
      status: "open",
      promotion: "corroborated",
      location: "somewhere_else",
      excerpts: [],
      evidence: {
        report_count: 2,
        families: ["claude", "gpt"],
        providers: ["claude_code", "codex"],
        tiers: ["volume"],
        has_runner_enforced_report: true,
        session_ids: ["s1", "s2"],
        first_seen_build: SQUASHED,
        last_seen_build: SQUASHED,
        first_seen_at: "2026-08-31T12:00:00.000Z",
        last_seen_at: "2026-08-31T12:00:00.000Z",
      },
      priority: 6,
      ...over,
    };
  }

  function triage(input: Partial<Parameters<typeof triagePlaytestCorpus>[0]>) {
    return triagePlaytestCorpus({
      sessions: sessionOn(HEAD),
      locationIndex: buildLocationIndex(process.cwd()),
      buildHistory: WINDOW,
      ...input,
    });
  }

  const find = (tickets: readonly QaTicket[], id = "7".repeat(16)) =>
    tickets.find((t) => t.ticket_id === id);

  it("ages a fresh cluster whose build a complete history does not contain", () => {
    const { tickets, stats } = triage({ sessions: sessionOn(SQUASHED) });
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets.every((t) => t.status === "stale")).toBe(true);
    expect(stats.stale).toBe(tickets.length);
  });

  it("keeps the benefit of the doubt when the history is truncated", () => {
    const shallow = triage({ sessions: sessionOn(SQUASHED), buildHistoryTruncated: true });
    expect(shallow.tickets.every((t) => t.status === "open")).toBe(true);
    // No history at all is truncated by definition, whatever the flag says.
    const none = triage({ sessions: sessionOn(SQUASHED), buildHistory: [] });
    expect(none.tickets.every((t) => t.status === "open")).toBe(true);
  });

  it("still exempts a verified finding, whose reproduction does not decay", () => {
    const id = triage({ sessions: sessionOn(SQUASHED) }).tickets[0]!.ticket_id;
    const stamped = triage({
      sessions: sessionOn(SQUASHED),
      verifiedTicketIds: [id],
      verifiedBy: "tests/regression/some_repro.test.ts",
    });
    expect(find(stamped.tickets, id)).toMatchObject({ status: "open", promotion: "verified" });
  });

  it("re-ages a carried-forward open ticket, then retires it on a later pass", () => {
    const first = triage({ existingTickets: [carried()] });
    expect(find(first.tickets)).toMatchObject({ status: "stale" });
    // Aged and retired are never the same pass: the next reader still sees it go stale.
    expect(first.stats.retired).toBe(0);

    const second = triage({ existingTickets: first.tickets });
    expect(second.stats.retired).toBe(1);
    expect(find(second.tickets)).toBeUndefined();
  });

  it("ages a carried-forward ticket by distance when history does contain its build", () => {
    const at = (index: number) =>
      find(
        triage({
          existingTickets: [
            carried({ evidence: { ...carried().evidence, last_seen_build: WINDOW[index]! } }),
          ],
        }).tickets,
      )!.status;
    expect(at(8)).toBe("open"); // exactly STALE_AFTER_BUILDS back: not yet
    expect(at(9)).toBe("stale");
  });

  it("does not age a carried-forward ticket someone claimed, verified, or decided", () => {
    for (const over of [
      { status: "in_progress" as const },
      { verified_by: "tests/regression/some_repro.test.ts", promotion: "verified" as const },
      { status: "wont_fix" as const },
    ]) {
      const ticket = carried(over);
      expect(find(triage({ existingTickets: [ticket] }).tickets)).toEqual(ticket);
    }
  });

  it("does not age a carried-forward ticket against a truncated history", () => {
    const { tickets } = triage({ existingTickets: [carried()], buildHistoryTruncated: true });
    expect(find(tickets)).toEqual(carried());
  });
});

// bug_0652. `--verified <id>` only ever reached tickets the CURRENT corpus clustered; one
// carried forward from the bucket was written back unstamped, and nothing said so.
describe("stamping a reproduction on a ticket the corpus no longer mentions", () => {
  const ID = "7".repeat(16);

  function carried(over: Partial<QaTicket> = {}): QaTicket {
    return {
      schema_version: 2,
      ticket_id: ID,
      title: "a finding reproduced after its reports aged out",
      kind: "bug",
      severity: "S3",
      status: "stale",
      promotion: "accumulating",
      location: "steading_yard",
      excerpts: [],
      evidence: {
        report_count: 2,
        families: ["claude"],
        providers: ["claude_code"],
        tiers: ["volume"],
        has_runner_enforced_report: true,
        session_ids: ["s1", "s2"],
        first_seen_build: "d".repeat(40),
        last_seen_build: "d".repeat(40),
        first_seen_at: "2026-08-31T12:00:00.000Z",
        last_seen_at: "2026-08-31T12:00:00.000Z",
      },
      priority: 6,
      ...over,
    };
  }

  function stamp(existingTickets: readonly QaTicket[], ids: readonly string[]) {
    return triagePlaytestCorpus({
      sessions: [],
      locationIndex: buildLocationIndex(process.cwd()),
      buildHistory: ["a".repeat(40)],
      existingTickets,
      verifiedTicketIds: ids,
      verifiedBy: "tests/regression/some_repro.test.ts",
    });
  }

  it("stamps it, promotes it to verified, and revives it from stale", () => {
    const result = stamp([carried()], [ID]);
    expect(result.unmatchedVerifiedIds).toEqual([]);
    const ticket = result.tickets.find((t) => t.ticket_id === ID)!;
    expect(ticket).toMatchObject({
      status: "open",
      promotion: "verified",
      verified_by: "tests/regression/some_repro.test.ts",
    });
    expect(isActionable(ticket)).toBe(true);
    expect(QaTicketSchema.parse(ticket)).toEqual(ticket);
  });

  it("leaves a decision in place while still recording the reproduction", () => {
    const ticket = stamp([carried({ status: "wont_fix" })], [ID]).tickets[0]!;
    expect(ticket).toMatchObject({ status: "wont_fix", promotion: "verified" });
  });

  it("names every id that matched nothing, including a superseded identity", () => {
    const superseded = carried({ ticket_id: "6".repeat(16), superseded_by: ["5".repeat(16)] });
    const result = stamp([carried(), superseded], [ID, "6".repeat(16), "not-a-ticket"]);
    expect(result.unmatchedVerifiedIds).toEqual(["6".repeat(16), "not-a-ticket"]);
    expect(result.tickets.find((t) => t.ticket_id === "6".repeat(16))!.verified_by).toBe(undefined);
  });
});

/**
 * Unmapped findings: one bucket, and content still decides.
 *
 * A player's `where` that resolves to no known place used to become the ticket's location
 * AND part of its id, so one defect described in two people's words became two tickets of
 * one report each, neither able to corroborate the other — the shape audit item
 * dcaefa368898e77c records. They now share the `unmapped` bucket; the severity band and
 * token tests are untouched, so the bucket only makes them ELIGIBLE to be compared.
 */
describe("unmapped findings cluster on content, not on phrasing", () => {
  const transcript = "line one\nline two\n";

  function ticketsFor(interviews: readonly PlaytestSessionBody["exit_interview"][]) {
    const store = tempDir();
    interviews.forEach((interview, index) => {
      writePlaytestSession(
        store,
        sealPlaytestSession(body({ exit_interview: interview, run_seed: 900 + index })),
        transcript,
      );
    });
    return triagePlaytestCorpus({
      sessions: listPlaytestSessions(store).entries.map((entry) => entry.record),
      locationIndex: buildLocationIndex(process.cwd()),
      buildHistory: ["a".repeat(40)],
    }).tickets;
  }

  /** A `where` string that deliberately resolves to nothing. */
  const NOWHERE_A = "the tutorial's closing summary screen, wherever that lives";
  const NOWHERE_B = "somewhere in the opening tutorial text, no idea what it is called";

  it("MUST MERGE: a bug and a confusion of the same band and tokens become one ticket", () => {
    // The must-merge case, and the tutorial finding that prompted it: one player filed the
    // same complaint in both lists. Both unmapped, an S1 bug (the interview's own "minor"
    // rung) against the S1 confusion rung so the severity BAND matches, and the same
    // leading tokens so the fingerprint matches. `clusterKind` takes the stronger reading.
    //
    // The bug's note deliberately differs from the confusion by its tail. Making the two
    // strings character-identical instead trips a documented collision in `issueKey`
    // (ref + text), which files the bug as its own confusion and reads the merged cluster
    // as `experience` — a real behaviour, but not the one under test here.
    const tickets = ticketsFor([
      {
        ...INTERVIEW,
        confusions: ["tutorial says gallowmere is the final optional chapter"],
        bugs: [
          {
            where: NOWHERE_A,
            severity: "S1" as const,
            note: "tutorial says gallowmere is the final optional chapter, yet a third opened",
          },
        ],
      },
    ]);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.kind).toBe("bug");
    expect(tickets[0]!.location).toBe("unmapped");
    expect(tickets[0]!.evidence.report_count).toBe(2);
  });

  it("keeps the player's `where` in the excerpts once it is no longer the label", () => {
    const tickets = ticketsFor([
      {
        ...INTERVIEW,
        confusions: [],
        bugs: [
          {
            where: NOWHERE_A,
            severity: "S1" as const,
            note: "the closing summary omits the score",
          },
        ],
      },
    ]);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.location).toBe("unmapped");
    // Leads, because a reader scanning the bucket wants the place before the complaint.
    expect(tickets[0]!.excerpts[0]).toBe(NOWHERE_A);
    expect(tickets[0]!.excerpts).toContain("the closing summary omits the score");
  });

  it("MUST NOT MERGE: same bucket, different fingerprint stays two tickets", () => {
    // The guard. Nothing about the content tests was loosened to get the merge above, so
    // two unrelated unresolved problems remain two pieces of work.
    const tickets = ticketsFor([
      {
        ...INTERVIEW,
        confusions: [],
        bugs: [
          {
            where: NOWHERE_A,
            severity: "S1" as const,
            note: "the closing summary omits the score",
          },
          {
            where: NOWHERE_B,
            severity: "S1" as const,
            note: "a merchant charged me twice for one lantern",
          },
        ],
      },
    ]);
    expect(tickets).toHaveLength(2);
    expect(new Set(tickets.map((ticket) => ticket.ticket_id)).size).toBe(2);
  });

  it("two players who phrase one unmapped defect differently now corroborate", () => {
    // The behaviour dcaefa368898e77c is about: before the bucket, these were two tickets
    // of one report each and neither could ever reach a promotion rung.
    const confusion = "tutorial framed gallowmere as the final chapter but more followed";
    const tickets = ticketsFor([
      { ...INTERVIEW, confusions: [confusion], bugs: [] },
      { ...INTERVIEW, confusions: [confusion], bugs: [] },
    ]);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.evidence.report_count).toBe(2);
    expect(tickets[0]!.evidence.session_ids).toHaveLength(2);
  });
});

/**
 * End to end: two players reporting one pattern about the whole game now reach each other.
 *
 * The wording here is taken from the live corpus. Before the global scope rung these two
 * resolved to `factors_mark` and `unmapped` — two different buckets, two singletons,
 * neither able to corroborate the other no matter how many players agreed. Cross-cutting
 * findings (pacing, repetition, difficulty curve, tone) all have this shape, and they are
 * the findings a mature playtest corpus should be best at surfacing.
 */
describe("cross-cutting findings corroborate each other", () => {
  const transcript = "line one\nline two\n";

  function ticketsFor(interviews: readonly PlaytestSessionBody["exit_interview"][]) {
    const store = tempDir();
    interviews.forEach((interview, index) => {
      writePlaytestSession(
        store,
        sealPlaytestSession(body({ exit_interview: interview, run_seed: 700 + index })),
        transcript,
      );
    });
    return triagePlaytestCorpus({
      sessions: listPlaytestSessions(store).entries.map((entry) => entry.record),
      locationIndex: buildLocationIndex(process.cwd()),
      buildHistory: ["a".repeat(40)],
    }).tickets;
  }

  const SAME_COMPLAINT =
    "every quest runs the same skeleton: gather optional bonuses, one linear gauntlet, one final choice";

  it("MUST MERGE: two multi-quest reports of one pattern become one ticket", () => {
    const tickets = ticketsFor([
      {
        ...INTERVIEW,
        confusions: [],
        bugs: [
          {
            where: "General quest structure, Wolf-Winter through The Factor's Mark",
            severity: "S1" as const,
            note: SAME_COMPLAINT,
          },
        ],
      },
      {
        ...INTERVIEW,
        confusions: [],
        bugs: [
          {
            where: "Quest structure across The Tanner's Fever / The Breaking Weir / The Cold Forge",
            severity: "S1" as const,
            note: SAME_COMPLAINT,
          },
        ],
      },
    ]);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.location).toBe("global");
    expect(tickets[0]!.evidence.report_count).toBe(2);
    expect(tickets[0]!.evidence.session_ids).toHaveLength(2);
    // The `where` each player wrote survives, since it is no longer the label.
    expect(tickets[0]!.excerpts.join(" ")).toContain("Wolf-Winter");
  });

  it("MUST NOT MERGE: the same complaint about ONE quest stays its own ticket", () => {
    const tickets = ticketsFor([
      {
        ...INTERVIEW,
        confusions: [],
        bugs: [
          {
            where: "General quest structure, Wolf-Winter through The Factor's Mark",
            severity: "S1" as const,
            note: SAME_COMPLAINT,
          },
        ],
      },
      {
        ...INTERVIEW,
        confusions: [],
        bugs: [{ where: "steading_yard", severity: "S1" as const, note: SAME_COMPLAINT }],
      },
    ]);
    expect(tickets).toHaveLength(2);
    expect(tickets.map((t) => t.location).sort()).toEqual(["global", "steading_yard"]);
  });
});
