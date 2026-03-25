import type { TimeSpec, ResolvedSlots } from "./discourse-state";

type Weekday =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

const WEEKDAYS = new Set<string>([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]);

export function buildScheduleConstraintFromSlots(
  slots: Pick<ResolvedSlots, "day" | "time">,
): {
  dayReference: "today" | "tomorrow" | "weekday" | null;
  weekday: Weekday | null;
  weekOffset: number | null;
  relativeMinutes?: number | null;
  explicitHour: number | null;
  minute: number | null;
  preferredWindow: "morning" | "afternoon" | "evening" | null;
  sourceText: string;
} | null {
  if (!slots.day && !slots.time) return null;

  const timeFields = slots.time
    ? timeSpecToConstraintFields(slots.time)
    : {
        explicitHour: null,
        minute: null,
        relativeMinutes: null,
        preferredWindow: "morning" as const,
      };

  let dayReference: "today" | "tomorrow" | "weekday" | null = null;
  let weekday: Weekday | null = null;
  let weekOffset: number | null = null;

  if (slots.day) {
    const lower = slots.day.toLowerCase();
    if (lower === "today") {
      dayReference = "today";
    } else if (lower === "tomorrow") {
      dayReference = "tomorrow";
    } else if (WEEKDAYS.has(lower)) {
      dayReference = "weekday";
      weekday = lower as Weekday;
      weekOffset = 0;
    }
  }

  const parts: string[] = [];
  if (slots.day) parts.push(slots.day);
  if (slots.time) parts.push(formatTimeSpec(slots.time));
  const sourceText = parts.join(" at ") || "scheduled";

  return {
    dayReference,
    weekday,
    weekOffset,
    ...timeFields,
    sourceText,
  };
}

export function timeSpecToHHMM(spec: TimeSpec): string | null {
  if (spec.kind === "absolute") {
    return `${String(spec.hour).padStart(2, "0")}:${String(spec.minute).padStart(2, "0")}`;
  }
  return null;
}

export function formatTimeSpec(spec: TimeSpec): string {
  switch (spec.kind) {
    case "absolute": {
      const period = spec.hour >= 12 ? "pm" : "am";
      const displayHour =
        spec.hour === 0 ? 12 : spec.hour > 12 ? spec.hour - 12 : spec.hour;
      if (spec.minute === 0) {
        return `${displayHour}${period}`;
      }
      return `${displayHour}:${String(spec.minute).padStart(2, "0")}${period}`;
    }
    case "relative": {
      if (spec.minutes < 60) {
        return `in ${spec.minutes} minutes`;
      }
      const hours = Math.floor(spec.minutes / 60);
      const remainder = spec.minutes % 60;
      if (remainder === 0) {
        return `in ${hours} hour${hours > 1 ? "s" : ""}`;
      }
      return `in ${hours}h ${remainder}m`;
    }
    case "window":
      return `in the ${spec.window}`;
  }
}

export function timeSpecToConstraintFields(spec: TimeSpec) {
  switch (spec.kind) {
    case "absolute":
      return {
        explicitHour: spec.hour,
        minute: spec.minute,
        relativeMinutes: null,
        preferredWindow: null,
      };
    case "relative":
      return {
        explicitHour: null,
        minute: null,
        relativeMinutes: spec.minutes,
        preferredWindow: null,
      };
    case "window":
      return {
        explicitHour: null,
        minute: null,
        relativeMinutes: null,
        preferredWindow: spec.window,
      };
  }
}

export function timeSpecsEqual(a: TimeSpec, b: TimeSpec): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "absolute":
      return (
        a.hour === (b as typeof a).hour && a.minute === (b as typeof a).minute
      );
    case "relative":
      return a.minutes === (b as typeof a).minutes;
    case "window":
      return a.window === (b as typeof a).window;
  }
}
