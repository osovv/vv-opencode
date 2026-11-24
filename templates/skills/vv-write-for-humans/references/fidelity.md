# Fidelity casebook

Level-A decisions on real span shapes. Default: when an edit would touch truth conditions, stop and check the source; when the source is silent, flag — do not resolve for the author.

## Leave as-is

| Span | Why |
|---|---|
| `The client may return stale data if the refresh fails.` | may = possibility, if = condition; deleting either changes the claim |
| `The files must be byte-for-byte identical.` | a check criterion, not redundancy |
| `No retry on 401` | a behavior rule, compressed by genre, not a negative to rephrase |
| `hot path`, `source of truth`, `backpressure`, `fan-out` | domain terms, not imagery |
| `usually retries` | real irregularity; either keep "usually" or name the exceptions from the source |
| `could potentially` | stack collapses to one hedge ("can"); the uncertainty itself stays |

Quantifiers (`only`, `all`, `never`, `up to`) and normative keywords (MUST, SHOULD, MAY, ДОЛЖЕН) keep their exact form: the level they state is the content.

## Term or metaphor

The term or metaphor procedure runs before replacing any image (`talks to`, `walks the list`, `hits the store`):

1. Name the operation from a source (code, spec, the user). `The client talks to the cache` + code showing a read before the API call → `The client reads the cache before calling the API`.
2. No source for the operation → leave the metaphor or flag it; never guess reads, writes, or subscriptions.
3. Domain terms (hot path, source of truth) are terminology, not imagery — leave them.
4. Replacing one metaphor with another is not an edit.

## Ambiguity

Two referents for "it", an unclear scope of "all", a dangling modifier with two readings → flag the span with the candidate readings; resolve only when a source disambiguates, and say which one.

## Numbers, units, versions, attribution

Preserve values, units, precision, dates, version ranges, and who said what. "About 3s" ≠ "3s"; "since v2.4" ≠ "in v2.4". Unit conversion must be exact and authorized by the user; rounding is a factual change.

## Hedges

Keep the hedge, cut the wrapping: «стоит отметить, что в некоторых случаях может наблюдаться потеря данных» → «иногда теряются данные» + a flag that the conditions are not stated anywhere. The filler goes; the possibility stays.

## The verification pass

After editing, compare claim-by-claim with the source: added claims? dropped claims? changed modality, conditions, or quantifiers? protected spans intact? Every changed span maps to a justified finding or a requested transformation. Re-reading for smoothness is not this pass.
