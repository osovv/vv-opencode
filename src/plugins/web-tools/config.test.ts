// FILE: src/plugins/web-tools/config.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify runtime web config and credential resolution plus the git-tracked apiKey warning helper.
//   SCOPE: Provider defaults, explicit Z.AI region handling, environment-over-config precedence, config apiKey ${VAR} placeholder substitution with unset-reference warnings, credential source reporting, native credential freedom, and git-tracked warning behavior with an injected command runner.
//   DEPENDS: [bun:test, src/plugins/web-tools/config.ts, src/lib/vvoc-config.ts, src/lib/config-layers.ts]
//   LINKS: [M-WEB-CONFIG, V-M-WEB-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   snapshot - Build a minimal runtime vvoc snapshot for resolver tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [direct fix - Covered ${VAR} placeholder substitution in web apiKey fields and unset-reference warnings.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { ConfigSource } from "../../lib/config-layers.js";
import {
  createDefaultVvocConfig,
  type VvocConfig,
  type VvocWebConfig,
} from "../../lib/vvoc-config.js";
import {
  resolveWebRuntimeConfig,
  warnIfSecretBearingProjectConfigTracked,
  type CommandRunner,
} from "./config.js";

function snapshot(web: VvocWebConfig | undefined, source: ConfigSource, warnings: string[] = []) {
  const config: VvocConfig = { ...createDefaultVvocConfig(), web };
  return { config, source, warnings };
}

describe("resolveWebRuntimeConfig", () => {
  test("absent web section resolves to exa and native with no credentials or warnings", () => {
    const resolved = resolveWebRuntimeConfig(snapshot(undefined, { kind: "global" }), {});
    expect(resolved.search.provider).toBe("exa");
    expect(resolved.fetch.provider).toBe("native");
    expect(resolved.search.credential).toBeUndefined();
    expect(resolved.fetch.credential).toBeUndefined();
    expect(resolved.warnings).toEqual([]);
  });

  test("environment variable wins over config apiKey", () => {
    const resolved = resolveWebRuntimeConfig(
      snapshot({ search: { provider: "exa", apiKey: "from-config" } }, { kind: "global" }),
      { EXA_API_KEY: "from-env" },
    );
    expect(resolved.search.credential).toEqual({ value: "from-env", source: "env" });
  });

  test("config apiKey is used when the environment variable is absent", () => {
    const resolved = resolveWebRuntimeConfig(
      snapshot({ search: { provider: "exa", apiKey: "from-config" } }, { kind: "global" }),
      {},
    );
    expect(resolved.search.credential).toEqual({ value: "from-config", source: "config" });
  });

  test("missing credential resolves undefined without throwing", () => {
    const resolved = resolveWebRuntimeConfig(
      snapshot({ search: { provider: "brave" } }, { kind: "global" }),
      {},
    );
    expect(resolved.search.credential).toBeUndefined();
  });

  test("brave selects BRAVE_API_KEY and spider selects SPIDER_API_KEY", () => {
    const resolved = resolveWebRuntimeConfig(
      snapshot(
        { search: { provider: "brave" }, fetch: { provider: "spider" } },
        { kind: "global" },
      ),
      { BRAVE_API_KEY: "b", SPIDER_API_KEY: "s" },
    );
    expect(resolved.search.envVar).toBe("BRAVE_API_KEY");
    expect(resolved.search.credential).toEqual({ value: "b", source: "env" });
    expect(resolved.fetch.envVar).toBe("SPIDER_API_KEY");
    expect(resolved.fetch.credential).toEqual({ value: "s", source: "env" });
  });

  test("zai search and fetch preserve regions and share ZAI_API_KEY precedence", () => {
    const resolved = resolveWebRuntimeConfig(
      snapshot(
        {
          search: { provider: "zai", region: "international", apiKey: "search-config" },
          fetch: { provider: "zai", region: "china", apiKey: "fetch-config" },
        },
        { kind: "global" },
      ),
      { ZAI_API_KEY: "zai-env" },
    );
    expect(resolved.search).toEqual({
      provider: "zai",
      region: "international",
      envVar: "ZAI_API_KEY",
      configField: "web.search.apiKey",
      credential: { value: "zai-env", source: "env" },
    });
    expect(resolved.fetch).toEqual({
      provider: "zai",
      region: "china",
      envVar: "ZAI_API_KEY",
      configField: "web.fetch.apiKey",
      credential: { value: "zai-env", source: "env" },
    });
  });

  test("zai uses section apiKey when ZAI_API_KEY is absent", () => {
    const resolved = resolveWebRuntimeConfig(
      snapshot(
        {
          search: { provider: "zai", region: "china", apiKey: "search-config" },
          fetch: { provider: "zai", region: "international", apiKey: "fetch-config" },
        },
        { kind: "global" },
      ),
      {},
    );
    expect(resolved.search.credential).toEqual({ value: "search-config", source: "config" });
    expect(resolved.fetch.provider === "zai" && resolved.fetch.credential).toEqual({
      value: "fetch-config",
      source: "config",
    });
  });

  test("config apiKey ${VAR} placeholder resolves from the environment", () => {
    const resolved = resolveWebRuntimeConfig(
      snapshot(
        {
          search: {
            provider: "zai",
            region: "international",
            apiKey: "${VVOC_WEB_SEARCH_API_KEY}",
          },
          fetch: { provider: "zai", region: "international", apiKey: "${VVOC_WEB_FETCH_API_KEY}" },
        },
        { kind: "global" },
      ),
      {
        VVOC_WEB_SEARCH_API_KEY: "search-key-from-env",
        VVOC_WEB_FETCH_API_KEY: "fetch-key-from-env",
      },
    );
    expect(resolved.search.credential).toEqual({
      value: "search-key-from-env",
      source: "config",
    });
    expect(resolved.fetch.provider === "zai" && resolved.fetch.credential).toEqual({
      value: "fetch-key-from-env",
      source: "config",
    });
    expect(resolved.warnings).toEqual([]);
  });

  test("canonical environment variable wins over a config apiKey placeholder", () => {
    const resolved = resolveWebRuntimeConfig(
      snapshot(
        { search: { provider: "zai", region: "china", apiKey: "${VVOC_WEB_SEARCH_API_KEY}" } },
        {
          kind: "global",
        },
      ),
      { ZAI_API_KEY: "canonical-env", VVOC_WEB_SEARCH_API_KEY: "placeholder-env" },
    );
    expect(resolved.search.credential).toEqual({ value: "canonical-env", source: "env" });
    expect(resolved.warnings).toEqual([]);
  });

  test("placeholder referencing an unset variable yields no credential and a value-free warning", () => {
    const resolved = resolveWebRuntimeConfig(
      snapshot({ search: { provider: "exa", apiKey: "${VVOC_MISSING_KEY}" } }, { kind: "global" }),
      {},
    );
    expect(resolved.search.credential).toBeUndefined();
    expect(resolved.warnings).toHaveLength(1);
    const warning = resolved.warnings[0]!;
    expect(warning).toContain("web.search.apiKey");
    expect(warning).toContain("VVOC_MISSING_KEY");
    expect(warning).not.toContain("${VVOC_MISSING_KEY}");
    expect(warning).not.toContain("$");
  });

  test("partially resolving placeholder keeps the partial credential and still warns", () => {
    const resolved = resolveWebRuntimeConfig(
      snapshot(
        { fetch: { provider: "spider", apiKey: "prefix-${SPIDER_SET}-${SPIDER_UNSET}" } },
        { kind: "global" },
      ),
      { SPIDER_SET: "middle" },
    );
    expect(resolved.fetch.credential).toEqual({ value: "prefix-middle-", source: "config" });
    expect(resolved.warnings[0]).toContain("web.fetch.apiKey");
    expect(resolved.warnings[0]).toContain("SPIDER_UNSET");
  });

  test("literal config apiKey produces no placeholder warnings", () => {
    const resolved = resolveWebRuntimeConfig(
      snapshot({ search: { provider: "exa", apiKey: "sk-literal" } }, { kind: "global" }),
      {},
    );
    expect(resolved.search.credential).toEqual({ value: "sk-literal", source: "config" });
    expect(resolved.warnings).toEqual([]);
  });

  test("zai fails closed when an in-memory config omits its required region", () => {
    const invalid = { provider: "zai" } as never;
    expect(() =>
      resolveWebRuntimeConfig(snapshot({ search: invalid }, { kind: "global" }), {
        ZAI_API_KEY: "z",
      }),
    ).toThrow("web.search.region");
    expect(() =>
      resolveWebRuntimeConfig(snapshot({ fetch: invalid }, { kind: "global" }), {
        ZAI_API_KEY: "z",
      }),
    ).toThrow("web.fetch.region");
  });

  test("native fetch has no envVar, configField, or credential requirement", () => {
    const resolved = resolveWebRuntimeConfig(snapshot(undefined, { kind: "global" }), {});
    expect(resolved.fetch.envVar).toBeUndefined();
    expect(resolved.fetch.configField).toBeUndefined();
    expect(resolved.fetch.credential).toBeUndefined();
  });
});

describe("warnIfSecretBearingProjectConfigTracked", () => {
  const trackedRunner: CommandRunner = () => ({ status: 0 });
  const untrackedRunner: CommandRunner = () => ({ status: 1 });
  const projectSource: ConfigSource = {
    kind: "project",
    path: "/repo/.vvoc/vvoc.json",
    rootDir: "/repo",
  };

  test("warns naming the file when a tracked project config stores an apiKey", () => {
    const warning = warnIfSecretBearingProjectConfigTracked(
      snapshot({ search: { apiKey: "secret-value" } }, projectSource),
      trackedRunner,
    );
    expect(warning).toContain("/repo/.vvoc/vvoc.json");
    expect(warning).not.toContain("secret-value");
  });

  test("returns undefined when the file is untracked", () => {
    expect(
      warnIfSecretBearingProjectConfigTracked(
        snapshot({ search: { apiKey: "x" } }, projectSource),
        untrackedRunner,
      ),
    ).toBeUndefined();
  });

  test("returns undefined for the global layer", () => {
    expect(
      warnIfSecretBearingProjectConfigTracked(
        snapshot(
          { search: { apiKey: "x" } },
          { kind: "global", path: "/home/.config/vvoc/vvoc.json" },
        ),
        trackedRunner,
      ),
    ).toBeUndefined();
  });

  test("returns undefined when no apiKey is present", () => {
    expect(
      warnIfSecretBearingProjectConfigTracked(
        snapshot({ search: { provider: "exa" } }, projectSource),
        trackedRunner,
      ),
    ).toBeUndefined();
  });
});
