// FILE: src/plugins/web-tools/providers/native-fetch.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the native fetch provider dispatch: HTML conversion per format, plain text passthrough, media attachments, unsupported rejection, HTTP errors, redirects, and size limits.
//   SCOPE: Deterministic tests using injected fetch implementations plus one local Bun.serve redirect case.
//   DEPENDS: [bun:test, src/plugins/web-tools/providers/native-fetch.ts]
//   LINKS: [M-WEB-NATIVE-FETCH]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PNG_BYTES - Minimal PNG fixture.
//   PDF_BYTES - Minimal PDF fixture.
//   args - Build native fetch input.
//   htmlResponse - Build an HTML response fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial coverage for the native fetch provider.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../http.js";
import { fetchNative } from "./native-fetch.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

function args(overrides: Partial<{ format: "markdown" | "text" | "html"; maxBytes: number }> = {}) {
  return {
    url: "https://x.test/page",
    format: "markdown" as const,
    abort: new AbortController().signal,
    timeoutMs: 1000,
    ...overrides,
  };
}

function htmlResponse(html: string): Response {
  return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
}

describe("fetchNative text dispatch", () => {
  test("HTML with format markdown returns converted Markdown", async () => {
    const fetchImpl: FetchLike = async () => htmlResponse("<h1>Hi</h1><p>text</p>");
    const outcome = await fetchNative(args({ format: "markdown" }), fetchImpl);
    expect(outcome.kind).toBe("text");
    if (outcome.kind === "text") {
      expect(outcome.content).toContain("Hi");
      expect(outcome.content).toContain("text");
      expect(outcome.content).not.toContain("<h1>");
    }
  });

  test("HTML with format text returns extracted text", async () => {
    const fetchImpl: FetchLike = async () => htmlResponse("<h1>Hi</h1><p>text</p>");
    const outcome = await fetchNative(args({ format: "text" }), fetchImpl);
    expect(outcome.kind).toBe("text");
    if (outcome.kind === "text") {
      expect(outcome.content).toContain("Hi");
      expect(outcome.content).not.toContain("<h1>");
    }
  });

  test("HTML with format html returns the raw HTML body", async () => {
    const fetchImpl: FetchLike = async () => htmlResponse("<h1>Hi</h1>");
    const outcome = await fetchNative(args({ format: "html" }), fetchImpl);
    expect(outcome.kind).toBe("text");
    if (outcome.kind === "text") {
      expect(outcome.content).toContain("<h1>Hi</h1>");
    }
  });

  test("plain text and JSON return raw content regardless of format", async () => {
    const plain: FetchLike = async () =>
      new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
    const plainOutcome = await fetchNative(args({ format: "markdown" }), plain);
    expect(plainOutcome.kind === "text" && plainOutcome.content).toBe("hello");

    const json: FetchLike = async () =>
      new Response('{"a":1}', { status: 200, headers: { "content-type": "application/json" } });
    const jsonOutcome = await fetchNative(args({ format: "markdown" }), json);
    expect(jsonOutcome.kind === "text" && jsonOutcome.content).toBe('{"a":1}');
  });
});

describe("fetchNative media dispatch", () => {
  test("image responses return media outcomes with attachments", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
    const outcome = await fetchNative(args(), fetchImpl);
    expect(outcome.kind).toBe("media");
    if (outcome.kind === "media") {
      expect(outcome.attachment.mime).toBe("image/png");
    }
  });

  test("PDF responses return media outcomes", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(PDF_BYTES, { status: 200, headers: { "content-type": "application/pdf" } });
    const outcome = await fetchNative(args(), fetchImpl);
    expect(outcome.kind).toBe("media");
    if (outcome.kind === "media") {
      expect(outcome.attachment.mime).toBe("application/pdf");
    }
  });
});

describe("fetchNative errors and limits", () => {
  test("unsupported binary content raises UNSUPPORTED naming the MIME type", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(new Uint8Array([0, 1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    await expect(fetchNative(args(), fetchImpl)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  test("a 404 response raises HTTP_ERROR with status 404", async () => {
    const fetchImpl: FetchLike = async () => new Response("nope", { status: 404 });
    await expect(fetchNative(args(), fetchImpl)).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 404,
    });
  });

  test("bodies exceeding the cap raise OVERSIZED", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("this body is definitely longer than ten bytes", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    await expect(fetchNative(args({ maxBytes: 10 }), fetchImpl)).rejects.toMatchObject({
      code: "OVERSIZED",
    });
  });

  test("redirects resolve and finalUrl reflects the last hop", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/start") {
          return Response.redirect(new URL("/final", url).toString(), 302);
        }
        return new Response("landed", { status: 200, headers: { "content-type": "text/plain" } });
      },
    });
    try {
      const outcome = await fetchNative({
        url: `http://localhost:${server.port}/start`,
        format: "text",
        abort: new AbortController().signal,
        timeoutMs: 3000,
      });
      expect(outcome.kind).toBe("text");
      expect(outcome.finalUrl).toContain("/final");
    } finally {
      server.stop(true);
    }
  });
});
