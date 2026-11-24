# Manual evaluation — C-WRITE-FOR-HUMANS-SKILL

Bounded manual evaluation performed at change time by the implementing agent following the shipped skill instructions, on synthetic inputs. It is evidence that the instructions apply to the intended task shapes. It is neither a CI gate nor proof of general model behavior.

## Task 1 — no-op on good atypical text (copyedit mode)

Input: "The exporter favours British spelling. It may emit duplicate rows if the upstream ledger is mid-write, and nightly reconciliation removes them. Snapshot files must remain byte-for-byte identical after the migration, so the hot path never re-encodes payloads."

Result: zero edits. Reasons recorded per the skill's report rule: the possibility ("may") and the condition ("if the ledger is mid-write") carry meaning (level A); "byte-for-byte identical" is a check criterion; "hot path" is a domain term; British spelling is internally consistent, so level C's "defaults never normalize existing text" applies; the thesis is in the first sentence and one term names one concept.

## Task 2 — insufficient-source trap (draft mode)

Input: a PR body draft reading "Improved retry handling." with no diff, no suite output, and no notes supplied.

Result: no rewritten claim was produced. Output was a gap flag and one focused question: which observable behavior changed (statuses retried, limits, backoff) and how it was verified. The trap (inventing "Honor Retry-After on 429" without a source) was avoided: the addition test requires the source to supply the detail.

## Task 3 — Russian editing task (copyedit mode)

Input: «В целях обеспечения возможности осуществления контроля качества в отдельных случаях может производиться дублирующая запись событий аудита.»

Output: «Чтобы можно было контролировать качество, иногда записываются дубликаты событий аудита.» Plus a flag: the conditions behind «в отдельных случаях» are stated nowhere in the source, so the hedge was kept as «иногда» and not elaborated.

Check: possibility preserved (может → иногда), the duplicated hedge collapsed, канцелярит removed (в целях обеспечения возможности осуществления → чтобы можно было), actor not invented (passive kept — the source does not name who writes), register stays neutral Russian without anglicization.

## Verdict

All three tasks behaved as the spec's AC-13 requires: no-op respected, gap flagged instead of filled, Russian edited with meaning preserved.
