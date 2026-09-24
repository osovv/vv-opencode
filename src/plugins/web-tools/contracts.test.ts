// FILE: src/plugins/web-tools/contracts.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Contract coverage of the two registered web tool definitions: model-facing JSON Schema projection (closed roots, provider-neutral fields, representable enums/bounds/defaults/descriptions), SDK-shaped accept/reject fixtures through the actual validators, execute-time default application, closed result metadata/attachment producer schemas checked against real service outputs, and bounded structural/provider error identity.
//   SCOPE: Pure contract schemas and validators plus deterministic mocked-transport service calls; no live provider calls and no real credentials.
//   DEPENDS: [bun:test, @opencode-ai/plugin, src/plugins/web-tools/schemas.ts, src/plugins/web-tools/search-service.ts, src/plugins/web-tools/fetch-service.ts, src/plugins/web-tools/providers/exa.ts]
//   LINKS: [M-PLUGIN-WEB-TOOLS, M-WEB-SEARCH-SERVICE, M-WEB-FETCH-SERVICE, M-AGENT-TOOL-CONTRACT, V-M-PLUGIN-WEB-TOOLS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PNG_BYTES - Minimal PNG payload bytes used by media/attachment fixtures.
//   projectionOf - Input-mode JSON Schema projection for one web contract.
//   propertiesOf - Narrow a projection to its properties record.
//   createContext - Build a tool execution context fixture.
//   withFetch - Temporarily install a deterministic global fetch fixture.
//   structuredResult - Narrow a ToolResult to its structured form.
//   searchAccepts - Representative accepted web_search fixtures.
//   searchRejects - Representative rejected web_search fixtures.
//   fetchAccepts - Representative accepted web_fetch fixtures.
//   fetchRejects - Representative rejected web_fetch fixtures.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-006 - Initial projection, fixture, execute-default, real-service result-schema, and error-identity coverage for the web tool contracts.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { tool, type ToolContext, type ToolResult } from "@opencode-ai/plugin";
import { ContractInputError } from "../../lib/agent-tool-contract.js";
import { createWebFetchTool } from "./fetch-service.js";
import { WebProviderError } from "./providers/exa.js";
import type { FetchLike } from "./http.js";
import {
  FETCH_FORMATS,
  SEARCH_FRESHNESS_WINDOWS,
  WEB_CREDENTIAL_SOURCES,
  WEB_FETCH_DEFAULT_TIMEOUT_SECONDS,
  WEB_FETCH_MAX_TIMEOUT_SECONDS,
  WEB_FETCH_TOOL_ID,
  WEB_SEARCH_DEFAULT_COUNT,
  WEB_SEARCH_MAX_COUNT,
  WEB_SEARCH_TOOL_ID,
  webFetchContract,
  webFetchMediaResultSchema,
  webFetchMetadataSchema,
  webFetchResultSchema,
  webFetchTextResultSchema,
  webSearchContract,
  webSearchMetadataSchema,
  webSearchResultSchema,
  webToolContracts,
  validateWebFetchToolInput,
  validateWebSearchToolInput,
} from "./schemas.js";
import { createWebSearchTool } from "./search-service.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

function projectionOf(contract: {
  inputJsonSchema: Record<string, unknown>;
}): Record<string, unknown> {
  return contract.inputJsonSchema;
}

function propertiesOf(projection: Record<string, unknown>): Record<string, unknown> {
  const properties = projection.properties;
  if (!properties || typeof properties !== "object") {
    throw new Error("projection has no properties");
  }
  return properties as Record<string, unknown>;
}

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

const searchAccepts: Array<Record<string, unknown>> = [
  { query: "vvoc" },
  { query: "vvoc", count: 1 },
  { query: "vvoc", count: WEB_SEARCH_MAX_COUNT },
  { query: "vvoc", freshness: "day" },
  { query: "vvoc", freshness: "week" },
  { query: "vvoc", freshness: "month" },
  { query: "vvoc", freshness: "year" },
];

const searchRejects: Array<Record<string, unknown>> = [
  {},
  { query: "" },
  { query: "vvoc", count: 0 },
  { query: "vvoc", count: WEB_SEARCH_MAX_COUNT + 1 },
  { query: "vvoc", count: 1.5 },
  { query: "vvoc", count: "8" },
  { query: "vvoc", count: null },
  { query: "vvoc", freshness: "hour" },
  { query: "vvoc", freshness: null },
  { query: "vvoc", extra: true },
  { query: "vvoc", credential: "secret" },
  { query: "vvoc", provider: "brave" },
  { query: "vvoc", apiKey: "secret" },
];

const fetchAccepts: Array<Record<string, unknown>> = [
  { url: "https://example.test/page" },
  { url: "http://example.test/page", format: "text" },
  { url: "https://example.test/page", format: "html", timeout: 1 },
  { url: "https://example.test/page", format: "markdown", timeout: 0.5 },
  { url: "https://example.test/page", timeout: WEB_FETCH_MAX_TIMEOUT_SECONDS },
];

const fetchRejects: Array<Record<string, unknown>> = [
  {},
  { url: "" },
  { url: "/page" },
  { url: "file:///tmp/secret" },
  { url: "data:text/plain,hello" },
  { url: "ftp://example.test/file" },
  { url: "https://exa mple.test" },
  { url: "https://" },
  { url: "https://example.test/page", format: "pdf" },
  { url: "https://example.test/page", format: "markdown", timeout: 0 },
  { url: "https://example.test/page", timeout: WEB_FETCH_MAX_TIMEOUT_SECONDS + 1 },
  { url: "https://example.test/page", timeout: "30" },
  { url: "https://example.test/page", timeout: null },
  { url: "https://example.test/page", extra: true },
  { url: "https://example.test/page", credential: "secret" },
  { url: "https://example.test/page", provider: "spider" },
  { url: "https://example.test/page", apiKey: "secret" },
];

describe("registered argument maps and published projection", () => {
  test("web_search projects a closed provider-neutral root with representable bounds", () => {
    const projection = projectionOf(webSearchContract);
    expect(projection.type).toBe("object");
    expect(projection.additionalProperties).toBe(false);
    const properties = propertiesOf(projection);
    expect(Object.keys(properties).sort()).toEqual(["count", "freshness", "query"]);
    expect(properties.count).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: WEB_SEARCH_MAX_COUNT,
      default: WEB_SEARCH_DEFAULT_COUNT,
    });
    expect((properties.freshness as { enum?: string[] }).enum).toEqual([
      ...SEARCH_FRESHNESS_WINDOWS,
    ]);
    expect((properties.query as { minLength?: number }).minLength).toBe(1);
    expect(typeof (properties.query as { description?: string }).description).toBe("string");
    expect(JSON.stringify(projection)).not.toContain("unknown");
  });

  test("web_fetch projects a closed provider-neutral root with representable bounds/defaults", () => {
    const projection = projectionOf(webFetchContract);
    expect(projection.type).toBe("object");
    expect(projection.additionalProperties).toBe(false);
    const properties = propertiesOf(projection);
    expect(Object.keys(properties).sort()).toEqual(["format", "timeout", "url"]);
    expect((properties.format as { enum?: string[] }).enum).toEqual([...FETCH_FORMATS]);
    expect(properties.format).toMatchObject({ default: "markdown" });
    expect(properties.timeout).toMatchObject({
      type: "number",
      exclusiveMinimum: 0,
      maximum: WEB_FETCH_MAX_TIMEOUT_SECONDS,
      default: WEB_FETCH_DEFAULT_TIMEOUT_SECONDS,
    });
    expect((properties.url as { minLength?: number }).minLength).toBe(1);
    expect(typeof (properties.timeout as { description?: string }).description).toBe("string");
    expect(JSON.stringify(projection)).not.toContain("unknown");
  });

  test("published roots never expose credential or provider-selection arguments", () => {
    for (const contract of [webSearchContract, webFetchContract]) {
      const keys = Object.keys(propertiesOf(projectionOf(contract)));
      for (const forbidden of ["apiKey", "credential", "provider", "region", "envVar"]) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });

  test("webToolContracts covers exactly the two registered web tools", () => {
    expect(webToolContracts.map((contract) => contract.toolId)).toEqual([
      WEB_SEARCH_TOOL_ID,
      WEB_FETCH_TOOL_ID,
    ]);
    for (const contract of webToolContracts) {
      expect(contract.description.length).toBeGreaterThan(0);
      expect(contract.registeredArgs).toBeTypeOf("object");
    }
  });

  test("registered maps parse through the pinned SDK schema instance with defaults", () => {
    const searchSdk = tool.schema.object(webSearchContract.registeredArgs as never);
    expect(searchSdk.safeParse({ query: "vvoc" }).success).toBe(true);
    const fetchSdk = tool.schema.object(webFetchContract.registeredArgs as never);
    expect(fetchSdk.safeParse({ url: "https://example.test" }).success).toBe(true);

    const search = webSearchContract.safeParse({ query: "vvoc" });
    expect(search.success).toBe(true);
    if (search.success) expect(search.data.count).toBe(WEB_SEARCH_DEFAULT_COUNT);

    const fetch = webFetchContract.safeParse({ url: "https://example.test" });
    expect(fetch.success).toBe(true);
    if (fetch.success) {
      expect(fetch.data.format).toBe("markdown");
      expect(fetch.data.timeout).toBe(WEB_FETCH_DEFAULT_TIMEOUT_SECONDS);
    }
  });
});

describe("operation fixtures through the actual validators", () => {
  test("positive and negative web_search fixtures", () => {
    for (const fixture of searchAccepts) {
      expect(validateWebSearchToolInput(fixture).ok).toBe(true);
    }
    for (const fixture of searchRejects) {
      const result = validateWebSearchToolInput(fixture);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  test("positive and negative web_fetch fixtures including URL scheme/shape", () => {
    for (const fixture of fetchAccepts) {
      expect(validateWebFetchToolInput(fixture).ok).toBe(true);
    }
    for (const fixture of fetchRejects) {
      const result = validateWebFetchToolInput(fixture);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  test("documented defaults are applied by the validators for execute", () => {
    const search = validateWebSearchToolInput({ query: "vvoc" });
    expect(search.ok).toBe(true);
    if (search.ok) expect(search.data.count).toBe(WEB_SEARCH_DEFAULT_COUNT);

    const fetch = validateWebFetchToolInput({ url: "https://example.test/page" });
    expect(fetch.ok).toBe(true);
    if (fetch.ok) {
      expect(fetch.data.format).toBe("markdown");
      expect(fetch.data.timeout).toBe(WEB_FETCH_DEFAULT_TIMEOUT_SECONDS);
    }
  });

  test("checked operation examples agree with the validators", () => {
    for (const example of webSearchContract.examples) {
      expect(validateWebSearchToolInput(example.input).ok).toBe(example.expect === "accept");
    }
    for (const example of webFetchContract.examples) {
      expect(validateWebFetchToolInput(example.input).ok).toBe(example.expect === "accept");
    }
  });

  test("malformed and unsupported URLs diagnose the url field without echoing the raw URL", () => {
    const malformed = validateWebFetchToolInput({ url: "file:///tmp/super-secret-file" });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      const issue = malformed.issues.find((entry) => entry.path === "url");
      expect(issue).toBeDefined();
      expect(issue?.message ?? "").not.toContain("super-secret-file");
    }
  });
});

describe("closed result metadata and attachment producer schemas", () => {
  test("search metadata schemas match each provider variant and reject drift", () => {
    expect(
      webSearchMetadataSchema.safeParse({
        provider: "exa",
        resultCount: 3,
        credentialSource: "env",
      }).success,
    ).toBe(true);
    expect(
      webSearchMetadataSchema.safeParse({
        provider: "brave",
        resultCount: 0,
        credentialSource: "config",
      }).success,
    ).toBe(true);
    expect(
      webSearchMetadataSchema.safeParse({
        provider: "zai",
        region: "china",
        resultCount: 1,
        credentialSource: "env",
      }).success,
    ).toBe(true);

    // A Z.AI result must carry its region; non-Z.AI results must not.
    expect(
      webSearchMetadataSchema.safeParse({
        provider: "zai",
        resultCount: 1,
        credentialSource: "env",
      }).success,
    ).toBe(false);
    expect(
      webSearchMetadataSchema.safeParse({
        provider: "exa",
        region: "china",
        resultCount: 1,
        credentialSource: "env",
      }).success,
    ).toBe(false);
    // Unknown or missing known fields and unsupported credential sources reject.
    expect(
      webSearchMetadataSchema.safeParse({
        provider: "exa",
        resultCount: 1,
        credentialSource: "env",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      webSearchMetadataSchema.safeParse({ provider: "exa", credentialSource: "env" }).success,
    ).toBe(false);
    expect(
      webSearchMetadataSchema.safeParse({
        provider: "exa",
        resultCount: 1,
        credentialSource: "vault",
      }).success,
    ).toBe(false);
    expect(WEB_CREDENTIAL_SOURCES).toEqual(["env", "config"]);
  });

  test("fetch metadata schemas match native, spider, and both Z.AI variants", () => {
    expect(
      webFetchMetadataSchema.safeParse({ provider: "native", format: "markdown", status: 200 })
        .success,
    ).toBe(true);
    expect(
      webFetchMetadataSchema.safeParse({
        provider: "spider",
        format: "html",
        credentialSource: "config",
        status: 207,
        durationMs: 42,
      }).success,
    ).toBe(true);
    expect(
      webFetchMetadataSchema.safeParse({
        provider: "spider",
        format: "text",
        credentialSource: "env",
      }).success,
    ).toBe(true);
    expect(
      webFetchMetadataSchema.safeParse({
        provider: "zai",
        region: "international",
        format: "markdown",
        credentialSource: "env",
        status: 200,
        requestId: "r1",
      }).success,
    ).toBe(true);
    // Direct Z.AI media omits the reader status.
    expect(
      webFetchMetadataSchema.safeParse({
        provider: "zai",
        region: "china",
        format: "markdown",
        credentialSource: "config",
      }).success,
    ).toBe(true);
    expect(
      webFetchMetadataSchema.safeParse({ provider: "native", format: "markdown" }).success,
    ).toBe(false);
    expect(
      webFetchMetadataSchema.safeParse({
        provider: "zai",
        format: "markdown",
        credentialSource: "env",
        status: 200,
      }).success,
    ).toBe(false);
    expect(
      webFetchMetadataSchema.safeParse({
        provider: "native",
        format: "markdown",
        status: 200,
        durationMs: 1,
      }).success,
    ).toBe(false);
  });

  test("fetch text schema requires reader status for Z.AI and rejects an attachments region", () => {
    const text = {
      title: "web_fetch: https://example.test/page",
      output: "body",
      metadata: {
        provider: "zai",
        region: "international",
        format: "markdown",
        credentialSource: "env",
        status: 200,
      },
    };
    expect(webFetchTextResultSchema.safeParse(text).success).toBe(true);
    expect(
      webFetchTextResultSchema.safeParse({
        ...text,
        metadata: {
          provider: "zai",
          region: "international",
          format: "markdown",
          credentialSource: "env",
        },
      }).success,
    ).toBe(false);
    expect(
      webFetchTextResultSchema.safeParse({
        ...text,
        metadata: { provider: "native", format: "markdown", status: 200 },
        attachments: [{ type: "file", mime: "image/png", url: "data:x" }],
      }).success,
    ).toBe(false);
  });

  test("media schema requires a valid attachment and rejects an invalid one", () => {
    const media = {
      title: "web_fetch: https://example.test/image.png",
      output: "Fetched as an image/png attachment.",
      metadata: { provider: "native", format: "markdown", status: 200 },
    };
    const valid = {
      ...media,
      attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AA==" }],
    };
    expect(webFetchMediaResultSchema.safeParse(valid).success).toBe(true);
    expect(webFetchMediaResultSchema.safeParse(media).success).toBe(false);
    expect(
      webFetchMediaResultSchema.safeParse({
        ...media,
        attachments: [{ type: "blob", mime: "image/png", url: "data:x" }],
      }).success,
    ).toBe(false);
    expect(webFetchMediaResultSchema.safeParse({ ...media, attachments: [] }).success).toBe(false);
  });
});

describe("result schemas validate real service outputs", () => {
  test("web_search output validates and unknown injected fields fail", async () => {
    const definition = createWebSearchTool({
      provider: "exa",
      envVar: "EXA_API_KEY",
      configField: "web.search.apiKey",
      credential: { value: "exa-secret", source: "env" },
    });
    const result = await withFetch(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              { title: "One", url: "https://example.test/1", highlights: ["snippet"] },
              { title: "Two", url: "https://example.test/2" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      () => definition.execute({ query: "vvoc", count: 2 }, createContext()),
    );
    const structured = structuredResult(result);
    expect(webSearchResultSchema.safeParse(structured).success).toBe(true);
    expect(
      webSearchResultSchema.safeParse({
        ...structured,
        metadata: { ...(structured.metadata as Record<string, unknown>), extra: 1 },
      }).success,
    ).toBe(false);
  });

  test("web_fetch text and media outputs validate across providers", async () => {
    const native = createWebFetchTool({ provider: "native" });
    const spider = createWebFetchTool({
      provider: "spider",
      envVar: "SPIDER_API_KEY",
      configField: "web.fetch.apiKey",
      credential: { value: "spider-secret", source: "config" },
    });
    const zai = createWebFetchTool({
      provider: "zai",
      region: "international",
      envVar: "ZAI_API_KEY",
      configField: "web.fetch.apiKey",
      credential: { value: "zai-secret", source: "env" },
    });

    const nativeText = await withFetch(
      async () => new Response("plain body", { headers: { "content-type": "text/plain" } }),
      () => native.execute({ url: "https://example.test/page" }, createContext()),
    );
    expect(webFetchResultSchema.safeParse(structuredResult(nativeText)).success).toBe(true);

    const nativeMedia = await withFetch(
      async () => new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
      () => native.execute({ url: "https://example.test/image.png" }, createContext()),
    );
    expect(webFetchResultSchema.safeParse(structuredResult(nativeMedia)).success).toBe(true);

    const spiderText = await withFetch(
      async (url) =>
        String(url).includes("api.spider.cloud")
          ? new Response(JSON.stringify([{ content: "scraped", status: 207, duration: 42 }]))
          : new Response("<html>probe</html>", { headers: { "content-type": "text/html" } }),
      () => spider.execute({ url: "https://example.test/page", format: "html" }, createContext()),
    );
    expect(webFetchResultSchema.safeParse(structuredResult(spiderText)).success).toBe(true);

    const spiderMedia = await withFetch(
      async () => new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
      () => spider.execute({ url: "https://example.test/image.png" }, createContext()),
    );
    expect(webFetchResultSchema.safeParse(structuredResult(spiderMedia)).success).toBe(true);

    const zaiText = await withFetch(
      async (url) =>
        String(url).endsWith("/api/paas/v4/reader")
          ? new Response(
              JSON.stringify({
                request_id: "reader-1",
                reader_result: { title: "Page", content: "content" },
              }),
              { headers: { "content-type": "application/json" } },
            )
          : new Response("<html>probe</html>", { headers: { "content-type": "text/html" } }),
      () => zai.execute({ url: "https://example.test/page" }, createContext()),
    );
    expect(webFetchResultSchema.safeParse(structuredResult(zaiText)).success).toBe(true);

    const zaiMedia = await withFetch(
      async () => new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }),
      () => zai.execute({ url: "https://example.test/image.png" }, createContext()),
    );
    expect(webFetchResultSchema.safeParse(structuredResult(zaiMedia)).success).toBe(true);
  });
});

describe("bounded structural and provider error identity", () => {
  test("invalid direct web_search call rejects before permission or dispatch without leaking values", async () => {
    let asked = false;
    let fetched = false;
    const definition = createWebSearchTool({
      provider: "exa",
      envVar: "EXA_API_KEY",
      configField: "web.search.apiKey",
      credential: { value: "never-print-this", source: "env" },
    });
    const error = await withFetch(
      async () => {
        fetched = true;
        return new Response("unexpected");
      },
      () =>
        definition.execute(
          { query: "vvoc", count: 0, apiKey: "never-print-this" },
          createContext(async () => {
            asked = true;
          }),
        ),
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(ContractInputError);
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      category: "input",
      toolId: WEB_SEARCH_TOOL_ID,
    });
    expect(String(error.message)).not.toContain("never-print-this");
    expect(asked).toBe(false);
    expect(fetched).toBe(false);
  });

  test("invalid direct web_fetch call rejects URL and credential fields before permission or dispatch", async () => {
    let asked = false;
    let fetched = false;
    const definition = createWebFetchTool({ provider: "native" });
    const context = createContext(async () => {
      asked = true;
    });
    const run = (args: Record<string, unknown>) =>
      withFetch(
        async () => {
          fetched = true;
          return new Response("unexpected");
        },
        () => definition.execute(args as never, context),
      ).catch((caught) => caught);

    const urlError = await run({ url: "file:///tmp/super-secret-file" });
    expect(urlError).toBeInstanceOf(ContractInputError);
    if (!(urlError instanceof ContractInputError)) throw urlError;
    expect(urlError.issues.some((issue) => issue.path === "url")).toBe(true);
    expect(String(urlError.message)).not.toContain("super-secret-file");

    const credentialError = await run({
      url: "https://example.test/page",
      credential: "never-print-this",
    });
    expect(credentialError).toBeInstanceOf(ContractInputError);
    if (!(credentialError instanceof ContractInputError)) throw credentialError;
    expect(credentialError.issues.some((issue) => issue.path === "credential")).toBe(true);
    expect(String(credentialError.message)).not.toContain("never-print-this");

    expect(asked).toBe(false);
    expect(fetched).toBe(false);
  });

  test("provider errors keep WebProviderError identity and never print the credential", async () => {
    const definition = createWebSearchTool({
      provider: "exa",
      envVar: "EXA_API_KEY",
      configField: "web.search.apiKey",
      credential: { value: "never-print-this", source: "env" },
    });
    const error = await withFetch(
      async () => new Response("denied", { status: 401 }),
      () => definition.execute({ query: "vvoc" }, createContext()),
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(WebProviderError);
    expect(error).toMatchObject({ provider: "exa", code: "AUTH_FAILED" });
    expect(String(error.message)).not.toContain("never-print-this");
  });
});
