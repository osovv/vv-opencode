# Feature Ideas

This file records potentially useful product ideas that are not approved specifications or implementation commitments.

## Multiprovider web search

Status: deferred

Allow the canonical `web_search` tool to use more than one configured search provider. Different search engines can return different sources and perspectives for the same query.

Possible directions include:

- a simple fallback chain for reliability when the primary provider fails;
- an opt-in multiprovider mode that combines results from several search engines;
- safe result deduplication and provider provenance if combined search is pursued.

Any future design should keep the existing single-provider mode as the simple default, preserve the canonical `web_search` interface, and make additional latency and API cost explicit. No ensemble or fallback behavior is currently planned for implementation.
