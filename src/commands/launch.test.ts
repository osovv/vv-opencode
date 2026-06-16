// FILE: src/commands/launch.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify deterministic vvoc launch planning and subprocess exit behavior.
//   SCOPE: Effective/project/global source selection, env construction, passthrough argument forwarding, and exit-code preservation.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/commands/launch.ts]
//   LINKS: [M-CLI-COMMANDS, V-M-CLI-COMMANDS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   launch command tests - Verify buildLaunchPlan and runLaunch contracts.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Added launch planning and subprocess behavior coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLaunchPlan, runLaunch } from "./launch.js";

describe("launch planning", () => {
  test("effective scope selects nearest project OpenCode and vvoc configs", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-launch-project-"));
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-launch-global-"));

    try {
      await writeProjectLayer(projectDir);
      const plan = await buildLaunchPlan({
        scope: "effective",
        cwd: projectDir,
        configDir: configHome,
        passthroughArgs: ["run", "hello"],
        env: {},
      });

      expect(plan.command).toEqual(["opencode", "run", "hello"]);
      expect(plan.env.OPENCODE_CONFIG).toBe(join(projectDir, ".opencode", "opencode.json"));
      expect(plan.env.VVOC_CONFIG).toBe(join(projectDir, ".vvoc", "vvoc.json"));
    } finally {
      await rm(projectDir, { recursive: true, force: true });
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("project scope throws install hint when no local layer exists", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-launch-missing-project-"));

    try {
      await expect(
        buildLaunchPlan({ scope: "project", cwd: projectDir, passthroughArgs: [], env: {} }),
      ).rejects.toThrow("vvoc install --scope project");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("global scope sets global OpenCode and vvoc config env paths", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-launch-cwd-"));
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-launch-config-home-"));

    try {
      const plan = await buildLaunchPlan({
        scope: "global",
        cwd: projectDir,
        configDir: configHome,
        passthroughArgs: [],
        env: {},
      });

      expect(plan.env.OPENCODE_CONFIG).toBe(join(configHome, "opencode", "opencode.json"));
      expect(plan.env.VVOC_CONFIG).toBe(join(configHome, "vvoc", "vvoc.json"));
    } finally {
      await rm(projectDir, { recursive: true, force: true });
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("runLaunch forwards passthrough args and preserves child exit code", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-launch-run-"));

    try {
      await writeProjectLayer(projectDir);
      const exitCode = await runLaunch({
        scope: "project",
        cwd: projectDir,
        passthroughArgs: ["run", "hello"],
        spawn: async (plan) => {
          expect(plan.command).toEqual(["opencode", "run", "hello"]);
          expect(plan.env.OPENCODE_CONFIG).toContain(".opencode/opencode.json");
          expect(plan.env.VVOC_CONFIG).toContain(".vvoc/vvoc.json");
          return 7;
        },
      });

      expect(exitCode).toBe(7);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

async function writeProjectLayer(projectDir: string): Promise<void> {
  await mkdir(join(projectDir, ".opencode"), { recursive: true });
  await mkdir(join(projectDir, ".vvoc"), { recursive: true });
  await writeFile(join(projectDir, ".opencode", "opencode.json"), "{}\n", "utf8");
  await writeFile(
    join(projectDir, ".vvoc", "vvoc.json"),
    JSON.stringify(
      {
        $schema: "https://example.com/schema.json",
        version: 3,
        roles: {
          default: "openai/gpt-5.4",
          smart: "openai/vv-gpt-5.5-xhigh",
          fast: "openai/gpt-5.4-mini",
          vision: "openai/gpt-5.4",
        },
        guardian: { timeoutMs: 90000, approvalRiskThreshold: 80, reviewToastDurationMs: 90000 },
        secretsRedaction: {
          secret: "${VVOC_SECRET}",
          ttlMs: 3600000,
          maxMappings: 10000,
          patterns: { keywords: [], regex: [], builtin: [], exclude: [] },
          debug: false,
        },
        presets: {},
        plugins: {},
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}
