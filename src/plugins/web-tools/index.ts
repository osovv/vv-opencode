// FILE: src/plugins/web-tools/index.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Register the canonical native web_search and web_fetch tools through the native tool editor and select, per bound family, either the owned tools or the genuine native builtins without mutating user permissions.
//   SCOPE: Native Plugin.define entry, stable registration of exactly the two owned tools, per-session context/compaction/generate visibility selection driven by the immutable captured policy (enabled publishes the owned contract; an explicit disabled capture publishes the genuine native builtin definitions; unknown policy exposes neither), strict owned validation, per-session provider-config resolution at execute time, credential-safe diagnostics, and no interception of unrelated host or MCP tools. No V1 config-permission mutation, no fabricated client logger, no startup-global toggle that could hijack another family.
//   DEPENDS: [@opencode/plugin, @opencode/plugin/promise/tool, src/lib/plugin-toggle-config.ts, src/runtime/context.ts, src/runtime/types.ts, src/plugins/web-tools/config.ts, src/plugins/web-tools/schemas.ts, src/plugins/web-tools/search-service.ts, src/plugins/web-tools/fetch-service.ts]
//   LINKS: M-PLUGIN-WEB-TOOLS, M-WEB-CONFIG, M-WEB-SEARCH-SERVICE, M-WEB-FETCH-SERVICE, M-AGENT-TOOL-CONTRACT, M-NATIVE-RUNTIME, V-M-PLUGIN-WEB-TOOLS, DF-WEB-SEARCH, DF-WEB-FETCH
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   NATIVE_WEB_TOOL_IDS - Genuine native builtin web tool names (websearch/webfetch).
//   OWNED_WEB_TOOL_IDS - Owned tool names (web_search/web_fetch).
//   WebToolsDiagnostic - Credential-safe diagnostic event.
//   WebToolsSessionDependencies - Per-session policy resolver plus native-builtin capture.
//   WebToolsRegistrationDependencies - Policy resolver, permission guard and diagnostic sink for registration.
//   registerWebTools - Register the two owned native tools.
//   applyWebToolVisibility - Select owned vs native builtins for one session tool map.
//   createWebToolsLog - Credential-safe bounded diagnostic sink.
//   WebToolsPluginOptions - Optional injectable runtime acquisition for tests.
//   createWebToolsPlugin - Native plugin factory; the default export acquires the real shared runtime.
//   WebToolsPlugin - Default production native web-tools plugin object.
//   NativeToolDefinition - Captured genuine native tool description/input schema.
//   default - Default export alias of WebToolsPlugin.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-005 attempt 3 - Restored the git-tracked literal-apiKey diagnostic by inspecting the selected current config source read-only (separate from provider selection and captured policy), reporting unknown rather than fabricating provenance.]
// END_CHANGE_SUMMARY

import { Plugin } from "@opencode/plugin";
import type { ToolEditor } from "@opencode/plugin/promise/tool";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import {
  acquireNativeSnapshotRuntime,
  type NativeSnapshotContext,
  type NativeSnapshotRuntime,
} from "../../runtime/context.js";
import type { FamilyCapture } from "../../runtime/types.js";
import { resolveWebRuntimeConfig, warnIfSecretBearingProjectConfigTracked } from "./config.js";
import { createWebFetchTool } from "./fetch-service.js";
import {
  createWebSearchTool,
  type WebToolsPolicyDecision,
  type WebToolsRuntime,
} from "./search-service.js";
import { webFetchContract, webSearchContract } from "./schemas.js";

/** Genuine native builtin web tool names (confirmed in pinned core/src/tool/plugin). */
export const NATIVE_WEB_TOOL_IDS = ["websearch", "webfetch"] as const;
/** Owned tool names replacing the builtins when the captured policy enables web-tools. */
export const OWNED_WEB_TOOL_IDS = ["web_search", "web_fetch"] as const;

/** Bounded credential-safe diagnostic event. */
export interface WebToolsDiagnostic {
  readonly level: "info" | "warn" | "debug";
  readonly message: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** A captured native tool definition (`description` + JSON `input` schema) safe to republish. */
export interface NativeToolDefinition {
  readonly description: string;
  readonly input: unknown;
}

/** Per-session policy resolver plus native-builtin capture shared by hooks and tools. */
export interface WebToolsSessionDependencies {
  resolve(sessionID: string): Promise<WebToolsPolicyDecision>;
  log(event: WebToolsDiagnostic): void;
}

/** Registration inputs; policy is resolved per session at execution time. */
export interface WebToolsRegistrationDependencies {
  readonly runtime: WebToolsRuntime;
}

/**
 * Register exactly the two owned native tools. Registration is stable and
 * independent of startup configuration so a disabled capture can never remove
 * a tool another family still uses.
 */
export function registerWebTools(editor: ToolEditor, deps: WebToolsRegistrationDependencies): void {
  editor.add(createWebSearchTool(deps.runtime));
  editor.add(createWebFetchTool(deps.runtime));
}

function isNativeToolDefinition(value: unknown): value is NativeToolDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { description?: unknown }).description === "string" &&
    "input" in (value as object)
  );
}

/**
 * Select the web tools visible to one session. An enabled captured policy
 * publishes the owned contract and removes the native builtins; an explicit
 * disabled capture removes the owned tools and republishes the genuine native
 * builtin definitions if another hook removed them; an unknown policy exposes
 * neither, so a missing policy is never treated as a disable and never blocks
 * another family.
 */
export function applyWebToolVisibility(
  decision: WebToolsPolicyDecision,
  tools: Record<string, unknown>,
  nativeDefinitions: Map<string, NativeToolDefinition>,
): void {
  // Capture whichever native builtin definitions this session exposes before mutation.
  for (const id of NATIVE_WEB_TOOL_IDS) {
    const value = tools[id];
    if (isNativeToolDefinition(value)) nativeDefinitions.set(id, value);
  }

  if (decision === "disabled") {
    for (const id of OWNED_WEB_TOOL_IDS) delete tools[id];
    for (const id of NATIVE_WEB_TOOL_IDS) {
      if (tools[id] === undefined) {
        const captured = nativeDefinitions.get(id);
        if (captured !== undefined) tools[id] = captured;
      }
    }
    return;
  }

  if (decision === undefined) {
    // Unknown policy: expose neither owned nor native web tools.
    for (const id of [...OWNED_WEB_TOOL_IDS, ...NATIVE_WEB_TOOL_IDS]) delete tools[id];
    return;
  }

  for (const id of NATIVE_WEB_TOOL_IDS) delete tools[id];
  tools.web_search = {
    description: webSearchContract.description,
    input: webSearchContract.inputJsonSchema,
  };
  tools.web_fetch = {
    description: webFetchContract.description,
    input: webFetchContract.inputJsonSchema,
  };
}

/**
 * Build a credential-safe diagnostic sink. The pinned native plugin App is only
 * `{name, version, channel}` and exposes no logger, so web-tools writes bounded
 * lines through console instead of a fabricated host API; credential values are
 * never included and every line is length-bounded.
 */
export function createWebToolsLog(options?: {
  readonly write?: (line: string) => void;
}): (event: WebToolsDiagnostic) => void {
  const write = options?.write ?? ((line: string) => console.error(line));
  return (event) => {
    const extra = event.extra === undefined ? "" : ` ${JSON.stringify(event.extra)}`;
    const line = `[web-tools][${event.level}] ${event.message}${extra}`;
    write(line.length > 1000 ? `${line.slice(0, 1000)}…` : line);
  };
}

function diagnosticsFor(
  capture: FamilyCapture,
  resolved: ReturnType<typeof resolveWebRuntimeConfig>,
  log: (event: WebToolsDiagnostic) => void,
): void {
  log({
    level: "info",
    message: "web tools configuration loaded",
    extra: {
      familyId: capture.familyId,
      searchProvider: resolved.search.provider,
      ...(resolved.search.provider === "zai" ? { searchRegion: resolved.search.region } : {}),
      searchCredentialSource: resolved.search.credential?.source ?? "missing",
      fetchProvider: resolved.fetch.provider,
      ...(resolved.fetch.provider === "zai" ? { fetchRegion: resolved.fetch.region } : {}),
      fetchCredentialSource:
        resolved.fetch.provider === "native"
          ? "not-required"
          : (resolved.fetch.credential?.source ?? "missing"),
    },
  });
  for (const warning of resolved.warnings) {
    log({ level: "warn", message: warning });
  }
}

// START_BLOCK_POLICY
/** Resolve the bound-family web-tools policy; never falls back to current/default config. */
async function resolvePolicy(
  runtime: NativeSnapshotRuntime,
  sessionID: string,
  log: (event: WebToolsDiagnostic) => void,
): Promise<WebToolsPolicyDecision> {
  const read = async (): Promise<FamilyCapture | undefined> => {
    try {
      return await runtime.snapshots.configFor(sessionID);
    } catch {
      return undefined;
    }
  };
  let capture = await read();
  if (capture === undefined) {
    try {
      await runtime.snapshots.accept({ sessionID });
    } catch {
      // fall through to the second read; absence is unknown policy below
    }
    capture = await read();
  }
  if (capture === undefined) return undefined;
  if (!isVvocPluginEnabled(capture.vvoc, "web-tools")) return "disabled";
  let resolved: ReturnType<typeof resolveWebRuntimeConfig>;
  try {
    resolved = resolveWebRuntimeConfig({
      config: capture.vvoc,
      source: { kind: "project" },
      warnings: [],
    });
  } catch {
    // A corrupt captured config is unknown policy, never silently disabled.
    return undefined;
  }
  diagnosticsFor(capture, resolved, log);
  return { resolved, permission: runtime.permissions };
}
// END_BLOCK_POLICY

export interface WebToolsPluginOptions {
  /** Test-only injectable runtime acquisition. Default acquires the real shared runtime. */
  acquireRuntime?: (ctx: NativeSnapshotContext) => Promise<NativeSnapshotRuntime>;
  /** Test-only diagnostic sink override; defaults to the console sink. */
  log?: (event: WebToolsDiagnostic) => void;
}

/** Native web-tools plugin factory; the default export uses the real shared runtime. */
export function createWebToolsPlugin(options: WebToolsPluginOptions = {}): Plugin.Plugin {
  return Plugin.define({
    id: "vvoc.web-tools",
    setup: async (ctx) => {
      const acquire =
        options.acquireRuntime ?? ((c: NativeSnapshotContext) => acquireNativeSnapshotRuntime(c));
      const runtime = await acquire(ctx as unknown as NativeSnapshotContext);
      const log = options.log ?? createWebToolsLog();
      // Diagnostic only: inspect the selected current config source read-only to
      // warn about a git-tracked literal apiKey. This never influences provider
      // selection or the captured policy, and never logs a key value.
      try {
        const effective = runtime.effectiveConfig();
        if (effective.sourcePath !== undefined) {
          const warning = warnIfSecretBearingProjectConfigTracked({
            config: effective.vvoc,
            source: { kind: "project", path: effective.sourcePath },
          });
          if (warning !== undefined) log({ level: "warn", message: warning });
        } else if (effective.vvoc.web?.search?.apiKey || effective.vvoc.web?.fetch?.apiKey) {
          log({
            level: "info",
            message:
              "web-tools config source unknown; cannot determine whether a literal apiKey is git-tracked.",
          });
        }
      } catch {
        // Best-effort diagnostic; a failure never affects registration or execution.
      }
      const runtimeSurface: WebToolsRuntime = {
        resolve: (sessionID) => resolvePolicy(runtime, sessionID, log),
      };
      const nativeDefinitions = new Map<string, NativeToolDefinition>();

      const toolRegistration = await ctx.tool.transform((editor) =>
        registerWebTools(editor, { runtime: runtimeSurface }),
      );
      const selectVisibility = async (event: {
        sessionID: string;
        tools?: Record<string, unknown>;
      }): Promise<void> => {
        const decision = await resolvePolicy(runtime, event.sessionID, log);
        if (event.tools === undefined) return;
        applyWebToolVisibility(decision, event.tools, nativeDefinitions);
      };
      const contextRegistration = await ctx.session.hook("context", (event) =>
        selectVisibility(event as never),
      );
      const compactionRegistration = await ctx.session.hook("compaction", (event) =>
        selectVisibility(event as never),
      );
      const generateRegistration = await ctx.session.hook("generate", (event) =>
        selectVisibility(event as never),
      );
      return async () => {
        await generateRegistration.dispose();
        await compactionRegistration.dispose();
        await contextRegistration.dispose();
        await toolRegistration.dispose();
        await runtime.release();
      };
    },
  });
}

export const WebToolsPlugin: Plugin.Plugin = createWebToolsPlugin();
export default WebToolsPlugin;
