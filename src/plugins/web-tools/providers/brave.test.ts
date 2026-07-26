// FILE: src/plugins/web-tools/providers/brave.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the Brave Web Search adapter request shape, freshness mapping, normalization, and error mapping.
//   SCOPE: Deterministic tests using injected fetch implementations; no real network I/O and no credential leakage.
//   DEPENDS: [bun:test, src/plugins/web-tools/providers/brave.ts]
//   LINKS: [M-WEB-BRAVE, V-M-WEB-BRAVE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CREDENTIAL - Synthetic Brave credential fixture.
//   input - Build provider-neutral Brave search input.
//   jsonResponse - Build a JSON Response fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial coverage for the Brave Web Search adapter.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../http.js";
import { searchBrave } from "./brave.js";
import type { WebSearchInput } from "./exa.js";

const CREDENTIAL = { value: "tok-9", source: "env" as const };

function input(overrides: Partial<WebSearchInput> = {}): WebSearchInput {
  return {
    query: "q",
    count: 8,
    credential: CREDENTIAL,
    abort: new AbortController().signal,
    timeoutMs: 1000,
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("searchBrave", () => {
  test("sends X-Subscription-Token, q, count, and safesearch moderate", async () => {
    let capturedUrl: string | URL | Request | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init?.headers as Record<string, string>;
      return jsonResponse({ web: { results: [] } });
    };
    await searchBrave(input(), fetchImpl);
    expect(capturedHeaders?.["X-Subscription-Token"]).toBe("tok-9");
    const requested = String(capturedUrl);
    expect(requested).toContain("q=q");
    expect(requested).toContain("count=8");
    expect(requested).toContain("safesearch=moderate");
  });

  test("maps freshness to pd, pw, pm, or py", async () => {
    let capturedUrl: string | URL | Request | undefined;
    const fetchImpl: FetchLike = async (url) => {
      capturedUrl = url;
      return jsonResponse({ web: { results: [] } });
    };
    await searchBrave(input({ freshness: "month" }), fetchImpl);
    expect(String(capturedUrl)).toContain("freshness=pm");
  });

  test("normalizes web.results into title, url, snippet, and publishedAt", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        web: {
          results: [
            { title: "T", url: "https://a.test", description: "desc", page_age: "2026-01-01" },
          ],
        },
      });
    const results = await searchBrave(input(), fetchImpl);
    expect(results).toEqual([
      { title: "T", url: "https://a.test", snippet: "desc", publishedAt: "2026-01-01" },
    ]);
  });

  test("an empty web.results array resolves to an empty array", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ web: { results: [] } });
    expect(await searchBrave(input(), fetchImpl)).toEqual([]);
  });

  test("status 401 raises AUTH_FAILED naming brave", async () => {
    const fetchImpl: FetchLike = async () => new Response("no", { status: 401 });
    await expect(searchBrave(input(), fetchImpl)).rejects.toMatchObject({
      provider: "brave",
      code: "AUTH_FAILED",
    });
  });

  test("status 429 raises RATE_LIMITED and 500 raises PROVIDER_ERROR", async () => {
    const rateLimited: FetchLike = async () => new Response("slow", { status: 429 });
    await expect(searchBrave(input(), rateLimited)).rejects.toMatchObject({
      provider: "brave",
      code: "RATE_LIMITED",
    });
    const serverError: FetchLike = async () => new Response("boom", { status: 500 });
    await expect(searchBrave(input(), serverError)).rejects.toMatchObject({
      provider: "brave",
      code: "PROVIDER_ERROR",
    });
  });

  test("a malformed envelope raises BAD_RESPONSE", async () => {
    const fetchImpl: FetchLike = async () => new Response("not json", { status: 200 });
    await expect(searchBrave(input(), fetchImpl)).rejects.toMatchObject({
      provider: "brave",
      code: "BAD_RESPONSE",
    });
  });

  test("error messages never include the credential value", async () => {
    const fetchImpl: FetchLike = async () => new Response("no", { status: 401 });
    const error = await searchBrave(input(), fetchImpl).catch((caught) => caught);
    expect(String(error.message)).not.toContain("tok-9");
  });
});
