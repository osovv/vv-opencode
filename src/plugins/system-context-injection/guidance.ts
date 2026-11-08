// FILE: src/plugins/system-context-injection/guidance.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Project controller and shared-primary instruction sets from the canonical bundled controller template.
//   SCOPE: LF/CRLF-tolerant extraction of the seven approved sections; shared project/memory/evidence/working-cycle sections; source/review/autonomy/reporting bullets and delivery sentence without controller role, dispatch or recovery instructions. Missing, duplicate or incomplete canonical fragments fail explicitly.
//   DEPENDS: [templates/agents/vv-controller.md]
//   LINKS: [M-PLUGIN-SYSTEM-CONTEXT-INJECTION, M-CLI-MANAGED-AGENTS, V-M-PLUGIN-SYSTEM-CONTEXT-INJECTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PrimarySystemContexts - Controller sections and shared-primary projection.
//   createPrimarySystemContexts - Derives both sets from one supplied canonical template.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Single-source the approved wording while keeping controller-only instructions out of other primary agents.]
// END_CHANGE_SUMMARY

export interface PrimarySystemContexts {
  controller: readonly string[];
  universal: readonly string[];
}

// START_BLOCK_CANONICAL_PROJECTION
/** Derive guidance from the shipped template, never from a user's installed override. */
export function createPrimarySystemContexts(template: string): PrimarySystemContexts {
  const normalized = template.replace(/\r\n/g, "\n");
  const section = (name: string): string => {
    const matches = [
      ...normalized.matchAll(new RegExp(`^<${name}>\\n[\\s\\S]*?^</${name}>$`, "gm")),
    ];
    if (matches.length !== 1) {
      throw new Error(`controller guidance requires exactly one ${name} section`);
    }
    return matches[0]![0];
  };
  const project = section("project_context");
  const memory = section("repository_memory");
  const evidence = section("evidence_discipline");
  const cycle = section("working_cycle");
  const delegation = section("delegation_and_workflow");
  const communication = section("communication");
  const paragraphs = delegation.split("\n").slice(1, -1).join("\n").split("\n\n");
  const sharedAuthority = [
    "Keep requirement source,",
    "Record and mechanically enforce",
    "Honor explicitly delegated autonomy",
    "Report completion as controller-accepted",
  ].map((prefix) => {
    const matches = paragraphs.filter((paragraph) => paragraph.startsWith(`- ${prefix}`));
    if (matches.length !== 1)
      throw new Error(`controller guidance requires authority paragraph: ${prefix}`);
    return matches[0]!;
  });
  const delivery = communication.match(/Keep scratch reasoning[\s\S]*?stray markers\./g);
  if (delivery?.length !== 1)
    throw new Error("controller guidance requires one delivery instruction");

  return {
    controller: [
      section("task_and_scope"),
      project,
      memory,
      evidence,
      cycle,
      delegation,
      communication,
    ],
    universal: [
      project,
      memory,
      evidence,
      cycle,
      [
        "<execution_source_and_authority>",
        ...sharedAuthority,
        "</execution_source_and_authority>",
      ].join("\n\n"),
      ["<delivery_discipline>", delivery[0], "</delivery_discipline>"].join("\n"),
    ],
  };
}
// END_BLOCK_CANONICAL_PROJECTION
