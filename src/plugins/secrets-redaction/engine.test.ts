// FILE: src/plugins/secrets-redaction/engine.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for the secrets redaction engine.
//   SCOPE: direct text redaction, overlap resolution, exclude handling, and placeholder round-trips.
//   DEPENDS: bun:test, engine, patterns, restore, session
//   LINKS: knowledge-graph://plugins/secrets-redaction
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   redactText tests - Verify direct engine behavior for real secrets, overlap handling, and round-trips.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Added direct engine coverage for real email redaction and overlap handling.]
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
});
