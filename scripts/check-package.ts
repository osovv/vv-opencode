#!/usr/bin/env bun
// FILE: scripts/check-package.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Manifest-driven package-surface gate: verify every declared export loads a native entry and that the actual packed tarball contains every required public artifact.
//   SCOPE: Pure manifest/entry/tarball assertions over injectable import and pack functions, plus a disk-backed CLI that builds nothing, packs with script suppression, and imports each dist export. It asserts native {id, setup|effect} shape for the root aggregate, the TUI default, and every standalone plugin subpath, requires the V1 SDK to be absent, and includes ToolHistoryCompaction in the required plugin set.
//   DEPENDS: [node:fs, node:path, node:child_process, node:os]
//   LINKS: [M-AGENT-TOOL-CONTRACT, V-M-AGENT-TOOL-CONTRACT]
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   execFileAsync - Promisified child_process.execFile used for the pack and list commands.
//   PackageManifest - Minimal package.json view needed by the pack gate.
//   PackDependencies - Injectable import/pack/list dependencies used by tests and the real entry.
//   nativeEntryIssue - Assert one module value is a native {id, setup|effect} entry.
//   pluginExportName - Derive the named plugin export from a plugin subpath.
//   ExportRequirement - Required export subpath with its expected native entry kind.
//   packageExportRequirements - Required export subpaths and their expected native entry kinds.
//   exportTarget - Human-readable target string of one exported value.
//   verifyPackageExports - Import every declared export and report shape failures.
//   manifestIssues - Package manifest identity/dependency failures.
//   expectedTarballEntries - Required packed entries derived from the manifest exports.
//   verifyTarballEntries - Report missing required packed entries.
//   readManifest - Read and parse the repository package.json manifest.
//   runPackageCheck - Full read-only package check over injectable dependencies.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009 - Replaced the inline root-export snippet that omitted ToolHistoryCompaction and never inspected the tarball with a manifest-driven export/entry/tarball gate that covers every plugin, the native aggregate default, the TUI default, and the packed artifact contents.]
// END_CHANGE_SUMMARY

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Minimal package.json view needed by the pack gate. */
export interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly files?: readonly string[];
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

/** Injectable import/pack/list dependencies used by tests and the real entry. */
export interface PackDependencies {
  readonly importModule: (specifier: string) => Promise<Record<string, unknown>>;
  readonly packTarball: () => Promise<string>;
  readonly listTarballEntries: (tarballPath: string) => Promise<string[]>;
}

// START_BLOCK_ASSERTIONS
/** Assert one module value is a native `{ id, setup | effect }` entry. */
export function nativeEntryIssue(label: string, value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return `${label} is not a native entry object`;
  }
  const entry = value as { id?: unknown; setup?: unknown; effect?: unknown };
  if (typeof entry.id !== "string" || entry.id.length === 0) {
    return `${label} has no string id`;
  }
  if (typeof entry.setup !== "function" && typeof entry.effect !== "function") {
    return `${label} has neither a setup nor an effect function`;
  }
  return undefined;
}

/** Derive the named plugin export from a plugin subpath (`hashline-edit` -> `HashlineEditPlugin`). */
export function pluginExportName(subpath: string): string {
  const name = subpath.replace(/^\.\/plugins\//, "");
  return `${name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}Plugin`;
}

interface ExportRequirement {
  readonly subpath: string;
  readonly kind: "aggregate" | "plugin" | "tui";
}

/** Required export subpaths and their expected native entry kinds. */
export function packageExportRequirements(manifest: PackageManifest): ExportRequirement[] {
  const exports = manifest.exports ?? {};
  const requirements: ExportRequirement[] = [{ subpath: ".", kind: "aggregate" }];
  if (exports["./server"] !== undefined) {
    requirements.push({ subpath: "./server", kind: "aggregate" });
  }
  if (exports["./tui"] !== undefined) {
    requirements.push({ subpath: "./tui", kind: "tui" });
  }
  for (const subpath of Object.keys(exports)) {
    if (subpath.startsWith("./plugins/")) requirements.push({ subpath, kind: "plugin" });
  }
  return requirements;
}
// END_BLOCK_ASSERTIONS

// START_BLOCK_EXPORT_VERIFY
function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const target = record["import"] ?? record["default"];
  return typeof target === "string" ? target : undefined;
}

/** Import every declared export and report native-shape failures. */
export async function verifyPackageExports(
  manifest: PackageManifest,
  deps: Pick<PackDependencies, "importModule"> & { readonly distUrl: (target: string) => string },
): Promise<string[]> {
  const failures: string[] = [];
  for (const requirement of packageExportRequirements(manifest)) {
    const raw = manifest.exports?.[requirement.subpath];
    const target = exportTarget(raw);
    if (target === undefined) {
      failures.push(`export ${requirement.subpath} has no import target`);
      continue;
    }
    let module: Record<string, unknown>;
    try {
      module = await deps.importModule(deps.distUrl(target));
    } catch (error) {
      failures.push(
        `export ${requirement.subpath} failed to import: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (requirement.kind === "plugin") {
      const name = pluginExportName(requirement.subpath);
      const issue = nativeEntryIssue(`${requirement.subpath} (${name})`, module[name]);
      if (issue !== undefined) failures.push(issue);
      continue;
    }
    const issue = nativeEntryIssue(`${requirement.subpath} default`, module["default"]);
    if (issue !== undefined) failures.push(issue);
    if (requirement.kind === "aggregate") {
      for (const key of Object.keys(module)) {
        if (key === "default" || key === "VVOC_SERVER_PLUGINS") continue;
        if (!key.endsWith("Plugin")) continue;
        const namedIssue = nativeEntryIssue(`${requirement.subpath} ${key}`, module[key]);
        if (namedIssue !== undefined) failures.push(namedIssue);
      }
    }
  }
  return failures;
}
// END_BLOCK_EXPORT_VERIFY

// START_BLOCK_MANIFEST
/** Package manifest identity/dependency failures. */
export function manifestIssues(manifest: PackageManifest): string[] {
  const failures: string[] = [];
  const declared = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
  for (const name of Object.keys(declared)) {
    if (name.startsWith("@opencode-ai/")) {
      failures.push(`manifest still declares removed V1 dependency ${name}`);
    }
  }
  for (const required of ["@opencode/plugin", "effect", "zod"]) {
    if (manifest.dependencies?.[required] === undefined) {
      failures.push(`manifest is missing direct dependency ${required}`);
    }
  }
  return failures;
}

/** Required packed entries derived from the manifest exports. */
export function expectedTarballEntries(manifest: PackageManifest): string[] {
  const required = ["package/package.json", "package/server.js", "package/tui.js"];
  for (const requirement of packageExportRequirements(manifest)) {
    const target = exportTarget(manifest.exports?.[requirement.subpath]);
    if (target !== undefined) required.push(`package/${target.replace(/^\.\//, "")}`);
  }
  for (const extra of ["package/README.md"]) required.push(extra);
  return [...new Set(required)].sort();
}

/** Report missing required packed entries. */
export function verifyTarballEntries(
  entries: readonly string[],
  manifest: PackageManifest,
): string[] {
  const present = new Set(entries);
  return expectedTarballEntries(manifest).filter((entry) => !present.has(entry));
}
// END_BLOCK_MANIFEST

// START_BLOCK_CLI
function readManifest(repoRoot: string): PackageManifest {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as PackageManifest;
}

/** Full read-only package check over injectable dependencies. */
export async function runPackageCheck(
  repoRoot: string,
  deps: Partial<PackDependencies> = {},
  stdout: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  const manifest = readManifest(repoRoot);
  const failures: string[] = [...manifestIssues(manifest)];

  const distUrl = (target: string): string => pathToFileURL(join(repoRoot, target)).href;
  const importModule =
    deps.importModule ??
    ((specifier: string) => import(specifier) as Promise<Record<string, unknown>>);
  failures.push(...(await verifyPackageExports(manifest, { importModule, distUrl })));

  const scratch = mkdtempSync(join(tmpdir(), "vvoc-pack-check-"));
  try {
    const tarballPath =
      deps.packTarball !== undefined
        ? await deps.packTarball()
        : (
            await execFileAsync(
              "bun",
              ["pm", "pack", "--ignore-scripts", "--filename", join(scratch, "pkg.tgz")],
              { cwd: repoRoot },
            )
          ).stdout.trim();
    const resolvedTarball = existsSync(tarballPath) ? tarballPath : join(scratch, "pkg.tgz");
    const listEntries =
      deps.listTarballEntries ??
      (async (path: string) => {
        const { stdout } = await execFileAsync("tar", ["tzf", path]);
        return stdout.split("\n").filter((line) => line.length > 0);
      });
    const entries = await listEntries(resolvedTarball);
    failures.push(...verifyTarballEntries(entries, manifest));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    stdout(`✗ package check failed with ${failures.length} issue(s):`);
    for (const failure of failures) stdout(`  ${failure}`);
    return 1;
  }
  stdout(`✓ ${manifest.name}@${manifest.version} exports and packed artifact are current.`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runPackageCheck(process.cwd());
}
// END_BLOCK_CLI
