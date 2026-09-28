// FILE: src/plugins/web-tools/fetch-service.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Build the provider-neutral native web_fetch tool: strict contract validation with explicit execute-time defaults, URL scheme/shape rejection, per-family captured policy/config resolution, awaited resource permission before any network effect, provider dispatch, and structured text or native file-content results.
//   SCOPE: Native Tool.Info factory plus provider result mapping. Validates raw host-forwarded arguments through the shared web_fetch contract before any permission request, credential lookup, or provider dispatch; awaits a resource-specific permission; delegates retrieval and conversion to the native, Spider, and direct Z.AI adapters. Media attachments map to native Tool file content covering data-URI binary payloads. No V1 ToolDefinition/context.ask, no startup-global toggle.
//   DEPENDS: [@opencode/plugin/promise/tool, zod, src/lib/agent-tool-contract.ts, src/plugins/web-tools/config.ts, src/plugins/web-tools/schemas.ts, src/plugins/web-tools/search-service.ts (WebPermissionGuard/WebToolsRuntime), src/plugins/web-tools/providers/native-fetch.ts, src/plugins/web-tools/providers/spider.ts, src/plugins/web-tools/providers/zai.ts, src/plugins/web-tools/providers/exa.ts]
//   LINKS: [M-WEB-FETCH-SERVICE, M-WEB-NATIVE-FETCH, M-WEB-SPIDER, M-WEB-ZAI, M-WEB-MEDIA-LOADER, M-WEB-EXA, M-PLUGIN-WEB-TOOLS, M-AGENT-TOOL-CONTRACT, V-M-WEB-FETCH-SERVICE, DF-WEB-FETCH]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WEB_FETCH_DEFAULT_TIMEOUT_SECONDS - Default per-call timeout in seconds (re-exported from schemas).
//   WEB_FETCH_MAX_TIMEOUT_SECONDS - Maximum model-configurable timeout in seconds (re-exported from schemas).
//   executeWebFetch - Execute one validated fetch against a resolved config and permission guard.
//   createWebFetchToolForConfig - Create a web_fetch tool pre-bound to one resolved config (tests/direct).
//   createWebFetchTool - Create the native web_fetch tool bound to a per-session policy resolver.
//   MappedResult - Native Tool.Result shape emitted by web_fetch.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-005 attempt 2 - Split per-provider execution from a per-session policy resolver so a startup-global toggle can no longer hijack a disabled captured family or block a later enabled one.]
// END_CHANGE_SUMMARY

import { z } from "zod";
import type { ToolContext as NativeToolContext } from "@opencode/plugin/promise/tool";
import { ContractInputError, type OwnedToolAttachment } from "../../lib/agent-tool-contract.js";
import type { ResolvedWebFetchConfig } from "./config.js";
import { WebProviderError } from "./providers/exa.js";
import { fetchNative, type NativeFetchOutcome } from "./providers/native-fetch.js";
import { scrapeSpider, type SpiderOutcome } from "./providers/spider.js";
import { fetchZai, type ZaiReaderOutcome } from "./providers/zai.js";
import {
  WebToolsPolicyError,
  type WebPermissionGuard,
  type WebToolsRuntime,
} from "./search-service.js";
import {
  WEB_FETCH_TOOL_ID,
  validateWebFetchToolInput,
  webFetchContract,
  type WebFetchFormat,
} from "./schemas.js";

export { WEB_FETCH_DEFAULT_TIMEOUT_SECONDS, WEB_FETCH_MAX_TIMEOUT_SECONDS } from "./schemas.js";

type NativeToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string };

// START_BLOCK_RESULT_MAPPING
function mediaSummary(attachment: OwnedToolAttachment): string {
  const name = attachment.filename ? `\`${attachment.filename}\`` : "the requested resource";
  return `Fetched ${name} as a ${attachment.mime} attachment.`;
}

/** Map a host-neutral attachment to a native Tool file-content frame (data-URI payload preserved). */
function fileContent(attachment: OwnedToolAttachment): NativeToolContent {
  return {
    type: "file",
    uri: attachment.url,
    mime: attachment.mime,
    ...(attachment.filename === undefined ? {} : { name: attachment.filename }),
  };
}

export interface MappedResult {
  readonly output: string;
  readonly content: string | ReadonlyArray<NativeToolContent>;
  readonly metadata: Record<string, unknown>;
}

function nativeResult(
  url: string,
  format: WebFetchFormat,
  outcome: NativeFetchOutcome,
): MappedResult {
  if (outcome.kind === "media") {
    return {
      output: mediaSummary(outcome.attachment),
      content: [fileContent(outcome.attachment)],
      metadata: { provider: "native", format, status: outcome.status },
    };
  }
  return {
    output: outcome.content,
    content: outcome.content,
    metadata: { provider: "native", format, status: outcome.status },
  };
}

function spiderResult(
  url: string,
  format: WebFetchFormat,
  credentialSource: "env" | "config",
  outcome: SpiderOutcome,
): MappedResult {
  const metadata = {
    provider: "spider",
    format,
    credentialSource,
    ...outcome.metadata,
  };
  if (outcome.kind === "media") {
    return {
      output: mediaSummary(outcome.attachment),
      content: [fileContent(outcome.attachment)],
      metadata,
    };
  }
  return { output: outcome.content, content: outcome.content, metadata };
}

function zaiResult(
  url: string,
  format: WebFetchFormat,
  region: "international" | "china",
  credentialSource: "env" | "config",
  outcome: ZaiReaderOutcome,
): MappedResult {
  const metadata = {
    provider: "zai",
    region,
    format,
    credentialSource,
    ...outcome.metadata,
  };
  if (outcome.kind === "media") {
    return {
      output: mediaSummary(outcome.attachment),
      content: [fileContent(outcome.attachment)],
      metadata,
    };
  }
  return { output: outcome.content, content: outcome.content, metadata };
}
// END_BLOCK_RESULT_MAPPING

/**
 * Execute one web_fetch against an already-resolved config. Validates raw
 * host-forwarded arguments through the shared strict contract first, so unknown
 * keys, invalid provided values, and unsupported or malformed URLs reject with a
 * bounded field diagnostic before any permission request, credential lookup, or
 * provider dispatch; the documented format/timeout defaults are re-applied here
 * because the host forwards unparsed raw arguments. The awaited permission is
 * resource-specific (url pattern) and runs before any network effect.
 */
export async function executeWebFetch(
  resolved: ResolvedWebFetchConfig,
  permission: WebPermissionGuard,
  args: unknown,
  context: NativeToolContext,
): Promise<MappedResult> {
  const validation = validateWebFetchToolInput(args);
  if (!validation.ok) {
    throw new ContractInputError(WEB_FETCH_TOOL_ID, validation.issues);
  }
  const { url, format, timeout: timeoutSeconds } = validation.data;

  return permission.guard(
    {
      sessionID: context.sessionID,
      action: "web_fetch",
      resources: [url],
      metadata: { provider: resolved.provider, format },
      ...(context.agent === undefined ? {} : { agent: context.agent }),
    },
    async () => {
      const timeoutMs = timeoutSeconds * 1000;
      if (resolved.provider === "native") {
        const outcome = await fetchNative({ url, format, abort: context.signal, timeoutMs });
        return nativeResult(url, format, outcome);
      }
      if (!resolved.credential) {
        throw new WebProviderError(
          resolved.provider,
          "MISSING_CREDENTIAL",
          `missing credential for ${resolved.provider}: set ${resolved.envVar ?? "SPIDER_API_KEY"} or ${resolved.configField ?? "web.fetch.apiKey"}`,
        );
      }
      if (resolved.provider === "zai") {
        if (!resolved.region) {
          throw new Error("web.fetch.region is required when provider is zai");
        }
        const outcome = await fetchZai({
          url,
          format,
          region: resolved.region,
          credential: resolved.credential,
          abort: context.signal,
          timeoutMs,
        });
        return zaiResult(url, format, resolved.region, resolved.credential.source, outcome);
      }
      const outcome = await scrapeSpider({
        url,
        format,
        credential: resolved.credential,
        abort: context.signal,
        timeoutMs,
      });
      return spiderResult(url, format, resolved.credential.source, outcome);
    },
    { signal: context.signal },
  );
}

/** Create a web_fetch tool pre-bound to one resolved config (direct/deterministic tests and callers). */
export function createWebFetchToolForConfig(
  resolved: ResolvedWebFetchConfig,
  permission: WebPermissionGuard,
): {
  name: string;
  description: string;
  input: typeof webFetchContract.runtimeSchema;
  output: z.ZodString;
  options: { codemode: false };
  execute: (args: unknown, context: NativeToolContext) => Promise<MappedResult>;
} {
  return {
    name: WEB_FETCH_TOOL_ID,
    description: webFetchContract.description,
    input: webFetchContract.runtimeSchema,
    output: z.string(),
    options: { codemode: false },
    execute: (args, context) => executeWebFetch(resolved, permission, args, context),
  };
}

/**
 * Create the native web_fetch tool bound to a per-session policy resolver.
 * A disabled or unknown family policy refuses the owned provider-bound path.
 */
export function createWebFetchTool(runtime: WebToolsRuntime): {
  name: string;
  description: string;
  input: typeof webFetchContract.runtimeSchema;
  output: z.ZodString;
  options: { codemode: false };
  execute: (args: unknown, context: NativeToolContext) => Promise<MappedResult>;
} {
  return {
    name: WEB_FETCH_TOOL_ID,
    description: webFetchContract.description,
    input: webFetchContract.runtimeSchema,
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
      return executeWebFetch(decision.resolved.fetch, decision.permission, args, context);
    },
  };
}
