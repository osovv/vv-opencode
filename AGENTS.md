# GRACE Framework - Project Engineering Protocol

## Keywords
opencode, plugins, workflow

## Annotation
Portable OpenCode workflow package with plugins and a Bun CLI for install, sync, and cross-device setup.

## Project Snapshot

- package name: `@osovv/vv-opencode`
- CLI binary: `vvoc`
- primary runtime: `Bun`
- language: `TypeScript`
- CLI framework: `citty`
- current exported plugin: `GuardianPlugin`
- current command set: `install`, `sync`, `status`, `doctor`, `guardian config`

## Repository Rules

1. `src/` is the source of truth.
2. `dist/` is generated output. Never edit it manually.
3. Publishing is manual from the terminal with `npm publish`. Do not add CI publish workflows unless explicitly requested.
4. If CLI behavior, package exports, or setup flow changes, update `README.md` in the same change.
5. This package manages user config, so prefer conservative, idempotent writes over aggressive rewrites.

## Core Principles

### 1. Never Write Code Without a Contract
Before generating or editing any module, create or update its MODULE_CONTRACT with PURPOSE, SCOPE, INPUTS, and OUTPUTS. The contract is the source of truth. Code implements the contract, not the other way around.

### 2. Semantic Markup Is Load-Bearing Structure
Markers like `// START_BLOCK_<NAME>` and `// END_BLOCK_<NAME>` are navigation anchors, not documentation. They must be:
- uniquely named
- paired
- proportionally sized so one block fits inside an LLM working window

### 3. Knowledge Graph Is Always Current
`docs/knowledge-graph.xml` is the project map. When you add a module, move a module, rename exports, or add dependencies, update the graph so future agents can navigate deterministically.

### 4. Verification Is a First-Class Artifact
Testing, traces, and log anchors are designed before large execution waves. `docs/verification-plan.xml` is part of the architecture, not an afterthought. Logs are evidence. Tests are executable contracts.

### 5. Top-Down Synthesis
Code generation follows:
`RequirementsAnalysis -> TechnologyStack -> DevelopmentPlan -> VerificationPlan -> Code + Tests`

Never jump straight to code when requirements, architecture, or verification intent are still unclear.

### 6. Governed Autonomy
Agents have freedom in HOW to implement, but not in WHAT to build. Contracts, plans, graph references, and verification requirements define the allowed space.

## Working Conventions

### CLI and packaging

- Local consumers of a project dependency should run `vvoc` through `bun x vvoc` or `bun run vvoc`.
- Root package exports must stay valid:
  - `@osovv/vv-opencode`
  - `@osovv/vv-opencode/plugins/guardian`
- Local quality tooling uses `oxlint`, `oxfmt`, and `lefthook`.
- `lefthook` owns the `pre-commit` hook and should keep running lint + format checks.
- Before release, run:
  - `bun run typecheck`
  - `bun run lint`
  - `bun run fmt:check`
  - `bun test`
  - `bun run build`

### Config safety

- `opencode.json` and `opencode.jsonc` must be handled conservatively.
- Preserve existing comments in JSONC edits where practical.
- `guardian.jsonc` may only be auto-rewritten when it is clearly managed by `vvoc`, unless the user explicitly forces overwrite.
- Never silently clobber user-owned config.

### Documentation sync

- If command names, flags, examples, or install flow change, update `README.md`.
- If modules or public exports change, update `docs/knowledge-graph.xml`.
- If commands, test strategy, or critical scenarios change, update `docs/verification-plan.xml`.

## Semantic Markup Reference

### Module Level
```
// FILE: path/to/file.ext
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: [What this module does - one sentence]
//   SCOPE: [What operations are included]
//   DEPENDS: [List of module dependencies]
//   LINKS: [Knowledge graph references]
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

`docs/verification-plan.xml` is the project-wide verification contract. Keep it current when module scope, test files, commands, critical log markers, or gate expectations change. Use `docs/operational-packets.xml` as the canonical schema for execution packets, graph deltas, verification deltas, and failure handoff packets.

Testing rules:
- deterministic assertions first
- trace or log assertions when trajectory matters
- module-local tests should stay close to the module they verify
- wave-level and phase-level checks should be explicit in the verification plan

## File Structure
```
docs/
  requirements.xml
  technology.xml
  development-plan.xml
  verification-plan.xml
  knowledge-graph.xml
  operational-packets.xml
src/
  cli.ts
  commands/
  lib/
  plugins/
```

## Rules for Modifications

1. Read the MODULE_CONTRACT before editing any file.
2. After editing source or test files, update MODULE_MAP in a way that matches the file's role and map mode.
3. After adding or removing modules, update `docs/knowledge-graph.xml`.
4. After changing test files, commands, critical scenarios, or log markers, update `docs/verification-plan.xml`.
5. After fixing bugs, add a CHANGE_SUMMARY entry and strengthen nearby verification if the old evidence was weak.
6. Never remove semantic markup anchors unless the structure is intentionally replaced with better anchors.
