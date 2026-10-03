// FILE: src/runtime/snapshots.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify durable credential-free family binding, rehydration, fail-soft repair, concurrent first-work serialization, rebind, deletion garbage collection, and live credential materialization.
//   SCOPE: In-memory binding-store and host-boundary doubles; no real filesystem or native host.
//   DEPENDS: [bun:test, src/runtime/snapshot-config.ts, src/runtime/snapshots.ts, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LOCATION - Stable project identity used by binding requests.
//   config - Build a minimal effective configuration for a selected default model.
//   MemoryBindingStore - In-memory content-addressed snapshot and family-pointer double.
//   FakeHost - Mutable config/session/model boundary double.
//   request - Build a first-work binding request for a session.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SNAPSHOT-ANCHORING-REDESIGN T-004/T-005 - Replaced candidate-admission coverage with durable family-binding lifecycle and credential-safe rehydration coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createDefaultVvocConfig } from "../lib/vvoc-config.js";
import { behaviourContentHash, type BehaviourProjection } from "./snapshot-config.js";
import {
  createSnapshotService,
  resolveSessionFamily,
  type SnapshotServiceDeps,
} from "./snapshots.js";
import type { FamilyBindingRecord } from "./snapshot-store.js";
import {
  SnapshotAdmissionError,
  type EffectiveRuntimeConfig,
  type ModelSelection,
  type NativeSessionView,
  type RuntimeIdentity,
} from "./types.js";

const LOCATION: RuntimeIdentity = {
  directory: "/project",
  projectID: "proj",
  canonical: "/project",
};

function config(modelID: string): EffectiveRuntimeConfig {
  return {
    roles: { default: `provider/${modelID}` },
    agentRoles: { build: "default" },
    vvoc: createDefaultVvocConfig(),
  };
}

class MemoryBindingStore {
  readonly snapshots = new Map<string, BehaviourProjection>();
  readonly bindings = new Map<string, FamilyBindingRecord>();
  writes = 0;

  async writeSnapshot(projection: BehaviourProjection): Promise<string> {
    const hash = behaviourContentHash(projection);
    this.snapshots.set(hash, structuredClone(projection));
    return hash;
  }

  async readSnapshot(hash: string): Promise<BehaviourProjection | undefined> {
    const snapshot = this.snapshots.get(hash);
    if (snapshot === undefined || behaviourContentHash(snapshot) !== hash) return undefined;
    return structuredClone(snapshot);
  }

  async writeBinding(binding: FamilyBindingRecord): Promise<void> {
    this.writes += 1;
    this.bindings.set(binding.familyId, { ...binding });
  }

  async readBinding(familyId: string): Promise<FamilyBindingRecord | undefined> {
    const binding = this.bindings.get(familyId);
    return binding === undefined ? undefined : { ...binding };
  }

  async removeBinding(familyId: string): Promise<void> {
    this.bindings.delete(familyId);
  }

  async listBindings(): Promise<readonly FamilyBindingRecord[]> {
    return [...this.bindings.values()].map((binding) => ({ ...binding }));
  }

  async listSnapshots(): Promise<readonly string[]> {
    return [...this.snapshots.keys()];
  }

  async removeSnapshot(hash: string): Promise<void> {
    this.snapshots.delete(hash);
  }

  async countBindings(): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    for (const binding of this.bindings.values()) {
      counts.set(binding.snapshotHash, (counts.get(binding.snapshotHash) ?? 0) + 1);
    }
    return counts;
  }
}

class FakeHost {
  readonly sessions = new Map<string, NativeSessionView>();
  readonly models = new Map<string, ModelSelection>();
  readonly switches: Array<{ readonly sessionID: string; readonly model: ModelSelection }> = [];
  readonly diagnostics: string[] = [];
  config = config("one");
  pendingRebinds: Array<{
    id: string;
    requestedAt: number;
    directory: string;
    sessionId?: string;
  }> = [];

  constructor(readonly store: MemoryBindingStore) {}

  get deps(): SnapshotServiceDeps {
    return {
      store: this.store,
      location: LOCATION,
      loadConfig: async () => this.config,
      readSession: async (sessionID) => this.sessions.get(sessionID),
      readSessionModel: async (sessionID) => this.models.get(sessionID),
      switchModel: async (input) => {
        this.switches.push(input);
        this.models.set(input.sessionID, input.model);
      },
      auxiliarySession: {
        create: async () => ({ sessionID: "aux" }),
        switchModel: async () => undefined,
        generate: async () => ({ text: "ok" }),
      },
      diagnostic: (message) => this.diagnostics.push(message),
      rebindRequests: async () => this.pendingRebinds,
      now: () => 1_700_000_000_000,
    };
  }

  add(id: string, parentID?: string): void {
    this.sessions.set(id, { id, ...(parentID === undefined ? {} : { parentID }) });
  }
}

function request(sessionID: string) {
  return { sessionID, directory: LOCATION.directory, location: LOCATION };
}

describe("family bindings", () => {
  test("binds first work and rehydrates the original revision after a restart and config edit", async () => {
    const store = new MemoryBindingStore();
    const host = new FakeHost(store);
    host.add("root");
    const first = createSnapshotService(host.deps);

    expect((await first.admitOwned(request("root"))).status).toBe("bound");
    const originalHash = store.bindings.get("root")?.snapshotHash;
    host.config = config("two");

    const restarted = createSnapshotService(host.deps);
    const capture = await restarted.configFor("root");
    expect(capture?.roleModels.default.modelID).toBe("one");
    expect(store.bindings.get("root")?.snapshotHash).toBe(originalHash);
  });

  test("leaves an existing family on its bound revision while a new family binds current config", async () => {
    const store = new MemoryBindingStore();
    const host = new FakeHost(store);
    host.add("existing");
    host.add("new");
    const service = createSnapshotService(host.deps);

    await service.admitOwned(request("existing"));
    const existingHash = store.bindings.get("existing")?.snapshotHash;
    host.config = config("two");

    expect((await service.admitOwned(request("existing"))).status).toBe("reused");
    expect((await service.admitOwned(request("new"))).status).toBe("bound");
    expect((await service.configFor("existing"))?.roleModels.default.modelID).toBe("one");
    expect((await service.configFor("new"))?.roleModels.default.modelID).toBe("two");
    expect(store.bindings.get("existing")?.snapshotHash).toBe(existingHash);
    expect(store.bindings.get("new")?.snapshotHash).not.toBe(existingHash);
  });

  test("a pending force-rebind marker moves an existing family to current config on its next workload", async () => {
    const store = new MemoryBindingStore();
    const host = new FakeHost(store);
    host.add("root");
    const service = createSnapshotService(host.deps);

    await service.admitOwned(request("root"));
    const originalHash = store.bindings.get("root")?.snapshotHash;
    expect((await service.configFor("root"))?.roleModels.default.modelID).toBe("one");

    host.config = config("two");
    host.pendingRebinds.push({
      id: "req-1",
      requestedAt: 1_700_000_000_001,
      directory: LOCATION.directory,
    });

    const outcome = await service.admitOwned(request("root"));
    expect(outcome.status).toBe("bound");
    expect(store.bindings.get("root")?.snapshotHash).not.toBe(originalHash);
    expect((await service.configFor("root"))?.roleModels.default.modelID).toBe("two");
    expect(host.switches.at(-1)?.model.modelID).toBe("two");
  });

  test("a pending marker for another project does not rebind the family", async () => {
    const store = new MemoryBindingStore();
    const host = new FakeHost(store);
    host.add("root");
    const service = createSnapshotService(host.deps);
    await service.admitOwned(request("root"));
    const originalHash = store.bindings.get("root")?.snapshotHash;

    host.config = config("two");
    host.pendingRebinds.push({ id: "req-2", requestedAt: 1_700_000_000_001, directory: "/other" });

    expect((await service.admitOwned(request("root"))).status).toBe("reused");
    expect(store.bindings.get("root")?.snapshotHash).toBe(originalHash);
    expect((await service.configFor("root"))?.roleModels.default.modelID).toBe("one");
  });

  test("serializes concurrent first workloads for one family", async () => {
    const store = new MemoryBindingStore();
    const host = new FakeHost(store);
    host.add("root");
    host.add("child", "root");
    const service = createSnapshotService(host.deps);

    const [left, right] = await Promise.all([
      service.admitOwned(request("root")),
      service.admitOwned(request("child")),
    ]);

    expect([left.status, right.status].sort()).toEqual(["bound", "reused"]);
    expect(store.writes).toBe(1);
  });

  test("repairs a missing snapshot on the affected family's next workload", async () => {
    const store = new MemoryBindingStore();
    const host = new FakeHost(store);
    host.add("root");
    host.add("other");
    const service = createSnapshotService(host.deps);
    await service.admitOwned(request("other"));
    store.bindings.set("root", {
      familyId: "root",
      snapshotHash: "missing",
      boundAt: new Date(0).toISOString(),
    });

    const outcome = await service.admitOwned(request("root"));
    expect(outcome.status).toBe("bound");
    expect(store.bindings.get("other")).toBeDefined();
    expect(host.diagnostics.some((message) => message.includes("snapshot"))).toBe(true);
  });

  test("repairs a corrupt pointer and a missing pointer without affecting other families", async () => {
    const store = new MemoryBindingStore();
    const host = new FakeHost(store);
    host.add("corrupt");
    host.add("missing");
    host.add("other");
    const service = createSnapshotService(host.deps);
    await service.admitOwned(request("corrupt"));
    await service.admitOwned(request("missing"));
    await service.admitOwned(request("other"));
    const otherHash = store.bindings.get("other")?.snapshotHash;
    host.config = config("two");

    store.bindings.set("corrupt", {
      familyId: "wrong-family",
      snapshotHash: "not-used",
      boundAt: new Date(0).toISOString(),
    });
    store.bindings.delete("missing");

    expect((await service.admitOwned(request("corrupt"))).status).toBe("bound");
    expect((await service.admitOwned(request("missing"))).status).toBe("bound");
    expect((await service.configFor("corrupt"))?.roleModels.default.modelID).toBe("two");
    expect((await service.configFor("missing"))?.roleModels.default.modelID).toBe("two");
    expect(store.bindings.get("other")?.snapshotHash).toBe(otherHash);
    expect(host.diagnostics.some((message) => message.includes("pointer"))).toBe(true);
  });

  test("materializes live credentials without storing them in the projection", async () => {
    const store = new MemoryBindingStore();
    const host = new FakeHost(store);
    host.add("root");
    host.config = config("one");
    host.config.vvoc.web = {
      search: { apiKey: "test-only-search-key" },
      fetch: { apiKey: "test-only-fetch-key" },
    };
    host.config.vvoc.secretsRedaction.secret = "test-only-redaction-secret";
    const service = createSnapshotService(host.deps);

    await service.admitOwned(request("root"));
    const stored = await store.readSnapshot(store.bindings.get("root")!.snapshotHash);
    const capture = await service.configFor("root");

    expect(JSON.stringify(stored)).not.toContain("test-only");
    expect(capture?.vvoc.web?.search?.apiKey).toBe("test-only-search-key");
    expect(capture?.vvoc.web?.fetch?.apiKey).toBe("test-only-fetch-key");
    expect(capture?.vvoc.secretsRedaction.secret).toBe("test-only-redaction-secret");

    host.config.vvoc.web = { search: { apiKey: "rotated-search-key" } };
    host.config.vvoc.secretsRedaction.secret = "rotated-redaction-secret";
    const restarted = createSnapshotService(host.deps);
    const reattached = await restarted.configFor("root");
    expect(reattached?.vvoc.web?.search?.apiKey).toBe("rotated-search-key");
    expect(reattached?.vvoc.secretsRedaction.secret).toBe("rotated-redaction-secret");
    expect(
      JSON.stringify(await store.readSnapshot(store.bindings.get("root")!.snapshotHash)),
    ).not.toContain("rotated");
  });

  test("force rebind replaces matching pointers and deletion keeps then collects shared snapshots", async () => {
    const store = new MemoryBindingStore();
    const host = new FakeHost(store);
    host.add("root");
    host.add("other");
    host.add("child", "root");
    const service = createSnapshotService(host.deps);
    await service.admitOwned(request("root"));
    await service.admitOwned(request("other"));
    const originalHash = store.bindings.get("root")!.snapshotHash;

    host.config = config("two");
    expect(
      await service.rebind({ directory: LOCATION.directory, location: LOCATION, familyId: "root" }),
    ).toEqual(["root"]);
    expect(
      await service.rebind({
        directory: LOCATION.directory,
        location: { ...LOCATION, projectID: "other-project" },
      }),
    ).toEqual([]);
    expect(store.bindings.get("root")?.snapshotHash).not.toBe(originalHash);
    expect(store.bindings.get("other")?.snapshotHash).toBe(originalHash);

    // A deletion event for a known fork resolves to the root family pointer.
    await service.familyOf("child");
    await service.removeFamily("child");
    expect(store.bindings.has("root")).toBe(false);
    expect(store.snapshots.has(originalHash)).toBe(true);
    await service.removeFamily("other");
    expect(store.snapshots.has(originalHash)).toBe(false);
    expect(store.snapshots.size).toBe(0);
  });
});

describe("resolveSessionFamily", () => {
  test("uses host lineage and rejects cycles", async () => {
    const sessions = new Map<string, NativeSessionView>([
      ["child", { id: "child", parentID: "root" }],
      ["root", { id: "root" }],
    ]);
    expect(
      await resolveSessionFamily({
        sessionID: "child",
        readSession: async (id) => sessions.get(id),
      }),
    ).toBe("root");
    sessions.set("root", { id: "root", parentID: "child" });
    await expect(
      resolveSessionFamily({ sessionID: "child", readSession: async (id) => sessions.get(id) }),
    ).rejects.toBeInstanceOf(SnapshotAdmissionError);
  });
});
