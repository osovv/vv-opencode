// FILE: src/commands/config-validate.test.ts
// VERSION: 0.9.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-CONFIG-VALIDATE - canonical vvoc.json validation.
//   SCOPE: Strict JSON parse error reporting, canonical schema v3 validation, role/preset semantic validation, and pass/fail terminal output.
//   DEPENDS: [src/commands/config-validate.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-CLI-CONFIG-VALIDATE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Test suite for config validation - canonical vvoc.json schema validation.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.9.0 - Replaced legacy v1/v2 acceptance checks with canonical v3 role-based failure coverage including unsupported-version and preset role-path errors.]
// END_CHANGE_SUMMARY

import { expect, test } from "bun:test";
import {
  VVOC_CONFIG_SCHEMA_URL,
  createDefaultVvocConfig,
  renderVvocConfig,
} from "../lib/vvoc-config.js";
import { validateVvocConfigContent } from "./config-validate.js";

const FP = "/test/vvoc.json";

test("validateVvocConfigContent - generated canonical config passes", () => {
  const result = validateVvocConfigContent(renderVvocConfig(createDefaultVvocConfig()), FP);
  expect(result.valid).toBe(true);
  expect(result.errors).toHaveLength(0);
});

test("validateVvocConfigContent - pre-role schema versions fail as unsupported", () => {
  const result = validateVvocConfigContent(
    JSON.stringify(
      {
        $schema: "https://cdn.jsdelivr.net/npm/@osovv/vv-opencode@0.24.0/schemas/vvoc/v2.json",
        version: 2,
        guardian: {
          timeoutMs: 90000,
          approvalRiskThreshold: 80,
          reviewToastDurationMs: 90000,
        },
        memory: {
          enabled: true,
          defaultSearchLimit: 8,
        },
        secretsRedaction: {
          enabled: true,
          secret: "${VVOC_SECRET}",
          ttlMs: 3600000,
          maxMappings: 10000,
          patterns: {
            keywords: [],
            regex: [],
            builtin: ["email"],
            exclude: [],
          },
          debug: false,
        },
      },
      null,
      2,
    ),
    FP,
  );

  expect(result.valid).toBe(false);
  expect(result.errors.some((error) => error.includes("/version unsupported-version"))).toBe(true);
});

test("validateVvocConfigContent - role-based custom preset assignments pass", () => {
  const result = validateVvocConfigContent(
    JSON.stringify(
      {
        ...createDefaultVvocConfig(),
        presets: {
          custom: {
            agents: {
              default: "openai/gpt-5.4",
              smart: "openai/gpt-5.4:xhigh",
              fast: "openai/gpt-5.4-mini",
              vision: "openai/gpt-5.4",
            },
          },
        },
      },
      null,
      2,
    ),
    FP,
  );

  expect(result.valid).toBe(true);
  expect(result.errors).toHaveLength(0);
});

test("validateVvocConfigContent - missing required built-in role ids fails with role path", () => {
  const result = validateVvocConfigContent(
    JSON.stringify(
      {
        ...createDefaultVvocConfig(),
        roles: {
          default: "openai/vv-gpt-5.4-xhigh",
          smart: "openai/vv-gpt-5.4-xhigh",
          fast: "openai/gpt-5.4-mini",
          helper: "openai/gpt-5.4",
        },
      },
      null,
      2,
    ),
    FP,
  );

  expect(result.valid).toBe(false);
  expect(
    result.errors.some((error) => error.includes('/roles missing required property "vision"')),
  ).toBe(true);
});

test("validateVvocConfigContent - invalid role assignment string fails with role path", () => {
  const result = validateVvocConfigContent(
    JSON.stringify(
      {
        ...createDefaultVvocConfig(),
        roles: {
          ...createDefaultVvocConfig().roles,
          default: "not-a-model",
        },
      },
      null,
      2,
    ),
    FP,
  );

  expect(result.valid).toBe(false);
  expect(
    result.errors.some(
      (error) =>
        error.includes("/roles/default") &&
        error.includes("INVALID_MODEL_SELECTION: modelSelection expected provider/model[:variant]"),
    ),
  ).toBe(true);
});

test("validateVvocConfigContent - missing required section fails", () => {
  const result = validateVvocConfigContent(
    JSON.stringify(
      {
        $schema: VVOC_CONFIG_SCHEMA_URL,
        version: 2,
        guardian: {
          timeoutMs: 90000,
          approvalRiskThreshold: 80,
          reviewToastDurationMs: 90000,
        },
        memory: {
          enabled: true,
          defaultSearchLimit: 8,
        },
        presets: {
          openai: {
            agents: {
              general: "openai/gpt-5-mini",
            },
          },
        },
      },
      null,
      2,
    ),
    FP,
  );

  expect(result.valid).toBe(false);
  expect(
    result.errors.some((error) => error.includes('missing required property "secretsRedaction"')),
  ).toBe(true);
});

test("validateVvocConfigContent - invalid field type fails", () => {
  const result = validateVvocConfigContent(
    JSON.stringify(
      {
        ...createDefaultVvocConfig(),
        memory: {
          enabled: "yes",
          defaultSearchLimit: 8,
        },
      },
      null,
      2,
    ),
    FP,
  );

  expect(result.valid).toBe(false);
  expect(
    result.errors.some((error) => error.includes("/memory/enabled") && error.includes("boolean")),
  ).toBe(true);
});

test("validateVvocConfigContent - invalid JSON reports parse error with line/col", () => {
  const result = validateVvocConfigContent(`{ "version": 1, }`, FP);
  expect(result.valid).toBe(false);
  expect(result.errors.some((error) => error.includes("invalid JSON"))).toBe(true);
  expect(result.errors.some((error) => error.includes(":1:"))).toBe(true);
});

test("validateVvocConfigContent - malformed preset role assignment fails with preset role path", () => {
  const result = validateVvocConfigContent(
    JSON.stringify(
      {
        ...createDefaultVvocConfig(),
        presets: {
          invalid: {
            agents: {
              guardian: "not-a-model",
            },
          },
        },
      },
      null,
      2,
    ),
    FP,
  );

  expect(result.valid).toBe(false);
  expect(
    result.errors.some(
      (error) =>
        error.includes("/presets/invalid/agents/guardian") &&
        error.includes("INVALID_MODEL_SELECTION: modelSelection expected provider/model[:variant]"),
    ),
  ).toBe(true);
});
