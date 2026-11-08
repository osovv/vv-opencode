// FILE: src/runtime/context.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Acquire, share by exact plugin-context identity, and release the lifecycle-managed native runtime and the centralized native runtime (client/permissions/settings/config/model/auxiliary) consumed by every later native plugin, resolving session-owned family settings from the family root's metadata.
//   SCOPE: Context-identity reference-counted registries, per-acquisition idempotent leases, lazy authenticated-client caching, permission-service exposure, native model/agent overlay capture, default-model transform, config.updated reconfiguration, lazy family-settings birth and resolution through host-verified lineage with read-modify-write metadata writes, one-shot creation reconciliation for host-created children, session-deletion cache hygiene, cross-context coordination, the read-only context-inspection RPC, and idempotent teardown without stopping the host. No candidate staging, no dispatch guard, no family snapshot store, no service discovery until a client is requested, no location-only sharing, no global configuration singleton, and no V1 compatibility facade.
//   DEPENDS: [node:crypto, @opencode/plugin, src/lib/config-layers.ts, src/runtime/client.ts, src/runtime/coordination.ts, src/runtime/context-inspection.ts, src/runtime/model-registry.ts, src/runtime/permissions.ts, src/runtime/session-settings.ts, src/runtime/snapshot-config.ts, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   acquireRuntime - Return a per-acquisition release lease for the runtime shared by one exact plugin context.
//   NativeSessionInfoLike - Structural native session info used for lineage and provenance.
//   NativeHookEvents - Structural native hook event map used by the shared runtime.
//   NativeSnapshotContext - Narrow structural native Plugin.Context used to acquire the shared runtime.
//   NativeRegistration - Releasable native registration handle.
//   NativeForkClient - Structural full client for forks and parented imports.
//   NativeSnapshotRuntimeOptions - Optional injectable native boundaries for the shared runtime.
//   NativeSnapshotRuntime - Documented shared native runtime: client, permissions, family settings, auxiliary work, effective config, role override, refresh.
//   acquireNativeSnapshotRuntime - Acquire the shared native runtime for an actual Plugin.Context.
//   rebuildAgentBindings - Recompute agent bindings from a freshly read policy without trusting a cached vvoc-applied selection.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SESSION-OWNED-SETTINGS T-002 - Replaced the family-binding snapshot service and dispatch guard with session-owned settings: lazy root birth, lineage resolution, RMW metadata writes, one-shot creation reconciliation, and the legacy-binding migration.]
//   PREVIOUS: [Direct fix follow-up - The pump-missed user-choice capture in bindFor now ends the first-work tolerance too, keeping every explicit-choice path symmetric with the event pump so a stale window can never admit a later bare-base dispatch.]
// END_CHANGE_SUMMARY

import { randomBytes } from "node:crypto";
import type { OpenCodeClient } from "@opencode/client";
import type { Plugin } from "@opencode/plugin";
import { loadEffectiveVvocConfig, readRawOpenCodeModelIntent } from "../lib/config-layers.js";
import {
  getBuiltInRoleBindings,
  isRoleReference,
  parseModelSelectionWithVariant,
  ROLE_REFERENCE_PREFIX,
} from "../lib/model-roles.js";
import { acquireNativeClient, nativeRuntimeDeps, type NativeClientAcquisition } from "./client.js";
import { coordinateHost, type HostCoordination } from "./coordination.js";
import { applyAgentPolicies } from "./model-registry.js";
import { createPermissionService } from "./permissions.js";
import {
  canonicalModelVariant,
  decodeSessionCreatedEvent,
  effectiveRuntimeConfig,
  isConfigUpdateEvent,
  parseRoleSelections,
} from "./snapshot-config.js";
import { registerContextInspectionRpc } from "./context-inspection.js";
import {
  INTERNAL_PRIMARY_AGENTS,
  isFamilyRootView,
  mergeSettingsIntoMetadata,
  migrateFamilyBindings,
  fileLegacyBindingsReader,
  projectFamilyConfig,
  readSettingsFromMetadata,
  resolveSessionFamily,
  settingsFromConfig,
  settingsId,
  type FamilySettings,
  type FamilySettingsService,
  type FamilySettingsView,
} from "./session-settings.js";
import { createAuxiliaryService } from "./auxiliary.js";
import {
  RuntimeDisposedError,
  decodeAuxiliaryMetadata,
  decodeImportedSessionID,
  runtimeIdentity,
  type AgentEditorLike,
  type AgentPolicyBinding,
  type AuxiliaryService,
  type EffectiveRuntimeConfig,
  type ModelEditorLike,
  type ModelSelection,
  type NativeRuntime,
  type NativeSessionImportPayload,
  type PermissionService,
  type RuntimeClient,
  type RuntimeContext,
  type RuntimeDeps,
  type RuntimeEvent,
  type RuntimeIdentity,
  type RuntimeLease,
  type RuntimeLocation,
} from "./types.js";

// START_BLOCK_RUNTIME_REGISTRY
const runtimes = new Map<string, ManagedNativeRuntime<RuntimeContext, RuntimeClient>>();
const contextIds = new WeakMap<object, number>();
const depsIds = new WeakMap<object, number>();
let nextInstance = 1;

function objectId(ids: WeakMap<object, number>, value: object): number {
  const existing = ids.get(value);
  if (existing !== undefined) return existing;
  const id = nextInstance;
  nextInstance += 1;
  ids.set(value, id);
  return id;
}

/**
 * Registry key scopes sharing to one dependency instance and one exact plugin
 * context object. Same location is not the same plugin instance, so distinct
 * contexts never reuse another context's registrations; root aggregation shares
 * naturally because it passes the same context object.
 */
function registryKey(context: RuntimeContext, deps: object): string {
  return `${objectId(contextIds, context)}:${objectId(depsIds, deps)}`;
}
// END_BLOCK_RUNTIME_REGISTRY

// START_BLOCK_MANAGED_RUNTIME
class ManagedNativeRuntime<
  Context extends RuntimeContext,
  Client extends RuntimeClient,
> implements NativeRuntime<Context, Client> {
  readonly context: Context;
  readonly location: RuntimeLocation;
  readonly identity: RuntimeIdentity;
  readonly instanceId: string;
  readonly permissions: PermissionService;

  private readonly deps: RuntimeDeps<Client>;
  private readonly key: string;
  private readonly lifetime = new AbortController();
  private refs = 0;
  private disposed = false;
  private clientPromise: Promise<Client> | undefined;
  private clientHandle: NativeClientAcquisition<Client> | undefined;

  constructor(context: Context, deps: RuntimeDeps<Client>, identity: RuntimeIdentity, key: string) {
    this.context = context;
    this.location = context.location;
    this.identity = identity;
    this.instanceId = randomBytes(16).toString("hex");
    this.deps = deps;
    this.key = key;
    this.permissions = createPermissionService(() => this.client(), this.lifetime.signal);
  }

  client(): Promise<Client> {
    if (this.disposed) return Promise.reject(new RuntimeDisposedError());
    this.clientPromise ??= this.acquireClient();
    return this.clientPromise;
  }

  private async acquireClient(): Promise<Client> {
    try {
      const handle = await acquireNativeClient<Client>({
        context: this.context,
        deps: this.deps,
        instanceId: this.instanceId,
        lifetimeSignal: this.lifetime.signal,
      });
      if (this.disposed) {
        await handle.dispose();
        throw new RuntimeDisposedError();
      }
      this.clientHandle = handle;
      return handle.client;
    } catch (error) {
      this.clientPromise = undefined;
      throw error;
    }
  }

  retainRef(): void {
    if (this.disposed) throw new RuntimeDisposedError();
    this.refs += 1;
  }

  async releaseRef(): Promise<void> {
    if (this.disposed) return;
    this.refs -= 1;
    if (this.refs <= 0) await this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    runtimes.delete(this.key);
    // Abort in-flight permission waits and the challenge before releasing registrations.
    this.lifetime.abort();
    const handle = this.clientHandle;
    this.clientHandle = undefined;
    this.clientPromise = undefined;
    if (handle !== undefined) await handle.dispose();
  }
}
// END_BLOCK_MANAGED_RUNTIME

// START_BLOCK_ACQUIRE_RUNTIME
/** Return a per-acquisition release lease for the runtime shared by one exact plugin context. */
export function acquireRuntime<Context extends RuntimeContext>(
  context: Context,
): RuntimeLease<Context, OpenCodeClient>;
export function acquireRuntime<Context extends RuntimeContext, Client extends RuntimeClient>(
  context: Context,
  deps: RuntimeDeps<Client>,
): RuntimeLease<Context, Client>;
export function acquireRuntime<Context extends RuntimeContext, Client extends RuntimeClient>(
  context: Context,
  deps?: RuntimeDeps<Client>,
): RuntimeLease<Context, Client> {
  // The no-dependency overload pins Client to the full native client; the cast bridges only that default.
  const resolvedDeps = (deps ?? nativeRuntimeDeps) as RuntimeDeps<Client>;
  const key = registryKey(context, resolvedDeps);

  let existing = runtimes.get(key);
  if (existing === undefined) {
    existing = new ManagedNativeRuntime(
      context,
      resolvedDeps,
      runtimeIdentity(context.location),
      key,
    ) as unknown as ManagedNativeRuntime<RuntimeContext, RuntimeClient>;
    runtimes.set(key, existing);
  }
  const runtime = existing;
  runtime.retainRef();

  let released = false;
  const lease: RuntimeLease<Context, Client> = {
    // Same key implies the same context object and dependency instance, so the stored runtime matches the requested client type.
    runtime: runtime as unknown as NativeRuntime<Context, Client>,
    release: async () => {
      if (released) return;
      released = true;
      await runtime.releaseRef();
    },
  };
  return lease;
}
// END_BLOCK_ACQUIRE_RUNTIME

// START_BLOCK_NATIVE_RUNTIME
/** Structural native session info used for lineage and provenance. */
export interface NativeSessionInfoLike {
  readonly id: string;
  readonly parentID?: unknown;
  readonly fork?: { readonly sessionID: unknown } | undefined;
  readonly projectID?: unknown;
  readonly location?: { readonly directory: unknown } | undefined;
  readonly model?:
    | { readonly id: unknown; readonly providerID: unknown; readonly variant?: unknown }
    | undefined;
  readonly agent?: unknown;
  /** Host-persisted metadata; auxiliary children record their intended role here. */
  readonly metadata?: unknown;
  readonly time?: { readonly idle?: number | undefined } | undefined;
  readonly tokens?:
    | { readonly input?: number | undefined; readonly output?: number | undefined }
    | undefined;
}

/** Structural native hook events used by the shared runtime. */
export interface NativeHookEvents {
  context: { readonly sessionID: string; readonly agent?: string | undefined };
  title: { readonly sessionID: string; result?: string | undefined; messages?: unknown };
}

/**
 * Narrow structural native `Plugin.Context` used to acquire the shared
 * runtime. A real `Plugin.Context` satisfies it, so the runtime is keyed by the
 * actual context object and later plugins share one instance.
 */
export interface NativeSnapshotContext extends RuntimeContext {
  readonly agent: {
    transform(callback: (editor: AgentEditorLike) => void): Promise<NativeRegistration>;
    reload(): Promise<void>;
  };
  readonly model: {
    transform(callback: (editor: ModelEditorLike) => void): Promise<NativeRegistration>;
    reload(): Promise<void>;
  };
  readonly session: {
    get(input: { readonly sessionID: string }): Promise<NativeSessionInfoLike>;
    switchModel(input: {
      readonly sessionID: string;
      readonly model: {
        readonly id: string;
        readonly providerID: string;
        readonly variant?: string;
      };
    }): Promise<void>;
    /**
     * Host-persisted session update. Metadata is REPLACE of the whole map, so
     * callers must merge through the settings read-modify-write helper.
     */
    update(input: {
      readonly sessionID: string;
      readonly title?: string | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    }): Promise<void>;
    generate(input: {
      readonly sessionID: string;
      readonly prompt: string;
    }): Promise<{ readonly text: string }>;
    hook<Name extends keyof NativeHookEvents>(
      name: Name,
      callback: (event: NativeHookEvents[Name]) => void | Promise<void>,
    ): Promise<NativeRegistration>;
  };
  readonly event: {
    subscribe(options?: { readonly signal?: AbortSignal | undefined }): AsyncIterable<RuntimeEvent>;
  };
  /**
   * Native registered-tool domain, when the host exposes one. The read-only
   * context-inspection RPC uses `list()` to snapshot the registered catalog; it
   * never executes a tool. Optional so a context without a tool domain still
   * acquires a runtime and reports its catalog as unavailable.
   */
  readonly tool?: { list(): Promise<readonly unknown[]> } | undefined;
}

/** Releasable native registration. */
export interface NativeRegistration {
  dispose(): Promise<void> | void;
}

// Compile-time proof the pinned native Plugin.Context satisfies this seam.
type PluginContextSatisfiesNativeSnapshotContext = Plugin.Context extends NativeSnapshotContext
  ? true
  : never;
const pluginContextSeam: PluginContextSatisfiesNativeSnapshotContext = true;
void pluginContextSeam;

/**
 * Structural full client needed for real native auxiliary/family work: forked
 * children, imported parented children, and durable session-log reconciliation.
 * The `import`/`log` parameters are intentionally `unknown` so the real
 * authenticated `OpenCodeClient` (whose generated parameter types are not a
 * faithful wire shape) satisfies this seam without a cast; callers pass a typed
 * payload and decode the `unknown` result at the checked boundary.
 */
export interface NativeForkClient extends RuntimeClient {
  readonly session: {
    fork(input: { readonly sessionID: string }): Promise<{ readonly id: string }>;
    /** Import a parented session; returns the created native session info. */
    import(input: unknown, options?: unknown): Promise<unknown>;
    /** Durable per-session event log ending in a `log.synced` marker. */
    log(input: unknown, options?: unknown): AsyncIterable<unknown>;
  };
}

/** Optional injectable native boundaries for the shared runtime (tests only). */
export interface NativeSnapshotRuntimeOptions<Client extends NativeForkClient = OpenCodeClient> {
  readonly runtimeDeps?: RuntimeDeps<Client> | undefined;
  readonly now?: (() => number) | undefined;
}

/** Documented shared native runtime consumed by every later plugin. */
export interface NativeSnapshotRuntime<Client extends NativeForkClient = OpenCodeClient> {
  /** Native runtime with lazy authenticated full client and resource permissions. */
  readonly runtime: NativeRuntime<NativeSnapshotContext, Client>;
  /** Session-owned family settings service (lazy birth, lineage resolution, projections). */
  readonly settings: FamilySettingsService;
  /** Family-settings-bound auxiliary generation (titles, compaction, Guardian). */
  readonly auxiliary: AuxiliaryService;
  /** Lazily authenticated same-instance full native client (genuine OpenCodeClient by default). */
  client(): Promise<Client>;
  /** Resource permission service bound to this runtime's client. */
  readonly permissions: PermissionService;
  /** Current effective vvoc configuration (live, never family-frozen). */
  effectiveConfig(): EffectiveRuntimeConfig;
  /** Enable or disable role overriding for newly created sessions without affecting resolution. */
  setRoleOverride(enabled: boolean): Promise<void>;
  /** Reload native transforms after role-override or config changes. */
  refresh(): Promise<void>;
  /** Last contained runtime failure, surfaced instead of being silently swallowed. */
  lastConfigError(): string | undefined;
  /** Idempotent per-lease release; disposes shared state only for the last lease. */
  release(): Promise<void>;
}

interface NativeRuntimeEntry {
  refs: number;
  disposed: boolean;
  readonly init: Promise<NativeSnapshotRuntime<NativeForkClient>>;
  runtime?: NativeSnapshotRuntime<NativeForkClient>;
}

const nativeRuntimes = new Map<string, NativeRuntimeEntry>();

function toSelection(ref: unknown): ModelSelection | undefined {
  if (ref === undefined || ref === null) return undefined;
  if (typeof ref !== "object") return undefined;
  const record = ref as { id?: unknown; providerID?: unknown; variant?: unknown };
  if (record.id === undefined || record.providerID === undefined) return undefined;
  const variant =
    record.variant === undefined || record.variant === null ? undefined : String(record.variant);
  return {
    providerID: String(record.providerID),
    modelID: String(record.id),
    ...(variant === undefined ? {} : { variant: canonicalModelVariant(variant) }),
  };
}

function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.providerID === right.providerID &&
    left.modelID === right.modelID &&
    canonicalModelVariant(left.variant) === canonicalModelVariant(right.variant)
  );
}

function toRef(selection: ModelSelection): {
  id: string;
  providerID: string;
  variant?: string;
} {
  return {
    id: selection.modelID,
    providerID: selection.providerID,
    ...(selection.variant === undefined ? {} : { variant: selection.variant }),
  };
}

function readDefaultModel(editor: ModelEditorLike): ModelSelection | undefined {
  const ref = editor.default.get();
  return ref === undefined ? undefined : { providerID: ref.providerID, modelID: ref.modelID };
}

function toSessionView(info: NativeSessionInfoLike): import("./types.js").NativeSessionView {
  const model = toSelection(info.model);
  const parentID = info.parentID === undefined ? undefined : String(info.parentID);
  const forkSessionID = info.fork === undefined ? undefined : String(info.fork.sessionID);
  const locationDirectory =
    info.location === undefined ? undefined : String(info.location.directory);
  const agent = info.agent === undefined ? undefined : String(info.agent);
  const metadata = isRecord(info.metadata) ? info.metadata : undefined;
  const hasActivity =
    info.time?.idle !== undefined ||
    (info.tokens !== undefined && (info.tokens.input ?? 0) + (info.tokens.output ?? 0) > 0);
  return {
    id: info.id,
    ...(parentID === undefined ? {} : { parentID }),
    ...(forkSessionID === undefined ? {} : { forkSessionID }),
    ...(locationDirectory === undefined ? {} : { locationDirectory }),
    ...(agent === undefined ? {} : { agent }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(model === undefined ? {} : { model }),
    ...(hasActivity ? { hasActivity: true } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const PUMP_ERROR_MAX_CHARS = 500;
const PLACEHOLDER_TOKEN_RE = /__VVOC_SECRET_[A-Z_]+_[0-9a-f]{12}(?:_\d+)?__/g;

/**
 * Bounded, credential-safe diagnostic for one contained event-pump failure. The
 * raw thrown value is never stored verbatim: placeholder tokens are redacted and
 * the result is capped so an error carrying configuration text cannot leak or
 * grow without bound.
 */
function describePumpError(error: unknown): string {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : "unknown error";
  const redacted = raw.replace(PLACEHOLDER_TOKEN_RE, "[redacted]");
  return redacted.length > PUMP_ERROR_MAX_CHARS
    ? `${redacted.slice(0, PUMP_ERROR_MAX_CHARS)}…`
    : redacted;
}

function extractTitleMessages(messages: unknown): ReadonlyArray<{ role: string; text: string }> {
  const extracted: Array<{ role: string; text: string }> = [];
  if (!Array.isArray(messages)) return extracted;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = typeof message.role === "string" ? message.role : "unknown";
    const text = extractMessageText(message.content);
    if (text.length > 0) extracted.push({ role, text });
  }
  return extracted;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    if (typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

/** Resolve one raw OpenCode model string (role reference or literal) to a selection. */
function resolveRawIntent(
  raw: string,
  roleModels: Readonly<Record<string, ModelSelection>>,
): { role?: string; selection?: ModelSelection } {
  const trimmed = raw.trim();
  if (isRoleReference(trimmed)) {
    const role = trimmed.slice(ROLE_REFERENCE_PREFIX.length);
    const selection = roleModels[role];
    return { role, ...(selection === undefined ? {} : { selection }) };
  }
  try {
    const parsed = parseModelSelectionWithVariant(trimmed);
    return {
      selection: {
        providerID: parsed.provider,
        modelID: parsed.model,
        ...(parsed.variant === undefined ? {} : { variant: parsed.variant }),
      },
    };
  } catch {
    return {};
  }
}

function captureAgentBindings(
  editor: AgentEditorLike,
  config: EffectiveRuntimeConfig,
): AgentPolicyBinding[] {
  const roleModels = parseRoleSelections(config.roles);
  const rawAgents = config.rawIntent?.agents ?? {};
  const bindings = new Map<string, AgentPolicyBinding>();

  const record = (
    agentID: string,
    role: string | undefined,
    selection: ModelSelection | undefined,
  ): void => {
    bindings.set(agentID, {
      agentID,
      ...(role === undefined ? {} : { role }),
      ...(selection === undefined ? {} : { selection }),
    });
  };

  for (const agent of editor.list()) {
    const agentID = String(agent.id);
    const role = config.agentRoles[agentID];
    const literal = toSelection(agent.model);
    const selection = literal ?? (role === undefined ? undefined : roleModels[role]);
    record(agentID, role, selection);
  }
  // Raw OpenCode intent survives host normalization and overrides the native view.
  for (const [agentID, raw] of Object.entries(rawAgents)) {
    const resolved = resolveRawIntent(raw, roleModels);
    const native = bindings.get(agentID);
    record(agentID, resolved.role ?? native?.role, resolved.selection ?? native?.selection);
  }
  return [...bindings.values()];
}

/**
 * Recompute agent bindings from a freshly read config without trusting a cached
 * selection that vvoc itself may have applied under a previous role set. A
 * vvoc-role-managed agent's selection is recomputed from the current role model,
 * raw OpenCode intent still wins, and an agent with no role keeps its genuine
 * native literal. This is what makes `vvoc.json` role changes take effect for
 * newly created sessions even when the host emits no `config.updated`.
 */
export function rebuildAgentBindings(
  cached: ReadonlyArray<AgentPolicyBinding>,
  config: EffectiveRuntimeConfig,
): AgentPolicyBinding[] {
  const roleModels = parseRoleSelections(config.roles);
  const rawAgents = config.rawIntent?.agents ?? {};
  const byAgent = new Map<string, AgentPolicyBinding>();
  for (const binding of cached) byAgent.set(binding.agentID, binding);
  for (const agentID of Object.keys(config.agentRoles)) {
    if (!byAgent.has(agentID)) byAgent.set(agentID, { agentID });
  }
  const result = new Map<string, AgentPolicyBinding>();
  for (const [agentID, binding] of byAgent) {
    const role = config.agentRoles[agentID] ?? binding.role;
    const roleSelection = role === undefined ? undefined : roleModels[role];
    // A role-managed agent's authority is the current role model; the cached
    // selection may already carry a vvoc-applied model from an older role set.
    const selection = roleSelection ?? binding.selection;
    result.set(agentID, {
      agentID,
      ...(role === undefined ? {} : { role }),
      ...(selection === undefined ? {} : { selection }),
    });
  }
  for (const [agentID, raw] of Object.entries(rawAgents)) {
    const resolved = resolveRawIntent(raw, roleModels);
    const native = result.get(agentID) ?? byAgent.get(agentID);
    const role = resolved.role ?? native?.role;
    const selection = resolved.selection ?? native?.selection;
    result.set(agentID, {
      agentID,
      ...(role === undefined ? {} : { role }),
      ...(selection === undefined ? {} : { selection }),
    });
  }
  return [...result.values()];
}
// END_BLOCK_NATIVE_RUNTIME

// START_BLOCK_RUNTIME_INITIALIZATION
function initializeNativeSnapshotRuntime<Client extends NativeForkClient>(
  ctx: NativeSnapshotContext,
  options: NativeSnapshotRuntimeOptions<Client> | undefined,
): Promise<NativeSnapshotRuntime<Client>> {
  return (async () => {
    const runtimeLease =
      options?.runtimeDeps === undefined
        ? (acquireRuntime(ctx) as unknown as RuntimeLease<NativeSnapshotContext, Client>)
        : acquireRuntime(ctx, options.runtimeDeps);
    const runtime = runtimeLease.runtime;
    const owned: NativeRegistration[] = [];
    const lifecycle = new AbortController();
    let runtimeReleased = false;
    const releaseRuntime = async (): Promise<void> => {
      if (runtimeReleased) return;
      runtimeReleased = true;
      lifecycle.abort();
      for (const registration of owned) await registration.dispose();
      await runtimeLease.release();
    };

    try {
      const base = effectiveRuntimeConfig(
        await loadEffectiveVvocConfig({ cwd: ctx.location.directory }),
      );
      const state: {
        config: EffectiveRuntimeConfig;
        agentBindings: AgentPolicyBinding[];
        nativeDefault: ModelSelection | undefined;
        roleOverride: boolean;
        configError: string | undefined;
      } = {
        config: base,
        agentBindings: [],
        nativeDefault: undefined,
        roleOverride: false,
        configError: undefined,
      };

      /**
       * Structural host session read used by lineage resolution, birth, and
       * migration. Returns the checked session view shape.
       */
      const readSession = async (
        sessionID: string,
      ): Promise<import("./types.js").NativeSessionView> =>
        toSessionView(await ctx.session.get({ sessionID }));

      const readConfig = async (directory: string): Promise<EffectiveRuntimeConfig> => {
        const vvoc = effectiveRuntimeConfig(await loadEffectiveVvocConfig({ cwd: directory }));
        const rawIntent = await readRawOpenCodeModelIntent(directory);
        const roleModels = parseRoleSelections(vvoc.roles);
        const rootRaw = rawIntent?.model;
        const rootResolved =
          rootRaw === undefined ? undefined : resolveRawIntent(rootRaw, roleModels).selection;
        // Bindings are recomputed from THIS read's roles + raw intent + the cached
        // genuine native literals, so a fresh vvoc role is reflected without trusting
        // a selection vvoc previously applied to the native agent entry.
        const agentBindings = rebuildAgentBindings(state.agentBindings, {
          ...vvoc,
          ...(rawIntent === undefined ? {} : { rawIntent }),
        });
        return {
          ...vvoc,
          ...(rawIntent === undefined ? {} : { rawIntent }),
          ...(rootResolved === undefined ? {} : { rootDefault: rootResolved }),
          agentBindings,
        };
      };

      // Initialize the live config with raw OpenCode intent before any transform runs.
      state.config = await readConfig(ctx.location.directory);

      /**
       * Create a real parented auxiliary child through the authenticated full
       * client's `session.import`. The child carries host-owned metadata naming
       * its intended workload role, so its selection is recoverable after restart
       * without an ephemeral in-process exemption.
       */
      const importAuxiliaryChild = async (input: {
        parentID: string;
        locationDirectory: string;
        title: string;
        kind: "title" | "compaction" | "generate";
        role?: string | undefined;
        model: ModelSelection;
        agent?: string | undefined;
      }): Promise<{ readonly sessionID: string }> => {
        const client = await runtime.client();
        const parent = await ctx.session.get({ sessionID: input.parentID });
        const projectID = parent.projectID === undefined ? "" : String(parent.projectID);
        if (projectID.length === 0) {
          throw new Error("Auxiliary child import requires the parent session project id.");
        }
        const sessionID = `ses_${randomBytes(16).toString("hex")}`;
        const now = Date.now();
        const payload: NativeSessionImportPayload = {
          info: {
            id: sessionID,
            parentID: input.parentID,
            projectID,
            ...(input.agent === undefined ? {} : { agent: input.agent }),
            model: {
              id: input.model.modelID,
              providerID: input.model.providerID,
              ...(input.model.variant === undefined ? {} : { variant: input.model.variant }),
            },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: now, updated: now },
            title: input.title,
            location: { directory: input.locationDirectory },
            metadata: {
              vvocAuxiliary: {
                kind: input.kind,
                ...(input.role === undefined ? {} : { role: input.role }),
              },
            },
            // Conservative: the auxiliary child needs generation, never tools.
            permissions: [{ action: "*", resource: "*", effect: "deny" }],
          },
          messages: [],
          location: { directory: input.locationDirectory },
        };
        const imported = await client.session.import(payload);
        const importedID = decodeImportedSessionID(imported);
        if (importedID === undefined || importedID !== sessionID) {
          throw new Error("Native session import did not return the expected auxiliary child id.");
        }
        // The parent binding must be durable before the child is used.
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const view = toSessionView(await ctx.session.get({ sessionID }));
          if (view.parentID === input.parentID) return { sessionID };
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("Imported auxiliary child did not persist its parent lineage.");
      };

      // START_BLOCK_SETTINGS_SERVICE
      /**
       * Per-family RMW serialization. Distinct plugin contexts copied from one
       * host share the native app/location object identity, so their settings
       * services share one per-family lock without sharing any client,
       * registration, or disposal.
       */
      const coordination: HostCoordination | undefined = coordinateHost({
        app: ctx.app,
        location: ctx.location,
      });
      const familyLocks = new Map<string, Promise<unknown>>();
      const withFamilyLock = <T>(familyId: string, run: () => Promise<T>): Promise<T> => {
        if (coordination !== undefined) return coordination.withFamilyLock(familyId, run);
        const previous = familyLocks.get(familyId) ?? Promise.resolve();
        const next = previous.then(run, run);
        familyLocks.set(
          familyId,
          next.then(
            () => undefined,
            () => undefined,
          ),
        );
        return next;
      };

      // Lineage and birth caches: lineage is stable for a session's lifetime,
      // and the born fact is cached per process so the birth check stays one
      // read per session ever.
      const familyRoots = new Map<string, string>();
      const bornRoots = new Set<string>();
      const birthInFlight = new Map<string, Promise<FamilySettings | undefined>>();
      const reconciledChildren = new Set<string>();

      const diagnostic = (message: string): void => {
        // Messages are static and bounded: never include paths, parsed state, or credentials.
        state.configError = message.slice(0, 240);
      };

      const familyOf = async (sessionID: string): Promise<string> => {
        const cached = familyRoots.get(sessionID);
        if (cached !== undefined) return cached;
        const root = await resolveSessionFamily({ sessionID, readSession });
        familyRoots.set(sessionID, root);
        return root;
      };

      const buildView = (
        familyId: string,
        settings: FamilySettings,
        source: FamilySettingsView["source"],
        root: import("./types.js").NativeSessionView,
      ): FamilySettingsView | undefined => {
        let roleModels;
        try {
          roleModels = parseRoleSelections(settings.roles);
        } catch {
          // A corrupt role binding must not fail the request path; the live
          // configuration resolves instead, with a bounded diagnostic.
          diagnostic("Family settings roles are invalid; resolving the live configuration.");
          return undefined;
        }
        return {
          familyId,
          locationDirectory: root.locationDirectory,
          ...(root.model === undefined ? {} : { rootModel: root.model }),
          settings,
          vvoc: projectFamilyConfig(settings, state.config.vvoc),
          roleModels,
          source,
          settingsId: settingsId(settings),
        };
      };

      const fallbackView = (familyId: string): FamilySettingsView | undefined =>
        buildView(familyId, settingsFromConfig(state.config.vvoc), "config", { id: familyId });

      /**
       * Birth a root family record under the per-family lock: re-read the
       * fresh metadata, skip when another writer won the race, otherwise
       * resolve the current effective configuration and read-modify-write only
       * the settings key. The current request keeps using the in-memory value.
       */
      const birthRoot = async (familyId: string): Promise<FamilySettings | undefined> => {
        const pending = birthInFlight.get(familyId);
        if (pending !== undefined) return pending;
        const run = withFamilyLock(familyId, async () => {
          const fresh = await readSession(familyId);
          const existing = readSettingsFromMetadata(fresh.metadata);
          if (existing !== undefined && "settings" in existing) {
            bornRoots.add(familyId);
            return existing.settings;
          }
          if (existing !== undefined && "error" in existing) {
            diagnostic("Existing family settings are invalid; rebirthing from the live config.");
          }
          // The birth record must reflect the CURRENT effective configuration:
          // vvoc.json edits emit no host config.updated event, so the cached
          // config can be stale exactly when a family is born right after a
          // config change. The read is once per family and under the family
          // lock; a failed fresh read falls back to the last fully read config.
          let effective = state.config;
          try {
            effective = await readConfig(ctx.location.directory);
          } catch {
            diagnostic("Fresh config read failed at birth; using the cached effective config.");
          }
          const settings = settingsFromConfig(effective.vvoc);
          const merged = mergeSettingsIntoMetadata(fresh.metadata, settings);
          try {
            await ctx.session.update({ sessionID: familyId, metadata: merged });
            bornRoots.add(familyId);
            return settings;
          } catch (error) {
            // Fail soft: the family keeps resolving the live configuration and
            // the next request retries the birth.
            diagnostic(`Family settings birth failed: ${describePumpError(error).slice(0, 160)}`);
            return undefined;
          }
        });
        birthInFlight.set(familyId, run);
        try {
          return await run;
        } finally {
          birthInFlight.delete(familyId);
        }
      };

      const resolveSettings = async (
        sessionID: string,
      ): Promise<FamilySettingsView | undefined> => {
        let familyId: string;
        try {
          familyId = await familyOf(sessionID);
        } catch (error) {
          diagnostic(`Family resolution failed: ${describePumpError(error).slice(0, 160)}`);
          return undefined;
        }
        let root: import("./types.js").NativeSessionView;
        try {
          root = await readSession(familyId);
        } catch {
          return fallbackView(familyId);
        }
        const read = readSettingsFromMetadata(root.metadata);
        if (read !== undefined && "settings" in read) {
          bornRoots.add(familyId);
          const view = buildView(familyId, read.settings, "metadata", root);
          return view ?? fallbackView(familyId);
        }
        if (read !== undefined && "error" in read) {
          diagnostic("Family settings are invalid; resolving the live configuration.");
        }
        if (!bornRoots.has(familyId) && isFamilyRootView(root)) {
          const born = await birthRoot(familyId);
          if (born !== undefined) {
            const view = buildView(familyId, born, "metadata", root);
            return view ?? fallbackView(familyId);
          }
        }
        return fallbackView(familyId);
      };

      const settingsService: FamilySettingsService = {
        familyOf,
        resolve: resolveSettings,
        configFor: resolveSettings,
        dispose() {
          familyRoots.clear();
          bornRoots.clear();
          birthInFlight.clear();
          reconciledChildren.clear();
          familyLocks.clear();
        },
      };

      /**
       * One-shot creation reconciliation: a host-created child of a role-managed
       * family adopts the family's role model exactly once at creation. There is
       * no later validation; an explicit model choice after creation is never
       * touched.
       */
      const reconcileCreatedChild = async (created: {
        readonly sessionID: string;
        readonly model?: ModelSelection | undefined;
      }): Promise<void> => {
        if (!state.roleOverride) return;
        if (reconciledChildren.has(created.sessionID)) return;
        reconciledChildren.add(created.sessionID);
        const view = await readSession(created.sessionID).catch(() => undefined);
        if (view === undefined) return;
        const auxiliary = decodeAuxiliaryMetadata(view.metadata);
        if (auxiliary !== undefined) return;
        if (view.agent !== undefined && INTERNAL_PRIMARY_AGENTS.has(view.agent)) return;
        const role = view.agent === undefined ? undefined : state.config.agentRoles[view.agent];
        if (role === undefined) return;
        const settings = await resolveSettings(created.sessionID);
        if (settings === undefined) return;
        const expected = settings.roleModels[role];
        if (expected === undefined) return;
        if (sameModelSelection(created.model ?? view.model, expected)) return;
        await ctx.session.switchModel({ sessionID: created.sessionID, model: toRef(expected) });
      };
      // END_BLOCK_SETTINGS_SERVICE

      const modelTransform = (editor: ModelEditorLike): void => {
        state.nativeDefault = readDefaultModel(editor) ?? state.nativeDefault;
        if (!state.roleOverride) return;
        const defaultRole = parseRoleSelections(state.config.roles).default;
        if (defaultRole !== undefined) {
          editor.default.set(defaultRole.providerID, defaultRole.modelID);
        }
      };
      // The agent transform applies role policies to agent definitions, so
      // newly created sessions resolve their role model natively at creation.
      const agentTransform = (editor: AgentEditorLike): void => {
        state.agentBindings = captureAgentBindings(editor, state.config);
        if (state.roleOverride) {
          applyAgentPolicies(editor, state.agentBindings);
        }
      };

      let eagerTransformsRegistered = false;
      let suffixTransformsRegistered = false;
      const registerTransforms = async (): Promise<void> => {
        owned.push(await ctx.model.transform(modelTransform));
        owned.push(await ctx.agent.transform(agentTransform));
      };
      /**
       * Eager registration gives the role toggle an immediate visible effect during
       * setup; post config plugins register after it, so it also needs a suffix
       * registration after activation that appends last.
       */
      const ensureEagerTransforms = async (): Promise<void> => {
        if (eagerTransformsRegistered) return;
        eagerTransformsRegistered = true;
        await registerTransforms();
        await ctx.model.reload();
        await ctx.agent.reload();
      };
      const ensureTransforms = async (): Promise<void> => {
        if (suffixTransformsRegistered) return;
        suffixTransformsRegistered = true;
        await registerTransforms();
        await ctx.model.reload();
        await ctx.agent.reload();
      };

      const rawSmallModel = state.config.rawIntent?.smallModel;
      const smallModelRole =
        rawSmallModel !== undefined && isRoleReference(rawSmallModel)
          ? rawSmallModel.trim().slice(ROLE_REFERENCE_PREFIX.length)
          : getBuiltInRoleBindings().opencodeDefaults.smallModel;
      const auxiliary = createAuxiliaryService({
        familyOf,
        policy: resolveSettings,
        session: {
          create: importAuxiliaryChild,
          switchModel: async ({ sessionID, model }) => {
            await ctx.session.switchModel({ sessionID, model: toRef(model) });
          },
          generate: (input) => ctx.session.generate(input),
        },
        fallbackDirectory: ctx.location.directory,
      });

      owned.push(
        await ctx.session.hook("title", async (event) => {
          const title = await auxiliary.title({
            sessionID: event.sessionID,
            result: event.result,
            messages: extractTitleMessages(event.messages),
            role: smallModelRole,
          });
          if (title !== undefined && event.result !== title) {
            event.result = title;
          }
        }),
      );

      // Lazy settings birth on the first context hook of a session. The hook is
      // fail-soft: resolution problems never fail a model request, and plugin
      // consumers resolve independently anyway.
      owned.push(
        await ctx.session.hook("context", async (event) => {
          try {
            await ensureTransforms();
            await resolveSettings(event.sessionID);
          } catch {
            // Never fail a model request from settings work.
          }
        }),
      );

      // One native event pump: creation reconciliation and config refresh share a
      // single subscription. Failures are contained per event so later updates
      // still recover runtime health.
      const pump = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: lifecycle.signal })) {
            try {
              const created = decodeSessionCreatedEvent(event);
              if (created !== undefined) {
                await reconcileCreatedChild(created);
              }
              if (isConfigUpdateEvent(event)) {
                // Assign only after a fully successful read so a partially read
                // invalid config never becomes the mutable current config that
                // consumers consult; a successful read also clears the last
                // contained failure.
                state.config = await readConfig(ctx.location.directory);
                state.configError = undefined;
              }
              if (event.type === "session.deleted" && isRecord(event.data)) {
                const sessionID = event.data.sessionID;
                if (typeof sessionID === "string") {
                  familyRoots.delete(sessionID);
                  bornRoots.delete(sessionID);
                  reconciledChildren.delete(sessionID);
                }
              }
            } catch (error) {
              // Contain one event's failure and keep observing later events.
              state.configError = describePumpError(error);
            }
          }
        } catch (error) {
          // A closed/failed native stream is recorded, never silently swallowed.
          // There is no reconnect loop: cleanup aborts the subscription.
          state.configError = describePumpError(error);
        }
      })();
      void pump;

      await ensureEagerTransforms();

      // One-shot legacy migration: convert existing family bindings into root
      // metadata, then prune the legacy directories. Fail-soft: any write
      // failure keeps the directories for the next start.
      try {
        await migrateFamilyBindings({
          reader: fileLegacyBindingsReader({ scopeKey: ctx.location.project.id }),
          readSession,
          writeSettings: async (sessionID, settings) => {
            const fresh = await readSession(sessionID);
            const merged = mergeSettingsIntoMetadata(fresh.metadata, settings);
            await ctx.session.update({ sessionID, metadata: merged });
          },
        });
      } catch (error) {
        diagnostic(`Legacy migration deferred: ${describePumpError(error).slice(0, 160)}`);
      }

      // Read-only native context-inspection RPC: projects the registered tool
      // catalog and an allowlisted family/current-runtime policy for the TUI.
      // Owned by this runtime's cleanup; it disposes only its own registration.
      owned.push(
        await registerContextInspectionRpc(
          {
            location: ctx.location,
            rpc: ctx.rpc,
            ...(ctx.tool === undefined ? {} : { tool: ctx.tool }),
            session: { get: (input) => ctx.session.get(input) },
          },
          {
            policy: (sessionID) => resolveSettings(sessionID),
            currentConfig: () => state.config,
            ...(options?.now === undefined ? {} : { now: options.now }),
          },
        ),
      );

      return {
        runtime,
        settings: settingsService,
        auxiliary,
        client: () => runtime.client(),
        permissions: runtime.permissions,
        effectiveConfig: () => state.config,
        async setRoleOverride(enabled) {
          state.roleOverride = enabled;
          // Immediate visible override: re-run the already-registered
          // transforms with the new state instead of waiting for the first
          // request, without stacking duplicate registrations.
          await ensureEagerTransforms();
          await ctx.model.reload();
          await ctx.agent.reload();
        },
        refresh: async () => {
          await ctx.model.reload();
          await ctx.agent.reload();
        },
        lastConfigError: () => state.configError,
        release: releaseRuntime,
      };
    } catch (error) {
      // Initialization failure must unwind every acquired resource and permit retry.
      await releaseRuntime().catch(() => undefined);
      throw error;
    }
  })();
}

/** Acquire the shared native runtime for an actual `Plugin.Context`. */
export async function acquireNativeSnapshotRuntime<
  Client extends NativeForkClient = OpenCodeClient,
>(
  ctx: NativeSnapshotContext,
  options?: NativeSnapshotRuntimeOptions<Client>,
): Promise<NativeSnapshotRuntime<Client>> {
  const key =
    options?.runtimeDeps === undefined
      ? String(objectId(contextIds, ctx))
      : `${objectId(contextIds, ctx)}:${objectId(depsIds, options.runtimeDeps)}`;
  let entry = nativeRuntimes.get(key);
  if (entry === undefined) {
    const init = initializeNativeSnapshotRuntime(
      ctx,
      options as unknown as NativeSnapshotRuntimeOptions<NativeForkClient> | undefined,
    ) as Promise<NativeSnapshotRuntime<NativeForkClient>>;
    entry = { refs: 0, disposed: false, init };
    nativeRuntimes.set(key, entry);
    void init.catch(() => {
      // A failed initialization must not poison the registry; allow a clean retry.
      if (nativeRuntimes.get(key) === entry) nativeRuntimes.delete(key);
    });
  }
  entry.refs += 1;
  const owned = entry;
  const runtime = await owned.init;
  owned.runtime = runtime;
  // The registry erases the client type; the key includes the injected dependency identity.
  const typed = runtime as unknown as NativeSnapshotRuntime<Client>;
  let released = false;
  return {
    ...typed,
    async release() {
      if (released) return;
      released = true;
      await releaseNativeSnapshotRuntime(key, owned);
    },
  };
}

async function releaseNativeSnapshotRuntime(key: string, entry: NativeRuntimeEntry): Promise<void> {
  if (entry.disposed) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entry.disposed = true;
  nativeRuntimes.delete(key);
  const runtime = entry.runtime ?? (await entry.init);
  await runtime.release();
}
// END_BLOCK_RUNTIME_INITIALIZATION
