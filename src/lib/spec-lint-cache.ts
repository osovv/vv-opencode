// FILE: src/lib/spec-lint-cache.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Content-addressed disk+memory cache for spec lint runs keyed on every input content hash plus the lint rule version.
//   SCOPE: Cache key computation over sorted artifact inputs, an in-memory layer backed by a JSON file under the XDG cache home, lazy pruning of the oldest entries beyond a cap, and a bypass flag for --no-cache.
//   DEPENDS: [node:crypto, node:fs/promises, node:path, src/lib/spec-lint.ts, src/lib/vvoc-paths.ts]
//   LINKS: [M-SPEC-LINT, M-PLUGIN-SPEC-GUARD, M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SPEC_LINT_CACHE_DIR_NAME - Cache directory name under the cache home.
//   SPEC_LINT_CACHE_FILE_NAME - JSON cache file name.
//   DEFAULT_MAX_CACHE_ENTRIES - Entry cap; oldest savedAt entries are pruned on write.
//   SpecLintCacheOptions - Cache root override, entry cap, and bypass flag.
//   SpecLintCacheResult - One lint run's verdicts plus a cache hit flag.
//   SpecLintCache - Reusable cache object with lint, clear, and path helpers.
//   computeSpecLintCacheKey - Deterministic sha256 key over lint version and all artifact inputs.
//   createSpecLintCache - Create a cache bound to a root, loading existing entries lazily-tolerantly.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SPEC-IDENTITY-LINT - Initial cache: content-addressed keys, memory+disk layers, bounded pruning, bypass support.]
// END_CHANGE_SUMMARY

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LINT_VERSION,
  lintSpecArtifacts,
  type SpecLintArtifactInput,
  type SpecLintOptions,
  type SpecLintVerdict,
} from "./spec-lint.js";
import { getCacheHome } from "./vvoc-paths.js";

// START_BLOCK_CACHE_TYPES
export const SPEC_LINT_CACHE_DIR_NAME = "vvoc/lint";
export const SPEC_LINT_CACHE_FILE_NAME = "cache.json";
export const DEFAULT_MAX_CACHE_ENTRIES = 256;

export interface SpecLintCacheOptions {
  /** Directory holding cache.json. Defaults to <cache home>/vvoc/lint. */
  cacheRoot?: string;
  /** Maximum entries kept on disk; oldest are pruned on write. */
  maxEntries?: number;
  /** Bypass both layers: always compute fresh and do not read or write the disk layer. */
  bypass?: boolean;
}

export interface SpecLintCacheResult {
  verdicts: SpecLintVerdict[];
  /** True when the verdicts came from a cache layer instead of a fresh run. */
  hit: boolean;
}

interface CacheFileEntry {
  savedAt: number;
  inputs: string[];
  verdicts: SpecLintVerdict[];
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheFileEntry>;
}

export interface SpecLintCache {
  lint(
    inputs: SpecLintArtifactInput[],
    lintOptions?: SpecLintOptions,
  ): Promise<SpecLintCacheResult>;
  clear(): Promise<void>;
  readonly cacheFilePath: string;
}
// END_BLOCK_CACHE_TYPES

// START_BLOCK_KEY_COMPUTATION
/**
 * Deterministic cache key: sha256 over the lint version plus every artifact's
 * file label and content, sorted so input order never matters. The linked
 * spec's content participates in a plan run's key because callers pass whole
 * input sets, which makes cross-file verdicts invalidate with their spec.
 */
export function computeSpecLintCacheKey(
  inputs: SpecLintArtifactInput[],
  lintVersion = LINT_VERSION,
): string {
  const hasher = createHash("sha256");
  hasher.update(`v${lintVersion}\n`);
  for (const input of [...inputs].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  )) {
    hasher.update(`${input.file}\n${input.content.length}\n${input.content}\n`);
  }
  return hasher.digest("hex");
}
// END_BLOCK_KEY_COMPUTATION

// START_BLOCK_CACHE_FACTORY
/**
 * Create a lint cache. The disk layer is loaded tolerantly: a missing or
 * corrupt cache file starts an empty cache rather than failing the lint run.
 */
export async function createSpecLintCache(
  options: SpecLintCacheOptions = {},
): Promise<SpecLintCache> {
  const cacheRoot = options.cacheRoot ?? join(getCacheHome(), SPEC_LINT_CACHE_DIR_NAME);
  const cacheFilePath = join(cacheRoot, SPEC_LINT_CACHE_FILE_NAME);
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const bypass = options.bypass ?? false;
  const memory = new Map<string, CacheFileEntry>();
  let diskLoaded = bypass; // when bypassing, the disk layer is never read or written
  let disk: CacheFile = { version: LINT_VERSION, entries: {} };
  let dirty = false;

  const loadDisk = async (): Promise<void> => {
    if (diskLoaded) return;
    diskLoaded = true;
    try {
      const raw = await readFile(cacheFilePath, "utf8");
      const parsed = JSON.parse(raw) as CacheFile;
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.version === LINT_VERSION &&
        parsed.entries &&
        typeof parsed.entries === "object"
      ) {
        disk = { version: LINT_VERSION, entries: parsed.entries };
      }
    } catch {
      // Missing or corrupt cache: start empty, never fail the lint run.
      disk = { version: LINT_VERSION, entries: {} };
    }
  };

  const persistDisk = async (): Promise<void> => {
    if (bypass || !dirty) return;
    const entries = Object.entries(disk.entries)
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, maxEntries);
    disk.entries = Object.fromEntries(entries);
    await mkdir(dirname(cacheFilePath), { recursive: true });
    await writeFile(cacheFilePath, `${JSON.stringify(disk, null, 2)}\n`, "utf8");
    dirty = false;
  };

  return {
    cacheFilePath,
    async lint(inputs, lintOptions) {
      const key = computeSpecLintCacheKey(inputs);
      if (!bypass) {
        const memo = memory.get(key);
        if (memo) return { verdicts: memo.verdicts, hit: true };
        await loadDisk();
        const fromDisk = disk.entries[key];
        if (fromDisk) {
          memory.set(key, fromDisk);
          return { verdicts: fromDisk.verdicts, hit: true };
        }
      }
      const verdicts = lintSpecArtifacts(inputs, lintOptions);
      if (!bypass) {
        const entry: CacheFileEntry = {
          savedAt: Date.now(),
          inputs: inputs.map((i) => i.file),
          verdicts,
        };
        memory.set(key, entry);
        await loadDisk();
        disk.entries[key] = entry;
        dirty = true;
        await persistDisk();
      }
      return { verdicts, hit: false };
    },
    async clear() {
      memory.clear();
      if (!bypass) {
        await loadDisk();
        disk = { version: LINT_VERSION, entries: {} };
        dirty = true;
        await persistDisk();
      }
      await rm(cacheFilePath, { force: true });
    },
  };
}
// END_BLOCK_CACHE_FACTORY
