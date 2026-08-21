// FILE: src/lib/peak-hours.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify peak-hours schedule parsing, window math, aliases, suggestions, formatting, and plugin entry normalization.
//   SCOPE: Time-of-day parsing, window validation and fail-open warnings, same-day and cross-midnight evaluation with timezones and weekdays, boundary dates, provider key resolution, suggestion filtering, display formatting, and entry seeding with overrides.
//   DEPENDS: [bun:test, src/lib/peak-hours.ts]
//   LINKS: [M-PEAK-HOURS-SCHEDULES, V-M-PEAK-HOURS-SCHEDULES]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   at - Builds a deterministic evaluation instant from an ISO string.
//   dailyWindow - Builds a raw daily window fixture.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-PLUGIN-PEAK-HOURS - Added deterministic table-driven coverage for the peak-hours library.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PEAK_HOURS_MODE,
  findActivePeak,
  formatPeakEndTime,
  formatWaitMinutes,
  normalizeProviderId,
  parsePeakHoursEntry,
  parsePeakWindow,
  parseTimeOfDay,
  resolveProviderKey,
  suggestOffPeakProviders,
  type PeakSchedules,
  type PeakWindowSpec,
} from "./peak-hours.js";

// 2026-08-21 is a Friday; 2026-08-22 is a Saturday.
const at = (iso: string): Date => new Date(iso);

function dailyWindow(
  start: string,
  end: string,
  extra: Partial<PeakWindowSpec> = {},
): PeakWindowSpec {
  return { start, end, ...extra };
}

const DAILY = (start: string, end: string, extra: Partial<PeakWindowSpec> = {}): PeakSchedules => ({
  "sample-provider": { windows: [dailyWindow(start, end, extra)] },
});

describe("parseTimeOfDay", () => {
  test("parses valid HH:MM values", () => {
    expect(parseTimeOfDay("00:00")).toBe(0);
    expect(parseTimeOfDay("09:30")).toBe(570);
    expect(parseTimeOfDay("23:59")).toBe(1439);
  });

  test("rejects malformed values", () => {
    expect(parseTimeOfDay("24:00")).toBeUndefined();
    expect(parseTimeOfDay("7:00")).toBeUndefined();
    expect(parseTimeOfDay("12:60")).toBeUndefined();
    expect(parseTimeOfDay("noon")).toBeUndefined();
    expect(parseTimeOfDay("")).toBeUndefined();
  });
});

describe("parsePeakWindow", () => {
  test("parses a same-day window with UTC and all days by default", () => {
    const { window } = parsePeakWindow({ start: "06:00", end: "10:00" });
    expect(window).toMatchObject({
      startMinutes: 360,
      endMinutes: 600,
      crossMidnight: false,
      tz: "UTC",
      days: [0, 1, 2, 3, 4, 5, 6],
    });
  });

  test("flags cross-midnight windows and sorts custom days", () => {
    const { window } = parsePeakWindow({
      start: "22:00",
      end: "02:00",
      tz: "Asia/Shanghai",
      days: [5, 1, 1, 4],
    });
    expect(window).toMatchObject({
      crossMidnight: true,
      tz: "Asia/Shanghai",
      days: [1, 4, 5],
    });
  });

  test("fails open with warnings for malformed windows", () => {
    expect(parsePeakWindow(null).warning).toBeDefined();
    expect(parsePeakWindow("06:00").warning).toBeDefined();
    expect(parsePeakWindow({ start: "25:00", end: "10:00" }).warning).toBeDefined();
    expect(parsePeakWindow({ start: "06:00", end: "bogus" }).warning).toBeDefined();
    expect(parsePeakWindow({ start: "06:00", end: "06:00" }).warning).toBeDefined();
    expect(
      parsePeakWindow({ start: "06:00", end: "10:00", tz: "Not/AZone" }).warning,
    ).toBeDefined();
    expect(parsePeakWindow({ start: "06:00", end: "10:00", days: [] }).warning).toBeDefined();
    expect(parsePeakWindow({ start: "06:00", end: "10:00", days: [0, 7] }).warning).toBeDefined();
    expect(
      parsePeakWindow({ start: "06:00", end: "10:00", days: "weekdays" }).warning,
    ).toBeDefined();
  });
});

describe("findActivePeak", () => {
  test("same-day window boundaries are start-inclusive and end-exclusive", () => {
    const schedules = DAILY("06:00", "10:00");
    expect(
      findActivePeak(at("2026-08-21T05:59:00Z"), schedules, "sample-provider"),
    ).toBeUndefined();
    expect(
      findActivePeak(at("2026-08-21T06:00:00Z"), schedules, "sample-provider")?.minutesRemaining,
    ).toBe(240);
    expect(
      findActivePeak(at("2026-08-21T10:00:00Z"), schedules, "sample-provider"),
    ).toBeUndefined();
  });

  test("same-day window reports boundary dates", () => {
    const hit = findActivePeak(
      at("2026-08-21T07:00:00Z"),
      DAILY("06:00", "10:00"),
      "sample-provider",
    );
    expect(hit?.endsAt.toISOString()).toBe("2026-08-21T10:00:00.000Z");
    expect(hit?.startedAt.toISOString()).toBe("2026-08-21T06:00:00.000Z");
    expect(hit?.minutesRemaining).toBe(180);
    expect(hit?.providerKey).toBe("sample-provider");
  });

  test("cross-midnight window matches the head on the opening day", () => {
    const hit = findActivePeak(
      at("2026-08-21T23:00:00Z"),
      DAILY("22:00", "02:00"),
      "sample-provider",
    );
    expect(hit?.minutesRemaining).toBe(180);
    expect(hit?.endsAt.toISOString()).toBe("2026-08-22T02:00:00.000Z");
    expect(hit?.startedAt.toISOString()).toBe("2026-08-21T22:00:00.000Z");
  });

  test("cross-midnight window matches the tail on the following day", () => {
    const hit = findActivePeak(
      at("2026-08-22T01:00:00Z"),
      DAILY("22:00", "02:00"),
      "sample-provider",
    );
    expect(hit?.minutesRemaining).toBe(60);
  });

  test("cross-midnight window respects weekday restrictions on the opening day", () => {
    const schedules = DAILY("22:00", "02:00", { days: [1, 2, 3, 4, 5] });
    // Friday 23:00 opens the window.
    expect(findActivePeak(at("2026-08-21T23:00:00Z"), schedules, "sample-provider")).toBeDefined();
    // Saturday 01:00 is the tail of the Friday opening.
    expect(findActivePeak(at("2026-08-22T01:00:00Z"), schedules, "sample-provider")).toBeDefined();
    // Saturday 23:00 does not open the window.
    expect(
      findActivePeak(at("2026-08-22T23:00:00Z"), schedules, "sample-provider"),
    ).toBeUndefined();
  });

  test("weekday restrictions exclude weekend days for weekday windows", () => {
    const schedules = DAILY("06:00", "10:00", { days: [1, 2, 3, 4, 5] });
    expect(findActivePeak(at("2026-08-21T07:00:00Z"), schedules, "sample-provider")).toBeDefined();
    expect(
      findActivePeak(at("2026-08-22T07:00:00Z"), schedules, "sample-provider"),
    ).toBeUndefined();
  });

  test("evaluates window times in the window timezone", () => {
    // 14:00-18:00 in Asia/Shanghai equals 06:00-10:00 UTC.
    const schedules = DAILY("14:00", "18:00", { tz: "Asia/Shanghai" });
    expect(findActivePeak(at("2026-08-21T07:00:00Z"), schedules, "sample-provider")).toBeDefined();
    expect(
      findActivePeak(at("2026-08-21T03:00:00Z"), schedules, "sample-provider"),
    ).toBeUndefined();
  });

  test("multiple windows select the hit with the largest remaining time", () => {
    const schedules: PeakSchedules = {
      "sample-provider": {
        windows: [dailyWindow("01:00", "04:00"), dailyWindow("06:00", "10:00")],
      },
    };
    const hit = findActivePeak(at("2026-08-21T02:00:00Z"), schedules, "sample-provider");
    expect(hit?.minutesRemaining).toBe(120);
  });

  test("skips malformed windows and unknown providers", () => {
    const schedules: PeakSchedules = {
      "sample-provider": {
        windows: [{ start: "bogus", end: "10:00" }, dailyWindow("06:00", "10:00")],
      },
    };
    expect(findActivePeak(at("2026-08-21T07:00:00Z"), schedules, "sample-provider")).toBeDefined();
    expect(
      findActivePeak(at("2026-08-21T07:00:00Z"), schedules, "unknown-provider"),
    ).toBeUndefined();
    expect(findActivePeak(at("2026-08-21T07:00:00Z"), {}, "sample-provider")).toBeUndefined();
  });
});

describe("provider key resolution", () => {
  const schedules: PeakSchedules = {
    deepseek: { windows: [] },
    "z-ai": { windows: [] },
    qwen: { windows: [] },
  };

  test("normalizes separators and case", () => {
    expect(normalizeProviderId(" Z_Ai ")).toBe("z-ai");
    expect(normalizeProviderId("Alibaba Cloud")).toBe("alibaba-cloud");
  });

  test("matches exact keys first, then aliases", () => {
    expect(resolveProviderKey("deepseek", schedules)).toBe("deepseek");
    expect(resolveProviderKey("z-ai", schedules)).toBe("z-ai");
    expect(resolveProviderKey("ZAI", schedules)).toBe("z-ai");
    expect(resolveProviderKey("zhipu", schedules)).toBe("z-ai");
    expect(resolveProviderKey("glm", schedules)).toBe("z-ai");
    expect(resolveProviderKey("alibaba", schedules)).toBe("qwen");
    expect(resolveProviderKey("dashscope", schedules)).toBe("qwen");
    expect(resolveProviderKey("openai", schedules)).toBeUndefined();
  });

  test("aliases do not resolve when the schedule key is absent", () => {
    expect(resolveProviderKey("zai", { deepseek: { windows: [] } })).toBeUndefined();
  });
});

describe("suggestOffPeakProviders", () => {
  const schedules: PeakSchedules = {
    deepseek: { windows: [dailyWindow("00:00", "14:00")] },
    qwen: { windows: [dailyWindow("00:00", "14:00")] },
    "z-ai": { windows: [dailyWindow("06:00", "10:00", { days: [1, 2, 3, 4, 5] })] },
  };

  test("suggests connected providers outside peak windows in input order", () => {
    expect(
      suggestOffPeakProviders(at("2026-08-21T07:00:00Z"), schedules, [
        "deepseek",
        "z-ai",
        "qwen",
        "openai",
      ]),
    ).toEqual(["openai"]);
  });

  test("returns all providers when none are scheduled", () => {
    expect(suggestOffPeakProviders(at("2026-08-21T07:00:00Z"), {}, ["z-ai", "qwen"])).toEqual([
      "z-ai",
      "qwen",
    ]);
  });

  test("deduplicates case and separator variants while preserving first spelling", () => {
    expect(
      suggestOffPeakProviders(at("2026-08-21T15:00:00Z"), schedules, [
        "DeepSeek",
        "deepseek",
        "z-ai",
      ]),
    ).toEqual(["DeepSeek", "z-ai"]);
  });

  test("returns an empty list when every connected provider is in peak", () => {
    expect(
      suggestOffPeakProviders(at("2026-08-21T07:00:00Z"), schedules, ["deepseek", "qwen"]),
    ).toEqual([]);
  });
});

describe("display formatting", () => {
  test("formatWaitMinutes renders bounded human strings", () => {
    expect(formatWaitMinutes(0)).toBe("0 min");
    expect(formatWaitMinutes(45)).toBe("45 min");
    expect(formatWaitMinutes(59)).toBe("59 min");
    expect(formatWaitMinutes(60)).toBe("1 h");
    expect(formatWaitMinutes(125)).toBe("2 h 5 min");
    expect(formatWaitMinutes(-5)).toBe("0 min");
  });

  test("formatPeakEndTime renders a deterministic UTC label", () => {
    expect(formatPeakEndTime(at("2026-08-21T14:00:00Z"))).toBe("14:00 UTC");
    expect(formatPeakEndTime(at("2026-08-22T00:30:00Z"))).toBe("00:30 UTC");
  });
});

describe("parsePeakHoursEntry", () => {
  test("seeds defaults for undefined and boolean values", () => {
    expect(parsePeakHoursEntry(undefined)).toEqual({
      entry: { enabled: true, mode: "hard", graceActiveSessions: true, schedules: {} },
      warnings: [],
    });
    expect(parsePeakHoursEntry(true).entry.enabled).toBe(true);
    expect(parsePeakHoursEntry(false).entry.enabled).toBe(false);
  });

  test("parses mode, grace, schedules, and per-provider mode overrides", () => {
    const { entry, warnings } = parsePeakHoursEntry({
      enabled: true,
      mode: "soft",
      graceActiveSessions: false,
      schedules: {
        deepseek: {
          mode: "hard",
          windows: [{ start: "01:00", end: "04:00" }],
        },
      },
    });
    expect(warnings).toEqual([]);
    expect(entry.mode).toBe("soft");
    expect(entry.graceActiveSessions).toBe(false);
    expect(entry.schedules.deepseek?.mode).toBe("hard");
    expect(entry.schedules.deepseek?.windows).toHaveLength(1);
  });

  test("fails open with warnings for malformed pieces", () => {
    const { entry, warnings } = parsePeakHoursEntry({
      enabled: "yes",
      mode: "strict",
      graceActiveSessions: 0,
      schedules: {
        deepseek: { windows: [{ start: "99:00", end: "10:00" }] },
        broken: "nope",
        empty: { windows: "nope" },
      },
    });
    expect(entry.enabled).toBe(true);
    expect(entry.mode).toBe(DEFAULT_PEAK_HOURS_MODE);
    expect(entry.graceActiveSessions).toBe(true);
    expect(entry.schedules.deepseek?.windows).toEqual([]);
    expect(entry.schedules.broken).toBeUndefined();
    expect(entry.schedules.empty).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("rejects non-object non-boolean values with defaults", () => {
    const { entry, warnings } = parsePeakHoursEntry("hard");
    expect(entry.mode).toBe("hard");
    expect(warnings).toHaveLength(1);
  });
});
