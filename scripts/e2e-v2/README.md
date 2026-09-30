# v2 real-host acceptance harness (`scripts/e2e-v2`)

Repeatable, isolated acceptance for the native OpenCode 2.0.18 rewrite of
`@osovv/vv-opencode`. The core tier exercises the **actual packed package** on the
pinned host; it is not a fixture reimplementation of selection, policy, or
permission behavior.

## What it does

1. Builds the package and packs it with `bun pm pack --ignore-scripts` (only the
   declared `files` ship).
2. Extracts the tarball into an isolated project's `node_modules` and symlinks the
   repository dependency tree so the packed package resolves with no registry
   access.
3. Writes an isolated project (`opencode.json`, `.vvoc/vvoc.json`) and a fixture
   plugin that:
   - imports the packed `./plugins/model-roles` subpath and the packed
     `dist/runtime/context.js`;
   - calls the real `ModelRolesPlugin.setup(ctx)`;
   - acquires the same shared `acquireNativeSnapshotRuntime(ctx)` instance;
   - exposes a nonce-protected `127.0.0.1` control plane that only forwards to
     real runtime methods (`snapshots`, `admitWorkload`, `client`, `permissions`).
4. Starts the pinned host with an allow-listed environment and a loopback-only
   OpenAI-compatible provider, then drives cases through the native HTTP API and
   the control plane.
5. Writes machine-readable evidence and tears everything down by exact PID only.

## Pinned inputs

| Input | Value |
| --- | --- |
| Host binary | `/tmp/opencode/vvoc-seam-host-2.0.18/opencode` |
| Host SHA-256 | `10d405161d8b9595f4a2ec31254e961969e6ca3f8239ac9bd55b6ff6431dc24f` |
| Host source commit | `cd9a14a6b688d4021bee381dfd39d2cef9c0f862` |
| Host version | `2.0.18` |
| Evidence | `.grace/changes/active/C-OPENCODE-V2-NATIVE/core-evidence.json` |
| Parity inventory | `scripts/e2e-v2/parity.json` |

Override the binary with `VVOC_E2E_V2_HOST`; override the scratch root with
`VVOC_E2E_SCRATCH`. A binary whose SHA-256 does not match the pin is refused.

## Modes

```bash
bun run e2e:v2                  # full installed-artifact parity (core + real-PTY TUI + installed surface)
bun scripts/e2e-v2.ts --core     # packed core real-host tier
bun scripts/e2e-v2.ts --tui      # real-PTY TUI tier for the installed TUI export
bun scripts/e2e-v2.ts --installed # installed-surface tier (rows mapped to it by parity.json)
bun scripts/e2e-v2.ts --list     # print the parity inventory by phase/status
bun scripts/e2e-v2.ts            # same as --full
bun scripts/e2e-v2.ts --full --json --keep   # JSON summary, keep the scratch dir
```

`--core` boots the pinned host against the packed package **installed with its
declared dependency graph** (no workspace `node_modules` symlinks) and exits
non-zero on a missing/invalid host or any failed case. `--tui` runs the actual
installed TUI export inside a real PTY against an isolated standalone host.
`--full` exits 0 only when every mandatory row is either verified against the
installed artifact or classified `residual-accepted` with a precise reason plus
cross-references (AC-11); a silently pending row or a `residual-accepted` row
missing a reason/cross-references counts as unverified and keeps `--full`
failing.
`--installed` verifies the installed package's root aggregate, every standalone
plugin subpath, the nine-tool catalog census, presets/variants, managed
agent/skill assets, and the installed `vvoc` CLI lifecycle. The installed
**aggregate** tier (`--aggregate`) additionally drives the installed root
aggregate on the real host: system-context injection, provider-reported
analytics usage, peak-hours primary-dispatch gating, real WebSocket transport
observation, and a native tool control plane (scripted loopback tool calls plus
native permission deny/allow) for permission-before-network rows. `--full` runs
all tiers, resolves every parity row, writes
`.grace/changes/active/C-OPENCODE-V2-NATIVE/parity-evidence.json`, and exits
non-zero while any mandatory parity row is unverified. A reduced matrix is never
reported as full parity.

## Installed artifact

`installPackedPackageWithDependencies` runs `bun install --ignore-scripts` in an
isolated project whose only dependency is the freshly packed tarball; dependency
resolution may use the local package-manager cache. `installedArtifactPathIssues`
proves every loaded package/dependency path resolves inside that isolated project
and never inside the workspace. Evidence records the tarball SHA-256, resolved
dependency versions, and loaded real paths.


## Core case matrix (`--core`)

| Case | What is asserted | Negative control |
| --- | --- | --- |
| `activation` | Packed subpath + runtime import, real setup, mandatory http/model guards, same-instance client challenge, fresh sessions unbound/un-staged | A fresh session has no capture and no staged candidate |
| `admission` | Rejected attachment preparation with zero dispatch then a later valid prompt dispatching exactly once and binding | The rejected preparation dispatches nothing and leaves the family unbound |
| `payload-variants` | One model sends two distinct captured variants; the qualified variant is present in native `model.list` | A fabricated variant is absent from `model.list` |
| `lineage-title` | Persistent parented auxiliary child, `vvocAuxiliary` metadata, shared capture; exactly one parent dispatch (native title suppressed) | An extra parent dispatch would be detected |
| `config-mutation` | Changed config binds new work; the already-bound family keeps its variant | Old family variant is unchanged after the change |
| `owned-generate-synthetic` | Real pre-admission publishes before native `session.generate`/`session.synthetic`, which dispatch the captured payload | Raw unbound generate/synthetic produce zero dispatch and no capture |
| `explicit-selection` | Explicit-at-create and explicit switch are preserved and dispatched | Explicit selection wins over the configured default |
| `fork-worktree` | Native fork (empty parentID + `fork.sessionID`) and worktree move keep the root family capture and dispatch its payload | Moved fork resolves the root family, not a new one |
| `permission-guard` | Awaited guard runs zero effects on deny and one on allow, including a fast reply | Deny must run zero effects; fast reply must not lose the event |
| `ordering-first-accepted` | The first-accepted input's policy binds over a first-staged differing policy | A fixture preparation delay (no admission logic) controls ordering |
| `hook-probe` | Which native hooks register on the pinned host | Availability only; no parity claim |
| `replay-restart` | Persisted root and auxiliary families re-bind their snapshot-qualified variants after a real host restart | Post-restart variants must equal the pre-restart variants |

## Isolation and safety

- The host child environment is allow-listed; inherited credentials, proxies, and
  user OpenCode config are dropped.
- The provider and the control plane bind `127.0.0.1` only; the fixture plugin
  refuses any non-loopback provider dispatch before it reaches the network.
- Provider traces never record authorization headers, so even fixture credentials
  stay out of evidence.
- Processes are signalled only by exact owned PID; foreign PIDs are refused and
  `pkill`/name matching is never used.
- The harness uses only `Service.discover`-style reads of the native registration
  password; it never calls service ensure/stop.
- No paid or public model requests are made.
- The packed package is the only source under test. Since the T-009-FULL work it
  is installed into an isolated project **with its declared dependency graph**
  (`bun install --ignore-scripts`, local package-manager cache only); see the
  Installed artifact section. Dependency resolution never falls back to
  symlinking the repository `node_modules`.

## Row classification (`parity.json`)

Every row ends the run as one of:

- **verified** (`implemented-core` / `implemented-full`) — the observation was
  made against the packed, installed artifact on the pinned host in this run.
- **residual-accepted** (AC-11) — the behavior cannot be exercised offline
  against this host (or is proven instead by an accepted dedicated suite). The
  row MUST carry a precise `residual.reason` and non-empty `residual.crossReferences`;
  the meta row only counts rows whose reason AND cross-references are present.
- **pending / unverified** — no installed-artifact observation and no accepted
  residual. `--full` fails on these; they are never promoted.

## Honest coverage limits

Recorded residuals (see `parity.json` + `parity-evidence.json`):

- **secrets live WebSocket**: the native session-WS gate
  (`core/src/session/model-request.ts:326-327`, `webSocket:'session'` in
  `runner/llm.ts`) was unreachable with a loopback provider (`wsOpened=false`);
  framing is proven at unit (`stream.test.ts`), HTTP-composition, and MID levels.
- **workflow + cancellation-recovery**: the aggregate verifies plugin load, the
  nine-tool census, `work_item_open` execution, a real foreground subagent launch
  (child session with parentID, attempt persisted `in_flight`) and a real
  background launch. The aggregate cancellation scenario is blocked by native
  offline observability: a child-session interrupt is a no-op for subagent runs
  (the subagent executes under the parent coordinator — pinned
  `core/session/execution.ts`: "Idle interruption is a no-op"), and a root
  interrupt in the fixture did not persist the partial assistant tool part, so
  the pinned `Subagent cancelled (sessionID:…)` / `Tool execution
  interrupted (sessionID:…)` parent evidence is not observable through the
  offline HTTP-API fixture. Settlement and the remaining lifecycle sub-checks are
  proven by the accepted T-004 real-host suites
  (`workflow.delegated.integration.test.ts`, `workflow.execution.integration.test.ts`,
  `cancellation.test.ts`) and the live root-interrupt shape fix (wi-20/c77f36d).

Other limits: same-model switches emit no native event and are not a
criterion. The `ordering-first-accepted` case controls same-session input ordering
through a fixture preparation delay after the real prompt hook (it never implements
admission); equal-time ordering **across** sessions remains covered by engine and
integration tests rather than forced on the host. The `--tui` tier drives the
actual built TUI in a real PTY (a narrow fixture composing the actual built
`dist/tui.js` plus the actual server model-roles plugin as the RPC bridge) and
reports only observed scenarios: `/context` Overview/Tools/MCP navigation,
narrow resize, key-driven scrolling, close/reopen, a visible peak-hours banner,
cache indicator and branding footer, a controlled collection failure without the
server bridge, and explicit-disabled negative controls. `--full` aggregates all
installed tiers and writes machine-readable evidence; it fails while any
mandatory row is pending/unverified (a `residual-accepted` row counts only with
a precise reason and cross-references) and never promotes a pending row.

## Module map

| File | Responsibility |
| --- | --- |
| `../e2e-v2.ts` | CLI modes, inventory listing, exit codes |
| `host.ts` | Isolation, packing, packed install, owned PIDs, loopback guard, native API |
| `provider.ts` | Loopback OpenAI-compatible provider and redacted request trace |
| `fixtures/plugin.ts` | Real-context fixture plugin and bounded control plane |
| `fixtures/model-catalog.json` | Deterministic loopback model catalog |
| `cases.ts` | Core case descriptors and observable assertions |
| `core.ts` | Core orchestration, driver, and evidence writer |
| `full.ts` | Installed-artifact full runner: tiers, row resolution, evidence |
| `full-cases.ts` | Parity-row/tier mapping and parity-evidence assembly |
| `tui.ts` | Real-PTY TUI tier (actual built TUI, screen-buffer assertions) |
| `parity.json` | Baseline surface inventory with phase and status |
