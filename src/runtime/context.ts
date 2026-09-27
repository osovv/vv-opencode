// FILE: src/runtime/context.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Acquire, share by exact plugin-context identity, and release the lifecycle-managed native runtime, the snapshot service, and the centralized native snapshot runtime (client/permissions/snapshots/config/model/auxiliary) consumed by every later native plugin.
//   SCOPE: Context-identity reference-counted runtime/snapshot registries, per-acquisition idempotent release leases, lazy authenticated-client caching, permission-service exposure, native model/agent overlay capture, default-model transform, config.updated reconfiguration, core stage/commit/guard/title hook registration, and idempotent teardown without stopping the host. No service discovery until a client is requested, no location-only sharing, no global configuration singleton, no parallel fake runtime, and no V1 compatibility facade.
//   DEPENDS: [node:crypto, @opencode/plugin, src/lib/config-layers.ts, src/runtime/client.ts, src/runtime/model-registry.ts, src/runtime/permissions.ts, src/runtime/snapshot-config.ts, src/runtime/snapshot-store.ts, src/runtime/snapshots.ts, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   acquireRuntime - Return a per-acquisition release lease for the runtime shared by one exact plugin context.
//   acquireSnapshotService - Return a per-acquisition release lease for the snapshot service shared by one exact plugin context and dependency instance.
//   NativeSnapshotContext - Narrow structural native Plugin.Context used to acquire the shared snapshot runtime.
//   NativeSnapshotRuntime - Documented shared native runtime: client, permissions, snapshots, effective config, model reload, role override and refresh.
//   acquireNativeSnapshotRuntime - Acquire the shared native snapshot runtime for an actual Plugin.Context.
//   ManagedNativeRuntime - Internal lifecycle-managed native runtime implementation.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-002 - Native inbox acceptance, canonical absent/default variants, creation-default provenance, one agent-aware workload resolver, suffix model/agent transforms with final-registry readback, created auxiliary children with title suppression, and per-family pending variants.]
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
import {
  applyAgentPolicies,
  applyVariantRegistrations,
  buildVariantRegistrations,
  primarySelection,
  qualifySelection,
} from "./model-registry.js";
import { createPermissionService } from "./permissions.js";
import {
  canonicalModelVariant,
  classifyInitialSelection,
  decodeInboxEnqueuedEvent,
  decodeModelSelectedEvent,
  decodeSessionCreatedEvent,
  effectiveRuntimeConfig,
  isAcceptedWorkloadEvent,
  isConfigUpdateEvent,
  normalizeModelSelection,
  parseRoleSelections,
} from "./snapshot-config.js";
import { createFileSnapshotStore } from "./snapshot-store.js";
import { createSnapshotService, type SnapshotServiceDeps } from "./snapshots.js";
import {
  RuntimeDisposedError,
  SnapshotAdmissionError,
  SnapshotUnboundError,
  runtimeIdentity,
  type AgentEditorLike,
  type AgentPolicyBinding,
  type AuxiliaryService,
  type CapturedModelSettings,
  type EffectiveRuntimeConfig,
  type ModelEditorLike,
  type ModelSelection,
  type NativeRuntime,
  type PermissionService,
  type RuntimeClient,
  type RuntimeContext,
  type RuntimeDeps,
  type RuntimeEvent,
  type RuntimeIdentity,
  type RuntimeLease,
  type RuntimeLocation,
  type SnapshotLease,
  type SnapshotService,
  type SnapshotStore,
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
  readonly location?: { readonly directory: unknown } | undefined;
  readonly model?:
    | { readonly id: unknown; readonly providerID: unknown; readonly variant?: unknown }
    | undefined;
  readonly agent?: unknown;
  readonly time?: { readonly idle?: number | undefined } | undefined;
  readonly tokens?:
    | { readonly input?: number | undefined; readonly output?: number | undefined }
    | undefined;
}

/** Structural native hook events used by the shared runtime. */
export interface NativeSnapshotHookEvents {
  prompt: { readonly sessionID: string };
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
    create(input: {
      readonly title?: string | undefined;
      readonly agent?: string | undefined;
      readonly model?:
        | { readonly id: string; readonly providerID: string; readonly variant?: string }
        | undefined;
      readonly location?: { readonly directory: string } | undefined;
    }): Promise<{ readonly id: string }>;
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

/** Structural full client needed for verified auxiliary lineage children. */
export interface NativeForkClient extends RuntimeClient {
  readonly session: {
    fork(input: { readonly sessionID: string }): Promise<{ readonly id: string }>;
  };
}

/** Optional injectable native boundaries for the shared snapshot runtime (tests only). */
export interface NativeSnapshotRuntimeOptions<Client extends NativeForkClient = OpenCodeClient> {
  readonly runtimeDeps?: RuntimeDeps<Client> | undefined;
  readonly store?: SnapshotStore | undefined;
  readonly now?: (() => number) | undefined;
}

/** Documented shared native runtime consumed by every later plugin. */
export interface NativeSnapshotRuntime<Client extends NativeForkClient = OpenCodeClient> {
  /** Native runtime with lazy authenticated full client and resource permissions. */
  readonly runtime: NativeRuntime<NativeSnapshotContext, Client>;
  /** Immutable family snapshot/config/model/auxiliary service. */
  readonly snapshots: SnapshotService;
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
  /** Reload persisted captures, variant registrations and native transforms. */
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
      if (ownVariantIds.has(String(variant.id))) continue;
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
  const hasActivity =
    info.time?.idle !== undefined ||
    (info.tokens !== undefined && (info.tokens.input ?? 0) + (info.tokens.output ?? 0) > 0);
  return {
    id: info.id,
    ...(parentID === undefined ? {} : { parentID }),
    ...(forkSessionID === undefined ? {} : { forkSessionID }),
    ...(locationDirectory === undefined ? {} : { locationDirectory }),
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(hasActivity ? { hasActivity: true } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
        ownedSessions: Map<string, ModelSelection>;
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
        ownedSessions: new Map(),
        suppressedTitles: new Set(),
      };

      const store =
        options?.store ?? createFileSnapshotStore({ scopeKey: ctx.location.project.id });

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
        for (const entry of entries) {
          const providerID = entry.providerID;
          const modelID = entry.id;
          if (typeof providerID !== "string" || typeof modelID !== "string") continue;
          if (wanted.size > 0 && !wanted.has(`${providerID}/${modelID}`)) continue;
          const overlay = (variant: string | undefined): CapturedModelSettings => ({
            providerID,
            modelID,
            ...(variant === undefined ? {} : { variant }),
            ...(isRecord(entry.settings) ? { settings: entry.settings } : {}),
            ...(isRecord(entry.body) ? { body: entry.body } : {}),
            ...(isRecord(entry.headers)
              ? { headers: entry.headers as Record<string, string> }
              : {}),
          });
          captured.push(overlay(undefined));
          if (Array.isArray(entry.variants)) {
            for (const variant of entry.variants) {
              if (!isRecord(variant) || typeof variant.id !== "string") continue;
              // Never re-capture our own generated variants (no accumulation).
              if (state.ownVariantIds.has(variant.id)) continue;
              captured.push(overlay(variant.id));
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
        const baseConfig: EffectiveRuntimeConfig = {
          ...vvoc,
          ...(rawIntent === undefined ? {} : { rawIntent }),
          ...(rootResolved === undefined ? {} : { rootDefault: rootResolved }),
          agentBindings: state.agentBindings,
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

      const deps: SnapshotServiceDeps = {
        store,
        ...(options?.now === undefined ? {} : { now: options.now }),
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
          create: async ({ title, agent, model, locationDirectory }) => {
            // A created child with explicit model/agent is the authentic native
            // binding path; a fork copies the parent agent and needs parent history.
            const created = await ctx.session.create({
              title,
              ...(agent === undefined ? {} : { agent }),
              ...(model === undefined ? {} : { model: toRef(model) }),
              location: { directory: locationDirectory },
            });
            const sessionID = String(created.id);
            if (sessionID.length > 0 && model !== undefined) {
              state.ownedSessions.set(sessionID, model);
            }
            return { sessionID };
          },
          switchModel: async ({ sessionID, model }) => {
            state.ownedSessions.set(sessionID, model);
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
      const materializeCandidate = async (
        capture: import("./types.js").FamilyCapture,
        selection: ModelSelection,
      ): Promise<void> => {
        if (selection.variant === undefined) return;
        // Materialize the staged family's variant before the switch so resolution finds it.
        state.pendingRegistrations.set(capture.familyId, buildVariantRegistrations([capture]));
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
          state.pendingRegistrations.delete(capture.familyId);
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

      /** Unbound candidate selection for a session's agent from the live policy. */
      const candidateTarget = (agentID: string | undefined): ModelSelection | undefined => {
        if (agentID !== undefined) {
          const binding = state.agentBindings.find((agent) => agent.agentID === agentID);
          if (binding?.selection !== undefined) return binding.selection;
        }
        const roleModels = parseRoleSelections(state.config.roles);
        if (roleModels.default !== undefined) return roleModels.default;
        if (state.config.rootDefault !== undefined) return state.config.rootDefault;
        for (const selection of Object.values(roleModels)) return selection;
        for (const binding of state.agentBindings) {
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
      ): ModelSelection | undefined => {
        if (!state.roleOverride) return capture.modelOverride ?? capture.rootSelection;
        const explicit = state.explicitSelections.get(sessionID);
        // An explicit user choice wins exactly as chosen; never re-qualify it with the
        // family variant, or the host-resolved request for that choice would mismatch.
        if (explicit !== undefined) return normalizeModelSelection(explicit);
        return expectedSelection(capture, agentID);
      };

      /** Commit a staged candidate for an already-accepted workload before use. */
      const reconcileAcceptedFamily = async (sessionID: string): Promise<void> => {
        if ((await snapshots.policy(sessionID)) !== undefined) return;
        const familyId = await snapshots.familyOf(sessionID);
        if (!(await snapshots.hasStaged(familyId))) return;
        const outcome = await snapshots.commit(familyId);
        if (outcome.status === "bound") await refresh();
      };

      const stageFor = async (sessionID: string): Promise<void> => {
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

        const existing = await snapshots.policy(sessionID);
        if (existing !== undefined) {
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
        // A candidate already staged for this family is being committed; do not
        // rewrite it and race the commit-removal.
        const familyId = await snapshots.familyOf(sessionID);
        if (await snapshots.hasStaged(familyId)) return;

        const explicitSelection = intent.mode === "explicit" ? intent.literal : undefined;
        const target = explicitSelection ?? candidateTarget(view.agent);
        const base = state.roleOverride ? target : (sessionModel ?? target);
        // The agent-aware resolved target drives staging, not the capture's default
        // role; when role overriding is off the session's current model is bound.
        const selectionOverride =
          explicitSelection === undefined && base !== undefined ? base : undefined;
        const outcome = await snapshots.stage(
          {
            sessionID,
            directory: ctx.location.directory,
            location: runtimeIdentity(ctx.location),
            ...(explicitSelection === undefined ? {} : { explicit: explicitSelection }),
            ...(selectionOverride === undefined ? {} : { selectionOverride }),
            ...(sessionModel === undefined ? {} : { before: sessionModel }),
            force: state.roleOverride,
          },
          async (capture, selection) => {
            await materializeCandidate(capture, selection);
            state.pluginSwitches.set(sessionID, selection);
          },
        );
        if (outcome.status === "rejected") {
          throw new SnapshotAdmissionError(
            outcome.error ?? `Admission for ${sessionID} did not produce a persisted policy.`,
          );
        }
      };

      const guardResolvedModel = async (
        sessionID: string,
        agentID: string | undefined,
        actual: ModelSelection | undefined,
        kind: string,
      ): Promise<void> => {
        await ensureTransforms();
        // An auxiliary child we created and bound is admitted by construction.
        const owned = state.ownedSessions.get(sessionID);
        if (owned !== undefined) {
          if (!selectionMatches(actual, owned)) {
            throw new SnapshotAdmissionError(
              `Resolved ${kind} model does not match the auxiliary session binding.`,
            );
          }
          return;
        }
        if (kind === "title" && state.suppressedTitles.has(sessionID)) {
          // The title hook already supplied the result; the host still runs this
          // hook before it checks `result`, so a refused dispatch here would fail
          // a title that never reaches the provider.
          state.suppressedTitles.delete(sessionID);
          return;
        }
        const familyId = await snapshots.familyOf(sessionID);
        const capture = await snapshots.policy(sessionID);
        if (capture !== undefined) {
          const expected =
            kind === "title"
              ? titleExpectedSelection(capture)
              : expectedForSession(capture, agentID, sessionID);
          if (!selectionMatches(actual, expected)) {
            throw new SnapshotAdmissionError(
              `Resolved ${kind} model ${actual?.providerID ?? "?"}/${actual?.modelID ?? "?"} does not match the captured family selection for ${familyId}.`,
            );
          }
          return;
        }
        // No committed capture yet. A staged candidate in this family may be
        // committed here because model.request only runs during an already
        // accepted execution; otherwise the work is unbound and refused.
        if (await snapshots.hasStaged(familyId)) {
          const outcome = await snapshots.commit(familyId);
          if (outcome.status === "rejected") {
            throw new SnapshotAdmissionError(outcome.error ?? "Snapshot commit was rejected.");
          }
          const committed = await snapshots.policy(sessionID);
          const expected =
            committed === undefined ? undefined : expectedForSession(committed, agentID, sessionID);
          if (!selectionMatches(actual, expected)) {
            throw new SnapshotAdmissionError(
              `Resolved ${kind} model does not match the committed family selection.`,
            );
          }
          await refresh();
          return;
        }
        throw new SnapshotUnboundError(
          `Refusing unbound ${kind} dispatch for session ${sessionID} before a family policy is bound.`,
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
      owned.push(await ctx.session.hook("prompt", (event) => stageFor(event.sessionID)));
      owned.push(await ctx.session.hook("context", (event) => stageFor(event.sessionID)));
      // `generate` resolves its model before the hook runs, so staging here is too
      // late; owned generate paths pre-admit through the snapshot service/RPC and
      // the hook only validates or refuses a truly unbound dispatch.
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
          // The host resolved and may dispatch the title before the event pump has
          // committed the accepted candidate; reconcile it so title work is bound.
          await reconcileAcceptedFamily(event.sessionID);
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
      // refresh and the accepted-input boundary all share a single subscription.
      const pump = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: lifecycle.signal })) {
            const created = decodeSessionCreatedEvent(event);
            if (created !== undefined) {
              state.creationModels.set(created.sessionID, created.model);
              // Record the default in force at creation, not a later changed default.
              state.creationDefaults.set(created.sessionID, state.nativeDefault);
            }
            const selected = decodeModelSelectedEvent(event);
            if (selected !== undefined) {
              const pluginSwitch = state.pluginSwitches.get(selected.sessionID);
              if (pluginSwitch === undefined || !sameModelSelection(selected.model, pluginSwitch)) {
                // The host emits this only for a real change, so it is a user choice.
                state.explicitSelections.set(selected.sessionID, selected.model);
              }
            }
            if (isConfigUpdateEvent(event)) {
              state.config = await readConfig(ctx.location.directory);
              await refresh();
            }
            if (isAcceptedWorkloadEvent(event)) {
              const enqueued = decodeInboxEnqueuedEvent(event);
              const sessionID = enqueued?.sessionID ?? readEventSessionID(event);
              if (sessionID === undefined) continue;
              const familyId = await snapshots.familyOf(sessionID);
              if (await snapshots.hasStaged(familyId)) {
                const outcome = await snapshots.commit(familyId);
                if (outcome.status === "bound") await refresh();
              }
            }
          }
        } catch (error) {
          // A closed/failed native stream is recorded, never silently swallowed.
          state.configError = error instanceof Error ? error.message : String(error);
        }
      })();
      void pump;

      await refresh();

      return {
        runtime,
        snapshots,
        auxiliary: snapshots.auxiliary,
        client: () => runtime.client(),
        permissions: runtime.permissions,
        effectiveConfig: () => state.config,
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

function readEventSessionID(event: RuntimeEvent): string | undefined {
  const data = event.data;
  if (!isRecord(data)) return undefined;
  return typeof data.sessionID === "string" ? data.sessionID : undefined;
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
