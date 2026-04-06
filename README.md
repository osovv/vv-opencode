# @osovv/vv-opencode

Portable OpenCode workflow package with plugins and a Bun CLI for install, sync, and cross-device setup.

Current package scope:

- `GuardianPlugin` for permission review
- `MemoryPlugin` for explicit persistent memory
- `vvoc` CLI for bootstrap, sync, and diagnostics
- vvoc-managed config kept separate from OpenCode config

## What is included

- npm package: `@osovv/vv-opencode`
- binary: `vvoc`
- exported plugins:
  - `GuardianPlugin`
  - `MemoryPlugin`
- CLI commands:
  - `install`
  - `sync`
  - `status`
  - `doctor`
  - `guardian config`

## Installation

Install into the current project:

```bash
bun add @osovv/vv-opencode
```

If installed locally, run the binary as:

```bash
bun x vvoc --help
```

or:

```bash
bun run vvoc --help
```

Plain `vvoc` only works when the binary is available in your `PATH`, for example after a global install.

## OpenCode usage

Add the package to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@osovv/vv-opencode"]
}
```

OpenCode loads all exported plugin functions from the package, so this enables both `GuardianPlugin` and `MemoryPlugin`.

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
- global memory data: `~/.local/share/vvoc/projects/<project-id>/memory/`
- project memory settings: `./.vvoc/memory.jsonc`

This keeps vvoc state clearly separated from native OpenCode config and avoids future clashes if OpenCode adds its own memory features.

## CLI

Show help:

```bash
bun x vvoc --help
```

Install package config and bootstrap Guardian config:

```bash
bun x vvoc install
```

Use project scope instead of global scope:

```bash
bun x vvoc install --scope project
```

Override the global config home used for both `opencode/` and `vvoc/`:

```bash
bun x vvoc install --config-dir /tmp/vvoc-home
```

This writes:

- `/tmp/vvoc-home/opencode/opencode.json`
- `/tmp/vvoc-home/vvoc/guardian.jsonc`
- `/tmp/vvoc-home/vvoc/memory.jsonc`

Sync managed config files:

```bash
bun x vvoc sync
```

Inspect current setup:

```bash
bun x vvoc status
bun x vvoc doctor
```

Generate or print `guardian.jsonc`:

```bash
bun x vvoc guardian config --print
bun x vvoc guardian config --model "anthropic/claude-sonnet-4-5" --variant high
```

### Guardian config behavior

`vvoc` creates a managed `guardian.jsonc` with a marker header.

- managed files can be resynced safely
- existing unmanaged files are not overwritten unless `--force` is passed
- Guardian now reads vvoc-managed config from `.vvoc/` or `$XDG_CONFIG_HOME/vvoc/`
- `vvoc install` also creates `memory.jsonc` when it is missing

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
- memory data lives under `$XDG_DATA_HOME/vvoc/projects/<project-id>/memory/`
- the plugin adds a short system instruction that reminds the agent to consider memory tools proactively when durable context may help

Supported scopes:

- `session`
- `branch`
- `project`
- `shared`

### Memory review

The package also installs a bundled reviewer subagent named `memory-reviewer`.

Use it when you want a report-only audit of stored memory:

```text
@memory-reviewer review the current memory and suggest keep/update/merge/delete actions
```

The reviewer can read memory with `memory_list`, `memory_get`, and `memory_search`, but it does not modify entries.

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
npm publish
```

## Repository layout

- `src/plugins/guardian.ts` - Guardian OpenCode plugin
- `src/plugins/memory.ts` - Memory OpenCode plugin and reviewer subagent config
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
