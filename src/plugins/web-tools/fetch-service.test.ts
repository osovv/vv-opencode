// FILE: src/plugins/web-tools/fetch-service.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the provider-neutral web_fetch tool schema, strict contract validation with explicit execute-time defaults, URL validation, permission flow, provider dispatch, attachments, metadata, and credential errors.
//   SCOPE: Deterministic tool-level tests with a temporary global fetch stub; no live provider calls.
//   DEPENDS: [bun:test, @opencode-ai/plugin, src/lib/agent-tool-contract.ts, src/plugins/web-tools/fetch-service.ts]
//   LINKS: M-WEB-FETCH-SERVICE, V-M-WEB-FETCH-SERVICE, DF-WEB-FETCH
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PNG_BYTES - Minimal PNG fixture.
//   PDF_BYTES - Minimal PDF fixture.
//   createContext - Build a tool execution context fixture.
//   withFetch - Temporarily install a deterministic global fetch fixture.
//   structuredResult - Narrow a ToolResult to its structured form.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-006 - Covered strict execute-boundary rejection (structural, URL scheme, and malformed values) before permission/dispatch plus fractional timeout and PDF media delivery.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin";
import { ContractInputError } from "../../lib/agent-tool-contract.js";
import {
  createWebFetchTool,
  WEB_FETCH_DEFAULT_TIMEOUT_SECONDS,
  WEB_FETCH_MAX_TIMEOUT_SECONDS,
} from "./fetch-service.js";
import type { FetchLike } from "./http.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 1]);

function createContext(ask: ToolContext["ask"] = async () => undefined): ToolContext {
  return {
    sessionID: "session-1",
    messageID: "message-1",
    agent: "test-agent",
    directory: "/tmp/project",
    worktree: "/tmp/project",
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask,
  };
}

async function withFetch<T>(fetchImpl: FetchLike, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function structuredResult(result: ToolResult): Exclude<ToolResult, string> {
  if (typeof result === "string") {
    throw new Error("expected a structured tool result");
  }
  return result;
}

describe("createWebFetchTool", () => {
  test("defaults format and timeout and rejects timeouts above the cap", () => {
    const definition = createWebFetchTool({ provider: "native" });
    const schema = tool.schema.object(definition.args);

    expect(schema.parse({ url: "https://example.test" })).toEqual({
      url: "https://example.test",
      format: "markdown",
      timeout: WEB_FETCH_DEFAULT_TIMEOUT_SECONDS,
    });
    expect(
      schema.safeParse({ url: "https://example.test", timeout: WEB_FETCH_MAX_TIMEOUT_SECONDS + 1 })
        .success,
    ).toBe(false);
  });

  test("applies format and timeout defaults when OpenCode omits them at execution", async () => {
    let readerBody: Record<string, unknown> | undefined;
    const definition = createWebFetchTool({
      provider: "zai",
      region: "international",
      credential: { value: "zai-secret", source: "env" },
    });
    const runtimeArgs = {
      url: "https://example.test/page",
    } as Parameters<typeof definition.execute>[0];

    const result = await withFetch(
      async (url, init) => {
        if (String(url).endsWith("/api/paas/v4/reader")) {
          readerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({ reader_result: { content: "defaulted" } }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("<html>probe</html>", {
          headers: { "content-type": "text/html" },
        });
      },
      () => definition.execute(runtimeArgs, createContext()),
    );

    expect(readerBody).toEqual({
      url: "https://example.test/page",
      timeout: WEB_FETCH_DEFAULT_TIMEOUT_SECONDS,
      return_format: "markdown",
    });
    expect(structuredResult(result).metadata).toMatchObject({
      provider: "zai",
      format: "markdown",
    });
  });

  test("rejects non-http URLs before permission or network work", async () => {
    let asked = false;
    let fetched = false;
    const definition = createWebFetchTool({ provider: "native" });
    const error = await withFetch(
      async () => {
        fetched = true;
        return new Response("unexpected");
      },
      () =>
        definition.execute(
          { url: "file:///tmp/secret", format: "text", timeout: 30 },
          createContext(async () => {
            asked = true;
          }),
        ),
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(ContractInputError);
    expect(String(error.message)).toContain("http and https");
    expect(String(error.message)).not.toContain("/tmp/secret");
    expect(asked).toBe(false);
    expect(fetched).toBe(false);
  });

  test("rejects relative, malformed, and other-scheme URLs before permission or network work", async () => {
    const definition = createWebFetchTool({ provider: "native" });
    let asked = false;
    let fetched = false;
    const context = createContext(async () => {
      asked = true;
    });

    for (const url of [
      "/page",
      "https://",
      "https://exa mple.test",
      "data:text/plain,hello",
      "ftp://example.test/file",
    ]) {
      const error = await withFetch(
        async () => {
          fetched = true;
          return new Response("unexpected");
        },
        () => definition.execute({ url, format: "markdown", timeout: 30 }, context),
      ).catch((caught) => caught);
      expect(error).toBeInstanceOf(ContractInputError);
      if (error instanceof ContractInputError) {
        expect(error.issues.some((issue) => issue.path === "url")).toBe(true);
      }
    }

    expect(asked).toBe(false);
    expect(fetched).toBe(false);
  });

  test("rejects invalid format, timeout, and unknown credential fields before permission or network work", async () => {
    const definition = createWebFetchTool({ provider: "native" });
    let asked = false;
    let fetched = false;
    const context = createContext(async () => {
      asked = true;
    });

    const invalidArgs: Array<Record<string, unknown>> = [
      { url: "https://example.test/page", format: "pdf" },
      { url: "https://example.test/page", timeout: 0 },
      { url: "https://example.test/page", timeout: WEB_FETCH_MAX_TIMEOUT_SECONDS + 1 },
      { url: "https://example.test/page", timeout: "30" },
      { url: "https://example.test/page", timeout: null },
      { url: "https://example.test/page", apiKey: "never-print-this" },
      { url: "https://example.test/page", credential: "never-print-this" },
      { url: "https://example.test/page", provider: "spider" },
    ];

    for (const args of invalidArgs) {
      const error = await withFetch(
        async () => {
          fetched = true;
          return new Response("unexpected");
        },
        () => definition.execute(args as never, context),
      ).catch((caught) => caught);
      expect(error).toBeInstanceOf(ContractInputError);
      expect(String(error.message)).not.toContain("never-print-this");
    }

    expect(asked).toBe(false);
    expect(fetched).toBe(false);
  });

  test("applies a fractional positive timeout at the execute boundary", async () => {
    let readerBody: Record<string, unknown> | undefined;
    const definition = createWebFetchTool({
      provider: "zai",
      region: "international",
      credential: { value: "zai-secret", source: "env" },
    });

    await withFetch(
      async (url, init) => {
        if (String(url).endsWith("/api/paas/v4/reader")) {
          readerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({ reader_result: { content: "fractional" } }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("<html>probe</html>", { headers: { "content-type": "text/html" } });
      },
      () => definition.execute({ url: "https://example.test/page", timeout: 0.5 }, createContext()),
    );

    expect(readerBody?.timeout).toBe(0.5);
  });

  test("returns native PDF media as an attachment", async () => {
    const definition = createWebFetchTool({ provider: "native" });
    const result = await withFetch(
      async () =>
        new Response(PDF_BYTES, { status: 200, headers: { "content-type": "application/pdf" } }),
      () => definition.execute({ url: "https://example.test/doc.pdf" }, createContext()),
    );

    const structured = structuredResult(result);
    expect(structured.attachments?.[0]).toMatchObject({ type: "file", mime: "application/pdf" });
    expect(structured.metadata).toMatchObject({ provider: "native", format: "markdown" });
  });

  test("asks permission before native dispatch and returns requested text", async () => {
    const events: string[] = [];
    const definition = createWebFetchTool({ provider: "native" });
    const result = await withFetch(
      async () => {
        events.push("fetch");
        return new Response("plain body", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      },
      () =>
        definition.execute(
          { url: "https://example.test/page", format: "text", timeout: 12 },
          createContext(async (input) => {
            events.push("ask");
            expect(input).toMatchObject({
              permission: "web_fetch",
              patterns: ["https://example.test/page"],
            });
          }),
        ),
    );

    expect(events).toEqual(["ask", "fetch"]);
    expect(structuredResult(result)).toEqual({
      title: "web_fetch: https://example.test/page",
      output: "plain body",
      metadata: { provider: "native", format: "text", status: 200 },
    });
  });

  test("returns native media with a textual summary and attachment", async () => {
    const definition = createWebFetchTool({ provider: "native" });
    const result = await withFetch(
      async () =>
        new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }),
      () =>
        definition.execute(
          { url: "https://example.test/image.png", format: "markdown", timeout: 30 },
          createContext(),
        ),
    );
    const structured = structuredResult(result);

    expect(structured.output).toContain("attachment");
    expect(structured.attachments).toHaveLength(1);
    expect(structured.attachments?.[0]).toMatchObject({ type: "file", mime: "image/png" });
  });

  test("surfaces Spider content, status, duration, and credential source metadata", async () => {
    const definition = createWebFetchTool({
      provider: "spider",
      envVar: "SPIDER_API_KEY",
      configField: "web.fetch.apiKey",
      credential: { value: "spider-secret", source: "config" },
    });
    const result = await withFetch(
      async (url) =>
        String(url).includes("api.spider.cloud")
          ? new Response(JSON.stringify([{ content: "scraped", status: 207, duration: 42 }]))
          : new Response("<html>probe</html>", {
              headers: { "content-type": "text/html" },
            }),
      () =>
        definition.execute(
          { url: "https://example.test/page", format: "html", timeout: 30 },
          createContext(),
        ),
    );

    expect(structuredResult(result)).toEqual({
      title: "web_fetch: https://example.test/page",
      output: "scraped",
      metadata: {
        provider: "spider",
        format: "html",
        credentialSource: "config",
        status: 207,
        durationMs: 42,
      },
    });
  });

  test("surfaces direct Z.AI reader content and regional request metadata", async () => {
    const definition = createWebFetchTool({
      provider: "zai",
      region: "china",
      envVar: "ZAI_API_KEY",
      configField: "web.fetch.apiKey",
      credential: { value: "zai-secret", source: "config" },
    });
    const result = await withFetch(
      async (url) =>
        String(url).endsWith("/api/paas/v4/reader")
          ? new Response(
              JSON.stringify({
                request_id: "reader-1",
                reader_result: { title: "页面", content: "读取内容" },
              }),
              { headers: { "content-type": "application/json" } },
            )
          : new Response("<html>probe</html>", {
              headers: { "content-type": "text/html" },
            }),
      () =>
        definition.execute(
          { url: "https://example.test/page", format: "markdown", timeout: 30 },
          createContext(),
        ),
    );

    expect(structuredResult(result)).toEqual({
      title: "web_fetch: https://example.test/page",
      output: "读取内容",
      metadata: {
        provider: "zai",
        region: "china",
        format: "markdown",
        credentialSource: "config",
        status: 200,
        requestId: "reader-1",
        title: "页面",
      },
    });
  });

  test("returns direct Z.AI media through the canonical attachment result", async () => {
    const definition = createWebFetchTool({
      provider: "zai",
      region: "international",
      envVar: "ZAI_API_KEY",
      configField: "web.fetch.apiKey",
      credential: { value: "zai-secret", source: "env" },
    });
    const result = await withFetch(
      async () =>
        new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }),
      () =>
        definition.execute(
          { url: "https://example.test/image.png", format: "markdown", timeout: 30 },
          createContext(),
        ),
    );
    const structured = structuredResult(result);
    expect(structured.attachments?.[0]).toMatchObject({ type: "file", mime: "image/png" });
    expect(structured.metadata).toEqual({
      provider: "zai",
      region: "international",
      format: "markdown",
      credentialSource: "env",
    });
  });

  test("missing Spider credentials name both supported locations without values", async () => {
    const definition = createWebFetchTool({
      provider: "spider",
      envVar: "SPIDER_API_KEY",
      configField: "web.fetch.apiKey",
    });
    const error = await definition
      .execute(
        { url: "https://example.test/page", format: "markdown", timeout: 30 },
        createContext(),
      )
      .catch((caught) => caught);

    expect(error).toMatchObject({ provider: "spider", code: "MISSING_CREDENTIAL" });
    expect(String(error.message)).toContain("SPIDER_API_KEY");
    expect(String(error.message)).toContain("web.fetch.apiKey");
  });

  test("missing Z.AI credentials name both supported locations without values", async () => {
    const definition = createWebFetchTool({
      provider: "zai",
      region: "international",
      envVar: "ZAI_API_KEY",
      configField: "web.fetch.apiKey",
    });
    const error = await definition
      .execute(
        { url: "https://example.test/page", format: "markdown", timeout: 30 },
        createContext(),
      )
      .catch((caught) => caught);

    expect(error).toMatchObject({ provider: "zai", code: "MISSING_CREDENTIAL" });
    expect(String(error.message)).toContain("ZAI_API_KEY");
    expect(String(error.message)).toContain("web.fetch.apiKey");
  });
});
