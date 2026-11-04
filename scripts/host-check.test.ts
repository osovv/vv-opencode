// FILE: scripts/host-check.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for the upstream host drift reporter's pure classification and report helpers.
//   SCOPE: Stable-version filtering, newest-stable resolution from dist-tags, support classification, and next-step wording. No network or host download.
//   DEPENDS: bun:test, host-check
//   LINKS: [M-HOST-COMPAT, V-M-HOST-COMPAT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   registry - Minimal registry document fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-HOST-COMPAT-WINDOW T-006 - Added deterministic coverage for the drift report without touching the network.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  classifyHosts,
  formatDriftReport,
  newestStable,
  stableVersions,
} from "./host-check.ts";

const registry = {
  versions: {
    "0.0.0-dev-1": {},
    "1.18.33": {},
    "2.0.18": {},
    "2.2.5": {},
    "2.2.6-rc.1": {},
    "3.0.0": {},
  },
  "dist-tags": { latest: "2.2.5", dev: "0.0.0-dev-1" },
};

describe("stable version filtering", () => {
  test("keeps stable semver releases newest first", () => {
    expect(stableVersions(registry)).toEqual(["3.0.0", "2.2.5", "2.0.18", "1.18.33"]);
  });

  test("prefers the latest dist-tag when it is stable", () => {
    expect(newestStable(registry)).toBe("2.2.5");
    expect(newestStable({ versions: { "2.2.5": {} }, "dist-tags": { latest: "next" } })).toBe(
      "2.2.5",
    );
    expect(newestStable({ versions: {} })).toBeUndefined();
  });
});

describe("drift classification", () => {
  test("classifies verified, tolerated, and unsupported versions", () => {
    expect(classifyHosts(["2.2.5", "2.2.6", "3.0.0", "1.18.33"])).toEqual([
      { version: "2.2.5", support: "verified" },
      { version: "2.2.6", support: "tolerated" },
      { version: "3.0.0", support: "unsupported" },
      { version: "1.18.33", support: "unsupported" },
    ]);
  });

  test("reports the next step for each classification", () => {
    const verified = formatDriftReport(classifyHosts(["2.2.5"]), "2.2.5");
    expect(verified).toContain("newestStable=2.2.5 (verified)");
    expect(verified).toContain("nothing to do");

    const tolerated = formatDriftReport(classifyHosts(["2.2.6"]), "2.2.5");
    expect(tolerated).toContain("bump train");

    const unsupported = formatDriftReport(classifyHosts(["3.0.0"]), "2.2.5");
    expect(unsupported).toContain("migration change");
  });
});
