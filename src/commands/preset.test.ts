// FILE: src/commands/preset.test.ts
// VERSION: 0.5.1
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-PRESET - declarative named preset workflows.
//   SCOPE: Built-in profile mappings, preset rendering, atomic role/profile application, no-opencode rewrite guarantees, section preservation, invalid-write safety, and CLI output paths.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/commands/preset.ts, src/lib/opencode.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-CLI-PRESET, M-ORCHESTRATION-PROFILES, V-M-CLI-PRESET]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   [test scenarios] - Preset behavior coverage is expressed through module-level tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [direct fix - Extended preset assertions to the 11-preset order including vv-osovv-mimo with xiaomi/vv-mimo-v2.6-flash-high on default and smart.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPreset, formatPreset, listConfiguredPresets, resolvePreset } from "./preset.js";
import { readVvocConfig, resolvePaths } from "../lib/opencode.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";

describe("preset helpers", () => {
  test("createDefaultVvocConfig exposes the canonical built-in preset keys", () => {
    expect(Object.keys(createDefaultVvocConfig().presets)).toEqual([
      "vv-codex",
      "vv-zai",
      "vv-deepseek",
      "vv-kimi",
      "vv-alibaba",
      "vv-osovv-ds",
      "vv-osovv-mimo",
      "vv-osovv-zai",
      "vv-osovv-qwen",
      "vv-astra-solo",
      "vv-astra-workers",
    ]);
  });

  test("createDefaultVvocConfig omits the retired osovv presets", () => {
    const presets = createDefaultVvocConfig().presets;
    expect(presets["vv-osovv-sol"]).toBeUndefined();
    expect(presets["vv-osovv-flash"]).toBeUndefined();
    expect(presets["vv-osovv-kimi"]).toBeUndefined();
  });

  test("built-in presets expose the approved exact role matrix", () => {
    const presets = createDefaultVvocConfig().presets;
    expect(
      Object.fromEntries(
        Object.entries(presets).map(([name, preset]) => [
          name,
          {
            default: preset.agents.default,
            fast: preset.agents.fast,
            smart: preset.agents.smart,
            reviewer: preset.agents.reviewer,
            profile: preset.orchestration?.profile,
          },
        ]),
      ),
    ).toEqual({
      "vv-codex": {
        default: "openai/vv-codex-gpt-5.6-terra-high",
        fast: "openai/vv-codex-gpt-5.6-luna-low",
        smart: "openai/vv-codex-gpt-5.6-sol-xhigh",
        reviewer: "openai/vv-codex-gpt-5.6-sol-xhigh",
        profile: "single-session",
      },
      "vv-zai": {
        default: "zai-coding-plan/vv-glm-5.3-flash-max",
        fast: "zai-coding-plan/vv-glm-5.3-flash-max",
        smart: "zai-coding-plan/vv-glm-5.3-max",
        reviewer: "zai-coding-plan/vv-glm-5.3-max",
        profile: "balanced",
      },
      "vv-deepseek": {
        default: "deepseek/vv-deepseek-flash-max",
        fast: "deepseek/vv-deepseek-flash-max",
        smart: "deepseek/vv-deepseek-flash-max",
        reviewer: "deepseek/vv-deepseek-flash-max",
        profile: "balanced",
      },
      "vv-kimi": {
        default: "kimi-for-coding/k3",
        fast: "kimi-for-coding/kimi-for-coding-highspeed",
        smart: "kimi-for-coding/vv-kimi-k3-max",
        reviewer: "kimi-for-coding/kimi-for-coding",
        profile: "single-session",
      },
      "vv-alibaba": {
        default: "alibaba-token-plan/qwen3.8-max",
        fast: "alibaba-token-plan/deepseek-v4-flash",
        smart: "alibaba-token-plan/vv-qwen3.8-max-xhigh",
        reviewer: "alibaba-token-plan/glm-5.2",
        profile: "single-session",
      },
      "vv-osovv-ds": {
        default: "deepseek/vv-deepseek-flash-max",
        fast: "openai/vv-codex-gpt-5.6-luna-low",
        smart: "deepseek/vv-deepseek-flash-max",
        reviewer: "zai-coding-plan/vv-glm-5.3-max",
        profile: "single-session",
      },
      "vv-osovv-mimo": {
        default: "xiaomi/vv-mimo-v2.6-flash-high",
        fast: "openai/vv-codex-gpt-5.6-luna-low",
        smart: "xiaomi/vv-mimo-v2.6-flash-high",
        reviewer: "zai-coding-plan/vv-glm-5.3-max",
        profile: "single-session",
      },
      "vv-osovv-zai": {
        default: "deepseek/vv-deepseek-flash-max",
        fast: "openai/vv-codex-gpt-5.6-luna-low",
        smart: "zai-coding-plan/vv-glm-5.3-max",
        reviewer: "zai-coding-plan/vv-glm-5.3-max",
        profile: "single-session",
      },
      "vv-osovv-qwen": {
        default: "deepseek/vv-deepseek-flash-max",
        fast: "openai/vv-codex-gpt-5.6-luna-low",
        smart: "alibaba-token-plan/vv-qwen3.8-max-xhigh",
        reviewer: "zai-coding-plan/vv-glm-5.3-max",
        profile: "delegated",
      },
      "vv-astra-solo": {
        default: "openai/vv-codex-gpt-6-astra-max",
        fast: "openai/vv-codex-gpt-5.6-luna-low",
        smart: "openai/vv-codex-gpt-6-astra-max",
        reviewer: "zai-coding-plan/vv-glm-5.3-high",
        profile: "single-session",
      },
      "vv-astra-workers": {
        default: "deepseek/vv-deepseek-flash-high",
        fast: "openai/vv-codex-gpt-5.6-luna-low",
        smart: "openai/vv-codex-gpt-6-astra-max",
        reviewer: "zai-coding-plan/vv-glm-5.3-high",
        profile: "delegated",
      },
    });
  });

  test("no shipped preset assignment selects the legacy Spark alias", () => {
    const presets = createDefaultVvocConfig().presets;
    const shippedAssignments = Object.entries(presets).flatMap(([presetName, preset]) =>
      Object.entries(preset.agents).flatMap(([roleId, modelSelection]) =>
        modelSelection === undefined ? [] : [{ presetName, roleId, modelSelection }],
      ),
    );
    expect(shippedAssignments.length).toBeGreaterThan(0);
    const sparkAssignments = shippedAssignments.filter(({ modelSelection }) =>
      modelSelection.includes("gpt-5.3-codex-spark"),
    );
    expect(sparkAssignments).toEqual([]);
  });

  test("built-in presets expose the approved orchestration mapping", () => {
    const presets = createDefaultVvocConfig().presets;
    expect(
      Object.fromEntries(
        Object.entries(presets).map(([name, preset]) => [name, preset.orchestration?.profile]),
      ),
    ).toEqual({
      "vv-codex": "single-session",
      "vv-zai": "balanced",
      "vv-deepseek": "balanced",
      "vv-kimi": "single-session",
      "vv-alibaba": "single-session",
      "vv-osovv-ds": "single-session",
      "vv-osovv-mimo": "single-session",
      "vv-osovv-zai": "single-session",
      "vv-osovv-qwen": "delegated",
      "vv-astra-solo": "single-session",
      "vv-astra-workers": "delegated",
    });
  });

  test("listConfiguredPresets shows the seeded built-in presets", () => {
    const presets = listConfiguredPresets(createDefaultVvocConfig().presets).map(
      (entry) => entry.name,
    );
    expect(presets).toEqual([
      "vv-alibaba",
      "vv-astra-solo",
      "vv-astra-workers",
      "vv-codex",
      "vv-deepseek",
      "vv-kimi",
      "vv-osovv-ds",
      "vv-osovv-mimo",
      "vv-osovv-qwen",
      "vv-osovv-zai",
      "vv-zai",
    ]);
  });

  test("formatPreset renders the expected preset object", () => {
    const resolved = resolvePreset("vv-codex", createDefaultVvocConfig().presets);
    const output = formatPreset(resolved.name, resolved.preset);

    expect(output).toContain(
      '"description": "Starter Codex subscription role assignments for built-in vvoc roles."',
    );
    expect(output).toContain('"default": "openai/vv-codex-gpt-5.6-terra-high"');
    expect(output).toContain('"smart": "openai/vv-codex-gpt-5.6-sol-xhigh"');
    expect(output).toContain('"fast": "openai/vv-codex-gpt-5.6-luna-low"');
    expect(output).toContain('"reviewer": "openai/vv-codex-gpt-5.6-sol-xhigh"');
  });

  test("formatPreset renders all four vv-osovv-ds role assignments", () => {
    const resolved = resolvePreset("vv-osovv-ds", createDefaultVvocConfig().presets);
    const output = formatPreset(resolved.name, resolved.preset);
    expect(output).toContain('"default": "deepseek/vv-deepseek-flash-max"');
    expect(output).toContain('"fast": "openai/vv-codex-gpt-5.6-luna-low"');
    expect(output).toContain('"smart": "deepseek/vv-deepseek-flash-max"');
    expect(output).toContain('"reviewer": "zai-coding-plan/vv-glm-5.3-max"');
  });

  test("formatPreset renders all four vv-osovv-mimo role assignments", () => {
    const resolved = resolvePreset("vv-osovv-mimo", createDefaultVvocConfig().presets);
    const output = formatPreset(resolved.name, resolved.preset);
    expect(output).toContain('"default": "xiaomi/vv-mimo-v2.6-flash-high"');
    expect(output).toContain('"fast": "openai/vv-codex-gpt-5.6-luna-low"');
    expect(output).toContain('"smart": "xiaomi/vv-mimo-v2.6-flash-high"');
    expect(output).toContain('"reviewer": "zai-coding-plan/vv-glm-5.3-max"');
    expect(output).toContain("single-session");
  });

  test("formatPreset renders all four vv-osovv-zai role assignments", () => {
    const resolved = resolvePreset("vv-osovv-zai", createDefaultVvocConfig().presets);
    const output = formatPreset(resolved.name, resolved.preset);
    expect(output).toContain('"default": "deepseek/vv-deepseek-flash-max"');
    expect(output).toContain('"fast": "openai/vv-codex-gpt-5.6-luna-low"');
    expect(output).toContain('"smart": "zai-coding-plan/vv-glm-5.3-max"');
    expect(output).toContain('"reviewer": "zai-coding-plan/vv-glm-5.3-max"');
  });

  test("formatPreset renders the vv-osovv-qwen delegated assignments", () => {
    const resolved = resolvePreset("vv-osovv-qwen", createDefaultVvocConfig().presets);
    const output = formatPreset(resolved.name, resolved.preset);
    expect(output).toContain('"default": "deepseek/vv-deepseek-flash-max"');
    expect(output).toContain('"fast": "openai/vv-codex-gpt-5.6-luna-low"');
    expect(output).toContain('"smart": "alibaba-token-plan/vv-qwen3.8-max-xhigh"');
    expect(output).toContain('"reviewer": "zai-coding-plan/vv-glm-5.3-max"');
    expect(output).toContain("delegated");
  });

  test("formatPreset renders the vv-astra-solo explicit-reasoning assignments", () => {
    const resolved = resolvePreset("vv-astra-solo", createDefaultVvocConfig().presets);
    const output = formatPreset(resolved.name, resolved.preset);
    expect(output).toContain('"default": "openai/vv-codex-gpt-6-astra-max"');
    expect(output).toContain('"smart": "openai/vv-codex-gpt-6-astra-max"');
    expect(output).toContain('"fast": "openai/vv-codex-gpt-5.6-luna-low"');
    expect(output).toContain('"reviewer": "zai-coding-plan/vv-glm-5.3-high"');
    expect(output).toContain("single-session");
  });

  test("formatPreset renders the vv-astra-workers delegated assignments", () => {
    const resolved = resolvePreset("vv-astra-workers", createDefaultVvocConfig().presets);
    const output = formatPreset(resolved.name, resolved.preset);
    expect(output).toContain('"default": "deepseek/vv-deepseek-flash-high"');
    expect(output).toContain('"smart": "openai/vv-codex-gpt-6-astra-max"');
    expect(output).toContain('"fast": "openai/vv-codex-gpt-5.6-luna-low"');
    expect(output).toContain('"reviewer": "zai-coding-plan/vv-glm-5.3-high"');
    expect(output).toContain("delegated");
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

      await mkdir(dirname(paths.vvocConfigPath), { recursive: true });

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
        scope: "project",
      });

      expect(applied.changes.map((change) => change.roleId)).toEqual(["default", "smart"]);
      expect(applied.orchestration).toEqual({ profile: "balanced", action: "unchanged" });

      const vvocConfig = await readVvocConfig(paths);
      expect(vvocConfig?.roles.default).toBe("openai/gpt-5.4");
      expect(vvocConfig?.roles.smart).toBe("openai/gpt-5.4:xhigh");
      expect(vvocConfig?.roles.fast).toBe(defaultConfig.roles.fast);
      expect(vvocConfig?.roles["team-review"]).toBe("anthropic/claude-sonnet-4-5:high");
      expect(vvocConfig?.orchestration).toEqual({ profile: "balanced" });

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
        "unknown preset: missing. Available presets: vv-alibaba, vv-astra-solo, vv-astra-workers, vv-codex, vv-deepseek, vv-kimi, vv-osovv-ds, vv-osovv-mimo, vv-osovv-qwen, vv-osovv-zai, vv-zai",
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

      await mkdir(dirname(paths.vvocConfigPath), { recursive: true });
      await writeFile(paths.vvocConfigPath, renderVvocConfig(createDefaultVvocConfig()), "utf8");

      const opencodeText =
        '{\n  "$schema": "https://opencode.ai/config.json",\n  "plugin": ["example/plugin"],\n  "agent": {\n    "general": {\n      "model": "vv-role:default"\n    }\n  }\n}\n';
      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      await writeFile(paths.opencodeConfigPath, opencodeText, "utf8");

      await applyPreset("vv-zai", {
        cwd: projectDir,
        configDir: configHome,
        scope: "project",
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
          timeoutMs: 120_000,
        },
        secretsRedaction: {
          ...defaultConfig.secretsRedaction,
          debug: true,
        },
        presets: {
          ...defaultConfig.presets,
          "vv-codex": {
            ...defaultConfig.presets["vv-codex"],
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

      await mkdir(dirname(paths.vvocConfigPath), { recursive: true });
      await writeFile(paths.vvocConfigPath, `${JSON.stringify(seededConfig, null, 2)}\n`, "utf8");

      const before = JSON.parse(await readFile(paths.vvocConfigPath, "utf8"));
      const applied = await applyPreset("custom", {
        cwd: projectDir,
        configDir: configHome,
        scope: "project",
      });
      const after = JSON.parse(await readFile(paths.vvocConfigPath, "utf8"));

      expect(before.guardian).toEqual(after.guardian);
      expect(before.secretsRedaction).toEqual(after.secretsRedaction);
      expect(before.presets).toEqual(after.presets);
      expect(before.orchestration).toEqual(after.orchestration);
      expect(applied.orchestration).toEqual({ profile: "balanced", action: "unchanged" });
      expect(after.presets["vv-codex"].description).toBe(
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
      const applied = await applyPreset("vv-codex", {
        cwd: projectDir,
        configDir: configHome,
      });

      const bootstrapped = JSON.parse(await readFile(paths.vvocConfigPath, "utf8"));
      expect(bootstrapped.version).toBe(3);
      expect(bootstrapped.roles.default).toBe("openai/vv-codex-gpt-5.6-terra-high");
      expect(bootstrapped.roles.smart).toBe("openai/vv-codex-gpt-5.6-sol-xhigh");
      expect(bootstrapped.orchestration).toEqual({ profile: "single-session" });
      expect(applied.orchestration).toEqual({ profile: "single-session", action: "updated" });
      expect(bootstrapped.presets["vv-codex"]?.agents.default).toBe(
        "openai/vv-codex-gpt-5.6-terra-high",
      );
      expect(bootstrapped.presets["vv-codex"]?.agents.smart).toBe(
        "openai/vv-codex-gpt-5.6-sol-xhigh",
      );
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

      const originalText = await readFile(paths.vvocConfigPath, "utf8");
      await expect(
        applyPreset("invalid", {
          cwd: "/workspace/project",
          configDir: configHome,
        }),
      ).rejects.toThrow("INVALID_MODEL_SELECTION: modelSelection expected provider/model");
      expect(await readFile(paths.vvocConfigPath, "utf8")).toBe(originalText);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("profile-only preset changes write orchestration when all roles are kept", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-preset-profile-only-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const config = createDefaultVvocConfig();
      config.presets.custom = {
        agents: { default: config.roles.default },
        orchestration: { profile: "orchestrated" },
      };
      await mkdir(dirname(paths.vvocConfigPath), { recursive: true });
      await writeFile(paths.vvocConfigPath, renderVvocConfig(config), "utf8");

      const applied = await applyPreset("custom", { configDir: configHome });
      const updated = await readVvocConfig(paths);

      expect(applied.changes).toEqual([
        { roleId: "default", model: config.roles.default, action: "kept" },
      ]);
      expect(applied.orchestration).toEqual({ profile: "orchestrated", action: "updated" });
      expect(updated?.orchestration).toEqual({ profile: "orchestrated" });
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("invalid preset orchestration leaves the original vvoc bytes unchanged", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-preset-invalid-profile-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const invalidConfig = createDefaultVvocConfig() as unknown as Record<string, unknown>;
      invalidConfig.presets = {
        invalid: {
          agents: { default: "openai/gpt-5.4" },
          orchestration: { profile: "automatic" },
        },
      };
      const originalText = `${JSON.stringify(invalidConfig, null, 2)}\n`;
      await mkdir(dirname(paths.vvocConfigPath), { recursive: true });
      await writeFile(paths.vvocConfigPath, originalText, "utf8");

      await expect(applyPreset("invalid", { configDir: configHome })).rejects.toThrow(
        "/presets/invalid/orchestration/profile",
      );
      expect(await readFile(paths.vvocConfigPath, "utf8")).toBe(originalText);
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

      await mkdir(dirname(paths.vvocConfigPath), { recursive: true });
      await writeFile(paths.vvocConfigPath, renderVvocConfig(createDefaultVvocConfig()), "utf8");

      const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
      const command = Bun.spawn({
        cmd: [
          process.execPath,
          "run",
          cliPath,
          "preset",
          "vv-zai",
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
      expect(stdout).toContain("Applied preset vv-zai:");
      expect(stdout).toContain("orchestration: kept (balanced)");
      expect(stdout).toContain(`Target: ${paths.vvocConfigPath}`);
      expect(stdout).toContain(
        "Restart OpenCode to apply the changed roles or orchestration profile.",
      );
      const vvocConfig = await readVvocConfig(paths);
      expect(vvocConfig?.roles.default).toBe("zai-coding-plan/vv-glm-5.3-flash-max");
      expect(vvocConfig?.roles.smart).toBe("zai-coding-plan/vv-glm-5.3-max");
      expect(vvocConfig?.roles.fast).toBe("zai-coding-plan/vv-glm-5.3-flash-max");
      expect(vvocConfig?.orchestration).toEqual({ profile: "balanced" });
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("cli reports expected argument validation errors", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-preset-cli-errors-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-preset-cli-errors-project-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
        configDir: configHome,
      });

      await mkdir(dirname(paths.vvocConfigPath), { recursive: true });
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
          "vv-codex",
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
          "vv-codex",
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
      expect(listStderr).toContain("unexpected extra argument for `vvoc preset list`: vv-codex");

      expect(bareExit).toBe(1);
      expect(bareStderr).toContain("unexpected extra argument for `vvoc preset <name>`: extra");
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  }, 20_000);
});
