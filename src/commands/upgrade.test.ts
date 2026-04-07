// FILE: src/commands/upgrade.test.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-UPGRADE - npm version checking and upgrade.
//   SCOPE: Version comparison, changelog fetching, and network error handling.
//   DEPENDS: [src/commands/upgrade.ts]
//   LINKS: [M-CLI-UPGRADE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Test suite for upgrade command.
// END_MODULE_MAP

import { expect, test } from "bun:test";
import { printUpgradeStatus } from "./upgrade.js";

test("printUpgradeStatus - shows update available", () => {
  const output = captureStdout(() => printUpgradeStatus("1.0.0", "2.0.0"));
  expect(output).toContain("Update available");
  expect(output).toContain("1.0.0");
  expect(output).toContain("2.0.0");
});

test("printUpgradeStatus - shows update available", () => {
  const output = captureStdout(() => printUpgradeStatus("1.0.0", "2.0.0"));
  expect(output).toContain("Update available");
  expect(output).toContain("1.0.0");
  expect(output).toContain("2.0.0");
});

test("printUpgradeStatus - shows already latest", () => {
  const output = captureStdout(() => printUpgradeStatus("1.0.0", "1.0.0"));
  expect(output).toContain("Already at latest version");
  expect(output).toContain("1.0.0");
});

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map((a) => String(a)).join(" ") + "\n");
  };
  try {
    fn();
  } finally {
    console.log = originalConsoleLog;
  }
  return chunks.join("");
}
