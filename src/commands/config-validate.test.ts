// FILE: src/commands/config-validate.test.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-CONFIG-VALIDATE - guardian.jsonc and memory.jsonc validation.
//   SCOPE: JSONC parse error reporting, schema field validation, and pass/fail terminal output.
//   DEPENDS: [src/commands/config-validate.ts]
//   LINKS: [M-CLI-CONFIG-VALIDATE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Test suite for config validation - guardian.jsonc and memory.jsonc schema validation.
// END_MODULE_MAP

import { expect, test } from "bun:test";
import { validateGuardianConfigContent, validateMemoryConfigContent } from "./config-validate.js";

const FP = "/test/guardian.jsonc";
const MP = "/test/memory.jsonc";

test("validateGuardianConfigContent - valid guardian config passes", () => {
  const result = validateGuardianConfigContent(
    `{
  "timeoutMs": 90000,
  "approvalRiskThreshold": 80
}`,
    FP,
  );
  expect(result.valid).toBe(true);
  expect(result.errors).toHaveLength(0);
});

test("validateGuardianConfigContent - missing required field fails", () => {
  const result = validateGuardianConfigContent(
    `{
  "model": "anthropic/claude-sonnet-4"
}`,
    FP,
  );
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes('missing required field "timeoutMs"'))).toBe(true);
});

test("validateGuardianConfigContent - wrong field type fails", () => {
  const result = validateGuardianConfigContent(
    `{
  "timeoutMs": "not-a-number",
  "approvalRiskThreshold": 80
}`,
    FP,
  );
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes('has type "string" but expected "number"'))).toBe(
    true,
  );
});

test("validateGuardianConfigContent - invalid JSONC reports parse error with line/col", () => {
  const result = validateGuardianConfigContent(
    `{ "timeoutMs": 90000, "approvalRiskThreshold": }`,
    FP,
  );
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes("invalid JSONC"))).toBe(true);
  expect(result.errors.some((e) => e.includes(":"))).toBe(true);
});

test("validateGuardianConfigContent - approvalRiskThreshold out of range fails", () => {
  const result = validateGuardianConfigContent(
    `{
  "timeoutMs": 90000,
  "approvalRiskThreshold": 150
}`,
    FP,
  );
  expect(result.valid).toBe(false);
  expect(
    result.errors.some(
      (e) => e.includes("approvalRiskThreshold") && e.includes("between 0 and 100"),
    ),
  ).toBe(true);
});

test("validateGuardianConfigContent - negative timeout fails", () => {
  const result = validateGuardianConfigContent(
    `{
  "timeoutMs": -100,
  "approvalRiskThreshold": 80
}`,
    FP,
  );
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes("timeoutMs") && e.includes("positive"))).toBe(true);
});

test("validateGuardianConfigContent - optional fields accepted", () => {
  const result = validateGuardianConfigContent(
    `{
  "timeoutMs": 90000,
  "approvalRiskThreshold": 80,
  "model": "anthropic/claude-sonnet-4",
  "variant": "high",
  "reviewToastDurationMs": 5000
}`,
    FP,
  );
  expect(result.valid).toBe(true);
  expect(result.errors).toHaveLength(0);
});

test("validateGuardianConfigContent - optional field wrong type fails", () => {
  const result = validateGuardianConfigContent(
    `{
  "timeoutMs": 90000,
  "approvalRiskThreshold": 80,
  "model": 123
}`,
    FP,
  );
  expect(result.valid).toBe(false);
  expect(
    result.errors.some((e) => e.includes('optional field "model"') && e.includes("string")),
  ).toBe(true);
});

test("validateGuardianConfigContent - top-level array fails", () => {
  const result = validateGuardianConfigContent(`[]`, FP);
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes("top-level object"))).toBe(true);
});

test("validateMemoryConfigContent - valid memory config passes", () => {
  const result = validateMemoryConfigContent(
    `{
  "enabled": true
}`,
    MP,
  );
  expect(result.valid).toBe(true);
  expect(result.errors).toHaveLength(0);
});

test("validateMemoryConfigContent - missing required field fails", () => {
  const result = validateMemoryConfigContent(
    `{
  "reviewerModel": "anthropic/claude-sonnet-4"
}`,
    MP,
  );
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes('missing required field "enabled"'))).toBe(true);
});

test("validateMemoryConfigContent - wrong field type fails", () => {
  const result = validateMemoryConfigContent(
    `{
  "enabled": "yes"
}`,
    MP,
  );
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes('field "enabled"') && e.includes('"string"'))).toBe(
    true,
  );
});

test("validateMemoryConfigContent - invalid JSONC reports parse error with line/col", () => {
  const result = validateMemoryConfigContent(`{ "enabled": true `, MP);
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes("invalid JSONC"))).toBe(true);
});

test("validateMemoryConfigContent - optional fields accepted", () => {
  const result = validateMemoryConfigContent(
    `{
  "enabled": true,
  "defaultSearchLimit": 10,
  "reviewerModel": "anthropic/claude-sonnet-4",
  "reviewerVariant": "high"
}`,
    MP,
  );
  expect(result.valid).toBe(true);
  expect(result.errors).toHaveLength(0);
});

test("validateMemoryConfigContent - non-integer defaultSearchLimit fails", () => {
  const result = validateMemoryConfigContent(
    `{
  "enabled": true,
  "defaultSearchLimit": 8.5
}`,
    MP,
  );
  expect(result.valid).toBe(false);
  expect(
    result.errors.some((e) => e.includes("defaultSearchLimit") && e.includes("positive integer")),
  ).toBe(true);
});

test("validateMemoryConfigContent - top-level string fails", () => {
  const result = validateMemoryConfigContent(`"not an object"`, MP);
  expect(result.valid).toBe(false);
  expect(result.errors.some((e) => e.includes("top-level object"))).toBe(true);
});
