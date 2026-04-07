# @osovv/vv-opencode

Portable OpenCode workflow package with plugins and a Bun CLI for install, sync, and cross-device setup.

Current package scope:

- `GuardianPlugin` for permission review
- `MemoryPlugin` for explicit persistent memory
- built-in `memory-reviewer` subagent for report-only memory audits
- vvoc-managed subagents: `implementer`, `spec-reviewer`, `code-reviewer`, `investitagor`
- `vvoc` CLI for bootstrap, sync, and diagnostics
- vvoc-managed config kept separate from OpenCode config

## What is included

- npm package: `@osovv/vv-opencode`
- binary: `vvoc`
- exported plugins:
  - `GuardianPlugin`
  - `MemoryPlugin`
- CLI commands:
  - `agent`
  - `completion`
  - `config`
  - `init`
  - `install`
  - `path-provider`
  - `plugin`
  - `sync`
  - `status`
  - `doctor`
  - `guardian`
  - `upgrade`
  - `version`

## Installation

Install into the current project:

```bash
bun add @osovv/vv-opencode
```

Use the CLI as:

```bash
vvoc --help
```

Examples below use `vvoc` directly and assume the binary is available in your `PATH`.

## OpenCode usage

Add the package to your OpenCode config with a pinned version:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@osovv/vv-opencode@<installed-version>"]
}
```

OpenCode loads all exported plugin functions from the package, so this enables both `GuardianPlugin` and `MemoryPlugin`.

`vvoc install` writes this pinned package specifier automatically and avoids stale `latest` plugin cache behavior inside OpenCode.

## Config layout

OpenCode config stays in OpenCode-managed locations:

- global: `$XDG_CONFIG_HOME/opencode/opencode.json` or `~/.config/opencode/opencode.json`
- project: `./opencode.json` or `./opencode.jsonc`

vvoc-managed config stays separate:

- global: `$XDG_CONFIG_HOME/vvoc/` or `~/.config/vvoc/`
- project: `./.vvoc/`

vvoc persisted data stays in the XDG data root:

- global data: `$XDG_DATA_HOME/vvoc/` or `~/.local/share/vvoc/`

Examples:

- global Guardian config: `~/.config/vvoc/guardian.jsonc`
- project Guardian config: `./.vvoc/guardian.jsonc`
- project-local memory data: `~/.local/share/vvoc/projects/<project-id>/memory/`
- global shared memory data: `~/.local/share/vvoc/memory/shared/<namespace>/`
- project memory settings: `./.vvoc/memory.jsonc`
- global managed agent prompts: `~/.config/vvoc/agents/*.md`
- project managed agent prompts: `./.vvoc/agents/*.md`

This keeps vvoc state clearly separated from native OpenCode config and avoids future clashes if OpenCode adds its own memory features.

## CLI

Show help:

```bash
vvoc --help
```

Show the installed `vvoc` package version:

```bash
vvoc version
```

Install package config and bootstrap Guardian + Memory config plus managed subagents:

```bash
vvoc install
```

`install` writes the current installed package version into the OpenCode `plugin` array instead of using an unpinned `latest` reference.
It also registers vvoc-managed subagents in OpenCode config and creates managed `guardian.jsonc`, `memory.jsonc`, and `vvoc/agents/*.md` prompt files when they are missing.

Use project scope instead of global scope:

```bash
vvoc install --scope project
```

Override the global config home used for both `opencode/` and `vvoc/`:

```bash
vvoc install --config-dir /tmp/vvoc-home
```

This writes:

- `/tmp/vvoc-home/opencode/opencode.json`
- `/tmp/vvoc-home/vvoc/guardian.jsonc`
- `/tmp/vvoc-home/vvoc/memory.jsonc`
- `/tmp/vvoc-home/vvoc/agents/guardian.md`
- `/tmp/vvoc-home/vvoc/agents/memory-reviewer.md`
- `/tmp/vvoc-home/vvoc/agents/implementer.md`
- `/tmp/vvoc-home/vvoc/agents/spec-reviewer.md`
- `/tmp/vvoc-home/vvoc/agents/code-reviewer.md`
- `/tmp/vvoc-home/vvoc/agents/investitagor.md`

Sync managed config files:

```bash
vvoc sync
```

Patch the global OpenCode StepFun provider to use the `stepfun.ai` endpoint:

```bash
vvoc path-provider stepfun-ai
```

This writes `provider.stepfun.options.baseURL = "https://api.stepfun.ai/v1"` into the global OpenCode config.
It does not manage auth for you, so keep using OpenCode's normal StepFun credential flow.

Manage model overrides for built-in and bundled agents:

```bash
vvoc agent list
vvoc agent general set openai/gpt-5-nano
vvoc agent explore set openai/gpt-5-nano
vvoc agent implementer set openai/gpt-5
vvoc agent code-reviewer set anthropic/claude-sonnet-4-20250514
vvoc agent spec-reviewer unset
```

`vvoc agent general set ...` and `vvoc agent explore set ...` write `agent.general.model` and `agent.explore.model` into OpenCode config so the built-in subagents do not inherit the main session model.

Inspect current setup:

```bash
vvoc status
vvoc doctor
```

Install shell completions for the current shell:

```bash
vvoc completion
```

For `zsh`, `vvoc completion` writes `~/.zsh/completions/_vvoc` and appends a small loader block to `~/.zshrc`.

Generate or print `guardian.jsonc`:

```bash
vvoc guardian config --print
vvoc guardian config --model "anthropic/claude-sonnet-4-5" --variant high
```

### Guardian config behavior

`vvoc` creates a managed `guardian.jsonc` with a marker header.

- managed files can be resynced safely
- existing unmanaged files are not overwritten unless `--force` is passed
- Guardian now reads vvoc-managed config from `.vvoc/` or `$XDG_CONFIG_HOME/vvoc/`
- `vvoc install` also creates `memory.jsonc` when it is missing

### Memory config behavior

`vvoc` also manages `memory.jsonc`.

Current supported settings:

```jsonc
{
  "enabled": true,
  "defaultSearchLimit": 8
}
```

Project config overrides global config.

## Memory plugin

`MemoryPlugin` adds explicit memory tools to OpenCode.

Available tools:

- `memory_search`
- `memory_get`
- `memory_put`
- `memory_update`
- `memory_delete`
- `memory_list`

Memory is explicit-only:

- stored entries are never injected into the prompt automatically
- the agent must call memory tools directly when it needs durable context
- memory settings live in `./.vvoc/memory.jsonc` or `$XDG_CONFIG_HOME/vvoc/memory.jsonc`
- session, branch, and project memory data live under `$XDG_DATA_HOME/vvoc/projects/<project-id>/memory/`
- shared memory data lives under `$XDG_DATA_HOME/vvoc/memory/shared/<namespace>/`
- the plugin adds a short system instruction that reminds the agent to consider memory tools proactively when durable context may help

Supported scopes:

- `session` - local to the current session in the current project
- `branch` - local to the current git branch in the current project
- `project` - local to the current project
- `shared` - global across projects

In practice:

- use `shared` for reusable personal preferences, reusable docs locations, and cross-project habits
- use `project` for repository-specific facts and workflows
- use `branch` for work that only matters on one branch
- use `session` for temporary context you want to keep only for the current session

### Memory review

The package also installs a bundled reviewer subagent named `memory-reviewer`.

Use it when you want a report-only audit of stored memory:

```text
@memory-reviewer review the current memory and suggest keep/update/merge/delete actions
```

The reviewer can read memory with `memory_list`, `memory_get`, and `memory_search`, but it does not modify entries.

## Managed agent prompts

`vvoc install` and `vvoc sync` create vvoc-managed prompt files under:

- global: `~/.config/vvoc/agents/*.md`
- project: `./.vvoc/agents/*.md`

This includes:

- `guardian.md`
- `memory-reviewer.md`
- `implementer.md`
- `spec-reviewer.md`
- `code-reviewer.md`
- `investitagor.md`

`GuardianPlugin` and `MemoryPlugin` now read `guardian.md` and `memory-reviewer.md` from those vvoc-managed paths at runtime.
There is no bundled runtime fallback, so missing files should be repaired with `vvoc install` or `vvoc sync`.

## Managed subagents

`vvoc install` and `vvoc sync` also register four OpenCode subagents in `opencode.json`:

- `implementer`
- `spec-reviewer`
- `code-reviewer`
- `investitagor`

Their prompt files also live under the same vvoc-managed `agents/` directory instead of being embedded directly into the TypeScript command code.

OpenCode registration stays in `opencode.json`, but each agent points its `prompt` field at the vvoc-managed file with a relative `{file:...}` reference.

Model overrides for these four subagents, plus the built-in `general` and `explore` subagents, are written into the corresponding `agent.<name>.model` entry inside OpenCode config via `vvoc agent ... set|unset`.

## Package API

Root exports:

```ts
import { GuardianPlugin, MemoryPlugin } from "@osovv/vv-opencode";
```

Subpath exports:

```ts
import { GuardianPlugin } from "@osovv/vv-opencode/plugins/guardian";
import { MemoryPlugin } from "@osovv/vv-opencode/plugins/memory";
```

## Local development

Install dependencies:

```bash
bun install
```

Run checks:

```bash
bun run typecheck
bun run lint
bun run fmt:check
bun test
bun run build
```

Format source files:

```bash
bun run fmt
```

Git hooks are managed with `lefthook`.

- `bun install` runs `lefthook install --force` through the `prepare` script
- the `pre-commit` hook runs `bun run lint` and `bun run fmt:check`

Smoke-test the CLI against a temporary config home:

```bash
tmpdir="$(mktemp -d)"
bun run build
bun dist/cli.js install --config-dir "$tmpdir"
bun dist/cli.js status --config-dir "$tmpdir"
```

## Publishing

This project is published manually from the terminal. There is no CI publish workflow.

Typical release flow:

```bash
bun run check
bun run build
bun run pack:check
npm publish
```

## Repository layout

- `src/plugins/guardian/` - Guardian OpenCode plugin runtime
- `src/plugins/memory/` - Memory OpenCode plugin runtime + system instruction
- `templates/agents/` - canonical managed prompt templates copied into `vvoc/agents/`
- `src/plugins/memory-store.ts` - file-based memory store and search logic
- `src/lib/opencode.ts` - config path resolution and JSONC helpers for the CLI
- `src/lib/vvoc-paths.ts` - shared vvoc/openCode path helpers
- `src/commands/` - `vvoc` commands
- `src/cli.ts` - CLI entrypoint
- `docs/` - GRACE planning, verification, and graph artifacts

## Notes

- `src/` is the source of truth
- `dist/` is generated output for packaging and local smoke tests
- if you change CLI behavior, plugin exports, vvoc config paths, or memory workflow, keep this README in sync

## Highly Recommended Addons

### RTK — LLM Token Optimizer

[RTK](https://github.com/rtk-ai/rtk) is a CLI proxy that reduces LLM token consumption by 60-90% on common dev commands like `git`, `ls`, `cat`, `rg`, `grep`, `pytest`, `cargo test`, and 100+ more. Single Rust binary, zero dependencies.

**Why use it with vvoc:**
- Transparent command rewriting — no workflow changes needed
- Works alongside vvoc's Guardian and Memory plugins
- Minimal overhead (<10ms)

**Quick install:**
```bash
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
rtk init -g --opencode
```

After install, commands like `git status` and `cargo test` are automatically rewritten to their RTK equivalents, producing compact output that costs 60-90% fewer tokens.

For more commands and details, see the [RTK documentation](https://github.com/rtk-ai/rtk).
