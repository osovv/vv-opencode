# vvoc agent tool contracts

Generated from the pure tool catalog. Do not edit by hand; run `bun run contracts:generate`.

- Package: `@osovv/vv-opencode@2.0.1`
- Tool contract revision: `1`
- Reference path: `templates/skills/vv-execute/references/tool-contracts.md`
- Current model-facing size: descriptions 8794 bytes, published input schemas 22572 bytes
- Baseline (commit f4319f8, SDK @opencode-ai/plugin@1.18.2, source-extraction): descriptions 8796 bytes, projected input schemas 6815 bytes

> Schema acceptance is structural only. It is not authorization, not proof of evidence,
> not reviewer acceptance, and not permission for a workflow transition. A declared
> `writeScope` is an edit boundary, not a universal sandbox, and no tool here grants a
> state transition on its own.

## Reading guide

This is an on-demand reference; load only the tool section you need rather than the whole manual. Each tool section lists a closed field table, closed vocabularies, execute-time defaults, state/host prerequisites, conditional requirements, declared path kinds, result families, representative failures, and checked accept/reject examples. Tool sections: `work_item_open`, `work_item_list`, `work_item_close`, `work_item_decide`, `work_checkpoint`, `hashline_edit`, `str_replace_editor`, `web_search`, `web_fetch`.

## Tools

### `work_item_open`

- Summary: Open one or more work items idempotently, or register/append generic execution tasks.
- Description: Open one or more workflow work items idempotently with explicit mode and requiredReviewers.

| field | type | required | description |
| --- | --- | --- | --- |
| `items` | array | yes | Non-empty batch of work items or generic task bindings (unbounded count). |
| `execution` | object | no | Generic execution descriptor for registration; mutually exclusive with runId. Requires the trusted workspace root from the plugin context. |
| `runId` | string | no | Existing generic execution to append to; mutually exclusive with execution. |
| `amendmentId` | string | no | Bounded amendment identity (trimmed, at most 128 characters); required with runId appends. |
| `rationale` | string | no | Bounded amendment rationale; required with runId appends. |

Closed vocabularies:
- `items[].mode`: implementation | review_only | delegated
- `execution.source.kind`: conversation-scoped | provided-plan

State/host prerequisites:
- trusted workspace root from the plugin context for every generic registration
- existing generic runId for appends

Conditional requirements:
- execution and runId are mutually exclusive
- amendmentId and rationale are only valid with a runId append
- generic items require mode delegated and a non-empty write scope of exact files
- standalone implementation/review_only require a unique non-empty reviewer set and forbid writeScope

Path kinds:
- `items[].writeScope[]` (exact-file): workspace-relative exact file paths; wildcards, traversal, absolute/home/drive paths, backslashes, and trailing separators are rejected
- `execution.boundary.files[]` (exact-file): workspace-relative exact file paths inside the execution boundary
- `execution.boundary.directories[]` (directory-subtree): workspace-relative directory subtrees; one trailing separator is normalized away

Result families:
- `work_item_open:batch`: standalone batch envelope (per-item ok/failure, no top-level ok)
- `work_item_open:batch-failure`: standalone batch envelope with a per-item failure
- `work_item_open:register`: generic execution registration
- `work_item_open:amend`: generic execution amendment
- `work_item_open:failure`: bounded owned failure

Representative failures:
- `items[0].typo`: unknown nested item key is rejected with its path
- `execution.source.reference`: provided plan without a reference names the source field

Checked examples:
- `work_item_open:standalone-implementation` (accept):
  ```json
  {
    "items": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "implementation",
        "requiredReviewers": [
          "spec"
        ]
      }
    ]
  }
  ```
- `work_item_open:standalone-review-only` (accept):
  ```json
  {
    "items": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "review_only",
        "requiredReviewers": [
          "spec"
        ]
      }
    ]
  }
  ```
- `work_item_open:standalone-delegated` (accept):
  ```json
  {
    "items": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "delegated",
        "requiredReviewers": [],
        "writeScope": [
          "src/lib/a.ts"
        ]
      }
    ]
  }
  ```
- `work_item_open:generic-register-conversation` (accept):
  ```json
  {
    "items": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "delegated",
        "requiredReviewers": [],
        "writeScope": [
          "src/lib/a.ts"
        ],
        "taskId": "T-100"
      }
    ],
    "execution": {
      "executionKey": "exec-1",
      "source": {
        "kind": "conversation-scoped"
      },
      "goal": "Deliver the scoped work.",
      "boundary": {
        "files": [
          "src/lib/a.ts"
        ],
        "directories": [
          "src/lib/"
        ]
      }
    }
  }
  ```
- `work_item_open:generic-register-provided-plan` (accept):
  ```json
  {
    "items": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "delegated",
        "requiredReviewers": [],
        "writeScope": [
          "src/lib/a.ts"
        ],
        "taskId": "T-101"
      }
    ],
    "execution": {
      "executionKey": "exec-2",
      "source": {
        "kind": "provided-plan",
        "reference": "docs/plan.xml",
        "sha256": "abc123"
      },
      "goal": "Deliver the provided plan.",
      "boundary": {
        "files": [
          "src/lib/a.ts"
        ],
        "directories": []
      }
    }
  }
  ```
- `work_item_open:generic-append` (accept):
  ```json
  {
    "items": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "delegated",
        "requiredReviewers": [],
        "writeScope": [
          "src/lib/a.ts"
        ],
        "taskId": "T-102"
      }
    ],
    "runId": "run-existing",
    "amendmentId": "amend-1",
    "rationale": "Append the follow-up."
  }
  ```
- `work_item_open:reject-unknown-key` (reject):
  ```json
  {
    "items": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "implementation",
        "requiredReviewers": [
          "spec"
        ],
        "typo": true
      }
    ]
  }
  ```
- `work_item_open:reject-unsupported-mode` (reject):
  ```json
  {
    "items": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "review",
        "requiredReviewers": [
          "spec"
        ]
      }
    ]
  }
  ```
- `work_item_open:reject-empty-items` (reject):
  ```json
  {
    "items": []
  }
  ```
- `work_item_open:reject-empty-reviewers` (reject):
  ```json
  {
    "items": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "implementation",
        "requiredReviewers": []
      }
    ]
  }
  ```
- `work_item_open:reject-execution-and-runid` (reject):
  ```json
  {
    "items": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "delegated",
        "requiredReviewers": [],
        "writeScope": [
          "src/lib/a.ts"
        ]
      }
    ],
    "runId": "run-1",
    "execution": {
      "executionKey": "exec-1",
      "source": {
        "kind": "conversation-scoped"
      },
      "goal": "Deliver.",
      "boundary": {
        "files": [
          "src/lib/a.ts"
        ],
        "directories": []
      }
    }
  }
  ```
- `work_item_open:reject-unsupported-source-kind` (reject):
  ```json
  {
    "items": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "delegated",
        "requiredReviewers": [],
        "writeScope": [
          "src/lib/a.ts"
        ]
      }
    ],
    "execution": {
      "executionKey": "exec-1",
      "source": {
        "kind": "native-package"
      },
      "goal": "Deliver.",
      "boundary": {
        "files": [
          "src/lib/a.ts"
        ],
        "directories": []
      }
    }
  }
  ```
- `work_item_open:reject-provided-plan-missing-reference` (reject):
  ```json
  {
    "items": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "delegated",
        "requiredReviewers": [],
        "writeScope": [
          "src/lib/a.ts"
        ]
      }
    ],
    "execution": {
      "executionKey": "exec-1",
      "source": {
        "kind": "provided-plan"
      },
      "goal": "Deliver.",
      "boundary": {
        "files": [
          "src/lib/a.ts"
        ],
        "directories": []
      }
    }
  }
  ```
- `work_item_open:reject-delegated-reviewers` (reject):
  ```json
  {
    "items": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "delegated",
        "requiredReviewers": [
          "spec"
        ],
        "writeScope": [
          "src/lib/a.ts"
        ]
      }
    ]
  }
  ```
- `work_item_open:reject-review-only-empty-reviewers` (reject):
  ```json
  {
    "items": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "review_only",
        "requiredReviewers": []
      }
    ]
  }
  ```
- `work_item_open:reject-generic-register-missing-goal` (reject):
  ```json
  {
    "items": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "delegated",
        "requiredReviewers": [],
        "writeScope": [
          "src/lib/a.ts"
        ]
      }
    ],
    "execution": {
      "executionKey": "exec-1",
      "source": {
        "kind": "conversation-scoped"
      },
      "goal": "   ",
      "boundary": {
        "files": [
          "src/lib/a.ts"
        ],
        "directories": []
      }
    }
  }
  ```
- `work_item_open:reject-generic-append-missing-amendment` (reject):
  ```json
  {
    "items": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "delegated",
        "requiredReviewers": [],
        "writeScope": [
          "src/lib/a.ts"
        ]
      }
    ],
    "runId": "run-existing"
  }
  ```

### `work_item_list`

- Summary: List current-session work items, native plan runs, and generic executions with contract identity.
- Description: List workflow work items for the current session.

| field | type | required | description |
| --- | --- | --- | --- |
| `includeClosed` | boolean | no | Include closed work items in the listing; defaults to false. |

State/host prerequisites:
- same-session store hydration from the plugin context

Conditional requirements:
- includeClosed defaults to false and is optional

Result families:
- `work_item_list:view`: inspection view with loaded contract identity
- `work_item_list:failure`: bounded owned failure

Representative failures:
- `includeClosed`: a non-boolean value is rejected rather than coerced

Checked examples:
- `work_item_list:default` (accept):
  ```json
  {}
  ```
- `work_item_list:include-closed` (accept):
  ```json
  {
    "includeClosed": true
  }
  ```
- `work_item_list:reject-unknown-key` (reject):
  ```json
  {
    "includeClosed": false,
    "extra": true
  }
  ```
- `work_item_list:reject-wrong-type` (reject):
  ```json
  {
    "includeClosed": "true"
  }
  ```
- `work_item_list:reject-unknown-key-default` (reject):
  ```json
  {
    "extra": true
  }
  ```
- `work_item_list:reject-unknown-key-include-closed` (reject):
  ```json
  {
    "includeClosed": true,
    "extra": true
  }
  ```

### `work_item_close`

- Summary: Close a same-session work item once its reviews are complete and no concerns remain open.
- Description: Close a workflow work item by id when it is ready_to_close.

| field | type | required | description |
| --- | --- | --- | --- |
| `workItemId` | string | yes | Non-empty id of the work item to close. |

State/host prerequisites:
- same-session work item in ready_to_close state

Conditional requirements:
- open concerns or pending reviews refuse the close with the unmet prerequisite

Result families:
- `work_item_close:success`: closed work item
- `work_item_close:failure`: bounded owned failure

Representative failures:
- `workItemId`: blank ids are rejected before any state mutation

Checked examples:
- `work_item_close:close` (accept):
  ```json
  {
    "workItemId": "wi-1"
  }
  ```
- `work_item_close:reject-unknown-key` (reject):
  ```json
  {
    "workItemId": "wi-1",
    "extra": true
  }
  ```
- `work_item_close:reject-blank-id` (reject):
  ```json
  {
    "workItemId": "   "
  }
  ```

### `work_item_decide`

- Summary: Accept, request changes, authorize bounded rework, or recover a stopped delegated attempt.
- Description: Accept or request changes for the current completed delegated attempt, authorize bounded rework of an accepted task from a failed checkpoint, or recover a stopped or exhausted unaccepted task with a bounded diagnosis and changed condition.

| field | type | required | description |
| --- | --- | --- | --- |
| `workItemId` | string | yes | Non-empty id of the delegated work item (trimmed). |
| `attempt` | integer | yes | Positive integer attempt number the decision targets. |
| `decision` | enum(accept \| request_changes \| rework \| recover) | yes | Controller decision family for this call. |
| `rationale` | string | no | Bounded rationale (trimmed, at most 2000 characters). Required non-empty for accept/request_changes; optional reason for rework. |
| `evidence` | array | no | Bounded evidence references (at most 8). Required non-empty for accept/request_changes. |
| `concernsDisposition` | string | no | Bounded disposition of recorded concerns; required by the domain only when the terminal record demands it. |
| `runId` | string | no | Failed-checkpoint run for rework, or authority-owning run for recover. |
| `checkpointId` | string | no | Failed checkpoint id; required for rework. |
| `diagnosis` | string | no | Bounded recovery diagnosis; required non-empty for recover. |
| `changedCondition` | string | no | Bounded changed condition; required non-empty for recover. |
| `verification` | array | no | Bounded verification references (at most 8); required non-empty for recover. |
| `recoveryId` | string | no | Stable recovery identity (trimmed, at most 512 characters); required for recover. |
| `userMessageId` | string | no | Optional root-user authorization message id for recover. |
| `authorityId` | string | no | Recorded advance authority funding recover; requires the owning runId. |

Closed vocabularies:
- `decision`: accept | request_changes | rework | recover

State/host prerequisites:
- latest completed attempt identity and terminal status
- recorded concerns disposition when the terminal record requires one

Conditional requirements:
- accept/request_changes require balanced rationale and evidence
- rework requires its failed checkpoint binding
- recover requires recoveryId, diagnosis, changedCondition, and verification; runId only accompanies authorityId
- concernsDisposition is conditional on the recorded terminal status, not a caller-supplied status

Result families:
- `work_item_decide:accept-or-request-changes`: decision outcome (accept/request_changes)
- `work_item_decide:rework`: rework authorization outcome
- `work_item_decide:recover`: recovery outcome
- `work_item_decide:failure`: bounded owned failure

Representative failures:
- `evidence`: missing required evidence names the field
- `runId`: runId without authorityId is a conflict, not silently dropped

Checked examples:
- `work_item_decide:accept` (accept):
  ```json
  {
    "workItemId": "wi-1",
    "attempt": 1,
    "decision": "accept",
    "rationale": "Verified against the acceptance criteria.",
    "evidence": [
      "bun test"
    ]
  }
  ```
- `work_item_decide:request-changes` (accept):
  ```json
  {
    "workItemId": "wi-1",
    "attempt": 1,
    "decision": "request_changes",
    "rationale": "Fix the edge case.",
    "evidence": [
      "review note"
    ],
    "concernsDisposition": "Resolved after rework."
  }
  ```
- `work_item_decide:rework` (accept):
  ```json
  {
    "workItemId": "wi-1",
    "attempt": 1,
    "decision": "rework",
    "runId": "run-1",
    "checkpointId": "C-1",
    "rationale": "Checkpoint failed."
  }
  ```
- `work_item_decide:recover` (accept):
  ```json
  {
    "workItemId": "wi-1",
    "attempt": 2,
    "decision": "recover",
    "recoveryId": "rec-1",
    "diagnosis": "Both attempts stopped.",
    "changedCondition": "Packet clarified.",
    "verification": [
      "bun test"
    ]
  }
  ```
- `work_item_decide:recover-authority` (accept):
  ```json
  {
    "workItemId": "wi-1",
    "attempt": 2,
    "decision": "recover",
    "recoveryId": "rec-2",
    "diagnosis": "Reserve advance.",
    "changedCondition": "Authority recorded.",
    "verification": [
      "bun test"
    ],
    "authorityId": "auth-1",
    "runId": "run-1"
  }
  ```
- `work_item_decide:reject-unknown-key` (reject):
  ```json
  {
    "workItemId": "wi-1",
    "attempt": 1,
    "decision": "accept",
    "rationale": "ok",
    "evidence": [
      "x"
    ],
    "typo": true
  }
  ```
- `work_item_decide:reject-unsupported-decision` (reject):
  ```json
  {
    "workItemId": "wi-1",
    "attempt": 1,
    "decision": "approve"
  }
  ```
- `work_item_decide:reject-missing-evidence` (reject):
  ```json
  {
    "workItemId": "wi-1",
    "attempt": 1,
    "decision": "accept",
    "rationale": "ok"
  }
  ```
- `work_item_decide:reject-request-changes-missing-evidence` (reject):
  ```json
  {
    "workItemId": "wi-1",
    "attempt": 1,
    "decision": "request_changes"
  }
  ```
- `work_item_decide:reject-rework-missing-checkpoint` (reject):
  ```json
  {
    "workItemId": "wi-1",
    "attempt": 1,
    "decision": "rework"
  }
  ```
- `work_item_decide:reject-unconsumed-field` (reject):
  ```json
  {
    "workItemId": "wi-1",
    "attempt": 1,
    "decision": "accept",
    "rationale": "ok",
    "evidence": [
      "x"
    ],
    "recoveryId": "rec-1"
  }
  ```
- `work_item_decide:reject-runid-without-authority` (reject):
  ```json
  {
    "workItemId": "wi-1",
    "attempt": 2,
    "decision": "recover",
    "runId": "run-1",
    "recoveryId": "rec-1",
    "diagnosis": "d",
    "changedCondition": "c",
    "verification": [
      "v"
    ]
  }
  ```

### `work_checkpoint`

- Summary: Register, start, verify, review, bind, amend, complete, or authorize/recover checkpoints and authority.
- Description: Register an approved delegated plan, start a declared review checkpoint, verify checkpoint outcomes, or recover a stopped or generation-exhausted checkpoint; verify with complete: true seals a finished final checkpoint.

| field | type | required | description |
| --- | --- | --- | --- |
| `action` | enum(register \| start \| verify \| recover \| review \| bind \| complete \| amend \| authorize \| record_approval \| revoke_authority) | yes | Checkpoint/authority action to perform. |
| `planPath` | string | no | Workspace-relative approved native plan path (trimmed, non-empty); native register only, never combined with runId. |
| `runId` | string | no | Target execution run. Required for every action except native register with planPath. |
| `checkpointId` | string | no | Checkpoint id (trimmed, at most 128 characters); required for start/verify/recover/review/bind. |
| `complete` | boolean | no | Seal a finished final checkpoint on verify. |
| `diagnosis` | string | no | Bounded recovery diagnosis; required non-empty for recover. |
| `changedCondition` | string | no | Bounded changed condition; required non-empty for recover. |
| `verification` | array | no | Bounded verification references (at most 8); required non-empty for recover and optional completion evidence for complete. |
| `recoveryId` | string | no | Stable recovery identity (trimmed, at most 512 characters); required for recover. |
| `userMessageId` | string | no | Root-user authorization message id; native-package checkpoint recovery only, not generic recovery. |
| `checkpoints` | array | no | Typed checkpoint contracts for generic register/amend batches (unbounded count). |
| `tasks` | array | no | Typed task items for generic register/amend batches (unbounded count). |
| `amendmentId` | string | no | Bounded amendment identity (trimmed, at most 128 characters); required for generic register/amend. |
| `rationale` | string | no | Bounded rationale; required for generic register/amend, optional context for complete/revocation. |
| `startFingerprint` | string | no | Optional expected start fingerprint for generic start. |
| `reviewer` | enum(spec \| code) | no | Optional canonical reviewer role for generic review/bind/verify. |
| `authorityId` | string | no | Recorded advance authority for authorize/approval/revocation or recover. |
| `messageId` | string | no | Eligible root-user authorization message id; required for authorize. |
| `approvalId` | string | no | Bounded stage-approval identity; required for record_approval. |
| `stage` | enum(specification \| planning \| implementation \| verification) | no | Authority stage being approved; required for record_approval. |
| `stages` | array | no | Delegatable stages (unbounded count). Required non-empty for authorize; optional surviving-stage set for revoke_authority narrowing. Every entry must be canonic |
| `decisionScope` | string | no | Bounded decision scope recorded with an authority grant; authorize only. An explicitly empty value keeps the documented empty default. |
| `fileBoundary` | array | no | File boundary recorded with an authority grant (unbounded count); authorize only. |
| `reservedStops` | array | no | Reserved lifecycle stops retained for explicit user action (unbounded count); every entry must be a canonical stage. authorize only; defaults to none. |
| `artifactPath` | string | no | Approved artifact path; required for record_approval. |
| `artifactSha256` | string | no | Approved artifact hash; required for record_approval. |
| `revocationId` | string | no | Bounded revocation identity; required for revoke_authority. |

Closed vocabularies:
- `action`: register | start | verify | recover | review | bind | complete | amend | authorize | record_approval | revoke_authority

State/host prerequisites:
- source (native planPath or generic runId) resolved before source-dependent validation
- eligible root-user authorization message for authorize

Conditional requirements:
- native register uses planPath and rejects runId; generic register appends a task batch to an existing runId with amendmentId and rationale
- generic review, bind, and verify consume the linked reviewer items' recorded outcomes; the reviewer callID launch binding happens in the host hook, not through this action
- native verify with complete:true seals only an eligible final checkpoint; generic executions seal through the complete action
- work_checkpoint recover consumes userMessageId only for native-package checkpoints: a generic checkpoint recover rejects userMessageId (a stopped generation resumes cost-free, an exhausted one needs a recorded advance authorityId with its runId). work_item_decide recover accepts userMessageId for standalone, native, and generic execution tasks
- authorize/record_approval/revoke_authority validate every supplied stage/stop before any ledger write

Path kinds:
- `planPath` (exact-file): workspace-relative approved native plan path; native register only
- `fileBoundary[]` (exact-file): workspace-relative exact files recorded with an authority grant
- `artifactPath` (exact-file): approved artifact path recorded with a stage approval

Result families:
- `work_checkpoint:register`: registration/amendment summary
- `work_checkpoint:amend`: generic amendment view
- `work_checkpoint:start`: started generation with reviewers to launch
- `work_checkpoint:verify-native`: native verify outcome
- `work_checkpoint:review-bind-verify`: generic review/bind/verify outcome
- `work_checkpoint:recover`: checkpoint recovery outcome
- `work_checkpoint:complete`: sealed execution
- `work_checkpoint:authorize`: authority grant/extension
- `work_checkpoint:record-approval`: stage approval record
- `work_checkpoint:revoke-authority`: authority revocation
- `work_checkpoint:failure`: bounded owned failure

Representative failures:
- `reservedStops[0]`: a misspelled stage rejects and never becomes a silent omission
- `action`: a field consumed by another action is rejected, not ignored

Checked examples:
- `work_checkpoint:register-native` (accept):
  ```json
  {
    "action": "register",
    "planPath": ".vvoc/specs/x/plan.xml"
  }
  ```
- `work_checkpoint:register-generic` (accept):
  ```json
  {
    "action": "register",
    "runId": "run-1",
    "amendmentId": "amend-1",
    "rationale": "Append a task batch to the existing run.",
    "tasks": [
      {
        "key": "task-key",
        "title": "Task title",
        "mode": "delegated",
        "requiredReviewers": [],
        "writeScope": [
          "src/lib/a.ts"
        ]
      }
    ]
  }
  ```
- `work_checkpoint:start` (accept):
  ```json
  {
    "action": "start",
    "runId": "run-1",
    "checkpointId": "C-1"
  }
  ```
- `work_checkpoint:verify` (accept):
  ```json
  {
    "action": "verify",
    "runId": "run-1",
    "checkpointId": "C-1",
    "complete": true
  }
  ```
- `work_checkpoint:recover` (accept):
  ```json
  {
    "action": "recover",
    "runId": "run-1",
    "checkpointId": "C-1",
    "recoveryId": "rec-1",
    "diagnosis": "Generation stopped.",
    "changedCondition": "Fresh reviewer assigned.",
    "verification": [
      "bun test"
    ]
  }
  ```
- `work_checkpoint:review` (accept):
  ```json
  {
    "action": "review",
    "runId": "run-1",
    "checkpointId": "C-1",
    "reviewer": "code"
  }
  ```
- `work_checkpoint:bind` (accept):
  ```json
  {
    "action": "bind",
    "runId": "run-1",
    "checkpointId": "C-1"
  }
  ```
- `work_checkpoint:complete` (accept):
  ```json
  {
    "action": "complete",
    "runId": "run-1",
    "rationale": "All tasks accepted."
  }
  ```
- `work_checkpoint:amend` (accept):
  ```json
  {
    "action": "amend",
    "runId": "run-1",
    "amendmentId": "amend-1",
    "rationale": "Add coverage."
  }
  ```
- `work_checkpoint:authorize` (accept):
  ```json
  {
    "action": "authorize",
    "runId": "run-1",
    "authorityId": "auth-1",
    "messageId": "msg-1",
    "stages": [
      "implementation"
    ],
    "reservedStops": [
      "specification"
    ]
  }
  ```
- `work_checkpoint:record-approval` (accept):
  ```json
  {
    "action": "record_approval",
    "runId": "run-1",
    "authorityId": "auth-1",
    "approvalId": "appr-1",
    "stage": "implementation",
    "artifactPath": "src/lib/a.ts",
    "artifactSha256": "abc123"
  }
  ```
- `work_checkpoint:revoke-authority` (accept):
  ```json
  {
    "action": "revoke_authority",
    "runId": "run-1",
    "authorityId": "auth-1",
    "revocationId": "revoke-1"
  }
  ```
- `work_checkpoint:revoke-narrow` (accept):
  ```json
  {
    "action": "revoke_authority",
    "runId": "run-1",
    "authorityId": "auth-1",
    "revocationId": "revoke-2",
    "stages": [
      "verification"
    ],
    "rationale": "Keep the final stage."
  }
  ```
- `work_checkpoint:reject-unknown-key` (reject):
  ```json
  {
    "action": "start",
    "runId": "run-1",
    "checkpointId": "C-1",
    "nestedUnknown": {
      "deep": 1
    }
  }
  ```
- `work_checkpoint:reject-unsupported-action` (reject):
  ```json
  {
    "action": "unknown_action"
  }
  ```
- `work_checkpoint:reject-start-missing-runid` (reject):
  ```json
  {
    "action": "start",
    "checkpointId": "C-1"
  }
  ```
- `work_checkpoint:reject-register-both-routes` (reject):
  ```json
  {
    "action": "register",
    "planPath": ".vvoc/specs/x/plan.xml",
    "runId": "run-1"
  }
  ```
- `work_checkpoint:reject-reserved-stop-typo` (reject):
  ```json
  {
    "action": "authorize",
    "runId": "run-1",
    "authorityId": "auth-1",
    "messageId": "msg-1",
    "stages": [
      "implementation"
    ],
    "reservedStops": [
      "verificaton"
    ]
  }
  ```
- `work_checkpoint:reject-unconsumed-action-field` (reject):
  ```json
  {
    "action": "complete",
    "runId": "run-1",
    "planPath": ".vvoc/specs/x/plan.xml"
  }
  ```
- `work_checkpoint:reject-recover-incomplete` (reject):
  ```json
  {
    "action": "recover",
    "runId": "run-1",
    "checkpointId": "C-1",
    "recoveryId": "rec-1"
  }
  ```
- `work_checkpoint:reject-verify-missing-checkpoint` (reject):
  ```json
  {
    "action": "verify",
    "runId": "run-1"
  }
  ```
- `work_checkpoint:reject-review-missing-checkpoint` (reject):
  ```json
  {
    "action": "review",
    "runId": "run-1"
  }
  ```
- `work_checkpoint:reject-bind-missing-checkpoint` (reject):
  ```json
  {
    "action": "bind",
    "runId": "run-1"
  }
  ```
- `work_checkpoint:reject-amend-missing-amendment` (reject):
  ```json
  {
    "action": "amend",
    "runId": "run-1"
  }
  ```
- `work_checkpoint:reject-record-approval-missing-approval` (reject):
  ```json
  {
    "action": "record_approval",
    "runId": "run-1"
  }
  ```
- `work_checkpoint:reject-revoke-authority-missing-revocation` (reject):
  ```json
  {
    "action": "revoke_authority",
    "runId": "run-1"
  }
  ```

### `hashline_edit`

- Summary: Apply exact hash-anchored line edits, range replacements, boundary inserts, delete, or rename.
- Description: Edit files using exact hash-anchored line references from the latest Read output.

| field | type | required | description |
| --- | --- | --- | --- |
| `filePath` | string | yes | Absolute path to the file to edit (non-empty; spaces inside the name are preserved) |
| `delete` | boolean | no | Delete the file instead of editing it |
| `rename` | string | no | Rename the file after edits are applied (non-empty when provided) |
| `edits` | array | yes | Hash-anchored edit operations to apply to the file |

Closed vocabularies:
- `edits[].op`: replace | replace_range | append | prepend

State/host prerequisites:
- absolute existing file path and current-file anchor validation
- model visibility for the routed edit tool

Conditional requirements:
- replace requires pos; replace_range requires pos and end
- append/prepend accept one anchor or none; null/[] deletes for replace/replace_range
- delete requires an empty edits list and forbids rename

Path kinds:
- `filePath` (absolute-file): absolute path; spaces inside the name are preserved
- `rename` (absolute-file): non-empty absolute destination path when provided

Result families:
- `hashline_edit:text-success`: model-visible success text returned to the host
- `hashline_edit:text-error`: model-visible Error text for a rejected edit
- `hashline_edit:success-metadata`: separately published bounded success metadata with filediff

Representative failures:
- `edits[0].typo`: unknown nested key names the edit index
- `edits[0].end`: conflicting insert anchors name the offending field

Checked examples:
- `hashline_edit:replace` (accept):
  ```json
  {
    "filePath": "/tmp/a.ts",
    "edits": [
      {
        "op": "replace",
        "pos": "2#VK#ZZ",
        "lines": [
          "x"
        ]
      }
    ]
  }
  ```
- `hashline_edit:replace-with-end` (accept):
  ```json
  {
    "filePath": "/tmp/a.ts",
    "edits": [
      {
        "op": "replace",
        "pos": "2#VK#ZZ",
        "end": "3#MB#ZZ",
        "lines": [
          "x"
        ]
      }
    ]
  }
  ```
- `hashline_edit:replace-range` (accept):
  ```json
  {
    "filePath": "/tmp/a.ts",
    "edits": [
      {
        "op": "replace_range",
        "pos": "2#VK#ZZ",
        "end": "3#MB#ZZ",
        "lines": [
          "x"
        ]
      }
    ]
  }
  ```
- `hashline_edit:delete-lines-null` (accept):
  ```json
  {
    "filePath": "/tmp/a.ts",
    "edits": [
      {
        "op": "replace_range",
        "pos": "2#VK#ZZ",
        "end": "3#MB#ZZ",
        "lines": null
      }
    ]
  }
  ```
- `hashline_edit:append-boundary` (accept):
  ```json
  {
    "filePath": "/tmp/a.ts",
    "edits": [
      {
        "op": "append",
        "lines": [
          "x"
        ]
      }
    ]
  }
  ```
- `hashline_edit:prepend-end-fallback` (accept):
  ```json
  {
    "filePath": "/tmp/a.ts",
    "edits": [
      {
        "op": "prepend",
        "end": "3#MB#ZZ",
        "lines": [
          "x"
        ]
      }
    ]
  }
  ```
- `hashline_edit:delete-file` (accept):
  ```json
  {
    "filePath": "/tmp/a.ts",
    "delete": true,
    "edits": []
  }
  ```
- `hashline_edit:rename` (accept):
  ```json
  {
    "filePath": "/tmp/a.ts",
    "rename": "/tmp/b.ts",
    "edits": [
      {
        "op": "append",
        "lines": [
          "x"
        ]
      }
    ]
  }
  ```
- `hashline_edit:reject-unknown-nested-key` (reject):
  ```json
  {
    "filePath": "/tmp/a.ts",
    "edits": [
      {
        "op": "append",
        "lines": [
          "x"
        ],
        "typo": 1
      }
    ]
  }
  ```
- `hashline_edit:reject-delete-rename` (reject):
  ```json
  {
    "filePath": "/tmp/a.ts",
    "delete": true,
    "rename": "/tmp/b.ts",
    "edits": []
  }
  ```
- `hashline_edit:reject-replace-range-missing-end` (reject):
  ```json
  {
    "filePath": "/tmp/a.ts",
    "edits": [
      {
        "op": "replace_range",
        "pos": "2#VK#ZZ",
        "lines": [
          "x"
        ]
      }
    ]
  }
  ```
- `hashline_edit:reject-conflicting-insert-anchors` (reject):
  ```json
  {
    "filePath": "/tmp/a.ts",
    "edits": [
      {
        "op": "append",
        "pos": "2#VK#ZZ",
        "end": "3#MB#ZZ",
        "lines": [
          "x"
        ]
      }
    ]
  }
  ```
- `hashline_edit:reject-unsupported-op` (reject):
  ```json
  {
    "filePath": "/tmp/a.ts",
    "edits": [
      {
        "op": "set_line",
        "pos": "2#VK#ZZ",
        "lines": [
          "x"
        ]
      }
    ]
  }
  ```
- `hashline_edit:reject-replace-missing-pos` (reject):
  ```json
  {
    "filePath": "/tmp/a.ts",
    "edits": [
      {
        "op": "replace",
        "lines": [
          "x"
        ]
      }
    ]
  }
  ```
- `hashline_edit:reject-prepend-conflicting-anchors` (reject):
  ```json
  {
    "filePath": "/tmp/a.ts",
    "edits": [
      {
        "op": "prepend",
        "pos": "2#VK#ZZ",
        "end": "3#MB#ZZ",
        "lines": [
          "x"
        ]
      }
    ]
  }
  ```
- `hashline_edit:reject-delete-blank-path` (reject):
  ```json
  {
    "filePath": "",
    "delete": true,
    "edits": []
  }
  ```
- `hashline_edit:reject-rename-blank-path` (reject):
  ```json
  {
    "filePath": "",
    "rename": "/tmp/b.ts",
    "edits": [
      {
        "op": "append",
        "lines": [
          "x"
        ]
      }
    ]
  }
  ```

### `str_replace_editor`

- Summary: View, create, exactly replace, or insert into a file with the dsh command surface.
- Description: Custom editing tool for viewing, creating and editing files

| field | type | required | description |
| --- | --- | --- | --- |
| `command` | enum(view \| create \| str_replace \| insert) | yes | The command to run: view, create, str_replace, or insert |
| `path` | string | yes | Absolute path to file or directory |
| `file_text` | string | no | create only: content of the new file; an explicitly empty string is allowed |
| `old_str` | string | no | str_replace only: the exact, non-empty text to replace (whitespace is significant) |
| `new_str` | string | no | str_replace replacement text (omitted defaults to empty deletion; explicit empty is valid); required for insert |
| `insert_line` | integer | no | insert only: integer line index >= 0; new_str is inserted AFTER this line (the file-dependent upper bound is enforced by the editor) |
| `view_range` | array | no | view only: exact [start, end] line range. The length is fixed at 2; start >= 1 and end is -1 (end of file) or >= start are runtime-checked. |

Closed vocabularies:
- `command`: view | create | str_replace | insert

State/host prerequisites:
- path existence and directory checks in the editor
- current-file freshness for str_replace and insert

Conditional requirements:
- create requires file_text (explicit empty allowed)
- str_replace requires a non-empty old_str; omitted new_str deletes
- insert requires insert_line >= 0 and new_str; view_range length is exactly 2

Path kinds:
- `path` (absolute-file): absolute file or directory path; non-empty

Result families:
- `str_replace_editor:ok`: successful ok/output envelope
- `str_replace_editor:error`: error envelope

Representative failures:
- `path`: blank paths are rejected before any mutation
- `view_range`: a non-two-element range is diagnosed

Checked examples:
- `str_replace_editor:view` (accept):
  ```json
  {
    "command": "view",
    "path": "/tmp/a.ts",
    "view_range": [
      2,
      -1
    ]
  }
  ```
- `str_replace_editor:create` (accept):
  ```json
  {
    "command": "create",
    "path": "/tmp/a.ts",
    "file_text": ""
  }
  ```
- `str_replace_editor:str-replace-explicit-empty` (accept):
  ```json
  {
    "command": "str_replace",
    "path": "/tmp/a.ts",
    "old_str": "x",
    "new_str": ""
  }
  ```
- `str_replace_editor:str-replace-omitted-new-str` (accept):
  ```json
  {
    "command": "str_replace",
    "path": "/tmp/a.ts",
    "old_str": "x"
  }
  ```
- `str_replace_editor:insert` (accept):
  ```json
  {
    "command": "insert",
    "path": "/tmp/a.ts",
    "insert_line": 0,
    "new_str": ""
  }
  ```
- `str_replace_editor:reject-unknown-key` (reject):
  ```json
  {
    "command": "view",
    "path": "/tmp/a.ts",
    "nested": {
      "deep": 1
    }
  }
  ```
- `str_replace_editor:reject-unsupported-command` (reject):
  ```json
  {
    "command": "delete",
    "path": "/tmp/a.ts"
  }
  ```
- `str_replace_editor:reject-unconsumed-field` (reject):
  ```json
  {
    "command": "view",
    "path": "/tmp/a.ts",
    "old_str": "x"
  }
  ```
- `str_replace_editor:reject-create-missing-file-text` (reject):
  ```json
  {
    "command": "create",
    "path": "/tmp/a.ts"
  }
  ```
- `str_replace_editor:reject-empty-old-str` (reject):
  ```json
  {
    "command": "str_replace",
    "path": "/tmp/a.ts",
    "old_str": "",
    "new_str": "x"
  }
  ```
- `str_replace_editor:reject-insert-missing-line` (reject):
  ```json
  {
    "command": "insert",
    "path": "/tmp/a.ts",
    "new_str": "x"
  }
  ```
- `str_replace_editor:reject-view-range-shape` (reject):
  ```json
  {
    "command": "view",
    "path": "/tmp/a.ts",
    "view_range": [
      1
    ]
  }
  ```
- `str_replace_editor:reject-view-range-order` (reject):
  ```json
  {
    "command": "view",
    "path": "/tmp/a.ts",
    "view_range": [
      3,
      2
    ]
  }
  ```

### `web_search`

- Summary: Search the configured provider and return ranked Markdown results.
- Description: Search the web using the configured provider and return ranked results as Markdown. Use for discovering information; returns titles, URLs, snippets, and dates.

| field | type | required | description |
| --- | --- | --- | --- |
| `query` | string | yes | The search query; the text is sent unchanged. |
| `count` | integer | no | Number of results, integer 1 through 20, default 8. |
| `freshness` | enum(day \| week \| month \| year) | no | Optional time window restricting results: day, week, month, or year. |

Closed vocabularies:
- `freshness`: day | week | month | year

Execute-time defaults:
- `count` = `8` (re-applied at execute time)

State/host prerequisites:
- configured provider and permission prompt
- resolved credential (env or config) for non-native providers

Conditional requirements:
- count is an integer 1..20; freshness is optional

Result families:
- `web_search:exa`: ranked Markdown result from the Exa provider
- `web_search:brave`: ranked Markdown result from the Brave provider
- `web_search:zai`: ranked Markdown result from the regional Z.AI provider

Representative failures:
- `count`: an out-of-range count is rejected before dispatch
- `credential`: unknown credential/provider fields are rejected

Checked examples:
- `web_search:default-count` (accept):
  ```json
  {
    "query": "vvoc"
  }
  ```
- `web_search:freshness-day` (accept):
  ```json
  {
    "query": "vvoc",
    "freshness": "day"
  }
  ```
- `web_search:freshness-week` (accept):
  ```json
  {
    "query": "vvoc",
    "freshness": "week"
  }
  ```
- `web_search:freshness-month` (accept):
  ```json
  {
    "query": "vvoc",
    "freshness": "month"
  }
  ```
- `web_search:freshness-year` (accept):
  ```json
  {
    "query": "vvoc",
    "freshness": "year"
  }
  ```
- `web_search:max-count` (accept):
  ```json
  {
    "query": "vvoc",
    "count": 20
  }
  ```
- `web_search:reject-unknown-key` (reject):
  ```json
  {
    "query": "vvoc",
    "extra": true
  }
  ```
- `web_search:reject-count-low` (reject):
  ```json
  {
    "query": "vvoc",
    "count": 0
  }
  ```
- `web_search:reject-count-high` (reject):
  ```json
  {
    "query": "vvoc",
    "count": 21
  }
  ```
- `web_search:reject-fractional-count` (reject):
  ```json
  {
    "query": "vvoc",
    "count": 1.5
  }
  ```
- `web_search:reject-string-count` (reject):
  ```json
  {
    "query": "vvoc",
    "count": "8"
  }
  ```
- `web_search:reject-unknown-freshness` (reject):
  ```json
  {
    "query": "vvoc",
    "freshness": "hour"
  }
  ```
- `web_search:reject-freshness-day-invalid-count` (reject):
  ```json
  {
    "query": "vvoc",
    "freshness": "day",
    "count": 0
  }
  ```
- `web_search:reject-freshness-week-invalid-count` (reject):
  ```json
  {
    "query": "vvoc",
    "freshness": "week",
    "count": 0
  }
  ```
- `web_search:reject-freshness-month-invalid-count` (reject):
  ```json
  {
    "query": "vvoc",
    "freshness": "month",
    "count": 0
  }
  ```
- `web_search:reject-freshness-year-invalid-count` (reject):
  ```json
  {
    "query": "vvoc",
    "freshness": "year",
    "count": 0
  }
  ```
- `web_search:reject-credential` (reject):
  ```json
  {
    "query": "vvoc",
    "credential": "secret",
    "provider": "brave"
  }
  ```

### `web_fetch`

- Summary: Fetch a known HTTP(S) URL and return Markdown, text, HTML, or a media attachment.
- Description: Fetch a known HTTP or HTTPS URL using the configured provider. Returns Markdown, text, raw HTML, or an image/PDF attachment.

| field | type | required | description |
| --- | --- | --- | --- |
| `url` | string | yes | The HTTP or HTTPS URL to retrieve; the URL is requested unchanged. |
| `format` | enum(markdown \| text \| html) | no | Output format for textual resources: markdown, text, or html. Default markdown. |
| `timeout` | number | no | Timeout in seconds: greater than 0 and at most 120; fractional values are allowed. Default 30. |

Closed vocabularies:
- `format`: markdown | text | html

Execute-time defaults:
- `format` = `"markdown"` (re-applied at execute time)
- `timeout` = `30` (re-applied at execute time; positive and at most 120)

State/host prerequisites:
- configured provider and permission prompt
- resolved credential for spider/zai providers

Conditional requirements:
- format defaults to markdown; timeout is positive and at most 120

Path kinds:
- `url` (url): absolute http(s) URL; the URL is requested unchanged and never echoed in diagnostics

Result families:
- `web_fetch:text-native`: native textual result envelope
- `web_fetch:text-spider`: Spider textual result envelope with request timing
- `web_fetch:text-zai`: regional Z.AI textual result envelope with reader metadata
- `web_fetch:media-native`: native media result envelope with a real attachment
- `web_fetch:media-spider`: Spider media result envelope with request timing
- `web_fetch:media-zai`: regional Z.AI media result envelope with a real attachment

Representative failures:
- `url`: a non-http(s) URL is rejected without echoing the raw URL
- `timeout`: an out-of-bounds timeout is rejected before dispatch

Checked examples:
- `web_fetch:default-format` (accept):
  ```json
  {
    "url": "https://example.test/page"
  }
  ```
- `web_fetch:format-text` (accept):
  ```json
  {
    "url": "https://example.test/page",
    "format": "text",
    "timeout": 0.5
  }
  ```
- `web_fetch:format-html` (accept):
  ```json
  {
    "url": "https://example.test/page",
    "format": "html",
    "timeout": 120
  }
  ```
- `web_fetch:reject-unknown-key` (reject):
  ```json
  {
    "url": "https://example.test/page",
    "extra": true
  }
  ```
- `web_fetch:reject-relative-url` (reject):
  ```json
  {
    "url": "/page"
  }
  ```
- `web_fetch:reject-file-scheme` (reject):
  ```json
  {
    "url": "file:///tmp/secret"
  }
  ```
- `web_fetch:reject-data-scheme` (reject):
  ```json
  {
    "url": "data:text/plain,hello"
  }
  ```
- `web_fetch:reject-unsupported-format` (reject):
  ```json
  {
    "url": "https://example.test/page",
    "format": "pdf"
  }
  ```
- `web_fetch:reject-markdown-invalid-timeout` (reject):
  ```json
  {
    "url": "https://example.test/page",
    "format": "markdown",
    "timeout": 0
  }
  ```
- `web_fetch:reject-text-invalid-timeout` (reject):
  ```json
  {
    "url": "https://example.test/page",
    "format": "text",
    "timeout": 0
  }
  ```
- `web_fetch:reject-html-invalid-timeout` (reject):
  ```json
  {
    "url": "https://example.test/page",
    "format": "html",
    "timeout": 0
  }
  ```
- `web_fetch:reject-zero-timeout` (reject):
  ```json
  {
    "url": "https://example.test/page",
    "timeout": 0
  }
  ```
- `web_fetch:reject-string-timeout` (reject):
  ```json
  {
    "url": "https://example.test/page",
    "timeout": "30"
  }
  ```
- `web_fetch:reject-credential` (reject):
  ```json
  {
    "url": "https://example.test/page",
    "apiKey": "secret",
    "provider": "spider"
  }
  ```
