// FILE: src/lib/spec-lint.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Pure strict linter for .vvoc spec-package XML artifacts (spec.xml, plan.xml, design-context.xml) enforcing the element-name identity format.
//   SCOPE: Strict well-formedness validation over the htmlparser2 xmlMode event stream, template-contract checks per artifact kind, component/task/wave identity rules, reference integrity, lifecycle-aware severity, plan-subset-of-spec cross-file checking, and package layout checks. No filesystem access — callers pass artifact contents.
//   DEPENDS: [htmlparser2]
//   LINKS: [M-SPEC-LINT, M-PLUGIN-SPEC-GUARD, M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LINT_VERSION - Rule-set version constant; cache keys include it so rule changes invalidate cached verdicts.
//   SpecLintArtifactKind - Artifact kinds detected by root element name.
//   SpecLintSeverity - Finding severity levels error and warning.
//   SpecLintFinding - One rule violation with rule id, message, file label, and 1-based line.
//   SpecLintVerdict - Per-artifact lint result with kind, ok flag, and findings.
//   SpecLintArtifactInput - One artifact to lint identified by a file label and raw content.
//   SpecLintOptions - Options for lint runs (skipCrossFile for single-file contexts).
//   parseSpecXml - Strict xmlMode parse producing a positioned element tree or well-formedness findings.
//   lintSpecArtifacts - Lint a set of artifacts together, applying cross-file rules between plans and specs.
//   detectSpecArtifactKind - Map a root element name onto an artifact kind.
//   isSpecArchivePath - True when a file label sits inside an archive directory.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SPEC-IDENTITY-LINT - Initial engine: strict stack validation, template contracts, identity rules, references, lifecycle severity, cross-file subset check, layout checks.]
// END_CHANGE_SUMMARY

import { Tokenizer, type TokenizerCallbacks } from "htmlparser2";

// START_BLOCK_PUBLIC_TYPES
export const LINT_VERSION = 1;

export type SpecLintArtifactKind = "spec" | "plan" | "design-context";

export type SpecLintSeverity = "error" | "warning";

export interface SpecLintFinding {
  severity: SpecLintSeverity;
  rule: string;
  message: string;
  file: string;
  line: number;
}

export interface SpecLintVerdict {
  version: number;
  file: string;
  kind: SpecLintArtifactKind | "unknown";
  ok: boolean;
  findings: SpecLintFinding[];
}

export interface SpecLintArtifactInput {
  file: string;
  content: string;
}

export interface SpecLintOptions {
  /** Skip cross-file rules even when plan and spec inputs are both present. */
  skipCrossFile?: boolean;
}
// END_BLOCK_PUBLIC_TYPES

// START_BLOCK_PARSER_TYPES
interface XmlNode {
  name: string;
  line: number;
  attribs: Record<string, string>;
  children: XmlNode[];
  text: string;
  cdataCount: number;
}

interface ParseResult {
  root: XmlNode | null;
  findings: SpecLintFinding[];
}

const IDENTITY_PATTERNS = {
  component: /^COMPONENT-[A-Z0-9]+(-[A-Z0-9]+)*$/,
  task: /^TASK-T-\d{3,}$/,
  wave: /^WAVE-\d+$/,
} as const;

const TASK_ID_REF = /^T-\d{3,}$/;

const DOC_STATUSES = new Set(["draft", "approved", "applied"]);
const TASK_STATUSES = new Set(["pending", "in_progress", "done", "skipped"]);

const RESERVED_PACKAGE_SLUGS = new Set(["draft", "archive", "template", "plan", "spec", "vvoc"]);

const PACKAGE_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-[a-z0-9]([a-z0-9_-]*[a-z0-9_])?$/;
// END_BLOCK_PARSER_TYPES

// START_BLOCK_LINE_INDEX
/** 1-based line number for a character index in source text. */
function lineAt(content: string, index: number): number {
  let line = 1;
  const stop = Math.max(0, Math.min(index, content.length));
  for (let i = 0; i < stop; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}
// END_BLOCK_LINE_INDEX

// START_BLOCK_STRICT_PARSER
interface OpenTagNode extends XmlNode {
  attribNames: string[];
}

/**
 * Strict XML parse over htmlparser2's xmlMode Tokenizer event stream.
 * The low-level tokenizer is used directly (not Parser) because the Parser
 * silently drops unmatched closing tags and implies closes at end-of-input;
 * strict artifacts need both violation classes reported. Builds a positioned
 * element tree and reports well-formedness violations: tokenizer errors,
 * mismatched or unmatched closing tags, unclosed elements, stray top-level
 * content, multiple roots, and content after the root element.
 */
export function parseSpecXml(content: string, file: string): ParseResult {
  const findings: SpecLintFinding[] = [];
  const rootCandidates: XmlNode[] = [];
  const stack: OpenTagNode[] = [];
  let rootClosed = false;
  let pendingAttribNames: string[] = [];
  let pendingAttribName: string | null = null;

  const current = () => stack[stack.length - 1];

  const tokenizer = new Tokenizer(
    { xmlMode: true, recognizeSelfClosing: true, decodeEntities: false },
    {
      onopentagname(start, endIndex) {
        const name = content.slice(start, endIndex);
        const line = lineAt(content, start);
        pendingAttribNames = [];
        pendingAttribName = null;
        if (rootClosed) {
          findings.push({
            severity: "error",
            rule: "xml.content-after-root",
            message: `element <${name}> appears after the root element closed`,
            file,
            line,
          });
          return;
        }
        const node: OpenTagNode = {
          name,
          line,
          attribs: {},
          children: [],
          text: "",
          cdataCount: 0,
          attribNames: [],
        };
        const parent = current();
        if (parent) {
          parent.children.push(node);
        } else {
          rootCandidates.push(node);
        }
        stack.push(node);
      },
      onattribname(start, endIndex) {
        pendingAttribName = content.slice(start, endIndex);
      },
      onattribdata() {
        // attribute values are irrelevant: the format forbids attributes outright
      },
      onattribentity() {
        // no-op: attribute values are not inspected
      },
      onattribend() {
        if (pendingAttribName) pendingAttribNames.push(pendingAttribName);
        pendingAttribName = null;
      },
      onopentagend(endIndex) {
        const node = current();
        if (!node) return;
        if (pendingAttribNames.length > 0) {
          findings.push({
            severity: "error",
            rule: "attr.forbidden",
            message: `element <${node.name}> uses XML attributes (${pendingAttribNames.join(", ")}); the artifact format allows child elements only`,
            file,
            line: node.line,
          });
        }
        void endIndex;
      },
      onselfclosingtag() {
        const node = current();
        if (!node) return;
        if (pendingAttribNames.length > 0) {
          findings.push({
            severity: "error",
            rule: "attr.forbidden",
            message: `element <${node.name}> uses XML attributes (${pendingAttribNames.join(", ")}); the artifact format allows child elements only`,
            file,
            line: node.line,
          });
        }
        pendingAttribNames = [];
        stack.pop();
        if (stack.length === 0) rootClosed = true;
      },
      onclosetag(start, endIndex) {
        const name = content.slice(start, endIndex);
        const line = lineAt(content, start);
        const top = current();
        if (!top) {
          findings.push({
            severity: "error",
            rule: rootClosed ? "xml.content-after-root" : "xml.stray-close",
            message: `closing tag </${name}> has no matching open element`,
            file,
            line,
          });
          return;
        }
        if (top.name !== name) {
          const namedIndex = stack.findIndex((n) => n.name === name);
          if (namedIndex === -1) {
            findings.push({
              severity: "error",
              rule: "xml.mismatched-close",
              message: `closing tag </${name}> does not match any open element (innermost open is <${top.name}> from line ${top.line})`,
              file,
              line,
            });
            return;
          }
          for (let i = stack.length - 1; i > namedIndex; i--) {
            findings.push({
              severity: "error",
              rule: "xml.unclosed",
              message: `element <${stack[i].name}> opened on line ${stack[i].line} is closed implicitly by </${name}> and must be closed explicitly`,
              file,
              line: stack[i].line,
            });
          }
          stack.length = namedIndex;
        } else {
          stack.pop();
        }
        if (stack.length === 0) rootClosed = true;
      },
      ontext(start, endIndex) {
        const raw = content.slice(start, endIndex);
        const parent = current();
        if (parent) {
          parent.text += raw;
        } else if (raw.trim()) {
          findings.push({
            severity: "error",
            rule: rootClosed ? "xml.content-after-root" : "xml.stray-text",
            message: `text content outside the root element: ${JSON.stringify(raw.trim().slice(0, 40))}`,
            file,
            line: lineAt(content, start),
          });
        }
      },
      oncdata() {
        const parent = current();
        if (parent) parent.cdataCount++;
      },
      oncomment() {
        // comments are legal noise in artifacts and carry no contract meaning
      },
      ondeclaration() {
        // XML declarations and DOCTYPE are tolerated without contract meaning
      },
      onprocessinginstruction() {
        // processing instructions are tolerated without contract meaning
      },
      ontextentity() {
        // unreachable with decodeEntities disabled; raw slices keep entities verbatim
      },
      onend() {
        // required by the tokenizer interface; end-of-input handling happens after tokenizer.end() returns
      },
    } satisfies TokenizerCallbacks,
  );

  tokenizer.write(content);
  tokenizer.end();

  for (const unclosed of stack) {
    findings.push({
      severity: "error",
      rule: "xml.unclosed",
      message: `element <${unclosed.name}> opened on line ${unclosed.line} is never closed`,
      file,
      line: unclosed.line,
    });
  }

  if (rootCandidates.length > 1) {
    findings.push({
      severity: "error",
      rule: "xml.multiple-roots",
      message: `document has ${rootCandidates.length} root elements; exactly one is allowed`,
      file,
      line: rootCandidates[1].line,
    });
  }

  return { root: rootCandidates[0] ?? null, findings };
}
// END_BLOCK_STRICT_PARSER

// START_BLOCK_CONTRACT_TABLES
interface ChildRule {
  /** Fixed child names allowed beside identity-pattern children. */
  names?: readonly string[];
  /** Identity pattern: children matching it are allowed regardless of `names`. */
  identity?: keyof typeof IDENTITY_PATTERNS;
  /** Container element collecting identity children (e.g. components, tasks). */
}

const SPEC_CONTRACT: Record<string, ChildRule> = {
  spec: {
    names: [
      "status",
      "goal",
      "architecture",
      "tech_stack",
      "components",
      "data_flow",
      "error_handling",
      "testing",
      "non_goals",
    ],
  },
  testing: { names: ["strategy", "coverage"] },
  components: { identity: "component" },
  non_goals: { names: ["non_goal"] },
};

const COMPONENT_CHILDREN = ["name", "responsibility", "depends_on"] as const;

const PLAN_CONTRACT: Record<string, ChildRule> = {
  plan: { names: ["spec", "design_context", "created", "status", "meta", "architecture", "tasks"] },
  meta: { names: ["summary", "waves", "affected_modules", "complexity"] },
  architecture: { identity: "component" },
  tasks: { identity: "wave" },
};

const TASK_CHILDREN = [
  "title",
  "file",
  "status",
  "description",
  "depends_on",
  "snippet",
  "acceptance",
  "verification",
] as const;
const TASK_DEPENDS_CHILDREN = ["task_id"] as const;
const ACCEPTANCE_CHILDREN = ["criterion"] as const;
const VERIFICATION_CHILDREN = ["command"] as const;
const WAVE_CHILDREN = ["goal"] as const;
const PLAN_FILE_CHILDREN = ["path", "role"] as const;

const DESIGN_CONTEXT_CONTRACT: Record<string, ChildRule> = {
  "design-context": {
    names: ["decisions", "assumptions", "deferred", "scenarios", "external_constraints"],
  },
  decisions: { names: ["decision"] },
  decision: { names: ["topic", "choice", "rationale", "alternatives_considered"] },
  alternatives_considered: { names: ["alternative"] },
  alternative: { names: ["name", "reason_rejected"] },
  assumptions: { names: ["assumption"] },
  assumption: { names: ["statement", "confidence", "fragile_if"] },
  deferred: { names: ["deferred_decision"] },
  deferred_decision: { names: ["decision", "why_deferred", "revisit_trigger"] },
  scenarios: { names: ["scenario"] },
  scenario: { names: ["name", "context", "implications"] },
  external_constraints: { names: ["constraint"] },
  constraint: { names: ["source", "impact"] },
};
// END_BLOCK_CONTRACT_TABLES

// START_BLOCK_LIFECYNESS_HELPER
/**
 * Completeness rules apply only to known non-draft statuses. An invalid
 * status is reported once by the vocabulary rule without cascading
 * emptiness noise for a document that may still be mid-composition.
 */
function requiresCompleteness(root: XmlNode): boolean {
  const status = textOf(child(root, "status"));
  return status === "approved" || status === "applied";
}
// END_BLOCK_LIFECYNESS_HELPER

// START_BLOCK_TREE_HELPERS
function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

function textOf(node: XmlNode | undefined): string {
  return node ? node.text.trim() : "";
}

function nonEmpty(node: XmlNode | undefined): boolean {
  return textOf(node) !== "";
}
// END_BLOCK_TREE_HELPERS

// START_BLOCK_CONTRACT_CHECKS
/** Report children that are neither allowed fixed names nor valid identity elements. */
function checkChildren(
  node: XmlNode,
  rule: ChildRule | undefined,
  file: string,
  findings: SpecLintFinding[],
  extraAllowed: readonly string[] = [],
): void {
  const allowed = new Set<string>([...(rule?.names ?? []), ...extraAllowed]);
  for (const c of node.children) {
    if (allowed.has(c.name)) continue;
    if (rule?.identity && IDENTITY_PATTERNS[rule.identity].test(c.name)) continue;
    const expected = rule?.identity
      ? `${(rule.names ?? []).join(", ") || "(none)"}, or ${rule.identity} identity elements`
      : (rule?.names ?? []).join(", ") || "(none)";
    findings.push({
      severity: "error",
      rule: "element.unknown",
      message: `element <${c.name}> is not part of the template contract under <${node.name}>; allowed: ${expected}`,
      file,
      line: c.line,
    });
  }
}
// END_BLOCK_CONTRACT_CHECKS

// START_BLOCK_LAYOUT_CHECKS
/** True when a file label sits under an archive/ directory. */
export function isSpecArchivePath(file: string): boolean {
  return /(^|\/)archive\//.test(file.replace(/\\/g, "/"));
}

/**
 * Package layout checks applied when the label is a specs-package artifact
 * (.vvoc/specs/<id>/<artifact>.xml or an equivalent specs/ segment). Foreign
 * paths (plain filenames, temp fixtures without a specs segment) are skipped.
 */
function checkPackageLayout(file: string, findings: SpecLintFinding[]): void {
  const segments = file.replace(/\\/g, "/").split("/");
  const fileName = segments[segments.length - 1];
  if (!["spec.xml", "plan.xml", "design-context.xml"].includes(fileName)) return;
  const specsIndex = segments.lastIndexOf("specs");
  if (specsIndex === -1) return;
  const dirSegments = segments.slice(specsIndex + 1, -1).filter((s) => s !== "archive");
  if (dirSegments.length === 0) return;
  const packageId = dirSegments[dirSegments.length - 1];
  if (dirSegments.length > 1) return; // nested dirs inside a package: skip id checks
  if (!PACKAGE_ID_PATTERN.test(packageId)) {
    findings.push({
      severity: "error",
      rule: "layout.package_id",
      message: `package directory "${packageId}" does not match the required date-prefixed id YYYY-MM-DD-<slug> with a lowercase slug`,
      file,
      line: 1,
    });
    return;
  }
  const slug = packageId.slice(11);
  if (RESERVED_PACKAGE_SLUGS.has(slug)) {
    findings.push({
      severity: "error",
      rule: "layout.reserved_slug",
      message: `package slug "${slug}" is reserved`,
      file,
      line: 1,
    });
  }
}
// END_BLOCK_LAYOUT_CHECKS

// START_BLOCK_KIND_DETECTION
export function detectSpecArtifactKind(rootName: string): SpecLintArtifactKind | "unknown" {
  switch (rootName) {
    case "spec":
      return "spec";
    case "plan":
      return "plan";
    case "design-context":
      return "design-context";
    default:
      return "unknown";
  }
}
// END_BLOCK_KIND_DETECTION

// START_BLOCK_SPEC_RULES
interface SpecFacts {
  componentSlugs: string[];
  status: string;
}

function lintSpec(root: XmlNode, file: string, parseFindings: SpecLintFinding[]): SpecLintVerdict {
  const findings = [...parseFindings];
  checkChildren(root, SPEC_CONTRACT.spec, file, findings);
  const completeness = requiresCompleteness(root);

  const statusNode = child(root, "status");
  const status = textOf(statusNode);
  if (!DOC_STATUSES.has(status)) {
    findings.push({
      severity: "error",
      rule: "lifecycle.status",
      message: `spec status "${status}" is not one of draft, approved, applied`,
      file,
      line: statusNode?.line ?? root.line,
    });
  }

  const componentsNode = child(root, "components");
  if (componentsNode) {
    checkChildren(componentsNode, SPEC_CONTRACT.components, file, findings);
    const seen = new Set<string>();
    const slugs: string[] = [];
    for (const c of componentsNode.children) {
      if (!IDENTITY_PATTERNS.component.test(c.name)) {
        findings.push({
          severity: "error",
          rule: "identity.pattern",
          message: `component element <${c.name}> does not match the COMPONENT-UPPER-SLUG pattern (uppercase alphanumeric and hyphens, derived from the display name)`,
          file,
          line: c.line,
        });
        continue;
      }
      if (seen.has(c.name)) {
        findings.push({
          severity: "error",
          rule: "identity.duplicate",
          message: `component ${c.name} is declared more than once`,
          file,
          line: c.line,
        });
        continue;
      }
      seen.add(c.name);
      slugs.push(c.name);
      checkChildren(c, { names: COMPONENT_CHILDREN }, file, findings);
    }

    for (const c of componentsNode.children) {
      for (const dep of children(c, "depends_on")) {
        const ref = textOf(dep);
        if (!ref) continue;
        const target = `COMPONENT-${ref.startsWith("COMPONENT-") ? ref.slice("COMPONENT-".length) : ref}`;
        if (!seen.has(target)) {
          findings.push({
            severity: "error",
            rule: "ref.dangling",
            message: `depends_on references "${ref}" which is not a declared component in this document`,
            file,
            line: dep.line,
          });
        }
      }
    }

    if (completeness) {
      for (const c of componentsNode.children) {
        if (!nonEmpty(child(c, "name"))) {
          findings.push({
            severity: "error",
            rule: "lifecycle.required",
            message: `component ${c.name} has an empty <name>; the spec is ${status} and must be complete`,
            file,
            line: c.line,
          });
        }
        if (!nonEmpty(child(c, "responsibility"))) {
          findings.push({
            severity: "error",
            rule: "lifecycle.required",
            message: `component ${c.name} has an empty <responsibility>; the spec is ${status} and must be complete`,
            file,
            line: c.line,
          });
        }
      }
    }
  }

  const testingNode = child(root, "testing");
  if (testingNode) checkChildren(testingNode, SPEC_CONTRACT.testing, file, findings);

  const nonGoalsNode = child(root, "non_goals");
  if (nonGoalsNode) checkChildren(nonGoalsNode, SPEC_CONTRACT.non_goals, file, findings);

  if (completeness) {
    const required: Array<[string, XmlNode | undefined]> = [
      ["goal", child(root, "goal")],
      ["architecture", child(root, "architecture")],
      ["tech_stack", child(root, "tech_stack")],
      ["data_flow", child(root, "data_flow")],
      ["error_handling", child(root, "error_handling")],
      ["testing.strategy", testingNode ? child(testingNode, "strategy") : undefined],
      ["testing.coverage", testingNode ? child(testingNode, "coverage") : undefined],
    ];
    for (const [label, node] of required) {
      if (!nonEmpty(node)) {
        findings.push({
          severity: "error",
          rule: "lifecycle.required",
          message: `<${label}> is empty; the spec is ${status} and must be complete`,
          file,
          line: node?.line ?? root.line,
        });
      }
    }
    if (componentsNode && componentsNode.children.length === 0) {
      findings.push({
        severity: "error",
        rule: "lifecycle.required",
        message: `<components> declares no components; the spec is ${status} and must be complete`,
        file,
        line: componentsNode.line,
      });
    }
  }

  checkPackageLayout(file, findings);

  return {
    version: LINT_VERSION,
    file,
    kind: "spec",
    ok: !findings.some((f) => f.severity === "error"),
    findings,
  };
}
// END_BLOCK_SPEC_RULES

// START_BLOCK_PLAN_RULES
function lintPlan(
  root: XmlNode,
  file: string,
  parseFindings: SpecLintFinding[],
  specByLabel: Map<string, SpecFacts>,
  options: SpecLintOptions,
): SpecLintVerdict {
  const findings = [...parseFindings];
  checkChildren(root, PLAN_CONTRACT.plan, file, findings);

  const statusNode = child(root, "status");
  const status = textOf(statusNode);
  if (!DOC_STATUSES.has(status)) {
    findings.push({
      severity: "error",
      rule: "lifecycle.status",
      message: `plan status "${status}" is not one of draft, approved, applied`,
      file,
      line: statusNode?.line ?? root.line,
    });
  }
  const completeness = requiresCompleteness(root);

  // Cross-file facts are resolved early so architecture depends_on may reference
  // spec components that the plan does not touch.
  const specPathNodeEarly = child(root, "spec");
  const specFacts = options.skipCrossFile
    ? undefined
    : resolveSpecFacts(textOf(specPathNodeEarly), specByLabel);

  // Architecture: component identity elements mirroring the spec.
  const architectureNode = child(root, "architecture");
  const componentSlugs: string[] = [];
  if (architectureNode) {
    checkChildren(architectureNode, PLAN_CONTRACT.architecture, file, findings);
    const seen = new Set<string>();
    for (const c of architectureNode.children) {
      if (!IDENTITY_PATTERNS.component.test(c.name)) {
        findings.push({
          severity: "error",
          rule: "identity.pattern",
          message: `architecture element <${c.name}> does not match the COMPONENT-UPPER-SLUG pattern mirrored from spec.xml`,
          file,
          line: c.line,
        });
        continue;
      }
      if (seen.has(c.name)) {
        findings.push({
          severity: "error",
          rule: "identity.duplicate",
          message: `architecture component ${c.name} is declared more than once`,
          file,
          line: c.line,
        });
        continue;
      }
      seen.add(c.name);
      componentSlugs.push(c.name);
      checkChildren(
        c,
        { names: ["name", "purpose", "file", "contract", "depends_on"] },
        file,
        findings,
      );
      const fileNode = child(c, "file");
      if (fileNode) checkChildren(fileNode, { names: PLAN_FILE_CHILDREN }, file, findings);
    }

    for (const c of architectureNode.children) {
      for (const dep of children(c, "depends_on")) {
        const ref = textOf(dep);
        if (!ref) continue;
        const target = ref.startsWith("COMPONENT-") ? ref : `COMPONENT-${ref}`;
        const knownLocally = seen.has(target);
        const knownInSpec = specFacts?.componentSlugs.includes(target) ?? false;
        // Without a resolved spec, non-local references stay unverifiable: the
        // crossfile.spec_missing warning already reports the skipped checks.
        if (specFacts && !knownLocally && !knownInSpec) {
          findings.push({
            severity: "error",
            rule: "ref.dangling",
            message: `architecture depends_on references "${ref}" which is declared neither in this plan's architecture nor in the linked spec`,
            file,
            line: dep.line,
          });
        }
      }
    }
  }

  // Tasks: waves with TASK-T-NNN identity elements.
  const tasksNode = child(root, "tasks");
  const taskIds = new Set<string>();
  if (tasksNode) {
    checkChildren(tasksNode, PLAN_CONTRACT.tasks, file, findings);
    for (const wave of tasksNode.children) {
      if (!IDENTITY_PATTERNS.wave.test(wave.name)) {
        findings.push({
          severity: "error",
          rule: "identity.pattern",
          message: `wave element <${wave.name}> does not match the WAVE-N pattern`,
          file,
          line: wave.line,
        });
        continue;
      }
      checkChildren(wave, { names: WAVE_CHILDREN, identity: "task" }, file, findings);
    }

    for (const wave of tasksNode.children) {
      for (const task of wave.children) {
        if (!IDENTITY_PATTERNS.task.test(task.name)) {
          if (!WAVE_CHILDREN.includes(task.name as (typeof WAVE_CHILDREN)[number])) {
            findings.push({
              severity: "error",
              rule: "identity.pattern",
              message: `task element <${task.name}> does not match the TASK-T-NNN pattern`,
              file,
              line: task.line,
            });
          }
          continue;
        }
        if (taskIds.has(task.name)) {
          findings.push({
            severity: "error",
            rule: "identity.duplicate",
            message: `task ${task.name} is declared more than once`,
            file,
            line: task.line,
          });
          continue;
        }
        taskIds.add(task.name);
        checkChildren(task, { names: TASK_CHILDREN }, file, findings);
        const dependsNode = child(task, "depends_on");
        if (dependsNode)
          checkChildren(dependsNode, { names: TASK_DEPENDS_CHILDREN }, file, findings);
        const acceptanceNode = child(task, "acceptance");
        if (acceptanceNode)
          checkChildren(acceptanceNode, { names: ACCEPTANCE_CHILDREN }, file, findings);
        const verificationNode = child(task, "verification");
        if (verificationNode)
          checkChildren(verificationNode, { names: VERIFICATION_CHILDREN }, file, findings);

        const taskStatusNode = child(task, "status");
        const taskStatus = textOf(taskStatusNode);
        if (!TASK_STATUSES.has(taskStatus)) {
          findings.push({
            severity: "error",
            rule: "lifecycle.task_status",
            message: `task ${task.name} status "${taskStatus}" is not one of pending, in_progress, done, skipped`,
            file,
            line: taskStatusNode?.line ?? task.line,
          });
        }

        const snippetNode = child(task, "snippet");
        if (snippetNode && snippetNode.text.trim() !== "" && snippetNode.cdataCount === 0) {
          findings.push({
            severity: "error",
            rule: "snippet.cdata",
            message: `task ${task.name} has a non-empty <snippet> that is not wrapped in CDATA`,
            file,
            line: snippetNode.line,
          });
        }

        if (completeness) {
          if (!nonEmpty(child(task, "title"))) {
            findings.push({
              severity: "error",
              rule: "lifecycle.required",
              message: `task ${task.name} has an empty <title>; the plan is ${status} and must be complete`,
              file,
              line: task.line,
            });
          }
          if (!nonEmpty(child(task, "file"))) {
            findings.push({
              severity: "error",
              rule: "lifecycle.required",
              message: `task ${task.name} has an empty <file>; the plan is ${status} and must be complete`,
              file,
              line: task.line,
            });
          }
          if (!nonEmpty(child(task, "description"))) {
            findings.push({
              severity: "error",
              rule: "lifecycle.required",
              message: `task ${task.name} has an empty <description>; the plan is ${status} and must be complete`,
              file,
              line: task.line,
            });
          }
          const acceptance = child(task, "acceptance");
          if (!acceptance || children(acceptance, "criterion").length === 0) {
            findings.push({
              severity: "error",
              rule: "lifecycle.required",
              message: `task ${task.name} has no acceptance criteria; the plan is ${status} and must be complete`,
              file,
              line: acceptance?.line ?? task.line,
            });
          }
          const verification = child(task, "verification");
          if (!verification || children(verification, "command").length === 0) {
            findings.push({
              severity: "error",
              rule: "lifecycle.required",
              message: `task ${task.name} has no verification command; the plan is ${status} and must be complete`,
              file,
              line: verification?.line ?? task.line,
            });
          }
        }
      }
    }

    for (const wave of tasksNode.children) {
      for (const task of wave.children) {
        const dependsNode = child(task, "depends_on");
        if (!dependsNode) continue;
        for (const ref of children(dependsNode, "task_id")) {
          const value = textOf(ref);
          if (!value) continue;
          if (!TASK_ID_REF.test(value) || !taskIds.has(`TASK-${value}`)) {
            findings.push({
              severity: "error",
              rule: "ref.dangling",
              message: `task_id references "${value}" which is not a declared task in this plan`,
              file,
              line: ref.line,
            });
          }
        }
      }
    }
  }

  if (completeness) {
    const metaNode = child(root, "meta");
    const required: Array<[string, XmlNode | undefined]> = metaNode
      ? [
          ["meta.summary", child(metaNode, "summary")],
          ["meta.waves", child(metaNode, "waves")],
          ["meta.affected_modules", child(metaNode, "affected_modules")],
          ["meta.complexity", child(metaNode, "complexity")],
        ]
      : [];
    for (const [label, node] of required) {
      if (!nonEmpty(node)) {
        findings.push({
          severity: "error",
          rule: "lifecycle.required",
          message: `<${label}> is empty; the plan is ${status} and must be complete`,
          file,
          line: node?.line ?? root.line,
        });
      }
    }
    if (tasksNode && tasksNode.children.length === 0) {
      findings.push({
        severity: "error",
        rule: "lifecycle.required",
        message: `<tasks> declares no waves; the plan is ${status} and must be complete`,
        file,
        line: tasksNode.line,
      });
    }
  }

  // Cross-file: plan components are a subset of spec components.
  if (!options.skipCrossFile) {
    const specPath = textOf(specPathNodeEarly);
    if (!specFacts) {
      findings.push({
        severity: "warning",
        rule: "crossfile.spec_missing",
        message: `linked spec "${specPath || "(empty)"}" was not part of this lint run; plan-subset-of-spec checks were skipped`,
        file,
        line: specPathNodeEarly?.line ?? root.line,
      });
    } else {
      const specSlugs = new Set(specFacts.componentSlugs);
      for (const slug of componentSlugs) {
        if (!specSlugs.has(slug)) {
          const archNode = architectureNode?.children.find((c) => c.name === slug);
          findings.push({
            severity: "error",
            rule: "crossfile.plan_component",
            message: `plan architecture component ${slug} does not exist in the linked spec; plan components must be a subset of spec components`,
            file,
            line: archNode?.line ?? root.line,
          });
        }
      }
    }
  }

  checkPackageLayout(file, findings);

  return {
    version: LINT_VERSION,
    file,
    kind: "plan",
    ok: !findings.some((f) => f.severity === "error"),
    findings,
  };
}
// END_BLOCK_PLAN_RULES

// START_BLOCK_SPEC_FACTS
function collectSpecFacts(root: XmlNode): SpecFacts {
  const componentsNode = child(root, "components");
  const componentSlugs = componentsNode
    ? componentsNode.children
        .filter((c) => IDENTITY_PATTERNS.component.test(c.name))
        .map((c) => c.name)
    : [];
  return { componentSlugs, status: textOf(child(root, "status")) };
}

function resolveSpecFacts(
  specPath: string,
  specByLabel: Map<string, SpecFacts>,
): SpecFacts | undefined {
  if (!specPath) return undefined;
  const normalized = specPath.replace(/\\/g, "/");
  if (specByLabel.has(normalized)) return specByLabel.get(normalized);
  const base = normalized.split("/").pop() ?? normalized;
  for (const [label, facts] of specByLabel) {
    const labelBase = label.replace(/\\/g, "/").split("/").pop() ?? label;
    if (labelBase === base) return facts;
  }
  return undefined;
}
// END_BLOCK_SPEC_FACTS

// START_BLOCK_DESIGN_CONTEXT_RULES
function lintDesignContext(
  root: XmlNode,
  file: string,
  parseFindings: SpecLintFinding[],
): SpecLintVerdict {
  const findings = [...parseFindings];
  const contract = DESIGN_CONTEXT_CONTRACT;
  checkChildren(root, contract["design-context"], file, findings);
  const walk = (node: XmlNode): void => {
    const rule = contract[node.name];
    if (rule) checkChildren(node, rule, file, findings);
    for (const c of node.children) walk(c);
  };
  for (const c of root.children) walk(c);

  checkPackageLayout(file, findings);

  return {
    version: LINT_VERSION,
    file,
    kind: "design-context",
    ok: !findings.some((f) => f.severity === "error"),
    findings,
  };
}
// END_BLOCK_DESIGN_CONTEXT_RULES

// START_BLOCK_LINT_ENTRY
/**
 * Lint a set of spec-package artifacts together. Plans resolve their linked
 * spec among the provided inputs by path or basename for cross-file subset
 * checks; a plan without its spec yields a warning, not an error.
 */
export function lintSpecArtifacts(
  inputs: SpecLintArtifactInput[],
  options: SpecLintOptions = {},
): SpecLintVerdict[] {
  // Parse everything first so spec facts exist for plan cross-file rules.
  const parsed = inputs.map((input) => ({ input, ...parseSpecXml(input.content, input.file) }));

  const specByLabel = new Map<string, SpecFacts>();
  for (const p of parsed) {
    if (p.root && detectSpecArtifactKind(p.root.name) === "spec") {
      specByLabel.set(p.input.file.replace(/\\/g, "/"), collectSpecFacts(p.root));
    }
  }

  const verdicts: SpecLintVerdict[] = [];
  for (const p of parsed) {
    if (!p.root) {
      verdicts.push({
        version: LINT_VERSION,
        file: p.input.file,
        kind: "unknown",
        ok: false,
        findings: p.findings.length
          ? p.findings
          : [
              {
                severity: "error",
                rule: "xml.empty",
                message: "document has no root element",
                file: p.input.file,
                line: 1,
              },
            ],
      });
      continue;
    }
    const kind = detectSpecArtifactKind(p.root.name);
    switch (kind) {
      case "spec":
        verdicts.push(lintSpec(p.root, p.input.file, p.findings));
        break;
      case "plan":
        verdicts.push(lintPlan(p.root, p.input.file, p.findings, specByLabel, options));
        break;
      case "design-context":
        verdicts.push(lintDesignContext(p.root, p.input.file, p.findings));
        break;
      default:
        verdicts.push({
          version: LINT_VERSION,
          file: p.input.file,
          kind: "unknown",
          ok: false,
          findings: [
            ...p.findings,
            {
              severity: "error",
              rule: "element.root",
              message: `root element <${p.root.name}> is not one of spec, plan, design-context`,
              file: p.input.file,
              line: p.root.line,
            },
          ],
        });
    }
  }
  return verdicts;
}
// END_BLOCK_LINT_ENTRY
