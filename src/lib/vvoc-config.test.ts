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
//   docWithTelegram - Render a fully valid canonical document carrying an arbitrary telegram value.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-TELEGRAM-BRIDGE-PLUGIN T-001 - Covered the optional telegram section: acceptance, required fields, connectivity exclusivity, rejection cases, round-trip, and file schema parity.]
//   PREVIOUS: [C-SPEC-IDENTITY-LINT - Covered spec-guard schema acceptance, rejection, boolean form, and file schema parity.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDefaultVvocConfig,
  createGuardianConfig,
  createSystemOneConfig,
  createWebConfig,
  parseVvocConfigText,
  renderSystemOneConfig,
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

/** Render a fully valid canonical document carrying an arbitrary telegram value. */
function docWithTelegram(telegram: unknown): string {
  return JSON.stringify({ ...createDefaultVvocConfig(), telegram }, null, 2);
}

// START_BLOCK_TELEGRAM_SECTION_TEST
describe("optional telegram section parsing", () => {
  test("a document without a telegram section parses unchanged and renders without telegram", () => {
    const rendered = renderVvocConfig(createDefaultVvocConfig());
    expect(JSON.parse(rendered).telegram).toBeUndefined();
    const parsed = parseVvocConfigText(rendered, "test");
    expect(parsed.telegram).toBeUndefined();
  });

  test("a complete telegram section parses with every field preserved", () => {
    const parsed = parseVvocConfigText(
      docWithTelegram({
        enabled: true,
        botToken: "${TELEGRAM_BOT_TOKEN}",
        allowedUserIds: [42, 1001],
        activityWindowMinutes: 120,
        apiRoot: "https://tg.example.com",
        settings: { showReasoning: true, formatMode: "raw" },
      }),
      "test",
    );
    expect(parsed.telegram).toEqual({
      enabled: true,
      botToken: "${TELEGRAM_BOT_TOKEN}",
      allowedUserIds: [42, 1001],
      activityWindowMinutes: 120,
      apiRoot: "https://tg.example.com",
      settings: { showReasoning: true, formatMode: "raw" },
    });
  });

  test("a minimal telegram section parses with only token and allowlist", () => {
    const parsed = parseVvocConfigText(
      docWithTelegram({ botToken: "123:abc", allowedUserIds: [7] }),
      "test",
    );
    expect(parsed.telegram?.botToken).toBe("123:abc");
    expect(parsed.telegram?.allowedUserIds).toEqual([7]);
    expect(parsed.telegram?.enabled).toBeUndefined();
  });

  test("missing botToken or allowlist is rejected", () => {
    expect(() => parseVvocConfigText(docWithTelegram({ allowedUserIds: [7] }), "test")).toThrow();
    expect(() => parseVvocConfigText(docWithTelegram({ botToken: "123:abc" }), "test")).toThrow();
  });

  test("an empty allowlist, empty token, or non-integer ids are rejected", () => {
    expect(() =>
      parseVvocConfigText(docWithTelegram({ botToken: "123:abc", allowedUserIds: [] }), "test"),
    ).toThrow();
    expect(() =>
      parseVvocConfigText(docWithTelegram({ botToken: "", allowedUserIds: [7] }), "test"),
    ).toThrow();
    expect(() =>
      parseVvocConfigText(docWithTelegram({ botToken: "123:abc", allowedUserIds: ["7"] }), "test"),
    ).toThrow();
  });

  test("apiRoot and proxyUrl together are rejected as mutually exclusive connectivity", () => {
    expect(() =>
      parseVvocConfigText(
        docWithTelegram({
          botToken: "123:abc",
          allowedUserIds: [7],
          apiRoot: "https://tg.example.com",
          proxyUrl: "socks5://127.0.0.1:9050",
        }),
        "test",
      ),
    ).toThrow();
  });

  test("unknown keys, bad formats, and invalid settings are rejected", () => {
    expect(() =>
      parseVvocConfigText(
        docWithTelegram({ botToken: "123:abc", allowedUserIds: [7], bogus: true }),
        "test",
      ),
    ).toThrow();
    expect(() =>
      parseVvocConfigText(
        docWithTelegram({ botToken: "123:abc", allowedUserIds: [7], activityWindowMinutes: 0 }),
        "test",
      ),
    ).toThrow();
    expect(() =>
      parseVvocConfigText(
        docWithTelegram({
          botToken: "123:abc",
          allowedUserIds: [7],
          settings: { formatMode: "html" },
        }),
        "test",
      ),
    ).toThrow();
  });

  test("a telegram section survives a render and reparse round-trip", () => {
    const parsed = parseVvocConfigText(
      docWithTelegram({ botToken: "123:abc", allowedUserIds: [7], activityWindowMinutes: 90 }),
      "test",
    );
    const reparsed = parseVvocConfigText(renderVvocConfig(parsed), "test");
    expect(reparsed.telegram).toEqual(parsed.telegram);
  });
});
// END_BLOCK_TELEGRAM_SECTION_TEST

// START_BLOCK_TELEGRAM_PARITY_TEST
describe("telegram schema parity", () => {
  test("embedded TELEGRAM_CONFIG_SCHEMA matches schemas/vvoc/v3.json telegram property", () => {
    const fileSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
      properties: Record<string, unknown>;
    };
    expect((VVOC_CONFIG_SCHEMA.properties as Record<string, unknown>).telegram).toEqual(
      fileSchema.properties.telegram,
    );
  });
});
// END_BLOCK_TELEGRAM_PARITY_TEST

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

describe("optional systemone section and guardian decision backend", () => {
  function docWithSystemone(systemone: unknown, guardian?: Record<string, unknown>): string {
    const base = createDefaultVvocConfig();
    return JSON.stringify(
      {
        ...base,
        guardian: guardian ? { ...base.guardian, ...guardian } : base.guardian,
        systemone,
      },
      null,
      2,
    );
  }

  test("defaults carry no systemone section and no backend override", () => {
    const defaults = createDefaultVvocConfig();
    expect(defaults.systemone).toBeUndefined();
    expect(defaults.guardian.decisionBackend).toBeUndefined();
    expect(defaults.guardian.systemone).toBeUndefined();
    const rendered = JSON.parse(renderVvocConfig(defaults)) as Record<string, unknown>;
    expect(rendered.systemone).toBeUndefined();
    expect((rendered.guardian as Record<string, unknown>).decisionBackend).toBeUndefined();
  });

  test("a full systemone section parses and round-trips", () => {
    const parsed = parseVvocConfigText(
      docWithSystemone({
        enabled: true,
        baseUrl: "http://localhost:8790",
        model: "example",
        apiKey: "${SYSTEMONE_KEY}",
        timeoutMs: 2500,
        maxRetries: 2,
      }),
      "test",
    );
    expect(parsed.systemone).toEqual({
      enabled: true,
      baseUrl: "http://localhost:8790",
      model: "example",
      apiKey: "${SYSTEMONE_KEY}",
      timeoutMs: 2500,
      maxRetries: 2,
    });
    const rendered = renderVvocConfig(parsed);
    expect(parseVvocConfigText(rendered, "test").systemone).toEqual(parsed.systemone);
  });

  test("a minimal systemone section seeds enabled, timeout, and retries", () => {
    const parsed = parseVvocConfigText(
      docWithSystemone({ baseUrl: "https://api.example.test", model: "example" }),
      "test",
    );
    expect(parsed.systemone).toEqual({
      enabled: true,
      baseUrl: "https://api.example.test",
      model: "example",
      timeoutMs: 5_000,
      maxRetries: 1,
    });
  });

  test("rejects a missing baseUrl or model, unknown keys, and an out-of-range retry count", () => {
    expect(() => parseVvocConfigText(docWithSystemone({ model: "example" }), "test")).toThrow();
    expect(() => parseVvocConfigText(docWithSystemone({ baseUrl: "http://x" }), "test")).toThrow();
    expect(() =>
      parseVvocConfigText(
        docWithSystemone({ baseUrl: "http://x", model: "m", bogus: true }),
        "test",
      ),
    ).toThrow();
    expect(() =>
      parseVvocConfigText(
        docWithSystemone({ baseUrl: "http://x", model: "m", maxRetries: 6 }),
        "test",
      ),
    ).toThrow();
  });

  test("guardian decisionBackend and systemone policy parse and round-trip", () => {
    const parsed = parseVvocConfigText(
      docWithSystemone(
        { baseUrl: "http://localhost:8790", model: "example" },
        { decisionBackend: "systemone", systemone: { lowRiskThreshold: 0.9 } },
      ),
      "test",
    );
    expect(parsed.guardian.decisionBackend).toBe("systemone");
    expect(parsed.guardian.systemone).toEqual({ lowRiskThreshold: 0.9 });
    const rendered = renderVvocConfig(parsed);
    const reparsed = parseVvocConfigText(rendered, "test");
    expect(reparsed.guardian.decisionBackend).toBe("systemone");
    expect(reparsed.guardian.systemone).toEqual({ lowRiskThreshold: 0.9 });
  });

  test("rejects an invalid decisionBackend and an invalid guardian systemone policy", () => {
    expect(() =>
      parseVvocConfigText(
        docWithSystemone({ baseUrl: "http://x", model: "m" }, { decisionBackend: "both" }),
        "test",
      ),
    ).toThrow();
    expect(() =>
      parseVvocConfigText(
        docWithSystemone({ baseUrl: "http://x", model: "m" }, { systemone: {} }),
        "test",
      ),
    ).toThrow();
    expect(() =>
      parseVvocConfigText(
        docWithSystemone(
          { baseUrl: "http://x", model: "m" },
          { systemone: { lowRiskThreshold: 2 } },
        ),
        "test",
      ),
    ).toThrow();
  });

  test("createSystemOneConfig normalizes defaults and returns undefined when absent", () => {
    expect(createSystemOneConfig(undefined)).toBeUndefined();
    expect(createSystemOneConfig("nope")).toBeUndefined();
    expect(createSystemOneConfig({ baseUrl: "http://x", model: "m" })).toEqual({
      enabled: true,
      baseUrl: "http://x",
      model: "m",
      timeoutMs: 5_000,
      maxRetries: 1,
    });
    expect(() => renderSystemOneConfig({ baseUrl: "http://x" })).toThrow();
  });

  test("createGuardianConfig keeps backend fields absent unless provided", () => {
    expect(createGuardianConfig().decisionBackend).toBeUndefined();
    expect(createGuardianConfig({ decisionBackend: "fast" }).decisionBackend).toBe("fast");
  });

  test("a pre-change document without systemone fields still validates", () => {
    const legacy = createDefaultVvocConfig();
    expect(validateVvocConfigDocument(legacy)).toEqual([]);
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

  test("embedded guardian and systemone schemas match schemas/vvoc/v3.json", () => {
    const fileSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
      properties: Record<string, unknown>;
    };
    const properties = VVOC_CONFIG_SCHEMA.properties as Record<string, unknown>;
    expect(properties.guardian).toEqual(fileSchema.properties.guardian);
    expect(properties.systemone).toEqual(fileSchema.properties.systemone);
  });
});

describe("plugins union parsing and schema", () => {
  function docWithPlugins(plugins: unknown): string {
    return JSON.stringify({ ...createDefaultVvocConfig(), plugins }, null, 2);
  }

  test("boolean plugin entries parse unchanged (backward compatible)", () => {
    const parsed = parseVvocConfigText(
      docWithPlugins({ guardian: false, "hashline-edit": true }),
      "test",
    );
    expect(parsed.plugins.guardian).toBe(false);
    expect(parsed.plugins["hashline-edit"]).toBe(true);
  });

  test("object plugin entries parse with enabled and routing preserved", () => {
    const parsed = parseVvocConfigText(
      docWithPlugins({
        "hashline-edit": {
          enabled: true,
          routing: { default: "hashline_edit", rules: { qwen: "edit" } },
        },
      }),
      "test",
    );
    expect(parsed.plugins["hashline-edit"]).toEqual({
      enabled: true,
      routing: { default: "hashline_edit", rules: { qwen: "edit" } },
    });
  });

  test("schema rejects invalid routing modes and unknown routing keys", () => {
    const invalidMode = JSON.parse(
      docWithPlugins({ "hashline-edit": { routing: { default: "patch" } } }),
    );
    expect(validateVvocConfigDocument(invalidMode).length).toBeGreaterThan(0);

    const invalidRule = JSON.parse(
      docWithPlugins({ "hashline-edit": { routing: { rules: { qwen: "patch" } } } }),
    );
    expect(validateVvocConfigDocument(invalidRule).length).toBeGreaterThan(0);

    const unknownKey = JSON.parse(
      docWithPlugins({ "hashline-edit": { routing: { bogus: true } } }),
    );
    expect(validateVvocConfigDocument(unknownKey).length).toBeGreaterThan(0);

    const nonBoolean = JSON.parse(docWithPlugins({ guardian: "yes" }));
    expect(validateVvocConfigDocument(nonBoolean).length).toBeGreaterThan(0);
  });

  test("schema accepts the object form alongside booleans", () => {
    const valid = JSON.parse(
      docWithPlugins({
        guardian: false,
        "hashline-edit": { enabled: true, routing: { default: "hashline_edit" } },
      }),
    );
    expect(validateVvocConfigDocument(valid)).toEqual([]);
  });

  test("schema accepts legacy hashline-edit routing values from pre-rc.4 configs", () => {
    const legacy = JSON.parse(
      docWithPlugins({
        "hashline-edit": {
          enabled: false,
          routing: {
            default: "passthrough",
            rules: {
              deepseek: "str_replace_editor",
              kimi: "replace",
              qwen: "replace",
              glm: "passthrough",
              gpt: "passthrough",
              codex: "passthrough",
            },
          },
        },
      }),
    );
    expect(validateVvocConfigDocument(legacy)).toEqual([]);

    const parsed = parseVvocConfigText(
      docWithPlugins({
        "hashline-edit": {
          enabled: false,
          routing: { default: "passthrough", rules: { qwen: "replace" } },
        },
      }),
      "test",
    );
    expect(parsed.plugins["hashline-edit"]).toEqual({
      enabled: false,
      routing: { default: "passthrough", rules: { qwen: "replace" } },
    });
  });

  test("schema accepts tool-history-compaction recent-window and saved-output keys", () => {
    const valid = JSON.parse(
      docWithPlugins({
        "tool-history-compaction": {
          enabled: true,
          protectLastCalls: 3,
          protectRecentMessages: 8,
          savePrunedOutput: true,
          minSavingsChars: 2000,
          outputMaxChars: 2048,
          headChars: 1200,
          tailChars: 400,
          readSlim: true,
          retainTools: ["webfetch", "search", "skill", "task", "agent"],
        },
      }),
    );
    expect(validateVvocConfigDocument(valid)).toEqual([]);
  });

  test("schema rejects invalid tool-history-compaction key values", () => {
    const negativeWindow = JSON.parse(
      docWithPlugins({ "tool-history-compaction": { protectRecentMessages: -1 } }),
    );
    expect(validateVvocConfigDocument(negativeWindow).length).toBeGreaterThan(0);

    const nonBooleanSave = JSON.parse(
      docWithPlugins({ "tool-history-compaction": { savePrunedOutput: "yes" } }),
    );
    expect(validateVvocConfigDocument(nonBooleanSave).length).toBeGreaterThan(0);

    const unknownKey = JSON.parse(
      docWithPlugins({ "tool-history-compaction": { bogusBudget: 1 } }),
    );
    expect(validateVvocConfigDocument(unknownKey).length).toBeGreaterThan(0);
  });

  test("embedded plugins schema matches schemas/vvoc/v3.json plugins property", () => {
    const fileSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
      properties: Record<string, unknown>;
    };
    expect((VVOC_CONFIG_SCHEMA.properties as Record<string, unknown>).plugins).toEqual(
      fileSchema.properties.plugins,
    );
  });

  test("schema accepts a valid peak-hours entry with schedules and weekday windows", () => {
    const valid = JSON.parse(
      docWithPlugins({
        "peak-hours": {
          enabled: true,
          mode: "hard",
          graceActiveSessions: true,
          schedules: {
            deepseek: {
              windows: [
                { start: "01:00", end: "04:00", tz: "UTC" },
                { start: "06:00", end: "10:00" },
              ],
            },
            "z-ai": {
              mode: "soft",
              windows: [{ start: "06:00", end: "10:00", tz: "UTC", days: [1, 2, 3, 4, 5] }],
            },
          },
        },
      }),
    );
    expect(validateVvocConfigDocument(valid)).toEqual([]);
  });

  test("schema rejects malformed peak-hours entries", () => {
    const badTime = JSON.parse(
      docWithPlugins({
        "peak-hours": { schedules: { deepseek: { windows: [{ start: "24:00", end: "04:00" }] } } },
      }),
    );
    expect(validateVvocConfigDocument(badTime).length).toBeGreaterThan(0);

    const badMode = JSON.parse(docWithPlugins({ "peak-hours": { mode: "strict" } }));
    expect(validateVvocConfigDocument(badMode).length).toBeGreaterThan(0);

    const badDays = JSON.parse(
      docWithPlugins({
        "peak-hours": {
          schedules: { qwen: { windows: [{ start: "00:00", end: "9:00", days: [9] }] } },
        },
      }),
    );
    expect(validateVvocConfigDocument(badDays).length).toBeGreaterThan(0);

    const unknownKey = JSON.parse(docWithPlugins({ "peak-hours": { surcharge: true } }));
    expect(validateVvocConfigDocument(unknownKey).length).toBeGreaterThan(0);

    const missingWindows = JSON.parse(
      docWithPlugins({ "peak-hours": { schedules: { deepseek: { mode: "hard" } } } }),
    );
    expect(validateVvocConfigDocument(missingWindows).length).toBeGreaterThan(0);
  });

  test("schema accepts boolean and absent peak-hours entries for backward compatibility", () => {
    const booleanForm = JSON.parse(docWithPlugins({ "peak-hours": false }));
    expect(validateVvocConfigDocument(booleanForm)).toEqual([]);
    const absent = JSON.parse(docWithPlugins({ guardian: true }));
    expect(validateVvocConfigDocument(absent)).toEqual([]);
  });

  test("schema accepts a valid spec-guard entry and rejects malformed ones", () => {
    const valid = JSON.parse(docWithPlugins({ "spec-guard": { enabled: true, mode: "enforce" } }));
    expect(validateVvocConfigDocument(valid)).toEqual([]);

    const warnOnly = JSON.parse(docWithPlugins({ "spec-guard": { mode: "warn" } }));
    expect(validateVvocConfigDocument(warnOnly)).toEqual([]);

    const booleanForm = JSON.parse(docWithPlugins({ "spec-guard": true }));
    expect(validateVvocConfigDocument(booleanForm)).toEqual([]);

    const badMode = JSON.parse(docWithPlugins({ "spec-guard": { mode: "strict" } }));
    expect(validateVvocConfigDocument(badMode).length).toBeGreaterThan(0);

    const unknownKey = JSON.parse(docWithPlugins({ "spec-guard": { severity: true } }));
    expect(validateVvocConfigDocument(unknownKey).length).toBeGreaterThan(0);
  });
});
