// FILE: src/runtime/context.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Acquire, share by exact plugin-context identity, and release the lifecycle-managed native runtime, family-binding service, and centralized native runtime (client/permissions/bindings/config/model/auxiliary) consumed by every later native plugin.
//   SCOPE: Context-identity reference-counted registries, per-acquisition idempotent leases, lazy authenticated-client caching, permission-service exposure, native model/agent overlay capture, default-model transform, config.updated reconfiguration, coherent first-work binding, rehydrated guard/variants, session-deletion cleanup, cross-context coordination, the read-only context-inspection RPC, and idempotent teardown without stopping the host. No candidate staging, accepted-input publication, service discovery until a client is requested, location-only sharing, global configuration singleton, parallel fake runtime, or V1 compatibility facade.
//   DEPENDS: [node:crypto, @opencode/plugin, src/lib/config-layers.ts, src/runtime/client.ts, src/runtime/coordination.ts, src/runtime/context-inspection.ts, src/runtime/model-registry.ts, src/runtime/permissions.ts, src/runtime/snapshot-config.ts, src/runtime/snapshot-store.ts, src/runtime/snapshots.ts, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   acquireRuntime - Return a per-acquisition release lease for the runtime shared by one exact plugin context.
//   acquireSnapshotService - Return a per-acquisition release lease for the family-binding service shared by one exact plugin context and dependency instance.
//   NativeSessionInfoLike - Structural native session info used for lineage and provenance.
//   NativeSnapshotHookEvents - Structural native hook event map used by the shared runtime.
//   NativeSnapshotContext - Narrow structural native Plugin.Context used to acquire the shared snapshot runtime.
//   NativeRegistration - Releasable native registration handle.
//   NativeForkClient - Structural full client for forks and parented imports.
//   NativeSnapshotRuntimeOptions - Optional injectable native boundaries for the shared snapshot runtime.
//   NativeSnapshotRuntime - Documented shared native runtime: client, permissions, family bindings, effective config, model reload, role override, first-work gateway and refresh.
//   acquireNativeSnapshotRuntime - Acquire the shared native snapshot runtime for an actual Plugin.Context.
//   rebuildAgentBindings - Recompute agent bindings from a freshly read policy without trusting a cached vvoc-applied selection.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SNAPSHOT-ANCHORING-REDESIGN T-004/T-005/T-008 - Replaced candidate acceptance with durable bind-on-first-work, runtime rehydration of credential-free bindings, live overlay materialization, explicit-selection qualification that matches the host-resolved family variant, native session-deletion cleanup.]
//   PREVIOUS: [C-OPENCODE-V2-NATIVE T-009 - One coherent admission config: bindings are rebuilt from the fresh role map plus raw intent so a vvoc role change with no config.updated selects and captures the new model; the same value drives the candidate target and the family capture for prompt and owned work, and services share an app/location-identity coordinator.]
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
import { coordinateHost } from "./coordination.js";
import {
  applyAgentPolicies,
  applyVariantRegistrations,
  buildVariantRegistrations,
  mergeModelBodyOverlay,
  mergeModelHeadersOverlay,
  primarySelection,
  qualifySelection,
} from "./model-registry.js";
import { createPermissionService } from "./permissions.js";
import {
  canonicalModelVariant,
  classifyInitialSelection,
  decodeModelSelectedEvent,
  decodeSessionCreatedEvent,
  effectiveRuntimeConfig,
  isConfigUpdateEvent,
  normalizeModelSelection,
  parseRoleSelections,
} from "./snapshot-config.js";
import { registerContextInspectionRpc } from "./context-inspection.js";
import { FileBindingStore } from "./snapshot-store.js";
import { createSnapshotService, type SnapshotServiceDeps } from "./snapshots.js";
import {
  RuntimeDisposedError,
  SnapshotAdmissionError,
  SnapshotUnboundError,
  decodeAuxiliaryMetadata,
  decodeImportedSessionID,
  runtimeIdentity,
  type AdmissionOutcome,
  type AgentEditorLike,
  type AgentPolicyBinding,
  type AuxiliaryService,
  type CapturedModelSettings,
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
  type SnapshotAdmissionRequest,
  type SnapshotLease,
  type SnapshotService,
  type VariantRegistration,
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

// START_BLOCK_SNAPSHOT_REGISTRY
interface ManagedSnapshotEntry {
  readonly service: SnapshotService;
  refs: number;
  disposed: boolean;
}

const snapshotServices = new Map<string, ManagedSnapshotEntry>();

/**
 * Return a per-acquisition release lease for the snapshot service shared by one
 * exact plugin context object and dependency instance. Distinct contexts never
 * share a service, so per-location policies cannot leak across projects.
 */
export function acquireSnapshotService<Context extends RuntimeContext>(
  context: Context,
  deps: SnapshotServiceDeps,
): SnapshotLease {
  const key = `${objectId(contextIds, context)}:${objectId(depsIds, deps)}`;
  let entry = snapshotServices.get(key);
  if (entry === undefined) {
    entry = { service: createSnapshotService(deps), refs: 0, disposed: false };
    snapshotServices.set(key, entry);
  }
  const owned = entry;
  owned.refs += 1;

  let released = false;
  return {
    snapshots: owned.service,
    release: async () => {
      if (released) return;
      released = true;
      if (owned.disposed) return;
      owned.refs -= 1;
      if (owned.refs <= 0) {
        owned.disposed = true;
        snapshotServices.delete(key);
        owned.service.dispose();
      }
    },
  };
}
// END_BLOCK_SNAPSHOT_REGISTRY

// START_BLOCK_NATIVE_SNAPSHOT_RUNTIME
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
export interface NativeSnapshotHookEvents {
  prompt: { readonly sessionID: string; readonly messageID?: string | undefined };
  context: { readonly sessionID: string; readonly agent?: string | undefined };
  generate: { readonly sessionID: string };
  title: { readonly sessionID: string; result?: string | undefined; messages?: unknown };
  "model.request": {
    readonly sessionID: string;
    readonly model: unknown;
    readonly agent?: string | undefined;
    readonly kind: string;
  };
}

/**
 * Narrow structural native `Plugin.Context` used to acquire the shared snapshot
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
    update(input: { readonly sessionID: string; readonly title: string }): Promise<void>;
    generate(input: {
      readonly sessionID: string;
      readonly prompt: string;
    }): Promise<{ readonly text: string }>;
    hook<Name extends keyof NativeSnapshotHookEvents>(
      name: Name,
      callback: (event: NativeSnapshotHookEvents[Name]) => void | Promise<void>,
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

/** Optional injectable native boundaries for the shared snapshot runtime (tests only). */
export interface NativeSnapshotRuntimeOptions<Client extends NativeForkClient = OpenCodeClient> {
  readonly runtimeDeps?: RuntimeDeps<Client> | undefined;
  readonly store?: FileBindingStore | undefined;
  readonly now?: (() => number) | undefined;
}

/** Documented shared native runtime consumed by every later plugin. */
export interface NativeSnapshotRuntime<Client extends NativeForkClient = OpenCodeClient> {
  /** Native runtime with lazy authenticated full client and resource permissions. */
  readonly runtime: NativeRuntime<NativeSnapshotContext, Client>;
  /** Family-binding/config/model/auxiliary service. */
  readonly snapshots: SnapshotService;
  /**
   * Supported bind-on-first-work gateway for owned direct generate/synthetic work.
   * It persists the credential-free family revision, materializes the qualified
   * live overlay, and switches before native model resolution. Unbound raw
   * external generate remains fail-closed.
   */
  admitWorkload(request: SnapshotAdmissionRequest): Promise<AdmissionOutcome>;
  /** Snapshot-bound auxiliary generation. */
  readonly auxiliary: AuxiliaryService;
  /** Lazily authenticated same-instance full native client (genuine OpenCodeClient by default). */
  client(): Promise<Client>;
  /** Resource permission service bound to this runtime's client. */
  readonly permissions: PermissionService;
  /** Current effective vvoc configuration plus captured native overlays. */
  effectiveConfig(): EffectiveRuntimeConfig;
  /** Enable or disable role overriding (agent models and default model) without disabling capture/guard. */
  setRoleOverride(enabled: boolean): Promise<void>;
  /** Reload rehydrated family bindings, variant registrations and native transforms. */
  refresh(): Promise<void>;
  /** Last config-watcher failure, surfaced instead of being silently swallowed. */
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
  return normalizeModelSelection({
    providerID: String(record.providerID),
    modelID: String(record.id),
    ...(record.variant === undefined ? {} : { variant: String(record.variant) }),
  });
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

function cloneOverlay(
  value: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  return value === undefined ? undefined : { ...value };
}

/** True for a snapshot-qualified variant previously materialized by this runtime. */
function isManagedVariantID(
  variantID: string,
  modelID: string,
  ownVariantIds: ReadonlySet<string>,
): boolean {
  if (ownVariantIds.has(variantID)) return true;
  const prefix = variantID.slice(0, 16);
  const suffix = variantID.slice(16);
  return (
    /^[0-9a-f]{16}$/.test(prefix) && (suffix === `.${modelID}` || suffix.startsWith(`.${modelID}.`))
  );
}

function wantedModelKeys(config: EffectiveRuntimeConfig): Set<string> {
  const keys = new Set<string>();
  for (const selection of Object.values(parseRoleSelections(config.roles))) {
    keys.add(`${selection.providerID}/${selection.modelID}`);
  }
  if (config.rootDefault !== undefined) {
    keys.add(`${config.rootDefault.providerID}/${config.rootDefault.modelID}`);
  }
  if (config.nativeDefault !== undefined) {
    keys.add(`${config.nativeDefault.providerID}/${config.nativeDefault.modelID}`);
  }
  // Custom/literal agent models outside the role map still need their overlay captured.
  for (const binding of config.agentBindings ?? []) {
    if (binding.selection !== undefined) {
      keys.add(`${binding.selection.providerID}/${binding.selection.modelID}`);
    }
  }
  return keys;
}

function captureModelSettings(
  editor: ModelEditorLike,
  wanted: ReadonlySet<string>,
  ownVariantIds: ReadonlySet<string>,
): CapturedModelSettings[] {
  const captured: CapturedModelSettings[] = [];
  for (const model of editor.list()) {
    const providerID = String(model.providerID);
    // The wire/route id (`Model.Info.id`) is what sessions and requests reference,
    // which differs from the catalog `modelID` for aliased models.
    const modelID = String(model.id);
    if (wanted.size > 0 && !wanted.has(`${providerID}/${modelID}`)) continue;
    captured.push({
      providerID,
      modelID,
      ...(model.settings === undefined ? {} : { settings: cloneOverlay(model.settings) }),
      ...(model.body === undefined ? {} : { body: cloneOverlay(model.body) }),
      ...(model.headers === undefined ? {} : { headers: { ...model.headers } }),
    });
    for (const variant of model.variants) {
      // Never re-capture vvoc-generated variants as native overlays (no accumulation).
      if (isManagedVariantID(String(variant.id), modelID, ownVariantIds)) continue;
      captured.push({
        providerID,
        modelID,
        variant: String(variant.id),
        ...(variant.settings === undefined ? {} : { settings: cloneOverlay(variant.settings) }),
        ...(variant.body === undefined ? {} : { body: cloneOverlay(variant.body) }),
        ...(variant.headers === undefined ? {} : { headers: { ...variant.headers } }),
      });
    }
  }
  return captured;
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
 * native literal. This is what makes `vvoc.json` role changes take effect on the
 * first unbound workload even when the host emits no `config.updated`.
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

/** Selection the family expects for a given request kind and session agent. */
function expectedSelection(
  capture: import("./types.js").FamilyCapture,
  agentID: string | undefined,
): ModelSelection | undefined {
  // An explicit family choice is the session's model and must not be overridden
  // by an agent-role binding.
  if (capture.intent.mode === "explicit" && capture.modelOverride !== undefined) {
    return qualifySelection(capture, capture.modelOverride);
  }
  if (agentID !== undefined) {
    const binding = capture.agents.find((agent) => agent.agentID === agentID);
    if (binding?.selection !== undefined) {
      return qualifySelection(capture, binding.selection);
    }
  }
  const base = primarySelection(capture);
  return base === undefined ? undefined : qualifySelection(capture, base);
}

function selectionMatches(
  actual: ModelSelection | undefined,
  expected: ModelSelection | undefined,
): boolean {
  if (expected === undefined) return true;
  if (actual === undefined) return false;
  // Identity plus variant: a resolved request must use the captured variant exactly.
  return sameModelSelection(actual, expected);
}

/** Map a family-qualified variant id back to its native source variant. */
function sourceVariantOf(
  capture: import("./types.js").FamilyCapture,
  selection: ModelSelection | undefined,
): string | undefined {
  if (selection?.variant === undefined) return undefined;
  const known = capture.variants.find((variant) => variant.id === selection.variant);
  return known?.sourceVariant ?? selection.variant;
}

/**
 * True when two selections denote the same model and the same source variant,
 * accepting the native variant id and its family-qualified id as equivalent.
 * The host may resolve either form depending on whether the session model was
 * rewritten through the family switch, and both denote the same request body.
 */
function sameSourceSelection(
  capture: import("./types.js").FamilyCapture,
  actual: ModelSelection | undefined,
  expected: ModelSelection | undefined,
): boolean {
  if (actual === undefined || expected === undefined) return false;
  return (
    actual.providerID === expected.providerID &&
    actual.modelID === expected.modelID &&
    sourceVariantOf(capture, actual) === sourceVariantOf(capture, expected)
  );
}

/** The model a family expects for host title work: the captured fast/small role. */
function titleExpectedSelection(
  capture: import("./types.js").FamilyCapture,
): ModelSelection | undefined {
  const small = capture.roleModels.fast;
  return small === undefined ? undefined : qualifySelection(capture, small);
}

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
        modelSettings: CapturedModelSettings[];
        nativeDefault: ModelSelection | undefined;
        registrations: VariantRegistration[];
        pendingRegistrations: Map<string, VariantRegistration[]>;
        materializedVariants: Set<string>;
        ownVariantIds: Set<string>;
        roleOverride: boolean;
        configError: string | undefined;
        creationModels: Map<string, ModelSelection | undefined>;
        creationDefaults: Map<string, ModelSelection | undefined>;
        explicitSelections: Map<string, ModelSelection>;
        pluginSwitches: Map<string, ModelSelection>;
        suppressedTitles: Set<string>;
      } = {
        config: base,
        agentBindings: [],
        modelSettings: [],
        nativeDefault: undefined,
        registrations: [],
        // Per-family pending materialization so concurrent families cannot overwrite
        // each other's in-flight variant registrations.
        pendingRegistrations: new Map(),
        materializedVariants: new Set(),
        ownVariantIds: new Set(),
        roleOverride: false,
        configError: undefined,
        creationModels: new Map(),
        creationDefaults: new Map(),
        explicitSelections: new Map(),
        pluginSwitches: new Map(),
        suppressedTitles: new Set(),
      };

      const store = options?.store ?? new FileBindingStore({ scopeKey: ctx.location.project.id });

      /**
       * Read the host's final native model collection. A model transform registered
       * by this plugin may run before later config transforms, so a transform-local
       * editor is neither the capture source nor proof a variant survived; the
       * host's final list is. Returns undefined when the host exposes no list call.
       */
      async function readFinalModelEntries(): Promise<
        ReadonlyArray<Record<string, unknown>> | undefined
      > {
        const list = (ctx.model as { list?: (input?: unknown) => Promise<unknown> }).list;
        if (typeof list !== "function") return undefined;
        let raw: unknown;
        try {
          raw = await list.call(ctx.model);
        } catch {
          return undefined;
        }
        const data =
          isRecord(raw) && Array.isArray((raw as { data?: unknown }).data)
            ? (raw as { data: unknown[] }).data
            : Array.isArray(raw)
              ? raw
              : [];
        return data.filter(isRecord);
      }

      const readFinalOverlays = async (
        config: EffectiveRuntimeConfig,
      ): Promise<CapturedModelSettings[] | undefined> => {
        const entries = await readFinalModelEntries();
        if (entries === undefined) return undefined;
        const wanted = wantedModelKeys(config);
        const captured: CapturedModelSettings[] = [];
        const overlay = (
          providerID: string,
          modelID: string,
          variant: string | undefined,
          base: Record<string, unknown>,
          source: Record<string, unknown>,
        ): CapturedModelSettings => {
          const settings = mergeModelBodyOverlay(
            isRecord(base.settings) ? base.settings : undefined,
            isRecord(source.settings) ? source.settings : undefined,
          );
          const body = mergeModelBodyOverlay(
            isRecord(base.body) ? base.body : undefined,
            isRecord(source.body) ? source.body : undefined,
          );
          const headers = mergeModelHeadersOverlay(
            isRecord(base.headers) ? (base.headers as Record<string, string>) : undefined,
            isRecord(source.headers) ? (source.headers as Record<string, string>) : undefined,
          );
          return {
            providerID,
            modelID,
            ...(variant === undefined ? {} : { variant }),
            ...(settings === undefined ? {} : { settings }),
            ...(body === undefined ? {} : { body }),
            ...(headers === undefined ? {} : { headers }),
          };
        };
        for (const entry of entries) {
          const providerID = entry.providerID;
          const modelID = entry.id;
          if (typeof providerID !== "string" || typeof modelID !== "string") continue;
          if (wanted.size > 0 && !wanted.has(`${providerID}/${modelID}`)) continue;
          captured.push(overlay(providerID, modelID, undefined, entry, entry));
          if (Array.isArray(entry.variants)) {
            for (const variant of entry.variants) {
              if (!isRecord(variant) || typeof variant.id !== "string") continue;
              // Never re-capture our own generated variants (no accumulation).
              if (isManagedVariantID(variant.id, modelID, state.ownVariantIds)) continue;
              // Each source variant gets the base merged with THAT variant's own
              // native overlay, so two source variants of one model stay distinct.
              captured.push(overlay(providerID, modelID, variant.id, entry, variant));
            }
          }
        }
        return captured;
      };

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
        const baseConfig: EffectiveRuntimeConfig = {
          ...vvoc,
          ...(rawIntent === undefined ? {} : { rawIntent }),
          ...(rootResolved === undefined ? {} : { rootDefault: rootResolved }),
          agentBindings,
          modelSettings: state.modelSettings,
          ...(state.nativeDefault === undefined ? {} : { nativeDefault: state.nativeDefault }),
        };
        // Capture the final native model overlay (post config-transform) when the
        // host exposes it, so a snapshot variant reflects the real request payload.
        const overlays = await readFinalOverlays(baseConfig);
        if (overlays !== undefined) state.modelSettings = overlays;
        return { ...baseConfig, modelSettings: state.modelSettings };
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
          throw new SnapshotAdmissionError(
            "Auxiliary child import requires the parent session project id.",
          );
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
          throw new SnapshotAdmissionError(
            "Native session import did not return the expected auxiliary child id.",
          );
        }
        // The parent binding must be durable before the child is used.
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const view = toSessionView(await ctx.session.get({ sessionID }));
          if (view.parentID === input.parentID) return { sessionID };
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new SnapshotAdmissionError(
          "Imported auxiliary child did not persist its parent lineage.",
        );
      };

      const deps: SnapshotServiceDeps = {
        store,
        location: runtimeIdentity(ctx.location),
        ...(options?.now === undefined ? {} : { now: options.now }),
        // Distinct plugin contexts copied from one host share the native app/location
        // object identity, so their snapshot services share one per-family
        // publication lock without sharing any client, registration or disposal.
        coordination: coordinateHost({ app: ctx.app, location: ctx.location }),
        loadConfig: async (directory) => {
          const fresh = await readConfig(directory);
          state.config = fresh;
          return fresh;
        },
        readSession: async (sessionID) => toSessionView(await ctx.session.get({ sessionID })),
        readSessionModel: async (sessionID) =>
          toSelection((await ctx.session.get({ sessionID })).model),
        switchModel: ({ sessionID, model }) =>
          ctx.session.switchModel({ sessionID, model: toRef(model) }),
        auxiliarySession: {
          create: importAuxiliaryChild,
          switchModel: async ({ sessionID, model }) => {
            await ctx.session.switchModel({ sessionID, model: toRef(model) });
          },
          generate: (input) => ctx.session.generate(input),
        },
      };
      const snapshots = createSnapshotService(deps);

      const allPending = (): VariantRegistration[] =>
        [...state.pendingRegistrations.values()].flat();

      const applyVariants = (editor: ModelEditorLike): number =>
        applyVariantRegistrations(editor, [...state.registrations, ...allPending()]);

      const refresh = async (): Promise<void> => {
        state.registrations = buildVariantRegistrations(await snapshots.captures());
        await ctx.model.reload();
        await ctx.agent.reload();
      };

      /**
       * Read the final native model collection after a reload. A model transform
       * registered by this plugin may run before later config transforms, so a
       * transform-local editor is not proof the variant survived; the host's final
       * model list is. Returns undefined when the host exposes no list call (tests).
       */
      const materializeBinding = async (
        capture: import("./types.js").FamilyCapture,
        selection: ModelSelection,
      ): Promise<void> => {
        if (selection.variant === undefined) return;
        // Materialize this family's qualified live variant before its first switch.
        state.pendingRegistrations.set(capture.snapshotId, buildVariantRegistrations([capture]));
        await ctx.model.reload();
        const finalEntries = await readFinalModelEntries();
        const exists =
          finalEntries === undefined
            ? state.materializedVariants.has(selection.variant)
            : finalEntries.some((entry) => {
                if (entry.providerID !== selection.providerID || entry.id !== selection.modelID) {
                  return false;
                }
                return (
                  Array.isArray(entry.variants) &&
                  entry.variants.some(
                    (variant) => isRecord(variant) && String(variant.id) === selection.variant,
                  )
                );
              });
        if (!exists) {
          state.pendingRegistrations.delete(capture.snapshotId);
          await ctx.model.reload();
          throw new SnapshotAdmissionError(
            `Captured variant ${selection.variant} is not materializable on ${selection.providerID}/${selection.modelID}.`,
          );
        }
      };

      const switchSession = async (sessionID: string, selection: ModelSelection): Promise<void> => {
        state.pluginSwitches.set(sessionID, selection);
        await ctx.session.switchModel({ sessionID, model: toRef(selection) });
      };

      /** First-work selection for a session's agent from the live policy. */
      const bindingTarget = (agentID: string | undefined): ModelSelection | undefined => {
        const bindings = state.config.agentBindings ?? [];
        if (agentID !== undefined) {
          const binding = bindings.find((agent) => agent.agentID === agentID);
          if (binding?.selection !== undefined) return binding.selection;
        }
        const roleModels = parseRoleSelections(state.config.roles);
        if (roleModels.default !== undefined) return roleModels.default;
        if (state.config.rootDefault !== undefined) return state.config.rootDefault;
        for (const selection of Object.values(roleModels)) return selection;
        for (const binding of bindings) {
          if (binding.selection !== undefined) return binding.selection;
        }
        return state.config.nativeDefault;
      };

      /**
       * One coherent workload selection for a bound family. An explicit post-bind
       * user choice always wins; role overriding disabled means the host's current
       * model is already the policy. Otherwise the agent's captured binding, then
       * the family primary, with the family's captured variant qualified.
       */
      const expectedForSession = (
        capture: import("./types.js").FamilyCapture,
        agentID: string | undefined,
        sessionID: string,
        metadata?: Readonly<Record<string, unknown>> | undefined,
      ): ModelSelection | undefined => {
        // A real parented auxiliary child recovers its intended role from
        // host-owned metadata, not an in-process exemption.
        const auxiliary = decodeAuxiliaryMetadata(metadata);
        if (auxiliary !== undefined) {
          const base =
            auxiliary.role === undefined
              ? primarySelection(capture)
              : capture.roleModels[auxiliary.role];
          return base === undefined ? undefined : qualifySelection(capture, base);
        }
        if (!state.roleOverride) return capture.modelOverride ?? capture.rootSelection;
        const explicit = state.explicitSelections.get(sessionID);
        // An explicit user choice wins, but the host resolves the request against the
        // family-qualified variant id after the first-work switch, so the expectation
        // must use the same qualification or the guard rejects the resolved request.
        if (explicit !== undefined) return qualifySelection(capture, explicit);
        return expectedSelection(capture, agentID);
      };

      const bindFor = async (sessionID: string): Promise<void> => {
        await ensureTransforms();
        const view = toSessionView(await ctx.session.get({ sessionID }));
        const sessionModel = view.model;
        const pluginSwitch = state.pluginSwitches.get(sessionID);
        const ownSwitch =
          pluginSwitch !== undefined && sameModelSelection(sessionModel, pluginSwitch);
        // The default captured at creation, never the possibly-changed current default.
        const creationDefault = state.creationDefaults.get(sessionID) ?? state.nativeDefault;
        const intent = ownSwitch
          ? ({ mode: "implicit", source: "switch" } as const)
          : classifyInitialSelection({ sessionModel, creationDefault });
        if (intent.mode === "explicit" && intent.literal !== undefined) {
          // Creation provenance is an explicit host selection just like a later
          // model-selected event, so preserve it through the model guard.
          state.explicitSelections.set(sessionID, intent.literal);
        }

        const existing = await snapshots.policy(sessionID);
        if (existing !== undefined) {
          // A bound family owns an immutable capture, so its policy/model handling
          // never consults the mutable current config. Resolve it before any fresh
          // read: an invalid on-disk vvoc must not fail an already-bound family.
          // A session model that changed outside our own switch is a user choice and
          // must survive, even if the event pump has not recorded it yet.
          const baseExpected = expectedSelection(existing, view.agent);
          if (
            !ownSwitch &&
            baseExpected !== undefined &&
            sessionModel !== undefined &&
            !sameModelSelection(sessionModel, baseExpected) &&
            !sameModelSelection(sessionModel, pluginSwitch)
          ) {
            state.explicitSelections.set(sessionID, normalizeModelSelection(sessionModel));
          }
          if (!state.roleOverride || state.explicitSelections.has(sessionID)) return;
          const target = expectedForSession(existing, view.agent, sessionID);
          if (target !== undefined && !sameModelSelection(sessionModel, target)) {
            await switchSession(sessionID, target);
          }
          return;
        }
        // Only a truly unbound family needs the freshest current config:
        // vvoc.json changes do not emit a host `config.updated`, and a stale
        // family target would otherwise bind the previous role selection. The
        // SAME immutable value is passed into the service so its projection cannot
        // re-read a different vvoc snapshot than the target was derived from.
        const admissionConfig = await readConfig(ctx.location.directory);
        state.config = admissionConfig;
        const explicitSelection = intent.mode === "explicit" ? intent.literal : undefined;
        const target = explicitSelection ?? bindingTarget(view.agent);
        const base = state.roleOverride ? target : (sessionModel ?? target);
        // The agent-aware resolved target drives binding, not the capture's default
        // role; when role overriding is off the session's current model is bound.
        const selectionOverride =
          explicitSelection === undefined && base !== undefined ? base : undefined;
        const outcome = await snapshots.admitOwned(
          {
            sessionID,
            directory: ctx.location.directory,
            location: runtimeIdentity(ctx.location),
            admissionConfig,
            ...(explicitSelection === undefined ? {} : { explicit: explicitSelection }),
            ...(selectionOverride === undefined ? {} : { selectionOverride }),
            force: state.roleOverride,
          },
          async (capture, selection) => {
            await materializeBinding(capture, selection);
            state.pluginSwitches.set(sessionID, selection);
          },
        );
        if (outcome.status === "rejected") {
          throw new SnapshotAdmissionError(
            outcome.error ?? `Binding for ${sessionID} did not produce a persisted policy.`,
          );
        }
        if (outcome.status === "bound") {
          await refresh();
          state.pendingRegistrations.clear();
        }
      };

      const guardResolvedModel = async (
        sessionID: string,
        agentID: string | undefined,
        actual: ModelSelection | undefined,
        kind: string,
      ): Promise<void> => {
        await ensureTransforms();
        if (kind === "title" && state.suppressedTitles.has(sessionID)) {
          // The title hook already supplied the result; the host still runs this
          // hook before it checks `result`, so a refused dispatch here would fail
          // a title that never reaches the provider.
          state.suppressedTitles.delete(sessionID);
          return;
        }
        const view = toSessionView(await ctx.session.get({ sessionID }));
        const effectiveAgent = agentID ?? view.agent;
        const familyId = await snapshots.familyOf(sessionID);
        const capture = await snapshots.policy(sessionID);
        if (capture !== undefined) {
          const expected =
            kind === "title"
              ? titleExpectedSelection(capture)
              : expectedForSession(capture, effectiveAgent, sessionID, view.metadata);
          if (
            !selectionMatches(actual, expected) &&
            !sameSourceSelection(capture, actual, expected)
          ) {
            throw new SnapshotAdmissionError(
              `Resolved ${kind} model ${actual?.providerID ?? "?"}/${actual?.modelID ?? "?"} does not match the captured family selection for ${familyId}.`,
            );
          }
          return;
        }
        throw new SnapshotUnboundError(
          `Refusing unbound ${kind} dispatch for session ${sessionID} before first-work family binding.`,
        );
      };

      const modelTransform = (editor: ModelEditorLike): void => {
        const own = new Set(
          [...state.registrations, ...allPending()].map((registration) => registration.variant.id),
        );
        state.ownVariantIds = own;
        state.modelSettings = captureModelSettings(editor, wantedModelKeys(state.config), own);
        state.nativeDefault = readDefaultModel(editor) ?? state.nativeDefault;
        applyVariants(editor);
        // Cheap transform-local readback; the final-list readback happens before switch.
        state.materializedVariants = new Set(
          [...state.registrations, ...allPending()].flatMap((registration) => {
            const model = editor.get(registration.providerID, registration.modelID);
            return model !== undefined &&
              model.variants.some((variant) => String(variant.id) === registration.variant.id)
              ? [registration.variant.id]
              : [];
          }),
        );
        if (!state.roleOverride) return;
        const defaultRole = parseRoleSelections(state.config.roles).default;
        if (defaultRole !== undefined) {
          editor.default.set(defaultRole.providerID, defaultRole.modelID);
        }
      };
      // Global agent transform represents current unbound candidates only; family
      // variants are applied per-session at switch time, never from another family.
      const agentTransform = (editor: AgentEditorLike): void => {
        state.agentBindings = captureAgentBindings(editor, state.config);
        if (state.roleOverride) {
          applyAgentPolicies(editor, state.agentBindings, []);
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
       * registration after activation that appends last and keeps our variants.
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
      owned.push(await ctx.session.hook("prompt", (event) => bindFor(event.sessionID)));
      // `context` and `generate` resolve their model before (or around) the hook,
      // so neither can bind; owned generate/synthetic work uses admitWorkload.
      owned.push(
        await ctx.session.hook("generate", async (event) => {
          const view = toSessionView(await ctx.session.get({ sessionID: event.sessionID }));
          await guardResolvedModel(event.sessionID, view.agent, view.model, "generate");
        }),
      );
      owned.push(
        await ctx.session.hook("model.request", async (event) => {
          // The model is already resolved here: only validate/commit, never re-stage.
          await guardResolvedModel(
            event.sessionID,
            event.agent,
            toSelection(event.model),
            event.kind,
          );
        }),
      );
      const rawSmallModel = state.config.rawIntent?.smallModel;
      const smallModelRole =
        rawSmallModel !== undefined && isRoleReference(rawSmallModel)
          ? rawSmallModel.trim().slice(ROLE_REFERENCE_PREFIX.length)
          : getBuiltInRoleBindings().opencodeDefaults.smallModel;
      owned.push(
        await ctx.session.hook("title", async (event) => {
          const title = await snapshots.auxiliary.title({
            sessionID: event.sessionID,
            result: event.result,
            messages: extractTitleMessages(event.messages),
            role: smallModelRole,
          });
          if (title !== undefined && event.result !== title) {
            event.result = title;
            // The host runs model.request before it checks `result`, so remember
            // that this title provider dispatch is suppressed and must not refuse.
            state.suppressedTitles.add(event.sessionID);
          }
        }),
      );

      // One native event pump: creation provenance, explicit choice capture, config
      // refresh, and family-deletion cleanup share a single subscription. Failures
      // are contained per event so later updates still recover runtime health.
      const pump = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: lifecycle.signal })) {
            try {
              const created = decodeSessionCreatedEvent(event);
              if (created !== undefined) {
                state.creationModels.set(created.sessionID, created.model);
                // Record the default in force at creation, not a later changed default.
                state.creationDefaults.set(created.sessionID, state.nativeDefault);
              }
              const selected = decodeModelSelectedEvent(event);
              if (selected !== undefined) {
                const pluginSwitch = state.pluginSwitches.get(selected.sessionID);
                if (
                  pluginSwitch === undefined ||
                  !sameModelSelection(selected.model, pluginSwitch)
                ) {
                  // The host emits this only for a real change, so it is a user choice.
                  state.explicitSelections.set(selected.sessionID, selected.model);
                }
              }
              if (isConfigUpdateEvent(event)) {
                // Assign only after a fully successful read so a partially read
                // invalid config never becomes the mutable current config that
                // already bound families consult.
                state.config = await readConfig(ctx.location.directory);
                await refresh();
                // A successful config event is the recovery signal.
                state.configError = undefined;
              }
              if (event.type === "session.deleted" && isRecord(event.data)) {
                const sessionID = event.data.sessionID;
                if (typeof sessionID === "string") {
                  await snapshots.removeFamily(sessionID);
                  state.creationModels.delete(sessionID);
                  state.creationDefaults.delete(sessionID);
                  state.explicitSelections.delete(sessionID);
                  state.pluginSwitches.delete(sessionID);
                  state.suppressedTitles.delete(sessionID);
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

      await refresh();

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
            policy: (sessionID) => snapshots.policy(sessionID),
            currentConfig: () => state.config,
            ...(options?.now === undefined ? {} : { now: options.now }),
          },
        ),
      );

      return {
        runtime,
        snapshots,
        auxiliary: snapshots.auxiliary,
        client: () => runtime.client(),
        permissions: runtime.permissions,
        effectiveConfig: () => state.config,
        async admitWorkload(request) {
          // Supported pre-admission gateway for owned direct generate/synthetic:
          // bind, materialize the qualified live variant, and switch before the
          // caller triggers native model resolution.
          const admissionConfig = await readConfig(request.directory);
          state.config = admissionConfig;
          const outcome = await snapshots.admitOwned(
            {
              ...request,
              admissionConfig,
            },
            async (capture, selection) => {
              await materializeBinding(capture, selection);
              state.pluginSwitches.set(request.sessionID, selection);
            },
          );
          if (outcome.status === "bound") {
            await refresh();
            state.pendingRegistrations.clear();
          }
          return outcome;
        },
        async setRoleOverride(enabled) {
          state.roleOverride = enabled;
          // Immediate visible override; the suffix registration at first work
          // appends after post config transforms and keeps the final state ours.
          await ensureEagerTransforms();
        },
        refresh,
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

/** Acquire the shared native snapshot runtime for an actual `Plugin.Context`. */
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
// END_BLOCK_NATIVE_SNAPSHOT_RUNTIME
