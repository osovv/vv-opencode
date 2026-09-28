#!/usr/bin/env bun
// FILE: scripts/e2e-v2/full.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Orchestrate full parity acceptance against the installed packed artifact: run the packed core and real-PTY TUI tiers, resolve every parity row, write machine-readable evidence, and fail whenever any mandatory row is unverified.
//   SCOPE: Inventory loading, pinned host/package/dependency hashing, tier orchestration through injectable runners, parity-row resolution, and parity-evidence writing. It never marks a row verified without an installed-artifact tier outcome and never substitutes a workspace-plugin run for the packed artifact.
//   DEPENDS: [node:fs, node:path, scripts/e2e-v2/full-cases.ts, scripts/e2e-v2/host.ts, scripts/e2e-v2/core.ts, scripts/e2e-v2/tui.ts]
//   LINKS: [M-E2E-V2-HARNESS, V-M-E2E-V2-HARNESS]
//   ROLE: SCRIPT
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   FullRunOptions - Inputs controlling one full installed-artifact run.
//   FullRunSummary - Machine-readable outcome of one full run.
//   FullRunDeps - Injectable tier runners and evidence writer.
//   readParityInventory - Read the versioned parity inventory from the workspace.
//   dependencyHashes - Exact content hashes of the installed runtime dependencies under test.
//   runFull - Run every installed tier, resolve rows, write evidence, and fail on unverified mandatory rows.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009-FULL - Resolves rows across the core, real-PTY TUI, and installed-surface tiers from the core summary's installed checks, and records the installed paths and native limits in parity evidence.]
//   PREVIOUS: [C-OPENCODE-V2-NATIVE T-009 - Added the installed-artifact full runner that reuses the packed core and real-PTY TUI tiers, records exact host/package/dependency hashes, and refuses to pass while any mandatory parity row is unverified.]
// END_CHANGE_SUMMARY

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCore, requireHostBinary, type CoreRunSummary } from "./core.js";
import {
  buildParityEvidence,
  evaluateParityRows,
  mandatoryRowFailures,
  writeParityEvidence,
  type ParityRow,
  type RowResult,
} from "./full-cases.js";
import { sha256File, PINNED_SOURCE_COMMIT, PINNED_HOST_VERSION } from "./host.js";
import { runTuiAcceptance, type TuiAcceptanceResult } from "./tui.js";

/** Inputs controlling one full installed-artifact run. */
export interface FullRunOptions {
  readonly workspaceRoot: string;
  readonly hostBinary: string;
  readonly scratchBase: string;
  readonly evidencePath: string;
  readonly keepScratch?: boolean;
  readonly caseTimeoutMs?: number;
}

/** Machine-readable outcome of one full run. */
export interface FullRunSummary {
  readonly ok: boolean;
  readonly rows: readonly RowResult[];
  readonly failures: readonly string[];
  readonly evidencePath?: string;
  readonly error?: string;
}

/** Injectable tier runners and evidence writer. */
export interface FullRunDeps {
  readonly runCore?: (options: {
    readonly workspaceRoot: string;
    readonly hostBinary: string;
    readonly scratchBase: string;
    readonly evidencePath: string;
    readonly keepScratch?: boolean;
    readonly caseTimeoutMs?: number;
  }) => Promise<CoreRunSummary>;
  readonly runTui?: (options: {
    readonly workspaceRoot: string;
    readonly hostBinary: string;
    readonly scratchBase: string;
    readonly keepScratch?: boolean;
  }) => Promise<TuiAcceptanceResult>;
  readonly writeEvidence?: typeof writeParityEvidence;
  readonly hostSha256?: (path: string) => Promise<string>;
}

/** Read the versioned parity inventory from the workspace. */
export function readParityInventory(workspaceRoot: string): ParityRow[] {
  const path = join(workspaceRoot, "scripts", "e2e-v2", "parity.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { rows?: ParityRow[] };
  return parsed.rows ?? [];
}

const RUNTIME_DEPENDENCIES = ["@opencode/plugin", "effect", "zod"] as const;

/** Exact content hashes of the installed runtime dependencies under test. */
export async function dependencyHashes(
  workspaceRoot: string,
  hostSha256: (path: string) => Promise<string> = sha256File,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const name of RUNTIME_DEPENDENCIES) {
    const manifest = join(workspaceRoot, "node_modules", name, "package.json");
    try {
      hashes[name] = await hostSha256(manifest);
    } catch {
      hashes[name] = "unavailable";
    }
  }
  return hashes;
}

/**
 * Run every installed tier, resolve rows, write evidence, and fail on unverified
 * mandatory rows. Evidence is written whenever a pinned host is available, even
 * on failure, so the recorded limits match the observed run.
 */
export async function runFull(
  options: FullRunOptions,
  deps: FullRunDeps = {},
): Promise<FullRunSummary> {
  const rows = readParityInventory(options.workspaceRoot);
  if (rows.length === 0) {
    return { ok: false, rows: [], failures: [], error: "parity inventory is empty" };
  }
  const core = deps.runCore ?? runCore;
  const tui = deps.runTui ?? runTuiAcceptance;
  const hasher = deps.hostSha256 ?? sha256File;
  const writer = deps.writeEvidence ?? writeParityEvidence;

  let hostBinarySha256 = "unavailable";
  try {
    hostBinarySha256 = await hasher(options.hostBinary);
  } catch (error) {
    return {
      ok: false,
      rows: [],
      failures: [],
      error: `pinned host is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const coreSummary = await core({
    workspaceRoot: options.workspaceRoot,
    hostBinary: options.hostBinary,
    scratchBase: options.scratchBase,
    evidencePath: join(options.workspaceRoot, ".grace", "changes", "active", "C-OPENCODE-V2-NATIVE", "core-evidence.json"),
    keepScratch: options.keepScratch,
    caseTimeoutMs: options.caseTimeoutMs,
  });

  let tuiSummary: TuiAcceptanceResult | undefined;
  try {
    tuiSummary = await tui({
      workspaceRoot: options.workspaceRoot,
      hostBinary: options.hostBinary,
      scratchBase: options.scratchBase,
      keepScratch: options.keepScratch,
    });
  } catch (error) {
    tuiSummary = {
      ok: false,
      implemented: false,
      sourceCommit: PINNED_SOURCE_COMMIT,
      scenarios: [],
      error: error instanceof Error ? error.message : String(error),
      note: "TUI tier threw before producing a result",
    };
  }

  const installedSummary = coreSummary.installedSurface;

  const results = evaluateParityRows(rows, {
    coreOk: coreSummary.ok,
    tuiOk: tuiSummary?.ok,
    installedOk: installedSummary?.ok,
  });
  const failures = mandatoryRowFailures(results);

  const packageManifest = JSON.parse(
    readFileSync(join(options.workspaceRoot, "package.json"), "utf8"),
  ) as { name: string; version: string };
  const coreFailed = coreSummary.cases.filter((entry) => entry.status === "fail").length;

  const document = buildParityEvidence({
    rows: results,
    hostBinary: options.hostBinary,
    hostBinarySha256,
    hostSourceCommit: PINNED_SOURCE_COMMIT,
    hostVersion: PINNED_HOST_VERSION,
    tarballSha256: coreSummary.tarballSha256,
    packageName: packageManifest.name,
    packageVersion: packageManifest.version,
    dependencyHashes: coreSummary.installed?.resolvedDependencies ?? {},
    installedPaths: coreSummary.installed?.loadedPaths,
    installedSurface: installedSummary?.checks,
    coreSummary: { cases: coreSummary.cases.length, failed: coreFailed },
    tuiSummary: tuiSummary
      ? {
          scenarios: tuiSummary.scenarios.length,
          failed: tuiSummary.scenarios.filter((scenario) => scenario.status === "fail").length,
        }
      : undefined,
    limits: [
      "Remote/paid provider effectiveness is explicitly unverified; only loopback providers are used.",
      "Same-model switchModel emits no native event and is not a parity criterion.",
      "A prompt-preparation failure after the prompt hook has no rejection notice; the harness records zero dispatch instead.",
      "Cross-session equal-time first-accept ordering remains a recorded engine-test limit, not forced on the host.",
      "Rows without an installed-artifact tier remain unverified until a scenario covers them; --full never promotes them.",
      "The anthropic-compatible cohort is declared but not exercised by the installed-surface tier.",
    ],
    generatedAt: new Date().toISOString(),
  });

  await writer(options.evidencePath, document);
  return { ok: failures.length === 0 && coreSummary.error === undefined, rows: results, failures, evidencePath: options.evidencePath, error: coreSummary.error };
}

/** Resolve the pinned host binary or throw the shared configuration error. */
export { requireHostBinary };
