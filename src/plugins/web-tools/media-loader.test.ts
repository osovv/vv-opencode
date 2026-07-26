// FILE: src/plugins/web-tools/media-loader.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the direct media attachment loader: per-format attachments, signature sniffing, filename derivation, and unsupported and oversized rejection.
//   SCOPE: Deterministic tests using fixed byte fixtures and an injected fetch implementation.
//   DEPENDS: [bun:test, src/plugins/web-tools/media-loader.ts, src/plugins/web-tools/http.ts]
//   LINKS: [M-WEB-MEDIA-LOADER]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PNG_BYTES - Minimal PNG signature fixture.
//   JPEG_BYTES - Minimal JPEG signature fixture.
//   GIF_BYTES - Minimal GIF signature fixture.
//   WEBP_BYTES - Minimal WebP signature fixture.
//   PDF_BYTES - Minimal PDF signature fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial coverage for the direct media attachment loader.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { FetchLike } from "./http.js";
import {
  loadMediaAttachment,
  mediaAttachmentFromBytes,
  sniffMediaMimeType,
  WebMediaError,
} from "./media-loader.js";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]);
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

describe("sniffMediaMimeType", () => {
  test("detects each supported format by signature", () => {
    expect(sniffMediaMimeType(JPEG_BYTES)).toBe("image/jpeg");
    expect(sniffMediaMimeType(PNG_BYTES)).toBe("image/png");
    expect(sniffMediaMimeType(GIF_BYTES)).toBe("image/gif");
    expect(sniffMediaMimeType(WEBP_BYTES)).toBe("image/webp");
    expect(sniffMediaMimeType(PDF_BYTES)).toBe("application/pdf");
  });

  test("returns undefined for an unknown signature", () => {
    expect(sniffMediaMimeType(new Uint8Array([0, 1, 2, 3]))).toBeUndefined();
  });
});

describe("mediaAttachmentFromBytes", () => {
  test("produces type-file attachments with correct mime and data URL", () => {
    const attachment = mediaAttachmentFromBytes(PNG_BYTES, { url: "https://x.test/img.png" });
    expect(attachment.type).toBe("file");
    expect(attachment.mime).toBe("image/png");
    expect(attachment.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("derives the filename from the URL path", () => {
    const attachment = mediaAttachmentFromBytes(PNG_BYTES, {
      url: "https://x.test/images/photo.png",
    });
    expect(attachment.filename).toBe("photo.png");
  });

  test("falls back to a basename with extension when the path has no file extension", () => {
    const attachment = mediaAttachmentFromBytes(PNG_BYTES, { url: "https://x.test/images/photo" });
    expect(attachment.filename).toBe("photo.png");
  });

  test("strips the query string from the filename", () => {
    const attachment = mediaAttachmentFromBytes(PNG_BYTES, {
      url: "https://x.test/a.png?token=secret",
    });
    expect(attachment.filename).toBe("a.png");
  });

  test("signature overrides a generic octet-stream content type", () => {
    const attachment = mediaAttachmentFromBytes(PNG_BYTES, {
      url: "https://x.test/img",
      declaredContentType: "application/octet-stream",
    });
    expect(attachment.mime).toBe("image/png");
  });

  test("rejects unsupported binary content naming the MIME type", () => {
    const error = mediaAttachmentFromBytes.bind(null, new Uint8Array([0, 1, 2, 3]), {
      url: "https://x.test/file.zip",
      declaredContentType: "application/zip",
    });
    expect(error).toThrow(WebMediaError);
    try {
      error();
    } catch (caught) {
      expect((caught as WebMediaError).mime).toBe("application/zip");
    }
  });

  test("rejects oversized payloads with WebHttpError code OVERSIZED", async () => {
    await expect(
      Promise.resolve().then(() =>
        mediaAttachmentFromBytes(PNG_BYTES, { url: "https://x.test/img.png", maxBytes: 5 }),
      ),
    ).rejects.toMatchObject({ code: "OVERSIZED" });
  });
});

describe("loadMediaAttachment", () => {
  test("fetches and builds an attachment through the injected fetch", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } });
    const attachment = await loadMediaAttachment({ url: "https://x.test/pic.png" }, fetchImpl);
    expect(attachment.mime).toBe("image/png");
    expect(attachment.type).toBe("file");
  });
});
