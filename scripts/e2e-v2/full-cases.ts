#!/usr/bin/env bun
// FILE: scripts/e2e-v2/full-cases.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Map the versioned parity inventory to installed-artifact outcomes and assemble the machine-readable parity evidence document.
//   SCOPE: Pure row/tier mapping and evidence assembly over injectable inputs: which parity rows the packed core and real-PTY TUI tiers verify, which rows remain unverified against the installed artifact, and the bounded evidence record (binary/source/package/dependency hashes, per-row outcomes, and honest limits). No host is spawned here.
//   DEPENDS: [node:crypto]
//   LINKS: [M-E2E-V2-HARNESS, V-M-E2E-V2-HARNESS]
//   ROLE: SCRIPT
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PARITY_EVIDENCE_VERSION - Version of the parity-evidence document schema.
//   ParityRow - One parity.json inventory row.
//   RowOutcome - Installed-artifact outcome for one row.
//   RowResult - Row outcome with the tier that produced it.
//   FULL_TIERS - The installed-artifact tiers that can verify a row.
//   tierForCommand - Which installed tier a row command belongs to, if any.
//   evaluateParityRows - Resolve every inventory row to an installed-artifact outcome.
//   mandatoryRowFailures - Mandatory rows that are not verified.
//   sha256Hex - Hex SHA-256 of a string.
//   buildParityEvidence - Assemble the bounded parity-evidence document.
//   writeParityEvidence - Serialize and write the evidence document.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009-FULL - Added the installed and installed-aggregate tiers with per-row observed outcomes, installed paths, and per-check evidence so `--full` fails whenever any mandatory row is unverified or observed failing.]
//   PREVIOUS: [C-OPENCODE-V2-NATIVE T-009 - Added installed-artifact parity mapping and evidence assembly.]
// END_CHANGE_SUMMARY

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Version of the parity-evidence document schema. */
export const PARITY_EVIDENCE_VERSION = "1.0.0";

/** One parity.json inventory row. */
export interface ParityRow {
  readonly id: string;
  readonly surface: string;
  readonly phase: string;
  readonly status: string;
  readonly acceptance: string;
  readonly command: string;
}

/** Installed-artifact outcome for one row. */
export type RowOutcome = "pass" | "fail" | "unverified";

/** Row outcome with the tier that produced it. */
export interface RowResult {
  readonly id: string;
  readonly surface: string;
  readonly status: string;
  readonly outcome: RowOutcome;
  readonly tier: "core" | "tui" | "installed" | "aggregate" | "none";
  readonly detail?: string;
}

/** The installed-artifact tiers that can verify a row. */
export const FULL_TIERS = ["core", "tui", "installed", "aggregate"] as const;

/** Which installed tier a row command belongs to, if any. */
export function tierForCommand(
  command: string,
): "core" | "tui" | "installed" | "aggregate" | undefined {
  if (command.includes("--core")) return "core";
  if (command.includes("--tui")) return "tui";
  if (command.includes("--installed")) return "installed";
  if (command.includes("--aggregate")) return "aggregate";
  return undefined;
}

/**
 * Resolve every inventory row to an installed-artifact outcome. A row is verified
 * only when its declared tier actually ran and passed against the installed
 * artifact; every other mandatory row is `unverified`, never silently promoted.
 */
export function evaluateParityRows(
  rows: readonly ParityRow[],
  input: {
    readonly coreOk: boolean;
    readonly tuiOk: boolean | undefined;
    readonly installedOk: boolean | undefined;
    readonly aggregateOutcomes?: Readonly<Record<string, boolean>> | undefined;
  },
): RowResult[] {
  return rows.map((row) => {
    const tier = tierForCommand(row.command);
    if (tier === "core") {
      return {
        id: row.id,
        surface: row.surface,
        status: row.status,
        tier,
        outcome: input.coreOk ? "pass" : "fail",
      };
    }
    if (tier === "aggregate") {
      const observed = input.aggregateOutcomes?.[row.id];
      return {
        id: row.id,
        surface: row.surface,
        status: row.status,
        tier,
        outcome: observed === true ? "pass" : observed === false ? "fail" : "unverified",
        ...(observed === undefined
          ? { detail: "installed aggregate tier did not observe this row" }
          : {}),
      };
    }
    if (tier === "installed") {
      if (input.installedOk === undefined) {
        return {
          id: row.id,
          surface: row.surface,
          status: row.status,
          tier,
          outcome: "unverified",
          detail: "installed-surface tier was not run",
        };
      }
      return {
        id: row.id,
        surface: row.surface,
        status: row.status,
        tier,
        outcome: input.installedOk ? "pass" : "fail",
      };
    }
    if (tier === "tui") {
      if (input.tuiOk === undefined) {
        return {
          id: row.id,
          surface: row.surface,
          status: row.status,
          tier,
          outcome: "unverified",
          detail: "TUI tier was not run",
        };
      }
      return {
        id: row.id,
        surface: row.surface,
        status: row.status,
        tier,
        outcome: input.tuiOk ? "pass" : "fail",
      };
    }
    return {
      id: row.id,
      surface: row.surface,
      status: row.status,
      tier: "none",
      outcome: "unverified",
      detail: "no installed-artifact tier covers this row",
    };
  });
}

/** Mandatory rows that are not verified. `unverified-paid` rows are recorded limits. */
export function mandatoryRowFailures(results: readonly RowResult[]): string[] {
  return results
    .filter((result) => result.outcome !== "pass" && result.status !== "unverified-paid")
    .map((result) => `${result.id}: ${result.outcome}${result.detail ? ` (${result.detail})` : ""}`);
}

/** Hex SHA-256 of a string. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Inputs for the bounded parity-evidence document. */
export interface ParityEvidenceInput {
  readonly rows: readonly RowResult[];
  readonly hostBinary: string;
  readonly hostBinarySha256: string;
  readonly hostSourceCommit: string;
  readonly hostVersion: string;
  readonly tarballSha256: string | undefined;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly dependencyHashes: Readonly<Record<string, string>>;
  readonly installedPaths?: Readonly<Record<string, string>> | undefined;
  readonly installedSurface?: readonly { readonly id: string; readonly ok: boolean; readonly detail: string }[] | undefined;
  readonly aggregateChecks?: readonly { readonly id: string; readonly ok: boolean; readonly detail: string }[] | undefined;
  readonly coreSummary: { readonly cases: number; readonly failed: number } | undefined;
  readonly tuiSummary: { readonly scenarios: number; readonly failed: number } | undefined;
  readonly limits: readonly string[];
  readonly generatedAt: string;
}

/** Assemble the bounded parity-evidence document. */
export function buildParityEvidence(input: ParityEvidenceInput): Record<string, unknown> {
  const verified = input.rows.filter((row) => row.outcome === "pass").length;
  const failed = input.rows.filter((row) => row.outcome === "fail").length;
  const unverified = input.rows.filter((row) => row.outcome === "unverified").length;
  return {
    version: PARITY_EVIDENCE_VERSION,
    generatedAt: input.generatedAt,
    change: "C-OPENCODE-V2-NATIVE",
    host: {
      binary: input.hostBinary,
      binarySha256: input.hostBinarySha256,
      sourceCommit: input.hostSourceCommit,
      version: input.hostVersion,
    },
    package: {
      name: input.packageName,
      version: input.packageVersion,
      tarballSha256: input.tarballSha256 ?? "unavailable",
    },
    dependencies: input.dependencyHashes,
    installedPaths: input.installedPaths ?? {},
    installedSurface: input.installedSurface ?? [],
    aggregateChecks: input.aggregateChecks ?? [],
    tiers: {
      core: input.coreSummary ?? null,
      tui: input.tuiSummary ?? null,
    },
    totals: { rows: input.rows.length, verified, failed, unverified },
    rows: input.rows,
    limits: input.limits,
  };
}

/** Serialize and write the evidence document. */
export async function writeParityEvidence(
  path: string,
  document: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}
