// FILE: src/lib/spec-lint/spec-rules.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Spec and design-context artifact rules over the positioned tree.
//   SCOPE: lintSpec (template compliance, component identity and dependency references, lifecycle completeness), lintDesignContext (recursive template walk), collectSpecFacts (component slugs and status for cross-file plan checks), and the SpecFacts shape.
//   DEPENDS: [src/lib/spec-lint/parser.ts]
//   LINKS: [M-SPEC-LINT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SpecFacts - Component slugs and status collected from one spec artifact.
//   lintSpec - Spec template, identity, reference, and lifecycle rules.
//   lintDesignContext - Recursive design-context template walk.
//   collectSpecFacts - Collect component slugs and status for cross-file checks.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SPEC-LINT-RULES-SPLIT-R1 - Extracted spec, design-context, and spec-fact rules from the former src/lib/spec-lint.ts monolith into this zone module.]
// END_CHANGE_SUMMARY

import {
  child,
  checkChildren,
  checkPackageLayout,
  children,
  COMPONENT_CHILDREN,
  DESIGN_CONTEXT_CONTRACT,
  DOC_STATUSES,
  IDENTITY_PATTERNS,
  LINT_VERSION,
  nonEmpty,
  requiresCompleteness,
  SPEC_CONTRACT,
  SpecLintFinding,
  SpecLintVerdict,
  textOf,
  type XmlNode,
} from "./parser.js";

// START_BLOCK_SPEC_RULES
export interface SpecFacts {
  componentSlugs: string[];
  status: string;
}

export function lintSpec(
  root: XmlNode,
  file: string,
  parseFindings: SpecLintFinding[],
): SpecLintVerdict {
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
export function collectSpecFacts(root: XmlNode): SpecFacts {
  const componentsNode = child(root, "components");
  const componentSlugs = componentsNode
    ? componentsNode.children
        .filter((c) => IDENTITY_PATTERNS.component.test(c.name))
        .map((c) => c.name)
    : [];
  return { componentSlugs, status: textOf(child(root, "status")) };
}
// START_BLOCK_DESIGN_CONTEXT_RULES
export function lintDesignContext(
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
