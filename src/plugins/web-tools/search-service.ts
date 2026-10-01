// FILE: src/plugins/web-tools/search-service.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Build the provider-neutral native web_search tool: strict contract validation with explicit execute-time defaults, per-family captured policy/config resolution, awaited resource permission before any network effect, provider dispatch, and ranked Markdown rendering.
//   SCOPE: Native tool Info factory, per-session policy seams (enabled/disabled/unknown), and Markdown rendering. Validates raw host-forwarded arguments through the shared web_search contract before any permission request or provider dispatch, requests a resource-specific native permission through an injected guard, then delegates transport to the Exa, Brave, and direct Z.AI adapters. No V1 ToolDefinition/context.ask, no startup-global toggle, no credential or provider arguments.
//   DEPENDS: [@opencode/plugin/promise/tool, zod, src/lib/agent-tool-contract.ts, src/plugins/web-tools/config.ts, src/plugins/web-tools/schemas.ts, src/plugins/web-tools/http.ts, src/plugins/web-tools/providers/brave.ts, src/plugins/web-tools/providers/exa.ts, src/plugins/web-tools/providers/zai.ts]
//   LINKS: [M-WEB-SEARCH-SERVICE, M-WEB-EXA, M-WEB-BRAVE, M-WEB-ZAI, M-WEB-HTTP, M-PLUGIN-WEB-TOOLS, M-AGENT-TOOL-CONTRACT, V-M-WEB-SEARCH-SERVICE, DF-WEB-SEARCH]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WebPermissionGuard - Narrow resource-permission guard consumed before any network effect.
//   WebToolsPolicyDecision - Per-session enabled/disabled/unknown policy decision.
//   WebToolsRuntime - Per-session policy resolver seam consumed by the registered tools.
//   WebToolsPolicyError - Provider-bound web tool refused because no enabled policy is bound.
//   renderSearchMarkdown - Render ranked search results as Markdown.
//   executeWebSearch - Execute one validated search against a resolved config and permission guard.
//   createWebSearchToolForConfig - Create a web_search tool pre-bound to one resolved config (tests/direct).
//   createWebSearchTool - Create the native web_search tool bound to a per-session policy resolver.
//   NativeWebToolContent - Native Tool.Result content frame.
//   WebToolExecutionResult - Native Tool.Result emitted by the web tools.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-005 attempt 2 - Split per-provider execution from a per-session policy resolver so a startup-global toggle can no longer hijack a disabled captured family or block a later enabled one.]
// END_CHANGE_SUMMARY

import { z } from "zod";
import type { ToolContext as NativeToolContext } from "@opencode/plugin/promise/tool";
import { ContractInputError } from "../../lib/agent-tool-contract.js";
import type { ResolvedWebConfig, ResolvedWebSearchConfig } from "./config.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./http.js";
import { searchBrave } from "./providers/brave.js";
import { searchExa, WebProviderError, type WebSearchResult } from "./providers/exa.js";
import { searchZai } from "./providers/zai.js";
import { WEB_SEARCH_TOOL_ID, validateWebSearchToolInput, webSearchContract } from "./schemas.js";

/** Narrow resource-permission guard consumed before any network effect. */
export interface WebPermissionGuard {
  guard<T>(
    input: {
      readonly sessionID: string;
      readonly action: string;
      readonly resources: ReadonlyArray<string>;
      readonly metadata?: Record<string, unknown> | undefined;
      readonly agent?: string | undefined;
    },
    effect: () => Promise<T> | T,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<T>;
}

/** Per-session policy decision: an enabled resolved config, an explicit captured disable, or unknown. */
export type WebToolsPolicyDecision =
  | { readonly resolved: ResolvedWebConfig; readonly permission: WebPermissionGuard }
  | "disabled"
  | undefined;

/** Per-session policy resolver seam consumed by the registered tools. */
export interface WebToolsRuntime {
  resolve(sessionID: string): Promise<WebToolsPolicyDecision>;
}

/** Provider-bound web tool refused because no enabled captured policy is bound. */
export class WebToolsPolicyError extends Error {
  readonly code = "WEB_TOOLS_POLICY";

  constructor(message: string) {
    super(message);
    this.name = "WebToolsPolicyError";
  }
}

/** Native Tool.Result content frame emitted by the web tools. */
export type NativeWebToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string };

/** Native Tool.Result emitted by the web tools (output is the structured string, content the model-facing payload). */
export interface WebToolExecutionResult {
  readonly output: string;
  readonly content: string | ReadonlyArray<NativeWebToolContent>;
  readonly metadata: Record<string, unknown>;
}

/**
 * Render ranked results as Markdown: numbered entries with [title](url),
 * an indented snippet line when present, and an italic publishedAt line when present.
 * Empty results render a short no-results notice.
 */
export function renderSearchMarkdown(results: WebSearchResult[]): string {
  if (results.length === 0) {
    return "No results found.";
  }
  return results
    .map((result, index) => {
      const lines = [`${index + 1}. [${result.title}](${result.url})`];
      if (result.snippet) {
        lines.push(`   ${result.snippet}`);
      }
      if (result.publishedAt) {
        lines.push(`   _${result.publishedAt}_`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * Execute one web_search against an already-resolved config. Validates raw
 * host-forwarded arguments through the shared strict contract first, so unknown
 * keys, invalid provided values, and out-of-range counts reject with a bounded
 * diagnostic before any permission request, credential lookup, or provider
 * dispatch. The documented count default is re-applied here because the host
 * forwards unparsed raw arguments. The awaited permission is resource-specific
 * (query pattern) and runs before any network effect, so a denied or aborted
 * decision yields zero requests.
 */
export async function executeWebSearch(
  resolved: ResolvedWebSearchConfig,
  permission: WebPermissionGuard,
  args: unknown,
  context: NativeToolContext,
): Promise<WebToolExecutionResult> {
  const validation = validateWebSearchToolInput(args);
  if (!validation.ok) {
    throw new ContractInputError(WEB_SEARCH_TOOL_ID, validation.issues);
  }
  const { query, count, freshness } = validation.data;

  return permission.guard(
    {
      sessionID: context.sessionID,
      action: "web_search",
      resources: [query],
      metadata: { provider: resolved.provider },
      ...(context.agent === undefined ? {} : { agent: context.agent }),
    },
    async () => {
      if (!resolved.credential) {
        throw new WebProviderError(
          resolved.provider,
          "MISSING_CREDENTIAL",
          `missing credential for ${resolved.provider}: set ${resolved.envVar} or ${resolved.configField}`,
        );
      }
      const searchInput = {
        query,
        count,
        freshness,
        credential: resolved.credential,
        abort: context.signal,
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      };
      const results =
        resolved.provider === "brave"
          ? await searchBrave(searchInput)
          : resolved.provider === "zai"
            ? await searchZai({ ...searchInput, region: resolved.region })
            : await searchExa(searchInput);
      const rendered = renderSearchMarkdown(results);
      return {
        output: rendered,
        content: rendered,
        metadata: {
          provider: resolved.provider,
          ...(resolved.provider === "zai" ? { region: resolved.region } : {}),
          resultCount: results.length,
          credentialSource: resolved.credential.source,
        },
      };
    },
    { signal: context.signal },
  );
}

/** Create a web_search tool pre-bound to one resolved config (direct/deterministic tests and callers). */
export function createWebSearchToolForConfig(
  resolved: ResolvedWebSearchConfig,
  permission: WebPermissionGuard,
): {
  name: string;
  description: string;
  input: typeof webSearchContract.runtimeSchema;
  output: z.ZodString;
  options: { codemode: false };
  execute: (args: unknown, context: NativeToolContext) => Promise<WebToolExecutionResult>;
} {
  return {
    name: WEB_SEARCH_TOOL_ID,
    description: webSearchContract.description,
    input: webSearchContract.runtimeSchema,
    output: z.string(),
    options: { codemode: false },
    execute: (args, context) => executeWebSearch(resolved, permission, args, context),
  };
}

/**
 * Create the native web_search tool bound to a per-session policy resolver.
 * A disabled or unknown family policy refuses the owned provider-bound path;
 * it never silently substitutes current/default config or a fabricated client.
 */
export function createWebSearchTool(runtime: WebToolsRuntime): {
  name: string;
  description: string;
  input: typeof webSearchContract.runtimeSchema;
  output: z.ZodString;
  options: { codemode: false };
  execute: (args: unknown, context: NativeToolContext) => Promise<WebToolExecutionResult>;
} {
  return {
    name: WEB_SEARCH_TOOL_ID,
    description: webSearchContract.description,
    input: webSearchContract.runtimeSchema,
    output: z.string(),
    options: { codemode: false },
    async execute(args, context) {
      const decision = await runtime.resolve(context.sessionID);
      if (decision === "disabled") {
        throw new WebToolsPolicyError(
          "web tools are disabled by the captured policy bound to this session.",
        );
      }
      if (decision === undefined) {
        throw new WebToolsPolicyError(
          "no trustworthy web-tools policy is bound to this session; refusing the provider-bound web path.",
        );
      }
      return executeWebSearch(decision.resolved.search, decision.permission, args, context);
    },
  };
}
