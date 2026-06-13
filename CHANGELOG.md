## <small>0.35.12 (2026-06-13)</small>

### Summary

This release introduces an inline execution mode choice for the vv-execute plugin, giving you more control over how commands are launched. The release process now automatically generates a changelog summary for each version, ensuring every release includes a clear, user-friendly overview of changes. Additionally, several fixes improve the reliability of summary generation, including support for single-line summary envelopes and corrected configuration handling.

* fix(release): accept single-line summary envelopes ([f2b7b93](https://github.com/osovv/vv-opencode/commit/f2b7b93))
* fix(release): use valid opencode summary config ([9b8b38d](https://github.com/osovv/vv-opencode/commit/9b8b38d))
* feat(release): add mandatory AI-generated release changelog summary ([592615d](https://github.com/osovv/vv-opencode/commit/592615d))
* feat(vv-execute): add inline execution mode choice ([4822a7a](https://github.com/osovv/vv-opencode/commit/4822a7a))

## <small>0.35.11 (2026-06-13)</small>

### Summary

This release makes the release and upgrade path easier to trust by tightening changelog validation and improving compatibility with generated conventional-changelog output. Users get clearer upgrade notes backed by GitHub Releases and jsDelivr, while maintainers get stronger automated checks around the artifacts that ship each release.

* fix(release): make changelog patterns compatible with conventional-changelog format ([582c2f4](https://github.com/osovv/vv-opencode/commit/582c2f4))
* test(upgrade): add multi-version changelog, graceful degradation, and prerelease tests ([3f634db](https://github.com/osovv/vv-opencode/commit/3f634db))
* feat(release): add CHANGELOG.md validation to release-check ([2e37a77](https://github.com/osovv/vv-opencode/commit/2e37a77))
* feat(release): add GitHub Releases and jsDelivr-based changelog for vvoc upgrade ([e0f9863](https://github.com/osovv/vv-opencode/commit/e0f9863))
* feat(release): integrate changelog generation into release-bump ([b90a079](https://github.com/osovv/vv-opencode/commit/b90a079))
* chore(config): add changelog and commitlint configuration ([88dc806](https://github.com/osovv/vv-opencode/commit/88dc806))
* chore(config): add commitlint commit-msg hook ([888abf1](https://github.com/osovv/vv-opencode/commit/888abf1))