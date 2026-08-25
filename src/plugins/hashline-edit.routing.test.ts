// FILE: src/plugins/hashline-edit.routing.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify edit-mode routing config parsing and provider-then-model resolution.
//   SCOPE: Default table shape, strict parsing failures, plugin entry union resolution, rule precedence, provider-before-model matching, case-insensitivity, and unknown-model default.
//   DEPENDS: [bun:test, src/plugins/hashline-edit/routing.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   [test scenarios] - Routing coverage is expressed through module-level tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Initial routing coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ROUTING_CONFIG,
  parseHashlineEditPluginEntry,
  parseRoutingConfig,
  resolveEditMode,
} from "./hashline-edit/routing.js";

describe("hashline routing config", () => {
  test("default table routes deepseek, kimi, qwen, glm, gpt, codex and defaults to hashline", () => {
    expect(DEFAULT_ROUTING_CONFIG.default).toBe("hashline");
    expect(
      resolveEditMode(DEFAULT_ROUTING_CONFIG, {
        providerID: "deepseek",
        modelID: "deepseek-v4-flash",
      }),
    ).toBe("str_replace_editor");
    expect(
      resolveEditMode(DEFAULT_ROUTING_CONFIG, { providerID: "kimi-for-coding", modelID: "k3" }),
    ).toBe("replace");
    expect(
      resolveEditMode(DEFAULT_ROUTING_CONFIG, {
        providerID: "alibaba-token-plan",
        modelID: "qwen3.8-max",
      }),
    ).toBe("replace");
    expect(
      resolveEditMode(DEFAULT_ROUTING_CONFIG, { providerID: "openai", modelID: "gpt-5.4" }),
    ).toBe("passthrough");
    expect(
      resolveEditMode(DEFAULT_ROUTING_CONFIG, { providerID: "openai", modelID: "gpt-5.3-codex" }),
    ).toBe("passthrough");
    expect(
      resolveEditMode(DEFAULT_ROUTING_CONFIG, {
        providerID: "zai-coding-plan",
        modelID: "glm-5.1",
      }),
    ).toBe("replace");
    expect(
      resolveEditMode(DEFAULT_ROUTING_CONFIG, {
        providerID: "minimax-coding-plan",
        modelID: "MiniMax-M2.7",
      }),
    ).toBe("hashline");
  });

  test("parseRoutingConfig returns defaults for undefined and null", () => {
    expect(parseRoutingConfig(undefined)).toEqual(DEFAULT_ROUTING_CONFIG);
    expect(parseRoutingConfig(null)).toEqual(DEFAULT_ROUTING_CONFIG);
  });

  test("parseRoutingConfig parses default and ordered rules", () => {
    const parsed = parseRoutingConfig({
      default: "replace",
      rules: { glm: "replace", minimax: "hashline" },
    });
    expect(parsed.default).toBe("replace");
    expect(parsed.rules).toEqual([
      { pattern: "glm", mode: "replace" },
      { pattern: "minimax", mode: "hashline" },
    ]);
  });

  test("parseRoutingConfig rejects invalid modes, non-object rules, empty patterns, and non-object config", () => {
    expect(() => parseRoutingConfig({ default: "patch" })).toThrow(/must be one of/);
    expect(() => parseRoutingConfig({ rules: ["deepseek"] })).toThrow(/rules must be an object/);
    expect(() => parseRoutingConfig({ rules: { "": "replace" } })).toThrow(/non-empty/);
    expect(() => parseRoutingConfig({ rules: { deepseek: "patch" } })).toThrow(/must be one of/);
    expect(() => parseRoutingConfig("hashline")).toThrow(/must be an object/);
  });

  test("parseHashlineEditPluginEntry resolves the boolean-or-object union", () => {
    expect(parseHashlineEditPluginEntry(undefined)).toEqual({
      enabled: true,
      routing: DEFAULT_ROUTING_CONFIG,
    });
    expect(parseHashlineEditPluginEntry(true)).toEqual({
      enabled: true,
      routing: DEFAULT_ROUTING_CONFIG,
    });
    expect(parseHashlineEditPluginEntry(false)).toEqual({
      enabled: false,
      routing: DEFAULT_ROUTING_CONFIG,
    });

    const custom = parseHashlineEditPluginEntry({
      enabled: true,
      routing: { default: "hashline", rules: { qwen: "hashline" } },
    });
    expect(custom.enabled).toBe(true);
    expect(custom.routing.rules).toEqual([{ pattern: "qwen", mode: "hashline" }]);

    expect(parseHashlineEditPluginEntry({}).enabled).toBe(true);
    expect(() => parseHashlineEditPluginEntry("yes")).toThrow(/boolean or an object/);
    expect(() => parseHashlineEditPluginEntry({ enabled: "yes" })).toThrow(
      /enabled must be a boolean/,
    );
    expect(() => parseHashlineEditPluginEntry({ routing: { default: "nope" } })).toThrow(
      /must be one of/,
    );
  });
});

describe("hashline routing resolution", () => {
  test("matches providerID before modelID across rule order", () => {
    const config = parseRoutingConfig({
      rules: { specialmodel: "replace", zai: "str_replace_editor" },
    });
    // Provider-level rule wins even though the model-level pattern is listed first.
    expect(resolveEditMode(config, { providerID: "zai", modelID: "specialmodel-x" })).toBe(
      "str_replace_editor",
    );
    expect(resolveEditMode(config, { providerID: "other", modelID: "specialmodel-x" })).toBe(
      "replace",
    );
  });

  test("first matching rule wins within a pass", () => {
    const config = parseRoutingConfig({
      rules: { deepseek: "str_replace_editor", "deepseek-v4-flash": "replace" },
    });
    expect(resolveEditMode(config, { providerID: "deepseek", modelID: "deepseek-v4-flash" })).toBe(
      "str_replace_editor",
    );
  });

  test("matching is case-insensitive", () => {
    expect(
      resolveEditMode(DEFAULT_ROUTING_CONFIG, {
        providerID: "DeepSeek",
        modelID: "DEEPSEEK-V4-FLASH",
      }),
    ).toBe("str_replace_editor");
    expect(
      resolveEditMode(DEFAULT_ROUTING_CONFIG, { providerID: "MOONSHOTAI", modelID: "Kimi-K3" }),
    ).toBe("replace");
  });

  test("unknown or missing models fall back to the default mode", () => {
    expect(resolveEditMode(DEFAULT_ROUTING_CONFIG, undefined)).toBe("hashline");
    expect(resolveEditMode(DEFAULT_ROUTING_CONFIG, {})).toBe("hashline");
    expect(
      resolveEditMode(DEFAULT_ROUTING_CONFIG, {
        providerID: "anthropic",
        modelID: "claude-opus-4-5",
      }),
    ).toBe("hashline");
    const config = parseRoutingConfig({ default: "replace" });
    expect(resolveEditMode(config, { providerID: "anthropic", modelID: "claude-opus-4-5" })).toBe(
      "replace",
    );
  });
});
