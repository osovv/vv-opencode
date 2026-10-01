// FILE: src/runtime/coordination.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the native app/location-identity coordinator: identity keying (never directory strings or RPC wrappers), shared per-family lock serialization, and shared bookkeeping isolation across distinct hosts/locations.
//   SCOPE: Deterministic pure assertions over in-memory object identities; no real host, network, or client.
//   DEPENDS: [bun:test, src/runtime/coordination.js]
//   LINKS: [M-NATIVE-RUNTIME, V-M-NATIVE-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   delay - Promise delay helper for interleaving assertions.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-009 - Initial coverage for app/location-identity coordination and shared family-lock serialization.]
// END_CHANGE_SUMMARY

import { afterEach, describe, expect, test } from "bun:test";
import {
  coordinationKey,
  coordinateHost,
  nativeObjectId,
  resetCoordinationForTests,
} from "./coordination.js";

afterEach(() => resetCoordinationForTests());

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("coordination identity", () => {
  test("keys on app/location object identity, not directory strings", () => {
    const app = {};
    const locationA = { directory: "/project" };
    const locationB = { directory: "/project" };
    expect(coordinateHost({ app, location: locationA })).toBe(
      coordinateHost({ app, location: locationA }),
    );
    // Same directory string, different location object: never merged.
    expect(coordinateHost({ app, location: locationA })).not.toBe(
      coordinateHost({ app, location: locationB }),
    );
    // Same location object, different app: never merged.
    expect(coordinateHost({ app: {}, location: locationA })).not.toBe(
      coordinateHost({ app: {}, location: locationA }),
    );
    expect(coordinationKey({ location: locationA })).toContain(`loc:${nativeObjectId(locationA)}`);
  });

  test("returns no coordinator without a native object identity", () => {
    expect(coordinateHost({})).toBeUndefined();
    expect(coordinateHost({ location: { directory: "/x" } })).toBeDefined();
  });
});

describe("shared family lock", () => {
  test("serializes work for one family across coordinator consumers", async () => {
    const app = {};
    const location = {};
    const first = coordinateHost({ app, location });
    const second = coordinateHost({ app, location });
    expect(first).toBe(second);
    if (first === undefined) throw new Error("expected coordinator");

    const order: string[] = [];
    const run = (label: string, wait: number) =>
      first.withFamilyLock("fam", async () => {
        order.push(`${label}:start`);
        await delay(wait);
        order.push(`${label}:end`);
      });
    await Promise.all([run("a", 20), run("b", 1)]);
    // The shared lock serializes even though b would finish first if it ran concurrently.
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  test("different families are not serialized against each other", async () => {
    const coordinator = coordinateHost({ app: {}, location: {} });
    if (coordinator === undefined) throw new Error("expected coordinator");
    const order: string[] = [];
    await Promise.all([
      coordinator.withFamilyLock("one", async () => {
        order.push("one:start");
        await delay(15);
        order.push("one:end");
      }),
      coordinator.withFamilyLock("two", async () => {
        order.push("two:start");
        await delay(1);
        order.push("two:end");
      }),
    ]);
    expect(order[0]).toBe("one:start");
    expect(order).toContain("two:end");
    expect(order.indexOf("two:end")).toBeLessThan(order.indexOf("one:end"));
  });

  test("shares bookkeeping across participating contexts", () => {
    const app = {};
    const location = {};
    const a = coordinateHost({ app, location });
    const b = coordinateHost({ app, location });
    if (a === undefined || b === undefined) throw new Error("expected coordinator");
    a.shared.switches.set("ses_1", { providerID: "p", modelID: "m" });
    expect(b.shared.switches.get("ses_1")).toEqual({ providerID: "p", modelID: "m" });
    a.shared.suppressedTitles.add("ses_1");
    expect(b.shared.suppressedTitles.has("ses_1")).toBe(true);
  });
});
