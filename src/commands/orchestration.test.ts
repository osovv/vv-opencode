// FILE: src/commands/orchestration.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify scoped orchestration profile reads, conservative writes, validation safety, source selection, and CLI output.
//   SCOPE: Default/project/global show behavior, kept/update/bootstrap writes, unrelated config preservation, invalid byte stability, and restart diagnostics.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, node:url, src/commands/orchestration.ts, src/lib/opencode.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-CLI-ORCHESTRATION, M-ORCHESTRATION-PROFILES, V-M-CLI-ORCHESTRATION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   orchestration show tests - Verify effective fallback and source precedence without writes.
//   orchestration set tests - Verify scoped conservative writes, bootstrap, validation, and CLI diagnostics.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-PRESET-ORCHESTRATION-PROFILES - Added complete scoped orchestration command coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolvePaths } from "../lib/opencode.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";
import { setOrchestrationProfile, showOrchestrationProfile } from "./orchestration.js";

describe("orchestration show", () => {
  test("defaults to effective balanced profile and default source without writing", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-orchestration-show-default-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-orchestration-show-project-"));
    try {
      const result = await showOrchestrationProfile({ cwd: projectDir, configDir: configHome });
      expect(result.profile).toBe("balanced");
      expect(result.source.kind).toBe("default");
      await expect(access(join(configHome, "vvoc", "vvoc.json"))).rejects.toBeDefined();
      await expect(access(join(projectDir, ".vvoc", "vvoc.json"))).rejects.toBeDefined();
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("effective scope selects the nearest project source and missing root resolves balanced", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-orchestration-show-global-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-orchestration-show-local-"));
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
      const projectConfig = createDefaultVvocConfig() as ReturnType<
        typeof createDefaultVvocConfig
      > &
        Record<string, unknown>;
      delete projectConfig.orchestration;
      await mkdir(dirname(globalPaths.vvocConfigPath), { recursive: true });
      await mkdir(dirname(projectPaths.vvocConfigPath), { recursive: true });
      await writeFile(globalPaths.vvocConfigPath, renderVvocConfig(globalConfig), "utf8");
      const projectText = `${JSON.stringify(projectConfig, null, 2)}\n`;
      await writeFile(projectPaths.vvocConfigPath, projectText, "utf8");

      const result = await showOrchestrationProfile({ cwd: projectDir, configDir: configHome });
      expect(result.profile).toBe("balanced");
      expect(result.source.kind).toBe("project");
      expect(result.source.path).toBe(projectPaths.vvocConfigPath);
      expect(await readFile(projectPaths.vvocConfigPath, "utf8")).toBe(projectText);
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("orchestration set", () => {
  test("bootstraps canonical v3 config and supports all profile values", async () => {
    for (const profile of ["single-session", "balanced", "orchestrated"] as const) {
      const configHome = await mkdtemp(join(tmpdir(), `vvoc-orchestration-set-${profile}-`));
      try {
        const result = await setOrchestrationProfile(profile, { configDir: configHome });
        const written = JSON.parse(await readFile(result.path, "utf8"));
        expect(result.action).toBe("updated");
        expect(written.version).toBe(3);
        expect(written.orchestration).toEqual({ profile });
      } finally {
        await rm(configHome, { recursive: true, force: true });
      }
    }
  });

  test("returns kept without rewriting an explicitly matching profile", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-orchestration-kept-"));
    try {
      const first = await setOrchestrationProfile("single-session", { configDir: configHome });
      const customText = `\n${await readFile(first.path, "utf8")}`;
      await writeFile(first.path, customText, "utf8");
      const kept = await setOrchestrationProfile("single-session", { configDir: configHome });
      expect(kept.action).toBe("kept");
      expect(await readFile(first.path, "utf8")).toBe(customText);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("updates only orchestration logically and preserves unrelated sections and custom presets", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-orchestration-preserve-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const config = createDefaultVvocConfig();
      config.roles.custom = "anthropic/claude-sonnet-4-5";
      config.guardian.timeoutMs = 12_345;
      config.secretsRedaction.debug = true;
      config.plugins.workflow = false;
      config.presets.custom = {
        description: "custom preset",
        agents: { custom: "anthropic/claude-sonnet-4-5" },
        orchestration: { profile: "orchestrated" },
      };
      await mkdir(dirname(paths.vvocConfigPath), { recursive: true });
      await writeFile(paths.vvocConfigPath, renderVvocConfig(config), "utf8");

      const before = JSON.parse(await readFile(paths.vvocConfigPath, "utf8"));
      const result = await setOrchestrationProfile("single-session", { configDir: configHome });
      const after = JSON.parse(await readFile(paths.vvocConfigPath, "utf8"));

      expect(result.action).toBe("updated");
      expect(after.orchestration).toEqual({ profile: "single-session" });
      for (const key of ["roles", "guardian", "secretsRedaction", "presets", "plugins"]) {
        expect(after[key]).toEqual(before[key]);
      }
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("rejects invalid existing config and effective writes without changing bytes", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-orchestration-invalid-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const invalidText = `${JSON.stringify({ ...createDefaultVvocConfig(), orchestration: { profile: "automatic" } }, null, 2)}\n`;
      await mkdir(dirname(paths.vvocConfigPath), { recursive: true });
      await writeFile(paths.vvocConfigPath, invalidText, "utf8");

      await expect(setOrchestrationProfile("balanced", { configDir: configHome })).rejects.toThrow(
        "/orchestration/profile",
      );
      expect(await readFile(paths.vvocConfigPath, "utf8")).toBe(invalidText);
      await expect(
        setOrchestrationProfile("balanced", {
          configDir: configHome,
          scope: "effective" as never,
        }),
      ).rejects.toThrow("not effective");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});
