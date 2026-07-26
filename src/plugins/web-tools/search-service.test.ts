// FILE: src/plugins/web-tools/search-service.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the provider-neutral web_search tool schema, permission flow, dispatch, rendering, metadata, and credential-safe errors.
//   SCOPE: Deterministic tool-level tests with a temporary global fetch stub; no live provider calls.
//   DEPENDS: [bun:test, @opencode-ai/plugin, src/plugins/web-tools/search-service.ts]
//   LINKS: [M-WEB-SEARCH-SERVICE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   createContext - Build a tool execution context fixture.
//   withFetch - Temporarily install a deterministic global fetch fixture.
//   structuredResult - Narrow a ToolResult to its structured form.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial coverage for the web_search tool service.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin";
import type { FetchLike } from "./http.js";
import { createWebSearchTool, renderSearchMarkdown } from "./search-service.js";

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

describe("createWebSearchTool", () => {
  test("defaults count to 8 and enforces count and freshness bounds", () => {
    const definition = createWebSearchTool({
      provider: "exa",
      envVar: "EXA_API_KEY",
      configField: "web.search.apiKey",
    });
    const schema = tool.schema.object(definition.args);

    expect(schema.parse({ query: "vvoc" })).toEqual({ query: "vvoc", count: 8 });
    expect(schema.safeParse({ query: "vvoc", count: 0 }).success).toBe(false);
    expect(schema.safeParse({ query: "vvoc", count: 21 }).success).toBe(false);
    expect(schema.safeParse({ query: "vvoc", freshness: "hour" }).success).toBe(false);
    expect(schema.parse({ query: "vvoc", freshness: "week" }).freshness).toBe("week");
  });

  test("asks permission before Exa dispatch and returns ranked Markdown metadata", async () => {
    const events: string[] = [];
    const definition = createWebSearchTool({
      provider: "exa",
      envVar: "EXA_API_KEY",
      configField: "web.search.apiKey",
      credential: { value: "exa-secret", source: "env" },
    });
    const context = createContext(async (input) => {
      events.push("ask");
      expect(input).toMatchObject({
        permission: "web_search",
        patterns: ["unified web tools"],
      });
    });

    const result = await withFetch(
      async () => {
        events.push("fetch");
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "Unified Web Tools",
                url: "https://example.test/web-tools",
                highlights: ["Provider-neutral search."],
                publishedDate: "2026-07-26",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
      () => definition.execute({ query: "unified web tools", count: 8 }, context),
    );

    expect(events).toEqual(["ask", "fetch"]);
    expect(structuredResult(result)).toEqual({
      title: "web_search: unified web tools",
      output:
        "1. [Unified Web Tools](https://example.test/web-tools)\n   Provider-neutral search.\n   _2026-07-26_",
      metadata: { provider: "exa", resultCount: 1, credentialSource: "env" },
    });
  });

  test("dispatches Brave and reports config as the credential source", async () => {
    let requestedUrl = "";
    const definition = createWebSearchTool({
      provider: "brave",
      envVar: "BRAVE_API_KEY",
      configField: "web.search.apiKey",
      credential: { value: "brave-secret", source: "config" },
    });

    const result = await withFetch(
      async (url) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({ web: { results: [] } }), {
          headers: { "content-type": "application/json" },
        });
      },
      () => definition.execute({ query: "vvoc", count: 3 }, createContext()),
    );

    expect(requestedUrl).toStartWith("https://api.search.brave.com/");
    expect(structuredResult(result).metadata).toEqual({
      provider: "brave",
      resultCount: 0,
      credentialSource: "config",
    });
  });

  test("missing credentials name both supported locations without a value", async () => {
    const definition = createWebSearchTool({
      provider: "brave",
      envVar: "BRAVE_API_KEY",
      configField: "web.search.apiKey",
    });

    const error = await definition
      .execute({ query: "vvoc", count: 8 }, createContext())
      .catch((caught) => caught);

    expect(error).toMatchObject({ provider: "brave", code: "MISSING_CREDENTIAL" });
    expect(String(error.message)).toContain("BRAVE_API_KEY");
    expect(String(error.message)).toContain("web.search.apiKey");
  });

  test("provider errors retain provider and code without leaking credentials", async () => {
    const definition = createWebSearchTool({
      provider: "exa",
      envVar: "EXA_API_KEY",
      configField: "web.search.apiKey",
      credential: { value: "never-print-this", source: "env" },
    });

    const error = await withFetch(
      async () => new Response("denied", { status: 401 }),
      () => definition.execute({ query: "vvoc", count: 8 }, createContext()),
    ).catch((caught) => caught);

    expect(error).toMatchObject({ provider: "exa", code: "AUTH_FAILED" });
    expect(String(error.message)).not.toContain("never-print-this");
  });
});

describe("renderSearchMarkdown", () => {
  test("renders ranked entries and a no-results notice", () => {
    expect(
      renderSearchMarkdown([
        { title: "One", url: "https://one.test", snippet: "First" },
        { title: "Two", url: "https://two.test", publishedAt: "2026-07-26" },
      ]),
    ).toBe("1. [One](https://one.test)\n   First\n2. [Two](https://two.test)\n   _2026-07-26_");
    expect(renderSearchMarkdown([])).toBe("No results found.");
  });
});
