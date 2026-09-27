// FILE: src/plugins/model-roles.integration.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the native ModelRolesPlugin and the production acquireNativeSnapshotRuntime wrapper against native-shaped transforms, hooks, lineage, provenance, config updates and auxiliary fork work.
//   SCOPE: Native Plugin.define export shape, disabled role override, shared-Context acquisition, staged admission and commit at the accepted inbox boundary, all-kind unbound refusal, agent-aware role selection, initial explicit/implicit provenance, post-bind explicit choices, config.updated reconfiguration, created auxiliary title children, and an optional isolated real OpenCode 2.0.18 host smoke loading the actual built plugin against a loopback provider (skipped unless VVOC_E2E_V2_HOST is set).
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, @opencode/schema/agent, @opencode/schema/model, @opencode/schema/provider, src/lib/vvoc-config.ts, src/plugins/model-roles/index.ts, src/runtime/context.ts, src/runtime/types.ts]
//   LINKS: [M-PLUGIN-MODEL-ROLES, M-NATIVE-RUNTIME, V-M-PLUGIN-MODEL-ROLES]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   FakeNativeContext - Native-shaped context double with editors, sessions, hooks and an event queue.
//   FakeRuntimeHost - In-memory discovery/authentication/client double adding session.fork.
//   createProject - Create an isolated project with a canonical vvoc config file.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-002 - Covers native inbox acceptance, canonical absent/default variants, agent-aware staging, disabled-toggle no-force, post-bind explicit switches, and an optional real-host payload smoke.]
// END_CHANGE_SUMMARY

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@opencode/schema/agent";
import { Model } from "@opencode/schema/model";
import { Provider } from "@opencode/schema/provider";
import type { DeepMutable } from "@opencode/plugin/promise/types";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";
import { ModelRolesPlugin, registerModelRoles } from "./model-roles/index.js";
import {
  acquireNativeSnapshotRuntime,
  type NativeForkClient,
  type NativeRegistration,
  type NativeSnapshotContext,
  type NativeSnapshotHookEvents,
} from "../runtime/context.js";
import {
  type AgentEditorLike,
  type ModelEditorLike,
  type ModelSelection,
  type NativeSessionView,
  type RuntimeClient,
  type RuntimeContext,
  type RuntimeDeps,
  type RuntimeEndpoint,
  type RuntimeEvent,
} from "../runtime/types.js";

const tempDirs: string[] = [];
const previousDataHome = process.env.XDG_DATA_HOME;
const previousVvocConfig = process.env.VVOC_CONFIG;

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  if (previousVvocConfig === undefined) delete process.env.VVOC_CONFIG;
  else process.env.VVOC_CONFIG = previousVvocConfig;
});

async function createProject(roles: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vvoc-mr-project-"));
  tempDirs.push(dir);
  await writeVvoc(dir, roles);
  return dir;
}

async function writeVvoc(dir: string, roles: Record<string, string>): Promise<void> {
  await mkdir(join(dir, ".vvoc"), { recursive: true });
  await writeFile(
    join(dir, ".vvoc", "vvoc.json"),
    renderVvocConfig({ ...createDefaultVvocConfig(), roles }),
    "utf8",
  );
}

async function writeOpenCodeConfig(dir: string, value: unknown): Promise<void> {
  await mkdir(join(dir, ".opencode"), { recursive: true });
  await writeFile(join(dir, ".opencode", "opencode.json"), JSON.stringify(value, null, 2), "utf8");
}

async function isolateDataHome(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vvoc-mr-data-"));
  tempDirs.push(dir);
  process.env.XDG_DATA_HOME = dir;
  delete process.env.VVOC_CONFIG;
}

type AgentInfo = DeepMutable<Agent.Info>;
type ModelInfo = DeepMutable<Model.Info>;

class EventQueue {
  private readonly events: RuntimeEvent[] = [];
  private waiter: (() => void) | undefined;

  push(event: RuntimeEvent): void {
    this.events.push(event);
    this.waiter?.();
    this.waiter = undefined;
  }

  drain(): AsyncIterable<RuntimeEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<RuntimeEvent> => ({
        next: () => {
          const next = this.events.shift();
          if (next !== undefined) return Promise.resolve({ done: false as const, value: next });
          return new Promise((resolve) => {
            this.waiter = () => {
              const value = this.events.shift();
              resolve(
                value === undefined
                  ? { done: true as const, value: undefined }
                  : { done: false as const, value },
              );
            };
          });
        },
        return: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    };
  }
}

class FakeNativeContext implements NativeSnapshotContext {
  readonly handlers = new Map<string, Record<string, (input: unknown) => Promise<unknown>>>();
  readonly rpc: RuntimeContext["rpc"] = {
    register: async (definition, handlers) => {
      this.handlers.set(
        definition.id,
        handlers as unknown as Record<string, (input: unknown) => Promise<unknown>>,
      );
      return {
        dispose: async () => {
          this.handlers.delete(definition.id);
        },
      };
    },
  };
  readonly agents = new Map<string, AgentInfo>();
  readonly models = new Map<string, ModelInfo>();
  readonly sessions = new Map<string, NativeSessionView>();
  readonly sessionModels = new Map<string, ModelSelection>();
  readonly switchCalls: Array<{ sessionID: string; model: ModelSelection }> = [];
  readonly updateCalls: Array<{ sessionID: string; title: string }> = [];
  readonly generateCalls: Array<{ sessionID: string; prompt: string }> = [];
  readonly createCalls: Array<{
    sessionID: string;
    title?: string;
    agent?: string;
    model?: { id: string; providerID: string; variant?: string };
    location?: { directory: string };
  }> = [];
  createdSessions = 0;
  readonly forkCalls: string[] = [];
  readonly events = new EventQueue();
  modelReloads = 0;
  agentReloads = 0;
  private defaultModel: { providerID: string; modelID: string } | undefined;
  private readonly hooks = new Map<
    keyof NativeSnapshotHookEvents,
    (event: never) => void | Promise<void>
  >();
  private readonly agentTransforms: Array<(editor: AgentEditorLike) => void> = [];
  private readonly modelTransforms: Array<(editor: ModelEditorLike) => void> = [];

  readonly location: {
    directory: string;
    project: { id: string; directory: string; canonical: string };
  };

  constructor(directory: string, projectID = "proj") {
    this.location = { directory, project: { id: projectID, directory, canonical: directory } };
  }

  addAgent(id: string, model?: ModelSelection): AgentInfo {
    const agent: AgentInfo = Agent.Info.default(Agent.ID.make(id));
    if (model !== undefined) {
      agent.model = {
        id: Model.ID.make(model.modelID),
        providerID: Provider.ID.make(model.providerID),
        ...(model.variant === undefined ? {} : { variant: Model.VariantID.make(model.variant) }),
      };
    }
    this.agents.set(id, agent);
    return agent;
  }

  addModel(providerID: string, modelID: string, body?: Record<string, unknown>): ModelInfo {
    const model: ModelInfo = Model.Info.default(
      Provider.ID.make(providerID),
      Model.ID.make(modelID),
    );
    if (body !== undefined) model.body = body;
    this.models.set(`${providerID}/${modelID}`, model);
    return model;
  }

  setDefault(providerID: string, modelID: string): void {
    this.defaultModel = { providerID, modelID };
  }

  private agentEditor(): AgentEditorLike {
    return {
      list: () => [...this.agents.values()],
      get: (id) => this.agents.get(id),
      update: (id, update) => {
        const agent = this.agents.get(id);
        if (agent !== undefined) update(agent);
      },
    };
  }

  private modelEditor(): ModelEditorLike {
    return {
      list: () => [...this.models.values()],
      get: (providerID, modelID) => this.models.get(`${providerID}/${modelID}`),
      update: (providerID, modelID, update) => {
        const model = this.models.get(`${providerID}/${modelID}`);
        if (model !== undefined) update(model);
      },
      default: {
        get: () => this.defaultModel,
        set: (providerID, modelID) => {
          this.defaultModel = { providerID, modelID };
        },
      },
    };
  }

  readonly agent = {
    transform: async (callback: (editor: AgentEditorLike) => void) => {
      this.agentTransforms.push(callback);
      return this.registration();
    },
    reload: async () => {
      this.agentReloads += 1;
      for (const callback of this.agentTransforms) callback(this.agentEditor());
    },
  };

  readonly model = {
    transform: async (callback: (editor: ModelEditorLike) => void) => {
      this.modelTransforms.push(callback);
      return this.registration();
    },
    reload: async () => {
      this.modelReloads += 1;
      for (const callback of this.modelTransforms) callback(this.modelEditor());
    },
  };

  readonly session = {
    create: async (input: {
      title?: string;
      agent?: string;
      model?: { id: string; providerID: string; variant?: string };
      location?: { directory: string };
    }) => {
      this.createdSessions += 1;
      const id = `aux-${this.createdSessions}`;
      this.sessions.set(id, {
        id,
        locationDirectory: input.location?.directory ?? this.location.directory,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
      });
      if (input.model !== undefined) {
        this.sessionModels.set(id, {
          providerID: input.model.providerID,
          modelID: input.model.id,
          ...(input.model.variant === undefined ? {} : { variant: input.model.variant }),
        });
      }
      this.createCalls.push({
        sessionID: id,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.location === undefined ? {} : { location: input.location }),
      });
      return { id };
    },
    get: async ({ sessionID }: { sessionID: string }) => {
      const view = this.sessions.get(sessionID);
      if (view === undefined) throw new Error(`unknown session ${sessionID}`);
      const model = this.sessionModels.get(sessionID) ?? view.model;
      return {
        id: view.id,
        ...(view.parentID === undefined ? {} : { parentID: view.parentID }),
        ...(view.forkSessionID === undefined ? {} : { fork: { sessionID: view.forkSessionID } }),
        ...(view.agent === undefined ? {} : { agent: view.agent }),
        location: { directory: view.locationDirectory ?? this.location.directory },
        ...(model === undefined
          ? {}
          : {
              model: {
                id: model.modelID,
                providerID: model.providerID,
                ...(model.variant === undefined ? {} : { variant: model.variant }),
              },
            }),
        time: { created: 0, ...(view.hasActivity === true ? { idle: 1 } : {}) },
        tokens: { input: 0, output: 0 },
      };
    },
    switchModel: async ({
      sessionID,
      model,
    }: {
      sessionID: string;
      model: { id: string; providerID: string; variant?: string };
    }) => {
      const selection: ModelSelection = {
        providerID: model.providerID,
        modelID: model.id,
        ...(model.variant === undefined ? {} : { variant: model.variant }),
      };
      this.switchCalls.push({ sessionID, model: selection });
      this.sessionModels.set(sessionID, selection);
    },
    update: async ({ sessionID, title }: { sessionID: string; title: string }) => {
      this.updateCalls.push({ sessionID, title });
    },
    generate: async ({ sessionID, prompt }: { sessionID: string; prompt: string }) => {
      this.generateCalls.push({ sessionID, prompt });
      return { text: `generated:${sessionID}` };
    },
    hook: async <Name extends keyof NativeSnapshotHookEvents>(
      name: Name,
      callback: (event: NativeSnapshotHookEvents[Name]) => void | Promise<void>,
    ): Promise<NativeRegistration> => {
      this.hooks.set(name, callback as (event: never) => void | Promise<void>);
      return this.registration();
    },
  };

  readonly event = {
    subscribe: () => this.events.drain(),
  };

  async invoke<Name extends keyof NativeSnapshotHookEvents>(
    name: Name,
    event: NativeSnapshotHookEvents[Name],
  ): Promise<void> {
    const callback = this.hooks.get(name) as
      | ((event: NativeSnapshotHookEvents[Name]) => void | Promise<void>)
      | undefined;
    await callback?.(event);
  }

  /**
   * Production-compatible seam: a real Plugin.Context satisfies the narrow
   * snapshot context, so this fake is the same shape the wrapper receives.
   */
  private registration(): NativeRegistration {
    return { dispose: async () => undefined };
  }
}

// START_BLOCK_RUNTIME_HOST
class FakeRuntimeHost {
  private readonly endpoints: RuntimeEndpoint = {
    url: "http://127.0.0.1:45678",
    auth: { type: "basic", username: "opencode", password: "secret" },
  };

  constructor(private readonly context: FakeNativeContext) {}

  createDeps(): RuntimeDeps<NativeForkClient> {
    return {
      serviceVersion: "2.0.18",
      discoverService: async () => this.endpoints,
      serviceHeaders: () => ({ authorization: "Basic fake" }),
      makeClient: () => this.createClient(),
    };
  }

  private createClient(): NativeForkClient {
    const rpc = ((definition: { id: string; methods: Record<string, unknown> }) => {
      const methods: Record<string, (input: unknown) => Promise<unknown>> = {};
      for (const name of Object.keys(definition.methods)) {
        methods[name] = async (input) => {
          const handler = this.context.handlers.get(definition.id)?.[name];
          if (handler === undefined)
            throw new Error(`unknown rpc handler ${definition.id}.${name}`);
          return handler(input);
        };
      }
      return methods as unknown as RuntimeClient["rpc"];
    }) as unknown as RuntimeClient["rpc"];

    return {
      rpc,
      permission: {
        create: async () => ({ id: "per", effect: "deny" as const }),
        get: async () => {
          throw new Error("unused");
        },
        reply: async () => undefined,
      },
      event: {
        subscribe: () => ({ async *[Symbol.asyncIterator]() {} }),
      },
      session: {
        fork: async ({ sessionID }: { sessionID: string }) => {
          this.context.forkCalls.push(sessionID);
          return { id: `fork-${this.context.forkCalls.length}` };
        },
      },
    };
  }
}
// END_BLOCK_RUNTIME_HOST

function makeBoundSession(
  context: FakeNativeContext,
  id: string,
  view: Partial<NativeSessionView> = {},
): void {
  context.sessions.set(id, { id, locationDirectory: context.location.directory, ...view });
}

describe("ModelRolesPlugin native delegation", () => {
  test("exposes a native Plugin.define object", () => {
    expect(typeof ModelRolesPlugin).toBe("object");
    expect(typeof ModelRolesPlugin.setup).toBe("function");
    expect(ModelRolesPlugin.id).toBe("vvoc.model-roles");
  });

  test("shares one snapshot runtime for the same Context and exposes the same service to later plugins", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    const runtimeDeps = host.createDeps();

    const first = await acquireNativeSnapshotRuntime(context, { runtimeDeps });
    const second = await acquireNativeSnapshotRuntime(context, { runtimeDeps });
    expect(second.snapshots).toBe(first.snapshots);
    await first.release();
    await second.release();
  });

  test("disabled role override still captures policy while leaving agent models untouched", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1", smart: "prov/m2" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addAgent("vv-controller");

    const registration = await registerModelRoles(context, {
      enabled: false,
      runtimeDeps: host.createDeps(),
    });
    expect(context.agents.get("vv-controller")?.model).toBeUndefined();
    await registration.dispose();
  });

  test("enabled role override selects the correct role for vv-controller, not the default", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1", smart: "prov/m2" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addAgent("vv-controller");
    context.addAgent("plan", { providerID: "user", modelID: "literal" });

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    expect(context.agents.get("vv-controller")?.model).toEqual({
      id: Model.ID.make("m2"),
      providerID: Provider.ID.make("prov"),
    });
    expect(context.agents.get("plan")?.model).toEqual({
      id: Model.ID.make("literal"),
      providerID: Provider.ID.make("user"),
    });
    await registration.dispose();
  });
});

describe("native snapshot runtime admission", () => {
  test("stages on prompt, commits at the accepted model.request boundary, and materializes the qualified variant", async () => {
    await isolateDataHome();
    const project = await createProject({
      default: "prov/m1",
      smart: "xiaomi/mimo-v2.6-flash#thinking",
    });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addModel("prov", "m1", { temperature: 0 });
    context.addModel("xiaomi", "mimo-v2.6-flash");
    context.setDefault("prov", "m1");
    makeBoundSession(context, "root", { model: { providerID: "prov", modelID: "m1" } });

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    await context.invoke("prompt", { sessionID: "root" });

    expect(context.switchCalls).toHaveLength(1);
    expect(context.switchCalls[0]?.model).toEqual({
      providerID: "prov",
      modelID: "m1",
      variant: expect.stringMatching(/^[0-9a-f]+\.m1$/),
    });
    const resolved = context.switchCalls[0]?.model;
    await context.invoke("model.request", {
      sessionID: "root",
      model: {
        id: resolved?.modelID ?? "m1",
        providerID: resolved?.providerID ?? "prov",
        ...(resolved?.variant === undefined ? {} : { variant: resolved.variant }),
      },
      kind: "primary",
    });

    const mimo = context.models.get("xiaomi/mimo-v2.6-flash");
    expect(mimo?.body).toBeUndefined();
    // The managed MiMo thinking variant exists on the real model after commit + refresh.
    expect(context.modelReloads).toBeGreaterThan(1);

    // The plugin's own materialized variant must never be re-captured as a native overlay.
    const runtime = await acquireNativeSnapshotRuntime(context, {
      runtimeDeps: host.createDeps(),
    });
    const captures = await runtime.snapshots.captures();
    const generatedIds = new Set(
      captures.flatMap((capture) => capture.variants.map((variant) => variant.id)),
    );
    const accumulated = captures.flatMap((capture) =>
      capture.modelSettings.filter(
        (settings) => settings.variant !== undefined && generatedIds.has(settings.variant),
      ),
    );
    expect(accumulated).toEqual([]);
    await runtime.release();
    await registration.dispose();
  });

  test("refuses unbound dispatch for every request kind", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    makeBoundSession(context, "unbound");

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    for (const kind of ["primary", "title", "compaction", "generate"]) {
      await expect(
        context.invoke("model.request", {
          sessionID: "unbound",
          model: { id: "m1", providerID: "prov" },
          kind,
        }),
      ).rejects.toThrow(/unbound/);
    }
    await registration.dispose();
  });

  test("initial selection differing from the default is preserved as explicit", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addModel("prov", "m1");
    context.addModel("prov", "user-pick");
    context.setDefault("prov", "m1");
    makeBoundSession(context, "explicit", {
      model: { providerID: "prov", modelID: "user-pick" },
    });

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    await context.invoke("prompt", { sessionID: "explicit" });

    expect(context.switchCalls[0]?.model).toEqual({ providerID: "prov", modelID: "user-pick" });
    await registration.dispose();
  });

  test("a config.updated switch changes future sessions while a bound family stays frozen", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addModel("prov", "m1");
    context.addModel("prov", "m9");
    context.setDefault("prov", "m1");
    makeBoundSession(context, "bound", { model: { providerID: "prov", modelID: "m1" } });
    makeBoundSession(context, "fresh", { model: { providerID: "prov", modelID: "m1" } });

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    await context.invoke("prompt", { sessionID: "bound" });
    await context.invoke("model.request", {
      sessionID: "bound",
      model: { id: "m1", providerID: "prov" },
      kind: "primary",
    });
    expect(context.switchCalls).toHaveLength(1);

    await writeVvoc(project, { default: "prov/m9" });
    context.events.push({ type: "config.updated" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A fresh session created after the preset switch carries the new default, so it is implicit.
    context.sessionModels.set("fresh", { providerID: "prov", modelID: "m9" });
    await context.invoke("prompt", { sessionID: "fresh" });
    const freshSwitch = context.switchCalls.at(-1);
    expect(freshSwitch?.model.providerID).toBe("prov");
    expect(freshSwitch?.model.modelID).toBe("m9");

    // The bound family stays frozen even after the preset switch.
    await context.invoke("prompt", { sessionID: "bound" });
    const boundSwitches = context.switchCalls.filter((call) => call.sessionID === "bound");
    expect(boundSwitches).toHaveLength(1);
    expect(boundSwitches[0]?.model.modelID).toBe("m1");
    await registration.dispose();
  });

  test("a fresh runtime at a moved worktree finds the root capture and does not re-bind", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addModel("prov", "m1");
    context.setDefault("prov", "m1");
    makeBoundSession(context, "root", { model: { providerID: "prov", modelID: "m1" } });

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    await context.invoke("prompt", { sessionID: "root" });
    await context.invoke("model.request", {
      sessionID: "root",
      model: { id: "m1", providerID: "prov" },
      kind: "primary",
    });
    expect(context.switchCalls).toHaveLength(1);
    await registration.dispose();

    // Moved worktree: different directory, same project scope and root session.
    const worktree = await createProject({ default: "prov/m1" });
    const moved = new FakeNativeContext(worktree, "proj");
    const movedHost = new FakeRuntimeHost(moved);
    moved.addModel("prov", "m1");
    moved.setDefault("prov", "m1");
    makeBoundSession(moved, "root", {
      model: { providerID: "prov", modelID: "m1" },
      locationDirectory: worktree,
    });
    const movedRegistration = await registerModelRoles(moved, {
      enabled: true,
      runtimeDeps: movedHost.createDeps(),
    });
    await moved.invoke("prompt", { sessionID: "root" });

    expect(moved.switchCalls).toHaveLength(0);
    await expect(
      moved.invoke("model.request", {
        sessionID: "root",
        model: { id: "m1", providerID: "prov" },
        kind: "primary",
      }),
    ).resolves.toBeUndefined();
    await movedRegistration.dispose();
  });

  test("a bound family refuses a resolved model that mismatches its capture", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addModel("prov", "m1");
    context.setDefault("prov", "m1");
    makeBoundSession(context, "root", { model: { providerID: "prov", modelID: "m1" } });

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    await context.invoke("prompt", { sessionID: "root" });
    await context.invoke("model.request", {
      sessionID: "root",
      model: { id: "m1", providerID: "prov" },
      kind: "primary",
    });

    await expect(
      context.invoke("model.request", {
        sessionID: "root",
        model: { id: "m9", providerID: "prov" },
        kind: "primary",
      }),
    ).rejects.toThrow(/does not match/);
    await registration.dispose();
  });

  test("raw OpenCode agent intent overrides the built-in role for a custom agent", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1", smart: "prov/m2" });
    await writeOpenCodeConfig(project, {
      agent: { build: { model: "vv-role:smart" }, custom: { model: "prov/custom-literal" } },
    });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addAgent("build");
    context.addAgent("custom");

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    expect(context.agents.get("build")?.model).toEqual({
      id: Model.ID.make("m2"),
      providerID: Provider.ID.make("prov"),
    });
    expect(context.agents.get("custom")?.model).toEqual({
      id: Model.ID.make("custom-literal"),
      providerID: Provider.ID.make("prov"),
    });
    await registration.dispose();
  });

  test("an accepted session.inbox.enqueued commits the staged family without a model.request", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addModel("prov", "m1");
    context.setDefault("prov", "m1");
    makeBoundSession(context, "root", { model: { providerID: "prov", modelID: "m1" } });

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    await context.invoke("prompt", { sessionID: "root" });
    expect(context.switchCalls).toHaveLength(1);
    const reloadsBefore = context.modelReloads;

    context.events.push({
      type: "session.inbox.enqueued",
      data: { sessionID: "root", inboxID: "msg-1", item: { type: "user" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.modelReloads).toBeGreaterThan(reloadsBefore);

    // A bare execution.started (explicit resume) is NOT admission and must not commit.
    const reloadsAfter = context.modelReloads;
    makeBoundSession(context, "resume", { model: { providerID: "prov", modelID: "m1" } });
    context.events.push({ type: "session.execution.started", data: { sessionID: "resume" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(context.modelReloads).toBe(reloadsAfter);

    // The family is now bound: a later prompt reuses it without switching.
    await context.invoke("prompt", { sessionID: "root" });
    expect(context.switchCalls).toHaveLength(1);
    await registration.dispose();
  });

  test("an old implicit tab follows a new default after a config.updated switch", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addModel("prov", "m1");
    context.addModel("prov", "m9");
    context.setDefault("prov", "m1");
    makeBoundSession(context, "old-tab", { model: { providerID: "prov", modelID: "m1" } });

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    // The host observed the tab's creation model before the preset switch.
    context.events.push({
      type: "session.created",
      data: { sessionID: "old-tab", model: { id: "m1", providerID: "prov" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    await writeVvoc(project, { default: "prov/m9" });
    context.events.push({ type: "config.updated" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await context.invoke("prompt", { sessionID: "old-tab" });
    expect(context.switchCalls.at(-1)?.model.modelID).toBe("m9");
    await registration.dispose();
  });

  test("title work creates a bound auxiliary child without fork, keeps messages, and fills the title slot", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1", fast: "prov/m1" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addModel("prov", "m1");
    context.setDefault("prov", "m1");
    makeBoundSession(context, "root", { model: { providerID: "prov", modelID: "m1" } });

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    await context.invoke("prompt", { sessionID: "root" });
    await context.invoke("model.request", {
      sessionID: "root",
      model: { id: "m1", providerID: "prov" },
      kind: "primary",
    });
    const event: { sessionID: string; result?: string; messages?: unknown } = {
      sessionID: "root",
      messages: [{ role: "user", content: "fix the parser bug" }],
    };
    await context.invoke("title", event);

    // A created bound child, never a fork that copies the parent agent.
    expect(context.forkCalls).toEqual([]);
    expect(context.createCalls).toHaveLength(1);
    expect(context.createCalls[0]?.model).toEqual({ id: "m1", providerID: "prov" });
    expect(context.updateCalls[0]?.title ?? context.createCalls[0]?.title).toContain("vvoc title");
    expect(context.generateCalls[0]?.prompt).toContain("fix the parser bug");
    expect(event.result).toBe("generated:aux-1");

    // A supplied title result must survive the later title model.request hook.
    await expect(
      context.invoke("model.request", {
        sessionID: "root",
        agent: "title",
        model: { id: "m1", providerID: "prov" },
        kind: "title",
      }),
    ).resolves.toBeUndefined();
    await registration.dispose();
  });
});

describe("native lifecycle provenance, resolver coherence and concurrency", () => {
  test("model.updated never re-triggers the config watcher, so reloads cannot loop", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addModel("prov", "m1");
    context.setDefault("prov", "m1");
    makeBoundSession(context, "root", { model: { providerID: "prov", modelID: "m1" } });

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    const reloadsBefore = context.modelReloads;
    for (let index = 0; index < 8; index += 1) {
      context.events.push({ type: "model.updated" });
      context.events.push({ type: "agent.updated" });
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    // Own reload output must not drive the refresh path that emitted it.
    expect(context.modelReloads).toBe(reloadsBefore);
    await registration.dispose();
  });

  test("the session agent selects its role (smart) rather than the family default", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1", smart: "prov/m2" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addAgent("vv-controller");
    context.addModel("prov", "m1");
    context.addModel("prov", "m2");
    context.setDefault("prov", "m1");
    makeBoundSession(context, "root", {
      model: { providerID: "prov", modelID: "m1" },
      agent: "vv-controller",
    });

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    await context.invoke("prompt", { sessionID: "root" });
    expect(context.switchCalls.at(-1)?.model.modelID).toBe("m2");
    await expect(
      context.invoke("model.request", {
        sessionID: "root",
        agent: "vv-controller",
        model: { id: "m2", providerID: "prov" },
        kind: "primary",
      }),
    ).resolves.toBeUndefined();
    await registration.dispose();
  });

  test("disabled role override binds policy without forcing any model switch", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1", smart: "prov/m2" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addModel("prov", "m1");
    context.addModel("prov", "m2");
    context.setDefault("prov", "m1");
    makeBoundSession(context, "root", { model: { providerID: "prov", modelID: "m1" } });

    const registration = await registerModelRoles(context, {
      enabled: false,
      runtimeDeps: host.createDeps(),
    });
    await context.invoke("prompt", { sessionID: "root" });
    expect(context.switchCalls).toHaveLength(0);
    await expect(
      context.invoke("model.request", {
        sessionID: "root",
        model: { id: "m1", providerID: "prov" },
        kind: "primary",
      }),
    ).resolves.toBeUndefined();
    await registration.dispose();
  });

  test("an explicit model chosen at creation is preserved over the implicit default", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addModel("prov", "m1");
    context.addModel("prov", "m9");
    context.setDefault("prov", "m1");
    makeBoundSession(context, "root", { model: { providerID: "prov", modelID: "m9" } });
    // The host recorded the tab creation with the explicit model and the m1 default.
    context.events.push({
      type: "session.created",
      data: { sessionID: "root", model: { id: "m9", providerID: "prov" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    await context.invoke("prompt", { sessionID: "root" });
    expect(context.switchCalls.at(-1)?.model.modelID).toBe("m9");
    await expect(
      context.invoke("model.request", {
        sessionID: "root",
        model: { id: "m9", providerID: "prov" },
        kind: "primary",
      }),
    ).resolves.toBeUndefined();
    await registration.dispose();
  });

  test("a post-bind explicit user switch is neither overwritten nor refused", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addModel("prov", "m1");
    context.addModel("prov", "m9");
    context.setDefault("prov", "m1");
    makeBoundSession(context, "root", { model: { providerID: "prov", modelID: "m1" } });

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    await context.invoke("prompt", { sessionID: "root" });
    await context.invoke("model.request", {
      sessionID: "root",
      model: { id: "m1", providerID: "prov" },
      kind: "primary",
    });
    const switchesAfterBind = context.switchCalls.length;

    context.events.push({
      type: "session.model.selected",
      data: { sessionID: "root", model: { id: "m9", providerID: "prov" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await context.invoke("prompt", { sessionID: "root" });
    expect(context.switchCalls).toHaveLength(switchesAfterBind);
    await expect(
      context.invoke("model.request", {
        sessionID: "root",
        model: { id: "m9", providerID: "prov" },
        kind: "primary",
      }),
    ).resolves.toBeUndefined();
    await registration.dispose();
  });

  test("unbound direct generate is refused instead of staged after resolution", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addModel("prov", "m1");
    context.setDefault("prov", "m1");
    makeBoundSession(context, "root", { model: { providerID: "prov", modelID: "m1" } });

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    await expect(context.invoke("generate", { sessionID: "root" })).rejects.toThrow(/unbound/);
    expect(context.switchCalls).toHaveLength(0);
    await registration.dispose();
  });

  test("the native absent/default variant is accepted without being a named variant", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addModel("prov", "m1");
    context.setDefault("prov", "m1");
    makeBoundSession(context, "root", {
      model: { providerID: "prov", modelID: "m1", variant: "default" },
    });

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    await context.invoke("prompt", { sessionID: "root" });
    // The host resolves `default` to no variant; the guard must treat them as equal.
    await expect(
      context.invoke("model.request", {
        sessionID: "root",
        model: { id: "m1", providerID: "prov", variant: "default" },
        kind: "primary",
      }),
    ).resolves.toBeUndefined();
    await registration.dispose();
  });

  test("two concurrent families in one runtime keep independent staged switches", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1", smart: "prov/m2" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    context.addModel("prov", "m1");
    context.addModel("prov", "m2");
    context.setDefault("prov", "m1");
    makeBoundSession(context, "a", { model: { providerID: "prov", modelID: "m1" } });
    makeBoundSession(context, "b", {
      model: { providerID: "prov", modelID: "m2" },
      agent: "vv-controller",
    });
    context.addAgent("vv-controller");

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: host.createDeps(),
    });
    await Promise.all([
      context.invoke("prompt", { sessionID: "a" }),
      context.invoke("prompt", { sessionID: "b" }),
    ]);
    const bySession = new Map(context.switchCalls.map((call) => [call.sessionID, call.model]));
    expect(bySession.get("a")?.modelID).toBe("m1");
    expect(bySession.get("b")?.modelID).toBe("m2");
    await registration.dispose();
  });
});

// START_BLOCK_REAL_HOST_SMOKE
/**
 * Optional isolated real-host smoke. Runs only when `VVOC_E2E_V2_HOST` points at
 * the pinned OpenCode 2.0.18 binary; otherwise it is skipped so ordinary test
 * runs stay hermetic. It loads the actual built ModelRolesPlugin (never a
 * fixture reimplementation) with a loopback provider and asserts the payload
 * that actually reached the provider.
 */
const REAL_HOST = process.env.VVOC_E2E_V2_HOST;
const smokeDescribe = REAL_HOST ? describe : describe.skip;

smokeDescribe("real OpenCode 2.0.18 host smoke (actual built plugin)", () => {
  const ROOT = join(
    process.env.VVOC_E2E_SCRATCH ?? "/tmp/opencode",
    `vvoc-t002-smoke-${process.pid}`,
  );
  const DIST_PLUGIN = join(
    import.meta.dir,
    "..",
    "..",
    "dist",
    "plugins",
    "model-roles",
    "index.js",
  );
  const PORT = 39247;
  const HOST_PORT = 42947;
  const providerTrace = join(ROOT, "trace", "provider.jsonl");
  const observerTrace = join(ROOT, "trace", "observer.jsonl");
  const pids: number[] = [];

  test("loads the built plugin, binds a variant, and sends it in the provider payload", async () => {
    await rm(ROOT, { recursive: true, force: true });
    await mkdir(join(ROOT, "project", ".vvoc"), { recursive: true });
    await mkdir(join(ROOT, "trace"), { recursive: true });
    await mkdir(join(ROOT, "home"), { recursive: true });
    await mkdir(join(ROOT, "cfg"), { recursive: true });
    await mkdir(join(ROOT, "data"), { recursive: true });
    await mkdir(join(ROOT, "state"), { recursive: true });
    await mkdir(join(ROOT, "cache"), { recursive: true });
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(ROOT, "home"),
      XDG_CONFIG_HOME: join(ROOT, "cfg"),
      XDG_DATA_HOME: join(ROOT, "data"),
      XDG_STATE_HOME: join(ROOT, "state"),
      XDG_CACHE_HOME: join(ROOT, "cache"),
      LOOPBACK_API_KEY: "smoke-key",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      VVOC_SMOKE_PROVIDER_PORT: String(PORT),
      VVOC_SMOKE_PROVIDER_TRACE: providerTrace,
      VVOC_SMOKE_TRACE: observerTrace,
    };

    await writeFile(
      join(ROOT, "provider.ts"),
      `import { appendFileSync, mkdirSync } from "node:fs";\n` +
        `import { dirname } from "node:path";\n` +
        `const trace = process.env.VVOC_SMOKE_PROVIDER_TRACE;\n` +
        `const stamp = (r) => { mkdirSync(dirname(trace), { recursive: true }); appendFileSync(trace, JSON.stringify({ at: Date.now(), ...r }) + "\\n"); };\n` +
        `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.VVOC_SMOKE_PROVIDER_PORT), async fetch(request) {\n` +
        `  const body = await request.clone().json().catch(() => ({}));\n` +
        `  const model = body?.model ?? "unknown";\n` +
        `  stamp({ event: "provider.request", model, body });\n` +
        `  const payload = { id: "c", object: "chat.completion", created: 1, model, choices: [{ index: 0, message: { role: "assistant", content: "smoke-ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };\n` +
        `  if (body?.stream) {\n` +
        `    const chunk = (delta, f) => "data: " + JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: f }] }) + "\\n\\n";\n` +
        `    return new Response(chunk({ role: "assistant" }, null) + chunk({ content: "smoke-ok" }, null) + chunk({}, "stop") + "data: [DONE]\\n\\n", { headers: { "content-type": "text/event-stream" } });\n` +
        `  }\n` +
        `  return Response.json(payload);\n` +
        `} });\n`,
      "utf8",
    );
    const provider = Bun.spawn([process.execPath, join(ROOT, "provider.ts")], {
      env,
      stdout: "ignore",
      stderr: "ignore",
    });
    pids.push(provider.pid);
    // provider started before the host so the first request cannot race startup.
    await new Promise((resolve) => setTimeout(resolve, 500));

    await mkdir(join(ROOT, "plugin"), { recursive: true });
    await mkdir(join(ROOT, "observer"), { recursive: true });
    await writeFile(
      join(ROOT, "plugin", "package.json"),
      JSON.stringify({ name: "vvoc-smoke-plugin", private: true, version: "0.0.0" }),
      "utf8",
    );
    await writeFile(
      join(ROOT, "plugin", "index.ts"),
      `import p from "${DIST_PLUGIN}";\nexport default p;\n`,
      "utf8",
    );
    await writeFile(
      join(ROOT, "observer", "package.json"),
      JSON.stringify({ name: "vvoc-smoke-observer", private: true, version: "0.0.0" }),
      "utf8",
    );
    await writeFile(
      join(ROOT, "observer", "index.ts"),
      `import { appendFileSync } from "node:fs";\n` +
        `export default { id: "vvoc.smoke-observer", async setup(ctx) {\n` +
        `  const trace = process.env.VVOC_SMOKE_TRACE;\n` +
        `  const stamp = (e, f = {}) => appendFileSync(trace, JSON.stringify({ at: Date.now(), event: e, ...f }) + "\\n");\n` +
        `  await ctx.session.hook("http.request", async (i) => { const body = await i.request.clone().json().catch(() => undefined); stamp("http.request", { model: i.model, body }); });\n` +
        `} };\n`,
      "utf8",
    );
    const project = join(ROOT, "project");
    await writeFile(
      join(project, "opencode.json"),
      JSON.stringify({
        model: "loopback/seam-smart",
        providers: {
          loopback: {
            name: "Smoke Loopback",
            package: "@opencode/ai/providers/openai-compatible",
            env: ["LOOPBACK_API_KEY"],
            settings: { baseURL: `http://127.0.0.1:${PORT}/v1`, provider: "loopback" },
            models: {
              "seam-smart": { name: "Smoke Smart", settings: { reasoningEffort: "low" } },
              "seam-fast": { name: "Smoke Fast" },
            },
          },
        },
        plugins: [{ package: join(ROOT, "plugin") }, { package: join(ROOT, "observer") }],
      }),
      "utf8",
    );
    await writeFile(
      join(project, ".vvoc", "vvoc.json"),
      renderVvocConfig({
        ...createDefaultVvocConfig(),
        roles: {
          default: "loopback/seam-smart",
          smart: "loopback/seam-smart",
          fast: "loopback/seam-fast",
          reviewer: "loopback/seam-fast",
        },
      }),
      "utf8",
    );

    const host = Bun.spawn(
      [
        REAL_HOST as string,
        "serve",
        "--service",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(HOST_PORT),
        "--log-level",
        "error",
      ],
      { env, stdout: "ignore", stderr: "pipe" },
    );
    pids.push(host.pid);
    let hostStderr = "";
    void new Response(host.stderr as ReadableStream).text().then((text) => {
      hostStderr = text;
    });

    const servicePath = join(ROOT, "state", "opencode", "service.json");
    let password: string | undefined;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        password = (JSON.parse(await readFile(servicePath, "utf8")) as { password: string })
          .password;
        if (password) break;
      } catch {
        /* not written yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(password, `host did not register; stderr: ${hostStderr}`).toBeTruthy();
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const api = async (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${HOST_PORT}${path}`, {
        ...init,
        headers: {
          authorization: auth,
          "content-type": "application/json",
          "x-opencode-directory": project,
          ...init.headers,
        },
      });
    const created = (await (
      await api("/api/session", {
        method: "POST",
        body: JSON.stringify({ location: { directory: project } }),
      })
    ).json()) as {
      data: { id: string };
    };
    const sessionID = created.data.id;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await api(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "smoke payload" }),
    });
    const deadline = Date.now() + 20000;
    let variant: string | undefined;
    for (;;) {
      const info = (await (await api(`/api/session/${sessionID}`)).json()) as {
        data: { model?: { id?: string; variant?: string }; time?: { idle?: number } };
      };
      variant = info.data.model?.variant;
      if (info.data.time?.idle !== undefined) break;
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    const providerLines = (await readFile(providerTrace, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            event?: string;
            model?: string;
            body?: { reasoning_effort?: string };
          },
      );
    const dispatched = providerLines.filter((line) => line.event === "provider.request");
    expect(dispatched.length).toBeGreaterThan(0);
    // The actual provider payload carried the snapshot-qualified variant's settings.
    expect(dispatched.some((line) => line.body?.reasoning_effort === "low")).toBe(true);
    expect(variant).toMatch(/\.seam-smart$/);
    // A loop would have produced a flood of own-reload events.
    const observerTypes = (await readFile(observerTrace, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string });
    expect(observerTypes.filter((entry) => entry.type === "model.updated").length).toBeLessThan(50);
  }, 90000);

  afterAll(async () => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(ROOT, { recursive: true, force: true });
  });
});
// END_BLOCK_REAL_HOST_SMOKE
