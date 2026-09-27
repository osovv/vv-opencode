// FILE: src/lib/model-roles.test.ts
// VERSION: 0.2.1
// START_MODULE_CONTRACT
//   PURPOSE: Verify role ID/reference parsing, concrete model-selection parsing (including canonical variant), built-in bindings, and role-resolution failures.
//   SCOPE: Deterministic built-in role exposure, vv-role round-trips, model selection normalization, variant parsing, and explicit error-code coverage.
//   DEPENDS: [bun:test, src/lib/model-roles.ts]
//   LINKS: [M-MODEL-ROLES, V-M-MODEL-ROLES]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   assertModelRolesError - Asserts stable model-role error codes and messages.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-002 - Added canonical provider/model#variant parsing coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  BUILTIN_ROLE_NAMES,
  getBuiltInRoleBindings,
  isRoleReference,
  parseModelSelection,
  parseModelSelectionWithVariant,
  resolveRoleReference,
  type ModelRolesError,
  type ModelRolesErrorCode,
} from "./model-roles.js";

describe("built-in roles", () => {
  test("exposes built-in role ids deterministically", () => {
    expect(BUILTIN_ROLE_NAMES).toEqual(["default", "smart", "fast", "reviewer"]);

    const bindings = getBuiltInRoleBindings();
    expect(bindings).toEqual({
      opencodeDefaults: { model: "default", smallModel: "fast" },
      opencodeAgents: {
        build: "default",
        plan: "smart",
        general: "default",
        explore: "fast",
      },
      managedAgents: {
        guardian: "fast",
        "vv-controller": "smart",
        enhancer: "smart",
        "vv-implementer": "default",
        "vv-spec-reviewer": "reviewer",
        "vv-code-reviewer": "reviewer",
        investigator: "smart",
      },
    });
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
      model: "gpt-5:high",
      normalized: "openai/gpt-5:high",
    });
  });

  test("normalizes surrounding whitespace consistently for checker and resolver", () => {
    expect(isRoleReference("  vv-role:default  ")).toBe(true);

    const resolved = resolveRoleReference("  vv-role:default  ", {
      default: "openai/gpt-5",
    });

    expect(resolved.roleId).toBe("default");
    expect(resolved.roleRef).toBe("vv-role:default");
    expect(resolved.normalized).toBe("openai/gpt-5");
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

  test("fails blank configured role bindings as invalid model selections", () => {
    assertModelRolesError(
      () => resolveRoleReference("vv-role:default", { default: "   " }),
      "INVALID_MODEL_SELECTION",
      "modelSelection",
    );
  });
});

describe("model selections", () => {
  test("normalizes provider/model consistently", () => {
    expect(parseModelSelection("openai/gpt-5")).toEqual({
      provider: "openai",
      model: "gpt-5",
      normalized: "openai/gpt-5",
    });

    expect(parseModelSelection("  openrouter/tencent/hy3-preview:free  ")).toEqual({
      provider: "openrouter",
      model: "tencent/hy3-preview:free",
      normalized: "openrouter/tencent/hy3-preview:free",
    });

    expect(parseModelSelection("openrouter/moonshotai/kimi-k2.6")).toEqual({
      provider: "openrouter",
      model: "moonshotai/kimi-k2.6",
      normalized: "openrouter/moonshotai/kimi-k2.6",
    });
  });

  test("fails malformed model selections with explicit INVALID_MODEL_SELECTION", () => {
    assertModelRolesError(
      () => parseModelSelection("openai"),
      "INVALID_MODEL_SELECTION",
      "modelSelection",
    );
  });

  test("parses canonical provider/model#variant while preserving provider/model semantics", () => {
    expect(parseModelSelectionWithVariant("xiaomi/vv-mimo-v2.6-flash-high")).toEqual({
      provider: "xiaomi",
      model: "vv-mimo-v2.6-flash-high",
      normalized: "xiaomi/vv-mimo-v2.6-flash-high",
    });
    expect(parseModelSelectionWithVariant("xiaomi/mimo-v2.6-flash#thinking")).toEqual({
      provider: "xiaomi",
      model: "mimo-v2.6-flash",
      normalized: "xiaomi/mimo-v2.6-flash",
      variant: "thinking",
    });
    assertModelRolesError(
      () => parseModelSelectionWithVariant("prov/model#"),
      "INVALID_MODEL_SELECTION",
      "modelSelection",
    );
    assertModelRolesError(
      () => parseModelSelectionWithVariant("prov/model#a#b"),
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
