// FILE: scripts/copy-dist-assets.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Prove the src-to-dist asset mirror accepts the real src tree and fails/succeeds on independent mutations: asset-rule classification, missing-directory tolerance, nested mirroring, idempotent copies, and a copied tree that satisfies the pack-gate asset-mirror assertion.
//   SCOPE: Pure assertions and copies over temporary fixture directories; no repository file is written.
//   DEPENDS: [bun:test, scripts/copy-dist-assets, scripts/check-package]
//   LINKS: [M-AGENT-TOOL-CONTRACT, V-M-AGENT-TOOL-CONTRACT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   repoRoot - Repository root used for the real src asset surface check.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Initial coverage for the generalized non-TS src-to-dist asset mirror.]
// END_CHANGE_SUMMARY

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copySourceAssets,
  isSourceAssetPath,
  listDirectoryFilePaths,
  listSourceAssetPaths,
} from "./copy-dist-assets.ts";
import { verifyAssetMirror } from "./check-package.ts";

const repoRoot = process.cwd();

describe("asset rule", () => {
  test("classifies non-TS files as assets and TS files as code", () => {
    expect(isSourceAssetPath("src/plugins/workflow/system-instruction.md")).toBe(true);
    expect(isSourceAssetPath("src/lib/fixtures/catalog.json")).toBe(true);
    expect(isSourceAssetPath("src/index.ts")).toBe(false);
    expect(isSourceAssetPath("src/tui.tsx")).toBe(false);
    expect(isSourceAssetPath("src/lib/package.d.ts")).toBe(false);
  });

  test("the real src tree mirrors exactly its non-TS assets", () => {
    expect(listSourceAssetPaths(repoRoot)).toEqual([
      "src/hosts.json",
      "src/plugins/workflow/system-instruction.md",
    ]);
  });
});

describe("directory walk", () => {
  test("returns an empty list for a missing directory", () => {
    expect(listDirectoryFilePaths(repoRoot, "src/does-not-exist-vvoc")).toEqual([]);
  });
});

describe("asset copying", () => {
  let fixtureRoot: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "vvoc-copy-assets-"));
    mkdirSync(join(fixtureRoot, "src/plugins/workflow"), { recursive: true });
    mkdirSync(join(fixtureRoot, "src/lib"));
    writeFileSync(join(fixtureRoot, "src/plugins/workflow/template.md"), "template");
    writeFileSync(join(fixtureRoot, "src/plugins/workflow/index.ts"), "export {};");
    writeFileSync(join(fixtureRoot, "src/lib/data.json"), "{}\n");
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test("mirrors nested non-TS assets and skips TS code", () => {
    const targets = copySourceAssets(fixtureRoot);
    expect(targets).toEqual(["dist/lib/data.json", "dist/plugins/workflow/template.md"]);
    expect(readFileSync(join(fixtureRoot, "dist/plugins/workflow/template.md"), "utf8")).toBe(
      "template",
    );
    expect(listDirectoryFilePaths(fixtureRoot, "dist")).toHaveLength(2);
  });

  test("a copied tree satisfies the pack-gate asset mirror and a pruned tree fails naming the file", () => {
    const sourceAssets = listSourceAssetPaths(fixtureRoot);
    const distEntries = listDirectoryFilePaths(fixtureRoot, "dist");
    expect(verifyAssetMirror(sourceAssets, distEntries)).toEqual([]);

    rmSync(join(fixtureRoot, "dist/plugins/workflow/template.md"));
    const issues = verifyAssetMirror(sourceAssets, listDirectoryFilePaths(fixtureRoot, "dist"));
    expect(issues).toEqual([
      "src asset src/plugins/workflow/template.md is not mirrored to dist at dist/plugins/workflow/template.md",
    ]);
  });

  test("copying again is idempotent", () => {
    const targets = copySourceAssets(fixtureRoot);
    expect(targets).toEqual(["dist/lib/data.json", "dist/plugins/workflow/template.md"]);
    expect(verifyAssetMirror(listSourceAssetPaths(fixtureRoot), listDirectoryFilePaths(fixtureRoot, "dist"))).toEqual([]);
  });
});
