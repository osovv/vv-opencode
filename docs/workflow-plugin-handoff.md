# WorkflowPlugin Handoff

Date: 2026-04-08
Project: `@osovv/vv-opencode`

## Goal

Transfer the current thinking about a future `WorkflowPlugin` / work-item protocol into another session.

This note summarizes:

- what the user is trying to solve
- how subagents are currently implemented in this repo
- where `work items` should attach in the current architecture
- the proposed protocol for strict work-item orchestration
- open design choices

## User Problem Statement

The user commonly works in this pattern:

- main session on a stronger / more expensive model
- cheap subagents used as workers
- repeated loop like `implementer -> spec-reviewer -> code-reviewer`

Observed failure mode:

- the workflow can keep looping for too many rounds
- this is not always a dumb exact-repeat loop
- often it is a higher-level convergence problem where review/fix/re-review keeps going too long

The user wants explicit workflow control, not semantic guesswork.

Important preference from the discussion:

- avoid fuzzy semantic grouping
- avoid embeddings / n-grams / similarity heuristics unless absolutely necessary
- prefer explicit IDs and simple counters
- prefer strict enforcement over `warn` mode
- `work_item_open` should be batch-oriented to avoid many roundtrips

## Prior Conceptual Decisions From The Discussion

These are the key decisions reached in the chat:

1. Do **not** call the new field `task_id`.
   OpenCode already uses `task_id` for resuming subagent sessions.

2. Use an explicit work-item header instead.
   Recommended header:

   ```text
   VVOC_WORK_ITEM_ID: wi-1
   ```

3. Allocate work items explicitly through a tool.
   Proposed tool name:

   - `work_item_open`

4. Make `work_item_open` batch-based.
   Example input:

   ```json
   {
     "items": [
       { "key": "1", "title": "SecretsRedactionPlugin" },
       { "key": "2", "title": "README sync" }
     ]
   }
   ```

5. Make validation strict.
   No `warn` mode was desired.

6. Reviewer-loop control should use dumb counters by explicit work item ID.
   Not semantic clustering.

7. Original desired product naming from the discussion was:

   - `vv-implementer`
   - `vv-spec-reviewer`
   - `vv-code-reviewer`
   - `vv-investigator`

   But the repo currently uses different managed subagent names; see the current architecture section below.

## Current Subagent Architecture In The Repo

### 1. Managed subagents are config-scaffolded, not runtime-installed plugins

Current managed subagents are defined in:

- `src/lib/managed-agents.ts`

Current names:

- `implementer`
- `spec-reviewer`
- `code-reviewer`
- `investigator`

Important detail:

- `investigator` is spelled exactly like that in the current codebase

Relevant source:

- `src/lib/managed-agents.ts:34-88`

### 2. Managed prompts live in vvoc-owned markdown files

Prompt templates are bundled in:

- `templates/agents/implementer.md`
- `templates/agents/spec-reviewer.md`
- `templates/agents/code-reviewer.md`
- `templates/agents/investigator.md`
- plus `guardian.md`

At runtime, `vvoc install` / `vvoc sync` materialize them into:

- global: `~/.config/vvoc/agents/*.md`
- project: `./.vvoc/agents/*.md`

Relevant source:

- `src/lib/managed-agents.ts:124-156`
- `src/lib/opencode.ts:323-368`
- `README.md:264-296`

### 3. Managed subagent registrations are written into `opencode.json`

The helper that does this is:

- `ensureManagedSubagentsConfigText(...)`

It registers each managed subagent as:

- `mode: "subagent"`
- `prompt: "{file:...}"`

Relevant source:

- `src/lib/opencode.ts:255-306`
- `src/lib/opencode.ts:1156-1181`

### 4. Runtime-installed plugin agents currently exist too

These are separate from the config-scaffolded managed subagents:

- `guardian` is installed by `GuardianPlugin`

Relevant source:

- `src/plugins/guardian/index.ts:1363-1506`

### 5. There is already a runtime hook point for intercepting tool calls

`GuardianPlugin` already uses:

- `tool.execute.before`

That is the cleanest current integration point for validating future `task` launches.

Relevant source:

- `src/plugins/guardian/index.ts:1486-1495`

### 6. There is already a runtime hook point for injecting system instructions

The Guardian plugin already uses:


Relevant source:

- `src/plugins/guardian/index.ts:1486-1495`

## Key Architectural Insight

`work item` should **not** be modeled as part of the subagent definition itself.

Why:

- subagent definitions are static
- prompt templates are static
- a `work item` exists only at the moment the main session launches a concrete task for a concrete plan item

Therefore:

- subagent registration is the list of *who can be tracked*
- `task` launch interception is where *which work item this run belongs to* should be enforced

This was the main conclusion from the discussion.

## Recommended Integration Model

### A. New runtime plugin

Introduce a new runtime plugin, likely named:

- `WorkflowPlugin`

Its responsibilities would be:

1. register a batch tool `work_item_open`
2. inject a system instruction into the main session explaining the protocol
3. intercept `task` launches via `tool.execute.before`
4. validate `VVOC_WORK_ITEM_ID`
5. count reviewer rounds by explicit work item id
6. enforce loop limits

### B. Keep work-item identity explicit

Do **not** infer work-item identity semantically.

Instead:

1. main session builds a plan
2. main session calls `work_item_open` once with the whole batch
3. tool returns stable IDs and exact headers
4. every tracked subagent launch must include that header in the prompt

### C. Strict prompt header protocol

Recommended prompt contract:

```text
VVOC_WORK_ITEM_ID: wi-1

<normal prompt body>
```

Preferred rule from the discussion:

- the header should be the first meaningful line
- ideally the literal first line for strictness

### D. Strict validation on `task` launches

At `tool.execute.before` for `task`:

1. inspect `output.args.subagent_type`
2. if it is a tracked managed subagent, parse `output.args.prompt`
3. require a valid `VVOC_WORK_ITEM_ID`
4. reject the launch if the ID is absent or invalid

Desired policy from the discussion:

- no `warn` mode
- fail closed

## Recommended `work_item_open` Shape

### Input

```json
{
  "items": [
    { "key": "1", "title": "SecretsRedactionPlugin" },
    { "key": "2", "title": "README sync" }
  ]
}
```

### Output

```json
{
  "items": [
    {
      "key": "1",
      "id": "wi-1",
      "title": "SecretsRedactionPlugin",
      "header": "VVOC_WORK_ITEM_ID: wi-1"
    },
    {
      "key": "2",
      "id": "wi-2",
      "title": "README sync",
      "header": "VVOC_WORK_ITEM_ID: wi-2"
    }
  ]
}
```

### Semantics

- `key` is used for idempotency inside the parent session
- repeated `work_item_open` with the same key should return the same ID
- same key + different title should be an error
- batch allocation was explicitly requested to avoid 10 roundtrips for 10 tasks

## Loop-Gating Model Discussed In The Chat

Use simple counters keyed by:

- `(parentSessionID, workItemID)`

Track at least:

- `spec-reviewer` count
- `code-reviewer` count
- `investigator` count

Possible `reviewRound` definition:

- `reviewRound = max(specReviewerCount, codeReviewerCount)`

Recommended policy discussed in the chat:

- rounds 1 and 2: allowed
- round 3: require one investigator escalation first
- after that: stop automatic looping and involve the user

The user specifically preferred:

- simple counters by explicit id
- not semantic clustering

## Naming Decision Still Open

There are two realistic paths.

### Option 1. Keep current managed subagent names

Use work-item orchestration with the current names:

- `implementer`
- `spec-reviewer`
- `code-reviewer`
- `investigator`

Pros:

- minimal migration
- fewer doc/config changes
- integrates directly with current `managed-agents.ts`

Cons:

- product naming stays less explicit
- typo `investigator` remains in the external surface

### Option 2. Migrate to vv-prefixed names

Rename managed subagents to:

- `vv-implementer`
- `vv-spec-reviewer`
- `vv-code-reviewer`
- `vv-investigator`

Pros:

- clearer product boundary
- matches the explicit discussion and desired future UX

Cons:

- broader migration across:
  - `managed-agents.ts`
  - templates
  - tests
  - README
  - CLI docs and model override helpers

No final choice was made yet.

## Recommendation For The Next Session

If the goal is fastest safe progress, do this first:

1. Keep current managed subagent names.
2. Add a new runtime `WorkflowPlugin`.
3. Implement `work_item_open`.
4. Add a main-session system instruction via `experimental.chat.system.transform`.
5. Validate tracked `task` launches via `tool.execute.before`.
6. Add simple explicit counters by work item ID.

This gives the work-item protocol without first doing a naming migration.

Then later, if desired, do a clean rename to `vv-*` as a separate change.

## Concrete Hook Points To Use

### System instruction hook

Use:

- `experimental.chat.system.transform`

Purpose:

- teach the main session to call `work_item_open`
- teach the main session to reuse the returned `VVOC_WORK_ITEM_ID`

Reference:


### Enforcement hook

Use:

- `tool.execute.before`

Purpose:

- intercept `task`
- inspect `subagent_type`
- validate prompt header
- enforce loop policy

Reference:

- `src/plugins/guardian/index.ts:1486-1495`

## Things Explicitly Rejected In The Discussion

The user pushed back against these directions:

- semantic clustering of related tasks
- text similarity / n-gram anti-loop logic as the primary mechanism
- `warn`-only validation
- complex fuzzy inference when explicit IDs can be used instead

The user explicitly preferred:

- explicit `work item` IDs
- batch allocation
- strict validation
- simple counters

## Useful File References For The Next Session

- `src/lib/managed-agents.ts`
- `src/lib/opencode.ts`
- `src/plugins/guardian/index.ts`
- `templates/agents/implementer.md`
- `templates/agents/spec-reviewer.md`
- `templates/agents/code-reviewer.md`
- `templates/agents/investigator.md`
- `README.md` sections:
  - `Managed agent prompts`
  - `Managed subagents`

## Suggested Prompt To Give The Next Session

Suggested instruction seed:

```text
Read docs/workflow-plugin-handoff.md first.

We want to design and likely implement a new WorkflowPlugin for vv-opencode.
Current managed subagents are implementer/spec-reviewer/code-reviewer/investigator from src/lib/managed-agents.ts.

Goal:
- add explicit batch work_item_open
- require VVOC_WORK_ITEM_ID on tracked task launches
- enforce this via tool.execute.before
- use simple counters by work item id for reviewer-loop gating
- avoid semantic heuristics

First, confirm the best integration path against the current codebase.
Then propose or implement the smallest coherent version.
```
