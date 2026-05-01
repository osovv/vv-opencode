// FILE: src/commands/plugin-list.test.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-PLUGIN-LIST - OpenCode plugin listing.
//   SCOPE: Plugin specifier parsing, table rendering, and empty state handling.
//   DEPENDS: [src/commands/plugin-list.ts]
//   LINKS: [M-CLI-PLUGIN-LIST]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Test suite for plugin list command.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.0.0 - Initial GRACE compliance: added missing CHANGE_SUMMARY.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { parsePluginSpecifier, renderPluginTable, type PluginEntry } from "./plugin-list.js";

test("parsePluginSpecifier - npm package plugin", () => {
  const result = parsePluginSpecifier("@osovv/vv-opencode");
  expect(result.name).toBe("@osovv/vv-opencode");
  expect(result.source).toBe("@osovv/vv-opencode");
  expect(result.enabled).toBe(true);
});

test("parsePluginSpecifier - file-based plugin", () => {
  const result = parsePluginSpecifier("/path/to/local/plugin");
  expect(result.name).toBe("plugin");
  expect(result.source).toBe("/path/to/local/plugin");
  expect(result.enabled).toBe(true);
});

test("parsePluginSpecifier - scoped npm package", () => {
  const result = parsePluginSpecifier("@anthropic/anthropic-sdk");
  expect(result.name).toBe("@anthropic/anthropic-sdk");
  expect(result.source).toBe("@anthropic/anthropic-sdk");
  expect(result.enabled).toBe(true);
});

test("parsePluginSpecifier - disabled plugin with hash prefix", () => {
  const result = parsePluginSpecifier("#@osovv/vv-opencode");
  expect(result.name).toBe("@osovv/vv-opencode");
  expect(result.source).toBe("@osovv/vv-opencode");
  expect(result.enabled).toBe(false);
});

test("parsePluginSpecifier - disabled file-based plugin", () => {
  const result = parsePluginSpecifier("#./my-plugin");
  expect(result.name).toBe("my-plugin");
  expect(result.source).toBe("./my-plugin");
  expect(result.enabled).toBe(false);
});

test("parsePluginSpecifier - github shorthand", () => {
  const result = parsePluginSpecifier("github:owner/repo");
  expect(result.name).toBe("repo");
  expect(result.source).toBe("github:owner/repo");
  expect(result.enabled).toBe(true);
});

test("parsePluginSpecifier - npm package with version", () => {
  const result = parsePluginSpecifier("@osovv/vv-opencode@0.4.0");
  expect(result.name).toBe("@osovv/vv-opencode");
  expect(result.source).toBe("@osovv/vv-opencode@0.4.0");
  expect(result.enabled).toBe(true);
});

describe("renderPluginTable", () => {
  test("renders empty state", () => {
    const output = captureStdout(() => renderPluginTable([]));
    expect(output).toContain("No plugins configured.");
  });

  test("renders single plugin", () => {
    const plugins: PluginEntry[] = [
      { name: "@osovv/vv-opencode", source: "@osovv/vv-opencode", enabled: true },
    ];
    const output = captureStdout(() => renderPluginTable(plugins));
    expect(output).toContain("@osovv/vv-opencode");
    expect(output).toContain("enabled");
  });

  test("renders disabled plugin", () => {
    const plugins: PluginEntry[] = [
      { name: "@osovv/vv-opencode", source: "@osovv/vv-opencode", enabled: false },
    ];
    const output = captureStdout(() => renderPluginTable(plugins));
    expect(output).toContain("disabled");
  });

  test("renders multiple plugins with columns aligned", () => {
    const plugins: PluginEntry[] = [
      { name: "@osovv/vv-opencode", source: "@osovv/vv-opencode", enabled: true },
      { name: "my-plugin", source: "./my-plugin", enabled: true },
      { name: "@org/pkg", source: "@org/pkg", enabled: false },
    ];
    const output = captureStdout(() => renderPluginTable(plugins));
    expect(output).toContain("@osovv/vv-opencode");
    expect(output).toContain("./my-plugin");
    expect(output).toContain("@org/pkg");
    expect(output).toContain("enabled");
    expect(output).toContain("disabled");
  });
});

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map((a) => String(a)).join(" ") + "\n");
  };
  try {
    fn();
  } finally {
    console.log = originalConsoleLog;
  }
  return chunks.join("");
}
