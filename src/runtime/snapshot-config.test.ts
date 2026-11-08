// FILE: src/runtime/snapshot-config.test.ts
// VERSION: 3.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify effective-config extraction, role/agent binding parsing, canonical selection normalization, and native event decoding.
//   SCOPE: vvoc snapshot policy derivation, invalid-binding failure, canonical variant handling, and session-creation/model-selection/config-update decoding; no native host.
//   DEPENDS: [bun:test, src/lib/config-layers.js, src/lib/vvoc-config.js, src/runtime/snapshot-config.js, src/runtime/types.js]
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
//   LAST_CHANGE: [C-SESSION-OWNED-SETTINGS T-002 - Coverage narrowed to the surviving extraction, parsing, and event-decoding helpers.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { VvocConfigSnapshot } from "../lib/config-layers.js";
import { createDefaultVvocConfig } from "../lib/vvoc-config.js";
import {
  agentBindingsFrom,
  agentPolicyBindings,
  canonicalModelVariant,
  decodeModelSelectedEvent,
  decodeSessionCreatedEvent,
  effectiveRuntimeConfig,
  isConfigUpdateEvent,
  normalizeModelSelection,
  parseRoleSelections,
} from "./snapshot-config.js";

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

  test("parses role selections and fails loudly on an invalid binding", () => {
    expect(parseRoleSelections({ smart: "prov/m2#xhigh" })).toEqual({
      smart: { providerID: "prov", modelID: "m2", variant: "xhigh" },
    });
    expect(() => parseRoleSelections({ smart: "nope" })).toThrow(/invalid model binding/);
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

describe("canonical selection normalization", () => {
  test("the native absent/`default` variant is not a distinct selection", () => {
    expect(canonicalModelVariant(undefined)).toBeUndefined();
    expect(canonicalModelVariant("default")).toBeUndefined();
    expect(canonicalModelVariant("thinking")).toBe("thinking");
    expect(
      normalizeModelSelection({ providerID: "prov", modelID: "m1", variant: "default" }),
    ).toEqual({ providerID: "prov", modelID: "m1" });
  });
});

describe("event decoding", () => {
  test("session.created decodes the creation model", () => {
    expect(
      decodeSessionCreatedEvent({
        type: "session.created",
        data: { sessionID: "ses_1", model: { id: "m1", providerID: "prov", variant: "default" } },
      }),
    ).toEqual({ sessionID: "ses_1", model: { providerID: "prov", modelID: "m1" } });
    expect(decodeSessionCreatedEvent({ type: "session.deleted" })).toBeUndefined();
    expect(
      decodeSessionCreatedEvent({ type: "session.created", data: { sessionID: "ses_1" } }),
    ).toEqual({ sessionID: "ses_1" });
    expect(
      decodeSessionCreatedEvent({ type: "session.created", data: { sessionID: 42 } }),
    ).toBeUndefined();
  });

  test("model.selected decodes explicit switches only", () => {
    expect(
      decodeModelSelectedEvent({
        type: "session.model.selected",
        data: { sessionID: "ses_1", model: { id: "m2", providerID: "prov" } },
      }),
    ).toEqual({ sessionID: "ses_1", model: { providerID: "prov", modelID: "m2" } });
    expect(
      decodeModelSelectedEvent({ type: "session.model.selected", data: { sessionID: "ses_1" } }),
    ).toBeUndefined();
  });

  test("only config.updated invalidates the cached effective config", () => {
    expect(isConfigUpdateEvent({ type: "config.updated" })).toBe(true);
    expect(isConfigUpdateEvent({ type: "model.updated" })).toBe(false);
    expect(isConfigUpdateEvent({ type: "agent.updated" })).toBe(false);
  });
});
