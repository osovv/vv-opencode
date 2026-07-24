// FILE: src/plugins/secrets-redaction/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: OpenCode plugin that redacts secrets from messages before LLM requests and restores them after.
//   SCOPE: Startup vvoc config snapshot use plus 3 hook handlers — chat.messages.transform (text, reasoning, and tool-part state redaction), text.complete, tool.execute.before
//   DEPENDS: src/lib/config-layers.ts, src/lib/plugin-toggle-config.ts, session, engine, patterns, restore, deep, config
//   LINKS: [M-PLUGIN-SECRETS-REDACTION]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SecretsRedactionPlugin - main plugin factory function
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.3.0 - Fixed a redaction bypass: tool-part payloads (ToolPart.state input/output/error/metadata) are now deep-redacted in chat.messages.transform; removed the dead msg.info.state path that never matched the SDK message shape.]
//   LAST_CHANGE: [v1.2.0 - Used the shared startup vvoc config snapshot for plugin toggles and redaction settings.]
//   LAST_CHANGE: [v0.0.0 - Initial GRACE compliance: added missing CHANGE_SUMMARY.]
// END_CHANGE_SUMMARY

import { resolveSecretsRedactionRuntimeConfig } from "./config.js";
import { buildPatternSet } from "./patterns.js";
import { redactText } from "./engine.js";
import { restoreText } from "./restore.js";
import { redactDeep, restoreDeep } from "./deep.js";
import { PlaceholderSession } from "./session.js";
import { loadVvocConfig } from "../../lib/config-layers.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import type { Plugin } from "@opencode-ai/plugin";
import type { Part, TextPart, ReasoningPart, ToolPart } from "@opencode-ai/sdk/client";

const PLACEHOLDER_PREFIX = "__VVOC_SECRET_";

function isTextPart(part: Part): part is TextPart {
  return part.type === "text";
}

function isReasoningPart(part: Part): part is ReasoningPart {
  return part.type === "reasoning";
}

function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool";
}

function redactMessageParts(
  parts: Part[],
  patternSet: ReturnType<typeof buildPatternSet>,
  session: PlaceholderSession,
): void {
  for (const part of parts) {
    if (isTextPart(part)) {
      const result = redactText(part.text, patternSet, session);
      part.text = result.text;
    }
    if (isReasoningPart(part)) {
      const result = redactText(part.text, patternSet, session);
      part.text = result.text;
    }
    if (isToolPart(part)) {
      // Tool inputs/outputs/errors/metadata are the primary secret vector
      // (file contents from `read`, command output from `bash`, env vars).
      // They live in part.state per the SDK ToolPart shape, not msg.info.state.
      redactDeep(part.state, patternSet, session);
      if (part.metadata) {
        redactDeep(part.metadata, patternSet, session);
      }
    }
  }
}

export const SecretsRedactionPlugin: Plugin = async (ctx) => {
  const vvoc = await loadVvocConfig({ cwd: ctx.directory });
  if (!isVvocPluginEnabled(vvoc.config, "secrets-redaction")) {
    return {};
  }

  const { config, path, warnings } = resolveSecretsRedactionRuntimeConfig(vvoc);
  if (config.debug) {
    await ctx.client.app.log({
      body: {
        service: "secrets-redaction",
        level: "debug" as const,
        message: `config loaded from: ${path ?? "none"}`,
      },
    });
  }

  for (const warning of warnings) {
    await ctx.client.app.log({
      body: {
        service: "secrets-redaction",
        level: "warn" as const,
        message: warning,
      },
    });
  }

  const patternSet = buildPatternSet(config.patterns);
  const session = new PlaceholderSession({
    prefix: PLACEHOLDER_PREFIX,
    ttlMs: config.ttlMs,
    maxMappings: config.maxMappings,
    secret: config.secret,
  });

  if (config.ttlMs > 0) {
    setInterval(
      () => {
        const evicted = session.cleanup(Date.now());
        if (config.debug && evicted > 0) {
          ctx.client.app.log({
            body: {
              service: "secrets-redaction",
              level: "debug" as const,
              message: `evicted ${evicted} expired placeholders`,
            },
          });
        }
      },
      Math.min(config.ttlMs, 60_000),
    );
  }

  return {
    config: async () => {},
    event: async () => {},
    "tool.execute.before": async (_input, output) => {
      if (output.args) {
        restoreDeep(output.args, session);
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      for (const msg of output.messages) {
        redactMessageParts(msg.parts, patternSet, session);
      }
    },
    "experimental.text.complete": async (_input, output) => {
      if (output.text) {
        output.text = restoreText(output.text, session);
      }
    },
  };
};
