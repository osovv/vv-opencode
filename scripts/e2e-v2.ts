#!/usr/bin/env bun
// FILE: scripts/e2e-v2.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Command-line entry for the v2 real-host acceptance harness with explicit core, full, TUI, and inventory modes.
//   SCOPE: Argument parsing, parity inventory listing, explicit full-mode refusal until all parity groups exist, truthful TUI scaffold, and delegation to the packed core run with bounded stdout and nonzero exit codes. It has no import-time side effects.
//   DEPENDS: [node:fs, node:path, scripts/e2e-v2.ts, scripts/e2e-v2/core.ts, scripts/e2e-v2/tui.ts]
//   LINKS: [M-E2E-V2-HARNESS, V-M-E2E-V2-HARNESS]
//   ROLE: SCRIPT
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   HarnessMode - Selected harness mode.
//   CliDeps - Injectable runner dependencies used by tests and the real entry.
//   parseArgs - Parse harness arguments into a mode and output flag.
//   runCli - Execute one harness invocation and return its process-style status.
//   main - Real entry that wires process arguments and exits.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-003 - Added the mode-aware harness entry that refuses full parity until T-004..T-010 land.]
// END_CHANGE_SUMMARY

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCore, requireHostBinary, type CoreRunSummary } from "./e2e-v2/core.js";
import { runTuiAcceptance } from "./e2e-v2/tui.js";

/** Selected harness mode. */
export type HarnessMode = "list" | "core" | "full" | "tui";

/** Injectable runner dependencies used by tests and the real entry. */
export interface CliDeps {
  readonly workspaceRoot: string;
  readonly stdout: (line: string) => void;
  readonly runCore: (options: {
    readonly workspaceRoot: string;
    readonly hostBinary: string;
    readonly scratchBase: string;
    readonly evidencePath: string;
    readonly keepScratch?: boolean;
  }) => Promise<CoreRunSummary>;
  readonly hostBinary?: string | undefined;
  readonly requireHost?: (() => string) | undefined;
  readonly scratchBase?: string | undefined;
  readonly evidencePath?: string | undefined;
}

/** Parse harness arguments into a mode and output flag. */
export function parseArgs(argv: readonly string[]): {
  readonly mode: HarnessMode;
  readonly json: boolean;
  readonly keep: boolean;
} {
  let mode: HarnessMode = "full";
  let json = false;
  let keep = false;
  for (const arg of argv) {
    if (arg === "--core") mode = "core";
    else if (arg === "--tui") mode = "tui";
    else if (arg === "--list") mode = "list";
    else if (arg === "--full") mode = "full";
    else if (arg === "--json") json = true;
    else if (arg === "--keep") keep = true;
  }
  return { mode, json, keep };
}

interface ParityRow {
  readonly id: string;
  readonly surface: string;
  readonly phase: string;
  readonly status: string;
}

function readParity(workspaceRoot: string): ParityRow[] {
  const path = join(workspaceRoot, "scripts", "e2e-v2", "parity.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { rows?: ParityRow[] };
  return parsed.rows ?? [];
}

// START_BLOCK_RUN
/** Execute one harness invocation and return its process-style status. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const { mode, json, keep } = parseArgs(argv);
  if (mode === "list") {
    const rows = readParity(deps.workspaceRoot);
    if (json) {
      deps.stdout(JSON.stringify({ rows }, null, 2));
    } else {
      for (const row of rows) {
        deps.stdout(`${row.phase}\t${row.status}\t${row.id}\t${row.surface}`);
      }
      const counts = rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = (acc[row.status] ?? 0) + 1;
        return acc;
      }, {});
      deps.stdout(`parity rows: ${rows.length} ${JSON.stringify(counts)}`);
    }
    return 0;
  }
  if (mode === "tui") {
    const result = runTuiAcceptance();
    deps.stdout(JSON.stringify(result, null, 2));
    deps.stdout("tui acceptance is not implemented; refusing to report success (T-008/T-009)");
    return 2;
  }
  if (mode === "full") {
    deps.stdout(
      "full parity acceptance is not implemented yet: core covers only the packed model-role runtime.",
    );
    deps.stdout("remaining parity groups are owned by T-004 through T-010; run --core for the current tier.");
    return 2;
  }

  // core mode
  let hostBinary = deps.hostBinary;
  if (hostBinary === undefined) {
    try {
      hostBinary = (deps.requireHost ?? requireHostBinary)();
    } catch (error) {
      deps.stdout(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  const scratchBase = deps.scratchBase ?? process.env.VVOC_E2E_SCRATCH ?? "/tmp/opencode";
  const evidencePath =
    deps.evidencePath ??
    join(deps.workspaceRoot, ".grace", "changes", "active", "C-OPENCODE-V2-NATIVE", "core-evidence.json");
  const summary = await deps.runCore({
    workspaceRoot: deps.workspaceRoot,
    hostBinary,
    scratchBase,
    evidencePath,
    keepScratch: keep,
  });
  if (json) {
    deps.stdout(JSON.stringify(summary, null, 2));
  } else {
    for (const entry of summary.cases) {
      deps.stdout(`[${entry.status.toUpperCase()}] ${entry.id} — ${entry.title}`);
      for (const failure of entry.failures) deps.stdout(`    failure: ${failure}`);
    }
    if (summary.error !== undefined) deps.stdout(`harness error: ${summary.error}`);
    const failed = summary.cases.filter((entry) => entry.status === "fail").length;
    deps.stdout(`core summary: ${summary.cases.length - failed} pass, ${failed} fail`);
    if (summary.evidencePath !== undefined) deps.stdout(`evidence: ${summary.evidencePath}`);
    deps.stdout(`packed tarball sha256: ${summary.tarballSha256 ?? "unavailable"}`);
  }
  if (summary.error !== undefined) return 2;
  return summary.ok ? 0 : 1;
}
// END_BLOCK_RUN

// START_BLOCK_MAIN
/** Real entry that wires process arguments and exits. */
async function main(): Promise<void> {
  const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
  const status = await runCli(process.argv.slice(2), {
    workspaceRoot,
    stdout: (line) => console.log(line),
    runCore,
  });
  process.exit(status);
}

if (import.meta.main) {
  void main();
}
// END_BLOCK_MAIN
