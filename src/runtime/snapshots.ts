// FILE: src/runtime/snapshots.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Bind each native session family to one credential-free, content-addressed behaviour policy at its first workload and materialize that stable policy with live credentials and native overlays for plugin consumers.
//   SCOPE: Host-verified family resolution, per-family serialized bind/rehydrate/rebind/delete lifecycle, fail-soft binding-store recovery, reference-counted garbage collection, live credential attachment, variant derivation, and the SnapshotService consumed by native plugins. No candidate staging, accepted-input ordering, cross-context publication, host discovery, client authentication, or stateless generation.
//   DEPENDS: [src/runtime/auxiliary.ts, src/runtime/coordination.ts, src/runtime/model-registry.ts, src/runtime/snapshot-config.ts, src/runtime/snapshot-store.ts, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MAX_LINEAGE_HOPS - Bound on host-verified parent/fork lineage traversal.
//   SnapshotServiceDeps - Injectable host and durable-binding boundaries.
//   resolveSessionFamily - Resolve a session's family root through host-verified lineage.
//   createSnapshotService - Build the credential-safe family-binding service for one native context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SNAPSHOT-ANCHORING-REDESIGN T-004/T-005/T-006 - Replaced staged candidate capture with fail-soft, per-family content-addressed bindings that rehydrate across restart, consume pending CLI force-rebind markers, clean up on deletion, and attach credentials only in memory.]
// END_CHANGE_SUMMARY

import { createAuxiliaryService } from "./auxiliary.js";
import type { HostCoordination } from "./coordination.js";
import { managedVariantFor, primarySelection, qualifySelection } from "./model-registry.js";
import {
  behaviourContentHash,
  buildBehaviourProjection,
  type BehaviourProjection,
} from "./snapshot-config.js";
import { FileBindingStore, type FamilyBindingRecord } from "./snapshot-store.js";
import {
  listRebindRequests,
  rebindRequestMatches,
  type RebindRequest,
} from "../lib/rebind-request.js";
import {
  SnapshotAdmissionError,
  type AdmissionOutcome,
  type CapturedModelSettings,
  type EffectiveRuntimeConfig,
  type FamilyCapture,
  type ModelSelection,
  type ModelVariantCapture,
  type NativeSessionView,
  type RuntimeIdentity,
  type SnapshotAcceptRequest,
  type SnapshotAdmissionRequest,
  type SnapshotService,
  type VariantRegistration,
} from "./types.js";

/** Bound on host-verified parent/fork lineage traversal. */
export const MAX_LINEAGE_HOPS = 64;

type BindingStore = Pick<
  FileBindingStore,
  | "writeSnapshot"
  | "readSnapshot"
  | "writeBinding"
  | "readBinding"
  | "removeBinding"
  | "listBindings"
  | "listSnapshots"
  | "removeSnapshot"
  | "countBindings"
>;

/** Injectable host and durable-binding boundaries for the snapshot service. */
export interface SnapshotServiceDeps {
  readonly store: BindingStore;
  readonly location: RuntimeIdentity;
  loadConfig(directory: string): Promise<EffectiveRuntimeConfig>;
  /** Host-verified session view; never model-supplied identity. */
  readSession(sessionID: string): Promise<NativeSessionView | undefined>;
  readSessionModel(sessionID: string): Promise<ModelSelection | undefined>;
  switchModel(input: { readonly sessionID: string; readonly model: ModelSelection }): Promise<void>;
  readonly auxiliarySession: import("./types.js").AuxiliarySessionApi;
  now?(): number;
  /** Optional bounded, credential-safe diagnostic sink. */
  diagnostic?(message: string): void;
  /** Optional shared per-family lock for distinct plugin contexts in one host. */
  readonly coordination?: HostCoordination | undefined;
  /** Optional pending rebind-request reader; defaults to the CLI marker directory. */
  readonly rebindRequests?: (() => Promise<readonly RebindRequest[]>) | undefined;
}

function variantIdFor(
  snapshotId: string,
  modelID: string,
  sourceVariant: string | undefined,
): string {
  return sourceVariant === undefined
    ? `${snapshotId}.${modelID}`
    : `${snapshotId}.${modelID}.${sourceVariant}`;
}

function variantOverlayFor(
  selection: ModelSelection,
  modelSettings: ReadonlyArray<CapturedModelSettings>,
): Pick<ModelVariantCapture, "settings" | "body" | "headers"> {
  const match = modelSettings.find(
    (settings) =>
      settings.providerID === selection.providerID &&
      settings.modelID === selection.modelID &&
      (selection.variant === undefined || settings.variant === selection.variant),
  );
  return {
    ...(match?.settings === undefined ? {} : { settings: match.settings }),
    ...(match?.body === undefined ? {} : { body: match.body }),
    ...(match?.headers === undefined ? {} : { headers: match.headers }),
  };
}

function buildVariants(
  snapshotId: string,
  selections: Readonly<Record<string, ModelSelection>>,
  modelSettings: ReadonlyArray<CapturedModelSettings>,
): ModelVariantCapture[] {
  const byKey = new Map<string, ModelVariantCapture>();
  for (const selection of Object.values(selections)) {
    const overlay = variantOverlayFor(selection, modelSettings);
    const managed = managedVariantFor(selection, snapshotId);
    const hasOverlay =
      overlay.settings !== undefined || overlay.body !== undefined || overlay.headers !== undefined;
    if (!hasOverlay && managed === undefined) continue;
    const sourceVariant = managed?.sourceVariant ?? selection.variant;
    const body = { ...overlay.body, ...managed?.body };
    const key = `${selection.providerID}\u0000${selection.modelID}\u0000${sourceVariant ?? ""}`;
    byKey.set(key, {
      id: variantIdFor(snapshotId, selection.modelID, sourceVariant),
      providerID: selection.providerID,
      modelID: selection.modelID,
      ...(sourceVariant === undefined ? {} : { sourceVariant }),
      ...(overlay.settings === undefined ? {} : { settings: overlay.settings }),
      ...(Object.keys(body).length === 0 ? {} : { body }),
      ...(overlay.headers === undefined ? {} : { headers: overlay.headers }),
    });
  }
  return [...byKey.values()];
}

/** Attach only live credential fields; the stored projection never carries them. */
function policyWithLiveCredentials(
  projection: BehaviourProjection,
  live: EffectiveRuntimeConfig | undefined,
): FamilyCapture["vvoc"] {
  const policy = structuredClone(projection.policy);
  if (live === undefined) return policy;
  policy.secretsRedaction = {
    ...policy.secretsRedaction,
    secret: live.vvoc.secretsRedaction.secret,
  };
  const searchKey = live.vvoc.web?.search?.apiKey;
  const fetchKey = live.vvoc.web?.fetch?.apiKey;
  if (searchKey !== undefined || fetchKey !== undefined) {
    policy.web = {
      ...policy.web,
      ...(searchKey === undefined ? {} : { search: { ...policy.web?.search, apiKey: searchKey } }),
      ...(fetchKey === undefined ? {} : { fetch: { ...policy.web?.fetch, apiKey: fetchKey } }),
    };
  }
  return policy;
}

function materializeCapture(input: {
  readonly familyId: string;
  readonly binding: FamilyBindingRecord;
  readonly projection: BehaviourProjection;
  readonly location: RuntimeIdentity;
  readonly live?: EffectiveRuntimeConfig | undefined;
}): FamilyCapture {
  const snapshotId = input.binding.snapshotHash.slice(0, 16);
  const modelSettings = input.live?.modelSettings ?? [];
  return {
    schemaVersion: 1,
    snapshotId,
    integrity: input.binding.snapshotHash,
    familyId: input.familyId,
    capturedAt: Date.parse(input.binding.boundAt) || 0,
    location: input.location,
    roles: input.projection.policy.roles,
    roleModels: input.projection.roleModels,
    agents: input.projection.agentBindings,
    variants: buildVariants(snapshotId, input.projection.roleModels, modelSettings),
    // Native overlays can carry credentials, so they are re-derived from the live registry.
    modelSettings,
    vvoc: policyWithLiveCredentials(input.projection, input.live),
    intent: { mode: "implicit", source: "config" },
  };
}

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
      throw new SnapshotAdmissionError("Session lineage contains a cycle; refusing to bind.");
    }
    seen.add(current);
    const view = await input.readSession(current);
    if (view === undefined) {
      throw new SnapshotAdmissionError(`Session ${current} could not be read from the host.`);
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
  throw new SnapshotAdmissionError("Session lineage exceeds the supported depth.");
}
// END_BLOCK_LINEAGE_RESOLUTION

// START_BLOCK_BINDING_LIFECYCLE
/** Build the credential-safe family-binding service for one native context. */
export function createSnapshotService(deps: SnapshotServiceDeps): SnapshotService {
  const now = deps.now ?? Date.now;
  const readPendingRebinds = deps.rebindRequests ?? listRebindRequests;
  const familyLocks = new Map<string, Promise<unknown>>();
  const sessionFamilies = new Map<string, string>();
  let disposed = false;

  const diagnose = (message: string): void => {
    // Messages are static and bounded: never include paths, parsed state, or credentials.
    deps.diagnostic?.(message.slice(0, 240));
  };

  function withFamilyLock<T>(familyId: string, run: () => Promise<T>): Promise<T> {
    if (deps.coordination !== undefined) return deps.coordination.withFamilyLock(familyId, run);
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
  }

  const familyOf = async (sessionID: string): Promise<string> => {
    const familyId = await resolveSessionFamily({ sessionID, readSession: deps.readSession });
    sessionFamilies.set(sessionID, familyId);
    return familyId;
  };

  async function readBound(
    familyId: string,
  ): Promise<
    { readonly binding: FamilyBindingRecord; readonly projection: BehaviourProjection } | undefined
  > {
    try {
      const binding = await deps.store.readBinding(familyId);
      if (binding === undefined || binding.familyId !== familyId) {
        if (binding !== undefined)
          diagnose("Invalid family binding pointer; rebinding on next workload.");
        return undefined;
      }
      const projection = await deps.store.readSnapshot(binding.snapshotHash);
      if (projection === undefined) {
        diagnose("Missing or invalid family policy snapshot; rebinding on next workload.");
        return undefined;
      }
      return { binding, projection };
    } catch {
      diagnose("Family binding state could not be read; rebinding on next workload.");
      return undefined;
    }
  }

  async function liveConfig(directory: string): Promise<EffectiveRuntimeConfig | undefined> {
    try {
      return await deps.loadConfig(directory);
    } catch {
      diagnose("Live configuration could not be read; using the credential-free bound policy.");
      return undefined;
    }
  }

  async function consumePendingRebind(input: {
    readonly familyId: string;
    readonly sessionID: string;
    readonly directory: string;
    readonly boundAt: number;
  }): Promise<
    | {
        readonly binding: FamilyBindingRecord;
        readonly projection: BehaviourProjection;
        readonly config: EffectiveRuntimeConfig;
      }
    | undefined
  > {
    let requests: readonly RebindRequest[];
    try {
      requests = await readPendingRebinds();
    } catch {
      return undefined;
    }
    const match = requests.find(
      (candidate) =>
        rebindRequestMatches(candidate, {
          directory: input.directory,
          sessionId: input.sessionID,
        }) && candidate.requestedAt > input.boundAt,
    );
    if (match === undefined) return undefined;
    const config = await liveConfig(input.directory);
    if (config === undefined) {
      diagnose("A pending rebind request could not read the current configuration.");
      return undefined;
    }
    try {
      const projection = buildBehaviourProjection({
        roles: config.roles,
        agentRoles: config.agentRoles,
        vvoc: config.vvoc,
      });
      const contentHash = await deps.store.writeSnapshot(projection);
      const binding: FamilyBindingRecord = {
        familyId: input.familyId,
        snapshotHash: contentHash,
        boundAt: new Date(now()).toISOString(),
      };
      await deps.store.writeBinding(binding);
      await collectGarbage();
      return { binding, projection, config };
    } catch {
      diagnose("A pending rebind request could not be applied.");
      return undefined;
    }
  }

  async function boundPolicy(sessionID: string): Promise<FamilyCapture | undefined> {
    if (disposed) return undefined;
    let familyId: string;
    try {
      familyId = await familyOf(sessionID);
    } catch {
      return undefined;
    }
    const bound = await readBound(familyId);
    if (bound === undefined) return undefined;
    const session = await deps.readSession(familyId).catch(() => undefined);
    const location = {
      ...deps.location,
      ...(session?.locationDirectory === undefined ? {} : { directory: session.locationDirectory }),
    };
    const live = await liveConfig(location.directory);
    return materializeCapture({
      familyId,
      ...bound,
      location,
      ...(live === undefined ? {} : { live }),
    });
  }

  async function bind(
    request: SnapshotAdmissionRequest,
    materialize: ((capture: FamilyCapture, selection: ModelSelection) => Promise<void>) | undefined,
  ): Promise<AdmissionOutcome> {
    if (disposed) {
      return {
        status: "rejected",
        familyId: request.sessionID,
        error: "Snapshot service is disposed.",
        rollback: "none",
      };
    }
    let familyId: string;
    try {
      familyId = await familyOf(request.sessionID);
    } catch (error) {
      return {
        status: "rejected",
        familyId: request.sessionID,
        error: String(error),
        rollback: "none",
      };
    }
    return withFamilyLock(familyId, async () => {
      const existing = await readBound(familyId);
      if (existing !== undefined) {
        const rebound = await consumePendingRebind({
          familyId,
          sessionID: request.sessionID,
          directory: request.directory,
          boundAt: Date.parse(existing.binding.boundAt),
        });
        if (rebound === undefined) {
          return {
            status: "reused",
            familyId,
            snapshotId: existing.binding.snapshotHash.slice(0, 16),
          };
        }
        const capture = materializeCapture({
          familyId,
          binding: rebound.binding,
          projection: rebound.projection,
          location: request.location,
          live: rebound.config,
        });
        const base = request.explicit ?? request.selectionOverride ?? primarySelection(capture);
        const selection = base === undefined ? undefined : qualifySelection(capture, base);
        if (selection !== undefined && request.force !== false) {
          await materialize?.(capture, selection);
          await deps.switchModel({ sessionID: request.sessionID, model: selection });
        }
        return {
          status: "bound",
          familyId,
          snapshotId: capture.snapshotId,
          ...(selection === undefined ? {} : { selection }),
          rollback: "none",
        };
      }
      const config = request.admissionConfig ?? (await liveConfig(request.directory));
      if (config === undefined) {
        return {
          status: "rejected",
          familyId,
          error: "Current configuration is unavailable; family binding was not changed.",
          rollback: "none",
        };
      }
      try {
        const projection = buildBehaviourProjection({
          roles: config.roles,
          agentRoles: config.agentRoles,
          vvoc: config.vvoc,
        });
        const hash = behaviourContentHash(projection);
        await deps.store.writeSnapshot(projection);
        const binding: FamilyBindingRecord = {
          familyId,
          snapshotHash: hash,
          boundAt: new Date(now()).toISOString(),
        };
        await deps.store.writeBinding(binding);
        const capture = materializeCapture({
          familyId,
          binding,
          projection,
          location: request.location,
          live: config,
        });
        const base = request.explicit ?? request.selectionOverride ?? primarySelection(capture);
        const selection = base === undefined ? undefined : qualifySelection(capture, base);
        if (selection !== undefined && request.force !== false) {
          await materialize?.(capture, selection);
          await deps.switchModel({ sessionID: request.sessionID, model: selection });
        }
        return {
          status: "bound",
          familyId,
          snapshotId: capture.snapshotId,
          ...(selection === undefined ? {} : { selection }),
          rollback: "none",
        };
      } catch {
        diagnose("Family binding could not be written; the affected family remains unbound.");
        return {
          status: "rejected",
          familyId,
          error: "Family binding could not be persisted.",
          rollback: "none",
        };
      }
    });
  }

  async function collectGarbage(): Promise<void> {
    try {
      const counts = await deps.store.countBindings();
      for (const hash of await deps.store.listSnapshots()) {
        if ((counts.get(hash) ?? 0) === 0) await deps.store.removeSnapshot(hash);
      }
    } catch {
      diagnose("Family binding cleanup was deferred after a store failure.");
    }
  }

  const auxiliary = createAuxiliaryService({
    familyOf,
    policy: boundPolicy,
    session: deps.auxiliarySession,
  });

  const service: SnapshotService = {
    familyOf,
    policy: boundPolicy,
    configFor: boundPolicy,
    captures: async () => {
      if (disposed) return [];
      const captures: FamilyCapture[] = [];
      for (const binding of await deps.store.listBindings().catch(() => [])) {
        const bound = await readBound(binding.familyId);
        if (bound === undefined) continue;
        const live = await liveConfig(deps.location.directory);
        captures.push(
          materializeCapture({
            familyId: binding.familyId,
            ...bound,
            location: deps.location,
            ...(live === undefined ? {} : { live }),
          }),
        );
      }
      return captures;
    },
    variants: async (familyId?: string): Promise<readonly VariantRegistration[]> => {
      const captures = await (async () => {
        if (familyId === undefined) return await service.captures();
        const capture = await boundPolicy(familyId);
        return capture === undefined ? [] : [capture];
      })();
      return captures.flatMap((capture) =>
        capture.variants.map((variant) => ({
          providerID: variant.providerID,
          modelID: variant.modelID,
          variant,
        })),
      );
    },
    // Plugins still call this after their config lookup. Binding is now performed
    // by the prompt/owned-work gateway, so this compatibility shim never stages.
    accept: async (input: SnapshotAcceptRequest) => {
      const capture = await boundPolicy(input.sessionID);
      if (capture !== undefined) {
        return { status: "reused", familyId: capture.familyId, snapshotId: capture.snapshotId };
      }
      return {
        status: "rejected",
        familyId: input.sessionID,
        error: "No family binding exists for this workload.",
        rollback: "none",
      };
    },
    admitOwned: async (request, materialize) => {
      return bind(request, materialize);
    },
    rebind: async ({ directory, location, familyId }) => {
      if (disposed) return [];
      // FileBindingStore is project-scoped; reject a caller that tries to cross it.
      if (location.projectID !== deps.location.projectID) return [];
      const config = await liveConfig(directory);
      if (config === undefined) return [];
      let projection: BehaviourProjection;
      try {
        projection = buildBehaviourProjection({
          roles: config.roles,
          agentRoles: config.agentRoles,
          vvoc: config.vvoc,
        });
      } catch {
        diagnose("Current configuration could not be projected for rebinding.");
        return [];
      }
      try {
        const hash = await deps.store.writeSnapshot(projection);
        const matching = (await deps.store.listBindings()).filter(
          (binding) => familyId === undefined || binding.familyId === familyId,
        );
        await Promise.all(
          matching.map((binding) =>
            withFamilyLock(binding.familyId, () =>
              deps.store.writeBinding({
                familyId: binding.familyId,
                snapshotHash: hash,
                boundAt: new Date(now()).toISOString(),
              }),
            ),
          ),
        );
        await collectGarbage();
        return matching.map((binding) => binding.familyId);
      } catch {
        diagnose("Family rebinding could not be completed.");
        return [];
      }
    },
    removeFamily: async (familyId) => {
      if (disposed) return;
      const resolvedFamilyId = sessionFamilies.get(familyId) ?? familyId;
      await withFamilyLock(resolvedFamilyId, async () => {
        try {
          await deps.store.removeBinding(resolvedFamilyId);
          for (const [sessionID, knownFamilyId] of sessionFamilies) {
            if (knownFamilyId === resolvedFamilyId) sessionFamilies.delete(sessionID);
          }
        } catch {
          diagnose("Family binding deletion was deferred after a store failure.");
          return;
        }
        await collectGarbage();
      });
    },
    auxiliary,
    dispose() {
      disposed = true;
      familyLocks.clear();
      sessionFamilies.clear();
    },
  };
  return service;
}
// END_BLOCK_BINDING_LIFECYCLE
