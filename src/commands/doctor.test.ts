// FILE: src/commands/doctor.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify doctor command TUI-aware, OpenCode-compatible, role-aware diagnostics, invalid config reporting, and failure signaling.
//   SCOPE: OpenCode version compatibility, TUI source/registration reporting, canonical role inventory output, unresolved role-reference problem reporting, invalid config diagnostics, and non-zero exit behavior.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/commands/doctor.ts, src/lib/opencode.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-CLI-COMMANDS, V-M-CLI-COMMANDS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   doctor command tests - Verify unresolved vv-role references and invalid vvoc config diagnostics surface in Problems with exitCode=1.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.2 - Added OpenCode host compatibility diagnostic coverage.]
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added managed TUI source, parse, and registration diagnostic coverage.]
//   LAST_CHANGE: [v0.2.0 - Added invalid vvoc config doctor diagnostics without mutation coverage.]
//   LAST_CHANGE: [v0.0.0 - Initial GRACE compliance: added missing CHANGE_SUMMARY.]
// END_CHANGE_SUMMARY

import { expect, test } from "bun:test";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import doctorCommand from "./doctor.js";
import {
  ensurePackageInstalled,
  ensureTuiPackageInstalled,
  installVvocConfig,
  resolvePaths,
  syncManagedAgentRegistrations,
} from "../lib/opencode.js";
import { createDefaultVvocConfig } from "../lib/vvoc-config.js";

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
    await ensureTuiPackageInstalled(paths);
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
    process.exitCode = 0;

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
    expect(stdout).toContain(`OpenCode TUI source: project ${paths.opencodeTuiConfigPath}`);
    expect(stdout).toContain("OpenCode TUI config parse: ok");
    expect(stdout).toContain("OpenCode version:");
    expect(stdout).toContain("OpenCode TUI minimum: 1.18.2");
    expect(stdout).toContain("TUI package configured: yes");
    expect(stderr).toContain("Problems:");
    expect(stderr).toContain(
      "unresolved role reference at model: vv-role:missing (missing role: missing)",
    );
    expect(process.exitCode ?? 0).toBe(1);
  } finally {
    process.chdir(initialCwd);
    process.exitCode = initialExitCode ?? 0;
    await rm(configHome, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("doctor reports invalid vvoc config and exits non-zero without mutating it", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-doctor-invalid-config-"));
  const projectDir = await mkdtemp(join(tmpdir(), "vvoc-doctor-invalid-project-"));
  const initialCwd = process.cwd();
  const initialExitCode = process.exitCode;

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
      JSON.stringify({ ...createDefaultVvocConfig(), version: 2 }, null, 2) + "\n";
    await writeFile(paths.vvocConfigPath, invalidText, "utf8");

    process.chdir(projectDir);
    process.exitCode = 0;

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

    expect(stdout).toContain(`vvoc config: ${paths.vvocConfigPath}`);
    expect(stdout).toContain("vvoc config parse:");
    expect(stdout).toContain("version");
    expect(stderr).toContain("Problems:");
    expect(stderr).toContain(paths.vvocConfigPath);
    expect(process.exitCode ?? 0).toBe(1);
    expect(await readFile(paths.vvocConfigPath, "utf8")).toBe(invalidText);
  } finally {
    process.chdir(initialCwd);
    process.exitCode = initialExitCode ?? 0;
    await rm(configHome, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("doctor reports malformed TUI config and exits non-zero without mutating it", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-doctor-invalid-tui-config-"));
  const projectDir = await mkdtemp(join(tmpdir(), "vvoc-doctor-invalid-tui-project-"));
  const initialCwd = process.cwd();
  const initialExitCode = process.exitCode;

  try {
    const paths = await resolvePaths({
      scope: "project",
      cwd: projectDir,
      configDir: configHome,
    });
    await ensurePackageInstalled(paths);
    await installVvocConfig(paths);
    const invalidText = '{ "plugin": [["broken"]] }\n';
    await writeFile(paths.opencodeTuiConfigPath, invalidText, "utf8");

    process.chdir(projectDir);
    process.exitCode = 0;
    const { stdout, stderr } = await captureOutput(async () => {
      await (
        doctorCommand as { run: (context: { args: Record<string, unknown> }) => Promise<void> }
      ).run({ args: { scope: "project", "config-dir": configHome } });
    });

    expect(stdout).toContain(`OpenCode TUI config: ${paths.opencodeTuiConfigPath}`);
    expect(stdout).toContain("OpenCode TUI config parse:");
    expect(stdout).toContain('expected "plugin[0]"');
    expect(stderr).toContain(paths.opencodeTuiConfigPath);
    expect(process.exitCode ?? 0).toBe(1);
    expect(await readFile(paths.opencodeTuiConfigPath, "utf8")).toBe(invalidText);
  } finally {
    process.chdir(initialCwd);
    process.exitCode = initialExitCode ?? 0;
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
