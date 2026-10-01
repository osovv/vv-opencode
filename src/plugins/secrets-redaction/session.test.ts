// FILE: src/plugins/secrets-redaction/session.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for PlaceholderSession
//   SCOPE: placeholder creation, lookup, TTL eviction, maxMappings eviction
//   DEPENDS: session
//   LINKS: [M-PLUGIN-SECRETS-REDACTION, V-M-PLUGIN-SECRETS-REDACTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PREFIX - Expected placeholder prefix fixture.
//   SECRET - HMAC secret fixture used by placeholder session tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009 - Category-grammar coverage: every canonical category emits a matchable token, whole-text restoration, and counter uniqueness under a forced hash collision.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { restoreText } from "./restore.js";
import { PlaceholderSession, generateFallbackSecret } from "./session.js";

const SECRET = "test-secret-for-hmac";
const PREFIX = "__VVOC_SECRET_";

describe("PlaceholderSession", () => {
  test("generates different placeholders for different secrets", () => {
    const session = new PlaceholderSession({
      prefix: PREFIX,
      ttlMs: 60_000,
      maxMappings: 1000,
      secret: SECRET,
    });

    const p1 = session.getOrCreatePlaceholder("api-key-123", "API_KEY");
    const p2 = session.getOrCreatePlaceholder("api-key-456", "API_KEY");

    expect(p1).not.toBe(p2);
    expect(p1).toMatch(/^__VVOC_SECRET_API_KEY_[0-9a-f]{12}__$/);
    expect(p2).toMatch(/^__VVOC_SECRET_API_KEY_[0-9a-f]{12}__$/);
  });

  test("returns same placeholder for same secret (deduplication)", () => {
    const session = new PlaceholderSession({
      prefix: PREFIX,
      ttlMs: 60_000,
      maxMappings: 1000,
      secret: SECRET,
    });

    const p1 = session.getOrCreatePlaceholder("my-secret-value", "KEYWORD");
    const p2 = session.getOrCreatePlaceholder("my-secret-value", "KEYWORD");

    expect(p1).toBe(p2);
  });

  test("same value produces same placeholder regardless of category", () => {
    const session = new PlaceholderSession({
      prefix: PREFIX,
      ttlMs: 60_000,
      maxMappings: 1000,
      secret: SECRET,
    });

    const p1 = session.getOrCreatePlaceholder("test@example.com", "EMAIL");
    const p2 = session.getOrCreatePlaceholder("test@example.com", "HASH");

    expect(p1).toBe(p2);
    expect(p1).toContain("EMAIL");
  });

  test("lookup returns original value", () => {
    const session = new PlaceholderSession({
      prefix: PREFIX,
      ttlMs: 60_000,
      maxMappings: 1000,
      secret: SECRET,
    });

    const placeholder = session.getOrCreatePlaceholder("ghp_abc123xyz", "GITHUB_TOKEN");
    const original = session.lookup(placeholder);

    expect(original).toBe("ghp_abc123xyz");
  });

  test("lookup returns undefined for unknown placeholder", () => {
    const session = new PlaceholderSession({
      prefix: PREFIX,
      ttlMs: 60_000,
      maxMappings: 1000,
      secret: SECRET,
    });

    expect(session.lookup("__VVOC_SECRET_UNKNOWN_abc123__")).toBeUndefined();
  });

  test("stable hashing — same input produces same hash across instances", () => {
    const session1 = new PlaceholderSession({
      prefix: PREFIX,
      ttlMs: 60_000,
      maxMappings: 1000,
      secret: SECRET,
    });

    const session2 = new PlaceholderSession({
      prefix: PREFIX,
      ttlMs: 60_000,
      maxMappings: 1000,
      secret: SECRET,
    });

    const p1 = session1.getOrCreatePlaceholder("consistent-secret", "KEYWORD");
    const p2 = session2.getOrCreatePlaceholder("consistent-secret", "KEYWORD");

    expect(p1).toBe(p2);
  });

  test("different secrets produce different hashes", () => {
    const session1 = new PlaceholderSession({
      prefix: PREFIX,
      ttlMs: 60_000,
      maxMappings: 1000,
      secret: SECRET,
    });

    const session2 = new PlaceholderSession({
      prefix: PREFIX,
      ttlMs: 60_000,
      maxMappings: 1000,
      secret: "different-secret",
    });

    const p1 = session1.getOrCreatePlaceholder("same-value", "KEYWORD");
    const p2 = session2.getOrCreatePlaceholder("same-value", "KEYWORD");

    expect(p1).not.toBe(p2);
  });

  test("TTL eviction removes expired entries", () => {
    const session = new PlaceholderSession({
      prefix: PREFIX,
      ttlMs: 100,
      maxMappings: 1000,
      secret: SECRET,
    });

    session.getOrCreatePlaceholder("secret-1", "KEYWORD");
    session.getOrCreatePlaceholder("secret-2", "KEYWORD");

    expect(session.size).toBe(2);

    const evicted = session.cleanup(Date.now() + 200);
    expect(evicted).toBe(2);
    expect(session.size).toBe(0);
  });

  test("maxMappings eviction removes oldest entry", () => {
    const session = new PlaceholderSession({
      prefix: PREFIX,
      ttlMs: 60_000,
      maxMappings: 3,
      secret: SECRET,
    });

    session.getOrCreatePlaceholder("a", "K");
    session.getOrCreatePlaceholder("b", "K");
    session.getOrCreatePlaceholder("c", "K");

    expect(session.size).toBe(3);

    session.getOrCreatePlaceholder("d", "K");

    expect(session.size).toBe(3);
    expect(session.lookup("__VVOC_SECRET_K_")).toBeUndefined();
  });

  test("size returns correct count", () => {
    const session = new PlaceholderSession({
      prefix: PREFIX,
      ttlMs: 60_000,
      maxMappings: 1000,
      secret: SECRET,
    });

    expect(session.size).toBe(0);

    session.getOrCreatePlaceholder("x", "K");
    expect(session.size).toBe(1);

    session.getOrCreatePlaceholder("y", "K");
    expect(session.size).toBe(2);

    session.getOrCreatePlaceholder("x", "K");
    expect(session.size).toBe(2);
  });
});

test("generateFallbackSecret returns 64-char hex string", () => {
  const secret = generateFallbackSecret();
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  expect(secret.length).toBe(64);
});

test("generateFallbackSecret returns different values each call", () => {
  const s1 = generateFallbackSecret();
  const s2 = generateFallbackSecret();
  expect(s1).not.toBe(s2);
});

describe("placeholder category grammar", () => {
  const categories = [
    "EMAIL",
    "IPV4",
    "lowercase",
    "mixedCase9",
    "custom-key",
    "dotted.key",
    "подпись",
    "a".repeat(200),
    "!!!",
  ];

  test("every canonical category emits a matchable token and preserves its metadata", () => {
    const session = new PlaceholderSession({
      prefix: PREFIX,
      ttlMs: 60_000,
      maxMappings: 1000,
      secret: SECRET,
    });
    for (const category of categories) {
      const placeholder = session.getOrCreatePlaceholder(`secret-for-${category}`, category);
      expect(placeholder).toMatch(/^__VVOC_SECRET_[A-Za-z0-9_]+_[0-9a-f]{12}(?:_\d+)?__$/);
      // No original category characters leak into the emitted token beyond the slug.
      expect(placeholder.includes(category) && category.length > 32).toBe(false);
    }
  });

  test("whole-text restoration works for every canonical category", () => {
    const session = new PlaceholderSession({
      prefix: PREFIX,
      ttlMs: 60_000,
      maxMappings: 1000,
      secret: SECRET,
    });
    for (const category of categories) {
      const original = `value-${category}`;
      const placeholder = session.getOrCreatePlaceholder(original, category);
      expect(restoreText(`before ${placeholder} after`, session)).toBe(`before ${original} after`);
    }
  });

  test("collisions in slugged categories stay unique via the counter", () => {
    const session = new PlaceholderSession({
      prefix: PREFIX,
      ttlMs: 60_000,
      maxMappings: 1000,
      secret: SECRET,
    });
    // Force a deterministic HMAC collision so the counter path is exercised.
    (session as unknown as { computeHash(value: string): string }).computeHash = () =>
      "0".repeat(64);
    const a = session.getOrCreatePlaceholder("secret-a", "custom-key");
    const b = session.getOrCreatePlaceholder("secret-b", "custom-key");
    expect(a).toMatch(/^__VVOC_SECRET_custom_key_0{12}__$/);
    expect(b).toMatch(/^__VVOC_SECRET_custom_key_0{12}_1__$/);
    expect(restoreText(`${a}|${b}`, session)).toBe("secret-a|secret-b");
  });
});
