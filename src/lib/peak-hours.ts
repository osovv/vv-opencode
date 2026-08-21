// FILE: src/lib/peak-hours.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Pure provider-level peak-hours schedule evaluation shared by the peak-hours server plugin and TUI banner.
//   SCOPE: Window parsing with explicit timezones, cross-midnight and weekday handling, provider id normalization and aliases, active-window lookup with end boundaries, connected-provider suggestion filtering, plugin entry parsing, and bounded display formatting.
//   DEPENDS: [none]
//   LINKS: [M-PEAK-HOURS-SCHEDULES, M-PLUGIN-PEAK-HOURS, M-TUI-PEAK-HOURS-BANNER]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PeakWindowSpec - Raw window shape from configuration with start, end, optional tz, and optional days.
//   PeakProviderSchedule - Per-provider schedule with optional mode override and windows.
//   PeakSchedules - Provider-keyed schedule map.
//   ParsedPeakWindow - Validated window with minute offsets, timezone, sorted days, and cross-midnight flag.
//   PeakHoursClock - Injectable clock returning the current Date.
//   PeakHoursMode - Soft or hard enforcement mode.
//   PeakHoursEntryConfig - Fully seeded plugin entry shape used by the server plugin and banner.
//   ActivePeak - Active window hit with provider ids, boundary dates, and remaining minutes.
//   DEFAULT_PEAK_TIMEZONE - Default window timezone (UTC).
//   DEFAULT_PEAK_HOURS_MODE - Default enforcement mode (hard).
//   ALL_WEEKDAYS - All seven weekday indexes.
//   PROVIDER_KEY_ALIASES - Known provider id spellings mapped onto canonical schedule keys.
//   normalizeProviderId - Lowercases, trims, and canonicalizes separators in a provider id.
//   resolveProviderKey - Maps a provider id onto a schedule key through exact and alias matching.
//   parseTimeOfDay - Parses HH:MM into minutes past midnight.
//   parsePeakWindow - Validates one raw window and returns it with a warning on malformed input.
//   findActivePeak - Returns the active window hit for a provider at a time, if any.
//   suggestOffPeakProviders - Filters connected provider ids down to those outside active peak windows.
//   formatWaitMinutes - Renders remaining minutes as a bounded human string.
//   formatPeakEndTime - Renders a window end instant as a deterministic HH:MM UTC label.
//   parsePeakHoursEntry - Normalizes a plugins["peak-hours"] value into a seeded entry with warnings.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-PLUGIN-PEAK-HOURS - Added the pure peak-hours schedule library shared by the server plugin and TUI banner.]
// END_CHANGE_SUMMARY

export type PeakHoursClock = () => Date;

export type PeakWindowSpec = {
  start: string;
  end: string;
  tz?: string;
  days?: number[];
};

export type PeakProviderSchedule = {
  mode?: PeakHoursMode;
  windows: PeakWindowSpec[];
};

export type PeakSchedules = Record<string, PeakProviderSchedule>;

export type ParsedPeakWindow = {
  startMinutes: number;
  endMinutes: number;
  crossMidnight: boolean;
  tz: string;
  days: number[];
};

export type PeakHoursMode = "soft" | "hard";

export type PeakHoursEntryConfig = {
  enabled: boolean;
  mode: PeakHoursMode;
  graceActiveSessions: boolean;
  schedules: PeakSchedules;
};

export type ActivePeak = {
  providerKey: string;
  providerID: string;
  window: ParsedPeakWindow;
  endsAt: Date;
  startedAt: Date;
  minutesRemaining: number;
};

export const DEFAULT_PEAK_TIMEZONE = "UTC";
export const DEFAULT_PEAK_HOURS_MODE: PeakHoursMode = "hard";
export const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

const MINUTES_PER_DAY = 1_440;
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// Known alternate spellings of schedule-owned provider ids observed across
// OpenCode provider catalogs. Canonical keys: deepseek, z-ai, qwen.
export const PROVIDER_KEY_ALIASES: Record<string, string> = {
  zai: "z-ai",
  z_ai: "z-ai",
  zhipu: "z-ai",
  bigmodel: "z-ai",
  glm: "z-ai",
  "qwen-cloud": "qwen",
  "qwen-coder": "qwen",
  alibaba: "qwen",
  "alibaba-cloud": "qwen",
  alibabacloud: "qwen",
  dashscope: "qwen",
  modelstudio: "qwen",
};

// START_CONTRACT: normalizeProviderId
//   PURPOSE: Canonicalize a provider id for schedule matching.
//   INPUTS: { id: string - provider id as observed from OpenCode surfaces }
//   OUTPUTS: { string - lowercased id with whitespace and underscores folded to single hyphens }
//   SIDE_EFFECTS: none
//   LINKS: resolveProviderKey
// END_CONTRACT: normalizeProviderId
export function normalizeProviderId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

// START_CONTRACT: resolveProviderKey
//   PURPOSE: Map an observed provider id onto a schedule key via exact then alias matching.
//   INPUTS: { providerID: string - observed provider id; schedules: PeakSchedules - loaded schedule map }
//   OUTPUTS: { string | undefined - matching schedule key, or undefined when the provider owns no schedule }
//   SIDE_EFFECTS: none
//   LINKS: normalizeProviderId, PROVIDER_KEY_ALIASES
// END_CONTRACT: resolveProviderKey
export function resolveProviderKey(
  providerID: string,
  schedules: PeakSchedules,
): string | undefined {
  const normalized = normalizeProviderId(providerID);
  if (normalized && schedules[normalized]) {
    return normalized;
  }
  const aliased = PROVIDER_KEY_ALIASES[normalized];
  if (aliased && schedules[aliased]) {
    return aliased;
  }
  return undefined;
}

// START_CONTRACT: parseTimeOfDay
//   PURPOSE: Parse an HH:MM string into minutes past midnight.
//   INPUTS: { value: string - candidate time-of-day string }
//   OUTPUTS: { number | undefined - minutes 0 through 1439, or undefined for malformed input }
//   SIDE_EFFECTS: none
//   LINKS: parsePeakWindow
// END_CONTRACT: parseTimeOfDay
export function parseTimeOfDay(value: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// START_CONTRACT: parsePeakWindow
//   PURPOSE: Validate one raw window spec and return the parsed window, failing open with a warning.
//   INPUTS: { spec: unknown - raw window value from configuration }
//   OUTPUTS: { { window?: ParsedPeakWindow; warning?: string } - parsed window when valid, or a warning string when malformed }
//   SIDE_EFFECTS: none
//   LINKS: parseTimeOfDay
// END_CONTRACT: parsePeakWindow
export function parsePeakWindow(spec: unknown): { window?: ParsedPeakWindow; warning?: string } {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return { warning: "window must be an object" };
  }

  const record = spec as Record<string, unknown>;
  const start = typeof record.start === "string" ? record.start.trim() : "";
  const end = typeof record.end === "string" ? record.end.trim() : "";
  const startMinutes = start ? parseTimeOfDay(start) : undefined;
  const endMinutes = end ? parseTimeOfDay(end) : undefined;
  if (startMinutes === undefined || endMinutes === undefined) {
    return { warning: `window has invalid start or end time (${start}..${end})` };
  }
  if (startMinutes === endMinutes) {
    return { warning: `window start and end must differ (${start}..${end})` };
  }

  const tz =
    typeof record.tz === "string" && record.tz.trim() ? record.tz.trim() : DEFAULT_PEAK_TIMEZONE;
  if (!isValidTimezone(tz)) {
    return { warning: `window has invalid tz (${tz})` };
  }

  let days: number[] = [...ALL_WEEKDAYS];
  if (record.days !== undefined) {
    if (!Array.isArray(record.days) || record.days.length === 0) {
      return { warning: "window days must be a non-empty array of integers 0 through 6" };
    }
    const parsedDays = [...new Set(record.days as unknown[])].map((day) => Number(day));
    if (parsedDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      return { warning: "window days must be integers 0 through 6" };
    }
    days = parsedDays.sort((left, right) => left - right);
  }

  return {
    window: {
      startMinutes,
      endMinutes,
      crossMidnight: endMinutes < startMinutes,
      tz,
      days,
    },
  };
}

function zonedParts(date: Date, timeZone: string): { weekday: number; minutes: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const weekdayName = parts.find((part) => part.type === "weekday")?.value ?? "";
  const rawHour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const weekday = WEEKDAY_INDEX[weekdayName] ?? -1;
  // Some ICU builds render midnight as hour 24 with hour12: false.
  const hour = rawHour === 24 ? 0 : rawHour;
  if (weekday < 0 || !Number.isFinite(hour) || !Number.isFinite(minute)) {
    return { weekday: -1, minutes: 0 };
  }
  return { weekday, minutes: hour * 60 + minute };
}

function evaluateWindow(
  window: ParsedPeakWindow,
  now: Date,
): { active: boolean; minutesRemaining: number } {
  const { weekday, minutes } = zonedParts(now, window.tz);
  if (weekday < 0) return { active: false, minutesRemaining: 0 };

  const previousWeekday = (weekday + 6) % 7;

  if (!window.crossMidnight) {
    const active =
      window.days.includes(weekday) &&
      minutes >= window.startMinutes &&
      minutes < window.endMinutes;
    return { active, minutesRemaining: active ? window.endMinutes - minutes : 0 };
  }

  // Cross-midnight windows open on a listed day and run into the next day.
  if (window.days.includes(weekday) && minutes >= window.startMinutes) {
    return { active: true, minutesRemaining: MINUTES_PER_DAY - minutes + window.endMinutes };
  }
  if (window.days.includes(previousWeekday) && minutes < window.endMinutes) {
    return { active: true, minutesRemaining: window.endMinutes - minutes };
  }
  return { active: false, minutesRemaining: 0 };
}

function windowDurationMinutes(window: ParsedPeakWindow): number {
  return window.crossMidnight
    ? MINUTES_PER_DAY - window.startMinutes + window.endMinutes
    : window.endMinutes - window.startMinutes;
}

// START_CONTRACT: findActivePeak
//   PURPOSE: Find the active peak window hit for a provider at a given time.
//   INPUTS: { now: Date - evaluation instant; schedules: PeakSchedules - loaded schedule map; providerID: string - observed provider id }
//   OUTPUTS: { ActivePeak | undefined - hit with boundaries and remaining minutes, or undefined when not in peak or unscheduled }
//   SIDE_EFFECTS: none
//   LINKS: resolveProviderKey, parsePeakWindow
// END_CONTRACT: findActivePeak
export function findActivePeak(
  now: Date,
  schedules: PeakSchedules,
  providerID: string,
): ActivePeak | undefined {
  const providerKey = resolveProviderKey(providerID, schedules);
  if (!providerKey) return undefined;

  const schedule = schedules[providerKey];
  if (!schedule || !Array.isArray(schedule.windows)) return undefined;

  let best: { window: ParsedPeakWindow; minutesRemaining: number } | undefined;
  for (const rawWindow of schedule.windows) {
    const { window } = parsePeakWindow(rawWindow);
    if (!window) continue;
    const result = evaluateWindow(window, now);
    if (result.active && (!best || result.minutesRemaining > best.minutesRemaining)) {
      best = { window, minutesRemaining: result.minutesRemaining };
    }
  }
  if (!best) return undefined;

  const durationMinutes = windowDurationMinutes(best.window);
  const endsAtMs = now.getTime() + best.minutesRemaining * 60_000;
  return {
    providerKey,
    providerID,
    window: best.window,
    endsAt: new Date(endsAtMs),
    startedAt: new Date(endsAtMs - durationMinutes * 60_000),
    minutesRemaining: best.minutesRemaining,
  };
}

// START_CONTRACT: suggestOffPeakProviders
//   PURPOSE: Filter connected provider ids down to those currently outside any active peak window.
//   INPUTS: { now: Date - evaluation instant; schedules: PeakSchedules - loaded schedule map; connectedProviderIDs: readonly string[] - observed connected provider ids in display order }
//   OUTPUTS: { string[] - original provider ids not currently in peak, deduplicated, preserving input order }
//   SIDE_EFFECTS: none
//   LINKS: findActivePeak, normalizeProviderId
// END_CONTRACT: suggestOffPeakProviders
export function suggestOffPeakProviders(
  now: Date,
  schedules: PeakSchedules,
  connectedProviderIDs: readonly string[],
): string[] {
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const providerID of connectedProviderIDs) {
    if (typeof providerID !== "string" || !providerID.trim()) continue;
    const normalized = normalizeProviderId(providerID);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (!findActivePeak(now, schedules, providerID)) {
      suggestions.push(providerID);
    }
  }
  return suggestions;
}

// START_CONTRACT: formatWaitMinutes
//   PURPOSE: Render remaining minutes as a bounded human-readable string.
//   INPUTS: { minutes: number - remaining whole minutes }
//   OUTPUTS: { string - "N min" below an hour, otherwise "H h M min" }
//   SIDE_EFFECTS: none
//   LINKS: none
// END_CONTRACT: formatWaitMinutes
export function formatWaitMinutes(minutes: number): string {
  const bounded = Math.max(0, Math.round(minutes));
  if (bounded < 60) return `${bounded} min`;
  const hours = Math.floor(bounded / 60);
  const remainder = bounded % 60;
  return remainder === 0 ? `${hours} h` : `${hours} h ${remainder} min`;
}

// START_CONTRACT: formatPeakEndTime
//   PURPOSE: Render a window end instant as a deterministic UTC label.
//   INPUTS: { date: Date - window end instant }
//   OUTPUTS: { string - "HH:MM UTC" label }
//   SIDE_EFFECTS: none
//   LINKS: none
// END_CONTRACT: formatPeakEndTime
export function formatPeakEndTime(date: Date): string {
  return `${date.toISOString().slice(11, 16)} UTC`;
}

// START_CONTRACT: parsePeakHoursEntry
//   PURPOSE: Normalize a plugins["peak-hours"] value into a seeded entry, failing open on malformed pieces.
//   INPUTS: { value: unknown - boolean, object, or undefined plugin entry value from the vvoc config }
//   OUTPUTS: { { entry: PeakHoursEntryConfig; warnings: string[] } - seeded entry plus warnings for skipped malformed pieces }
//   SIDE_EFFECTS: none
//   LINKS: parsePeakWindow, DEFAULT_PEAK_HOURS_MODE
// END_CONTRACT: parsePeakHoursEntry
export function parsePeakHoursEntry(value: unknown): {
  entry: PeakHoursEntryConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const entry: PeakHoursEntryConfig = {
    enabled: true,
    mode: DEFAULT_PEAK_HOURS_MODE,
    graceActiveSessions: true,
    schedules: {},
  };

  if (value === undefined || typeof value === "boolean") {
    if (value === false) entry.enabled = false;
    return { entry, warnings };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("plugins[peak-hours] must be a boolean or an object; using defaults");
    return { entry, warnings };
  }

  const record = value as Record<string, unknown>;

  if (record.enabled !== undefined) {
    if (typeof record.enabled === "boolean") {
      entry.enabled = record.enabled;
    } else {
      warnings.push("plugins[peak-hours].enabled must be a boolean; using default");
    }
  }

  if (record.mode !== undefined) {
    if (record.mode === "soft" || record.mode === "hard") {
      entry.mode = record.mode;
    } else {
      warnings.push(`plugins[peak-hours].mode must be "soft" or "hard"; using ${entry.mode}`);
    }
  }

  if (record.graceActiveSessions !== undefined) {
    if (typeof record.graceActiveSessions === "boolean") {
      entry.graceActiveSessions = record.graceActiveSessions;
    } else {
      warnings.push("plugins[peak-hours].graceActiveSessions must be a boolean; using default");
    }
  }

  if (record.schedules !== undefined) {
    if (
      !record.schedules ||
      typeof record.schedules !== "object" ||
      Array.isArray(record.schedules)
    ) {
      warnings.push("plugins[peak-hours].schedules must be an object; ignoring schedules");
    } else {
      for (const [providerKey, providerValue] of Object.entries(
        record.schedules as Record<string, unknown>,
      )) {
        if (!providerValue || typeof providerValue !== "object" || Array.isArray(providerValue)) {
          warnings.push(`schedules["${providerKey}"] must be an object; skipped`);
          continue;
        }
        const providerRecord = providerValue as Record<string, unknown>;
        if (providerRecord.windows !== undefined && !Array.isArray(providerRecord.windows)) {
          warnings.push(`schedules["${providerKey}"].windows must be an array; skipped`);
          continue;
        }
        const windows: PeakWindowSpec[] = [];
        if (Array.isArray(providerRecord.windows)) {
          for (const rawWindow of providerRecord.windows) {
            const parsed = parsePeakWindow(rawWindow);
            if (parsed.window && typeof rawWindow === "object" && rawWindow !== null) {
              windows.push(rawWindow as PeakWindowSpec);
            } else if (parsed.warning) {
              warnings.push(`schedules["${providerKey}"]: ${parsed.warning}`);
            }
          }
        }

        const providerSchedule: PeakProviderSchedule = { windows };
        if (providerRecord.mode === "soft" || providerRecord.mode === "hard") {
          providerSchedule.mode = providerRecord.mode;
        } else if (providerRecord.mode !== undefined) {
          warnings.push(`schedules["${providerKey}"].mode must be "soft" or "hard"; ignored`);
        }
        entry.schedules[providerKey] = providerSchedule;
      }
    }
  }

  return { entry, warnings };
}
