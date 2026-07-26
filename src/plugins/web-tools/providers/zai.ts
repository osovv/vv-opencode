// FILE: src/plugins/web-tools/providers/zai.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Call the documented Z.AI international or Zhipu China Tool API directly for provider-neutral web search and reader extraction.
//   SCOPE: Explicit region endpoint selection, bearer-authenticated search and reader requests, response normalization, direct media-first fetch dispatch, and provider error mapping without MCP behavior.
//   DEPENDS: [src/plugins/web-tools/config.ts, src/plugins/web-tools/http.ts, src/plugins/web-tools/media-loader.ts, src/plugins/web-tools/providers/exa.ts, @opencode-ai/plugin]
//   LINKS: [M-WEB-ZAI, M-WEB-HTTP, M-WEB-MEDIA-LOADER, M-WEB-SEARCH-SERVICE, M-WEB-FETCH-SERVICE]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ZaiReaderOutcome - Text or direct media result returned by the Z.AI fetch adapter.
//   searchZai - Execute one direct regional Z.AI or Zhipu web search request.
//   fetchZai - Return supported media directly or read textual content through the regional reader endpoint.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-ZAI-DIRECT-WEB-PROVIDERS - Added direct international and China search and reader Tool API integration.]
// END_CHANGE_SUMMARY

import type { ToolAttachment } from "@opencode-ai/plugin";
import type { VvocWebRegion } from "../../../lib/vvoc-config.js";
import type { WebProviderCredential } from "../config.js";
import {
  DEFAULT_TEXT_MAX_BYTES,
  requestBounded,
  type BoundedHttpResponse,
  type FetchLike,
} from "../http.js";
import { loadMediaAttachment, WebMediaError } from "../media-loader.js";
import {
  mapHttpErrorToProviderError,
  WebProviderError,
  type WebSearchInput,
  type WebSearchResult,
} from "./exa.js";

type FetchFormat = "markdown" | "text" | "html";

type ZaiRegionConfig = {
  searchUrl: string;
  readerUrl: string;
  searchEngine: "search-prime" | "search_pro";
};

const REGION_CONFIG: Record<VvocWebRegion, ZaiRegionConfig> = {
  international: {
    searchUrl: "https://api.z.ai/api/paas/v4/web_search",
    readerUrl: "https://api.z.ai/api/paas/v4/reader",
    searchEngine: "search-prime",
  },
  china: {
    searchUrl: "https://open.bigmodel.cn/api/paas/v4/web_search",
    readerUrl: "https://open.bigmodel.cn/api/paas/v4/reader",
    searchEngine: "search_pro",
  },
};

const ZAI_FRESHNESS = {
  day: "oneDay",
  week: "oneWeek",
  month: "oneMonth",
  year: "oneYear",
} as const;

export type ZaiReaderOutcome =
  | {
      kind: "text";
      content: string;
      metadata: {
        status: number;
        requestId?: string;
        model?: string;
        created?: number;
        title?: string;
      };
    }
  | {
      kind: "media";
      attachment: ToolAttachment;
      metadata: Record<string, never>;
    };

// START_BLOCK_RESPONSE_HELPERS
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJson(bytes: Uint8Array, operation: "search" | "reader"): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WebProviderError(
      "zai",
      "BAD_RESPONSE",
      `malformed JSON response from zai ${operation}`,
    );
  }
}

function normalizeSearchResult(item: unknown): WebSearchResult | undefined {
  if (!isPlainObject(item) || typeof item.link !== "string" || item.link.length === 0) {
    return undefined;
  }
  const title = typeof item.title === "string" && item.title.length > 0 ? item.title : item.link;
  const snippet =
    typeof item.content === "string" && item.content.length > 0 ? item.content : undefined;
  const publishedAt =
    typeof item.publish_date === "string" && item.publish_date.length > 0
      ? item.publish_date
      : undefined;
  return {
    title,
    url: item.link,
    ...(snippet ? { snippet } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

function parseSearchResponse(bytes: Uint8Array): WebSearchResult[] {
  const parsed = decodeJson(bytes, "search");
  if (!isPlainObject(parsed) || !Array.isArray(parsed.search_result)) {
    throw new WebProviderError("zai", "BAD_RESPONSE", "unexpected zai search response envelope");
  }
  return parsed.search_result
    .map(normalizeSearchResult)
    .filter((result): result is WebSearchResult => result !== undefined);
}

function parseReaderResponse(
  response: BoundedHttpResponse,
): Extract<ZaiReaderOutcome, { kind: "text" }> {
  const parsed = decodeJson(response.bytes, "reader");
  const envelope = isPlainObject(parsed) ? parsed : undefined;
  const readerResult = envelope?.reader_result;
  if (!isPlainObject(readerResult) || typeof readerResult.content !== "string") {
    throw new WebProviderError("zai", "BAD_RESPONSE", "unexpected zai reader response envelope");
  }
  return {
    kind: "text",
    content: readerResult.content,
    metadata: {
      status: response.status,
      ...(typeof envelope?.request_id === "string" ? { requestId: envelope.request_id } : {}),
      ...(typeof envelope?.model === "string" ? { model: envelope.model } : {}),
      ...(typeof envelope?.created === "number" ? { created: envelope.created } : {}),
      ...(typeof readerResult.title === "string" ? { title: readerResult.title } : {}),
    },
  };
}
// END_BLOCK_RESPONSE_HELPERS

// START_CONTRACT: searchZai
//   PURPOSE: Search through the documented direct Z.AI or Zhipu Tool API for one explicit region.
//   INPUTS: { input: provider-neutral search input plus region; fetchImpl: injectable fetch }
//   OUTPUTS: { WebSearchResult[] - normalized provider-ranked results }
//   SIDE_EFFECTS: performs one bounded authenticated HTTP request; never logs credentials
//   LINKS: M-WEB-SEARCH-SERVICE
// END_CONTRACT: searchZai
export async function searchZai(
  input: WebSearchInput & { region: VvocWebRegion },
  fetchImpl?: FetchLike,
): Promise<WebSearchResult[]> {
  const regional = REGION_CONFIG[input.region];
  const body = JSON.stringify({
    search_engine: regional.searchEngine,
    search_query: input.query,
    count: input.count,
    ...(input.freshness ? { search_recency_filter: ZAI_FRESHNESS[input.freshness] } : {}),
  });

  let response: BoundedHttpResponse;
  try {
    response = await requestBounded(
      {
        url: regional.searchUrl,
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.credential.value}`,
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
    mapHttpErrorToProviderError(error, "zai");
    throw error;
  }

  return parseSearchResponse(response.bytes);
}

// START_CONTRACT: fetchZai
//   PURPOSE: Return supported direct media attachments or read textual content through the documented regional reader Tool API.
//   INPUTS: { input: url, format, region, credential, abort, timeoutMs; fetchImpl: injectable fetch }
//   OUTPUTS: { ZaiReaderOutcome - direct media or normalized reader text and metadata }
//   SIDE_EFFECTS: performs bounded network I/O; textual targets use a direct media probe before the reader API
//   LINKS: M-WEB-FETCH-SERVICE, M-WEB-MEDIA-LOADER
// END_CONTRACT: fetchZai
export async function fetchZai(
  input: {
    url: string;
    format: FetchFormat;
    region: VvocWebRegion;
    credential: WebProviderCredential;
    abort: AbortSignal;
    timeoutMs: number;
  },
  fetchImpl?: FetchLike,
): Promise<ZaiReaderOutcome> {
  try {
    const attachment = await loadMediaAttachment(
      { url: input.url, abort: input.abort, timeoutMs: input.timeoutMs },
      fetchImpl,
    );
    return { kind: "media", attachment, metadata: {} };
  } catch (error) {
    if (!(error instanceof WebMediaError)) {
      throw error;
    }
  }

  const regional = REGION_CONFIG[input.region];
  const body = JSON.stringify({
    url: input.url,
    timeout: input.timeoutMs / 1000,
    return_format: input.format,
  });

  let response: BoundedHttpResponse;
  try {
    response = await requestBounded(
      {
        url: regional.readerUrl,
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.credential.value}`,
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
    mapHttpErrorToProviderError(error, "zai");
    throw error;
  }

  return parseReaderResponse(response);
}
