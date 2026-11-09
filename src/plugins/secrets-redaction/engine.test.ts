// FILE: src/plugins/secrets-redaction/engine.test.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for the secrets redaction engine.
//   SCOPE: direct text redaction, overlap resolution, exclude handling, placeholder round-trips, idempotent re-redaction, and capture-group (context-anchored) spans.
//   DEPENDS: bun:test, engine, patterns, restore, session
//   LINKS: [M-PLUGIN-SECRETS-REDACTION, V-M-PLUGIN-SECRETS-REDACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   EMAIL - Reusable email secret fixture.
//   SECRET - Reusable token secret fixture.
//   createSession - Creates a placeholder session for redaction round-trips.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [secrets reliability overhaul - Added idempotency regressions (re-redacting redacted text is a no-op and re-redaction no longer breaks restoration), context-anchored group spans that preserve the Bearer prefix, case-insensitive exclusion, and keyword case-sensitivity coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { redactText } from "./engine.js";
import { buildPatternSet } from "./patterns.js";
import { restoreText } from "./restore.js";
import { PlaceholderSession } from "./session.js";

const SECRET = "test-secret-for-redaction";
const EMAIL = "qa-redaction-check-884271@example.invalid";

function createSession() {
  return new PlaceholderSession({
    prefix: "__VVOC_SECRET_",
    ttlMs: 60_000,
    maxMappings: 1000,
    secret: SECRET,
  });
}

describe("redactText", () => {
  test("redacts builtin email matches and returns placeholder metadata", () => {
    const session = createSession();
    const patternSet = buildPatternSet({ builtin: ["email"] });

    const result = redactText(`Contact ${EMAIL} for help.`, patternSet, session);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.original).toBe(EMAIL);
    expect(result.matches[0]?.category).toBe("EMAIL");
    expect(result.matches[0]?.placeholder).toMatch(/^__VVOC_SECRET_EMAIL_[0-9a-f]{12}__$/);
    expect(result.text).not.toContain(EMAIL);
    expect(result.text).toContain(result.matches[0]!.placeholder);
  });

  test("redacts multiple distinct matches in input order", () => {
    const session = createSession();
    const patternSet = buildPatternSet({ builtin: ["email"] });
    const secondEmail = "ops-redaction-check-884271@example.invalid";

    const result = redactText(`${EMAIL} then ${secondEmail}`, patternSet, session);

    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]?.original).toBe(EMAIL);
    expect(result.matches[1]?.original).toBe(secondEmail);
    expect(result.text).not.toContain(EMAIL);
    expect(result.text).not.toContain(secondEmail);
  });

  test("skips excluded values", () => {
    const session = createSession();
    const patternSet = buildPatternSet({
      builtin: ["email"],
      exclude: [EMAIL],
    });

    const result = redactText(`Contact ${EMAIL} for help.`, patternSet, session);

    expect(result.matches).toHaveLength(0);
    expect(result.text).toContain(EMAIL);
  });

  test("prefers the wider earlier match when patterns overlap", () => {
    const session = createSession();
    const patternSet = buildPatternSet({
      regex: [
        { pattern: "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}", category: "FULL_EMAIL" },
        { pattern: "example\\.invalid", category: "DOMAIN_ONLY" },
      ],
    });

    const result = redactText(`Contact ${EMAIL} for help.`, patternSet, session);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.category).toBe("FULL_EMAIL");
    expect(result.matches[0]?.original).toBe(EMAIL);
    expect(result.text).not.toContain(EMAIL);
    expect(result.text).not.toContain("example.invalid");
  });

  test("restores exact placeholders back to the original value", () => {
    const session = createSession();
    const patternSet = buildPatternSet({ builtin: ["email"] });

    const redacted = redactText(`Contact ${EMAIL} for help.`, patternSet, session);
    const restored = restoreText(redacted.text, session);

    expect(restored).toContain(EMAIL);
    expect(restored).not.toContain(redacted.matches[0]!.placeholder);
  });

  test("does NOT redact long .md filenames with bearer_token pattern", () => {
    const session = createSession();
    const patternSet = buildPatternSet({ builtin: ["bearer_token"] });
    const mdFilename = ".vvoc/plans/batch-form-migration-requirements.md";

    const result = redactText(mdFilename, patternSet, session);

    // Should not match - the .md extension should prevent false positive
    expect(result.matches).toHaveLength(0);
    expect(result.text).toBe(mdFilename);
  });

  test("terminates and skips zero-width regex matches instead of looping forever", () => {
    const session = createSession();
    const patternSet = buildPatternSet({
      regex: [{ pattern: "(?=a)", category: "ZERO_WIDTH" }],
    });

    const result = redactText("aaa", patternSet, session);

    expect(result.matches).toHaveLength(0);
    expect(result.text).toBe("aaa");
  });

  test("re-redacting redacted text is a no-op (idempotency)", () => {
    const session = createSession();
    const patternSet = buildPatternSet({ builtin: ["email"] });

    const first = redactText(`Contact ${EMAIL} for help.`, patternSet, session);
    const second = redactText(first.text, patternSet, session);

    expect(second.text).toBe(first.text);
    expect(second.matches).toHaveLength(0);
    expect(session.size).toBe(1);
  });

  test("a bare well-formed placeholder is never re-redacted", () => {
    const session = createSession();
    const patternSet = buildPatternSet({ builtin: ["email"] });
    // An unknown/invented marker with the well-formed shape (not in any mapping).
    const invented = "__VVOC_SECRET_EMAIL_0123456789ab__";

    const result = redactText(invented, patternSet, session);

    expect(result.text).toBe(invented);
    expect(result.matches).toHaveLength(0);
    expect(session.size).toBe(0);
  });

  test("restoration still returns the original after redacted text is redacted again", () => {
    const session = createSession();
    const patternSet = buildPatternSet({ builtin: ["email"] });

    const first = redactText(`value ${EMAIL} end`, patternSet, session);
    redactText(first.text, patternSet, session);
    const restored = restoreText(first.text, session);

    expect(restored).toBe(`value ${EMAIL} end`);
  });

  test("context-anchored bearer_auth redacts only the token and preserves the prefix", () => {
    const session = createSession();
    const patternSet = buildPatternSet({ builtin: ["bearer_auth"] });
    const token = "abc123def456ghi789jkl012";

    const result = redactText(`Authorization: Bearer ${token}`, patternSet, session);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.original).toBe(token);
    expect(result.matches[0]!.category).toBe("BEARER_AUTH");
    expect(result.text).toBe(`Authorization: Bearer ${result.matches[0]!.placeholder}`);
    expect(result.text).not.toContain(token);
    expect(restoreText(result.text, session)).toBe(`Authorization: Bearer ${token}`);
  });

  test("exclusion is case-insensitive regardless of how the entry was authored", () => {
    const session = createSession();
    const patternSet = buildPatternSet({
      builtin: ["email"],
      exclude: [EMAIL.toUpperCase()],
    });

    const result = redactText(`Contact ${EMAIL} for help.`, patternSet, session);

    expect(result.matches).toHaveLength(0);
    expect(result.text).toContain(EMAIL);
  });

  test("keyword rules respect caseSensitive while the default stays case-insensitive", () => {
    const session = createSession();
    const sensitive = buildPatternSet({
      keywords: [{ value: "ApiKeyAbc", category: "CUSTOM_KEY", caseSensitive: true }],
    });
    const hit = redactText("key=ApiKeyAbc;", sensitive, session);
    expect(hit.matches).toHaveLength(1);
    const miss = redactText("key=apikeyabc;", sensitive, session);
    expect(miss.matches).toHaveLength(0);

    const insensitive = buildPatternSet({ keywords: [{ value: "ApiKeyAbc" }] });
    const lowered = redactText("key=apikeyabc;", insensitive, session);
    expect(lowered.matches).toHaveLength(1);
  });
});
