// FILE: src/lib/opencode.test.ts
// VERSION: 1.4.1
// START_MODULE_CONTRACT
//   PURPOSE: Verify OpenCode config mutation and canonical vvoc config path/helpers.
//   SCOPE: Plugin specifier writes, role-reference OpenCode defaults/agent/tool rewrites, managed prompt/plan scaffolding, canonical vvoc schema v3 writes, strict pre-role schema rejection, and scope-aware path resolution behavior.
//   DEPENDS: [bun:test, jsonc-parser, src/lib/opencode.ts]
//   LINKS: [M-CLI-CONFIG, V-M-CLI-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ensurePackageConfigText tests - Verify schema insertion and pinned plugin writes.
//   ensureManagedAgentRegistrationsConfigText tests - Verify role-reference defaults, managed tool rewrites, and managed agent rewrites while preserving comments.
//   canonical vvoc config tests - Verify schema v3 seeding, managed preset refresh, and strict pre-role rejection.
//   provider helper tests - Verify conservative provider patch helpers remain comment-safe.
//   resolvePaths tests - Verify vvoc/OpenCode root separation by scope.
//   managed skill files tests - Verify managed skill/reference install, sync, and custom-skill reference safety.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.4.1 - Added managed skill distribution and behavioral coverage for vv-handoff.]
//   LAST_CHANGE: [v1.3.0 - Added strict current-only vvoc config rejection and no-rewrite mutation coverage.]
//   LAST_CHANGE: [v1.4.0 - Updated managed registration coverage so old-name agents and old command entries remain untouched.]
//   LAST_CHANGE: [v1.2.8 - Added regression test for syncManagedSkillFiles not syncing references when parent skill is skipped (config-safety).]
//   LAST_CHANGE: [v1.2.7 - Added vv-reflect template coverage for user-provided domain and product insight capture.]
//   LAST_CHANGE: [v1.2.6 - Added vv-reflect template coverage for generalized lesson synthesis instead of current-session recaps.]
//   LAST_CHANGE: [v1.2.5 - Updated managed vv-controller registration expectations to seed and sync `model = vv-role:smart` while preserving root defaults.]
//   LAST_CHANGE: [v1.2.4 - Added static schema regression coverage for the package-versioned URL and plugins property placement.]
//   LAST_CHANGE: [v1.2.3 - Removed vv-plan/vv-review command assertions after replacing them with managed skills system.]
//   LAST_CHANGE: [v1.2.2 - Reworked the vv-deepseek refresh regression to write drifted managed presets directly before syncVvocConfig runs.]
//   LAST_CHANGE: [v1.2.0 - Added coverage for managed vv-controller registrations and planning artifact directory scaffolding.]
//   LAST_CHANGE: [v1.2.1 - Added regression coverage proving sync restores drifted vv-deepseek while preserving custom non-managed presets.]
//   LAST_CHANGE: [v1.1.7 - Added regression coverage for managed `tools.apply_patch = false` writes and sibling `tools.*` preservation during OpenCode config sync.]
//   LAST_CHANGE: [v1.1.6 - Added regression coverage ensuring legacy old-name cleanup is blocked when the legacy prompt file exists but is user-owned (missing vvoc managed marker).]
//   LAST_CHANGE: [C-CODEX-PRESET-LIMITS - Updated canonical fresh-config preset key coverage from vv-openai to vv-codex.]
//   LAST_CHANGE: [v1.2.5 - Added managed skill distribution coverage for vv-reflect.]
//   LAST_CHANGE: [v1.1.5 - Added coverage ensuring legacy cleanup preserves old-name agents that keep legacy prompt paths but diverge from managed model/permission/description/mode fields.]
//   LAST_CHANGE: [v1.1.4 - Added coverage proving legacy cleanup is restricted to clearly vvoc-managed old tracked entries and preserves user-owned agents that reuse old names.]
//   LAST_CHANGE: [v1.1.3 - Added legacy tracked-agent migration coverage to verify sync removes pre-rename implementer/spec-reviewer/code-reviewer registrations while preserving unrelated agent entries and comments.]
//   LAST_CHANGE: [v1.1.2 - Updated managed registration and prompt assertions to vv-* tracked subagent names and filenames.]
//   LAST_CHANGE: [v1.1.1 - Updated managed registration coverage so only `agent.explore` is auto-seeded among built-in OpenCode agents.]
//   LAST_CHANGE: [v1.1.0 - Added installation inspection coverage for canonical role inventory ordering and unresolved vv-role reference diagnostics.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import {
  OPENCODE_SCHEMA_URL,
  PACKAGE_NAME,
  ensureManagedAgentRegistrationsConfigText,
  ensurePackageConfigText,
  ensurePackageInstalled,
  ensureProviderBaseUrlConfigText,
  installManagedAgentPrompts,
  installManagedSkillFiles,
  installVvocConfig,
  inspectInstallation,
  parseGuardianConfigText,
  readVvocConfig,
  renderGuardianConfig,
  resolvePaths,
  syncManagedAgentRegistrations,
  syncManagedSkillFiles,
  syncVvocConfig,
  writeGuardianConfig,
  writeProviderBaseUrl,
  writeOpenCodeProviderObject,
} from "./opencode.js";
import {
  createDefaultVvocConfig,
  parseVvocConfigText,
  renderVvocConfig,
  VVOC_CONFIG_SCHEMA_URL,
} from "./vvoc-config.js";

describe("ensurePackageConfigText", () => {
  test("creates a new config when none exists", () => {
    const output = ensurePackageConfigText(undefined, `${PACKAGE_NAME}@0.2.3`);
    const parsed = parse(output) as { $schema?: string; plugin?: string[] };

    expect(parsed.$schema).toBe(OPENCODE_SCHEMA_URL);
    expect(parsed.plugin).toEqual([`${PACKAGE_NAME}@0.2.3`]);
  });

  test("preserves comments while appending the plugin", () => {
    const input = `{
  // existing plugin comment
  "plugin": ["foo"]
}\n`;
    const output = ensurePackageConfigText(input, `${PACKAGE_NAME}@0.2.3`);
    const parsed = parse(output) as { plugin?: string[] };

    expect(output).toContain("// existing plugin comment");
    expect(parsed.plugin).toEqual(["foo", `${PACKAGE_NAME}@0.2.3`]);
  });

  test("upgrades bare or old pinned package entries to the requested version", () => {
    const input = `{
  "plugin": ["foo", "${PACKAGE_NAME}", "${PACKAGE_NAME}@0.2.2"]
}\n`;
    const output = ensurePackageConfigText(input, `${PACKAGE_NAME}@0.2.3`);
    const parsed = parse(output) as { plugin?: string[] };

    expect(parsed.plugin).toEqual(["foo", `${PACKAGE_NAME}@0.2.3`]);
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

describe("managed OpenCode role-reference rewrites", () => {
  test("rewrites root defaults, built-in agents, and managed agents to vv-role refs", async () => {
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
      tools?: { apply_patch?: boolean };
      agent?: Record<
        string,
        { model?: string; prompt?: string; mode?: string; permission?: unknown }
      >;
      command?: Record<string, { description?: string; agent?: string; template?: string }>;
    };

    expect(parsed.model).toBe("vv-role:default");
    expect(parsed.small_model).toBe("vv-role:fast");
    expect(parsed.default_agent).toBe("vv-controller");
    expect(parsed.tools?.apply_patch).toBe(false);
    expect(parsed.agent?.build).toBeUndefined();
    expect(parsed.agent?.plan).toBeUndefined();
    expect(parsed.agent?.general).toBeUndefined();
    expect(parsed.agent?.explore?.model).toBe("vv-role:fast");
    expect(parsed.agent?.["vv-controller"]?.model).toBe("vv-role:smart");
    expect(parsed.agent?.["vv-controller"]?.mode).toBe("primary");
    expect(parsed.agent?.["vv-controller"]?.prompt).toBe("{file:../vvoc/agents/vv-controller.md}");
    expect(parsed.agent?.enhancer?.model).toBe("vv-role:smart");
    expect(parsed.agent?.enhancer?.mode).toBe("primary");
    expect(parsed.agent?.enhancer?.prompt).toBe("{file:../vvoc/agents/enhancer.md}");
    expect(parsed.agent?.enhancer?.permission).toEqual({
      edit: "deny",
      bash: "deny",
      task: "deny",
      todowrite: "deny",
    });
    expect(parsed.agent?.["vv-implementer"]?.model).toBe("vv-role:default");
    expect(parsed.agent?.["vv-spec-reviewer"]?.model).toBe("vv-role:reviewer");
    expect(parsed.agent?.["vv-code-reviewer"]?.model).toBe("vv-role:reviewer");
    expect(parsed.agent?.investigator?.model).toBe("vv-role:smart");
  });

  test("preserves comments while rewriting managed fields and leaving unrelated built-ins alone", async () => {
    const paths = await resolvePaths({
      scope: "project",
      cwd: "/workspace/project",
      configDir: "/tmp/vvoc-config-home",
    });

    const input = `{
  // keep root note
  "model": "openai/gpt-5",
  // keep root small note
  "small_model": "openai/gpt-5-mini",
      "default_agent": "plan",
  "tools": {
    // keep tools note
    "read": true,
    "apply_patch": true
  },
  "skills": {
    "paths": ["./custom-skills"]
  },
  "agent": {
    // keep managed note
    "enhancer": {
      // keep managed nested note
      "model": "openai/gpt-5",
      "prompt": "{file:./.vvoc/agents/enhancer.md}"
    },
    "build": {
      // keep build note
      "model": "openai/gpt-5",
      // keep build sibling note
      "mode": "primary"
    }
  }
}\n`;

    const output = ensureManagedAgentRegistrationsConfigText(input, paths);
    const parsed = parse(output) as {
      model?: string;
      small_model?: string;
      tools?: { apply_patch?: boolean; read?: boolean };
      default_agent?: string;
      agent?: Record<string, { model?: string; prompt?: string }>;
      skills?: { paths?: string[] };
      command?: Record<string, { agent?: string; template?: string }>;
    };

    expect(output).toContain("// keep root note");
    expect(output).toContain("// keep root small note");
    expect(output).toContain("// keep tools note");
    expect(output).toContain("// keep managed note");
    expect(output).toContain("// keep managed nested note");
    expect(output).toContain("// keep build note");
    expect(output).toContain("// keep build sibling note");
    expect(parsed.model).toBe("vv-role:default");
    expect(parsed.small_model).toBe("vv-role:fast");
    expect(parsed.default_agent).toBe("vv-controller");
    expect(parsed.tools?.read).toBe(true);
    expect(parsed.tools?.apply_patch).toBe(false);
    expect(parsed.agent?.build?.model).toBe("openai/gpt-5");
    expect(parsed.agent?.["vv-controller"]?.model).toBe("vv-role:smart");
    expect(parsed.agent?.enhancer?.model).toBe("vv-role:smart");
    expect(parsed.agent?.enhancer?.prompt).toBe("{file:../.vvoc/agents/enhancer.md}");
    expect(parsed.skills?.paths).toContain("./custom-skills");
    expect(parsed.skills?.paths).toContain("../.vvoc/skills");
  });

  test("sync preserves old-name agents and old command entries while adding current managed agents", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-current-agent-sync-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
      });

      const existingConfig = `{
  "model": "openai/gpt-5",
  "small_model": "openai/gpt-5-mini",
  "agent": {
    // keep unrelated user agent
    "custom-helper": {
      "model": "openai/gpt-5-mini",
      "prompt": "{file:./custom-helper.md}"
    },
    "implementer": {
      "description": "Implements approved changes with focused verification and a minimal diff.",
      "model": "vv-role:default",
      "prompt": "{file:../.vvoc/agents/implementer.md}",
      "mode": "subagent"
    },
    "spec-reviewer": {
      "description": "Checks an implementation against the requested spec and flags missing or extra behavior.",
      "model": "vv-role:smart",
      "prompt": "{file:../.vvoc/agents/spec-reviewer.md}",
      "mode": "subagent",
      "permission": {
        "edit": "deny"
      }
    },
    "code-reviewer": {
      "description": "Reviews changes for bugs, regressions, maintainability risks, and missing tests.",
      "model": "vv-role:smart",
      "prompt": "{file:../.vvoc/agents/code-reviewer.md}",
      "mode": "subagent",
      "permission": {
        "edit": "deny"
      }
    }
  },
  "command": {
    "vv-plan": {
      "agent": "plan",
      "template": "legacy plan"
    },
    "vv-review": {
      "agent": "reviewer",
      "template": "legacy review"
    }
  }
}\n`;

      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      await writeFile(paths.opencodeConfigPath, existingConfig, "utf8");
      const result = await syncManagedAgentRegistrations(paths);
      const syncedText = await readFile(paths.opencodeConfigPath, "utf8");
      const synced = parse(syncedText) as {
        agent?: Record<string, { model?: string; prompt?: string }>;
        command?: Record<string, { agent?: string; template?: string }>;
      };

      expect(result.changed).toBe(true);
      expect(syncedText).toContain("// keep unrelated user agent");
      expect(synced.agent?.["custom-helper"]?.model).toBe("openai/gpt-5-mini");
      expect(synced.agent?.implementer?.prompt).toBe("{file:../.vvoc/agents/implementer.md}");
      expect(synced.agent?.["spec-reviewer"]?.prompt).toBe(
        "{file:../.vvoc/agents/spec-reviewer.md}",
      );
      expect(synced.agent?.["code-reviewer"]?.prompt).toBe(
        "{file:../.vvoc/agents/code-reviewer.md}",
      );
      expect(synced.command?.["vv-plan"]?.template).toBe("legacy plan");
      expect(synced.command?.["vv-review"]?.template).toBe("legacy review");
      expect(synced.agent?.["vv-implementer"]?.prompt).toBe(
        "{file:../.vvoc/agents/vv-implementer.md}",
      );
      expect(synced.agent?.["vv-spec-reviewer"]?.prompt).toBe(
        "{file:../.vvoc/agents/vv-spec-reviewer.md}",
      );
      expect(synced.agent?.["vv-code-reviewer"]?.prompt).toBe(
        "{file:../.vvoc/agents/vv-code-reviewer.md}",
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("sync preserves user-owned agents that reuse old tracked names", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-legacy-agent-preserve-custom-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
      });

      const customNamedConfig = `{
  "agent": {
    // keep custom implementer
    "implementer": {
      "model": "openai/gpt-5",
      "prompt": "{file:./custom-implementer.md}",
      "mode": "subagent"
    },
    "spec-reviewer": {
      "model": "openai/gpt-5-mini",
      "mode": "subagent"
    },
    "code-reviewer": {
      "model": "anthropic/claude-sonnet-4-5",
      "prompt": "{file:./custom-code-reviewer.md}",
      "mode": "subagent"
    }
  }
}\n`;

      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      await writeFile(paths.opencodeConfigPath, customNamedConfig, "utf8");
      const result = await syncManagedAgentRegistrations(paths);
      const syncedText = await readFile(paths.opencodeConfigPath, "utf8");
      const synced = parse(syncedText) as {
        agent?: Record<string, { model?: string; prompt?: string; mode?: string }>;
      };

      expect(result.changed).toBe(true);
      expect(syncedText).toContain("// keep custom implementer");

      expect(synced.agent?.implementer?.prompt).toBe("{file:./custom-implementer.md}");
      expect(synced.agent?.implementer?.mode).toBe("subagent");
      expect(synced.agent?.["spec-reviewer"]?.model).toBe("openai/gpt-5-mini");
      expect(synced.agent?.["code-reviewer"]?.prompt).toBe("{file:./custom-code-reviewer.md}");

      expect(synced.agent?.["vv-implementer"]?.prompt).toBe(
        "{file:../.vvoc/agents/vv-implementer.md}",
      );
      expect(synced.agent?.["vv-spec-reviewer"]?.prompt).toBe(
        "{file:../.vvoc/agents/vv-spec-reviewer.md}",
      );
      expect(synced.agent?.["vv-code-reviewer"]?.prompt).toBe(
        "{file:../.vvoc/agents/vv-code-reviewer.md}",
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("sync preserves legacy-path old-name agents when registration shape is customized", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-legacy-agent-customized-shape-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
      });

      const customizedLegacyPathConfig = `{
  "agent": {
    "implementer": {
      "description": "Custom team implementer",
      "mode": "subagent",
      "prompt": "{file:../.vvoc/agents/implementer.md}",
      "model": "vv-role:smart"
    },
    "spec-reviewer": {
      "description": "Checks an implementation against the requested spec and flags missing or extra behavior.",
      "mode": "subagent",
      "prompt": "{file:../.vvoc/agents/spec-reviewer.md}",
      "model": "vv-role:smart",
      "permission": {
        "edit": "allow"
      }
    },
    "code-reviewer": {
      "description": "Reviews changes for bugs, regressions, maintainability risks, and missing tests.",
      "mode": "primary",
      "prompt": "{file:../.vvoc/agents/code-reviewer.md}",
      "model": "vv-role:smart",
      "permission": {
        "edit": "deny"
      }
    }
  }
}\n`;

      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      await writeFile(paths.opencodeConfigPath, customizedLegacyPathConfig, "utf8");
      const result = await syncManagedAgentRegistrations(paths);
      const synced = parse(await readFile(paths.opencodeConfigPath, "utf8")) as {
        agent?: Record<
          string,
          { description?: string; mode?: string; model?: string; prompt?: string }
        >;
      };

      expect(result.changed).toBe(true);
      expect(synced.agent?.implementer?.description).toBe("Custom team implementer");
      expect(synced.agent?.implementer?.model).toBe("vv-role:smart");
      expect(synced.agent?.implementer?.prompt).toBe("{file:../.vvoc/agents/implementer.md}");

      expect(synced.agent?.["spec-reviewer"]?.prompt).toBe(
        "{file:../.vvoc/agents/spec-reviewer.md}",
      );
      expect(synced.agent?.["spec-reviewer"]?.model).toBe("vv-role:smart");

      expect(synced.agent?.["code-reviewer"]?.mode).toBe("primary");
      expect(synced.agent?.["code-reviewer"]?.prompt).toBe(
        "{file:../.vvoc/agents/code-reviewer.md}",
      );

      expect(synced.agent?.["vv-implementer"]?.prompt).toBe(
        "{file:../.vvoc/agents/vv-implementer.md}",
      );
      expect(synced.agent?.["vv-spec-reviewer"]?.prompt).toBe(
        "{file:../.vvoc/agents/vv-spec-reviewer.md}",
      );
      expect(synced.agent?.["vv-code-reviewer"]?.prompt).toBe(
        "{file:../.vvoc/agents/vv-code-reviewer.md}",
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("sync preserves full legacy-shaped old-name entry when legacy prompt file is user-owned", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-legacy-user-owned-prompt-"));

    try {
      const paths = await resolvePaths({
        scope: "project",
        cwd: projectDir,
      });

      await mkdir(paths.managedAgentsDirPath, { recursive: true });
      await writeFile(
        join(paths.managedAgentsDirPath, "implementer.md"),
        "# Customized legacy implementer prompt without managed marker\n",
        "utf8",
      );

      const legacyManagedShapeConfig = `{
  "agent": {
    "implementer": {
      "description": "Implements approved changes with focused verification and a minimal diff.",
      "mode": "subagent",
      "prompt": "{file:../.vvoc/agents/implementer.md}",
      "model": "vv-role:default"
    }
  }
}\n`;

      await mkdir(dirname(paths.opencodeConfigPath), { recursive: true });
      await writeFile(paths.opencodeConfigPath, legacyManagedShapeConfig, "utf8");
      const result = await syncManagedAgentRegistrations(paths);
      const synced = parse(await readFile(paths.opencodeConfigPath, "utf8")) as {
        agent?: Record<string, { model?: string; prompt?: string }>;
      };

      expect(result.changed).toBe(true);
      expect(synced.agent?.implementer?.prompt).toBe("{file:../.vvoc/agents/implementer.md}");
      expect(synced.agent?.implementer?.model).toBe("vv-role:default");
      expect(synced.agent?.["vv-implementer"]?.prompt).toBe(
        "{file:../.vvoc/agents/vv-implementer.md}",
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
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
      properties?: { version?: { const?: number }; plugins?: unknown };
    };

    expect(schema.$id).toBe(VVOC_CONFIG_SCHEMA_URL);
    expect(schema.properties?.version?.const).toBe(3);
    expect(schema.required).toContain("plugins");
    expect(schema.properties?.plugins).toBeDefined();
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

    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
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
        plugin?: string[];
        model?: string;
        small_model?: string;
        default_agent?: string;
        tools?: { apply_patch?: boolean };
        agent?: Record<string, { model?: string }>;
        command?: Record<string, { agent?: string }>;
      };
      const vvocConfig = await readVvocConfig(paths);

      expect(openCodeConfig.plugin?.some((entry) => entry.startsWith(`${PACKAGE_NAME}@`))).toBe(
        true,
      );
      expect(openCodeConfig.model).toBe("vv-role:default");
      expect(openCodeConfig.small_model).toBe("vv-role:fast");
      expect(openCodeConfig.default_agent).toBe("vv-controller");
      expect(openCodeConfig.tools?.apply_patch).toBe(false);
      expect(openCodeConfig.agent?.build).toBeUndefined();
      expect(openCodeConfig.agent?.general).toBeUndefined();
      expect(openCodeConfig.agent?.explore?.model).toBe("vv-role:fast");
      expect(openCodeConfig.agent?.["vv-controller"]?.model).toBe("vv-role:smart");
      expect(openCodeConfig.agent?.enhancer?.model).toBe("vv-role:smart");

      expect(vvocConfig?.version).toBe(3);
      expect(vvocConfig?.$schema).toBe(VVOC_CONFIG_SCHEMA_URL);
      expect(vvocConfig?.roles.default).toBeDefined();
      expect(vvocConfig?.roles.smart).toBeDefined();
      expect(vvocConfig?.roles.fast).toBeDefined();
      expect(vvocConfig?.roles.vision).toBeDefined();
      expect(vvocConfig?.roles.reviewer).toBeDefined();
      expect(Object.keys(vvocConfig?.presets ?? {})).toEqual([
        "vv-codex",
        "vv-zai",
        "vv-minimax",
        "vv-deepseek",
        "vv-osovv",
        "vv-osovv-cheap",
      ]);
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
              },
              custom: {
                description: "user preset",
                agents: {
                  custom: "openai/gpt-5.4-mini",
                },
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
      expect(synced?.presets.custom?.agents.custom).toBe("openai/gpt-5.4-mini");
      expect(synced?.presets.custom?.description).toBe("user preset");
      expect(synced?.presets["vv-deepseek"]?.description).toBe(
        "Starter DeepSeek role assignments for built-in vvoc roles.",
      );
      expect(synced?.presets["vv-deepseek"]?.agents.default).toBe("deepseek/deepseek-v4-flash");
      expect(synced?.presets["vv-deepseek"]?.agents.fast).toBe("deepseek/deepseek-v4-flash");
      expect(synced?.presets["vv-zai"]?.agents.default).toBe("zai-coding-plan/glm-5-turbo");
      expect(synced?.plugins["secrets-redaction"]).toBe(false);
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
      expect(created?.plugins).toEqual(createDefaultVvocConfig().plugins);
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
      expect(promptResults).toHaveLength(7);

      const openCode = ensureManagedAgentRegistrationsConfigText(undefined, paths);
      const parsed = parse(openCode) as { agent?: Record<string, { prompt?: string }> };
      expect(parsed.agent?.["vv-controller"]?.prompt).toBe(
        "{file:../.vvoc/agents/vv-controller.md}",
      );
      expect(parsed.agent?.enhancer?.prompt).toBe("{file:../.vvoc/agents/enhancer.md}");
      expect(parsed.agent?.["vv-implementer"]?.prompt).toBe(
        "{file:../.vvoc/agents/vv-implementer.md}",
      );
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
      expect(results).toHaveLength(9); // 6 SKILL.md + 3 reference files
      expect(results.every((r) => r.action === "created")).toBe(true);
      for (const r of results) {
        const isSkill = r.path.endsWith("SKILL.md");
        const isReference = r.path.endsWith(".xml");
        expect(isSkill || isReference).toBe(true);
      }
      expect(results.some((r) => r.path.endsWith(join("vv-reflect", "SKILL.md")))).toBe(true);
      expect(results.some((r) => r.path.endsWith(join("vv-handoff", "SKILL.md")))).toBe(true);
      expect(
        results.some((r) =>
          r.path.endsWith(join("vv-spec", "references", "design-context-template.xml")),
        ),
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
      expect(results).toHaveLength(7); // vv-spec skipped + 5 other SKILL.md + 1 plan ref (design-context not synced when vv-spec skipped)
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
      expect(results).toHaveLength(9); // 6 SKILL.md + 3 reference files
      expect(results.every((r) => r.action === "created")).toBe(true);
      expect(results.some((r) => r.path.endsWith(join("vv-reflect", "SKILL.md")))).toBe(true);
      expect(results.some((r) => r.path.endsWith(join("vv-handoff", "SKILL.md")))).toBe(true);
      expect(
        results.some((r) =>
          r.path.endsWith(join("vv-spec", "references", "design-context-template.xml")),
        ),
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
      expect(kept).toHaveLength(9); // 6 SKILL.md + 3 reference files
      expect(kept.some((r) => r.path.endsWith(join("vv-handoff", "SKILL.md")))).toBe(true);
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
      expect(results).toHaveLength(9); // 6 SKILL.md + 3 reference files
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
      provider?: Record<string, { options?: { baseURL?: string } }>;
    };

    expect(parsed.$schema).toBe(OPENCODE_SCHEMA_URL);
    expect(parsed.provider?.stepfun?.options?.baseURL).toBe("https://api.stepfun.ai/v1");
  });

  test("preserves comments while patching provider baseURL", () => {
    const input = `{
  // keep provider docs
  "provider": {
    "stepfun": {
      "options": {
        // keep timeout
        "timeout": 1000
      }
    }
  }
}\n`;
    const output = ensureProviderBaseUrlConfigText(input, "stepfun", "https://api.stepfun.ai/v1");
    const parsed = parse(output) as {
      provider?: Record<string, { options?: { baseURL?: string; timeout?: number } }>;
    };

    expect(output).toContain("// keep provider docs");
    expect(output).toContain("// keep timeout");
    expect(parsed.provider?.stepfun?.options?.timeout).toBe(1000);
    expect(parsed.provider?.stepfun?.options?.baseURL).toBe("https://api.stepfun.ai/v1");
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
        provider?: Record<string, { options?: { baseURL?: string } }>;
      };

      expect(first.action).toBe("created");
      expect(second.action).toBe("kept");
      expect(parsed.provider?.stepfun?.options?.baseURL).toBe("https://api.stepfun.ai/v1");
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
        "glm-4.5-airx": {
          "name: glm-4.5-airx": {
            limit: {
              context: 128000,
              output: 96000,
            },
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
            provider: {
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
        provider?: Record<string, { models?: Record<string, Record<string, unknown>> }>;
      };

      expect(first.action).toBe("updated");
      expect(second.action).toBe("kept");
      expect(parsed.provider?.["zai-coding-plan"]?.models?.Existing).toEqual({
        name: "Existing",
      });
      expect(parsed.provider?.["zai-coding-plan"]?.models?.["glm-4.5-airx"]).toEqual({
        "name: glm-4.5-airx": {
          limit: {
            context: 128000,
            output: 96000,
          },
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
    expect(paths.managedAgentsDirPath).toBe("/tmp/vvoc-config-home/vvoc/agents");
    expect(paths.opencodeConfigPath).toBe("/tmp/vvoc-config-home/opencode/opencode.json");
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
    expect(paths.managedAgentsDirPath).toBe("/workspace/project/.vvoc/agents");
    expect(paths.managedSkillsDirPath).toBe("/workspace/project/.vvoc/skills");
  });
});

describe("inspectInstallation", () => {
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
            plugin: [PACKAGE_NAME],
            model: "vv-role:missing",
            small_model: "vv-role:fast",
            agent: {
              general: {
                model: "vv-role:default",
              },
            },
            command: {
              plan: {
                model: "vv-role:another-missing",
              },
            },
          },
          null,
          2,
        ) + "\n",
        "utf8",
      );

      const inspection = await inspectInstallation(paths);

      expect(inspection.roles.assignments.map((entry) => entry.roleId)).toEqual([
        "default",
        "smart",
        "fast",
        "vision",
        "reviewer",
        "custom",
      ]);
      expect(inspection.roles.unresolvedReferences).toEqual([
        {
          fieldPath: "model",
          roleRef: "vv-role:missing",
          roleId: "missing",
        },
        {
          fieldPath: "command.plan.model",
          roleRef: "vv-role:another-missing",
          roleId: "another-missing",
        },
      ]);
      expect(inspection.problems).toContain(
        "unresolved role reference at model: vv-role:missing (missing role: missing)",
      );
      expect(inspection.problems).toContain(
        "unresolved role reference at command.plan.model: vv-role:another-missing (missing role: another-missing)",
      );
    } finally {
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
