// FILE: src/plugins/secrets-redaction/deep.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for deep redaction/restore traversal.
//   SCOPE: media data-URL pass-through in redactDeep/restoreDeep and bearer-token redaction in nested tool-result shapes.
//   DEPENDS: bun:test, deep, patterns, session
//   LINKS: [M-PLUGIN-SECRETS-REDACTION, V-M-PLUGIN-SECRETS-REDACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SECRET - Reusable session-secret fixture.
//   createSession - Creates a placeholder session for redaction checks.
//   mediaDataUrl - Builds a media data-URL whose base64 body is bearer_token bait.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [FIX-MEDIA-400 - Added regression coverage that redactDeep preserves media data URLs byte-exact while still redacting nested bearer-like tokens.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { redactDeep, restoreDeep } from "./deep.js";
import { buildPatternSet } from "./patterns.js";
import { PlaceholderSession } from "./session.js";

const SECRET = "test-secret-for-redaction";

function createSession() {
  return new PlaceholderSession({
    prefix: "__VVOC_SECRET_",
    ttlMs: 60_000,
    maxMappings: 1000,
    secret: SECRET,
  });
}

function mediaDataUrl(mime = "image/png"): string {
  // The body is two 32+ character [A-Za-z0-9] runs separated by base64 alphabet
  // characters (`+`, `/`): every run is a bearer_token match inside the payload,
  // exactly like a real PNG read from disk.
  const body =
    "iVBORw0KGgoAAAANSUhEUgAAAJYAAACICAYAAAAKmzymA" +
    "+/9" +
    "QwMDA0NDQ2NjY4ODg4RERETFxcXHx8fIyMjJycnKysrL" +
    "B/8=";
  return `data:${mime};base64,${body}`;
}

describe("redactDeep media data-URL pass-through", () => {
  test("preserves a read-tool media part byte-exact", () => {
    const session = createSession();
    const patternSet = buildPatternSet({ builtin: ["bearer_token"] });
    const uri = mediaDataUrl();
    const value = {
      content: [
        { type: "text", text: "Image read successfully" },
        { type: "file", uri, mime: "image/png" },
      ],
    };

    const redacted = redactDeep(value, patternSet, session) as typeof value;

    expect((redacted.content[1] as { uri: string }).uri).toBe(uri);
    expect(JSON.stringify(redacted)).not.toContain("__VVOC_SECRET_");
  });

  test("preserves pdf and audio media data URLs byte-exact", () => {
    const session = createSession();
    const patternSet = buildPatternSet({ builtin: ["bearer_token"] });
    const parts = {
      pdf: mediaDataUrl("application/pdf"),
      audio: mediaDataUrl("audio/mpeg"),
    };

    const redacted = redactDeep(parts, patternSet, session) as typeof parts;

    expect(redacted.pdf).toBe(parts.pdf);
    expect(redacted.audio).toBe(parts.audio);
  });

  test("still redacts bearer-like tokens outside media data URLs", () => {
    const session = createSession();
    const patternSet = buildPatternSet({ builtin: ["bearer_token"] });
    const token = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"; // 36 chars
    const value = { value: { note: `token=${token}` } };

    const redacted = redactDeep(value, patternSet, session) as {
      value: { note: string };
    };

    expect(redacted.value.note).not.toContain(token);
    expect(redacted.value.note).toContain("__VVOC_SECRET_");
  });

  test("still redacts raw base64 without a data: prefix", () => {
    const session = createSession();
    const patternSet = buildPatternSet({ builtin: ["bearer_token"] });
    const opaque = "iVBORw0KGgoAAAANSUhEUgAAAJYAAACICAYAAAAKmzymA";
    const value = { value: { blob: opaque } };

    const redacted = redactDeep(value, patternSet, session) as {
      value: { blob: string };
    };

    expect(redacted.value.blob).not.toBe(opaque);
    expect(redacted.value.blob).toContain("__VVOC_SECRET_");
  });

  test("restoreDeep round-trips a redacted nested token", () => {
    const session = createSession();
    const patternSet = buildPatternSet({ builtin: ["bearer_token"] });
    const token = "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"; // 36 chars
    const value = { value: { note: `token=${token}` } };

    const redacted = redactDeep(value, patternSet, session) as {
      value: { note: string };
    };
    const restored = restoreDeep(redacted, session) as {
      value: { note: string };
    };

    expect(restored.value.note).toBe(`token=${token}`);
  });
});
