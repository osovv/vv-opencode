// FILE: src/runtime/model-registry.test.ts
// VERSION: 3.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify creation-level agent policy application onto real native agents, preserving explicit literal choices.
//   SCOPE: Missing-agent skip, literal-model preservation, and plain selection application using real native schema fixtures; no host.
//   DEPENDS: [bun:test, @opencode/schema/agent, @opencode/schema/model, @opencode/schema/provider, src/runtime/model-registry.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   AgentInfo - Native agent info type alias used by the editor double.
//   AgentEditorFixture - In-memory native-shaped agent editor fixture type.
//   createAgentEditor - Build an in-memory native-shaped agent editor double.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SESSION-OWNED-SETTINGS T-002 - Coverage narrowed to the surviving creation-level agent-policy application.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { Agent } from "@opencode/schema/agent";
import { Model } from "@opencode/schema/model";
import { Provider } from "@opencode/schema/provider";
import { applyAgentPolicies } from "./model-registry.js";
import type { AgentEditorLike, ModelSelection } from "./types.js";

type AgentInfo = NonNullable<ReturnType<AgentEditorLike["get"]>>;

interface AgentEditorFixture {
  readonly editor: AgentEditorLike;
  add(id: string, model?: ModelSelection): AgentInfo;
}

function createAgentEditor(): AgentEditorFixture {
  const agents = new Map<string, AgentInfo>();
  const editor: AgentEditorLike = {
    list: () => [...agents.values()],
    get: (id) => agents.get(id),
    update: (id, update) => {
      const agent = agents.get(id);
      if (agent !== undefined) update(agent);
    },
  };
  return {
    editor,
    add(id, model) {
      const agent: AgentInfo = Agent.Info.default(Agent.ID.make(id));
      if (model !== undefined) {
        agent.model = {
          id: Model.ID.make(model.modelID),
          providerID: Provider.ID.make(model.providerID),
          ...(model.variant === undefined ? {} : { variant: Model.VariantID.make(model.variant) }),
        };
      }
      agents.set(id, agent);
      return agent;
    },
  };
}

describe("applyAgentPolicies", () => {
  test("sets role models only for unset agents and preserves literal models", () => {
    const agents = createAgentEditor();
    const unset = agents.add("build");
    const literal = agents.add("plan", { providerID: "user", modelID: "chosen" });

    const applied = applyAgentPolicies(agents.editor, [
      { agentID: "build", role: "default", selection: { providerID: "prov", modelID: "m1" } },
      { agentID: "plan", role: "smart", selection: { providerID: "prov", modelID: "m2" } },
      { agentID: "missing", role: "fast", selection: { providerID: "prov", modelID: "m3" } },
    ]);

    expect(applied).toBe(1);
    expect(unset.model).toEqual({
      id: Model.ID.make("m1"),
      providerID: Provider.ID.make("prov"),
    });
    expect(literal.model).toEqual({
      id: Model.ID.make("chosen"),
      providerID: Provider.ID.make("user"),
    });
  });

  test("applies the selection variant verbatim and counts each application", () => {
    const agents = createAgentEditor();
    const unset = agents.add("build");
    const applied = applyAgentPolicies(agents.editor, [
      {
        agentID: "build",
        role: "smart",
        selection: { providerID: "prov", modelID: "m2", variant: "thinking" },
      },
      { agentID: "empty", selection: undefined },
    ]);
    expect(applied).toBe(1);
    expect(unset.model).toEqual({
      id: Model.ID.make("m2"),
      providerID: Provider.ID.make("prov"),
      variant: Model.VariantID.make("thinking"),
    });
  });
});
