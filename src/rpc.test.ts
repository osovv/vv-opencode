// FILE: src/rpc.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Test the versioned GUI RPC contract: identity, portable method surface, strict reply-decoder acceptance and rejection, and the bounded DTO shapes both sides depend on.
//   SCOPE: Pure contract assertions over src/rpc.ts; no server runtime, no window code, no I/O.
//   DEPENDS: [src/rpc.ts]
//   LINKS: [M-GUI-SPIKE, V-M-PLUGIN-GUI-SETTINGS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   AVAILABLE_DEFAULTS_REPLY - Valid available defaults.get reply fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [GUI-SPike initial skeleton - Added contract identity, decoder acceptance/rejection, and bounded-DTO tests for the GUI RPC surface.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  VVOC_GUI_METHODS,
  VVOC_GUI_RPC_ID,
  VVOC_GUI_RPC_VERSION,
  decodeDefaultsGetOutput,
  decodeDefaultsSetOutput,
  decodeSessionGetOutput,
  decodeSessionPatchOutput,
  vvocGuiRpc,
} from "./rpc.js";

const AVAILABLE_DEFAULTS_REPLY = {
  version: 1,
  status: "available",
  profile: "balanced",
  plugins: { guardian: true, analytics: false, peakHours: true },
  source: { kind: "project", path: "/tmp/.vvoc/vvoc.json" },
} as const;

describe("gui rpc contract", () => {
  test("exposes the stable versioned identity and method surface", () => {
    expect(VVOC_GUI_RPC_ID).toBe("vvoc.gui.v1");
    expect(VVOC_GUI_RPC_VERSION).toBe(1);
    expect(vvocGuiRpc.id).toBe(VVOC_GUI_RPC_ID);
    expect(Object.keys(vvocGuiRpc.methods)).toEqual([
      "defaults.get",
      "defaults.set",
      "session.get",
      "session.patch",
    ]);
    expect(vvocGuiRpc.events).toEqual({});
  });

  test("decodes an available defaults.get reply and keeps the bounded projection", () => {
    const decoded = decodeDefaultsGetOutput(AVAILABLE_DEFAULTS_REPLY);
    expect(decoded.status).toBe("available");
    expect(decoded.profile).toBe("balanced");
    expect(decoded.plugins).toEqual({ guardian: true, analytics: false, peakHours: true });
    expect(decoded.source?.kind).toBe("project");
    expect(decoded.error).toBeUndefined();
  });

  test("decodes an unavailable defaults.get verdict without profile data", () => {
    const decoded = decodeDefaultsGetOutput({
      version: 1,
      status: "unavailable",
      error: "config_unavailable",
    });
    expect(decoded.status).toBe("unavailable");
    expect(decoded.profile).toBeUndefined();
    expect(decoded.source).toBeUndefined();
  });

  test("rejects wrong version, unknown status, and unknown error codes", () => {
    expect(() =>
      decodeDefaultsGetOutput({ version: 2, status: "available", profile: "balanced" }),
    ).toThrow();
    expect(() => decodeDefaultsGetOutput({ version: 1, status: "maybe" })).toThrow();
    expect(() =>
      decodeDefaultsGetOutput({ version: 1, status: "unavailable", error: "something_else" }),
    ).toThrow();
  });

  test("strips keys outside the bounded projection", () => {
    const decoded = decodeDefaultsGetOutput({
      version: 1,
      status: "available",
      profile: "balanced",
      extra: true,
      plugins: { guardian: true, analytics: true, peakHours: true, smuggled: "x" },
    });
    expect(decoded).not.toHaveProperty("extra");
    expect(decoded.plugins).toEqual({ guardian: true, analytics: true, peakHours: true });
  });

  test("validates the defaults.set write verdict surface", () => {
    const updated = decodeDefaultsSetOutput({
      version: 1,
      action: "updated",
      profile: "delegated",
      path: "/p",
    });
    expect(updated.action).toBe("updated");
    expect(updated.profile).toBe("delegated");
    expect(updated.path).toBe("/p");
    const unavailable = decodeDefaultsSetOutput({
      version: 1,
      action: "unavailable",
      profile: "balanced",
    });
    expect(unavailable.action).toBe("unavailable");
    expect(unavailable.error).toBeUndefined();
    expect(unavailable.path).toBeUndefined();
    expect(() =>
      decodeDefaultsSetOutput({ version: 1, action: "exploded", profile: "balanced" }),
    ).toThrow();
    expect(() =>
      decodeDefaultsSetOutput({ version: 1, action: "updated", profile: "nope" }),
    ).toThrow();
  });

  test("validates the session stub and unsupported verdict surfaces", () => {
    const stub = decodeSessionGetOutput({
      version: 1,
      status: "stub",
      profile: "orchestrated",
      note: "stub note",
    });
    expect(stub.status).toBe("stub");
    expect(stub.note).toBe("stub note");
    expect(() => decodeSessionGetOutput({ version: 1, status: "complete", note: "x" })).toThrow();

    const unsupported = decodeSessionPatchOutput({
      version: 1,
      status: "unsupported",
      error: "session_settings_unsupported",
    });
    expect(unsupported.status).toBe("unsupported");
    expect(() =>
      decodeSessionPatchOutput({ version: 1, status: "unsupported", error: "write_rejected" }),
    ).toThrow();
  });

  test("keeps the method-name map in sync with the definition", () => {
    expect(Object.keys(vvocGuiRpc.methods)).toEqual(Object.values(VVOC_GUI_METHODS));
  });
});
