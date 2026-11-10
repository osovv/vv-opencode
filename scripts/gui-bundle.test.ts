// FILE: scripts/gui-bundle.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Execute the built `./gui-experimental` CommonJS bundle with the host SDK modules stubbed and assert that its default export is a loadable GUI definition: an English i18n catalog and a setup that registers the vvoc settings page and the profile composer pill.
//   SCOPE: Bundle-level loadability harness over `dist/gui-experimental.cjs` when it exists (skipped on a fresh tree without a build); externals are stubbed because the app provides them at runtime. No DOM and no real host.
//   DEPENDS: [node:fs, node:module, bun:test]
//   LINKS: [M-GUI-SPIKE, V-M-GUI-SPIKE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   BUNDLE_PATH - Repo-relative path of the built GUI bundle.
//   loadBundle - Evaluates the built bundle with stubbed app-provided modules and returns its default export.
//   recorded - The registry items the stubbed context captured during setup.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [GUI-SPike initial skeleton - Added the built-bundle loadability harness proving the default export registers both GUI contributions with its i18n catalog.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Repo-relative path of the built GUI bundle. */
export const BUNDLE_PATH = join(import.meta.dir, "..", "dist", "gui-experimental.cjs");

/** The registry items the stubbed context captured during setup. */
const recorded: Array<{ registry: string; item: Record<string, unknown> }> = [];

/**
 * Evaluates the built bundle with stubbed app-provided modules and returns its
 * default export. The stubs mirror the host's shared-module contract:
 * `@opencode/plugin/gui` provides the define/registries surface, `effect`
 * provides the Schema namespace, and Solid provides the reactive primitives.
 */
function loadBundle(): Record<string, unknown> {
  const source = require("node:fs").readFileSync(BUNDLE_PATH, "utf8") as string;
  const stubSchema = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "toStandardSchemaV1") return (value: unknown) => value;
        return () => ({});
      },
    },
  );
  const stubs: Record<string, unknown> = {
    "solid-js": {
      createResource: () => [() => undefined, { refetch: () => undefined }],
      Show: () => null,
    },
    "solid-js/web": { insert: () => undefined, createComponent: () => null, template: () => null },
    "@opencode/plugin/gui": {
      Plugin: { define: (definition: unknown) => definition },
      SettingsPage: { name: "SettingsPage" },
      ComposerPill: { name: "ComposerPill" },
    },
    effect: { Schema: stubSchema },
  };
  const module = { exports: {} as Record<string, unknown> };
  const loader = new Function("require", "module", "exports", source);
  loader(
    (name: string) => {
      const stub = stubs[name];
      if (stub !== undefined) return stub;
      return require(name);
    },
    module,
    module.exports,
  );
  return (module.exports.default ?? {}) as Record<string, unknown>;
}

describe("gui bundle loadability", () => {
  test("default export registers the settings page and the composer pill", () => {
    if (!existsSync(BUNDLE_PATH)) {
      console.log("dist/gui-experimental.cjs is absent (no build); skipping bundle harness");
      return;
    }
    const definition = loadBundle();
    const i18n = definition.i18n as { en?: Record<string, string> } | undefined;
    expect(typeof definition.setup).toBe("function");
    expect(i18n?.en).toBeDefined();
    expect(Object.keys(i18n?.en ?? {})).toContain("settings.title");

    const context = {
      id: "vvoc",
      app: { platform: "web", version: "0.0.0" },
      t: (key: string) => i18n?.en?.[key] ?? key,
      add: (registry: { name: string }, item: Record<string, unknown>) => {
        recorded.push({ registry: String(registry.name), item });
        return () => undefined;
      },
      layout: { settings: () => undefined },
      client: {
        rpc: () => ({
          "defaults.get": async () => {
            throw new Error("stub client");
          },
        }),
      },
      signal: new AbortController().signal,
    };
    (definition.setup as (ctx: unknown) => unknown)(context);
    const page = recorded.find((entry) => entry.registry === "SettingsPage");
    const pill = recorded.find((entry) => entry.registry === "ComposerPill");
    expect(page?.item.id).toBe("vvoc");
    expect(typeof page?.item.render).toBe("function");
    expect(pill?.item.id).toBe("profile");
    expect(typeof (pill?.item as { show?: unknown }).show).toBe("function");
  });
});
