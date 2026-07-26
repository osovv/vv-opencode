// FILE: src/plugins/web-tools/media-loader.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Load supported images and PDFs as base64 file attachments for the web tools fetch path.
//   SCOPE: MIME and magic-byte identification, base64 data-URL attachment construction, filename derivation, and rejection of unsupported or oversized payloads.
//   DEPENDS: [src/plugins/web-tools/http.ts, @opencode-ai/plugin]
//   LINKS: [M-WEB-MEDIA-LOADER, M-WEB-HTTP, M-WEB-NATIVE-FETCH, M-WEB-SPIDER]
//   ROLE: CORE_LOGIC
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SUPPORTED_MEDIA_MIME_TYPES - Tuple of supported media MIME types.
//   SupportedMediaMimeType - Supported media MIME type union.
//   WebMediaError - Unsupported-media error carrying the detected or declared MIME type.
//   sniffMediaMimeType - Detect a supported MIME type from leading bytes.
//   mediaAttachmentFromBytes - Build a base64 data-URL attachment from already-fetched bytes.
//   loadMediaAttachment - Fetch a URL and return it as an attachment when supported.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial direct media attachment loader for the unified web tools.]
// END_CHANGE_SUMMARY

import type { ToolAttachment } from "@opencode-ai/plugin";
import {
  DEFAULT_MEDIA_MAX_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  requestBounded,
  WebHttpError,
  type FetchLike,
} from "./http.js";

export const SUPPORTED_MEDIA_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
] as const;

export type SupportedMediaMimeType = (typeof SUPPORTED_MEDIA_MIME_TYPES)[number];

/** Unsupported-media failure. The message names the detected or declared MIME type and never includes the payload. */
export class WebMediaError extends Error {
  readonly code: "UNSUPPORTED";
  readonly mime?: string;

  constructor(message: string, mime?: string) {
    super(message);
    this.name = "WebMediaError";
    this.code = "UNSUPPORTED";
    this.mime = mime;
  }
}

const EXTENSION_BY_MIME: Record<SupportedMediaMimeType, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

// START_BLOCK_SNIFF
/**
 * Sniff the media MIME type from leading bytes.
 * Returns undefined when the signature matches no supported format.
 */
export function sniffMediaMimeType(bytes: Uint8Array): SupportedMediaMimeType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return "application/pdf";
  }
  return undefined;
}
// END_BLOCK_SNIFF

// START_BLOCK_HELPERS
function normalizeDeclaredContentType(declared?: string): string | undefined {
  if (!declared) {
    return undefined;
  }
  const mime = declared.split(";")[0]?.trim().toLowerCase();
  return mime || undefined;
}

function filenameFromUrl(url: string, mime: SupportedMediaMimeType): string {
  const extension = EXTENSION_BY_MIME[mime];
  try {
    const base = new URL(url).pathname.split("/").pop() ?? "";
    if (base && base.includes(".")) {
      return base;
    }
    if (base) {
      return `${base}${extension}`;
    }
    return `resource${extension}`;
  } catch {
    return `resource${extension}`;
  }
}

function resolveMimeType(
  bytes: Uint8Array,
  declaredContentType?: string,
): SupportedMediaMimeType | undefined {
  const sniffed = sniffMediaMimeType(bytes);
  if (sniffed) {
    return sniffed;
  }
  const declared = normalizeDeclaredContentType(declaredContentType);
  if (declared && (SUPPORTED_MEDIA_MIME_TYPES as readonly string[]).includes(declared)) {
    return declared as SupportedMediaMimeType;
  }
  return undefined;
}
// END_BLOCK_HELPERS

// START_CONTRACT: mediaAttachmentFromBytes
//   PURPOSE: Build a base64 data-URL file attachment from already-fetched bytes.
//   INPUTS: { bytes: payload; source: url, declaredContentType, optional maxBytes }
//   OUTPUTS: { ToolAttachment - type file, mime, data URL, filename }
//   SIDE_EFFECTS: none; performs no network I/O
//   LINKS: M-WEB-NATIVE-FETCH, M-WEB-SPIDER
// END_CONTRACT: mediaAttachmentFromBytes
export function mediaAttachmentFromBytes(
  bytes: Uint8Array,
  source: { url: string; declaredContentType?: string; maxBytes?: number },
): ToolAttachment {
  const maxBytes = source.maxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
  if (bytes.byteLength > maxBytes) {
    throw new WebHttpError("OVERSIZED", `media payload exceeded ${maxBytes} bytes`);
  }
  const mime = resolveMimeType(bytes, source.declaredContentType);
  if (!mime) {
    const detail =
      sniffMediaMimeType(bytes) ??
      normalizeDeclaredContentType(source.declaredContentType) ??
      "unknown";
    throw new WebMediaError(
      `unsupported media type: ${detail}`,
      detail === "unknown" ? undefined : detail,
    );
  }
  const base64 = Buffer.from(bytes).toString("base64");
  return {
    type: "file",
    mime,
    url: `data:${mime};base64,${base64}`,
    filename: filenameFromUrl(source.url, mime),
  };
}

// START_CONTRACT: loadMediaAttachment
//   PURPOSE: Fetch a URL through the bounded transport and return it as an attachment when supported.
//   INPUTS: { input: url, optional abort, timeoutMs, maxBytes; fetchImpl: injectable fetch }
//   OUTPUTS: { ToolAttachment }
//   SIDE_EFFECTS: performs network I/O through fetchImpl
//   LINKS: M-WEB-HTTP
// END_CONTRACT: loadMediaAttachment
export async function loadMediaAttachment(
  input: { url: string; abort?: AbortSignal; timeoutMs?: number; maxBytes?: number },
  fetchImpl?: FetchLike,
): Promise<ToolAttachment> {
  const maxBytes = input.maxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
  const response = await requestBounded(
    {
      url: input.url,
      timeoutMs: input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxBytes,
      abort: input.abort,
    },
    fetchImpl,
  );
  return mediaAttachmentFromBytes(response.bytes, {
    url: response.finalUrl,
    declaredContentType: response.headers.get("content-type") ?? undefined,
    maxBytes,
  });
}
