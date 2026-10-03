// FILE: src/runtime/snapshot-config.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify full effective-config extraction, role/agent binding parsing, initial-selection provenance, and config.updated watching.
//   SCOPE: vvoc snapshot policy derivation, invalid-binding failure, initial default/explicit classification, and watcher notification and error reporting; no native host.
//   DEPENDS: [bun:test, src/lib/config-layers.ts, src/lib/vvoc-config.ts, src/runtime/snapshot-config.ts, src/runtime/types.ts]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   makeSnapshot - Build a vvoc config snapshot fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-002 - Initial-selection provenance and full config coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { VvocConfigSnapshot } from "../lib/config-layers.js";
import { createDefaultVvocConfig, type VvocConfig } from "../lib/vvoc-config.js";
import {
  agentBindingsFrom,
  agentPolicyBindings,
  behaviourContentHash,
  buildBehaviourProjection,
  canonicalizeJson,
  classifyInitialSelection,
  effectiveRuntimeConfig,
  isAcceptedWorkloadEvent,
  isConfigUpdateEvent,
  parseRoleSelections,
  sanitizePolicyConfig,
  watchConfigUpdates,
} from "./snapshot-config.js";
import { SnapshotAdmissionError } from "./types.js";

function makeSnapshot(roles = {}): VvocConfigSnapshot {
  const config = createDefaultVvocConfig();
  return {
    config: { ...config, roles: { ...config.roles, ...roles } },
    source: { kind: "project", path: "/p/.vvoc/vvoc.json" },
    warnings: [],
    loadedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("effectiveRuntimeConfig", () => {
  test("captures effective roles, built-in agent bindings, and the full vvoc document", () => {
    const effective = effectiveRuntimeConfig(makeSnapshot({ default: "prov/m1" }));
    expect(effective.roles.default).toBe("prov/m1");
    expect(effective.agentRoles.build).toBe("default");
    expect(effective.agentRoles.guardian).toBe("fast");
    expect(effective.agentRoles["vv-controller"]).toBe("smart");
    expect(effective.vvoc?.plugins).toBeDefined();
    expect(effective.sourcePath).toBe("/p/.vvoc/vvoc.json");
  });

  test("parses role selections and fails closed on an invalid binding", () => {
    expect(parseRoleSelections({ smart: "prov/m2#xhigh" })).toEqual({
      smart: { providerID: "prov", modelID: "m2", variant: "xhigh" },
    });
    expect(() => parseRoleSelections({ smart: "nope" })).toThrow(SnapshotAdmissionError);
  });

  test("derives agent bindings with resolved selections", () => {
    const effective = effectiveRuntimeConfig(makeSnapshot({ fast: "prov/m2" }));
    const bindings = agentPolicyBindings(effective);
    expect(bindings.find((binding) => binding.agentID === "guardian")?.selection).toEqual({
      providerID: "prov",
      modelID: "m2",
    });
    expect(bindings.find((binding) => binding.agentID === "build")?.role).toBe("default");

    const explicit = agentBindingsFrom(
      { custom: "fast" },
      { fast: { providerID: "prov", modelID: "m2" } },
    );
    expect(explicit).toEqual([
      { agentID: "custom", role: "fast", selection: { providerID: "prov", modelID: "m2" } },
    ]);
  });
});

describe("classifyInitialSelection", () => {
  test("a session model matching the creation default is implicit; a differing one is explicit", () => {
    const creationDefault = { providerID: "loopback", modelID: "seam-smart" };
    expect(
      classifyInitialSelection({
        sessionModel: { providerID: "loopback", modelID: "seam-smart" },
        creationDefault,
      }),
    ).toEqual({ mode: "implicit", source: "config" });
    expect(
      classifyInitialSelection({
        sessionModel: { providerID: "loopback", modelID: "seam-fast" },
        creationDefault,
      }),
    ).toEqual({
      mode: "explicit",
      source: "watcher",
      literal: { providerID: "loopback", modelID: "seam-fast" },
    });
    expect(classifyInitialSelection({ sessionModel: undefined, creationDefault })).toEqual({
      mode: "implicit",
      source: "config",
    });
  });

  test("the native absent/`default` variant is not a distinct selection", () => {
    expect(
      classifyInitialSelection({
        sessionModel: { providerID: "loopback", modelID: "seam-smart", variant: "default" },
        creationDefault: { providerID: "loopback", modelID: "seam-smart" },
      }),
    ).toEqual({ mode: "implicit", source: "config" });
  });

  test("only config.updated invalidates candidates; own reload output never does", () => {
    expect(isConfigUpdateEvent({ type: "config.updated" })).toBe(true);
    expect(isConfigUpdateEvent({ type: "model.updated" })).toBe(false);
    expect(isConfigUpdateEvent({ type: "agent.updated" })).toBe(false);
    expect(isConfigUpdateEvent({ type: "session.created" })).toBe(false);
  });

  test("accepted input is the native inbox enqueue, not a resume start", () => {
    expect(
      isAcceptedWorkloadEvent({ type: "session.execution.started", data: { sessionID: "s" } }),
    ).toBe(false);
    expect(
      isAcceptedWorkloadEvent({
        type: "session.inbox.enqueued",
        data: { sessionID: "s", inboxID: "i", item: { type: "user" } },
      }),
    ).toBe(true);
  });
});

describe("watchConfigUpdates", () => {
  test("notifies on config.updated, stops on abort, and reports transport failure", async () => {
    const controller = new AbortController();
    let changes = 0;
    const stop = watchConfigUpdates(
      (async function* () {
        yield { type: "session.created" };
        yield { type: "config.updated" };
        yield { type: "model.updated" };
      })(),
      () => {
        changes += 1;
        controller.abort();
      },
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    stop();
    expect(changes).toBe(1);

    const errors: unknown[] = [];
    let failed = false;
    const failedStop = watchConfigUpdates(
      (async function* () {
        yield { type: "session.created" };
        throw new Error("transport lost");
      })(),
      () => undefined,
      new AbortController().signal,
      (error) => {
        failed = true;
        errors.push(error);
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    failedStop();
    expect(failed).toBe(true);
    expect(errors).toHaveLength(1);
  });
});

describe("behaviour projection", () => {
  function projectionConfig(overrides: {
    readonly schema?: string;
    readonly apiKey?: string;
    readonly redactionSecret?: string;
  }): VvocConfig {
    const config = createDefaultVvocConfig();
    return {
      ...config,
      $schema: overrides.schema ?? config.$schema,
      web: {
        search: { provider: "exa", apiKey: overrides.apiKey ?? "k" },
        fetch: { provider: "native", apiKey: overrides.apiKey ?? "k" },
      },
      secretsRedaction: {
        ...config.secretsRedaction,
        secret: overrides.redactionSecret ?? "seed",
      },
    };
  }

  test("strips credential values and version-derived fields", () => {
    const config = projectionConfig({
      schema: "https://cdn.jsdelivr.net/npm/@osovv/vv-opencode@2.1.3/schemas/vvoc/v3.json",
      apiKey: "secret-api-value",
      redactionSecret: "secret-seed-value",
    });
    const sanitized = sanitizePolicyConfig(config);
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("secret-api-value");
    expect(serialized).not.toContain("secret-seed-value");
    expect(serialized).not.toContain("$schema");
    expect(sanitized.web?.search?.apiKey).toBeUndefined();
    expect(sanitized.secretsRedaction.secret).toBeUndefined();
    expect(sanitized.roles).toEqual(config.roles);
    expect(sanitized.plugins).toEqual(config.plugins);
  });

  test("content hash ignores package version and credentials", () => {
    const roles = { ...createDefaultVvocConfig().roles, default: "prov/m1" };
    const agentRoles = { build: "default" };
    const left = buildBehaviourProjection({
      roles,
      agentRoles,
      vvoc: projectionConfig({
        schema: "https://cdn.jsdelivr.net/npm/@osovv/vv-opencode@2.1.3/schemas/vvoc/v3.json",
        apiKey: "left-key",
        redactionSecret: "left-seed",
      }),
    });
    const right = buildBehaviourProjection({
      roles,
      agentRoles,
      vvoc: projectionConfig({
        schema: "https://cdn.jsdelivr.net/npm/@osovv/vv-opencode@9.9.9/schemas/vvoc/v3.json",
        apiKey: "right-key",
        redactionSecret: "right-seed",
      }),
    });
    expect(behaviourContentHash(left)).toBe(behaviourContentHash(right));
  });

  test("content hash tracks behaviour and is deterministic across key order", () => {
    const config = createDefaultVvocConfig();
    const base = buildBehaviourProjection({
      roles: config.roles,
      agentRoles: { build: "default" },
      vvoc: config,
    });
    const reorderedConfig = {
      ...config,
      roles: Object.fromEntries(Object.entries(config.roles).reverse()),
    };
    const reordered = buildBehaviourProjection({
      roles: reorderedConfig.roles,
      agentRoles: { build: "default" },
      vvoc: reorderedConfig,
    });
    const changed = buildBehaviourProjection({
      roles: { ...config.roles, default: "prov/changed" },
      agentRoles: { build: "default" },
      vvoc: config,
    });
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe(canonicalizeJson({ a: 2, b: 1 }));
    expect(behaviourContentHash(reordered)).toBe(behaviourContentHash(base));
    expect(behaviourContentHash(base)).toBe(behaviourContentHash(base));
    expect(behaviourContentHash(changed)).not.toBe(behaviourContentHash(base));
  });
});
