// FILE: scripts/release-deprecate.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify superseded-version selection and npm output parsing for the release deprecation helper.
//   SCOPE: Pure parsing, selection, and message assertions only; no npm, git, or network access.
//   DEPENDS: [bun:test, scripts/release-deprecate.ts]
//   LINKS: [M-RELEASE-AUTOMATION, V-M-RELEASE-AUTOMATION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SAMPLE_VERSIONS - Mixed v1, stable v2, and v2 prerelease versions used by the selection tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial coverage for superseded v2 selection and npm output parsing.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  buildDeprecationMessage,
  compareStableVersions,
  parseDistTags,
  parseVersionList,
  selectSupersededVersions,
} from "./release-deprecate.ts";

const SAMPLE_VERSIONS = ["1.7.0", "2.0.0", "2.0.1", "2.1.0", "2.1.1", "2.1.2", "2.2.0-rc.1"];

describe("release deprecate selection", () => {
  test("selects every stable v2 below the kept latest", () => {
    expect(selectSupersededVersions(SAMPLE_VERSIONS, "2.1.2")).toEqual([
      "2.0.0",
      "2.0.1",
      "2.1.0",
      "2.1.1",
    ]);
  });

  test("keeps only versions below an explicit keep", () => {
    expect(selectSupersededVersions(SAMPLE_VERSIONS, "2.1.0")).toEqual(["2.0.0", "2.0.1"]);
  });

  test("ignores v1 releases and v2 prereleases", () => {
    const selected = selectSupersededVersions(
      ["1.7.0", "2.1.0", "2.1.1", "2.1.2", "2.2.0-rc.1"],
      "2.1.2",
    );
    expect(selected).toEqual(["2.1.0", "2.1.1"]);
  });

  test("returns nothing when only the kept release remains", () => {
    expect(selectSupersededVersions(["2.1.2"], "2.1.2")).toEqual([]);
  });

  test("compares stable versions numerically, not lexically", () => {
    expect(compareStableVersions("2.10.0", "2.9.0")).toBeGreaterThan(0);
    expect(compareStableVersions("2.0.10", "2.0.9")).toBeGreaterThan(0);
    expect(compareStableVersions("2.1.2", "2.1.2")).toBe(0);
  });
});

describe("npm output parsing", () => {
  test("parses a version array and a single-version string", () => {
    expect(parseVersionList('["2.0.0","2.1.0"]')).toEqual(["2.0.0", "2.1.0"]);
    expect(parseVersionList('"2.1.2"')).toEqual(["2.1.2"]);
  });

  test("parses a dist-tag map", () => {
    expect(parseDistTags('{"latest":"2.1.2","rc":"1.4.3-rc.1"}')).toEqual({
      latest: "2.1.2",
      rc: "1.4.3-rc.1",
    });
  });

  test("rejects malformed npm output", () => {
    expect(() => parseDistTags("[]")).toThrow();
    expect(() => parseVersionList("42")).toThrow();
  });
});

describe("deprecation message", () => {
  test("points at the kept release", () => {
    const message = buildDeprecationMessage("2.1.2");
    expect(message).toContain("@osovv/vv-opencode@2.1.2");
    expect(message).toContain("releases/tag/v2.1.2");
  });
});
