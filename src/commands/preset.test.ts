// FILE: src/commands/preset.test.ts
// VERSION: 0.2.2
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-PRESET - declarative named preset workflows.
//   SCOPE: Default preset listing, preset rendering, partial preset application including OpenCode default targets, unknown preset failures, and special-agent syntax validation through canonical vvoc.json parsing.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/commands/preset.ts, src/lib/opencode.ts, src/lib/vvoc-config.ts]
//   LINKS: [V-M-CLI-PRESET]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Test suite for preset resolution and application.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.2 - Added a CLI regression test for bare `vvoc preset <name>` dispatch.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPreset, formatPreset, listConfiguredPresets, resolvePreset } from "./preset.js";
import {
  readOpenCodeDefaultModel,
  readOpenCodeAgentModel,
  readVvocConfig,
  resolvePaths,
  writeGuardianConfig,
  writeMemoryConfig,
  writeOpenCodeAgentModel,
} from "../lib/opencode.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";

describe("preset helpers", () => {
  test("listConfiguredPresets shows the seeded openai, zai, and minimax presets", () => {
    const presets = listConfiguredPresets(createDefaultVvocConfig().presets).map(
      (entry) => entry.name,
    );
    expect(presets).toEqual(["minimax", "openai", "zai"]);
  });

  test("formatPreset renders the expected preset object", () => {
    const resolved = resolvePreset("openai", createDefaultVvocConfig().presets);
    const output = formatPreset(resolved.name, resolved.preset);

    expect(output).toContain(
      '"description": "Starter OpenAI overrides for common vvoc model targets."',
    );
    expect(output).toContain('"default": "openai/gpt-5.4:xhigh"');
    expect(output).toContain('"small-model": "openai/gpt-5.4-mini"');
    expect(output).toContain('"guardian": "openai/gpt-5.4-mini"');
    expect(output).toContain('"explore": "openai/gpt-5.4-mini"');
  });
});

describe("applyPreset", () => {
  test("applies only the targets listed in the selected preset", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-preset-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-preset-project-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
        configDir: configHome,
      });
      const defaultConfig = createDefaultVvocConfig();

      await mkdir(join(configHome, "vvoc"), { recursive: true });

      await writeFile(
        paths.vvocConfigPath,
        renderVvocConfig({
          ...defaultConfig,
          presets: {
            openai: {
              description: "Partial OpenAI preset",
              agents: {
                default: "openai/gpt-5.4:xhigh",
                guardian: "openai/gpt-5.4-mini",
                explore: "openai/gpt-5.4-mini",
              },
            },
            zai: defaultConfig.presets.zai,
          },
        }),
        "utf8",
      );

      await writeGuardianConfig(
        paths,
        { model: "anthropic/claude-sonnet-4-5", variant: "high" },
        { merge: true },
      );
      await writeMemoryConfig(
        paths,
        { reviewerModel: "anthropic/claude-sonnet-4-5", reviewerVariant: "high" },
        { merge: true },
      );
      await writeOpenCodeAgentModel(paths, "general", {
        model: "anthropic/claude-sonnet-4-5",
        ensureEntry: true,
      });
      await writeOpenCodeAgentModel(paths, "explore", {
        model: "anthropic/claude-sonnet-4-5",
        ensureEntry: true,
      });

      const applied = await applyPreset("openai", {
        cwd: projectDir,
        configDir: configHome,
        scope: "project",
      });

      expect(applied.changes.map((change) => change.targetName)).toEqual([
        "guardian",
        "default",
        "explore",
      ]);

      const vvocConfig = await readVvocConfig(paths);
      expect(vvocConfig?.guardian.model).toBe("openai/gpt-5.4-mini");
      expect(vvocConfig?.guardian.variant).toBeUndefined();
      expect(vvocConfig?.memory.reviewerModel).toBe("anthropic/claude-sonnet-4-5");
      expect(vvocConfig?.memory.reviewerVariant).toBe("high");

      expect(await readOpenCodeDefaultModel(paths, "model")).toBe("openai/gpt-5.4:xhigh");
      expect(await readOpenCodeAgentModel(paths, "general")).toBe("anthropic/claude-sonnet-4-5");
      expect(await readOpenCodeAgentModel(paths, "explore")).toBe("openai/gpt-5.4-mini");
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("fails clearly for an unknown preset", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-preset-missing-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });

      await mkdir(join(configHome, "vvoc"), { recursive: true });

      await writeFile(paths.vvocConfigPath, renderVvocConfig(createDefaultVvocConfig()), "utf8");

      await expect(
        applyPreset("missing", {
          cwd: "/workspace/project",
          configDir: configHome,
        }),
      ).rejects.toThrow("unknown preset: missing");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("reuses special-agent syntax validation for memory-reviewer models", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-preset-invalid-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });

      await mkdir(join(configHome, "vvoc"), { recursive: true });

      await writeFile(
        paths.vvocConfigPath,
        JSON.stringify(
          {
            ...createDefaultVvocConfig(),
            presets: {
              invalid: {
                agents: {
                  "memory-reviewer": "not-a-model",
                },
              },
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      await expect(
        applyPreset("invalid", {
          cwd: "/workspace/project",
          configDir: configHome,
        }),
      ).rejects.toThrow("/presets/invalid/agents/memory-reviewer");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("installs preset changes using the existing OpenCode write path", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-preset-raw-output-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-preset-raw-project-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
        configDir: configHome,
      });

      await mkdir(join(configHome, "vvoc"), { recursive: true });

      await writeFile(paths.vvocConfigPath, renderVvocConfig(createDefaultVvocConfig()), "utf8");
      await applyPreset("openai", {
        cwd: projectDir,
        configDir: configHome,
        scope: "project",
      });

      const opencodeText = await readFile(paths.opencodeConfigPath, "utf8");
      expect(opencodeText).toContain('"model": "openai/gpt-5.4:xhigh"');
      expect(opencodeText).toContain('"small_model": "openai/gpt-5.4-mini"');
      expect(opencodeText).toContain('"explore"');
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("cli applies a bare preset name without treating it as a subcommand", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-preset-cli-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-preset-cli-project-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
        configDir: configHome,
      });

      await mkdir(join(configHome, "vvoc"), { recursive: true });
      await writeFile(paths.vvocConfigPath, renderVvocConfig(createDefaultVvocConfig()), "utf8");

      const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
      const command = Bun.spawn({
        cmd: [
          process.execPath,
          "run",
          cliPath,
          "preset",
          "zai",
          "--scope",
          "project",
          "--config-dir",
          configHome,
        ],
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(command.stdout).text(),
        new Response(command.stderr).text(),
        command.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("Applied preset zai (project):");
      expect(await readOpenCodeDefaultModel(paths, "model")).toBe("zai-coding-plan/glm-5.1");
      expect(await readOpenCodeDefaultModel(paths, "small_model")).toBe(
        "zai-coding-plan/glm-4.5-air",
      );
      expect(await readOpenCodeAgentModel(paths, "explore")).toBe("zai-coding-plan/glm-4.5-air");
      expect((await readVvocConfig(paths))?.guardian.model).toBe("zai-coding-plan/glm-4.5-air");
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
