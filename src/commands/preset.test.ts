// FILE: src/commands/preset.test.ts
// VERSION: 0.4.2
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-PRESET - declarative named preset workflows.
//   SCOPE: Default preset listing, preset rendering, role-only preset application, no-opencode rewrite guarantees, non-role section preservation, unknown preset failures, and CLI argument validation paths.
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
//   LAST_CHANGE: [v0.4.1 - Added guards for no-sync side effects: existing OpenCode byte preservation, vvoc non-role section/preset preservation, and CLI argument error paths.]
//   LAST_CHANGE: [v0.4.2 - Asserted raw vvoc.json section/preset preservation and first-run bootstrap behavior when the vvoc config path is missing.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(output).toContain('"vision": "openai/gpt-5.4"');
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

  test("keeps an existing OpenCode config byte-for-byte unchanged", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-preset-opencode-stable-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-preset-opencode-project-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
        configDir: configHome,
      });

      await mkdir(join(configHome, "vvoc"), { recursive: true });
      await writeFile(paths.vvocConfigPath, renderVvocConfig(createDefaultVvocConfig()), "utf8");

      const opencodeText =
        '{\n  "$schema": "https://opencode.ai/config.json",\n  "plugin": ["example/plugin"],\n  "agent": {\n    "general": {\n      "model": "vv-role:default"\n    }\n  }\n}\n';
      await writeFile(paths.opencodeConfigPath, opencodeText, "utf8");

      await applyPreset("vv-zai", {
        cwd: projectDir,
        configDir: configHome,
      });

      const afterText = await readFile(paths.opencodeConfigPath, "utf8");
      expect(afterText).toBe(opencodeText);
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("preserves non-role vvoc sections and preset blocks during apply", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-preset-preserve-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-preset-preserve-project-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
        configDir: configHome,
      });
      const defaultConfig = createDefaultVvocConfig();
      const seededConfig = {
        ...defaultConfig,
        guardian: {
          ...defaultConfig.guardian,
          model: "anthropic/claude-sonnet-4-5",
          variant: "high",
          timeoutMs: 120_000,
        },
        memory: {
          ...defaultConfig.memory,
          reviewerModel: "zai-coding-plan/glm-4.5-airx",
          reviewerVariant: "high",
        },
        secretsRedaction: {
          ...defaultConfig.secretsRedaction,
          debug: true,
        },
        presets: {
          ...defaultConfig.presets,
          "vv-openai": {
            ...defaultConfig.presets["vv-openai"],
            description: "user-overridden managed preset description",
          },
          custom: {
            description: "Custom role preset",
            agents: {
              default: "openai/gpt-5.4",
            },
          },
        },
      };

      await mkdir(join(configHome, "vvoc"), { recursive: true });
      await writeFile(paths.vvocConfigPath, `${JSON.stringify(seededConfig, null, 2)}\n`, "utf8");

      const before = JSON.parse(await readFile(paths.vvocConfigPath, "utf8"));
      await applyPreset("custom", {
        cwd: projectDir,
        configDir: configHome,
      });
      const after = JSON.parse(await readFile(paths.vvocConfigPath, "utf8"));

      expect(before.guardian).toEqual(after.guardian);
      expect(before.memory).toEqual(after.memory);
      expect(before.secretsRedaction).toEqual(after.secretsRedaction);
      expect(before.presets).toEqual(after.presets);
      expect(after.presets["vv-openai"].description).toBe(
        "user-overridden managed preset description",
      );
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("bootstraps canonical vvoc config when missing", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-preset-bootstrap-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-preset-bootstrap-project-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: projectDir,
        configDir: configHome,
      });

      await rm(join(configHome, "vvoc"), { recursive: true, force: true });
      await applyPreset("vv-openai", {
        cwd: projectDir,
        configDir: configHome,
      });

      const bootstrapped = JSON.parse(await readFile(paths.vvocConfigPath, "utf8"));
      expect(bootstrapped.version).toBe(3);
      expect(bootstrapped.roles.default).toBe("openai/vv-gpt-5.4-xhigh");
      expect(bootstrapped.presets["vv-openai"]).toBeDefined();
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
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
      expect(vvocConfig?.roles.vision).toBe("zai-coding-plan/glm-4.6v");
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("cli reports expected argument validation errors", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-preset-cli-errors-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-preset-cli-errors-project-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
        configDir: configHome,
      });

      await mkdir(join(configHome, "vvoc"), { recursive: true });
      await writeFile(paths.vvocConfigPath, renderVvocConfig(createDefaultVvocConfig()), "utf8");

      const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));

      const showMissing = Bun.spawn({
        cmd: [process.execPath, "run", cliPath, "preset", "show", "--config-dir", configHome],
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const listExtra = Bun.spawn({
        cmd: [
          process.execPath,
          "run",
          cliPath,
          "preset",
          "list",
          "vv-openai",
          "--config-dir",
          configHome,
        ],
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const bareExtra = Bun.spawn({
        cmd: [
          process.execPath,
          "run",
          cliPath,
          "preset",
          "vv-openai",
          "extra",
          "--config-dir",
          configHome,
        ],
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [showStderr, showExit, listStderr, listExit, bareStderr, bareExit] = await Promise.all([
        new Response(showMissing.stderr).text(),
        showMissing.exited,
        new Response(listExtra.stderr).text(),
        listExtra.exited,
        new Response(bareExtra.stderr).text(),
        bareExtra.exited,
      ]);

      expect(showExit).toBe(1);
      expect(showStderr).toContain("preset name required for `vvoc preset show <name>`");

      expect(listExit).toBe(1);
      expect(listStderr).toContain("unexpected extra argument for `vvoc preset list`: vv-openai");

      expect(bareExit).toBe(1);
      expect(bareStderr).toContain("unexpected extra argument for `vvoc preset <name>`: extra");
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
