// FILE: src/runtime/session-settings.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Own the session-owned family settings record stored in native session metadata: the narrow resolved record format, strict decode, birth from the effective configuration, family-root lineage resolution, read-modify-write metadata merging, the projected consumer view with live credentials, and the one-shot legacy-binding migration.
//   SCOPE: Pure record/projection/lineage helpers plus the file-backed legacy bindings reader and migration converter. Family settings are resolved values only (roles, orchestration profile, plugin toggle booleans, optional preset name) and never carry credential values. No host session access of its own: callers supply session reads and metadata writes, so this module never talks to the host client and never persists anything except through injected write callbacks.
//   DEPENDS: [node:crypto, node:fs/promises, node:path, src/lib/orchestration.ts, src/lib/plugin-toggle-config.ts, src/lib/vvoc-config.ts, src/lib/vvoc-paths.ts, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SESSION_SETTINGS_METADATA_KEY - Native session metadata key holding the family settings record.
//   FAMILY_SETTINGS_VERSION - Record schema version this module reads and writes.
//   MAX_LINEAGE_HOPS - Bound on host-verified parent/fork lineage traversal.
//   INTERNAL_PRIMARY_AGENTS - Host-internal primary agents whose work never births family settings.
//   FamilySettings - Narrow resolved settings record persisted on a family root.
//   FamilySettingsView - Consumer-facing resolution: settings plus projected config and role models.
//   FamilySettingsSource - Whether a resolution came from root metadata or the live configuration.
//   SessionLineageError - Lineage could not be resolved safely, so no settings were resolved.
//   decodeFamilySettings - Strictly decode an unknown metadata value into a settings record.
//   settingsFromConfig - Resolve the current effective configuration into a settings record.
//   projectFamilyConfig - Project settings over the live configuration for consumers.
//   settingsId - Deterministic short content identity of a settings record.
//   readSettingsFromMetadata - Read and decode the settings record from one metadata map.
//   mergeSettingsIntoMetadata - Copy a metadata map and set only the settings key (RMW merge).
//   resolveSessionFamily - Resolve a session's family root through host-verified lineage.
//   isFamilyRootView - True when a session view is a birthable family root.
//   FamilySettingsService - Narrow settings resolution service consumed by native plugins.
//   SessionSettingsClient - Structural client seam for out-of-process settings changes.
//   resolveFamilyRootViaClient - Walk a session's lineage to its family root through the client seam.
//   updateFamilySettingsViaClient - Read-modify-write the settings key of one family root through the client seam.
//   LegacyFamilyBinding - One legacy family-binding pointer read from the bindings scope.
//   LegacyBindingsReader - Injectable reader over the legacy bindings and snapshot directories.
//   MigrationOutcome - Bounded migration summary for one scope.
//   migrateFamilyBindings - Convert legacy family bindings into root metadata, then prune legacy directories on full success.
//   fileLegacyBindingsReader - Default file-backed legacy reader plus its directory pruning.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SESSION-OWNED-SETTINGS T-001 - Added the session-owned family settings record, lineage resolver, RMW metadata merge, projected consumer view, and the one-shot legacy-binding migration.]
// END_CHANGE_SUMMARY

import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createOrchestrationConfig,
  parseOrchestrationProfile,
  type OrchestrationProfile,
} from "../lib/orchestration.js";
import { isPluginEnabled, PLUGIN_TOGGLE_NAMES } from "../lib/plugin-toggle-config.js";
import type { VvocConfig } from "../lib/vvoc-config.js";
import { getGlobalVvocDataDir } from "../lib/vvoc-paths.js";
import type { NativeSessionView } from "./types.js";

/** Native session metadata key holding the family settings record. */
export const SESSION_SETTINGS_METADATA_KEY = "vvoc:settings";

/** Record schema version this module reads and writes. */
export const FAMILY_SETTINGS_VERSION = 1 as const;

/** Bound on host-verified parent/fork lineage traversal. */
export const MAX_LINEAGE_HOPS = 64;

/**
 * Host-internal primary agents whose sessions exist only to serve host
 * housekeeping. Their context work never births or resolves family settings;
 * they are never family members with their own behavior.
 */
export const INTERNAL_PRIMARY_AGENTS: ReadonlySet<string> = new Set([
  "title",
  "summary",
  "compaction",
]);

/** Narrow resolved settings record persisted on a family root session. */
export interface FamilySettings {
  readonly version: typeof FAMILY_SETTINGS_VERSION;
  /** Name of the preset explicitly applied to this family, when one was. */
  readonly preset?: string | undefined;
  /** Resolved role-id to canonical model-selection strings. */
  readonly roles: Readonly<Record<string, string>>;
  /** Resolved orchestration profile name. */
  readonly profile: OrchestrationProfile;
  /** Resolved plugin toggle booleans for the vvoc-managed plugin names. */
  readonly plugins: Readonly<Record<string, boolean>>;
}

/** Whether a resolution came from root metadata or fell back to the live configuration. */
export type FamilySettingsSource = "metadata" | "config";

/** Consumer-facing resolution for one session's family. */
export interface FamilySettingsView {
  /** Family root session id; also the metadata holder. */
  readonly familyId: string;
  /** Directory of the family root session. */
  readonly locationDirectory: string | undefined;
  /** Native model of the family root session, when known. */
  readonly rootModel?: import("./types.js").ModelSelection | undefined;
  /** The resolved narrow settings record. */
  readonly settings: FamilySettings;
  /** Family settings projected over the live effective configuration (credentials only from live). */
  readonly vvoc: VvocConfig;
  /** Concrete selections parsed from the settings roles. */
  readonly roleModels: Readonly<Record<string, import("./types.js").ModelSelection>>;
  /** Where the settings came from. */
  readonly source: FamilySettingsSource;
  /** Deterministic short content identity of the settings record. */
  readonly settingsId: string;
}

/** Lineage could not be resolved safely, so no settings were resolved. */
export class SessionLineageError extends Error {
  readonly code = "SESSION_LINEAGE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SessionLineageError";
  }
}

// START_BLOCK_RECORD_CODEC
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRoleMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0 || typeof entry !== "string" || entry.trim().length === 0) return false;
  }
  return true;
}

function isToggleMap(value: unknown): value is Record<string, boolean> {
  if (!isRecord(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0 || typeof entry !== "boolean") return false;
  }
  return true;
}

/**
 * Strictly decode an unknown metadata value into a settings record. Any shape
 * mismatch, unknown version, or invalid profile yields undefined so callers can
 * fail soft to the live configuration; the reason is returned for bounded
 * diagnostics.
 */
export function decodeFamilySettings(value: unknown):
  | { readonly settings: FamilySettings; readonly error?: undefined }
  | {
      readonly settings?: undefined;
      readonly error: string;
    } {
  if (!isRecord(value)) return { error: "settings record is not an object" };
  if (value.version !== FAMILY_SETTINGS_VERSION) {
    return { error: `unsupported settings version ${String(value.version)}` };
  }
  if (!isRoleMap(value.roles)) return { error: "roles are not a nonempty-string map" };
  if (!isToggleMap(value.plugins)) return { error: "plugins are not a boolean map" };
  let profile: OrchestrationProfile;
  try {
    profile = parseOrchestrationProfile(value.profile, "decode family settings");
  } catch {
    return { error: `unknown orchestration profile ${String(value.profile)}` };
  }
  const preset = value.preset;
  if (preset !== undefined && (typeof preset !== "string" || preset.trim().length === 0)) {
    return { error: "preset is present but not a nonempty string" };
  }
  return {
    settings: {
      version: FAMILY_SETTINGS_VERSION,
      roles: { ...value.roles },
      profile,
      plugins: { ...value.plugins },
      ...(preset === undefined ? {} : { preset: preset.trim() }),
    },
  };
}

/** Resolve the current effective configuration into a settings record. */
export function settingsFromConfig(config: VvocConfig): FamilySettings {
  return {
    version: FAMILY_SETTINGS_VERSION,
    roles: { ...config.roles },
    profile: createOrchestrationConfig(config.orchestration).profile,
    plugins: Object.fromEntries(
      PLUGIN_TOGGLE_NAMES.map((name) => [name, isPluginEnabled(config, name)]),
    ),
  };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = sortJson(record[key]);
  return sorted;
}

/** Deterministic short content identity of a settings record. */
export function settingsId(settings: FamilySettings): string {
  return createHash("sha256")
    .update(JSON.stringify(sortJson(settings)))
    .digest("hex")
    .slice(0, 16);
}

/** Read and decode the settings record from one metadata map. */
export function readSettingsFromMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): { readonly settings: FamilySettings } | { readonly error: string } | undefined {
  if (metadata === undefined) return undefined;
  const raw = metadata[SESSION_SETTINGS_METADATA_KEY];
  if (raw === undefined) return undefined;
  const decoded = decodeFamilySettings(raw);
  return decoded.error === undefined ? { settings: decoded.settings } : { error: decoded.error };
}

/**
 * Copy a metadata map and set only the settings key, leaving every foreign key
 * untouched. This is the merge half of every read-modify-write: callers read
 * the host's full metadata map, merge through here, and write the result back
 * because the native write replaces the whole map.
 */
export function mergeSettingsIntoMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  settings: FamilySettings,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...metadata };
  merged[SESSION_SETTINGS_METADATA_KEY] = settings;
  return merged;
}
// END_BLOCK_RECORD_CODEC

// START_BLOCK_PROJECTION
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project family settings over the live effective configuration for plugin
 * consumers. The live document is deep-cloned and only the family-governed
 * fields are overridden: roles, orchestration profile, and plugin toggle
 * booleans. Detail inside object-valued plugin entries (schedules, modes,
 * budgets) and every credential keep coming from the live configuration.
 */
export function projectFamilyConfig(settings: FamilySettings, live: VvocConfig): VvocConfig {
  const projected = structuredClone(live);
  projected.roles = { ...settings.roles };
  projected.orchestration = { profile: settings.profile };
  const livePlugins = isPlainRecord(projected.plugins) ? { ...projected.plugins } : {};
  for (const [name, enabled] of Object.entries(settings.plugins)) {
    const liveEntry = livePlugins[name];
    if (enabled === false) {
      livePlugins[name] = false;
      continue;
    }
    // Resolved enabled wins over a later live disable while preserving live detail.
    if (liveEntry === undefined || typeof liveEntry === "boolean") {
      livePlugins[name] = true;
    } else if (isPlainRecord(liveEntry)) {
      livePlugins[name] = { ...liveEntry, enabled: true };
    }
  }
  projected.plugins = livePlugins as VvocConfig["plugins"];
  return projected;
}
// END_BLOCK_PROJECTION

// START_BLOCK_LINEAGE_RESOLUTION
/** Resolve a session's family root through host-verified lineage. */
export async function resolveSessionFamily(input: {
  readonly sessionID: string;
  readSession(sessionID: string): Promise<NativeSessionView | undefined>;
}): Promise<string> {
  const seen = new Set<string>();
  let current = input.sessionID;
  for (let hop = 0; hop < MAX_LINEAGE_HOPS; hop += 1) {
    if (seen.has(current)) {
      throw new SessionLineageError("Session lineage contains a cycle; refusing to resolve.");
    }
    seen.add(current);
    const view = await input.readSession(current);
    if (view === undefined) {
      throw new SessionLineageError(`Session ${current} could not be read from the host.`);
    }
    const parent =
      typeof view.parentID === "string" && view.parentID.length > 0
        ? view.parentID
        : typeof view.forkSessionID === "string" && view.forkSessionID.length > 0
          ? view.forkSessionID
          : undefined;
    if (parent === undefined) return current;
    current = parent;
  }
  throw new SessionLineageError("Session lineage exceeds the supported depth.");
}

/**
 * True when a session view is a birthable family root: no parent, no fork
 * source, and not a host-internal primary agent session.
 */
export function isFamilyRootView(view: NativeSessionView): boolean {
  const hasParent =
    (view.parentID !== undefined && view.parentID.length > 0) ||
    (view.forkSessionID !== undefined && view.forkSessionID.length > 0);
  if (hasParent) return false;
  return !(view.agent !== undefined && INTERNAL_PRIMARY_AGENTS.has(view.agent));
}
// END_BLOCK_LINEAGE_RESOLUTION

/**
 * Narrow settings resolution service consumed by native plugins. Resolution is
 * fail-soft: a session whose lineage cannot be resolved yields undefined
 * instead of failing the caller's request path.
 */
export interface FamilySettingsService {
  /** Family root session id for a session (host-verified lineage). */
  familyOf(sessionID: string): Promise<string>;
  /** Resolve settings for a session's family, birthing root records lazily. */
  resolve(sessionID: string): Promise<FamilySettingsView | undefined>;
  /** Consumer-facing alias of {@link resolve}. */
  configFor(sessionID: string): Promise<FamilySettingsView | undefined>;
  /** Release service-owned caches; never stops the host. */
  dispose(): void;
}

// START_BLOCK_CLIENT_UPDATE
/**
 * Structural client seam for out-of-process settings changes (CLI and TUI).
 * The real authenticated `OpenCodeClient` satisfies it; results are decoded at
 * the checked boundary because the generated parameter types are not faithful
 * wire shapes.
 */
export interface SessionSettingsClient {
  readonly session: {
    get(input: { readonly sessionID: string }): Promise<unknown>;
    update(input: {
      readonly sessionID: string;
      readonly title?: string | undefined;
      readonly metadata?: unknown;
    }): Promise<unknown>;
  };
}

function decodeClientSession(value: unknown): NativeSessionView | undefined {
  if (!isRecord(value)) return undefined;
  const data = isRecord(value.data) ? value.data : value;
  const id = data.id;
  if (typeof id !== "string" || id.length === 0) return undefined;
  const parentID = typeof data.parentID === "string" ? data.parentID : undefined;
  const forkRaw = data.fork;
  const forkSessionID =
    typeof data.forkSessionID === "string"
      ? data.forkSessionID
      : isRecord(forkRaw) && typeof forkRaw.sessionID === "string"
        ? forkRaw.sessionID
        : undefined;
  const modelRaw = data.model;
  const model =
    isRecord(modelRaw) && typeof modelRaw.id === "string" && typeof modelRaw.providerID === "string"
      ? {
          providerID: modelRaw.providerID,
          modelID: modelRaw.id,
          ...(typeof modelRaw.variant === "string" ? { variant: modelRaw.variant } : {}),
        }
      : undefined;
  const agent = typeof data.agent === "string" ? data.agent : undefined;
  const metadata = isRecord(data.metadata) ? data.metadata : undefined;
  return {
    id,
    ...(parentID === undefined ? {} : { parentID }),
    ...(forkSessionID === undefined ? {} : { forkSessionID }),
    ...(agent === undefined ? {} : { agent }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(model === undefined ? {} : { model }),
  };
}

/**
 * Walk a session's lineage to its family root through the client seam. The
 * walk mirrors the runtime resolver: parentID first, then fork source, with
 * the same cycle and depth guards.
 */
export async function resolveFamilyRootViaClient(
  client: SessionSettingsClient,
  sessionID: string,
): Promise<NativeSessionView> {
  const seen = new Set<string>();
  let current = sessionID;
  let view: NativeSessionView | undefined;
  for (let hop = 0; hop < MAX_LINEAGE_HOPS; hop += 1) {
    if (seen.has(current)) {
      throw new SessionLineageError("Session lineage contains a cycle; refusing to update.");
    }
    seen.add(current);
    view = decodeClientSession(await client.session.get({ sessionID: current }));
    if (view === undefined) {
      throw new SessionLineageError(`Session ${current} could not be read from the host.`);
    }
    const parent =
      typeof view.parentID === "string" && view.parentID.length > 0
        ? view.parentID
        : typeof view.forkSessionID === "string" && view.forkSessionID.length > 0
          ? view.forkSessionID
          : undefined;
    if (parent === undefined) return view;
    current = parent;
  }
  throw new SessionLineageError("Session lineage exceeds the supported depth.");
}

/**
 * Read-modify-write the settings key of one session's family root through the
 * client seam. The full metadata map is re-read immediately before the write
 * and merged through {@link mergeSettingsIntoMetadata}, so foreign keys survive
 * and only the named family's root is touched. `apply` receives the root's
 * current settings (or undefined) and returns the next record.
 */
export async function updateFamilySettingsViaClient(input: {
  readonly client: SessionSettingsClient;
  readonly sessionID: string;
  apply(current: FamilySettings | undefined): FamilySettings | Promise<FamilySettings>;
}): Promise<{ readonly rootID: string; readonly settings: FamilySettings }> {
  const root = await resolveFamilyRootViaClient(input.client, input.sessionID);
  const current = readSettingsFromMetadata(root.metadata);
  if (current !== undefined && "error" in current) {
    throw new Error(`Family settings for ${root.id} are invalid: ${current.error}`);
  }
  const next = await input.apply(current === undefined ? undefined : current.settings);
  const updated = decodeClientSession(await input.client.session.get({ sessionID: root.id }));
  const metadata = mergeSettingsIntoMetadata(updated?.metadata, next);
  await input.client.session.update({ sessionID: root.id, metadata });
  return { rootID: root.id, settings: next };
}
// END_BLOCK_CLIENT_UPDATE

// START_BLOCK_MIGRATION
/** One legacy family-binding pointer read from a bindings scope. */
export interface LegacyFamilyBinding {
  readonly familyId: string;
  readonly snapshotHash: string;
}

/**
 * Injectable reader over the legacy bindings and content-addressed snapshot
 * directories. The default implementation reads the project-scoped directories
 * under the global vvoc data dir.
 */
export interface LegacyBindingsReader {
  listFamilies(): Promise<readonly LegacyFamilyBinding[]>;
  /** Decoded legacy behaviour-projection snapshot, or undefined when unreadable. */
  readSnapshot(hash: string): Promise<unknown>;
}

/** Bounded migration summary for one scope. */
export interface MigrationOutcome {
  /** Families whose settings were written into live root metadata. */
  readonly converted: readonly string[];
  /** Families with nothing convertible (dead root, unreadable or invalid snapshot). */
  readonly skipped: readonly string[];
  /** Families whose metadata write failed; legacy directories are kept for retry. */
  readonly failed: readonly string[];
  /** Whether the legacy directories were removed after a fully successful pass. */
  readonly pruned: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Convert legacy family bindings into root metadata and prune the legacy
 * directories only after every convertible family was written. Dead roots and
 * unreadable legacy snapshots are skipped (there is nothing to convert), while
 * a metadata write failure keeps the directories so the next start retries.
 * The conversion is idempotent: rewriting the same resolved settings is a
 * no-op, and a completed pass leaves no directories to migrate again.
 */
export async function migrateFamilyBindings(deps: {
  readonly reader: LegacyBindingsReader;
  readSession(sessionID: string): Promise<NativeSessionView | undefined>;
  /** Read-modify-write the settings key into the root's metadata. */
  writeSettings(sessionID: string, settings: FamilySettings): Promise<void>;
}): Promise<MigrationOutcome> {
  const converted: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  let families: readonly LegacyFamilyBinding[];
  try {
    families = await deps.reader.listFamilies();
  } catch {
    // No legacy scope readable: migration is a no-op and nothing is pruned.
    return { converted, skipped, failed, pruned: false };
  }

  for (const family of families) {
    try {
      let root: NativeSessionView | undefined;
      try {
        root = await deps.readSession(family.familyId);
      } catch {
        // A host read failure means the family root is gone: nothing to convert.
        root = undefined;
      }
      if (root === undefined || !isFamilyRootView(root)) {
        skipped.push(family.familyId);
        continue;
      }
      const snapshot = await deps.reader.readSnapshot(family.snapshotHash);
      if (!isPlainObject(snapshot) || !isPlainObject(snapshot.policy)) {
        skipped.push(family.familyId);
        continue;
      }
      await deps.writeSettings(
        family.familyId,
        settingsFromConfig(snapshot.policy as unknown as VvocConfig),
      );
      converted.push(family.familyId);
    } catch {
      failed.push(family.familyId);
    }
  }

  const pruned = failed.length === 0;
  if (pruned) await pruneLegacyDirs(deps.reader);
  return { converted, skipped, failed, pruned };
}

/** Default file-backed legacy reader plus its directory pruning. */
export function fileLegacyBindingsReader(paths: {
  readonly bindingsDir?: string | undefined;
  readonly snapshotsDir?: string | undefined;
  readonly rebindDir?: string | undefined;
  readonly scopeKey: string;
}): LegacyBindingsReader & { prune(): Promise<void> } {
  const dataDir = getGlobalVvocDataDir();
  // Scope hashing mirrors the legacy binding-store layout.
  const scope = createHash("sha256").update(paths.scopeKey).digest("hex").slice(0, 32);
  const bindingsDir = paths.bindingsDir ?? join(dataDir, "bindings", scope);
  const snapshotsDir = paths.snapshotsDir ?? join(dataDir, "snapshots", scope);
  const rebindDir = paths.rebindDir ?? join(dataDir, "rebind");

  const reader: LegacyBindingsReader & { prune(): Promise<void> } = {
    async listFamilies() {
      let names: string[];
      try {
        names = await readdir(join(bindingsDir, "families"));
      } catch {
        return [];
      }
      const families: LegacyFamilyBinding[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          const value = JSON.parse(
            await readFile(join(bindingsDir, "families", name), "utf8"),
          ) as unknown;
          if (
            isPlainObject(value) &&
            typeof value.familyId === "string" &&
            typeof value.snapshotHash === "string"
          ) {
            families.push({ familyId: value.familyId, snapshotHash: value.snapshotHash });
          }
        } catch {
          // Unreadable pointer: nothing to convert for it.
        }
      }
      return families;
    },

    async readSnapshot(hash) {
      // Legacy projections lived beside the pointers, inside the binding scope.
      try {
        return JSON.parse(await readFile(join(bindingsDir, "policies", `${hash}.json`), "utf8"));
      } catch {
        return undefined;
      }
    },

    async prune() {
      await rm(bindingsDir, { recursive: true, force: true });
      await rm(snapshotsDir, { recursive: true, force: true });
      await rm(rebindDir, { recursive: true, force: true });
    },
  };
  return reader;
}

async function pruneLegacyDirs(reader: LegacyBindingsReader): Promise<void> {
  const prunable = reader as { prune?: (() => Promise<void>) | undefined };
  if (typeof prunable.prune !== "function") return;
  await prunable.prune();
}
// END_BLOCK_MIGRATION
