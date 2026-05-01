// FILE: src/plugins/secrets-redaction.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Re-export barrel for SecretsRedactionPlugin
//   SCOPE: plugin re-exports
//   DEPENDS: secrets-redaction/index
//   LINKS: knowledge-graph://plugins/secrets-redaction
//   ROLE: BARREL
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SecretsRedactionPlugin - main plugin export
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.0.0 - Initial GRACE compliance: added missing CHANGE_SUMMARY.]
// END_CHANGE_SUMMARY

export { SecretsRedactionPlugin } from "./secrets-redaction/index.js";
