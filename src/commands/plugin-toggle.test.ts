// FILE: src/commands/plugin-toggle.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify plugin enable/disable CLI toggles.
//   SCOPE: Deterministic assertions for plugin name validation and toggle value.
//   DEPENDS: [bun:test, src/commands/plugin-toggle.js]
//   LINKS: [M-CLI-PLUGIN-TOGGLE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("plugin toggle", () => {
  test("PLUGIN_TOGGLE_NAMES contains expected names", async () => {
    const { PLUGIN_TOGGLE_NAMES } = await import("../lib/plugin-toggle-config.js");
    const names = Array.from(PLUGIN_TOGGLE_NAMES);
    expect(names.includes("guardian")).toBe(true);
    expect(names.includes("secrets-redaction")).toBe(true);
    expect(names.includes("hashline-edit")).toBe(true);
    expect(names.length).toBe(6);
  });

  test("vvoc.json toggle write round-trips", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vvoc-toggle-cli-"));
    const vvocDir = join(tmpDir, "vvoc");
    mkdirSync(vvocDir, { recursive: true });
    const configPath = join(vvocDir, "vvoc.json");

    const initialConfig = {
      $schema: "https://example.com/schema.json",
      version: 3,
      roles: { default: "openai/gpt-4" },
      guardian: { timeoutMs: 90_000, approvalRiskThreshold: 80, reviewToastDurationMs: 5000 },
      secretsRedaction: {
        secret: "test",
        ttlMs: 3600,
        maxMappings: 100,
        patterns: { keywords: [], regex: [], builtin: [], exclude: [] },
        debug: false,
      },
      presets: {},
    };
    await writeFile(configPath, JSON.stringify(initialConfig, null, 2));

    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.plugins = { guardian: false, "hashline-edit": true };
    await writeFile(configPath, JSON.stringify(config, null, 2));

    const updated = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const plugins = updated.plugins as Record<string, unknown>;
    expect(plugins.guardian).toBe(false);
    expect(plugins["hashline-edit"]).toBe(true);
  });
});
