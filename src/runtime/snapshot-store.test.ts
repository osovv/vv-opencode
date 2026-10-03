// FILE: src/runtime/snapshot-store.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify durable project-scoped family-snapshot persistence, staged candidates, integrity verification, immutable reads, and fail-closed corruption handling.
//   SCOPE: Temp-dir file-store round trips, family listing, cross-project isolation, integrity rejection, and invalid-shape rejection; no native host.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/runtime/snapshot-store.ts, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   makeCapture - Build a valid integrity-checked family capture fixture.
//   tempDirs - Tracks temporary data roots for cleanup.
//   createDataDir - Create a temporary vvoc data root for the store.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-002 - Project-scoped store, integrity, and immutable-read coverage.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBehaviourProjection } from "./snapshot-config.js";
import { createDefaultVvocConfig, type VvocConfig } from "../lib/vvoc-config.js";
import {
  BINDING_STORE_DIR_NAME,
  FileBindingStore,
  createFileSnapshotStore,
  decodeFamilyCapture,
  familyCaptureIntegrity,
  snapshotScopeDirName,
} from "./snapshot-store.js";
import {
  SnapshotStoreError,
  stagedCandidateKey,
  type FamilyCapture,
  type StagedCandidate,
} from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function createDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vvoc-snapshot-store-"));
  tempDirs.push(dir);
  return dir;
}

function makeCapture(familyId: string, overrides: Partial<FamilyCapture> = {}): FamilyCapture {
  const draft: FamilyCapture = {
    schemaVersion: 1,
    snapshotId: "",
    integrity: "",
    familyId,
    capturedAt: 100,
    location: { directory: "/project", projectID: "proj", canonical: "/project" },
    roles: { default: "prov/m1" },
    roleModels: { default: { providerID: "prov", modelID: "m1" } },
    agents: [
      { agentID: "build", role: "default", selection: { providerID: "prov", modelID: "m1" } },
    ],
    variants: [],
    modelSettings: [{ providerID: "prov", modelID: "m1", body: { temperature: 0 } }],
    vvoc: createDefaultVvocConfig(),
    intent: { mode: "implicit", source: "config" },
    ...overrides,
  };
  const integrity = familyCaptureIntegrity(draft);
  return { ...draft, integrity, snapshotId: integrity.slice(0, 16) };
}

describe("createFileSnapshotStore", () => {
  test("round-trips integrity-checked captures, staged candidates, and family listing", async () => {
    const store = createFileSnapshotStore({ scopeKey: "proj-1", dataDir: await createDataDir() });
    const capture = makeCapture("ses_1");
    await store.write("ses_1", capture);

    const loaded = await store.read("ses_1");
    expect(loaded).toEqual(capture);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(await store.list()).toEqual(["ses_1"]);

    const candidate: StagedCandidate = {
      familyId: "ses_1",
      sessionID: "ses_1",
      stagedAt: 5,
      revision: capture.integrity,
      selection: { providerID: "prov", modelID: "m1" },
      capture,
    };
    await store.writeCandidate(candidate);
    expect(await store.readCandidates("ses_1")).toEqual([candidate]);
    expect(await store.list()).toEqual(["ses_1"]);
    await store.removeCandidate("ses_1", stagedCandidateKey(candidate));
    expect(await store.readCandidates("ses_1")).toEqual([]);

    expect(await store.readMarker("ses_1")).toBe(false);
    await store.writeMarker("ses_1");
    expect(await store.readMarker("ses_1")).toBe(true);
    await store.removeMarker("ses_1");
    expect(await store.readMarker("ses_1")).toBe(false);

    await store.remove("ses_1");
    expect(await store.read("ses_1")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  test("isolates captures by project scope", async () => {
    const dataDir = await createDataDir();
    const left = createFileSnapshotStore({ scopeKey: "project-a", dataDir });
    const right = createFileSnapshotStore({ scopeKey: "project-b", dataDir });

    await left.write("ses_1", makeCapture("ses_1"));
    expect(await left.list()).toEqual(["ses_1"]);
    expect(await right.list()).toEqual([]);
  });

  test("a moved worktree in the same project still resolves the root capture", async () => {
    const dataDir = await createDataDir();
    // Two store instances with the same project scope share captures despite different paths.
    const root = createFileSnapshotStore({ scopeKey: "proj-1", dataDir });
    const worktree = createFileSnapshotStore({ scopeKey: "proj-1", dataDir });
    await root.write("ses_root", makeCapture("ses_root"));
    expect(await worktree.read("ses_root")).toBeDefined();
  });

  test("fails closed on corrupt persisted state instead of adopting it", async () => {
    const dataDir = await createDataDir();
    const store = createFileSnapshotStore({ scopeKey: "proj-1", dataDir });
    const path = join(
      dataDir,
      "snapshots",
      snapshotScopeDirName("proj-1"),
      `${encodeURIComponent("ses_1")}.json`,
    );
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{ not json", "utf8");

    await expect(store.read("ses_1")).rejects.toBeInstanceOf(SnapshotStoreError);
  });

  test("rejects tampered content whose integrity no longer matches", async () => {
    const dataDir = await createDataDir();
    const store = createFileSnapshotStore({ scopeKey: "proj-1", dataDir });
    const capture = makeCapture("ses_1");
    await store.write("ses_1", capture);
    const path = join(
      dataDir,
      "snapshots",
      snapshotScopeDirName("proj-1"),
      `${encodeURIComponent("ses_1")}.json`,
    );
    const tampered = JSON.parse(JSON.stringify(capture));
    tampered.roles.default = "attacker/model";
    await writeFile(path, `${JSON.stringify(tampered)}\n`, "utf8");

    await expect(store.read("ses_1")).rejects.toBeInstanceOf(SnapshotStoreError);
  });

  test("rejects structurally invalid or incomplete captures", () => {
    expect(decodeFamilyCapture({ schemaVersion: 2 })).toBeUndefined();
    expect(
      decodeFamilyCapture({
        schemaVersion: 1,
        snapshotId: "s",
        integrity: "x",
        familyId: "f",
        capturedAt: 1,
        location: { directory: "/p", projectID: "p", canonical: "/p" },
        roles: {},
        roleModels: {},
        agents: [],
        variants: [],
        // modelSettings and vvoc missing
        intent: { mode: "implicit", source: "config" },
      }),
    ).toBeUndefined();
  });
});

describe("FileBindingStore", () => {
  function projection(apiKey: string) {
    const config: VvocConfig = {
      ...createDefaultVvocConfig(),
      web: {
        search: { provider: "exa", apiKey },
        fetch: { provider: "native", apiKey },
      },
    };
    return buildBehaviourProjection({
      roles: config.roles,
      agentRoles: { build: "default" },
      vvoc: config,
    });
  }

  function policyPath(dataDir: string, scopeKey: string, hash: string): string {
    return join(
      dataDir,
      BINDING_STORE_DIR_NAME,
      snapshotScopeDirName(scopeKey),
      "policies",
      `${hash}.json`,
    );
  }

  test("round-trips content-addressed snapshots and family pointers", async () => {
    const dataDir = await createDataDir();
    const store = new FileBindingStore({ scopeKey: "proj-1", dataDir });
    const value = projection("secret-key");
    const hash = await store.writeSnapshot(value);
    expect(await store.readSnapshot(hash)).toEqual(value);
    await store.writeBinding({
      familyId: "ses_1",
      snapshotHash: hash,
      boundAt: "2026-01-01T00:00:00.000Z",
    });
    expect((await store.readBinding("ses_1"))?.snapshotHash).toBe(hash);
    const counts = await store.countBindings();
    expect(counts.get(hash)).toBe(1);
    await store.removeBinding("ses_1");
    expect(await store.readBinding("ses_1")).toBeUndefined();
  });

  test("deduplicates identical snapshots and never writes credentials", async () => {
    const dataDir = await createDataDir();
    const store = new FileBindingStore({ scopeKey: "proj-1", dataDir });
    const left = await store.writeSnapshot(projection("left-secret"));
    const right = await store.writeSnapshot(projection("right-secret"));
    expect(right).toBe(left);
    expect(await store.listSnapshots()).toEqual([left]);
    const text = await readFile(policyPath(dataDir, "proj-1", left), "utf8");
    expect(text).not.toContain("left-secret");
    expect(text).not.toContain("right-secret");
    expect(text).not.toContain("apiKey");
  });

  test("fails soft on corrupt snapshots, mismatched hashes, and missing pointers", async () => {
    const dataDir = await createDataDir();
    const store = new FileBindingStore({ scopeKey: "proj-1", dataDir });
    const hash = await store.writeSnapshot(projection("k"));
    await writeFile(policyPath(dataDir, "proj-1", hash), "{ not json", "utf8");
    expect(await store.readSnapshot(hash)).toBeUndefined();
    expect(await store.readSnapshot("0".repeat(64))).toBeUndefined();
    expect(await store.readBinding("missing")).toBeUndefined();
  });

  test("ignores the legacy snapshot directory", async () => {
    const dataDir = await createDataDir();
    const legacyDir = join(dataDir, "snapshots", snapshotScopeDirName("proj-1"));
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, "ses_legacy.json"), "{}", "utf8");
    const store = new FileBindingStore({ scopeKey: "proj-1", dataDir });
    expect(await store.listSnapshots()).toEqual([]);
    expect(await store.listBindings()).toEqual([]);
  });
});
