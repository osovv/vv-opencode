// FILE: src/commands/status.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify status command role-aware installation reporting and invalid config diagnostics.
//   SCOPE: Canonical role inventory rendering, deterministic built-in role ordering, and diagnostic-only invalid vvoc config reporting.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/commands/status.ts, src/lib/opencode.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-CLI-COMMANDS, V-M-CLI-COMMANDS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   status command tests - Verify role inventory output and invalid vvoc config diagnostics from installation inspection.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.0 - Added invalid vvoc config status diagnostics without mutation coverage.]
//   LAST_CHANGE: [v0.1.1 - Added selected source reporting assertions for project status.]
//   LAST_CHANGE: [v0.0.0 - Initial GRACE compliance: added missing CHANGE_SUMMARY.]
// END_CHANGE_SUMMARY

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import statusCommand from "./status.js";
import {
  ensurePackageInstalled,
  installVvocConfig,
  resolvePaths,
  syncManagedAgentRegistrations,
} from "../lib/opencode.js";
import { createDefaultVvocConfig } from "../lib/vvoc-config.js";

test("status prints built-in role inventory after init-style seeding", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-status-config-"));
  const projectDir = await mkdtemp(join(tmpdir(), "vvoc-status-project-"));
  const initialCwd = process.cwd();

  try {
    const paths = await resolvePaths({
      scope: "project",
      cwd: projectDir,
      configDir: configHome,
    });

    await ensurePackageInstalled(paths);
    await syncManagedAgentRegistrations(paths);
    await installVvocConfig(paths);

    process.chdir(projectDir);
    const stdout = await captureStdout(async () => {
      await (
        statusCommand as { run: (context: { args: Record<string, unknown> }) => Promise<void> }
      ).run({
        args: {
          scope: "project",
          "config-dir": configHome,
        },
      });
    });

    expect(stdout).toContain("Roles:");
    expect(stdout).toContain("OpenCode source: project");
    expect(stdout).toContain("vvoc source: project");
    const defaultIndex = stdout.indexOf("  default:");
    const smartIndex = stdout.indexOf("  smart:");
    const fastIndex = stdout.indexOf("  fast:");
    const visionIndex = stdout.indexOf("  vision:");

    expect(defaultIndex).toBeGreaterThan(-1);
    expect(smartIndex).toBeGreaterThan(defaultIndex);
    expect(fastIndex).toBeGreaterThan(smartIndex);
    expect(visionIndex).toBeGreaterThan(fastIndex);
  } finally {
    process.chdir(initialCwd);
    await rm(configHome, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("status reports invalid vvoc config without mutating the selected file", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-status-invalid-config-"));
  const projectDir = await mkdtemp(join(tmpdir(), "vvoc-status-invalid-project-"));
  const initialCwd = process.cwd();

  try {
    const paths = await resolvePaths({
      scope: "project",
      cwd: projectDir,
      configDir: configHome,
    });

    await ensurePackageInstalled(paths);
    await installVvocConfig(paths);
    const invalidText =
      JSON.stringify({ ...createDefaultVvocConfig(), version: 2 }, null, 2) + "\n";
    await writeFile(paths.vvocConfigPath, invalidText, "utf8");

    process.chdir(projectDir);
    const stdout = await captureStdout(async () => {
      await (
        statusCommand as { run: (context: { args: Record<string, unknown> }) => Promise<void> }
      ).run({
        args: {
          scope: "project",
          "config-dir": configHome,
        },
      });
    });

    expect(stdout).toContain(`vvoc config: ${paths.vvocConfigPath}`);
    expect(stdout).toContain("vvoc config parse:");
    expect(stdout).toContain("version");
    expect(stdout).toContain("Problems:");
    expect(await readFile(paths.vvocConfigPath, "utf8")).toBe(invalidText);
  } finally {
    process.chdir(initialCwd);
    await rm(configHome, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalConsoleLog = console.log;

  console.log = (...args: unknown[]) => {
    chunks.push(args.map((arg) => String(arg)).join(" ") + "\n");
  };

  try {
    await fn();
  } finally {
    console.log = originalConsoleLog;
  }

  return chunks.join("");
}
