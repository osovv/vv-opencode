# Test Maintenance

A verification stack decays. Tests become stale, duplicate, flaky, or slower than the value they provide. Maintenance is part of verification, not an afterthought.

## Stale tests

A stale test encodes an old contract. It can silently override the current specification because a failing implementation is "wrong" by the test's definition. This is a real specification-drift risk: tests can take priority over the specification, especially test suites nobody remembers or reviews.

Policy:

1. Every test should name the property or requirement it protects.
2. When a requirement changes, update or delete the test in the same change.
3. A test that cannot fail for the claimed reason is not protecting anything; delete it.
4. A test that duplicates another test adds maintenance cost without adding discrimination; keep the stronger one.
5. A test written for a one-off investigation is not a permanent regression test unless it is promoted deliberately.

A useful pruning instruction is a bounded, reviewable goal: instead of "clean up the tests", ask for "remove the least useful tests while keeping the critical claims covered". The principle is a measurable outcome, not a vague tidy-up.

## Mutation testing and kill matrix

Mutation testing changes the implementation in small ways and checks whether a test fails. A test that survives a relevant mutation is not discriminating. A kill matrix records which test kills which mutation and exposes duplicates.

Use mutation testing as a targeted audit:

- On a critical module where the test suite is large and its value is unclear.
- Before deleting tests, to see which ones are load-bearing.
- After a defect escapes, to check whether the existing tests would have caught the class of defect.

Do not run full mutation testing on every change. Aggressive mutation testing can be extremely expensive, with a poor return on tokens and time. A kill matrix is a scalpel, not a default gate.

A practical kill-matrix rule: keep a test only if it catches something no other test catches. A test that catches nothing unique is a candidate for deletion.

## Flaky tests

A flaky test is worse than a missing test because it trains everyone to ignore failures.

- Quarantine it: move it out of the blocking suite, keep it visible, and assign an owner.
- Fix the cause: time, ordering, shared state, network, randomness, or an unstated environment assumption.
- If it cannot be made deterministic, replace it with a deterministic oracle at a lower level and keep the flaky scenario as a manual or scheduled check.
- Never average a flaky test into "mostly passing".

## Coverage versus value

Coverage is a map of executed lines, not a measure of verified behavior. Use it to find unexercised code, then ask what claim that code needs. Do not use a coverage target as evidence for correctness, and do not preserve a low-value test just because it raises a number.

A useful review question: "If this test were deleted, which defect would escape?" If the answer is "none that another test would not catch", the test is a candidate for deletion.

## Incident to regression test

Every production incident should produce a regression test or eval that fails before the fix and passes after it. The test should reproduce the class of failure, not only the exact symptom. Keep it in the permanent set. If the incident cannot be reproduced deterministically, record the environment and the evidence, and add the closest deterministic check.

The incident becomes a new requirement or eval, and the loop returns to the specification. The test is the memory of the failure.

## Test-code quality

Test code is code. Apply the same standards:

- Arrange, act, assert in a readable order.
- One reason to fail per test where practical.
- No hidden sleeps, real network calls, or shared mutable state in the deterministic suite.
- Assert on structured values, not long unstable prose.
- Make the failure message name the property and the observed value.
- Keep fixtures small and owned; a fixture that nobody understands is a liability.
- Prefer the public boundary over private helpers, unless the helper is the unit under test.

## Pruning policy

When the suite is large, prune deliberately:

1. List tests by the claim they protect.
2. Mark duplicates and tests that cannot fail for the claimed reason.
3. Run a targeted mutation audit on the critical modules.
4. Delete or merge the weakest tests.
5. Re-run the suite and confirm the critical claims still have evidence.
6. Record the pruning decision and the residual risk.

Do not prune by coverage alone. Do not keep a test because it is old, green, or expensive to understand. Keep it because it protects a claim.

## Anti-patterns

- Keeping a stale test because "it passes".
- Adding a test for every line of implementation.
- Treating a coverage percentage as a correctness claim.
- Running mutation testing on every change and calling the cost "quality".
- Ignoring a flaky test until it blocks a release.
- Fixing an incident without a regression test.
- A test that fails for an unrelated reason and is retried until green.
- A test suite nobody can run locally.
