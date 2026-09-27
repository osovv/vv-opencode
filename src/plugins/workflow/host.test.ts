// FILE: src/plugins/workflow/host.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify native OpenCode 2.0.18 subagent input/result/envelope decoding against pinned shapes.
//   SCOPE: Native input field reads, fresh-exclusive eligibility exclusions, structured result decoding, and the exact `<subagent ...>` delivery element parser including negative shapes.
//   DEPENDS: [bun:test, src/plugins/workflow/host.ts]
//   LINKS: [M-PLUGIN-WORKFLOW, V-M-PLUGIN-WORKFLOW]
//   ROLE: TEST
//   MAP_MODE: NONE
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-004 - Initial native subagent host-shape fixtures.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  decodeNativeSubagentResult,
  evaluateFreshExclusiveLaunch,
  parseSubagentCompletionElement,
  readNativeSubagentInput,
  readSubagentAgent,
  readSubagentPrompt,
} from "./host.js";

describe("readNativeSubagentInput", () => {
  test("reads the pinned fields and defaults", () => {
    expect(readNativeSubagentInput({ agent: "vv-implementer", prompt: "do it" })).toEqual({
      agent: "vv-implementer",
      description: "",
      prompt: "do it",
      background: false,
    });
    expect(
      readNativeSubagentInput({
        agent: " vv-implementer ",
        description: "task",
        prompt: "do it",
        model: "prov/model#variant",
        sessionID: "ses_child",
        background: true,
      }),
    ).toEqual({
      agent: "vv-implementer",
      description: "task",
      prompt: "do it",
      model: "prov/model#variant",
      sessionID: "ses_child",
      background: true,
    });
  });

  test("refuses malformed or missing agent/prompt", () => {
    expect(readNativeSubagentInput({ prompt: "x" })).toBeUndefined();
    expect(readNativeSubagentInput({ agent: "", prompt: "x" })).toBeUndefined();
    expect(readNativeSubagentInput({ agent: "a" })).toBeUndefined();
    expect(readNativeSubagentInput({ agent: "a", prompt: "" })).toBeUndefined();
    expect(readNativeSubagentInput(null)).toBeUndefined();
    expect(readSubagentAgent({ agent: 5 })).toBeUndefined();
    expect(readSubagentPrompt({ prompt: 5 })).toBe("");
  });
});

describe("evaluateFreshExclusiveLaunch", () => {
  test("accepts a foreground new child and excludes background/resume", () => {
    expect(
      evaluateFreshExclusiveLaunch({ agent: "a", description: "", prompt: "p", background: false }),
    ).toEqual({ eligible: true });
    expect(
      evaluateFreshExclusiveLaunch({ agent: "a", description: "", prompt: "p", background: true }),
    ).toEqual({ eligible: false, reason: "requested_background" });
    expect(
      evaluateFreshExclusiveLaunch({
        agent: "a",
        description: "",
        prompt: "p",
        background: false,
        sessionID: "ses_child",
      }),
    ).toEqual({ eligible: false, reason: "resume_session", resumedChildSessionId: "ses_child" });
  });
});

describe("decodeNativeSubagentResult", () => {
  test("decodes completed and running results", () => {
    expect(
      decodeNativeSubagentResult({ sessionID: "ses_child", status: "completed", output: "ok" }),
    ).toEqual({ sessionID: "ses_child", status: "completed", output: "ok" });
    expect(
      decodeNativeSubagentResult({ sessionID: "ses_child", status: "running", output: "bg" }),
    ).toEqual({ sessionID: "ses_child", status: "running", output: "bg" });
  });

  test("refuses unknown status or missing session id", () => {
    expect(decodeNativeSubagentResult({ sessionID: "ses_child", status: "done" })).toBeUndefined();
    expect(decodeNativeSubagentResult({ status: "completed" })).toBeUndefined();
    expect(decodeNativeSubagentResult("Subagent completed")).toBeUndefined();
  });
});

describe("parseSubagentCompletionElement", () => {
  test("parses the exact native delivery element", () => {
    expect(
      parseSubagentCompletionElement(
        '<subagent sessionID="ses_child" state="completed" description="task">\nDone.\n</subagent>',
      ),
    ).toEqual({
      sessionID: "ses_child",
      state: "completed",
      description: "task",
      output: "Done.",
    });
    expect(
      parseSubagentCompletionElement(
        '<subagent sessionID="ses_child" state="cancelled">\nSubagent cancelled\n</subagent>',
      ),
    ).toEqual({
      sessionID: "ses_child",
      state: "cancelled",
      output: "Subagent cancelled",
    });
  });

  test("refuses non-native or malformed envelope text", () => {
    expect(parseSubagentCompletionElement("plain VVOC result")).toBeUndefined();
    expect(
      parseSubagentCompletionElement('<subagent sessionID="ses_child" state="bogus">x</subagent>'),
    ).toBeUndefined();
    expect(
      parseSubagentCompletionElement('<subagent sessionID="ses_child" state="completed">x'),
    ).toBeUndefined();
    expect(
      parseSubagentCompletionElement(
        'preface\n<subagent sessionID="ses_child" state="completed">x</subagent>',
      ),
    ).toBeUndefined();
  });
});
