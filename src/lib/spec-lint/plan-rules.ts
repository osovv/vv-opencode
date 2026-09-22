// FILE: src/lib/spec-lint/plan-rules.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Plan artifact rules: template compliance, task/wave identity, delegated execution-section and checkpoint validation, and delegated fact collection.
//   SCOPE: lintPlan over the positioned tree (status, architecture mirror, waves and TASK-T-NNN tasks, dependencies, snippet CDATA, lifecycle completeness, cross-file subset hookup), collectDelegatedTaskFacts shared with delegated extraction, lintExecutionSection with write-scope, checkpoint identity/coverage/scope/reviewer, final-coverage and wave-barrier rules, and lintDelegatedWriteScopes obligations.
//   DEPENDS: [src/lib/workflow-contract.ts, src/lib/spec-lint/parser.ts]
//   LINKS: [M-SPEC-LINT, M-WORKFLOW-CONTRACT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   DelegatedTaskFactsEntry - Per-task delegated facts collected for lint and extraction.
//   DelegatedTaskFacts - Wave order plus task facts plus duplicate element list.
//   collectDelegatedTaskFacts - Shared walk interpreting declared tasks and write scopes.
//   lintDelegatedWriteScopes - Write-scope obligations for delegated tasks.
//   lintExecutionSection - Execution mode and review-checkpoint validation.
//   lintPlan - Plan template, identity, reference, and lifecycle rules.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SPEC-LINT-RULES-SPLIT-R1 - Extracted plan rules, delegated fact collection, and execution-section validation from the former src/lib/spec-lint.ts monolith into this zone module.]
// END_CHANGE_SUMMARY

import { normalizeDeclaredScopePath } from "../workflow-contract.js";
import {
  ACCEPTANCE_CHILDREN,
  CHECKPOINT_CHILDREN,
  CHECKPOINT_COVERS_CHILDREN,
  CHECKPOINT_KINDS,
  CHECKPOINT_REVIEWERS_CHILDREN,
  CHECKPOINT_SCOPE_CHILDREN,
  checkChildren,
  checkPackageLayout,
  child,
  children,
  DELEGATED_REVIEWERS,
  DOC_STATUSES,
  EXECUTION_MODES,
  IDENTITY_PATTERNS,
  LINT_VERSION,
  nonEmpty,
  PLAN_CONTRACT,
  PLAN_FILE_CHILDREN,
  requiresCompleteness,
  SpecLintFinding,
  SpecLintOptions,
  SpecLintVerdict,
  TASK_CHILDREN,
  TASK_DEPENDS_CHILDREN,
  TASK_ID_REF,
  TASK_STATUSES,
  TASK_WRITE_SCOPE_CHILDREN,
  textOf,
  VERIFICATION_CHILDREN,
  WAVE_CHILDREN,
  type XmlNode,
} from "./parser.js";
import { resolveSpecFacts } from "./cross-file-rules.js";
import type { SpecFacts } from "./spec-rules.js";

// START_BLOCK_DELEGATED_FACTS
export interface DelegatedTaskFactsEntry {
  taskElement: string;
  taskId: string;
  wave: string;
  line: number;
  writeScope: string[];
  writeScopeDeclared: boolean;
  writeScopeDuplicates: string[];
  primaryFile: string;
  title: string;
  acceptance: string[];
  verification: string[];
  dependsOn: string[];
}

export interface DelegatedTaskFacts {
  waveOrder: string[];
  tasks: DelegatedTaskFactsEntry[];
  duplicateTaskElements: string[];
}

/**
 * Collect wave order and per-task delegated facts with a standalone walk so
 * lintPlan's main task validation and extractDelegatedPlanDefinition share one
 * interpretation of the declared task/write-scope vocabulary.
 */
export function collectDelegatedTaskFacts(root: XmlNode): DelegatedTaskFacts {
  const waveOrder: string[] = [];
  const tasks: DelegatedTaskFactsEntry[] = [];
  const duplicateTaskElements: string[] = [];
  const seenTasks = new Set<string>();

  const tasksNode = child(root, "tasks");
  if (!tasksNode) return { waveOrder, tasks, duplicateTaskElements };

  for (const wave of tasksNode.children) {
    if (!IDENTITY_PATTERNS.wave.test(wave.name)) continue;
    if (!waveOrder.includes(wave.name)) waveOrder.push(wave.name);
    for (const task of wave.children) {
      if (!IDENTITY_PATTERNS.task.test(task.name)) continue;
      if (seenTasks.has(task.name)) {
        duplicateTaskElements.push(task.name);
        continue;
      }
      seenTasks.add(task.name);
      const writeScopeNode = child(task, "write_scope");
      const writeScope: string[] = [];
      const writeScopeDuplicates: string[] = [];
      if (writeScopeNode) {
        for (const fileNode of writeScopeNode.children) {
          if (fileNode.name !== "file") continue;
          const normalized = normalizeDeclaredScopePath(textOf(fileNode));
          if (!normalized.ok) continue;
          if (writeScope.includes(normalized.path)) {
            // Duplicate write-scope entries are rejected by the lint rules;
            // here the duplicate is recorded so the rule can point at it.
            if (!writeScopeDuplicates.includes(normalized.path)) {
              writeScopeDuplicates.push(normalized.path);
            }
            continue;
          }
          writeScope.push(normalized.path);
        }
      }
      tasks.push({
        taskElement: task.name,
        taskId: task.name.slice("TASK-".length),
        wave: wave.name,
        line: task.line,
        writeScope,
        writeScopeDeclared: writeScopeNode !== undefined,
        writeScopeDuplicates,
        primaryFile: (() => {
          const normalized = normalizeDeclaredScopePath(textOf(child(task, "file")));
          return normalized.ok ? normalized.path : "";
        })(),
        title: textOf(child(task, "title")).trim(),
        acceptance: (() => {
          const acceptanceNode = child(task, "acceptance");
          return acceptanceNode
            ? children(acceptanceNode, "criterion")
                .map((entry) => textOf(entry).trim())
                .filter(Boolean)
            : [];
        })(),
        verification: (() => {
          const verificationNode = child(task, "verification");
          return verificationNode
            ? children(verificationNode, "command")
                .map((entry) => textOf(entry).trim())
                .filter(Boolean)
            : [];
        })(),
        dependsOn: (() => {
          const dependsNode = child(task, "depends_on");
          return dependsNode
            ? children(dependsNode, "task_id")
                .map((entry) => textOf(entry).trim())
                .filter(Boolean)
            : [];
        })(),
      });
    }
  }

  return { waveOrder, tasks, duplicateTaskElements };
}
// END_BLOCK_DELEGATED_FACTS

// START_BLOCK_DELEGATED_VALIDATION
/** Emit write-scope obligations for every declared delegated task. */
export function lintDelegatedWriteScopes(
  facts: DelegatedTaskFacts,
  completeness: boolean,
  findings: SpecLintFinding[],
  file: string,
): void {
  for (const task of facts.tasks) {
    if (task.writeScopeDuplicates.length > 0) {
      findings.push({
        severity: "error",
        rule: "execution.scope_path",
        message: `task ${task.taskId} declares write_scope path ${JSON.stringify(task.writeScopeDuplicates[0])} more than once; the runtime normalizer rejects duplicate scope entries`,
        file,
        line: task.line,
      });
      continue;
    }
    if (!task.writeScopeDeclared || task.writeScope.length === 0) {
      findings.push({
        severity: completeness ? "error" : "warning",
        rule: "lifecycle.required",
        message: `task ${task.taskId} declares no write_scope; delegated tasks must list their workspace-relative write scope`,
        file,
        line: task.line,
      });
      continue;
    }
    if (task.primaryFile && !task.writeScope.includes(task.primaryFile)) {
      findings.push({
        severity: "error",
        rule: "execution.write_scope",
        message: `task ${task.taskId} write_scope does not include its primary file ${task.primaryFile}`,
        file,
        line: task.line,
      });
    }
  }
}

/**
 * Validate the optional <execution> section. Structural violations of declared
 * content (unknown modes/children, duplicate identities, dangling references,
 * future-wave coverage, multiple or misplaced finals, incomplete declared
 * coverage) are always errors; presence obligations for approved/applied plans
 * escalate from draft warnings.
 */
export function lintExecutionSection(
  root: XmlNode,
  file: string,
  facts: DelegatedTaskFacts,
  completeness: boolean,
  findings: SpecLintFinding[],
): void {
  const executionNode = child(root, "execution");
  if (!executionNode) return;
  checkChildren(executionNode, PLAN_CONTRACT.execution, file, findings);

  const mode = textOf(child(executionNode, "mode"));
  if (!EXECUTION_MODES.has(mode)) {
    findings.push({
      severity: "error",
      rule: "execution.mode",
      message: `execution mode "${mode}" is not one of inline, classic, delegated`,
      file,
      line: child(executionNode, "mode")?.line ?? executionNode.line,
    });
  }

  const reviewCheckpointsNode = child(executionNode, "review_checkpoints");
  if (reviewCheckpointsNode && mode !== "delegated") {
    findings.push({
      severity: "error",
      rule: "execution.checkpoints_mode",
      message: `review_checkpoints are only valid with execution mode delegated, not "${mode}"`,
      file,
      line: reviewCheckpointsNode.line,
    });
    return;
  }
  if (mode !== "delegated") return;
  if (!reviewCheckpointsNode) {
    findings.push({
      severity: completeness ? "error" : "warning",
      rule: "lifecycle.required",
      message: `delegated execution declares no review_checkpoints; the plan is ${completeness ? "approved or applied" : "draft"} and must declare its checkpoint obligations`,
      file,
      line: executionNode.line,
    });
    // Task write-scope obligations still apply even without declared checkpoints.
    lintDelegatedWriteScopes(facts, completeness, findings, file);
    return;
  }

  checkChildren(reviewCheckpointsNode, PLAN_CONTRACT.review_checkpoints, file, findings);

  const obligation = (message: string, line: number, rule = "lifecycle.required"): void => {
    findings.push({
      severity: completeness ? "error" : "warning",
      rule,
      message,
      file,
      line,
    });
  };

  const waveIndex = new Map(facts.waveOrder.map((wave, index) => [wave, index] as const));
  const taskById = new Map(facts.tasks.map((task) => [task.taskId, task] as const));

  const seenCheckpoints = new Set<string>();
  const validCheckpoints: Array<{
    node: XmlNode;
    id: string;
    kind: string;
    afterWave: string;
    covers: string[];
    scope: string[];
    reviewers: string[];
  }> = [];

  for (const checkpoint of reviewCheckpointsNode.children) {
    if (!IDENTITY_PATTERNS.checkpoint.test(checkpoint.name)) {
      findings.push({
        severity: "error",
        rule: "identity.pattern",
        message: `checkpoint element <${checkpoint.name}> does not match the CHECKPOINT-R-NNN pattern`,
        file,
        line: checkpoint.line,
      });
      continue;
    }
    if (seenCheckpoints.has(checkpoint.name)) {
      findings.push({
        severity: "error",
        rule: "identity.duplicate",
        message: `checkpoint ${checkpoint.name} is declared more than once`,
        file,
        line: checkpoint.line,
      });
      continue;
    }
    seenCheckpoints.add(checkpoint.name);
    checkChildren(checkpoint, { names: CHECKPOINT_CHILDREN }, file, findings);

    const kind = textOf(child(checkpoint, "kind"));
    if (!CHECKPOINT_KINDS.has(kind)) {
      findings.push({
        severity: "error",
        rule: "execution.checkpoint_kind",
        message: `checkpoint ${checkpoint.name} kind "${kind}" is not one of milestone, final`,
        file,
        line: child(checkpoint, "kind")?.line ?? checkpoint.line,
      });
    }

    const afterWaveNode = child(checkpoint, "after_wave");
    const afterWave = textOf(afterWaveNode);
    let afterWaveKnown = false;
    if (!IDENTITY_PATTERNS.wave.test(afterWave) || !waveIndex.has(afterWave)) {
      findings.push({
        severity: "error",
        rule: "ref.dangling",
        message: `checkpoint ${checkpoint.name} after_wave "${afterWave}" is not a declared wave in this plan`,
        file,
        line: afterWaveNode?.line ?? checkpoint.line,
      });
    } else {
      afterWaveKnown = true;
    }

    const coversNode = child(checkpoint, "covers");
    const covers: string[] = [];
    if (coversNode) {
      checkChildren(coversNode, { names: CHECKPOINT_COVERS_CHILDREN }, file, findings);
      for (const taskRef of coversNode.children) {
        if (taskRef.name !== "task_id") continue;
        const value = textOf(taskRef);
        if (!TASK_ID_REF.test(value) || !taskById.has(value)) {
          findings.push({
            severity: "error",
            rule: "ref.dangling",
            message: `checkpoint ${checkpoint.name} covers task_id "${value}" which is not a declared task in this plan`,
            file,
            line: taskRef.line,
          });
          continue;
        }
        covers.push(value);
        const coveredTask = taskById.get(value);
        if (
          kind === "milestone" &&
          afterWaveKnown &&
          coveredTask &&
          (waveIndex.get(coveredTask.wave) ?? -1) > (waveIndex.get(afterWave) ?? -1)
        ) {
          findings.push({
            severity: "error",
            rule: "execution.future_coverage",
            message: `checkpoint ${checkpoint.name} (milestone after ${afterWave}) covers ${value} from a later wave ${coveredTask.wave}`,
            file,
            line: taskRef.line,
          });
        }
      }
    }

    const scopeNode = child(checkpoint, "scope");
    const scope: string[] = [];
    if (scopeNode) {
      checkChildren(scopeNode, { names: CHECKPOINT_SCOPE_CHILDREN }, file, findings);
      for (const fileNode of scopeNode.children) {
        if (fileNode.name !== "file") continue;
        const normalized = normalizeDeclaredScopePath(textOf(fileNode));
        if (!normalized.ok) {
          findings.push({
            severity: "error",
            rule: "execution.scope_path",
            message: `checkpoint ${checkpoint.name} declares a malformed scope path (${normalized.reason}): ${JSON.stringify(textOf(fileNode))}`,
            file,
            line: fileNode.line,
          });
          continue;
        }
        if (scope.includes(normalized.path)) {
          findings.push({
            severity: "error",
            rule: "execution.scope_path",
            message: `checkpoint ${checkpoint.name} declares scope path ${JSON.stringify(normalized.path)} more than once; the runtime normalizer rejects duplicate scope entries`,
            file,
            line: fileNode.line,
          });
          continue;
        }
        scope.push(normalized.path);
      }
    }

    const reviewersNode = child(checkpoint, "reviewers");
    const reviewers: string[] = [];
    if (reviewersNode) {
      checkChildren(reviewersNode, { names: CHECKPOINT_REVIEWERS_CHILDREN }, file, findings);
      for (const reviewerNode of reviewersNode.children) {
        if (reviewerNode.name !== "reviewer") continue;
        const value = textOf(reviewerNode);
        if (!DELEGATED_REVIEWERS.has(value)) {
          findings.push({
            severity: "error",
            rule: "execution.reviewer",
            message: `checkpoint ${checkpoint.name} reviewer "${value}" is not one of spec, code`,
            file,
            line: reviewerNode.line,
          });
          continue;
        }
        if (reviewers.includes(value)) {
          findings.push({
            severity: "error",
            rule: "execution.reviewer_duplicate",
            message: `checkpoint ${checkpoint.name} declares reviewer "${value}" more than once`,
            file,
            line: reviewerNode.line,
          });
          continue;
        }
        reviewers.push(value);
      }
    }

    const acceptanceNode = child(checkpoint, "acceptance");
    if (acceptanceNode)
      checkChildren(acceptanceNode, { names: ACCEPTANCE_CHILDREN }, file, findings);
    const verificationNode = child(checkpoint, "verification");
    if (verificationNode)
      checkChildren(verificationNode, { names: VERIFICATION_CHILDREN }, file, findings);

    if (covers.length === 0) {
      obligation(
        `checkpoint ${checkpoint.name} covers no tasks; delegated checkpoints must list covered task_ids`,
        coversNode?.line ?? checkpoint.line,
      );
    }
    if (scope.length === 0) {
      obligation(
        `checkpoint ${checkpoint.name} declares an empty scope; delegated checkpoints must list reviewed files`,
        scopeNode?.line ?? checkpoint.line,
      );
    }
    if (reviewers.length === 0) {
      obligation(
        `checkpoint ${checkpoint.name} declares no reviewers; delegated checkpoints require a non-empty spec/code reviewer set`,
        reviewersNode?.line ?? checkpoint.line,
      );
    }
    if (!acceptanceNode || children(acceptanceNode, "criterion").length === 0) {
      obligation(
        `checkpoint ${checkpoint.name} has no acceptance criteria`,
        acceptanceNode?.line ?? checkpoint.line,
      );
    }
    if (!verificationNode || children(verificationNode, "command").length === 0) {
      obligation(
        `checkpoint ${checkpoint.name} has no verification commands`,
        verificationNode?.line ?? checkpoint.line,
      );
    }

    validCheckpoints.push({
      node: checkpoint,
      id: checkpoint.name,
      kind,
      afterWave,
      covers,
      scope,
      reviewers,
    });
  }

  // Delegated task write-scope obligations.
  lintDelegatedWriteScopes(facts, completeness, findings, file);

  const finals = validCheckpoints.filter((c) => c.kind === "final");
  if (finals.length > 1) {
    for (const final of finals.slice(1)) {
      findings.push({
        severity: "error",
        rule: "execution.final_count",
        message: `checkpoint ${final.id} is an additional final checkpoint; exactly one final checkpoint is allowed`,
        file,
        line: final.node.line,
      });
    }
  }

  const declaredCheckpointCount = reviewCheckpointsNode.children.filter((c) =>
    IDENTITY_PATTERNS.checkpoint.test(c.name),
  ).length;
  if (finals.length === 0 && declaredCheckpointCount > 0) {
    obligation(
      "delegated execution declares no final checkpoint; exactly one final checkpoint is required",
      reviewCheckpointsNode.line,
      "execution.final_count",
    );
  }

  if (finals.length === 1) {
    const finalCheckpoint = finals[0];
    const lastWave = facts.waveOrder[facts.waveOrder.length - 1];
    if (
      lastWave &&
      finalCheckpoint.afterWave !== lastWave &&
      waveIndex.has(finalCheckpoint.afterWave)
    ) {
      findings.push({
        severity: "error",
        rule: "execution.final_wave",
        message: `final checkpoint ${finalCheckpoint.id} must sit after the last declared wave ${lastWave}, not ${finalCheckpoint.afterWave}`,
        file,
        line: finalCheckpoint.node.line,
      });
    }

    for (const task of facts.tasks) {
      if (!finalCheckpoint.covers.includes(task.taskId)) {
        findings.push({
          severity: "error",
          rule: "execution.final_coverage",
          message: `final checkpoint ${finalCheckpoint.id} does not cover task ${task.taskId}; the final checkpoint must cover every declared task`,
          file,
          line: finalCheckpoint.node.line,
        });
      }
    }

    const declaredWriteScopes = new Set(facts.tasks.flatMap((task) => task.writeScope));
    for (const scopeFile of declaredWriteScopes) {
      if (!finalCheckpoint.scope.includes(scopeFile)) {
        findings.push({
          severity: "error",
          rule: "execution.final_scope",
          message: `final checkpoint ${finalCheckpoint.id} scope does not cover declared task write scope file ${scopeFile}`,
          file,
          line: finalCheckpoint.node.line,
        });
      }
    }
  }
}
// END_BLOCK_DELEGATED_VALIDATION

// START_BLOCK_PLAN_RULES
export function lintPlan(
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
        const writeScopeNode = child(task, "write_scope");
        if (writeScopeNode)
          checkChildren(writeScopeNode, { names: TASK_WRITE_SCOPE_CHILDREN }, file, findings);

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

  // Optional execution section: delegated/classic/inline intent and checkpoints.
  lintExecutionSection(root, file, collectDelegatedTaskFacts(root), completeness, findings);

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
