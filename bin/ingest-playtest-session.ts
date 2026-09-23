#!/usr/bin/env -S npx tsx
/**
 * Ingest a playtest session that the runner did not launch.
 *
 * This is the path for any session that the repository's runner did not launch. A human
 * plays through a desktop, web, or unsupported CLI client wired to the AdventureForge
 * MCP server, saves the transcript and exit interview, and this turns them into a
 * first-class session record in the same corpus the automated cohorts write to.
 *
 * The one thing it will not do is lie about provenance. A session ingested this way is
 * stamped `operator_attested`, and the attestation naming who vouched for the tool
 * boundary is REQUIRED, not optional. Such a session counts fully toward bug
 * corroboration and frequency — a human playing the real game is a real player — but it
 * is excluded from experience METRICS by `countsTowardExperienceMetrics`, because no
 * code in this repo watched that client and none can claim it was blind.
 *
 * Usage:
 *   npm run playtest:ingest -- \
 *     --provider grok_desktop --model grok-4.6 --persona default \
 *     --seed 1234 --game-session-id o-… \
 *     --transcript run.jsonl --report report.md \
 *     --attested-by "michael" --method "desktop client, AdventureForge MCP only"
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashState } from "../src/core/hash.js";
import {
  ExitInterviewSchema,
  JourneyExitReceiptSchema,
  SubjectiveExitInterviewSchema,
} from "../src/blind/exit_interview.js";
import { savePlaytestReport } from "../src/qa/save_playtest_report.js";
import {
  findCatalogModel,
  findPlaytestProvider,
  parsePlaytestCatalog,
  playtestProviderIds,
} from "../src/blind/providers.js";
import { parseOverworldManifest } from "../src/world/overworld.js";
import {
  PlaytestOutcomeSchema,
  sealPlaytestSession,
  type PlaytestSessionBody,
} from "../src/qa/session_record.js";
import { DEFAULT_SESSION_STORE, sha256Hex, writePlaytestSession } from "../src/qa/session_store.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORLD_PATH = join(REPO_ROOT, "content/world/new_york_overworld.json");
const PERSONA_DIR = join(REPO_ROOT, "blind-tester/personas");

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function required(flag: string): string {
  const value = arg(flag);
  if (value === null) throw new Error(`${flag} is required`);
  return value;
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function main(): void {
  const providerId = required("--provider");
  const provider = findPlaytestProvider(providerId);
  if (!provider) {
    throw new Error(
      `unknown provider "${providerId}"; registered providers: ${playtestProviderIds().join(", ")}`,
    );
  }

  const catalog = parsePlaytestCatalog(
    provider,
    JSON.parse(readFileSync(join(REPO_ROOT, provider.catalogPath), "utf8")),
  );
  const model = findCatalogModel(catalog, required("--model"));

  // The persona's CONTENT is hashed, not just its name, so a session stays
  // interpretable after the persona prose is later edited.
  const personaId = arg("--persona") ?? "default";
  const personaPath = join(PERSONA_DIR, `${personaId}.md`);
  const personaText = readFileSync(personaPath, "utf8");
  const personaTitle = arg("--persona-title") ?? personaId;

  const transcriptPath = required("--transcript");
  const transcript = readFileSync(transcriptPath, "utf8");

  // Accept either a raw interview JSON or the protocol's markdown report, so an
  // operator can hand over whatever their client actually produced.
  const interviewFile = arg("--interview");
  const reportFile = arg("--report");
  let interview: PlaytestSessionBody["exit_interview"] = null;
  let receipt: PlaytestSessionBody["journey_receipt"] = null;
  let failureNote: string | null = null;

  /**
   * Split a parsed interview into the two things the record stores separately: the
   * player's subjective answers, and the game's own exit receipt. They are kept apart
   * because one is opinion and the other is server-authored fact — mixing them would
   * let a client's prose sit in a field the pipeline treats as evidence.
   */
  const absorb = (raw: unknown): void => {
    const parsed = ExitInterviewSchema.parse(raw);
    const subjectiveKeys = Object.keys(SubjectiveExitInterviewSchema.shape);
    const subjective: Record<string, unknown> = {};
    for (const key of subjectiveKeys) {
      if (key in (parsed as Record<string, unknown>)) {
        subjective[key] = (parsed as Record<string, unknown>)[key];
      }
    }
    interview = SubjectiveExitInterviewSchema.parse(subjective);
    const carried = (parsed as Record<string, unknown>).journey_exit_receipt;
    receipt = carried === undefined ? null : JourneyExitReceiptSchema.parse(carried);
  };

  if (interviewFile) {
    absorb(JSON.parse(readFileSync(interviewFile, "utf8")));
  } else if (reportFile) {
    const attestedByEarly = arg("--attested-by");
    if (attestedByEarly === null) {
      throw new Error(
        `--attested-by is required: a session ingested by hand was not launched by the runner, ` +
          `so it cannot be recorded as runner-enforced. Say who is vouching for the tool boundary ` +
          `(and pass --method describing how).`,
      );
    }
    const explicitOutcome = arg("--outcome");
    const recordedAt = arg("--recorded-at");
    const buildCommit = arg("--build-commit");
    const acceptedDecisions = arg("--accepted-decisions");
    const saved = savePlaytestReport({
      reportText: readFileSync(reportFile, "utf8"),
      transcript,
      store: arg("--store") ?? DEFAULT_SESSION_STORE,
      providerId,
      modelId: model.id,
      personaId,
      personaTitle,
      seed: Number.parseInt(required("--seed"), 10),
      gameSessionId: required("--game-session-id"),
      attestedBy: attestedByEarly,
      method: required("--method"),
      ...(recordedAt === null ? {} : { recordedAt }),
      ...(explicitOutcome === null
        ? {}
        : { requestedOutcome: PlaytestOutcomeSchema.parse(explicitOutcome) }),
      turns: Number.parseInt(arg("--turns") ?? "0", 10),
      acceptedDecisions: acceptedDecisions === null ? null : Number.parseInt(acceptedDecisions, 10),
      ...(buildCommit === null ? {} : { buildCommit }),
      transcriptFilename: basename(transcriptPath),
    });
    const record = saved.record;
    console.log(
      `Ingested ${record.record_id} (${record.provider.id}/${record.model.id}) → ${saved.dir}`,
    );
    console.log(
      `  isolation: ${record.provider.isolation}; outcome: ${record.outcome}; ` +
        `counts toward metrics: ${record.outcome === "completed" && record.provider.isolation === "runner_enforced"}`,
    );
    if (record.exit_interview === null) {
      console.log(
        `\n  ! No exit interview was captured, so this session contributes no issues to\n` +
          `    triage — it is stored as provenance only.\n` +
          `    reason: ${record.failure_note ?? "no report supplied"}\n` +
          `    Fix the report and re-run: the record is content-addressed, so re-ingesting\n` +
          `    the corrected one adds it rather than duplicating this.`,
      );
    }
    return;
  }

  const explicitOutcome = arg("--outcome");
  const outcome = explicitOutcome
    ? PlaytestOutcomeSchema.parse(explicitOutcome)
    : interview
      ? ("completed" as const)
      : ("malformed_report" as const);

  if (outcome !== "completed" && failureNote === null) {
    failureNote = arg("--failure-note") ?? `session recorded with outcome "${outcome}"`;
  }

  // An attestation is what makes a hand-played session honest, so it is also what
  // selects the evidence class. A provider the runner cannot launch at all always
  // requires one; a normally-runner-launched provider requires one HERE, because
  // arriving through this command is itself proof the runner did not launch it.
  const attestedBy = arg("--attested-by");
  if (attestedBy === null) {
    throw new Error(
      `--attested-by is required: a session ingested by hand was not launched by the runner, ` +
        `so it cannot be recorded as runner-enforced. Say who is vouching for the tool boundary ` +
        `(and pass --method describing how).`,
    );
  }
  const sessionIsolation = "operator_attested" as const;

  const world = parseOverworldManifest(JSON.parse(readFileSync(WORLD_PATH, "utf8")));
  const body: PlaytestSessionBody = {
    schema_version: 1,
    recorded_at: arg("--recorded-at") ?? new Date().toISOString(),
    game_session_id: required("--game-session-id"),
    run_seed: Number.parseInt(required("--seed"), 10),
    build: {
      git_commit: arg("--build-commit") ?? git(["rev-parse", "HEAD"]),
      tracked_worktree_clean: git(["status", "--porcelain"]).length === 0,
      world_id: world.id,
      world_hash: hashState(world),
    },
    provider: {
      id: provider.id,
      vendor: provider.vendor,
      family: provider.family,
      // Isolation is a property of THIS SESSION, not only of the provider.
      //
      // A registry entry says how that vendor is normally launched, but this command
      // exists precisely for sessions the runner did NOT launch. Reading isolation
      // straight off the registry would stamp a hand-played Claude Code session
      // `runner_enforced` — claiming the runner proved a tool boundary it never saw,
      // which is exactly the contamination the evidence classes exist to prevent.
      //
      // So the downgrade is always available and the upgrade never is: supplying an
      // attestation makes any session operator-attested, and no flag can make a session
      // runner-enforced. That asymmetry is the invariant — provenance can only ever be
      // weakened by hand, never strengthened.
      isolation: sessionIsolation,
      transport_contract: provider.transportContract,
      ...(sessionIsolation === "operator_attested"
        ? {
            operator_attestation: {
              attested_by: attestedBy!,
              method: required("--method"),
              attested_at: new Date().toISOString(),
            },
          }
        : {}),
    },
    model: { id: model.id, tier: model.tier, settings: model.settings },
    persona: { id: personaId, title: personaTitle, source_sha256: sha256Hex(personaText) },
    outcome,
    log: {
      turns: Number.parseInt(arg("--turns") ?? "0", 10),
      accepted_decisions: arg("--accepted-decisions")
        ? Number.parseInt(arg("--accepted-decisions")!, 10)
        : null,
      transcript_filename: basename(transcriptPath),
      transcript_sha256: sha256Hex(transcript),
      transcript_bytes: Buffer.byteLength(transcript, "utf8"),
    },
    exit_interview: interview,
    journey_receipt: receipt,
    failure_note: failureNote,
  };

  // A completed session must carry the game-returned receipt; without one the honest
  // label is `abandoned`, not `completed`. Say so rather than letting the schema throw
  // an error the operator cannot act on.
  if (body.outcome === "completed" && body.journey_receipt === null) {
    throw new Error(
      "a completed session needs the game-returned journey receipt: pass --interview with a report " +
        "containing journey_exit_receipt, or record this run with --outcome abandoned",
    );
  }

  const record = sealPlaytestSession(body);
  const store = arg("--store") ?? DEFAULT_SESSION_STORE;
  const dir = writePlaytestSession(store, record, transcript);
  console.log(`Ingested ${record.record_id} (${record.provider.id}/${record.model.id}) → ${dir}`);
  console.log(
    `  isolation: ${record.provider.isolation}; outcome: ${record.outcome}; ` +
      `counts toward metrics: ${record.outcome === "completed" && record.provider.isolation === "runner_enforced"}`,
  );

  // Say it plainly when the report did not verify.
  //
  // Keeping such a session is right — it is a real playthrough and often evidence of the
  // very confusion it failed to describe cleanly — but reporting it as a plain success is
  // not. Without an interview the record contributes NOTHING to triage: no issues, no
  // cluster, no ticket. Someone who hand-played for an hour, saw "Ingested …", and walked
  // away would never learn their evidence was inert, and this is the only path
  // non-Codex vendors have, so it is the path that must not fail quietly.
  if (record.exit_interview === null) {
    console.log(
      `\n  ! No exit interview was captured, so this session contributes no issues to\n` +
        `    triage — it is stored as provenance only.\n` +
        `    reason: ${record.failure_note ?? "no report supplied"}\n` +
        `    Fix the report and re-run: the record is content-addressed, so re-ingesting\n` +
        `    the corrected one adds it rather than duplicating this.`,
    );
  }
}

main();
