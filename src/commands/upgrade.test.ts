// FILE: src/commands/upgrade.test.ts
// VERSION: 0.5.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-UPGRADE - global-only Bun upgrade, fresh subprocess sync, and partial-upgrade warnings.
//   SCOPE: Already-latest handling, registry failures, Bun install execution, post-install sync behavior, partial sync-warning messaging, jsDelivr changelog output, multi-version changelog display, graceful degradation, and prerelease version resolution.
//   DEPENDS: [src/commands/upgrade.ts]
//   LINKS: [M-CLI-UPGRADE, V-M-CLI-UPGRADE]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   createLoggerCapture - Captures upgrade flow messages for assertions.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-RELEASE-RC-CHANNEL - Covered rc dist-tag resolution, no-candidate degradation, flag semantics, and default-path isolation.]
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
  expect(logger.warnLines.join("\n")).toContain("Upgrade partial");
  expect(logger.warnLines.join("\n")).toContain("Fix vvoc.json manually, then run `vvoc sync`.");
});

test("runUpgradeFlow - warns partial upgrade when post-install sync launch throws", async () => {
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
      if (callCount === 1) {
        return { exitCode: 0, stderr: "", stdout: "installed" };
      }
      throw new Error("sync launch failed");
    },
  });

  expect(result).toEqual({ exitCode: 0, status: "sync-warning" });
  expect(commands).toEqual([
    ["bun", "add", "-g", "@osovv/vv-opencode@0.15.0"],
    ["vvoc", "sync"],
  ]);
  expect(logger.warnLines.join("\n")).toContain("sync launch failed");
  expect(logger.warnLines.join("\n")).toContain("Upgrade partial");
  expect(logger.warnLines.join("\n")).toContain("Fix vvoc.json manually, then run `vvoc sync`.");
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

test("runUpgradeFlow - resolves the rc dist-tag version with allowPrerelease option", async () => {
  const logger = createLoggerCapture();
  const commands: string[][] = [];
  const result = await runUpgradeFlow(
    {
      getCurrentVersion: async () => "0.35.10",
      fetchLatestVersion: async () => "0.35.10",
      fetchRcDistTagVersion: async () => "0.36.0-rc.1",
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
  expect(commands[0]?.[3]).toContain("0.36.0-rc.1");
  expect(logger.logLines.join("\n")).toContain("Latest release candidate: 0.36.0-rc.1");
});

test("runUpgradeFlow - rc channel upgrade ignores the latest dist-tag resolution", async () => {
  const logger = createLoggerCapture();
  const commands: string[][] = [];
  const result = await runUpgradeFlow(
    {
      getCurrentVersion: async () => "0.35.10",
      fetchLatestVersion: async () => "1.0.0",
      fetchRcDistTagVersion: async () => "0.36.0-rc.1",
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
  expect(commands[0]?.[3]).toContain("0.36.0-rc.1");
  expect(commands[0]?.[3]).not.toContain("1.0.0");
});

test("runUpgradeFlow - reports no-rc-candidate when the rc dist-tag is absent", async () => {
  const logger = createLoggerCapture();
  const commands: string[][] = [];
  const result = await runUpgradeFlow(
    {
      getCurrentVersion: async () => "0.35.10",
      fetchLatestVersion: async () => "0.36.0",
      fetchRcDistTagVersion: async () => null,
      fetchChangelog: async () => null,
      logger,
      runSubprocess: async (command) => {
        commands.push([...command]);
        return { exitCode: 0, stderr: "", stdout: "ok" };
      },
    },
    { allowPrerelease: true },
  );
  expect(result).toEqual({ exitCode: 0, status: "no-rc-candidate" });
  expect(commands).toEqual([]);
  expect(logger.logLines.join("\n")).toContain("no release candidate on the rc channel");
  expect(logger.errorLines).toEqual([]);
});

test("runUpgradeFlow - reports already-latest on rc channel when the candidate is not newer", async () => {
  const logger = createLoggerCapture();
  const commands: string[][] = [];
  const result = await runUpgradeFlow(
    {
      getCurrentVersion: async () => "0.36.0-rc.1",
      fetchLatestVersion: async () => "0.35.10",
      fetchRcDistTagVersion: async () => "0.36.0-rc.1",
      fetchChangelog: async () => null,
      logger,
      runSubprocess: async (command) => {
        commands.push([...command]);
        return { exitCode: 0, stderr: "", stdout: "ok" };
      },
    },
    { allowPrerelease: true },
  );
  expect(result).toEqual({ exitCode: 0, status: "already-latest" });
  expect(commands).toEqual([]);
  expect(logger.logLines.join("\n")).toContain("Already at release candidate version: 0.36.0-rc.1");
});

test("runUpgradeFlow - default resolution never consults the rc channel", async () => {
  const logger = createLoggerCapture();
  const commands: string[][] = [];
  let rcConsulted = false;
  const result = await runUpgradeFlow({
    getCurrentVersion: async () => "0.35.10",
    fetchLatestVersion: async () => "0.36.0",
    fetchRcDistTagVersion: async () => {
      rcConsulted = true;
      return "0.37.0-rc.1";
    },
    fetchChangelog: async () => null,
    logger,
    runSubprocess: async (command) => {
      commands.push([...command]);
      return { exitCode: 0, stderr: "", stdout: "ok" };
    },
  });
  expect(result.status).toBe("upgraded");
  expect(rcConsulted).toBe(false);
  expect(commands[0]?.[3]).toContain("0.36.0");
});

test("runUpgradeFlow - default upgrade off a candidate uses the latest dist-tag", async () => {
  const logger = createLoggerCapture();
  const commands: string[][] = [];
  const result = await runUpgradeFlow({
    getCurrentVersion: async () => "0.36.0-rc.1",
    fetchLatestVersion: async () => "0.36.0",
    fetchRcDistTagVersion: async () => "0.36.0-rc.1",
    fetchChangelog: async () => null,
    logger,
    runSubprocess: async (command) => {
      commands.push([...command]);
      return { exitCode: 0, stderr: "", stdout: "ok" };
    },
  });
  expect(result.status).toBe("upgraded");
  expect(commands[0]?.[3]).toContain("0.36.0");
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
