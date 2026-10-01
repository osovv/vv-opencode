// FILE: src/runtime/coordination.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Coordinate data and admission bookkeeping between distinct native plugin Contexts that share one host app/location object identity.
//   SCOPE: Source-proven native object-identity keying (app + location), a shared per-family publication lock reused by every participating snapshot service, and a small shared bag for role-policy contributions, coherent admission inputs, vvoc switch/variant provenance and admission/title bookkeeping. It never shares a client, registration, hook, subscription, challenge, refcount or disposal across contexts, and it never keys on directory strings or RPC-wrapper identity.
//   DEPENDS: []
//   LINKS: [M-NATIVE-RUNTIME, M-PLUGIN-MODEL-ROLES]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   HostSharedState - Cross-context shared bookkeeping for one host app/location identity.
//   HostCoordination - Coordinator handle sharing only locks and admission bookkeeping.
//   CoordinationIdentity - Native object identities used to key a coordinator.
//   nativeObjectId - Stable process-local identity for one native object.
//   coordinationKey - Stable coordinator key from app/location object identity.
//   coordinateHost - Return the shared coordinator for a native app/location identity.
//   resetCoordinationForTests - Clear the process registry (tests only).
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009 - Added the app/location-identity coordinator and shared per-family publication lock so concurrent acceptors across distinct native contexts publish a family capture exactly once.]
// END_CHANGE_SUMMARY

import type { ModelSelection } from "./types.js";

/** Cross-context shared bookkeeping for one host app/location identity. */
export interface HostSharedState {
  /** Last model this plugin switched a session to, keyed by session id. */
  readonly switches: Map<string, ModelSelection>;
  /** Sessions whose native title dispatch the plugin already suppressed. */
  readonly suppressedTitles: Set<string>;
  /** Root selection contributions from participating contexts, keyed by a stable owner id. */
  readonly rolePolicy: Map<string, Readonly<Record<string, string>>>;
  /** Coherent admission inputs computed by participating contexts, keyed by owner id. */
  readonly coherentInputs: Map<string, unknown>;
}

/** Coordinator handle sharing only locks and admission bookkeeping. */
export interface HostCoordination {
  readonly key: string;
  readonly shared: HostSharedState;
  /** Serialize one family's candidate/publication work across every participating service. */
  withFamilyLock<T>(familyId: string, run: () => Promise<T>): Promise<T>;
}

/** Native object identities used to key a coordinator. */
export interface CoordinationIdentity {
  /** Native app object shared by every plugin copied from one host instance. */
  readonly app?: object | undefined;
  /** Native location object; distinct projects/locations never share a coordinator. */
  readonly location?: object | undefined;
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

/** Stable process-local identity for one native object. */
export function nativeObjectId(value: object): number {
  const existing = objectIds.get(value);
  if (existing !== undefined) return existing;
  const id = nextObjectId;
  nextObjectId += 1;
  objectIds.set(value, id);
  return id;
}

/**
 * Stable coordinator key from native app/location object identity. The app object
 * identifies the host instance and the location object scopes it to one project;
 * two contexts copied from the same host share an app reference, so they also
 * share the coordinator. A missing identity yields no coordinator (per-context
 * behavior) rather than a directory-string merge.
 */
export function coordinationKey(identity: CoordinationIdentity): string | undefined {
  const parts: string[] = [];
  if (identity.app !== undefined && typeof identity.app === "object") {
    parts.push(`app:${nativeObjectId(identity.app)}`);
  }
  if (identity.location !== undefined && typeof identity.location === "object") {
    parts.push(`loc:${nativeObjectId(identity.location)}`);
  }
  return parts.length === 0 ? undefined : parts.join("|");
}

const coordinators = new Map<string, HostCoordination>();

/** Return the shared coordinator for a native app/location identity. */
export function coordinateHost(identity: CoordinationIdentity): HostCoordination | undefined {
  const key = coordinationKey(identity);
  if (key === undefined) return undefined;
  const existing = coordinators.get(key);
  if (existing !== undefined) return existing;
  const familyLocks = new Map<string, Promise<unknown>>();
  const shared: HostSharedState = {
    switches: new Map(),
    suppressedTitles: new Set(),
    rolePolicy: new Map(),
    coherentInputs: new Map(),
  };
  const coordinator: HostCoordination = {
    key,
    shared,
    withFamilyLock<T>(familyId: string, run: () => Promise<T>): Promise<T> {
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
    },
  };
  coordinators.set(key, coordinator);
  return coordinator;
}

/** Clear the process registry (tests only). */
export function resetCoordinationForTests(): void {
  coordinators.clear();
}
