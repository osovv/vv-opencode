// FILE: server.js
// VERSION: 1.0.0
// OpenCode v2 resolves directory-scoped plugin targets through a literal
// `server` module next to the package manifest before consulting the exports
// map. This shim re-exports the dual-runtime default entrypoint so both the
// file-path and npm-specifier loading styles reach the same plugin.
export { default } from "./dist/index.js";
