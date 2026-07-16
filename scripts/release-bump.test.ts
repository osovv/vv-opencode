// FILE: scripts/release-bump.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify release preparation pushes only the exact release commit and leaves npm publication plus tag creation to verified CI.
//   SCOPE: Pure command-runner capture for release workflow dispatch plus static publish workflow ordering assertions; no git, GitHub, or npm mutations.
//   DEPENDS: [bun:test, node:fs, scripts/release-bump.ts, .github/workflows/publish.yml]
//   LINKS: [M-RELEASE-AUTOMATION, V-M-RELEASE-AUTOMATION, VF-RELEASE-AUTOMATION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   dispatch regression tests - Protect branch-only push and exact-SHA workflow dispatch semantics.
//   workflow ordering tests - Protect verification-before-publish and publish-before-remote-tag ordering.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Added regression coverage preventing pre-verification tag pushes and tag-triggered publishing.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dispatchVerifiedPublishWorkflow, type ReleaseCommandRunner } from "./release-bump.ts";

type CapturedCommand = {
  command: string;
  args: string[];
  failureMessage: string;
};

describe("release workflow dispatch", () => {
  test("pushes only the release branch and dispatches publish.yml with exact version and SHA", () => {
    const commands: CapturedCommand[] = [];
    const runner: ReleaseCommandRunner = (command, args, failureMessage) => {
      commands.push({ command, args, failureMessage });
      return "";
    };

    dispatchVerifiedPublishWorkflow(
      {
        branchName: "main",
        version: "1.2.3",
        commitSha: "0123456789abcdef0123456789abcdef01234567",
      },
      runner,
    );

    expect(commands).toEqual([
      {
        command: "git",
        args: ["push", "origin", "main"],
        failureMessage:
          "git push origin main failed. The release commit exists locally but CI was not dispatched.",
      },
      {
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

describe("publish workflow ordering", () => {
  test("uses explicit dispatch and creates the remote tag only after tests and npm publication", () => {
    const workflowPath = fileURLToPath(
      new URL("../.github/workflows/publish.yml", import.meta.url),
    );
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("ref: ${{ inputs.commit_sha }}");
    expect(workflow).not.toMatch(/push:\s*\n\s*tags:/);

    const testStep = workflow.indexOf("- name: Test");
    const publishStep = workflow.indexOf("- name: Publish to npm");
    const tagStep = workflow.indexOf("- name: Create and push release tag");

    expect(testStep).toBeGreaterThan(-1);
    expect(publishStep).toBeGreaterThan(testStep);
    expect(tagStep).toBeGreaterThan(publishStep);
  });
});
