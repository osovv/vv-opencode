// FILE: src/commands/preset.test.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-PRESET - declarative named preset workflows.
//   SCOPE: Default preset listing, preset rendering, partial role-only preset application, unknown preset failures, and bare-name CLI invocation.
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
//   LAST_CHANGE: [v0.4.0 - Switched preset coverage to canonical role-only writes and removed legacy OpenCode target mutation assertions.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPreset, formatPreset, listConfiguredPresets, resolvePreset } from "./preset.js";
import { readVvocConfig, resolvePaths } from "../lib/opencode.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";

describe("preset helpers", () => {
  test("listConfiguredPresets shows the seeded vv-openai, vv-zai, and vv-minimax presets", () => {
    const presets = listConfiguredPresets(createDefaultVvocConfig().presets).map(
      (entry) => entry.name,
    );
    expect(presets).toEqual(["vv-minimax", "vv-openai", "vv-zai"]);
  });

  test("formatPreset renders the expected preset object", () => {
    const resolved = resolvePreset("vv-openai", createDefaultVvocConfig().presets);
    const output = formatPreset(resolved.name, resolved.preset);

    expect(output).toContain(
      '"description": "Starter OpenAI role assignments for built-in vvoc roles."',
    );
    expect(output).toContain('"default": "openai/vv-gpt-5.4-xhigh"');
    expect(output).toContain('"smart": "openai/vv-gpt-5.4-xhigh"');
    expect(output).toContain('"fast": "openai/gpt-5.4-mini"');
    expect(output).toContain('"vision": "openai/gpt-4.1"');
  });
});

describe("applyPreset", () => {
  test("applies only the roles listed in the selected preset", async () => {
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
              description: "Partial OpenAI role preset",
              agents: {
                default: "openai/gpt-5.4",
                smart: "openai/gpt-5.4:xhigh",
              },
            },
            zai: defaultConfig.presets["vv-zai"],
          },
          roles: {
            ...defaultConfig.roles,
            "team-review": "anthropic/claude-sonnet-4-5:high",
          },
        }),
        "utf8",
      );

      const applied = await applyPreset("openai", {
        cwd: projectDir,
        configDir: configHome,
      });

      expect(applied.changes.map((change) => change.roleId)).toEqual(["default", "smart"]);

      const vvocConfig = await readVvocConfig(paths);
      expect(vvocConfig?.roles.default).toBe("openai/gpt-5.4");
      expect(vvocConfig?.roles.smart).toBe("openai/gpt-5.4:xhigh");
      expect(vvocConfig?.roles.fast).toBe(defaultConfig.roles.fast);
      expect(vvocConfig?.roles.vision).toBe(defaultConfig.roles.vision);
      expect(vvocConfig?.roles["team-review"]).toBe("anthropic/claude-sonnet-4-5:high");

      await expect(access(paths.opencodeConfigPath)).rejects.toBeDefined();
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
      ).rejects.toThrow(
        "unknown preset: missing. Available presets: vv-minimax, vv-openai, vv-zai",
      );
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("reuses schema validation for preset model selection values", async () => {
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
                  default: "not-a-model",
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
      ).rejects.toThrow(
        "INVALID_MODEL_SELECTION: modelSelection expected provider/model[:variant]",
      );
    } finally {
      await rm(configHome, { recursive: true, force: true });
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
        cmd: [process.execPath, "run", cliPath, "preset", "vv-zai", "--config-dir", configHome],
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
      expect(stdout).toContain("Applied preset vv-zai:");
      const vvocConfig = await readVvocConfig(paths);
      expect(vvocConfig?.roles.default).toBe("zai-coding-plan/glm-5.1");
      expect(vvocConfig?.roles.smart).toBe("zai-coding-plan/glm-5.1");
      expect(vvocConfig?.roles.fast).toBe("zai-coding-plan/glm-4.5-airx");
      expect(vvocConfig?.roles.vision).toBe("zai-coding-plan/glm-4.5v");
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
