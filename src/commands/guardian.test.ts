// FILE: src/commands/guardian.test.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify Guardian CLI printing, scoped writes, preservation, and schema-safe numeric argument rejection.
//   SCOPE: Subprocess coverage for config reads/writes plus direct deterministic coverage of invalid positive-integer duration inputs.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, node:url, src/cli.ts, src/commands/guardian.ts, src/lib/vvoc-config.ts]
//   LINKS: M-CLI-GUARDIAN, M-CLI-CONFIG, V-M-CLI-GUARDIAN
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CLI_PATH - Registered CLI entrypoint used by isolated subprocess tests.
//   runGuardianConfig - Invoke the registered Guardian config CLI in an isolated subprocess.
//   parsePositiveIntegerArg tests - Reject fractional, non-finite, and non-positive duration values without subprocess contention.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.0 - Moved invalid-duration cases to direct parser coverage so the full suite does not spawn twelve redundant CLI processes.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePositiveIntegerArg } from "./guardian.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";

const CLI_PATH = fileURLToPath(new URL("../cli.ts", import.meta.url));

async function runGuardianConfig(args: string[], cwd: string) {
  const command = Bun.spawn({
    cmd: [process.execPath, "run", CLI_PATH, "guardian", "config", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
    command.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("guardian config CLI", () => {
  test("prints canonical defaults and valid normalized overrides", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vvoc-guardian-print-"));
    try {
      const defaults = await runGuardianConfig(["--print"], cwd);
      expect(defaults.exitCode).toBe(0);
      expect(defaults.stderr).toBe("");
      expect(JSON.parse(defaults.stdout)).toEqual({
        timeoutMs: 90_000,
        approvalRiskThreshold: 80,
        reviewToastDurationMs: 90_000,
      });

      const overridden = await runGuardianConfig(
        [
          "--print",
          "--model",
          " openai/gpt-5.6 ",
          "--timeout-ms",
          "1234",
          "--approval-risk-threshold",
          "55.6",
          "--review-toast-duration-ms",
          "5678",
        ],
        cwd,
      );
      expect(overridden.exitCode).toBe(0);
      expect(overridden.stderr).toBe("");
      expect(JSON.parse(overridden.stdout)).toEqual({
        model: "openai/gpt-5.6",
        timeoutMs: 1234,
        approvalRiskThreshold: 56,
        reviewToastDurationMs: 5678,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("rejects invalid positive-integer duration values", () => {
    for (const flag of ["--timeout-ms", "--review-toast-duration-ms"]) {
      const label = flag.slice(2);
      for (const value of ["0", "-1", "0.4", "1.5", "NaN", "Infinity"]) {
        expect(() => parsePositiveIntegerArg(value, label)).toThrow(
          `${label} must be a positive integer`,
        );
      }
    }
  });

  test("writes canonical global and project configs while preserving unrelated sections", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-guardian-global-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-guardian-project-"));
    try {
      const globalPath = join(configHome, "vvoc", "vvoc.json");
      const initial = createDefaultVvocConfig();
      initial.roles.custom = "anthropic/claude-sonnet-4-5";
      await mkdir(dirname(globalPath), { recursive: true });
      await writeFile(globalPath, renderVvocConfig(initial), "utf8");

      const globalResult = await runGuardianConfig(
        ["--config-dir", configHome, "--timeout-ms", "1234"],
        projectDir,
      );
      expect(globalResult.exitCode).toBe(0);
      expect(globalResult.stderr).toBe("");
      const globalConfig = JSON.parse(await readFile(globalPath, "utf8"));
      expect(globalConfig.guardian).toEqual({
        timeoutMs: 1234,
        approvalRiskThreshold: 80,
        reviewToastDurationMs: 1234,
      });
      expect(globalConfig.roles.custom).toBe("anthropic/claude-sonnet-4-5");

      const projectResult = await runGuardianConfig(
        [
          "--scope",
          "project",
          "--config-dir",
          configHome,
          "--timeout-ms",
          "2222",
          "--review-toast-duration-ms",
          "3333",
        ],
        projectDir,
      );
      expect(projectResult.exitCode).toBe(0);
      expect(projectResult.stderr).toBe("");
      const projectConfig = JSON.parse(
        await readFile(join(projectDir, ".vvoc", "vvoc.json"), "utf8"),
      );
      expect(projectConfig.guardian).toEqual({
        timeoutMs: 2222,
        approvalRiskThreshold: 80,
        reviewToastDurationMs: 3333,
      });
      expect(JSON.parse(await readFile(globalPath, "utf8")).guardian.timeoutMs).toBe(1234);
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("leaves invalid existing config bytes unchanged", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-guardian-invalid-config-"));
    const cwd = await mkdtemp(join(tmpdir(), "vvoc-guardian-invalid-cwd-"));
    const configPath = join(configHome, "vvoc", "vvoc.json");
    const invalidText = "{ invalid guardian config\n";
    try {
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, invalidText, "utf8");
      const result = await runGuardianConfig(
        ["--config-dir", configHome, "--timeout-ms", "1234"],
        cwd,
      );
      expect(result.exitCode).not.toBe(0);
      expect(await readFile(configPath, "utf8")).toBe(invalidText);
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
