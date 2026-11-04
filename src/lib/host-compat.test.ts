// FILE: src/lib/host-compat.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for the supported and verified native OpenCode host window.
//   SCOPE: Window bounds, prerelease refusal, verified-list classification, and the shipped hosts.json shape.
//   DEPENDS: bun:test, host-compat
//   LINKS: [M-HOST-COMPAT, V-M-HOST-COMPAT]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   parse - Shorthand for parseOpenCodeVersion.
//   compareDesc - Newest-first comparator used by the sorted-list assertion.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-HOST-COMPAT-WINDOW T-001 - Added regression coverage for the major-bounded window, prerelease refusal, and verified/tolerated/unsupported classification.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import hosts from "../hosts.json" with { type: "json" };
import {
  isSupportedOpenCodeVersion,
  isVerifiedOpenCodeVersion,
  MAX_SUPPORTED_OPENCODE_VERSION_EXCLUSIVE,
  MIN_SUPPORTED_OPENCODE_VERSION,
  openCodeHostSupport,
  parseOpenCodeVersion,
  SUPPORTED_OPENCODE_VERSION_RANGE,
  VERIFIED_HOST_VERSION,
  VERIFIED_HOST_VERSIONS,
} from "./host-compat.js";

const parse = parseOpenCodeVersion;

describe("supported host window", () => {
  test("is major-bounded and starts at the documented floor", () => {
    expect(MIN_SUPPORTED_OPENCODE_VERSION).toBe("2.0.18");
    expect(MAX_SUPPORTED_OPENCODE_VERSION_EXCLUSIVE).toBe("3.0.0");
    expect(SUPPORTED_OPENCODE_VERSION_RANGE).toBe(">=2.0.18 <3.0.0");
  });

  test("accepts every stable host inside the window", () => {
    for (const version of ["2.0.18", "v2.1.0", "2.2.5", "2.2.6", "2.9.99", "2.0.18+build.5"]) {
      expect(isSupportedOpenCodeVersion(version)).toBe(true);
    }
  });

  test("refuses older, next-major, prerelease, and malformed versions", () => {
    for (const version of [
      "2.0.17",
      "1.18.33",
      "3.0.0",
      "3.0.0-rc.1",
      "2.0.18-beta.1",
      "latest",
      "",
    ]) {
      expect(isSupportedOpenCodeVersion(version)).toBe(false);
    }
  });

  test("parses stable versions only", () => {
    expect(parse("v2.2.5")).toEqual([2, 2, 5]);
    expect(parse(" 2.0.18 ")).toEqual([2, 0, 18]);
    expect(parse("2.2.5-rc.1")).toBeUndefined();
    expect(parse("nope")).toBeUndefined();
  });
});

describe("verified host list", () => {
  test("ships a non-empty sorted evidence list", () => {
    expect(VERIFIED_HOST_VERSIONS.length).toBeGreaterThan(0);
    expect(VERIFIED_HOST_VERSIONS).toEqual([...VERIFIED_HOST_VERSIONS].sort(compareDesc));
    expect(VERIFIED_HOST_VERSIONS[0]).toBe(VERIFIED_HOST_VERSION);
  });

  test("classifies verified, tolerated, and unsupported hosts", () => {
    expect(openCodeHostSupport(VERIFIED_HOST_VERSION)).toBe("verified");
    expect(openCodeHostSupport("2.2.6")).toBe("tolerated");
    expect(openCodeHostSupport("3.0.0")).toBe("unsupported");
    expect(openCodeHostSupport("1.18.33")).toBe("unsupported");
    expect(isVerifiedOpenCodeVersion(`v${VERIFIED_HOST_VERSION}`)).toBe(true);
  });

  test("hosts.json records the verified versions it ships", () => {
    expect(Array.isArray(hosts.verified)).toBe(true);
    expect(hosts.verified.length).toBeGreaterThan(0);
    for (const version of hosts.verified) {
      expect(typeof version).toBe("string");
      expect(parse(version)).toBeDefined();
    }
  });
});

function compareDesc(left: string, right: string): number {
  const a = parse(left);
  const b = parse(right);
  if (a === undefined || b === undefined) return 0;
  return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
}
