// FILE: src/lib/vvoc-config.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the canonical vvoc.json document shape, schema versions, normalization rules, and validation helpers.
//   SCOPE: Versioned schema constants, preset-aware default config generation, strict and lenient config parsing, section rendering/parsing helpers, and schema plus semantic validation for vvoc-owned configuration.
//   DEPENDS: [ajv/dist/2020, src/lib/agent-models.ts, src/lib/package.ts]
//   LINKS: [M-CLI-CONFIG, M-CLI-CONFIG-VALIDATE, M-CLI-PRESET, M-PLUGIN-GUARDIAN, M-PLUGIN-MEMORY-STORE, M-PLUGIN-SECRETS-REDACTION-INTERNAL-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   VVOC_CONFIG_VERSION - Canonical vvoc config document version.
//   VVOC_CONFIG_SCHEMA_URL - Hosted JSON Schema URL for the canonical vvoc config.
//   VVOC_CONFIG_SCHEMA - JSON Schema document for vvoc.json.
//   VvocPresetAgents - Partial per-target model override map for a named preset.
//   VvocPreset - Declarative preset shape stored in vvoc.json.
//   VvocPresets - Top-level preset map stored in vvoc.json.
//   GuardianConfig - Fully seeded guardian section shape.
//   GuardianConfigOverrides - Partial guardian section override shape.
//   MemoryConfig - Fully seeded memory section shape.
//   MemoryConfigOverrides - Partial memory section override shape.
//   SecretsRedactionConfig - Fully seeded secrets-redaction section shape.
//   VvocConfig - Fully seeded canonical vvoc config document shape.
//   ParsedVvocConfig - Parsed vvoc config plus the document schema/version found on disk.
//   createGuardianConfig - Builds a fully seeded guardian section from optional overrides.
//   createMemoryConfig - Builds a fully seeded memory section from optional overrides.
//   createDefaultSecretsRedactionConfig - Builds the seeded secrets-redaction section.
//   createDefaultVvocPresets - Builds the seeded named preset map.
//   createDefaultVvocConfig - Builds the fully seeded canonical vvoc config document.
//   parseGuardianConfigText - Strictly parses a guardian section JSON snippet.
//   renderGuardianConfig - Renders a guardian section JSON snippet.
//   parseMemoryConfigText - Strictly parses a memory section JSON snippet.
//   renderMemoryConfig - Renders a memory section JSON snippet.
//   parseVersionedVvocConfigText - Strictly parses vvoc.json and returns the source version plus normalized config.
//   parseVvocConfigText - Strictly parses the canonical vvoc config document.
//   loadLenientVvocConfigText - Parses vvoc.json leniently for runtime fallback with warnings.
//   renderVvocConfig - Renders canonical vvoc.json.
//   validateVvocConfigDocument - Validates a parsed vvoc config object against the JSON Schema.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v2.0.0 - Added vvoc.json schema v2 with declarative named presets and version-aware v1 normalization.]
// END_CHANGE_SUMMARY

import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import {
  SUPPORTED_MODEL_TARGET_NAMES,
  normalizeModelTargetOverride,
  type SupportedModelTargetName,
} from "./agent-models.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package.js";

const DEFAULT_GUARDIAN_TIMEOUT_MS = 90_000;
const DEFAULT_GUARDIAN_APPROVAL_RISK_THRESHOLD = 80;
const DEFAULT_MEMORY_SEARCH_LIMIT = 8;
const DEFAULT_SECRETS_REDACTION_TTL_MS = 3_600_000;
const DEFAULT_SECRETS_REDACTION_MAX_MAPPINGS = 10_000;

const VVOC_CONFIG_V1_SCHEMA_URL = `https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}@${PACKAGE_VERSION}/schemas/vvoc/v1.json`;

export const VVOC_CONFIG_VERSION = 2;
export const VVOC_CONFIG_SCHEMA_URL = `https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}@${PACKAGE_VERSION}/schemas/vvoc/v2.json`;

const JSON_SCHEMA_DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";
const BUILTIN_SECRETS_REDACTION_PATTERNS = [
  "email",
  "uuid",
  "ipv4",
  "mac",
  "openai_key",
  "anthropic_key",
  "github_token",
  "aws_access_key",
  "stripe_key",
  "bearer_token",
  "bearer_dot",
  "syn_key",
  "hex_token",
] as const;

type JsonObject = Record<string, unknown>;
type VvocConfigVersion = 1 | 2;

export type VvocPresetAgents = Partial<Record<SupportedModelTargetName, string>>;

export type VvocPreset = {
  description?: string;
  agents: VvocPresetAgents;
};

export type VvocPresets = Record<string, VvocPreset>;

export type GuardianConfig = {
  model?: string;
  variant?: string;
  timeoutMs: number;
  approvalRiskThreshold: number;
  reviewToastDurationMs: number;
};

export type GuardianConfigOverrides = Partial<GuardianConfig>;

export type MemoryConfig = {
  enabled: boolean;
  defaultSearchLimit: number;
  reviewerModel?: string;
  reviewerVariant?: string;
};

export type MemoryConfigOverrides = Partial<MemoryConfig>;

export type SecretsRedactionKeywordRule = {
  value: string;
  category?: string;
};

export type SecretsRedactionRegexRule = {
  pattern: string;
  category: string;
};

export type SecretsRedactionConfig = {
  enabled: boolean;
  secret: string;
  ttlMs: number;
  maxMappings: number;
  patterns: {
    keywords: SecretsRedactionKeywordRule[];
    regex: SecretsRedactionRegexRule[];
    builtin: string[];
    exclude: string[];
  };
  debug: boolean;
};

export type VvocConfig = {
  $schema: string;
  version: number;
  guardian: GuardianConfig;
  memory: MemoryConfig;
  secretsRedaction: SecretsRedactionConfig;
  presets: VvocPresets;
};

export type ParsedVvocConfig = {
  sourceSchema: string;
  sourceVersion: VvocConfigVersion;
  config: VvocConfig;
};

const GUARDIAN_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["timeoutMs", "approvalRiskThreshold", "reviewToastDurationMs"],
  properties: {
    model: { type: "string", minLength: 1 },
    variant: { type: "string", minLength: 1 },
    timeoutMs: { type: "integer", minimum: 1 },
    approvalRiskThreshold: { type: "integer", minimum: 0, maximum: 100 },
    reviewToastDurationMs: { type: "integer", minimum: 1 },
  },
};

const MEMORY_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "defaultSearchLimit"],
  properties: {
    enabled: { type: "boolean" },
    defaultSearchLimit: { type: "integer", minimum: 1 },
    reviewerModel: { type: "string", minLength: 1 },
    reviewerVariant: { type: "string", minLength: 1 },
  },
};

const SECRETS_REDACTION_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "secret", "ttlMs", "maxMappings", "patterns", "debug"],
  properties: {
    enabled: { type: "boolean" },
    secret: { type: "string", minLength: 1 },
    ttlMs: { type: "integer", minimum: 0 },
    maxMappings: { type: "integer", minimum: 1 },
    debug: { type: "boolean" },
    patterns: {
      type: "object",
      additionalProperties: false,
      required: ["keywords", "regex", "builtin", "exclude"],
      properties: {
        keywords: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["value"],
            properties: {
              value: { type: "string", minLength: 1 },
              category: { type: "string", minLength: 1 },
            },
          },
        },
        regex: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["pattern", "category"],
            properties: {
              pattern: { type: "string", minLength: 1 },
              category: { type: "string", minLength: 1 },
            },
          },
        },
        builtin: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        exclude: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

const VVOC_PRESET_AGENTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: Object.fromEntries(
    SUPPORTED_MODEL_TARGET_NAMES.map((agentName) => [agentName, { type: "string", minLength: 1 }]),
  ),
};

const VVOC_PRESET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["agents"],
  properties: {
    description: { type: "string", minLength: 1 },
    agents: VVOC_PRESET_AGENTS_SCHEMA,
  },
};

const VVOC_CONFIG_V1_SCHEMA = {
  $schema: JSON_SCHEMA_DRAFT_2020_12,
  $id: VVOC_CONFIG_V1_SCHEMA_URL,
  title: "vvoc config",
  description: "Canonical vvoc configuration document (v1).",
  type: "object",
  additionalProperties: false,
  required: ["$schema", "version", "guardian", "memory", "secretsRedaction"],
  properties: {
    $schema: {
      type: "string",
      minLength: 1,
      description: "Hosted JSON Schema URL for vvoc.json.",
    },
    version: {
      type: "integer",
      const: 1,
    },
    guardian: GUARDIAN_CONFIG_SCHEMA,
    memory: MEMORY_CONFIG_SCHEMA,
    secretsRedaction: SECRETS_REDACTION_CONFIG_SCHEMA,
  },
};

export const VVOC_CONFIG_SCHEMA = {
  $schema: JSON_SCHEMA_DRAFT_2020_12,
  $id: VVOC_CONFIG_SCHEMA_URL,
  title: "vvoc config",
  description: "Canonical vvoc configuration document.",
  type: "object",
  additionalProperties: false,
  required: ["$schema", "version", "guardian", "memory", "secretsRedaction", "presets"],
  properties: {
    $schema: {
      type: "string",
      minLength: 1,
      description: "Hosted JSON Schema URL for vvoc.json.",
    },
    version: {
      type: "integer",
      const: VVOC_CONFIG_VERSION,
    },
    guardian: GUARDIAN_CONFIG_SCHEMA,
    memory: MEMORY_CONFIG_SCHEMA,
    secretsRedaction: SECRETS_REDACTION_CONFIG_SCHEMA,
    presets: {
      type: "object",
      propertyNames: { minLength: 1 },
      additionalProperties: VVOC_PRESET_SCHEMA,
    },
  },
};

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateWithV1Schema = ajv.compile(VVOC_CONFIG_V1_SCHEMA);
const validateWithSchema = ajv.compile(VVOC_CONFIG_SCHEMA);

// START_BLOCK_DEFAULT_CONFIG_BUILDERS
export function createGuardianConfig(overrides: GuardianConfigOverrides = {}): GuardianConfig {
  const timeoutMs = overrides.timeoutMs ?? DEFAULT_GUARDIAN_TIMEOUT_MS;

  return compactObject({
    model: normalizeOptionalString(overrides.model),
    variant: normalizeOptionalString(overrides.variant),
    timeoutMs,
    approvalRiskThreshold:
      overrides.approvalRiskThreshold ?? DEFAULT_GUARDIAN_APPROVAL_RISK_THRESHOLD,
    reviewToastDurationMs: overrides.reviewToastDurationMs ?? timeoutMs,
  });
}

export function createMemoryConfig(overrides: MemoryConfigOverrides = {}): MemoryConfig {
  return compactObject({
    enabled: overrides.enabled ?? true,
    defaultSearchLimit: overrides.defaultSearchLimit ?? DEFAULT_MEMORY_SEARCH_LIMIT,
    reviewerModel: normalizeOptionalString(overrides.reviewerModel),
    reviewerVariant: normalizeOptionalString(overrides.reviewerVariant),
  });
}

export function createDefaultSecretsRedactionConfig(): SecretsRedactionConfig {
  return {
    enabled: true,
    secret: "${VVOC_SECRET}",
    ttlMs: DEFAULT_SECRETS_REDACTION_TTL_MS,
    maxMappings: DEFAULT_SECRETS_REDACTION_MAX_MAPPINGS,
    patterns: {
      keywords: [],
      regex: [],
      builtin: [...BUILTIN_SECRETS_REDACTION_PATTERNS],
      exclude: [],
    },
    debug: false,
  };
}

export function createDefaultVvocPresets(): VvocPresets {
  return createVvocPresets({
    openai: {
      description: "Starter OpenAI overrides for common vvoc model targets.",
      agents: {
        default: "openai/gpt-5.4:xhigh",
        "small-model": "openai/gpt-5.4-mini",
        guardian: "openai/gpt-5.4-mini",
        explore: "openai/gpt-5.4-mini",
      },
    },
    zai: {
      description: "Starter ZAI overrides for common vvoc model targets.",
      agents: {
        default: "zai-coding-plan/glm-5.1",
        "small-model": "zai-coding-plan/glm-4.5-air",
        guardian: "zai-coding-plan/glm-4.5-air",
        explore: "zai-coding-plan/glm-4.5-air",
      },
    },
    minimax: {
      description: "Starter MiniMax overrides for common vvoc model targets.",
      agents: {
        default: "minimax-coding-plan/minimax-m2.7",
        "small-model": "minimax-coding-plan/minimax-m2.1",
        guardian: "minimax-coding-plan/minimax-m2.1",
        explore: "minimax-coding-plan/minimax-m2.1",
      },
    },
  });
}

export function createDefaultVvocConfig(): VvocConfig {
  return {
    $schema: VVOC_CONFIG_SCHEMA_URL,
    version: VVOC_CONFIG_VERSION,
    guardian: createGuardianConfig(),
    memory: createMemoryConfig(),
    secretsRedaction: createDefaultSecretsRedactionConfig(),
    presets: createDefaultVvocPresets(),
  };
}
// END_BLOCK_DEFAULT_CONFIG_BUILDERS

// START_BLOCK_SECTION_PARSE_AND_RENDER
export function parseGuardianConfigText(text: string, label: string): GuardianConfigOverrides {
  const value = parseStrictJson(text, label);
  if (!isPlainObject(value)) {
    throw new Error(`${label}: expected a top-level object`);
  }

  assertAllowedKeys(
    value,
    ["model", "variant", "timeoutMs", "approvalRiskThreshold", "reviewToastDurationMs"],
    label,
  );

  const overrides: GuardianConfigOverrides = {};

  if (Object.hasOwn(value, "model")) {
    overrides.model = readNonEmptyString(value.model, `${label}: model`);
  }
  if (Object.hasOwn(value, "variant")) {
    overrides.variant = readNonEmptyString(value.variant, `${label}: variant`);
  }
  if (Object.hasOwn(value, "timeoutMs")) {
    overrides.timeoutMs = readPositiveInteger(value.timeoutMs, `${label}: timeoutMs`);
  }
  if (Object.hasOwn(value, "approvalRiskThreshold")) {
    overrides.approvalRiskThreshold = readThreshold(
      value.approvalRiskThreshold,
      `${label}: approvalRiskThreshold`,
    );
  }
  if (Object.hasOwn(value, "reviewToastDurationMs")) {
    overrides.reviewToastDurationMs = readPositiveInteger(
      value.reviewToastDurationMs,
      `${label}: reviewToastDurationMs`,
    );
  }

  return overrides;
}

export function renderGuardianConfig(overrides: GuardianConfigOverrides = {}): string {
  return renderJson(createGuardianConfig(overrides));
}

export function parseMemoryConfigText(text: string, label: string): MemoryConfigOverrides {
  const value = parseStrictJson(text, label);
  if (!isPlainObject(value)) {
    throw new Error(`${label}: expected a top-level object`);
  }

  assertAllowedKeys(
    value,
    ["enabled", "defaultSearchLimit", "reviewerModel", "reviewerVariant"],
    label,
  );

  const overrides: MemoryConfigOverrides = {};

  if (Object.hasOwn(value, "enabled")) {
    if (typeof value.enabled !== "boolean") {
      throw new Error(`${label}: enabled: expected a boolean`);
    }
    overrides.enabled = value.enabled;
  }
  if (Object.hasOwn(value, "defaultSearchLimit")) {
    overrides.defaultSearchLimit = readPositiveInteger(
      value.defaultSearchLimit,
      `${label}: defaultSearchLimit`,
    );
  }
  if (Object.hasOwn(value, "reviewerModel")) {
    overrides.reviewerModel = readNonEmptyString(value.reviewerModel, `${label}: reviewerModel`);
  }
  if (Object.hasOwn(value, "reviewerVariant")) {
    overrides.reviewerVariant = readNonEmptyString(
      value.reviewerVariant,
      `${label}: reviewerVariant`,
    );
  }

  return overrides;
}

export function renderMemoryConfig(overrides: MemoryConfigOverrides = {}): string {
  return renderJson(createMemoryConfig(overrides));
}
// END_BLOCK_SECTION_PARSE_AND_RENDER

// START_BLOCK_CANONICAL_CONFIG_PARSE_RENDER
export function parseVersionedVvocConfigText(text: string, label: string): ParsedVvocConfig {
  const value = parseStrictJson(text, label);
  const errors = validateVvocConfigDocument(value);

  if (errors.length > 0) {
    throw new Error(`${label}: ${errors.join("; ")}`);
  }

  return normalizeStrictVvocConfig(value as JsonObject);
}

export function parseVvocConfigText(text: string, label: string): VvocConfig {
  return parseVersionedVvocConfigText(text, label).config;
}

export function loadLenientVvocConfigText(
  text: string,
  label: string,
  warnings: string[],
): VvocConfig {
  let value: unknown;

  try {
    value = parseStrictJson(text, label);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : `${label}: invalid JSON`);
    return createDefaultVvocConfig();
  }

  if (!isPlainObject(value)) {
    warnings.push(`${label}: expected a top-level object`);
    return createDefaultVvocConfig();
  }

  const sourceVersion = readLenientSupportedVersion(value.version, `${label}: version`, warnings);

  return {
    $schema: VVOC_CONFIG_SCHEMA_URL,
    version: VVOC_CONFIG_VERSION,
    guardian: loadLenientGuardianConfig(value.guardian, `${label}: guardian`, warnings),
    memory: loadLenientMemoryConfig(value.memory, `${label}: memory`, warnings),
    secretsRedaction: loadLenientSecretsRedactionConfig(
      value.secretsRedaction,
      `${label}: secretsRedaction`,
      warnings,
    ),
    presets:
      sourceVersion === 2
        ? loadLenientVvocPresets(value.presets, `${label}: presets`, warnings)
        : createDefaultVvocPresets(),
  };
}

export function renderVvocConfig(config: VvocConfig = createDefaultVvocConfig()): string {
  return renderJson({
    $schema: VVOC_CONFIG_SCHEMA_URL,
    version: VVOC_CONFIG_VERSION,
    guardian: createGuardianConfig(config.guardian),
    memory: createMemoryConfig(config.memory),
    secretsRedaction: createSecretsRedactionConfig(config.secretsRedaction),
    presets: createVvocPresets(config.presets),
  });
}
// END_BLOCK_CANONICAL_CONFIG_PARSE_RENDER

// START_BLOCK_SCHEMA_VALIDATION
export function validateVvocConfigDocument(document: unknown): string[] {
  const validator =
    isPlainObject(document) && document.version === 1 ? validateWithV1Schema : validateWithSchema;

  if (!validator(document)) {
    return (validator.errors ?? []).map(formatSchemaError);
  }

  if (isPlainObject(document) && document.version === VVOC_CONFIG_VERSION) {
    return validatePresetSemantics(document);
  }

  return [];
}
// END_BLOCK_SCHEMA_VALIDATION

function normalizeStrictVvocConfig(value: JsonObject): ParsedVvocConfig {
  const sourceVersion = readSupportedVersion(value.version, "version");
  const baseConfig = {
    $schema: VVOC_CONFIG_SCHEMA_URL,
    version: VVOC_CONFIG_VERSION,
    guardian: createGuardianConfig(value.guardian as GuardianConfig),
    memory: createMemoryConfig(value.memory as MemoryConfig),
    secretsRedaction: createSecretsRedactionConfig(
      value.secretsRedaction as SecretsRedactionConfig,
    ),
  };

  return {
    sourceSchema: readNonEmptyString(value.$schema, "$schema"),
    sourceVersion,
    config:
      sourceVersion === 1
        ? {
            ...baseConfig,
            presets: createDefaultVvocPresets(),
          }
        : {
            ...baseConfig,
            presets: createVvocPresets(value.presets as VvocPresets),
          },
  };
}

function createSecretsRedactionConfig(
  overrides: Partial<SecretsRedactionConfig> = {},
): SecretsRedactionConfig {
  const defaults = createDefaultSecretsRedactionConfig();
  const patterns: Partial<SecretsRedactionConfig["patterns"]> = overrides.patterns ?? {};

  return {
    enabled: overrides.enabled ?? defaults.enabled,
    secret: normalizeOptionalString(overrides.secret) ?? defaults.secret,
    ttlMs: overrides.ttlMs ?? defaults.ttlMs,
    maxMappings: overrides.maxMappings ?? defaults.maxMappings,
    patterns: {
      keywords: cloneKeywordRules(patterns.keywords ?? defaults.patterns.keywords),
      regex: cloneRegexRules(patterns.regex ?? defaults.patterns.regex),
      builtin: cloneStringArray(patterns.builtin ?? defaults.patterns.builtin),
      exclude: cloneStringArray(patterns.exclude ?? defaults.patterns.exclude),
    },
    debug: overrides.debug ?? defaults.debug,
  };
}

function createVvocPresets(overrides: VvocPresets = {}): VvocPresets {
  const presets: VvocPresets = {};

  for (const [presetName, preset] of Object.entries(overrides)) {
    presets[presetName] = createVvocPreset(preset);
  }

  return presets;
}

function createVvocPreset(overrides: Partial<VvocPreset> = {}): VvocPreset {
  return compactObject({
    description: normalizeOptionalString(overrides.description),
    agents: createVvocPresetAgents(overrides.agents),
  });
}

function createVvocPresetAgents(overrides: VvocPresetAgents = {}): VvocPresetAgents {
  const agents: VvocPresetAgents = {};

  for (const agentName of SUPPORTED_MODEL_TARGET_NAMES) {
    const value = overrides[agentName];
    if (value === undefined) {
      continue;
    }

    agents[agentName] = normalizeModelTargetOverride(agentName, value, `preset ${agentName}`);
  }

  return agents;
}

function cloneKeywordRules(rules: SecretsRedactionKeywordRule[]): SecretsRedactionKeywordRule[] {
  return rules.map((rule) => compactObject({ value: rule.value, category: rule.category }));
}

function cloneRegexRules(rules: SecretsRedactionRegexRule[]): SecretsRedactionRegexRule[] {
  return rules.map((rule) => ({ pattern: rule.pattern, category: rule.category }));
}

function cloneStringArray(values: string[]): string[] {
  return values.slice();
}

function loadLenientGuardianConfig(
  value: unknown,
  label: string,
  warnings: string[],
): GuardianConfig {
  if (!isPlainObject(value)) {
    warnings.push(`${label}: expected an object`);
    return createGuardianConfig();
  }

  const overrides: GuardianConfigOverrides = {};

  if (Object.hasOwn(value, "model")) {
    const model = readLenientOptionalString(value.model, `${label}.model`, warnings);
    if (model !== undefined) {
      overrides.model = model;
    }
  }
  if (Object.hasOwn(value, "variant")) {
    const variant = readLenientOptionalString(value.variant, `${label}.variant`, warnings);
    if (variant !== undefined) {
      overrides.variant = variant;
    }
  }
  if (Object.hasOwn(value, "timeoutMs")) {
    const timeoutMs = readLenientPositiveInteger(value.timeoutMs, `${label}.timeoutMs`, warnings);
    if (timeoutMs !== undefined) {
      overrides.timeoutMs = timeoutMs;
    }
  }
  if (Object.hasOwn(value, "approvalRiskThreshold")) {
    const threshold = readLenientThreshold(
      value.approvalRiskThreshold,
      `${label}.approvalRiskThreshold`,
      warnings,
    );
    if (threshold !== undefined) {
      overrides.approvalRiskThreshold = threshold;
    }
  }
  if (Object.hasOwn(value, "reviewToastDurationMs")) {
    const reviewToastDurationMs = readLenientPositiveInteger(
      value.reviewToastDurationMs,
      `${label}.reviewToastDurationMs`,
      warnings,
    );
    if (reviewToastDurationMs !== undefined) {
      overrides.reviewToastDurationMs = reviewToastDurationMs;
    }
  }

  return createGuardianConfig(overrides);
}

function loadLenientMemoryConfig(value: unknown, label: string, warnings: string[]): MemoryConfig {
  if (!isPlainObject(value)) {
    warnings.push(`${label}: expected an object`);
    return createMemoryConfig();
  }

  const overrides: MemoryConfigOverrides = {};

  if (Object.hasOwn(value, "enabled")) {
    if (typeof value.enabled === "boolean") {
      overrides.enabled = value.enabled;
    } else {
      warnings.push(`${label}.enabled: expected a boolean`);
    }
  }
  if (Object.hasOwn(value, "defaultSearchLimit")) {
    const limit = readLenientPositiveInteger(
      value.defaultSearchLimit,
      `${label}.defaultSearchLimit`,
      warnings,
    );
    if (limit !== undefined) {
      overrides.defaultSearchLimit = limit;
    }
  }
  if (Object.hasOwn(value, "reviewerModel")) {
    const reviewerModel = readLenientOptionalString(
      value.reviewerModel,
      `${label}.reviewerModel`,
      warnings,
    );
    if (reviewerModel !== undefined) {
      overrides.reviewerModel = reviewerModel;
    }
  }
  if (Object.hasOwn(value, "reviewerVariant")) {
    const reviewerVariant = readLenientOptionalString(
      value.reviewerVariant,
      `${label}.reviewerVariant`,
      warnings,
    );
    if (reviewerVariant !== undefined) {
      overrides.reviewerVariant = reviewerVariant;
    }
  }

  return createMemoryConfig(overrides);
}

function loadLenientSecretsRedactionConfig(
  value: unknown,
  label: string,
  warnings: string[],
): SecretsRedactionConfig {
  if (!isPlainObject(value)) {
    warnings.push(`${label}: expected an object`);
    return createDefaultSecretsRedactionConfig();
  }

  const defaults = createDefaultSecretsRedactionConfig();
  const config = createDefaultSecretsRedactionConfig();

  if (Object.hasOwn(value, "enabled")) {
    if (typeof value.enabled === "boolean") {
      config.enabled = value.enabled;
    } else {
      warnings.push(`${label}.enabled: expected a boolean`);
    }
  }
  if (Object.hasOwn(value, "secret")) {
    const secret = readLenientOptionalString(value.secret, `${label}.secret`, warnings);
    if (secret !== undefined) {
      config.secret = secret;
    }
  }
  if (Object.hasOwn(value, "ttlMs")) {
    const ttlMs = readLenientInteger(value.ttlMs, `${label}.ttlMs`, warnings, 0);
    if (ttlMs !== undefined) {
      config.ttlMs = ttlMs;
    }
  }
  if (Object.hasOwn(value, "maxMappings")) {
    const maxMappings = readLenientPositiveInteger(
      value.maxMappings,
      `${label}.maxMappings`,
      warnings,
    );
    if (maxMappings !== undefined) {
      config.maxMappings = maxMappings;
    }
  }
  if (Object.hasOwn(value, "debug")) {
    if (typeof value.debug === "boolean") {
      config.debug = value.debug;
    } else {
      warnings.push(`${label}.debug: expected a boolean`);
    }
  }

  const patternsValue = value.patterns;
  if (patternsValue !== undefined) {
    if (!isPlainObject(patternsValue)) {
      warnings.push(`${label}.patterns: expected an object`);
      config.patterns = defaults.patterns;
    } else {
      config.patterns = {
        keywords: loadLenientKeywordRules(
          patternsValue.keywords,
          `${label}.patterns.keywords`,
          warnings,
        ),
        regex: loadLenientRegexRules(patternsValue.regex, `${label}.patterns.regex`, warnings),
        builtin: loadLenientStringArray(
          patternsValue.builtin,
          `${label}.patterns.builtin`,
          warnings,
          defaults.patterns.builtin,
        ),
        exclude: loadLenientStringArray(
          patternsValue.exclude,
          `${label}.patterns.exclude`,
          warnings,
          defaults.patterns.exclude,
        ),
      };
    }
  }

  return config;
}

function loadLenientKeywordRules(
  value: unknown,
  label: string,
  warnings: string[],
): SecretsRedactionKeywordRule[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`${label}: expected an array`);
    return [];
  }

  const rules: SecretsRedactionKeywordRule[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry)) {
      warnings.push(`${label}[${index}]: expected an object`);
      continue;
    }

    const ruleValue = readLenientOptionalString(entry.value, `${label}[${index}].value`, warnings);
    if (!ruleValue) {
      continue;
    }

    const category = Object.hasOwn(entry, "category")
      ? readLenientOptionalString(entry.category, `${label}[${index}].category`, warnings)
      : undefined;
    rules.push(compactObject({ value: ruleValue, category }));
  }

  return rules;
}

function loadLenientRegexRules(
  value: unknown,
  label: string,
  warnings: string[],
): SecretsRedactionRegexRule[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`${label}: expected an array`);
    return [];
  }

  const rules: SecretsRedactionRegexRule[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry)) {
      warnings.push(`${label}[${index}]: expected an object`);
      continue;
    }

    const pattern = readLenientOptionalString(
      entry.pattern,
      `${label}[${index}].pattern`,
      warnings,
    );
    const category = readLenientOptionalString(
      entry.category,
      `${label}[${index}].category`,
      warnings,
    );
    if (!pattern || !category) {
      continue;
    }

    rules.push({ pattern, category });
  }

  return rules;
}

function loadLenientStringArray(
  value: unknown,
  label: string,
  warnings: string[],
  fallback: string[],
): string[] {
  if (value === undefined) {
    return cloneStringArray(fallback);
  }
  if (!Array.isArray(value)) {
    warnings.push(`${label}: expected an array`);
    return cloneStringArray(fallback);
  }

  const entries = value
    .map((entry, index) => {
      const normalized = readLenientOptionalString(entry, `${label}[${index}]`, warnings);
      return normalized ?? "";
    })
    .filter(Boolean);

  return entries;
}

function loadLenientVvocPresets(value: unknown, label: string, warnings: string[]): VvocPresets {
  if (!isPlainObject(value)) {
    warnings.push(`${label}: expected an object`);
    return createDefaultVvocPresets();
  }

  const presets: VvocPresets = {};

  for (const [presetName, presetValue] of Object.entries(value)) {
    if (!presetName.trim()) {
      warnings.push(`${label}: preset names must be non-empty strings`);
      continue;
    }
    if (!isPlainObject(presetValue)) {
      warnings.push(`${label}.${presetName}: expected an object`);
      continue;
    }

    const description = Object.hasOwn(presetValue, "description")
      ? readLenientOptionalString(
          presetValue.description,
          `${label}.${presetName}.description`,
          warnings,
        )
      : undefined;
    const agents = loadLenientVvocPresetAgents(
      presetValue.agents,
      `${label}.${presetName}.agents`,
      warnings,
    );

    if (Object.keys(agents).length === 0) {
      warnings.push(`${label}.${presetName}.agents: expected at least one supported target`);
      continue;
    }

    presets[presetName] = createVvocPreset({ description, agents });
  }

  return Object.keys(presets).length > 0 ? presets : createDefaultVvocPresets();
}

function loadLenientVvocPresetAgents(
  value: unknown,
  label: string,
  warnings: string[],
): VvocPresetAgents {
  if (!isPlainObject(value)) {
    warnings.push(`${label}: expected an object`);
    return {};
  }

  const agents: VvocPresetAgents = {};

  for (const [agentName, modelValue] of Object.entries(value)) {
    if (!SUPPORTED_MODEL_TARGET_NAMES.includes(agentName as SupportedModelTargetName)) {
      warnings.push(`${label}: unsupported target "${agentName}"`);
      continue;
    }

    try {
      agents[agentName as SupportedModelTargetName] = normalizeModelTargetOverride(
        agentName as SupportedModelTargetName,
        modelValue,
        `${label}.${agentName}`,
      );
    } catch (error) {
      warnings.push(
        `${label}.${agentName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return agents;
}

function readLenientSupportedVersion(
  value: unknown,
  label: string,
  warnings: string[],
): VvocConfigVersion {
  if (value === undefined) {
    return VVOC_CONFIG_VERSION;
  }
  if (value === 1 || value === VVOC_CONFIG_VERSION) {
    return value;
  }

  warnings.push(`${label}: expected 1 or ${VVOC_CONFIG_VERSION}`);
  return VVOC_CONFIG_VERSION;
}

function readLenientOptionalString(
  value: unknown,
  label: string,
  warnings: string[],
): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    warnings.push(`${label}: expected a non-empty string`);
    return undefined;
  }

  return value.trim();
}

function readLenientInteger(
  value: unknown,
  label: string,
  warnings: string[],
  minimum: number,
): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= minimum) {
    return value;
  }

  warnings.push(`${label}: expected an integer >= ${minimum}`);
  return undefined;
}

function readLenientPositiveInteger(
  value: unknown,
  label: string,
  warnings: string[],
): number | undefined {
  return readLenientInteger(value, label, warnings, 1);
}

function readLenientThreshold(
  value: unknown,
  label: string,
  warnings: string[],
): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) {
    return value;
  }

  warnings.push(`${label}: expected an integer between 0 and 100`);
  return undefined;
}

function parseStrictJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${label}: failed to parse JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function readSupportedVersion(value: unknown, label: string): VvocConfigVersion {
  if (value === 1 || value === VVOC_CONFIG_VERSION) {
    return value;
  }

  throw new Error(`${label}: expected 1 or ${VVOC_CONFIG_VERSION}`);
}

function readNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label}: expected a non-empty string`);
  }

  return value.trim();
}

function readPositiveInteger(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  throw new Error(`${label}: expected a positive integer`);
}

function readThreshold(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) {
    return value;
  }

  throw new Error(`${label}: expected an integer between 0 and 100`);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedKeys(record: JsonObject, allowedKeys: string[], label: string): void {
  const allowed = new Set(allowedKeys);

  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${label}: unsupported field "${key}"`);
    }
  }
}

function compactObject<T extends JsonObject>(value: T): T {
  const nextEntries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return Object.fromEntries(nextEntries) as T;
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validatePresetSemantics(document: JsonObject): string[] {
  const presetsValue = document.presets;
  if (!isPlainObject(presetsValue)) {
    return [];
  }

  const errors: string[] = [];

  for (const [presetName, presetValue] of Object.entries(presetsValue)) {
    if (!isPlainObject(presetValue) || !isPlainObject(presetValue.agents)) {
      continue;
    }

    for (const [agentName, modelValue] of Object.entries(presetValue.agents)) {
      const location = `/presets/${presetName}/agents/${agentName}`;

      try {
        normalizeModelTargetOverride(agentName as SupportedModelTargetName, modelValue, location);
      } catch (error) {
        errors.push(`${location} ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return errors;
}

function formatSchemaError(error: ErrorObject): string {
  const path = error.instancePath || "/";

  if (error.keyword === "required") {
    return `${path} missing required property "${String((error.params as { missingProperty?: string }).missingProperty ?? "unknown")}"`;
  }

  if (error.keyword === "additionalProperties") {
    return `${path} has unsupported property "${String((error.params as { additionalProperty?: string }).additionalProperty ?? "unknown")}"`;
  }

  return `${path} ${error.message ?? "is invalid"}`;
}
