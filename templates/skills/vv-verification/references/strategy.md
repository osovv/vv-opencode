# Verification Strategy

## Contents
- Risk first
- Test levels
- Cost and confidence
- CI split
- Coverage is a weak signal
- Choosing a level
- Layered example
- Anti-patterns

Use this reference to choose **where** to verify a claim. The oracle choice (what counts as correct) lives in `oracles.md`; this file decides the level, cost, and CI placement.

## Risk first

Classify the claim before choosing a test. The size of the diff is a weak signal; the blast radius is the real signal.

| Risk class | Typical claim | Cheapest useful level | Often too weak |
|---|---|---|---|
| Pure logic | A parser, formatter, calculator, or state transition returns the right value | Unit, property-based | End-to-end for a pure function |
| Module contract | A public function or API keeps its shape and errors | Contract test at the boundary | Unit test of a private helper |
| Integration | Two real components collaborate through a database, queue, HTTP, or filesystem | Integration with real collaborators and stubbed externals | Mocking both sides and calling it integration |
| Persisted data | A migration, schema, or backfill preserves data | Migration test plus a rehearsal on a copy | A unit test of the migration function only |
| Money | A charge, refund, invoice, or balance is exactly right | Contract plus recorded external request plus reconciliation | A UI snapshot |
| Permissions and security | A role cannot read or mutate what it should not | Contract plus adversarial cases plus a real authorization path | A happy-path login test |
| Concurrency | No lost update, duplicate, deadlock, or ordering violation | Property or model check plus a stress test | A single-threaded unit test |
| User-facing flow | A user can complete a scenario and sees the right result | Browser or end-to-end with real rendering | A backend test with no UI |
| Deployment and environment | The artifact starts, migrates, and serves in the target environment | Smoke test in the target environment | A local unit test |
| Operational behavior | Latency, error rate, logs, metrics, or traces meet a bound | Runtime observation with a measurable threshold | A green unit suite |
| AI behavior | A prompt, model, or pipeline produces an acceptable distribution of outcomes | Eval run with a rubric and a held-out set | A single manual chat |

## Test levels

### Unit

Fast, deterministic, no network. Best for pure logic, edge cases, and boundary conditions. Weak for integration, serialization drift, deployment, and user-visible behavior.

### Contract

Exercises a public boundary through its real interface: an HTTP handler, a CLI command, a bot update handler, a module export, a schema. Assert on structured payloads and error shapes, not on long prose. This is usually the highest-value automated layer for agent-written code because it catches interface drift without requiring a full environment.

### Integration

Runs the real collaborators you own: database, queue, worker, filesystem, HTTP callbacks, persistence. Stub only external providers you do not control. This catches orchestration and transaction bugs that contract tests cannot see.

### End-to-end and browser

Drives the product as a user would. Use it for a small number of critical paths, rendering, and cross-boundary behavior. Browser tests are expensive and can encode an unrealistic safe path; keep them scenario-based and few. A screenshot or video is evidence of what the user saw, not proof that every branch is correct.

### Smoke

A tiny set that proves the artifact starts, migrates, and serves in a real environment. Smoke is for deployment and environment risk, not for regression coverage. Run it on the environment where the risk exists.

### Property and model

Property-based tests assert a relation over many generated inputs. Model checking explores a state machine or protocol exhaustively within a model. Both are stronger than examples for quantified claims, and both require a good property or model; a bad property proves nothing.

### Eval

An eval is a scored set of tasks, traces, or rubric judgments. Use it when the target is a model or an AI pipeline, or when the behavior is probabilistic. An eval is one oracle among others, not a replacement for deterministic checks around it.

## Cost and confidence

| Oracle | Cost | Confidence | Best for |
|---|---|---|---|
| Exact expected output | Low | High for the covered example | Stable, small, fully specified values |
| Target or reproduction test | Low to medium | High for the reproduced defect | Bug fixes and regressions |
| Property-based | Medium | High for the stated property | Parsers, serializers, invariants, ranges |
| Contract test | Low | High at the boundary | Public interfaces and errors |
| Integration test | Medium | High for owned collaboration | Transactions, queues, persistence |
| Browser or end-to-end | High | High for the exercised path | Critical user journeys |
| Model checking | High | High within the model | State machines, protocols, concurrency |
| Dependent proof | Very high | High within the formalization | Algorithms with stable specifications |
| LLM judge or eval | Medium to high | Probabilistic | Fuzzy or distributional behavior |

Choose the cheapest oracle that can still fail for the claimed reason. A cheap oracle that cannot reach the risk is not cheap; it is false confidence.

## CI split

- **Per change:** unit, contract, and integration with stubbed external providers. These should be fast enough to run on every change and deterministic enough to trust.
- **Per merge or nightly:** browser and end-to-end paths, migration rehearsal, cross-environment smoke, and heavier property or model checks.
- **Per release:** the full eval or acceptance set, the real-environment smoke, and the rollback rehearsal.
- **On incident:** a new regression test or eval that fails before the fix and passes after it. Keep it in the permanent set.

Do not run the whole live suite on every commit. Do not hide the expensive checks in a dashboard that never blocks a merge; a check that cannot block is a report, not a gate.

## Coverage is a weak signal

Coverage measures lines executed, not behavior verified. A suite can have high coverage and still miss the risky branch, the stale contract, or the user path. Use coverage to find unexercised code, then ask what claim that code needs; do not use a coverage percentage as evidence for a correctness claim.

## Choosing a level

1. If the claim is about a pure function or a value, start with unit or property.
2. If the claim is about an interface, start with contract.
3. If the claim is about collaboration you own, start with integration.
4. If the claim is about what a user sees or does, use browser or end-to-end.
5. If the claim is about deployment or environment, use smoke in that environment.
6. If the claim is about an invariant over many interleavings, use a model or property check.
7. If the claim is about probabilistic behavior, use an eval with a rubric and a held-out set.

If two levels are plausible, pick the one that would have caught the failure you actually fear, then add the cheaper one as a regression net.

## Layered example

A chat bot has four useful layers, and the same shape generalizes to most services:

1. **Unit:** text normalization, callback parsing, permission checks, keyboard builders.
2. **Contract:** feed a synthetic platform update into the real handler, then assert which route ran, which service was called, and which outgoing API method and payload were produced.
3. **Integration:** run your own database, queue, worker, and HTTP callbacks; stub the platform, payment, and model providers.
4. **Live smoke:** a dedicated staging account and sandbox provider, a handful of real scenarios, never the main regression suite.

The lesson is not "use this framework". The lesson is: each layer answers a different claim, and the contract layer usually gives the best confidence per unit of maintenance.

## Anti-patterns

- Testing a private helper while the public boundary is broken.
- Mocking both sides of a collaboration and calling it integration.
- A browser suite that encodes a safe path a real user cannot reproduce.
- A snapshot of your own output that changes whenever the implementation changes.
- A test that passes for any input, or that cannot fail for the claimed reason.
- A green suite that never reaches the changed behavior.
- A coverage target used as a proxy for correctness.
- A live external dependency in the main regression suite.
- A stale test that contradicts the current specification.
- A test whose failure message does not identify the property that broke.
