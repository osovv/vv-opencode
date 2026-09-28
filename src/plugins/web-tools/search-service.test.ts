// FILE: src/plugins/web-tools/search-service.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the provider-neutral native web_search tool: strict contract validation with explicit execute-time defaults, awaited permission before dispatch, provider dispatch, rendering, metadata, and credential-safe errors.
//   SCOPE: Deterministic native tool-level tests with a temporary global fetch stub and an injected permission guard; no live provider calls.
//   DEPENDS: [bun:test, @opencode/plugin/promise/tool, src/lib/agent-tool-contract.ts, src/plugins/web-tools/search-service.ts]
//   LINKS: M-WEB-SEARCH-SERVICE, V-M-WEB-SEARCH-SERVICE, DF-WEB-SEARCH
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   createContext - Build a pinned native tool execute context fixture.
//   createPermission - Build a recording permission guard fixture.
//   withFetch - Temporarily install a deterministic global fetch fixture.
//   RecordingPermission - Recording resource permission guard.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-005 - Rewrote V1 SDK tool.schema/context.ask tests as native Tool.Info input and injected resource permission guard tests.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { ContractInputError } from "../../lib/agent-tool-contract.js";
import type { FetchLike } from "./http.js";
import {
  createWebSearchToolForConfig,
  renderSearchMarkdown,
  type WebPermissionGuard,
} from "./search-service.js";

function createContext(signal: AbortSignal = new AbortController().signal): ToolContext {
  return {
    sessionID: "session-1",
    agent: "test-agent",
    messageID: "message-1",
    id: "call-1",
    signal,
    progress: async () => undefined,
  } as unknown as ToolContext;
}

interface RecordingPermission extends WebPermissionGuard {
  readonly calls: Array<{ action: string; resources: ReadonlyArray<string> }>;
}

function createPermission(
  options: { deny?: boolean; runEffect?: boolean } = {},
): RecordingPermission {
  const calls: Array<{ action: string; resources: ReadonlyArray<string> }> = [];
  return {
    calls,
    async guard(input, effect, guardOptions) {
      calls.push({ action: input.action, resources: input.resources });
      if (guardOptions?.signal?.aborted) {
        throw new Error("PERMISSION_ABORTED");
      }
      if (options.deny) {
        throw new Error("PERMISSION_DENIED");
      }
      if (options.runEffect === false) {
        return undefined as never;
      }
      return effect();
    },
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

describe("createWebSearchTool", () => {
  test("defaults count to 8 and enforces count and freshness bounds", () => {
    const definition = createWebSearchToolForConfig(
      { provider: "exa", envVar: "EXA_API_KEY", configField: "web.search.apiKey" },
      createPermission(),
    );
    const schema = definition.input;

    expect(schema.parse({ query: "vvoc" })).toEqual({ query: "vvoc", count: 8 });
    expect(schema.safeParse({ query: "vvoc", count: 0 }).success).toBe(false);
    expect(schema.safeParse({ query: "vvoc", count: 21 }).success).toBe(false);
    expect(schema.safeParse({ query: "vvoc", freshness: "hour" }).success).toBe(false);
    expect(schema.parse({ query: "vvoc", freshness: "week" }).freshness).toBe("week");
  });

  test("applies count 8 when the host omits it at execution", async () => {
    const events: string[] = [];
    let requestBody: Record<string, unknown> | undefined;
    const permission = createPermission();
    const definition = createWebSearchToolForConfig(
      {
        provider: "zai",
        region: "international",
        envVar: "ZAI_API_KEY",
        configField: "web.search.apiKey",
        credential: { value: "zai-secret", source: "env" },
      },
      permission,
    );

    await withFetch(
      async (_url, init) => {
        events.push("fetch");
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ search_result: [] }), {
          headers: { "content-type": "application/json" },
        });
      },
      () => definition.execute({ query: "vvoc" }, createContext()),
    );

    expect(permission.calls).toEqual([{ action: "web_search", resources: ["vvoc"] }]);
    expect(events).toEqual(["fetch"]);
    expect(requestBody).toEqual({
      search_engine: "search-prime",
      search_query: "vvoc",
      count: 8,
    });
  });

  test("rejects invalid count, freshness, and unknown credential fields before permission or dispatch", async () => {
    let fetched = false;
    const permission = createPermission();
    const definition = createWebSearchToolForConfig(
      {
        provider: "exa",
        envVar: "EXA_API_KEY",
        configField: "web.search.apiKey",
        credential: { value: "never-print-this", source: "env" },
      },
      permission,
    );

    const invalidArgs: Array<Record<string, unknown>> = [
      { query: "vvoc", count: 0 },
      { query: "vvoc", count: 21 },
      { query: "vvoc", count: 1.5 },
      { query: "vvoc", count: "8" },
      { query: "vvoc", count: null },
      { query: "vvoc", freshness: "hour" },
      { query: "vvoc", extra: true },
      { query: "vvoc", apiKey: "never-print-this" },
      { query: "vvoc", credential: "never-print-this" },
      { query: "vvoc", provider: "brave" },
    ];

    for (const args of invalidArgs) {
      const error = await withFetch(
        async () => {
          fetched = true;
          return new Response("unexpected");
        },
        () => definition.execute(args, createContext()),
      ).catch((caught) => caught);
      expect(error).toBeInstanceOf(ContractInputError);
      if (error instanceof ContractInputError) {
        expect(error.toolId).toBe("web_search");
        expect(error.issues.length).toBeGreaterThan(0);
      }
      expect(String(error.message)).not.toContain("never-print-this");
    }

    expect(permission.calls).toEqual([]);
    expect(fetched).toBe(false);
  });

  test("permission denial yields zero provider dispatch", async () => {
    let fetched = false;
    const permission = createPermission({ deny: true });
    const definition = createWebSearchToolForConfig(
      {
        provider: "exa",
        envVar: "EXA_API_KEY",
        configField: "web.search.apiKey",
        credential: { value: "secret", source: "env" },
      },
      permission,
    );

    const error = await withFetch(
      async () => {
        fetched = true;
        return new Response("unexpected");
      },
      () => definition.execute({ query: "vvoc", count: 8 }, createContext()),
    ).catch((caught) => caught);

    expect(String(error)).toContain("PERMISSION_DENIED");
    expect(fetched).toBe(false);
  });

  test("aborted permission signal yields zero provider dispatch", async () => {
    let fetched = false;
    const controller = new AbortController();
    controller.abort();
    const definition = createWebSearchToolForConfig(
      {
        provider: "exa",
        envVar: "EXA_API_KEY",
        configField: "web.search.apiKey",
        credential: { value: "secret", source: "env" },
      },
      createPermission(),
    );

    const error = await withFetch(
      async () => {
        fetched = true;
        return new Response("unexpected");
      },
      () => definition.execute({ query: "vvoc", count: 8 }, createContext(controller.signal)),
    ).catch((caught) => caught);

    expect(String(error)).toContain("PERMISSION_ABORTED");
    expect(fetched).toBe(false);
  });

  test("maps the freshness window to the provider request", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const definition = createWebSearchToolForConfig(
      {
        provider: "zai",
        region: "international",
        envVar: "ZAI_API_KEY",
        configField: "web.search.apiKey",
        credential: { value: "zai-secret", source: "env" },
      },
      createPermission(),
    );

    await withFetch(
      async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ search_result: [] }), {
          headers: { "content-type": "application/json" },
        });
      },
      () => definition.execute({ query: "vvoc", freshness: "week" }, createContext()),
    );

    expect(requestBody).toMatchObject({ search_recency_filter: "oneWeek" });
  });

  test("awaits permission before Exa dispatch and returns ranked Markdown metadata", async () => {
    const events: string[] = [];
    const permission = createPermission();
    const definition = createWebSearchToolForConfig(
      {
        provider: "exa",
        envVar: "EXA_API_KEY",
        configField: "web.search.apiKey",
        credential: { value: "exa-secret", source: "env" },
      },
      permission,
    );

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
      async () => {
        const value = await definition.execute(
          { query: "unified web tools", count: 8 },
          createContext(),
        );
        events.push("result");
        return value;
      },
    );

    expect(permission.calls).toEqual([{ action: "web_search", resources: ["unified web tools"] }]);
    expect(events).toEqual(["fetch", "result"]);
    expect(result).toEqual({
      output:
        "1. [Unified Web Tools](https://example.test/web-tools)\n   Provider-neutral search.\n   _2026-07-26_",
      content:
        "1. [Unified Web Tools](https://example.test/web-tools)\n   Provider-neutral search.\n   _2026-07-26_",
      metadata: { provider: "exa", resultCount: 1, credentialSource: "env" },
    });
  });

  test("dispatches Brave and reports config as the credential source", async () => {
    let requestedUrl = "";
    const definition = createWebSearchToolForConfig(
      {
        provider: "brave",
        envVar: "BRAVE_API_KEY",
        configField: "web.search.apiKey",
        credential: { value: "brave-secret", source: "config" },
      },
      createPermission(),
    );

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
    expect(result.metadata).toEqual({
      provider: "brave",
      resultCount: 0,
      credentialSource: "config",
    });
  });

  test("dispatches direct Z.AI search and reports the explicit region", async () => {
    let requestedUrl = "";
    const definition = createWebSearchToolForConfig(
      {
        provider: "zai",
        region: "international",
        envVar: "ZAI_API_KEY",
        configField: "web.search.apiKey",
        credential: { value: "zai-secret", source: "env" },
      },
      createPermission(),
    );

    const result = await withFetch(
      async (url) => {
        requestedUrl = String(url);
        return new Response(
          JSON.stringify({
            search_result: [
              {
                title: "Z.AI Tool API",
                link: "https://example.test/zai",
                content: "Direct search result.",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
      () => definition.execute({ query: "zai", count: 4 }, createContext()),
    );

    expect(requestedUrl).toBe("https://api.z.ai/api/paas/v4/web_search");
    expect(result).toEqual({
      output: "1. [Z.AI Tool API](https://example.test/zai)\n   Direct search result.",
      content: "1. [Z.AI Tool API](https://example.test/zai)\n   Direct search result.",
      metadata: {
        provider: "zai",
        region: "international",
        resultCount: 1,
        credentialSource: "env",
      },
    });
  });

  test("missing credentials name both supported locations without a value", async () => {
    const definition = createWebSearchToolForConfig(
      { provider: "brave", envVar: "BRAVE_API_KEY", configField: "web.search.apiKey" },
      createPermission(),
    );

    const error = await definition
      .execute({ query: "vvoc", count: 8 }, createContext())
      .catch((caught) => caught);

    expect(error).toMatchObject({ provider: "brave", code: "MISSING_CREDENTIAL" });
    expect(String(error.message)).toContain("BRAVE_API_KEY");
    expect(String(error.message)).toContain("web.search.apiKey");
  });

  test("provider errors retain provider and code without leaking credentials", async () => {
    const definition = createWebSearchToolForConfig(
      {
        provider: "exa",
        envVar: "EXA_API_KEY",
        configField: "web.search.apiKey",
        credential: { value: "never-print-this", source: "env" },
      },
      createPermission(),
    );

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
