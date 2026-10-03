// FILE: src/lib/opencode/config-migration.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the V1-to-V2 OpenCode config migration module against guide-aligned mappings, nested all-or-nothing conversion, report-only and unmappable detection, backup-on-change, idempotency, and no-write abort behavior.
//   SCOPE: classification, pure plan transformations, and file-level migrateOpenCodeConfig orchestration over isolated temp directories.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/opencode/config-migration.ts, src/lib/opencode/shared-utils.ts, src/lib/opencode/paths.ts]
//   LINKS: [M-CLI-CONFIG, V-M-CLI-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   VVOC_V1_CONFIG - vvoc 1.7.0 OpenCode config fixture used across the migration tests.
//   pathsFor - Builds a minimal ResolvedPaths for file-level migration tests.
//   makeConfigDir - Creates an isolated temp config directory containing opencode.json.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-V1-OPENCODE-CONFIG-MIGRATION T-001 - Added migration module coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyOpenCodeConfig,
  migrateOpenCodeConfig,
  planOpenCodeConfigMigration,
} from "./config-migration.js";
import { OPENCODE_SCHEMA_URL } from "./shared-utils.js";
import type { ResolvedPaths } from "./paths.js";

const VVOC_V1_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  model: "vv-role:smart",
  small_model: "vv-role:fast",
  default_agent: "vv-controller",
  tools: { apply_patch: false },
  agent: {
    explore: { model: "vv-role:fast" },
    "vv-controller": { model: "vv-role:smart" },
  },
  skills: { paths: ["./.vvoc/skills"] },
  command: {},
  plugin: ["@osovv/vv-opencode@1.7.0"],
};

function pathsFor(opencodeConfigPath: string): ResolvedPaths {
  return { opencodeConfigPath } as unknown as ResolvedPaths;
}

async function makeConfigDir(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vvoc-migrate-"));
  await writeFile(join(dir, "opencode.json"), contents, "utf8");
  return dir;
}

describe("classifyOpenCodeConfig", () => {
  test("flags a vvoc 1.7.0 document as V1-shaped", () => {
    const result = classifyOpenCodeConfig(VVOC_V1_CONFIG);
    expect(result.shape).toBe("v1");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  test("treats a native document as native-clean", () => {
    const result = classifyOpenCodeConfig({
      $schema: OPENCODE_SCHEMA_URL,
      default_agent: "vv-controller",
      skills: ["./.vvoc/skills"],
      plugins: ["@osovv/vv-opencode@2.1.2"],
      permissions: [{ action: "edit", resource: "*", effect: "allow" }],
    });
    expect(result.shape).toBe("native-clean");
  });
});

describe("planOpenCodeConfigMigration", () => {
  test("materializes the vvoc 1.7.0 managed document into the native shape", () => {
    const plan = planOpenCodeConfigMigration(VVOC_V1_CONFIG);
    expect(plan.unmappable).toEqual([]);
    expect(plan.reportOnly).toEqual([]);
    expect(plan.document.$schema).toBe(OPENCODE_SCHEMA_URL);
    expect(plan.document.plugins).toEqual(["@osovv/vv-opencode@1.7.0"]);
    expect(plan.document.skills).toEqual(["./.vvoc/skills"]);
    expect(plan.document.commands).toEqual({});
    expect(plan.document.permissions).toEqual([
      { action: "apply_patch", resource: "*", effect: "deny" },
    ]);
    expect(plan.document.default_agent).toBe("vv-controller");
    expect("model" in plan.document).toBe(false);
    expect("small_model" in plan.document).toBe(false);
    expect("tools" in plan.document).toBe(false);
    expect("agent" in plan.document).toBe(false);
    expect("plugin" in plan.document).toBe(false);
    expect(plan.document.agents).toEqual({ explore: {}, "vv-controller": {} });
  });

  test("converts a V1 plugin tuple into a package-and-options object", () => {
    const plan = planOpenCodeConfigMigration({
      plugin: [["@osovv/vv-opencode", { enabled: true }]],
    });
    expect(plan.document.plugins).toEqual([
      { package: "@osovv/vv-opencode", options: { enabled: true } },
    ]);
  });

  test("converts agent fields including variant joining and request-body moves", () => {
    const plan = planOpenCodeConfigMigration({
      agent: {
        reviewer: {
          prompt: "Review for correctness.",
          disable: false,
          maxSteps: 5,
          temperature: 0.2,
          model: "anthropic/claude-sonnet-4-5",
          variant: "high",
        },
      },
    });
    expect(plan.document.agents).toEqual({
      reviewer: {
        system: "Review for correctness.",
        disabled: false,
        steps: 5,
        request: { body: { temperature: 0.2 } },
        model: "anthropic/claude-sonnet-4-5#high",
      },
    });
  });

  test("converts command fields including subtask and variant joining", () => {
    const plan = planOpenCodeConfigMigration({
      command: {
        review: {
          template: "Review the changes.",
          subtask: true,
          model: "anthropic/claude-sonnet-4-5",
          variant: "high",
        },
      },
    });
    expect(plan.document.commands).toEqual({
      review: {
        template: "Review the changes.",
        subagent: true,
        model: "anthropic/claude-sonnet-4-5#high",
      },
    });
  });

  test("converts provider shape, canonical IDs, and provider models", () => {
    const plan = planOpenCodeConfigMigration({
      provider: {
        "azure-cognitive-services": {
          npm: "@ai-sdk/openai-compatible",
          api: "https://llm.example.com/v1",
          options: { apiKey: "secret" },
          models: {
            gpt: {
              id: "gpt",
              tool_call: true,
              cache_read: 1,
              cache_write: 2,
              status: "deprecated",
              variants: { high: { reasoningEffort: "high" } },
            },
          },
        },
      },
    });
    expect(plan.document.providers).toEqual({
      azure: {
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { apiKey: "secret", baseURL: "https://llm.example.com/v1" },
        models: {
          gpt: {
            modelID: "gpt",
            capabilities: { tools: true },
            cache: { read: 1, write: 2 },
            disabled: true,
            variants: [{ id: "high", settings: { reasoningEffort: "high" } }],
          },
        },
      },
    });
  });

  test("converts mcp into servers with disabled inversion, split timeouts, and snake_case OAuth", () => {
    const plan = planOpenCodeConfigMigration({
      mcp: {
        playwright: {
          type: "local",
          command: ["npx", "@playwright/mcp"],
          enabled: true,
          timeout: 30000,
          clientId: "abc",
        },
      },
    });
    expect(plan.document.mcp).toEqual({
      servers: {
        playwright: {
          type: "local",
          command: ["npx", "@playwright/mcp"],
          disabled: false,
          timeout: { catalog: 30000, execution: 30000 },
          client_id: "abc",
        },
      },
    });
  });

  test("converts compaction keep and buffer and simple renames", () => {
    const plan = planOpenCodeConfigMigration({
      compaction: { preserve_recent_tokens: 8000, reserved: 20000, auto: true },
      autoshare: true,
      autoupdate: false,
      snapshot: false,
      reference: { docs: "../docs" },
    });
    expect(plan.document.compaction).toEqual({ keep: { tokens: 8000 }, buffer: 20000, auto: true });
    expect(plan.document.share).toBe("auto");
    expect(plan.document.update).toBe("disable");
    expect(plan.document.snapshots).toBe(false);
    expect(plan.document.references).toEqual({ docs: "../docs" });
  });

  test("reports report-only fields without converting them", () => {
    const plan = planOpenCodeConfigMigration({ enabled_providers: ["anthropic"] });
    expect(plan.reportOnly).toContain('"enabled_providers"');
    expect("enabled_providers" in plan.document).toBe(false);
  });

  test("marks an unmappable permission effect without writing", () => {
    const plan = planOpenCodeConfigMigration({ permission: { edit: 42 } });
    expect(plan.unmappable.length).toBeGreaterThan(0);
  });
});

describe("migrateOpenCodeConfig", () => {
  test("writes the native document with a timestamped backup", async () => {
    const dir = await makeConfigDir(`${JSON.stringify(VVOC_V1_CONFIG, null, 2)}\n`);
    const configPath = join(dir, "opencode.json");

    const result = await migrateOpenCodeConfig(pathsFor(configPath));

    expect(result.action).toBe("migrated");
    expect(result.backupPath).toBeDefined();
    const migrated = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(migrated.plugins).toEqual(["@osovv/vv-opencode@1.7.0"]);
    expect(migrated.skills).toEqual(["./.vvoc/skills"]);
    expect("plugin" in migrated).toBe(false);
    expect(classifyOpenCodeConfig(migrated).shape).toBe("native-clean");
    const entries = await readdir(dir);
    expect(entries.some((name) => name.includes(".vvoc-backup-"))).toBe(true);
  });

  test("is idempotent and writes no second backup", async () => {
    const dir = await makeConfigDir(`${JSON.stringify(VVOC_V1_CONFIG, null, 2)}\n`);
    const configPath = join(dir, "opencode.json");

    expect((await migrateOpenCodeConfig(pathsFor(configPath))).action).toBe("migrated");
    const afterFirst = await readdir(dir);
    const backupsAfterFirst = afterFirst.filter((name) => name.includes(".vvoc-backup-")).length;

    const second = await migrateOpenCodeConfig(pathsFor(configPath));
    expect(second.action).toBe("kept");
    const afterSecond = await readdir(dir);
    expect(afterSecond.filter((name) => name.includes(".vvoc-backup-")).length).toBe(
      backupsAfterFirst,
    );
  });

  test("aborts without writing when a report-only field is present", async () => {
    const original = `${JSON.stringify({ enabled_providers: ["anthropic"] }, null, 2)}\n`;
    const dir = await makeConfigDir(original);
    const configPath = join(dir, "opencode.json");

    const result = await migrateOpenCodeConfig(pathsFor(configPath));

    expect(result.action).toBe("aborted");
    expect(result.reportOnly.length).toBeGreaterThan(0);
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect((await readdir(dir)).some((name) => name.includes(".vvoc-backup-"))).toBe(false);
  });

  test("preserves comments on unchanged keys", async () => {
    const original = [
      "{",
      "  // keep this agent comment",
      '  "default_agent": "vv-controller",',
      '  "plugin": ["@osovv/vv-opencode@1.7.0"]',
      "}",
      "",
    ].join("\n");
    const dir = await makeConfigDir(original);
    const configPath = join(dir, "opencode.json");

    expect((await migrateOpenCodeConfig(pathsFor(configPath))).action).toBe("migrated");
    const migrated = await readFile(configPath, "utf8");
    expect(migrated).toContain("// keep this agent comment");
    expect(migrated).toContain('"plugins"');
  });

  test("reports a legacy tui.json without deleting it", async () => {
    const dir = await makeConfigDir(`${JSON.stringify(VVOC_V1_CONFIG, null, 2)}\n`);
    await writeFile(join(dir, "tui.json"), "{}\n", "utf8");
    const configPath = join(dir, "opencode.json");

    const result = await migrateOpenCodeConfig(pathsFor(configPath));

    expect(result.legacyTuiPaths.length).toBe(1);
    expect(existsSync(join(dir, "tui.json"))).toBe(true);
  });
});
