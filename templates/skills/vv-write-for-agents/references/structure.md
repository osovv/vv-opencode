# Structure: serialization, placement, identity

## Serialization

Structure exists to distinguish functions: instructions, context, source material, examples, current input, output requirements. It reduces interpretations; it does not fix contradictions.

- One primary container format, with the native representation inside: Markdown sections for prose, semantic XML containers for task shape, fenced blocks for code. Do not mix syntaxes for decoration.
- Proportional to the task: "Translate hello to French" needs no nested containers.
- In programmatic templates: stable section order, no empty decorative fields, one naming convention, external text serialized so it cannot break the container, and lint the rendered prompt, not only the template.

## Pasted external content

Wrap any pasted foreign text (chat logs, tool output, doc excerpts) in paired tags, never bare:

`<DOC-EXCERPT-BILLING-01 source="internal-wiki" date="2026-08-14"> … </DOC-EXCERPT-BILLING-01>`

This marks the data boundary (instruction, data, or example?), gives an explicit end so foreign markup cannot bleed into later sections, and provides a retrieval key ("see BILLING-01" beats "in the chat above"). Add identity and provenance when several same-type blocks exist or the block will be referenced. This reduces confusion; it is not injection protection.

## Unique identities vs stable types

Type and identity are different functions. An addressable outer entity gets a unique tag; local fields keep stable semantic types:

`<TASK-TURN-12><objective>…</objective><constraints>…</constraints></TASK-TURN-12>`

When many sibling blocks share one generic tag, the closing tag is ambiguous — the reader must work out which entity closed. A unique closing tag carries the identity by itself. In .vvoc spec and plan artifacts, unique identities are enforced by vvoc tooling (components and tasks use unique element identities, and a plan must reuse the identities its spec declared); elsewhere they are a strong default.

Unique identity earns its place for: repeated sibling entities, blocks referenced later, pasted blocks with later references, long flat sequences, versioned requirements. A single root task, local fields, and one-off containers keep stable types — do not uniquify everything.

## Causal placement

Order determines what can build on what: definitions before use, examples before the query that relies on them, sources before questions about them, global framing early, the immediate task and output requirements last. Default baseline for document-grounded tasks: task frame → definitions and schema → source material → exact query → output requirements. Order is a variable to check, not a theorem; when placement materially matters, compare orderings on the target model rather than trusting the default.

## Tokenizer check

The model sees tokens, not words. For a critical prompt family, check the identity formats on the target tokenizer: length, separator consistency, digit splitting, and collisions after normalization — `BUILD-ORDER-1`, `build_order_1`, and `BuildOrder1` do not necessarily tokenize the same way. An identifier that reads as one name is not necessarily one token.
