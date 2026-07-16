// FILE: scripts/tui-local.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify local pre-release TUI argument parsing, conservative config replacement, and isolated child environment construction.
//   SCOPE: Pure helper tests; no OpenCode process launch or user config mutation.
//   DEPENDS: [bun:test, scripts/tui-local.ts]
//   LINKS: [M-RELEASE-AUTOMATION, VF-RELEASE-AUTOMATION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   local TUI argument tests - Verify scope parsing and OpenCode argument forwarding.
//   local TUI config tests - Verify managed package replacement and unrelated JSONC preservation.
//   local TUI environment test - Verify XDG/TUI isolation while preserving runtime and vvoc sources.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Added deterministic coverage for the local pre-release TUI launcher.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  createLocalTuiEnvironment,
  parseLocalTuiArguments,
  renderLocalTuiConfig,
} from "./tui-local.ts";

describe("local TUI arguments", () => {
  test("defaults to effective scope and forwards OpenCode arguments", () => {
    expect(parseLocalTuiArguments(["-s", "session-1"])).toEqual({
      scope: "effective",
      passthroughArgs: ["-s", "session-1"],
    });
  });

  test("accepts explicit scope forms and a passthrough separator", () => {
    expect(parseLocalTuiArguments(["--scope", "project", "--", "run", "hello"])).toEqual({
      scope: "project",
      passthroughArgs: ["run", "hello"],
    });
    expect(parseLocalTuiArguments(["--scope=global", "--version"])).toEqual({
      scope: "global",
      passthroughArgs: ["--version"],
    });
  });

  test("rejects an unknown scope", () => {
    expect(() => parseLocalTuiArguments(["--scope", "workspace"])).toThrow(
      "expected effective, project, or global",
    );
  });
});

describe("local TUI config", () => {
  test("replaces the managed package with local dist while preserving tuple options and comments", () => {
    const output = renderLocalTuiConfig(
      `{
  // keep the selected theme
  "theme": "system",
  "plugin": [
    ["@osovv/vv-opencode@1.1.3", { "enabled": true }],
    "other-plugin"
  ]
}\n`,
      "file:///workspace/vv-opencode/dist/tui.js",
    );

    expect(output).toContain("// keep the selected theme");
    expect(output).toContain('"theme": "system"');
    expect(output).toContain('"file:///workspace/vv-opencode/dist/tui.js"');
    expect(output).toContain('"enabled": true');
    expect(output).toContain('"other-plugin"');
    expect(output).not.toContain("@osovv/vv-opencode@1.1.3");
  });
});

describe("local TUI environment", () => {
  test("isolates native TUI discovery while preserving selected runtime and vvoc paths", () => {
    const env = createLocalTuiEnvironment({
      baseEnv: { HOME: "/home/test", XDG_CONFIG_HOME: "/home/test/.config" },
      launchEnv: {
        OPENCODE_CONFIG: "/home/test/.config/opencode/opencode.json",
        OPENCODE_TUI_CONFIG: "/home/test/.config/opencode/tui.json",
        VVOC_CONFIG: "/home/test/.config/vvoc/vvoc.json",
      },
      isolatedConfigHome: "/tmp/vvoc-local-tui",
      tuiConfigPath: "/tmp/vvoc-local-tui/opencode/tui.json",
    });

    expect(env.HOME).toBe("/home/test");
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/vvoc-local-tui");
    expect(env.OPENCODE_CONFIG).toBe("/home/test/.config/opencode/opencode.json");
    expect(env.VVOC_CONFIG).toBe("/home/test/.config/vvoc/vvoc.json");
    expect(env.OPENCODE_TUI_CONFIG).toBe("/tmp/vvoc-local-tui/opencode/tui.json");
  });
});
