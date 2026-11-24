# Genres: sufficiency criteria

A genre is defined by the reader's job, not by the file name. The quality criterion changes with the job: a short quickstart without preconditions fails; a long design note without alternatives fails. A genre framework used widely for documentation splits forms along two axes — action versus understanding, acquiring versus applying — giving tutorial, how-to, reference, and explanation. Engineering artifacts add their own genres below.

## Documentation forms

| Form | Reader's job | Sufficiency criteria | Typical failure |
|---|---|---|---|
| Tutorial | learn by doing | guaranteed-working steps, a visible result at each stage, no choices offered | explains theory instead of leading |
| How-to | perform a task | preconditions, working steps, expected result, failure branches | missing preconditions; assumed context |
| Reference | look up behavior | exact conditions, defaults, units, limits; neutral tone | narrative, opinions, "simply" |
| Explanation | understand why | decision, alternatives, tradeoffs, context | steps without rationale |

## Engineering artifacts

### README / docs
Job: get the reader running and oriented. Sufficiency: what the thing is, what it needs, how to start, where to go next; commands that work as written. Failure: marketing tone, stale commands, buried quickstart.

### PR description
Job: let a reviewer decide whether the change is correct and safe. Sufficiency: what changed and why, up front; scope and impact; how it was verified — which checks ran and which did not; risk and rollback when relevant. Failure: three paragraphs of history before the change; "tests pass" without naming the suite.

### Commit message
Job: a future reader doing archaeology. Sufficiency: a subject in the imperative that names the change (~72 characters); a body that says why, not a retelling of the diff; constraints and rejected alternatives when they shaped the fix. Failure: "Fix stuff". A one-line fix with a clear subject is complete at subject length.

### Design note / RFD / ADR
Job: let a reader evaluate or revisit a decision. Sufficiency: context, decision, alternatives with reasons for rejection, consequences and tradeoffs, status. Rationale is the content, not decoration. Failure: "we chose X because it is robust" — a significance word with no mechanism; name the actual property from the source instead, or flag the gap.

### Report / final answer
Job: let the reader trust the state of the work. Sufficiency: what was done, what was verified and how, what remains unverified or unknown, the next step if any. The scope of the verification is part of the claim: "The parser suite passes (14 tests). The integration suite was not run; readiness is not established." — never widen a limited check into a guarantee.

### Error message
Job: let the user recover. Sufficiency: what happened (specific), why if known, what to do next. "Invalid month '13' in field DTP03. Expected MM in 01–12." beats "Invalid input." Error strings asserted in tests or snapshots are protected content: changing them is a code change; flag it instead of editing.

## Cross-genre rules

- Match length to sufficiency, not to a word budget.
- One document, one primary job; split or link when jobs mix.
- When the genre is unclear, ask what the reader must do after reading, and check that against the criteria above.
