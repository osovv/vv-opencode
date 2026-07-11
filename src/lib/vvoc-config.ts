// FILE: src/lib/vvoc-config.ts
// VERSION: 3.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the canonical vvoc.json document shape, schema versions, normalization rules, and validation helpers.
//   SCOPE: Versioned schema constants, preset-aware default config generation including managed built-in presets, strict current config parsing, section rendering/parsing helpers, and schema plus semantic validation for vvoc-owned configuration including OpenCode alias-model defaults.
//   DEPENDS: [ajv/dist/2020, src/lib/agent-models.ts, src/lib/package.ts, src/lib/vvoc-preset-registry.ts]
//   LINKS: [M-CLI-CONFIG, M-CLI-CONFIG-VALIDATE, M-CLI-PRESET, M-PLUGIN-GUARDIAN, M-PLUGIN-SECRETS-REDACTION-INTERNAL-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   VVOC_CONFIG_VERSION - Canonical vvoc config version number.
//   VVOC_CONFIG_SCHEMA_URL - Hosted JSON Schema URL for vvoc config.
//   VvocRoleAssignments - Role assignment record type.
//   VvocPresetAgents - Preset agent assignment record type.
//   VvocPreset - Named preset definition type.
//   VvocPresets - Named preset map type.
//   GuardianConfig - Guardian section configuration type.
//   GuardianConfigOverrides - Guardian config override type.
//   SecretsRedactionKeywordRule - Keyword rule configuration type.
//   SecretsRedactionRegexRule - Regex rule configuration type.
//   SecretsRedactionConfig - Secrets redaction section configuration type.
//   VvocConfig - Fully seeded canonical vvoc config document shape.
//   ParsedVvocConfig - Parsed vvoc config plus source schema/version.
//   VVOC_CONFIG_SCHEMA - JSON Schema object for validation.
//   createGuardianConfig - Builds a fully seeded guardian section from optional overrides.
//   createDefaultSecretsRedactionConfig - Builds the seeded secrets-redaction section.
//   createDefaultVvocPresets - Builds the seeded named preset map.
//   createDefaultVvocConfig - Builds the fully seeded canonical vvoc config document.
//   parseGuardianConfigText - Strictly parses a guardian section JSON snippet.
//   renderGuardianConfig - Renders a guardian section JSON snippet.
//   parseVersionedVvocConfigText - Strictly parses vvoc.json and returns source version plus config.
//   parseVvocConfigText - Strictly parses the canonical vvoc config document.
//   renderVvocConfig - Renders canonical vvoc.json.
//   validateVvocConfigDocument - Validates parsed vvoc config against JSON Schema.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v3.0.0 - Removed lenient vvoc config parsing and made plugins a required canonical v3 section.]
//   LAST_CHANGE: [v2.5.0 - Added reviewer and orchestrator role defaults to createDefaultRoleAssignments.]
//   LAST_CHANGE: [v2.4.1 - Preserved strict-parsed plugin toggle values instead of resetting them to defaults.]
//   LAST_CHANGE: [v2.3.4 - Moved built-in vvoc preset definitions and managed-name detection to a shared internal preset registry.]
//   LAST_CHANGE: [v2.3.1 - Updated built-in vision preset targets to use OpenAI GPT-5.4 and ZAI GLM-4.6V.]
//   LAST_CHANGE: [v2.3.3 - Split OpenAI defaults so the default role uses GPT-5.4 while smart keeps the vv-gpt-5.5-xhigh alias.]
//   LAST_CHANGE: [v2.4.0 - Removed MemoryConfig, memory section, and all memory-related parsing. Memory v2 is a CLI command, not a config section.]
//   LAST_CHANGE: [C-CODEX-PRESET-LIMITS - Updated default role assignments to reference openai/vv-codex-gpt-5.5-xhigh for the smart role.]
// END_CHANGE_SUMMARY

import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { BUILTIN_ROLE_NAMES, parseModelSelection, type BuiltInRoleName } from "./model-roles.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package.js";
import {
  BUILTIN_VVOC_PRESET_REGISTRY,
  isBuiltinVvocPresetName as isManagedBuiltinVvocPresetName,
} from "./vvoc-preset-registry.js";
import {
  createDefaultPluginToggleConfig,
  type VvocPluginToggleConfig,
} from "./plugin-toggle-config.js";

const DEFAULT_GUARDIAN_TIMEOUT_MS = 90_000;
const DEFAULT_GUARDIAN_APPROVAL_RISK_THRESHOLD = 80;
const DEFAULT_SECRETS_REDACTION_TTL_MS = 3_600_000;
const DEFAULT_SECRETS_REDACTION_MAX_MAPPINGS = 10_000;
export const VVOC_CONFIG_VERSION = 3;
export const VVOC_CONFIG_SCHEMA_URL = `https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}@${PACKAGE_VERSION}/schemas/vvoc/v3.json`;

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
type VvocConfigVersion = 3;

export type VvocRoleAssignments = Partial<Record<string, string>>;
export type VvocPresetAgents = VvocRoleAssignments;

export type VvocPreset = {
  description?: string;
  agents: VvocPresetAgents;
};

export type VvocPresets = Record<string, VvocPreset>;

export type GuardianConfig = {
  model?: string;
  timeoutMs: number;
  approvalRiskThreshold: number;
  reviewToastDurationMs: number;
};

export type GuardianConfigOverrides = Partial<GuardianConfig>;

export type SecretsRedactionKeywordRule = {
  value: string;
  category?: string;
};

export type SecretsRedactionRegexRule = {
  pattern: string;
  category: string;
};

export type SecretsRedactionConfig = {
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
  roles: Record<string, string>;
  guardian: GuardianConfig;
  secretsRedaction: SecretsRedactionConfig;
  presets: VvocPresets;
  plugins: VvocPluginToggleConfig;
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
    timeoutMs: { type: "integer", minimum: 1 },
    approvalRiskThreshold: { type: "integer", minimum: 0, maximum: 100 },
    reviewToastDurationMs: { type: "integer", minimum: 1 },
  },
};

const SECRETS_REDACTION_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["secret", "ttlMs", "maxMappings", "patterns", "debug"],
  properties: {
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

const ROLE_ASSIGNMENTS_SCHEMA = {
  type: "object",
  propertyNames: { minLength: 1, pattern: "^[a-z][a-z0-9-]*$" },
  minProperties: 1,
  additionalProperties: { type: "string", minLength: 1 },
};

const VVOC_PRESET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["agents"],
  properties: {
    description: { type: "string", minLength: 1 },
    agents: ROLE_ASSIGNMENTS_SCHEMA,
  },
};

export const VVOC_CONFIG_SCHEMA = {
  $schema: JSON_SCHEMA_DRAFT_2020_12,
  $id: VVOC_CONFIG_SCHEMA_URL,
  title: "vvoc config",
  description: "Canonical vvoc configuration document.",
  type: "object",
  additionalProperties: false,
  required: ["$schema", "version", "roles", "guardian", "secretsRedaction", "presets", "plugins"],
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
    roles: {
      type: "object",
      propertyNames: { minLength: 1, pattern: "^[a-z][a-z0-9-]*$" },
      minProperties: BUILTIN_ROLE_NAMES.length,
      additionalProperties: { type: "string", minLength: 1 },
    },
    guardian: GUARDIAN_CONFIG_SCHEMA,
    secretsRedaction: SECRETS_REDACTION_CONFIG_SCHEMA,
    presets: {
      type: "object",
      propertyNames: { minLength: 1 },
      additionalProperties: VVOC_PRESET_SCHEMA,
    },
    plugins: {
      type: "object",
      propertyNames: { minLength: 1 },
      additionalProperties: { type: "boolean" },
    },
  },
};

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateWithSchema = ajv.compile(VVOC_CONFIG_SCHEMA);

// START_BLOCK_DEFAULT_CONFIG_BUILDERS
export function createGuardianConfig(overrides: GuardianConfigOverrides = {}): GuardianConfig {
  const timeoutMs = overrides.timeoutMs ?? DEFAULT_GUARDIAN_TIMEOUT_MS;

  return compactObject({
    model: normalizeOptionalString(overrides.model),
    timeoutMs,
    approvalRiskThreshold:
      overrides.approvalRiskThreshold ?? DEFAULT_GUARDIAN_APPROVAL_RISK_THRESHOLD,
    reviewToastDurationMs: overrides.reviewToastDurationMs ?? timeoutMs,
  });
}

export function createDefaultSecretsRedactionConfig(): SecretsRedactionConfig {
  return {
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
  return createBuiltinVvocPresets();
}

function createDefaultRoleAssignments(overrides: VvocRoleAssignments = {}): Record<string, string> {
  const defaults: Record<BuiltInRoleName, string> = {
    default: "openai/gpt-5.4",
    smart: "openai/vv-codex-gpt-5.5-xhigh",
    fast: "openai/gpt-5.4-mini",
    vision: "openai/gpt-5.4",
    reviewer: "openai/gpt-5.4",
  } as const;
  const roles: Record<string, string> = { ...defaults };

  for (const [roleId, modelSelection] of Object.entries(overrides)) {
    if (typeof modelSelection !== "string") {
      continue;
    }
    const normalizedRoleId = normalizeRoleId(roleId, `role ${roleId}`);
    roles[normalizedRoleId] = normalizeRoleModelSelection(
      modelSelection,
      `role ${normalizedRoleId}`,
    );
  }

  return roles;
}

function createBuiltinVvocPresets(): VvocPresets {
  return Object.fromEntries(
    Object.entries(BUILTIN_VVOC_PRESET_REGISTRY).map(([presetName, preset]) => [
      presetName,
      createVvocPreset(preset),
    ]),
  );
}

export function createDefaultVvocConfig(): VvocConfig {
  return {
    $schema: VVOC_CONFIG_SCHEMA_URL,
    version: VVOC_CONFIG_VERSION,
    roles: createDefaultRoleAssignments(),
    guardian: createGuardianConfig(),
    secretsRedaction: createDefaultSecretsRedactionConfig(),
    presets: createDefaultVvocPresets(),
    plugins: createDefaultPluginToggleConfig(),
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
    ["model", "timeoutMs", "approvalRiskThreshold", "reviewToastDurationMs"],
    label,
  );

  const overrides: GuardianConfigOverrides = {};

  if (Object.hasOwn(value, "model")) {
    overrides.model = readNonEmptyString(value.model, `${label}: model`);
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

export function renderVvocConfig(config: VvocConfig = createDefaultVvocConfig()): string {
  return renderJson({
    $schema: VVOC_CONFIG_SCHEMA_URL,
    version: VVOC_CONFIG_VERSION,
    roles: createDefaultRoleAssignments(config.roles),
    guardian: createGuardianConfig(config.guardian),
    secretsRedaction: createSecretsRedactionConfig(config.secretsRedaction),
    presets: createVvocPresets(config.presets),
    plugins: config.plugins,
  });
}
// END_BLOCK_CANONICAL_CONFIG_PARSE_RENDER

// START_BLOCK_SCHEMA_VALIDATION
export function validateVvocConfigDocument(document: unknown): string[] {
  if (!validateWithSchema(document)) {
    return (validateWithSchema.errors ?? []).map(formatSchemaError);
  }

  if (isPlainObject(document) && document.version === VVOC_CONFIG_VERSION) {
    return validatePresetSemantics(document);
  }

  return [];
}
// END_BLOCK_SCHEMA_VALIDATION

function normalizeStrictVvocConfig(value: JsonObject): ParsedVvocConfig {
  const sourceVersion = readSupportedVersion(value.version, "version");
  return {
    sourceSchema: readNonEmptyString(value.$schema, "$schema"),
    sourceVersion,
    config: {
      $schema: VVOC_CONFIG_SCHEMA_URL,
      version: VVOC_CONFIG_VERSION,
      roles: createDefaultRoleAssignments(value.roles as VvocRoleAssignments),
      guardian: createGuardianConfig(value.guardian as GuardianConfig),
      secretsRedaction: createSecretsRedactionConfig(
        value.secretsRedaction as SecretsRedactionConfig,
      ),
      presets: createVvocPresets(value.presets as VvocPresets),
      plugins: createPluginToggleConfig(value.plugins),
    },
  };
}

function createSecretsRedactionConfig(
  overrides: Partial<SecretsRedactionConfig> = {},
): SecretsRedactionConfig {
  const defaults = createDefaultSecretsRedactionConfig();
  const patterns: Partial<SecretsRedactionConfig["patterns"]> = overrides.patterns ?? {};

  return {
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
  const presets = createBuiltinVvocPresets();

  for (const [presetName, preset] of Object.entries(overrides)) {
    // Managed built-ins are always rewritten from vvoc defaults.
    if (isBuiltinVvocPresetName(presetName)) {
      continue;
    }
    presets[presetName] = createVvocPreset(preset);
  }

  return presets;
}

function createPluginToggleConfig(overrides: unknown = {}): VvocPluginToggleConfig {
  const config = createDefaultPluginToggleConfig();
  if (!isPlainObject(overrides)) {
    return config;
  }

  for (const [pluginName, pluginValue] of Object.entries(overrides)) {
    if (typeof pluginValue === "boolean") {
      config[pluginName] = pluginValue;
    }
  }

  return config;
}

function isBuiltinVvocPresetName(name: string): boolean {
  return isManagedBuiltinVvocPresetName(name);
}

function createVvocPreset(overrides: Partial<VvocPreset> = {}): VvocPreset {
  return compactObject({
    description: normalizeOptionalString(overrides.description),
    agents: createVvocPresetAgents(overrides.agents),
  });
}

function createVvocPresetAgents(overrides: VvocPresetAgents = {}): VvocPresetAgents {
  const agents: VvocPresetAgents = {};

  for (const [roleId, modelSelection] of Object.entries(overrides)) {
    if (typeof modelSelection !== "string") {
      continue;
    }

    const normalizedRoleId = normalizeRoleId(roleId, `preset role ${roleId}`);
    agents[normalizedRoleId] = normalizeRoleModelSelection(
      modelSelection,
      `preset role ${normalizedRoleId}`,
    );
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
  if (value === VVOC_CONFIG_VERSION) {
    return value;
  }

  throw new Error(`${label}: expected ${VVOC_CONFIG_VERSION}`);
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
  const rolesValue = document.roles;
  const errors: string[] = [];

  if (isPlainObject(rolesValue)) {
    for (const builtInRoleName of BUILTIN_ROLE_NAMES) {
      if (!Object.hasOwn(rolesValue, builtInRoleName)) {
        errors.push(`/roles missing required property "${builtInRoleName}"`);
      }
    }

    for (const [roleId, modelValue] of Object.entries(rolesValue)) {
      const location = `/roles/${roleId}`;
      try {
        normalizeRoleId(roleId, location);
        normalizeRoleModelSelection(modelValue, location);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  const presetsValue = document.presets;
  if (!isPlainObject(presetsValue)) {
    return errors;
  }

  for (const [presetName, presetValue] of Object.entries(presetsValue)) {
    if (!isPlainObject(presetValue) || !isPlainObject(presetValue.agents)) {
      continue;
    }

    for (const [roleId, modelValue] of Object.entries(presetValue.agents)) {
      const location = `/presets/${presetName}/agents/${roleId}`;

      try {
        normalizeRoleId(roleId, location);
        normalizeRoleModelSelection(modelValue, location);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  return errors;
}

function normalizeRoleModelSelection(value: unknown, label: string): string {
  const modelSelection = readNonEmptyString(value, label);
  const parsed = parseModelSelection(modelSelection);
  return parsed.normalized;
}

function normalizeRoleId(value: unknown, label: string): string {
  const roleId = readNonEmptyString(value, label);
  if (!/^[a-z][a-z0-9-]*$/.test(roleId)) {
    throw new Error(`${label}: expected lowercase letters, digits, and hyphens`);
  }
  return roleId;
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
