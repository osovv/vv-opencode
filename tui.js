// FILE: tui.js
// VERSION: 1.0.0
// OpenCode v2 resolves the CLI/TUI plugin entrypoint of directory-scoped
// plugin targets through a literal `tui` module next to the package manifest.
// This shim re-exports the dual-runtime default TUI entrypoint so the
// file-path and npm-specifier loading styles stay equivalent.
export { default } from "./dist/tui.js";
