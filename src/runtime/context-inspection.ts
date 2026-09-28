// FILE: src/runtime/context-inspection.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Register the read-only native context-inspection RPC on the server plugin context, projecting the registered tool catalog and an allowlisted session-family or current-runtime policy for the TUI.
//   SCOPE: Structural server context/runtime seam, bounded catalog reads via ctx.tool.list with server-side vendor schema conversion (Schema-owned Effect 4 resolved from @opencode/schema), serving-location/project session validation via ctx.session.get, meaningful FamilyCapture validation via snapshots.policy, current-runtime preview from the already-loaded effective config, value-free stable error codes, and strict allowlisted output construction. It never stages/accepts work, switches models, reloads, executes tools, or connects MCP servers.
//   DEPENDS: [node:module, node:url, @opencode/schema/tool, src/runtime/context-inspection-contract.ts, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, M-PLUGIN-CONTEXT-TUI, DF-CONTEXT-INSPECTION, V-M-NATIVE-RUNTIME, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ContextInspectionServerContext - Structural native server plugin context accepted by the registration helper.
//   ContextInspectionServerRuntime - Structural runtime snapshot/config seam the handler may read.
//   createContextInspectionHandler - Build the production inspection handler for focused tests.
//   registerContextInspectionRpc - Register the versioned read-only inspection RPC and return its registration handle.
//   isMeaningfulFamilyCapture - Validate a durable capture before exposing any allowlisted policy.
//   loadSchemaOwnedVendorConverter - Resolve the Schema-owned Effect 4 codec converter for known built-in tool schemas.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 attempt 2 - Added value-free error codes, meaningful-capture validation, current-location session checks, undefined-preview rejection, bounded schedule reporting, and Schema-owned Effect schema conversion.]
// END_CHANGE_SUMMARY

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  CONTEXT_INSPECTION_MAX_TOOLS,
  CONTEXT_INSPECTION_METHOD,
  CONTEXT_INSPECTION_VERSION,
  boundedWarnings,
  contextInspectionRpc,
  inspectionErrorCode,
  projectContextInspectionPolicy,
  projectContextInspectionTool,
  type ContextInspectionCatalog,
  type ContextInspectionErrorCode,
  type ContextInspectionLocation,
  type ContextInspectionPolicy,
  type ContextInspectionProvenance,
  type ContextInspectionResult,
  type ContextInspectionSchemaConverter,
  type ContextInspectionTool,
} from "./context-inspection-contract.js";
import type { RuntimeLocation, RuntimeRpcRegistrar, RuntimeRpcRegistration } from "./types.js";

/**
 * Structural native server plugin context accepted by the registration helper.
 * A real server `Plugin.Context` satisfies it; `tool` is optional so a context
 * without a tool domain still registers and reports its catalog as unavailable.
 */
export interface ContextInspectionServerContext {
  readonly location: RuntimeLocation;
  readonly rpc: RuntimeRpcRegistrar;
  readonly tool?: { list(): Promise<readonly unknown[]> } | undefined;
  readonly session: {
    get(input: { readonly sessionID: string }): Promise<unknown>;
  };
}

/**
 * Structural runtime snapshot/config seam the handler may read. `policy` is the
 * session-family capture lookup; `currentConfig` is the already-loaded effective
 * config used only for a labelled current-runtime preview.
 */
export interface ContextInspectionServerRuntime {
  policy(sessionID: string): Promise<unknown>;
  currentConfig(): unknown;
  now?: (() => number) | undefined;
}

interface InspectInput {
  readonly sessionID?: string;
  readonly includeCatalog?: boolean;
}

// START_BLOCK_INSPECTION_REGISTRATION
/**
 * Build the read-only inspection handler. Exported so focused tests can invoke
 * the exact production logic without a live RPC transport.
 */
export function createContextInspectionHandler(
  ctx: ContextInspectionServerContext,
  runtime: ContextInspectionServerRuntime,
): (rawInput: unknown) => Promise<ContextInspectionResult> {
  return async (rawInput: unknown): Promise<ContextInspectionResult> => {
    const input: InspectInput = isRecord(rawInput) ? rawInput : {};
    const now = runtime.now ?? (() => Date.now());
    const observedAt = now();
    const location = toLocation(ctx.location);
    const warnings: string[] = [];

    const catalog = input.includeCatalog === false ? undefined : await readCatalog(ctx, warnings);
    const policy = await readPolicy(ctx, runtime, input.sessionID, location, warnings);

    return {
      version: CONTEXT_INSPECTION_VERSION,
      status: overallStatus(catalog, policy),
      location,
      observedAt,
      ...(catalog === undefined ? {} : { catalog }),
      policy,
      warnings: boundedWarnings(warnings),
    };
  };
}

/**
 * Register the versioned read-only inspection RPC. The returned registration is
 * owned by the caller: disposing it removes only this registration and never
 * stops the host or another plugin's registration.
 */
export async function registerContextInspectionRpc(
  ctx: ContextInspectionServerContext,
  runtime: ContextInspectionServerRuntime,
): Promise<RuntimeRpcRegistration> {
  const handler = createContextInspectionHandler(ctx, runtime);
  return ctx.rpc.register(contextInspectionRpc, {
    [CONTEXT_INSPECTION_METHOD]: (rawInput) => handler(rawInput),
  });
}
// END_BLOCK_INSPECTION_REGISTRATION

// START_BLOCK_CATALOG_READ
async function readCatalog(
  ctx: ContextInspectionServerContext,
  warnings: string[],
): Promise<ContextInspectionCatalog> {
  const list = ctx.tool?.list;
  if (typeof list !== "function") {
    warnings.push("tool_catalog_unavailable: the server context exposes no tool domain");
    return { status: "unavailable", tools: [], warnings: [] };
  }
  let rows: readonly unknown[];
  try {
    rows = await list.call(ctx.tool);
  } catch {
    warnings.push("tool_catalog_unavailable: the tool registry could not be read");
    return { status: "unavailable", tools: [], warnings: [] };
  }
  if (!Array.isArray(rows)) {
    warnings.push("tool_catalog_unavailable: the tool registry returned a non-list payload");
    return { status: "unavailable", tools: [], warnings: [] };
  }

  const capped = rows.slice(0, CONTEXT_INSPECTION_MAX_TOOLS);
  const cappedRows = capped.length < rows.length;
  if (cappedRows) warnings.push(`tool catalog truncated to ${CONTEXT_INSPECTION_MAX_TOOLS} rows`);

  const convertVendorSchema = await loadSchemaOwnedVendorConverter();
  const tools: ContextInspectionTool[] = [];
  const catalogWarnings = new Set<string>();
  let unusableRows = 0;
  let unavailableSchemas = 0;
  for (const row of capped) {
    const projected = projectContextInspectionTool(
      row,
      convertVendorSchema === undefined ? undefined : convertVendorSchema,
    );
    if (projected === undefined) {
      unusableRows += 1;
      continue;
    }
    tools.push(projected.tool);
    for (const warning of projected.warnings) {
      catalogWarnings.add(warning);
      warnings.push(warning);
    }
    if (projected.tool.status === "unavailable") unavailableSchemas += 1;
  }

  const status =
    tools.length === 0 && rows.length > 0
      ? "unavailable"
      : unusableRows > 0 || unavailableSchemas > 0 || cappedRows
        ? "partial"
        : "complete";
  return { status, tools, warnings: boundedWarnings([...catalogWarnings]) };
}

/**
 * Resolve the Schema-owned Effect 4 codec (the exact version `@opencode/schema`
 * depends on) through `@opencode/schema/tool`, so known built-in Effect schemas
 * convert to JSON Schema without pulling the repository-root Effect 3 types.
 * Returns undefined when no compatible converter is available.
 */
export async function loadSchemaOwnedVendorConverter(): Promise<
  ContextInspectionSchemaConverter | undefined
> {
  try {
    // `@opencode/schema` exports only the `import` condition, so resolve the
    // ESM entry with import.meta.resolve and create the require from it.
    const schemaToolUrl = import.meta.resolve("@opencode/schema/tool");
    const requireFromSchema = createRequire(schemaToolUrl);
    const effectEntry = requireFromSchema.resolve("effect");
    const effect = (await import(pathToFileURL(effectEntry).href)) as {
      readonly Schema?: {
        isSchema?: (value: unknown) => boolean;
        toJsonSchemaDocument?: (schema: unknown) => {
          readonly schema: unknown;
          readonly definitions?: Readonly<Record<string, unknown>>;
        };
      };
    };
    const schema = effect.Schema;
    if (
      schema === undefined ||
      typeof schema.isSchema !== "function" ||
      typeof schema.toJsonSchemaDocument !== "function"
    ) {
      return undefined;
    }
    return (candidate: unknown): unknown => {
      if (!schema.isSchema!(candidate)) return undefined;
      const document = schema.toJsonSchemaDocument!(candidate);
      const definitions = document.definitions;
      if (definitions === undefined || Object.keys(definitions).length === 0)
        return document.schema;
      // Preserve named definitions as `$defs` instead of flattening/refs.
      return { ...(document.schema as Record<string, unknown>), $defs: definitions };
    };
  } catch {
    return undefined;
  }
}
// END_BLOCK_CATALOG_READ

// START_BLOCK_POLICY_READ
async function readPolicy(
  ctx: ContextInspectionServerContext,
  runtime: ContextInspectionServerRuntime,
  sessionID: string | undefined,
  location: ContextInspectionLocation,
  warnings: string[],
): Promise<ContextInspectionPolicy> {
  if (sessionID === undefined || sessionID.length === 0) {
    return readPreviewPolicy(runtime, warnings);
  }

  // Validate that the supplied session currently belongs to this serving
  // location's project AND directory before returning any captured policy.
  // The captured family directory may legitimately differ after a worktree
  // move, but the session's CURRENT location must match the serving location.
  let session: unknown;
  try {
    session = await ctx.session.get({ sessionID });
  } catch {
    return unavailablePolicy(
      "family",
      inspectionErrorCode("session"),
      warnings,
      "session lookup failed",
    );
  }
  if (!sessionMatchesLocation(session, ctx.location)) {
    return unavailablePolicy(
      "family",
      inspectionErrorCode("session-location"),
      warnings,
      "session current location does not match the serving location",
    );
  }

  let capture: unknown;
  try {
    capture = await runtime.policy(sessionID);
  } catch {
    return unavailablePolicy(
      "family",
      inspectionErrorCode("policy"),
      warnings,
      "policy lookup failed",
    );
  }
  if (capture === undefined) {
    return unavailablePolicy(
      "family",
      "policy_capture_missing",
      warnings,
      "no captured family policy is bound to this session",
    );
  }
  if (!isMeaningfulFamilyCapture(capture)) {
    return unavailablePolicy(
      "family",
      "policy_capture_invalid",
      warnings,
      "the captured family policy is corrupt or incomplete",
    );
  }

  const projected = projectContextInspectionPolicy(readPolicySource(capture));
  if (!projected.complete) {
    return unavailablePolicy(
      "family",
      "schedule_projection_exceeded",
      warnings,
      "the captured peak schedule exceeds the bounded projection",
    );
  }
  const policyWarnings = projected.warnings.length === 0 ? undefined : [...projected.warnings];
  for (const warning of projected.warnings) warnings.push(warning);
  return {
    status: "available",
    scope: "family",
    contextEnabled: projected.contextEnabled,
    analyticsEnabled: projected.analyticsEnabled,
    peakHours: projected.peakHours,
    provenance: readProvenance(capture, location),
    ...(policyWarnings === undefined ? {} : { warnings: policyWarnings }),
  };
}

function readPreviewPolicy(
  runtime: ContextInspectionServerRuntime,
  warnings: string[],
): ContextInspectionPolicy {
  let config: unknown;
  try {
    config = runtime.currentConfig();
  } catch {
    return unavailablePolicy(
      "current-runtime",
      inspectionErrorCode("preview"),
      warnings,
      "current config unreadable",
    );
  }
  const vvoc = isRecord(config) && isRecord(config.vvoc) ? config.vvoc : undefined;
  if (vvoc === undefined || !isRecord(vvoc.plugins)) {
    // An undefined or malformed current config must not default to all-enabled.
    return unavailablePolicy(
      "current-runtime",
      inspectionErrorCode("preview"),
      warnings,
      "current runtime configuration is unavailable",
    );
  }
  const projected = projectContextInspectionPolicy({ plugins: vvoc.plugins });
  if (!projected.complete) {
    return unavailablePolicy(
      "current-runtime",
      "schedule_projection_exceeded",
      warnings,
      "the current peak schedule exceeds the bounded projection",
    );
  }
  const policyWarnings = projected.warnings.length === 0 ? undefined : [...projected.warnings];
  for (const warning of projected.warnings) warnings.push(warning);
  return {
    status: "preview",
    scope: "current-runtime",
    contextEnabled: projected.contextEnabled,
    analyticsEnabled: projected.analyticsEnabled,
    peakHours: projected.peakHours,
    ...(policyWarnings === undefined ? {} : { warnings: policyWarnings }),
  };
}
// END_BLOCK_POLICY_READ

// START_BLOCK_CAPTURE_VALIDATION
/**
 * Validate a durable family capture before exposing any allowlisted policy. An
 * arbitrary object (for example `{}`) is never treated as available defaults.
 */
export function isMeaningfulFamilyCapture(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (!nonEmptyString(value.familyId)) return false;
  if (!nonEmptyString(value.snapshotId)) return false;
  if (!nonEmptyString(value.integrity)) return false;
  if (typeof value.capturedAt !== "number" || !Number.isFinite(value.capturedAt)) return false;
  if (!isRecord(value.vvoc) || !isRecord(value.vvoc.plugins)) return false;
  const location = value.location;
  if (!isRecord(location) || !nonEmptyString(location.directory)) return false;
  if (!nonEmptyString(location.projectID)) return false;
  return true;
}

function sessionMatchesLocation(session: unknown, serving: RuntimeLocation): boolean {
  if (!isRecord(session)) return false;
  const projectID = session.projectID;
  if (typeof projectID !== "string" || projectID !== serving.project.id) return false;
  const sessionLocation = session.location;
  if (!isRecord(sessionLocation)) return false;
  const directory = sessionLocation.directory;
  return typeof directory === "string" && directory === serving.directory;
}
// END_BLOCK_CAPTURE_VALIDATION

function readPolicySource(capture: Record<string, unknown>): {
  plugins?: Readonly<Record<string, unknown>>;
} {
  const vvoc = isRecord(capture.vvoc) ? capture.vvoc : undefined;
  return vvoc === undefined ? {} : { plugins: readPlugins(vvoc) };
}

function readPlugins(vvoc: Record<string, unknown>): Readonly<Record<string, unknown>> | undefined {
  return isRecord(vvoc.plugins) ? vvoc.plugins : undefined;
}

function readProvenance(
  capture: Record<string, unknown>,
  fallback: ContextInspectionLocation,
): ContextInspectionProvenance {
  const location = isRecord(capture.location) ? capture.location : undefined;
  const directory = location === undefined ? undefined : readString(location.directory);
  const projectID = location === undefined ? undefined : readString(location.projectID);
  const workspaceID = location === undefined ? undefined : readString(location.workspaceID);
  return {
    familyId: readString(capture.familyId) ?? "",
    snapshotId: readString(capture.snapshotId) ?? "",
    capturedAt: typeof capture.capturedAt === "number" ? capture.capturedAt : 0,
    location:
      directory === undefined
        ? fallback
        : {
            directory,
            ...(projectID === undefined ? {} : { projectID }),
            ...(workspaceID === undefined ? {} : { workspaceID }),
          },
  };
}

function unavailablePolicy(
  scope: "family" | "current-runtime",
  code: ContextInspectionErrorCode,
  warnings: string[],
  reason: string,
): ContextInspectionPolicy {
  warnings.push(`${code}: ${reason}`);
  return { status: "unavailable", scope, error: code };
}

function overallStatus(
  catalog: ContextInspectionCatalog | undefined,
  policy: ContextInspectionPolicy,
): ContextInspectionResult["status"] {
  const catalogStatus = catalog?.status;
  const policyUnavailable = policy.status === "unavailable";
  if (catalogStatus === undefined) return policyUnavailable ? "unavailable" : "complete";
  if (catalogStatus === "unavailable" && policyUnavailable) return "unavailable";
  if (catalogStatus !== "complete" || policyUnavailable) return "partial";
  return "complete";
}

function toLocation(location: RuntimeLocation): ContextInspectionLocation {
  return {
    directory: location.directory,
    projectID: location.project.id,
    ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
