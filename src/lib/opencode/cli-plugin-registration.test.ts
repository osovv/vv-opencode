// FILE: src/lib/opencode/cli-plugin-registration.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the mirror-only cli.json pin writer and the server-versus-client pin comparison.
//   SCOPE: Managed-entry rewrite with comment and options preservation, no creation of documents or arrays, idempotency, conflict refusal, and pin comparison outcomes; no host, no filesystem.
//   DEPENDS: [bun:test, src/lib/opencode/cli-plugin-registration.ts, src/lib/opencode/shared-utils.ts]
//   LINKS: [M-CLI-CONFIG, V-M-CLI-CONFIG]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   cliConfig - Build a cli.json document fixture with the given plugins array.
//   serverPlugins - Build an opencode.json plugins fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CLI-JSON-PIN-SYNC-R1 T-001 - Covered the mirror-only cli.json pin writer and the pin comparison.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  comparePluginPins,
  ensureCliPackageConfigText,
  managedPinOf,
  readCliPluginPin,
} from "./cli-plugin-registration.js";

function cliConfig(
  plugins: unknown,
  options: { readonly comments?: boolean; readonly theme?: boolean } = {},
): string {
  const lines: string[] = ["{"];
  if (options.comments) lines.push("  // migrated from the V1 terminal config", "");
  if (options.theme) {
    lines.push('  "theme": { "name": "opencode", "mode": "dark" },');
  }
  lines.push(`  "plugins": ${JSON.stringify(plugins, null, 2).replace(/\n/g, "\n  ")}`);
  lines.push("}");
  const text = lines.join("\n");
  return options.comments ? `// client preferences\n${text}` : text;
}

function serverPlugins(entries: unknown[]): string {
  return JSON.stringify({ plugins: entries });
}

describe("ensureCliPackageConfigText", () => {
  test("rewrites a managed string pin preserving comments, theme, and formatting shape", () => {
    const text = cliConfig(["some-other-plugin", "@osovv/vv-opencode@2.1.2"], {
      comments: true,
      theme: true,
    });
    const next = ensureCliPackageConfigText(text, "@osovv/vv-opencode@2.1.5");
    if (next === undefined) throw new Error("expected a rewrite");
    expect(next).toContain("// migrated from the V1 terminal config");
    expect(next).toContain('"theme"');
    expect(next).toContain("some-other-plugin");
    expect(next).toContain("@osovv/vv-opencode@2.1.5");
    expect(next).not.toContain("@osovv/vv-opencode@2.1.2");
    // Unrelated entry order is preserved: the other plugin stays first.
    expect(next.indexOf("some-other-plugin")).toBeLessThan(next.indexOf("@osovv/vv-opencode"));
  });

  test("rewrites a managed object entry preserving its options", () => {
    const text = cliConfig([
      { package: "@osovv/vv-opencode@2.1.2", options: { modelIntent: { model: "p/m" } } },
    ]);
    const next = ensureCliPackageConfigText(text, "@osovv/vv-opencode@2.1.5");
    if (next === undefined) throw new Error("expected a rewrite");
    expect(next).toContain('"package": "@osovv/vv-opencode@2.1.5"');
    expect(next).toContain('"modelIntent"');
    expect(next).toContain('"model": "p/m"');
  });

  test("returns the text unchanged when no managed entry exists", () => {
    const text = cliConfig(["some-other-plugin"], { theme: true });
    expect(ensureCliPackageConfigText(text, "@osovv/vv-opencode@2.1.5")).toBe(text);
  });

  test("returns the text unchanged when the plugins key is absent", () => {
    const text = '{\n  "theme": { "name": "opencode" }\n}\n';
    expect(ensureCliPackageConfigText(text, "@osovv/vv-opencode@2.1.5")).toBe(text);
  });

  test("returns undefined for an absent document and never creates one", () => {
    expect(ensureCliPackageConfigText(undefined, "@osovv/vv-opencode@2.1.5")).toBeUndefined();
    expect(ensureCliPackageConfigText("   ", "@osovv/vv-opencode@2.1.5")).toBeUndefined();
  });

  test("is byte-stable on a repeated run", () => {
    const text = cliConfig(["@osovv/vv-opencode@2.1.2"]);
    const once = ensureCliPackageConfigText(text, "@osovv/vv-opencode@2.1.5");
    const twice = ensureCliPackageConfigText(once, "@osovv/vv-opencode@2.1.5");
    expect(twice).toBe(once);
  });

  test("refuses conflicting managed entries instead of guessing", () => {
    const text = cliConfig([
      { package: "@osovv/vv-opencode@2.1.2", options: { a: 1 } },
      { package: "@osovv/vv-opencode@2.1.3", options: { b: 2 } },
    ]);
    expect(() => ensureCliPackageConfigText(text, "@osovv/vv-opencode@2.1.5")).toThrow(
      /conflicting managed plugin entries/,
    );
  });
});

describe("pin comparison", () => {
  test("managedPinOf finds string, object, and legacy /tui entries", () => {
    expect(managedPinOf(["@osovv/vv-opencode@2.1.2"])).toBe("@osovv/vv-opencode@2.1.2");
    expect(managedPinOf([{ package: "@osovv/vv-opencode" }])).toBe("@osovv/vv-opencode");
    expect(managedPinOf(["@osovv/vv-opencode@2.1.2/tui"])).toBe("@osovv/vv-opencode@2.1.2/tui");
    expect(managedPinOf(["other-plugin"])).toBeUndefined();
  });

  test("comparePluginPins flags a stale client pin against the server pin", () => {
    const result = comparePluginPins(
      JSON.parse(serverPlugins([{ package: "@osovv/vv-opencode@2.1.5" }])).plugins,
      cliConfig(["@osovv/vv-opencode@2.1.2"]),
    );
    expect(result.serverPin).toBe("@osovv/vv-opencode@2.1.5");
    expect(result.cliPin).toBe("@osovv/vv-opencode@2.1.2");
    expect(result.mismatch).toBe(true);
  });

  test("comparePluginPins passes equal pins and tolerates a missing client pin", () => {
    const server = JSON.parse(serverPlugins([{ package: "@osovv/vv-opencode@2.1.5" }])).plugins;
    expect(
      comparePluginPins(server, cliConfig([{ package: "@osovv/vv-opencode@2.1.5" }])).mismatch,
    ).toBe(false);
    expect(comparePluginPins(server, undefined).mismatch).toBe(false);
    expect(comparePluginPins(server, cliConfig(["other"])).mismatch).toBe(false);
  });

  test("readCliPluginPin reports a bounded parse error without throwing", () => {
    const result = readCliPluginPin("{ not json");
    expect(result.exists).toBe(true);
    expect(result.parseError).toBeDefined();
    expect(result.managedPin).toBeUndefined();
  });
});
