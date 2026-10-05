// FILE: src/lib/opencode.test.ts
// VERSION: 1.4.2
// START_MODULE_CONTRACT
//   PURPOSE: Verify OpenCode runtime/TUI config mutation and canonical vvoc config path/helpers.
//   SCOPE: Runtime/TUI plugin specifier writes and legacy migration, OpenCode host compatibility, role-reference OpenCode defaults/agent/tool rewrites, managed prompt/plan scaffolding, canonical vvoc schema v3 writes, strict pre-role schema rejection, inspection, and scope-aware path resolution behavior.
//   DEPENDS: [bun:test, jsonc-parser, src/lib/opencode.ts]
//   LINKS: [M-CLI-CONFIG, V-M-CLI-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   exists - Checks whether a fixture path exists.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [direct fix - Added coverage that prompt sync resolves {file:} tokens from the declaring config directory.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Config as NativeConfig } from "@opencode/schema/config";
import { ConfigAgent as NativeConfigAgent } from "@opencode/schema/config/agent";
import { ConfigPlugin as NativeConfigPlugin } from "@opencode/schema/config/plugin";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import { getManagedNativeAgentFrontmatter } from "./managed-agents.js";
import {
  OPENCODE_SCHEMA_URL,
  MIN_SUPPORTED_OPENCODE_VERSION,
  MAX_SUPPORTED_OPENCODE_VERSION_EXCLUSIVE,
  SUPPORTED_OPENCODE_VERSION_RANGE,
  PACKAGE_NAME,
  ensureManagedAgentRegistrationsConfigText,
  ensurePackageConfigText,
  ensurePackageInstalled,
  ensureProviderBaseUrlConfigText,
  installManagedAgentPrompts,
  installManagedSkillFiles,
  installVvocConfig,
  inspectInstallation,
  inspectOpenCodeRuntime,
  assertSupportedOpenCodeRuntime,
  isSupportedOpenCodeVersion,
  parseGuardianConfigText,
  readManagedAgentModels,
  readOpenCodeAgentModel,
  readOpenCodeDefaultModel,
  readVvocConfig,
  renderGuardianConfig,
  resolvePaths,
  syncManagedAgentPrompts,
  syncManagedAgentRegistrations,
  syncManagedSkillFiles,
  syncVvocConfig,
  writeGuardianConfig,
  writeManagedAgentModel,
  writeOpenCodeAgentModel,
  writeOpenCodeDefaultModel,
  writeProviderBaseUrl,
  writeOpenCodeProviderObject,
} from "./opencode.js";
import {
  materializeHashlineEditEntry,
  materializeToolHistoryCompactionEntry,
  materializePeakHoursEntry,
  materializeSpecGuardEntry,
} from "./plugin-toggle-config.js";
import {
  createDefaultVvocConfig,
  parseVvocConfigText,
  renderVvocConfig,
  VVOC_CONFIG_SCHEMA_URL,
} from "./vvoc-config.js";

describe("ensurePackageConfigText", () => {
  test("creates a new config when none exists", () => {
    const output = ensurePackageConfigText(undefined, `${PACKAGE_NAME}@0.2.3`);
    const parsed = parse(output) as { $schema?: string; plugins?: unknown[] };

    expect(parsed.$schema).toBe(OPENCODE_SCHEMA_URL);
    expect(parsed.plugins).toEqual([{ package: `${PACKAGE_NAME}@0.2.3` }]);
  });

  test("preserves comments while appending the plugin", () => {
    const input = `{
  // existing plugin comment
  "plugins": ["foo"]
}\n`;
    const output = ensurePackageConfigText(input, `${PACKAGE_NAME}@0.2.3`);
    const parsed = parse(output) as { plugins?: unknown[] };

    expect(output).toContain("// existing plugin comment");
    expect(parsed.plugins).toEqual(["foo", { package: `${PACKAGE_NAME}@0.2.3` }]);
  });

  test("upgrades bare or old pinned package entries to the requested version", () => {
    const input = `{
  "plugins": ["foo", "${PACKAGE_NAME}", "${PACKAGE_NAME}@0.2.2"]
}\n`;
    const output = ensurePackageConfigText(input, `${PACKAGE_NAME}@0.2.3`);
    const parsed = parse(output) as { plugins?: unknown[] };

    expect(parsed.plugins).toEqual(["foo", { package: `${PACKAGE_NAME}@0.2.3` }]);
  });
});

describe("ensurePackageConfigText native plugins", () => {
  test("preserves string entries, object options, and removal directives", () => {
    const input = `{
  // preserve theme
  "theme": "catppuccin",
  "plugins": [
    "other-plugin",
    { "package": "needs-options", "options": { "mode": "compact" } },
    { "package": "${PACKAGE_NAME}@0.9.0", "options": { "keep": true } },
    "-remove-me"
  ]
}\n`;
    const output = ensurePackageConfigText(input, `${PACKAGE_NAME}@0.2.3`);
    const parsed = parse(output) as { theme?: string; plugins?: unknown[] };

    expect(output).toContain("// preserve theme");
    expect(parsed.theme).toBe("catppuccin");
    expect(parsed.plugins).toEqual([
      "other-plugin",
      { package: "needs-options", options: { mode: "compact" } },
      { package: `${PACKAGE_NAME}@0.2.3`, options: { keep: true } },
      "-remove-me",
    ]);
    expect(ensurePackageConfigText(output, `${PACKAGE_NAME}@0.2.3`)).toBe(output);
  });

  test("rejects malformed plugin entries instead of rewriting user config", () => {
    expect(() => ensurePackageConfigText('{ "plugins": [["broken"]] }\n')).toThrow(
      'expected "plugins[0]"',
    );
  });

  test("refuses conflicting managed plugin entries instead of dropping options", () => {
    const input = `{
  "plugins": [
    { "package": "${PACKAGE_NAME}@0.9.0", "options": { "keep": true } },
    { "package": "${PACKAGE_NAME}@1.0.0", "options": { "other": true } }
  ]
}\n`;
    expect(() => ensurePackageConfigText(input, `${PACKAGE_NAME}@0.2.3`)).toThrow(
      "conflicting managed plugin entries",
    );
  });
});

describe("OpenCode runtime compatibility", () => {
  test("accepts only the exact supported host window", () => {
    expect(MIN_SUPPORTED_OPENCODE_VERSION).toBe("2.0.18");
    expect(MAX_SUPPORTED_OPENCODE_VERSION_EXCLUSIVE).toBe("2.0.19");
    expect(SUPPORTED_OPENCODE_VERSION_RANGE).toBe(">=2.0.18 <2.0.19");
    expect(isSupportedOpenCodeVersion("2.0.18")).toBe(true);
    expect(isSupportedOpenCodeVersion("v2.0.18")).toBe(true);
  });

  test("rejects older, newer, prerelease, and malformed versions", () => {
    expect(isSupportedOpenCodeVersion("2.0.17")).toBe(false);
    expect(isSupportedOpenCodeVersion("2.0.19")).toBe(false);
    expect(isSupportedOpenCodeVersion("2.1.0")).toBe(false);
    expect(isSupportedOpenCodeVersion("1.18.33")).toBe(false);
    expect(isSupportedOpenCodeVersion("2.0.18-beta.1")).toBe(false);
    expect(isSupportedOpenCodeVersion("2.0.18-rc.1")).toBe(false);
    expect(isSupportedOpenCodeVersion("latest")).toBe(false);
  });

  test("inspects supported and unsupported command output deterministically", async () => {
    const supported = await inspectOpenCodeRuntime(async () => ({
      exitCode: 0,
      stdout: "v2.0.18\n",
      stderr: "",
    }));
    const older = await inspectOpenCodeRuntime(async () => ({
      exitCode: 0,
      stdout: "1.18.33\n",
      stderr: "",
    }));
    const newer = await inspectOpenCodeRuntime(async () => ({
      exitCode: 0,
      stdout: "2.0.19\n",
      stderr: "",
    }));
    const prerelease = await inspectOpenCodeRuntime(async () => ({
      exitCode: 0,
      stdout: "2.0.18-rc.1\n",
      stderr: "",
    }));

    expect(supported).toEqual({
      version: "2.0.18",
      supportedRange: SUPPORTED_OPENCODE_VERSION_RANGE,
      versionSupported: true,
    });
    expect(older.versionSupported).toBe(false);
    expect(newer.versionSupported).toBe(false);
    expect(prerelease.versionSupported).toBe(false);
  });

  test("assertSupportedOpenCodeRuntime refuses out-of-window and unavailable hosts", async () => {
    const supported = await assertSupportedOpenCodeRuntime(async () => ({
      version: "2.0.18",
      supportedRange: SUPPORTED_OPENCODE_VERSION_RANGE,
      versionSupported: true,
    }));
    expect(supported.version).toBe("2.0.18");

    await expect(
      assertSupportedOpenCodeRuntime(async () => ({
        version: "1.18.33",
        supportedRange: SUPPORTED_OPENCODE_VERSION_RANGE,
        versionSupported: false,
      })),
    ).rejects.toThrow("OpenCode 1.18.33 is not supported");
    await expect(
      assertSupportedOpenCodeRuntime(async () => ({
        version: "2.0.19",
        supportedRange: SUPPORTED_OPENCODE_VERSION_RANGE,
        versionSupported: false,
      })),
    ).rejects.toThrow("OpenCode 2.0.19 is not supported");
    await expect(
      assertSupportedOpenCodeRuntime(async () => ({
        supportedRange: SUPPORTED_OPENCODE_VERSION_RANGE,
        error: "opencode --version failed: ENOENT",
      })),
    ).rejects.toThrow("OpenCode host is not verifiable");
  });
});

describe("guardian config helpers", () => {
  test("round-trips managed guardian config values", () => {
    const output = renderGuardianConfig({
      timeoutMs: 12_345,
      approvalRiskThreshold: 55,
      reviewToastDurationMs: 6_789,
    });
    const parsed = parseGuardianConfigText(output, "test guardian config");

    expect(parsed).toEqual({
      timeoutMs: 12_345,
      approvalRiskThreshold: 55,
      reviewToastDurationMs: 6_789,
    });
  });
});

describe("managed native agent registration", () => {
  test("creates native default_agent and skills registration without V1 fields", async () => {
    const paths = await resolvePaths({
      scope: "global",
      cwd: "/workspace/project",
      configDir: "/tmp/vvoc-config-home",
    });

    const output = ensureManagedAgentRegistrationsConfigText(undefined, paths);
    const parsed = parse(output) as {
      model?: string;
      small_model?: string;
      default_agent?: string;
      tools?: unknown;
      agent?: unknown;
      plugins?: unknown;
      skills?: string[];
    };

    expect(parsed.model).toBeUndefined();
    expect(parsed.small_model).toBeUndefined();
    expect(parsed.tools).toBeUndefined();
    expect(parsed.agent).toBeUndefined();
    expect(parsed.default_agent).toBe("vv-controller");
    expect(parsed.skills).toEqual(["/tmp/vvoc-config-home/vvoc/skills"]);
  });

  test("preserves comments and unrelated native fields while adding skills", async () => {
    const paths = await resolvePaths({
      scope: "project",
      cwd: "/workspace/project",
      configDir: "/tmp/vvoc-config-home",
    });

    const input = `{
  // keep root note
  "model": "openai/gpt-5",
  "skills": ["./custom-skills"],
  "plugins": [
    // keep plugin note
    "other-plugin"
  ]
}\n`;
    const output = ensureManagedAgentRegistrationsConfigText(input, paths);
    const parsed = parse(output) as {
      model?: string;
      skills?: string[];
      plugins?: unknown[];
    };

    expect(output).toContain("// keep root note");
    expect(output).toContain("// keep plugin note");
    expect(parsed.model).toBe("openai/gpt-5");
    expect(parsed.skills).toEqual(["./custom-skills", ".vvoc/skills"]);
    expect(parsed.plugins).toEqual(["other-plugin"]);
    expect(ensureManagedAgentRegistrationsConfigText(output, paths)).toBe(output);
  });

  test("refuses a V1-shaped document before any mutation", async () => {
    const paths = await resolvePaths({
      scope: "global",
      cwd: "/workspace/project",
      configDir: "/tmp/vvoc-config-home",
    });

    expect(() =>
      ensureManagedAgentRegistrationsConfigText('{ "agent": { "explore": {} } }\n', paths),
    ).toThrow('unsupported V1 field "agent"');
    expect(() => ensureManagedAgentRegistrationsConfigText('{ "plugin": ["x"] }\n', paths)).toThrow(
      'unsupported V1 field "plugin"',
    );
  });

  test("writes native discovered agent markdown with native frontmatter only", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-native-agent-files-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await installManagedAgentPrompts(paths, { force: true });

      const reviewer = await readFile(
        join(paths.managedAgentsDirPath, "vv-spec-reviewer.md"),
        "utf8",
      );
      expect(reviewer).toContain("mode: subagent");
      expect(reviewer).toContain("permissions:");
      expect(reviewer).toContain('action: "edit"');
      expect(reviewer).not.toContain("prompt:");
      expect(reviewer).toContain("Managed by vvoc");

      const guardian = await readFile(join(paths.managedAgentsDirPath, "guardian.md"), "utf8");
      expect(guardian).toContain("hidden: true");
      expect(guardian).toContain("steps: 2");
      expect(guardian).not.toContain("permission:");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});

describe("canonical vvoc config helpers", () => {
  test("ships a versioned schema file at the canonical hosted URL", async () => {
    const schemaText = await readFile(
      new URL("../../schemas/vvoc/v3.json", import.meta.url),
      "utf8",
    );
    const schema = JSON.parse(schemaText) as {
      $id?: string;
      plugins?: unknown;
      required?: string[];
      properties?: {
        version?: { const?: number };
        plugins?: unknown;
        orchestration?: { properties?: { profile?: { enum?: string[] } } };
        presets?: {
          additionalProperties?: {
            properties?: { orchestration?: { properties?: { profile?: { enum?: string[] } } } };
          };
        };
      };
    };

    expect(schema.$id).toBe(VVOC_CONFIG_SCHEMA_URL);
    expect(schema.properties?.version?.const).toBe(3);
    expect(schema.required).toContain("plugins");
    expect(schema.required).not.toContain("orchestration");
    expect(schema.properties?.plugins).toBeDefined();
    expect(schema.properties?.orchestration?.properties?.profile?.enum).toEqual([
      "single-session",
      "balanced",
      "orchestrated",
      "delegated",
    ]);
    expect(
      schema.properties?.presets?.additionalProperties?.properties?.orchestration?.properties
        ?.profile?.enum,
    ).toEqual(["single-session", "balanced", "orchestrated", "delegated"]);
    expect(schema.plugins).toBeUndefined();
  });

  test("rendered default vvoc config validates against runtime and published schemas", async () => {
    const rendered = renderVvocConfig(createDefaultVvocConfig());
    expect(() => parseVvocConfigText(rendered, "rendered vvoc config")).not.toThrow();

    const publishedSchema = JSON.parse(
      await readFile(new URL("../../schemas/vvoc/v3.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(publishedSchema);
    const valid = validate(JSON.parse(rendered));
    const renderedConfig = JSON.parse(rendered) as ReturnType<typeof createDefaultVvocConfig>;

    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
    expect(renderedConfig.orchestration).toEqual({ profile: "balanced" });
    expect(renderedConfig.presets["vv-codex"]?.orchestration).toEqual({
      profile: "single-session",
    });
    expect(renderedConfig.presets["vv-deepseek"]?.orchestration).toEqual({
      profile: "balanced",
    });
  });

  test("old valid v3 config without orchestration parses with balanced effective behavior", () => {
    const legacy = createDefaultVvocConfig() as ReturnType<typeof createDefaultVvocConfig> &
      Record<string, unknown>;
    delete legacy.orchestration;
    for (const preset of Object.values(legacy.presets)) {
      delete preset.orchestration;
    }

    const parsed = parseVvocConfigText(JSON.stringify(legacy), "legacy v3 config");

    expect(parsed.orchestration).toEqual({ profile: "balanced" });
    expect(parsed.presets["vv-codex"]?.orchestration).toEqual({ profile: "single-session" });
    expect(parsed.presets["vv-deepseek"]?.orchestration).toEqual({ profile: "balanced" });
  });

  test("parseVvocConfigText rejects old, incomplete, and old-field documents", () => {
    const current = createDefaultVvocConfig();
    const withoutVersion = { ...current } as Record<string, unknown>;
    delete withoutVersion.version;
    const withoutPlugins = { ...current } as Record<string, unknown>;
    delete withoutPlugins.plugins;

    const invalidDocuments: Array<[string, Record<string, unknown>]> = [
      ["version 1", { ...current, version: 1 }],
      ["version 2", { ...current, version: 2 }],
      ["missing version", withoutVersion],
      ["missing plugins", withoutPlugins],
      [
        "old secretsRedaction.enabled",
        {
          ...current,
          secretsRedaction: {
            ...current.secretsRedaction,
            enabled: false,
          },
        },
      ],
    ];

    for (const [label, document] of invalidDocuments) {
      expect(() => parseVvocConfigText(JSON.stringify(document), label)).toThrow();
    }
  });

  test("fresh install creates schema v3 vvoc config and pins package in plugin array", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-fresh-install-v3-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });

      const pluginResult = await ensurePackageInstalled(paths);
      const registrationResult = await syncManagedAgentRegistrations(paths);
      const vvocResult = await installVvocConfig(paths);

      expect(pluginResult.changed).toBe(true);
      expect(registrationResult.changed).toBe(true);
      expect(vvocResult.action).toBe("created");

      const openCodeConfig = parse(await readFile(paths.opencodeConfigPath, "utf8")) as {
        plugins?: Array<string | { package: string }>;
        model?: string;
        small_model?: string;
        default_agent?: string;
        tools?: unknown;
        agent?: unknown;
        skills?: string[];
      };
      const vvocConfig = await readVvocConfig(paths);

      expect(
        openCodeConfig.plugins?.some((entry) =>
          typeof entry === "string"
            ? entry.startsWith(`${PACKAGE_NAME}@`)
            : entry.package.startsWith(`${PACKAGE_NAME}@`),
        ),
      ).toBe(true);
      expect(openCodeConfig.model).toBeUndefined();
      expect(openCodeConfig.small_model).toBeUndefined();
      expect(openCodeConfig.default_agent).toBe("vv-controller");
      expect(openCodeConfig.tools).toBeUndefined();
      expect(openCodeConfig.agent).toBeUndefined();
      expect(openCodeConfig.skills).toContain(join(configHome, "vvoc", "skills"));

      expect(vvocConfig?.version).toBe(3);
      expect(vvocConfig?.$schema).toBe(VVOC_CONFIG_SCHEMA_URL);
      expect(vvocConfig?.roles.default).toBeDefined();
      expect(vvocConfig?.roles.smart).toBeDefined();
      expect(vvocConfig?.roles.fast).toBeDefined();
      expect(vvocConfig?.roles.reviewer).toBeDefined();
      expect(vvocConfig?.orchestration).toEqual({ profile: "balanced" });
      expect(Object.keys(vvocConfig?.presets ?? {})).toEqual([
        "vv-codex",
        "vv-zai",
        "vv-deepseek",
        "vv-alibaba",
        "vv-osovv-ds",
        "vv-osovv-mimo",
        "vv-osovv-zai",
        "vv-osovv-qwen",
        "vv-astra-solo",
        "vv-astra-workers",
      ]);
      expect(vvocConfig?.presets["vv-codex"]?.orchestration).toEqual({
        profile: "single-session",
      });
      expect(vvocConfig?.presets["vv-zai"]?.orchestration).toEqual({ profile: "balanced" });
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("syncVvocConfig preserves unrelated sections, restores drifted vv-deepseek, and keeps custom presets", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-v3-preset-refresh-"));

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
            orchestration: { profile: "single-session" },
            guardian: {
              ...createDefaultVvocConfig().guardian,
              model: "openai/gpt-5.4",
              timeoutMs: 12_345,
            },
            roles: {
              ...createDefaultVvocConfig().roles,
              custom: "openai/gpt-5.4-mini",
            },
            presets: {
              "vv-deepseek": {
                description: "user drifted managed preset",
                agents: {
                  default: "openai/gpt-5",
                },
                orchestration: { profile: "single-session" },
              },
              custom: {
                description: "user preset",
                agents: {
                  custom: "openai/gpt-5.4-mini",
                },
                orchestration: { profile: "orchestrated" },
              },
            },
            plugins: {
              ...createDefaultVvocConfig().plugins,
              "secrets-redaction": false,
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const driftedBeforeSync = JSON.parse(
        await readFile(paths.vvocConfigPath, "utf8"),
      ) as ReturnType<typeof createDefaultVvocConfig>;
      expect(driftedBeforeSync.presets["vv-deepseek"]?.description).toBe(
        "user drifted managed preset",
      );
      expect(driftedBeforeSync.presets["vv-deepseek"]?.agents.default).toBe("openai/gpt-5");

      const syncResult = await syncVvocConfig(paths);
      expect(syncResult.action).toBe("updated");

      const synced = await readVvocConfig(paths);
      expect(synced?.guardian.model).toBe("openai/gpt-5.4");
      expect(synced?.guardian.timeoutMs).toBe(12_345);
      expect(synced?.roles.custom).toBe("openai/gpt-5.4-mini");
      expect(synced?.orchestration).toEqual({ profile: "single-session" });
      expect(synced?.presets.custom?.agents.custom).toBe("openai/gpt-5.4-mini");
      expect(synced?.presets.custom?.description).toBe("user preset");
      expect(synced?.presets.custom?.orchestration).toEqual({ profile: "orchestrated" });
      expect(synced?.presets["vv-deepseek"]?.description).toBe(
        "Starter DeepSeek role assignments for built-in vvoc roles.",
      );
      expect(synced?.presets["vv-deepseek"]?.agents.default).toBe("deepseek/deepseek-flash#max");
      expect(synced?.presets["vv-deepseek"]?.agents.fast).toBe("deepseek/deepseek-flash#max");
      expect(synced?.presets["vv-deepseek"]?.orchestration).toEqual({ profile: "balanced" });
      expect(synced?.presets["vv-zai"]?.agents.default).toBe("zai-coding-plan/glm-5.3-flash#max");
      expect(synced?.plugins["secrets-redaction"]).toBe(false);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("syncVvocConfig preserves retired saved presets, custom presets, and active role/profile", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-retired-presets-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const defaults = createDefaultVvocConfig();
      const retiredPresets = {
        "vv-osovv-sol": {
          description: "saved retired sol preset",
          agents: {
            default: "deepseek/deepseek-v4-flash",
            smart: "openai/gpt-5.6-sol#xhigh",
          },
          orchestration: { profile: "single-session" },
        },
        "vv-osovv-flash": {
          description: "saved retired flash preset",
          agents: { default: "deepseek/deepseek-v4-flash" },
        },
        "vv-osovv-kimi": {
          description: "saved retired kimi preset",
          agents: {
            default: "deepseek/deepseek-v4-flash",
            smart: "kimi-for-coding/vv-kimi-k3-max",
          },
        },
      } as const;
      const savedConfig = {
        ...defaults,
        orchestration: { profile: "single-session" },
        roles: {
          ...defaults.roles,
          default: "deepseek/deepseek-v4-flash",
          custom: "openai/gpt-5.4-mini",
        },
        presets: {
          ...defaults.presets,
          ...retiredPresets,
          custom: {
            description: "user preset",
            agents: { custom: "openai/gpt-5.4-mini" },
            orchestration: { profile: "orchestrated" },
          },
        },
      };

      await mkdir(join(configHome, "vvoc"), { recursive: true });
      await writeFile(paths.vvocConfigPath, `${JSON.stringify(savedConfig, null, 2)}\n`, "utf8");

      const first = await syncVvocConfig(paths);
      expect(first.action).toBe("updated");
      const firstText = await readFile(paths.vvocConfigPath, "utf8");
      expect(firstText).toContain("vv-osovv-sol");
      expect(firstText).toContain("vv-osovv-flash");
      expect(firstText).toContain("vv-osovv-kimi");
      const synced = JSON.parse(firstText) as ReturnType<typeof createDefaultVvocConfig>;

      expect(synced.presets["vv-osovv-sol"]).toEqual(retiredPresets["vv-osovv-sol"]);
      expect(synced.presets["vv-osovv-flash"]).toEqual(retiredPresets["vv-osovv-flash"]);
      expect(synced.presets["vv-osovv-kimi"]).toEqual(retiredPresets["vv-osovv-kimi"]);
      expect(synced.presets.custom).toEqual({
        description: "user preset",
        agents: { custom: "openai/gpt-5.4-mini" },
        orchestration: { profile: "orchestrated" },
      });
      expect(synced.roles.default).toBe("deepseek/deepseek-v4-flash");
      expect(synced.roles.custom).toBe("openai/gpt-5.4-mini");
      expect(synced.orchestration).toEqual({ profile: "single-session" });
      expect(synced.presets["vv-osovv-ds"]).toBeDefined();
      expect(synced.presets["vv-osovv-zai"]).toBeDefined();
      expect(synced.presets["vv-zai"]?.agents.default).toBe("zai-coding-plan/glm-5.3-flash#max");

      // The first write materializes boolean plugin toggles into objects; the
      // next writes must then settle to byte-identical output.
      await syncVvocConfig(paths);
      const settledText = await readFile(paths.vvocConfigPath, "utf8");
      const repeated = await syncVvocConfig(paths);
      expect(repeated.action).toBe("kept");
      expect(await readFile(paths.vvocConfigPath, "utf8")).toBe(settledText);
      const settled = JSON.parse(settledText) as ReturnType<typeof createDefaultVvocConfig>;
      expect(settled.presets["vv-osovv-sol"]).toEqual(retiredPresets["vv-osovv-sol"]);
      expect(settled.presets.custom).toEqual(synced.presets.custom);
      expect(settled.roles.default).toBe("deepseek/deepseek-v4-flash");
      expect(settled.orchestration).toEqual({ profile: "single-session" });
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("readVvocConfig returns undefined only when absent and sync creates canonical config", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-strict-absent-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });

      expect(await readVvocConfig(paths)).toBeUndefined();
      const syncResult = await syncVvocConfig(paths);
      expect(syncResult.action).toBe("created");
      const created = await readVvocConfig(paths);
      expect(created?.version).toBe(3);
      const expectedPlugins = { ...createDefaultVvocConfig().plugins };
      expectedPlugins["hashline-edit"] = materializeHashlineEditEntry(true);
      expectedPlugins["tool-history-compaction"] = materializeToolHistoryCompactionEntry(true);
      expectedPlugins["peak-hours"] = materializePeakHoursEntry(true);
      expectedPlugins["spec-guard"] = materializeSpecGuardEntry(true);
      expect(created?.plugins).toEqual(expectedPlugins);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("strict reads and sync reject unsupported pre-role vvoc schemas without rewriting", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-v2-reject-"));

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
            $schema: "https://cdn.jsdelivr.net/npm/@osovv/vv-opencode@0.30.0/schemas/vvoc/v2.json",
            version: 2,
            guardian: {
              timeoutMs: 12345,
              approvalRiskThreshold: 70,
              reviewToastDurationMs: 54321,
            },
            secretsRedaction: createDefaultVvocConfig().secretsRedaction,
            presets: createDefaultVvocConfig().presets,
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const originalText = await readFile(paths.vvocConfigPath, "utf8");

      await expect(readVvocConfig(paths)).rejects.toThrow();
      await expect(syncVvocConfig(paths)).rejects.toThrow();
      expect(await readFile(paths.vvocConfigPath, "utf8")).toBe(originalText);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("writeGuardianConfig rejects invalid existing vvoc config without rewriting", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-guardian-invalid-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await mkdir(join(configHome, "vvoc"), { recursive: true });
      const invalidText =
        JSON.stringify({ ...createDefaultVvocConfig(), plugins: undefined }) + "\n";
      await writeFile(paths.vvocConfigPath, invalidText, "utf8");

      await expect(writeGuardianConfig(paths, { timeoutMs: 12_345 })).rejects.toThrow();
      expect(await readFile(paths.vvocConfigPath, "utf8")).toBe(invalidText);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});

describe("managed prompt install", () => {
  test("writes managed prompt files and keeps project-scope prompt refs", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-managed-agents-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
      });

      const promptResults = await installManagedAgentPrompts(paths, { force: true });
      expect(promptResults.length).toBeGreaterThanOrEqual(7);

      const openCode = ensureManagedAgentRegistrationsConfigText(undefined, paths);
      const parsed = parse(openCode) as {
        agent?: unknown;
        default_agent?: string;
        skills?: string[];
      };
      expect(parsed.agent).toBeUndefined();
      expect(parsed.default_agent).toBe("vv-controller");
      expect(parsed.skills).toEqual([".vvoc/skills"]);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
describe("managed skill files", () => {
  test("installManagedSkillFiles creates skill files for all managed skills", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-managed-skills-"));
    try {
      const paths = await resolvePaths({ scope: "project", cwd: projectDir });
      const results = await installManagedSkillFiles(paths, { force: true });
      expect(results).toHaveLength(13); // 7 SKILL.md + 6 reference files
      expect(results.every((r) => r.action === "created")).toBe(true);
      for (const r of results) {
        const isSkill = r.path.endsWith("SKILL.md");
        const isReference =
          r.path.endsWith(".xml") ||
          r.path.endsWith(".py") ||
          r.path.endsWith(join("references", "opencode-db-queries.md")) ||
          r.path.endsWith(join("references", "tool-contracts.md"));
        expect(isSkill || isReference).toBe(true);
      }
      expect(results.some((r) => r.path.endsWith(join("vv-reflect", "SKILL.md")))).toBe(true);
      expect(results.some((r) => r.path.endsWith(join("vv-handoff", "SKILL.md")))).toBe(true);
      expect(
        results.some((r) =>
          r.path.endsWith(join("vv-spec", "references", "design-context-template.xml")),
        ),
      ).toBe(true);
      expect(
        results.some((r) => r.path.endsWith(join("vv-execute", "references", "tool-contracts.md"))),
      ).toBe(true);
      expect(await exists(join(projectDir, ".vvoc", "lessons"))).toBe(false);
      expect(await exists(join(projectDir, ".vvoc", "runbooks"))).toBe(false);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("installManagedSkillFiles skips non-managed files without force", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-managed-skills-skip-"));
    try {
      const paths = await resolvePaths({ scope: "project", cwd: projectDir });
      const saveDir = join(paths.managedSkillsDirPath, "vv-spec");
      await mkdir(saveDir, { recursive: true });
      await writeFile(join(saveDir, "SKILL.md"), "# My custom skill\n", "utf8");

      const results = await installManagedSkillFiles(paths, { force: false });
      expect(results).toHaveLength(11); // vv-spec skipped + 6 other SKILL.md + 4 refs (plan, usage-analytics, tool-contracts, session-graph; vv-spec refs not synced when vv-spec skipped)
      const vvSpec = results.find((r) => r.path.includes("vv-spec"));
      expect(vvSpec?.action).toBe("skipped");
      expect(vvSpec?.reason).toContain("has no YAML frontmatter");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("installManagedSkillFiles overwrites with force", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-managed-skills-force-"));
    try {
      const paths = await resolvePaths({ scope: "project", cwd: projectDir });
      const saveDir = join(paths.managedSkillsDirPath, "vv-spec");
      await mkdir(saveDir, { recursive: true });
      await writeFile(join(saveDir, "SKILL.md"), "# My custom skill\n", "utf8");

      const results = await installManagedSkillFiles(paths, { force: true });
      const vvSpec = results.find((r) => r.path.includes("vv-spec"));
      expect(vvSpec?.action).toBe("updated");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("syncManagedSkillFiles creates missing skill files", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-managed-skills-sync-"));
    try {
      const paths = await resolvePaths({ scope: "project", cwd: projectDir });
      const results = await syncManagedSkillFiles(paths, { force: false });
      expect(results).toHaveLength(13); // 7 SKILL.md + 6 reference files
      expect(results.every((r) => r.action === "created")).toBe(true);
      expect(results.some((r) => r.path.endsWith(join("vv-reflect", "SKILL.md")))).toBe(true);
      expect(results.some((r) => r.path.endsWith(join("vv-handoff", "SKILL.md")))).toBe(true);
      expect(
        results.some((r) =>
          r.path.endsWith(join("vv-spec", "references", "design-context-template.xml")),
        ),
      ).toBe(true);
      expect(
        results.some((r) => r.path.endsWith(join("vv-execute", "references", "tool-contracts.md"))),
      ).toBe(true);
      expect(await exists(join(projectDir, ".vvoc", "lessons"))).toBe(false);
      expect(await exists(join(projectDir, ".vvoc", "runbooks"))).toBe(false);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("syncManagedSkillFiles skips non-managed files", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-managed-skills-sync-skip-"));
    try {
      const paths = await resolvePaths({ scope: "project", cwd: projectDir });
      const saveDir = join(paths.managedSkillsDirPath, "vv-plan");
      await mkdir(saveDir, { recursive: true });
      await writeFile(join(saveDir, "SKILL.md"), "# Custom plan\n", "utf8");

      const results = await syncManagedSkillFiles(paths, { force: false });
      const vvPlan = results.find((r) => r.path.includes("vv-plan"));
      expect(vvPlan?.action).toBe("skipped");
      expect(vvPlan?.reason).toContain("no YAML frontmatter");
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("syncManagedSkillFiles does not sync references when parent skill is skipped", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-skills-skip-ref-"));
    try {
      const paths = await resolvePaths({ scope: "project", cwd: projectDir });
      // Create custom vv-spec SKILL.md (no YAML frontmatter)
      const specDir = join(paths.managedSkillsDirPath, "vv-spec");
      await mkdir(specDir, { recursive: true });
      await writeFile(join(specDir, "SKILL.md"), "# My custom vv-spec skill\n", "utf8");

      // Create custom reference file with content different from template
      const refDir = join(specDir, "references");
      await mkdir(refDir, { recursive: true });
      const customRefContent = "<custom>user-owned reference</custom>\n";
      await writeFile(join(refDir, "design-context-template.xml"), customRefContent, "utf8");

      const results = await syncManagedSkillFiles(paths, { force: false });

      // vv-spec skill should be skipped
      const vvSpec = results.find((r) => r.path.endsWith(join("vv-spec", "SKILL.md")));
      expect(vvSpec?.action).toBe("skipped");
      expect(vvSpec?.reason).toContain("no YAML frontmatter");

      // No vv-spec reference file should appear in results (references not synced)
      const specRefResults = results.filter((r) => r.path.includes(join("vv-spec", "references")));
      expect(specRefResults).toHaveLength(0);

      // Custom reference file content on disk must be unchanged
      const actualRefContent = await readFile(join(refDir, "design-context-template.xml"), "utf8");
      expect(actualRefContent).toBe(customRefContent);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("syncManagedSkillFiles keeps unchanged managed files", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-managed-skills-keep-"));
    try {
      const paths = await resolvePaths({ scope: "project", cwd: projectDir });
      await installManagedSkillFiles(paths, { force: true });
      const results = await syncManagedSkillFiles(paths, { force: false });
      const kept = results.filter((r) => r.action === "kept");
      expect(kept).toHaveLength(13); // 7 SKILL.md + 6 reference files
      expect(kept.some((r) => r.path.endsWith(join("vv-handoff", "SKILL.md")))).toBe(true);
      expect(
        kept.some((r) => r.path.endsWith(join("vv-execute", "references", "tool-contracts.md"))),
      ).toBe(true);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("syncManagedSkillFiles force-updates content", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-managed-skills-force-update-"));
    try {
      const paths = await resolvePaths({ scope: "project", cwd: projectDir });
      await installManagedSkillFiles(paths, { force: true });
      const results = await syncManagedSkillFiles(paths, { force: true });
      expect(results).toHaveLength(13); // 7 SKILL.md + 6 reference files
      expect(results.some((r) => r.path.endsWith(join("vv-handoff", "SKILL.md")))).toBe(true);
      for (const r of results) {
        expect(["kept", "updated"]).toContain(r.action);
      }
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("vv-reflect SKILL.md template contains required behavioral contracts", async () => {
    const skillText = await readFile(
      new URL("../../templates/skills/vv-reflect/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(skillText).toContain("name: vv-reflect");
    expect(skillText).toContain("Do not use or create .vvoc/reflect.jsonc");
    expect(skillText).toContain("Use only the current visible chat context");
    expect(skillText).toContain("generalized knowledge");
    expect(skillText).toContain(
      "A lesson is not a transcript, changelog item, bug report, or solved-task summary",
    );
    expect(skillText).toContain("similar-but-not-identical future task");
    expect(skillText).toContain("durable user-provided knowledge");
    expect(skillText).toContain("business context, domain semantics, product intent");
    expect(skillText).toContain("Treat explicit user explanations as first-class evidence");
    expect(skillText).toContain("If proposed content reads like a current-session recap");
    expect(skillText).toContain("wait for explicit per-entry");
    expect(skillText).toContain(
      "Treat silence or general agreement without clear approval as not yet approved",
    );
    expect(skillText).toContain(
      "Prefer existing repository-owned documentation only when the match is high-confidence",
    );
    expect(skillText).toContain("Create fallback directories and indexes lazily");
    expect(skillText).toContain("Use one durable entry per file");
    expect(skillText).toContain("update the corresponding index");
    expect(skillText).toContain("Never silently overwrite");
    expect(skillText).toContain(
      "Do not add a CLI command, hook behavior, or automatic writer behavior",
    );
  });

  test("vv-handoff SKILL.md template contains required behavioral contracts", async () => {
    const skillText = await readFile(
      new URL("../../templates/skills/vv-handoff/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(skillText).toContain("name: vv-handoff");
    expect(skillText).toContain(".vvoc/handoff/YYYY-MM-DD-&lt;session-slug&gt;/handoff.xml");
    expect(skillText).toContain(
      "Do not run shell commands, tests, lint, build, git status, git diff, web searches",
    );
    expect(skillText).toContain("not collected in current session");
    expect(skillText).toContain("-2, then -3, and later integers");
    expect(skillText).toContain("[REDACTED]");
    expect(skillText).toContain("<original_request>");
    expect(skillText).toContain("<completed_work>");
    expect(skillText).toContain("<current_state_and_decisions>");
    expect(skillText).toContain("<important_or_changed_files>");
    expect(skillText).toContain("<known_commands_and_results>");
    expect(skillText).toContain("<blockers_risks_unknowns>");
    expect(skillText).toContain("<next_safe_step>");
    expect(skillText).toContain("Do not create a CLI command, plugin, runtime hook");
    expect(skillText).toContain("must not be schema-validated");
  });
});

/** Returns true when the path exists and false for ENOENT. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
describe("provider baseURL helpers", () => {
  test("creates a new config with a provider baseURL override", () => {
    const output = ensureProviderBaseUrlConfigText(
      undefined,
      "stepfun",
      "https://api.stepfun.ai/v1",
    );
    const parsed = parse(output) as {
      $schema?: string;
      providers?: Record<string, { settings?: { baseURL?: string } }>;
    };

    expect(parsed.$schema).toBe(OPENCODE_SCHEMA_URL);
    expect(parsed.providers?.stepfun?.settings?.baseURL).toBe("https://api.stepfun.ai/v1");
  });

  test("preserves comments while patching provider baseURL", () => {
    const input = `{
  // keep provider docs
  "providers": {
    "stepfun": {
      "settings": {
        // keep timeout
        "timeout": 1000
      }
    }
  }
}\n`;
    const output = ensureProviderBaseUrlConfigText(input, "stepfun", "https://api.stepfun.ai/v1");
    const parsed = parse(output) as {
      providers?: Record<string, { settings?: { baseURL?: string; timeout?: number } }>;
    };

    expect(output).toContain("// keep provider docs");
    expect(output).toContain("// keep timeout");
    expect(parsed.providers?.stepfun?.settings?.timeout).toBe(1000);
    expect(parsed.providers?.stepfun?.settings?.baseURL).toBe("https://api.stepfun.ai/v1");
  });

  test("writes provider override idempotently", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-provider-patch-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });

      const first = await writeProviderBaseUrl(paths, "stepfun", "https://api.stepfun.ai/v1");
      const second = await writeProviderBaseUrl(paths, "stepfun", "https://api.stepfun.ai/v1");
      const content = await readFile(paths.opencodeConfigPath, "utf8");
      const parsed = parse(content) as {
        providers?: Record<string, { settings?: { baseURL?: string } }>;
      };

      expect(first.action).toBe("created");
      expect(second.action).toBe("kept");
      expect(parsed.providers?.stepfun?.settings?.baseURL).toBe("https://api.stepfun.ai/v1");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});

describe("provider object helpers", () => {
  test("merges provider-specific object patches without clobbering sibling models", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-opencode-provider-object-"));
    const zaiPatch = {
      models: {
        "glm-5.2": {
          name: "GLM-5.2",
          limit: {
            context: 1000000,
            output: 131072,
          },
        },
      },
    };

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });

      await mkdir(join(configHome, "opencode"), { recursive: true });

      await writeFile(
        paths.opencodeConfigPath,
        JSON.stringify(
          {
            $schema: OPENCODE_SCHEMA_URL,
            providers: {
              "zai-coding-plan": {
                models: {
                  Existing: {
                    name: "Existing",
                  },
                },
              },
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const first = await writeOpenCodeProviderObject(paths, "zai-coding-plan", zaiPatch);
      const second = await writeOpenCodeProviderObject(paths, "zai-coding-plan", zaiPatch);
      const content = await readFile(paths.opencodeConfigPath, "utf8");
      const parsed = JSON.parse(content) as {
        providers?: Record<string, { models?: Record<string, Record<string, unknown>> }>;
      };

      expect(first.action).toBe("updated");
      expect(second.action).toBe("kept");
      expect(parsed.providers?.["zai-coding-plan"]?.models?.Existing).toEqual({
        name: "Existing",
      });
      expect(parsed.providers?.["zai-coding-plan"]?.models?.["glm-5.2"]).toEqual({
        name: "GLM-5.2",
        limit: {
          context: 1000000,
          output: 131072,
        },
      });
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});

describe("resolvePaths", () => {
  test("separates global opencode and vvoc config roots", async () => {
    const paths = await resolvePaths({
      scope: "global",
      cwd: "/workspace/project",
      configDir: "/tmp/vvoc-config-home",
    });

    expect(paths.configHome).toBe("/tmp/vvoc-config-home");
    expect(paths.opencodeBaseDir).toBe("/tmp/vvoc-config-home/opencode");
    expect(paths.vvocBaseDir).toBe("/tmp/vvoc-config-home/vvoc");
    expect(paths.vvocConfigPath).toBe("/tmp/vvoc-config-home/vvoc/vvoc.json");
    expect(paths.managedAgentsDirPath).toBe("/tmp/vvoc-config-home/opencode/agents");
    expect(paths.opencodeConfigPath).toBe("/tmp/vvoc-config-home/opencode/opencode.json");
    expect(paths.opencodeSkillsDirPath).toBe("/tmp/vvoc-config-home/opencode/skills");
  });

  test("keeps project config, prompts, and skills in canonical local layers", async () => {
    const paths = await resolvePaths({
      scope: "project",
      cwd: "/workspace/project",
      configDir: "/tmp/vvoc-config-home",
    });

    expect(paths.opencodeBaseDir).toBe("/workspace/project/.opencode");
    expect(paths.opencodeConfigPath).toBe("/workspace/project/.opencode/opencode.json");
    expect(paths.vvocBaseDir).toBe("/workspace/project/.vvoc");
    expect(paths.vvocConfigPath).toBe("/workspace/project/.vvoc/vvoc.json");
    expect(paths.managedAgentsDirPath).toBe("/workspace/project/.opencode/agents");
    expect(paths.managedSkillsDirPath).toBe("/workspace/project/.vvoc/skills");
  });

  test("honors the native OPENCODE_CONFIG_DIR global root without an explicit config dir", async () => {
    const prev = process.env.OPENCODE_CONFIG_DIR;
    try {
      process.env.OPENCODE_CONFIG_DIR = "/tmp/opencode/native-root-probe";
      const paths = await resolvePaths({ scope: "global", cwd: "/workspace/project" });
      expect(paths.opencodeBaseDir).toBe("/tmp/opencode/native-root-probe");
      expect(paths.opencodeConfigPath).toBe("/tmp/opencode/native-root-probe/opencode.json");
      expect(paths.managedAgentsDirPath).toBe("/tmp/opencode/native-root-probe/agents");
      expect(paths.opencodeSkillsDirPath).toBe("/tmp/opencode/native-root-probe/skills");
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = prev;
    }
  });

  test("an explicit config dir wins over the native root override", async () => {
    const prev = process.env.OPENCODE_CONFIG_DIR;
    try {
      process.env.OPENCODE_CONFIG_DIR = "/tmp/opencode/native-root-probe";
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: "/tmp/vvoc-config-home",
      });
      expect(paths.opencodeBaseDir).toBe("/tmp/vvoc-config-home/opencode");
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = prev;
    }
  });
});

describe("inspectInstallation", () => {
  test("reports the managed native combined package registration", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-native-inspect-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await ensurePackageInstalled(paths);
      await installVvocConfig(paths);

      const inspection = await inspectInstallation(paths);

      expect(inspection.opencode.pluginConfigured).toBe(true);
      expect(inspection.tui.registered).toBe(true);
      expect(inspection.tui.note).toContain("live native host plugin inventory");
      expect(inspection.opencode.plugins).toHaveLength(1);
      const registered = inspection.opencode.plugins[0];
      expect(typeof registered === "object" && registered.package.startsWith(PACKAGE_NAME)).toBe(
        true,
      );

      const incompatible = await inspectInstallation(paths, {
        runtime: {
          version: "1.18.33",
          supportedRange: SUPPORTED_OPENCODE_VERSION_RANGE,
          versionSupported: false,
        },
      });
      expect(incompatible.problems).toContain(
        "OpenCode 1.18.33 is not supported; vvoc requires >=2.0.18 <2.0.19",
      );
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("reports missing native plugins registration as unconfigured", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-native-missing-inspect-"));

    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      await writeFile(paths.opencodeConfigPath, '{ "plugins": ["other"] }\n', "utf8");
      await installVvocConfig(paths);

      const inspection = await inspectInstallation(paths);
      expect(inspection.opencode.pluginConfigured).toBe(false);
      expect(inspection.tui.registered).toBe(false);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("reports canonical role inventory and unresolved vv-role references", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-install-inspect-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-install-inspect-project-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
        configDir: configHome,
      });

      await mkdir(dirname(paths.vvocConfigPath), { recursive: true });
      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });

      await writeFile(
        paths.vvocConfigPath,
        renderVvocConfig({
          ...createDefaultVvocConfig(),
          roles: {
            ...createDefaultVvocConfig().roles,
            custom: "openai/gpt-5.4-mini",
          },
        }),
        "utf8",
      );

      await writeFile(
        paths.opencodeConfigPath,
        JSON.stringify(
          {
            $schema: OPENCODE_SCHEMA_URL,
            plugins: [
              {
                package: PACKAGE_NAME,
                options: {
                  modelIntent: {
                    model: "vv-role:missing",
                    smallModel: "vv-role:fast",
                    agents: {
                      general: "vv-role:default",
                    },
                    commands: {
                      plan: "vv-role:another-missing",
                    },
                  },
                },
              },
            ],
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const inspection = await inspectInstallation(paths);

      expect(inspection.orchestration.profile).toBe("balanced");
      expect(inspection.roles.assignments.map((entry) => entry.roleId)).toEqual([
        "default",
        "smart",
        "fast",
        "reviewer",
        "custom",
        "reflector",
      ]);
      expect(inspection.roles.unresolvedReferences).toEqual([
        {
          fieldPath: "modelIntent.model",
          roleRef: "vv-role:missing",
          roleId: "missing",
        },
        {
          fieldPath: "modelIntent.commands.plan",
          roleRef: "vv-role:another-missing",
          roleId: "another-missing",
        },
      ]);
      expect(inspection.problems).toContain(
        "unresolved role reference at modelIntent.model: vv-role:missing (missing role: missing)",
      );
      expect(inspection.problems).toContain(
        "unresolved role reference at modelIntent.commands.plan: vv-role:another-missing (missing role: another-missing)",
      );
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

describe("modelIntent envelope write semantics", () => {
  function managedEntry(parsed: {
    plugins?: Array<string | { package: string; options?: Record<string, unknown> }>;
  }) {
    const entry = parsed.plugins?.find(
      (candidate) => typeof candidate === "object" && candidate.package.includes("vv-opencode"),
    );
    return entry && typeof entry === "object" ? entry : undefined;
  }

  test("writes root role intent to the vvoc plugins modelIntent envelope", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-intent-model-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      const result = await writeOpenCodeDefaultModel(paths, "model", {
        model: "vv-role:default",
        ensureEntry: true,
      });
      const parsed = JSON.parse(await readFile(paths.opencodeConfigPath, "utf8")) as {
        model?: unknown;
        small_model?: unknown;
        plugins?: Array<string | { package: string; options?: Record<string, unknown> }>;
      };

      expect(result.action).toBe("created");
      expect(parsed.model).toBeUndefined();
      expect(parsed.small_model).toBeUndefined();
      expect(managedEntry(parsed)?.options?.modelIntent).toEqual({ model: "vv-role:default" });
      expect(await readOpenCodeDefaultModel(paths, "model")).toBe("vv-role:default");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("writes small_model intent to the envelope without any V1 field", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-intent-small-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await writeOpenCodeDefaultModel(paths, "small_model", {
        model: "vv-role:fast",
        ensureEntry: true,
      });
      const parsed = JSON.parse(await readFile(paths.opencodeConfigPath, "utf8")) as {
        small_model?: unknown;
        plugins?: Array<string | { package: string; options?: Record<string, unknown> }>;
      };

      expect(parsed.small_model).toBeUndefined();
      expect(await readFile(paths.opencodeConfigPath, "utf8")).not.toContain('"small_model"');
      expect(managedEntry(parsed)?.options?.modelIntent).toEqual({ smallModel: "vv-role:fast" });
      expect(await readOpenCodeDefaultModel(paths, "small_model")).toBe("vv-role:fast");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("writes a native explicit literal and clears root role intent", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-intent-literal-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await writeOpenCodeDefaultModel(paths, "model", {
        model: "vv-role:default",
        ensureEntry: true,
      });
      await writeOpenCodeDefaultModel(paths, "model", {
        model: "openai/gpt-5.6-terra#high",
        ensureEntry: false,
      });
      const parsed = JSON.parse(await readFile(paths.opencodeConfigPath, "utf8")) as {
        model?: unknown;
        plugins?: Array<string | { package: string; options?: Record<string, unknown> }>;
      };

      expect(parsed.model).toBe("openai/gpt-5.6-terra#high");
      expect(managedEntry(parsed)?.options?.modelIntent).toBeUndefined();
      expect(await readOpenCodeDefaultModel(paths, "model")).toBe("openai/gpt-5.6-terra#high");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("preserves unrelated plugin entries and options when writing intent", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-intent-preserve-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      await writeFile(
        paths.opencodeConfigPath,
        JSON.stringify(
          {
            plugins: [
              "other-plugin",
              { package: "@osovv/vv-opencode@1.7.0", options: { keep: true } },
              "-remove-me",
            ],
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      await writeOpenCodeAgentModel(paths, "build", {
        model: "vv-role:smart",
        ensureEntry: true,
      });
      const parsed = JSON.parse(await readFile(paths.opencodeConfigPath, "utf8")) as {
        plugins?: Array<string | { package: string; options?: Record<string, unknown> }>;
      };

      expect(parsed.plugins?.[0]).toBe("other-plugin");
      expect(parsed.plugins?.[2]).toBe("-remove-me");
      const entry = managedEntry(parsed);
      expect(entry?.options?.keep).toBe(true);
      expect(entry?.options?.modelIntent).toEqual({ agents: { build: "vv-role:smart" } });
      expect(await readOpenCodeAgentModel(paths, "build")).toBe("vv-role:smart");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("moves a managed agent between the envelope and a native literal", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-intent-agent-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await writeOpenCodeAgentModel(paths, "build", {
        model: "vv-role:smart",
        ensureEntry: true,
      });
      let parsed = JSON.parse(await readFile(paths.opencodeConfigPath, "utf8")) as {
        agents?: Record<string, { model?: string }>;
        plugins?: Array<string | { package: string; options?: Record<string, unknown> }>;
      };
      expect(parsed.agents?.["build"]?.model).toBeUndefined();
      expect(managedEntry(parsed)?.options?.modelIntent).toEqual({
        agents: { build: "vv-role:smart" },
      });

      await writeOpenCodeAgentModel(paths, "build", {
        model: "openai/gpt-5.6-sol#xhigh",
        ensureEntry: false,
      });
      parsed = JSON.parse(await readFile(paths.opencodeConfigPath, "utf8")) as typeof parsed;
      expect(parsed.agents?.["build"]?.model).toBe("openai/gpt-5.6-sol#xhigh");
      expect(managedEntry(parsed)?.options?.modelIntent).toBeUndefined();
      expect(await readOpenCodeAgentModel(paths, "build")).toBe("openai/gpt-5.6-sol#xhigh");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});

describe("managed agent user ownership", () => {
  test("preserves user-owned frontmatter while refreshing the managed body", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-agent-ownership-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await installManagedAgentPrompts(paths, { force: true });
      const agentPath = join(paths.managedAgentsDirPath, "vv-implementer.md");

      const installed = await readFile(agentPath, "utf8");
      const customized = installed.replace(
        "mode: subagent",
        'mode: subagent\nmodel: "openai/gpt-5.6-sol#xhigh"\nhidden: true',
      );
      await writeFile(agentPath, customized, "utf8");

      const results = await syncManagedAgentPrompts(paths, { force: true });
      expect(results.some((result) => result.path === agentPath)).toBe(true);
      const synced = await readFile(agentPath, "utf8");

      expect(synced).toContain('model: "openai/gpt-5.6-sol#xhigh"');
      expect(synced).toContain("hidden: true");
      expect(synced).toContain("Managed by vvoc");
      expect(synced).toContain("vv-implementer subagent");
      // The opening frontmatter fence must survive a re-sync or native
      // discovery would treat the whole file as the system body.
      expect(synced.startsWith("---\n")).toBe(true);
      await syncManagedAgentPrompts(paths, { force: true });
      expect(await readFile(agentPath, "utf8")).toBe(synced);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("incremental inline overrides win over generated markdown after install", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-agent-inline-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      // Initial install writes canonical managed markdown.
      await installManagedAgentPrompts(paths, { force: true });
      const controllerPath = join(paths.managedAgentsDirPath, "vv-controller.md");
      const guardianPath = join(paths.managedAgentsDirPath, "guardian.md");
      expect(await readFile(controllerPath, "utf8")).toContain("mode: primary");

      // The user then adds inline native agent overrides.
      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      await writeFile(
        paths.opencodeConfigPath,
        JSON.stringify(
          {
            agents: {
              "vv-controller": { system: "custom inline system" },
              guardian: {
                steps: 7,
                permissions: [{ action: "edit", resource: "*", effect: "allow" }],
              },
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      await syncManagedAgentPrompts(paths, { force: true });

      // Inline system wins because the canonical generated body is removed.
      await expect(readFile(controllerPath, "utf8")).rejects.toBeDefined();

      // Only the inline-owned keys are stripped; other preserved keys stay.
      const guardian = await readFile(guardianPath, "utf8");
      expect(guardian.startsWith("---\n")).toBe(true);
      expect(guardian).toContain("mode: subagent");
      expect(guardian).toContain("hidden: true");
      expect(guardian).not.toContain("steps:");
      expect(guardian).not.toContain("permissions:");
      expect(guardian).toContain("Managed by vvoc");

      // Repeated sync keeps the reconciliation stable.
      await syncManagedAgentPrompts(paths, { force: true });
      expect(await readFile(guardianPath, "utf8")).toBe(guardian);
      await expect(readFile(controllerPath, "utf8")).rejects.toBeDefined();

      // The resulting native document is valid and carries the effective
      // inline overrides (the unit-level mirror of the real /api/agent check).
      const schemaRequire = createRequire(import.meta.resolve("@opencode/schema/config"));
      const decodeConfig = (
        schemaRequire("effect") as {
          Schema: { decodeUnknownSync: (target: unknown) => (input: unknown) => unknown };
        }
      ).Schema.decodeUnknownSync(NativeConfig.Info);
      const decoded = decodeConfig(
        JSON.parse(await readFile(paths.opencodeConfigPath, "utf8")),
      ) as {
        agents?: Record<string, { system?: string; steps?: number; permissions?: unknown[] }>;
      };
      expect(decoded.agents?.["vv-controller"]?.system).toBe("custom inline system");
      expect(decoded.agents?.guardian?.steps).toBe(7);
      expect(decoded.agents?.guardian?.permissions).toEqual([
        { action: "edit", resource: "*", effect: "allow" },
      ]);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("fails closed when an inline system override conflicts with user-customized markdown", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-agent-conflict-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await installManagedAgentPrompts(paths, { force: true });
      const controllerPath = join(paths.managedAgentsDirPath, "vv-controller.md");
      const customized = (await readFile(controllerPath, "utf8")).replace(
        "mode: primary",
        'mode: primary\nmodel: "openai/gpt-5.6-sol#xhigh"',
      );
      await writeFile(controllerPath, customized, "utf8");

      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      await writeFile(
        paths.opencodeConfigPath,
        JSON.stringify(
          { agents: { "vv-controller": { system: "custom inline system" } } },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      await expect(syncManagedAgentPrompts(paths, { force: true })).rejects.toThrow(
        "conflicts with the user-customized managed markdown",
      );
      // No partial mutation of the user-customized file.
      expect(await readFile(controllerPath, "utf8")).toBe(customized);
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("resolves {file:} tokens from the declaring config dir during prompt sync", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-agent-file-token-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await installManagedAgentPrompts(paths, { force: true });
      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      await writeFile(
        join(dirname(paths.opencodeConfigPath), "prompt.md"),
        "Resolved helper system.\n",
        "utf8",
      );

      // A user agent whose system points at a file relative to the declaring
      // config directory. Prompt sync validates this document before writing,
      // so it must supply the config dir instead of failing on the unresolved
      // token (regression for the inline-override preflight).
      await writeFile(
        paths.opencodeConfigPath,
        JSON.stringify({ agents: { helper: { system: "{file:./prompt.md}" } } }, null, 2) + "\n",
        "utf8",
      );

      await expect(syncManagedAgentPrompts(paths, { force: true })).resolves.toBeDefined();
      expect(await readFile(paths.opencodeConfigPath, "utf8")).toContain("{file:./prompt.md}");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});

describe("native root isolation", () => {
  test("project-scope writes never touch the native global root", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-root-iso-project-"));
    const globalRoot = await mkdtemp(join(tmpdir(), "vvoc-root-iso-global-"));
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-root-iso-config-"));
    const prev = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = globalRoot;
    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
        configDir: configHome,
      });
      expect(paths.opencodeBaseDir).toBe(join(projectDir, ".opencode"));
      await ensurePackageInstalled(paths);
      await syncManagedAgentRegistrations(paths);

      expect(await readFile(join(projectDir, ".opencode", "opencode.json"), "utf8")).toContain(
        "plugins",
      );
      await expect(readFile(join(globalRoot, "opencode.json"), "utf8")).rejects.toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = prev;
      await rm(projectDir, { recursive: true, force: true });
      await rm(globalRoot, { recursive: true, force: true });
      await rm(configHome, { recursive: true, force: true });
    }
  });
});

describe("native schema verification", () => {
  // Resolve the schema package's own Effect 4 runtime instead of the root Effect 3 copy.
  const schemaRequire = createRequire(import.meta.resolve("@opencode/schema/config"));
  type NativeDecoder = (input: unknown) => Record<string, unknown>;
  const nativeDecode = (schema: unknown): NativeDecoder => {
    const runtime = schemaRequire("effect") as {
      Schema: { decodeUnknownSync: (target: unknown) => NativeDecoder };
    };
    return runtime.Schema.decodeUnknownSync(schema);
  };
  const decodeConfig = nativeDecode(NativeConfig.Info);
  const decodeAgent = nativeDecode(NativeConfigAgent.Info);
  const decodePluginEntry = nativeDecode(NativeConfigPlugin.Entry);

  test("generated OpenCode config decodes with the pinned native schema unmodified", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-native-decode-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-native-decode-project-"));
    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
        configDir: configHome,
      });
      await ensurePackageInstalled(paths);
      await syncManagedAgentRegistrations(paths);
      await installManagedAgentPrompts(paths, { force: true });

      const raw = await readFile(paths.opencodeConfigPath, "utf8");
      const document = JSON.parse(raw) as Record<string, unknown>;
      const decoded = decodeConfig(document) as {
        default_agent?: string;
        skills?: string[];
        plugins?: unknown[];
      };

      expect(decoded.default_agent).toBe("vv-controller");
      expect(decoded.skills).toEqual([".vvoc/skills"]);
      expect(decoded.plugins).toBeDefined();
      const pluginEntry = decoded.plugins?.[0];
      expect(() => decodePluginEntry(pluginEntry)).not.toThrow();
      // No V1 fields survive.
      expect(document).not.toHaveProperty("agent");
      expect(document).not.toHaveProperty("plugin");
      expect(document).not.toHaveProperty("small_model");
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("generated agent markdown frontmatter decodes with the pinned native agent schema", () => {
    for (const name of [
      "guardian",
      "vv-controller",
      "enhancer",
      "vv-implementer",
      "vv-spec-reviewer",
      "vv-code-reviewer",
      "investigator",
      "vv-reflector",
    ] as const) {
      const frontmatter = getManagedNativeAgentFrontmatter(name);
      expect(() => decodeAgent({ ...frontmatter, system: "prompt body" })).not.toThrow();
    }
  });
});

describe("native schema preflight", () => {
  const malformed: Array<[string, Record<string, unknown>]> = [
    ["providers as an array", { providers: [] }],
    [
      "model limit context as a string",
      { providers: { x: { models: { m: { limit: { context: "big" } } } } } },
    ],
    ["agent permissions as a string", { agents: { a: { permissions: "nope" } } }],
    ["agent mode literal", { agents: { a: { mode: "bogus" } } }],
  ];

  for (const [name, document] of malformed) {
    test(`rejects malformed native config before writes: ${name}`, () => {
      const text = JSON.stringify(document, null, 2) + "\n";
      expect(() => ensurePackageConfigText(text)).toThrow(
        "document does not satisfy the pinned native OpenCode 2.0.18 config schema",
      );
    });
  }

  test("sync and asset install refuse a malformed existing config with no writes", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-preflight-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-preflight-project-"));
    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
        configDir: configHome,
      });
      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      const malformedText = '{ "providers": [] }\n';
      await writeFile(paths.opencodeConfigPath, malformedText, "utf8");

      await expect(syncManagedAgentRegistrations(paths)).rejects.toThrow(
        "does not satisfy the pinned native OpenCode 2.0.18 config schema",
      );
      await expect(installManagedAgentPrompts(paths, { force: true })).rejects.toThrow(
        "document does not satisfy the pinned native OpenCode 2.0.18 config schema",
      );
      // Byte-unchanged config and no generated assets.
      expect(await readFile(paths.opencodeConfigPath, "utf8")).toBe(malformedText);
      await expect(
        readFile(join(paths.managedAgentsDirPath, "guardian.md"), "utf8"),
      ).rejects.toBeDefined();
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("rejects a structural error even when an unrelated token is present, before writes", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-preflight-token-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-preflight-token-project-"));
    const prevSecret = process.env.VVOC_SECRET;
    process.env.VVOC_SECRET = "supersecretvalue";
    try {
      const text = JSON.stringify({ providers: [], note: "{env:VVOC_SECRET}" }, null, 2) + "\n";
      let message = "";
      expect(() => ensurePackageConfigText(text)).toThrow();
      try {
        ensurePackageConfigText(text);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("does not satisfy the pinned native OpenCode 2.0.18 config schema");
      expect(message).not.toContain("supersecretvalue");

      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
        configDir: configHome,
      });
      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      await writeFile(paths.opencodeConfigPath, text, "utf8");
      await expect(syncManagedAgentRegistrations(paths)).rejects.toThrow();
      await expect(installManagedAgentPrompts(paths, { force: true })).rejects.toThrow();
      expect(await readFile(paths.opencodeConfigPath, "utf8")).toBe(text);
      await expect(
        readFile(join(paths.managedAgentsDirPath, "guardian.md"), "utf8"),
      ).rejects.toBeDefined();
    } finally {
      if (prevSecret === undefined) delete process.env.VVOC_SECRET;
      else process.env.VVOC_SECRET = prevSecret;
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("rejects an invalid nested field alongside a valid secret token", () => {
    const prevSecret = process.env.VVOC_SECRET;
    process.env.VVOC_SECRET = "anothersecret";
    try {
      const text =
        JSON.stringify(
          {
            providers: { x: { models: { m: { limit: { context: "big" } } } } },
            note: "{env:VVOC_SECRET}",
          },
          null,
          2,
        ) + "\n";
      let message = "";
      try {
        ensurePackageConfigText(text);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("does not satisfy the pinned native OpenCode 2.0.18 config schema");
      expect(message).not.toContain("anothersecret");
    } finally {
      if (prevSecret === undefined) delete process.env.VVOC_SECRET;
      else process.env.VVOC_SECRET = prevSecret;
    }
  });

  test("fails closed when a missing env token yields an invalid model", () => {
    const prev = process.env.VVOC_UNSET_MODEL;
    delete process.env.VVOC_UNSET_MODEL;
    try {
      expect(() => ensurePackageConfigText('{ "model": "{env:VVOC_UNSET_MODEL}" }\n')).toThrow(
        "document does not satisfy the pinned native OpenCode 2.0.18 config schema",
      );
    } finally {
      if (prev !== undefined) process.env.VVOC_UNSET_MODEL = prev;
    }
  });

  test("resolves a valid env model and preserves the original token on write", () => {
    const prev = process.env.VVOC_MODEL;
    process.env.VVOC_MODEL = "openai/gpt-5.6-terra#high";
    try {
      const output = ensurePackageConfigText('{ "model": "{env:VVOC_MODEL}" }\n');
      expect(output).toContain("{env:VVOC_MODEL}");
    } finally {
      if (prev === undefined) delete process.env.VVOC_MODEL;
      else process.env.VVOC_MODEL = prev;
    }
  });

  test("resolves a source-relative file ref from the declaring config dir, not cwd", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-preflight-file-"));
    try {
      await writeFile(join(configHome, "model.txt"), "openai/gpt-5.6-terra#high\n", "utf8");
      const text = '{ "model": "{file:./model.txt}" }\n';
      expect(() =>
        ensurePackageConfigText(text, PACKAGE_NAME, { configDir: configHome }),
      ).not.toThrow();
      const output = ensurePackageConfigText(text, PACKAGE_NAME, { configDir: configHome });
      expect(output).toContain("{file:./model.txt}");

      // A different (cwd-like) directory without the file must not be used.
      const otherDir = await mkdtemp(join(tmpdir(), "vvoc-preflight-other-"));
      try {
        let message = "";
        try {
          ensurePackageConfigText(text, PACKAGE_NAME, { configDir: otherDir });
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toContain("unresolved {file:} reference");
        expect(message).not.toContain("model.txt");
      } finally {
        await rm(otherDir, { recursive: true, force: true });
      }
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("accepts valid native user extras and a real agent system file", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-preflight-extras-"));
    try {
      await writeFile(join(configHome, "prompt.md"), "You are a helper.\n", "utf8");
      const text =
        JSON.stringify(
          {
            plugins: [{ package: "custom/plugin", options: { custom: { nested: [1, 2, 3] } } }],
            "my-user-field": true,
            permissions: [{ action: "*", resource: "*", effect: "allow" }],
            agents: { a: { system: "{file:./prompt.md}" } },
          },
          null,
          2,
        ) + "\n";
      expect(() =>
        ensurePackageConfigText(text, PACKAGE_NAME, { configDir: configHome }),
      ).not.toThrow();
      const output = ensurePackageConfigText(text, PACKAGE_NAME, { configDir: configHome });
      expect(output).toContain("{file:./prompt.md}");
      expect(output).toContain('"my-user-field": true');
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});

describe("modelIntent regression: string plugin entries and managed agent models", () => {
  const STRING_ENTRY_CONFIG =
    JSON.stringify({ plugins: ["@osovv/vv-opencode@1.7.0"] }, null, 2) + "\n";

  test("upgrades a string managed entry in place instead of appending a duplicate", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-intent-string-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      await writeFile(paths.opencodeConfigPath, STRING_ENTRY_CONFIG, "utf8");

      await writeOpenCodeDefaultModel(paths, "model", {
        model: "vv-role:default",
        ensureEntry: false,
      });
      const content = await readFile(paths.opencodeConfigPath, "utf8");
      const parsed = JSON.parse(content) as { plugins?: unknown[] };

      expect(parsed.plugins).toHaveLength(1);
      expect(parsed.plugins?.[0]).toMatchObject({
        options: { modelIntent: { model: "vv-role:default" } },
      });
      expect(await readOpenCodeDefaultModel(paths, "model")).toBe("vv-role:default");
      // A subsequent sync-style rewrite must not see conflicting managed entries.
      expect(() => ensurePackageConfigText(content)).not.toThrow();
      expect(ensurePackageConfigText(ensurePackageConfigText(content))).toBe(
        ensurePackageConfigText(content),
      );
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("preserves ordered directives and unrelated options while writing intent", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-intent-order-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      await writeFile(
        paths.opencodeConfigPath,
        JSON.stringify(
          {
            plugins: [
              "-remove-me",
              { package: "other-plugin", options: { keep: true } },
              "@osovv/vv-opencode@1.7.0",
            ],
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      await writeOpenCodeAgentModel(paths, "build", { model: "vv-role:smart", ensureEntry: true });
      const parsed = JSON.parse(await readFile(paths.opencodeConfigPath, "utf8")) as {
        plugins?: Array<string | { package: string; options?: Record<string, unknown> }>;
      };
      expect(parsed.plugins?.[0]).toBe("-remove-me");
      expect(parsed.plugins?.[1]).toEqual({ package: "other-plugin", options: { keep: true } });
      expect(parsed.plugins?.[2]).toMatchObject({
        options: { modelIntent: { agents: { build: "vv-role:smart" } } },
      });
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("managed agent role ref goes to the envelope and a literal to native agents", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-managed-agent-model-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      await writeFile(paths.opencodeConfigPath, STRING_ENTRY_CONFIG, "utf8");

      await writeManagedAgentModel(paths, "vv-controller", {
        model: "vv-role:smart",
        ensureEntry: true,
      });
      const roleDoc = JSON.parse(await readFile(paths.opencodeConfigPath, "utf8")) as {
        agents?: Record<string, { model?: string }>;
        plugins?: Array<{
          package?: string;
          options?: { modelIntent?: { agents?: Record<string, string> } };
        }>;
      };
      expect(roleDoc.agents?.["vv-controller"]?.model).toBeUndefined();
      expect(roleDoc.plugins?.[0]?.options?.modelIntent?.agents?.["vv-controller"]).toBe(
        "vv-role:smart",
      );
      expect(await readFile(paths.opencodeConfigPath, "utf8")).not.toContain(
        '"agents": {\n      "vv-controller": {\n        "model": "vv-role:smart"',
      );
      expect((await readManagedAgentModels(paths))["vv-controller"]).toBe("vv-role:smart");

      await writeManagedAgentModel(paths, "vv-controller", {
        model: "openai/gpt-5.6-sol#xhigh",
        ensureEntry: false,
      });
      const literalDoc = JSON.parse(await readFile(paths.opencodeConfigPath, "utf8")) as {
        agents?: Record<string, { model?: string }>;
        plugins?: Array<{ options?: { modelIntent?: unknown } }>;
      };
      expect(literalDoc.agents?.["vv-controller"]?.model).toBe("openai/gpt-5.6-sol#xhigh");
      expect(literalDoc.plugins?.[0]?.options?.modelIntent).toBeUndefined();
      expect((await readManagedAgentModels(paths))["vv-controller"]).toBe(
        "openai/gpt-5.6-sol#xhigh",
      );
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});

describe("native model struct readers", () => {
  test("normalizes provider/model/variant structs across public readers", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-struct-read-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      await writeFile(
        paths.opencodeConfigPath,
        JSON.stringify(
          {
            model: { providerID: "openai", model: "gpt-6-astra", variant: "max" },
            agents: {
              "vv-controller": {
                model: { providerID: "openai", model: "gpt-5.6-sol", variant: "xhigh" },
              },
              build: { model: "openai/gpt-5.6-terra#high" },
            },
            plugins: [
              {
                package: "@osovv/vv-opencode@1.7.0",
                options: { modelIntent: { agents: { enhancer: "vv-role:smart" } } },
              },
            ],
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      expect(await readOpenCodeDefaultModel(paths, "model")).toBe("openai/gpt-6-astra#max");
      expect(await readOpenCodeAgentModel(paths, "build")).toBe("openai/gpt-5.6-terra#high");
      const managed = await readManagedAgentModels(paths);
      expect(managed["vv-controller"]).toBe("openai/gpt-5.6-sol#xhigh");
      // Envelope role intent still surfaces for a managed agent without a literal.
      expect(managed["enhancer"]).toBe("vv-role:smart");
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("rejects an invalid model struct instead of silently defaulting", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-struct-invalid-"));
    try {
      const paths = await resolvePaths({
        scope: "global",
        cwd: "/workspace/project",
        configDir: configHome,
      });
      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      await writeFile(
        paths.opencodeConfigPath,
        JSON.stringify({ model: { providerID: "openai" } }, null, 2) + "\n",
        "utf8",
      );
      await expect(readOpenCodeDefaultModel(paths, "model")).rejects.toThrow(
        "expected model selection model id",
      );
    } finally {
      await rm(configHome, { recursive: true, force: true });
    }
  });
});
