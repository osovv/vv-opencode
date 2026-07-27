// FILE: src/lib/vvoc-config.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the optional strict web section of canonical vvoc schema v3: parsing, rejection, normalization, rendering, and schema-file parity.
//   SCOPE: web section parse/render round-trips, strict provider and Z.AI region validation, rejection of unknown keys and empty apiKey, default omission, createWebConfig behavior, and embedded schema versus schemas/vvoc/v3.json equivalence.
//   DEPENDS: [src/lib/vvoc-config.ts, schemas/vvoc/v3.json]
//   LINKS: [M-CLI-CONFIG, M-WEB-CONFIG, M-PLUGIN-WEB-TOOLS, V-M-CLI-CONFIG, V-M-WEB-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SCHEMA_PATH - Published schema-v3 file used for parity checks.
//   docWithWeb - Render a valid canonical document carrying an arbitrary web value.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-ZAI-DIRECT-WEB-PROVIDERS - Covered strict Z.AI provider regions, normalization, compatibility, and schema parity.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDefaultVvocConfig,
  createWebConfig,
  parseVvocConfigText,
  renderVvocConfig,
  validateVvocConfigDocument,
  VVOC_CONFIG_SCHEMA,
  type VvocConfig,
} from "./vvoc-config.js";

const SCHEMA_PATH = join(import.meta.dir, "..", "..", "schemas", "vvoc", "v3.json");

/** Render a fully valid canonical document carrying an arbitrary web value, bypassing normalization. */
function docWithWeb(web: unknown): string {
  return JSON.stringify({ ...createDefaultVvocConfig(), web }, null, 2);
}

describe("optional web section parsing", () => {
  test("a document without a web section parses unchanged and renders without web", () => {
    const rendered = renderVvocConfig(createDefaultVvocConfig());
    expect(rendered).not.toContain('"web"');
    const parsed = parseVvocConfigText(rendered, "test");
    expect(parsed.web).toBeUndefined();
  });

  test("a full web section with search and fetch providers parses", () => {
    const parsed = parseVvocConfigText(
      docWithWeb({ search: { provider: "brave" }, fetch: { provider: "spider" } }),
      "test",
    );
    expect(parsed.web?.search?.provider).toBe("brave");
    expect(parsed.web?.fetch?.provider).toBe("spider");
  });

  test("a partial web section preserves exactly the given fields", () => {
    const parsed = parseVvocConfigText(docWithWeb({ fetch: { provider: "spider" } }), "test");
    expect(parsed.web?.fetch?.provider).toBe("spider");
    expect(parsed.web?.search).toBeUndefined();
  });

  test("zai search and fetch require and preserve explicit regions", () => {
    const parsed = parseVvocConfigText(
      docWithWeb({
        search: { provider: "zai", region: "international" },
        fetch: { provider: "zai", region: "china" },
      }),
      "test",
    );
    expect(parsed.web?.search).toEqual({ provider: "zai", region: "international" });
    expect(parsed.web?.fetch).toEqual({ provider: "zai", region: "china" });
  });

  test("zai provider without a region is rejected", () => {
    expect(() =>
      parseVvocConfigText(docWithWeb({ search: { provider: "zai" } }), "test"),
    ).toThrow();
    expect(() => parseVvocConfigText(docWithWeb({ fetch: { provider: "zai" } }), "test")).toThrow();
  });

  test("an unknown zai region is rejected", () => {
    expect(() =>
      parseVvocConfigText(docWithWeb({ search: { provider: "zai", region: "global" } }), "test"),
    ).toThrow();
  });

  test("an unknown provider value is rejected with a schema error", () => {
    expect(() =>
      parseVvocConfigText(docWithWeb({ search: { provider: "google" } }), "test"),
    ).toThrow();
    const errors = validateVvocConfigDocument(
      JSON.parse(docWithWeb({ search: { provider: "google" } })),
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  test("an unknown property inside web.search is rejected", () => {
    expect(() =>
      parseVvocConfigText(docWithWeb({ search: { provider: "exa", bogus: true } }), "test"),
    ).toThrow();
  });

  test("an empty apiKey is rejected by the minLength constraint", () => {
    expect(() => parseVvocConfigText(docWithWeb({ search: { apiKey: "" } }), "test")).toThrow();
  });
});

describe("web section rendering and defaults", () => {
  test("renderVvocConfig round-trips a configured apiKey without losing it", () => {
    const config: VvocConfig = {
      ...createDefaultVvocConfig(),
      web: { search: { provider: "exa", apiKey: "sk-test-123" } },
    };
    const rendered = renderVvocConfig(config);
    expect(rendered).toContain("sk-test-123");
    const parsed = parseVvocConfigText(rendered, "test");
    expect(parsed.web?.search?.apiKey).toBe("sk-test-123");
    expect(parsed.web?.search?.provider).toBe("exa");
  });

  test("createDefaultVvocConfig produces no web section", () => {
    expect(createDefaultVvocConfig().web).toBeUndefined();
  });
});

describe("createWebConfig normalization", () => {
  test("returns undefined for absent or empty input", () => {
    expect(createWebConfig(undefined)).toBeUndefined();
    expect(createWebConfig({})).toBeUndefined();
    expect(createWebConfig({ search: {} })).toBeUndefined();
  });

  test("normalizes a populated section and drops empty subsections", () => {
    expect(createWebConfig({ search: { provider: "exa" }, fetch: {} })).toEqual({
      search: { provider: "exa" },
    });
  });

  test("normalizes and renders explicit zai regions", () => {
    const web = createWebConfig({
      search: { provider: "zai", region: "international", apiKey: "search-key" },
      fetch: { provider: "zai", region: "china", apiKey: "fetch-key" },
    });
    expect(web).toEqual({
      search: { provider: "zai", region: "international", apiKey: "search-key" },
      fetch: { provider: "zai", region: "china", apiKey: "fetch-key" },
    });
    const rendered = renderVvocConfig({ ...createDefaultVvocConfig(), web });
    expect(parseVvocConfigText(rendered, "test").web).toEqual(web);
  });
});

describe("schema parity", () => {
  test("embedded WEB_CONFIG_SCHEMA matches schemas/vvoc/v3.json web property", () => {
    const fileSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
      properties: Record<string, unknown>;
    };
    expect((VVOC_CONFIG_SCHEMA.properties as Record<string, unknown>).web).toEqual(
      fileSchema.properties.web,
    );
  });
});
