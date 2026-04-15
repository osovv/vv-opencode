# @osovv/vv-opencode

Portable OpenCode workflow package with a Bun CLI that installs and maintains OpenCode plugins, managed agent prompts, and a canonical `vvoc.json` config.

## What This Package Does

- installs one pinned `@osovv/vv-opencode@<version>` entry into OpenCode
- that package entry exports five plugins: `GuardianPlugin`, `MemoryPlugin`, `ModelRolesPlugin`, `SystemContextInjectionPlugin`, `SecretsRedactionPlugin`
- creates and maintains canonical `vvoc` config at `$XDG_CONFIG_HOME/vvoc/vvoc.json`
- scaffolds managed prompt files under `vvoc/agents/`
- registers managed OpenCode agents: `enhancer`, `implementer`, `spec-reviewer`, `code-reviewer`, `investitagor`
- installs plugin-managed agents: `guardian`, `memory-reviewer`
- ships role presets, diagnostics, and shell completion through the `vvoc` CLI

## Quick Start

If the package is installed as a project dependency, run it via `bun x vvoc` or `bun run vvoc`.

Install globally:

```bash
bun add -g @osovv/vv-opencode
```

Bootstrap the default global setup:

```bash
vvoc install
vvoc status
```

Write OpenCode config and managed prompts into the current repository instead of the global OpenCode config:

```bash
vvoc install --scope project
```

## What `install` And `sync` Do

`vvoc install` and `vvoc sync`:

- ensure OpenCode has a pinned `@osovv/vv-opencode@<version>` package entry
- register managed agents and scaffold their prompt files
- create or refresh canonical `vvoc.json`
- refresh managed built-in presets: `vv-openai`, `vv-zai`, `vv-minimax`

That package entry exports five plugins:

- `GuardianPlugin`
- `MemoryPlugin`
- `ModelRolesPlugin`
- `SystemContextInjectionPlugin`
- `SecretsRedactionPlugin`

## Config And Data Layout

OpenCode config stays in OpenCode-managed paths:

- global: `$XDG_CONFIG_HOME/opencode/opencode.json` or `~/.config/opencode/opencode.json`
- project: `./opencode.json` or `./opencode.jsonc`

vvoc-owned config stays separate from OpenCode config:

- canonical config: `$XDG_CONFIG_HOME/vvoc/vvoc.json` or `~/.config/vvoc/vvoc.json`

Managed prompt files live here:

- global: `$XDG_CONFIG_HOME/vvoc/agents/*.md`
- project: `./.vvoc/agents/*.md`

For CLI commands that accept `--scope project`, only the OpenCode config target and managed prompt directory become project-local. Canonical `vvoc.json` stays global.

Persisted vvoc data lives here:

- global data root: `$XDG_DATA_HOME/vvoc/` or `~/.local/share/vvoc/`
- project-local memory: `$XDG_DATA_HOME/vvoc/projects/<project-id>/memory/`
- shared memory: `$XDG_DATA_HOME/vvoc/memory/shared/<namespace>/`

`vvoc.json` currently contains these top-level sections:

- `roles`
- `guardian`
- `memory`
- `secretsRedaction`
- `presets`

The current schema is versioned and published with the package:

```json
{
  "$schema": "https://cdn.jsdelivr.net/npm/@osovv/vv-opencode@<installed-version>/schemas/vvoc/v3.json",
  "version": 3
}
```

Schema source of truth lives in this repository at `schemas/vvoc/v3.json`.

## CLI Overview

| Command | Purpose |
| --- | --- |
| `vvoc init` | Interactive bootstrap flow |
| `vvoc install` | Non-interactive setup and scaffolding |
| `vvoc sync` | Refresh plugin entry, managed agents, prompts, and `vvoc.json` |
| `vvoc status` | Show current installation state |
| `vvoc doctor` | Diagnose setup problems and exit non-zero if problems are found |
| `vvoc config validate` | Validate canonical `vvoc.json` |
| `vvoc role list/set/unset` | Manage canonical role assignments |
| `vvoc preset list`, `vvoc preset show <name>`, `vvoc preset <name>` | Inspect or apply named presets |
| `vvoc guardian config` | Print or write the `guardian` section of `vvoc.json` |
| `vvoc plugin list` | List plugin entries from OpenCode config |
| `vvoc patch-provider stepfun-ai|zai|openai` | Patch a global OpenCode config preset |
| `vvoc completion` | Install shell completions |
| `vvoc upgrade` | Upgrade the global package and run a follow-up sync |
| `vvoc version` | Print the installed package version |

## Model Roles And Presets

Inspect current role assignments:

```bash
vvoc role list
```

Set role assignments (`provider/model[:variant]`):

```bash
vvoc role set default openai/gpt-5.4
vvoc role set smart openai/gpt-5.4:xhigh
vvoc role set fast openai/gpt-5.4-mini
vvoc role set team-review anthropic/claude-sonnet-4-5:high
```

Remove custom role assignments:

```bash
vvoc role unset team-review
```

Built-in role IDs:

- `default`
- `smart`
- `fast`
- `vision`

Role notes:

- `vvoc role` mutates only canonical global `vvoc.json` (`roles` map)
- built-in roles cannot be removed with `vvoc role unset`
- custom role IDs must use lowercase letters, digits, and hyphens

Presets are stored in canonical `vvoc.json` and are useful when you want to switch several role assignments together:

```bash
vvoc preset list
vvoc preset show vv-openai
vvoc preset vv-openai
vvoc preset vv-zai
```

Preset rules:

- managed built-in presets are `vv-openai`, `vv-zai`, and `vv-minimax`
- `vvoc install` and `vvoc sync` always refresh those managed `vv-*` presets back to vvoc defaults
- `vv-openai` uses the vv-managed OpenAI alias model `openai/vv-gpt-5.4-xhigh` as its default target so GPT-5.4 xhigh can be selected as an exact root default model
- run `vvoc patch-provider openai` before applying `vv-openai` if the alias model is not already present in your global OpenCode config
- user-defined presets with other names are preserved as-is, including legacy names such as `openai`, `zai`, and `minimax`
- presets may be partial
- applying a preset only changes the roles listed in that preset
- preset application updates only canonical global `vvoc.json` role assignments and does not rewrite OpenCode config directly

## Plugins Included

### ModelRolesPlugin

`ModelRolesPlugin` resolves `vv-role:*` model references at startup for supported OpenCode config fields (`model`, `small_model`, `agent.*.model`, and `command.*.model`).

Agent role assignments that include `:variant` are translated into native `model` plus `variant` fields.

### GuardianPlugin

`GuardianPlugin` reviews OpenCode permission requests with a constrained `guardian` agent and safe deny behavior.

Runtime settings live in the `guardian` section of canonical `vvoc.json`.

Supported `guardian` fields:

- `model`
- `variant`
- `timeoutMs`
- `approvalRiskThreshold`
- `reviewToastDurationMs`

Print or update the `guardian` section:

```bash
vvoc guardian config --print
vvoc guardian config --model "anthropic/claude-sonnet-4-5" --variant high
```

The runtime prompt is loaded from `guardian.md`, preferring `./.vvoc/agents/guardian.md` over the global `vvoc` agents directory.

### MemoryPlugin

`MemoryPlugin` adds explicit persistent memory tools and installs a report-only `memory-reviewer` subagent.

Memory scopes are `session`, `branch`, `project`, and `shared`. Writes default to `project`; `shared` is cross-project, the rest are repository-local.

Available tools:

- `memory_search`
- `memory_get`
- `memory_put`
- `memory_update`
- `memory_delete`
- `memory_list`

Memory is explicit-only:

- stored entries are never injected into prompts automatically
- the agent must call memory tools directly when durable context is useful
- `memory-reviewer` can read memory but cannot modify it

Supported `memory` fields:

- `enabled`
- `defaultSearchLimit`
- `reviewerModel`
- `reviewerVariant`

Example:

```text
@memory-reviewer review the current memory and suggest keep/update/merge/delete actions
```

The runtime prompt is loaded from `memory-reviewer.md`, preferring `./.vvoc/agents/memory-reviewer.md` over the global `vvoc` agents directory.

### SystemContextInjectionPlugin

`SystemContextInjectionPlugin` injects reusable system guidance into primary sessions without polluting known subagent prompts.

The default injected guidance tells the main session to proactively use the `explore` subagent when the task depends on unfamiliar code, unclear scope, or multiple candidate implementation areas.

### SecretsRedactionPlugin

`SecretsRedactionPlugin` redacts secrets from chat content before LLM requests and restores placeholders afterward where needed.

Settings live in the `secretsRedaction` section of canonical `vvoc.json`.

The default seeded config uses:

```json
{
  "secret": "${VVOC_SECRET}"
}
```

Set `VVOC_SECRET` if you want placeholder restoration to stay stable across restarts.

Built-in patterns cover common identifiers and tokens such as email addresses, UUIDs, IP and MAC addresses, bearer tokens, and common OpenAI, Anthropic, GitHub, AWS, and Stripe-style keys.

## Managed Prompts And Agents

Managed prompt files are created for:

- `guardian`
- `memory-reviewer`
- `enhancer`
- `implementer`
- `spec-reviewer`
- `code-reviewer`
- `investitagor`

OpenCode agent registrations written by `vvoc install` and `vvoc sync` are:

- `enhancer`
- `implementer`
- `spec-reviewer`
- `code-reviewer`
- `investitagor`

Plugin runtime agents are:

- `guardian`
- `memory-reviewer`

If a managed prompt file is missing, rerun one of these commands:

```bash
vvoc install
vvoc sync
```

## Local Development

Install dependencies:

```bash
bun install
```

Run the local verification stack:

```bash
bun run typecheck
bun run lint
bun run fmt:check
bun test
bun run build
bun run pack:check
```

Format source files:

```bash
bun run fmt
```

Smoke-test the built CLI against a temporary config root:

```bash
tmpdir="$(mktemp -d)"
bun run build
bun dist/cli.js install --config-dir "$tmpdir"
bun dist/cli.js status --config-dir "$tmpdir"
```

Git hooks are managed with `lefthook`.

## Publishing

Publishing is manual from the terminal.

Typical release flow:

```bash
bun run typecheck
bun run lint
bun run fmt:check
bun test
bun run build
bun run pack:check
npm publish
```

## Optional: RTK

[RTK](https://github.com/rtk-ai/rtk) is a CLI proxy that can reduce token usage for common developer commands. The interactive `vvoc init` flow recommends it after setup.
