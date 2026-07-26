// FILE: src/plugins/web-tools/fetch-service.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Build the provider-neutral web_fetch tool: input validation, permission request, provider dispatch, and structured text or attachment results.
//   SCOPE: web_fetch ToolDefinition factory; delegates retrieval and conversion to the native and Spider adapters.
//   DEPENDS: [@opencode-ai/plugin, src/plugins/web-tools/config.ts, src/plugins/web-tools/providers/native-fetch.ts, src/plugins/web-tools/providers/spider.ts, src/plugins/web-tools/providers/exa.ts]
//   LINKS: [M-WEB-FETCH-SERVICE, M-WEB-NATIVE-FETCH, M-WEB-SPIDER, M-WEB-MEDIA-LOADER, M-PLUGIN-WEB-TOOLS]
//   ROLE: CORE_LOGIC
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WEB_FETCH_DEFAULT_TIMEOUT_SECONDS - Default per-call timeout in seconds.
//   WEB_FETCH_MAX_TIMEOUT_SECONDS - Maximum model-configurable timeout in seconds.
//   createWebFetchTool - Create the web_fetch ToolDefinition bound to a resolved fetch config.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial web_fetch tool service.]
// END_CHANGE_SUMMARY

import {
  tool,
  type ToolAttachment,
  type ToolDefinition,
  type ToolResult,
} from "@opencode-ai/plugin";
import type { ResolvedWebFetchConfig } from "./config.js";
import { WebProviderError } from "./providers/exa.js";
import { fetchNative, type NativeFetchOutcome } from "./providers/native-fetch.js";
import { scrapeSpider, type SpiderOutcome } from "./providers/spider.js";

const z = tool.schema;

export const WEB_FETCH_DEFAULT_TIMEOUT_SECONDS = 30;
export const WEB_FETCH_MAX_TIMEOUT_SECONDS = 120;

type FetchFormat = "markdown" | "text" | "html";

// START_BLOCK_RESULT_MAPPING
function mediaSummary(attachment: ToolAttachment): string {
  const name = attachment.filename ? `\`${attachment.filename}\`` : "the requested resource";
  return `Fetched ${name} as a ${attachment.mime} attachment.`;
}

function nativeResult(
  url: string,
  format: FetchFormat,
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
  format: FetchFormat,
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
// END_BLOCK_RESULT_MAPPING

/**
 * Create the web_fetch tool bound to the resolved fetch configuration.
 * execute validates http or https schemes, asks permission key web_fetch with patterns [url],
 * routes textual extraction to native or Spider, returns media as attachments with a short
 * Markdown summary in the same ToolResult, and reports metadata
 * { provider, format, credentialSource?, status?, durationMs? }.
 * Native fetch requires no credential; Spider validates its credential at execution time
 * with an actionable message naming SPIDER_API_KEY and web.fetch.apiKey.
 */
export function createWebFetchTool(resolved: ResolvedWebFetchConfig): ToolDefinition {
  return tool({
    description:
      "Fetch a known HTTP or HTTPS URL using the configured provider. Returns Markdown, text, raw HTML, or an image/PDF attachment.",
    args: {
      url: z.string().min(1).describe("The HTTP or HTTPS URL to retrieve."),
      format: z
        .enum(["markdown", "text", "html"])
        .default("markdown")
        .describe("Output format for textual resources; defaults to markdown."),
      timeout: z
        .number()
        .positive()
        .max(WEB_FETCH_MAX_TIMEOUT_SECONDS)
        .default(WEB_FETCH_DEFAULT_TIMEOUT_SECONDS)
        .describe("Timeout in seconds, greater than 0 and at most 120."),
    },
    async execute(args, context) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(args.url);
      } catch {
        throw new Error("web_fetch requires a valid HTTP or HTTPS URL");
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error(
          `web_fetch supports only HTTP and HTTPS URLs; received ${parsedUrl.protocol || "unknown scheme"}`,
        );
      }

      await context.ask({
        permission: "web_fetch",
        patterns: [args.url],
        always: [],
        metadata: { provider: resolved.provider, format: args.format },
      });

      const timeoutMs = args.timeout * 1000;
      if (resolved.provider === "native") {
        const outcome = await fetchNative({
          url: args.url,
          format: args.format,
          abort: context.abort,
          timeoutMs,
        });
        return nativeResult(args.url, args.format, outcome);
      }

      if (!resolved.credential) {
        throw new WebProviderError(
          "spider",
          "MISSING_CREDENTIAL",
          `missing credential for spider: set ${resolved.envVar ?? "SPIDER_API_KEY"} or ${resolved.configField ?? "web.fetch.apiKey"}`,
        );
      }
      const outcome = await scrapeSpider({
        url: args.url,
        format: args.format,
        credential: resolved.credential,
        abort: context.abort,
        timeoutMs,
      });
      return spiderResult(args.url, args.format, resolved.credential.source, outcome);
    },
  });
}
