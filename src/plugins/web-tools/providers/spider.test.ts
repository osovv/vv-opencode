// FILE: src/plugins/web-tools/providers/spider.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the Spider Scrape adapter: Bearer auth, return_format mapping, envelope validation, metadata, provider errors, media-first dispatch, and credential safety.
//   SCOPE: Deterministic tests using injected fetch implementations that route by URL between the media probe and the Spider endpoint.
//   DEPENDS: [bun:test, src/plugins/web-tools/providers/spider.ts]
//   LINKS: [M-WEB-SPIDER]
//   ROLE: TEST
//   MAP_MODE: NONE
// END_MODULE_CONTRACT
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial coverage for the Spider Scrape adapter.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../http.js";
import { scrapeSpider } from "./spider.js";

const CREDENTIAL = { value: "sp-1", source: "env" as const };
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

function args(
  overrides: Partial<{
    format: "markdown" | "text" | "html";
    url: string;
    credential: typeof CREDENTIAL;
  }> = {},
) {
  return {
    url: "https://x.test/page",
    format: "markdown" as const,
    credential: CREDENTIAL,
    abort: new AbortController().signal,
    timeoutMs: 1000,
    ...overrides,
  };
}

/** Target probe response that is textual, so the media loader rejects it and scraping proceeds. */
function probeText(): Response {
  return new Response("<html>page</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

function envelopeResponse(content = "scraped", status = 200, duration = 12): Response {
  return new Response(JSON.stringify([{ content, status, duration }]), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function isSpiderUrl(url: string | URL | Request): boolean {
  return String(url).includes("api.spider.cloud");
}

describe("scrapeSpider", () => {
  test("sends a Bearer token and maps markdown to the markdown return_format", async () => {
    let spiderHeaders: Record<string, string> | undefined;
    let spiderBody: string | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      if (isSpiderUrl(url)) {
        spiderHeaders = init?.headers as Record<string, string>;
        spiderBody = init?.body as string;
        return envelopeResponse();
      }
      return probeText();
    };
    const outcome = await scrapeSpider(args(), fetchImpl);
    expect(spiderHeaders?.Authorization).toBe("Bearer sp-1");
    expect(JSON.parse(spiderBody ?? "{}").return_format).toEqual(["markdown"]);
    expect(outcome.kind).toBe("text");
  });

  test("maps html to raw and text to text return formats", async () => {
    let spiderBody: string | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      if (isSpiderUrl(url)) {
        spiderBody = init?.body as string;
        return envelopeResponse();
      }
      return probeText();
    };
    await scrapeSpider(args({ format: "html" }), fetchImpl);
    expect(JSON.parse(spiderBody ?? "{}").return_format).toEqual(["raw"]);
    await scrapeSpider(args({ format: "text" }), fetchImpl);
    expect(JSON.parse(spiderBody ?? "{}").return_format).toEqual(["text"]);
  });

  test("a valid envelope resolves with content and status and duration metadata", async () => {
    const fetchImpl: FetchLike = async (url) =>
      isSpiderUrl(url) ? envelopeResponse("scraped text") : probeText();
    const outcome = await scrapeSpider(args(), fetchImpl);
    expect(outcome).toMatchObject({
      kind: "text",
      content: "scraped text",
      metadata: { status: 200, durationMs: 12 },
    });
  });

  test("an empty or non-array envelope raises BAD_RESPONSE naming spider", async () => {
    const fetchImpl: FetchLike = async (url) =>
      isSpiderUrl(url) ? new Response("[]", { status: 200 }) : probeText();
    await expect(scrapeSpider(args(), fetchImpl)).rejects.toMatchObject({
      provider: "spider",
      code: "BAD_RESPONSE",
    });
  });

  test("a provider error entry raises PROVIDER_ERROR", async () => {
    const fetchImpl: FetchLike = async (url) =>
      isSpiderUrl(url)
        ? new Response(JSON.stringify([{ error: "blocked", status: 403 }]), { status: 200 })
        : probeText();
    await expect(scrapeSpider(args(), fetchImpl)).rejects.toMatchObject({
      provider: "spider",
      code: "PROVIDER_ERROR",
    });
  });

  test("an image target resolves via the shared media loader without a Spider scrape", async () => {
    let spiderCalled = false;
    const fetchImpl: FetchLike = async (url) => {
      if (isSpiderUrl(url)) {
        spiderCalled = true;
        return envelopeResponse();
      }
      return new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
    };
    const outcome = await scrapeSpider(args({ url: "https://x.test/img.png" }), fetchImpl);
    expect(outcome.kind).toBe("media");
    expect(spiderCalled).toBe(false);
  });

  test("status 401 raises AUTH_FAILED and 429 raises RATE_LIMITED", async () => {
    const unauthorized: FetchLike = async (url) =>
      isSpiderUrl(url) ? new Response("no", { status: 401 }) : probeText();
    await expect(scrapeSpider(args(), unauthorized)).rejects.toMatchObject({
      provider: "spider",
      code: "AUTH_FAILED",
    });
    const rateLimited: FetchLike = async (url) =>
      isSpiderUrl(url) ? new Response("slow", { status: 429 }) : probeText();
    await expect(scrapeSpider(args(), rateLimited)).rejects.toMatchObject({
      provider: "spider",
      code: "RATE_LIMITED",
    });
  });

  test("error messages never include the credential value", async () => {
    const fetchImpl: FetchLike = async (url) =>
      isSpiderUrl(url) ? new Response("no", { status: 401 }) : probeText();
    const error = await scrapeSpider(
      args({ credential: { value: "sp-secret", source: "env" } }),
      fetchImpl,
    ).catch((caught) => caught);
    expect(String(error.message)).not.toContain("sp-secret");
  });
});
