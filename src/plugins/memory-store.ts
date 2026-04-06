// FILE: src/plugins/memory-store.ts
// VERSION: 0.2.5
// START_MODULE_CONTRACT
//   PURPOSE: Persist and query explicit vvoc memory entries across local and shared scopes.
//   SCOPE: Memory config loading, scope-aware storage roots, CRUD operations, lexical search, and JSON-backed filesystem helpers.
//   DEPENDS: [node:child_process, node:crypto, node:fs/promises, node:path, jsonc-parser, src/lib/vvoc-paths.ts]
//   LINKS: [M-PLUGIN-MEMORY-STORE]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MemoryScopeType - Supported write scope categories for explicit memory.
//   MemoryReadScopeType - Supported read scopes including the cross-scope `all` selector.
//   MemoryScope - Scope selector used by list/search filters.
//   MemoryEntry - Canonical persisted memory record shape.
//   MemoryRuntimeConfig - Resolved runtime config including local and shared storage roots.
//   MemoryFilters - Shared filter shape for list/search operations.
//   MemoryConfigOverrides - Parsed memory config override values.
//   loadMemoryRuntimeConfig - Loads merged global/project memory settings and storage roots.
//   parseMemoryConfigText - Parses managed memory config JSONC.
//   renderMemoryConfig - Renders managed memory config JSONC.
//   getDefaultSearchLimit - Returns the effective default limit for memory list/search operations.
//   getDefaultProjectScopeKey - Returns the canonical project scope key.
//   getDefaultSharedScopeKey - Returns the canonical shared scope fallback key.
//   normalizeReadScopeType - Normalizes list/search scope arguments including `all`.
//   normalizeWriteScopeType - Normalizes memory write scope arguments.
//   resolveBranchScopeKey - Resolves the current git branch fallback key.
//   listMemories - Lists explicit memory entries for the requested filters.
//   getMemory - Loads a single explicit memory entry by id.
//   putMemory - Persists a new explicit memory entry.
//   updateMemory - Updates a stored explicit memory entry.
//   deleteMemory - Deletes an explicit memory entry by id.
//   searchMemories - Performs ranked lexical memory search across resolved scopes.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.5 - Added GRACE runtime markup and symbol-accurate export mapping for explicit memory storage helpers.]
// END_CHANGE_SUMMARY

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import {
  getGlobalVvocDataDir,
  getGlobalVvocDir,
  getGlobalVvocProjectDataDir,
  getProjectVvocDir,
} from "../lib/vvoc-paths.js";

const MEMORY_SCOPE_TYPES = ["session", "branch", "project", "shared"] as const;
const MEMORY_SCOPE_TYPES_WITH_ALL = [...MEMORY_SCOPE_TYPES, "all"] as const;
const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_PROJECT_SCOPE_KEY = "project";
const DEFAULT_SHARED_SCOPE_KEY = "default";
const MEMORY_CONFIG_FILE_NAMES = ["memory.jsonc", "memory.json"] as const;
const SCOPE_PRIORITY: Record<MemoryScopeType, number> = {
  session: 4,
  branch: 3,
  project: 2,
  shared: 1,
};

export type MemoryScopeType = (typeof MEMORY_SCOPE_TYPES)[number];
export type MemoryReadScopeType = (typeof MEMORY_SCOPE_TYPES_WITH_ALL)[number];

export type MemoryScope = {
  scopeType: MemoryScopeType;
  scopeKey: string;
};

export type MemoryEntry = {
  id: string;
  scope_type: MemoryScopeType;
  scope_key: string;
  kind: string;
  text: string;
  tags: string[];
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type MemoryRuntimeConfig = {
  enabled: boolean;
  projectStorageRoot: string;
  sharedStorageRoot: string;
  defaultSearchLimit: number;
  sources: string[];
  warnings: string[];
};

export type MemoryFilters = {
  scopes?: MemoryScope[];
  kind?: string;
  limit?: number;
};

export type MemoryConfigOverrides = {
  enabled?: boolean;
  defaultSearchLimit?: number;
};

type MemoryRecord = {
  entry: MemoryEntry;
  filePath: string;
};

type JsonObject = Record<string, unknown>;

// START_BLOCK_LOAD_MEMORY_RUNTIME_CONFIG
export async function loadMemoryRuntimeConfig(directory: string): Promise<MemoryRuntimeConfig> {
  const sources: string[] = [];
  const warnings: string[] = [];
  const globalConfig = await loadScopedMemoryConfig(
    MEMORY_CONFIG_FILE_NAMES.map((name) => join(getGlobalVvocDir(), name)),
    sources,
    warnings,
  );
  const projectConfig = directory
    ? await loadScopedMemoryConfig(
        MEMORY_CONFIG_FILE_NAMES.map((name) => join(getProjectVvocDir(directory), name)),
        sources,
        warnings,
      )
    : {};

  return {
    enabled: projectConfig.enabled ?? globalConfig.enabled ?? true,
    projectStorageRoot: join(getGlobalVvocProjectDataDir(directory), "memory"),
    sharedStorageRoot: join(getGlobalVvocDataDir(), "memory"),
    defaultSearchLimit:
      projectConfig.defaultSearchLimit ?? globalConfig.defaultSearchLimit ?? DEFAULT_SEARCH_LIMIT,
    sources,
    warnings,
  };
}
// END_BLOCK_LOAD_MEMORY_RUNTIME_CONFIG

export function parseMemoryConfigText(text: string, label: string): MemoryConfigOverrides {
  return normalizeMemoryConfigDocument(parseMemoryConfigDocument(text, label), label);
}

// START_BLOCK_RENDER_MEMORY_CONFIG
export function renderMemoryConfig(overrides: MemoryConfigOverrides = {}): string {
  const lines = [
    "// Managed by vvoc.",
    "// `vvoc sync` rewrites files with this marker while preserving current values.",
    "// Remove this header if you want to manage the file manually.",
    "",
    "{",
    `  "enabled": ${JSON.stringify(overrides.enabled ?? true)},`,
    `  "defaultSearchLimit": ${overrides.defaultSearchLimit ?? DEFAULT_SEARCH_LIMIT}`,
    "}",
  ];

  return `${lines.join("\n")}\n`;
}
// END_BLOCK_RENDER_MEMORY_CONFIG

export function getDefaultSearchLimit(config: MemoryRuntimeConfig): number {
  return config.defaultSearchLimit;
}

export function getDefaultProjectScopeKey(): string {
  return DEFAULT_PROJECT_SCOPE_KEY;
}

export function getDefaultSharedScopeKey(): string {
  return DEFAULT_SHARED_SCOPE_KEY;
}

export function normalizeReadScopeType(value: unknown): MemoryReadScopeType | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return MEMORY_SCOPE_TYPES_WITH_ALL.includes(normalized as MemoryReadScopeType)
    ? (normalized as MemoryReadScopeType)
    : undefined;
}

export function normalizeWriteScopeType(value: unknown): MemoryScopeType | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return MEMORY_SCOPE_TYPES.includes(normalized as MemoryScopeType)
    ? (normalized as MemoryScopeType)
    : undefined;
}

export function resolveBranchScopeKey(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0) {
    return "no-git-branch";
  }

  const branch = String(result.stdout || "").trim();
  if (!branch || branch === "HEAD") {
    return "detached-head";
  }

  return branch;
}

// START_BLOCK_MEMORY_CRUD_AND_SEARCH
export async function listMemories(
  config: MemoryRuntimeConfig,
  filters: MemoryFilters = {},
): Promise<MemoryEntry[]> {
  return (await loadMemories(config, filters)).slice(0, resolveLimit(config, filters.limit));
}

export async function getMemory(
  config: MemoryRuntimeConfig,
  id: string,
): Promise<MemoryEntry | null> {
  return (await findRecordById(config, id))?.entry ?? null;
}

export async function putMemory(
  config: MemoryRuntimeConfig,
  entry: Partial<MemoryEntry> & {
    text: string;
    scope_type: MemoryScopeType;
    scope_key: string;
  },
): Promise<MemoryEntry> {
  const normalized = normalizeEntry(entry);
  if (!normalized) {
    throw new Error("Memory text is required.");
  }

  await ensureEntryDir(config, normalized);
  await writeFile(getEntryPath(config, normalized), serializeEntry(normalized), "utf8");
  return normalized;
}

export async function updateMemory(
  config: MemoryRuntimeConfig,
  id: string,
  patch: Partial<Pick<MemoryEntry, "kind" | "text" | "tags" | "meta">> = {},
): Promise<MemoryEntry | null> {
  const record = await findRecordById(config, id);
  if (!record) return null;

  const merged = normalizeEntry({
    ...record.entry,
    kind: patch.kind === undefined ? record.entry.kind : patch.kind,
    text: patch.text === undefined ? record.entry.text : patch.text,
    tags: patch.tags === undefined ? record.entry.tags : patch.tags,
    meta: patch.meta === undefined ? record.entry.meta : patch.meta,
    updated_at: new Date().toISOString(),
  });

  if (!merged) {
    throw new Error("Updated memory text is required.");
  }

  const nextPath = getEntryPath(config, merged);
  await ensureEntryDir(config, merged);
  await writeFile(nextPath, serializeEntry(merged), "utf8");

  if (nextPath !== record.filePath) {
    await rm(record.filePath, { force: true });
    await pruneEmptyDirectories(
      dirname(record.filePath),
      getPruneStopDir(config, merged.scope_type),
    );
  }

  return merged;
}

export async function deleteMemory(
  config: MemoryRuntimeConfig,
  id: string,
): Promise<MemoryEntry | null> {
  const record = await findRecordById(config, id);
  if (!record) return null;

  await rm(record.filePath, { force: true });
  await pruneEmptyDirectories(
    dirname(record.filePath),
    getPruneStopDir(config, record.entry.scope_type),
  );
  return record.entry;
}

export async function searchMemories(
  config: MemoryRuntimeConfig,
  query: string,
  filters: MemoryFilters = {},
): Promise<MemoryEntry[]> {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  const ranked = (await loadRecords(config))
    .map((record) => record.entry)
    .filter((entry) => matchesFilters(entry, filters))
    .map((entry) => ({
      entry,
      score: searchScore(entry, normalizedQuery),
    }))
    .filter((item) => item.score > 0.12)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return sortByUpdatedDesc(left.entry, right.entry);
    });

  return ranked.slice(0, resolveLimit(config, filters.limit)).map((item) => item.entry);
}
// END_BLOCK_MEMORY_CRUD_AND_SEARCH

// START_BLOCK_MEMORY_CONFIG_NORMALIZATION
function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseMemoryConfigDocument(text: string, label: string): JsonObject {
  const errors: ParseError[] = [];
  const value = parse(text, errors, {
    allowEmptyContent: false,
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;

  if (errors.length > 0) {
    throw new Error(`${label}: failed to parse JSONC (${errors.length} error(s))`);
  }
  if (!isPlainObject(value)) {
    throw new Error(`${label}: expected a top-level object`);
  }

  return value;
}

function normalizeMemoryConfigDocument(raw: unknown, label: string): MemoryConfigOverrides {
  if (!isPlainObject(raw)) {
    throw new Error(`${label}: expected a top-level object`);
  }

  const overrides: MemoryConfigOverrides = {};

  if (Object.hasOwn(raw, "enabled")) {
    if (typeof raw.enabled !== "boolean") {
      throw new Error(`${label}: expected "enabled" to be a boolean`);
    }
    overrides.enabled = raw.enabled;
  }

  if (Object.hasOwn(raw, "defaultSearchLimit")) {
    const limit = readPositiveInteger(raw.defaultSearchLimit);
    if (!limit) {
      throw new Error(`${label}: expected "defaultSearchLimit" to be a positive integer`);
    }
    overrides.defaultSearchLimit = limit;
  }

  return overrides;
}

function normalizeMemoryConfigOverrides(
  source: string,
  raw: unknown,
  warnings: string[],
): MemoryConfigOverrides {
  try {
    return normalizeMemoryConfigDocument(raw, source);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : `${source}: invalid memory config`);
    return {};
  }
}

async function loadScopedMemoryConfig(
  candidates: string[],
  sources: string[],
  warnings: string[],
): Promise<MemoryConfigOverrides> {
  for (const candidate of candidates) {
    const text = await readOptionalText(candidate);
    if (!text) continue;

    try {
      const parsed = parseMemoryConfigDocument(text, candidate);
      sources.push(candidate);
      return normalizeMemoryConfigOverrides(candidate, parsed, warnings);
    } catch (error) {
      warnings.push(
        `${candidate}: failed to parse JSONC (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  return {};
}
// END_BLOCK_MEMORY_CONFIG_NORMALIZATION

// START_BLOCK_MEMORY_ENTRY_NORMALIZATION
function normalizeScopeType(scopeType: unknown): MemoryScopeType {
  return normalizeWriteScopeType(scopeType) ?? "project";
}

function normalizeScopeKey(scopeType: MemoryScopeType, scopeKey: unknown): string {
  const raw = typeof scopeKey === "string" ? scopeKey.trim() : "";
  if (scopeType === "project") return DEFAULT_PROJECT_SCOPE_KEY;
  if (scopeType === "shared") return raw || DEFAULT_SHARED_SCOPE_KEY;
  return raw || (scopeType === "session" ? "session" : "branch");
}

function normalizeKind(kind: unknown): string {
  const normalized = typeof kind === "string" ? kind.trim().toLowerCase().replace(/\s+/g, "_") : "";
  return normalized || "semantic";
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];

  return Array.from(
    new Set(
      tags.map((tag) => (typeof tag === "string" ? tag.trim().toLowerCase() : "")).filter(Boolean),
    ),
  );
}

function normalizeMeta(meta: unknown): Record<string, unknown> {
  return isPlainObject(meta) ? meta : {};
}

function normalizeText(text: unknown): string {
  return typeof text === "string" ? text.trim() : "";
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return fallback;
}

function normalizeEntry(raw: unknown): MemoryEntry | null {
  if (!isPlainObject(raw)) return null;

  const text = normalizeText(raw.text);
  if (!text) return null;

  const now = new Date().toISOString();
  const scopeType = normalizeScopeType(raw.scope_type);
  const scopeKey = normalizeScopeKey(scopeType, raw.scope_key);
  const createdAt = normalizeTimestamp(raw.created_at, now);
  const updatedAt = normalizeTimestamp(raw.updated_at, createdAt);

  return {
    id:
      typeof raw.id === "string" && raw.id.trim()
        ? raw.id.trim()
        : `mem_${crypto.randomUUID().replace(/-/g, "")}`,
    scope_type: scopeType,
    scope_key: scopeKey,
    kind: normalizeKind(raw.kind),
    text,
    tags: normalizeTags(raw.tags),
    meta: normalizeMeta(raw.meta),
    created_at: createdAt,
    updated_at: updatedAt,
  };
}
// END_BLOCK_MEMORY_ENTRY_NORMALIZATION

// START_BLOCK_MEMORY_FILESYSTEM_LAYOUT
function serializeEntry(entry: MemoryEntry): string {
  return `${JSON.stringify(entry, null, 2)}\n`;
}

function encodeScopeSegment(value: string): string {
  return encodeURIComponent(String(value || "").trim() || "default");
}

function getScopeDir(
  config: MemoryRuntimeConfig,
  scopeType: MemoryScopeType,
  scopeKey: string,
): string {
  if (scopeType === "shared") {
    return join(config.sharedStorageRoot, "shared", encodeScopeSegment(scopeKey));
  }

  if (scopeType === "project") {
    return join(config.projectStorageRoot, "project");
  }

  return join(config.projectStorageRoot, scopeType, encodeScopeSegment(scopeKey));
}

function getEntryPath(config: MemoryRuntimeConfig, entry: MemoryEntry): string {
  return join(getScopeDir(config, entry.scope_type, entry.scope_key), `${entry.id}.json`);
}

async function walkJsonFiles(targetDir: string): Promise<string[]> {
  const files: string[] = [];

  const visit = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(absolute);
      }
    }
  };

  await visit(targetDir);
  files.sort((left, right) => left.localeCompare(right));
  return files;
}
// END_BLOCK_MEMORY_FILESYSTEM_LAYOUT

// START_BLOCK_MEMORY_RECORD_LOADING_AND_FILTERING
async function loadRecords(config: MemoryRuntimeConfig): Promise<MemoryRecord[]> {
  const files = (
    await Promise.all([
      walkJsonFiles(join(config.projectStorageRoot, "session")),
      walkJsonFiles(join(config.projectStorageRoot, "branch")),
      walkJsonFiles(join(config.projectStorageRoot, "project")),
      walkJsonFiles(join(config.sharedStorageRoot, "shared")),
    ])
  )
    .flat()
    .sort((left, right) => left.localeCompare(right));
  const records = await Promise.all(
    files.map(async (filePath) => {
      try {
        const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
        const entry = normalizeEntry(raw);
        return entry ? { entry, filePath } : null;
      } catch {
        return null;
      }
    }),
  );

  return records.filter((record): record is MemoryRecord => record !== null);
}

async function loadMemories(
  config: MemoryRuntimeConfig,
  filters: MemoryFilters = {},
): Promise<MemoryEntry[]> {
  return (await loadRecords(config))
    .map((record) => record.entry)
    .filter((entry) => matchesFilters(entry, filters))
    .sort(sortByUpdatedDesc);
}

function sortByUpdatedDesc(left: MemoryEntry, right: MemoryEntry): number {
  const updatedDelta = Date.parse(right.updated_at) - Date.parse(left.updated_at);
  if (updatedDelta !== 0) return updatedDelta;
  return left.id.localeCompare(right.id);
}

function matchesScopes(entry: MemoryEntry, scopes?: MemoryScope[]): boolean {
  if (!Array.isArray(scopes) || scopes.length === 0) return true;

  return scopes.some((scope) => {
    if (scope.scopeType !== entry.scope_type) return false;
    if (scope.scopeType === "project") return true;
    return normalizeScopeKey(scope.scopeType, scope.scopeKey) === entry.scope_key;
  });
}

function matchesFilters(entry: MemoryEntry, filters: MemoryFilters): boolean {
  if (filters.kind && normalizeKind(filters.kind) !== entry.kind) {
    return false;
  }

  return matchesScopes(entry, filters.scopes);
}
// END_BLOCK_MEMORY_RECORD_LOADING_AND_FILTERING

// START_BLOCK_MEMORY_SEARCH_SCORING
function scopeBonus(scopeType: MemoryScopeType): number {
  return SCOPE_PRIORITY[scopeType] * 0.08;
}

function recencyBonus(updatedAt: string): number {
  const ageDays = Math.max((Date.now() - Date.parse(updatedAt)) / 86_400_000, 0);
  return clamp(1 - ageDays / 30) * 0.08;
}

function tokenize(value: string): string[] {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function overlapScore(query: string, target: string): number {
  const queryTokens = tokenize(query);
  const targetTokens = new Set(tokenize(target));
  if (queryTokens.length === 0 || targetTokens.size === 0) return 0;

  let hits = 0;
  for (const token of queryTokens) {
    if (targetTokens.has(token)) {
      hits += 1;
    }
  }

  return hits / queryTokens.length;
}

function tagBonus(entry: MemoryEntry, queryTokens: string[]): number {
  if (queryTokens.length === 0 || entry.tags.length === 0) return 0;

  const tags = new Set(entry.tags.flatMap((tag) => tokenize(tag)));
  let hits = 0;
  for (const token of queryTokens) {
    if (tags.has(token)) {
      hits += 1;
    }
  }

  return Math.min(hits * 0.06, 0.18);
}

function searchScore(entry: MemoryEntry, query: string): number {
  const normalizedQuery = normalizeText(query).toLowerCase();
  if (!normalizedQuery) return 0;

  const haystack = `${entry.text} ${entry.tags.join(" ")}`;
  const lexical = overlapScore(normalizedQuery, haystack);
  const queryTokens = tokenize(normalizedQuery);
  const textTokens = tokenize(entry.text);
  const exactHits = queryTokens.filter((token) => textTokens.includes(token)).length;
  const exactPhrase = entry.text.toLowerCase().includes(normalizedQuery) ? 0.24 : 0;

  return (
    lexical * 0.58 +
    Math.min(exactHits * 0.05, 0.2) +
    tagBonus(entry, queryTokens) +
    scopeBonus(entry.scope_type) +
    recencyBonus(entry.updated_at) +
    exactPhrase
  );
}
// END_BLOCK_MEMORY_SEARCH_SCORING

// START_BLOCK_MEMORY_FS_HELPERS
async function findRecordById(
  config: MemoryRuntimeConfig,
  id: string,
): Promise<MemoryRecord | null> {
  const targetId = typeof id === "string" ? id.trim() : "";
  if (!targetId) return null;

  return (await loadRecords(config)).find((record) => record.entry.id === targetId) ?? null;
}

async function ensureEntryDir(config: MemoryRuntimeConfig, entry: MemoryEntry): Promise<void> {
  await mkdir(getScopeDir(config, entry.scope_type, entry.scope_key), { recursive: true });
}

function getPruneStopDir(config: MemoryRuntimeConfig, scopeType: MemoryScopeType): string {
  return scopeType === "shared" ? config.sharedStorageRoot : config.projectStorageRoot;
}

async function pruneEmptyDirectories(startDir: string, stopDir: string): Promise<void> {
  let current = startDir;

  while (current.startsWith(stopDir) && current !== stopDir) {
    let entries;
    try {
      entries = await readdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        break;
      }
      throw error;
    }

    if (entries.length > 0) break;
    await rm(current, { recursive: true, force: true });
    current = dirname(current);
  }
}

function resolveLimit(config: MemoryRuntimeConfig, value: unknown): number {
  const fallback = config.defaultSearchLimit;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }

  return undefined;
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
// END_BLOCK_MEMORY_FS_HELPERS
