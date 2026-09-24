// FILE: src/plugins/web-tools/schemas.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Single source of the two vvoc-owned web tool contracts: registered raw argument maps, strict runtime schemas with explicit execute-time defaults, args-only URL/shape validation, model-facing descriptions, operation examples, concrete search/fetch result metadata/attachment producer schemas, and the owned contracts consumed by the definition and pre-execute publication seam.
//   SCOPE: Pure contract declarations and args-only validation for web_search and web_fetch: unknown-key rejection, provided-value typing/enum/bounds checks, representable URL scheme/shape checks, and closed result-envelope schemas for the actual provider delivery variants. No network I/O, permission request, credential resolution, provider selection, dispatch, or content rewriting; the services keep transport and credential redaction authority.
//   DEPENDS: [@opencode-ai/plugin, zod (types), src/lib/agent-tool-contract.ts]
//   LINKS: [M-PLUGIN-WEB-TOOLS, M-WEB-SEARCH-SERVICE, M-WEB-FETCH-SERVICE, M-AGENT-TOOL-CONTRACT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WEB_SEARCH_TOOL_ID - Registered tool id for provider-neutral web search.
//   WEB_FETCH_TOOL_ID - Registered tool id for provider-neutral web fetch.
//   WEB_SEARCH_PROVIDERS - Canonical search provider vocabulary.
//   WEB_FETCH_PROVIDERS - Canonical fetch provider vocabulary.
//   WEB_CREDENTIAL_SOURCES - Credential provenance vocabulary reported in metadata.
//   WEB_REGIONS - Canonical Z.AI region vocabulary.
//   WebRegion - Union of supported Z.AI region identifiers.
//   SEARCH_FRESHNESS_WINDOWS - Canonical freshness window vocabulary.
//   WebSearchFreshness - Union of supported freshness window identifiers.
//   FETCH_FORMATS - Canonical textual output format vocabulary.
//   WebFetchFormat - Union of supported textual output format identifiers.
//   WEB_SEARCH_DEFAULT_COUNT - Default result count.
//   WEB_SEARCH_MIN_COUNT - Minimum result count.
//   WEB_SEARCH_MAX_COUNT - Maximum result count.
//   WEB_FETCH_DEFAULT_TIMEOUT_SECONDS - Default per-call timeout in seconds.
//   WEB_FETCH_MAX_TIMEOUT_SECONDS - Maximum model-configurable timeout in seconds.
//   webSearchArgs - Registered raw argument map for web_search.
//   webFetchArgs - Registered raw argument map for web_fetch.
//   WebSearchToolArgs - Schema-derived web_search argument shape with defaults applied.
//   WebFetchToolArgs - Schema-derived web_fetch argument shape with defaults applied.
//   webSearchContract - Owned contract for web_search.
//   webFetchContract - Owned contract for web_fetch.
//   webToolContracts - Owned contracts for both web tools (definition adapter input).
//   WebSearchValidation - Successful parsed search args or bounded issues.
//   WebFetchValidation - Successful parsed fetch args or bounded issues.
//   validateWebSearchToolInput - Structural validation for web_search.
//   validateWebFetchToolInput - Structural plus URL scheme/shape validation for web_fetch.
//   webSearchMetadataSchema - Closed search metadata schema per provider variant.
//   webSearchResultSchema - Closed search result envelope producer schema.
//   webFetchMetadataSchema - Closed fetch metadata schema per provider/delivery variant.
//   webFetchTextResultSchema - Closed textual fetch result envelope producer schema.
//   webFetchMediaResultSchema - Closed media/attachment fetch result envelope producer schema.
//   webFetchResultSchema - Closed fetch result envelope union.
//   WebSearchResultEnvelope - Schema-derived search result envelope.
//   WebFetchResultEnvelope - Schema-derived fetch result envelope.
//   WebSearchMetadata - Schema-derived search metadata union.
//   WebFetchMetadata - Schema-derived fetch metadata union.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-006 - Initial single-source web input/result contracts with explicit execute-time defaults, URL scheme/shape validation before dispatch, closed provider-variant metadata schemas, and operation examples.]
// END_CHANGE_SUMMARY

import { tool } from "@opencode-ai/plugin";
import type { z, ZodRawShape } from "zod";
import {
  MAX_CONTRACT_ISSUES,
  MAX_ISSUE_MESSAGE_CHARS,
  MAX_ISSUE_PATH_CHARS,
  MAX_ISSUE_VALUE_CHARS,
  defineOwnedToolContract,
  ownedToolAttachmentSchema,
  strictObject,
  type ContractIssue,
  type OperationExample,
  type OwnedToolContract,
} from "../../lib/agent-tool-contract.js";

const schema = tool.schema;

// START_BLOCK_TOOL_IDS
/** Registered tool id for provider-neutral web search. */
export const WEB_SEARCH_TOOL_ID = "web_search";
/** Registered tool id for provider-neutral web fetch. */
export const WEB_FETCH_TOOL_ID = "web_fetch";

/** Canonical search provider vocabulary. */
export const WEB_SEARCH_PROVIDERS = ["exa", "brave", "zai"] as const;
/** Canonical fetch provider vocabulary. */
export const WEB_FETCH_PROVIDERS = ["native", "spider", "zai"] as const;
/** Credential provenance vocabulary reported in result metadata. */
export const WEB_CREDENTIAL_SOURCES = ["env", "config"] as const;
/** Canonical Z.AI region vocabulary (matches the canonical vvoc web region enum). */
export const WEB_REGIONS = ["international", "china"] as const;
/** Union of supported Z.AI region identifiers. */
export type WebRegion = (typeof WEB_REGIONS)[number];
/** Canonical freshness window vocabulary. */
export const SEARCH_FRESHNESS_WINDOWS = ["day", "week", "month", "year"] as const;
/** Union of supported freshness window identifiers. */
export type WebSearchFreshness = (typeof SEARCH_FRESHNESS_WINDOWS)[number];
/** Canonical textual output format vocabulary. */
export const FETCH_FORMATS = ["markdown", "text", "html"] as const;
/** Union of supported textual output format identifiers. */
export type WebFetchFormat = (typeof FETCH_FORMATS)[number];

/** Default result count. */
export const WEB_SEARCH_DEFAULT_COUNT = 8;
/** Minimum result count. */
export const WEB_SEARCH_MIN_COUNT = 1;
/** Maximum result count. */
export const WEB_SEARCH_MAX_COUNT = 20;
/** Default per-call timeout in seconds. */
export const WEB_FETCH_DEFAULT_TIMEOUT_SECONDS = 30;
/** Maximum model-configurable timeout in seconds. */
export const WEB_FETCH_MAX_TIMEOUT_SECONDS = 120;
// END_BLOCK_TOOL_IDS

// START_BLOCK_ARG_MAPS
/**
 * Registered raw argument map for web_search (single source of the tool surface).
 * Provider-neutral: no credential, provider, or region arguments are accepted.
 * count carries a representable 1..20 integer bound and the documented default;
 * the execute boundary re-applies the default because the host forwards raw args.
 */
export const webSearchArgs = {
  query: schema.string().min(1).describe("The search query; the text is sent unchanged."),
  count: schema
    .number()
    .int()
    .min(WEB_SEARCH_MIN_COUNT)
    .max(WEB_SEARCH_MAX_COUNT)
    .default(WEB_SEARCH_DEFAULT_COUNT)
    .describe(
      `Number of results, integer ${WEB_SEARCH_MIN_COUNT} through ${WEB_SEARCH_MAX_COUNT}, default ${WEB_SEARCH_DEFAULT_COUNT}.`,
    ),
  freshness: schema
    .enum(SEARCH_FRESHNESS_WINDOWS)
    .optional()
    .describe("Optional time window restricting results: day, week, month, or year."),
};

const webSearchArgsObject = strictObject(webSearchArgs);

/** web_search argument shape with defaults applied, single-sourced from the registered schema. */
export type WebSearchToolArgs = z.infer<typeof webSearchArgsObject>;

/**
 * Registered raw argument map for web_fetch (single source of the tool surface).
 * Provider-neutral: no credential or provider arguments are accepted.
 * format and timeout carry the documented defaults; the execute boundary re-applies
 * them because the host forwards raw args. A provider may drop the numeric bound
 * during schema lowering, so the positive/maximum rule stays runtime-enforced.
 */
export const webFetchArgs = {
  url: schema
    .string()
    .min(1)
    .describe("The HTTP or HTTPS URL to retrieve; the URL is requested unchanged."),
  format: schema
    .enum(FETCH_FORMATS)
    .default("markdown")
    .describe("Output format for textual resources: markdown, text, or html. Default markdown."),
  timeout: schema
    .number()
    .positive()
    .max(WEB_FETCH_MAX_TIMEOUT_SECONDS)
    .default(WEB_FETCH_DEFAULT_TIMEOUT_SECONDS)
    .describe(
      `Timeout in seconds: greater than 0 and at most ${WEB_FETCH_MAX_TIMEOUT_SECONDS}; fractional values are allowed. Default ${WEB_FETCH_DEFAULT_TIMEOUT_SECONDS}.`,
    ),
};

const webFetchArgsObject = strictObject(webFetchArgs);

/** web_fetch argument shape with defaults applied, single-sourced from the registered schema. */
export type WebFetchToolArgs = z.infer<typeof webFetchArgsObject>;
// END_BLOCK_ARG_MAPS

// START_BLOCK_OPERATION_EXAMPLES
const webSearchExamples: readonly OperationExample[] = [
  {
    operation: "search",
    label: "query only applies count 8",
    expect: "accept",
    input: { query: "vvoc" },
  },
  {
    operation: "search",
    label: "explicit integer count at the maximum",
    expect: "accept",
    input: { query: "vvoc", count: WEB_SEARCH_MAX_COUNT },
  },
  {
    operation: "search",
    label: "freshness window filters results",
    expect: "accept",
    input: { query: "vvoc", freshness: "week" },
  },
  {
    operation: "search",
    label: "count below the minimum",
    expect: "reject",
    input: { query: "vvoc", count: 0 },
  },
  {
    operation: "search",
    label: "count above the maximum",
    expect: "reject",
    input: { query: "vvoc", count: WEB_SEARCH_MAX_COUNT + 1 },
  },
  {
    operation: "search",
    label: "fractional count is not an integer",
    expect: "reject",
    input: { query: "vvoc", count: 1.5 },
  },
  {
    operation: "search",
    label: "string count is not coerced",
    expect: "reject",
    input: { query: "vvoc", count: "8" },
  },
  {
    operation: "search",
    label: "null count is not a default",
    expect: "reject",
    input: { query: "vvoc", count: null },
  },
  {
    operation: "search",
    label: "unknown freshness window",
    expect: "reject",
    input: { query: "vvoc", freshness: "hour" },
  },
  {
    operation: "search",
    label: "credential or provider selection is not a caller argument",
    expect: "reject",
    input: { query: "vvoc", credential: "secret", provider: "brave" },
  },
];

const webFetchExamples: readonly OperationExample[] = [
  {
    operation: "fetch",
    label: "url only applies markdown and 30 seconds",
    expect: "accept",
    input: { url: "https://example.test/page" },
  },
  {
    operation: "fetch",
    label: "text format with a fractional positive timeout",
    expect: "accept",
    input: { url: "https://example.test/page", format: "text", timeout: 0.5 },
  },
  {
    operation: "fetch",
    label: "html format at the timeout maximum",
    expect: "accept",
    input: {
      url: "https://example.test/page",
      format: "html",
      timeout: WEB_FETCH_MAX_TIMEOUT_SECONDS,
    },
  },
  {
    operation: "fetch",
    label: "relative url has no absolute scheme",
    expect: "reject",
    input: { url: "/page" },
  },
  {
    operation: "fetch",
    label: "file scheme is unsupported",
    expect: "reject",
    input: { url: "file:///tmp/secret" },
  },
  {
    operation: "fetch",
    label: "data scheme is unsupported",
    expect: "reject",
    input: { url: "data:text/plain,hello" },
  },
  {
    operation: "fetch",
    label: "ftp scheme is unsupported",
    expect: "reject",
    input: { url: "ftp://example.test/file" },
  },
  {
    operation: "fetch",
    label: "malformed host is unparseable",
    expect: "reject",
    input: { url: "https://exa mple.test" },
  },
  {
    operation: "fetch",
    label: "unsupported format",
    expect: "reject",
    input: { url: "https://example.test/page", format: "pdf" },
  },
  {
    operation: "fetch",
    label: "timeout of zero is not positive",
    expect: "reject",
    input: { url: "https://example.test/page", timeout: 0 },
  },
  {
    operation: "fetch",
    label: "timeout above the maximum",
    expect: "reject",
    input: { url: "https://example.test/page", timeout: WEB_FETCH_MAX_TIMEOUT_SECONDS + 1 },
  },
  {
    operation: "fetch",
    label: "string timeout is not coerced",
    expect: "reject",
    input: { url: "https://example.test/page", timeout: "30" },
  },
  {
    operation: "fetch",
    label: "null timeout is not a default",
    expect: "reject",
    input: { url: "https://example.test/page", timeout: null },
  },
  {
    operation: "fetch",
    label: "credential or provider selection is not a caller argument",
    expect: "reject",
    input: { url: "https://example.test/page", apiKey: "secret", provider: "spider" },
  },
];
// END_BLOCK_OPERATION_EXAMPLES

// START_BLOCK_CONTRACTS
/** Owned contract for web_search. */
export const webSearchContract = defineOwnedToolContract({
  toolId: WEB_SEARCH_TOOL_ID,
  description:
    "Search the web using the configured provider and return ranked results as Markdown. Use for discovering information; returns titles, URLs, snippets, and dates.",
  registeredArgs: webSearchArgs,
  examples: webSearchExamples,
});

/** Owned contract for web_fetch. */
export const webFetchContract = defineOwnedToolContract({
  toolId: WEB_FETCH_TOOL_ID,
  description:
    "Fetch a known HTTP or HTTPS URL using the configured provider. Returns Markdown, text, raw HTML, or an image/PDF attachment.",
  registeredArgs: webFetchArgs,
  examples: webFetchExamples,
});

/** Owned contracts for both web tools (input to the owned definition/pre-execute adapters). */
export const webToolContracts: readonly OwnedToolContract<ZodRawShape>[] = [
  webSearchContract,
  webFetchContract,
];
// END_BLOCK_CONTRACTS

// START_BLOCK_ISSUE_HELPERS
function truncateChars(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function boundedIssue(issue: ContractIssue): ContractIssue {
  return {
    code: issue.code,
    path: truncateChars(issue.path, MAX_ISSUE_PATH_CHARS),
    message: truncateChars(issue.message, MAX_ISSUE_MESSAGE_CHARS),
    ...(issue.expected !== undefined
      ? { expected: truncateChars(issue.expected, MAX_ISSUE_MESSAGE_CHARS) }
      : {}),
    ...(issue.received !== undefined
      ? { received: truncateChars(issue.received, MAX_ISSUE_VALUE_CHARS) }
      : {}),
  };
}

function pushIssue(issues: ContractIssue[], issue: ContractIssue): void {
  if (issues.length >= MAX_CONTRACT_ISSUES) return;
  issues.push(boundedIssue(issue));
}
// END_BLOCK_ISSUE_HELPERS

// START_BLOCK_VALIDATION
/** Successful parsed search args or bounded structural issues. */
export type WebSearchValidation =
  | { ok: true; data: WebSearchToolArgs }
  | { ok: false; issues: readonly ContractIssue[] };

/** Successful parsed fetch args or bounded structural/URL issues. */
export type WebFetchValidation =
  | { ok: true; data: WebFetchToolArgs }
  | { ok: false; issues: readonly ContractIssue[] };

/**
 * Strict structural validation for web_search.
 * Unknown root keys, malformed provided values, unsupported freshness windows, and
 * out-of-bounds counts reject; the documented count default is applied for execute.
 * The query text is preserved verbatim.
 */
export function validateWebSearchToolInput(raw: unknown): WebSearchValidation {
  const parsed = webSearchContract.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.issues };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Strict structural plus URL scheme/shape validation for web_fetch.
 * Structural failures reject first; then the URL must parse as an absolute HTTP or
 * HTTPS URL. Diagnostics identify the offending `url` field with a bounded message
 * that never echoes the raw URL (which may carry credentials) or an error payload.
 * The format and timeout defaults are applied for execute.
 */
export function validateWebFetchToolInput(raw: unknown): WebFetchValidation {
  const parsed = webFetchContract.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.issues };
  }

  const issues: ContractIssue[] = [];
  let parsedUrl: URL | undefined;
  try {
    parsedUrl = new URL(parsed.data.url);
  } catch {
    pushIssue(issues, {
      code: "invalid_format",
      path: "url",
      message: "url must be an absolute HTTP or HTTPS URL",
      expected: "an absolute http(s) URL",
    });
  }
  if (parsedUrl && parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    const scheme = truncateChars(parsedUrl.protocol.replace(/:$/, ""), MAX_ISSUE_VALUE_CHARS);
    pushIssue(issues, {
      code: "invalid_value",
      path: "url",
      message: `unsupported URL scheme "${scheme}"; only http and https are supported`,
      expected: "http or https",
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, data: parsed.data };
}
// END_BLOCK_VALIDATION

// START_BLOCK_RESULT_SCHEMAS
const credentialSourceSchema = schema.enum(WEB_CREDENTIAL_SOURCES);
const formatSchema = schema.enum(FETCH_FORMATS);
const regionSchema = schema.enum(WEB_REGIONS);
const [EXA, BRAVE, ZAI_SEARCH] = WEB_SEARCH_PROVIDERS;
const [NATIVE, SPIDER, ZAI_FETCH] = WEB_FETCH_PROVIDERS;

/**
 * Closed search metadata schemas for the actual delivery variants.
 * `region` is present only for the direct Z.AI provider; unknown fields and
 * missing known fields reject.
 */
export const webSearchMetadataSchema = schema.union([
  strictObject({
    provider: schema.literal(EXA),
    resultCount: schema.number().int().min(0),
    credentialSource: credentialSourceSchema,
  }),
  strictObject({
    provider: schema.literal(BRAVE),
    resultCount: schema.number().int().min(0),
    credentialSource: credentialSourceSchema,
  }),
  strictObject({
    provider: schema.literal(ZAI_SEARCH),
    region: regionSchema,
    resultCount: schema.number().int().min(0),
    credentialSource: credentialSourceSchema,
  }),
]);

/**
 * Closed result envelope for web_search producer/test checks.
 * `output` is the rendered Markdown document and stays a declared opaque string.
 * This is never applied as a throw-after-side-effect execute wrapper.
 */
export const webSearchResultSchema = strictObject({
  title: schema.string(),
  output: schema.string(),
  metadata: webSearchMetadataSchema,
});

/**
 * Closed fetch metadata schemas for the actual provider/delivery variants.
 * Native reports its status; Spider may add status/duration; Z.AI reader text
 * carries its regional request metadata while direct Z.AI media reports only the
 * region/format/credential provenance. Region is required for every Z.AI variant.
 */
export const webFetchMetadataSchema = schema.union([
  strictObject({
    provider: schema.literal(NATIVE),
    format: formatSchema,
    status: schema.number().int(),
  }),
  strictObject({
    provider: schema.literal(SPIDER),
    format: formatSchema,
    credentialSource: credentialSourceSchema,
    status: schema.number().int().optional(),
    durationMs: schema.number().optional(),
  }),
  strictObject({
    provider: schema.literal(ZAI_FETCH),
    region: regionSchema,
    format: formatSchema,
    credentialSource: credentialSourceSchema,
    status: schema.number().int(),
    requestId: schema.string().optional(),
    model: schema.string().optional(),
    created: schema.number().optional(),
    title: schema.string().optional(),
  }),
  strictObject({
    provider: schema.literal(ZAI_FETCH),
    region: regionSchema,
    format: formatSchema,
    credentialSource: credentialSourceSchema,
  }),
]);

/** Closed textual fetch result envelope producer schema (no attachments region). */
export const webFetchTextResultSchema = strictObject({
  title: schema.string(),
  output: schema.string(),
  metadata: schema.union([
    strictObject({
      provider: schema.literal(NATIVE),
      format: formatSchema,
      status: schema.number().int(),
    }),
    strictObject({
      provider: schema.literal(SPIDER),
      format: formatSchema,
      credentialSource: credentialSourceSchema,
      status: schema.number().int().optional(),
      durationMs: schema.number().optional(),
    }),
    strictObject({
      provider: schema.literal(ZAI_FETCH),
      region: regionSchema,
      format: formatSchema,
      credentialSource: credentialSourceSchema,
      status: schema.number().int(),
      requestId: schema.string().optional(),
      model: schema.string().optional(),
      created: schema.number().optional(),
      title: schema.string().optional(),
    }),
  ]),
});

/** Closed media fetch result envelope producer schema requiring a real attachment. */
export const webFetchMediaResultSchema = strictObject({
  title: schema.string(),
  output: schema.string(),
  metadata: schema.union([
    strictObject({
      provider: schema.literal(NATIVE),
      format: formatSchema,
      status: schema.number().int(),
    }),
    strictObject({
      provider: schema.literal(SPIDER),
      format: formatSchema,
      credentialSource: credentialSourceSchema,
      status: schema.number().int().optional(),
      durationMs: schema.number().optional(),
    }),
    strictObject({
      provider: schema.literal(ZAI_FETCH),
      region: regionSchema,
      format: formatSchema,
      credentialSource: credentialSourceSchema,
    }),
  ]),
  attachments: schema.array(ownedToolAttachmentSchema).min(1),
});

/** Closed fetch result envelope union for producer/test checks. */
export const webFetchResultSchema = schema.union([
  webFetchTextResultSchema,
  webFetchMediaResultSchema,
]);

/** Schema-derived search result envelope. */
export type WebSearchResultEnvelope = z.infer<typeof webSearchResultSchema>;
/** Schema-derived fetch result envelope. */
export type WebFetchResultEnvelope = z.infer<typeof webFetchResultSchema>;
/** Schema-derived search metadata union. */
export type WebSearchMetadata = z.infer<typeof webSearchMetadataSchema>;
/** Schema-derived fetch metadata union. */
export type WebFetchMetadata = z.infer<typeof webFetchMetadataSchema>;
// END_BLOCK_RESULT_SCHEMAS
