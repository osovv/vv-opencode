# @osovv/vv-opencode

**Portable OpenCode workflow toolkit** — one command bootstraps a managed agent ecosystem, skill-driven spec-to-code pipeline, security-and-productivity plugins, and a unified CLI.

<p>
  <a href="https://www.npmjs.com/package/@osovv/vv-opencode"><img src="https://img.shields.io/npm/v/%40osovv%2Fvv-opencode?style=flat&label=npm&color=blue" alt="npm"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-bun-%23f9f9f9?style=flat&logo=bun" alt="bun"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat" alt="MIT"></a>
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
```

> **Already installed?** Run `vvoc sync` anytime to refresh plugins, prompts, skills, and presets.

---

## Spec-to-Code Pipeline

The core workflow is a three-stage pipeline with independent review gates at each level:

```
User request
    │
    ▼ auto-trigger
vv-spec  ───────────────────────────────────────→  .vvoc/specs/*.xml
    │   Grill-me interview (one question at a time)
    │   Decision tree with recommended answers
    │   vv-analyst + vv-architect synthesis
    │
    ├── ① Spec review: requirements correct, complete, unambiguous?
    │
    ▼ auto-trigger (after approval)
vv-plan  ───────────────────────────────────────→  .vvoc/plans/*-plan.xml
    │   Interface contracts with JSDoc behavior descriptions
    │   Acceptance criteria per task (grep: `<criterion-N>`)
    │   Dependency ordering (grep: `<depends-on>`)
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

### XML grep

Plans and specs are XML documents, making every element grep-able:

```bash
# Extract tasks from plan
grep '<task-[0-9]\+>' .vvoc/plans/*.xml

# Extract all acceptance criteria
grep '<criterion-[0-9]\+>' .vvoc/plans/*.xml

# Extract dependency graph
grep '<depends-on>task-' .vvoc/plans/*.xml

# Extract method signatures
grep '/\*\*' .vvoc/plans/*.xml

# Extract all components from plan
grep '<component>' .vvoc/plans/*.xml
```

All four skills are auto-triggered by `vv-controller` via its built-in `<skill_trigger_rule>` — no slash commands needed. The controller checks whether `vv-spec`, `vv-plan`, `vv-review`, or `vv-reflect` applies before routing any request.

---

## Why vv-opencode?

Setting up OpenCode for serious daily work means juggling config files, agent prompts, plugin wiring, model role assignments, and permission rules — every time, on every machine.

**vv-opencode collapses that into a single `vvoc install`.** It owns the wiring so you don't have to:

- **Six plugins, one entry** — all plugins are exported from a single pinned package entry
- **Managed agent & skill system** — `vv-controller` auto-triggers `vv-spec`, `vv-plan`, `vv-review`, and `vv-reflect` skills before routing to domain-specialized subagents
- **Model roles & presets** — assign models to roles (`smart`, `fast`, `vision`, …) and switch provider presets with one command
- **Security-first** — a `guardian` agent reviews permission requests, secrets are redacted from LLM-bound chat
- **Stale-line-number defense** — hashline-backed `edit` prevents write-against-wrong-snapshot bugs

---

## Features

| Area | What you get |
|---|---|
| **Plugins** | 6 plugins in one pinned package entry — workflow orchestration, model roles, guardian, hashline edit, system context injection, secrets redaction |
| **Agent System** | `vv-controller` routes work: direct for small changes, `investigator` for bugs, implementer+reviewer loop for risky work, analyst+architect for large features |
| **Skills** | `vv-spec` interviews you and writes an XML spec; `vv-plan` maps the spec to interface contracts and acceptance criteria; `vv-review` runs a review-only workflow; `vv-reflect` preserves reusable session findings as repository memory — all auto-triggered |
| **Spec-to-Code Pipeline** | `vv-spec` → spec review → `vv-plan` → plan review → `vv-implementer` → code review. Three independent review gates cover requirements, contracts, and implementation |
| **One-Click Setup** | `vvoc install` or `vvoc sync` bootstraps everything — config, agents, skills, prompts, presets |
| **CLI Tooling** | 15+ commands: install, sync, status, doctor, role management, presets, guardian config, shell completion, upgrade |
| **Security** | GuardianPlugin reviews shell-permission requests; SecretsRedactionPlugin strips tokens before LLM requests; both configurable via `vvoc.json` |
| **Model Roles** | Assign provider/model/variant to roles (`default`, `smart`, `fast`, `vision`, custom); switch between `vv-openai`, `vv-zai`, `vv-deepseek`, `vv-minimax` presets |
| **Workflow Tracking** | Work items with open/list/close for tracked implementation-to-review pipelines |

---

## The Six Plugins

| Plugin | What it does |
|---|---|
| **WorkflowPlugin** | Tracked orchestration around `task` for subagents; registers `work_item_open/list/close` tools for implementation-to-review pipelines with state-machine enforcement and round-limit gating |
| **ModelRolesPlugin** | Resolves `vv-role:*` references in OpenCode config at startup; translates `:variant` suffixes into native model+variant fields |
| **GuardianPlugin** | Reviews OpenCode permission requests with a constrained guardian agent and safe-deny defaults; configurable model, timeout, risk threshold |
| **HashlineEditPlugin** | Replaces OpenCode's `edit` with hash-anchored variant; rewrites `read` output to `line#hash` format; rejects stale snapshots to prevent drift bugs |
| **SystemContextInjectionPlugin** | Injects reusable system guidance into primary sessions without polluting subagent prompts; encourages proactive `explore` usage; registers vvoc skill directory for OpenCode skill discovery |
| **SecretsRedactionPlugin** | Redacts secrets (tokens, keys, emails, UUIDs, IPs) before LLM requests; restores placeholders afterward; configurable patterns |

---

## CLI at a Glance

| Command | Purpose |
|---|---|
| `vvoc init` | Interactive bootstrap flow |
| `vvoc install` | Non-interactive setup and scaffolding |
| `vvoc sync` | Refresh plugin entry, agents, prompts, skills, config |
| `vvoc status` | Show current installation state |
| `vvoc doctor` | Diagnose setup problems (exits non-zero on issues) |
| `vvoc config validate` | Validate canonical `vvoc.json` |
| `vvoc role list\|set\|unset` | Manage model role assignments |
| `vvoc preset list\|show\|<name>` | Inspect or apply named presets |
| `vvoc guardian config` | Print or write guardian section |
| `vvoc plugin list` | List OpenCode plugin entries |
| `vvoc patch-provider stepfun-ai\|zai\|openai` | Patch a global OpenCode config preset |
| `vvoc completion` | Install shell completions |
| `vvoc upgrade` | Upgrade global package and run follow-up sync |
| `vvoc version` | Print installed version |

---

## Model Roles & Presets

```bash
# View current assignments
vvoc role list

# Assign models to roles
vvoc role set default openai/gpt-5.4
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

```
OpenCode config          → OpenCode-managed paths (global or project)
vvoc.json (canonical)    → $XDG_CONFIG_HOME/vvoc/vvoc.json
Managed agent prompts    → $XDG_CONFIG_HOME/vvoc/agents/*.md  (global)
                           ./.vvoc/agents/*.md                 (project)
Managed skills           → $XDG_CONFIG_HOME/vvoc/skills/*/SKILL.md  (global)
                           ./.vvoc/skills/*/SKILL.md               (project)
Spec documents           → ./.vvoc/specs/*
Planning artifacts       → ./.vvoc/plans/*
Persisted data           → $XDG_DATA_HOME/vvoc/
Repository memory       → ./.vvoc/lessons/*.xml              (lazy vv-reflect fallback)
                           ./.vvoc/runbooks/*.xml             (lazy vv-reflect fallback)
```

Schema is versioned and published with the package — source of truth at `schemas/vvoc/v3.json`.

---

## Managed Agents

All prompt files are scaffolded by `vvoc install` / `vvoc sync`:

| Agent | Role |
|---|---|
| `vv-controller` | Default primary agent — routes work to the right subagent |
| `enhancer` | Prompt enhancement |
| `vv-analyst` | Requirements analysis for large features |
| `vv-architect` | Module/contract/wave design |
| `vv-implementer` | Focused implementation with verification |
| `vv-spec-reviewer` | Checks implementation against spec |
| `vv-code-reviewer` | Engineering review for bugs and maintainability |
| `investigator` | Root-cause analysis for unclear bugs |
| `guardian` | Permission request review (plugin runtime) |

---

## Managed Skills

Four workflow skills are scaffolded alongside agents:

| Skill | Trigger | Output | Grep-able |
|---|---|---|---|
| `vv-spec` | Creative/feature request, no spec exists | `.vvoc/specs/*.xml` | `<user-story>`, `<fr-1>`, `<sc-1>` |
| `vv-plan` | Approved spec exists | `.vvoc/plans/*-plan.xml` | `<task-N>`, `<criterion-N>`, `<depends-on>`, `/**` JSDoc |
| `vv-review` | Review request | Findings report | — |
| `vv-reflect` | End of a long development, debugging, bugfix, ops, or investigation session | Existing repo docs or `.vvoc/lessons/*.xml` / `.vvoc/runbooks/*.xml` | XML fallback indexes and entry tags |

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
