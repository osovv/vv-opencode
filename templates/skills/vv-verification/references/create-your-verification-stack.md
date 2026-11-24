# Create Your Verification Stack

Most repositories have tests but no explicit map from claims to evidence. This reference builds that map from the repository's own tooling, then turns it into invocable behavior: a verification CLI and two project-local skills. It is language-agnostic by design: discover what the project already uses, then record and wrap it.

What the stack consists of:

- `VERIFICATION.md` — the data: claim → oracle → command → evidence → gap → owner.
- A verification CLI — thin commands in the repository's own runner.
- A `verify` skill — routes "verify this change" to those commands.
- A `maintain-verification` skill — keeps the map, the CLI, and the skills truthful over time.

Only this bootstrap procedure ships with the tooling. The CLI and the two skills are generated in the target project and belong to it.

## When to use

Use this reference when:

- The repository has no documented verification map.
- A new contributor or agent cannot tell which command proves which behavior.
- The suite is large, slow, or unclear, and nobody knows which tests are load-bearing.
- A change needs a verification plan for a language or stack the host skill has not seen.

Do not use it to impose a test framework. Use it to make the existing surface legible and runnable.

## Discover the repository

Read the repository before writing anything. Record what exists, not what you wish existed.

- **Languages and runtimes:** the languages, versions, and runtime managers actually declared by the project.
- **Package manager and task runner:** the lockfile, workspace layout, and the commands the project already uses.
- **Test runners:** unit, contract, integration, end-to-end, browser, property-based, model-checking, and eval tools. Note the exact command and the config file.
- **CI:** which jobs run on a change, which run nightly, which run on release, and which are required to merge.
- **Environments:** local, container, staging, production, sandboxes, and the credentials or fixtures needed to run each.
- **Observability:** logs, metrics, traces, screenshots, videos, and where they are stored.
- **Deployment:** build, migration, rollout, rollback, and smoke procedure.
- **Existing tests:** the directories, naming conventions, fixtures, and the tests that are known to be flaky or stale.
- **Skill loading convention:** how this repository loads agent skills — an explicit skills array in the agent config, an `.agents/skills` directory, or another tool-specific location. The generated skills must live where this repository expects them.
- **Known gaps:** what the project cannot verify today and why.

Ask the user only for information the repository cannot answer, such as a business property or an environment you cannot inspect.

## Write VERIFICATION.md

Create `VERIFICATION.md` at the repository root unless the project already has a documented verification location. Keep it short enough to read and specific enough to run.

```markdown
# Verification

## Commands

| Purpose | Command | Runtime | Required to merge |
|---|---|---|---|
| Unit and contract tests | `<the CLI command>` | `<seconds>` | yes |
| Integration tests | `<the CLI command>` | `<seconds>` | yes |
| Browser or end-to-end | `<the CLI command>` | `<seconds>` | nightly |
| Smoke against staging | `<the CLI command>` | `<seconds>` | release |
| Lint and types | `<the CLI command>` | `<seconds>` | yes |

## Claim map

| Claim | Oracle | Command | Evidence | Residual gap | Owner |
|---|---|---|---|---|---|
| A user can complete the checkout flow | Browser test plus screenshot | `<command>` | Screenshot and trace | Payment sandbox differs from production | Payments |
| An expired card creates no charge | Contract test plus recorded provider request | `<command>` | Test output and request body | Provider sandbox only | Payments |
| A migration preserves existing rows | Migration test plus rehearsal on a copy | `<command>` | Row counts and checksum | Production data volume not reproduced | Data |

## Environments and fixtures

- Local:
- CI:
- Staging:
- Sandbox providers:
- Secrets or variables:

## Known gaps

- `<gap>` — why it exists, what would close it, and who owns it.

## Maintenance

- Stale-test review: `<cadence or trigger>`
- Flaky-test quarantine: `<location>`
- Mutation or kill-matrix audit: `<scope and cadence>`
- Incident-to-regression rule: `<where the test is added>`

Last reviewed: `<date>`
```

Adapt the sections; do not invent commands. If a command does not exist, write `missing` and record the gap.

## Create the verification CLI

Prefer thin CLI entry points over long prose. A command that produces evidence is testable, reusable, and cheaper for an agent than a wall of instructions.

- Use the repository's own runner: package scripts, a Makefile or justfile, a scripts directory, or the language's standard task runner.
- Expose one command per level you actually use — for example unit, contract, integration, e2e, smoke — or a single command with a level argument.
- Each command must exit nonzero on failure and print where the evidence artifact landed (report path, screenshot directory, trace) when one exists.
- Do not add a new framework or dependency to satisfy this; wrap what already runs.
- Record the commands in `VERIFICATION.md`. The generated skills call these commands and never inline long shell chains.

## Generate the project skills

Create two project-local skills beside the verification map. Default location is `.agents/skills/` (a cross-tool convention); if the repository already loads skills from another path, use that path instead. The default maintenance name is `maintain-verification`; rename it if the project has a stronger convention.

Before writing, check whether a skill with the default name already exists at the target location. If it does, read it first and integrate with it or rename the generated skill instead of overwriting user-owned content.

### verify

`.agents/skills/verify/SKILL.md` routes "verify this change" to the project's commands. Keep it thin: data lives in `VERIFICATION.md`, method in the host's verification skill.

```markdown
---
name: verify
description: Use when a change in this repository needs proof — run the right verification level, capture the evidence, and report residual risk
---

1. Read VERIFICATION.md for the claim map and the CLI commands.
2. Classify the change's risk and pick the level that reaches it.
3. Run the matching CLI command; keep the exit code and the artifact path.
4. Record an evidence ledger row: claim, property, oracle, command, artifact, result, residual risk.
5. For oracle choice, evidence design, or formal methods, follow the host's verification skill if available.
6. Never weaken a check to make it pass. If the map is wrong, say so and propose an update.
```

### maintain-verification

`.agents/skills/maintain-verification/SKILL.md` keeps the stack truthful. Run it after an incident, after a spec or plan change, after a runner, CI, or dependency change, when a test goes flaky, on a release cadence, or whenever `VERIFICATION.md` and reality drift.

```markdown
---
name: maintain-verification
description: Use to keep this repository's verification stack current — reconcile the claim map, CLI commands, and skills after incidents, spec changes, or tooling changes
---

1. Diff the claim map against the current tests: claims without evidence, evidence without claims.
2. Add a regression entry for every incident since the last pass; keep it in the permanent set.
3. Prune stale, duplicate, and non-discriminating entries; quarantine flaky tests with an owner.
4. Re-check the CLI commands against the current runners; keep exit codes and artifact paths meaningful.
5. Update VERIFICATION.md, the CLI, and both skills together — they must not diverge.
6. Refresh Last reviewed and record remaining gaps with owners.
```

Both generated skills stay thin. A generated skill that duplicates the map will drift; a generated skill that inlines commands will rot when the runner changes.

## Register the skills

- Discover how the repository loads skills. If a config file lists skill paths explicitly, propose adding the two new paths and show the exact snippet; apply it only after the user approves. Never edit user-owned configuration silently.
- If the repository's convention is directory auto-discovery, no config change is needed — create the files and report where they are.
- Tell the user how to invoke the skills afterwards, including a host restart if the host caches the skill list.

## The smallest useful stack

Start with the smallest set that covers the real risks:

1. One deterministic CLI command that runs the unit and contract tests.
2. One integration command for the collaborators you own.
3. One browser or end-to-end path for the critical user journey.
4. One smoke command for the target environment.
5. One lint and type command.
6. One regression entry per known incident.
7. `VERIFICATION.md`, the `verify` skill, and the `maintain-verification` skill that keep them usable.

Add a property or model check when a quantified or stateful claim appears. Add an eval when the target is probabilistic. Do not add a layer just because a pyramid diagram has it.

## Never impose a framework

- Use the project's existing runner, fixtures, and conventions.
- Do not add a dependency to satisfy this reference.
- Do not rewrite a working suite into a preferred style.
- Do not introduce a browser, a database, or a container the project does not already use.
- The generated CLI and the generated skills follow the same rule: they wrap what exists, they do not replace it.
- If the project has no runner, propose the smallest one that fits the stack and ask before adding it.

The skill travels across stacks; the repository's own commands are the source of truth.

## Keep it current

A verification map that nobody updates is worse than no map: it gives false confidence. The generated `maintain-verification` skill exists to prevent that.

- Run the maintain pass after every incident and before every release.
- Update the claim map when a requirement, interface, or environment changes.
- Remove claims that no longer matter; do not let the map become a museum.
- Re-run the CLI commands after a tool or runtime upgrade.
- Record the evidence location, not just "tests pass".
- Treat the map, the CLI, and the two skills as code: reviewed, owned, and versioned with the repository.
