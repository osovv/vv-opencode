// FILE: src/tui/policy.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Own the shared TUI policy snapshot fetched from the native context-inspection RPC, quarantining the previous selection's snapshot as soon as the session/location key changes and discarding stale replies.
//   SCOPE: Selection-keyed generation-guarded refresh, loading quarantine on key change, listener notification, disposal, and pure allowlisted policy predicates for the context/analytics/peak-hours consumers.
//   DEPENDS: [src/runtime/context-inspection-contract.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, M-PLUGIN-ANALYTICS, M-PLUGIN-PEAK-HOURS, DF-CONTEXT-INSPECTION, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ContextPolicySelection - Current session id and location directory the policy applies to.
//   ContextPolicySnapshot - Loading quarantine, an allowlisted policy, or undefined before the first refresh.
//   ContextPolicyFetch - Injectable RPC fetch seam used by tests and production.
//   ContextPolicyInspect - Structural native inspection call used by the production fetch.
//   createRpcPolicyFetch - Build the location-checked production policy fetch.
//   ContextPolicyController - Shared selection-keyed refresh/dispose/listen controller.
//   createPolicyController - Build a selection-keyed, generation-guarded policy controller.
//   isResolvedPolicy - Narrow a snapshot to an allowlisted available/preview/unavailable policy.
//   policyContextEnabled - True only when an available/preview policy enables the context plugin.
//   policyContextSuppressed - True only when a resolved policy explicitly disables the context plugin.
//   policyAnalyticsEnabled - True only when an available/preview policy enables analytics.
//   policyPeakHours - Allowlisted peak-hours config, or undefined when unavailable/loading.
//   policyUnavailableReason - Stable error code when a resolved policy is unavailable.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 attempt 3 - Made the selection directory mandatory and added a serving-location-checked production RPC policy fetch.]
// END_CHANGE_SUMMARY

import {
  isContextInspectionResult,
  type ContextInspectionPolicy,
  type ContextInspectionPeakHours,
} from "../runtime/context-inspection-contract.js";

/** Current session id and location directory the policy applies to. */
export type ContextPolicySelection = {
  readonly sessionID?: string | undefined;
  /** The selected session's current native directory; always required by the TUI. */
  readonly directory: string;
};

/** Loading quarantine, an allowlisted policy, or undefined before the first refresh. */
export type ContextPolicySnapshot =
  | { readonly status: "loading"; readonly scope: "family" | "current-runtime" }
  | ContextInspectionPolicy;

/** Injectable RPC fetch seam used by tests and production. */
export type ContextPolicyFetch = (
  selection: ContextPolicySelection,
) => Promise<ContextInspectionPolicy | undefined>;

/** Structural native inspection call used by the production policy fetch. */
export type ContextPolicyInspect = (
  input: { readonly sessionID?: string; readonly includeCatalog?: boolean },
  options: { readonly location: { readonly directory: string } },
) => Promise<unknown>;

/**
 * Build the production RPC policy fetch. A reply is accepted only when it is a
 * strictly valid inspection result AND its serving `location.directory` matches
 * the requested selected-session directory (the family capture origin may move,
 * the serving location may not).
 */
export function createRpcPolicyFetch(inspect: ContextPolicyInspect): ContextPolicyFetch {
  return async (selection) => {
    const result = await inspect(
      {
        ...(selection.sessionID === undefined ? {} : { sessionID: selection.sessionID }),
        includeCatalog: false,
      },
      { location: { directory: selection.directory } },
    );
    if (!isContextInspectionResult(result)) return undefined;
    if (result.location.directory !== selection.directory) return undefined;
    return result.policy;
  };
}

/** Shared selection-keyed refresh/dispose/listen controller. */
export interface ContextPolicyController {
  /** The current accepted snapshot (undefined before the first refresh). */
  current(): ContextPolicySnapshot | undefined;
  /** Refetch for the selected session/location and accept only the newest reply for the newest key. */
  refresh(selection: ContextPolicySelection): Promise<ContextPolicySnapshot | undefined>;
  /** Notifies after each accepted snapshot or quarantine; returns an unsubscribe function. */
  subscribe(listener: (snapshot: ContextPolicySnapshot | undefined) => void): () => void;
  /** Stop accepting replies and release listeners. */
  dispose(): void;
}

// START_BLOCK_POLICY_CONTROLLER
function selectionKey(selection: ContextPolicySelection): string {
  return `${selection.sessionID ?? ""}\u0000${selection.directory ?? ""}`;
}

/**
 * Build a selection-keyed, generation-guarded policy controller. On a selection
 * key change the previous snapshot is quarantined immediately (a `loading`
 * snapshot is published) so a stale policy is never rendered while the new one
 * loads. Replies whose selection key or generation is no longer current are
 * discarded. A rejected fetch becomes an explicit unavailable snapshot.
 */
export function createPolicyController(fetch: ContextPolicyFetch): ContextPolicyController {
  const listeners = new Set<(snapshot: ContextPolicySnapshot | undefined) => void>();
  let generation = 0;
  let activeKey: string | undefined;
  let current: ContextPolicySnapshot | undefined;
  let disposed = false;

  const publish = (snapshot: ContextPolicySnapshot | undefined): void => {
    current = snapshot;
    for (const listener of listeners) listener(snapshot);
  };

  return {
    current: () => current,
    async refresh(selection) {
      if (disposed) return current;
      const key = selectionKey(selection);
      const scope = selection.sessionID === undefined ? "current-runtime" : "family";
      if (key !== activeKey) {
        activeKey = key;
        // Quarantine the previous selection's policy until the new one resolves.
        publish({ status: "loading", scope });
      }
      const mine = (generation += 1);
      let snapshot: ContextPolicySnapshot;
      try {
        const policy = await fetch(selection);
        snapshot =
          policy ??
          ({
            status: "unavailable",
            scope,
            error: "policy_capture_missing",
          } satisfies ContextInspectionPolicy);
      } catch {
        snapshot = {
          status: "unavailable",
          scope,
          error: "inspection_internal_error",
        } satisfies ContextInspectionPolicy;
      }
      // Discard a stale reply: only the newest key/generation may publish.
      if (disposed || mine !== generation || key !== activeKey) return current;
      publish(snapshot);
      return current;
    },
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      generation += 1;
      listeners.clear();
    },
  };
}
// END_BLOCK_POLICY_CONTROLLER

// START_BLOCK_POLICY_PREDICATES
/** Narrow a snapshot to an allowlisted available/preview/unavailable policy. */
export function isResolvedPolicy(
  policy: ContextPolicySnapshot | undefined,
): policy is ContextInspectionPolicy {
  return (
    policy !== undefined &&
    (policy.status === "available" ||
      policy.status === "preview" ||
      policy.status === "unavailable")
  );
}

/**
 * True only when an available or preview policy explicitly enables the context
 * plugin. Disabled and unavailable policies both suppress the effect.
 */
export function policyContextEnabled(policy: ContextPolicySnapshot | undefined): boolean {
  if (!isResolvedPolicy(policy) || policy.status === "unavailable") return false;
  return policy.contextEnabled;
}

/**
 * True only when a resolved policy explicitly disables the context plugin.
 * Loading, unavailable, and undefined snapshots are not "disabled": the
 * /context command stays reachable so an unbound or empty session can show its
 * unavailable policy and observations honestly instead of becoming empty.
 */
export function policyContextSuppressed(policy: ContextPolicySnapshot | undefined): boolean {
  if (!isResolvedPolicy(policy) || policy.status === "unavailable") return false;
  return policy.contextEnabled === false;
}

/** True only when an available or preview policy explicitly enables analytics. */
export function policyAnalyticsEnabled(policy: ContextPolicySnapshot | undefined): boolean {
  if (!isResolvedPolicy(policy) || policy.status === "unavailable") return false;
  return policy.analyticsEnabled;
}

/** Allowlisted peak-hours config, or undefined when the policy is unavailable/loading. */
export function policyPeakHours(
  policy: ContextPolicySnapshot | undefined,
): ContextInspectionPeakHours | undefined {
  if (!isResolvedPolicy(policy) || policy.status === "unavailable") return undefined;
  return policy.peakHours;
}

/** Stable error code when a resolved policy is unavailable. */
export function policyUnavailableReason(
  policy: ContextPolicySnapshot | undefined,
): string | undefined {
  return isResolvedPolicy(policy) && policy.status === "unavailable" ? policy.error : undefined;
}
// END_BLOCK_POLICY_PREDICATES
