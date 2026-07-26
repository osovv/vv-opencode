// FILE: src/plugins/web-tools/providers/zai.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify direct Z.AI and Zhipu Tool API endpoint routing, request mapping, normalization, reader extraction, media bypass, bounded failures, and credential safety.
//   SCOPE: Deterministic injected-fetch coverage for both regions with no live provider calls.
//   DEPENDS: [bun:test, src/plugins/web-tools/providers/zai.ts]
//   LINKS: [M-WEB-ZAI, V-M-WEB-ZAI]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CREDENTIAL - Synthetic Z.AI credential fixture.
//   PNG_BYTES - Minimal direct-media fixture.
//   searchInput - Build a regional provider-neutral search input.
//   readerInput - Build a regional reader input.
//   jsonResponse - Build a JSON response fixture.
//   isReaderApi - Identify regional reader endpoint requests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-ZAI-DIRECT-WEB-PROVIDERS - Added deterministic direct Z.AI and Zhipu provider coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { VvocWebRegion } from "../../../lib/vvoc-config.js";
import type { FetchLike } from "../http.js";
import type { WebSearchInput } from "./exa.js";
import { fetchZai, searchZai } from "./zai.js";

const CREDENTIAL = { value: "zai-secret", source: "env" as const };
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

function searchInput(
  region: VvocWebRegion,
  overrides: Partial<WebSearchInput> = {},
): WebSearchInput & { region: VvocWebRegion } {
  return {
    query: "direct web tools",
    count: 8,
    freshness: "week",
    credential: CREDENTIAL,
    abort: new AbortController().signal,
    timeoutMs: 1000,
    region,
    ...overrides,
  };
}

function readerInput(region: VvocWebRegion) {
  return {
    url: "https://example.test/page",
    format: "markdown" as const,
    region,
    credential: CREDENTIAL,
    abort: new AbortController().signal,
    timeoutMs: 12000,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isReaderApi(url: string | URL | Request): boolean {
  return String(url).endsWith("/api/paas/v4/reader");
}

describe("searchZai", () => {
  test("routes international search to api.z.ai with search-prime and canonical fields", async () => {
    let requestedUrl = "";
    let requestedHeaders: Record<string, string> | undefined;
    let requestedBody: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (url, init) => {
      requestedUrl = String(url);
      requestedHeaders = init?.headers as Record<string, string>;
      requestedBody = JSON.parse(String(init?.body));
      return jsonResponse({ search_result: [] });
    };

    await searchZai(searchInput("international"), fetchImpl);

    expect(requestedUrl).toBe("https://api.z.ai/api/paas/v4/web_search");
    expect(requestedHeaders?.Authorization).toBe("Bearer zai-secret");
    expect(requestedBody).toEqual({
      search_engine: "search-prime",
      search_query: "direct web tools",
      count: 8,
      search_recency_filter: "oneWeek",
    });
  });

  test("routes China search to open.bigmodel.cn with search_pro", async () => {
    let requestedUrl = "";
    let requestedBody: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (url, init) => {
      requestedUrl = String(url);
      requestedBody = JSON.parse(String(init?.body));
      return jsonResponse({ search_result: [] });
    };

    await searchZai(searchInput("china", { freshness: undefined }), fetchImpl);

    expect(requestedUrl).toBe("https://open.bigmodel.cn/api/paas/v4/web_search");
    expect(requestedBody.search_engine).toBe("search_pro");
    expect(requestedBody).not.toHaveProperty("search_recency_filter");
  });

  test("normalizes ranked results and skips entries without links", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        search_result: [
          {
            title: "Direct APIs",
            link: "https://example.test/direct",
            content: "Provider-neutral result.",
            publish_date: "2026-07-26",
          },
          { title: "Missing link", content: "skip" },
          { link: "https://example.test/fallback-title" },
        ],
      });

    expect(await searchZai(searchInput("international"), fetchImpl)).toEqual([
      {
        title: "Direct APIs",
        url: "https://example.test/direct",
        snippet: "Provider-neutral result.",
        publishedAt: "2026-07-26",
      },
      {
        title: "https://example.test/fallback-title",
        url: "https://example.test/fallback-title",
      },
    ]);
  });

  test("maps malformed, auth, rate-limit, and timeout failures without leaking credentials", async () => {
    await expect(
      searchZai(searchInput("international"), async () => new Response("not-json")),
    ).rejects.toMatchObject({ provider: "zai", code: "BAD_RESPONSE" });
    const authError = await searchZai(
      searchInput("international"),
      async () => new Response("denied", { status: 401 }),
    ).catch((error) => error);
    expect(authError).toMatchObject({ provider: "zai", code: "AUTH_FAILED" });
    expect(String(authError.message)).not.toContain("zai-secret");
    await expect(
      searchZai(searchInput("international"), async () => new Response("slow", { status: 429 })),
    ).rejects.toMatchObject({ provider: "zai", code: "RATE_LIMITED" });

    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(
      searchZai(searchInput("international", { timeoutMs: 20 }), hanging),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("fetchZai", () => {
  test("probes text then calls the international reader with canonical fields and metadata", async () => {
    let readerHeaders: Record<string, string> | undefined;
    let readerBody: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (url, init) => {
      if (isReaderApi(url)) {
        readerHeaders = init?.headers as Record<string, string>;
        readerBody = JSON.parse(String(init?.body));
        return jsonResponse({
          request_id: "request-1",
          model: "web-reader",
          created: 123,
          reader_result: { title: "Example", content: "# Extracted" },
        });
      }
      return new Response("<html>page</html>", {
        headers: { "content-type": "text/html" },
      });
    };

    const outcome = await fetchZai(readerInput("international"), fetchImpl);

    expect(readerHeaders?.Authorization).toBe("Bearer zai-secret");
    expect(readerBody).toEqual({
      url: "https://example.test/page",
      timeout: 12,
      return_format: "markdown",
    });
    expect(outcome).toEqual({
      kind: "text",
      content: "# Extracted",
      metadata: {
        status: 200,
        requestId: "request-1",
        model: "web-reader",
        created: 123,
        title: "Example",
      },
    });
  });

  test("routes China text to the open.bigmodel.cn reader", async () => {
    let readerUrl = "";
    const fetchImpl: FetchLike = async (url) => {
      if (isReaderApi(url)) {
        readerUrl = String(url);
        return jsonResponse({ reader_result: { content: "读取内容" } });
      }
      return new Response("page", { headers: { "content-type": "text/plain" } });
    };

    const outcome = await fetchZai(readerInput("china"), fetchImpl);

    expect(readerUrl).toBe("https://open.bigmodel.cn/api/paas/v4/reader");
    expect(outcome.kind === "text" && outcome.content).toBe("读取内容");
  });

  test("returns supported media directly without calling the reader", async () => {
    let readerCalled = false;
    const fetchImpl: FetchLike = async (url) => {
      if (isReaderApi(url)) {
        readerCalled = true;
        return jsonResponse({ reader_result: { content: "unexpected" } });
      }
      return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
    };

    const outcome = await fetchZai(readerInput("international"), fetchImpl);

    expect(outcome.kind).toBe("media");
    expect(readerCalled).toBe(false);
    if (outcome.kind === "media") {
      expect(outcome.attachment).toMatchObject({ type: "file", mime: "image/png" });
    }
  });

  test("rejects malformed reader envelopes and maps reader authentication safely", async () => {
    const malformed: FetchLike = async (url) =>
      isReaderApi(url)
        ? jsonResponse({ reader_result: {} })
        : new Response("page", { headers: { "content-type": "text/plain" } });
    await expect(fetchZai(readerInput("international"), malformed)).rejects.toMatchObject({
      provider: "zai",
      code: "BAD_RESPONSE",
    });

    const unauthorized: FetchLike = async (url) =>
      isReaderApi(url)
        ? new Response("denied", { status: 401 })
        : new Response("page", { headers: { "content-type": "text/plain" } });
    const error = await fetchZai(readerInput("international"), unauthorized).catch(
      (caught) => caught,
    );
    expect(error).toMatchObject({ provider: "zai", code: "AUTH_FAILED" });
    expect(String(error.message)).not.toContain("zai-secret");
  });
});
