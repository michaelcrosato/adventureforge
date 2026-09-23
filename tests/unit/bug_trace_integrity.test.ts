import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { verifyBugTraces } from "../../scripts/verify-bug-traces.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "adventureforge-bug-traces-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "traces", "bugs"), { recursive: true });
  return root;
}

function writeTrace(root: string, name: string, source: string): void {
  writeFileSync(join(root, "traces", "bugs", name), source);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bug trace integrity", () => {
  it("keeps the complete checked-in corpus parseable, identified, and referentially sound", () => {
    const report = verifyBugTraces(ROOT);

    expect(report.findings).toEqual([]);
    expect(report.stats.files).toBeGreaterThan(350);
    expect(report.stats.currentReferences).toBeGreaterThan(0);
    expect(report.stats.historicalReferences).toBeGreaterThan(0);
  });

  it("accepts current, historical, generated-output, and TypeScript ESM source references", () => {
    const root = fixtureRoot();
    writeTrace(
      root,
      "bug_0001_reference_kinds.yaml",
      [
        "id: bug_0001_reference_kinds",
        "title: reference kinds",
        "verification:",
        "  - tests/current.test.ts",
        "  - src/retired.ts",
        "  - src/runtime.js",
        "  - traces/run.json",
      ].join("\n"),
    );

    const report = verifyBugTraces(root, {
      currentPaths: new Set(["tests/current.test.ts", "src/runtime.ts"]),
      historicalPaths: new Set(["src/retired.ts"]),
    });

    expect(report.findings).toEqual([]);
    expect(report.stats).toEqual({
      files: 1,
      references: 4,
      currentReferences: 2,
      historicalReferences: 1,
      generatedReferences: 1,
    });
  });

  it("accepts non-ignored work in progress but rejects an ignored local artifact", () => {
    const root = fixtureRoot();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "/traces/*.json\n");
    writeFileSync(join(root, "tests", "new_regression.test.ts"), "export {};\n");
    writeFileSync(join(root, "traces", "ignored.json"), "{}\n");
    writeTrace(
      root,
      "bug_0001_clean_checkout.yaml",
      [
        "id: bug_0001_clean_checkout",
        "title: clean checkout parity",
        "verification:",
        "  - tests/new_regression.test.ts",
        "  - traces/ignored.json",
      ].join("\n"),
    );

    const report = verifyBugTraces(root);

    expect(report.findings).toEqual([
      {
        file: "traces/bugs/bug_0001_clean_checkout.yaml",
        code: "TRACE_REFERENCE_MISSING",
        message:
          "referenced path never existed in the current tree or reachable Git history: traces/ignored.json",
      },
    ]);
    expect(report.stats).toEqual({
      files: 1,
      references: 2,
      currentReferences: 1,
      historicalReferences: 0,
      generatedReferences: 0,
    });
  });

  it("rejects malformed structure, duplicate identities, mismatches, and phantom paths", () => {
    const root = fixtureRoot();
    writeTrace(root, "bug_0001_first.yaml", "id: bug_0001\ntitle: first\n");
    writeTrace(root, "bug_0002_duplicate.yaml", "id: bug_0001\ntitle: duplicate\n");
    writeTrace(root, "bug_0003_malformed.yaml", "id: [unterminated\n");
    writeTrace(root, "bug_0004_no_id.yaml", "summary: missing identity\n");
    writeTrace(root, "bug_0005_no_story.yaml", "id: bug_0005\ncomponent: tooling\n");
    writeTrace(
      root,
      "bug_0006_phantom_path.yaml",
      "id: bug_0006\ndescription: broken reference\nregression: tests/never_existed.test.ts\n",
    );

    const report = verifyBugTraces(root, {
      currentPaths: new Set(),
      historicalPaths: new Set(),
    });
    const codes = report.findings.map((finding) => finding.code);

    expect(codes).toContain("TRACE_ID_FILENAME_MISMATCH");
    expect(codes).toContain("TRACE_ID_DUPLICATE");
    expect(codes).toContain("YAML_PARSE_ERROR");
    expect(codes).toContain("TRACE_ID_MISSING");
    expect(codes).toContain("TRACE_NARRATIVE_MISSING");
    expect(codes).toContain("TRACE_REFERENCE_MISSING");
  });

  // A shallow clone is the realistic failure here, not an exotic one: Claude Code on the
  // web, `git clone --depth 1`, and any CI job that forgets fetch-depth: 0 all produce
  // one. `rev-list --objects --all` then answers honestly for a history that is almost
  // entirely absent, and every reference to a legitimately retired path looks phantom.
  // Before this guard the gate reported 771 TRACE_REFERENCE_MISSING findings against a
  // corpus in perfect health, which is a false accusation aimed at the wrong artifact.
  it("blames the truncated clone, not the corpus, when history is shallow", () => {
    const root = fixtureRoot();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    writeTrace(
      root,
      "bug_0001_retired_path.yaml",
      ["id: bug_0001_retired_path", "title: retired runtime", "regression: src/retired.ts"].join(
        "\n",
      ),
    );

    const report = verifyBugTraces(root, { shallowHistory: true });

    expect(report.findings).toEqual([
      {
        file: "traces/bugs",
        code: "GIT_HISTORY_TRUNCATED",
        message:
          "repository history is truncated (shallow clone), so 1 unresolved path reference(s) could not be adjudicated and were NOT judged missing; run `git fetch --unshallow` (CI: actions/checkout with fetch-depth: 0), then re-run",
      },
    ]);
  });

  // The suppression is scoped to what truncation can actually explain. Everything the
  // corpus asserts about ITSELF — parse, identity, narrative — is provable from the tree
  // alone and must still fail on a shallow clone.
  it("keeps every history-independent check live under a truncated clone", () => {
    const root = fixtureRoot();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    writeTrace(root, "bug_0001_first.yaml", "id: bug_0002\ntitle: mismatched identity\n");
    writeTrace(root, "bug_0002_no_story.yaml", "id: bug_0002_no_story\ncomponent: tooling\n");

    const codes = verifyBugTraces(root, { shallowHistory: true }).findings.map((f) => f.code);

    expect(codes).toContain("TRACE_ID_FILENAME_MISMATCH");
    expect(codes).toContain("TRACE_NARRATIVE_MISSING");
  });

  // Truncation only matters when it left something unresolved. A shallow clone whose
  // every reference still resolved lost this run nothing, and failing it would be
  // ceremony rather than verification.
  it("stays green when a truncated clone still resolved every reference", () => {
    const root = fixtureRoot();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "present.ts"), "export {};\n");
    writeTrace(
      root,
      "bug_0001_present_path.yaml",
      ["id: bug_0001_present_path", "title: current path", "regression: src/present.ts"].join("\n"),
    );

    const report = verifyBugTraces(root, { shallowHistory: true });

    expect(report.findings).toEqual([]);
    expect(report.stats.currentReferences).toBe(1);
  });
});
