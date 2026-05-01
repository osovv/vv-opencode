// FILE: src/plugins/secrets-redaction/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: OpenCode plugin that redacts secrets from messages before LLM requests and restores them after.
//   SCOPE: 3 hook handlers — chat.messages.transform, text.complete, tool.execute.before
//   DEPENDS: session, engine, patterns, restore, deep, config
//   LINKS: knowledge-graph://plugins/secrets-redaction
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SecretsRedactionPlugin - main plugin factory function
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.0.0 - Initial GRACE compliance: added missing CHANGE_SUMMARY.]
// END_CHANGE_SUMMARY

import { loadConfig } from "./config.js";
import { buildPatternSet } from "./patterns.js";
import { redactText } from "./engine.js";
import { restoreText } from "./restore.js";
import { redactDeep, restoreDeep } from "./deep.js";
import { PlaceholderSession } from "./session.js";
import type { Plugin } from "@opencode-ai/plugin";
import type { Part, TextPart, ReasoningPart } from "@opencode-ai/sdk/client";

const PLACEHOLDER_PREFIX = "__VVOC_SECRET_";

function isTextPart(part: Part): part is TextPart {
  return part.type === "text";
}

function isReasoningPart(part: Part): part is ReasoningPart {
  return part.type === "reasoning";
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
  }
}

function redactAssistantState(
  msg: unknown,
  patternSet: ReturnType<typeof buildPatternSet>,
  session: PlaceholderSession,
): void {
  const state = (msg as { state?: Record<string, unknown> }).state;
  if (state) {
    if (state.input) {
      redactDeep(state.input, patternSet, session);
    }
    if (state.output) {
      redactDeep(state.output, patternSet, session);
    }
    if (state.error) {
      redactDeep(state.error, patternSet, session);
    }
    if (state.raw) {
      redactDeep(state.raw, patternSet, session);
    }
  }
}

export const SecretsRedactionPlugin: Plugin = async (ctx) => {
  const { config, path, warnings } = await loadConfig(ctx.directory);

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

  if (!config.enabled) {
    return {};
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
        if (msg.info.role === "assistant") {
          redactAssistantState(msg.info, patternSet, session);
        }
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
