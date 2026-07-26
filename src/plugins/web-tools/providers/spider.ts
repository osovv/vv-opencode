// FILE: src/plugins/web-tools/providers/spider.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Call the Spider.cloud Scrape API for one exact URL and serve binary targets through the shared direct media loader.
//   SCOPE: Bearer auth, mapped return_format, array envelope validation, status and duration metadata, provider error mapping, and media-first dispatch.
//   DEPENDS: [src/plugins/web-tools/http.ts, src/plugins/web-tools/config.ts, src/plugins/web-tools/media-loader.ts, src/plugins/web-tools/providers/exa.ts, @opencode-ai/plugin]
//   LINKS: [M-WEB-SPIDER, M-WEB-HTTP, M-WEB-MEDIA-LOADER, M-WEB-FETCH-SERVICE]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SpiderOutcome - Text or media outcome of a Spider scrape.
//   scrapeSpider - Serve media targets directly, otherwise scrape one URL through Spider.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial Spider Scrape adapter.]
// END_CHANGE_SUMMARY

import type { ToolAttachment } from "@opencode-ai/plugin";
import type { WebProviderCredential } from "../config.js";
import {
  DEFAULT_TEXT_MAX_BYTES,
  requestBounded,
  type BoundedHttpResponse,
  type FetchLike,
} from "../http.js";
import { loadMediaAttachment, WebMediaError } from "../media-loader.js";
import { mapHttpErrorToProviderError, WebProviderError } from "./exa.js";

const SPIDER_SCRAPE_URL = "https://api.spider.cloud/scrape";

const SPIDER_RETURN_FORMAT = { markdown: "markdown", text: "text", html: "raw" } as const;

export type SpiderOutcome =
  | {
      kind: "text";
      content: string;
      metadata: { status?: number; durationMs?: number };
    }
  | {
      kind: "media";
      attachment: ToolAttachment;
      metadata: { status?: number; durationMs?: number };
    };

// START_BLOCK_HELPERS
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSpiderResponse(bytes: Uint8Array): SpiderOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new WebProviderError("spider", "BAD_RESPONSE", "malformed JSON response from spider");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new WebProviderError("spider", "BAD_RESPONSE", "unexpected spider response envelope");
  }
  const entry = parsed[0];
  if (!isPlainObject(entry)) {
    throw new WebProviderError("spider", "BAD_RESPONSE", "unexpected spider response envelope");
  }

  const status = typeof entry.status === "number" ? entry.status : undefined;
  const duration = typeof entry.duration === "number" ? entry.duration : undefined;
  const metadata = {
    ...(status !== undefined ? { status } : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}),
  };

  if (entry.error) {
    const detail = typeof entry.error === "string" ? entry.error : "scrape failed";
    throw new WebProviderError("spider", "PROVIDER_ERROR", `spider error: ${detail}`, status);
  }

  const content = typeof entry.content === "string" ? entry.content : undefined;
  if (content === undefined) {
    throw new WebProviderError("spider", "BAD_RESPONSE", "spider response missing content");
  }
  return { kind: "text", content, metadata };
}
// END_BLOCK_HELPERS

// START_CONTRACT: scrapeSpider
//   PURPOSE: Serve image and PDF targets through the shared media loader; scrape textual targets through Spider.
//   INPUTS: { input: url, format, credential, abort, timeoutMs; fetchImpl: injectable fetch }
//   OUTPUTS: { SpiderOutcome - text or media with provider metadata }
//   SIDE_EFFECTS: performs network I/O through fetchImpl; never logs the credential
//   LINKS: M-WEB-FETCH-SERVICE
// END_CONTRACT: scrapeSpider
export async function scrapeSpider(
  input: {
    url: string;
    format: "markdown" | "text" | "html";
    credential: WebProviderCredential;
    abort: AbortSignal;
    timeoutMs: number;
  },
  fetchImpl?: FetchLike,
): Promise<SpiderOutcome> {
  try {
    const attachment = await loadMediaAttachment(
      { url: input.url, abort: input.abort, timeoutMs: input.timeoutMs },
      fetchImpl,
    );
    return { kind: "media", attachment, metadata: {} };
  } catch (error) {
    if (!(error instanceof WebMediaError)) {
      throw error;
    }
  }

  const body = JSON.stringify({
    url: input.url,
    return_format: [SPIDER_RETURN_FORMAT[input.format]],
  });

  let response: BoundedHttpResponse;
  try {
    response = await requestBounded(
      {
        url: SPIDER_SCRAPE_URL,
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.credential.value}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
        timeoutMs: input.timeoutMs,
        maxBytes: DEFAULT_TEXT_MAX_BYTES,
        abort: input.abort,
      },
      fetchImpl,
    );
  } catch (error) {
    mapHttpErrorToProviderError(error, "spider");
    throw error;
  }

  return parseSpiderResponse(response.bytes);
}
