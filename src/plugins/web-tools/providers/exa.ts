// FILE: src/plugins/web-tools/providers/exa.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Call the official Exa Search API directly and normalize ranked results for the web_search tool.
//   SCOPE: Exa request construction with x-api-key auth, count and freshness mapping, result normalization, and provider error mapping. Also owns the shared provider search types and WebProviderError used by sibling adapters.
//   DEPENDS: [src/plugins/web-tools/http.ts, src/plugins/web-tools/config.ts]
//   LINKS: [M-WEB-EXA, M-WEB-HTTP, M-WEB-SEARCH-SERVICE]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WebProviderName - Provider identifiers for error attribution.
//   WebProviderErrorCode - Provider-facing error codes.
//   WebProviderError - Provider error carrying provider, code, and optional status.
//   WebSearchResult - Normalized ranked search result.
//   WebSearchInput - Provider-neutral search input.
//   mapHttpErrorToProviderError - Map bounded HTTP status failures into credential-safe provider errors.
//   searchExa - Execute one Exa search.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-ZAI-DIRECT-WEB-PROVIDERS - Extended shared provider error attribution with the direct zai adapter.]
//   LAST_CHANGE: [v1.0.0 - Initial Exa Search API adapter and shared provider search contracts.]
// END_CHANGE_SUMMARY

import type { WebProviderCredential } from "../config.js";
import {
  DEFAULT_TEXT_MAX_BYTES,
  requestBounded,
  WebHttpError,
  type BoundedHttpResponse,
  type FetchLike,
} from "../http.js";

export type WebProviderName = "exa" | "brave" | "spider" | "native" | "zai";

export type WebProviderErrorCode =
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR"
  | "BAD_RESPONSE"
  | "MISSING_CREDENTIAL"
  | "UNSUPPORTED"
  | "CONVERSION_FAILED";

/** Provider-facing search or scrape error. Messages name the provider and never include the credential. */
export class WebProviderError extends Error {
  readonly provider: WebProviderName;
  readonly code: WebProviderErrorCode;
  readonly status?: number;

  constructor(
    provider: WebProviderName,
    code: WebProviderErrorCode,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "WebProviderError";
    this.provider = provider;
    this.code = code;
    this.status = status;
  }
}

export type WebSearchResult = {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
};

export type WebSearchInput = {
  query: string;
  count: number;
  freshness?: "day" | "week" | "month" | "year";
  credential: WebProviderCredential;
  abort: AbortSignal;
  timeoutMs: number;
};

const EXA_SEARCH_URL = "https://api.exa.ai/search";

const FRESHNESS_DAYS = { day: 1, week: 7, month: 31, year: 365 } as const;

// START_BLOCK_HELPERS
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freshnessToDate(freshness: keyof typeof FRESHNESS_DAYS): string {
  const ms = Date.now() - FRESHNESS_DAYS[freshness] * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

/** Map a bounded-transport HTTP error to a provider error; re-throw timeout, abort, oversized, and network errors unchanged. */
export function mapHttpErrorToProviderError(error: unknown, provider: WebProviderName): never {
  if (error instanceof WebHttpError && error.code === "HTTP_ERROR") {
    const status = error.status ?? 0;
    if (status === 401 || status === 403) {
      throw new WebProviderError(
        provider,
        "AUTH_FAILED",
        `${provider} authentication failed`,
        status,
      );
    }
    if (status === 429) {
      throw new WebProviderError(
        provider,
        "RATE_LIMITED",
        `${provider} rate limit exceeded`,
        status,
      );
    }
    throw new WebProviderError(
      provider,
      "PROVIDER_ERROR",
      `${provider} server error HTTP ${status}`,
      status,
    );
  }
  throw error;
}

function normalizeExaResult(item: unknown): WebSearchResult | undefined {
  if (!isPlainObject(item)) {
    return undefined;
  }
  const url = typeof item.url === "string" ? item.url : undefined;
  if (!url) {
    return undefined;
  }
  const title = typeof item.title === "string" && item.title.length > 0 ? item.title : url;
  const highlights = Array.isArray(item.highlights)
    ? item.highlights.filter((entry): entry is string => typeof entry === "string")
    : [];
  const snippet = highlights[0];
  const publishedAt = typeof item.publishedDate === "string" ? item.publishedDate : undefined;
  return {
    title,
    url,
    ...(snippet ? { snippet } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

function parseExaResults(bytes: Uint8Array): WebSearchResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WebProviderError("exa", "BAD_RESPONSE", "malformed JSON response from exa");
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.results)) {
    throw new WebProviderError("exa", "BAD_RESPONSE", "unexpected exa response envelope");
  }
  return (parsed.results as unknown[])
    .map(normalizeExaResult)
    .filter((result): result is WebSearchResult => result !== undefined);
}
// END_BLOCK_HELPERS

// START_CONTRACT: searchExa
//   PURPOSE: POST https://api.exa.ai/search with x-api-key auth and normalize results.
//   INPUTS: { input: WebSearchInput; fetchImpl: injectable fetch }
//   OUTPUTS: { WebSearchResult[] - ranked results, empty array when none }
//   SIDE_EFFECTS: performs network I/O through fetchImpl; never logs the credential
//   LINKS: M-WEB-SEARCH-SERVICE
// END_CONTRACT: searchExa
export async function searchExa(
  input: WebSearchInput,
  fetchImpl?: FetchLike,
): Promise<WebSearchResult[]> {
  const body = JSON.stringify({
    query: input.query,
    type: "auto",
    numResults: input.count,
    contents: { highlights: { query: input.query, numSentences: 3 } },
    ...(input.freshness ? { startPublishedDate: freshnessToDate(input.freshness) } : {}),
  });

  let response: BoundedHttpResponse;
  try {
    response = await requestBounded(
      {
        url: EXA_SEARCH_URL,
        method: "POST",
        headers: {
          "x-api-key": input.credential.value,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
        timeoutMs: input.timeoutMs,
        maxBytes: DEFAULT_TEXT_MAX_BYTES,
        abort: input.abort,
      },
      fetchImpl,
    );
  } catch (error) {
    mapHttpErrorToProviderError(error, "exa");
    throw error;
  }

  return parseExaResults(response.bytes);
}
