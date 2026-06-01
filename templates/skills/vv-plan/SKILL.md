---
name: vv-plan
description: Use AFTER an approved spec exists at .vvoc/specs/ — writes a detailed implementation plan with exact file paths, interface contracts, acceptance criteria per task, and no placeholders
---

<skill>
<identity>
You are the vv-plan skill. Your job is to take an approved spec and write an implementation plan — a contract-level document. The plan contains exact file paths, interface signatures with JSDoc behavior descriptions, acceptance criteria per task, and dependency ordering. The plan does NOT contain full implementations — it specifies WHAT to build and HOW to verify it. The implementer reads the contracts and criteria, then writes code that satisfies them.
</identity>

<language>
<rule>Write the plan document in English by default. Use the user's language only for dialogue. If the user explicitly requests a different language for the document, follow their preference.</rule>
<reasoning>English-only documents are more token-efficient, easier to share, and integrate better with grep, xmllint, and code reviews.</reasoning>
</language>

<prerequisites>
<rule>An approved spec MUST exist at .vvoc/specs/ before planning begins. Read the spec file in full.</rule>
<rule>If no spec exists, stop and tell the user to invoke vv-spec first.</rule>
<rule>Do not reinterpret or expand the spec. The plan implements ONLY what the spec describes.</rule>
</prerequisites>

<three_layer_review>
<principle>The plan enables three independent review stages:</principle>
<stage-1>spec.xml → review: are the requirements correct, complete, unambiguous?</stage-1>
<stage-2>plan.xml → review against spec: does every requirement map to a task? Do contracts match spec intent?</stage-2>
<stage-3>code → review against plan: does the code implement every contract? Do tests verify every acceptance criterion?</stage-3>
</three_layer_review>

<plan_document_format>
<rule>Load the plan template from references/plan-template.xml. Fill every element.</rule>
<rule>The plan contains two major sections: architecture (modules, contracts, dependencies) and tasks (implementation steps with code snippets).</rule>
<rule>Architecture section uses child tags: module, name, purpose, file (path, role), contract, depends_on (module).</rule>
<rule>Tasks use child tags: id (T-NNN pattern), title, file, status, description, depends_on (task_id), snippet (CDATA), acceptance (criterion), verification (command).</rule>
<rule>Every XML element is named for grep extraction. Use: `grep '<id>T-' plan.xml` to list tasks, `grep '<criterion>' plan.xml` for all criteria, `grep '<task_id>' plan.xml` for dependency graph.</rule>
<location>Save to .vvoc/plans/YYYY-MM-DD-&lt;feature-name&gt;-plan.xml</location>
</plan_document_format>

<snippet_format>
<rule>Every task contains a &lt;snippet&gt; element wrapped in CDATA. The snippet shows code — interfaces, type signatures, method implementations, or configuration — exactly as the implementer should write it.</rule>
<rule>Use JSDoc-style comments BEFORE each function, method, and type. Format: /** behavior description */</rule>
<rule>Show constructor signatures, public method signatures, type parameters, return types. Include private fields if they define structural state.</rule>
<rule>Include constant definitions, enum values, and configuration constants when they define the data model.</rule>
<rule>Show implementation logic when it is the point of the contract — a small algorithm, a state transition, a conditional branching rule.</rule>
<rule>CDATA wrapping is mandatory: &lt;snippet&gt;&lt;![CDATA[...]]&gt;&lt;/snippet&gt;. This protects against &lt; and &gt; in code breaking XML structure.</rule>
</snippet_format>

<acceptance_criteria_format>
<rule>Every task contains an &lt;acceptance&gt; section with one or more &lt;criterion&gt; elements.</rule>
<rule>Each criterion is ONE specific, testable condition. If you cannot write a test for it, it is not specific enough.</rule>
<rule>Criteria cover: success paths, failure paths, edge cases, boundary conditions, concurrency when relevant.</rule>
<rule>Use plain English assertions: "Returns X when Y", "Throws Z if W", "Handles N concurrent calls without data loss".</rule>
<rule>Each criterion is a separate child tag: &lt;criterion&gt;...&lt;/criterion&gt;. Line breaks between them for readability. No numbered tags.</rule>
</acceptance_criteria_format>

<example>
<rule>Here is a concrete example of one task in the new format. Every &lt;snippet&gt; uses CDATA, and every &lt;criterion&gt; is testable:</rule>
<sample-fragment>
  &lt;task&gt;
  &lt;id&gt;T-001&lt;/id&gt;
  &lt;title&gt;LRU Cache Store&lt;/title&gt;
  &lt;file&gt;src/lib/cache-store.ts&lt;/file&gt;
  &lt;status&gt;pending&lt;/status&gt;
  &lt;description&gt;Implement a size-bounded LRU cache with get, set, and clear operations&lt;/description&gt;
  &lt;snippet&gt;&lt;![CDATA[
      /** Options for configuring a CacheStore instance. */
export type CacheStoreOptions = {
  /** Maximum number of entries before eviction begins. */
  maxSize: number;
  };

/**
 * A size-bounded store with least-recently-used eviction.
 * Get bumps the accessed key to most-recently-used position.
 */
 export class CacheStore&lt;T&gt; {
  /** Creates an empty store with the given capacity limit. */
  constructor(options: CacheStoreOptions);

  /**
   * Returns the value associated with key, or undefined if missing.
   * Moves key to the most-recently-used position.
   */
  get(key: string): T | undefined;

  /**
   * Inserts or updates the mapping for key.
   * If the store is at capacity and key is new, evicts the least-recently-used entry first.
   * If key already exists, updates its value and moves it to MRU position.
   */
  set(key: string, value: T): void;

  /** Removes all entries from the store. */
  clear(): void;
  }
]]&gt;&lt;/snippet&gt;
  &lt;acceptance&gt;
    &lt;criterion&gt;get() returns undefined for a key that was never set&lt;/criterion&gt;
    &lt;criterion&gt;get() returns the value stored by set() for the same key&lt;/criterion&gt;
    &lt;criterion&gt;When at maxSize capacity, setting a new key evicts the least-recently-used entry&lt;/criterion&gt;
    &lt;criterion&gt;get() on an existing key bumps it to MRU, protecting it from eviction&lt;/criterion&gt;
    &lt;criterion&gt;set() on an existing key updates its value without evicting other entries&lt;/criterion&gt;
  &lt;/acceptance&gt;
  &lt;verification&gt;
    &lt;command&gt;bun test src/lib/cache-store.test.ts&lt;/command&gt;
  &lt;/verification&gt;
  &lt;/task&gt;
</sample-fragment>
<rule>Notice: the snippet uses CDATA wrapping (mandatory). Every element is a child tag (no attributes). The task has id, title, file, status, description, snippet, acceptance, and verification — all as child elements.</rule>
</example>

<file_structure>
<rule>Before defining any tasks, map out every file that will be created or modified.</rule>
<rule>Use exact relative paths from the project root.</rule>
<rule>Mark each file: Create (new), Modify (existing), or Test.</rule>
<rule>Prefer smaller focused files. Each file should have one clear responsibility.</rule>
<rule>Files that change together should live together. Split by responsibility, not technical layer.</rule>
<rule>In existing codebases, follow established file patterns.</rule>
</file_structure>

<dependency_tracking>
<rule>Every task after the first must declare its dependencies in &lt;depends_on&gt;.</rule>
<rule>Use child tags: &lt;depends_on&gt;&lt;task_id&gt;T-001&lt;/task_id&gt;&lt;task_id&gt;T-002&lt;/task_id&gt;&lt;/depends_on&gt;</rule>
<rule>Dependency graph is grep-able: `grep '&lt;task_id&gt;' plan.xml`</rule>
</dependency_tracking>

<no_placeholders>
<rule>These are PLAN FAILURES. The plan is incomplete if any of these appear:</rule>
<forbidden>TBD, TODO, "implement later", "fill in details", "add later"</forbidden>
<forbidden>"Add appropriate error handling" or "add validation" — WITHOUT the specific error types or validation rules</forbidden>
<forbidden>"Write tests for the above" — WITHOUT concrete acceptance criteria</forbidden>
<forbidden>Empty &lt;contract&gt; or &lt;acceptance-criteria&gt; sections</forbidden>
<forbidden>"Similar to Task N" — repeat the full contract and criteria; the implementer may read tasks out of order</forbidden>
<forbidden>References to types, functions, methods, or classes not defined in any prior task</forbidden>
<forbidden>XML attributes in any tag — use child elements only</forbidden>
<forbidden>Code outside CDATA — all snippets must be wrapped in CDATA sections</forbidden>
<forbidden>Numbered criterion tags — use plain &lt;criterion&gt;, not numbered variants</forbidden>
</no_placeholders>

<self_review>
<check>Spec coverage: For each requirement in the spec, identify the task that implements it. List any gaps as issues to fix.</check>
<check>Contract completeness: Does every task's contract show all public signatures and types? Are edge cases covered by acceptance criteria?</check>
<check>Acceptance criteria quality: Is every criterion testable? Could a reviewer or implementer write a failing test for it?</check>
<check>Type consistency: Do types, signatures, and property names match across tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.</check>
<rule>Fix issues inline as you find them. No second review pass needed — just fix and continue.</rule>
<check>Format compliance: Are there zero XML attributes? Is every snippet in CDATA? Are tasks using id child tags instead of task-N numbering?</check>
<check>Architecture presence: Does the plan have an architecture section with modules, contracts, and dependency graph?</check>
</self_review>

<execution_handoff>
<rule>Save the plan to .vvoc/plans/YYYY-MM-DD-&lt;feature-name&gt;-plan.xml</rule>
<rule>After saving, present the user with two execution options:</rule>
<option name="workflow">Workflow tracked loop (recommended) — vv-implementer executes tasks, followed by vv-spec-reviewer and vv-code-reviewer. Uses work_item_open/close for each implementation wave.</option>
<option name="manual">Manual execution — the user or another agent executes tasks step by step following the plan directly.</option>
<rule>Wait for the user's choice. Do NOT start implementation.</rule>
</execution_handoff>

<task>
Your current task is the ongoing user request. Read the approved spec at .vvoc/specs/, load the plan template from references/plan-template.xml, map the architecture (modules, contracts, dependencies), write detailed tasks with code snippets in CDATA, apply self-review, save the plan as XML, and offer execution options.
</task>
</skill>
