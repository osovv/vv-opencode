// FILE: src/commands/status.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify status command source-aware TUI registration, OpenCode compatibility, orchestration, role inventory, and invalid config diagnostics.
//   SCOPE: Selected/default profile reporting, OpenCode version compatibility, TUI source/parse state, role ordering, source precedence, and diagnostic-only invalid config handling.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/commands/status.ts, src/lib/opencode.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-CLI-COMMANDS, M-ORCHESTRATION-PROFILES, V-M-CLI-COMMANDS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   status command tests - Verify role inventory output and invalid vvoc config diagnostics from installation inspection.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.2 - Added OpenCode host compatibility status coverage.]
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added selected TUI source and managed package status coverage.]
//   LAST_CHANGE: [v0.2.0 - Added invalid vvoc config status diagnostics without mutation coverage.]
//   LAST_CHANGE: [v0.1.1 - Added selected source reporting assertions for project status.]
//   LAST_CHANGE: [v0.0.0 - Initial GRACE compliance: added missing CHANGE_SUMMARY.]
//   LAST_CHANGE: [C-PRESET-ORCHESTRATION-PROFILES - Added selected/default profile and invalid explicit profile reporting coverage.]
// END_CHANGE_SUMMARY

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import statusCommand from "./status.js";
import {
  ensurePackageInstalled,
  ensureTuiPackageInstalled,
  installVvocConfig,
  resolvePaths,
  syncManagedAgentRegistrations,
} from "../lib/opencode.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";

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
    await ensureTuiPackageInstalled(paths);
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
    expect(stdout).toContain(`OpenCode TUI source: project ${paths.opencodeTuiConfigPath}`);
    expect(stdout).toContain("OpenCode TUI config parse: ok");
    expect(stdout).toContain("OpenCode version:");
    expect(stdout).toContain("OpenCode TUI minimum: 1.18.2");
    expect(stdout).toContain("TUI package configured: yes");
    expect(stdout).toContain("vvoc source: project");
    expect(stdout).toContain("Orchestration profile: balanced");
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

test("status reports invalid explicit profile without mutating the selected file", async () => {
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
    await ensureTuiPackageInstalled(paths);
    await installVvocConfig(paths);
    const invalidText =
      JSON.stringify(
        { ...createDefaultVvocConfig(), orchestration: { profile: "automatic" } },
        null,
        2,
      ) + "\n";
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
    expect(stdout).toContain("/orchestration/profile");
    expect(stdout).toContain("Orchestration profile: unknown");
    expect(stdout).toContain("Problems:");
    expect(await readFile(paths.vvocConfigPath, "utf8")).toBe(invalidText);
  } finally {
    process.chdir(initialCwd);
    await rm(configHome, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("effective status with no vvoc file reports balanced and default source", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-status-default-config-"));
  const projectDir = await mkdtemp(join(tmpdir(), "vvoc-status-default-project-"));
  const initialCwd = process.cwd();

  try {
    process.chdir(projectDir);
    const stdout = await captureStdout(async () => {
      await (
        statusCommand as { run: (context: { args: Record<string, unknown> }) => Promise<void> }
      ).run({ args: { scope: "effective", "config-dir": configHome } });
    });

    expect(stdout).toContain("vvoc source: default");
    expect(stdout).toContain("Orchestration profile: balanced");
  } finally {
    process.chdir(initialCwd);
    await rm(configHome, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("effective status reports the profile from the selected project source", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-status-layered-config-"));
  const projectDir = await mkdtemp(join(tmpdir(), "vvoc-status-layered-project-"));
  const initialCwd = process.cwd();

  try {
    const globalPaths = await resolvePaths({
      scope: "global",
      cwd: projectDir,
      configDir: configHome,
    });
    const projectPaths = await resolvePaths({
      scope: "project",
      cwd: projectDir,
      configDir: configHome,
    });
    const globalConfig = createDefaultVvocConfig();
    globalConfig.orchestration = { profile: "orchestrated" };
    const projectConfig = createDefaultVvocConfig();
    projectConfig.orchestration = { profile: "single-session" };
    await mkdir(dirname(globalPaths.vvocConfigPath), { recursive: true });
    await mkdir(dirname(projectPaths.vvocConfigPath), { recursive: true });
    await writeFile(globalPaths.vvocConfigPath, renderVvocConfig(globalConfig), "utf8");
    await writeFile(projectPaths.vvocConfigPath, renderVvocConfig(projectConfig), "utf8");

    process.chdir(projectDir);
    const stdout = await captureStdout(async () => {
      await (
        statusCommand as { run: (context: { args: Record<string, unknown> }) => Promise<void> }
      ).run({ args: { scope: "effective", "config-dir": configHome } });
    });

    expect(stdout).toContain(`vvoc source: project ${projectPaths.vvocConfigPath}`);
    expect(stdout).toContain("Orchestration profile: single-session");
    expect(stdout).not.toContain("Orchestration profile: orchestrated");
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
