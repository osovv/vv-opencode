// FILE: src/commands/preset.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-PRESET - declarative named preset workflows.
//   SCOPE: Default preset listing, preset rendering, partial preset application, unknown preset failures, and special-agent syntax validation through canonical vvoc.json parsing.
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
//   LAST_CHANGE: [v0.1.0 - Added coverage for default preset discovery, show formatting, partial application, and validation failures.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPreset, formatPreset, listConfiguredPresets, resolvePreset } from "./preset.js";
import {
  readOpenCodeAgentModel,
  readVvocConfig,
  resolvePaths,
  writeGuardianConfig,
  writeMemoryConfig,
  writeOpenCodeAgentModel,
} from "../lib/opencode.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";

describe("preset helpers", () => {
  test("listConfiguredPresets shows the seeded openai and zai presets", () => {
    const presets = listConfiguredPresets(createDefaultVvocConfig().presets).map(
      (entry) => entry.name,
    );
    expect(presets).toEqual(["openai", "zai"]);
  });

  test("formatPreset renders the expected preset object", () => {
    const resolved = resolvePreset("openai", createDefaultVvocConfig().presets);
    const output = formatPreset(resolved.name, resolved.preset);

    expect(output).toContain('"description": "Starter OpenAI overrides for common vvoc agents."');
    expect(output).toContain('"guardian": "openai/gpt-5:high"');
    expect(output).toContain('"general": "openai/gpt-5-mini"');
  });
});

describe("applyPreset", () => {
  test("applies only the agents listed in the selected preset", async () => {
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
                guardian: "openai/gpt-5:high",
                general: "openai/gpt-5-mini",
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

      expect(applied.changes.map((change) => change.agentName)).toEqual(["guardian", "general"]);

      const vvocConfig = await readVvocConfig(paths);
      expect(vvocConfig?.guardian.model).toBe("openai/gpt-5");
      expect(vvocConfig?.guardian.variant).toBe("high");
      expect(vvocConfig?.memory.reviewerModel).toBe("anthropic/claude-sonnet-4-5");
      expect(vvocConfig?.memory.reviewerVariant).toBe("high");

      expect(await readOpenCodeAgentModel(paths, "general")).toBe("openai/gpt-5-mini");
      expect(await readOpenCodeAgentModel(paths, "explore")).toBe("anthropic/claude-sonnet-4-5");
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
      expect(opencodeText).toContain('"general"');
      expect(opencodeText).toContain('"explore"');
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
