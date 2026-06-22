# @osovv/vv-opencode

**Curated, opinionated OpenCode plugin set** for spec-first, review-driven, safer agentic development — with managed agents, skills, safety plugins, and the `vvoc` CLI.

<p>
  <a href="https://www.npmjs.com/package/@osovv/vv-opencode"><img src="https://img.shields.io/npm/v/%40osovv%2Fvv-opencode?style=flat&label=npm&color=blue" alt="npm"></a>
  <a href="https://github.com/osovv/vv-opencode/actions/workflows/publish.yml"><img src="https://github.com/osovv/vv-opencode/actions/workflows/publish.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/osovv/vv-opencode/releases"><img src="https://img.shields.io/github/v/release/osovv/vv-opencode?style=flat&label=release" alt="release"></a>
  <a href="https://github.com/osovv/vv-opencode"><img src="https://img.shields.io/github/stars/osovv/vv-opencode?style=flat&color=yellow" alt="stars"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-bun-%23f9f9f9?style=flat&logo=bun" alt="bun"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/osovv/vv-opencode?style=flat&color=green" alt="MIT"></a>
</p>

---

## Quick Start

```bash
bun add -g @osovv/vv-opencode
vvoc install
```

That's it. `vvoc install` pins the package, scaffolds managed agents and skills, writes canonical config, and sets `vv-controller` as your default OpenCode agent with auto-triggered spec, planning, review, and reflection skills.

To scope everything to the current project instead of the global OpenCode config:

```bash
vvoc install --scope project
vvoc launch --scope project
```

Project scope writes only to `./.opencode/` and `./.vvoc/`. A normal `opencode` launch may still apply OpenCode's native config discovery and merge behavior; `vvoc launch --scope project` is the hard sandbox path and starts OpenCode with `OPENCODE_CONFIG` and `VVOC_CONFIG` pinned to those local files, so you can smoke-test vv-opencode in one repository without mutating your primary global setup.

> **Already installed?** Run `vvoc sync` anytime to refresh plugins, prompts, skills, and presets.

---

## Spec-to-Code Pipeline

Agents are most useful when they do not jump straight from a vague request to edits. vvoc turns larger work into explicit artifacts first: a spec that captures intent, a plan that maps intent to implementation tasks, and review gates that catch mismatches before work is considered done.

The core workflow is a three-stage pipeline with independent review gates at each level. All artifacts for one feature live in a single spec package directory:

```
User request
    │
    ▼ auto-trigger
vv-spec  ───────────────────────────────────────→  .vvoc/specs/<id>/spec.xml
    │   Grill-me interview (one question at a time)
    │   Decision tree with recommended answers
    │   Deep synthesis by expensive model (no sub-agent delegation)
    │   Optionally creates .vvoc/specs/<id>/design-context.xml
    │   for complex sessions (design memory, not requirements)
    │
    ├── ① Spec review: requirements correct, complete, unambiguous?
    │
    ▼ auto-trigger (after approval)
vv-plan  ───────────────────────────────────────→  .vvoc/specs/<id>/plan.xml
    │   Reads sibling design-context.xml when present (explanatory only)
    │   Interface contracts with JSDoc behavior descriptions
    │   Acceptance criteria per task (grep: `<criterion>`)
    │   Dependency ordering (grep: `<task_id>`)
    │   Three-layer review model: spec → plan → code
    │
    ├── ② Plan review: every spec requirement → task? Contracts match spec?
    │
    ▼ auto-trigger (after approval)
vv-implementer → vv-spec-reviewer → vv-code-reviewer
    │   Workflow tracked loop with work items
    │   Spec review checks: code matches spec?
    │   Code review checks: implementation matches plan contracts?
    │
    ├── ③ Code review: interfaces correct? All AC pass?
    │
    ▼
Done
```

Specs and plans use a top-level lifecycle status: `draft` while being written, `approved` after explicit user approval, and `applied` after successful execution. `vv-execute` archives applied artifact packages by moving the entire spec package directory `.vvoc/specs/<id>/` to `.vvoc/specs/archive/<id>-<timestamp>/`.

### XML grep

Plans and specs are XML documents, making every element grep-able:

```bash
# Extract tasks from plan
grep '<id>T-' .vvoc/specs/*/plan.xml

# Extract all acceptance criteria
grep '<criterion>' .vvoc/specs/*/plan.xml

# Extract dependency graph
grep '<task_id>' .vvoc/specs/*/plan.xml

# Extract method signatures
grep '/\*\*' .vvoc/specs/*/plan.xml

# Extract all modules from architecture
grep '<name>' .vvoc/specs/*/plan.xml
```

Managed skills are installed by `vvoc`. `vv-controller` explicitly routes `vv-spec`, `vv-plan`, and `vv-review`; `vv-execute` and `vv-reflect` are available as managed skills for plan execution and durable session memory.

---

## Why vv-opencode?

OpenCode is a strong, flexible base for agentic coding, but it intentionally leaves the development process mostly up to you: when to clarify requirements, when to plan, when to investigate first, when to review, and how to keep longer runs safe. That flexibility is powerful, but it can also make agent work feel loose and inconsistent.

**vv-opencode adds a curated process layer on top of OpenCode:**

- **Formalized trajectories** — small changes stay direct, unclear bugs start with investigation, large changes go through spec and plan, and risky implementation uses review loops
- **Spec-first by default** — turn broad requests into explicit specs, plans, and review gates before implementation
- **Review-driven execution** — keep implementation, spec review, and code review as separate steps instead of one agent silently doing everything
- **Portable model choices** — use roles like `vv-role:smart` and `vv-role:fast` in shared agents, then map those roles per machine or project
- **Long-run safety** — Guardian auto-approves routine low-risk permission requests, leaves risky ones to OpenCode's manual approval flow, and secrets redaction reduces accidental leakage
- **Safer edits** — hashline-backed `edit` ties changes to fresh `read` output so agents are less likely to write against stale line numbers

---

## Features

| Area | What you get |
|---|---|
| **Plugins** | A curated set of OpenCode plugins that make agentic work more structured, portable, and safer without hand-wiring each piece yourself |
| **Agent System** | A default controller that picks the right path: direct changes for small work, investigation before unclear fixes, and implementer/reviewer loops for risky changes |
| **Skills** | Guided workflows for turning ideas into specs, specs into plans, plans into execution, reviews into findings, and long sessions into reusable memory |
| **Spec-to-Code Pipeline** | A repeatable path from request → spec → plan → implementation → review, so agents do not silently skip requirements or acceptance criteria |
| **One-Click Setup** | Recreate the same opinionated workflow on a new machine or project with `vvoc install` / `vvoc sync` |
| **CLI Tooling** | Operate and diagnose the setup from one CLI: install, sync, launch, status, doctor, roles, presets, plugin toggles, completion, and upgrade |
| **Long-Run Safety** | Guardian keeps safe long/AFK runs moving by auto-approving routine low-risk permissions, while risky actions stay in OpenCode's manual approval flow; secrets redaction reduces accidental leakage |
| **Model Roles** | Put roles like `vv-role:smart` or `vv-role:fast` in shared agents and skills instead of hardcoded model IDs, then choose provider/model mappings per environment |
| **Workflow Tracking** | Replace free-form multi-agent chaos with explicit work items, bounded review rounds, reviewer result collection, and hard stops when more context is needed |

---

## The Six Plugins

| Plugin | What it helps you do |
|---|---|
| **WorkflowPlugin** | Keep multi-agent work structured with explicit work items, bounded implementation/review loops, reviewer result collection, and safe stops when more context is needed. |
| **ModelRolesPlugin** | Use semantic model roles instead of hardcoded model IDs in OpenCode agents, subagents, and command configs — e.g. `vv-role:smart`, `vv-role:fast` — then map those roles per machine or project. |
| **GuardianPlugin** | Keep long or AFK agent runs moving by auto-approving routine low-risk permission requests. If something looks risky, Guardian does not auto-approve it and leaves the decision to OpenCode's normal manual approval flow. |
| **HashlineEditPlugin** | Make agent edits safer by tying changes to fresh `read` output, reducing wrong-line and stale-context edits. |
| **SystemContextInjectionPlugin** | Give primary agents the vvoc workflow rules and skill discovery automatically, while keeping subagents focused and avoiding prompt pollution. |
| **SecretsRedactionPlugin** | Reduce accidental secret leakage by redacting tokens, keys, emails, and other sensitive values before messages are sent to the model. |

Workflow work items are opened with explicit intent. For implementation loops, controllers use:

```json
{
  "items": [
    {
      "key": "implement-feature",
      "title": "Implement feature",
      "mode": "implementation",
      "requiredReviewers": ["spec", "code"]
    }
  ]
}
```

For review-only reports, use `"mode": "review_only"`. In review-only mode, reviewer `FAIL` is a completed finding result: required reviewers are collected independently, parallel `spec` and `code` reviewers may both return `FAIL`, and the item does not route to `vv-implementer` unless the user explicitly requests fixes.

---

## CLI at a Glance

| Command | Purpose |
|---|---|
| `vvoc init` | Interactive bootstrap flow |
| `vvoc install` | Non-interactive setup and scaffolding |
| `vvoc sync` | Refresh plugin entry, agents, prompts, skills, config |
| `vvoc launch` | Launch OpenCode with deterministic `OPENCODE_CONFIG` and `VVOC_CONFIG` sources |
| `vvoc status` | Show current installation state |
| `vvoc doctor` | Diagnose setup problems (exits non-zero on issues) |
| `vvoc config validate` | Validate canonical `vvoc.json` |
| `vvoc role list\|set\|unset` | Manage model role assignments |
| `vvoc preset list\|show\|<name>` | Inspect or apply named presets |
| `vvoc guardian config` | Print or write guardian section |
| `vvoc plugin list` | List OpenCode plugin entries |
| `vvoc plugin enable\|disable` | Toggle a vvoc-managed plugin on or off |
| `vvoc patch-provider stepfun-ai\|zai\|openai` | Patch an OpenCode provider preset in global or project scope |
| `vvoc completion` | Install shell completions |
| `vvoc upgrade` | Upgrade global package and run follow-up sync; sync failure is reported as a partial upgrade |
| `vvoc version` | Print installed version |

---

## Model Roles & Presets

```bash
# View current assignments
vvoc role list
vvoc role list --scope effective

# Assign models to roles
vvoc role set default openai/gpt-5.4
vvoc role set team-review anthropic/claude-sonnet-4-5 --scope project
vvoc role set smart openai/vv-gpt-5.5-xhigh
vvoc role set fast openai/gpt-5.4-mini

# Switch provider presets
vvoc preset vv-openai
vvoc preset vv-zai
vvoc preset vv-deepseek
vvoc preset vv-minimax
vvoc preset vv-osovv
```

Built-in role IDs: `default`, `smart`, `fast`, `vision` + any custom lowercase-hyphenated IDs.

Presets are partial — applying one only changes the roles it defines. Managed built-in presets (`vv-*`) are refreshed on every `vvoc install`/`vvoc sync`; user-defined presets are preserved as-is.

---

## Config & Data Layout

Mutating commands default to global for backward compatibility. Add `--scope project` to write a project-local layer. Read/diagnostic commands accept `--scope global|project|effective`, where `effective` resolves in this order:

1. explicit env override (`VVOC_CONFIG` / `OPENCODE_CONFIG`)
2. nearest project layer
3. global layer
4. built-in defaults when the command/runtime permits defaults

Canonical project-local paths:

```text
OpenCode config          → ./.opencode/opencode.json(c)
vvoc config              → ./.vvoc/vvoc.json
Managed agent prompts    → ./.vvoc/agents/*.md
Managed skills           → ./.vvoc/skills/*/SKILL.md
Spec package directory   → ./.vvoc/specs/<id>/
  spec.xml              # normative spec document (required)
  design-context.xml    # curated design memory (optional)
  plan.xml              # implementation plan (created by vv-plan)

```

Legacy root-level `./opencode.json` and `./opencode.jsonc` are intentionally not used as vvoc project layers.

```
Global OpenCode config   → $XDG_CONFIG_HOME/opencode/opencode.json
Global vvoc config       → $XDG_CONFIG_HOME/vvoc/vvoc.json
Managed agent prompts    → $XDG_CONFIG_HOME/vvoc/agents/*.md  (global)
                           ./.vvoc/agents/*.md                 (project)
Managed skills           → $XDG_CONFIG_HOME/vvoc/skills/*/SKILL.md  (global)
                           ./.vvoc/skills/*/SKILL.md               (project)
Spec documents           → ./.vvoc/specs/<id>/spec.xml
Optional design context  → ./.vvoc/specs/<id>/design-context.xml
Implementation plans     → ./.vvoc/specs/<id>/plan.xml
Persisted data           → $XDG_DATA_HOME/vvoc/
Repository memory       → ./.vvoc/lessons/*.xml              (lazy vv-reflect fallback)
                           ./.vvoc/runbooks/*.xml             (lazy vv-reflect fallback)
```

Schema is versioned and published with the package — source of truth at `schemas/vvoc/v3.json`. The current config contract is strict: `vvoc.json` must be canonical version 3 and include required sections such as `plugins`. Existing v1/v2/pre-role, incomplete, malformed, or otherwise invalid config files fail instead of being migrated or repaired. `vvoc install` and `vvoc sync` may create a fresh canonical config when no config exists, but they refuse to rewrite an invalid existing `vvoc.json`; fix the file manually and rerun `vvoc sync`.

`vvoc status` and `vvoc doctor` are diagnostic exceptions: they report the selected config path and validation problem without normalizing or rewriting the file. `vvoc upgrade` can still finish the package installation when the follow-up `vvoc sync` fails; in that case it reports a partial upgrade, leaves config unchanged, and tells you to fix `vvoc.json` manually before rerunning `vvoc sync`.

Runtime compatibility is current-only. Guardian permission replies use the current OpenCode permission reply path (with the current HTTP reply fallback), Hashline edit refs must use current hash/context anchors, and sync writes current managed agents without deleting old pre-rename user or command entries.

Runtime plugins load the effective `vvoc.json` once during OpenCode startup and share the same immutable config snapshot for the lifetime of the process. There is no live reload; restart OpenCode after changing `vvoc.json`.

### Deterministic local launch

Use `vvoc launch` when you want the vvoc-selected config files to be the only files OpenCode sees for this run:

```bash
vvoc install --scope project
vvoc launch --scope project -- run "hello"
```

`vvoc launch --scope project` is strict and non-mutating: if `.opencode/opencode.json` or `.vvoc/vvoc.json` is missing, it fails with a hint to run `vvoc install --scope project`. `--scope effective` follows the layered lookup order, and `--scope global` uses the global config paths.

---

## Managed Agents

All prompt files are scaffolded by `vvoc install` / `vvoc sync`:

| Agent | When it helps |
|---|---|
| `vv-controller` | Default primary agent that routes small changes, investigations, reviews, and larger feature work through the right workflow |
| `enhancer` | Improves rough requests before execution when a clearer prompt would help |
| `vv-implementer` | Applies a focused approved change and verifies it before reporting completion |
| `vv-spec-reviewer` | Checks whether implementation matches the requested spec and acceptance criteria |
| `vv-code-reviewer` | Looks for bugs, regressions, maintainability risks, and missing tests |
| `investigator` | Finds the root cause first when behavior is unclear or a failure needs diagnosis |
| `guardian` | Supports GuardianPlugin by auto-approving routine low-risk permission requests and leaving risky ones for manual approval |

---

## Managed Skills

Five workflow skills are scaffolded alongside agents:

| Skill | When to use it | What it gives you |
|---|---|---|
| `vv-spec` | You have a feature or creative request and no agreed contract yet | A guided interview, recommended options, and a saved spec in `.vvoc/specs/<id>/spec.xml` |
| `vv-plan` | A spec is approved and ready to implement | A task-level implementation plan with file targets, contracts, dependencies, and acceptance criteria |
| `vv-execute` | A plan is approved and you want it applied step by step | Ordered execution with verification and applied spec/plan archival |
| `vv-review` | You want findings, not fixes | A review-only workflow that reports spec/code issues and stops before implementation |
| `vv-reflect` | A long development, debugging, ops, or investigation session produced reusable knowledge | Durable notes in existing docs or `.vvoc/lessons` / `.vvoc/runbooks` for future agents |

Spec and plan artifacts stay XML so requirements, tasks, acceptance criteria, and dependencies remain easy to grep and review.

`vv-reflect` creates `.vvoc/lessons` and `.vvoc/runbooks` lazily only after approved fallback writes. It prefers an existing repository documentation convention when there is a high-confidence match.

Skills are loaded by OpenCode at session start through `config.skills.paths` (registered by the SystemContextInjectionPlugin). The `vv-controller` agent's `<skill_trigger_rule>` ensures they are invoked automatically when the user's request matches their trigger conditions.

---

## Local Development

```bash
bun install             # Install dependencies
bun run check           # Typecheck + lint + format check + test
bun run fmt             # Auto-format source files
bun run release:check   # Verify package/schema release consistency
```

Git hooks managed via `lefthook`.

### Smoke-test the built CLI

```bash
tmpdir="$(mktemp -d)"
bun run build
bun dist/cli.js install --config-dir "$tmpdir"
bun dist/cli.js status --config-dir "$tmpdir"
```

### Full release verification

```bash
bun run release:check
bun run check
bun run pack:check
```

---
## Publishing

The release flow is automated via a local wrapper and a tag-gated GitHub Actions workflow.

### Local bump

```bash
bun run release:bump patch   # or minor, major, prerelease, or explicit semver
```

This will:
1. Reject if the worktree is dirty
2. Bump `package.json` via `npm version --no-git-tag-version`
3. Generate a required AI release summary with `opencode --pure run`
4. Prepend a `### Summary` section plus conventional commit details to `CHANGELOG.md`
5. Update `schemas/vvoc/v3.json` `$id` to the new version
6. Run `release:check` for consistency
7. Create a release commit and annotated tag `vX.Y.Z`
8. Push the current branch and the created tag to `origin`

Required local release prerequisite:
- `opencode` must be available from `PATH`.
- The summary model defaults to `deepseek/deepseek-v4-flash`.
- Override with `VVOC_RELEASE_SUMMARY_MODEL=provider/model`.
- Override the per-attempt timeout with `VVOC_RELEASE_SUMMARY_TIMEOUT_MS=120000`.
Run `release:bump` from a checked-out branch with push access to `origin`. The tag push is what triggers the publish workflow.

The GitHub Actions workflow triggers on `v*` tag pushes, verifies the tag matches
`package.json`, runs full validation (typecheck, lint, fmt check, tests, build, pack
check, `release:check`), and publishes to npm with `--provenance`.

### Checking consistency manually

```bash
bun run release:check
```

This verifies that `package.json` name, version, and `schemas/vvoc/v3.json` `$id` and
config format version are all consistent. Run it independently anytime.

### CI publish workflow

The workflow uses npm provenance/trusted publishing (`id-token: write`) and does not publish on normal branch pushes. Configure npm trusted publishing for this GitHub repository/package, or adapt the publish step to use an `NPM_TOKEN` secret if token-based publishing is required.

---

## Optional: RTK

[RTK](https://github.com/rtk-ai/rtk) is a CLI proxy that reduces token usage for common developer commands. The interactive `vvoc init` flow recommends it after setup.

---

## License

MIT — see [LICENSE](LICENSE).
