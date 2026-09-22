// FILE: src/lib/spec-lint/parser.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Strict XML document model, vocabulary, and template contract tables shared by every spec-lint rule zone.
//   SCOPE: htmlparser2 xmlMode event-stream parse with a positioned element tree and well-formedness findings, identity/status/mode vocabularies, child-rule contract tables for spec/plan/design-context templates, tree and completeness helpers, child-contract checking, package layout checks, artifact-kind detection, and archive-path detection. Rule orchestration lives in sibling zone modules.
//   DEPENDS: [htmlparser2]
//   LINKS: [M-SPEC-LINT]
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
//   XmlNode - Positioned element tree node produced by the strict parser.
//   ParseResult - Root element plus well-formedness findings from parseSpecXml.
//   ChildRule - Allowed fixed child names or identity-pattern rule for one container element.
//   parseSpecXml - Strict xmlMode parse producing a positioned element tree or well-formedness findings.
//   detectSpecArtifactKind - Map a root element name onto an artifact kind.
//   isSpecArchivePath - True when a file label sits inside an archive directory.
//   child/children/textOf/nonEmpty - Positioned-tree readers used by every rule zone.
//   requiresCompleteness - True when the document status demands completeness rules.
//   checkChildren - Report children outside the template contract.
//   checkPackageLayout - Enforce specs-package id and reserved-slug layout rules.
//   IDENTITY_PATTERNS - Element identity regexes for component, task, wave, and checkpoint.
//   TASK_ID_REF - Bare task reference regex T-NNN.
//   DOC_STATUSES - Accepted document statuses.
//   TASK_STATUSES - Accepted task statuses.
//   EXECUTION_MODES - Accepted execution modes.
//   CHECKPOINT_KINDS - Accepted checkpoint kinds.
//   DELEGATED_REVIEWERS - Accepted delegated reviewer roles.
//   SPEC_CONTRACT - Spec template child-rule table.
//   PLAN_CONTRACT - Plan template child-rule table.
//   DESIGN_CONTEXT_CONTRACT - Design-context template child-rule table.
//   COMPONENT_CHILDREN - Fixed children of one spec component element.
//   TASK_CHILDREN - Fixed children of one plan task element.
//   TASK_DEPENDS_CHILDREN - Fixed children of one task depends_on element.
//   ACCEPTANCE_CHILDREN - Fixed children of one acceptance element.
//   VERIFICATION_CHILDREN - Fixed children of one verification element.
//   WAVE_CHILDREN - Fixed children of one wave element.
//   PLAN_FILE_CHILDREN - Fixed children of one plan file element.
//   TASK_WRITE_SCOPE_CHILDREN - Fixed children of one task write_scope element.
//   CHECKPOINT_CHILDREN - Fixed children of one checkpoint element.
//   CHECKPOINT_COVERS_CHILDREN - Fixed children of one checkpoint covers element.
//   CHECKPOINT_SCOPE_CHILDREN - Fixed children of one checkpoint scope element.
//   CHECKPOINT_REVIEWERS_CHILDREN - Fixed children of one checkpoint reviewers element.
//   child - First named child of a node.
//   children - All named children of a node.
//   textOf - Trimmed text of a node.
//   nonEmpty - True when a node has non-empty trimmed text.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SPEC-LINT-RULES-SPLIT-R1 - Extracted the strict parser, vocabularies, contract tables, and shared tree helpers from the former src/lib/spec-lint.ts monolith into this foundation zone module.]
// END_CHANGE_SUMMARY

import { Tokenizer, type TokenizerCallbacks } from "htmlparser2";

// START_BLOCK_PUBLIC_TYPES
export const LINT_VERSION = 2;

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
export interface XmlNode {
  name: string;
  line: number;
  attribs: Record<string, string>;
  children: XmlNode[];
  text: string;
  cdataCount: number;
}

export interface ParseResult {
  root: XmlNode | null;
  findings: SpecLintFinding[];
}

export const IDENTITY_PATTERNS = {
  component: /^COMPONENT-[A-Z0-9]+(-[A-Z0-9]+)*$/,
  task: /^TASK-T-\d{3,}$/,
  wave: /^WAVE-\d+$/,
  checkpoint: /^CHECKPOINT-R-\d{3,}$/,
} as const;

export const TASK_ID_REF = /^T-\d{3,}$/;

export const DOC_STATUSES = new Set(["draft", "approved", "applied"]);
export const TASK_STATUSES = new Set(["pending", "in_progress", "done", "skipped"]);

export const EXECUTION_MODES = new Set(["inline", "classic", "delegated"]);
export const CHECKPOINT_KINDS = new Set(["milestone", "final"]);
export const DELEGATED_REVIEWERS = new Set(["spec", "code"]);

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
export interface ChildRule {
  /** Fixed child names allowed beside identity-pattern children. */
  names?: readonly string[];
  /** Identity pattern: children matching it are allowed regardless of `names`. */
  identity?: keyof typeof IDENTITY_PATTERNS;
  /** Container element collecting identity children (e.g. components, tasks). */
}

export const SPEC_CONTRACT: Record<string, ChildRule> = {
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

export const COMPONENT_CHILDREN = ["name", "responsibility", "depends_on"] as const;

export const PLAN_CONTRACT: Record<string, ChildRule> = {
  plan: {
    names: [
      "spec",
      "design_context",
      "created",
      "status",
      "meta",
      "architecture",
      "tasks",
      "execution",
    ],
  },
  meta: { names: ["summary", "waves", "affected_modules", "complexity"] },
  architecture: { identity: "component" },
  tasks: { identity: "wave" },
  execution: { names: ["mode", "review_checkpoints"] },
  review_checkpoints: { identity: "checkpoint" },
};

export const TASK_CHILDREN = [
  "title",
  "file",
  "status",
  "description",
  "depends_on",
  "snippet",
  "acceptance",
  "verification",
  "write_scope",
] as const;
export const TASK_DEPENDS_CHILDREN = ["task_id"] as const;
export const ACCEPTANCE_CHILDREN = ["criterion"] as const;
export const VERIFICATION_CHILDREN = ["command"] as const;
export const WAVE_CHILDREN = ["goal"] as const;
export const PLAN_FILE_CHILDREN = ["path", "role"] as const;
export const TASK_WRITE_SCOPE_CHILDREN = ["file"] as const;

export const CHECKPOINT_CHILDREN = [
  "kind",
  "after_wave",
  "covers",
  "scope",
  "reviewers",
  "acceptance",
  "verification",
] as const;
export const CHECKPOINT_COVERS_CHILDREN = ["task_id"] as const;
export const CHECKPOINT_SCOPE_CHILDREN = ["file"] as const;
export const CHECKPOINT_REVIEWERS_CHILDREN = ["reviewer"] as const;

export const DESIGN_CONTEXT_CONTRACT: Record<string, ChildRule> = {
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
export function requiresCompleteness(root: XmlNode): boolean {
  const status = textOf(child(root, "status"));
  return status === "approved" || status === "applied";
}
// END_BLOCK_LIFECYNESS_HELPER

// START_BLOCK_TREE_HELPERS
export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

export function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

export function textOf(node: XmlNode | undefined): string {
  return node ? node.text.trim() : "";
}

export function nonEmpty(node: XmlNode | undefined): boolean {
  return textOf(node) !== "";
}
// END_BLOCK_TREE_HELPERS

// START_BLOCK_CONTRACT_CHECKS
/** Report children that are neither allowed fixed names nor valid identity elements. */
export function checkChildren(
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
export function checkPackageLayout(file: string, findings: SpecLintFinding[]): void {
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
