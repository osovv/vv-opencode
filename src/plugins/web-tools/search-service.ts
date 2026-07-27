// FILE: src/plugins/web-tools/search-service.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Build the provider-neutral web_search tool: input validation, permission request, provider dispatch, and ranked Markdown rendering.
//   SCOPE: web_search ToolDefinition factory and Markdown rendering; delegates transport to the Exa, Brave, and direct Z.AI adapters.
//   DEPENDS: [@opencode-ai/plugin, src/plugins/web-tools/config.ts, src/plugins/web-tools/http.ts, src/plugins/web-tools/providers/exa.ts, src/plugins/web-tools/providers/brave.ts, src/plugins/web-tools/providers/zai.ts]
//   LINKS: M-WEB-SEARCH-SERVICE, M-WEB-EXA, M-WEB-BRAVE, M-WEB-ZAI, M-WEB-HTTP, M-PLUGIN-WEB-TOOLS, V-M-WEB-SEARCH-SERVICE, DF-WEB-SEARCH
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
//   LAST_CHANGE: [C-GRACE-INTEGRITY-AND-COVERAGE-REMEDIATION - Applied the declared count default inside execute when OpenCode omits schema defaults.]
// END_CHANGE_SUMMARY

import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { ResolvedWebSearchConfig } from "./config.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "./http.js";
import { searchBrave } from "./providers/brave.js";
import { searchExa, WebProviderError, type WebSearchResult } from "./providers/exa.js";
import { searchZai } from "./providers/zai.js";

const z = tool.schema;

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
 * execute asks permission key web_search with patterns [query], validates the credential
 * at execution time, dispatches to exa, brave, or direct zai, and returns a ToolResult with
 * title, Markdown output, and metadata { provider, region?, resultCount, credentialSource }.
 * Missing credentials raise an actionable error naming the environment variable
 * and the web.search.apiKey config field without printing any value.
 */
export function createWebSearchTool(resolved: ResolvedWebSearchConfig): ToolDefinition {
  return tool({
    description:
      "Search the web using the configured provider and return ranked results as Markdown. Use for discovering information; returns titles, URLs, snippets, and dates.",
    args: {
      query: z.string().min(1).describe("The search query."),
      count: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(8)
        .describe("Number of results, 1 through 20, default 8."),
      freshness: z
        .enum(["day", "week", "month", "year"])
        .optional()
        .describe("Optional time window restricting results."),
    },
    async execute(args, context) {
      const count = args.count ?? 8;

      await context.ask({
        permission: "web_search",
        patterns: [args.query],
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
        query: args.query,
        count,
        freshness: args.freshness,
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
        title: `web_search: ${args.query}`,
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
