// FILE: scripts/release-check.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify release-check validates latest changelog summary while preserving package and schema consistency checks.
//   SCOPE: Pure collectReleaseConsistencyErrors tests with package, schema, and changelog fixtures.
//   DEPENDS: [bun:test, scripts/release-check]
//   LINKS: [M-RELEASE-AUTOMATION, VF-RELEASE-AUTOMATION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   collectReleaseConsistencyErrors - Returns all package, schema, and changelog summary consistency errors for tests and main.
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Initial test coverage for release-check consistency validation.]
// END_CHANGE_SUMMARY
import { describe, expect, test } from "bun:test";
import { collectReleaseConsistencyErrors, type ReleaseConsistencyInputs } from "./release-check.ts";

/** Returns a valid release-check fixture with overridable changelog text. */
function fixture(changelogText: string | null, overrides?: Partial<ReleaseConsistencyInputs>): ReleaseConsistencyInputs {
  return {
    pkg: { name: "@osovv/vv-opencode", version: "1.2.3" },
    schema: {
      $id: "https://cdn.jsdelivr.net/npm/@osovv/vv-opencode@1.2.3/schemas/vvoc/v3.json",
      properties: { version: { const: 3 } },
    },
    changelogText,
    ...overrides,
  };
}

describe("release-check latest summary validation", () => {
  // -----------------------------------------------------------------------
  // Summary gate tests
  // -----------------------------------------------------------------------

  test("passes when latest entry has a valid summary", () => {
    const changelog =
      `## <small>1.2.3 (2026-06-13)</small>\n\n### Summary\n\nThis release makes upgrades clearer and safer for maintainers. It preserves detailed commit notes below while giving users a fast explanation of what changed.\n\n* feat: new`;
    expect(collectReleaseConsistencyErrors(fixture(changelog))).toEqual([]);
  });

  test("fails when latest entry has no summary", () => {
    const changelog = `## <small>1.2.3 (2026-06-13)</small>\n\n* feat: new`;
    const errors = collectReleaseConsistencyErrors(fixture(changelog));
    expect(errors.join("\n")).toContain("latest release summary");
  });

  test("fails when latest summary contains a fenced code block", () => {
    const changelog =
      `## <small>1.2.3 (2026-06-13)</small>\n\n### Summary\n\nCode: \`\`\`\nfoo\n\`\`\`\n\n* feat: new`;
    expect(collectReleaseConsistencyErrors(fixture(changelog)).join("\n")).toContain("latest release summary");
  });

  test("fails when latest summary contains a heading", () => {
    const changelog =
      `## <small>1.2.3 (2026-06-13)</small>\n\n### Summary\n\n# Bad heading\n\n* feat: new`;
    expect(collectReleaseConsistencyErrors(fixture(changelog)).join("\n")).toContain("latest release summary");
  });

  test("passes when only older release blocks lack summaries", () => {
    const changelog =
      `## <small>1.2.3 (2026-06-13)</small>\n\n### Summary\n\nA clear summary.\n\n* feat: new\n\n## <small>1.1.0 (2026-06-01)</small>\n\n* fix: old`;
    expect(collectReleaseConsistencyErrors(fixture(changelog))).toEqual([]);
  });

  test("passes when two releases both have valid summaries", () => {
    const changelog =
      `## <small>1.2.3 (2026-06-13)</small>\n\n### Summary\n\nA clear summary.\n\n* feat: new\n\n## <small>1.1.0 (2026-06-01)</small>\n\n### Summary\n\nOld valid summary.\n\n* fix: old`;
    expect(collectReleaseConsistencyErrors(fixture(changelog))).toEqual([]);
  });

  test("fails when latest summary is empty", () => {
    const changelog =
      `## <small>1.2.3 (2026-06-13)</small>\n\n### Summary\n\n\n\n* feat: new`;
    const errors = collectReleaseConsistencyErrors(fixture(changelog));
    expect(errors.join("\n")).toContain("latest release summary");
  });

  // -----------------------------------------------------------------------
  // Package / schema tests (existing coverage)
  // -----------------------------------------------------------------------

  test("fails when package name is wrong", () => {
    const input = fixture("## <small>1.2.3</small>\n\n### Summary\n\nValid summary.\n\n* feat: new", {
      pkg: { name: "@wrong/package", version: "1.2.3" },
    });
    const errors = collectReleaseConsistencyErrors(input);
    expect(errors).toContainEqual(expect.stringContaining("@wrong/package"));
  });

  test("fails when version is missing", () => {
    const input = fixture("## <small>1.2.3</small>\n\n### Summary\n\nValid.\n\n* feat: new", {
      pkg: { name: "@osovv/vv-opencode", version: undefined },
    });
    const errors = collectReleaseConsistencyErrors(input);
    expect(errors).toContainEqual(expect.stringContaining("version is missing"));
  });

  test("fails when schema $id does not match", () => {
    const input = fixture("## <small>1.2.3</small>\n\n### Summary\n\nValid.\n\n* feat: new", {
      schema: { $id: "https://wrong/url" },
    });
    const errors = collectReleaseConsistencyErrors(input);
    expect(errors).toContainEqual(expect.stringContaining("$id"));
  });

  test("fails when CHANGELOG.md is null", () => {
    const errors = collectReleaseConsistencyErrors(fixture(null));
    expect(errors).toContainEqual(expect.stringContaining("CHANGELOG.md"));
  });

  // -----------------------------------------------------------------------
  // import.meta.main guard: does not execute process.exit
  // -----------------------------------------------------------------------

  test("does not execute process.exit during import (testable import)", () => {
    // If we got here without process.exit being called, the guard works.
    // The function was imported and called directly — main() is not run.
    expect(collectReleaseConsistencyErrors).toBeDefined();
  });
});
