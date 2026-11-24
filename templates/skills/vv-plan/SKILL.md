---
name: vv-plan
description: Use AFTER an approved spec exists in .vvoc/specs/<id>/spec.xml — reads the approved spec and optional sibling design-context.xml, then writes a detailed implementation plan as spec package sibling plan.xml
---

<scope>
Take an approved spec and write an implementation plan — a contract-level document. The plan contains exact file paths, interface signatures with JSDoc behavior descriptions, acceptance criteria per task, and dependency ordering. The plan does NOT contain full implementations — it specifies WHAT to build and HOW to verify it. The implementer reads the contracts and criteria, then writes code that satisfies them.

An approved spec MUST exist at .vvoc/specs/&lt;id&gt;/spec.xml before planning begins. For newly created specs, vv-spec derives &lt;id&gt; as a date-prefixed package id in the form YYYY-MM-DD-&lt;slug&gt; from the feature name. Read the spec file in full. Check whether a sibling design-context.xml exists at .vvoc/specs/&lt;id&gt;/design-context.xml; if it exists, read it as explanatory context only. design-context.xml does NOT override or expand spec.xml — spec.xml remains normative and wins on conflicts.

The spec's top-level &lt;status&gt; MUST be approved. If the status is draft, missing, applied, or any other value, stop and tell the user the spec must be explicitly approved before planning. If no spec exists, stop and tell the user to invoke vv-spec first. Do not reinterpret or expand the spec: the plan implements ONLY what the spec describes. Do not treat design-context.xml as a requirements source.
</scope>

<workflow>
1. Read the approved spec in full and, when present, the sibling design-context.xml as explanatory context only.
2. Map the architecture: each plan component reuses the exact COMPONENT-UPPER-SLUG identity declared in spec.xml. Plan components are always a subset of spec components — a plan module without a spec component does not exist. Architecture child tags: name (display name from the spec), purpose, file (path, role), contract, depends_on (bare component slug). Do NOT add a child id element.
3. Write tasks grouped into waves: &lt;WAVE-1&gt;, &lt;WAVE-2&gt;, … Each wave contains a &lt;goal&gt; and its tasks. A task's identity is its element name in the TASK-T-NNN pattern: &lt;TASK-T-001&gt;…&lt;/TASK-T-001&gt;. Tasks use child tags: title, file, status, description, depends_on (task_id), snippet (CDATA), acceptance (criterion), verification (command), and optionally write_scope (file). Do NOT add a child id element — the element name is the single authoritative identity. Task-level &lt;status&gt; values are separate from the top-level plan lifecycle status and may remain pending until execution updates them.
4. Populate &lt;spec&gt; with the path to the spec.xml this plan implements. If a design-context.xml was found and read, populate &lt;design_context&gt; with its path so execution tools and reviewers can locate it.
5. Ask the user which execution intent the plan should declare — inline, classic, or delegated — while the plan is being drafted, and record it in an &lt;execution&gt; section with a &lt;mode&gt; child. If the user has no preference, omit the section entirely; a plan without &lt;execution&gt; keeps its legacy meaning and is never silently reinterpreted.
6. For delegated plans, declare the full vocabulary the runtime registers: a &lt;review_checkpoints&gt; container with unique CHECKPOINT-R-NNN elements. Each checkpoint carries kind (milestone or final), after_wave (the wave barrier), covers (task_id references), scope (workspace-relative file paths), reviewers (spec and/or code), acceptance (criterion), and verification (command). Delegated tasks MUST declare a &lt;write_scope&gt; with at least the task's primary &lt;file&gt;.
7. Run the self-review checks below and fix issues inline. No second review pass is needed — fix and continue.
8. Save the plan to .vvoc/specs/&lt;id&gt;/plan.xml with top-level status draft. Present the file path and ask the user to read/review and explicitly approve it. Do NOT offer execution options until the user approves.
9. If the user requests changes, keep the plan status as draft, make the changes, re-run self-review, save, and ask for approval again.
10. After explicit user approval, update the saved plan so the top-level status is approved, then present exactly inline, classic, and delegated and wait for the user's choice. Do NOT start implementation.
    - inline — execute tasks in this session.
    - classic — vv-implementer executes tasks, followed by required reviewers per task, using work_item_open with `mode: "implementation"` and explicit `requiredReviewers`, then work_item_close after the collect-all review round is ready to close.
    - delegated — workers implement bounded task packets, the controller accepts each attempt explicitly, and independent review happens at the plan's declared review checkpoints. Requires the delegated &lt;execution&gt; section with write scopes and checkpoints.
</workflow>

<rules>
- The top-level &lt;status&gt; element is the plan lifecycle status and MUST be one of: draft, approved, applied. When first saving, set draft. Change it to approved only after the user explicitly reads/reviews and approves the final plan, or after a recorded delegated authority explicitly covers the planning stage; a reserved plan-approval stop still waits. Never set applied yourself; applied is reserved for vv-execute after successful execution.
- Every XML element is named for grep extraction. Use `grep '&lt;TASK-T-' plan.xml` to list tasks, `grep '&lt;criterion&gt;' plan.xml` for all criteria, `grep '&lt;task_id&gt;' plan.xml` for the dependency graph, and `grep '&lt;COMPONENT-' plan.xml` for the component map.
- Milestones reflect contract or integration boundaries — not a fixed task-count interval. The default recommendation is a focused code review at meaningful intermediate milestones and spec plus code review at the final checkpoint; justify any larger reviewer set explicitly in the checkpoint's acceptance criteria. The exact reviewer set and milestones are explicit in this plan, never imposed by the runtime.
- The final checkpoint MUST sit after the last wave, cover every declared task, and its scope MUST cover every task write scope, so the complete current result receives fresh review before completion.
- Review coverage is not retroactive: later planned edits are covered by later checkpoints or the final checkpoint, not by an earlier milestone's approval. Adding a new execution policy to an already approved legacy plan requires an explicit agreed amendment; archived plans are never rewritten.
- Every task after the first must declare its dependencies in &lt;depends_on&gt;: `&lt;depends_on&gt;&lt;task_id&gt;T-001&lt;/task_id&gt;&lt;task_id&gt;T-002&lt;/task_id&gt;&lt;/depends_on&gt;`. The graph is grep-able with `grep '&lt;task_id&gt;' plan.xml`.
- Acceptance criteria: every task contains an &lt;acceptance&gt; section with one or more &lt;criterion&gt; elements. Each criterion is ONE specific, testable condition. If you cannot write a test for it, it is not specific enough. Criteria cover: success paths, failure paths, edge cases, boundary conditions, concurrency when relevant.
- Derive acceptance criteria and verification commands from the spec contract and the directly affected consumers, not from a preferred implementation. Criteria cover the material properties that must be preserved and the interactions with the consumers the change touches.
- Choose verification at the level where the risk arises: name the targeted command or scenario that exercises the changed behavior, and do not present a general check that cannot reach the changed path as evidence for a material criterion.
- Every criterion names the property it protects and the oracle that decides it. Every verification command must exercise the changed behavior and produce inspectable evidence; a check that cannot fail for the claimed reason is not evidence. Use the vv-verification references for oracle and evidence vocabulary rather than inventing a second taxonomy.
- Use plain English assertions: "Returns X when Y", "Throws Z if W", "Handles N concurrent calls without data loss". Each criterion is a separate &lt;criterion&gt; element; no numbered tags.
- File structure: before defining any tasks, map out every file that will be created or modified. Use exact relative paths from the project root. Mark each file Create, Modify, or Test. Prefer smaller focused files with one clear responsibility. Files that change together should live together; split by responsibility, not technical layer. In existing codebases, follow established file patterns.
- These are PLAN FAILURES and the plan is incomplete if any appear: TBD, TODO, "implement later", "fill in details", "add later"; "Add appropriate error handling" or "add validation" without the specific error types or validation rules; "Write tests for the above" without concrete acceptance criteria; empty &lt;contract&gt; or &lt;acceptance&gt; sections; "Similar to Task N" instead of repeating the full contract; references to types, functions, methods, or classes not defined in any prior task; XML attributes in any tag; code outside CDATA; numbered criterion tags; generic &lt;task&gt;, &lt;wave&gt;, or &lt;module&gt; elements with child id or num elements — identity belongs in the element name.
</rules>

<artifact>
Plan document format:
- Load the template from `references/plan-template.xml` and fill every element.
- The plan contains two major sections: architecture (components, contracts, dependencies) and tasks (implementation steps with code snippets).
- Save plan.xml as a sibling of spec.xml in the same spec package directory: .vvoc/specs/&lt;id&gt;/plan.xml.

Snippet format:
- Every task contains a &lt;snippet&gt; element wrapped in CDATA. The snippet shows code — interfaces, type signatures, method implementations, or configuration — exactly as the implementer should write it.
- Use JSDoc-style comments BEFORE each function, method, and type: `/** behavior description */`.
- Show constructor signatures, public method signatures, type parameters, return types. Include private fields if they define structural state. Include constant definitions, enum values, and configuration constants when they define the data model. Show implementation logic when it is the point of the contract — a small algorithm, a state transition, a conditional branching rule.
- CDATA wrapping is mandatory: `&lt;snippet&gt;&lt;![CDATA[...]]&gt;&lt;/snippet&gt;`. This protects against &lt; and &gt; in code breaking XML structure.

Example task:
<![CDATA[
<TASK-T-001>
  <title>LRU Cache Store</title>
  <file>src/lib/cache-store.ts</file>
  <status>pending</status>
  <description>Implement a size-bounded LRU cache with get, set, and clear operations</description>
  <snippet><![CDATA[
/** Options for configuring a CacheStore instance. */
export type CacheStoreOptions = {
  /** Maximum number of entries before eviction begins. */
  maxSize: number;
};

/**
 * A size-bounded store with least-recently-used eviction.
 * Get bumps the accessed key to most-recently-used position.
 */
export class CacheStore<T> {
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
  ]]></snippet>
  <acceptance>
    <criterion>get() returns undefined for a key that was never set</criterion>
    <criterion>get() returns the value stored by set() for the same key</criterion>
    <criterion>When at maxSize capacity, setting a new key evicts the least-recently-used entry</criterion>
    <criterion>get() on an existing key bumps it to MRU, protecting it from eviction</criterion>
    <criterion>set() on an existing key updates its value without evicting other entries</criterion>
  </acceptance>
  <verification>
    <command>bun test src/lib/cache-store.test.ts</command>
  </verification>
</TASK-T-001>
]]>

Self-review checks:
- Spec coverage: for each requirement in the spec, identify the task that implements it. List any gaps as issues to fix.
- Contract completeness: does every task's contract show all public signatures and types? Are edge cases covered by acceptance criteria?
- Acceptance criteria quality: is every criterion testable? Could a reviewer or implementer write a failing test for it? Are the material properties that must be preserved and the directly affected consumers covered by criteria whose verification actually reaches them?
- Verification intent: does every criterion name its property and oracle? Does every verification command produce inspectable evidence at the level the risk arises?
- Type consistency: do types, signatures, and property names match across tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.
- Format compliance: zero XML attributes, every snippet in CDATA, every task a &lt;TASK-T-NNN&gt; element with identity in the element name and no child id element.
- Architecture presence: every &lt;COMPONENT-UPPER-SLUG&gt; element exists in the spec's components section — plan components are a subset of spec components.
</artifact>

<refs>
- `references/plan-template.xml` — the plan document template; load before writing the plan and fill every element.
</refs>

<done>
An approved spec was read, the architecture and tasks were written with contracts and testable criteria, self-review issues were fixed, plan.xml was saved under .vvoc/specs/&lt;id&gt;/, the user explicitly approved it, the top-level status is approved, and exactly the three execution options were presented. Stop before implementation.
</done>
