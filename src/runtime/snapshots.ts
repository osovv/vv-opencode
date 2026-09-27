// FILE: src/runtime/snapshots.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Build durable immutable family policy captures from full effective vvoc configuration plus native model overlays, and admit sessions through a staged awaited native model switch that is committed only at the accepted request boundary.
//   SCOPE: Host-verified parent/fork family resolution, content-addressed full-policy capture construction, staged-candidate persistence, family-qualified awaited switchModel admission, commit at acceptance with rollback that preserves a newer choice, idempotent/concurrent deduplication that preserves rejection, variant derivation, and the documented SnapshotService consumed by later plugins. No host discovery, no client authentication, no permission flow, no stateless generation.
//   DEPENDS: [node:crypto, src/runtime/auxiliary.ts, src/runtime/model-registry.ts, src/runtime/snapshot-config.ts, src/runtime/snapshot-store.ts, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MAX_LINEAGE_HOPS - Bound on host-verified parent/fork lineage traversal.
//   SnapshotCaptureInput - Inputs used to build one family capture.
//   SnapshotServiceDeps - Injectable native boundaries for the snapshot service.
//   defaultSnapshotDigest - Content digest used to address captures.
//   buildFamilyCapture - Build an immutable full-policy family capture.
//   resolveSessionFamily - Resolve a session's family root through host-verified lineage.
//   createSnapshotService - Build the documented snapshot service for one native context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-002 - Bind the caller-resolved (agent-aware) selection as the family model, keep the integrity revision independent of capturedAt so restaging is idempotent, allow non-forcing staged admission, and make capture+marker publication fail-closed.]
// END_CHANGE_SUMMARY

import { createHash } from "node:crypto";
import { createAuxiliaryService } from "./auxiliary.js";
import { managedVariantFor, primarySelection, qualifySelection } from "./model-registry.js";
import { agentBindingsFrom, parseRoleSelections } from "./snapshot-config.js";
import { familyCaptureIntegrity } from "./snapshot-store.js";
import {
  SnapshotAdmissionError,
  type AdmissionOutcome,
  type CapturedModelSettings,
  type EffectiveRuntimeConfig,
  type FamilyCapture,
  type ModelSelection,
  type ModelVariantCapture,
  type NativeSessionView,
  type SnapshotAdmissionRequest,
  type SnapshotService,
  type SnapshotStore,
  type StagedCandidate,
} from "./types.js";

/** Bound on host-verified parent/fork lineage traversal. */
export const MAX_LINEAGE_HOPS = 64;

/** Inputs used to build one full-policy family capture. */
export interface SnapshotCaptureInput {
  readonly familyId: string;
  readonly location: FamilyCapture["location"];
  readonly config: EffectiveRuntimeConfig;
  readonly intent: FamilyCapture["intent"];
  readonly explicit?: ModelSelection | undefined;
  readonly capturedAt?: number | undefined;
  readonly digest?: ((value: string) => string) | undefined;
}

/** Injectable native boundaries for the snapshot service. */
export interface SnapshotServiceDeps {
  readonly store: SnapshotStore;
  loadConfig(directory: string): Promise<EffectiveRuntimeConfig>;
  /** Host-verified session view; never model-supplied identity. */
  readSession(sessionID: string): Promise<NativeSessionView | undefined>;
  readSessionModel(sessionID: string): Promise<ModelSelection | undefined>;
  switchModel(input: { readonly sessionID: string; readonly model: ModelSelection }): Promise<void>;
  readonly auxiliarySession: import("./types.js").AuxiliarySessionApi;
  now?(): number;
  digest?(value: string): string;
}

// START_BLOCK_CAPTURE_CONSTRUCTION
/** Content digest used to address captures. */
export function defaultSnapshotDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
): {
  settings?: Readonly<Record<string, unknown>>;
  body?: Readonly<Record<string, unknown>>;
  headers?: Readonly<Record<string, string>>;
} {
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
  selections: Readonly<Record<string, ModelSelection>>,
  modelSettings: ReadonlyArray<CapturedModelSettings>,
): ModelVariantCapture[] {
  const byKey = new Map<string, ModelVariantCapture>();
  for (const selection of Object.values(selections)) {
    const overlay = variantOverlayFor(selection, modelSettings);
    const managed = managedVariantFor(selection, "");
    const hasOverlay =
      overlay.settings !== undefined || overlay.body !== undefined || overlay.headers !== undefined;
    if (!hasOverlay && managed === undefined) continue;

    const sourceVariant = managed?.sourceVariant ?? selection.variant;
    const body = { ...overlay.body, ...managed?.body };
    const key = `${selection.providerID}\u0000${selection.modelID}\u0000${sourceVariant ?? ""}`;
    byKey.set(key, {
      id: "",
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

/** Build an immutable full-policy family capture. */
export function buildFamilyCapture(input: SnapshotCaptureInput): FamilyCapture {
  const digest = input.digest ?? defaultSnapshotDigest;
  const roleModels = parseRoleSelections(input.config.roles);
  const agents =
    input.config.agentBindings ?? agentBindingsFrom(input.config.agentRoles, roleModels);
  const modelSettings = input.config.modelSettings ?? [];
  const vvoc = input.config.vvoc;
  const modelOverride = input.explicit;

  const draft: FamilyCapture = {
    schemaVersion: 1,
    snapshotId: "",
    integrity: "",
    familyId: input.familyId,
    capturedAt: input.capturedAt ?? Date.now(),
    location: input.location,
    roles: input.config.roles,
    roleModels,
    agents,
    variants: buildVariants(roleModels, modelSettings),
    modelSettings,
    vvoc,
    ...(input.config.rawIntent === undefined ? {} : { rawIntent: input.config.rawIntent }),
    ...(input.config.rootDefault === undefined ? {} : { rootSelection: input.config.rootDefault }),
    ...(modelOverride === undefined ? {} : { modelOverride }),
    intent: input.intent,
  };
  // Integrity covers roles, native overlays, raw vvoc and source variants, never generated ids.
  const integrity = familyCaptureIntegrity(draft);
  const snapshotId = digest(integrity).slice(0, 16);
  const variants = draft.variants.map((variant) => ({
    ...variant,
    id: variantIdFor(snapshotId, variant.modelID, variant.sourceVariant),
  }));

  return {
    ...draft,
    snapshotId,
    integrity,
    variants,
  };
}
// END_BLOCK_CAPTURE_CONSTRUCTION

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
    // An empty parentID with a fork.sessionID means the fork's source is the parent.
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

// START_BLOCK_ADMISSION
function sameSelection(
  left: ModelSelection | undefined,
  right: ModelSelection | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.providerID === right.providerID &&
    left.modelID === right.modelID &&
    (left.variant ?? "") === (right.variant ?? "")
  );
}

async function rollbackStaged(input: {
  readonly sessionID: string;
  readonly candidate: StagedCandidate;
  readSessionModel(sessionID: string): Promise<ModelSelection | undefined>;
  switchModel(input: { readonly sessionID: string; readonly model: ModelSelection }): Promise<void>;
}): Promise<AdmissionOutcome["rollback"]> {
  let current: ModelSelection | undefined;
  try {
    current = await input.readSessionModel(input.sessionID);
  } catch {
    return "none";
  }
  // Full identity including variant; a different current means a newer choice arrived.
  if (!sameSelection(current, input.candidate.selection)) return "preserved-newer-choice";
  if (input.candidate.before === undefined) return "none";
  try {
    await input.switchModel({ sessionID: input.sessionID, model: input.candidate.before });
    return "reverted";
  } catch {
    return "none";
  }
}

function toReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build the documented snapshot service for one native context. */
export function createSnapshotService(deps: SnapshotServiceDeps): SnapshotService {
  const now = deps.now ?? Date.now;
  const digest = deps.digest ?? defaultSnapshotDigest;
  const inFlightSessions = new Map<string, Promise<AdmissionOutcome>>();
  const inFlightCommits = new Map<string, Promise<AdmissionOutcome>>();
  let disposed = false;

  const familyOf = async (sessionID: string): Promise<string> =>
    resolveSessionFamily({ sessionID, readSession: deps.readSession });

  const policy = async (sessionID: string): Promise<FamilyCapture | undefined> => {
    if (disposed) return undefined;
    const familyId = await familyOf(sessionID);
    return deps.store.read(familyId);
  };

  async function loadCaptures(): Promise<FamilyCapture[]> {
    const ids = await deps.store.list();
    const captures: FamilyCapture[] = [];
    for (const familyId of ids) {
      const capture = await deps.store.read(familyId);
      if (capture !== undefined) captures.push(capture);
    }
    return captures;
  }

  async function doStage(
    request: SnapshotAdmissionRequest,
    familyId: string,
    materialize: ((capture: FamilyCapture, selection: ModelSelection) => Promise<void>) | undefined,
  ): Promise<AdmissionOutcome> {
    const existing = await deps.store.read(familyId);
    if (existing !== undefined) {
      return { status: "reused", familyId, snapshotId: existing.snapshotId };
    }
    // A durable marker proves the family was bound before; a missing capture must fail closed.
    if (await deps.store.readMarker(familyId)) {
      return {
        status: "rejected",
        familyId,
        error:
          "A previously bound family capture is missing; refusing to adopt current configuration.",
        rollback: "none",
      };
    }

    const view = await deps.readSession(request.sessionID);
    if (view === undefined) {
      return {
        status: "rejected",
        familyId,
        error: `Session ${request.sessionID} could not be read for admission.`,
        rollback: "none",
      };
    }
    if (view.hasActivity === true && request.explicit === undefined) {
      // A session that already did work without a durable capture must not adopt current policy.
      return {
        status: "rejected",
        familyId,
        error:
          "An active session has no persisted family capture; refusing to adopt current configuration.",
        rollback: "none",
      };
    }

    let config: EffectiveRuntimeConfig;
    try {
      config = await deps.loadConfig(request.directory);
    } catch (error) {
      return {
        status: "rejected",
        familyId,
        error: toReason(error),
        rollback: "none",
      };
    }
    const intent: FamilyCapture["intent"] =
      request.intent ??
      (request.explicit === undefined
        ? { mode: "implicit", source: "config" }
        : { mode: "explicit", source: "config", literal: request.explicit });
    let capture: FamilyCapture;
    try {
      // Resolve the family model before building the capture so `modelOverride`
      // records the exact model this family binds. `explicit` is the user's
      // documented choice; `selectionOverride` is a caller-resolved base (for
      // example the current model when role overriding is disabled).
      const parsedRoles = parseRoleSelections(config.roles);
      const fallback =
        parsedRoles.default ??
        config.rootDefault ??
        Object.values(parsedRoles)[0] ??
        config.agentBindings?.find((binding) => binding.selection !== undefined)?.selection;
      const baseSelection = request.explicit ?? request.selectionOverride ?? fallback;
      capture = buildFamilyCapture({
        familyId,
        location: request.location,
        config,
        intent,
        ...(baseSelection === undefined ? {} : { explicit: baseSelection }),
        capturedAt: now(),
        digest,
      });
    } catch (error) {
      return {
        status: "rejected",
        familyId,
        error: toReason(error),
        rollback: "none",
      };
    }

    // A staged candidate for the same capture revision is already switched; a newer
    // revision (for example after a preset switch) must be re-staged and re-switched.
    const alreadyStaged = await deps.store.readCandidate(familyId);
    if (alreadyStaged !== undefined && alreadyStaged.revision === capture.integrity) {
      return {
        status: "staged",
        familyId,
        snapshotId: alreadyStaged.capture.snapshotId,
        candidateSelection: alreadyStaged.selection,
      };
    }

    const baseSelection = request.explicit ?? primarySelection(capture);
    if (baseSelection === undefined) {
      return {
        status: "rejected",
        familyId,
        error: "The effective configuration has no selectable model policy.",
        rollback: "none",
      };
    }
    // The family's captured variant must be activated, not a sibling family's.
    const selection = qualifySelection(capture, baseSelection);
    try {
      // Materialize the candidate variant before the switch so resolution finds it.
      await materialize?.(capture, selection);
    } catch (error) {
      return {
        status: "rejected",
        familyId,
        candidateSelection: selection,
        error: toReason(error),
        rollback: "none",
      };
    }
    const candidate: StagedCandidate = {
      familyId,
      sessionID: request.sessionID,
      stagedAt: now(),
      revision: capture.integrity,
      selection,
      ...(request.before === undefined ? {} : { before: request.before }),
      capture,
    };
    try {
      await deps.store.writeCandidate(candidate);
    } catch (error) {
      return {
        status: "rejected",
        familyId,
        candidateSelection: selection,
        error: toReason(error),
        rollback: "none",
      };
    }

    // A caller may bind policy without forcing a model change (role override off).
    if (request.force === false) {
      return {
        status: "staged",
        familyId,
        snapshotId: capture.snapshotId,
        candidateSelection: selection,
        rollback: "none",
      };
    }

    try {
      await deps.switchModel({ sessionID: request.sessionID, model: selection });
    } catch (error) {
      const rollback = await rollbackStaged({
        sessionID: request.sessionID,
        candidate,
        readSessionModel: deps.readSessionModel,
        switchModel: deps.switchModel,
      });
      await deps.store.removeCandidate(familyId).catch(() => undefined);
      return {
        status: "rejected",
        familyId,
        candidateSelection: selection,
        rollback,
        error: toReason(error),
      };
    }
    return {
      status: "staged",
      familyId,
      snapshotId: capture.snapshotId,
      candidateSelection: selection,
      rollback: "none",
    };
  }

  async function doCommit(familyId: string): Promise<AdmissionOutcome> {
    const candidate = await deps.store.readCandidate(familyId);
    if (candidate === undefined) {
      const existing = await deps.store.read(familyId);
      return existing === undefined
        ? { status: "rejected", familyId, error: "There is no staged candidate to commit." }
        : { status: "reused", familyId, snapshotId: existing.snapshotId };
    }
    try {
      await deps.store.write(familyId, candidate.capture);
      await deps.store.writeMarker(familyId);
    } catch (error) {
      // Publication is capture + bound marker. If either half failed, remove a
      // partially published capture so the next read stays fail-closed instead of
      // silently reusing an unproven policy.
      await deps.store.remove(familyId).catch(() => undefined);
      // Commit failure must undo our own switch unless a newer choice replaced it.
      const rollback = await rollbackStaged({
        sessionID: candidate.sessionID,
        candidate,
        readSessionModel: deps.readSessionModel,
        switchModel: deps.switchModel,
      });
      await deps.store.removeCandidate(familyId).catch(() => undefined);
      return {
        status: "rejected",
        familyId,
        candidateSelection: candidate.selection,
        rollback,
        error: toReason(error),
      };
    }
    await deps.store.removeCandidate(familyId).catch(() => undefined);
    return {
      status: "bound",
      familyId,
      snapshotId: candidate.capture.snapshotId,
      candidateSelection: candidate.selection,
      rollback: "none",
    };
  }

  async function stageWithFamily(
    request: SnapshotAdmissionRequest,
    materialize: ((capture: FamilyCapture, selection: ModelSelection) => Promise<void>) | undefined,
  ): Promise<AdmissionOutcome> {
    const familyId = await familyOf(request.sessionID);
    // Sessions are deduped individually: two sessions in one family each need their
    // own switch, while a repeated call for one session shares the first attempt.
    const sessionKey = `${familyId}\u0000${request.sessionID}`;
    const pending = inFlightSessions.get(sessionKey);
    if (pending !== undefined) return pending;
    const promise = doStage(request, familyId, materialize).finally(() => {
      inFlightSessions.delete(sessionKey);
    });
    inFlightSessions.set(sessionKey, promise);
    return promise;
  }

  const stage = (
    request: SnapshotAdmissionRequest,
    materialize?: (capture: FamilyCapture, selection: ModelSelection) => Promise<void>,
  ): Promise<AdmissionOutcome> => {
    if (disposed) {
      return Promise.resolve({
        status: "rejected",
        familyId: request.sessionID,
        error: "The snapshot service was released.",
        rollback: "none",
      });
    }
    return stageWithFamily(request, materialize);
  };

  const commit = (familyId: string): Promise<AdmissionOutcome> => {
    if (disposed) {
      return Promise.resolve({
        status: "rejected",
        familyId,
        error: "The snapshot service was released.",
        rollback: "none",
      });
    }
    const pending = inFlightCommits.get(familyId);
    if (pending !== undefined) return pending;
    const promise = doCommit(familyId).finally(() => {
      inFlightCommits.delete(familyId);
    });
    inFlightCommits.set(familyId, promise);
    return promise;
  };

  const admit = async (request: SnapshotAdmissionRequest): Promise<AdmissionOutcome> => {
    const staged = await stage(request);
    if (staged.status === "rejected" || staged.status === "reused") return staged;
    return commit(staged.familyId);
  };

  const auxiliary = createAuxiliaryService({
    familyOf,
    policy,
    session: deps.auxiliarySession,
  });

  return {
    familyOf,
    policy,
    configFor: policy,
    captures: async () => (disposed ? [] : loadCaptures()),
    variants: async (familyId) => {
      if (disposed) return [];
      const captures = (await loadCaptures()).filter(
        (capture) => familyId === undefined || capture.familyId === familyId,
      );
      return captures.flatMap((capture) =>
        capture.variants.map((variant) => ({
          providerID: variant.providerID,
          modelID: variant.modelID,
          variant,
        })),
      );
    },
    stage,
    commit,
    hasStaged: async (familyId) => (await deps.store.readCandidate(familyId)) !== undefined,
    admit,
    auxiliary,
    dispose() {
      disposed = true;
      inFlightSessions.clear();
      inFlightCommits.clear();
    },
  };
}
// END_BLOCK_ADMISSION
