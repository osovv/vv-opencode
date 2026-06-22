# GRACE 4 Migration Checklist

- [x] Generated `.grace/context` artifacts reviewed.
- [x] Generated `.grace/graph/index.xml` and graph documents reviewed.
- [x] Generated `.grace/verification/index.xml` and verification documents reviewed.
- [x] Ambiguities and unsupported legacy structures are listed.
- [x] No retroactive `C-*` bundles were created.
- [x] `bunx @osovv/grace-cli@rc lint --path .` passed or findings are understood.
- [x] `bunx @osovv/grace-cli@rc status --path .` reports GRACE 4 state.
- [x] Legacy cleanup proposal is explicit.
- [x] User explicitly confirmed cleanup before deleting or moving legacy docs.
