// FILE: src/commands/config-validate.test.ts
// VERSION: 0.6.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-CONFIG-VALIDATE - canonical vvoc.json validation.
//   SCOPE: Strict JSON parse error reporting, version-aware schema validation, preset semantic validation, and pass/fail terminal output.
//   DEPENDS: [src/commands/config-validate.ts, src/lib/vvoc-config.ts]
//   LINKS: [M-CLI-CONFIG-VALIDATE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Test suite for config validation - canonical vvoc.json schema validation.
// END_MODULE_MAP

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

test("validateVvocConfigContent - legacy v1 config still passes", () => {
  const result = validateVvocConfigContent(
    JSON.stringify(
      {
        $schema: "https://cdn.jsdelivr.net/npm/@osovv/vv-opencode@0.16.0/schemas/vvoc/v1.json",
        version: 1,
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

  expect(result.valid).toBe(true);
  expect(result.errors).toHaveLength(0);
});

test("validateVvocConfigContent - v2 presets pass schema validation", () => {
  const result = validateVvocConfigContent(
    JSON.stringify(
      {
        ...createDefaultVvocConfig(),
        presets: {
          openai: {
            description: "Starter OpenAI preset",
            agents: {
              guardian: "openai/gpt-5:high",
              general: "openai/gpt-5-mini",
            },
          },
          zai: {
            agents: {
              explore: "zai/glm-4.5-air",
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

test("validateVvocConfigContent - unsupported property fails", () => {
  const result = validateVvocConfigContent(
    JSON.stringify(
      {
        ...createDefaultVvocConfig(),
        unexpected: true,
      },
      null,
      2,
    ),
    FP,
  );

  expect(result.valid).toBe(false);
  expect(result.errors.some((error) => error.includes('unsupported property "unexpected"'))).toBe(
    true,
  );
});

test("validateVvocConfigContent - invalid preset special-agent syntax fails", () => {
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
        error.includes("provider/model-id format"),
    ),
  ).toBe(true);
});
