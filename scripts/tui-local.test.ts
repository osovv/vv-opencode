// FILE: scripts/tui-local.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify local native TUI argument parsing, conservative cli.json plugin merging, and isolated child environment construction.
//   SCOPE: Pure helper tests; no OpenCode process launch or user config mutation.
//   DEPENDS: [bun:test, scripts/tui-local.ts]
//   LINKS: [M-RELEASE-AUTOMATION, VF-RELEASE-AUTOMATION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   [test scenarios] - Local native TUI launcher coverage is expressed through module-level tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 - Rewrote launcher coverage for native cli.json plugin merging.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  createLocalTuiEnvironment,
  parseLocalTuiArguments,
  renderLocalCliConfig,
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

describe("local cli.json", () => {
  test("appends the local plugin directory, drops the managed entry, and preserves unrelated settings", () => {
    const output = renderLocalCliConfig(
      `{
  // keep the selected theme
  "theme": { "name": "system" },
  "plugins": [
    "@osovv/vv-opencode@1.7.0",
    { "package": "other-plugin", "options": { "flag": true } }
  ]
}\n`,
      "file:///tmp/vvoc-local-tui/plugin",
    );

    expect(output).toContain("// keep the selected theme");
    expect(output).toContain('"name": "system"');
    expect(output).toContain('"other-plugin"');
    expect(output).toContain('"flag": true');
    expect(output).toContain('"file:///tmp/vvoc-local-tui/plugin"');
    expect(output).not.toContain("@osovv/vv-opencode@1.7.0");
  });

  test("creates a valid plugins list when no config exists", () => {
    const output = renderLocalCliConfig(undefined, "file:///tmp/plugin");
    expect(JSON.parse(output)).toEqual({ plugins: ["file:///tmp/plugin"] });
  });
});

describe("local TUI environment", () => {
  test("isolates the native config home while preserving selected runtime and vvoc paths", () => {
    const env = createLocalTuiEnvironment({
      baseEnv: { HOME: "/home/test", XDG_CONFIG_HOME: "/home/test/.config" },
      launchEnv: {
        OPENCODE_CONFIG: "/home/test/.config/opencode/opencode.json",
        VVOC_CONFIG: "/home/test/.config/vvoc/vvoc.json",
      },
      isolatedConfigHome: "/tmp/vvoc-local-tui",
    });

    expect(env.HOME).toBe("/home/test");
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/vvoc-local-tui");
    expect(env.OPENCODE_CONFIG).toBe("/home/test/.config/opencode/opencode.json");
    expect(env.VVOC_CONFIG).toBe("/home/test/.config/vvoc/vvoc.json");
    expect(env.OPENCODE_TUI_CONFIG).toBeUndefined();
  });
});
