// FILE: src/lib/spec-lint-cache.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Deterministic tests for the content-addressed spec lint cache: hits, invalidation by content and lint version, bypass, pruning, and tolerance of corrupt cache files.
//   SCOPE: Temp-directory fixture runs through createSpecLintCache and computeSpecLintCacheKey without touching the real cache home.
//   DEPENDS: [src/lib/spec-lint-cache.ts, src/lib/spec-lint.ts]
//   LINKS: [M-SPEC-LINT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   validSpec - Minimal valid spec fixture.
//   otherSpec - Content-variant of validSpec for invalidation checks.
//   tempRoot - Creates an isolated cache root directory.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SPEC-IDENTITY-LINT - Initial cache hit, invalidation, bypass, pruning, and corruption tests.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_MAX_CACHE_ENTRIES,
  computeSpecLintCacheKey,
  createSpecLintCache,
} from "./spec-lint-cache.js";
import { LINT_VERSION } from "./spec-lint.js";

const validSpec = `<spec><status>draft</status><goal>g</goal><components><COMPONENT-A><name>A</name><responsibility>r</responsibility></COMPONENT-A></components></spec>`;
const otherSpec = validSpec.replace("<goal>g</goal>", "<goal>different</goal>");

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vvoc-lint-cache-"));
}

describe("computeSpecLintCacheKey", () => {
  test("is deterministic across input order", () => {
    const a = computeSpecLintCacheKey([
      { file: "spec.xml", content: validSpec },
      { file: "plan.xml", content: "<plan></plan>" },
    ]);
    const b = computeSpecLintCacheKey([
      { file: "plan.xml", content: "<plan></plan>" },
      { file: "spec.xml", content: validSpec },
    ]);
    expect(a).toBe(b);
  });

  test("changes with content and with lint version", () => {
    const base = computeSpecLintCacheKey([{ file: "spec.xml", content: validSpec }]);
    expect(computeSpecLintCacheKey([{ file: "spec.xml", content: otherSpec }])).not.toBe(base);
    expect(
      computeSpecLintCacheKey([{ file: "spec.xml", content: validSpec }], base.length),
    ).not.toBe(base);
  });
});

describe("createSpecLintCache", () => {
  test("second run over unchanged inputs hits the cache", async () => {
    const root = await tempRoot();
    const cache = await createSpecLintCache({ cacheRoot: root });
    const first = await cache.lint([{ file: "spec.xml", content: validSpec }]);
    expect(first.hit).toBe(false);
    expect(first.verdicts[0].ok).toBe(true);
    const second = await cache.lint([{ file: "spec.xml", content: validSpec }]);
    expect(second.hit).toBe(true);
    expect(second.verdicts).toEqual(first.verdicts);
  });

  test("a fresh cache instance reads the persisted disk entry", async () => {
    const root = await tempRoot();
    const first = await createSpecLintCache({ cacheRoot: root });
    await first.lint([{ file: "spec.xml", content: validSpec }]);
    const second = await createSpecLintCache({ cacheRoot: root });
    const result = await second.lint([{ file: "spec.xml", content: validSpec }]);
    expect(result.hit).toBe(true);
  });

  test("editing the spec content invalidates the run including dependent plan verdicts", async () => {
    const root = await tempRoot();
    const cache = await createSpecLintCache({ cacheRoot: root });
    const inputs = [
      { file: ".vvoc/specs/2026-08-29-x/spec.xml", content: validSpec },
      { file: ".vvoc/specs/2026-08-29-x/plan.xml", content: "<plan></plan>" },
    ];
    const first = await cache.lint(inputs);
    expect(first.hit).toBe(false);
    const changed = await cache.lint([
      { file: ".vvoc/specs/2026-08-29-x/spec.xml", content: otherSpec },
      { file: ".vvoc/specs/2026-08-29-x/plan.xml", content: "<plan></plan>" },
    ]);
    expect(changed.hit).toBe(false);
  });

  test("bypass never reads or writes the disk layer", async () => {
    const root = await tempRoot();
    const cache = await createSpecLintCache({ cacheRoot: root, bypass: true });
    const first = await cache.lint([{ file: "spec.xml", content: validSpec }]);
    const second = await cache.lint([{ file: "spec.xml", content: validSpec }]);
    expect(first.hit).toBe(false);
    expect(second.hit).toBe(false);
    await expect(readFile(cache.cacheFilePath, "utf8")).rejects.toThrow();
  });

  test("a corrupt cache file starts empty instead of failing", async () => {
    const root = await tempRoot();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "cache.json"), "{not json", "utf8");
    const cache = await createSpecLintCache({ cacheRoot: root });
    const result = await cache.lint([{ file: "spec.xml", content: validSpec }]);
    expect(result.hit).toBe(false);
    const after = await cache.lint([{ file: "spec.xml", content: validSpec }]);
    expect(after.hit).toBe(true);
  });

  test("the disk layer keeps at most maxEntries newest entries", async () => {
    const root = await tempRoot();
    const cache = await createSpecLintCache({ cacheRoot: root, maxEntries: 2 });
    for (let i = 0; i < 3; i++) {
      await cache.lint([{ file: "spec.xml", content: `<!-- ${i} -->${validSpec}` }]);
    }
    const raw = JSON.parse(await readFile(cache.cacheFilePath, "utf8"));
    expect(Object.keys(raw.entries).length).toBe(2);
  });

  test("default entry cap matches the documented constant", () => {
    expect(DEFAULT_MAX_CACHE_ENTRIES).toBe(256);
  });

  test("clear removes the cache file", async () => {
    const root = await tempRoot();
    const cache = await createSpecLintCache({ cacheRoot: root });
    await cache.lint([{ file: "spec.xml", content: validSpec }]);
    await cache.clear();
    await expect(readFile(cache.cacheFilePath, "utf8")).rejects.toThrow();
    const again = await cache.lint([{ file: "spec.xml", content: validSpec }]);
    expect(again.hit).toBe(false);
  });

  test("cache entries carry the lint version so bumps invalidate", async () => {
    const root = await tempRoot();
    const cache = await createSpecLintCache({ cacheRoot: root });
    await cache.lint([{ file: "spec.xml", content: validSpec }]);
    const raw = JSON.parse(await readFile(cache.cacheFilePath, "utf8"));
    expect(raw.version).toBe(LINT_VERSION);
  });
});
