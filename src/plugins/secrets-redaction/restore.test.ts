// FILE: src/plugins/secrets-redaction/restore.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for placeholder restoration, including the strict tool-input restore path.
//   SCOPE: plain restoration, unresolved-reference failures (unknown, altered, expired/evicted, cross-family), value-free actionable errors, and safe literal marker text.
//   DEPENDS: bun:test, restore, session, engine, patterns
//   LINKS: [M-PLUGIN-SECRETS-REDACTION, V-M-PLUGIN-SECRETS-REDACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SECRET - HMAC secret fixture.
//   PREFIX - Placeholder prefix fixture.
//   CONTEXT - Strict-restore tool/session identity fixture.
//   redact - Redacts a fixture string through the email/openai builtins.
//   createSession - Creates a placeholder session for restore tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [secrets reliability overhaul - New suite proving the strict tool-input restore: known references round-trip byte-exact (including quote/backslash credentials embedded in JSON), while unknown, altered, evicted, and cross-family placeholders throw SECRETS_REFERENCE_UNRESOLVED before execution with value-free messages; single-underscore literals and prefix-only text pass through.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { redactText } from "./engine.js";
import { buildPatternSet } from "./patterns.js";
import {
  SecretsReferenceUnresolvedError,
  restoreText,
  restoreTextStrict,
  type StrictRestoreContext,
} from "./restore.js";
import { PlaceholderSession } from "./session.js";

const SECRET = "restore-suite-hmac-secret";
const PREFIX = "__VVOC_SECRET_";
const CONTEXT: StrictRestoreContext = { tool: "bash", sessionID: "ses_restore" };

function createSession(secret = SECRET) {
  return new PlaceholderSession({
    prefix: PREFIX,
    ttlMs: 60_000,
    maxMappings: 1000,
    secret,
  });
}

function redact(session: PlaceholderSession, text: string): string {
  return redactText(text, buildPatternSet({ builtin: ["email", "openai_key"] }), session).text;
}

describe("restoreText", () => {
  test("leaves an unknown well-formed placeholder unchanged", () => {
    const session = createSession();
    const invented = "__VVOC_SECRET_EMAIL_0123456789ab__";
    expect(restoreText(`file://${invented}/spec.xml`, session)).toBe(`file://${invented}/spec.xml`);
  });
});

describe("restoreTextStrict", () => {
  test("restores a known reference exactly", () => {
    const session = createSession();
    const redacted = redact(session, `path ${"qa-strict@example.invalid"} end`);

    expect(restoreTextStrict(redacted, session, CONTEXT)).toBe(
      "path qa-strict@example.invalid end",
    );
    expect(redacted).toMatch(/__VVOC_SECRET_[A-Za-z0-9_]+_[0-9a-f]{12}__/);
  });

  test("restores quote/backslash credentials byte-exact inside JSON-shaped text", () => {
    const session = createSession();
    const credential = 'say "hi" \\ done';
    const patternSet = buildPatternSet({ keywords: [{ value: credential }] });
    const redacted = redactText(
      JSON.stringify({ command: `echo ${credential}` }),
      patternSet,
      session,
    ).text;

    const restored = restoreTextStrict(redacted, session, CONTEXT);
    expect(JSON.parse(restored)).toEqual({ command: 'echo say "hi" \\ done' });
    expect(restored).not.toContain("__VVOC_SECRET_");
  });

  test("an unknown well-formed placeholder throws before execution, value-free", () => {
    const session = createSession();
    const invented = "__VVOC_SECRET_EMAIL_0123456789ab__";
    const input = { file_path: `.vvoc/specs/${invented}/spec.xml` };

    expect(() => restoreTextStrict(input.file_path, session, CONTEXT)).toThrow(
      SecretsReferenceUnresolvedError,
    );
    try {
      restoreTextStrict(input.file_path, session, CONTEXT);
      throw new Error("expected a throw");
    } catch (error) {
      const unresolved = error as SecretsReferenceUnresolvedError;
      expect(unresolved.code).toBe("SECRETS_REFERENCE_UNRESOLVED");
      expect(unresolved.tool).toBe("bash");
      expect(unresolved.sessionID).toBe("ses_restore");
      expect(unresolved.placeholder).toBe(invented);
      expect(unresolved.message).toContain(invented);
      expect(unresolved.message).toContain("re-read");
      // Credential-safe: the message names no secret value (there is none) and
      // never embeds the input path beyond the safe placeholder token.
      expect(unresolved.message).not.toContain("spec.xml");
    }
  });

  test("an altered or truncated marker never fuzzy-matches a credential", () => {
    const session = createSession();
    const redacted = redact(session, "qa-altered@example.invalid");
    const placeholder = redacted.match(/__VVOC_SECRET_[A-Za-z0-9_]+_([0-9a-f]{12})__/)!;
    const digest = placeholder[1]!;
    // Flip the first digest hex char to its opposite so the marker is provably
    // different from every mapped placeholder: no fuzzy fallback may substitute
    // the credential.
    const flipped = digest[0] === "a" ? `b${digest.slice(1)}` : `a${digest.slice(1)}`;
    const altered = placeholder[0].replace(digest, flipped);

    expect(altered).not.toBe(placeholder[0]);
    expect(() => restoreTextStrict(`read ${altered}`, session, CONTEXT)).toThrow(
      SecretsReferenceUnresolvedError,
    );
  });

  test("an expired or evicted mapping fails closed on restoration", () => {
    const session = createSession();
    const redacted = redact(session, "qa-evicted@example.invalid");
    session.cleanup(Date.now() + 120_000);

    expect(() => restoreTextStrict(redacted, session, CONTEXT)).toThrow(
      SecretsReferenceUnresolvedError,
    );
  });

  test("a cross-family placeholder never borrows another family's mappings", () => {
    const otherFamily = createSession("a-completely-different-hmac");
    const redacted = redact(otherFamily, "qa-foreign@example.invalid");

    const session = createSession();
    expect(() => restoreTextStrict(`open ${redacted}`, session, CONTEXT)).toThrow(
      SecretsReferenceUnresolvedError,
    );
  });

  test("literal single-underscore markers and prefix-only text pass through", () => {
    const session = createSession();
    // Documented safe literal representation: one leading underscore.
    const literal = "_VVOC_SECRET_EMAIL_0123456789ab__";
    expect(restoreTextStrict(`docs say ${literal}`, session, CONTEXT)).toBe(`docs say ${literal}`);

    // Prefix-only text (no well-formed digest tail) is legitimate content.
    expect(
      restoreTextStrict("prefix __VVOC_SECRET_ and __VVOC_SECRET_NOT_A_TOKEN__", session, CONTEXT),
    ).toBe("prefix __VVOC_SECRET_ and __VVOC_SECRET_NOT_A_TOKEN__");
  });
});
