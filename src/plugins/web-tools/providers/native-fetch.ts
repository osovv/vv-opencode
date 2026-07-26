// FILE: src/plugins/web-tools/providers/native-fetch.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Fetch HTTP and HTTPS resources directly and dispatch the body to media, HTML conversion, or plain text passthrough.
//   SCOPE: Redirect following and size limits via the bounded transport, MIME and signature sniffing, local HTML conversion, and rejection of unsupported binaries.
//   DEPENDS: [src/plugins/web-tools/http.ts, src/plugins/web-tools/html-markdown.ts, src/plugins/web-tools/media-loader.ts, src/plugins/web-tools/providers/exa.ts, @opencode-ai/plugin]
//   LINKS: [M-WEB-NATIVE-FETCH, M-WEB-HTTP, M-WEB-HTML-MARKDOWN, M-WEB-MEDIA-LOADER]
//   ROLE: INTEGRATION
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   NativeFetchOutcome - Text or media outcome of a native fetch.
//   fetchNative - Fetch one URL and dispatch its body by content.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial native fetch provider with local conversion.]
// END_CHANGE_SUMMARY

import type { ToolAttachment } from "@opencode-ai/plugin";
import { convertHtmlToMarkdown, convertHtmlToText } from "../html-markdown.js";
import {
  DEFAULT_MEDIA_MAX_BYTES,
  DEFAULT_TEXT_MAX_BYTES,
  requestBounded,
  WebHttpError,
  type FetchLike,
} from "../http.js";
import {
  mediaAttachmentFromBytes,
  sniffMediaMimeType,
  SUPPORTED_MEDIA_MIME_TYPES,
} from "../media-loader.js";
import { WebProviderError } from "./exa.js";

export type NativeFetchOutcome =
  | {
      kind: "text";
      content: string;
      contentType: string;
      finalUrl: string;
      status: number;
    }
  | {
      kind: "media";
      attachment: ToolAttachment;
      finalUrl: string;
      status: number;
    };

const STRUCTURED_TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "text/xml",
  "application/javascript",
  "text/javascript",
]);

// START_BLOCK_HELPERS
function normalizeContentType(declared?: string): string | undefined {
  if (!declared) {
    return undefined;
  }
  const mime = declared.split(";")[0]?.trim().toLowerCase();
  return mime || undefined;
}

function isSupportedMediaMime(mime: string): boolean {
  return (SUPPORTED_MEDIA_MIME_TYPES as readonly string[]).includes(mime);
}

function isTextLike(mime: string | undefined): boolean {
  if (!mime) {
    return true;
  }
  if (mime.startsWith("text/")) {
    return true;
  }
  if (STRUCTURED_TEXT_TYPES.has(mime)) {
    return true;
  }
  return mime.endsWith("+json") || mime.endsWith("+xml");
}

function looksLikeHtml(mime: string | undefined, text: string): boolean {
  if (mime === "text/html" || mime === "application/xhtml+xml") {
    return true;
  }
  if (!mime || mime === "application/octet-stream") {
    return /<\s*(html|body|div|p|h[1-6]|table)\b/i.test(text.slice(0, 2000));
  }
  return false;
}
// END_BLOCK_HELPERS

// START_CONTRACT: fetchNative
//   PURPOSE: Fetch one URL through the bounded transport with redirects followed and dispatch the body by content.
//   INPUTS: { input: url, format, abort, timeoutMs, optional maxBytes; fetchImpl: injectable fetch }
//   OUTPUTS: { NativeFetchOutcome - text or media }
//   SIDE_EFFECTS: performs network I/O through fetchImpl
//   LINKS: M-WEB-FETCH-SERVICE
// END_CONTRACT: fetchNative
export async function fetchNative(
  input: {
    url: string;
    format: "markdown" | "text" | "html";
    abort: AbortSignal;
    timeoutMs: number;
    maxBytes?: number;
  },
  fetchImpl?: FetchLike,
): Promise<NativeFetchOutcome> {
  const downloadCap = input.maxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
  const response = await requestBounded(
    {
      url: input.url,
      timeoutMs: input.timeoutMs,
      maxBytes: downloadCap,
      abort: input.abort,
    },
    fetchImpl,
  );

  const declared = normalizeContentType(response.headers.get("content-type") ?? undefined);
  const sniffed = sniffMediaMimeType(response.bytes);

  if (sniffed || (declared && isSupportedMediaMime(declared))) {
    const attachment = mediaAttachmentFromBytes(response.bytes, {
      url: response.finalUrl,
      declaredContentType: declared,
      maxBytes: downloadCap,
    });
    return { kind: "media", attachment, finalUrl: response.finalUrl, status: response.status };
  }

  if (isTextLike(declared)) {
    const textCap = input.maxBytes ?? DEFAULT_TEXT_MAX_BYTES;
    if (response.bytes.byteLength > textCap) {
      throw new WebHttpError("OVERSIZED", `text response exceeded ${textCap} bytes`);
    }
    const text = new TextDecoder().decode(response.bytes);
    const content = looksLikeHtml(declared, text)
      ? input.format === "markdown"
        ? convertHtmlToMarkdown(text)
        : input.format === "text"
          ? convertHtmlToText(text)
          : text
      : text;
    return {
      kind: "text",
      content,
      contentType: declared ?? "text/plain",
      finalUrl: response.finalUrl,
      status: response.status,
    };
  }

  throw new WebProviderError(
    "native",
    "UNSUPPORTED",
    `unsupported content type: ${declared ?? "unknown"}`,
  );
}
