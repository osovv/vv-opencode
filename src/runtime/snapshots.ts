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
//   MAX_STAGED_CANDIDATES - Bound on concurrently staged per-input candidates for one family.
//   SnapshotCaptureInput - Inputs used to build one family capture.
//   SnapshotServiceDeps - Injectable native boundaries for the snapshot service.
//   defaultSnapshotDigest - Content digest used to address captures.
//   buildFamilyCapture - Build an immutable full-policy family capture.
//   resolveSessionFamily - Resolve a session's family root through host-verified lineage.
//   createSnapshotService - Build the documented snapshot service for one native context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-002 attempt 7 - Bounded per-input candidate sets; the first accepted input by native durable order wins, ordering requires a complete replay when multiple inputs are staged, and publication consumes only the winning owner.]
// END_CHANGE_SUMMARY

import { createHash } from "node:crypto";
import { createAuxiliaryService } from "./auxiliary.js";
import { managedVariantFor, primarySelection, qualifySelection } from "./model-registry.js";
import { agentBindingsFrom, parseRoleSelections } from "./snapshot-config.js";
import { familyCaptureIntegrity } from "./snapshot-store.js";
import {
  SnapshotAdmissionError,
  stagedCandidateIdentity,
  stagedCandidateKey,
  type AcceptedInput,
  type AcceptedInputReconciliation,
  type AdmissionOutcome,
  type CapturedModelSettings,
  type EffectiveRuntimeConfig,
  type FamilyCapture,
  type ModelSelection,
  type ModelVariantCapture,
  type NativeSessionView,
  type SnapshotAcceptRequest,
  type SnapshotAdmissionRequest,
  type SnapshotOwnedAdmissionRequest,
  type SnapshotService,
  type SnapshotStore,
  type StagedCandidate,
} from "./types.js";

/** Bound on host-verified parent/fork lineage traversal. */
export const MAX_LINEAGE_HOPS = 64;

/**
 * Bound on concurrently staged per-input admission candidates for one family.
 * Overflow fails the new stage closed rather than dropping an unaccepted input
 * that native preparation may still accept later.
 */
export const MAX_STAGED_CANDIDATES = 8;

/** Materialize a candidate's qualified variant before the awaited switch. */
type Materialize = (
  capture: FamilyCapture,
  selection: ModelSelection,
  candidateIdentity: string,
) => Promise<void>;

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
  /**
   * Accepted-input reconciliation for a session from the live stream and/or the
   * durable native session log, ordered by native event time/sequence. Returns
   * undefined when no reliable source exists so acceptance fails closed instead
   * of committing without evidence, or binding a later policy.
   */
  readonly readAcceptedInputs?:
    | ((sessionID: string) => Promise<AcceptedInputReconciliation | undefined>)
    | undefined;
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
  const inFlightAccepts = new Map<string, Promise<AdmissionOutcome>>();
  const inFlightOwned = new Map<string, Promise<AdmissionOutcome>>();
  /**
   * Per-family serialization. Candidate read/write, switch and publication are
   * ordered so a concurrent stage cannot be lost or overwritten between an
   * acceptance validation and its publication, and late cleanup cannot delete a
   * newer/committed capture.
   */
  const familyLocks = new Map<string, Promise<unknown>>();
  let disposed = false;

  function withFamilyLock<T>(familyId: string, run: () => Promise<T>): Promise<T> {
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
    materialize: Materialize | undefined,
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

    // Per-input candidates: repeated identical input is idempotent, distinct
    // inputs coexist up to MAX_STAGED_CANDIDATES, and the family's first
    // accepted input decides the snapshot regardless of stage order.
    const requestIdentity = stagedCandidateIdentity(request);
    const candidates = await deps.store.readCandidates(familyId);
    const sameInput = candidates.find(
      (candidate) => stagedCandidateKey(candidate) === requestIdentity,
    );
    if (sameInput !== undefined && sameInput.revision === capture.integrity) {
      // Repeated identical input: idempotent, no rewrite and no re-switch.
      return {
        status: "staged",
        familyId,
        snapshotId: sameInput.capture.snapshotId,
        candidateSelection: sameInput.selection,
        rollback: "none",
      };
    }
    if (sameInput === undefined && candidates.length >= MAX_STAGED_CANDIDATES) {
      // Bounded set overflow fails the new stage closed rather than dropping an
      // unaccepted input that native preparation may still accept later.
      return {
        status: "rejected",
        familyId,
        error: `The family already holds ${candidates.length} staged candidates; refusing to drop an unaccepted input.`,
        rollback: "none",
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
      await materialize?.(capture, selection, requestIdentity);
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
      ...(request.inboxID === undefined ? {} : { inboxID: request.inboxID }),
      ...(request.operationID === undefined ? {} : { operationID: request.operationID }),
      ...(request.workload === undefined ? {} : { workload: request.workload }),
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
      // Remove only our own candidate; never another owner's.
      await deps.store.removeCandidate(familyId, requestIdentity).catch(() => undefined);
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

  /**
   * Publish the exact winning candidate as the bound family capture. The
   * candidate must still exist with the same owner identity and revision; the
   * bound marker is written first so a crash between the two writes fails closed:
   * a capture is never readable without its marker, and a marker without a
   * capture is refused on the next admission instead of adopting current
   * configuration. Cleanup removes only the winning candidate, never a newer one.
   */
  async function publishCandidate(
    familyId: string,
    expected: StagedCandidate,
  ): Promise<AdmissionOutcome> {
    const key = stagedCandidateKey(expected);
    const candidates = await deps.store.readCandidates(familyId);
    const current = candidates.find((candidate) => stagedCandidateKey(candidate) === key);
    if (current === undefined || current.revision !== expected.revision) {
      return {
        status: "rejected",
        familyId,
        error: "The staged candidate changed before publication; refusing to publish.",
        rollback: "none",
      };
    }
    try {
      await deps.store.writeMarker(familyId);
      await deps.store.write(familyId, current.capture);
    } catch (error) {
      // Remove both halves so the next read cannot expose or silently reuse a
      // partially published policy.
      await deps.store.removeMarker(familyId).catch(() => undefined);
      await deps.store.remove(familyId).catch(() => undefined);
      // Publication failure must undo our own switch unless a newer choice replaced it.
      const rollback = await rollbackStaged({
        sessionID: current.sessionID,
        candidate: current,
        readSessionModel: deps.readSessionModel,
        switchModel: deps.switchModel,
      });
      await deps.store.removeCandidate(familyId, key).catch(() => undefined);
      return {
        status: "rejected",
        familyId,
        candidateSelection: current.selection,
        rollback,
        error: toReason(error),
      };
    }
    // Consume only the winning owner.
    await deps.store.removeCandidate(familyId, key).catch(() => undefined);
    return {
      status: "bound",
      familyId,
      snapshotId: current.capture.snapshotId,
      candidateSelection: current.selection,
      rollback: "none",
    };
  }

  /**
   * Owned generated-work gateway. Stages with the runtime's operation token and
   * publishes only that exact owned candidate; it never adopts a prompt
   * candidate.
   */
  async function doAdmitOwned(
    familyId: string,
    request: SnapshotOwnedAdmissionRequest,
    materialize: Materialize | undefined,
  ): Promise<AdmissionOutcome> {
    const staged = await doStage(request, familyId, materialize);
    if (staged.status === "rejected" || staged.status === "reused") return staged;
    const key = stagedCandidateIdentity(request);
    const candidates = await deps.store.readCandidates(familyId);
    const candidate = candidates.find((entry) => stagedCandidateKey(entry) === key);
    if (candidate === undefined || candidate.operationID !== request.operationID) {
      return {
        status: "rejected",
        familyId,
        error: "The owned operation no longer owns the staged candidate.",
        rollback: "none",
      };
    }
    if (candidate.inboxID !== undefined) {
      return {
        status: "rejected",
        familyId,
        error: "Refusing to publish a prompt candidate through the owned gateway.",
        rollback: "none",
      };
    }
    return publishCandidate(familyId, candidate);
  }

  /**
   * First-accepted publication: among every staged prompt candidate, publish the
   * one whose native accepted input is earliest by durable event order, never the
   * most recently staged or an arbitrary map entry. Covers delayed/missed live
   * notifications by reconciling against the durable session log. An optional
   * `validate` refuses a resolved model that does not belong to the winner
   * without losing the winner's snapshot.
   */
  async function doAccept(
    familyId: string,
    request: SnapshotAcceptRequest,
  ): Promise<AdmissionOutcome> {
    const existing = await deps.store.read(familyId);
    if (existing !== undefined)
      return { status: "reused", familyId, snapshotId: existing.snapshotId };
    const candidates = await deps.store.readCandidates(familyId);
    const promptCandidates = candidates.filter(
      (candidate) => candidate.inboxID !== undefined && candidate.operationID === undefined,
    );
    if (promptCandidates.length === 0) {
      return {
        status: "rejected",
        familyId,
        error: "There is no staged prompt candidate to accept.",
        rollback: "none",
      };
    }
    const sessions = [...new Set(promptCandidates.map((candidate) => candidate.sessionID))];
    const reconciliation = new Map<string, AcceptedInputReconciliation | undefined>();
    for (const sessionID of sessions) {
      const resolved = deps.readAcceptedInputs
        ? await deps.readAcceptedInputs(sessionID).catch(() => undefined)
        : undefined;
      reconciliation.set(sessionID, resolved);
    }
    // With more than one staged input, only a complete durable replay can prove
    // which was accepted first; an incomplete/live-only view could bind a later
    // policy, so fail closed until the log confirms the ordering.
    if (promptCandidates.length > 1) {
      for (const sessionID of sessions) {
        const resolved = reconciliation.get(sessionID);
        if (resolved === undefined || !resolved.complete) {
          return {
            status: "rejected",
            familyId,
            error:
              "Cannot establish the first accepted input without a complete session log; refusing to bind a later policy.",
            rollback: "none",
          };
        }
      }
    }
    const eligible: Array<{ candidate: StagedCandidate; order: AcceptedInput }> = [];
    for (const candidate of promptCandidates) {
      const resolved = reconciliation.get(candidate.sessionID);
      const match = resolved?.inputs.find(
        (entry) =>
          entry.inboxID === candidate.inboxID &&
          (entry.itemType === "user" || entry.itemType === "synthetic"),
      );
      // A log-derived match is only trusted from a complete replay; a verified
      // live native event may stand alone.
      if (match !== undefined && (match.source === "live" || resolved?.complete === true)) {
        eligible.push({ candidate, order: match });
      }
    }
    if (eligible.length === 0) {
      return {
        status: "rejected",
        familyId,
        error: "No accepted input matching a staged workload was found.",
        rollback: "none",
      };
    }
    eligible.sort(
      (left, right) =>
        left.order.created - right.order.created ||
        (left.order.seq ?? 0) - (right.order.seq ?? 0) ||
        left.candidate.stagedAt - right.candidate.stagedAt ||
        stagedCandidateKey(left.candidate).localeCompare(stagedCandidateKey(right.candidate)),
    );
    const winner = eligible[0];
    if (request.validate !== undefined && !request.validate(winner.candidate.selection)) {
      return {
        status: "rejected",
        familyId,
        candidateSelection: winner.candidate.selection,
        error:
          "The resolved model does not match the first accepted candidate; refusing to publish.",
        rollback: "none",
      };
    }
    return publishCandidate(familyId, winner.candidate);
  }

  async function stageWithFamily(
    request: SnapshotAdmissionRequest,
    materialize: Materialize | undefined,
  ): Promise<AdmissionOutcome> {
    const familyId = await familyOf(request.sessionID);
    // Dedupe by exact input identity (session + inboxID/operationID/workload):
    // concurrent distinct prompts must not share one staging promise, while a
    // repeated identical input shares its first attempt.
    const sessionKey = `${familyId}\u0000${stagedCandidateIdentity(request)}`;
    const pending = inFlightSessions.get(sessionKey);
    if (pending !== undefined) return pending;
    const promise = withFamilyLock(familyId, () => doStage(request, familyId, materialize)).finally(
      () => {
        inFlightSessions.delete(sessionKey);
      },
    );
    inFlightSessions.set(sessionKey, promise);
    return promise;
  }

  const stage = (
    request: SnapshotAdmissionRequest,
    materialize?: Materialize,
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

  const accept = (request: SnapshotAcceptRequest): Promise<AdmissionOutcome> => {
    if (disposed) {
      return Promise.resolve({
        status: "rejected",
        familyId: request.sessionID,
        error: "The snapshot service was released.",
        rollback: "none",
      });
    }
    return (async () => {
      const familyId = await familyOf(request.sessionID);
      const key = `${familyId}\u0000${request.sessionID}\u0000${request.inboxID ?? ""}`;
      const pending = inFlightAccepts.get(key);
      if (pending !== undefined) return pending;
      const promise = withFamilyLock(familyId, () => doAccept(familyId, request)).finally(() => {
        inFlightAccepts.delete(key);
      });
      inFlightAccepts.set(key, promise);
      return promise;
    })();
  };

  const admitOwned = (
    request: SnapshotOwnedAdmissionRequest,
    materialize?: Materialize,
  ): Promise<AdmissionOutcome> => {
    if (disposed) {
      return Promise.resolve({
        status: "rejected",
        familyId: request.sessionID,
        error: "The snapshot service was released.",
        rollback: "none",
      });
    }
    if (request.operationID.length === 0) {
      return Promise.resolve({
        status: "rejected",
        familyId: request.sessionID,
        error: "An owned admission requires a non-empty operation token.",
        rollback: "none",
      });
    }
    return (async () => {
      const familyId = await familyOf(request.sessionID);
      const key = `${familyId}\u0000${request.sessionID}\u0000${request.operationID}`;
      const pending = inFlightOwned.get(key);
      if (pending !== undefined) return pending;
      const promise = withFamilyLock(familyId, () =>
        doAdmitOwned(familyId, request, materialize),
      ).finally(() => {
        inFlightOwned.delete(key);
      });
      inFlightOwned.set(key, promise);
      return promise;
    })();
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
    accept,
    admitOwned,
    hasStaged: async (familyId) => (await deps.store.readCandidates(familyId)).length > 0,
    auxiliary,
    dispose() {
      disposed = true;
      inFlightSessions.clear();
      inFlightAccepts.clear();
      inFlightOwned.clear();
      familyLocks.clear();
    },
  };
}
// END_BLOCK_ADMISSION
