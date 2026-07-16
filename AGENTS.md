# GRACE 4 Project Engineering Protocol

## Keywords

opencode, plugins, workflow, model-roles, hashline-edit, work-items, controller, Bun,
TypeScript, GRACE 4

## Annotation

Portable OpenCode workflow package with plugins and a Bun CLI for install, sync,
semantic model-role assignment, controller-led workflow routing, safer editing,
secrets redaction, and cross-device setup.

Use this file as the practical entry point for changes to `@osovv/vv-opencode`. It
combines the repository-specific working guide with the mandatory GRACE 4 engineering
protocol.

## GRACE 4 Source of Truth

This project uses the GRACE 4 `.grace` artifact model:

- Product and technical context: `.grace/context/*.xml`.
- Current graph projection: `.grace/graph/index.xml` plus routed graph documents such
  as `.grace/graph/main.xml`.
- Current verification projection: `.grace/verification/index.xml` plus routed
  verification documents such as `.grace/verification/main.xml`.
- Active work: `.grace/changes/active/C-*/spec.xml` and
  `.grace/changes/active/C-*/plan.xml`.
- Completed or terminal work: `.grace/changes/archive/C-*/*`.

Use the source that owns each concern:

- Runtime behavior: `src/` and executable tests beside the implementation.
- Public CLI/setup/config behavior: `README.md`.
- Package surface and scripts: `package.json`.
- Canonical vvoc config schema: `schemas/vvoc/v3.json`.
- Release policy: `.grace/context/deployment.xml`.

Historical Markdown under `docs/` is advisory only. Legacy `docs/*.xml` files are not
GRACE 4 state; if GRACE 3 artifacts appear, use `grace-migrate` and do not silently
validate, convert, or delete them. If authoritative sources disagree, stop and resolve
the conflict rather than guessing.

## GRACE Workflow Rules

1. Do not implement source behavior before an approved active `GraceChangeSpec` and
   `GraceChangePlan` exist, unless the user explicitly requests a small direct fix.
2. Treat `spec.xml` as normative. Treat `design-context.xml` as explanatory,
   non-normative memory.
3. Before executing a plan, inspect `BaselineAssertions`, `TargetAssertions`,
   `DurableScope`, and `ObservedWriteScope`.
4. For planned work, update durable graph and verification state inside the approved
   change lifecycle. For an explicitly requested direct fix, keep existing graph and
   verification projections truthful without creating a retroactive `C-*` bundle.
5. Never store transient run state by mutating approved XML lifecycle statuses. Runtime
   state is derived from current files, assertions, and scopes.
6. A source change is not complete when its module ownership, dependencies, data flows,
   or verification contract are stale.

## First Five Minutes

1. Run `git status --short` and do not overwrite unrelated user changes.
2. Read the relevant file's `MODULE_CONTRACT`, nearby tests, and matching entries in:
   - `.grace/graph/index.xml` → routed graph document
   - `.grace/verification/index.xml` → routed verification document
3. Confirm the public contract in `README.md`, `package.json`, or `schemas/` when the
   change affects commands, setup, config, exports, or packaging.
4. Edit `src/`, `templates/`, `schemas/`, or `scripts/` as appropriate. Never edit
   generated `dist/` output.
5. Run the narrowest relevant test first, then the broader gate required by the
   change-impact table below.

## Project Snapshot

- Runtime/package manager: Bun (`>=1.3.8`).
- Language: TypeScript, ESM.
- CLI framework: `citty`; binary name: `vvoc`.
- Package: `@osovv/vv-opencode`.
- Tests: Bun test files colocated under `src/` and `scripts/`.
- Quality tools: TypeScript, `oxlint`, `oxfmt`, and `lefthook`.
- Public plugins: Guardian, Hashline Edit, Model Roles, System Context Injection,
  Workflow, Secrets Redaction, and the `/context` TUI plugin. Modern TUI integration targets
  OpenCode `>=1.18.2`.

## Repository Map

| Area | Primary locations | Notes |
|---|---|---|
| CLI registration | `src/cli.ts` | Top-level command tree and CLI metadata. |
| CLI commands | `src/commands/*.ts` | Command implementation and colocated `*.test.ts`. |
| Config resolution | `src/lib/config-layers.ts`, `src/lib/vvoc-paths.ts` | vvoc, OpenCode runtime, and TUI env/project/global/default precedence and write targets. |
| Config document | `src/lib/vvoc-config.ts`, `schemas/vvoc/v3.json` | Strict canonical v3 parsing, rendering, and schema. |
| OpenCode mutation | `src/lib/opencode.ts` | Conservative runtime/TUI registration, inspection, and managed config writes. |
| Managed agents/skills | `src/lib/managed-agents.ts`, `src/lib/managed-skills.ts`, `templates/` | Installed by `vvoc install`/`sync`. |
| Model roles/presets | `src/lib/model-roles.ts`, `src/lib/agent-models.ts`, `src/lib/vvoc-preset-registry.ts` | Semantic role resolution and built-in presets. |
| Plugins | `src/plugins/` | Public plugin entry points and plugin-local tests. |
| TUI plugin | `src/tui.tsx`, `src/tui/context/` | Default TUI module, `/context` collection/analysis/dialog, and focused tests. |
| Workflow engine | `src/plugins/workflow/` | Protocol, state, transitions, tooling, repair, and persistence. |
| Release automation | `scripts/release-*.ts`, `.github/workflows/publish.yml` | Follow deployment policy; do not duplicate it here. |
| Public exports | `src/index.ts`, `package.json#exports` | Validate with `bun run pack:check`. |

For a deterministic architecture lookup, search `.grace/graph/main.xml` by module ID
(`M-*`) and follow its `Paths`, `Depends`, and `Verification` fields.

## Grep-First GRACE Navigation

1. Locate module ownership in `.grace/graph/index.xml`, then open the routed graph
   document and search for the relevant `M-*` anchor.
2. Locate verification ownership in `.grace/verification/index.xml`, then open the
   routed verification document and search for the matching `V-M-*` anchor.
3. Search `.grace/changes/active/C-*` for approved work that already owns the requested
   behavior.
4. Follow file-local `LINKS:` fields from module contracts back to graph and verification
   anchors.
5. Use `START_BLOCK_*` anchors to narrow source reads before loading large files.

The GRACE CLI also exposes `module`, `verification`, and `file` navigation commands.
Use the installed CLI's `--help` for current arguments rather than guessing syntax.

## GRACE CLI Checks

- `bunx @osovv/grace-cli@rc lint --path .` validates GRACE grammar, routed projections,
  assertions, lifecycle locations, and scope overlaps.
- `bunx @osovv/grace-cli@rc status --path .` summarizes durable and operational GRACE
  health.
- Run both whenever `.grace` artifacts change; treat failures as blockers rather than
  editing XML until it merely parses.

## Standard Change Workflow

1. **Bound the change.** Identify the owning module, public behavior, persistence/config
   effects, and verification target.
2. **Update the contract first.** Before changing source or tests, make the file's
   `MODULE_CONTRACT` describe the intended responsibility and dependencies.
3. **Preserve semantic structure.** Keep contract, map, change-summary, and block anchors
   paired and accurate.
4. **Add or strengthen verification.** Bug fixes need a regression assertion when one can
   be expressed deterministically.
5. **Implement the smallest safe diff.** Prefer existing helpers, naming, and config
   layering over new abstractions.
6. **Synchronize owned artifacts.** Update README, schema, GRACE graph, or GRACE
   verification whenever the impact table requires it.
7. **Run fresh verification.** Do not claim completion from old output or code inspection
   alone.

## GRACE Semantic Anchor and Markup Rules

Source and test files use semantic comments as navigation and maintenance contracts:

- Module IDs use `M-*`; data-flow IDs use `DF-*`; graph document wrappers use `GD-*`.
- Verification entries use deterministic `V-M-*`; verification document wrappers use
  `VD-*`; change bundles use `C-*`.
- GRACE semantic anchors are XML tags, never attributes: use `<M-EXAMPLE />`, not
  `<Module ref="M-EXAMPLE" />`.
- Anchors owned by an index must appear as direct elements in the routed document.

- `START_MODULE_CONTRACT` / `END_MODULE_CONTRACT` owns file purpose, scope,
  dependencies, GRACE links, role, and map mode.
- `START_MODULE_MAP` / `END_MODULE_MAP` must reflect the file's exported symbols or the
  configured `MAP_MODE` (`EXPORTS`, `LOCALS`, `SUMMARY`, or `NONE`).
- Function-level `START_CONTRACT` blocks document purpose, inputs, outputs, side effects,
  and links where that extra contract is useful.
- `START_BLOCK_*` / `END_BLOCK_*` anchors are load-bearing: keep names unique, paired,
  and small enough to navigate in one working window.
- For a bug fix or meaningful behavioral change, update `START_CHANGE_SUMMARY` with a
  concise reason and outcome.
- Do not remove anchors merely to simplify an edit.

File-local reference:

```ts
// START_MODULE_CONTRACT
//   PURPOSE: [What this module does]
//   SCOPE: [Bounded responsibility]
//   DEPENDS: [M-* dependencies, file dependencies, or none]
//   LINKS: [Related M-* and V-M-* anchors]
//   ROLE: [RUNTIME | TEST | BARREL | CONFIG | TYPES | SCRIPT]
//   MAP_MODE: [EXPORTS | LOCALS | SUMMARY | NONE]
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   exportedSymbol - one-line responsibility
// END_MODULE_MAP
//
// START_CONTRACT: functionName
//   PURPOSE: [What it does]
//   INPUTS: { paramName: Type - description }
//   OUTPUTS: { ReturnType - description }
//   SIDE_EFFECTS: [External state changes or none]
//   LINKS: [Related modules or functions]
// END_CONTRACT: functionName
//
// START_BLOCK_EXAMPLE
// ... implementation slice ...
// END_BLOCK_EXAMPLE
```

## Non-Negotiable Invariants

### Generated and public surfaces

- `src/` is the implementation source of truth; `dist/` is generated by `bun run build`.
- Keep all root, server plugin, and TUI subpath exports in `package.json` importable.
- If commands, flags, examples, setup flow, exports, or config paths change, update
  `README.md` in the same change.

### Config safety

- Never silently clobber user-owned config.
- Writes must be conservative and idempotent.
- OpenCode config stays in OpenCode-managed paths.
- Dedicated OpenCode TUI config stays in `tui.json(c)` under the selected OpenCode config
  directory; project scope keeps it inside `./.opencode/`.
- Global vvoc config lives under `$XDG_CONFIG_HOME/vvoc/`; project vvoc config lives
  under `./.vvoc/`; persisted data lives under `$XDG_DATA_HOME/vvoc/`.
- Effective reads resolve explicit env override, nearest project layer, global layer,
  then defaults where allowed.
- Canonical `vvoc.json` is strict schema v3. Invalid or old existing config must fail
  loudly instead of being silently migrated or repaired.
- `vvoc install` must keep a pinned package specifier in the OpenCode plugin array.
- `vvoc install`, `init`, and `sync` must keep the current pinned base package specifier in
  the TUI plugin array so OpenCode selects its `./tui` export, migrating legacy `/tui` specs
  without removing comments, unrelated settings, plugin entries, or tuple options.
- Runtime plugins share the startup config snapshot; config changes require an OpenCode
  restart rather than live reload behavior.

### Workflow behavior

- Tracked workflow operations use explicit work-item mode and required reviewer roles.
- Keep tracked result parsing fail-closed and preserve bounded recovery excerpts.
- `BLOCKED` and `NEEDS_CONTEXT` remain hard stops.
- Workflow persistence stays under
  `$XDG_DATA_HOME/vvoc/workflow/<sessionId>/workflow-state.json`.

## Change-Impact Table

| If you change… | Also inspect/update… | Minimum fresh evidence |
|---|---|---|
| One implementation helper | Its `MODULE_CONTRACT`, map, nearby tests | Targeted `bun test <file>` plus `bun run typecheck` when types are affected |
| A CLI command, flag, output, or setup flow | `src/cli.ts`, command tests, `README.md`, relevant `M-*`/`V-M-*` entries | Targeted command test, `bun run check`, `bun run build` |
| Config paths, precedence, schema, or data meaning | Config libs, `schemas/vvoc/v3.json`, README layout, graph and verification | Relevant config tests, `bun run check`, `bun run release:check` when schema/version consistency is involved |
| A module, dependency, data flow, or public export | `.grace/graph/*`, `src/index.ts`, `package.json#exports` as applicable | `bun run check`, `bun run build`; add `bun run pack:check` for exports/package surface |
| A test strategy, critical scenario, command gate, or log marker | `.grace/verification/*` | Targeted tests plus the recorded gate command |
| Managed agent or skill content | `templates/`, loader tests, README when user-facing behavior changes | `bun test src/lib/managed-agents.test.ts` or the owning loader test, then `bun run check` |
| Workflow protocol/state/transitions/persistence | All affected files under `src/plugins/workflow/`, graph, verification | `bun test src/plugins/workflow.test.ts`, `bun run typecheck`, `bun run build` |
| Release behavior or package/schema versioning | `.grace/context/deployment.xml`, release scripts/tests, changelog/schema/package metadata | `bun run release:check`, `bun run check`, `bun run pack:check` |
| Documentation only | Referenced commands, paths, and current code/schema | Review the diff and validate every changed command/path; code tests are optional unless the docs expose uncertain behavior |

## Verification Commands

```bash
bun install                         # install dependencies
bun test path/to/file.test.ts       # narrow test
bun run typecheck                   # TypeScript only
bun run lint                        # oxlint on src/
bun run fmt:check                   # oxfmt check on src/
bun run check                       # typecheck + lint + fmt check + all tests
bun run build                       # regenerate dist/ from source
bun run pack:check                  # build, import public exports, dry-run npm pack
bun run release:check               # package/schema/release consistency
bunx @osovv/grace-cli@rc lint --path .
bunx @osovv/grace-cli@rc status --path .
```

Choose checks by impact; do not run heavyweight release gates for a trivial isolated
change unless repository state or the requested scope requires them. Before release,
run `bun run release:check`, `bun run check`, and `bun run pack:check`.

## Completion Checklist

- [ ] The diff contains only intended files.
- [ ] Contracts, maps, block anchors, and change summaries remain accurate.
- [ ] User-owned config is not overwritten or broadened unexpectedly.
- [ ] README/schema/GRACE artifacts are synchronized when required.
- [ ] Relevant targeted tests pass with fresh output.
- [ ] The broader gate appropriate to the change passes, or any skipped check/blocker is
      reported explicitly.
- [ ] No generated `dist/` files were edited manually.

Do not create retroactive `C-*` bundles for already completed work.
