// FILE: src/plugins/web-tools/providers/exa.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the Exa Search API adapter request shape, freshness mapping, normalization, and error mapping.
//   SCOPE: Deterministic tests using injected fetch implementations; no real network I/O and no credential leakage.
//   DEPENDS: [bun:test, src/plugins/web-tools/providers/exa.ts]
//   LINKS: [M-WEB-EXA]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   CREDENTIAL - Synthetic Exa credential fixture.
//   input - Build provider-neutral Exa search input.
//   jsonResponse - Build a JSON Response fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial coverage for the Exa Search API adapter.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../http.js";
import { searchExa, type WebSearchInput } from "./exa.js";

const CREDENTIAL = { value: "key-123", source: "env" as const };

function input(overrides: Partial<WebSearchInput> = {}): WebSearchInput {
  return {
    query: "test query",
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

describe("searchExa", () => {
  test("sends x-api-key, type auto, and highlights configuration", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: string | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = init?.body as string;
      return jsonResponse({ results: [] });
    };
    await searchExa(input(), fetchImpl);
    expect(capturedHeaders?.["x-api-key"]).toBe("key-123");
    const body = JSON.parse(capturedBody ?? "{}");
    expect(body.type).toBe("auto");
    expect(body.numResults).toBe(8);
    expect(body.contents.highlights).toBeDefined();
  });

  test("maps count to numResults and freshness to startPublishedDate", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: FetchLike = async (_url, init) => {
      body = JSON.parse((init?.body as string) ?? "{}");
      return jsonResponse({ results: [] });
    };
    await searchExa(input({ count: 5, freshness: "week" }), fetchImpl);
    expect(body.numResults).toBe(5);
    const published = String(body.startPublishedDate);
    const diff = Date.now() - new Date(published).getTime();
    expect(diff).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(diff).toBeLessThan(8 * 24 * 60 * 60 * 1000);
  });

  test("normalizes title, url, snippet, and publishedAt", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        results: [
          {
            title: "T",
            url: "https://a.test",
            publishedDate: "2026-01-01",
            highlights: ["snip1", "snip2"],
          },
        ],
      });
    const results = await searchExa(input(), fetchImpl);
    expect(results).toEqual([
      { title: "T", url: "https://a.test", snippet: "snip1", publishedAt: "2026-01-01" },
    ]);
  });

  test("an empty results array resolves to an empty array", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ results: [] });
    expect(await searchExa(input(), fetchImpl)).toEqual([]);
  });

  test("status 401 raises AUTH_FAILED naming exa", async () => {
    const fetchImpl: FetchLike = async () => new Response("no", { status: 401 });
    await expect(searchExa(input(), fetchImpl)).rejects.toMatchObject({
      provider: "exa",
      code: "AUTH_FAILED",
    });
  });

  test("status 429 raises RATE_LIMITED and 500 raises PROVIDER_ERROR", async () => {
    const rateLimited: FetchLike = async () => new Response("slow", { status: 429 });
    await expect(searchExa(input(), rateLimited)).rejects.toMatchObject({
      provider: "exa",
      code: "RATE_LIMITED",
    });
    const serverError: FetchLike = async () => new Response("boom", { status: 500 });
    await expect(searchExa(input(), serverError)).rejects.toMatchObject({
      provider: "exa",
      code: "PROVIDER_ERROR",
    });
  });

  test("a malformed JSON envelope raises BAD_RESPONSE", async () => {
    const fetchImpl: FetchLike = async () => new Response("not json", { status: 200 });
    await expect(searchExa(input(), fetchImpl)).rejects.toMatchObject({
      provider: "exa",
      code: "BAD_RESPONSE",
    });
  });

  test("caller timeout propagates through the bounded transport", async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(searchExa(input({ timeoutMs: 20 }), hanging)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  test("error messages never include the credential value", async () => {
    const fetchImpl: FetchLike = async () => new Response("no", { status: 401 });
    const error = await searchExa(input(), fetchImpl).catch((caught) => caught);
    expect(String(error.message)).not.toContain("key-123");
  });
});
