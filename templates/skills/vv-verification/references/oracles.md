# Oracle Design

## Contents
- The oracle problem
- Oracle catalog
- Selection matrix
- Fixtures
- The external-information test
- Anti-patterns

An oracle is the mechanism that decides whether an observed result is correct. The hardest part of verification is not running the code; it is knowing what the right answer is.

## The oracle problem

Every test needs an independent source of truth. When the source of truth is the implementation itself, the test tends to mirror the implementation and stops adding information. This is the practical form of the oracle problem: an oracle derived from the same context as the code cannot reliably detect that context's mistakes.

A concrete failure mode is an agent that can see the exact test suite. It may stop implementing the specification and start building for the tests, even against the specification. The lesson is not that tests are bad; it is that the oracle must be separated from the implementer and must carry information the implementer did not produce.

The same pattern appears when an agent writes both the code and the tests. The tests tend to encode the implementation's assumptions rather than an external intent. Human-written tests, target tests, invariants, properties, and real-environment observations are stronger because they bring information from outside that loop.

## Oracle catalog

### Example-based oracle

An explicit expected output for a specific input. Cheap and precise for stable, small, fully specified values. Weak when the expected value is copied from the implementation, when the output is long prose, or when the example does not cover the risky branch.

### Target or reproduction oracle

A test written to reproduce a specific defect or a specific requirement, not generated from the current implementation. It answers "does this exact failure still happen?" This is the strongest cheap oracle for bug fixes. Write it before the fix, confirm it fails for the reported reason, then fix without editing the reproduction.

### Property-based oracle

A property that must hold for all generated inputs: round-trip, idempotence, monotonicity, invariance under a transformation, bounds, ordering, or a relation between input and output. Property-based testing explores inputs a human would not write. It is only as good as the property; a vacuous property passes forever.

### Invariant plus proof oracle

State an invariant from the specification, require the implementation to produce evidence that the invariant holds, and have a test check the evidence. This is the core of evidence-based testing (see `evidence.md`). The architect formulates invariants, the coding agent carries the burden of proof, and the test checks the proof in the log. The oracle is the invariant, not the green status.

### Formal model oracle

Model the state machine or protocol, state the invariant, and let a model checker explore the reachable states. TLA+ is a common choice; Lean is used for dependent proofs of algorithms. The oracle is the formal model, and the result is a proof or a counterexample. This is stronger than examples for state and concurrency claims, and it is only as good as the model (see `formal.md`).

### Runtime and browser oracle

Observe the running system: a screenshot, a video, a DOM state, a network trace, a log marker, a metric, or a trace. This is often the only oracle that reaches rendering, deployment, and environment behavior. Browser tests with screenshots can be useful because they create a new context for the model; backend tests often do not create new information relative to logs. The weakness is that a screenshot proves what was rendered, not that every branch is correct.

### Human acceptance oracle

A human with the intent decides whether the observed behavior is acceptable. Use it for ambiguous product semantics, visual craft, and exploratory acceptance. It is expensive and not reproducible at scale; encode the decision as a fixture, property, or rubric where possible.

### LLM judge or verifier oracle

Another model scores the output against a rubric, or a verifier model scores candidate answers. Useful for fuzzy or distributional behavior; probabilistic, sensitive to prompt and model version, and vulnerable to proxy gaming. Discrete judges can have a high tie rate, and verifier trajectories must be inspected for shortcuts. Treat an LLM judge as one oracle, not as ground truth.

### Differential oracle

Compare the new implementation against a reference implementation, a previous version, or a second independent implementation on the same inputs. General testing theory, not a specific source. Strong when the reference is trusted and the input space is representative; weak when both implementations share the same misunderstanding.

### Metamorphic oracle

Assert a relation between outputs for related inputs, without knowing the exact output: scaling an input scales the output, permuting inputs permutes outputs, adding a neutral element does not change the result. General testing theory, not a specific source. Useful when an exact expected value is unavailable but a reliable relation exists.

## Selection matrix

| Claim | First oracle | Stronger oracle | Avoid |
|---|---|---|---|
| A specific bug is fixed | Target or reproduction test | Property that the bug violated | A new happy-path test only |
| A public interface is stable | Contract test | Consumer-driven contract | Unit test of a private helper |
| A value is correct for known inputs | Example-based | Property-based | Snapshot of the implementation's own output |
| A transformation is correct for all inputs | Property-based | Differential against a reference | A handful of examples |
| A state machine cannot reach a bad state | Invariant plus proof | TLA+ model check | A single-path integration test |
| An algorithm is correct | Property-based | Lean or another dependent proof | Example tests only |
| A user can complete a flow | Browser or end-to-end | Recorded video plus DOM assertions | Backend-only test |
| The artifact works in the target environment | Smoke in that environment | Canary or staged rollout | Local unit test |
| A model output is acceptable | Eval with a rubric | Held-out eval plus human review | One manual chat |
| A fuzzy output is acceptable | Human acceptance | LLM judge with calibration | Uncalibrated judge as gate |

## Fixtures

A fixture is external information made reusable. Prefer fixtures that come from the real contract: official update payloads, provider sandbox responses, recorded production traces with secrets removed, or approved golden files.

- **Official fixtures:** copy the documented shape, not your own serialization.
- **Approved fixtures:** a human reviews the expected artifact once; the test compares against it. Useful for generated output, reports, and rendering.
- **Recorded traces:** capture a real interaction, sanitize it, and replay it. Useful for integration and agent behavior.
- **Synthetic minimal fixtures:** construct the smallest input that exercises the property; keep them readable.

A fixture is stale when the contract changes and nobody updates it. Treat fixture maintenance as part of the test.

## The external-information test

Before trusting an oracle, ask:

1. Did this expected value come from the implementation, or from an independent source?
2. Could the implementation change while the oracle stays correct?
3. Could the oracle fail for the reason I care about?
4. Would a wrong implementation be able to satisfy this oracle without doing the work?

If the answer to 1 is "from the implementation", or the answer to 4 is "yes", the oracle is weak.

## Anti-patterns

- Asserting on a full snapshot of your own output.
- Recomputing the expected value with the same function under test.
- A mock that returns exactly what the implementation expects, with no contract check.
- A browser test that walks an unrealistic safe path.
- An LLM judge with no calibration, no held-out set, and no human spot check.
- A test that asserts only that no exception was thrown.
- A test that passes for any input, or that cannot fail for the claimed reason.
- A stale expected value kept alive because "the test is green".
- A test that encodes the current implementation as the specification.
