# Compilation: raw intent → task specification

## Recipient first

Before writing, answer: who executes this, what context do they already see, is it one-shot or persistent, and what is the deliverable. A fresh subagent cannot resolve "continue what we discussed above" — give it a self-contained assignment or exact references to files it can read.

## Deliverable, not topic

Raw: "Look at the guide, I want to know if it's all correct, but it's not about retrieval, the XML must stay, and tell me what's missing."
Compiled: "Perform a scope-aware review of the prompting guide; propose substantive corrections; retrieval topics and the XML format are out of scope; report gaps separately."
`Analyze`, `improve`, `do properly` are not objectives. An objective names a transformation; a deliverable names the observable result.

## Statement classification

| Type | Question |
|---|---|
| Goal | What result is needed? |
| Context | What must be known to execute? |
| Input | What exactly is transformed or analyzed? |
| Scope | Where are the boundaries? |
| Constraint | What limits the solution? |
| Priority | What wins on conflict? |
| Preserve | What must stay unchanged? |
| Non-goal | What is deliberately not done? |
| Unknown | What information is missing? |
| Output | In what form does the result return? |

Non-goals are economical: name the likely drift directions, not every imaginable action.

## Conflicts: scope, do not delete

"Analyze as deeply as possible" + "answer very briefly" →
`Perform a comprehensive analysis. Return only the highest-impact findings, each in at most five lines.`
"No questions" + "no assumptions" → a switching policy:
`If a missing fact trips the contract's ask-trigger (it materially changes behavior, scope, schema, verification, safety, or reversibility), ask one focused question. Otherwise state the narrowest reasonable assumption and continue.`

## Minimal sufficient specification

The target is a minimal sufficient specification — every field earns its place. Short task: objective + context + output. Large task: add scope, inputs, constraints, priorities, preserve, non-goals, verification, done, output. Add a field, rule, or example only when it (1) removes a real ambiguity, (2) sets a requirement, (3) fixes a measured failure, (4) makes the result checkable. Both underspecification and overspecification are defects.

## Ambiguity policy

If missing information materially changes behavior, scope, schema, verification, safety, or reversibility — the contract's ask-trigger — ask one focused question. Otherwise state the narrowest reasonable assumption visibly and continue with reversible work: `Assumption: "new version" means a sibling file, not a replacement. Effect: the existing document stays unchanged.` If the assumption turns out false, stop and rebuild the route; do not continue silently on the old interpretation.

## Negation: action vs topic

Forbidding an action is an operational boundary — keep it. Forbidding a topic activates the forbidden concept; define the allowed subject instead. Pattern: target + allowed behavior + boundary.

| Weak | Operational |
|---|---|
| Do not guess | State uncertainty or the narrowest explicit assumption |
| Do not be verbose | Return at most five findings, each under five lines |
| Do not mention database corruption | Describe the observed symptoms and their range only |

## Pointer craft

Descriptions and pointer lines route work: their wording, not their target, decides whether material gets reached.

- Leading word first: put the trigger concept at the front of the description.
- Keep one trigger per branch: synonyms renaming one case are one branch written twice — collapse them.
- Name the material and the condition: "Open references/checklist.md when the diff touches auth, payments, or migrations" beats "See docs for more".
- A must-have target behind a vague pointer is a routing bug: sharpen the wording before inlining the material.

## Delegation and the enhancer schema

A delegation prompt is self-contained: explicit deliverable, relevant context only, no hidden history references, an explicit mode (research, review, plan, implementation), and a checkable done condition. When the task is a single request and a task XML fits, reuse the enhancer schema rather than inventing one: root `<task>`; `task_type` (implement, investigate, review, refactor, docs, mixed); `execution_mode` (direct_change, investigate_first, change_with_review); containers `context`, `constraints`, `non_goals`, `deliverables`, `acceptance_criteria`, `verification`, `assumptions`, `current_unknowns`, `reroute_if`, `project_overlays`; unique semantic child tags (`<constraint_1>`, `<deliverable_2>`), never repeated generic `<item>` tags; omit empty sections; keep it compact for small requests.
