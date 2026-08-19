// FILE: src/tui/analytics/indicator.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify the live indicator accumulator, label thresholds, registration gating, session filtering, and fail-soft slot handling.
//   SCOPE: Step-finish-only accumulation, eligibility and tone boundaries, disabled toggle no-op, event subscription filtering, muted non-rendering, slot failure tolerance, and real OpenTUI rendering of the default label.
//   DEPENDS: [bun:test, @opencode-ai/plugin/tui, @opencode-ai/sdk, src/tui/analytics/indicator.tsx, src/lib/analytics/types.ts]
//   LINKS: [M-TUI-ANALYTICS-INDICATOR, V-M-TUI-ANALYTICS-INDICATOR]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   stepFinishPart - Builds a step-finish part payload.
//   fakeApi - Builds a minimal TuiPluginApi double with recording hooks.
//   partUpdatedEvent - Builds a message.part.updated event payload.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [2026-08-20-orphan-text-fix - Added a real-render regression test for the default label to catch orphan text errors.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { Event, Part } from "@opencode-ai/sdk";
import {
  createIndicatorAccumulator,
  indicatorLabel,
  registerAnalyticsIndicator,
} from "./indicator.js";
import type { IndicatorTokens } from "../../lib/analytics/types.js";

function stepFinishPart(overrides: Record<string, unknown> = {}): Part {
  return {
    id: "prt_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 900, write: 100 } },
    ...overrides,
  } as unknown as Part;
}

function state(overrides: Partial<IndicatorTokens> = {}): IndicatorTokens {
  return { steps: 0, eligibleSteps: 0, cacheRead: 0, cacheWrite: 0, input: 0, ...overrides };
}

describe("createIndicatorAccumulator", () => {
  test("ignores non-step-finish parts", () => {
    const accumulator = createIndicatorAccumulator();
    accumulator.applyPart({ id: "p", type: "text", text: "hi" } as unknown as Part);
    expect(accumulator.get()).toEqual(state());
  });

  test("counts each step-finish part once with eligibility", () => {
    const accumulator = createIndicatorAccumulator();
    accumulator.applyPart(stepFinishPart());
    accumulator.applyPart(
      stepFinishPart({
        tokens: { input: 50, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    expect(accumulator.get()).toEqual(
      state({ steps: 2, eligibleSteps: 1, cacheRead: 900, cacheWrite: 100, input: 150 }),
    );
  });
});

describe("indicatorLabel", () => {
  test("returns muted n/a before any eligible step", () => {
    expect(indicatorLabel(state({ steps: 3 }))).toEqual({ text: "cache n/a", tone: "muted" });
  });

  test("green at >= 80 percent, yellow at >= 50, red below", () => {
    const at = (rate: number) =>
      state({ eligibleSteps: 1, cacheRead: rate * 1000, cacheWrite: 0, input: (1 - rate) * 1000 });
    expect(indicatorLabel(at(0.8)).tone).toBe("green");
    expect(indicatorLabel(at(0.95)).text).toBe("cache 95%");
    expect(indicatorLabel(at(0.5)).tone).toBe("yellow");
    expect(indicatorLabel(at(0.79)).tone).toBe("yellow");
    expect(indicatorLabel(at(0.49)).tone).toBe("red");
  });
});

function partUpdatedEvent(part: Part, sessionID = part.sessionID): Event {
  return {
    type: "message.part.updated",
    properties: { part: { ...part, sessionID } as unknown as Part },
  } as unknown as Event;
}

function fakeApi(options: { slotsFail?: boolean } = {}) {
  const listeners = new Map<string, Array<(event: Event) => void>>();
  const disposers: Array<() => void> = [];
  const registeredSlots: unknown[] = [];
  const api = {
    route: {
      current: { name: "session", params: { sessionID: "ses_1" } },
    },
    state: { path: { directory: "/home/al/dev/project" } },
    theme: {
      current: {
        success: { r: 0, g: 255, b: 0, a: 1 },
        warning: { r: 255, g: 255, b: 0, a: 1 },
        error: { r: 255, g: 0, b: 0, a: 1 },
        textMuted: { r: 128, g: 128, b: 128, a: 1 },
      },
    },
    event: {
      on: (type: string, handler: (event: Event) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), handler]);
        return () => {
          listeners.set(
            type,
            (listeners.get(type) ?? []).filter((entry) => entry !== handler),
          );
        };
      },
    },
    lifecycle: {
      onDispose: (fn: () => void) => {
        disposers.push(fn);
        return () => {};
      },
    },
    slots: {
      register: (plugin: unknown) => {
        if (options.slotsFail) throw new Error("slot registration failed");
        registeredSlots.push(plugin);
        return "slot-id";
      },
    },
  } as unknown as TuiPluginApi;

  const emit = (event: Event) => {
    for (const handler of listeners.get(event.type) ?? []) handler(event);
  };

  return { api, emit, registeredSlots, disposers };
}

describe("registerAnalyticsIndicator", () => {
  test("subscribes, filters by current session, and renders the label", async () => {
    const { api, emit, registeredSlots } = fakeApi();
    await registerAnalyticsIndicator(api, undefined, testDeps());

    emit(partUpdatedEvent(stepFinishPart(), "ses_other"));
    expect(renderSlot(registeredSlots, "ses_1")).toBeUndefined();

    emit(partUpdatedEvent(stepFinishPart()));
    const element = renderSlot(registeredSlots, "ses_1") as {
      label: { text: string };
      color: string;
    };
    expect(element.label.text).toBe("cache 82%");
    expect(element.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("renders nothing while the label is muted", async () => {
    const { api, registeredSlots } = fakeApi();
    await registerAnalyticsIndicator(api, undefined, testDeps());
    expect(renderSlot(registeredSlots, "ses_1")).toBeUndefined();
  });

  test("disabled toggle results in no subscription and no slot registration", async () => {
    const { api, emit, registeredSlots, disposers } = fakeApi();
    await registerAnalyticsIndicator(api, undefined, testDeps(false));
    emit(partUpdatedEvent(stepFinishPart()));
    expect(registeredSlots).toHaveLength(0);
    expect(disposers).toHaveLength(0);
  });

  test("options.enabled === false skips registration", async () => {
    const { api, registeredSlots } = fakeApi();
    await registerAnalyticsIndicator(api, { enabled: false }, testDeps());
    expect(registeredSlots).toHaveLength(0);
  });

  test("slot registration failure does not propagate", async () => {
    const { api } = fakeApi({ slotsFail: true });
    await expect(registerAnalyticsIndicator(api, undefined, testDeps())).resolves.toBeUndefined();
  });

  test("ignores parts from other sessions entirely", async () => {
    const { api, emit, registeredSlots } = fakeApi();
    await registerAnalyticsIndicator(api, undefined, testDeps());
    emit(partUpdatedEvent(stepFinishPart(), "ses_other"));
    expect(renderSlot(registeredSlots, "ses_1")).toBeUndefined();
  });

  test("default label renders through real OpenTUI without orphan text errors", async () => {
    const { testRender } = await import("@opentui/solid");
    const { DEFAULT_DEPENDENCIES } = await import("./indicator.js");
    const label = indicatorLabel(
      state({ eligibleSteps: 1, cacheRead: 900, cacheWrite: 100, input: 100 }),
    );
    const setup = await testRender(
      () => DEFAULT_DEPENDENCIES.renderLabel(label, "rgba(0,255,0,1)") as never,
      { width: 20, height: 3 },
    );
    await setup.flush();
    expect(setup.captureCharFrame()).toContain(label.text);
  });
});

/** Test dependencies with a marker label renderer instead of real OpenTUI JSX. */
function testDeps(enabled = true) {
  return {
    enabled: async () => enabled,
    renderLabel: (label: { text: string }, color: string) => ({ label, color }),
  } as unknown as Parameters<typeof registerAnalyticsIndicator>[2];
}

/** Invokes the first registered session_prompt_right renderer. */
function renderSlot(registeredSlots: unknown[], sessionID: string): unknown {
  const slot = registeredSlots[0] as {
    slots: { session_prompt_right: (ctx: unknown, props: unknown) => unknown };
  };
  return slot.slots.session_prompt_right({ theme: { current: {} } }, { session_id: sessionID });
}
