// FILE: src/commands/status.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify status command role-aware installation reporting.
//   SCOPE: Canonical role inventory rendering and deterministic built-in role ordering.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/commands/status.ts, src/lib/opencode.ts]
//   LINKS: [V-M-CLI-COMMANDS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   status command tests - Verify role inventory output from installation inspection.
// END_MODULE_MAP

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import statusCommand from "./status.js";
import {
  ensurePackageInstalled,
  installVvocConfig,
  resolvePaths,
  syncManagedAgentRegistrations,
} from "../lib/opencode.js";

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
