// FILE: src/plugins/model-roles.integration.test.ts
// VERSION: 3.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the native ModelRolesPlugin delegation and the shared runtime's session-owned family settings: lazy root birth, lineage child resolution, restart parity, explicit metadata changes, one-shot creation reconciliation, config watching, auxiliary title children, and the one-shot legacy migration.
//   SCOPE: Deterministic fake-native-host assertions with an isolated data home; no real host, network, or V1 client.
//   DEPENDS: [bun:test, node:fs/promises, node:crypto, @opencode/schema/agent, @opencode/schema/model, @opencode/schema/provider, src/lib/vvoc-config.js, src/plugins/model-roles/index.js, src/runtime/context.js, src/runtime/session-settings.js, src/runtime/types.js]
//   LINKS: [M-PLUGIN-MODEL-ROLES, M-NATIVE-RUNTIME, V-M-PLUGIN-MODEL-ROLES]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   EventQueue - Deterministic native event queue double.
//   FakeNativeContext - In-memory native Plugin.Context double with persistent session metadata.
//   FakeRuntimeHost - Discovery/auth/client double bound to one fake context.
//   AgentInfo - Native agent info type alias used by the fakes.
//   ModelInfo - Native model info type alias used by the fakes.
//   acquireRuntime - Acquire a settings-based runtime over the fake host with role overriding enabled unless stated.
//   createProject - Create an isolated fixture project with the given role map.
//   isolateDataHome - Point XDG_DATA_HOME at a fresh temporary directory.
//   makeSession - Register one session view in the fake context.
//   previousDataHome - Saved XDG_DATA_HOME restored after the suite.
//   previousVvocConfig - Saved VVOC_CONFIG restored after the suite.
//   tempDirs - Temporary directories removed after the suite.
//   waitFor - Poll a predicate until it holds or the bounded deadline elapses.
//   writeVvoc - Write the fixture project's vvoc.json with the given roles.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SESSION-OWNED-SETTINGS T-003 - Rewrote the suite for session-owned settings: birth, resolution, restart parity, reconciliation, and migration replace the binding/guard coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@opencode/schema/agent";
import { Model } from "@opencode/schema/model";
import { Provider } from "@opencode/schema/provider";
import type { DeepMutable } from "../runtime/types.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";
import { ModelRolesPlugin, registerModelRoles } from "./model-roles/index.js";
import {
  acquireNativeSnapshotRuntime,
  type NativeForkClient,
  type NativeHookEvents,
  type NativeRegistration,
  type NativeSnapshotContext,
} from "../runtime/context.js";
import {
  SESSION_SETTINGS_METADATA_KEY,
  readSettingsFromMetadata,
} from "../runtime/session-settings.js";
import {
  type AgentEditorLike,
  type ModelEditorLike,
  type ModelSelection,
  type NativeSessionImportPayload,
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

async function isolateDataHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vvoc-mr-data-"));
  tempDirs.push(dir);
  process.env.XDG_DATA_HOME = dir;
  delete process.env.VVOC_CONFIG;
  return dir;
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
  readonly updateCalls: Array<{
    sessionID: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }> = [];
  readonly generateCalls: Array<{ sessionID: string; prompt: string }> = [];
  readonly importCalls: Array<{
    id: string;
    parentID: string;
    projectID: string;
    title: string;
    agent?: string;
    model?: { id: string; providerID: string; variant?: string };
    metadata?: Record<string, unknown>;
    permissions?: ReadonlyArray<{ action: string; resource: string; effect: string }>;
    location?: { directory: string };
  }> = [];
  readonly forkCalls: string[] = [];
  readonly events = new EventQueue();
  modelReloads = 0;
  agentReloads = 0;
  private defaultModel: { providerID: string; modelID: string } | undefined;
  private readonly hooks = new Map<
    keyof NativeHookEvents,
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

  /** Fake native `session.import`: create the parented child the runtime asked for. */
  importSession(payload: NativeSessionImportPayload): { id: string } {
    const info = payload.info;
    this.sessions.set(info.id, {
      id: info.id,
      parentID: info.parentID,
      locationDirectory: info.location.directory,
      ...(info.agent === undefined ? {} : { agent: info.agent }),
      ...(info.metadata === undefined ? {} : { metadata: info.metadata }),
    });
    if (info.model !== undefined) {
      this.sessionModels.set(info.id, {
        providerID: info.model.providerID,
        modelID: info.model.id,
        ...(info.model.variant === undefined ? {} : { variant: info.model.variant }),
      });
    }
    this.importCalls.push({
      id: info.id,
      parentID: info.parentID,
      projectID: info.projectID,
      title: info.title,
      ...(info.agent === undefined ? {} : { agent: info.agent }),
      ...(info.model === undefined ? {} : { model: info.model }),
      ...(info.metadata === undefined ? {} : { metadata: info.metadata }),
      ...(info.permissions === undefined ? {} : { permissions: info.permissions }),
      ...(payload.location === undefined ? {} : { location: payload.location }),
    });
    return { id: info.id };
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
    // Final native model collection readback.
    list: async () => ({ data: [...this.models.values()] }),
  };

  readonly session = {
    get: async ({ sessionID }: { sessionID: string }) => {
      const view = this.sessions.get(sessionID);
      if (view === undefined) throw new Error(`unknown session ${sessionID}`);
      const model = this.sessionModels.get(sessionID) ?? view.model;
      return {
        id: view.id,
        parentID: view.parentID,
        projectID: this.location.project.id,
        ...(view.forkSessionID === undefined ? {} : { fork: { sessionID: view.forkSessionID } }),
        ...(view.agent === undefined ? {} : { agent: view.agent }),
        ...(view.metadata === undefined ? {} : { metadata: view.metadata }),
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
    // REPLACE semantics: the whole metadata map replaces the previous one.
    update: async (input: {
      sessionID: string;
      title?: string;
      metadata?: Record<string, unknown>;
    }) => {
      this.updateCalls.push({
        sessionID: input.sessionID,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
      const view = this.sessions.get(input.sessionID);
      if (view !== undefined && input.metadata !== undefined) {
        this.sessions.set(input.sessionID, { ...view, metadata: input.metadata });
      }
    },
    generate: async ({ sessionID, prompt }: { sessionID: string; prompt: string }) => {
      this.generateCalls.push({ sessionID, prompt });
      return { text: `generated:${sessionID}` };
    },
    hook: async <Name extends keyof NativeHookEvents>(
      name: Name,
      callback: (event: NativeHookEvents[Name]) => void | Promise<void>,
    ): Promise<NativeRegistration> => {
      this.hooks.set(name, callback as (event: never) => void | Promise<void>);
      return this.registration();
    },
  };

  readonly event = {
    subscribe: () => this.events.drain(),
  };

  async invoke<Name extends keyof NativeHookEvents>(
    name: Name,
    event: NativeHookEvents[Name],
  ): Promise<void> {
    const callback = this.hooks.get(name) as
      | ((event: NativeHookEvents[Name]) => void | Promise<void>)
      | undefined;
    await callback?.(event);
  }

  /** Production-compatible seam: a real Plugin.Context satisfies the narrow context. */
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
        import: async (input: unknown) =>
          this.context.importSession(input as NativeSessionImportPayload),
        log: () => ({ async *[Symbol.asyncIterator]() {} }),
      },
    };
  }
}
// END_BLOCK_RUNTIME_HOST

function makeSession(
  context: FakeNativeContext,
  id: string,
  view: Partial<NativeSessionView> = {},
): void {
  context.sessions.set(id, { id, locationDirectory: context.location.directory, ...view });
}

/** Poll a predicate until it holds or the bounded deadline elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Acquire a runtime over the fake host with role overriding enabled unless stated. */
async function acquireRuntime(context: FakeNativeContext, options: { enabled?: boolean } = {}) {
  const host = new FakeRuntimeHost(context);
  const runtime = await acquireNativeSnapshotRuntime(context, {
    runtimeDeps: host.createDeps(),
  });
  await runtime.setRoleOverride(options.enabled ?? true);
  return runtime;
}

describe("ModelRolesPlugin native delegation", () => {
  test("exposes a native Plugin.define object", () => {
    expect(typeof ModelRolesPlugin).toBe("object");
    expect(typeof ModelRolesPlugin.setup).toBe("function");
    expect(ModelRolesPlugin.id).toBe("vvoc.model-roles");
  });

  test("shares one runtime and settings service for the same Context", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1" });
    const context = new FakeNativeContext(project);
    const host = new FakeRuntimeHost(context);
    const runtimeDeps = host.createDeps();

    const first = await acquireNativeSnapshotRuntime(context, { runtimeDeps });
    const second = await acquireNativeSnapshotRuntime(context, { runtimeDeps });
    expect(second.settings).toBe(first.settings);
    await first.release();
    await second.release();
  });

  test("disabled role override leaves agent models untouched", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1", smart: "prov/m2" });
    const context = new FakeNativeContext(project);
    context.addAgent("vv-controller");

    const registration = await registerModelRoles(context, {
      enabled: false,
      runtimeDeps: new FakeRuntimeHost(context).createDeps(),
    });
    expect(context.agents.get("vv-controller")?.model).toBeUndefined();
    await registration.dispose();
  });

  test("enabled role override selects the correct role for vv-controller, not the default", async () => {
    await isolateDataHome();
    const project = await createProject({ default: "prov/m1", smart: "prov/m2" });
    const context = new FakeNativeContext(project);
    context.addAgent("vv-controller");
    context.addAgent("plan", { providerID: "user", modelID: "literal" });

    const registration = await registerModelRoles(context, {
      enabled: true,
      runtimeDeps: new FakeRuntimeHost(context).createDeps(),
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

describe("session-owned family settings", () => {
  test("the first context hook births root settings and later hooks do not rewrite them", async () => {
    await isolateDataHome();
    const project = await createProject({ smart: "prov/m2" });
    const context = new FakeNativeContext(project);
    makeSession(context, "ses_root");
    const runtime = await acquireRuntime(context, { enabled: false });

    await context.invoke("context", { sessionID: "ses_root" });
    await waitFor(() => context.updateCalls.length > 0);
    const stored = readSettingsFromMetadata(
      context.sessions.get("ses_root")?.metadata as Record<string, unknown>,
    );
    // The birth record carries the FULL resolved role map (seeded defaults
    // included), so the family is immune to later config edits.
    expect(stored && "settings" in stored ? stored.settings.roles : undefined).toEqual({
      default: "openai/gpt-5.6-terra#high",
      fast: "openai/gpt-6-luna#low",
      reflector: "openai/gpt-6-luna#low",
      reviewer: "openai/gpt-5.6-sol#xhigh",
      smart: "prov/m2",
    });

    const writesAfterFirst = context.updateCalls.length;
    await context.invoke("context", { sessionID: "ses_root" });
    expect(context.updateCalls.length).toBe(writesAfterFirst);
    await runtime.release();
  });

  test("birth preserves foreign metadata keys (read-modify-write)", async () => {
    await isolateDataHome();
    const project = await createProject({ smart: "prov/m2" });
    const context = new FakeNativeContext(project);
    makeSession(context, "ses_root", { metadata: { user: { note: "keep me" }, count: 3 } });
    const runtime = await acquireRuntime(context, { enabled: false });

    await context.invoke("context", { sessionID: "ses_root" });
    await waitFor(() => context.updateCalls.length > 0);
    const metadata = context.sessions.get("ses_root")?.metadata as Record<string, unknown>;
    expect(metadata.user).toEqual({ note: "keep me" });
    expect(metadata.count).toBe(3);
    expect(metadata[SESSION_SETTINGS_METADATA_KEY]).toBeDefined();
    await runtime.release();
  });

  test("a child resolves through the root's record while a fresh session resolves the changed config", async () => {
    await isolateDataHome();
    const project = await createProject({ smart: "prov/m-x" });
    const context = new FakeNativeContext(project);
    makeSession(context, "ses_root");
    makeSession(context, "ses_child", { parentID: "ses_root" });
    const runtime = await acquireRuntime(context, { enabled: false });

    await context.invoke("context", { sessionID: "ses_root" });
    await waitFor(
      () =>
        readSettingsFromMetadata(
          context.sessions.get("ses_root")?.metadata as Record<string, unknown>,
        ) !== undefined,
    );

    // The project config flips to Y; the host emits one config.updated.
    await writeVvoc(project, { smart: "prov/m-y" });
    context.events.push({ type: "config.updated" });
    await waitFor(() => runtime.effectiveConfig().roles.smart === "prov/m-y", 2000);

    // The existing family keeps its birth settings (X) through the root record.
    const familyView = await runtime.settings.configFor("ses_child");
    expect(familyView?.source).toBe("metadata");
    expect(familyView?.settings.roles.smart).toBe("prov/m-x");
    expect(familyView?.familyId).toBe("ses_root");

    // A brand-new session resolves the current effective config (Y).
    makeSession(context, "ses_fresh");
    const freshView = await runtime.settings.configFor("ses_fresh");
    expect(freshView?.source).toBe("metadata");
    expect(freshView?.settings.roles.smart).toBe("prov/m-y");

    // The projected consumer config carries the family roles over the live document.
    expect(familyView?.vvoc.roles.smart).toBe("prov/m-x");
    expect(freshView?.vvoc.roles.smart).toBe("prov/m-y");
    await runtime.release();
  });

  test("a fresh runtime resolves the same settings after a restart", async () => {
    await isolateDataHome();
    const project = await createProject({ smart: "prov/m-x" });
    const context = new FakeNativeContext(project);
    makeSession(context, "ses_root");
    makeSession(context, "ses_child", { parentID: "ses_root" });

    const first = await acquireRuntime(context, { enabled: false });
    const before = await first.settings.configFor("ses_child");
    await first.release();

    const second = await acquireRuntime(context, { enabled: false });
    const after = await second.settings.configFor("ses_child");
    expect(after?.settings).toEqual(before?.settings);
    expect(after?.settingsId).toBe(before?.settingsId);
    await second.release();
  });

  test("an explicit root metadata change moves only that family", async () => {
    await isolateDataHome();
    const project = await createProject({ smart: "prov/m-x" });
    const context = new FakeNativeContext(project);
    makeSession(context, "ses_a");
    makeSession(context, "ses_b");
    const runtime = await acquireRuntime(context, { enabled: false });
    await context.invoke("context", { sessionID: "ses_a" });
    await context.invoke("context", { sessionID: "ses_b" });
    await waitFor(() => context.updateCalls.length >= 2);

    // Simulate /vv-settings: rewrite only family A's root record.
    const metadataA = context.sessions.get("ses_a")?.metadata as Record<string, unknown>;
    const currentSettings = metadataA[SESSION_SETTINGS_METADATA_KEY];
    context.sessions.set("ses_a", {
      ...context.sessions.get("ses_a")!,
      metadata: {
        ...metadataA,
        [SESSION_SETTINGS_METADATA_KEY]: {
          ...(typeof currentSettings === "object" && currentSettings !== null
            ? currentSettings
            : {}),
          profile: "single-session",
        },
      },
    });

    const a = await runtime.settings.configFor("ses_a");
    const b = await runtime.settings.configFor("ses_b");
    expect(a?.settings.profile).toBe("single-session");
    // Family B keeps the profile it was born with (the project default).
    expect(b?.settings.profile).toBe("balanced");
    await runtime.release();
  });

  test("lineage failures resolve to nothing without failing the caller", async () => {
    await isolateDataHome();
    const project = await createProject({ smart: "prov/m-x" });
    const context = new FakeNativeContext(project);
    const runtime = await acquireRuntime(context, { enabled: false });
    expect(await runtime.settings.configFor("ses_ghost")).toBeUndefined();
    await runtime.release();
  });
});

describe("creation reconciliation", () => {
  test("a host-created child adopts the family role model exactly once after a config flip", async () => {
    await isolateDataHome();
    const project = await createProject({ smart: "prov/m-x" });
    const context = new FakeNativeContext(project);
    context.addAgent("vv-controller");
    context.addModel("prov", "m-x");
    context.addModel("prov", "m-y");
    makeSession(context, "ses_root");
    const runtime = await acquireRuntime(context, { enabled: true });

    await context.invoke("context", { sessionID: "ses_root" });
    await waitFor(
      () =>
        readSettingsFromMetadata(
          context.sessions.get("ses_root")?.metadata as Record<string, unknown>,
        ) !== undefined,
    );

    // The config flips to Y; a new child is created afterwards with the stale Y agent model.
    await writeVvoc(project, { smart: "prov/m-y" });
    context.events.push({ type: "config.updated" });
    await waitFor(() => runtime.effectiveConfig().roles.smart === "prov/m-y", 2000);

    makeSession(context, "ses_child", { parentID: "ses_root", agent: "vv-controller" });
    context.sessionModels.set("ses_child", { providerID: "prov", modelID: "m-y" });
    context.events.push({
      type: "session.created",
      data: {
        sessionID: "ses_child",
        info: { id: "ses_child", parentID: "ses_root" },
        model: { id: "m-y", providerID: "prov" },
      },
    });
    await waitFor(() => context.switchCalls.length > 0, 2000);
    expect(context.switchCalls).toEqual([
      { sessionID: "ses_child", model: { providerID: "prov", modelID: "m-x" } },
    ]);

    // One-shot: another created event never switches again.
    context.events.push({
      type: "session.created",
      data: { sessionID: "ses_child", model: { id: "m-y", providerID: "prov" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(context.switchCalls).toHaveLength(1);
    await runtime.release();
  });

  test("auxiliary-metadata children and internal agents are never reconciled", async () => {
    await isolateDataHome();
    const project = await createProject({ smart: "prov/m-x", fast: "prov/m-fast" });
    const context = new FakeNativeContext(project);
    makeSession(context, "ses_root");
    const runtime = await acquireRuntime(context, { enabled: true });
    await context.invoke("context", { sessionID: "ses_root" });
    await waitFor(() => context.updateCalls.length > 0);

    makeSession(context, "ses_aux", {
      parentID: "ses_root",
      agent: "title",
      metadata: { vvocAuxiliary: { kind: "title", role: "fast" } },
    });
    context.events.push({
      type: "session.created",
      data: { sessionID: "ses_aux", model: { id: "m-other", providerID: "prov" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(context.switchCalls).toEqual([]);
    await runtime.release();
  });

  test("disabled role override never reconciles children", async () => {
    await isolateDataHome();
    const project = await createProject({ smart: "prov/m-x" });
    const context = new FakeNativeContext(project);
    context.addAgent("vv-controller");
    makeSession(context, "ses_root");
    const runtime = await acquireRuntime(context, { enabled: false });
    await context.invoke("context", { sessionID: "ses_root" });
    await waitFor(() => context.updateCalls.length > 0);

    makeSession(context, "ses_child", { parentID: "ses_root", agent: "vv-controller" });
    context.events.push({
      type: "session.created",
      data: { sessionID: "ses_child", model: { id: "m-stale", providerID: "prov" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(context.switchCalls).toEqual([]);
    await runtime.release();
  });
});

describe("config watching and auxiliary work", () => {
  test("the event pump contains an invalid config event and recovers on a fixed one", async () => {
    await isolateDataHome();
    const project = await createProject({ smart: "prov/m-x" });
    const context = new FakeNativeContext(project);
    const runtime = await acquireRuntime(context, { enabled: false });

    await writeFile(join(project, ".vvoc", "vvoc.json"), "{broken", "utf8");
    context.events.push({ type: "config.updated" });
    await waitFor(() => runtime.lastConfigError() !== undefined, 2000);
    // The cached effective config stays the last fully read one.
    expect(runtime.effectiveConfig().roles.smart).toBe("prov/m-x");

    await writeVvoc(project, { smart: "prov/m-y" });
    context.events.push({ type: "config.updated" });
    await waitFor(() => runtime.effectiveConfig().roles.smart === "prov/m-y", 2000);
    expect(runtime.lastConfigError()).toBeUndefined();
    await runtime.release();
  });

  test("title work creates an auxiliary child bound to the family fast role", async () => {
    await isolateDataHome();
    const project = await createProject({ smart: "prov/m-x", fast: "prov/m-fast" });
    const context = new FakeNativeContext(project);
    makeSession(context, "ses_root");
    const runtime = await acquireRuntime(context, { enabled: false });
    await context.invoke("context", { sessionID: "ses_root" });
    await waitFor(() => context.updateCalls.length > 0);

    const event: { sessionID: string; result?: string; messages?: unknown } = {
      sessionID: "ses_root",
      messages: [{ role: "user", text: "hello" }],
    };
    await context.invoke("title", event);
    await waitFor(() => context.importCalls.length > 0, 2000);
    const call = context.importCalls[0];
    expect(call.parentID).toBe("ses_root");
    expect(call.model).toEqual({ id: "m-fast", providerID: "prov" });
    expect(call.metadata).toMatchObject({ vvocAuxiliary: { kind: "title", role: "fast" } });
    expect(context.generateCalls.length).toBe(1);
    expect(event.result).toBe(`generated:${call.id}`);
    await runtime.release();
  });

  test("session deletion only clears in-process caches", async () => {
    await isolateDataHome();
    const project = await createProject({ smart: "prov/m-x" });
    const context = new FakeNativeContext(project);
    makeSession(context, "ses_root");
    const runtime = await acquireRuntime(context, { enabled: false });
    await context.invoke("context", { sessionID: "ses_root" });
    await waitFor(() => context.updateCalls.length > 0);

    context.events.push({ type: "session.deleted", data: { sessionID: "ses_root" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The family still resolves; the host is the source of truth for lineage.
    const view = await runtime.settings.configFor("ses_root");
    expect(view?.familyId).toBe("ses_root");
    await runtime.release();
  });
});

describe("legacy binding migration", () => {
  test("the first runtime start converts legacy bindings into root metadata and prunes directories", async () => {
    const dataHome = await isolateDataHome();
    const project = await createProject({ smart: "prov/m-current" });
    const context = new FakeNativeContext(project);
    makeSession(context, "ses_root");

    // Seed the legacy layout: one live family, one dead family.
    const scope = createHash("sha256").update("proj").digest("hex").slice(0, 32);
    const bindingsDir = join(dataHome, "vvoc", "bindings", scope);
    await mkdir(join(bindingsDir, "families"), { recursive: true });
    await mkdir(join(bindingsDir, "policies"), { recursive: true });
    await writeFile(
      join(bindingsDir, "families", "ses_root.json"),
      JSON.stringify({ familyId: "ses_root", snapshotHash: "hash1", boundAt: "2026-01-01" }),
      "utf8",
    );
    await writeFile(
      join(bindingsDir, "families", "ses_dead.json"),
      JSON.stringify({ familyId: "ses_dead", snapshotHash: "hash2", boundAt: "2026-01-01" }),
      "utf8",
    );
    await writeFile(
      join(bindingsDir, "policies", "hash1.json"),
      JSON.stringify({
        roleModels: { smart: { providerID: "prov", modelID: "m-legacy" } },
        agentBindings: [],
        policy: {
          ...createDefaultVvocConfig(),
          roles: { smart: "prov/m-legacy" },
          orchestration: { profile: "orchestrated" },
        },
      }),
      "utf8",
    );
    await mkdir(join(dataHome, "vvoc", "snapshots", scope), { recursive: true });
    await mkdir(join(dataHome, "vvoc", "rebind"), { recursive: true });

    const runtime = await acquireRuntime(context, { enabled: false });
    await waitFor(
      () =>
        readSettingsFromMetadata(
          context.sessions.get("ses_root")?.metadata as Record<string, unknown>,
        ) !== undefined,
      2000,
    );
    const stored = readSettingsFromMetadata(
      context.sessions.get("ses_root")?.metadata as Record<string, unknown>,
    );
    expect(stored && "settings" in stored ? stored.settings.roles : undefined).toEqual({
      smart: "prov/m-legacy",
    });
    // The runtime itself resolves the converted record after a restart too.
    const view = await runtime.settings.configFor("ses_root");
    expect(view?.settings.roles.smart).toBe("prov/m-legacy");
    await runtime.release();

    // Second start: migration is a no-op with the directories gone.
    const secondRuntime = await acquireRuntime(context, { enabled: false });
    const again = await secondRuntime.settings.configFor("ses_root");
    expect(again?.settings.roles.smart).toBe("prov/m-legacy");
    await secondRuntime.release();
    const { readdir } = await import("node:fs/promises");
    await expect(readdir(join(dataHome, "vvoc", "bindings", scope))).rejects.toBeDefined();
    await expect(readdir(join(dataHome, "vvoc", "rebind"))).rejects.toBeDefined();
  });
});
