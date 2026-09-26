// FILE: src/plugins/model-roles/v2.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the v2 model-roles port: agent transform rewriting, default-model selection, title-agent mapping, fail-closed invalid roles, and watcher-driven reload.
//   SCOPE: Unit tests for setupModelRolesV2 with a mocked adapter capturing transforms, editors, and watch callbacks over a temp project directory.
//   DEPENDS: [src/plugins/model-roles/v2.ts, src/plugins/v2-runtime/setup.ts]
//   LINKS: [V-M-PLUGIN-MODEL-ROLES, M-PLUGIN-MODEL-ROLES]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   AgentModel - Model value shape accepted by the fake agent editor (string reference or v2 object form).
//   AgentEditorHarness - Mutable fake agent editor capturing updates.
//   ModelEditorHarness - Mutable fake model editor capturing the default selection.
//   makeAdapter - Builds a mocked v2 adapter wired to the fake editors and a watch registry.
//   withTempProject - Creates a temp project with vvoc and opencode configs for one test body.
//   tempRoots - Temp project roots removed after all tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-006 - Added the v2 model-roles test suite.]
// END_CHANGE_SUMMARY

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupModelRolesV2 } from "./v2.js";
import type { V2AdapterContext } from "../v2-runtime/setup.js";
import { createDefaultVvocConfig } from "../../lib/vvoc-config.js";

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

type AgentModel = string | { providerID: string; id: string; variant?: string };

class AgentEditorHarness {
  /** Source definitions as they would come from config; replay rebuilds from these. */
  readonly sources = new Map<string, { id: string; model?: AgentModel }>();
  private agents = new Map<string, { id: string; model?: AgentModel }>();

  /** Rebuild working state from sources, mirroring v2 replay semantics. */
  rebuild() {
    this.agents = new Map([...this.sources.entries()].map(([id, source]) => [id, { ...source }]));
  }

  list() {
    return [...this.agents.values()];
  }

  update(id: string, update: (draft: { id: string; model?: AgentModel }) => void) {
    const agent = this.agents.get(id);
    if (agent) update(agent);
  }
}

class ModelEditorHarness {
  defaultSelection: { providerID: string; modelID: string } | undefined;

  default = {
    get: () => this.defaultSelection,
    set: (providerID: string, modelID: string) => {
      this.defaultSelection = { providerID, modelID };
    },
  };
}

function makeAdapter(options?: { watchTrigger?: (fire: () => void) => void }) {
  const agentEditor = new AgentEditorHarness();
  const modelEditor = new ModelEditorHarness();
  const watchers: Array<() => void> = [];
  const agentTransforms: Array<() => void> = [];
  const modelTransforms: Array<() => void> = [];
  let agentReloads = 0;
  let modelReloads = 0;
  let fireWatch: (() => void) | undefined;

  const switchedModels: Array<{ sessionID: string; model: unknown }> = [];
  const promptHooks: Array<(event: { sessionID: string }) => Promise<void> | void> = [];
  const adapter = {
    ctx: {
      location: { directory: "/tmp/proj-a", project: { id: "p" } },
      session: {
        hook: async (
          _name: string,
          callback: (event: { sessionID: string }) => Promise<void> | void,
        ) => {
          promptHooks.push(callback);
          return { dispose: async () => {} };
        },
        get: async (input: { sessionID: string }) => ({
          agent: "vv-role-probe",
          sessionID: input.sessionID,
        }),
        switchModel: async (input: { sessionID: string; model: unknown }) => {
          switchedModels.push({ sessionID: input.sessionID, model: input.model });
        },
      },
      agent: {
        transform: async (callback: (editor: AgentEditorHarness) => void) => {
          agentTransforms.push(() => callback(agentEditor));
          return { dispose: async () => {} };
        },
        reload: async () => {
          agentReloads += 1;
          agentEditor.rebuild();
          for (const replay of agentTransforms) replay();
        },
      },
      model: {
        transform: async (callback: (editor: ModelEditorHarness) => void) => {
          modelTransforms.push(() => callback(modelEditor));
          return { dispose: async () => {} };
        },
        reload: async () => {
          modelReloads += 1;
          for (const replay of modelTransforms) replay();
        },
      },
    },
    resolver: {
      forDirectory: async () => undefined,
      forSession: async () => undefined,
      invalidate: () => {},
      cachedDirectories: [],
    },
    watchConfig: async (_directory: string, onChange: () => void) => {
      watchers.push(onChange);
      fireWatch = () => {
        for (const watcher of watchers) watcher();
      };
      options?.watchTrigger?.(fireWatch);
      return () => {
        watchers.length = 0;
      };
    },
  } as unknown as V2AdapterContext;

  return {
    adapter,
    agentEditor,
    modelEditor,
    promptHooks,
    switchedModels,
    counts: {
      get agentReloads() {
        return agentReloads;
      },
      get modelReloads() {
        return modelReloads;
      },
    },
    fireWatch: () => fireWatch?.(),
    firePrompt: async (sessionID: string) => {
      for (const hook of promptHooks) await hook({ sessionID });
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
}

async function withTempProject(setup: {
  roles?: Record<string, string>;
  model?: string;
  smallModel?: string;
  agentModel?: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vvoc-model-roles-"));
  tempRoots.push(root);
  await mkdir(join(root, ".vvoc"), { recursive: true });
  const config = createDefaultVvocConfig() as unknown as Record<string, unknown>;
  if (setup.roles)
    config.roles = {
      default: "z-ai/glm-5.3",
      smart: "z-ai/glm-5.3",
      fast: "z-ai/glm-5.3",
      reviewer: "z-ai/glm-5.3",
      ...setup.roles,
    };
  await writeFile(join(root, ".vvoc", "vvoc.json"), JSON.stringify(config), "utf8");
  if (setup.model || setup.smallModel || setup.agentModel) {
    const opencode: Record<string, unknown> = {};
    if (setup.model) opencode.model = setup.model;
    if (setup.smallModel) opencode.small_model = setup.smallModel;
    if (setup.agentModel) {
      opencode.agent = { "vv-role-probe": { prompt: "probe", model: setup.agentModel } };
    }
    await writeFile(join(root, "opencode.json"), JSON.stringify(opencode), "utf8");
  }
  return root;
}

describe("setupModelRolesV2", () => {
  test("rewrites role-referenced agent models through the transform", async () => {
    const project = await withTempProject({ roles: { primary: "anthropic/claude-sonnet-4-5" } });
    const { adapter, agentEditor } = makeAdapter();
    const cleanup = await setupModelRolesV2({
      ...adapter,
      ctx: { ...adapter.ctx, location: { directory: project, project: { id: "p" } } },
    } as V2AdapterContext);

    agentEditor.sources.set("reviewer", { id: "reviewer", model: "vv-role:primary" });
    agentEditor.sources.set("build", { id: "build", model: "openai/gpt-6" });

    // The transform replays through a reload call in this harness.
    await (adapter.ctx.agent as unknown as { reload: () => Promise<void> }).reload();

    expect(agentEditor.list().find((a) => a.id === "reviewer")?.model).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-5",
    });
    expect(agentEditor.list().find((a) => a.id === "build")?.model).toBe("openai/gpt-6");
    await cleanup?.();
  });

  test("applies the role-referenced default model selection", async () => {
    const project = await withTempProject({
      roles: { primary: "z-ai/glm-5.3" },
      model: "vv-role:primary",
    });
    const { adapter, modelEditor } = makeAdapter();
    const cleanup = await setupModelRolesV2({
      ...adapter,
      ctx: { ...adapter.ctx, location: { directory: project, project: { id: "p" } } },
    } as V2AdapterContext);

    await (adapter.ctx.model as unknown as { reload: () => Promise<void> }).reload();

    expect(modelEditor.defaultSelection).toEqual({ providerID: "z-ai", modelID: "glm-5.3" });
    await cleanup?.();
  });

  test("maps a role-referenced small_model onto the title agent", async () => {
    const project = await withTempProject({
      roles: { small: "deepseek/deepseek-chat" },
      smallModel: "vv-role:small",
    });
    const { adapter, agentEditor } = makeAdapter();
    const cleanup = await setupModelRolesV2({
      ...adapter,
      ctx: { ...adapter.ctx, location: { directory: project, project: { id: "p" } } },
    } as V2AdapterContext);

    agentEditor.sources.set("title", { id: "title" });
    await (adapter.ctx.agent as unknown as { reload: () => Promise<void> }).reload();

    expect(agentEditor.list().find((a) => a.id === "title")?.model).toEqual({
      providerID: "deepseek",
      id: "deepseek-chat",
    });
    await cleanup?.();
  });

  test("fails closed on an unknown role, leaving the agent model untouched", async () => {
    const project = await withTempProject({ roles: { primary: "z-ai/glm-5.3" } });
    const { adapter, agentEditor } = makeAdapter();
    const cleanup = await setupModelRolesV2({
      ...adapter,
      ctx: { ...adapter.ctx, location: { directory: project, project: { id: "p" } } },
    } as V2AdapterContext);

    agentEditor.sources.set("build", { id: "build", model: "vv-role:nonexistent" });
    await (adapter.ctx.agent as unknown as { reload: () => Promise<void> }).reload();

    expect(agentEditor.list().find((a) => a.id === "build")?.model).toBe("vv-role:nonexistent");
    await cleanup?.();
  });

  test("reloads domains after a config change so preset switches apply without restart", async () => {
    const project = await withTempProject({ roles: { primary: "z-ai/glm-5.3" } });
    const { adapter, agentEditor, counts, fireWatch } = makeAdapter();
    const cleanup = await setupModelRolesV2({
      ...adapter,
      ctx: { ...adapter.ctx, location: { directory: project, project: { id: "p" } } },
    } as V2AdapterContext);

    agentEditor.sources.set("reviewer", { id: "reviewer", model: "vv-role:primary" });
    await (adapter.ctx.agent as unknown as { reload: () => Promise<void> }).reload();
    expect(agentEditor.list().find((a) => a.id === "reviewer")?.model).toEqual({
      providerID: "z-ai",
      id: "glm-5.3",
    });

    // Switch the preset: rewrite the roles map and notify the watcher.
    const config = createDefaultVvocConfig() as unknown as Record<string, unknown>;
    config.roles = {
      default: "z-ai/glm-5.3",
      smart: "z-ai/glm-5.3",
      fast: "z-ai/glm-5.3",
      reviewer: "z-ai/glm-5.3",
      primary: "openai/gpt-6",
    };
    await writeFile(join(project, ".vvoc", "vvoc.json"), JSON.stringify(config), "utf8");
    fireWatch();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(counts.agentReloads).toBeGreaterThanOrEqual(2);
    expect(counts.modelReloads).toBeGreaterThanOrEqual(1);
    expect(agentEditor.list().find((a) => a.id === "reviewer")?.model).toEqual({
      providerID: "openai",
      id: "gpt-6",
    });
    await cleanup?.();
  });
});

describe("setupModelRolesV2 prompt model application", () => {
  test("pins the role-resolved model on a session's first prompt and anchors it", async () => {
    const project = await withTempProject({
      roles: { smart: "openai/gpt-6-sol" },
      agentModel: "vv-role:smart",
    });
    const { adapter, firePrompt, switchedModels, fireWatch } = makeAdapter();
    const cleanup = await setupModelRolesV2({
      ...adapter,
      ctx: { ...adapter.ctx, location: { directory: project, project: { id: "p" } } },
    } as V2AdapterContext);

    await firePrompt("ses-a");
    await firePrompt("ses-a");
    expect(switchedModels).toEqual([
      { sessionID: "ses-a", model: { providerID: "openai", id: "gpt-6-sol" } },
    ]);

    // Switch the preset; the anchored session keeps its pinned model, a new
    // session resolves against the refreshed role map.
    const config = createDefaultVvocConfig() as unknown as Record<string, unknown>;
    config.roles = {
      default: "z-ai/glm-5.3",
      smart: "openai/gpt-6-luna",
      fast: "z-ai/glm-5.3",
      reviewer: "z-ai/glm-5.3",
    };
    await writeFile(join(project, ".vvoc", "vvoc.json"), JSON.stringify(config), "utf8");
    fireWatch();
    await new Promise((resolve) => setTimeout(resolve, 30));

    await firePrompt("ses-a");
    await firePrompt("ses-b");
    expect(switchedModels.length).toBe(2);
    expect(switchedModels[1]).toEqual({
      sessionID: "ses-b",
      model: { providerID: "openai", id: "gpt-6-luna" },
    });
    await cleanup?.();
  });
});
