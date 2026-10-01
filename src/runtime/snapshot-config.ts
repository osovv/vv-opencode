// FILE: src/runtime/snapshot-config.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Derive full effective snapshot policy from loaded vvoc configuration, native agent/model overlays, and native config updates, and classify an initial session selection as explicit or implicit without forced location reloads.
//   SCOPE: Effective role/agent-binding extraction, raw custom-agent preservation, native overlay merging, initial-selection provenance from the host default, and config.updated watcher plumbing for unbound candidates. No native client, no persistence, no admission, no location reload.
//   DEPENDS: [src/lib/config-layers.ts, src/lib/model-roles.ts, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   effectiveRuntimeConfig - Extract effective roles, agent bindings and full vvoc document from a loaded snapshot.
//   parseRoleSelections - Parse a role map into concrete selections, failing loudly on invalid bindings.
//   agentBindingsFrom - Derive built-in agent bindings from role assignments and resolved selections.
//   agentPolicyBindings - Derive built-in agent bindings from an effective runtime config.
//   deepCloneConfig - Deep-copy a config document into an immutable captured value.
//   classifyInitialSelection - Classify a host session's model against the default in force at creation.
//   decodeSessionCreatedEvent - Decode the session's creation model for provenance.
//   canonicalModelVariant - Collapse the native absent/`default` variant to undefined.
//   normalizeModelSelection - Normalize one selection to its canonical variant form.
//   decodeModelSelectedEvent - Decode a native explicit model-selection event.
//   decodeInboxEnqueuedEvent - Decode a native accepted-input event (session.inbox.enqueued).
//   isAcceptedWorkloadEvent - True when a native event marks an accepted workload boundary.
//   isConfigUpdateEvent - True when a native config change invalidates unbound candidates.
//   watchConfigUpdates - Consume config.updated events and notify the owner without a forced location reload.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-002 - Full effective config capture, native agent bindings, and initial-selection provenance replace switch-event dependence.]
// END_CHANGE_SUMMARY

import type { VvocConfigSnapshot } from "../lib/config-layers.js";
import type { VvocConfig } from "../lib/vvoc-config.js";
import { getBuiltInRoleBindings, parseModelSelectionWithVariant } from "../lib/model-roles.js";
import {
  SnapshotAdmissionError,
  type AgentPolicyBinding,
  type CaptureIntent,
  type CapturedVvocConfig,
  type EffectiveRuntimeConfig,
  type ModelSelection,
  type RuntimeEvent,
} from "./types.js";

// START_BLOCK_POLICY_EXTRACTION
/** Deep-copy a validated config document into an immutable captured value. */
export function deepCloneConfig(config: VvocConfig): CapturedVvocConfig {
  return structuredClone(config);
}

/** Extract the effective runtime policy (roles, agent bindings, full vvoc) from a loaded vvoc snapshot. */
export function effectiveRuntimeConfig(snapshot: VvocConfigSnapshot): EffectiveRuntimeConfig {
  const builtIn = getBuiltInRoleBindings();
  const agentRoles: Record<string, string> = {
    ...builtIn.opencodeAgents,
    ...builtIn.managedAgents,
  };
  return {
    roles: { ...snapshot.config.roles },
    agentRoles,
    vvoc: deepCloneConfig(snapshot.config),
    ...(snapshot.source.path === undefined ? {} : { sourcePath: snapshot.source.path }),
  };
}

/** Parse a role map into concrete selections, failing loudly on an invalid binding. */
export function parseRoleSelections(
  roles: Readonly<Record<string, string>>,
): Record<string, ModelSelection> {
  const roleModels: Record<string, ModelSelection> = {};
  for (const [role, raw] of Object.entries(roles)) {
    let parsed;
    try {
      parsed = parseModelSelectionWithVariant(raw);
    } catch (cause) {
      throw new SnapshotAdmissionError(
        `Role ${role} has an invalid model binding (${raw}); refusing to capture policy.`,
        { cause },
      );
    }
    roleModels[role] = {
      providerID: parsed.provider,
      modelID: parsed.model,
      ...(parsed.variant === undefined ? {} : { variant: parsed.variant }),
    };
  }
  return roleModels;
}

/** Derive built-in agent bindings (agent id, role, selection) from effective policy. */
export function agentBindingsFrom(
  agentRoles: Readonly<Record<string, string>>,
  roleModels: Readonly<Record<string, ModelSelection>>,
): AgentPolicyBinding[] {
  const bindings: AgentPolicyBinding[] = [];
  for (const [agentID, role] of Object.entries(agentRoles)) {
    const selection = roleModels[role];
    bindings.push({
      agentID,
      role,
      ...(selection === undefined ? {} : { selection }),
    });
  }
  return bindings;
}

/** Derive built-in agent bindings from an effective runtime config. */
export function agentPolicyBindings(effective: EffectiveRuntimeConfig): AgentPolicyBinding[] {
  return agentBindingsFrom(effective.agentRoles, parseRoleSelections(effective.roles));
}
// END_BLOCK_POLICY_EXTRACTION

// START_BLOCK_PROVENANCE
/**
 * Collapse the native `default` variant to undefined. Native session rows store
 * `variant ?? "default"` (core/session/info.ts), while `Model.Resolver.withVariant`
 * treats `"default"` as absent and resolution omits it, so the two are the same
 * logical selection. Keeping them distinct makes ordinary unqualified requests
 * look like named variants and breaks equality/rollback ownership.
 */
export function canonicalModelVariant(variant: string | undefined): string | undefined {
  return variant === undefined || variant === "default" ? undefined : variant;
}

/** Normalize one selection to its canonical (absent-`default`) variant form. */
export function normalizeModelSelection(selection: ModelSelection): ModelSelection {
  const variant = canonicalModelVariant(selection.variant);
  return {
    providerID: selection.providerID,
    modelID: selection.modelID,
    ...(variant === undefined ? {} : { variant }),
  };
}

function sameSelection(
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

/**
 * Classify a host session's model at first work against the host default that was
 * in force when the session was created. A session-local model that differs from
 * that default is an explicit user selection; a matching model followed the
 * implicit default. The default is captured at `session.created` time, not read
 * later, so a preset/config switch does not turn an old implicit tab explicit.
 */
export function classifyInitialSelection(input: {
  readonly sessionModel: ModelSelection | undefined;
  readonly creationDefault: ModelSelection | undefined;
}): CaptureIntent {
  const { sessionModel, creationDefault } = input;
  if (sessionModel === undefined || creationDefault === undefined) {
    return { mode: "implicit", source: "config" };
  }
  if (!sameSelection(sessionModel, creationDefault)) {
    return { mode: "explicit", source: "watcher", literal: sessionModel };
  }
  return { mode: "implicit", source: "config" };
}

/** Decode a native `session.created` payload carrying the session's initial model. */
export function decodeSessionCreatedEvent(
  event: RuntimeEvent,
): { readonly sessionID: string; readonly model?: ModelSelection | undefined } | undefined {
  if (event.type !== "session.created") return undefined;
  const data = event.data;
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const sessionID = record.sessionID;
  if (typeof sessionID !== "string") return undefined;
  const model = decodeModelRef(record.model);
  return { sessionID, ...(model === undefined ? {} : { model }) };
}

function decodeModelRef(value: unknown): ModelSelection | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = record.id;
  const providerID = record.providerID;
  const variant = record.variant;
  if (typeof id !== "string" || typeof providerID !== "string") return undefined;
  if (variant !== undefined && typeof variant !== "string") return undefined;
  const canonical = canonicalModelVariant(variant);
  return { providerID, modelID: id, ...(canonical === undefined ? {} : { variant: canonical }) };
}

/**
 * Decode a native explicit model-selection event (`session.model.selected`). The
 * host emits it only when a switch actually changes the model; an identical
 * switch is a no-op with no event, which is why provenance also reads the session.
 */
export function decodeModelSelectedEvent(event: RuntimeEvent):
  | {
      readonly sessionID: string;
      readonly model: ModelSelection;
    }
  | undefined {
  if (event.type !== "session.model.selected") return undefined;
  const data = event.data;
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const sessionID = record.sessionID;
  const model = decodeModelRef(record.model);
  if (typeof sessionID !== "string" || model === undefined) return undefined;
  return { sessionID, model };
}

/**
 * Decode a native accepted-input event. `session.inbox.enqueued` is the host's
 * durable admission of one input (schema/session-event.ts); `execution.started`
 * can be an explicit resume and is not admission on its own.
 */
export function decodeInboxEnqueuedEvent(event: RuntimeEvent):
  | {
      readonly sessionID: string;
      readonly inboxID: string;
      readonly itemType: string;
      readonly created?: number | undefined;
      readonly seq?: number | undefined;
    }
  | undefined {
  if (event.type !== "session.inbox.enqueued") return undefined;
  const data = event.data;
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const sessionID = record.sessionID;
  const inboxID = record.inboxID;
  if (typeof sessionID !== "string" || typeof inboxID !== "string") return undefined;
  const item = record.item;
  const itemType =
    typeof item === "object" &&
    item !== null &&
    typeof (item as { type?: unknown }).type === "string"
      ? String((item as { type: string }).type)
      : "unknown";
  const created =
    typeof event.created === "number" && Number.isFinite(event.created) ? event.created : undefined;
  const rawSeq = event.durable?.seq;
  const seq = typeof rawSeq === "number" && Number.isFinite(rawSeq) ? rawSeq : undefined;
  return {
    sessionID,
    inboxID,
    itemType,
    ...(created === undefined ? {} : { created }),
    ...(seq === undefined ? {} : { seq }),
  };
}

/**
 * True when the event is a native accepted-input admission: `session.inbox.enqueued`
 * carrying a `user` or `synthetic` item. `session.inbox.delivered` only proves the
 * projection moved, and `session.execution.started` can be an explicit resume, so
 * neither alone authorizes a commit without the matching enqueued identity.
 */
export function isAcceptedWorkloadEvent(event: RuntimeEvent): boolean {
  const enqueued = decodeInboxEnqueuedEvent(event);
  if (enqueued === undefined) return false;
  return enqueued.itemType === "user" || enqueued.itemType === "synthetic";
}

/**
 * True when the event invalidates unbound candidates through a native config
 * change. Never `model.updated`/`agent.updated`: those are emitted by the
 * runtime's own `model.reload()`/`agent.reload()` and would make the refresh
 * re-trigger itself in an unbounded loop.
 */
export function isConfigUpdateEvent(event: RuntimeEvent): boolean {
  return event.type === "config.updated";
}
// END_BLOCK_PROVENANCE

// START_BLOCK_CONFIG_WATCH
/**
 * Consume native config.updated events and notify the owner so cached effective
 * configuration and transforms are rebuilt. Never triggers a forced location
 * reload, and a watcher failure is reported rather than silently swallowed.
 */
export function watchConfigUpdates(
  events: AsyncIterable<RuntimeEvent>,
  onChange: () => void | Promise<void>,
  signal: AbortSignal,
  onError?: (error: unknown) => void,
): () => void {
  let stopped = false;
  const iterator = events[Symbol.asyncIterator]();
  const loop = (async () => {
    try {
      for (;;) {
        if (stopped || signal.aborted) break;
        const next = await iterator.next();
        if (next.done) break;
        if (isConfigUpdateEvent(next.value)) await onChange();
      }
    } catch (error) {
      // A watcher failure is reported to the owner; it is never silently swallowed.
      onError?.(error);
    }
  })();
  return () => {
    stopped = true;
    void loop;
    void iterator.return?.();
  };
}
// END_BLOCK_CONFIG_WATCH
