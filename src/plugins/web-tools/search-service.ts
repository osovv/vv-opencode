// FILE: src/plugins/web-tools/search-service.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Build the provider-neutral web_search tool: strict contract validation with explicit execute-time defaults, permission request, provider dispatch, and ranked Markdown rendering.
//   SCOPE: web_search ToolDefinition factory and Markdown rendering. Validates raw host-forwarded arguments through the shared web_search contract before any permission request or provider dispatch, then delegates transport to the Exa, Brave, and direct Z.AI adapters. No credential or provider arguments and no content rewriting.
//   DEPENDS: [@opencode-ai/plugin, src/lib/agent-tool-contract.ts, src/plugins/web-tools/config.ts, src/plugins/web-tools/schemas.ts, src/plugins/web-tools/http.ts, src/plugins/web-tools/providers/exa.ts, src/plugins/web-tools/providers/brave.ts, src/plugins/web-tools/providers/zai.ts]
//   LINKS: M-WEB-SEARCH-SERVICE, M-WEB-EXA, M-WEB-BRAVE, M-WEB-ZAI, M-WEB-HTTP, M-PLUGIN-WEB-TOOLS, M-AGENT-TOOL-CONTRACT, V-M-WEB-SEARCH-SERVICE, DF-WEB-SEARCH
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   renderSearchMarkdown - Render ranked search results as Markdown.
//   createWebSearchTool - Create the web_search ToolDefinition bound to a resolved search config.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-006 - Registered web_search from the shared schemas.ts contract, validated raw args and re-applied the documented count default at the execute boundary before any permission request or dispatch.]
// END_CHANGE_SUMMARY

import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { ContractInputError } from "../../lib/agent-tool-contract.js";
import type { ResolvedWebSearchConfig } from "./config.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./http.js";
import { searchBrave } from "./providers/brave.js";
import { searchExa, WebProviderError, type WebSearchResult } from "./providers/exa.js";
import { searchZai } from "./providers/zai.js";
import {
  WEB_SEARCH_TOOL_ID,
  validateWebSearchToolInput,
  webSearchArgs,
  webSearchContract,
} from "./schemas.js";

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
 * Create the web_search tool bound to the resolved search configuration.
 * execute validates raw host-forwarded arguments through the shared strict contract first,
 * so unknown keys, invalid provided values, and out-of-range counts reject with a bounded
 * diagnostic before any permission request, credential lookup, or provider dispatch.
 * The documented count default is re-applied here because the host forwards unparsed raw
 * arguments. Permission uses key web_search with patterns [query], and the result reports
 * metadata { provider, region?, resultCount, credentialSource }.
 * Missing credentials raise an actionable error naming the environment variable
 * and the web.search.apiKey config field without printing any value.
 */
export function createWebSearchTool(resolved: ResolvedWebSearchConfig): ToolDefinition {
  return tool({
    description: webSearchContract.description,
    args: webSearchArgs,
    async execute(args, context) {
      const validation = validateWebSearchToolInput(args);
      if (!validation.ok) {
        throw new ContractInputError(WEB_SEARCH_TOOL_ID, validation.issues);
      }
      const { query, count, freshness } = validation.data;

      await context.ask({
        permission: "web_search",
        patterns: [query],
        always: [],
        metadata: { provider: resolved.provider },
      });

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
        abort: context.abort,
        timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      };
      const results =
        resolved.provider === "brave"
          ? await searchBrave(searchInput)
          : resolved.provider === "zai"
            ? await searchZai({ ...searchInput, region: resolved.region })
            : await searchExa(searchInput);

      return {
        title: `web_search: ${query}`,
        output: renderSearchMarkdown(results),
        metadata: {
          provider: resolved.provider,
          ...(resolved.provider === "zai" ? { region: resolved.region } : {}),
          resultCount: results.length,
          credentialSource: resolved.credential.source,
        },
      };
    },
  });
}
