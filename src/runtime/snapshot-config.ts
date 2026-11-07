// FILE: src/runtime/snapshot-config.ts
// VERSION: 3.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Extract the effective runtime policy (roles, agent bindings, full vvoc document) from a loaded vvoc configuration and decode the native session-creation events the runtime consumes for creation-time role reconciliation.
//   SCOPE: Effective role/agent-binding extraction, strict role-selection parsing, native event decoding for session creation and model selection, config-update event identification, and canonical selection normalization. No persistence, no admission, no dispatch validation, no location reload, and no credential handling.
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
//   canonicalModelVariant - Collapse the native absent/`default` variant to undefined.
//   normalizeModelSelection - Normalize one selection to its canonical variant form.
//   decodeSessionCreatedEvent - Decode the session's creation model for creation-time reconciliation.
//   decodeModelSelectedEvent - Decode a native explicit model-selection event.
//   isConfigUpdateEvent - True when a native config change invalidates cached effective config.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SESSION-OWNED-SETTINGS T-002 - Dropped the behaviour projection/hash, initial-selection provenance classification, accepted-input decoding, and config-watch plumbing; role parsing now fails with plain errors because no admission layer remains.]
// END_CHANGE_SUMMARY

import type { VvocConfigSnapshot } from "../lib/config-layers.js";
import type { VvocConfig } from "../lib/vvoc-config.js";
import { getBuiltInRoleBindings, parseModelSelectionWithVariant } from "../lib/model-roles.js";
import type {
  AgentPolicyBinding,
  CapturedVvocConfig,
  EffectiveRuntimeConfig,
  ModelSelection,
  RuntimeEvent,
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
      throw new Error(`Role ${role} has an invalid model binding (${raw}).`, { cause });
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

// START_BLOCK_EVENT_DECODING
/**
 * Collapse the native `default` variant to undefined. Native session rows store
 * `variant ?? "default"` (core/session/info.ts), while `Model.Resolver.withVariant`
 * treats `"default"` as absent and resolution omits it, so the two are the same
 * logical selection.
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
 * switch is a no-op with no event.
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
 * True when the event invalidates the cached effective configuration through a
 * native config change. Never `model.updated`/`agent.updated`: those are emitted
 * by the runtime's own `model.reload()`/`agent.reload()` and would make the
 * refresh re-trigger itself in an unbounded loop.
 */
export function isConfigUpdateEvent(event: RuntimeEvent): boolean {
  return event.type === "config.updated";
}
// END_BLOCK_EVENT_DECODING
