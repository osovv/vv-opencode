// FILE: src/plugins/v2-runtime/location-config.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify per-location config resolution: TTL caching, invalidation, session mapping, and fail-closed behavior.
//   SCOPE: Unit tests for createLocationResolver with an injected loader, logger, and controllable clock only.
//   DEPENDS: [src/plugins/v2-runtime/location-config.ts]
//   LINKS: [V-M-PLUGIN-V2-RUNTIME, M-PLUGIN-V2-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   makeResolver - Builds a resolver with an injectable loader, warning log, and stepping clock.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-002 - Added the per-location resolver test suite.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { createLocationResolver, type LocationConfigSnapshot } from "./location-config.js";
import { createDefaultVvocConfig } from "../../lib/vvoc-config.js";

function makeResolver(overrides?: { loadError?: Error }) {
  let clock = 1_000;
  let loadCount = 0;
  const warnings: string[] = [];
  const resolver = createLocationResolver({
    ttlMs: 100,
    now: () => clock,
    warn: (message) => warnings.push(message),
    loadForDirectory: async () => {
      loadCount += 1;
      if (overrides?.loadError) throw overrides.loadError;
      return {
        config: createDefaultVvocConfig(),
        source: { kind: "project", path: "/tmp/x/.vvoc/vvoc.json" },
        warnings: [],
      };
    },
  });
  return {
    resolver,
    warnings,
    get loadCount() {
      return loadCount;
    },
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("createLocationResolver.forDirectory", () => {
  test("caches a successful load within the TTL", async () => {
    const h = makeResolver();
    const first = await h.resolver.forDirectory("/tmp/proj-a");
    const second = await h.resolver.forDirectory("/tmp/proj-a");

    expect(h.loadCount).toBe(1);
    expect(first?.directory).toBe("/tmp/proj-a");
    expect(second).toBe(first);
    expect(h.warnings).toEqual([]);
  });

  test("reloads after the TTL expires", async () => {
    const h = makeResolver();
    await h.resolver.forDirectory("/tmp/proj-a");
    h.advance(101);
    await h.resolver.forDirectory("/tmp/proj-a");

    expect(h.loadCount).toBe(2);
  });

  test("invalidate forces an immediate reload", async () => {
    const h = makeResolver();
    await h.resolver.forDirectory("/tmp/proj-a");
    h.resolver.invalidate("/tmp/proj-a");
    await h.resolver.forDirectory("/tmp/proj-a");

    expect(h.loadCount).toBe(2);
    expect(h.resolver.cachedDirectories).toEqual(["/tmp/proj-a"]);
  });

  test("separates caches per directory", async () => {
    const h = makeResolver();
    await h.resolver.forDirectory("/tmp/proj-a");
    await h.resolver.forDirectory("/tmp/proj-b");

    expect(h.loadCount).toBe(2);
    expect([...h.resolver.cachedDirectories].sort()).toEqual(["/tmp/proj-a", "/tmp/proj-b"]);
  });

  test("fails closed with a warning when loading throws, and caches the failure", async () => {
    const h = makeResolver({ loadError: new Error("broken config") });
    const first = await h.resolver.forDirectory("/tmp/proj-bad");
    const second = await h.resolver.forDirectory("/tmp/proj-bad");

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(h.loadCount).toBe(1);
    expect(h.warnings.length).toBe(1);
    expect(h.warnings[0]).toContain("broken config");
  });
});

describe("createLocationResolver.forSession", () => {
  test("resolves through the session location directory", async () => {
    const h = makeResolver();
    const snapshot: LocationConfigSnapshot | undefined = await h.resolver.forSession(
      "s-1",
      async () => ({
        location: { directory: "/tmp/proj-a" },
      }),
    );

    expect(snapshot?.directory).toBe("/tmp/proj-a");
    expect(h.warnings).toEqual([]);
  });

  test("fails closed when the session has no location directory", async () => {
    const h = makeResolver();
    const snapshot = await h.resolver.forSession("s-2", async () => ({ location: {} }));

    expect(snapshot).toBeUndefined();
    expect(h.warnings.length).toBe(1);
    expect(h.warnings[0]).toContain("s-2");
  });

  test("fails closed when the session lookup throws", async () => {
    const h = makeResolver();
    const snapshot = await h.resolver.forSession("s-3", async () => {
      throw new Error("server unavailable");
    });

    expect(snapshot).toBeUndefined();
    expect(h.warnings.length).toBe(1);
    expect(h.warnings[0]).toContain("server unavailable");
  });
});
