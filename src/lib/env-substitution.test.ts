// FILE: src/lib/env-substitution.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify ${VAR} placeholder substitution and missing-reference reporting.
//   SCOPE: Literal passthrough, full and partial substitution, unset and empty variables, duplicate references, and the string-only wrapper.
//   DEPENDS: [bun:test, src/lib/env-substitution.ts]
//   LINKS: [M-ENV-SUBSTITUTION, V-M-ENV-SUBSTITUTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ENV - Stable environment fixture for substitution tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [direct fix - Covered shared env placeholder substitution used by web apiKey and secrets-redaction secret resolution.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { resolveEnvPlaceholders, substituteEnvVars } from "./env-substitution.js";

const ENV = { SET_VAR: "resolved-value", EMPTY_VAR: "" } as const;

describe("resolveEnvPlaceholders", () => {
  test("returns literal values unchanged with no missing references", () => {
    expect(resolveEnvPlaceholders("sk-literal-key", ENV)).toEqual({
      value: "sk-literal-key",
      missing: [],
    });
  });

  test("substitutes a full placeholder from the environment", () => {
    expect(resolveEnvPlaceholders("${SET_VAR}", ENV)).toEqual({
      value: "resolved-value",
      missing: [],
    });
  });

  test("substitutes inside mixed text and reports unset variables by name", () => {
    expect(resolveEnvPlaceholders("prefix-${SET_VAR}-${UNSET_VAR}", ENV)).toEqual({
      value: "prefix-resolved-value-",
      missing: ["UNSET_VAR"],
    });
  });

  test("treats empty-string variables as missing", () => {
    expect(resolveEnvPlaceholders("${EMPTY_VAR}", ENV)).toEqual({
      value: "",
      missing: ["EMPTY_VAR"],
    });
  });

  test("deduplicates repeated missing references in first-reference order", () => {
    expect(resolveEnvPlaceholders("${A}-${B}-${A}", {})).toEqual({
      value: "--",
      missing: ["A", "B"],
    });
  });

  test("substituteEnvVars returns only the substituted string", () => {
    expect(substituteEnvVars("${SET_VAR}-${UNSET_VAR}", ENV)).toBe("resolved-value-");
  });
});
