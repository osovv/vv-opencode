# Validation: lint, evidence, evaluation

## Evidence levels

| Level | Meaning |
|---|---|
| Established mechanism | confirmed by intervention or strict analysis |
| Behavioral evidence | effect measured; mechanism not established |
| Working hypothesis | useful engineering guess; requires a check on the target model |

Attach a level to every recommendation you make about prompts. An inference is not a law; the check decides.

## Prompt lint

Specification: the objective names a transformation; the deliverable is observable; inputs are named exactly; scope is separated from non-goals; priorities exist where requirements can conflict; done is not reachable by weakening the criteria; the ambiguity policy fits the task.
Serialization: instructions, sources, examples, and current input are distinguishable; structure is proportional; one primary container; pasted content is wrapped with identity when referenced.
Placement: definitions before dependent use; examples before the query; output requirements near the generation boundary.
Addressability: repeated referenced entities have stable IDs; boundaries are unambiguous; no pronoun references without an exact target.
Session: the current task is marked; update operations are clear; state is separated from history; one authoritative location per rule; external results carry Q-IDs with status; readback happened before substantial work.

## Anti-patterns

1. "Do it properly" — unknown deliverable, unbounded scope. Compile it.
2. Stream of consciousness — useful content, unseparated functions. Classify, then serialize.
3. Prestige persona — "the world's greatest engineer". Replace with mode, objective, scope, evidence, output.
4. One rule repeated four ways — four non-equivalent boundaries. One authoritative wording.
5. Ambiguous update — "now do it differently, but keep the rest". Use supersedes and preserves with IDs.
6. Overstructure — markup costing more attention than the task. Shrink it; structure distinguishes functions, not formality.

## Controlled evaluation

One good answer proves nothing. Pipeline: name the failure mode → build controlled variants → paired runs on the same inputs → score against the real success condition → error analysis → make the smallest supported change.

- Isolate one variable first; test combinations only after univariate screening — two separate gains can conflict together.
- Split development, regression, and held-out examples; otherwise the prompt overfits known cases.
- Run several samples when output is nondeterministic; a difference comparable to run-to-run variance is not a winner.
- Judge by the real condition: deterministic checks where possible; schema validation checks syntax, not truth; a model judge carries biases — calibrate it and spot-check by hand.
- Record the exact model, prompt text and hash, inputs, settings, and scores, so the result is reproducible.

## Boundary of automated checks

Bundled contract tests in this repository assert instruction delivery, not model behavior. Behavioral validation of a prompt change is a separate, run-based activity; never report a contract-test pass as behavioral evidence.
