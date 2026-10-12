# Implementation protocol: vv-opencode

1. Read `.vv-factory/context.md`, `AGENTS.md`, and the full task first. The repo is GRACE
   4-managed — respect its change protocol (see “GRACE Workflow Rules” in AGENTS.md): do not
   implement behavior in `src/` without an approved active `C-*` change bundle, except small
   explicitly requested direct fixes.
2. Before changing anything: `git status --short` (do not clobber someone else's edits), read the
   file's `MODULE_CONTRACT` and its neighboring tests, find the owning module in
   `.grace/graph/index.xml` → routed document → `M-*` anchor, and its verifications in
   `.grace/verification/` (`V-M-*`).
3. Make the minimal correct change in the existing style. Update the file contract BEFORE the
   code.
4. GRACE markers are semantic anchors (`START_MODULE_CONTRACT` / `START_MODULE_MAP` /
   `START_CONTRACT` / `START_BLOCK_*` / `START_CHANGE_SUMMARY`) implemented as XML tags inside
   comments. Never delete or rename anchors to make an edit easier; keep them paired and keep the
   map accurate.
5. Run the checks and attach the output (select via the “Change-Impact Table” in AGENTS.md; the
   minimum for a typical code change):

   ```bash
   bun install
   bun test path/to/file.test.ts        # narrow test first
   bun run check                        # typecheck + lint + fmt + grace markup + contracts + bun test
   bun run build                        # if code that ends up in dist/ changed
   ```

   Add `bun run pack:check` for export/packaging changes; `bun run release:check` for release
   work.
6. If `.grace/` artifacts changed, run `grace lint --path .` and `grace status --path .` with the
   stable grace binary (see “GRACE CLI Checks” in AGENTS.md); any failure is a blocker.
7. Workspace and delivery (publication is owner-gated):
   - work in an isolated copy of the repo on a per-task branch; never push the branch and never
     open a PR — publication to `main` is done by the maintainer after review;
   - deliver the work as Conventional Commits on that branch (`feat: …`, `fix: …`, `docs: …`),
     with no internal task identifiers and no machine-specific paths in commit messages;
   - before finishing, check `git status --short`: the diff contains only the intended files.
8. Never commit secrets, tokens, or build artifacts (`dist/` is gitignored). Sync `README.md` in
   the same change whenever commands/flags/exports/config paths change.
