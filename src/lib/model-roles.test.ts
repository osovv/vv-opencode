// FILE: src/lib/model-roles.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify role ID/reference parsing, concrete model-selection parsing, built-in bindings, and role-resolution failures.
//   SCOPE: Deterministic built-in role exposure, vv-role round-trips, model selection normalization, and explicit error-code coverage.
//   DEPENDS: [bun:test, src/lib/model-roles.ts]
//   LINKS: [V-M-MODEL-ROLES]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   built-in role tests - Verify deterministic built-in role IDs and hard-coded role bindings.
//   role reference tests - Verify vv-role parsing, round-trip resolution, and unknown-role handling.
//   model selection tests - Verify provider/model[:variant] normalization and malformed input failures.
//   chaining guard tests - Verify role-to-role chaining is rejected in wave 1.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added module-local coverage for built-in role exposure, parsing normalization, field-specific errors, and non-transitive role resolution.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  BUILTIN_ROLE_NAMES,
  getBuiltInRoleBindings,
  isRoleReference,
  parseModelSelection,
  resolveRoleReference,
  type ModelRolesError,
  type ModelRolesErrorCode,
} from "./model-roles.js";

describe("built-in roles", () => {
  test("exposes built-in role ids deterministically", () => {
    expect(BUILTIN_ROLE_NAMES).toEqual(["default", "smart", "fast", "vision"]);

    const bindings = getBuiltInRoleBindings();
    expect(bindings.opencodeDefaults).toEqual({ model: "default", smallModel: "fast" });
    expect(bindings.managedAgents.guardian).toBe("fast");
    expect(bindings.managedAgents["memory-reviewer"]).toBe("fast");
  });
});

describe("role references", () => {
  test("parses and resolves vv-role references cleanly", () => {
    expect(isRoleReference("vv-role:default")).toBe(true);
    expect(isRoleReference("vv-role:my-custom-role")).toBe(true);
    expect(isRoleReference("openai/gpt-5")).toBe(false);

    const resolved = resolveRoleReference("vv-role:my-custom-role", {
      "my-custom-role": "openai/gpt-5:high",
    });

    expect(resolved).toEqual({
      roleId: "my-custom-role",
      roleRef: "vv-role:my-custom-role",
      provider: "openai",
      model: "gpt-5",
      variant: "high",
      normalized: "openai/gpt-5:high",
    });
  });

  test("fails unknown roles with explicit UNKNOWN_ROLE", () => {
    assertModelRolesError(
      () => resolveRoleReference("vv-role:missing", { default: "openai/gpt-5" }),
      "UNKNOWN_ROLE",
      "roleRef",
    );
  });

  test("fails malformed role ids and malformed references with explicit codes", () => {
    assertModelRolesError(
      () => resolveRoleReference("vv-role:Bad", { Bad: "openai/gpt-5" }),
      "INVALID_ROLE_ID",
      "roleId",
    );

    assertModelRolesError(
      () => resolveRoleReference("openai/gpt-5", { default: "openai/gpt-5" }),
      "INVALID_ROLE_REFERENCE",
      "roleRef",
    );
  });
});

describe("model selections", () => {
  test("normalizes provider/model[:variant] consistently", () => {
    expect(parseModelSelection("openai/gpt-5")).toEqual({
      provider: "openai",
      model: "gpt-5",
      normalized: "openai/gpt-5",
    });

    expect(parseModelSelection("  anthropic/claude-sonnet-4-5:high  ")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      variant: "high",
      normalized: "anthropic/claude-sonnet-4-5:high",
    });
  });

  test("fails malformed model selections with explicit INVALID_MODEL_SELECTION", () => {
    assertModelRolesError(
      () => parseModelSelection("openai"),
      "INVALID_MODEL_SELECTION",
      "modelSelection",
    );

    assertModelRolesError(
      () => resolveRoleReference("vv-role:default", { default: "openai/gpt-5:" }),
      "INVALID_MODEL_SELECTION",
      "modelSelection",
    );
  });
});

describe("role resolution chaining guard", () => {
  test("does not allow role-to-role chaining in wave 1", () => {
    assertModelRolesError(
      () =>
        resolveRoleReference("vv-role:default", {
          default: "vv-role:fast",
          fast: "openai/gpt-5-mini",
        }),
      "INVALID_MODEL_SELECTION",
      "modelSelection",
    );
  });
});

function assertModelRolesError(
  run: () => unknown,
  code: ModelRolesErrorCode,
  field: ModelRolesError["field"],
): void {
  try {
    run();
  } catch (error) {
    const modelRolesError = error as ModelRolesError;
    expect(modelRolesError.code).toBe(code);
    expect(modelRolesError.field).toBe(field);
    expect(modelRolesError.message).toContain(code);
    return;
  }

  throw new Error(`Expected ${code} to be thrown`);
}
