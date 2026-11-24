# Formal Verification

Formal verification is the strongest oracle in this skill, and the easiest to misuse. Use it when the claim is about all reachable states, not just the examples you remembered.

## When it is justified

Reach for formal methods when at least one of these is true:

- The behavior is a state machine, protocol, permission model, payment flow, notification fan-out, or distributed interaction.
- The failure mode is a race, a lost update, a duplicate, a deadlock, a reordering, or an unreachable-state violation.
- The cost of a production failure is high enough to justify modeling effort.
- A property must hold for all interleavings, not just the happy path.
- The implementation is hard to test exhaustively but easy to model.

Do not reach for formal methods when a contract test, property test, or integration test already discriminates the risk. Formal methods are not a substitute for ordinary tests; they cover a different class of claim.

## Statecharts and TLA+

A statechart is a readable model of states, transitions, guards, and parallel regions. It is often the bridge between code and a formal model.

A practical agent workflow:

1. Ask the agent to draw the statechart for the flow, from the code and the user-facing requirement.
2. Review the statechart: are the states real, are the transitions complete, are the guards meaningful?
3. Translate the statechart into TLA+ (or another model checker).
4. State the invariants: no charge without an order, no duplicate notification, no state reachable after cancellation, no permission escalation.
5. Run the model checker. If it finds a counterexample, map the trace back to code and write a deterministic regression test.
6. Keep the model and the invariant with the code; update them when the flow changes.

TLA+ is good at interleavings, invariants, and protocol-level properties. It is not a code verifier; it verifies the model. The model-to-code gap is your responsibility.

## Lean and property-based tests

Lean is a dependent type theory proof assistant. It is appropriate when the claim is a mathematical property of an algorithm and the specification is stable enough to formalize.

Property-based testing is the cheaper bridge. Instead of a proof, assert a property over generated inputs. It finds counterexamples without a full formalization, and it is usually the right first step before investing in a proof.

Use Lean when:

- The algorithm is stable and the property is mathematical.
- The cost of a wrong result is high.
- You can afford to maintain the proof and the formalization.

Use property-based testing when:

- The property is clear but the implementation is still moving.
- You want counterexamples quickly.
- A full proof would be disproportionate to the risk.

## Counterexample to regression test

A model checker's counterexample is a trace: a sequence of states and actions that violates the invariant. Do not stop at "the model is wrong". Map the trace to the code path, reproduce it with a deterministic test if possible, fix the code or the model, and add the regression test.

If the counterexample is not reproducible in code, record why: the model is more abstract, the code has an additional guard, or the trace requires an environment you cannot create. That gap is residual risk, not a pass.

## Tooling notes

- **TLA+ model checkers:** the standard approach is TLA+ plus a model checker. Some implementations require a JVM; others aim for compatibility without that friction. Verify that the tool supports the TLA+ features you use.
- **Lean and its standard library:** a proof assistant and its mathematics library. Proofs are checked by a small kernel; the kernel itself can have bugs, and a proof can be about the wrong formalization.
- **Property-based libraries:** every ecosystem has one; use the repository's existing library rather than adding a new dependency.

Tooling is not the point. The point is the model, the invariant, and the mapping back to code.

## Limits

- **Formalization gap:** the proof can be correct and still not match the intended requirement. A proof is only as good as the specification it formalizes.
- **Kernel and tool bugs:** a small trusted kernel is not infallible. Do not treat "the proof checked" as absolute truth without understanding the toolchain.
- **Cost:** modeling, proof engineering, and maintenance are expensive. Use formal methods where the risk justifies them.
- **Model drift:** the model and the code can diverge. Keep the model in the repository, review changes to both, and regenerate or re-check when the flow changes.
- **Coverage of the model:** a model checker explores the model you wrote, not the code you wrote. A missing transition or an omitted environment assumption can hide the bug.
- **Not a silver bullet:** formal verification is very promising and can find real bugs, but it is not a substitute for judgment.

## A minimal workflow

```text
1. State the property in plain language.
2. Draw the statechart from the code and the requirement.
3. Review the statechart with a human or a fresh-context reviewer.
4. Encode the model and the invariant.
5. Run the model checker.
6. If a counterexample appears: map it to code, fix, add a regression test.
7. If no counterexample appears: record the model, the invariant, the tool version, and the residual gap.
8. Keep the model and the regression test with the code.
```

The output of formal verification is not "proven correct"; it is "no counterexample was found in this model under these assumptions". That is a strong and honest claim.
