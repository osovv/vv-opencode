// FILE: src/runtime/model-registry.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify family-qualified variant materialization on real native models and snapshot-bound agent policy application.
//   SCOPE: Managed MiMo thinking on the real #thinking model only, missing-model skip, family-filtered projection, family qualification, and literal-model preservation using real native schema fixtures; no host.
//   DEPENDS: [bun:test, @opencode/schema/agent, @opencode/schema/model, @opencode/schema/provider, src/runtime/model-registry.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   createModelEditor - Build an in-memory native-shaped model editor double.
//   createAgentEditor - Build an in-memory native-shaped agent editor double.
//   captureWith - Build a minimal family capture fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-002 - Family-qualified variant and real-MiMo rule coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { Agent } from "@opencode/schema/agent";
import { Model } from "@opencode/schema/model";
import { Provider } from "@opencode/schema/provider";
import { createDefaultVvocConfig } from "../lib/vvoc-config.js";
import {
  applyAgentPolicies,
  applyVariantRegistrations,
  buildVariantRegistrations,
  managedVariantFor,
  primarySelection,
  qualifySelection,
} from "./model-registry.js";
import type {
  AgentEditorLike,
  FamilyCapture,
  ModelEditorLike,
  ModelSelection,
  VariantRegistration,
} from "./types.js";

type ModelInfo = ReturnType<ModelEditorLike["list"]>[number];
type AgentInfo = NonNullable<ReturnType<AgentEditorLike["get"]>>;

interface ModelEditorFixture {
  readonly editor: ModelEditorLike;
  get(providerID: string, modelID: string): ModelInfo | undefined;
  add(providerID: string, modelID: string): void;
  setDefault(providerID: string, modelID: string): void;
  default(): { providerID: string; modelID: string } | undefined;
}

function createModelEditor(): ModelEditorFixture {
  const models = new Map<string, ModelInfo>();
  let currentDefault: { providerID: string; modelID: string } | undefined;
  const editor: ModelEditorLike = {
    list: (providerID) =>
      [...models.values()].filter(
        (model) => providerID === undefined || String(model.providerID) === providerID,
      ),
    get: (providerID, modelID) => models.get(`${providerID}/${modelID}`),
    update: (providerID, modelID, update) => {
      const model = models.get(`${providerID}/${modelID}`);
      if (model !== undefined) update(model);
    },
    default: {
      get: () => currentDefault,
      set: (providerID, modelID) => {
        currentDefault = { providerID, modelID };
      },
    },
  };
  return {
    editor,
    get: (providerID, modelID) => models.get(`${providerID}/${modelID}`),
    add(providerID, modelID) {
      models.set(
        `${providerID}/${modelID}`,
        Model.Info.default(Provider.ID.make(providerID), Model.ID.make(modelID)),
      );
    },
    setDefault(providerID, modelID) {
      currentDefault = { providerID, modelID };
    },
    default: () => currentDefault,
  };
}

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

function captureWith(
  variants: FamilyCapture["variants"],
  overrides: Partial<FamilyCapture> = {},
): FamilyCapture {
  return {
    schemaVersion: 1,
    snapshotId: "snap",
    integrity: "integrity",
    familyId: "ses_root",
    capturedAt: 1,
    location: { directory: "/project", projectID: "proj", canonical: "/project" },
    roles: {},
    roleModels: {},
    agents: [],
    variants,
    modelSettings: [],
    vvoc: createDefaultVvocConfig(),
    intent: { mode: "implicit", source: "config" },
    ...overrides,
  };
}

describe("managedVariantFor", () => {
  test("emits a thinking body only for the real MiMo #thinking model", () => {
    const mimo = managedVariantFor(
      { providerID: "xiaomi", modelID: "mimo-v2.6-flash", variant: "thinking" },
      "snap",
    );
    expect(mimo?.body).toEqual({ thinking: { type: "enabled" } });
    expect(mimo?.sourceVariant).toBe("thinking");
    expect(mimo?.id).toBe("snap.mimo-v2.6-flash.thinking");

    expect(
      managedVariantFor({ providerID: "xiaomi", modelID: "mimo-v2.6-flash" }, "snap"),
    ).toBeUndefined();
    expect(
      managedVariantFor(
        { providerID: "xiaomi", modelID: "other-model", variant: "thinking" },
        "snap",
      ),
    ).toBeUndefined();
    expect(managedVariantFor({ providerID: "openai", modelID: "gpt-5.4" }, "snap")).toBeUndefined();
  });
});

describe("applyVariantRegistrations", () => {
  test("adds a family-qualified variant to a real model and skips missing models", () => {
    const registry = createModelEditor();
    registry.add("xiaomi", "mimo-v2.6-flash");
    const registrations: VariantRegistration[] = [
      {
        providerID: "xiaomi",
        modelID: "mimo-v2.6-flash",
        variant: {
          id: "snap.mimo-v2.6-flash.thinking",
          providerID: "xiaomi",
          modelID: "mimo-v2.6-flash",
          sourceVariant: "thinking",
          body: { thinking: { type: "enabled" } },
        },
      },
      {
        providerID: "ghost",
        modelID: "missing",
        variant: { id: "snap.missing", providerID: "ghost", modelID: "missing" },
      },
    ];

    expect(applyVariantRegistrations(registry.editor, registrations)).toBe(1);
    const model = registry.get("xiaomi", "mimo-v2.6-flash");
    expect(model?.variants.map((variant) => String(variant.id))).toEqual([
      "snap.mimo-v2.6-flash.thinking",
    ]);
    expect(registry.get("ghost", "missing")).toBeUndefined();
    expect(applyVariantRegistrations(registry.editor, registrations)).toBe(0);
  });

  test("buildVariantRegistrations filters by family and primarySelection prefers default", () => {
    const first = captureWith(
      [{ id: "a.m1", providerID: "prov", modelID: "m1", sourceVariant: "thinking" }],
      { familyId: "family-a", roleModels: { default: { providerID: "prov", modelID: "m1" } } },
    );
    const second = captureWith(
      [{ id: "b.m1", providerID: "prov", modelID: "m1", sourceVariant: "thinking" }],
      { familyId: "family-b" },
    );
    expect(buildVariantRegistrations([first, second], "family-b").map((r) => r.variant.id)).toEqual(
      ["b.m1"],
    );
    expect(primarySelection(first)).toEqual({ providerID: "prov", modelID: "m1" });
  });

  test("qualifySelection picks the family's own variant and respects source variants", () => {
    const capture = captureWith([
      { id: "a.m1.thinking", providerID: "prov", modelID: "m1", sourceVariant: "thinking" },
      { id: "a.m1.plain", providerID: "prov", modelID: "m1" },
    ]);
    expect(qualifySelection(capture, { providerID: "prov", modelID: "m1" })).toEqual({
      providerID: "prov",
      modelID: "m1",
      variant: "a.m1.thinking",
    });
    expect(
      qualifySelection(capture, { providerID: "prov", modelID: "m1", variant: "thinking" }),
    ).toEqual({ providerID: "prov", modelID: "m1", variant: "a.m1.thinking" });
    expect(qualifySelection(capture, { providerID: "prov", modelID: "other" })).toEqual({
      providerID: "prov",
      modelID: "other",
    });
  });
});

describe("applyAgentPolicies", () => {
  test("sets snapshot-qualified models only for unset agents and preserves literal models", () => {
    const agents = createAgentEditor();
    const unset = agents.add("build");
    const literal = agents.add("plan", { providerID: "user", modelID: "chosen" });

    const applied = applyAgentPolicies(
      agents.editor,
      [
        { agentID: "build", role: "default", selection: { providerID: "prov", modelID: "m1" } },
        { agentID: "plan", role: "smart", selection: { providerID: "prov", modelID: "m2" } },
        { agentID: "missing", role: "fast", selection: { providerID: "prov", modelID: "m3" } },
      ],
      [
        {
          providerID: "prov",
          modelID: "m1",
          variant: { id: "snap.m1", providerID: "prov", modelID: "m1" },
        },
      ],
    );

    expect(applied).toBe(1);
    expect(unset.model).toEqual({
      id: Model.ID.make("m1"),
      providerID: Provider.ID.make("prov"),
      variant: Model.VariantID.make("snap.m1"),
    });
    expect(literal.model).toEqual({
      id: Model.ID.make("chosen"),
      providerID: Provider.ID.make("user"),
    });
  });
});
