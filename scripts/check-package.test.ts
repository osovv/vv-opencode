// FILE: scripts/check-package.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Prove the manifest-driven package gate accepts the real native surface and fails on independent mutations: a non-native entry, a missing plugin export (including ToolHistoryCompaction), a removed V1 dependency check, a missing declared dependency, an omitted packed forwarder, and a tarball missing a required dist target.
//   SCOPE: Pure assertions over in-memory manifests and injected import/pack/list dependencies; no repository file is written.
//   DEPENDS: [bun:test, scripts/check-package]
//   LINKS: [M-AGENT-TOOL-CONTRACT, V-M-AGENT-TOOL-CONTRACT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   repoRoot - Repository root used for the real manifest surface check.
//   realManifest - The real package.json manifest.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009 - Initial coverage for the manifest-driven export/entry/tarball package gate.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  expectedTarballEntries,
  manifestIssues,
  nativeEntryIssue,
  packageExportRequirements,
  pluginExportName,
  runPackageCheck,
  verifyPackageExports,
  verifyTarballEntries,
  type PackageManifest,
} from "./check-package.ts";

const repoRoot = process.cwd();
const realManifest = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
) as PackageManifest;

describe("native entry shape", () => {
  test("accepts setup and effect entries and rejects non-native shapes", () => {
    expect(nativeEntryIssue("x", { id: "a", setup: () => undefined })).toBeUndefined();
    expect(nativeEntryIssue("x", { id: "a", effect: () => undefined })).toBeUndefined();
    expect(nativeEntryIssue("x", { id: "a" })).toContain("neither a setup nor an effect");
    expect(nativeEntryIssue("x", { setup: () => undefined })).toContain("no string id");
    expect(nativeEntryIssue("x", undefined)).toContain("not a native entry object");
  });
});

describe("export requirements", () => {
  test("derives every plugin export name including tool-history-compaction", () => {
    expect(pluginExportName("./plugins/tool-history-compaction")).toBe(
      "ToolHistoryCompactionPlugin",
    );
    expect(pluginExportName("./plugins/model-roles")).toBe("ModelRolesPlugin");
  });

  test("the real manifest requires the aggregate, TUI, and all plugin subpaths", () => {
    const requirements = packageExportRequirements(realManifest);
    const subpaths = requirements.map((requirement) => requirement.subpath);
    expect(subpaths).toContain(".");
    expect(subpaths).toContain("./server");
    expect(subpaths).toContain("./tui");
    const plugins = subpaths.filter((subpath) => subpath.startsWith("./plugins/"));
    expect(plugins).toHaveLength(12);
    expect(plugins).toContain("./plugins/tool-history-compaction");
    expect(plugins).toContain("./plugins/telegram");
  });
});

describe("export verification", () => {
  test("fails when a plugin subpath exports a non-native value", async () => {
    const manifest: PackageManifest = {
      name: "fixture",
      version: "0.0.1",
      exports: { "./plugins/extra": { import: "./dist/extra/index.js" } },
    };
    const failures = await verifyPackageExports(manifest, {
      importModule: async () => ({ ExtraPlugin: {} }),
      distUrl: (target) => target,
    });
    expect(failures.some((failure) => failure.includes("ExtraPlugin"))).toBe(true);
  });

  test("fails when the aggregate default is not a native entry", async () => {
    const manifest: PackageManifest = {
      name: "fixture",
      version: "0.0.1",
      exports: { ".": { import: "./dist/index.js" } },
    };
    const failures = await verifyPackageExports(manifest, {
      importModule: async () => ({ default: { id: "x" } }),
      distUrl: (target) => target,
    });
    expect(failures.some((failure) => failure.includes(". default"))).toBe(true);
  });

  test("passes for a well-formed aggregate, TUI, and plugin surface", async () => {
    const manifest: PackageManifest = {
      name: "fixture",
      version: "0.0.1",
      exports: {
        ".": { import: "./dist/index.js" },
        "./tui": { import: "./dist/tui.js" },
        "./plugins/extra": { import: "./dist/extra/index.js" },
      },
    };
    const failures = await verifyPackageExports(manifest, {
      importModule: async (specifier) => {
        if (specifier.endsWith("tui.js")) return { default: { id: "tui", setup: () => undefined } };
        if (specifier.endsWith("extra/index.js"))
          return { ExtraPlugin: { id: "extra", setup: () => undefined } };
        return {
          default: { id: "vvoc", setup: () => undefined },
          ExtraPlugin: { id: "extra", setup: () => undefined },
        };
      },
      distUrl: (target) => target,
    });
    expect(failures).toEqual([]);
  });
});

describe("manifest and tarball gates", () => {
  test("flags a lingering V1 dependency and a missing direct dependency", () => {
    const manifest: PackageManifest = {
      name: "fixture",
      version: "0.0.1",
      dependencies: { "@opencode-ai/plugin": "1.18.2" },
    };
    const failures = manifestIssues(manifest);
    expect(failures.some((failure) => failure.includes("@opencode-ai/plugin"))).toBe(true);
    expect(failures.some((failure) => failure.includes("@opencode/plugin"))).toBe(true);
    expect(manifestIssues(realManifest)).toEqual([]);
  });

  test("requires the packed forwarders and every declared dist target", () => {
    const required = expectedTarballEntries(realManifest);
    expect(required).toContain("package/server.js");
    expect(required).toContain("package/tui.js");
    expect(required).toContain("package/dist/plugins/tool-history-compaction/index.js");
    const missing = verifyTarballEntries(["package/package.json"], realManifest);
    expect(missing).toContain("package/dist/tui.js");
    expect(missing).toContain("package/tui.js");
    expect(verifyTarballEntries(required, realManifest)).toEqual([]);
  });

  test("runPackageCheck fails closed on a tarball missing a required entry", async () => {
    const lines: string[] = [];
    const status = await runPackageCheck(
      repoRoot,
      {
        importModule: async () => ({ default: { id: "vvoc", setup: () => undefined } }),
        packTarball: async () => "/tmp/does-not-exist-vvoc.tgz",
        listTarballEntries: async () => ["package/package.json"],
      },
      (line) => lines.push(line),
    );
    expect(status).toBe(1);
    expect(lines.join("\n")).toContain("package/dist/index.js");
  });
});
