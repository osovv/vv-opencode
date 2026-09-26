// FILE: scripts/e2e-v2.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the pure sandbox config shapes used by the v2 end-to-end harness.
//   SCOPE: Unit tests for buildSandboxConfigs only, without network, binaries, or filesystem sandboxes.
//   DEPENDS: [scripts/e2e-v2.ts]
//   LINKS: [V-M-E2E-V2-HARNESS, M-E2E-V2-HARNESS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   shapes - Shortcut binding for the harness config builder under test.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-009 - Added unit coverage for the harness config shapes.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { buildSandboxConfigs } from "./e2e-v2.ts";

const shapes = buildSandboxConfigs;

describe("buildSandboxConfigs", () => {
  test("carries the smart role into the probe agent reference", () => {
    const config = shapes("opencode/gpt-6-sol", "file:///tmp/pkg");
    expect(config.vvocRoles.smart).toBe("opencode/gpt-6-sol");
    expect(config.opencode.agent["vv-role-probe"]?.model).toBe("vv-role:smart");
    expect(config.opencode.plugins).toEqual(["file:///tmp/pkg"]);
  });

  test("keeps at least four canonical roles for strict schema validity", () => {
    const config = shapes("opencode/gpt-6-luna", "file:///tmp/pkg");
    expect(Object.keys(config.vvocRoles).length).toBeGreaterThanOrEqual(4);
    expect(config.vvocRoles.reviewer).toBe("opencode/gpt-6-luna");
  });
});
