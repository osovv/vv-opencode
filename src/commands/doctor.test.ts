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
//   captureOutput - Captures doctor command output and exit behavior for assertions.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-WORKFLOW-PROMPT-SYNC-DOCTOR-ARCHIVE T-003 - Added warning coverage for stale managed prompts and skills, duplicate skills roots, deprecated permission actions, and missing {file:} problem behavior.]
// END_CHANGE_SUMMARY

import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import doctorCommand from "./doctor.js";
import {
  ensurePackageInstalled,
  installManagedAgentPrompts,
  installManagedSkillFiles,
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
    await syncManagedAgentRegistrations(paths);
    await installVvocConfig(paths);

    const opencodeConfig = JSON.parse(await readFile(paths.opencodeConfigPath, "utf8")) as {
      plugins?: Array<string | { package: string; options?: Record<string, unknown> }>;
    };
    const managedEntry = opencodeConfig.plugins?.find(
      (entry) => typeof entry === "object" && entry.package.includes("vv-opencode"),
    );
    if (!managedEntry || typeof managedEntry === "string") {
      throw new Error("managed plugin entry missing");
    }
    managedEntry.options = { modelIntent: { model: "vv-role:missing" } };
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
    expect(stdout).toContain("OpenCode version:");
    expect(stdout).toContain("OpenCode supported range: >=2.0.18 <3.0.0");
    expect(stdout).toContain("TUI package registered: yes");
    expect(stderr).toContain("Problems:");
    expect(stderr).toContain(
      "unresolved role reference at modelIntent.model: vv-role:missing (missing role: missing)",
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

test("doctor reports prompt, skill, duplicate-root, and permission drift as warnings without failing", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-doctor-drift-config-"));
  const projectDir = await mkdtemp(join(tmpdir(), "vvoc-doctor-drift-project-"));
  const initialCwd = process.cwd();
  const initialExitCode = process.exitCode;
  const initialPath = process.env.PATH;

  try {
    const paths = await resolvePaths({
      scope: "project",
      cwd: projectDir,
      configDir: configHome,
    });
    await ensurePackageInstalled(paths);
    await syncManagedAgentRegistrations(paths);
    await installVvocConfig(paths);
    await installManagedAgentPrompts(paths, { force: true });
    await installManagedSkillFiles(paths, { force: true });

    // Doctor probes the host version; the CI runner has no OpenCode binary.
    const binDir = join(projectDir, "bin");
    await mkdir(binDir, { recursive: true });
    const fakeOpenCode = join(binDir, "opencode");
    await writeFile(fakeOpenCode, "#!/bin/sh\necho 2.2.5\n", "utf8");
    await chmod(fakeOpenCode, 0o755);
    process.env.PATH = `${binDir}:${initialPath ?? ""}`;

    const controllerPath = join(paths.managedAgentsDirPath, "vv-controller.md");
    await writeFile(controllerPath, `${await readFile(controllerPath, "utf8")}\nSTALE\n`, "utf8");
    const skillPath = join(paths.managedSkillsDirPath, "vv-execute", "SKILL.md");
    await writeFile(skillPath, `${await readFile(skillPath, "utf8")}\nSTALE\n`, "utf8");

    const config = JSON.parse(await readFile(paths.opencodeConfigPath, "utf8")) as {
      skills?: string[];
      permissions?: Array<Record<string, unknown>>;
    };
    config.skills = [".vvoc/skills", join(projectDir, ".vvoc", "skills")];
    config.permissions = [{ action: "apply_patch", resource: "*", effect: "deny" }];
    await writeFile(paths.opencodeConfigPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    process.chdir(projectDir);
    process.exitCode = 0;
    const { stdout } = await captureOutput(async () => {
      await (
        doctorCommand as { run: (context: { args: Record<string, unknown> }) => Promise<void> }
      ).run({ args: { scope: "project", "config-dir": configHome } });
    });

    expect(stdout).toContain("Warnings:");
    expect(stdout).toContain(controllerPath);
    expect(stdout).toContain(skillPath);
    expect(stdout).toContain("duplicate skills root");
    expect(stdout).toContain('permission action "apply_patch"');
    expect(process.exitCode ?? 0).toBe(0);
  } finally {
    process.chdir(initialCwd);
    process.exitCode = initialExitCode ?? 0;
    process.env.PATH = initialPath;
    await rm(configHome, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("doctor keeps a missing {file:} reference as a problem", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-doctor-missing-file-config-"));
  const projectDir = await mkdtemp(join(tmpdir(), "vvoc-doctor-missing-file-project-"));
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
    const config = JSON.parse(await readFile(paths.opencodeConfigPath, "utf8")) as {
      agents?: Record<string, Record<string, unknown>>;
    };
    config.agents = { "vv-controller": { system: "{file:./missing.md}" } };
    await writeFile(paths.opencodeConfigPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    process.chdir(projectDir);
    process.exitCode = 0;
    const { stderr } = await captureOutput(async () => {
      await (
        doctorCommand as { run: (context: { args: Record<string, unknown> }) => Promise<void> }
      ).run({ args: { scope: "project", "config-dir": configHome } });
    });

    expect(stderr).toContain("Problems:");
    expect(stderr).toContain("unresolved {file:} reference");
    expect(process.exitCode ?? 0).toBe(1);
  } finally {
    process.chdir(initialCwd);
    process.exitCode = initialExitCode ?? 0;
    await rm(configHome, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("doctor reports malformed native plugins and exits non-zero without mutating it", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-doctor-invalid-opencode-config-"));
  const projectDir = await mkdtemp(join(tmpdir(), "vvoc-doctor-invalid-opencode-project-"));
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
    const invalidText = '{ "plugins": [["broken"]] }\n';
    await writeFile(paths.opencodeConfigPath, invalidText, "utf8");

    process.chdir(projectDir);
    process.exitCode = 0;
    const { stdout, stderr } = await captureOutput(async () => {
      await (
        doctorCommand as { run: (context: { args: Record<string, unknown> }) => Promise<void> }
      ).run({ args: { scope: "project", "config-dir": configHome } });
    });

    expect(stdout).toContain("OpenCode config parse:");
    expect(stdout).toContain('expected "plugins[0]"');
    expect(stderr).toContain(paths.opencodeConfigPath);
    expect(process.exitCode ?? 0).toBe(1);
    expect(await readFile(paths.opencodeConfigPath, "utf8")).toBe(invalidText);
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
