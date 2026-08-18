// FILE: src/plugins/hashline-edit/routing.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Define edit-mode routing configuration and resolve the active edit mode for a session model.
//   SCOPE: EditMode vocabulary, strict routing config parsing with the default routing table, plugin entry union resolution, and case-insensitive provider-then-model substring matching.
//   DEPENDS: [none]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   EDIT_MODES - Canonical edit mode identifiers accepted by routing configuration.
//   EditMode - Union type of edit mode identifiers.
//   RoutingRule - One ordered pattern-to-mode routing entry.
//   RoutingConfig - Parsed routing table with default mode and ordered rules.
//   DEFAULT_ROUTING_CONFIG - Built-in routing table applied when config does not override it.
//   parseRoutingConfig - Strictly parse an unknown routing value into a RoutingConfig or throw.
//   HashlineEditPluginSettings - Resolved enabled flag and routing config for the hashline-edit plugin entry.
//   parseHashlineEditPluginEntry - Resolve the plugins["hashline-edit"] boolean-or-object union into enabled flag and routing config.
//   resolveEditMode - Resolve the active edit mode for a provider/model pair against a routing config.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.0 - Added glm to the default routing table on the replace profile.]
// END_CHANGE_SUMMARY

// START_BLOCK_VOCABULARY
export const EDIT_MODES = ["hashline", "replace", "str_replace_editor", "passthrough"] as const;

export type EditMode = (typeof EDIT_MODES)[number];

export interface RoutingRule {
  pattern: string;
  mode: EditMode;
}

export interface RoutingConfig {
  default: EditMode;
  rules: RoutingRule[];
}
// END_BLOCK_VOCABULARY

// START_BLOCK_DEFAULT_TABLE
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  default: "hashline",
  rules: [
    { pattern: "deepseek", mode: "str_replace_editor" },
    { pattern: "kimi", mode: "replace" },
    { pattern: "qwen", mode: "replace" },
    { pattern: "glm", mode: "replace" },
    { pattern: "gpt", mode: "passthrough" },
    { pattern: "codex", mode: "passthrough" },
  ],
};
// END_BLOCK_DEFAULT_TABLE

// START_BLOCK_PARSE
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEditMode(value: unknown, where: string): EditMode {
  if (typeof value === "string" && (EDIT_MODES as readonly string[]).includes(value)) {
    return value as EditMode;
  }
  throw new Error(
    `hashline-edit routing: ${where} must be one of ${EDIT_MODES.join(", ")}; got ${JSON.stringify(value)}`,
  );
}

export function parseRoutingConfig(raw: unknown): RoutingConfig {
  if (raw === undefined || raw === null) {
    return DEFAULT_ROUTING_CONFIG;
  }
  if (!isRecord(raw)) {
    throw new Error("hashline-edit routing: routing config must be an object");
  }

  const defaultMode =
    raw.default === undefined ? "hashline" : parseEditMode(raw.default, "default");
  const rules: RoutingRule[] = [];

  if (raw.rules !== undefined) {
    if (!isRecord(raw.rules)) {
      throw new Error("hashline-edit routing: rules must be an object mapping patterns to modes");
    }
    for (const [pattern, mode] of Object.entries(raw.rules)) {
      if (pattern.trim().length === 0) {
        throw new Error("hashline-edit routing: rule patterns must be non-empty strings");
      }
      rules.push({ pattern, mode: parseEditMode(mode, `rules["${pattern}"]`) });
    }
  }

  return { default: defaultMode, rules };
}

export interface HashlineEditPluginSettings {
  enabled: boolean;
  routing: RoutingConfig;
}

export function parseHashlineEditPluginEntry(raw: unknown): HashlineEditPluginSettings {
  if (raw === undefined || raw === null) {
    return { enabled: true, routing: DEFAULT_ROUTING_CONFIG };
  }
  if (typeof raw === "boolean") {
    return { enabled: raw, routing: DEFAULT_ROUTING_CONFIG };
  }
  if (!isRecord(raw)) {
    throw new Error('hashline-edit: plugins["hashline-edit"] must be a boolean or an object');
  }
  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof enabled !== "boolean") {
    throw new Error("hashline-edit: enabled must be a boolean");
  }
  return { enabled, routing: parseRoutingConfig(raw.routing) };
}
// END_BLOCK_PARSE

// START_BLOCK_RESOLVE
export function resolveEditMode(
  config: RoutingConfig,
  model: { providerID?: string; modelID?: string } | undefined,
): EditMode {
  if (!model) {
    return config.default;
  }
  const providerID = model.providerID?.toLowerCase();
  const modelID = model.modelID?.toLowerCase();

  for (const rule of config.rules) {
    const pattern = rule.pattern.toLowerCase();
    if (providerID !== undefined && providerID.includes(pattern)) {
      return rule.mode;
    }
  }
  for (const rule of config.rules) {
    const pattern = rule.pattern.toLowerCase();
    if (modelID !== undefined && modelID.includes(pattern)) {
      return rule.mode;
    }
  }
  return config.default;
}
// END_BLOCK_RESOLVE
