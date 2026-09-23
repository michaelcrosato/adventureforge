/**
 * `npm run doctor` — does this machine's setup actually work, and if nothing is queued,
 * why not?
 *
 * The questions it answers are the ones that went unanswered during a live two-loop
 * exercise: a whole run produced findings and promoted none of them, and no command
 * would say whether that was correct behaviour or a broken pipeline. Both present as an
 * empty queue. These tests pin that it distinguishes them, because a diagnostic that
 * says the same thing in both states is worse than none — it teaches you to ignore it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { onPath } from "../../bin/doctor.js";
import {
  derivePlaytestIsolation,
  PLAYTEST_PROVIDERS,
  type PlaytestIsolationReasonCode,
} from "../../src/blind/providers.js";
import { sealPlaytestSession, type PlaytestSessionBody } from "../../src/qa/session_record.js";
import { sha256Hex, writePlaytestSession } from "../../src/qa/session_store.js";
import { isActionable, QaTicketSchema, ticketFileName } from "../../src/qa/ticket.js";

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const TRANSCRIPT = "line one\nline two\n";
/**
 * The build these sessions played. It has to be a commit this checkout's history holds:
 * triage ages a finding whose build a complete history cannot place (bug_0650), and the
 * cases below are about fresh evidence, not stale evidence.
 */
const PLAYED_BUILD = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: ROOT,
  encoding: "utf8",
}).trim();

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** One session reporting the same defect, from whichever vendor the caller names. */
function session(over: {
  family: string;
  providerId: string;
  vendor: string;
  model: string;
  index: number;
}): PlaytestSessionBody {
  return {
    schema_version: 1,
    recorded_at: `2026-08-28T12:0${over.index}:00.000Z`,
    game_session_id: `o-${over.index}`,
    run_seed: 100 + over.index,
    build: {
      git_commit: PLAYED_BUILD,
      tracked_worktree_clean: true,
      world_id: "new_york_overworld",
      world_hash: "b".repeat(64),
    },
    provider: {
      id: over.providerId,
      vendor: over.vendor,
      family: over.family,
      isolation: "runner_enforced",
      transport_contract: "game-direct-mcp-v1",
    },
    model: { id: over.model, tier: "volume", settings: {} },
    persona: { id: "default", title: "default", source_sha256: "c".repeat(64) },
    outcome: "abandoned",
    log: {
      turns: 12,
      accepted_decisions: null,
      transcript_filename: "transcript.jsonl",
      transcript_sha256: sha256Hex(TRANSCRIPT),
      transcript_bytes: Buffer.byteLength(TRANSCRIPT, "utf8"),
    },
    exit_interview: {
      clarity: 3,
      enjoyment: 3,
      goal_understood: true,
      got_stuck: false,
      confusions: [],
      bugs: [
        {
          where: "quest wolf_winter, room steading_yard, blocked exit north",
          severity: "S3",
          note: "Blocked reason claims both approaches selected; exactly one was.",
        },
      ],
      best_moment: "the wolf fight",
      worst_moment: "the blocked exit",
      would_replay: true,
      verdict: "Playable, but the blocked-exit copy is wrong and misleads.",
    },
    journey_receipt: null,
    failure_note: "stopped early",
  };
}

function corpusOf(vendors: readonly { family: string; id: string; vendor: string }[]): string {
  const store = temp("af-doc-store-");
  vendors.forEach((v, index) => {
    writePlaytestSession(
      store,
      sealPlaytestSession(
        session({
          family: v.family,
          providerId: v.id,
          vendor: v.vendor,
          model: `${v.family}-model`,
          index,
        }),
      ),
      TRANSCRIPT,
    );
  });
  return store;
}

function run(script: string, args: readonly string[]): string {
  const result = spawnSync(process.execPath, [TSX, script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000,
  });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function diagnose(store: string): string {
  const tickets = temp("af-doc-t-");
  const queue = temp("af-doc-q-");
  run("bin/triage.ts", ["--store", store, "--tickets", tickets, "--queue", queue]);
  return run("bin/doctor.ts", ["--store", store, "--tickets", tickets, "--queue", queue]);
}

const CLAUDE = { family: "claude", id: "claude_code", vendor: "anthropic" };
const GEMINI = { family: "gemini", id: "gemini_cli", vendor: "google" };
const GPT = { family: "gpt", id: "codex", vendor: "openai" };

describe("doctor", () => {
  it("names the one vendor that can run live, so a cohort is planned on fact", () => {
    // The docs once claimed no vendor was privileged, alongside an example cohort in
    // which most players could not launch. This is where an operator finds out first.
    const output = run("bin/doctor.ts", ["--store", temp("af-doc-empty-")]);
    expect(output).toContain("runner_enforced");
    expect(output).toMatch(/codex/);
    expect(output).toContain("playtest:ingest");
  });

  /**
   * The table used to be driven by `const LIVE_LAUNCHABLE_PROVIDER = "codex"` — a
   * hand-written second copy of a rule src/blind/providers.ts already derives. Two
   * failures came out of that, and these three tests pin both shut.
   *
   * The first is drift: the constant could not notice a capture reader landing, so the
   * day a second vendor became provable this command would have gone on telling the
   * operator to hand-play it. The second is flattening: every non-Codex provider got the
   * SAME sentence, which turned four different situations into one unhelpful one.
   */
  it("prints each provider's derived reason verbatim, and no two providers share one", () => {
    const output = run("bin/doctor.ts", ["--store", temp("af-doc-empty-")]);
    const reasons = PLAYTEST_PROVIDERS.map((provider) => derivePlaytestIsolation(provider).reason);
    for (const reason of reasons) expect(output).toContain(reason);
    // Distinctness is the half that matters. Asserting only "each reason appears" would
    // stay green if the derivation started answering every provider with one shared
    // house sentence, which is precisely the state this replaced.
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it("gives each provider the sentence for ITS OWN reason class", () => {
    // Written out as literals rather than recomputed from derivePlaytestIsolation. A test
    // that builds its expectation with the same function the CLI calls cannot distinguish
    // "every provider printed its own answer" from "every provider printed one shared
    // answer", and that distinction is the entire point: two vendors can miss
    // `runner_enforced` for facts that imply completely different work. No capture block
    // means someone can go and write the reader; `desktop_client` means the runner never
    // sees the process at all, so no reader would help while it is registered that way.
    // The old `LIVE_LAUNCHABLE_PROVIDER` said "not codex" to both, which is neither.
    //
    // Keyed by reason CODE rather than by vendor id on purpose. Which vendor sits in
    // which class is a fact about this checkout that changes the day a reader lands —
    // that is the whole design — so pinning vendor names here would make doing the work
    // break the test that guards it.
    const phrases: Record<PlaytestIsolationReasonCode, string> = {
      runner_captures_this_vendor: "is a headless CLI whose session log is read by",
      kind_is_not_headless_cli: "which the runner never spawns",
      no_capture_block: "declares no capture block",
      capture_reader_module_missing: "does not exist in this checkout",
    };
    const output = run("bin/doctor.ts", ["--store", temp("af-doc-empty-")]);
    const codes = new Set<PlaytestIsolationReasonCode>();
    for (const provider of PLAYTEST_PROVIDERS) {
      const derived = derivePlaytestIsolation(provider);
      codes.add(derived.code);
      expect(derived.reason, `${provider.id} is in class ${derived.code}`).toContain(
        phrases[derived.code],
      );
      expect(output, `${provider.id} (${derived.code})`).toContain(derived.reason);
    }
    // And the table really is saying more than one thing today, so the assertions above
    // are not all checking the same sentence four times over.
    expect(codes.size, "the registry no longer exercises two isolation classes").toBeGreaterThan(1);
  });

  it("names each trusted vendor's OWN witness, never one shared claim", () => {
    // "Why is this one enforced?" is the same question as "why is that one not", and the
    // honest answer is a file path. A `runner_enforced` label with no witness named is
    // the exact failure src/blind/providers.ts exists to prevent, so the diagnostic
    // prints the module doing the witnessing — a different one per vendor, because they
    // are trusted on separate evidence rather than on one house policy.
    const output = run("bin/doctor.ts", ["--store", temp("af-doc-empty-")]);
    const enforced = PLAYTEST_PROVIDERS.map((provider) => derivePlaytestIsolation(provider)).filter(
      (derived) => derived.isolation === "runner_enforced",
    );
    expect(enforced.length).toBeGreaterThan(0);
    for (const derived of enforced) {
      expect(derived.readerModule).not.toBeNull();
      expect(output).toContain(derived.readerModule);
    }
    expect(new Set(enforced.map((derived) => derived.readerModule)).size).toBe(enforced.length);
  });

  it("says a single-family stall is correct, and what would actually change it", () => {
    const output = diagnose(corpusOf([CLAUDE, CLAUDE, CLAUDE]));
    // The distinction that matters: this is the rule working, not a fault.
    expect(output).toContain("That is a real state, not");
    expect(output).toContain("Add a SECOND model family");
    expect(output).toMatch(/families so far: claude/);
  });

  it("reports work waiting once a second family corroborates", () => {
    const output = diagnose(corpusOf([CLAUDE, GEMINI, GPT]));
    expect(output).toContain("The dev loop has work");
    expect(output).not.toContain("Add a SECOND model family");
  });

  it("does not cry clustering-bug on a single session", () => {
    // With one session every ticket has exactly one report by construction, so the
    // non-merging heuristic must stay silent or it teaches you to ignore it.
    const output = diagnose(corpusOf([CLAUDE]));
    expect(output).not.toContain("nothing merged at all");
  });

  // The failure this pair exists for, from the 2026-09-02 audit. A 100-player wave
  // produced 633 committed tickets; 351 reached `corroborated` and were then aged out to
  // `stale`. `isActionable` is a CONJUNCTION, so the dev loop could work none of them and
  // `qa:triage` promoted zero — while doctor filtered on promotion alone and printed
  // "351 actionable", then hit an open AUDIT item and stopped at "✓ The dev loop has
  // work". The one command whose stated job is "if nothing is queued, why not" reported
  // a healthy flywheel over a dead one, for hundreds of tickets.
  function stalledBucket(): { tickets: string; queue: string } {
    const tickets = temp("af-doc-stale-t-");
    // State the premise here rather than borrowing a ticket out of `qa/tickets/`.
    // Reading the live bucket coupled these two cases to whatever the committed corpus
    // happened to hold, and the corpus is explicitly transient: `isRetireable` deletes
    // aged-out tickets, so the retirement pass emptied the bucket of `.json` files and
    // `real[0]!` became `undefined` — the fixture crashed on a TypeError before either
    // assertion ran. A checkout with no tickets is a legitimate state, not a broken one.
    const ticket = QaTicketSchema.parse({
      schema_version: 1,
      ticket_id: "1b46b06b7e15e3f7",
      title: "Consequence text duplicated 'Cost: 10 minutes and $0'.",
      kind: "bug",
      severity: "S0",
      status: "stale",
      promotion: "corroborated",
      location: "Road Warden quick-setup confirmation",
      excerpts: ["Consequence text duplicated 'Cost: 10 minutes and $0'."],
      evidence: {
        report_count: 1,
        families: ["grok"],
        providers: ["grok_cli"],
        tiers: ["reference"],
        has_runner_enforced_report: false,
        session_ids: ["552bb45331836c2fcdd55acb8943c0ae07e60ab3e71ec7f62e3d40ce0ae69c19"],
        first_seen_build: "fe2619a884e55cf24175d91764f030f07ff0ec9c",
        last_seen_build: "fe2619a884e55cf24175d91764f030f07ff0ec9c",
        first_seen_at: "2026-08-31T01:10:41.260Z",
        last_seen_at: "2026-08-31T01:10:41.260Z",
      },
      priority: 3,
    });
    // Guard the premise with the predicate under test rather than with a status string:
    // corroborated, and still not actionable. `QaTicketSchema.parse` keeps the fixture
    // honest against the real shape — the reason the live bucket was read in the first
    // place — and `isActionable` is the conjunction these two cases are about, so if it
    // ever stops excluding a stale ticket this fails here instead of going vacuous.
    expect(ticket.promotion).toBe("corroborated");
    expect(isActionable(ticket)).toBe(false);
    writeFileSync(join(tickets, ticketFileName(ticket)), JSON.stringify(ticket), "utf8");
    return { tickets, queue: temp("af-doc-stale-q-") };
  }

  it("counts a corroborated-but-stale ticket as NOT actionable", () => {
    const { tickets, queue } = stalledBucket();
    const output = run("bin/doctor.ts", [
      "--store",
      temp("af-doc-empty-"),
      "--tickets",
      tickets,
      "--queue",
      queue,
    ]);

    expect(output).toMatch(/tickets 1 \(0 actionable\)/);
    expect(output).toContain("aged out");
    // The corroboration advice is for a DIFFERENT stall and would be wrong here: this
    // ticket already corroborated.
    expect(output).not.toContain("Add a SECOND model family");
  });

  it("does not let an open audit item hide a playtest bucket that promotes nothing", () => {
    const { tickets, queue } = stalledBucket();
    run("bin/submit.ts", [
      "--source",
      "audit",
      "--kind",
      "bug",
      "--title",
      "an unrelated audit chore",
      "--body",
      "not from a playtest",
      "--queue",
      queue,
    ]);

    const output = run("bin/doctor.ts", [
      "--store",
      temp("af-doc-empty-"),
      "--tickets",
      tickets,
      "--queue",
      queue,
    ]);

    // The queue genuinely has work, so the checkmark is honest and stays...
    expect(output).toContain("The dev loop has work");
    // ...but it must no longer END the report and swallow the reason.
    expect(output).toContain("Not from the playtest side");
    expect(output).toContain("aged out");
  });

  it("distinguishes an empty corpus from a stalled one", () => {
    const output = run("bin/doctor.ts", [
      "--store",
      temp("af-doc-empty-"),
      "--tickets",
      temp("af-doc-t-"),
      "--queue",
      temp("af-doc-q-"),
    ]);
    expect(output).toContain("No sessions yet");
    expect(output).not.toContain("Add a SECOND model family");
  });
});

describe("onPath", () => {
  /**
   * This resolved NOTHING on Windows. onPath shelled `command -v <bin>` with
   * `shell: true`, which spawns cmd.exe, where `command` is not a builtin — so the call
   * threw for every binary and the function returned false unconditionally. The one
   * command whose job is to say what an operator can launch reported that they could
   * launch nothing, on the platform where that answer is hardest to check by hand.
   *
   * `node` is the honest probe: this suite is running under it, so it is on PATH by
   * construction on every platform, and the old implementation still said it was not.
   */
  it("finds an executable that is definitely on PATH", () => {
    expect(onPath("node")).toBe(true);
  });

  it("does not invent one that is not", () => {
    expect(onPath("adventureforge-definitely-not-a-real-binary")).toBe(false);
  });

  it("survives a PATH containing empty and quoted entries", () => {
    const original = process.env.PATH;
    try {
      process.env.PATH = `${original ?? ""}${delimiter}${delimiter}"${tmpdir()}"`;
      expect(onPath("node")).toBe(true);
      expect(onPath("adventureforge-definitely-not-a-real-binary")).toBe(false);
    } finally {
      process.env.PATH = original;
    }
  });
});

/**
 * The cohort preflight in playtest-loop.sh was the THIRD hand-written copy of the
 * launchability policy — `[[ "$provider" != "codex" ]]` — and it is pinned in THIS file
 * because it is now the same derived fact `npm run doctor` reports. One rule with two
 * consumers, pinned in one place, is what stops it quietly becoming two rules again.
 *
 * The shell is exercised the way tests/regression/loop_driver_gates.test.ts exercises
 * loop.sh: the real text is cut out of the shipped file and run under `bash -s`, with a
 * stub substituted for the one function that shells out. Running playtest-loop.sh itself
 * is not an option — one step past this gate it dispatches a live, paid cohort.
 */
const LOOP_SH = readFileSync(join(ROOT, "playtest-loop.sh"), "utf8");
const GATE_ANCHOR = 'if [[ "$MOCK" != "1" ]]; then';

/** The exact shipped text between two anchors, so the test can never drift from the file. */
function loopSection(start: string, end: string): string {
  const from = LOOP_SH.indexOf(start);
  expect(from, `playtest-loop.sh no longer contains: ${start}`).toBeGreaterThanOrEqual(0);
  const to = LOOP_SH.indexOf(end, from);
  expect(to, `playtest-loop.sh no longer contains: ${end}`).toBeGreaterThan(from);
  return LOOP_SH.slice(from, to);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * One provider's `--records` answer, in the keys the shell actually reads.
 *
 * FOUR keys, not two, because launchability is two independent facts. `isolation` says
 * this vendor's blindness is PROVABLE here (a capture reader exists); `drivable` says
 * blind-tester/run.sh actually has a launch path for that reader. Gating on the first
 * alone dispatched a full wave of claude_code players the moment its reader landed, every
 * one of which run.sh then refused — a burned wave reported as a cohort of failures
 * rather than as the single configuration fact it was.
 */
function records(
  isolation: string,
  reason: string,
  drivable: "0" | "1" = "1",
  drivableReason: string = reason,
): string {
  return (
    `id\tstub\nisolation\t${isolation}\nisolation_reason\t${reason}\n` +
    `drivable\t${drivable}\ndrivable_reason\t${drivableReason}\n`
  );
}

/**
 * A bash stand-in for `provider_isolation`, the single point where the shell shells out.
 *
 * `null` means the resolver REFUSED this id — an unregistered provider, a broken catalog,
 * or the registry's stored isolation disagreeing with what this checkout derives. That
 * last one is the failure the whole derivation exists to catch, so the gate has to
 * survive it rather than read an unanswered question as a yes.
 */
function stubResolver(table: Record<string, string | null>): string {
  const arms = Object.entries(table).map(([id, answer]) =>
    answer === null
      ? `    ${id}) echo 'resolver refused ${id}' >&2; return 2 ;;`
      : `    ${id}) printf '%s' ${shellQuote(answer)} ;;`,
  );
  return [
    "provider_isolation() {",
    '  case "$1" in',
    ...arms,
    '    *) echo "the stub was asked about an unexpected id: $1" >&2; return 2 ;;',
    "  esac",
    "}",
  ].join("\n");
}

function runPreflight(
  cohort: string,
  stub: string,
  mock = "0",
): { status: number | null; output: string } {
  const script = [
    "set -uo pipefail",
    `COHORT=${shellQuote(cohort)}`,
    `MOCK=${shellQuote(mock)}`,
    // The real functions, then the stub overriding the one seam, then the real gate that
    // calls them. Order matters: the stub has to land after the definition it replaces
    // and before the caller.
    loopSection("provider_isolation() {", GATE_ANCHOR),
    stub,
    loopSection(GATE_ANCHOR, "# Model pin lookup:"),
  ].join("\n");
  const result = spawnSync("bash", ["-s"], {
    cwd: ROOT,
    input: script,
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`,
  };
}

const WITNESSED = records("runner_enforced", "the stub vendor's log is read by a stub reader");
/** A reason no file in this repo contains, so quoting it can only mean pass-through. */
const SENTINEL_REASON =
  'provider "stub_cli" names capture reader "blind-tester/nobody-wrote-this.mjs", which ' +
  "does not exist in this checkout, so no session of it can be witnessed";

describe("playtest-loop.sh cohort preflight", () => {
  it("is syntactically valid bash", () => {
    const result = spawnSync("bash", ["-n", "playtest-loop.sh"], { cwd: ROOT, encoding: "utf8" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("no longer decides launchability by comparing against a vendor name", () => {
    // The exact shape of the old gate. It could not notice a capture reader landing, so
    // it would have gone on refusing a vendor that had just become provable — making the
    // work of becoming provable pointless, which is the opposite of the intended incentive.
    expect(LOOP_SH).not.toContain('!= "codex"');
  });

  it("dispatches when every requested provider is one the runner can witness", () => {
    const result = runPreflight("stub_cli:4", stubResolver({ stub_cli: WITNESSED }));
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain("Refusing the cohort");
  });

  it("refuses a provable vendor the runner still has no launch path for", () => {
    // The second gate. This is the state claude_code was actually in the moment its
    // capture reader landed: blindness genuinely provable, no way to spawn it. Dispatching
    // here would launch players run.sh refuses one by one, and — worse — any session
    // assembled by another route would be sealed with the stronger evidence label.
    const NOT_DRIVABLE =
      'provider "stub_cli" has a capture reader (blind-tester/stub-reader.mjs) but ' +
      "blind-tester/run.sh has no launch path written against it yet";
    const result = runPreflight(
      "stub_cli:3",
      stubResolver({
        stub_cli: records("runner_enforced", "provable by the stub reader", "0", NOT_DRIVABLE),
      }),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(NOT_DRIVABLE);
  });

  it("refuses on the derivation's answer, and quotes its reason verbatim", () => {
    const result = runPreflight(
      "stub_cli:2",
      stubResolver({ stub_cli: records("operator_attested", SENTINEL_REASON) }),
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(SENTINEL_REASON);
    // And it stays as actionable as the sentence it replaced: where this evidence goes
    // instead, the free way to test the wiring with no vendor at all, and where to read
    // the current per-provider table rather than a copy of it pasted in here.
    expect(result.output).toContain("bin/ingest-playtest-session.ts");
    expect(result.output).toContain("PLAYTEST_MOCK=1");
    expect(result.output).toContain("npm run doctor");
  });

  it("refuses a provider it cannot resolve, surfacing the resolver's own words", () => {
    // An unanswered launchability question is not a yes. Continuing here would dispatch a
    // wave whose every player dies at launch, and the recorder cannot tell that from a
    // mid-play crash — so it would file each one as a `failed` session carrying a real
    // vendor family, seeding the corpus with evidence about nothing at all.
    const result = runPreflight("mystery:1", stubResolver({ mystery: null }));
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("resolver refused mystery");
    expect(result.output).toContain("could not be resolved");
  });

  it("names every blocked provider, once each, however many players were asked for", () => {
    const result = runPreflight(
      "stub_cli:3,stub_cli:2,other_cli:1,witness_cli:1",
      stubResolver({
        stub_cli: records("operator_attested", SENTINEL_REASON),
        other_cli: records("operator_attested", "other_cli has no capture block either"),
        witness_cli: WITNESSED,
      }),
    );
    expect(result.status, result.output).toBe(1);
    // Repeating one provider's reason per requested player would bury the second blocked
    // vendor under the first one's copies.
    expect(result.output.split(SENTINEL_REASON).length - 1).toBe(1);
    expect(result.output).toContain("other_cli has no capture block either");
  });

  it("still lets PLAYTEST_MOCK=1 past the gate — a wiring check launches no vendor", () => {
    // The mock wave drives run.sh's bundled scripted agent, so there is no client whose
    // blindness could be proved or doubted. Gating it would take the one free way to test
    // this loop's plumbing away from exactly the vendors that most need hand-play.
    const result = runPreflight(
      "stub_cli:8",
      stubResolver({ stub_cli: records("operator_attested", SENTINEL_REASON) }),
      "1",
    );
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain("Refusing the cohort");
  });

  it("reads keys the shipped resolver actually emits", () => {
    // The shell above is only honest if `--records` really carries these two keys, and
    // carries the same answer the typed authority gives. That seam runs between files
    // owned by different changes, so it gets its own pin instead of being assumed by the
    // stubs — a stub agreeing with itself proves nothing.
    const provider = PLAYTEST_PROVIDERS.find(
      (candidate) => derivePlaytestIsolation(candidate).isolation === "operator_attested",
    );
    expect(provider, "no operator_attested provider left to check the seam with").toBeDefined();
    const result = spawnSync(
      process.execPath,
      ["blind-tester/resolve-provider.mjs", "--records", provider!.id],
      { cwd: ROOT, encoding: "utf8", timeout: 120_000 },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const rows = new Map(
      (result.stdout ?? "")
        .split(/\r?\n/u)
        .filter((line) => line.includes("\t"))
        .map((line) => line.split("\t") as [string, string]),
    );
    const derived = derivePlaytestIsolation(provider!);
    expect(rows.get("isolation")).toBe(derived.isolation);
    expect(rows.get("isolation_reason")).toBe(derived.reason);
  });
});

/**
 * `PLAYTEST_NEW_BUILD_ONLY` — the loop's between-wave wait for a NEW build.
 *
 * A fixed `PLAYTEST_DELAY_SECONDS` is a guess about how fast the dev loop lands changes,
 * and it is wrong in both directions: too short and the corpus fills with repeat sessions
 * on a build nobody changed, too long and a freshly pushed build sits unplayed. The knob
 * waits for the EVENT instead, and uses time only as the failsafe.
 *
 * Exercised exactly the way the cohort preflight above is: the real `await_new_build` text
 * is cut out of the shipped file and run under `bash -s`, with the two things that touch
 * the world — `git` and `sleep` — replaced by stubs. Running playtest-loop.sh itself is not
 * an option; one step past this it dispatches a live, paid cohort.
 *
 * The failure worth guarding against is not a crash. It is a loop that waits forever
 * because the dev side went quiet: from outside, that is indistinguishable from a healthy
 * idle loop, while QA silently produces nothing. Hence the ceiling, and hence a test on it.
 *
 * The stubs count their calls through a FILE rather than a shell variable, because the
 * function reads the tip with `$(git rev-parse '@{u}')` — a command substitution, whose
 * subshell throws away any variable the stub increments. A counter that silently stays 0
 * would make every assertion below vacuously pass.
 */
describe("playtest-loop.sh new-build gate", () => {
  const AWAIT_FN = loopSection("await_new_build() {", "\nwave=0");

  /**
   * `tips` is what `git rev-parse '@{u}'` answers on successive looks; the last entry
   * repeats forever, which is how "the dev loop went quiet" is expressed.
   */
  function runAwait(options: {
    only?: string;
    tips: string[];
    played: string;
    hasUpstream?: string;
    poll?: string;
    maxWait?: string;
  }): { status: number | null; output: string; looks: number; sleeps: number } {
    const dir = mkdtempSync(join(tmpdir(), "af-newbuild-"));
    const looksFile = join(dir, "looks");
    const sleepsFile = join(dir, "sleeps");
    const script = [
      "set -uo pipefail",
      `NEW_BUILD_ONLY=${shellQuote(options.only ?? "1")}`,
      `NEW_BUILD_POLL=${shellQuote(options.poll ?? "60")}`,
      `NEW_BUILD_MAX_WAIT=${shellQuote(options.maxWait ?? "600")}`,
      `LAST_WAVE_BUILD=${shellQuote(options.played)}`,
      `HAS_UPSTREAM=${shellQuote(options.hasUpstream ?? "1")}`,
      `LOOKS_FILE=${shellQuote(looksFile)}`,
      `SLEEPS_FILE=${shellQuote(sleepsFile)}`,
      `TIPS=(${options.tips.map(shellQuote).join(" ")})`,
      // Created up front so a run that never looks still leaves a readable zero.
      ': > "$LOOKS_FILE"',
      ': > "$SLEEPS_FILE"',
      // The one seam that touches the repository. Every command the function may issue is
      // answered explicitly, and anything else is a hard error rather than a silent 0 — an
      // unrecognised git call answered "fine" is how a stub starts certifying a function
      // that no longer does what the test claims.
      "git() {",
      '  case "$*" in',
      '    "rev-parse --abbrev-ref --symbolic-full-name @{u}") [ "$HAS_UPSTREAM" = 1 ] || return 1 ;;',
      '    "fetch --quiet origin") return 0 ;;',
      '    "rev-parse @{u}")',
      '      printf "x\\n" >> "$LOOKS_FILE"',
      '      local index=$(( $(wc -l < "$LOOKS_FILE") - 1 ))',
      "      (( index >= ${#TIPS[@]} )) && index=$(( ${#TIPS[@]} - 1 ))",
      '      printf "%s\\n" "${TIPS[$index]}" ;;',
      '    "reset --quiet --hard @{u}") return 0 ;;',
      '    "rev-parse --short HEAD") printf "shorthead\\n" ;;',
      '    *) printf "unexpected git call: %s\\n" "$*" >&2; return 2 ;;',
      "  esac",
      "}",
      'sleep() { printf "x\\n" >> "$SLEEPS_FILE"; }',
      AWAIT_FN,
      "await_new_build",
    ].join("\n");
    const result = spawnSync("bash", ["-s"], {
      cwd: ROOT,
      input: script,
      encoding: "utf8",
      timeout: 120_000,
    });
    const count = (file: string): number =>
      readFileSync(file, "utf8").split("\n").filter(Boolean).length;
    try {
      return {
        status: result.status,
        output: `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`,
        looks: count(looksFile),
        sleeps: count(sleepsFile),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("is off by default, and then touches the repository not at all", () => {
    // Not merely "returns 0": the default path must not fetch, look, or sleep. An opt-in
    // knob that still runs its machinery is one that can still change the timing of every
    // wave for operators who never asked for it.
    const result = runAwait({ only: "0", tips: ["deadbeef"], played: "deadbeef" });
    expect(result.status, result.output).toBe(0);
    expect(result.looks).toBe(0);
    expect(result.sleeps).toBe(0);
    expect(result.output).not.toContain("new build");
  });

  it("starts the next wave as soon as the tip differs from the build last played", () => {
    const result = runAwait({ tips: ["1111111111"], played: "0000000000" });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("new build shorthead after 0s");
    expect(result.looks).toBe(1);
    expect(result.sleeps).toBe(0);
  });

  it("keeps looking while the tip is still the build it already played", () => {
    // Nothing pushed for two polls, then a landing.
    const result = runAwait({
      tips: ["0000000000", "0000000000", "2222222222"],
      played: "0000000000",
      poll: "30",
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("new build shorthead after 60s");
    expect(result.looks).toBe(3);
    expect(result.sleeps).toBe(2);
  });

  it("gives up at the ceiling and replays rather than waiting forever", () => {
    // The dev loop is down. A QA loop that blocks here produces nothing while looking
    // perfectly healthy, so the ceiling turns silence into a repeat session and a line
    // saying why.
    const result = runAwait({
      tips: ["0000000000"],
      played: "0000000000",
      poll: "60",
      maxWait: "300",
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("no new build after 300s");
    expect(result.output).toContain("replaying shorthead");
    expect(result.looks).toBe(5);
    expect(result.sleeps).toBe(5);
  });

  it("says so out loud when the checkout tracks no upstream, instead of ignoring the knob", () => {
    // Refusing would strand an operator whose only mistake was setting a knob on a
    // detached mirror. Playing on is right; doing it silently is how someone concludes the
    // feature is broken.
    const result = runAwait({ tips: ["1111111111"], played: "0000000000", hasUpstream: "0" });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("tracks no upstream");
    expect(result.looks).toBe(0);
  });

  it("measures new against the build the wave PLAYED, not the tip when it last looked", () => {
    // If the dev loop pushed WHILE the wave was running, that push is already unplayed work
    // and the next wave should start on it immediately. Comparing against the tip observed
    // at the end of the wave would swallow exactly that build.
    const result = runAwait({ tips: ["3333333333"], played: "0000000000" });
    expect(result.looks).toBe(1);
    expect(result.sleeps).toBe(0);
    expect(result.output).toContain("new build");
  });

  it("refuses a poll interval that is not a positive number of seconds", () => {
    // `sleep soon` would fail every poll and spin the ceiling out at full speed; a 0 would
    // busy-loop against the remote. Both are worth refusing at startup, by name.
    const knobs = loopSection(
      'NEW_BUILD_ONLY="${PLAYTEST_NEW_BUILD_ONLY:-0}"',
      "# The exact commit",
    );
    for (const bad of ["soon", "0", "-5"]) {
      const result = spawnSync("bash", ["-s"], {
        cwd: ROOT,
        input: `set -uo pipefail\nexport PLAYTEST_NEW_BUILD_ONLY=1 PLAYTEST_NEW_BUILD_POLL_SECONDS=${bad}\n${knobs}`,
        encoding: "utf8",
        timeout: 120_000,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status, output).toBe(2);
      expect(output).toContain("PLAYTEST_NEW_BUILD_POLL_SECONDS");
    }
  });
});
