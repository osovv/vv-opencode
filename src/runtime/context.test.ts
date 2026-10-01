// FILE: src/runtime/context.test.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify context-identity native runtime and snapshot-service acquisition, per-lease idempotent release, distinct-context isolation at one location, registration teardown/reacquisition, and disposed-state safety.
//   SCOPE: Deterministic fixture-host assertions for the runtime and snapshot-service registries; no real host, network, or V1 client.
//   DEPENDS: [bun:test, src/runtime/context.js, src/runtime/snapshots.js, src/runtime/types.js]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ENDPOINT - Fixed discovered-service endpoint fixture.
//   createFakeClient - Build an in-memory full-client double.
//   NativeHandler - Shape of one registered native RPC handler.
//   makeLocation - Build a structural runtime location fixture.
//   FakeNativeHost - In-memory native host double that records discovery, registration, and client construction.
//   MemoryCaptureStore - In-memory SnapshotStore double for snapshot-service sharing tests.
//   createSnapshotDeps - Minimal injectable snapshot-service dependencies.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009 - Added coherent-admission binding coverage: a role-managed agent is recomputed from the fresh role, raw intent wins, and an unmanaged agent keeps its native literal.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import { acquireRuntime, acquireSnapshotService, rebuildAgentBindings } from "./context.js";
import { createDefaultVvocConfig } from "../lib/vvoc-config.js";
import type { SnapshotServiceDeps } from "./snapshots.js";
import type { EffectiveRuntimeConfig, FamilyCapture, SnapshotStore } from "./types.js";
import {
  RuntimeDisposedError,
  SUPPORTED_SERVICE_VERSION,
  type RuntimeClient,
  type RuntimeContext,
  type RuntimeDeps,
  type RuntimeEndpoint,
  type RuntimeLocation,
  type RuntimeRpcCallOptions,
  type RuntimeRpcMethods,
} from "./types.js";

const ENDPOINT: RuntimeEndpoint = {
  url: "http://127.0.0.1:41234",
  auth: { type: "basic", username: "opencode", password: "runtime-secret" },
};

function makeLocation(directory: string): RuntimeLocation {
  return { directory, project: { id: "project-1", directory, canonical: directory } };
}

type NativeHandler = (input: unknown, context: unknown) => Promise<unknown>;

// START_BLOCK_FIXTURE_HOST
class FakeNativeHost {
  readonly handlers = new Map<string, Record<string, NativeHandler>>();
  registerCalls = 0;
  disposeCalls = 0;
  discoverCalls = 0;
  makeClientCalls = 0;
  readonly serviceVersion = SUPPORTED_SERVICE_VERSION;
  readonly endpoint = ENDPOINT;

  createContext(location: RuntimeLocation): RuntimeContext {
    return {
      location,
      rpc: {
        register: async (definition, handlers) => {
          this.registerCalls += 1;
          this.handlers.set(definition.id, handlers as unknown as Record<string, NativeHandler>);
          return {
            dispose: async () => {
              this.disposeCalls += 1;
              this.handlers.delete(definition.id);
            },
          };
        },
      },
    };
  }

  createDeps(): RuntimeDeps<RuntimeClient> {
    return {
      serviceVersion: this.serviceVersion,
      discoverService: async () => {
        this.discoverCalls += 1;
        return this.endpoint;
      },
      serviceHeaders: () => {
        return { authorization: "Basic b3BlbmNvZGU6cnVudGltZS1zZWNyZXQ=" };
      },
      makeClient: () => {
        this.makeClientCalls += 1;
        return createFakeClient(this);
      },
    };
  }
}

function createFakeClient(host: FakeNativeHost): RuntimeClient {
  const rpc = ((definition) => {
    const methods: Record<
      string,
      (input: unknown, options?: RuntimeRpcCallOptions) => Promise<unknown>
    > = {};
    for (const name of Object.keys(definition.methods)) {
      methods[name] = async (input) => {
        const handler = host.handlers.get(definition.id)?.[name];
        if (handler === undefined) throw new Error(`Unknown RPC handler: ${definition.id}.${name}`);
        return handler(input, {});
      };
    }
    return methods as unknown as RuntimeRpcMethods<typeof definition>;
  }) as RuntimeClient["rpc"];

  return {
    rpc,
    permission: {
      async create() {
        return { id: "per_unused", effect: "deny" as const };
      },
      async get() {
        throw new Error("unused");
      },
      async reply() {},
    },
    event: {
      subscribe() {
        return {
          async *[Symbol.asyncIterator]() {},
        };
      },
    },
  };
}
// END_BLOCK_FIXTURE_HOST

describe("acquireRuntime", () => {
  test("accepts a real native Plugin.Context as the runtime seam", () => {
    // Compiles only while the pinned native Plugin.Context remains assignable to RuntimeContext.
    const seam = (context: Plugin.Context): RuntimeContext => context;
    expect(typeof seam).toBe("function");
  });

  test("acquires lazily without touching discovery or registration", () => {
    const host = new FakeNativeHost();
    const lease = acquireRuntime(
      host.createContext(makeLocation("/workspace/lazy")),
      host.createDeps(),
    );

    expect(lease.runtime.identity.directory).toBe("/workspace/lazy");
    expect(lease.runtime.identity.projectID).toBe("project-1");
    expect(lease.runtime.location.directory).toBe("/workspace/lazy");
    expect(lease.runtime.instanceId).toMatch(/^[0-9a-f]{32}$/);
    expect(host.discoverCalls).toBe(0);
    expect(host.registerCalls).toBe(0);
    expect(host.makeClientCalls).toBe(0);
  });

  test("shares one runtime for the same context and releases idempotently per lease", async () => {
    const host = new FakeNativeHost();
    const context = host.createContext(makeLocation("/workspace/shared"));
    const deps = host.createDeps();

    const first = acquireRuntime(context, deps);
    const second = acquireRuntime(context, deps);
    expect(second.runtime).toBe(first.runtime);

    const client = await first.runtime.client();
    expect(await second.runtime.client()).toBe(client);
    expect(host.registerCalls).toBe(1);
    expect(host.discoverCalls).toBe(1);
    expect(host.makeClientCalls).toBe(1);

    // Double cleanup from one consumer must not dispose another consumer's live runtime.
    await first.release();
    await first.release();
    expect(host.disposeCalls).toBe(0);
    expect(await second.runtime.client()).toBe(client);

    await second.release();
    await second.release();
    expect(host.disposeCalls).toBe(1);
  });

  test("isolates distinct contexts that share one location", async () => {
    const host = new FakeNativeHost();
    const deps = host.createDeps();
    const location = makeLocation("/workspace/same-location");
    const left = acquireRuntime(host.createContext(location), deps);
    const right = acquireRuntime(host.createContext(location), deps);

    expect(right.runtime).not.toBe(left.runtime);
    expect(right.runtime.instanceId).not.toBe(left.runtime.instanceId);

    // Separate challenge ids let both contexts authenticate in the same host without collision.
    await left.runtime.client();
    await right.runtime.client();
    expect(host.registerCalls).toBe(2);
    expect(host.handlers.size).toBe(2);
    expect([...host.handlers.keys()].every((id) => id.startsWith("vvoc.native-runtime."))).toBe(
      true,
    );

    await left.release();
    expect(host.disposeCalls).toBe(1);
    expect(await right.runtime.client()).toBeDefined();
    await right.release();
    expect(host.disposeCalls).toBe(2);
  });

  test("tears down registrations and re-acquires a fresh runtime", async () => {
    const host = new FakeNativeHost();
    const context = host.createContext(makeLocation("/workspace/reacquire"));
    const deps = host.createDeps();

    const first = acquireRuntime(context, deps);
    await first.runtime.client();
    await first.release();
    expect(host.disposeCalls).toBe(1);
    expect(host.handlers.size).toBe(0);

    const second = acquireRuntime(context, deps);
    expect(second.runtime).not.toBe(first.runtime);
    expect(second.runtime.instanceId).not.toBe(first.runtime.instanceId);
    await second.runtime.client();
    expect(host.registerCalls).toBe(2);
    await second.release();
  });

  test("isolates one context acquired with distinct dependencies", () => {
    const host = new FakeNativeHost();
    const context = host.createContext(makeLocation("/workspace/deps"));
    const one = acquireRuntime(context, host.createDeps());
    const two = acquireRuntime(context, host.createDeps());

    expect(two.runtime).not.toBe(one.runtime);
  });

  test("rejects client after forced disposal", async () => {
    const host = new FakeNativeHost();
    const lease = acquireRuntime(
      host.createContext(makeLocation("/workspace/disposed")),
      host.createDeps(),
    );
    await lease.runtime.client();
    await lease.runtime.dispose();

    await expect(lease.runtime.client()).rejects.toBeInstanceOf(RuntimeDisposedError);
    await lease.release();
    expect(host.disposeCalls).toBe(1);
  });
});

// START_BLOCK_SNAPSHOT_SERVICE_ACQUISITION
class MemoryCaptureStore implements SnapshotStore {
  readonly captures = new Map<string, FamilyCapture>();
  readonly markers = new Set<string>();

  async read(familyId: string) {
    return this.captures.get(familyId);
  }
  async write(familyId: string, capture: FamilyCapture) {
    this.captures.set(familyId, capture);
  }
  async remove(familyId: string) {
    this.captures.delete(familyId);
  }
  async readCandidates() {
    return [];
  }
  async writeCandidate() {}
  async removeCandidate() {}
  async removeCandidates() {}
  async readMarker(familyId: string) {
    return this.markers.has(familyId);
  }
  async writeMarker(familyId: string) {
    this.markers.add(familyId);
  }
  async removeMarker(familyId: string) {
    this.markers.delete(familyId);
  }
  async list() {
    return [...this.captures.keys()];
  }
}

function createSnapshotDeps(store: SnapshotStore): SnapshotServiceDeps {
  return {
    store,
    loadConfig: async () => ({
      roles: { default: "prov/m1" },
      agentRoles: { build: "default" },
      vvoc: createDefaultVvocConfig(),
    }),
    readSession: async (sessionID) =>
      sessionID === "ses_root"
        ? { id: sessionID, locationDirectory: "/workspace/shared" }
        : undefined,
    readSessionModel: async () => undefined,
    switchModel: async () => undefined,
    auxiliarySession: {
      create: async () => ({ sessionID: "ses_aux" }),
      switchModel: async () => undefined,
      generate: async () => ({ text: "x" }),
    },
  };
}

describe("acquireSnapshotService", () => {
  test("shares one snapshot service for the same context and dependency instance", async () => {
    const host = new FakeNativeHost();
    const context = host.createContext(makeLocation("/workspace/shared"));
    const deps = createSnapshotDeps(new MemoryCaptureStore());

    const first = acquireSnapshotService(context, deps);
    const second = acquireSnapshotService(context, deps);
    expect(second.snapshots).toBe(first.snapshots);

    // Releasing one lease twice must not dispose another consumer's live service.
    await first.release();
    await first.release();
    expect(second.snapshots.familyOf("ses_root")).resolves.toBe("ses_root");
    await second.release();
  });

  test("isolates distinct contexts that share one location", () => {
    const host = new FakeNativeHost();
    const deps = createSnapshotDeps(new MemoryCaptureStore());
    const location = makeLocation("/workspace/shared");
    const left = acquireSnapshotService(host.createContext(location), deps);
    const right = acquireSnapshotService(host.createContext(location), deps);

    expect(right.snapshots).not.toBe(left.snapshots);
  });

  test("a released snapshot service rejects further admission", async () => {
    const host = new FakeNativeHost();
    const lease = acquireSnapshotService(
      host.createContext(makeLocation("/workspace/released")),
      createSnapshotDeps(new MemoryCaptureStore()),
    );
    await lease.release();

    const outcome = await lease.snapshots.stage({
      sessionID: "ses_root",
      directory: "/workspace/released",
      location: {
        directory: "/workspace/released",
        projectID: "project-1",
        canonical: "/workspace/released",
      },
    });
    expect(outcome.status).toBe("rejected");
  });
});

describe("coherent admission bindings", () => {
  const vvoc = createDefaultVvocConfig();

  test("recomputes a role-managed agent from the fresh role over a stale vvoc-applied literal", () => {
    const cached = [
      { agentID: "build", role: "smart", selection: { providerID: "prov", modelID: "m1" } },
    ];
    const fresh: EffectiveRuntimeConfig = {
      roles: { smart: "prov/m2" },
      agentRoles: { build: "smart" },
      vvoc,
    };
    expect(rebuildAgentBindings(cached, fresh)).toEqual([
      { agentID: "build", role: "smart", selection: { providerID: "prov", modelID: "m2" } },
    ]);
  });

  test("preserves genuine raw OpenCode intent over the fresh role", () => {
    const cached = [
      { agentID: "build", role: "smart", selection: { providerID: "prov", modelID: "m1" } },
    ];
    const fresh: EffectiveRuntimeConfig = {
      roles: { smart: "prov/m2" },
      agentRoles: { build: "smart" },
      vvoc,
      rawIntent: { agents: { build: "prov/m9" }, commands: {} },
    };
    const binding = rebuildAgentBindings(cached, fresh).find((entry) => entry.agentID === "build");
    expect(binding?.selection).toEqual({ providerID: "prov", modelID: "m9" });
  });

  test("keeps a genuine native literal for an agent vvoc does not role-manage", () => {
    const cached = [{ agentID: "custom", selection: { providerID: "prov", modelID: "m3" } }];
    const fresh: EffectiveRuntimeConfig = { roles: { smart: "prov/m2" }, agentRoles: {}, vvoc };
    expect(rebuildAgentBindings(cached, fresh)).toEqual([
      { agentID: "custom", selection: { providerID: "prov", modelID: "m3" } },
    ]);
  });
});
// END_BLOCK_SNAPSHOT_SERVICE_ACQUISITION
