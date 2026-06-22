# GRACE 4 Project Engineering Protocol

## Keywords
opencode, plugins, workflow, model-roles, hashline-edit, work-items, controller

## Annotation
Portable OpenCode workflow package with plugins and a Bun CLI for install, sync, semantic model-role assignment, controller-led workflow routing, safer editing, secrets redaction, and cross-device setup.

## GRACE 4 Source of Truth

This project uses the GRACE 4 `.grace` artifact model.

- Product and technical context: `.grace/context/*.xml`
- Current graph projection source: `.grace/graph/index.xml` plus routed graph documents such as `.grace/graph/main.xml`
- Current verification projection source: `.grace/verification/index.xml` plus routed verification documents such as `.grace/verification/main.xml`
- Active work: `.grace/changes/active/C-*/spec.xml` and `.grace/changes/active/C-*/plan.xml`
- Completed or terminal work: `.grace/changes/archive/C-*/*`

Legacy `docs/*.xml` files are GRACE 3 migration sources only. They are not current GRACE 4 state. Do not validate, convert, delete, or treat them as source of truth unless the user explicitly requests a legacy cleanup or audit step.

## Project Snapshot

- package name: `@osovv/vv-opencode`
- CLI binary: `vvoc`
- primary runtime: `Bun`
- language: `TypeScript`
- CLI framework: `citty`
- public plugin exports:
  - `GuardianPlugin`
  - `HashlineEditPlugin`
  - `ModelRolesPlugin`
  - `SystemContextInjectionPlugin`
  - `WorkflowPlugin`
  - `SecretsRedactionPlugin`
- current command set includes: `init`, `install`, `sync`, `launch`, `status`, `doctor`, `version`, `role`, `preset`, `config validate`, `plugin list`, `plugin enable`, `plugin disable`, `patch-provider`, `completion`, `guardian config`, `upgrade`

## Repository Rules

1. `src/` is the source of truth for implementation behavior.
2. `dist/` is generated output. Never edit it manually.
3. Publishing is manual from the terminal with `npm publish`. Do not add CI publish workflows unless explicitly requested.
4. If CLI behavior, package exports, setup flow, or config locations change, update `README.md` in the same change.
5. This package manages user config, so prefer conservative, idempotent writes over aggressive rewrites.
6. If modules, public exports, data flows, verification strategy, commands, critical scenarios, or log markers change, update the relevant `.grace` graph and verification artifacts in the same change.

## Core Principles

### 1. Never Write Code Without a Contract
Before generating or editing any module, create or update its `MODULE_CONTRACT` with PURPOSE, SCOPE, INPUTS, and OUTPUTS. Code implements the contract, not the other way around.

### 2. Semantic Markup Is Load-Bearing Structure
Markers like `// START_BLOCK_<NAME>` and `// END_BLOCK_<NAME>` are navigation anchors, not decoration. They must be uniquely named, paired, and proportionally sized so one block fits inside an LLM working window.

### 3. GRACE Graph Is Always Current
`.grace/graph/index.xml` and routed graph documents are the project map. When you add a module, move a module, rename exports, or add dependencies, update `.grace/graph/*` so future agents can navigate deterministically.

### 4. Verification Is a First-Class Artifact
Testing, traces, and log anchors are designed before large execution waves. `.grace/verification/index.xml` and routed verification documents are the verification contract. Logs are evidence. Tests are executable contracts.

### 5. Top-Down Synthesis
Code generation follows:
`GraceRequirements -> GraceTechnology/Principles -> GraceGraph -> GraceVerification -> Code + Tests`

Never jump straight to code when requirements, architecture, or verification intent are still unclear.

### 6. Governed Autonomy
Agents have freedom in HOW to implement, but not in WHAT to build. Contracts, specs, plans, graph references, verification entries, and user instructions define the allowed space.

## Working Conventions

### CLI and packaging

- Local consumers of a project dependency should run `vvoc` through `bun x vvoc` or `bun run vvoc`.
- Root package exports must stay valid:
  - `@osovv/vv-opencode`
  - `@osovv/vv-opencode/plugins/guardian`
  - `@osovv/vv-opencode/plugins/hashline-edit`
  - `@osovv/vv-opencode/plugins/model-roles`
  - `@osovv/vv-opencode/plugins/system-context-injection`
  - `@osovv/vv-opencode/plugins/workflow`
  - `@osovv/vv-opencode/plugins/secrets-redaction`
- Local quality tooling uses `oxlint`, `oxfmt`, and `lefthook`.
- `lefthook` owns the `pre-commit` hook and should keep running lint + format checks.
- Before release, run:
  - `bun run typecheck`
  - `bun run lint`
  - `bun run fmt:check`
  - `bun test`
  - `bun run build`
  - `bun run pack:check`
  - `bun run release:check` when release/schema consistency matters

### Config safety

- OpenCode config remains in OpenCode-managed paths.
- vvoc-managed config must live in `$XDG_CONFIG_HOME/vvoc/` or project-local `.vvoc/`.
- `guardian.jsonc` may only be auto-rewritten when it is clearly managed by `vvoc`, unless the user explicitly forces overwrite.
- Persisted vvoc data must live in `$XDG_DATA_HOME/vvoc/`.
- Never silently clobber user-owned config.

### Documentation and GRACE sync

- If command names, flags, examples, install flow, or vvoc config paths change, update `README.md`.
- `vvoc install` should keep writing a pinned package specifier to the OpenCode plugin array.
- If modules, public exports, dependencies, or data flows change, update `.grace/graph/*`.
- If commands, test strategy, critical scenarios, phase gates, or log markers change, update `.grace/verification/*`.
- Legacy `docs/*` GRACE 3 artifacts are retained only until explicit cleanup approval.

## Semantic Markup Reference

### GRACE XML Anchors

- GRACE semantic anchors are XML tags, never attributes: use `<M-EXAMPLE />`, not `<Module ref="M-EXAMPLE" />`.
- Module IDs use `M-*`; data-flow IDs use `DF-*`; graph document wrappers use `GD-*`; verification entries use `V-M-*`; verification document wrappers use `VD-*`; change bundles use `C-*`.
- Index documents route to owning documents. Anchors listed in an index must appear as direct anchors in the routed document.

### Module Level
```
// FILE: path/to/file.ext
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: [What this module does - one sentence]
//   SCOPE: [What operations are included]
//   DEPENDS: [List of module dependencies]
//   LINKS: [Knowledge graph and verification references]
//   ROLE: [Optional: RUNTIME | TEST | BARREL | CONFIG | TYPES | SCRIPT]
//   MAP_MODE: [Optional: EXPORTS | LOCALS | SUMMARY | NONE]
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   exportedSymbol - one-line description
// END_MODULE_MAP
```

### Function or Component Level
```
// START_CONTRACT: functionName
//   PURPOSE: [What it does]
//   INPUTS: { paramName: Type - description }
//   OUTPUTS: { ReturnType - description }
//   SIDE_EFFECTS: [External state changes or "none"]
//   LINKS: [Related modules/functions]
// END_CONTRACT: functionName
```

### Code Block Level
```
// START_BLOCK_VALIDATE_INPUT
// ... code ...
// END_BLOCK_VALIDATE_INPUT
```

### Change Tracking
```
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.2.0 - What changed and why]
// END_CHANGE_SUMMARY
```

### Optional Lint Semantics

Use `ROLE` and `MAP_MODE` only when the file should be linted differently from a normal runtime module.

- `RUNTIME` + `EXPORTS`: normal source files with public APIs
- `TEST` + `LOCALS`: tests where the map should describe helpers, fixtures, and assertion surfaces
- `BARREL` + `SUMMARY`: re-export aggregators and grouped entry points
- `CONFIG` + `NONE`: build or tool configuration files
- `TYPES` + `EXPORTS`: pure type/interface modules
- `SCRIPT` + `LOCALS`: CLI/bootstrap/smoke scripts

## Verification Conventions

`.grace/verification/main.xml` is the project-wide verification contract. Keep it current when module scope, test files, commands, critical log markers, or gate expectations change.

Testing rules:
- deterministic assertions first
- trace or log assertions when trajectory matters
- module-local tests should stay close to the module they verify
- wave-level and phase-level checks should be explicit in the verification plan
- GRACE 4 validation commands for this project use `bunx @osovv/grace-cli@rc lint --path .` and `bunx @osovv/grace-cli@rc status --path .`

## File Structure
```
.grace/
  context/
    requirements.xml
    technology.xml
    principles.xml
    deployment.xml
    ux-guidelines.xml
  graph/
    index.xml
    main.xml
  verification/
    index.xml
    main.xml
  changes/
    active/
    archive/
src/
  cli.ts
  commands/
  lib/
  plugins/
```

## Rules for Modifications

1. Read the `MODULE_CONTRACT` before editing any source or test file.
2. After editing source or test files, update `MODULE_MAP` in a way that matches the file's role and map mode.
3. After adding, removing, renaming, or changing modules or public exports, update `.grace/graph/*`.
4. After changing test files, commands, critical scenarios, phase gates, or log markers, update `.grace/verification/*`.
5. After fixing bugs, add a `CHANGE_SUMMARY` entry and strengthen nearby verification if the old evidence was weak.
6. Never remove semantic markup anchors unless the structure is intentionally replaced with better anchors.
7. Do not create retroactive `C-*` bundles for historical GRACE 3 artifacts.
