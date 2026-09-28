// FILE: src/runtime/context-inspection-contract.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the portable, versioned context-inspection RPC contract (strict input/output JSON Schemas, allowlisted DTOs, pure projections, and a strict client decoder) shared by the native server helper and the TUI collector without importing runtime initialization or CLI code.
//   SCOPE: RPC identity/version and schemas, bounded tool/location/provenance DTOs, explicit complete/partial/unavailable status, allowlisted policy projection (context/analytics/peak-hours with per-provider mode and bounded-but-complete schedules), value-free stable error codes, safe tool-row projection with bounded strings/schema size and server-injectable vendor schema conversion, and a strict result decoder. It never exposes raw family captures, model settings, headers, bodies, credentials, or raw error messages.
//   DEPENDS: [@opencode/schema/rpc, src/lib/peak-hours.ts]
//   LINKS: [M-NATIVE-RUNTIME, M-PLUGIN-CONTEXT-TUI, DF-CONTEXT-INSPECTION, V-M-NATIVE-RUNTIME, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: TYPES
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CONTEXT_INSPECTION_RPC_ID - Stable versioned RPC id.
//   CONTEXT_INSPECTION_VERSION - DTO schema version required in every reply.
//   CONTEXT_INSPECTION_METHOD - Registered method name.
//   ContextInspectionStatus - Explicit complete/partial/unavailable observation status.
//   ContextInspectionLocation - Serving location/project identity exposed to the client.
//   ContextInspectionTool - One registered tool row with effective id, safe namespace, code-mode flag, optional input JSON Schema, and availability status.
//   ContextInspectionCatalog - Tool catalog plus its own verdict and warnings.
//   ContextInspectionPeakWindow - Allowlisted peak window.
//   ContextInspectionPeakSchedule - Allowlisted per-provider peak schedule including its mode.
//   ContextInspectionPeakHours - Allowlisted peak-hours policy projection.
//   ContextInspectionProvenance - Capture provenance ids/times for the family-scoped policy.
//   ContextInspectionPolicy - Allowlisted policy projection (family capture or current-runtime preview) or a value-free unavailable verdict.
//   ContextInspectionInput - RPC input.
//   ContextInspectionResult - Versioned bounded RPC output.
//   ContextInspectionPolicySource - Structural vvoc toggle source accepted by the pure policy projection.
//   ContextInspectionSchemaConverter - Server-injectable vendor schema-to-JSON-Schema converter.
//   contextInspectionRpc - Portable RPC definition registered server-side and called client-side.
//   projectContextInspectionPolicy - Allowlisted policy projection from plugin toggles.
//   projectContextInspectionTool - Safe projection of one native tool row with bounded strings/schema size.
//   isContextInspectionResult - Strict versioned output decoder used by the client.
//   boundedWarnings - Bound and sanitize a warning list.
//   inspectionErrorCode - Stable value-free error code for a failed inspection step.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 attempt 2 - Added a schema version, strict output decoder, value-free error codes, per-provider schedule mode, bounded-but-complete schedules, and server-injectable vendor schema conversion.]
// END_CHANGE_SUMMARY

import type { Rpc } from "@opencode/schema/rpc";
import { parsePeakHoursEntry, type PeakHoursMode } from "../lib/peak-hours.js";

/** Stable versioned RPC id. */
export const CONTEXT_INSPECTION_RPC_ID = "vvoc.context-inspection.v1" as const;
/** DTO schema version required in every reply. */
export const CONTEXT_INSPECTION_VERSION = 1 as const;
/** Registered method name. */
export const CONTEXT_INSPECTION_METHOD = "inspect" as const;

const MAX_TOOLS = 512;
const MAX_NAME_CHARS = 160;
const MAX_DESCRIPTION_CHARS = 400;
const MAX_NAMESPACE_CHARS = 96;
const MAX_SCHEMA_BYTES = 32_768;
const MAX_WARNINGS = 8;
const MAX_SCHEDULE_PROVIDERS = 64;
const MAX_SCHEDULE_WINDOWS = 64;

/** Stable value-free error codes surfaced through the policy/RPC contract. */
export type ContextInspectionErrorCode =
  | "tool_catalog_unavailable"
  | "session_lookup_failed"
  | "session_location_mismatch"
  | "policy_capture_missing"
  | "policy_capture_invalid"
  | "policy_lookup_failed"
  | "current_config_unavailable"
  | "schedule_projection_exceeded"
  | "inspection_internal_error";

// START_BLOCK_CONTRACT_TYPES
/** Explicit complete/partial/unavailable observation status. */
export type ContextInspectionStatus = "complete" | "partial" | "unavailable";

/** Serving location/project identity exposed to the client. */
export interface ContextInspectionLocation {
  readonly directory: string;
  readonly projectID?: string;
  readonly workspaceID?: string;
}

/** One registered tool row with effective id, safe namespace, code-mode flag, and schema availability. */
export interface ContextInspectionTool {
  readonly effectiveID: string;
  readonly name: string;
  readonly description?: string;
  readonly namespace?: string;
  readonly codeMode: boolean;
  readonly inputJSONSchema?: unknown;
  readonly status: "registered" | "unavailable";
}

/** Tool catalog plus its own verdict and warnings. */
export interface ContextInspectionCatalog {
  readonly status: ContextInspectionStatus;
  readonly tools: readonly ContextInspectionTool[];
  readonly warnings: readonly string[];
}

/** Allowlisted peak window. */
export interface ContextInspectionPeakWindow {
  readonly start: string;
  readonly end: string;
  readonly tz?: string;
  readonly days?: readonly number[];
}

/** Allowlisted per-provider peak schedule including its mode. */
export interface ContextInspectionPeakSchedule {
  readonly mode?: PeakHoursMode;
  readonly windows: readonly ContextInspectionPeakWindow[];
}

/** Allowlisted peak-hours policy projection. */
export interface ContextInspectionPeakHours {
  readonly enabled: boolean;
  readonly mode: PeakHoursMode;
  readonly graceActiveSessions: boolean;
  readonly schedules: Readonly<Record<string, ContextInspectionPeakSchedule>>;
}

/** Capture provenance ids/times for the family-scoped policy. */
export interface ContextInspectionProvenance {
  readonly familyId: string;
  readonly snapshotId: string;
  readonly capturedAt: number;
  readonly location: ContextInspectionLocation;
}

/** Allowlisted policy projection (family capture or current-runtime preview) or a value-free unavailable verdict. */
export type ContextInspectionPolicy =
  | {
      readonly status: "available";
      readonly scope: "family";
      readonly contextEnabled: boolean;
      readonly analyticsEnabled: boolean;
      readonly peakHours: ContextInspectionPeakHours;
      readonly provenance: ContextInspectionProvenance;
      readonly warnings?: readonly string[];
    }
  | {
      readonly status: "preview";
      readonly scope: "current-runtime";
      readonly contextEnabled: boolean;
      readonly analyticsEnabled: boolean;
      readonly peakHours: ContextInspectionPeakHours;
      readonly warnings?: readonly string[];
    }
  | {
      readonly status: "unavailable";
      readonly scope: "family" | "current-runtime";
      readonly error: ContextInspectionErrorCode;
    };

/** RPC input. */
export interface ContextInspectionInput {
  readonly sessionID?: string;
  readonly includeCatalog?: boolean;
}

/** Versioned bounded RPC output. */
export interface ContextInspectionResult {
  readonly version: typeof CONTEXT_INSPECTION_VERSION;
  readonly status: ContextInspectionStatus;
  readonly location: ContextInspectionLocation;
  readonly observedAt: number;
  readonly catalog?: ContextInspectionCatalog;
  readonly policy?: ContextInspectionPolicy;
  readonly warnings: readonly string[];
}
// END_BLOCK_CONTRACT_TYPES

// START_BLOCK_RPC_DEFINITION
const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionID: { type: "string", maxLength: 160 },
    includeCatalog: { type: "boolean" },
  },
} as const;

const LOCATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["directory"],
  properties: {
    directory: { type: "string", maxLength: 4096 },
    projectID: { type: "string", maxLength: 160 },
    workspaceID: { type: "string", maxLength: 160 },
  },
} as const;

const PEAK_WINDOW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["start", "end"],
  properties: {
    start: { type: "string", maxLength: 16 },
    end: { type: "string", maxLength: 16 },
    tz: { type: "string", maxLength: 64 },
    days: { type: "array", maxItems: 7, items: { type: "number" } },
  },
} as const;

const PEAK_SCHEDULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["windows"],
  properties: {
    mode: { type: "string", enum: ["soft", "hard"] },
    windows: { type: "array", maxItems: MAX_SCHEDULE_WINDOWS, items: PEAK_WINDOW_SCHEMA },
  },
} as const;

const PEAK_HOURS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "mode", "graceActiveSessions", "schedules"],
  properties: {
    enabled: { type: "boolean" },
    mode: { type: "string", enum: ["soft", "hard"] },
    graceActiveSessions: { type: "boolean" },
    schedules: { type: "object", additionalProperties: PEAK_SCHEDULE_SCHEMA },
  },
} as const;

const PROVENANCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["familyId", "snapshotId", "capturedAt", "location"],
  properties: {
    familyId: { type: "string", maxLength: 160 },
    snapshotId: { type: "string", maxLength: 160 },
    capturedAt: { type: "number" },
    location: LOCATION_SCHEMA,
  },
} as const;

const POLICY_SCHEMA = {
  type: "object",
  required: ["status", "scope"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["available", "preview", "unavailable"] },
    scope: { type: "string", enum: ["family", "current-runtime"] },
    contextEnabled: { type: "boolean" },
    analyticsEnabled: { type: "boolean" },
    peakHours: PEAK_HOURS_SCHEMA,
    provenance: PROVENANCE_SCHEMA,
    warnings: {
      type: "array",
      maxItems: MAX_WARNINGS,
      items: { type: "string", maxLength: MAX_DESCRIPTION_CHARS },
    },
    error: { type: "string", maxLength: 64 },
  },
} as const;

const TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["effectiveID", "name", "codeMode", "status"],
  properties: {
    effectiveID: { type: "string", maxLength: MAX_NAME_CHARS },
    name: { type: "string", maxLength: MAX_NAME_CHARS },
    description: { type: "string", maxLength: MAX_DESCRIPTION_CHARS },
    namespace: { type: "string", maxLength: MAX_NAMESPACE_CHARS },
    codeMode: { type: "boolean" },
    inputJSONSchema: { type: ["object", "boolean"] },
    status: { type: "string", enum: ["registered", "unavailable"] },
  },
} as const;

const CATALOG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "tools", "warnings"],
  properties: {
    status: { type: "string", enum: ["complete", "partial", "unavailable"] },
    tools: { type: "array", maxItems: MAX_TOOLS, items: TOOL_SCHEMA },
    warnings: {
      type: "array",
      maxItems: MAX_WARNINGS,
      items: { type: "string", maxLength: MAX_DESCRIPTION_CHARS },
    },
  },
} as const;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "status", "location", "observedAt", "warnings"],
  properties: {
    version: { type: "number", enum: [CONTEXT_INSPECTION_VERSION] },
    status: { type: "string", enum: ["complete", "partial", "unavailable"] },
    location: LOCATION_SCHEMA,
    observedAt: { type: "number" },
    catalog: CATALOG_SCHEMA,
    policy: POLICY_SCHEMA,
    warnings: {
      type: "array",
      maxItems: MAX_WARNINGS,
      items: { type: "string", maxLength: MAX_DESCRIPTION_CHARS },
    },
  },
} as const;

/** Portable RPC definition registered server-side and called client-side. */
export const contextInspectionRpc = {
  id: CONTEXT_INSPECTION_RPC_ID,
  methods: {
    [CONTEXT_INSPECTION_METHOD]: { input: INPUT_SCHEMA, output: OUTPUT_SCHEMA },
  },
  events: {},
} satisfies Rpc.PortableDefinition;
// END_BLOCK_RPC_DEFINITION

// START_BLOCK_POLICY_PROJECTION
/** Structural vvoc toggle source accepted by the pure policy projection. */
export interface ContextInspectionPolicySource {
  readonly plugins?: Readonly<Record<string, unknown>> | undefined;
}

/** Projected values derived from the allowlisted policy source. */
export interface ProjectedContextInspectionPolicy {
  readonly contextEnabled: boolean;
  readonly analyticsEnabled: boolean;
  readonly peakHours: ContextInspectionPeakHours;
  /** False when a schedule exceeded the bounded projection and was not fully preserved. */
  readonly complete: boolean;
  readonly warnings: readonly string[];
}

/**
 * Allowlisted policy projection from plugin toggles. Only context/analytics
 * enablement and the peak-hours enabled/mode/grace/schedules fields survive;
 * every other captured setting (models, web keys, MCP config, headers, bodies,
 * secrets) is intentionally dropped.
 */
export function projectContextInspectionPolicy(
  source: ContextInspectionPolicySource | undefined,
): ProjectedContextInspectionPolicy {
  const plugins = source?.plugins;
  const peakHours = parsePeakHoursEntry(plugins?.["peak-hours"]);
  const schedules = projectSchedules(peakHours.entry.schedules);
  return {
    contextEnabled: isPluginToggleEnabled(plugins, "context"),
    analyticsEnabled: isPluginToggleEnabled(plugins, "analytics"),
    peakHours: {
      enabled: peakHours.entry.enabled,
      mode: peakHours.entry.mode,
      graceActiveSessions: peakHours.entry.graceActiveSessions,
      schedules: schedules.schedules,
    },
    complete: schedules.complete,
    warnings: schedules.warnings,
  };
}

/**
 * Mirror of the canonical `isVvocPluginEnabled` rule (absent → enabled, boolean
 * wins, object entry disables only when `enabled === false`) applied to an opaque
 * capture toggle map. Kept local so the portable contract has no config-module
 * dependency and no unsafe cast of an untrusted value.
 */
function isPluginToggleEnabled(
  plugins: Readonly<Record<string, unknown>> | undefined,
  name: string,
): boolean {
  const value = plugins?.[name];
  if (value === undefined) return true;
  if (typeof value === "boolean") return value;
  if (isRecord(value)) return value.enabled !== false;
  return true;
}

type ProjectedSchedules = {
  readonly schedules: Readonly<Record<string, ContextInspectionPeakSchedule>>;
  readonly complete: boolean;
  readonly warnings: readonly string[];
};

/**
 * The schedules are provider-keyed windows. Every documented key (mode and each
 * window's start/end/tz/days) is preserved; no user-supplied extra key travels
 * through the RPC. If the bounded projection is exceeded, the result is flagged
 * incomplete rather than silently truncating a schedule.
 */
function projectSchedules(schedules: unknown): ProjectedSchedules {
  if (!isRecord(schedules)) return { schedules: {}, complete: true, warnings: [] };
  const entries = Object.entries(schedules);
  if (entries.length > MAX_SCHEDULE_PROVIDERS) {
    return {
      schedules: {},
      complete: false,
      warnings: ["peak schedule providers exceed the bounded projection"],
    };
  }
  const projected: Record<string, ContextInspectionPeakSchedule> = {};
  const warnings: string[] = [];
  let complete = true;
  for (const [provider, value] of entries) {
    const schedule = projectProviderSchedule(value);
    if (!schedule.complete) {
      complete = false;
      warnings.push(`peak schedule for ${provider} exceeds the bounded projection`);
    }
    projected[provider] = schedule.schedule;
  }
  return { schedules: projected, complete, warnings };
}

function projectProviderSchedule(value: unknown): {
  readonly schedule: ContextInspectionPeakSchedule;
  readonly complete: boolean;
} {
  if (!isRecord(value) || !Array.isArray(value.windows)) {
    return { schedule: { windows: [] }, complete: true };
  }
  if (value.windows.length > MAX_SCHEDULE_WINDOWS) {
    return { schedule: { windows: [] }, complete: false };
  }
  const windows: ContextInspectionPeakWindow[] = [];
  for (const window of value.windows) {
    if (!isRecord(window)) continue;
    const start = typeof window.start === "string" ? window.start : undefined;
    const end = typeof window.end === "string" ? window.end : undefined;
    if (start === undefined || end === undefined) continue;
    windows.push({
      start,
      end,
      ...(typeof window.tz === "string" ? { tz: window.tz } : {}),
      ...(Array.isArray(window.days)
        ? { days: window.days.filter((day): day is number => typeof day === "number") }
        : {}),
    });
  }
  const mode = value.mode === "soft" || value.mode === "hard" ? value.mode : undefined;
  return { schedule: { ...(mode === undefined ? {} : { mode }), windows }, complete: true };
}
// END_BLOCK_POLICY_PROJECTION

// START_BLOCK_TOOL_PROJECTION
/** Server-injectable vendor schema-to-JSON-Schema converter (e.g. Effect codecs). */
export type ContextInspectionSchemaConverter = (schema: unknown) => unknown;

/** One projected tool row plus any bounded warnings it produced. */
export interface ProjectedContextInspectionTool {
  readonly tool: ContextInspectionTool;
  readonly warnings: readonly string[];
}

/**
 * Safe projection of one native tool row. `input` is converted to JSON Schema
 * only when it is a plain JSON Schema object, exposes a Standard JSON Schema
 * converter, or is handled by the server-injected vendor converter. A Standard
 * Schema object is never re-interpreted as a plain JSON Schema, an unsupported
 * vendor yields `unavailable` (never `{}`), and an oversized schema is refused
 * rather than truncated.
 */
export function projectContextInspectionTool(
  row: unknown,
  convertVendorSchema?: ContextInspectionSchemaConverter,
): ProjectedContextInspectionTool | undefined {
  if (!isRecord(row)) return undefined;
  const name = boundedString(row.name, MAX_NAME_CHARS);
  const effectiveID = boundedString(row.id, MAX_NAME_CHARS) ?? name;
  if (effectiveID === undefined) return undefined;
  const options = isRecord(row.options) ? row.options : undefined;
  const namespace = boundedString(options?.namespace, MAX_NAMESPACE_CHARS);
  const description = boundedString(row.description, MAX_DESCRIPTION_CHARS);
  const codeMode = options?.codemode !== false;
  const converted = convertInputSchema(row.input, convertVendorSchema);
  const warnings: string[] = [];
  if (converted.warning !== undefined) warnings.push(converted.warning);
  return {
    tool: {
      effectiveID,
      name: name ?? effectiveID,
      ...(description === undefined ? {} : { description }),
      ...(namespace === undefined ? {} : { namespace }),
      codeMode,
      ...(converted.schema === undefined ? {} : { inputJSONSchema: converted.schema }),
      status:
        converted.schema === undefined && row.input !== undefined ? "unavailable" : "registered",
    },
    warnings,
  };
}

type SchemaConversion =
  | { readonly schema: unknown; readonly warning?: undefined }
  | { readonly schema: undefined; readonly warning: string };

function convertInputSchema(
  input: unknown,
  convertVendorSchema?: ContextInspectionSchemaConverter,
): SchemaConversion {
  if (input === undefined || input === null) return { schema: undefined };
  if (isRecord(input) && isRecord(input["~standard"])) {
    const converted = convertStandardSchema(input);
    if (converted !== undefined) return boundedSchema(converted, "tool input");
    // A Standard Schema vendor without a usable JSON Schema converter is never
    // reinterpreted as a plain JSON Schema.
    return unavailableConversion(convertVendorSchema, input);
  }
  if (looksLikeJSONSchema(input)) return boundedSchema(input, "tool input");
  return unavailableConversion(convertVendorSchema, input);
}

function unavailableConversion(
  convertVendorSchema: ContextInspectionSchemaConverter | undefined,
  input: unknown,
): SchemaConversion {
  if (convertVendorSchema !== undefined) {
    try {
      const converted = convertVendorSchema(input);
      if (converted !== undefined && looksLikeJSONSchema(converted)) {
        return boundedSchema(converted, "tool input");
      }
    } catch {
      // Fall through to the unavailable verdict.
    }
  }
  return {
    schema: undefined,
    warning: "tool input schema conversion is unavailable for this schema vendor",
  };
}

function convertStandardSchema(input: Record<string, unknown>): unknown {
  const standard = isRecord(input["~standard"]) ? input["~standard"] : undefined;
  const converter = standard === undefined ? undefined : standard.jsonSchema;
  if (!isRecord(converter) || typeof converter.input !== "function") return undefined;
  try {
    const produced = converter.input({ target: "draft-2020-12" });
    return isPlainObject(produced) ? produced : undefined;
  } catch {
    return undefined;
  }
}

function boundedSchema(schema: unknown, label: string): SchemaConversion {
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    return { schema: undefined, warning: `${label} schema is not JSON-serializable` };
  }
  if (serialized.length > MAX_SCHEMA_BYTES) {
    return { schema: undefined, warning: `${label} schema exceeds the bounded observation size` };
  }
  return { schema };
}

const JSON_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "type",
  "properties",
  "patternProperties",
  "additionalProperties",
  "items",
  "prefixItems",
  "required",
  "enum",
  "const",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "format",
  "description",
  "title",
  "default",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "propertyNames",
  "minProperties",
  "maxProperties",
]);

/** A plain JSON Schema object: a plain object with at least one known keyword (or empty/boolean). */
function looksLikeJSONSchema(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  if (!isPlainObject(value)) return false;
  if (isRecord(value["~standard"])) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return true;
  return keys.some((key) => JSON_SCHEMA_KEYWORDS.has(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
// END_BLOCK_TOOL_PROJECTION

// START_BLOCK_VALIDATION
/**
 * Strict versioned output decoder. Malformed or spoofed replies cannot become
 * UI policy: every required field, type, enum, and scope/provenance combination
 * is enforced here before the client trusts a reply.
 */
export function isContextInspectionResult(value: unknown): value is ContextInspectionResult {
  if (!isRecord(value)) return false;
  if (value.version !== CONTEXT_INSPECTION_VERSION) return false;
  if (!isStatus(value.status)) return false;
  if (!isLocation(value.location)) return false;
  if (!isFiniteNonNegative(value.observedAt)) return false;
  if (!isBoundedStringArray(value.warnings, MAX_WARNINGS, MAX_DESCRIPTION_CHARS)) return false;
  if (value.catalog !== undefined && !isCatalog(value.catalog)) return false;
  if (value.policy !== undefined && !isPolicy(value.policy)) return false;
  return true;
}

/** Stable value-free error code for a failed inspection step. */
export function inspectionErrorCode(
  stage: "catalog" | "session" | "session-location" | "policy" | "preview" | "internal",
): ContextInspectionErrorCode {
  switch (stage) {
    case "catalog":
      return "tool_catalog_unavailable";
    case "session":
      return "session_lookup_failed";
    case "session-location":
      return "session_location_mismatch";
    case "policy":
      return "policy_lookup_failed";
    case "preview":
      return "current_config_unavailable";
    case "internal":
      return "inspection_internal_error";
  }
}

/** Bound a warning list so a broken registry cannot return an unbounded payload. */
export function boundedWarnings(warnings: readonly string[]): string[] {
  return warnings
    .slice(0, MAX_WARNINGS)
    .map((warning) => boundedString(warning, MAX_DESCRIPTION_CHARS) ?? "");
}

function isStatus(value: unknown): value is ContextInspectionStatus {
  return value === "complete" || value === "partial" || value === "unavailable";
}

function isLocation(value: unknown): value is ContextInspectionLocation {
  if (!isRecord(value)) return false;
  if (typeof value.directory !== "string" || value.directory.length === 0) return false;
  if (value.projectID !== undefined && typeof value.projectID !== "string") return false;
  if (value.workspaceID !== undefined && typeof value.workspaceID !== "string") return false;
  return true;
}

function isCatalog(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isStatus(value.status)) return false;
  if (!Array.isArray(value.tools)) return false;
  if (!isBoundedStringArray(value.warnings, MAX_WARNINGS, MAX_DESCRIPTION_CHARS)) return false;
  return value.tools.every((tool) => isTool(tool));
}

function isTool(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.effectiveID !== "string" || value.effectiveID.length === 0) return false;
  if (typeof value.name !== "string") return false;
  if (typeof value.codeMode !== "boolean") return false;
  if (value.status !== "registered" && value.status !== "unavailable") return false;
  if (value.description !== undefined && typeof value.description !== "string") return false;
  if (value.namespace !== undefined && typeof value.namespace !== "string") return false;
  if (value.inputJSONSchema !== undefined && !looksLikeJSONSchema(value.inputJSONSchema))
    return false;
  return true;
}

function isPolicy(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.scope !== "family" && value.scope !== "current-runtime") return false;
  if (value.status === "unavailable") {
    return typeof value.error === "string" && value.error.length > 0;
  }
  if (value.status !== "available" && value.status !== "preview") return false;
  if (typeof value.contextEnabled !== "boolean") return false;
  if (typeof value.analyticsEnabled !== "boolean") return false;
  if (!isPeakHours(value.peakHours)) return false;
  if (
    value.warnings !== undefined &&
    !isBoundedStringArray(value.warnings, MAX_WARNINGS, MAX_DESCRIPTION_CHARS)
  ) {
    return false;
  }
  if (value.status === "available") {
    // A family-scoped policy must carry validated provenance; a preview policy
    // must be current-runtime scoped and must not claim provenance.
    if (value.scope !== "family") return false;
    return isProvenance(value.provenance);
  }
  return value.scope === "current-runtime" && value.provenance === undefined;
}

function isProvenance(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.familyId !== "string" || value.familyId.length === 0) return false;
  if (typeof value.snapshotId !== "string" || value.snapshotId.length === 0) return false;
  if (!isFiniteNonNegative(value.capturedAt)) return false;
  return isLocation(value.location);
}

function isPeakHours(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.enabled !== "boolean") return false;
  if (value.mode !== "soft" && value.mode !== "hard") return false;
  if (typeof value.graceActiveSessions !== "boolean") return false;
  if (!isRecord(value.schedules)) return false;
  return Object.values(value.schedules).every((schedule) => isPeakSchedule(schedule));
}

function isPeakSchedule(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.windows)) return false;
  if (value.windows.length > MAX_SCHEDULE_WINDOWS) return false;
  if (value.mode !== undefined && value.mode !== "soft" && value.mode !== "hard") return false;
  return value.windows.every(
    (window) =>
      isRecord(window) &&
      typeof window.start === "string" &&
      typeof window.end === "string" &&
      (window.tz === undefined || typeof window.tz === "string") &&
      (window.days === undefined ||
        (Array.isArray(window.days) && window.days.every((day) => typeof day === "number"))),
  );
}
// END_BLOCK_VALIDATION

/** Bound a string by length, returning undefined for empty/non-string values. */
function boundedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.length > maxChars ? value.slice(0, maxChars) : value;
  return trimmed.length === 0 ? undefined : trimmed;
}

function isBoundedStringArray(value: unknown, maxItems: number, maxChars: number): boolean {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((entry) => typeof entry === "string" && entry.length <= maxChars)
  );
}

function isFiniteNonNegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** True for a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exposed for focused tests of the row bound. */
export const CONTEXT_INSPECTION_MAX_TOOLS = MAX_TOOLS;
