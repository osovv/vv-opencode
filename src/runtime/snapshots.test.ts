// FILE: src/runtime/snapshots.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify full-policy family capture construction, host-verified lineage, and staged/accepted-boundary family admission including family-qualified variants, rollback, concurrency, and policy immutability.
//   SCOPE: In-memory native boundary doubles for full capture content, lineage, staged admission, commit-at-acceptance, conditional rollback, concurrent stage preservation, and bound-family stability; no real host.
//   DEPENDS: [bun:test, src/runtime/snapshots.ts, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LOCATION - Shared runtime location fixture.
//   VVOC - Default vvoc config fixture.
//   CONFIG_A - Effective config fixture with managed and non-managed models.
//   CONFIG_B - Effective config fixture with a different default model.
//   MemorySnapshotStore - In-memory SnapshotStore double with failure injection.
//   FakeNativeBoundaries - In-memory session/config/switch double.
//   addSession - Register one session view on the fake boundaries.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009 - Added force-escalation reconciliation, coordinated single-publish, and uncoordinated double-publish negative-control coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { coordinateHost } from "./coordination.js";
import {
  buildFamilyCapture,
  createSnapshotService,
  resolveSessionFamily,
  type SnapshotServiceDeps,
} from "./snapshots.js";
import { createDefaultVvocConfig } from "../lib/vvoc-config.js";
import {
  SnapshotAdmissionError,
  stagedCandidateKey,
  type AcceptedInput,
  type EffectiveRuntimeConfig,
  type FamilyCapture,
  type ModelSelection,
  type NativeSessionView,
  type SnapshotStore,
  type StagedCandidate,
} from "./types.js";

const LOCATION = { directory: "/project", projectID: "proj", canonical: "/project" };
const VVOC = createDefaultVvocConfig();

const CONFIG_A: EffectiveRuntimeConfig = {
  roles: { default: "prov/m1", fast: "prov/m2", smart: "xiaomi/mimo-v2.6-flash#thinking" },
  agentRoles: { build: "default", explore: "fast", guardian: "fast", "vv-controller": "smart" },
  vvoc: VVOC,
  modelSettings: [
    { providerID: "prov", modelID: "m1", body: { temperature: 0 } },
    {
      providerID: "xiaomi",
      modelID: "mimo-v2.6-flash",
      variant: "thinking",
      settings: { reasoningEffort: "low" },
    },
  ],
};
const CONFIG_B: EffectiveRuntimeConfig = {
  roles: { default: "prov/m9", fast: "prov/m2" },
  agentRoles: { build: "default" },
  vvoc: VVOC,
};

class MemorySnapshotStore implements SnapshotStore {
  readonly captures = new Map<string, FamilyCapture>();
  readonly candidates = new Map<string, StagedCandidate[]>();
  readonly markers = new Set<string>();
  failWriteCandidate = false;
  failWrite = false;
  writeCount = 0;
  writeDelayMs = 0;

  async read(familyId: string) {
    return this.captures.get(familyId);
  }
  async write(familyId: string, capture: FamilyCapture) {
    if (this.writeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
    }
    if (this.failWrite) throw new Error("commit failed");
    this.writeCount += 1;
    this.captures.set(familyId, capture);
  }
  async remove(familyId: string) {
    this.captures.delete(familyId);
  }
  async readCandidates(familyId: string) {
    return this.candidates.get(familyId) ?? [];
  }
  async writeCandidate(candidate: StagedCandidate) {
    if (this.failWriteCandidate) throw new Error("stage failed");
    const list = this.candidates.get(candidate.familyId) ?? [];
    const key = stagedCandidateKey(candidate);
    this.candidates.set(candidate.familyId, [
      ...list.filter((entry) => stagedCandidateKey(entry) !== key),
      candidate,
    ]);
  }
  async removeCandidate(familyId: string, candidateKey: string) {
    const list = this.candidates.get(familyId) ?? [];
    const remaining = list.filter((entry) => stagedCandidateKey(entry) !== candidateKey);
    if (remaining.length === 0) this.candidates.delete(familyId);
    else this.candidates.set(familyId, remaining);
  }
  async removeCandidates(familyId: string) {
    this.candidates.delete(familyId);
  }
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

class FakeNativeBoundaries {
  readonly sessions = new Map<string, NativeSessionView>();
  readonly models = new Map<string, ModelSelection>();
  readonly switchCalls: Array<{ sessionID: string; model: ModelSelection }> = [];
  config: EffectiveRuntimeConfig = CONFIG_A;
  /** Accepted inputs (native created/seq order); undefined means the source is unavailable. */
  accepted: ReadonlyArray<Omit<AcceptedInput, "sessionID" | "source">> | undefined = [];
  /** Whether the durable replay for the session reached a verified watermark. */
  acceptedComplete = true;
  switchBehavior:
    | ((input: { sessionID: string; model: ModelSelection }) => Promise<void>)
    | undefined;

  constructor(readonly store: MemorySnapshotStore) {}

  get deps(): SnapshotServiceDeps {
    return {
      store: this.store,
      loadConfig: async () => this.config,
      readSession: async (sessionID) => this.sessions.get(sessionID),
      readSessionModel: async (sessionID) => this.models.get(sessionID),
      switchModel: async (input) => {
        this.switchCalls.push(input);
        if (this.switchBehavior !== undefined) return this.switchBehavior(input);
        this.models.set(input.sessionID, input.model);
      },
      ...(this.accepted === undefined
        ? {}
        : {
            readAcceptedInputs: async (sessionID: string) =>
              this.accepted === undefined
                ? undefined
                : {
                    inputs: this.accepted.map((entry) => ({
                      sessionID,
                      inboxID: entry.inboxID,
                      itemType: entry.itemType,
                      created: entry.created ?? 0,
                      ...(entry.seq === undefined ? {} : { seq: entry.seq }),
                      source: "log" as const,
                    })),
                    complete: this.acceptedComplete,
                  },
          }),
      auxiliarySession: {
        create: async () => ({ sessionID: "ses_aux" }),
        switchModel: async () => undefined,
        generate: async () => ({ text: "generated" }),
      },
    };
  }
}

function addSession(host: FakeNativeBoundaries, view: NativeSessionView): void {
  host.sessions.set(view.id, view);
}

describe("buildFamilyCapture", () => {
  test("captures full vvoc policy, native overlays, and managed variants into content addressing", () => {
    const capture = buildFamilyCapture({
      familyId: "ses_root",
      location: LOCATION,
      config: CONFIG_A,
      intent: { mode: "implicit", source: "config" },
      capturedAt: 42,
    });

    expect(capture.integrity).toMatch(/^[0-9a-f]{64}$/);
    expect(capture.snapshotId).toMatch(/^[0-9a-f]{16}$/);
    expect(capture.vvoc.plugins).toBeDefined();
    expect(capture.modelSettings).toHaveLength(2);
    expect(capture.roleModels.smart).toEqual({
      providerID: "xiaomi",
      modelID: "mimo-v2.6-flash",
      variant: "thinking",
    });
    const managed = capture.variants.find((variant) => variant.sourceVariant === "thinking");
    expect(managed?.body).toEqual({ thinking: { type: "enabled" } });
    expect(JSON.stringify(capture.variants)).not.toContain("pdf");
    // The native overlay is captured for the captured variant.
    const overlay = capture.variants.find((variant) => variant.id.includes(".m1"));
    expect(overlay?.body).toEqual({ temperature: 0 });
  });

  test("content addressing changes when behavior-relevant policy changes", () => {
    const first = buildFamilyCapture({
      familyId: "ses_root",
      location: LOCATION,
      config: CONFIG_A,
      intent: { mode: "implicit", source: "config" },
    });
    const second = buildFamilyCapture({
      familyId: "ses_root",
      location: LOCATION,
      config: { ...CONFIG_A, vvoc: { ...VVOC, plugins: { ...VVOC.plugins, guardian: false } } },
      intent: { mode: "implicit", source: "config" },
    });
    expect(first.integrity).not.toBe(second.integrity);
  });

  test("does not create a managed variant for non-real MiMo selections", () => {
    const capture = buildFamilyCapture({
      familyId: "ses_root",
      location: LOCATION,
      config: {
        roles: { default: "xiaomi/vv-mimo-v2.6-flash-high" },
        agentRoles: {},
        modelSettings: [],
        vvoc: VVOC,
      },
      intent: { mode: "implicit", source: "config" },
    });
    expect(capture.variants).toHaveLength(0);
  });

  test("fails closed on an invalid role binding", () => {
    expect(() =>
      buildFamilyCapture({
        familyId: "ses_root",
        location: LOCATION,
        config: { roles: { default: "not-a-selection" }, agentRoles: {}, vvoc: VVOC },
        intent: { mode: "implicit", source: "config" },
      }),
    ).toThrow(SnapshotAdmissionError);
  });
});

describe("resolveSessionFamily", () => {
  test("walks parent lineage, fork.sessionID, and worktree moves to the family root", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addSession(host, { id: "root", locationDirectory: "/project" });
    addSession(host, { id: "child", parentID: "root" });
    addSession(host, { id: "fork", forkSessionID: "root" });
    addSession(host, { id: "moved", parentID: "root", locationDirectory: "/project/worktree" });
    const read = (sessionID: string) => Promise.resolve(host.sessions.get(sessionID));

    expect(await resolveSessionFamily({ sessionID: "child", readSession: read })).toBe("root");
    expect(await resolveSessionFamily({ sessionID: "fork", readSession: read })).toBe("root");
    expect(await resolveSessionFamily({ sessionID: "moved", readSession: read })).toBe("root");
  });

  test("fails closed on a lineage cycle", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addSession(host, { id: "a", parentID: "b" });
    addSession(host, { id: "b", parentID: "a" });
    const read = (sessionID: string) => Promise.resolve(host.sessions.get(sessionID));
    await expect(
      resolveSessionFamily({ sessionID: "a", readSession: read }),
    ).rejects.toBeInstanceOf(SnapshotAdmissionError);
  });
});

describe("createSnapshotService staged admission", () => {
  function addRoot(host: FakeNativeBoundaries): void {
    addSession(host, { id: "root", locationDirectory: "/project" });
  }

  test("stages the family-qualified selection, then commits at the accepted boundary", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addRoot(host);
    const snapshots = createSnapshotService(host.deps);

    const staged = await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-1",
      workload: "prompt",
    });
    expect(staged.status).toBe("staged");
    // Family-qualified variant is activated, not the plain model.
    expect(host.switchCalls[0]?.model).toEqual({
      providerID: "prov",
      modelID: "m1",
      variant: expect.stringMatching(/^[0-9a-f]+\.m1$/),
    });
    expect(await snapshots.hasStaged("root")).toBe(true);
    expect(host.store.captures.size).toBe(0);
    host.accepted = [{ inboxID: "msg-1", itemType: "user", created: 1 }];

    const committed = await snapshots.accept({
      sessionID: "root",
      inboxID: "msg-1",
      itemType: "user",
    });
    expect(committed.status).toBe("bound");
    expect(host.store.captures.size).toBe(1);
    expect(await snapshots.hasStaged("root")).toBe(false);
    expect(await snapshots.configFor("root")).toBeDefined();

    // Re-admission reuses the persisted capture and never switches again.
    const again = await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
    });
    expect(again.status).toBe("reused");
    expect(host.switchCalls).toHaveLength(1);
  });

  test("two families on the same model keep distinct captured variants", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addSession(host, { id: "rootA", locationDirectory: "/project" });
    addSession(host, { id: "rootB", locationDirectory: "/project" });
    const snapshots = createSnapshotService(host.deps);

    host.config = CONFIG_A;
    await snapshots.admitOwned({
      sessionID: "rootA",
      directory: "/project",
      location: LOCATION,
      operationID: "op-rootA",
    });
    host.config = {
      ...CONFIG_A,
      modelSettings: [
        {
          providerID: "xiaomi",
          modelID: "mimo-v2.6-flash",
          variant: "thinking",
          settings: { reasoningEffort: "high" },
        },
      ],
    };
    await snapshots.admitOwned({
      sessionID: "rootB",
      directory: "/project",
      location: LOCATION,
      operationID: "op-rootB",
    });

    const variantsA = await snapshots.variants("rootA");
    const variantsB = await snapshots.variants("rootB");
    const overlaysA = variantsA.find((entry) => entry.variant.sourceVariant === "thinking");
    const overlaysB = variantsB.find((entry) => entry.variant.sourceVariant === "thinking");
    expect(overlaysA?.variant.settings).toEqual({ reasoningEffort: "low" });
    expect(overlaysB?.variant.settings).toEqual({ reasoningEffort: "high" });
    expect(overlaysA?.variant.id).not.toBe(overlaysB?.variant.id);
  });

  test("an explicit selection is preserved and stored as the capture override", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addRoot(host);
    host.models.set("root", { providerID: "prov", modelID: "user-pick" });
    const snapshots = createSnapshotService(host.deps);

    const outcome = await snapshots.admitOwned({
      operationID: "op-1",
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      explicit: { providerID: "prov", modelID: "user-pick" },
      before: { providerID: "prov", modelID: "user-pick" },
    });
    expect(outcome.status).toBe("bound");
    expect(host.switchCalls[0]?.model).toEqual({ providerID: "prov", modelID: "user-pick" });
    const policy = await snapshots.policy("root");
    expect(policy?.modelOverride).toEqual({ providerID: "prov", modelID: "user-pick" });
  });

  test("an active session with no capture fails closed instead of adopting current policy", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addSession(host, { id: "root", locationDirectory: "/project", hasActivity: true });
    const snapshots = createSnapshotService(host.deps);

    const outcome = await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
    });
    expect(outcome.status).toBe("rejected");
    expect(host.switchCalls).toHaveLength(0);
  });

  test("a durable bound marker fails closed when the capture is missing", async () => {
    const store = new MemorySnapshotStore();
    const host = new FakeNativeBoundaries(store);
    addRoot(host);
    store.markers.add("root");
    const snapshots = createSnapshotService(host.deps);

    const outcome = await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
    });
    expect(outcome.status).toBe("rejected");
    expect(host.switchCalls).toHaveLength(0);
  });

  test("materializes the staged candidate before the switch and refuses on failure", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addRoot(host);
    const snapshots = createSnapshotService(host.deps);
    const order: string[] = [];

    const outcome = await snapshots.stage(
      { sessionID: "root", directory: "/project", location: LOCATION },
      async (_capture, selection) => {
        order.push(`materialize:${selection.modelID}${selection.variant ?? ""}`);
      },
    );
    order.push("switch");
    expect(outcome.status).toBe("staged");
    // Materialize ran before the engine issued the switch.
    expect(order[0]).toMatch(/^materialize:/);

    const failing = new FakeNativeBoundaries(new MemorySnapshotStore());
    addSession(failing, { id: "root2", locationDirectory: "/project" });
    const failingSnapshots = createSnapshotService(failing.deps);
    const rejected = await failingSnapshots.stage(
      { sessionID: "root2", directory: "/project", location: LOCATION },
      async () => {
        throw new Error("variant not materializable");
      },
    );
    expect(rejected.status).toBe("rejected");
    expect(failing.switchCalls).toHaveLength(0);
  });

  test("persistence failure at stage blocks the native switch entirely", async () => {
    const store = new MemorySnapshotStore();
    store.failWriteCandidate = true;
    const host = new FakeNativeBoundaries(store);
    addRoot(host);
    const snapshots = createSnapshotService(host.deps);

    const outcome = await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
    });
    expect(outcome.status).toBe("rejected");
    expect(host.switchCalls).toHaveLength(0);
  });

  test("commit failure undoes its own switch and publishes no policy", async () => {
    const store = new MemorySnapshotStore();
    const host = new FakeNativeBoundaries(store);
    addRoot(host);
    host.models.set("root", { providerID: "prov", modelID: "before" });
    const snapshots = createSnapshotService(host.deps);
    await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      before: { providerID: "prov", modelID: "before" },
      inboxID: "msg-1",
      workload: "prompt",
    });
    host.accepted = [{ inboxID: "msg-1", itemType: "user", created: 1 }];
    store.failWrite = true;

    const outcome = await snapshots.accept({
      sessionID: "root",
      inboxID: "msg-1",
      itemType: "user",
    });
    expect(outcome.status).toBe("rejected");
    expect(outcome.rollback).toBe("reverted");
    expect(host.models.get("root")).toEqual({ providerID: "prov", modelID: "before" });
    expect(store.captures.size).toBe(0);
  });

  test("commit failure preserves a newer same-model variant choice", async () => {
    const store = new MemorySnapshotStore();
    const host = new FakeNativeBoundaries(store);
    addRoot(host);
    const snapshots = createSnapshotService(host.deps);
    await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-1",
      workload: "prompt",
    });
    host.accepted = [{ inboxID: "msg-1", itemType: "user", created: 1 }];
    store.failWrite = true;
    // A newer explicit choice replaced our staged switch with the same model but a different variant.
    host.models.set("root", { providerID: "prov", modelID: "m1", variant: "user-variant" });

    const outcome = await snapshots.accept({
      sessionID: "root",
      inboxID: "msg-1",
      itemType: "user",
    });
    expect(outcome.status).toBe("rejected");
    expect(outcome.rollback).toBe("preserved-newer-choice");
    expect(host.models.get("root")).toEqual({
      providerID: "prov",
      modelID: "m1",
      variant: "user-variant",
    });
  });

  test("rejected native switch preserves a newer choice or reverts its own mutation", async () => {
    const store = new MemorySnapshotStore();
    const host = new FakeNativeBoundaries(store);
    addRoot(host);
    host.models.set("root", { providerID: "prov", modelID: "before" });
    let calls = 0;
    host.switchBehavior = async (input) => {
      calls += 1;
      host.models.set(input.sessionID, input.model);
      if (calls === 1) {
        host.models.set(input.sessionID, { providerID: "prov", modelID: "user-pick" });
        throw new Error("switch rejected");
      }
    };
    const snapshots = createSnapshotService(host.deps);

    const outcome = await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      before: { providerID: "prov", modelID: "before" },
    });
    expect(outcome.status).toBe("rejected");
    expect(outcome.rollback).toBe("preserved-newer-choice");
    expect(host.models.get("root")).toEqual({ providerID: "prov", modelID: "user-pick" });
  });

  test("concurrent stages share one candidate and never turn rejection into reuse", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addRoot(host);
    const snapshots = createSnapshotService(host.deps);

    const [a, b] = await Promise.all([
      snapshots.stage({ sessionID: "root", directory: "/project", location: LOCATION }),
      snapshots.stage({ sessionID: "root", directory: "/project", location: LOCATION }),
    ]);
    expect(a.status).toBe("staged");
    expect(b.status).toBe("staged");
    expect(host.switchCalls).toHaveLength(1);

    // A rejected concurrent stage must stay rejected for every waiter.
    const rejectedHost = new FakeNativeBoundaries(new MemorySnapshotStore());
    addRoot(rejectedHost);
    rejectedHost.config = { roles: { default: "invalid" }, agentRoles: {}, vvoc: VVOC };
    const rejected = createSnapshotService(rejectedHost.deps);
    const [r1, r2] = await Promise.all([
      rejected.stage({ sessionID: "root", directory: "/project", location: LOCATION }),
      rejected.stage({ sessionID: "root", directory: "/project", location: LOCATION }),
    ]);
    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("rejected");
  });

  test("bound families keep their capture while unbound families pick up a preset switch", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addSession(host, { id: "bound-root", locationDirectory: "/project" });
    addSession(host, { id: "fresh-root", locationDirectory: "/project" });
    const snapshots = createSnapshotService(host.deps);

    await snapshots.admitOwned({
      sessionID: "bound-root",
      directory: "/project",
      location: LOCATION,
      operationID: "op-bound",
    });
    host.config = CONFIG_B;

    const bound = await snapshots.policy("bound-root");
    expect(bound?.roleModels.default).toEqual({ providerID: "prov", modelID: "m1" });

    await snapshots.admitOwned({
      sessionID: "fresh-root",
      directory: "/project",
      location: LOCATION,
      operationID: "op-fresh",
    });
    const fresh = await snapshots.policy("fresh-root");
    expect(fresh?.roleModels.default).toEqual({ providerID: "prov", modelID: "m9" });
  });

  test("the first accepted input wins even when a later input staged a changed policy", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addRoot(host);
    const snapshots = createSnapshotService(host.deps);
    await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-A",
      workload: "prompt",
    });
    host.config = CONFIG_B;
    await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-B",
      workload: "prompt",
    });
    expect(await snapshots.hasStaged("root")).toBe(true);

    // Native accepted A before B regardless of which notification the pump saw first.
    host.accepted = [
      { inboxID: "msg-A", itemType: "user", created: 10 },
      { inboxID: "msg-B", itemType: "user", created: 20 },
    ];
    const outcome = await snapshots.accept({ sessionID: "root" });
    expect(outcome.status).toBe("bound");
    const capture = await snapshots.policy("root");
    expect(capture?.roleModels.default).toEqual({ providerID: "prov", modelID: "m1" });
  });

  test("reverse acceptance order binds the later policy", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addRoot(host);
    const snapshots = createSnapshotService(host.deps);
    await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-A",
      workload: "prompt",
    });
    host.config = CONFIG_B;
    await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-B",
      workload: "prompt",
    });
    // B was accepted first.
    host.accepted = [
      { inboxID: "msg-B", itemType: "user", created: 10 },
      { inboxID: "msg-A", itemType: "user", created: 20 },
    ];
    expect((await snapshots.accept({ sessionID: "root" })).status).toBe("bound");
    const capture = await snapshots.policy("root");
    expect(capture?.roleModels.default).toEqual({ providerID: "prov", modelID: "m9" });
  });

  test("multiple staged inputs fail closed until a complete durable replay orders them", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addRoot(host);
    const snapshots = createSnapshotService(host.deps);
    await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-A",
      workload: "prompt",
    });
    await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-B",
      workload: "prompt",
    });
    // A live-only, incomplete view cannot prove the first accepted workload.
    host.accepted = [{ inboxID: "msg-A", itemType: "user", created: 10 }];
    host.acceptedComplete = false;
    expect((await snapshots.accept({ sessionID: "root" })).status).toBe("rejected");
    expect(host.store.captures.size).toBe(0);

    host.acceptedComplete = true;
    host.accepted = [
      { inboxID: "msg-A", itemType: "user", created: 10 },
      { inboxID: "msg-B", itemType: "user", created: 20 },
    ];
    expect((await snapshots.accept({ sessionID: "root" })).status).toBe("bound");
    const capture = await snapshots.policy("root");
    expect(capture?.roleModels.default).toEqual({ providerID: "prov", modelID: "m1" });
  });

  test("repeating the same input is idempotent", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addRoot(host);
    const snapshots = createSnapshotService(host.deps);
    await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-1",
      workload: "prompt",
    });
    await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-1",
      workload: "prompt",
    });
    expect(host.store.candidates.get("root")).toHaveLength(1);
    expect(host.switchCalls).toHaveLength(1);
    host.accepted = [{ inboxID: "msg-1", itemType: "user", created: 1 }];
    expect((await snapshots.accept({ sessionID: "root" })).status).toBe("bound");
    expect((await snapshots.accept({ sessionID: "root" })).status).toBe("reused");
  });

  test("candidate overflow fails closed without discarding existing inputs", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addRoot(host);
    const snapshots = createSnapshotService(host.deps);
    for (let index = 0; index < 8; index += 1) {
      const staged = await snapshots.stage({
        sessionID: "root",
        directory: "/project",
        location: LOCATION,
        inboxID: `msg-${index}`,
        workload: "prompt",
      });
      expect(staged.status).toBe("staged");
    }
    const overflow = await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-overflow",
      workload: "prompt",
    });
    expect(overflow.status).toBe("rejected");
    const candidates = host.store.candidates.get("root") ?? [];
    expect(candidates).toHaveLength(8);
    expect(candidates.map((entry) => entry.inboxID)).toContain("msg-0");
  });

  test("a rejected preparation followed by a valid input binds the valid policy", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addRoot(host);
    const snapshots = createSnapshotService(host.deps);
    await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-A",
      workload: "prompt",
    });
    host.config = CONFIG_B;
    await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-B",
      workload: "prompt",
    });
    // Only B is ever accepted; A's preparation failed and stays pending.
    host.accepted = [{ inboxID: "msg-B", itemType: "user", created: 5 }];
    expect((await snapshots.accept({ sessionID: "root" })).status).toBe("bound");
    const capture = await snapshots.policy("root");
    expect(capture?.roleModels.default).toEqual({ providerID: "prov", modelID: "m9" });
  });

  test("concurrent distinct inputs keep independent candidates", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addRoot(host);
    const snapshots = createSnapshotService(host.deps);
    await Promise.all([
      snapshots.stage({
        sessionID: "root",
        directory: "/project",
        location: LOCATION,
        inboxID: "msg-1",
        workload: "prompt",
      }),
      snapshots.stage({
        sessionID: "root",
        directory: "/project",
        location: LOCATION,
        inboxID: "msg-2",
        workload: "prompt",
      }),
    ]);
    const candidates = host.store.candidates.get("root") ?? [];
    expect(candidates).toHaveLength(2);
    expect(candidates.map((entry) => entry.inboxID).sort()).toEqual(["msg-1", "msg-2"]);
  });

  test("publication failure leaves no readable capture and no marker", async () => {
    const store = new MemorySnapshotStore();
    const host = new FakeNativeBoundaries(store);
    addRoot(host);
    const snapshots = createSnapshotService(host.deps);
    await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-1",
    });
    host.accepted = [{ inboxID: "msg-1", itemType: "user", created: 1 }];
    store.failWrite = true;
    const outcome = await snapshots.accept({ sessionID: "root" });
    expect(outcome.status).toBe("rejected");
    expect(store.captures.size).toBe(0);
    expect(store.markers.has("root")).toBe(false);
    expect(await snapshots.policy("root")).toBeUndefined();
  });

  test("a fresh service reacquires both candidates and the earlier accepted input wins", async () => {
    const store = new MemorySnapshotStore();
    const first = new FakeNativeBoundaries(store);
    addRoot(first);
    const serviceA = createSnapshotService(first.deps);
    await serviceA.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-A",
      workload: "prompt",
    });
    await serviceA.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-B",
      workload: "prompt",
    });
    serviceA.dispose();

    const second = new FakeNativeBoundaries(store);
    addSession(second, { id: "root", locationDirectory: "/project" });
    second.accepted = [
      { inboxID: "msg-A", itemType: "user", created: 10 },
      { inboxID: "msg-B", itemType: "user", created: 20 },
    ];
    const serviceB = createSnapshotService(second.deps);
    expect((await serviceB.accept({ sessionID: "root" })).status).toBe("bound");
    const capture = await serviceB.configFor("root");
    expect(capture?.roleModels.default).toEqual({ providerID: "prov", modelID: "m1" });
  });

  test("the owned gateway publishes its own operation and accept refuses an owned candidate", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addRoot(host);
    const snapshots = createSnapshotService(host.deps);
    await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-1",
      workload: "prompt",
    });
    const owned = await snapshots.admitOwned({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      operationID: "op-1",
      selectionOverride: { providerID: "prov", modelID: "m9" },
    });
    expect(owned.status).toBe("bound");
    const capture = await snapshots.policy("root");
    expect(capture?.modelOverride).toEqual({ providerID: "prov", modelID: "m9" });
    // The prompt candidate was never adopted by the owned gateway.
    expect((await snapshots.accept({ sessionID: "root" })).status).toBe("reused");

    const ownedOnly = new FakeNativeBoundaries(new MemorySnapshotStore());
    addRoot(ownedOnly);
    const ownedSnapshots = createSnapshotService(ownedOnly.deps);
    await ownedSnapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      operationID: "op-owned",
      workload: "generate",
    });
    expect((await ownedSnapshots.accept({ sessionID: "root" })).status).toBe("rejected");
    expect(
      (
        await ownedSnapshots.admitOwned({
          sessionID: "root",
          directory: "/project",
          location: LOCATION,
          operationID: "op-owned",
        })
      ).status,
    ).toBe("bound");
  });

  test("a force:true escalation of an identical input reconciles the required switch", async () => {
    const host = new FakeNativeBoundaries(new MemorySnapshotStore());
    addRoot(host);
    const snapshots = createSnapshotService(host.deps);

    const first = await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-1",
      workload: "prompt",
      force: false,
    });
    expect(first.status).toBe("staged");
    expect(host.switchCalls).toHaveLength(0);

    // The same input escalates to force:true; the required materialization/switch
    // must happen instead of returning early with zero switches.
    const second = await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-1",
      workload: "prompt",
      force: true,
    });
    expect(second.status).toBe("staged");
    expect(host.switchCalls).toHaveLength(1);
    expect(host.switchCalls[0]?.model.modelID).toBe("m1");

    // An already-applied identical escalation stays idempotent.
    const third = await snapshots.stage({
      sessionID: "root",
      directory: "/project",
      location: LOCATION,
      inboxID: "msg-1",
      workload: "prompt",
      force: true,
    });
    expect(third.status).toBe("staged");
    expect(host.switchCalls).toHaveLength(1);
  });

  test("coordinated services publish a concurrent first binding exactly once", async () => {
    const store = new MemorySnapshotStore();
    store.writeDelayMs = 5;
    const coordination = coordinateHost({ app: {}, location: {} });
    const first = new FakeNativeBoundaries(store);
    addRoot(first);
    const second = new FakeNativeBoundaries(store);
    addSession(second, { id: "root", locationDirectory: "/project" });
    const accepted = [{ inboxID: "msg-1", itemType: "user" as const, created: 1 }];
    first.accepted = accepted;
    second.accepted = accepted;

    const serviceA = createSnapshotService({ ...first.deps, coordination });
    const serviceB = createSnapshotService({ ...second.deps, coordination });
    for (const service of [serviceA, serviceB]) {
      const staged = await service.stage({
        sessionID: "root",
        directory: "/project",
        location: LOCATION,
        inboxID: "msg-1",
        workload: "prompt",
      });
      expect(staged.status).toBe("staged");
    }

    const [left, right] = await Promise.all([
      serviceA.accept({ sessionID: "root" }),
      serviceB.accept({ sessionID: "root" }),
    ]);
    expect([left.status, right.status].sort()).toEqual(["bound", "reused"]);
    expect(store.writeCount).toBe(1);
  });

  test("uncoordinated services can double-publish a concurrent first binding (negative control)", async () => {
    const store = new MemorySnapshotStore();
    store.writeDelayMs = 5;
    const first = new FakeNativeBoundaries(store);
    addRoot(first);
    const second = new FakeNativeBoundaries(store);
    addSession(second, { id: "root", locationDirectory: "/project" });
    const accepted = [{ inboxID: "msg-1", itemType: "user" as const, created: 1 }];
    first.accepted = accepted;
    second.accepted = accepted;

    const serviceA = createSnapshotService(first.deps);
    const serviceB = createSnapshotService(second.deps);
    for (const service of [serviceA, serviceB]) {
      await service.stage({
        sessionID: "root",
        directory: "/project",
        location: LOCATION,
        inboxID: "msg-1",
        workload: "prompt",
      });
    }
    await Promise.all([
      serviceA.accept({ sessionID: "root" }),
      serviceB.accept({ sessionID: "root" }),
    ]);
    // Without a shared lock both acceptors publish, which is exactly the defect the
    // coordinator lock prevents.
    expect(store.writeCount).toBeGreaterThan(1);
  });
});
