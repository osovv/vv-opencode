// FILE: server.js
// Root native server-plugin forwarder for local-directory loading. OpenCode's
// plugin host resolves a plugin directory's `server` subpath (or package export
// `./server`) to this file before falling back to `index`.
export { default } from "./dist/index.js";
