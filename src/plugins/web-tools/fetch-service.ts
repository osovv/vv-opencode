// FILE: src/plugins/web-tools/fetch-service.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Build the provider-neutral web_fetch tool: strict contract validation with explicit execute-time defaults, URL scheme/shape rejection, permission request, provider dispatch, and structured text or attachment results.
//   SCOPE: web_fetch ToolDefinition factory plus provider result mapping. Validates raw host-forwarded arguments through the shared web_fetch contract before any permission request, credential lookup, or provider dispatch; delegates retrieval and conversion to the native, Spider, and direct Z.AI adapters.
//   DEPENDS: [@opencode-ai/plugin, src/lib/agent-tool-contract.ts, src/plugins/web-tools/config.ts, src/plugins/web-tools/schemas.ts, src/plugins/web-tools/providers/native-fetch.ts, src/plugins/web-tools/providers/spider.ts, src/plugins/web-tools/providers/zai.ts, src/plugins/web-tools/providers/exa.ts]
//   LINKS: M-WEB-FETCH-SERVICE, M-WEB-NATIVE-FETCH, M-WEB-SPIDER, M-WEB-ZAI, M-WEB-MEDIA-LOADER, M-WEB-EXA, M-PLUGIN-WEB-TOOLS, M-AGENT-TOOL-CONTRACT, V-M-WEB-FETCH-SERVICE, DF-WEB-FETCH
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WEB_FETCH_DEFAULT_TIMEOUT_SECONDS - Default per-call timeout in seconds (re-exported from schemas).
//   WEB_FETCH_MAX_TIMEOUT_SECONDS - Maximum model-configurable timeout in seconds (re-exported from schemas).
//   createWebFetchTool - Create the web_fetch ToolDefinition bound to a resolved fetch config.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-006 - Registered web_fetch from the shared schemas.ts contract and validated URL shape/scheme plus re-applied the documented format/timeout defaults at the execute boundary before any permission request or dispatch.]
// END_CHANGE_SUMMARY

import {
  tool,
  type ToolAttachment,
  type ToolDefinition,
  type ToolResult,
} from "@opencode-ai/plugin";
import { ContractInputError } from "../../lib/agent-tool-contract.js";
import type { ResolvedWebFetchConfig } from "./config.js";
import { WebProviderError } from "./providers/exa.js";
import { fetchNative, type NativeFetchOutcome } from "./providers/native-fetch.js";
import { scrapeSpider, type SpiderOutcome } from "./providers/spider.js";
import { fetchZai, type ZaiReaderOutcome } from "./providers/zai.js";
import {
  WEB_FETCH_TOOL_ID,
  validateWebFetchToolInput,
  webFetchArgs,
  webFetchContract,
  type WebFetchFormat,
} from "./schemas.js";

export { WEB_FETCH_DEFAULT_TIMEOUT_SECONDS, WEB_FETCH_MAX_TIMEOUT_SECONDS } from "./schemas.js";

// START_BLOCK_RESULT_MAPPING
function mediaSummary(attachment: ToolAttachment): string {
  const name = attachment.filename ? `\`${attachment.filename}\`` : "the requested resource";
  return `Fetched ${name} as a ${attachment.mime} attachment.`;
}

function nativeResult(
  url: string,
  format: WebFetchFormat,
  outcome: NativeFetchOutcome,
): Exclude<ToolResult, string> {
  if (outcome.kind === "media") {
    return {
      title: `web_fetch: ${url}`,
      output: mediaSummary(outcome.attachment),
      attachments: [outcome.attachment],
      metadata: { provider: "native", format, status: outcome.status },
    };
  }
  return {
    title: `web_fetch: ${url}`,
    output: outcome.content,
    metadata: { provider: "native", format, status: outcome.status },
  };
}

function spiderResult(
  url: string,
  format: WebFetchFormat,
  credentialSource: "env" | "config",
  outcome: SpiderOutcome,
): Exclude<ToolResult, string> {
  const metadata = {
    provider: "spider",
    format,
    credentialSource,
    ...outcome.metadata,
  };
  if (outcome.kind === "media") {
    return {
      title: `web_fetch: ${url}`,
      output: mediaSummary(outcome.attachment),
      attachments: [outcome.attachment],
      metadata,
    };
  }
  return { title: `web_fetch: ${url}`, output: outcome.content, metadata };
}

function zaiResult(
  url: string,
  format: WebFetchFormat,
  region: "international" | "china",
  credentialSource: "env" | "config",
  outcome: ZaiReaderOutcome,
): Exclude<ToolResult, string> {
  const metadata = {
    provider: "zai",
    region,
    format,
    credentialSource,
    ...outcome.metadata,
  };
  if (outcome.kind === "media") {
    return {
      title: `web_fetch: ${url}`,
      output: mediaSummary(outcome.attachment),
      attachments: [outcome.attachment],
      metadata,
    };
  }
  return { title: `web_fetch: ${url}`, output: outcome.content, metadata };
}
// END_BLOCK_RESULT_MAPPING

/**
 * Create the web_fetch tool bound to the resolved fetch configuration.
 * execute validates raw host-forwarded arguments through the shared strict contract first, so
 * unknown keys, invalid provided values, and unsupported or malformed URLs reject with a
 * bounded field diagnostic before any permission request, credential lookup, or provider
 * dispatch; the documented format/timeout defaults are re-applied here because the host
 * forwards unparsed raw arguments. Permission uses key web_fetch with patterns [url]. Textual
 * extraction routes to native, Spider, or direct Z.AI reader; media returns as an attachment
 * with a short Markdown summary in the same ToolResult and reports metadata
 * { provider, format, credentialSource?, status?, durationMs? }.
 * Native fetch requires no credential; Spider and Z.AI validate credentials at execution time
 * with actionable messages naming the environment variable and web.fetch.apiKey.
 */
export function createWebFetchTool(resolved: ResolvedWebFetchConfig): ToolDefinition {
  return tool({
    description: webFetchContract.description,
    args: webFetchArgs,
    async execute(args, context) {
      const validation = validateWebFetchToolInput(args);
      if (!validation.ok) {
        throw new ContractInputError(WEB_FETCH_TOOL_ID, validation.issues);
      }
      const { url, format, timeout: timeoutSeconds } = validation.data;

      await context.ask({
        permission: "web_fetch",
        patterns: [url],
        always: [],
        metadata: { provider: resolved.provider, format },
      });

      const timeoutMs = timeoutSeconds * 1000;
      if (resolved.provider === "native") {
        const outcome = await fetchNative({
          url,
          format,
          abort: context.abort,
          timeoutMs,
        });
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
          abort: context.abort,
          timeoutMs,
        });
        return zaiResult(url, format, resolved.region, resolved.credential.source, outcome);
      }
      const outcome = await scrapeSpider({
        url,
        format,
        credential: resolved.credential,
        abort: context.abort,
        timeoutMs,
      });
      return spiderResult(url, format, resolved.credential.source, outcome);
    },
  });
}
