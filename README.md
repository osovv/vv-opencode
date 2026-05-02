# @osovv/vv-opencode

**Portable OpenCode workflow toolkit** — one command bootstraps a managed agent ecosystem, security-and-productivity plugins, and a unified CLI.

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

That's it. `vvoc install` pins the package, scaffolds managed agents, registers slash commands, writes canonical config, and sets `vv-controller` as your default OpenCode agent.

To scope everything to the current project instead of the global OpenCode config:

```bash
vvoc install --scope project
```

> **Already installed?** Run `vvoc sync` anytime to refresh plugins, prompts, and presets.

---

## Why vv-opencode?

Setting up OpenCode for serious daily work means juggling config files, agent prompts, plugin wiring, model role assignments, and permission rules — every time, on every machine.

**vv-opencode collapses that into a single `vvoc install`.** It owns the wiring so you don't have to:

- **Seven plugins, one entry** — all plugins are exported from a single pinned package entry
- **Managed agent system** — a routed `vv-controller` primary agent with domain-specialized subagents
- **Model roles & presets** — assign models to roles (`smart`, `fast`, `vision`, …) and switch provider presets with one command
- **Security-first** — a `guardian` agent reviews permission requests, secrets are redacted from LLM-bound chat
- **Stale-line-number defense** — hashline-backed `edit` prevents write-against-wrong-snapshot bugs

---

## Features

| Area | What you get |
|---|---|
| **Plugins** | 6 plugins in one pinned package entry — workflow orchestration, model roles, guardian, hashline edit, system context injection, secrets redaction |
| **Agent System** | `vv-controller` routes work: direct for small changes, `investigator` for bugs, implementer+reviewer loop for risky work, analyst+architect for large features |
| **One-Click Setup** | `vvoc install` or `vvoc sync` bootstraps everything — config, agents, prompts, commands, presets |
| **CLI Tooling** | 15+ commands: install, sync, status, doctor, role management, presets, guardian config, shell completion, upgrade |
| **Security** | GuardianPlugin reviews shell-permission requests; SecretsRedactionPlugin strips tokens before LLM requests; both configurable via `vvoc.json` |
| **Model Roles** | Assign provider/model/variant to roles (`default`, `smart`, `fast`, `vision`, custom); switch between `vv-openai`, `vv-zai`, `vv-deepseek`, `vv-minimax` presets |
| **Workflow Tracking** | Work items with open/list/close for tracked implementation-to-review pipelines |
| **Slash Commands** | `/vv-plan` routes through planning mode, `/vv-review` routes through review-only mode |

---

## The Six Plugins

| Plugin | What it does |
|---|---|
| **WorkflowPlugin** | Tracked orchestration around `task` for subagents; registers `work_item_open/list/close` tools; routes `/vv-plan` and `/vv-review` commands |
| **ModelRolesPlugin** | Resolves `vv-role:*` references in OpenCode config at startup; translates `:variant` suffixes into native model+variant fields |
| **GuardianPlugin** | Reviews OpenCode permission requests with a constrained guardian agent and safe-deny defaults; configurable model, timeout, risk threshold |
| **HashlineEditPlugin** | Replaces OpenCode's `edit` with hash-anchored variant; rewrites `read` output to `line#hash` format; rejects stale snapshots to prevent drift bugs |
| **SystemContextInjectionPlugin** | Injects reusable system guidance into primary sessions without polluting subagent prompts; encourages proactive `explore` usage |
| **SecretsRedactionPlugin** | Redacts secrets (tokens, keys, emails, UUIDs, IPs) before LLM requests; restores placeholders afterward; configurable patterns |

---

## CLI at a Glance

| Command | Purpose |
|---|---|
| `vvoc init` | Interactive bootstrap flow |
| `vvoc install` | Non-interactive setup and scaffolding |
| `vvoc sync` | Refresh plugin entry, agents, prompts, config |
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
Planning artifacts       → ./.vvoc/plans/*
Persisted data           → $XDG_DATA_HOME/vvoc/
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

## Local Development

```bash
bun install             # Install dependencies
bun run check           # Typecheck + lint + format check + test
bun run fmt             # Auto-format source files
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
bun run check
bun run build
bun run pack:check
```

---

## Publishing

```bash
bun run check && bun run build && npm publish
```

Publishing is manual from the terminal. No CI publish workflows.

---

## Optional: RTK

[RTK](https://github.com/rtk-ai/rtk) is a CLI proxy that reduces token usage for common developer commands. The interactive `vvoc init` flow recommends it after setup.
