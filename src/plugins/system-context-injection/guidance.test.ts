// FILE: src/plugins/system-context-injection/guidance.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Prevent canonical prompt edits from silently dropping shared-primary instructions.
//   SCOPE: Missing/duplicate sections, missing authority bullets and missing delivery guidance reject projection; prose reflow is preserved and CRLF templates retain the same instructions.
//   DEPENDS: [bun:test, src/lib/managed-agents.ts, ./guidance.ts]
//   LINKS: [M-PLUGIN-SYSTEM-CONTEXT-INJECTION, V-M-PLUGIN-SYSTEM-CONTEXT-INJECTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   [test scenarios] - Canonical template projection rejects instruction-loss mutations.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Cover instruction-loss counterexamples in the single-source primary projection.]
// END_CHANGE_SUMMARY

import { expect, test } from "bun:test";
import { loadManagedAgentPromptTemplate } from "../../lib/managed-agents.js";
import { createPrimarySystemContexts } from "./guidance.js";

test("rejects missing or duplicated repository-memory instructions", async () => {
  const template = await loadManagedAgentPromptTemplate("vv-controller");
  const memory = template.match(/<repository_memory>[\s\S]*?<\/repository_memory>/)![0];
  for (const broken of [template.replace(memory, ""), `${template}\n${memory}`]) {
    expect(() => createPrimarySystemContexts(broken)).toThrow("exactly one repository_memory");
  }
});

test("rejects loss of shared authority and delivery instead of silently omitting them", async () => {
  const template = await loadManagedAgentPromptTemplate("vv-controller");
  expect(() =>
    createPrimarySystemContexts(
      template.replace("- Honor explicitly delegated autonomy", "- Removed autonomy"),
    ),
  ).toThrow("requires authority paragraph");
  expect(() =>
    createPrimarySystemContexts(template.replace("Keep scratch reasoning", "Removed delivery")),
  ).toThrow("requires one delivery instruction");
});

test("shared sections use the canonical wording rather than a separately maintained copy", async () => {
  const template = await loadManagedAgentPromptTemplate("vv-controller");
  const changed = template.replace(
    "Treat lessons and runbooks as advisory memory.",
    "Treat lessons and runbooks as advisory\nmemory.",
  );
  const contexts = createPrimarySystemContexts(changed);
  expect(contexts.controller.join("\n\n")).toContain("as advisory\nmemory.");
  expect(contexts.universal.join("\n\n")).toContain("as advisory\nmemory.");
});

test("CRLF checkout preserves the canonical guidance", async () => {
  const template = await loadManagedAgentPromptTemplate("vv-controller");
  expect(createPrimarySystemContexts(template.replace(/\n/g, "\r\n"))).toEqual(
    createPrimarySystemContexts(template),
  );
});
