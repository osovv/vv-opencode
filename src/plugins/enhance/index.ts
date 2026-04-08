// FILE: src/plugins/enhance/index.ts
// VERSION: 0.1.1
// START_MODULE_CONTRACT
//   PURPOSE: Improve `/enhance` command UX by rewriting the TUI prompt instead of submitting command output parts directly when possible.
//   SCOPE: Enhance command detection, prompt text extraction from command parts, TUI clear+append orchestration, and conservative fallback to default command behavior on API failure.
//   DEPENDS: [@opencode-ai/plugin, @opencode-ai/sdk]
//   LINKS: [M-PLUGIN-ENHANCE, V-M-PLUGIN-ENHANCE]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   EnhanceCommandPlugin - Intercepts `/enhance` command execution and rewrites the current TUI prompt via clear+append when available.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.1 - Added partial-failure recovery attempt that restores the original slash-command draft after clear+append failure.]
// END_CHANGE_SUMMARY

import { type Plugin } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";

const ENHANCE_COMMAND = "enhance";

type ClientResponse = {
  error?: unknown;
};

type TuiClient = {
  clearPrompt?: (input: unknown) => Promise<ClientResponse>;
  appendPrompt?: (input: unknown) => Promise<ClientResponse>;
  showToast?: (input: unknown) => Promise<unknown>;
};

function getTuiClient(client: Parameters<Plugin>[0]["client"]): TuiClient | undefined {
  return (client as { tui?: TuiClient }).tui;
}

// START_BLOCK_PROMPT_PART_EXTRACTION
function extractCommandPrompt(parts: Part[]): string {
  const textSegments: string[] = [];

  for (const part of parts) {
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string") {
      textSegments.push(text);
    }
  }

  return textSegments.join("\n\n").trim();
}
// END_BLOCK_PROMPT_PART_EXTRACTION

// START_BLOCK_TUI_HELPERS
async function showToast(
  client: Parameters<Plugin>[0]["client"],
  directory: string,
  variant: "info" | "warning",
  message: string,
) {
  const tui = getTuiClient(client);
  if (!tui?.showToast) {
    return;
  }

  try {
    await tui.showToast({
      query: { directory },
      body: {
        title: "enhance",
        message,
        variant,
        duration: 4_000,
      },
    });
  } catch {
    // Toast display is best-effort only.
  }
}

async function rewritePromptViaTui(
  client: Parameters<Plugin>[0]["client"],
  directory: string,
  prompt: string,
  fallbackDraft: string,
): Promise<boolean> {
  const tui = getTuiClient(client);
  if (!tui?.clearPrompt || !tui.appendPrompt) {
    return false;
  }

  let clearResult: ClientResponse;
  try {
    clearResult = (await tui.clearPrompt({
      query: { directory },
    })) as ClientResponse;
  } catch {
    return false;
  }

  if (clearResult.error) {
    return false;
  }

  let appendResult: ClientResponse;
  try {
    appendResult = (await tui.appendPrompt({
      query: { directory },
      body: {
        text: prompt,
      },
    })) as ClientResponse;
  } catch {
    await restoreFallbackDraft(tui, directory, fallbackDraft);
    return false;
  }

  if (appendResult.error) {
    await restoreFallbackDraft(tui, directory, fallbackDraft);
    return false;
  }

  return true;
}

async function restoreFallbackDraft(
  tui: TuiClient,
  directory: string,
  fallbackDraft: string,
): Promise<void> {
  if (!fallbackDraft.trim() || !tui.appendPrompt) {
    return;
  }

  try {
    await tui.appendPrompt({
      query: { directory },
      body: {
        text: fallbackDraft,
      },
    });
  } catch {
    // Recovery is best-effort only.
  }
}
// END_BLOCK_TUI_HELPERS

// START_BLOCK_PLUGIN_ENTRY
export const EnhanceCommandPlugin: Plugin = async ({ client, directory }) => {
  return {
    "command.execute.before": async (input, output) => {
      if (input.command !== ENHANCE_COMMAND) {
        return;
      }

      const prompt = extractCommandPrompt(output.parts);
      if (!prompt) {
        return;
      }

      const trimmedArguments = input.arguments.trim();
      const fallbackDraft = trimmedArguments
        ? `/${input.command} ${trimmedArguments}`
        : `/${input.command}`;

      const rewritten = await rewritePromptViaTui(client, directory, prompt, fallbackDraft);
      if (!rewritten) {
        await showToast(
          client,
          directory,
          "warning",
          "TUI prompt rewrite is unavailable; using default /enhance submit behavior.",
        );
        return;
      }

      output.parts = [];
      await showToast(
        client,
        directory,
        "info",
        "Enhanced prompt inserted into chatbox. Review and press Enter to submit.",
      );
    },
  };
};
// END_BLOCK_PLUGIN_ENTRY
