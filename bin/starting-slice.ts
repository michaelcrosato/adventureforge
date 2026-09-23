#!/usr/bin/env -S npx tsx
/**
 * bin/starting-slice — evaluate one frozen fleet against the starting-slice milestone.
 *
 *   npm run starting-slice:pilot -- --fleet ai-runs/fleet/<label>     readiness pilot
 *   npm run starting-slice:certify -- --fleet ai-runs/fleet/<label>   authority certification
 *
 * A pilot can never certify the milestone; each mode publishes its own artifact.
 */

import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  certifyStartingSliceAuthority,
  startingSliceFleetDisplayName,
  validateStartingSlicePilot,
} from "../src/starting_slice/fleet_certifier.js";

type StartingSliceMode = "pilot" | "certify";

class StartingSliceUsageError extends Error {}

function parseArgs(argv: string[]): { mode: StartingSliceMode; fleetDir: string } {
  const mode = argv[0];
  if (mode !== "pilot" && mode !== "certify") {
    throw new StartingSliceUsageError(
      "usage: npm run starting-slice:<pilot|certify> -- --fleet ai-runs/fleet/<label>",
    );
  }
  const rest = argv.slice(1);
  if (rest.length !== 2 || rest[0] !== "--fleet" || rest[1]?.trim().length === 0) {
    throw new StartingSliceUsageError(
      `usage: npm run starting-slice:${mode} -- --fleet ai-runs/fleet/<label>`,
    );
  }
  return { mode, fleetDir: resolve(rest[1]!) };
}

function canonicalRealpath(path: string): string {
  return realpathSync.native(path);
}

function containedPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function existingOutputIsSafe(
  outputPath: string,
  fleetRoot: string,
  kind: StartingSliceResultArtifactKind,
): void {
  let stats;
  try {
    stats = lstatSync(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`existing ${kind} output must not be a symbolic link`);
  }
  if (!stats.isFile()) {
    throw new Error(`existing ${kind} output must be a regular file`);
  }
  if (stats.nlink !== 1) {
    throw new Error(`existing ${kind} output must not have multiple hard links`);
  }
  if (!containedPath(fleetRoot, canonicalRealpath(outputPath))) {
    throw new Error(`existing ${kind} output escapes the fleet directory`);
  }
}

type StartingSliceResultArtifactKind = "certification" | "pilot";

/** Safely publish one fleet result without ever truncating a link target. */
function writeStartingSliceResultArtifactSafely(
  fleetDir: string,
  result: unknown,
  kind: StartingSliceResultArtifactKind,
): string {
  const canonicalFleetDir = resolve(fleetDir);
  const fleetStats = lstatSync(canonicalFleetDir);
  if (fleetStats.isSymbolicLink() || !fleetStats.isDirectory()) {
    throw new Error(`${kind} fleet directory must be a real directory`);
  }
  const fleetRoot = canonicalRealpath(canonicalFleetDir);
  const outputPath = resolve(canonicalFleetDir, `starting-slice-${kind}.json`);
  existingOutputIsSafe(outputPath, fleetRoot, kind);

  const payload = `${JSON.stringify(result, null, 2)}\n`;
  let tempPath: string | null = null;
  let descriptor: number | null = null;
  try {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = join(
        canonicalFleetDir,
        `.starting-slice-${kind}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
      );
      try {
        descriptor = openSync(candidate, "wx", 0o600);
        tempPath = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (descriptor === null || tempPath === null) {
      throw new Error(`could not reserve an exclusive ${kind} temp file`);
    }
    writeFileSync(descriptor, payload, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;

    const tempStats = lstatSync(tempPath);
    if (!tempStats.isFile() || tempStats.isSymbolicLink() || tempStats.nlink !== 1) {
      throw new Error(`${kind} temp artifact is not a private regular file`);
    }
    if (!containedPath(fleetRoot, canonicalRealpath(tempPath))) {
      throw new Error(`${kind} temp artifact escaped the fleet directory`);
    }
    // Rename replaces the directory entry itself; it never opens or truncates
    // a destination symlink/hardlink target.
    renameSync(tempPath, outputPath);
    tempPath = null;
    return outputPath;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (tempPath !== null) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Preserve the original publication error.
      }
    }
  }
}

export function writeCertificationArtifactSafely(fleetDir: string, result: unknown): string {
  return writeStartingSliceResultArtifactSafely(fleetDir, result, "certification");
}

export function writePilotArtifactSafely(fleetDir: string, result: unknown): string {
  return writeStartingSliceResultArtifactSafely(fleetDir, result, "pilot");
}

function certify(fleetDir: string): void {
  const result = certifyStartingSliceAuthority({
    root: process.cwd(),
    fleetDir,
  });
  let outputPath: string;
  try {
    outputPath = writeCertificationArtifactSafely(fleetDir, result);
  } catch (error) {
    console.error(
      `Could not write certification artifact: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
    return;
  }

  const name = startingSliceFleetDisplayName(result);
  if (!result.valid) {
    console.error(`${name}: invalid certification evidence`);
    for (const error of result.validity_errors) console.error(`- ${error}`);
    console.error(`Wrote ${outputPath}`);
    process.exitCode = 2;
    return;
  }
  if (!result.authority_certified) {
    console.error(`${name}: authenticated cohort missed ${result.gate_failures.length} gate(s)`);
    for (const gate of result.gate_failures) console.error(`- ${gate}`);
    console.error(`Wrote ${outputPath}`);
    process.exitCode = 1;
    return;
  }

  console.log(`${name}: starting-slice certification passed`);
  console.log(`Wrote ${outputPath}`);
}

function pilot(fleetDir: string): void {
  const result = validateStartingSlicePilot({
    root: process.cwd(),
    fleetDir,
  });
  let outputPath: string;
  try {
    outputPath = writePilotArtifactSafely(fleetDir, result);
  } catch (error) {
    console.error(
      `Could not write pilot artifact: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
    return;
  }

  const name = startingSliceFleetDisplayName(result);
  if (!result.valid) {
    console.error(`${name}: invalid pilot evidence`);
    for (const error of result.validity_errors) console.error(`- ${error}`);
    console.error(`Wrote ${outputPath}`);
    process.exitCode = 2;
    return;
  }
  if (!result.pilot_passed) {
    console.error(
      `${name}: authenticated pilot missed ${result.gate_failures.length} quality and ${result.pilot_gate_failures.length} pilot gate(s)`,
    );
    for (const gate of result.gate_failures) console.error(`- quality:${gate}`);
    for (const gate of result.pilot_gate_failures) console.error(`- pilot:${gate}`);
    console.error(`Wrote ${outputPath}`);
    process.exitCode = 1;
    return;
  }

  console.log(`${name}: starting-slice readiness pilot passed`);
  console.log(`Authenticated actual model: ${result.authenticated_actual_model}`);
  console.log("Authority certification: false (a pilot can never certify the milestone)");
  console.log(`Wrote ${outputPath}`);
}

function main(): void {
  let parsed: { mode: StartingSliceMode; fleetDir: string };
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof StartingSliceUsageError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  if (parsed.mode === "pilot") pilot(parsed.fleetDir);
  else certify(parsed.fleetDir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
