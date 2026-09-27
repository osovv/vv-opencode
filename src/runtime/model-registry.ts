// FILE: src/runtime/model-registry.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Materialize family-specific snapshot-qualified model variants and snapshot-bound agent policies onto the real native provider/model collection.
//   SCOPE: Managed variant derivation for the real MiMo thinking model only, family-filtered capture-to-registration projection, replay of persisted captures onto real models only, family-qualified selection qualification, and snapshot-bound agent models that preserve explicit literal choices. Never invents alias providers/models and never emits a PDF declaration.
//   DEPENDS: [@opencode/schema/agent, @opencode/schema/model, @opencode/schema/provider, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MIMO_PROVIDER_ID - Managed provider whose real thinking model has a managed variant.
//   MIMO_THINKING_MODEL_ID - Real model id that carries the managed thinking variant.
//   managedVariantFor - Derive a managed snapshot variant for one model selection.
//   primarySelection - Select the capture's default model for admission and bound auxiliary work.
//   qualifySelection - Qualify a family selection with its own captured variant.
//   buildVariantRegistrations - Project captures into family-specific variant registrations.
//   applyVariantRegistrations - Publish registrations onto real models present in the native editor.
//   applyAgentPolicies - Apply snapshot-bound agent selections without overwriting explicit literal models.
//   isManagedThinkingModel - True only for the real MiMo thinking model selection.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-002 - Family-qualified variants, source-variant identity, and MiMo thinking restricted to the real #thinking model.]
// END_CHANGE_SUMMARY

import { Model } from "@opencode/schema/model";
import { Provider } from "@opencode/schema/provider";
import {
  type AgentEditorLike,
  type AgentPolicyBinding,
  type FamilyCapture,
  type ModelEditorLike,
  type ModelSelection,
  type ModelVariantCapture,
  type VariantRegistration,
} from "./types.js";

/** Managed provider whose real thinking model has a managed variant. */
export const MIMO_PROVIDER_ID = "xiaomi";

/** Real model id that carries the managed thinking variant. */
export const MIMO_THINKING_MODEL_ID = "mimo-v2.6-flash";

/** Managed MiMo thinking body: enables thinking, never reasoningEffort, never PDF. */
const MIMO_THINKING_BODY = Object.freeze({ thinking: Object.freeze({ type: "enabled" }) });

/** True only for the real MiMo thinking model selection (`xiaomi/mimo-v2.6-flash#thinking`). */
export function isManagedThinkingModel(selection: ModelSelection): boolean {
  return (
    selection.providerID === MIMO_PROVIDER_ID &&
    selection.modelID === MIMO_THINKING_MODEL_ID &&
    selection.variant === "thinking"
  );
}

/**
 * Derive a managed snapshot variant. The snapshot id is assigned by the capture
 * builder, so `snapshotId` may be empty here and is filled when ids are stamped.
 */
export function managedVariantFor(
  selection: ModelSelection,
  snapshotId: string,
): ModelVariantCapture | undefined {
  if (!isManagedThinkingModel(selection)) return undefined;
  const sourceVariant = "thinking";
  return {
    id: snapshotId === "" ? "" : `${snapshotId}.${selection.modelID}.${sourceVariant}`,
    providerID: selection.providerID,
    modelID: selection.modelID,
    sourceVariant,
    body: { ...MIMO_THINKING_BODY },
  };
}

/** Select the capture's default model for admission and bound auxiliary work. */
export function primarySelection(capture: FamilyCapture): ModelSelection | undefined {
  if (capture.modelOverride !== undefined) return capture.modelOverride;
  if (capture.rootSelection !== undefined) return capture.rootSelection;
  const defaultRole = capture.roleModels.default;
  if (defaultRole !== undefined) return defaultRole;
  for (const selection of Object.values(capture.roleModels)) return selection;
  for (const agent of capture.agents) {
    if (agent.selection !== undefined) return agent.selection;
  }
  return undefined;
}

/** Qualify a family selection with its own captured variant. */
export function qualifySelection(
  capture: FamilyCapture,
  selection: ModelSelection,
): ModelSelection {
  if (selection.variant !== undefined) {
    // Preserve an explicit source variant; only map it to the captured variant id.
    const explicit = capture.variants.find(
      (variant) =>
        variant.providerID === selection.providerID &&
        variant.modelID === selection.modelID &&
        variant.sourceVariant === selection.variant,
    );
    return explicit === undefined ? selection : { ...selection, variant: explicit.id };
  }
  const variant = capture.variants.find(
    (candidate) =>
      candidate.providerID === selection.providerID && candidate.modelID === selection.modelID,
  );
  return variant === undefined ? selection : { ...selection, variant: variant.id };
}

// START_BLOCK_VARIANT_REGISTRY
/** Project captures into family-specific variant registrations. */
export function buildVariantRegistrations(
  captures: readonly FamilyCapture[],
  familyId?: string,
): VariantRegistration[] {
  const registrations: VariantRegistration[] = [];
  const seen = new Set<string>();
  for (const capture of captures) {
    if (familyId !== undefined && capture.familyId !== familyId) continue;
    for (const variant of capture.variants) {
      const key = `${capture.familyId}\u0000${variant.providerID}\u0000${variant.modelID}\u0000${variant.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      registrations.push({
        providerID: variant.providerID,
        modelID: variant.modelID,
        variant,
      });
    }
  }
  return registrations;
}

/** Publish registrations onto real models present in the native editor. */
export function applyVariantRegistrations(
  editor: ModelEditorLike,
  registrations: readonly VariantRegistration[],
): number {
  let applied = 0;
  for (const registration of registrations) {
    // Only real provider/models are touched; missing targets are skipped, never invented.
    if (editor.get(registration.providerID, registration.modelID) === undefined) continue;
    editor.update(registration.providerID, registration.modelID, (model) => {
      if (model.variants.some((variant) => String(variant.id) === registration.variant.id)) return;
      model.variants.push({
        id: Model.VariantID.make(registration.variant.id),
        ...(registration.variant.settings === undefined
          ? {}
          : { settings: { ...registration.variant.settings } }),
        ...(registration.variant.body === undefined
          ? {}
          : { body: { ...registration.variant.body } }),
        ...(registration.variant.headers === undefined
          ? {}
          : { headers: { ...registration.variant.headers } }),
      });
      applied += 1;
    });
  }
  return applied;
}
// END_BLOCK_VARIANT_REGISTRY

// START_BLOCK_AGENT_POLICY
function selectionWithVariant(
  selection: ModelSelection,
  registrations: readonly VariantRegistration[],
): ModelSelection {
  if (selection.variant !== undefined) {
    const sourceMatch = registrations.find(
      (registration) =>
        registration.providerID === selection.providerID &&
        registration.modelID === selection.modelID &&
        registration.variant.sourceVariant === selection.variant,
    );
    return sourceMatch === undefined
      ? selection
      : { ...selection, variant: sourceMatch.variant.id };
  }
  const match = registrations.find(
    (registration) =>
      registration.providerID === selection.providerID &&
      registration.modelID === selection.modelID,
  );
  return match === undefined ? selection : { ...selection, variant: match.variant.id };
}

/** Apply snapshot-bound agent selections without overwriting explicit literal models. */
export function applyAgentPolicies(
  editor: AgentEditorLike,
  bindings: readonly AgentPolicyBinding[],
  registrations: readonly VariantRegistration[] = [],
): number {
  let applied = 0;
  for (const binding of bindings) {
    const captured = binding.selection;
    if (captured === undefined) continue;
    const target = editor.get(binding.agentID);
    // A user-supplied literal model wins; only unset agents adopt the snapshot policy.
    if (target === undefined || target.model !== undefined) continue;
    editor.update(binding.agentID, (agent) => {
      if (agent.model !== undefined) return;
      const selection = selectionWithVariant(captured, registrations);
      agent.model = {
        id: Model.ID.make(selection.modelID),
        providerID: Provider.ID.make(selection.providerID),
        ...(selection.variant === undefined
          ? {}
          : { variant: Model.VariantID.make(selection.variant) }),
      };
      applied += 1;
    });
  }
  return applied;
}
// END_BLOCK_AGENT_POLICY
