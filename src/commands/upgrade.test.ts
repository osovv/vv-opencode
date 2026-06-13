// FILE: src/commands/upgrade.test.ts
// VERSION: 0.5.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-UPGRADE - global-only Bun upgrade and fresh subprocess sync.
//   SCOPE: Already-latest handling, registry failures, Bun install execution, post-install sync behavior, jsDelivr changelog output, multi-version changelog display, graceful degradation, and prerelease version resolution.
//   DEPENDS: [src/commands/upgrade.ts]
//   LINKS: [M-CLI-UPGRADE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   runUpgradeFlow tests - Verify the automatic install and sync upgrade flow without real global package mutations.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.6.0 - Added tests for multi-version changelog, graceful degradation, and --allow-prerelease flag.]
// END_CHANGE_SUMMARY

import { expect, test } from "bun:test";
import { runUpgradeFlow } from "./upgrade.js";

test("runUpgradeFlow - reports already-latest without install or sync", async () => {
  const logger = createLoggerCapture();
  const commands: string[][] = [];

  const result = await runUpgradeFlow({
    fetchLatestVersion: async () => "0.14.0",
    fetchChangelog: async () => "should not be used",
    getCurrentVersion: async () => "0.14.0",
    logger,
    runSubprocess: async (command) => {
      commands.push([...command]);
      return { exitCode: 0, stderr: "", stdout: "" };
    },
  });

  expect(result).toEqual({ exitCode: 0, status: "already-latest" });
  expect(commands).toEqual([]);
  expect(logger.logLines.join("\n")).toContain("Already at latest version: 0.14.0");
  expect(logger.warnLines).toEqual([]);
  expect(logger.errorLines).toEqual([]);
});

test("runUpgradeFlow - reports registry failure and exits non-zero", async () => {
  const logger = createLoggerCapture();
  const commands: string[][] = [];

  const result = await runUpgradeFlow({
    fetchLatestVersion: async () => null,
    fetchChangelog: async () => null,
    getCurrentVersion: async () => "0.14.0",
    logger,
    runSubprocess: async (command) => {
      commands.push([...command]);
      return { exitCode: 0, stderr: "", stdout: "" };
    },
  });

  expect(result).toEqual({ exitCode: 1, status: "registry-failed" });
  expect(commands).toEqual([]);
  expect(logger.errorLines.join("\n")).toContain("NETWORK_ERROR: Could not reach npm registry");
});

test("runUpgradeFlow - installs latest package with Bun and runs default global sync", async () => {
  const logger = createLoggerCapture();
  const commands: string[][] = [];

  const result = await runUpgradeFlow({
    fetchLatestVersion: async () => "0.15.0",
    fetchChangelog: async () => "Latest fixes and sync improvements.",
    getCurrentVersion: async () => "0.14.0",
    logger,
    runSubprocess: async (command) => {
      commands.push([...command]);
      if (command[0] === "bun") {
        return { exitCode: 0, stderr: "", stdout: "installed" };
      }

      return {
        exitCode: 0,
        stderr: "",
        stdout: "Updated /home/al/.config/opencode/opencode.json",
      };
    },
  });

  expect(result).toEqual({ exitCode: 0, status: "upgraded" });
  expect(commands).toEqual([
    ["bun", "add", "-g", "@osovv/vv-opencode@0.15.0"],
    ["vvoc", "sync"],
    ["vvoc", "completion"],
  ]);
  expect(logger.logLines.join("\n")).toContain("Latest fixes and sync improvements.");
  expect(logger.logLines.join("\n")).toContain("Global upgrade installed successfully.");
  expect(logger.logLines.join("\n")).toContain("Updated /home/al/.config/opencode/opencode.json");
  expect(logger.warnLines).toEqual([]);
  expect(logger.errorLines).toEqual([]);
});

test("runUpgradeFlow - stops after install failure and does not run sync", async () => {
  const logger = createLoggerCapture();
  const commands: string[][] = [];

  const result = await runUpgradeFlow({
    fetchLatestVersion: async () => "0.15.0",
    fetchChangelog: async () => "Latest fixes and sync improvements.",
    getCurrentVersion: async () => "0.14.0",
    logger,
    runSubprocess: async (command) => {
      commands.push([...command]);
      return {
        exitCode: 1,
        stderr: "bun add failed",
        stdout: "",
      };
    },
  });

  expect(result).toEqual({ exitCode: 1, status: "install-failed" });
  expect(commands).toEqual([["bun", "add", "-g", "@osovv/vv-opencode@0.15.0"]]);
  expect(logger.errorLines.join("\n")).toContain("bun add failed");
  expect(logger.errorLines.join("\n")).toContain("Upgrade install failed.");
});

test("runUpgradeFlow - keeps secret-like changelog text intact", async () => {
  const logger = createLoggerCapture();
  const commands: string[][] = [];
  const changelog = `Token fixture: ${[
    "__VVOC",
    "SECRET",
    "BEARER",
    "TOKEN",
    "1374aea45684__",
  ].join("_")}`;

  const result = await runUpgradeFlow({
    fetchLatestVersion: async () => "0.15.0",
    fetchChangelog: async () => changelog,
    getCurrentVersion: async () => "0.14.0",
    logger,
    runSubprocess: async (command) => {
      commands.push([...command]);
      return { exitCode: 0, stderr: "", stdout: "ok" };
    },
  });

  expect(result).toEqual({ exitCode: 0, status: "upgraded" });
  expect(commands).toEqual([
    ["bun", "add", "-g", "@osovv/vv-opencode@0.15.0"],
    ["vvoc", "sync"],
    ["vvoc", "completion"],
  ]);
  expect(logger.logLines.join("\n")).toContain(changelog);
  expect(logger.logLines.join("\n")).toContain(changelog);
});

test("runUpgradeFlow - warns when post-install sync fails but keeps upgrade successful", async () => {
  const logger = createLoggerCapture();
  const commands: string[][] = [];
  let callCount = 0;

  const result = await runUpgradeFlow({
    fetchLatestVersion: async () => "0.15.0",
    fetchChangelog: async () => null,
    getCurrentVersion: async () => "0.14.0",
    logger,
    runSubprocess: async (command) => {
      commands.push([...command]);
      callCount += 1;
      return callCount === 1
        ? { exitCode: 0, stderr: "", stdout: "installed" }
        : { exitCode: 1, stderr: "sync failed", stdout: "" };
    },
  });

  expect(result).toEqual({ exitCode: 0, status: "sync-warning" });
  expect(commands).toEqual([
    ["bun", "add", "-g", "@osovv/vv-opencode@0.15.0"],
    ["vvoc", "sync"],
  ]);
  expect(logger.warnLines.join("\n")).toContain("sync failed");
  expect(logger.warnLines.join("\n")).toContain("Run `vvoc sync` manually");
});

test("runUpgradeFlow - displays multi-version changelog between current and latest", async () => {
  const logger = createLoggerCapture();
  const commands: string[][] = [];
  const changelog = `## [0.15.0] - 2026-06-13

### Features
* feat(test): mock feature

### Bug Fixes
* fix(test): mock fix

## [0.14.5] - 2026-06-12

### Documentation
* docs(test): mock docs
`;
  const result = await runUpgradeFlow({
    fetchLatestVersion: async () => "0.15.0",
    fetchChangelog: async () => changelog,
    getCurrentVersion: async () => "0.14.4",
    logger,
    runSubprocess: async (command) => {
      commands.push([...command]);
      return { exitCode: 0, stderr: "", stdout: "ok" };
    },
  });
  expect(result.status).toBe("upgraded");
  expect(logger.logLines.some((line) => line.includes("0.14.5"))).toBe(true);
  expect(logger.logLines.some((line) => line.includes("0.15.0"))).toBe(true);
  expect(logger.logLines.join("\n")).toContain("mock feature");
  expect(logger.logLines.join("\n")).toContain("mock docs");
});

test("runUpgradeFlow - proceeds without changelog when fetch returns null", async () => {
  const logger = createLoggerCapture();
  const result = await runUpgradeFlow({
    fetchLatestVersion: async () => "0.36.0",
    fetchChangelog: async () => null,
    getCurrentVersion: async () => "0.35.10",
    logger,
    runSubprocess: async () => ({ exitCode: 0, stderr: "", stdout: "ok" }),
  });
  expect(result.exitCode).toBe(0);
  expect(result.status).toBe("upgraded");
  expect(logger.logLines.join("\n")).not.toContain("--- Changelog ---");
});

test("runUpgradeFlow - resolves prerelease version with allowPrerelease option", async () => {
  const logger = createLoggerCapture();
  const commands: string[][] = [];
  const result = await runUpgradeFlow(
    {
      getCurrentVersion: async () => "0.35.10",
      fetchLatestVersion: async () => "0.36.0-beta.1",
      fetchChangelog: async () => null,
      logger,
      runSubprocess: async (command) => {
        commands.push([...command]);
        return { exitCode: 0, stderr: "", stdout: "ok" };
      },
    },
    { allowPrerelease: true },
  );
  expect(result.status).toBe("upgraded");
  expect(commands[0]?.[3]).toContain("0.36.0-beta.1");
});
function createLoggerCapture(): {
  error: (message: string) => void;
  errorLines: string[];
  log: (message: string) => void;
  logLines: string[];
  warn: (message: string) => void;
  warnLines: string[];
} {
  const logLines: string[] = [];
  const warnLines: string[] = [];
  const errorLines: string[] = [];

  return {
    error: (message: string) => {
      errorLines.push(message);
    },
    errorLines,
    log: (message: string) => {
      logLines.push(message);
    },
    logLines,
    warn: (message: string) => {
      warnLines.push(message);
    },
    warnLines,
  };
}
