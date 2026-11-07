// FILE: src/runtime/model-registry.ts
// VERSION: 3.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Apply role-policy agent models onto the real native agent collection for newly created sessions, preserving explicit literal choices.
//   SCOPE: Agent-policy application that only fills agents without an explicit literal model. Never invents alias providers/models, never touches model variants or per-family qualified selections, and never mutates explicit user choices.
//   DEPENDS: [@opencode/schema/agent, @opencode/schema/model, @opencode/schema/provider, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   applyAgentPolicies - Apply role-policy agent selections without overwriting explicit literal models.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SESSION-OWNED-SETTINGS T-002 - Dropped variant materialization, family-qualified selection, managed variants, and overlay merging; only creation-level agent-policy application remains.]
// END_CHANGE_SUMMARY

import { Model } from "@opencode/schema/model";
import { Provider } from "@opencode/schema/provider";
import type { AgentEditorLike, AgentPolicyBinding, ModelSelection } from "./types.js";

/** Apply role-policy agent selections without overwriting explicit literal models. */
export function applyAgentPolicies(
  editor: AgentEditorLike,
  bindings: readonly AgentPolicyBinding[],
): number {
  let applied = 0;
  for (const binding of bindings) {
    const selection: ModelSelection | undefined = binding.selection;
    if (selection === undefined) continue;
    const target = editor.get(binding.agentID);
    // A user-supplied literal model wins; only unset agents adopt the policy.
    if (target === undefined || target.model !== undefined) continue;
    editor.update(binding.agentID, (agent) => {
      if (agent.model !== undefined) return;
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
