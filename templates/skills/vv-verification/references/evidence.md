# Evidence-Based Testing

Evidence-based testing starts from the practice used for life-critical systems: code must demonstrate that a stated requirement is satisfied, not merely pass a green test. The practical question is not "do the tests pass?" but "what evidence proves this claim, and where is it recorded?"

## High-assurance traceability

Life-critical practice converges on the same shape:

- Requirements are explicit and traceable.
- Tests are derived from requirements and from identified failure modes, not only from the implementation.
- Independence and coverage are part of the evidence, not an afterthought.
- An auditor looks for a trace from requirement to design to code to test result, not for a green status.

The common shape is:

```text
requirement -> design -> code -> evidence -> test result
```

Every material requirement should be traceable to the code that implements it and to the evidence that demonstrates it. The trace is the audit object; the green status is not.

## Specification to invariant to proof to log check

A compact engineering variant that works with agents:

1. The architect reads the requirement, classifies it, and formulates an **invariant**: a statement that must hold if the requirement is satisfied.
2. The coding agent receives the **burden of proof**: it must make the implementation produce evidence that the invariant holds.
3. A test exercises the implementation to populate its logs or trace with that evidence.
4. The test checks the **evidence** in the log, not only the business return value.
5. The verification code merges with the implementation; the invariant and proof can often be very small.

This is stronger than an example test because the oracle is the invariant, and the evidence is produced by the implementation rather than copied from it. It also gives the agent a concrete obligation: prove this claim, not "make the tests green".

A generic shape:

```text
invariant I(requirement)
implementation produces evidence E when I holds
test asserts E is present and well-formed
test also asserts the observable behavior
```

The evidence must be specific enough that a wrong implementation cannot produce it accidentally. A log line that says "ok" without the relevant values is not evidence.

## Evidence ledger

Use a ledger for every material claim. It can live in the change description, the plan, the review, or a project `VERIFICATION.md`.

| Field | Meaning |
|---|---|
| Claim | The one-sentence statement under test |
| Property | The invariant or behavior that must hold |
| Oracle | The independent source of truth |
| Command | The exact reproducible command |
| Artifact | The output, screenshot, trace, log, proof, or counterexample |
| Result | Observed pass, fail, or inconclusive, with the relevant values |
| Residual risk | What the evidence does not prove |
| Owner | Who can reproduce or update it |

A row is complete only when another person can run the command and inspect the artifact without asking the author. "Tests pass" is not a row.

## Self-verification versus independent verification

Self-verification is the author's feedback loop: run the tests, build, screenshots, and traces while implementing. It is necessary and cheap.

Independent verification runs in a fresh context and does not inherit the assumptions that produced the code. It is appropriate for high-risk, cross-module, security, data, or release claims. A common long-running-agent practice distinguishes the two and runs the verifier in a fresh context so the verdict is not colored by the implementation's assumptions. Code review is not verification: review checks intent, risk, and specification fit; verification checks behavior.

## Acceptance and review language

Separate these statements:

- "No defect was discovered in the reviewed scope."
- "The material claims are supported by evidence that exercises the changed behavior."
- "The change is proven correct."

Only the second is a reasonable completion claim for ordinary work. The third is reserved for a proof or an exhaustive verification, and even then only within the model or the stated assumptions.

A reviewer finding should name the property, its relevance, the evidence limitation, and the smallest useful check. A material verification gap is a finding, not a stylistic preference.

## Confidence tiers

Use explicit tiers when a claim is contested or when sources disagree:

1. **Executed observation in this repository:** a command you ran, an artifact you inspected, a test that failed before and passed after.
2. **Authoritative contract:** the current specification, schema, public interface, or standard that governs the behavior.
3. **Reproducible primary source:** a paper, official documentation, or a reproducible external experiment.
4. **Practitioner report or secondary retelling:** a blog, talk, thread, or a summary of a paper. Useful for direction; not proof.
5. **Model self-report or prose:** the agent's description of what it did. Never sufficient for a correctness claim.

Treat a `medium` or `low` confidence claim as a hypothesis to test, not as a settled fact. This includes claims about TDD, formal methods, and agent behavior.

## What this does not prove

- A green test does not prove the absence of defects.
- A proof does not prove that the formalization matches the intended requirement.
- A model check does not prove that the model matches the code.
- A screenshot does not prove that every branch is correct.
- An eval does not prove that the product is correct outside the eval distribution.
- A reviewer's approval does not prove that the evidence is sufficient.

State the residual risk explicitly. A named gap is honest; an unnamed gap is a false completion claim.
