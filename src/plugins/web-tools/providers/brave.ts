// FILE: src/plugins/web-tools/providers/brave.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Call the Brave Web Search endpoint directly and normalize web results for the web_search tool.
//   SCOPE: Brave request construction with X-Subscription-Token auth, count and freshness mapping, moderate safe search, and web result normalization.
//   DEPENDS: [src/plugins/web-tools/http.ts, src/plugins/web-tools/providers/exa.ts]
//   LINKS: [M-WEB-BRAVE, M-WEB-HTTP, M-WEB-SEARCH-SERVICE]
//   ROLE: INTEGRATION
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   searchBrave - Execute one Brave Web Search.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial Brave Web Search adapter.]
// END_CHANGE_SUMMARY

import {
  DEFAULT_TEXT_MAX_BYTES,
  requestBounded,
  type BoundedHttpResponse,
  type FetchLike,
} from "../http.js";
import {
  mapHttpErrorToProviderError,
  WebProviderError,
  type WebSearchInput,
  type WebSearchResult,
} from "./exa.js";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

const BRAVE_FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" } as const;

// START_BLOCK_HELPERS
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBraveResult(item: unknown): WebSearchResult | undefined {
  if (!isPlainObject(item)) {
    return undefined;
  }
  const url = typeof item.url === "string" ? item.url : undefined;
  if (!url) {
    return undefined;
  }
  const title = typeof item.title === "string" && item.title.length > 0 ? item.title : url;
  const snippet =
    typeof item.description === "string" && item.description.length > 0
      ? item.description
      : undefined;
  const publishedAt = typeof item.page_age === "string" ? item.page_age : undefined;
  return {
    title,
    url,
    ...(snippet ? { snippet } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

function parseBraveResults(bytes: Uint8Array): WebSearchResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WebProviderError("brave", "BAD_RESPONSE", "malformed JSON response from brave");
  }
  const web = isPlainObject(parsed) ? parsed.web : undefined;
  const results =
    isPlainObject(web) && Array.isArray(web.results) ? (web.results as unknown[]) : undefined;
  if (!results) {
    throw new WebProviderError("brave", "BAD_RESPONSE", "unexpected brave response envelope");
  }
  return results
    .map(normalizeBraveResult)
    .filter((result): result is WebSearchResult => result !== undefined);
}
// END_BLOCK_HELPERS

// START_CONTRACT: searchBrave
//   PURPOSE: GET the Brave Web Search endpoint with X-Subscription-Token auth and normalize web.results.
//   INPUTS: { input: WebSearchInput; fetchImpl: injectable fetch }
//   OUTPUTS: { WebSearchResult[] - ranked results, empty array when none }
//   SIDE_EFFECTS: performs network I/O through fetchImpl; never logs the credential
//   LINKS: M-WEB-SEARCH-SERVICE
// END_CONTRACT: searchBrave
export async function searchBrave(
  input: WebSearchInput,
  fetchImpl?: FetchLike,
): Promise<WebSearchResult[]> {
  const params = new URLSearchParams();
  params.set("q", input.query);
  params.set("count", String(input.count));
  params.set("safesearch", "moderate");
  if (input.freshness) {
    params.set("freshness", BRAVE_FRESHNESS[input.freshness]);
  }
  const url = `${BRAVE_SEARCH_URL}?${params.toString()}`;

  let response: BoundedHttpResponse;
  try {
    response = await requestBounded(
      {
        url,
        method: "GET",
        headers: {
          "X-Subscription-Token": input.credential.value,
          accept: "application/json",
        },
        timeoutMs: input.timeoutMs,
        maxBytes: DEFAULT_TEXT_MAX_BYTES,
        abort: input.abort,
      },
      fetchImpl,
    );
  } catch (error) {
    mapHttpErrorToProviderError(error, "brave");
    throw error;
  }

  return parseBraveResults(response.bytes);
}
