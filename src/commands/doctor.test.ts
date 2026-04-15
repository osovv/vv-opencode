// FILE: src/commands/doctor.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify doctor command role-aware diagnostics and failure signaling.
//   SCOPE: Canonical role inventory output and unresolved role-reference problem reporting with non-zero exit behavior.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/commands/doctor.ts, src/lib/opencode.ts]
//   LINKS: [V-M-CLI-COMMANDS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   doctor command tests - Verify unresolved vv-role references surface in Problems with exitCode=1.
// END_MODULE_MAP

import { expect, test } from "bun:test";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import doctorCommand from "./doctor.js";
import {
  ensurePackageInstalled,
  installVvocConfig,
  resolvePaths,
  syncManagedAgentRegistrations,
} from "../lib/opencode.js";

test("doctor reports unresolved role refs as problems and exits non-zero", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-doctor-config-"));
  const projectDir = await mkdtemp(join(tmpdir(), "vvoc-doctor-project-"));
  const initialCwd = process.cwd();
  const initialExitCode = process.exitCode;

  try {
    const paths = await resolvePaths({
      scope: "project",
      cwd: projectDir,
      configDir: configHome,
    });

    await ensurePackageInstalled(paths);
    await syncManagedAgentRegistrations(paths);
    await installVvocConfig(paths);

    const opencodeConfig = JSON.parse(await readFile(paths.opencodeConfigPath, "utf8")) as {
      model?: string;
    };
    opencodeConfig.model = "vv-role:missing";
    await writeFile(
      paths.opencodeConfigPath,
      JSON.stringify(opencodeConfig, null, 2) + "\n",
      "utf8",
    );

    process.chdir(projectDir);
    process.exitCode = undefined;

    const { stdout, stderr } = await captureOutput(async () => {
      await (
        doctorCommand as { run: (context: { args: Record<string, unknown> }) => Promise<void> }
      ).run({
        args: {
          scope: "project",
          "config-dir": configHome,
        },
      });
    });

    expect(stdout).toContain("Roles:");
    expect(stderr).toContain("Problems:");
    expect(stderr).toContain(
      "unresolved role reference at model: vv-role:missing (missing role: missing)",
    );
    expect(process.exitCode ?? 0).toBe(1);
  } finally {
    process.chdir(initialCwd);
    process.exitCode = initialExitCode;
    await rm(configHome, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

async function captureOutput(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  console.log = (...args: unknown[]) => {
    stdoutChunks.push(args.map((arg) => String(arg)).join(" ") + "\n");
  };
  console.error = (...args: unknown[]) => {
    stderrChunks.push(args.map((arg) => String(arg)).join(" ") + "\n");
  };

  try {
    await fn();
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  return {
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}
