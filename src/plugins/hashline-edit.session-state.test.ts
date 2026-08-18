// FILE: src/plugins/hashline-edit.session-state.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify session model cache and session file cache behavior used by edit-mode routing.
//   SCOPE: Model cache set/get/delete, file cache unread/fresh/drifted verdicts, and per-session isolation.
//   DEPENDS: [bun:test, src/plugins/hashline-edit/session-state.ts]
//   LINKS: [M-PLUGIN-HASHLINE-EDIT, V-M-PLUGIN-HASHLINE-EDIT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   [test scenarios] - Session state coverage is expressed through module-level tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Initial session state coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { SessionFileCache, SessionModelCache } from "./hashline-edit/session-state.js";

describe("session model cache", () => {
  test("stores and returns model info per session", () => {
    const cache = new SessionModelCache();
    cache.set("ses_1", { providerID: "deepseek", modelID: "deepseek-v4-flash" });
    cache.set("ses_2", { providerID: "moonshotai", modelID: "kimi-k3" });

    expect(cache.get("ses_1")).toEqual({ providerID: "deepseek", modelID: "deepseek-v4-flash" });
    expect(cache.get("ses_2")).toEqual({ providerID: "moonshotai", modelID: "kimi-k3" });
    expect(cache.get("ses_missing")).toBeUndefined();
  });

  test("overwrites on re-set and removes on delete", () => {
    const cache = new SessionModelCache();
    cache.set("ses_1", { providerID: "deepseek", modelID: "deepseek-v4-flash" });
    cache.set("ses_1", { providerID: "openai", modelID: "gpt-5.4" });
    expect(cache.get("ses_1")).toEqual({ providerID: "openai", modelID: "gpt-5.4" });

    cache.delete("ses_1");
    expect(cache.get("ses_1")).toBeUndefined();
  });
});

describe("session file cache", () => {
  test("reports unread for files never recorded in the session", () => {
    const cache = new SessionFileCache();
    expect(cache.check("ses_1", "/tmp/a.ts", { mtimeMs: 1, size: 2 })).toBe("unread");
  });

  test("reports fresh when mtime and size match the recorded snapshot", () => {
    const cache = new SessionFileCache();
    cache.record("ses_1", "/tmp/a.ts", { mtimeMs: 100, size: 42 });
    expect(cache.check("ses_1", "/tmp/a.ts", { mtimeMs: 100, size: 42 })).toBe("fresh");
  });

  test("reports drifted when mtime or size changed or the file vanished", () => {
    const cache = new SessionFileCache();
    cache.record("ses_1", "/tmp/a.ts", { mtimeMs: 100, size: 42 });
    expect(cache.check("ses_1", "/tmp/a.ts", { mtimeMs: 101, size: 42 })).toBe("drifted");
    expect(cache.check("ses_1", "/tmp/a.ts", { mtimeMs: 100, size: 43 })).toBe("drifted");
    expect(cache.check("ses_1", "/tmp/a.ts", undefined)).toBe("drifted");
  });

  test("isolates sessions and paths from each other", () => {
    const cache = new SessionFileCache();
    cache.record("ses_1", "/tmp/a.ts", { mtimeMs: 100, size: 42 });
    expect(cache.check("ses_2", "/tmp/a.ts", { mtimeMs: 100, size: 42 })).toBe("unread");
    expect(cache.check("ses_1", "/tmp/b.ts", { mtimeMs: 100, size: 42 })).toBe("unread");

    cache.forget("ses_1", "/tmp/a.ts");
    expect(cache.check("ses_1", "/tmp/a.ts", { mtimeMs: 100, size: 42 })).toBe("unread");
  });
});
