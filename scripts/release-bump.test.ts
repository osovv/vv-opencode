// FILE: scripts/release-bump.test.ts
// VERSION: 1.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify exact-SHA CI publication is awaited before authenticated local tag and GitHub Release finalization.
//   SCOPE: Pure command-runner capture for workflow dispatch/finalization, run URL parsing, changelog extraction, and static workflow ordering assertions; no git, GitHub, or npm mutations.
//   DEPENDS: [bun:test, node:fs, scripts/release-bump.ts, .github/workflows/publish.yml]
//   LINKS: [M-RELEASE-AUTOMATION, V-M-RELEASE-AUTOMATION, VF-RELEASE-AUTOMATION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   dispatch regression tests - Protect branch-only push and exact-SHA workflow dispatch semantics.
//   workflow run parsing tests - Protect deterministic gh run watch targeting.
//   workflow wait tests - Protect exact run watching with failure propagation.
//   finalization tests - Protect npm gitHead verification before local tag and GitHub Release creation.
//   workflow ordering tests - Protect verification-before-publish while keeping tag/release mutation out of CI.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Covered npm metadata retries, exact run watching, and exact changelog version matching.]
//   LAST_CHANGE: [DIRECT-FIX - Moved tag and GitHub Release finalization to the authenticated local process after CI publication.]
//   LAST_CHANGE: [DIRECT-FIX - Added regression coverage preventing pre-verification tag pushes and tag-triggered publishing.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  dispatchVerifiedPublishWorkflow,
  extractReleaseChangelogEntry,
  finalizePublishedRelease,
  parseWorkflowRunId,
  waitForPublishWorkflow,
  type ReleaseCommandRunner,
} from "./release-bump.ts";

type CapturedCommand = {
  mode: "run" | "capture";
  command: string;
  args: string[];
  failureMessage: string;
};

describe("release workflow dispatch", () => {
  test("pushes only the release branch and dispatches publish.yml with exact version and SHA", () => {
    const commands: CapturedCommand[] = [];
    const execute: ReleaseCommandRunner = (command, args, failureMessage) => {
      commands.push({ mode: "run", command, args, failureMessage });
      return "";
    };
    const capture: ReleaseCommandRunner = (command, args, failureMessage) => {
      commands.push({ mode: "capture", command, args, failureMessage });
      return "https://github.com/osovv/vv-opencode/actions/runs/123456789\n";
    };

    const output = dispatchVerifiedPublishWorkflow(
      {
        branchName: "main",
        version: "1.2.3",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
      },
      execute,
      capture,
    );

    expect(output).toBe("https://github.com/osovv/vv-opencode/actions/runs/123456789");
    expect(commands).toEqual([
      {
        mode: "run",
        command: "git",
        args: ["push", "origin", "main"],
        failureMessage:
          "git push origin main failed. The release commit exists locally but CI was not dispatched.",
      },
      {
        mode: "capture",
        command: "gh",
        args: [
          "workflow",
          "run",
          "publish.yml",
          "--ref",
          "main",
          "-f",
          "version=1.2.3",
          "-f",
          "commit_sha=0123456789abcdef0123456789abcdef01234567",
        ],
        failureMessage:
          "Failed to dispatch publish.yml. Retry with: gh workflow run publish.yml --ref main -f version=1.2.3 -f commit_sha=0123456789abcdef0123456789abcdef01234567",
      },
    ]);
    expect(commands.some((entry) => entry.command === "git" && entry.args[0] === "tag")).toBe(
      false,
    );
    expect(
      commands.some(
        (entry) =>
          entry.command === "git" && entry.args[0] === "push" && entry.args.includes("v1.2.3"),
      ),
    ).toBe(false);
  });
});

describe("workflow run parsing", () => {
  test("extracts the run ID from gh workflow run output and rejects missing URLs", () => {
    expect(
      parseWorkflowRunId("https://github.com/osovv/vv-opencode/actions/runs/123456789"),
    ).toBe("123456789");
    expect(() => parseWorkflowRunId("")).toThrow("Could not determine GitHub Actions run ID");
  });
});

describe("workflow run waiting", () => {
  test("watches the exact run and requires a successful conclusion", () => {
    const commands: CapturedCommand[] = [];
    const execute: ReleaseCommandRunner = (command, args, failureMessage) => {
      commands.push({ mode: "run", command, args, failureMessage });
      return "";
    };

    waitForPublishWorkflow("123456789", execute);

    expect(commands).toEqual([
      {
        mode: "run",
        command: "gh",
        args: ["run", "watch", "123456789", "--exit-status"],
        failureMessage:
          "Failed to watch publish.yml run 123456789. CI may have failed or the local gh authentication may not support run watch; inspect it with: gh run view 123456789. No release tag was created.",
      },
    ]);
  });
});

describe("release finalization", () => {
  test("verifies npm gitHead before creating the local annotated tag and GitHub Release", () => {
    const commands: CapturedCommand[] = [];
    const commitSha = "0123456789abcdef0123456789abcdef01234567";
    const execute: ReleaseCommandRunner = (command, args, failureMessage) => {
      commands.push({ mode: "run", command, args, failureMessage });
      return "";
    };
    const capture: ReleaseCommandRunner = (command, args, failureMessage) => {
      commands.push({ mode: "capture", command, args, failureMessage });
      return `${commitSha}\n`;
    };
    const changelog =
      "## <small>1.2.3 (2026-07-16)</small>\n\n### Summary\n\nCurrent release.\n\n## <small>1.2.2 (2026-07-15)</small>\n\nOlder release.";

    finalizePublishedRelease(
      {
        version: "1.2.3",
        commitSha,
        tagName: "v1.2.3",
        changelogText: changelog,
      },
      execute,
      capture,
    );

    expect(commands[0]).toEqual({
      mode: "capture",
      command: "npm",
      args: ["view", "@osovv/vv-opencode@1.2.3", "gitHead"],
      failureMessage: "Failed to verify @osovv/vv-opencode@1.2.3 after CI publication.",
    });
    expect(commands[1]).toMatchObject({
      mode: "run",
      command: "git",
      args: ["tag", "-a", "-m", "v1.2.3", "v1.2.3", commitSha],
    });
    expect(commands[2]).toMatchObject({
      mode: "run",
      command: "git",
      args: ["push", "origin", "v1.2.3"],
    });
    expect(commands[3]?.command).toBe("gh");
    expect(commands[3]?.args.slice(0, 7)).toEqual([
      "release",
      "create",
      "v1.2.3",
      "--verify-tag",
      "--title",
      "v1.2.3",
      "--notes",
    ]);
    expect(commands[3]?.args[7]).toContain("Current release.");
    expect(commands[3]?.args[7]).not.toContain("Older release.");
  });

  test("does not create a tag when npm gitHead does not match the release commit", () => {
    const commands: CapturedCommand[] = [];
    const execute: ReleaseCommandRunner = (command, args, failureMessage) => {
      commands.push({ mode: "run", command, args, failureMessage });
      return "";
    };
    const capture: ReleaseCommandRunner = (command, args, failureMessage) => {
      commands.push({ mode: "capture", command, args, failureMessage });
      return "ffffffffffffffffffffffffffffffffffffffff\n";
    };

    expect(() =>
      finalizePublishedRelease(
        {
          version: "1.2.3",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          tagName: "v1.2.3",
          changelogText: "## 1.2.3\n\nCurrent release.",
        },
        execute,
        capture,
      ),
    ).toThrow("gitHead is ffffffffffffffffffffffffffffffffffffffff");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.mode).toBe("capture");
  });

  test("retries delayed npm metadata before creating the tag", () => {
    const commands: CapturedCommand[] = [];
    const waits: number[] = [];
    const commitSha = "0123456789abcdef0123456789abcdef01234567";
    let captureAttempts = 0;
    const execute: ReleaseCommandRunner = (command, args, failureMessage) => {
      commands.push({ mode: "run", command, args, failureMessage });
      return "";
    };
    const capture: ReleaseCommandRunner = (command, args, failureMessage) => {
      commands.push({ mode: "capture", command, args, failureMessage });
      captureAttempts++;
      if (captureAttempts < 3) throw new Error("package metadata not propagated");
      return `${commitSha}\n`;
    };

    finalizePublishedRelease(
      {
        version: "1.2.3",
        commitSha,
        tagName: "v1.2.3",
        changelogText: "## 1.2.3\n\nCurrent release.",
      },
      execute,
      capture,
      (milliseconds) => waits.push(milliseconds),
    );

    expect(captureAttempts).toBe(3);
    expect(waits).toEqual([1_000, 2_000]);
    expect(commands.filter((entry) => entry.mode === "capture")).toHaveLength(3);
    expect(commands.some((entry) => entry.command === "git" && entry.args[0] === "tag")).toBe(
      true,
    );
  });

  test("extracts only the requested changelog block", () => {
    const changelog = "## 2.0.0\n\nNew.\n\n## 1.9.0\n\nOld.";
    expect(extractReleaseChangelogEntry(changelog, "2.0.0")).toBe("## 2.0.0\n\nNew.");
  });

  test("does not match a longer version that only contains the requested version", () => {
    const changelog = "## 1.2.30\n\nWrong.\n\n## <small>1.2.3 (2026-07-17)</small>\n\nRight.";
    expect(extractReleaseChangelogEntry(changelog, "1.2.3")).toBe(
      "## <small>1.2.3 (2026-07-17)</small>\n\nRight.",
    );
  });
});

describe("publish workflow ordering", () => {
  test("uses explicit dispatch, publishes after tests, and leaves tag/release mutation to the local wrapper", () => {
    const workflowPath = fileURLToPath(
      new URL("../.github/workflows/publish.yml", import.meta.url),
    );
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("ref: ${{ inputs.commit_sha }}");
    expect(workflow).not.toMatch(/push:\s*\n\s*tags:/);
    expect(workflow).toContain("contents: read");

    const testStep = workflow.indexOf("- name: Test");
    const publishStep = workflow.indexOf("- name: Publish to npm");

    expect(testStep).toBeGreaterThan(-1);
    expect(publishStep).toBeGreaterThan(testStep);
    expect(workflow).not.toContain("Create and push release tag");
    expect(workflow).not.toContain("git tag -a");
    expect(workflow).not.toContain("softprops/action-gh-release");
  });
});
