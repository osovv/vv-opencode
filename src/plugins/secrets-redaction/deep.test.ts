// FILE: src/plugins/secrets-redaction/deep.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for deep copy-on-write redaction/restoration traversal.
//   SCOPE: media-leaf guard byte integrity, plain vs media-aware redaction contrast, strict restore traversal.
//   DEPENDS: bun:test, deep, session, engine, patterns, restore
//   LINKS: [M-PLUGIN-SECRETS-REDACTION, V-M-PLUGIN-SECRETS-REDACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SECRET - HMAC secret fixture.
//   EMAIL - Email credential fixture.
//   PNG_BASE64 - Deterministic bare base64 blob fixture.
//   PNG_DATA_URL - Deterministic image data-URL fixture.
//   PDF_DATA_URL - Deterministic PDF data-URL fixture.
//   AUDIO_DATA_URL - Deterministic audio data-URL fixture.
//   createSession - Creates a placeholder session for deep traversal tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [secrets reliability overhaul - New suite proving the media-leaf guard: image/PDF/audio data URLs and long pure-base64 payloads stay byte-identical while adjacent textual credentials still redact, and restoreDeepStrict fails closed on unresolved references.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { isOpaqueMediaText, redactDeep, redactDeepMediaAware, restoreDeepStrict } from "./deep.js";
import { buildPatternSet } from "./patterns.js";
import { SecretsReferenceUnresolvedError } from "./restore.js";
import { PlaceholderSession } from "./session.js";

const SECRET = "deep-suite-hmac-secret";
const EMAIL = "qa-deep-check-884271@example.invalid";

function createSession() {
  return new PlaceholderSession({
    prefix: "__VVOC_SECRET_",
    ttlMs: 60_000,
    maxMappings: 1000,
    secret: SECRET,
  });
}

// ~1.5KB of deterministic base64-looking payload content.
const PNG_BASE64 = Buffer.from("synthetic-png-payload-".repeat(70), "utf8").toString("base64");
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;
const PDF_DATA_URL = `data:application/pdf;base64,${PNG_BASE64}`;
const AUDIO_DATA_URL = `data:audio/wav;base64,${PNG_BASE64}`;

describe("isOpaqueMediaText", () => {
  test("accepts supported image/pdf/audio/video data URLs", () => {
    expect(isOpaqueMediaText(PNG_DATA_URL)).toBe(true);
    expect(isOpaqueMediaText(PDF_DATA_URL)).toBe(true);
    expect(isOpaqueMediaText(AUDIO_DATA_URL)).toBe(true);
    expect(isOpaqueMediaText(`data:video/mp4;base64,${"QUFB".repeat(4)}`)).toBe(true);
  });

  test("rejects non-media mimes and non-base64 shapes", () => {
    expect(isOpaqueMediaText(`data:text/plain;base64,${PNG_BASE64}`)).toBe(false);
    expect(isOpaqueMediaText(`data:image/svg+xml;utf8,<svg>${EMAIL}</svg>`)).toBe(false);
    expect(isOpaqueMediaText(`read ${EMAIL} now`)).toBe(false);
    expect(isOpaqueMediaText(EMAIL)).toBe(false);
  });

  test("requires 512+ pure base64 alphabet characters for bare blobs", () => {
    expect(isOpaqueMediaText(PNG_BASE64)).toBe(true);
    expect(isOpaqueMediaText("a".repeat(511))).toBe(false);
    expect(isOpaqueMediaText(`${"a".repeat(300)} not-base64!! ${"a".repeat(300)}`)).toBe(false);
    // Line-wrapped base64 stays media-shaped.
    expect(isOpaqueMediaText(PNG_BASE64.match(/.{1,76}/g)!.join("\n"))).toBe(true);
  });
});

describe("redactDeepMediaAware", () => {
  test("preserves media payloads byte-for-byte while adjacent credentials redact", () => {
    const session = createSession();
    const patternSet = buildPatternSet({ builtin: ["email"] });
    const value = {
      image: PNG_DATA_URL,
      pdf: PDF_DATA_URL,
      audio: AUDIO_DATA_URL,
      note: `author ${EMAIL}`,
    };

    const redacted = redactDeepMediaAware(value, patternSet, session) as typeof value;

    expect(redacted.image).toBe(PNG_DATA_URL);
    expect(redacted.pdf).toBe(PDF_DATA_URL);
    expect(redacted.audio).toBe(AUDIO_DATA_URL);
    expect(redacted.note).not.toContain(EMAIL);
    expect(redacted.note).toMatch(/__VVOC_SECRET_EMAIL_[0-9a-f]{12}__/);
    // The original input object is untouched (copy-on-write).
    expect(value.note).toBe(`author ${EMAIL}`);
  });

  test("plain redactDeep still rewrites base64 media (the historical corruption path)", () => {
    const session = createSession();
    // bearer_token is the historical default that rewrote base64 blobs
    // (issue: base64 media corrupted by generic token matching).
    const patternSet = buildPatternSet({ builtin: ["bearer_token"] });
    const value = { image: PNG_DATA_URL };

    const redacted = redactDeep(value, patternSet, session) as typeof value;

    expect(redacted.image).not.toBe(PNG_DATA_URL);
    expect(redacted.image).toContain("__VVOC_SECRET_");
  });

  test("small textual values and structured credentials still redact", () => {
    const session = createSession();
    const patternSet = buildPatternSet({ builtin: ["email"] });
    const value = { nested: { list: [EMAIL, { deep: EMAIL }] } };

    const redacted = redactDeepMediaAware(value, patternSet, session) as typeof value;

    expect(JSON.stringify(redacted)).not.toContain(EMAIL);
  });
});

describe("restoreDeepStrict", () => {
  test("restores nested known references and preserves structure", () => {
    const session = createSession();
    const patternSet = buildPatternSet({ builtin: ["email"] });
    const redacted = redactDeep(
      { cmd: `cat ${EMAIL}`, arr: [{ p: EMAIL }] },
      patternSet,
      session,
    ) as Record<string, unknown>;

    const restored = restoreDeepStrict(redacted, session, {
      tool: "bash",
      sessionID: "ses_deep",
    }) as { cmd: string; arr: Array<{ p: string }> };

    expect(restored.cmd).toBe(`cat ${EMAIL}`);
    expect(restored.arr[0]!.p).toBe(EMAIL);
  });

  test("throws the unresolved-reference error for a nested invented marker", () => {
    const session = createSession();
    const input = { file_path: ".vvoc/specs/__VVOC_SECRET_EMAIL_0123456789ab__/spec.xml" };

    expect(() =>
      restoreDeepStrict(input, session, { tool: "str_replace_editor", sessionID: "ses_deep" }),
    ).toThrow(SecretsReferenceUnresolvedError);
  });
});
