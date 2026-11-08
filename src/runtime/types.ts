// FILE: src/runtime/types.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the shared native runtime vocabulary: the supported host window and service-compatibility predicate, structural plugin-context seams, resource-permission contracts, and the session/auxiliary/agent-binding contracts consumed by native plugins.
//   SCOPE: Type-only native contracts plus pure location/identity/key helpers and error constructors. No service discovery, authentication, RPC registration, permission flow, settings persistence, filesystem, or network I/O.
//   DEPENDS: [@opencode/plugin, @opencode/client, @opencode/schema/agent, @opencode/schema/location, @opencode/schema/permission, @opencode/schema/rpc, @opencode/schema/session, src/lib/host-compat.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: TYPES
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SUPPORTED_SERVICE_RANGE - Human-readable native OpenCode host window this runtime accepts.
//   isSupportedServiceVersion - Native service-version predicate handed to discovery.
//   DeepMutable - Local recursive mutable projection of a readonly native schema type.
//   RuntimeLocation - Structural subset of Location.Info the runtime needs for identity and routing.
//   RuntimeIdentity - Stable per-location identity used to share one runtime inside a host.
//   RuntimeRpcRegistration - Releasable native RPC registration handle.
//   RuntimeRpcRegistrar - Narrow structural view of the native plugin context RPC registrar.
//   RuntimeContext - Narrow structural view of a native Plugin.Context used to acquire a runtime.
//   RuntimeRpcCallOptions - Location and cancellation options for an authenticated client RPC call.
//   RuntimeRpcMethods - Method map projected from a portable RPC definition.
//   RuntimeRpcClient - Callable projection of an authenticated native client RPC.
//   RuntimeEvent - Structural native event envelope.
//   RuntimeEventApi - Structural native live-event subscription API.
//   RuntimePermissionApi - Structural native session permission create/get/reply API.
//   RuntimeClient - Structural subset of the native client used by the runtime foundation.
//   RuntimeEndpoint - Native local-service endpoint handed to a full client.
//   RuntimeDeps - Injectable native boundary: discovery, auth headers, and full-client construction.
//   ResourcePermissionRequest - Resource-specific permission request passed to the native host.
//   PermissionDecision - Terminal permission decision: allow or deny.
//   PermissionRequestOptions - Cancellation and bounded-readiness options for an awaited permission decision.
//   PermissionService - Awaited resource permission service consumed before side effects.
//   NativeRuntime - Shared lifecycle-managed native runtime exposed to later plugins.
//   RuntimeLease - Per-acquisition idempotent release handle for a shared runtime.
//   RuntimeUnavailableError - No compatible already-running service could be discovered.
//   RuntimeChallengeError - The discovered service did not prove the loading plugin instance.
//   RuntimeDisposedError - The runtime was released and can no longer serve work.
//   PERMISSION_REPLIED_EVENT - Native event type carrying a terminal permission reply.
//   SERVER_CONNECTED_EVENT - Native event proving the live event transport finished its handshake.
//   ModelSelection - Concrete native provider/model/variant selection.
//   CapturedVvocConfig - Config-shaped vvoc policy value used by a resolved family view.
//   PermissionCreateInput - Minimal input accepted by the native permission create call.
//   AgentPolicyBinding - Captured agent-to-role and resolved-model binding.
//   NativeSessionView - Structural native session view used for host-verified lineage.
//   ModelEditorLike - Structural native model transform editor used for default-model overrides.
//   AgentEditorLike - Structural native agent transform editor used for role-policy application.
//   EffectiveRuntimeConfig - Structural effective vvoc policy input consumed by the runtime.
//   AuxiliaryMessageContent - Text carried by a native title request as generation input.
//   AuxiliarySessionApi - Structural native child-session/generate boundary for auxiliary work.
//   AuxiliaryWorkloadMetadata - Host-owned auxiliary workload metadata recorded on a child session.
//   decodeAuxiliaryMetadata - Decode the auxiliary workload metadata from native session metadata.
//   NativeSessionImportPayload - Typed payload forwarded to the native import route for a parented auxiliary child.
//   decodeImportedSessionID - Decode the id of an imported native session from the unchecked client result.
//   AuxiliaryService - Family-settings-bound auxiliary generation consumed by title and Guardian.
//   runtimeIdentity - Build the stable identity from a runtime location.
//   runtimeKey - Render a deterministic location identity string for diagnostics.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SESSION-OWNED-SETTINGS T-002 - Removed the snapshot vocabulary (family capture, staged candidates, admission/guard/store contracts and error classes) and slimmed EffectiveRuntimeConfig; session-owned settings types live in session-settings.ts.]
//   PREVIOUS: [C-HOST-COMPAT-WINDOW T-002 - Replaced the exact SUPPORTED_SERVICE_VERSION string with the host-compat window predicate: discovery now accepts any stable host inside the supported major-bounded window, and DeepMutable is owned locally because the host package no longer ships @opencode/plugin/promise/types.]
// END_CHANGE_SUMMARY

import type {
  OpenCodeClient,
  PermissionEffect,
  PermissionGetInput,
  PermissionGetOutput,
  PermissionReplyInput,
} from "@opencode/client";
import type { Rpc } from "@opencode/schema/rpc";
import type { RpcHandlers } from "@opencode/plugin/promise/rpc";
import {
  isSupportedOpenCodeVersion,
  SUPPORTED_OPENCODE_VERSION_RANGE,
} from "../lib/host-compat.js";
import type { RawOpenCodeModelIntent } from "../lib/config-layers.js";
import type { VvocConfig } from "../lib/vvoc-config.js";
import type { Agent } from "@opencode/schema/agent";
import type { Model } from "@opencode/schema/model";
import type { Permission } from "@opencode/schema/permission";
import type { Session } from "@opencode/schema/session";

/** Human-readable native host window this runtime accepts. */
export const SUPPORTED_SERVICE_RANGE = SUPPORTED_OPENCODE_VERSION_RANGE;

/** Native service-version predicate handed to discovery; accepts any stable host inside the window. */
export function isSupportedServiceVersion(version: string): boolean {
  return isSupportedOpenCodeVersion(version);
}

/**
 * Recursive mutable projection of a readonly native schema type. Owned here
 * because the native host package no longer exports a shared helper module for
 * it; the projection is structural and carries no host runtime behavior.
 */
export type DeepMutable<T> = T extends readonly (infer Element)[]
  ? DeepMutable<Element>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

/** Native event type carrying a terminal permission reply. */
export const PERMISSION_REPLIED_EVENT = "permission.replied";

/** Native event proving the live event transport finished its handshake. */
export const SERVER_CONNECTED_EVENT = "server.connected";

/**
 * Structural subset of `Location.Info` the runtime needs. The native
 * `Location.Info` class satisfies it, and tests can build plain objects.
 */
export interface RuntimeLocation {
  readonly directory: string;
  readonly workspaceID?: string | undefined;
  readonly project: {
    readonly id: string;
    readonly directory: string;
    readonly canonical: string;
  };
}

/** Stable per-location identity used to share one runtime inside a host. */
export interface RuntimeIdentity {
  readonly directory: string;
  readonly workspaceID?: string | undefined;
  readonly projectID: string;
  readonly canonical: string;
}

/** Releasable native RPC registration handle. Disposing it never stops the host. */
export interface RuntimeRpcRegistration {
  dispose(): Promise<void> | void;
}

/** Narrow structural view of the native plugin context RPC registrar. */
export interface RuntimeRpcRegistrar {
  register<const D extends Rpc.PortableDefinition>(
    definition: D,
    handlers: RpcHandlers<NoInfer<D>>,
  ): Promise<RuntimeRpcRegistration>;
}

/**
 * Narrow structural view of a native `Plugin.Context` used to acquire a
 * runtime. A real `Plugin.Context` satisfies it; the full context stays with
 * the owning plugin.
 */
export interface RuntimeContext {
  readonly location: RuntimeLocation;
  readonly rpc: RuntimeRpcRegistrar;
  /**
   * Native app object copied from the host instance, used only as a cross-context
   * coordination identity. Optional so a context without it still acquires a
   * runtime; distinct contexts copied from one host share the same app reference.
   */
  readonly app?: object | undefined;
}

/** Location and cancellation options for an authenticated client RPC call. */
export interface RuntimeRpcCallOptions {
  readonly location?: { readonly directory?: string | undefined } | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Method map projected from a portable RPC definition. */
export type RuntimeRpcMethods<D extends Rpc.PortableDefinition> = {
  readonly [Name in keyof D["methods"]]: (
    input: Rpc.Input<D["methods"][Name]["input"]>,
    options?: RuntimeRpcCallOptions,
  ) => Promise<Rpc.Output<D["methods"][Name]["output"]>>;
};

/** Callable projection of an authenticated native client RPC. */
export interface RuntimeRpcClient {
  <D extends Rpc.PortableDefinition>(definition: D): RuntimeRpcMethods<D>;
}

/** Structural native event envelope. */
export interface RuntimeEvent {
  readonly type: string;
  readonly data?: unknown;
  /** Native event creation time in epoch milliseconds, when supplied. */
  readonly created?: unknown;
  /** Native durable envelope carrying the per-aggregate sequence. */
  readonly durable?: { readonly aggregateID?: unknown; readonly seq?: unknown } | undefined;
}

/** Structural native live-event subscription API. */
export interface RuntimeEventApi {
  subscribe(options?: { readonly signal?: AbortSignal | undefined }): AsyncIterable<RuntimeEvent>;
}

/** Structural native session permission create/get/reply API. */
export interface RuntimePermissionApi {
  create(
    input: PermissionCreateInput,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<{ readonly id: string; readonly effect: PermissionEffect }>;
  get(
    input: PermissionGetInput,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<PermissionGetOutput>;
  reply(
    input: PermissionReplyInput,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<void>;
}

/** Minimal input accepted by `permission.create`, kept in sync with the native contract. */
export interface PermissionCreateInput {
  readonly sessionID: string;
  readonly id?: string | null | undefined;
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
  readonly save?: ReadonlyArray<string> | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly source?: Permission.Source | undefined;
  readonly agent?: string | null | undefined;
}

/**
 * Structural subset of the native client used by the runtime foundation. The
 * full `OpenCodeClient` satisfies it, and later plugins receive the full client
 * from the default runtime.
 */
export interface RuntimeClient {
  readonly rpc: RuntimeRpcClient;
  readonly permission: RuntimePermissionApi;
  readonly event: RuntimeEventApi;
}

/** Native local-service endpoint handed to a full client. Never log its credentials. */
export interface RuntimeEndpoint {
  readonly url: string;
  readonly auth?:
    | {
        readonly type: "basic";
        readonly username: string;
        readonly password: string;
      }
    | undefined;
}

/**
 * Injectable native boundary. The default implementation uses
 * `Service.discover`/`Service.headers`/`OpenCode.make`; tests provide faithful
 * in-memory implementations.
 */
export interface RuntimeDeps<Client extends RuntimeClient = OpenCodeClient> {
  /** Required service version: an exact string or a compatibility predicate. */
  readonly serviceVersion: string | ((version: string) => boolean);
  /** Discover a healthy, compatible already-running service; never starts one. */
  discoverService(options: {
    readonly version: string | ((version: string) => boolean);
  }): Promise<RuntimeEndpoint | undefined>;
  /** Create native basic-auth headers from the service registration. */
  serviceHeaders(endpoint: RuntimeEndpoint): Record<string, string> | undefined;
  /** Build the full native client for the discovered endpoint. */
  makeClient(options: {
    readonly baseUrl: string;
    readonly headers?: Record<string, string> | undefined;
  }): Client;
}

/** Resource-specific permission request passed to the native host. */
export interface ResourcePermissionRequest {
  readonly sessionID: Session.ID;
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
  readonly save?: ReadonlyArray<string> | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly source?: Permission.Source | undefined;
  readonly agent?: Agent.ID | undefined;
}

/** Terminal permission decision: allow or deny. */
export type PermissionDecision = "allow" | "deny";

/** Cancellation and bounded-readiness options for an awaited permission decision. */
export interface PermissionRequestOptions {
  readonly signal?: AbortSignal | undefined;
  /**
   * Bounds how long to wait for the native event transport handshake before the
   * request is created. Defaults to `DEFAULT_PERMISSION_READINESS_TIMEOUT_MS`.
   */
  readonly readinessTimeoutMs?: number | undefined;
}

/**
 * Awaited resource permission service. `request` creates the native request and
 * waits for its terminal state; `guard` runs a side effect only after a
 * terminal allow.
 */
export interface PermissionService {
  request(
    input: ResourcePermissionRequest,
    options?: PermissionRequestOptions,
  ): Promise<PermissionDecision>;
  guard<T>(
    input: ResourcePermissionRequest,
    effect: () => Promise<T> | T,
    options?: PermissionRequestOptions,
  ): Promise<T>;
}

/**
 * Shared lifecycle-managed native runtime. `client()` is lazy: acquiring a
 * runtime neither discovers a service nor registers an RPC, so an unused plugin
 * never depends on host service availability. Sharing is scoped to the exact
 * plugin context object, never to a bare cwd.
 */
export interface NativeRuntime<
  Context extends RuntimeContext = RuntimeContext,
  Client extends RuntimeClient = OpenCodeClient,
> {
  /** The native plugin context this runtime was acquired from. */
  readonly context: Context;
  /** The native plugin location this runtime is bound to. */
  readonly location: RuntimeLocation;
  /** Stable identity used for diagnostics; equal locations may still differ by context. */
  readonly identity: RuntimeIdentity;
  /** Random per-runtime challenge identity; distinct contexts never share it. */
  readonly instanceId: string;
  /** Lazily discover, authenticate, and challenge the full native client. */
  client(): Promise<Client>;
  /** Resource permission service bound to this runtime's authenticated client. */
  readonly permissions: PermissionService;
  /** Force disposal of runtime-owned registrations and subscriptions. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Per-acquisition release handle. Each `acquireRuntime` call yields its own
 * handle, and releasing the same handle twice never affects another consumer's
 * live runtime.
 */
export interface RuntimeLease<
  Context extends RuntimeContext = RuntimeContext,
  Client extends RuntimeClient = OpenCodeClient,
> {
  readonly runtime: NativeRuntime<Context, Client>;
  /** Idempotent for this lease; disposes the runtime only when the last lease releases. */
  release(): Promise<void>;
}

/** No compatible already-running service could be discovered. */
export class RuntimeUnavailableError extends Error {
  readonly code = "RUNTIME_UNAVAILABLE";

  constructor() {
    super(
      `No compatible OpenCode ${SUPPORTED_SERVICE_RANGE} service is registered for this plugin instance.`,
    );
    this.name = "RuntimeUnavailableError";
  }
}

/** The discovered service did not prove the loading plugin instance and location. */
export class RuntimeChallengeError extends Error {
  readonly code = "RUNTIME_CHALLENGE_FAILED";

  constructor(reason: string, options?: ErrorOptions) {
    super(
      `Native runtime challenge failed: ${reason}. The discovered service is not this loading plugin instance.`,
      options,
    );
    this.name = "RuntimeChallengeError";
  }
}

/** The runtime was released and can no longer serve work. */
export class RuntimeDisposedError extends Error {
  readonly code = "RUNTIME_DISPOSED";

  constructor() {
    super("The native runtime has been released.");
    this.name = "RuntimeDisposedError";
  }
}

// START_BLOCK_SNAPSHOT_VOCABULARY
/** Concrete native provider/model/variant selection. */
export interface ModelSelection {
  readonly providerID: string;
  readonly modelID: string;
  readonly variant?: string | undefined;
}

/** Deep-copied, schema-validated effective vvoc configuration captured for replay. */
export type CapturedVvocConfig = VvocConfig;

/** Captured agent-to-role and resolved-model binding. */
export interface AgentPolicyBinding {
  readonly agentID: string;
  readonly role?: string | undefined;
  readonly selection?: ModelSelection | undefined;
}

/** Structural native session view used for host-verified lineage and provenance. */
export interface NativeSessionView {
  readonly id: string;
  readonly parentID?: string | undefined;
  readonly forkSessionID?: string | undefined;
  readonly locationDirectory?: string | undefined;
  readonly model?: ModelSelection | undefined;
  /** Selected agent id, used to resolve agent-specific captured roles. */
  readonly agent?: string | undefined;
  /**
   * Host-persisted session metadata. Auxiliary children record their intended
   * role/kind here so the intended selection is recoverable after a restart
   * without an ephemeral in-process exemption.
   */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  /** True once the session has produced or received work, so a missing capture is not "fresh". */
  readonly hasActivity?: boolean | undefined;
}

/**
 * Structural native model transform editor used for default-model overrides.
 * The native `ModelEditor` callback parameter satisfies it exactly, so plugin
 * code passes the native editor without a cast.
 */
export interface ModelEditorLike {
  list(providerID?: string): readonly DeepMutable<Model.Info>[];
  get(providerID: string, modelID: string): DeepMutable<Model.Info> | undefined;
  update(
    providerID: string,
    modelID: string,
    update: (model: DeepMutable<Model.Info>) => void,
  ): void;
  /** Native default-model handle used to drive future-session provenance. */
  readonly default: {
    get(): { readonly providerID: string; readonly modelID: string } | undefined;
    set(providerID: string, modelID: string): void;
  };
}

/**
 * Structural native agent transform editor used for role-policy application.
 * The native `AgentEditor` callback parameter satisfies it exactly.
 */
export interface AgentEditorLike {
  list(): readonly DeepMutable<Agent.Info>[];
  get(id: string): DeepMutable<Agent.Info> | undefined;
  update(id: string, update: (agent: DeepMutable<Agent.Info>) => void): void;
}

/** Structural effective vvoc policy input consumed by the runtime. */
export interface EffectiveRuntimeConfig {
  readonly roles: Readonly<Record<string, string>>;
  /** Agent-to-role bindings managed by vvoc for built-in and bundled agents. */
  readonly agentRoles: Readonly<Record<string, string>>;
  /** Full effective vvoc document available to consumers. */
  readonly vvoc: CapturedVvocConfig;
  /** Native agent bindings (including custom agents) observed from the host editor. */
  readonly agentBindings?: ReadonlyArray<AgentPolicyBinding> | undefined;
  /** Current host default model. */
  readonly nativeDefault?: ModelSelection | undefined;
  /** Raw OpenCode model intent preserved before native normalization. */
  readonly rawIntent?: RawOpenCodeModelIntent | undefined;
  /** Implicit root selection resolved from raw OpenCode root model intent. */
  readonly rootDefault?: ModelSelection | undefined;
  readonly sourcePath?: string | undefined;
}

/**
 * Structural native auxiliary-session/generate boundary. Production creates a
 * real parented native child through the authenticated full client's
 * `session.import` (an imported session with a parentID, not a fork that copies
 * the parent agent or the plugin subset's parentless `session.create`).
 */
export interface AuxiliarySessionApi {
  create(input: {
    /** Family root the imported child is parented to; `get(child).parentID` must equal it. */
    readonly parentID: string;
    /** Directory the child is created in; reused from the family root. */
    readonly locationDirectory: string;
    /** Nonempty child title. */
    readonly title: string;
    /** Workload kind recorded in host-owned metadata for restart recovery. */
    readonly kind: "title" | "compaction" | "generate";
    /** Family role whose selection the child is bound to, when known. */
    readonly role?: string | undefined;
    /** Resolved family selection applied to the child. */
    readonly model: ModelSelection;
    /** Optional family agent id to bind. */
    readonly agent?: string | undefined;
  }): Promise<{ readonly sessionID: string }>;
  switchModel(input: { readonly sessionID: string; readonly model: ModelSelection }): Promise<void>;
  generate(input: {
    readonly sessionID: string;
    readonly prompt: string;
  }): Promise<{ readonly text: string }>;
}

/**
 * Host-owned metadata recorded on an auxiliary child so its intended role and
 * selection are recoverable after restart without a model-only exemption.
 */
export interface AuxiliaryWorkloadMetadata {
  readonly kind: "title" | "compaction" | "generate";
  readonly role?: string | undefined;
}

/** Decode the auxiliary workload metadata embedded in native session metadata. */
export function decodeAuxiliaryMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): AuxiliaryWorkloadMetadata | undefined {
  if (metadata === undefined) return undefined;
  const raw = metadata["vvocAuxiliary"];
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "title" && kind !== "compaction" && kind !== "generate") return undefined;
  const role = record.role;
  if (role !== undefined && typeof role !== "string") return undefined;
  return { kind, ...(role === undefined ? {} : { role }) };
}

/** Typed payload forwarded to the native import route for a parented auxiliary child. */
export interface NativeSessionImportPayload {
  readonly info: {
    readonly id: string;
    readonly parentID: string;
    readonly projectID: string;
    readonly agent?: string | undefined;
    readonly model?:
      | { readonly id: string; readonly providerID: string; readonly variant?: string }
      | undefined;
    readonly cost: number;
    readonly tokens: {
      readonly input: number;
      readonly output: number;
      readonly reasoning: number;
      readonly cache: { readonly read: number; readonly write: number };
    };
    readonly time: { readonly created: number; readonly updated: number };
    readonly title: string;
    readonly location: { readonly directory: string };
    readonly metadata?: Readonly<Record<string, unknown>> | undefined;
    readonly permissions?:
      | ReadonlyArray<{
          readonly action: string;
          readonly resource: string;
          readonly effect: "allow" | "deny" | "ask";
        }>
      | undefined;
  };
  readonly messages: ReadonlyArray<unknown>;
  readonly location: { readonly directory: string };
}

/** Decode the id of an imported native session from the unchecked client result. */
export function decodeImportedSessionID(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Text carried by a native title request, retained as generation input. */
export interface AuxiliaryMessageContent {
  readonly role: string;
  readonly text: string;
}

/** Family-settings-bound auxiliary generation consumed by title and Guardian. */
export interface AuxiliaryService {
  /** Resolve a title through a bound child; a set event.result always wins. */
  title(event: {
    readonly sessionID: string;
    result?: string | undefined;
    /** Native title messages retained as generation input, never dropped. */
    readonly messages?: ReadonlyArray<AuxiliaryMessageContent> | undefined;
    /** Family role to use (title/small_model), never an implicit primary fallback. */
    readonly role?: string | undefined;
  }): Promise<string | undefined>;
  /** Run settings-bound auxiliary generation for the given request kind and role. */
  generate(input: {
    readonly sessionID: string;
    readonly kind: "title" | "compaction" | "generate";
    readonly prompt: string;
    /** Family role to use (for example Guardian's fast role); defaults to primary. */
    readonly role?: string | undefined;
  }): Promise<{ readonly text: string } | undefined>;
}
// END_BLOCK_SNAPSHOT_VOCABULARY

// START_BLOCK_IDENTITY_HELPERS
/** Build the stable identity from a runtime location. */
export function runtimeIdentity(location: RuntimeLocation): RuntimeIdentity {
  return {
    directory: location.directory,
    ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }),
    projectID: location.project.id,
    canonical: location.project.canonical,
  };
}

/** Render a deterministic location identity string for diagnostics. */
export function runtimeKey(identity: RuntimeIdentity): string {
  return [
    identity.directory,
    identity.workspaceID ?? "",
    identity.projectID,
    identity.canonical,
  ].join("\u0000");
}
// END_BLOCK_IDENTITY_HELPERS
