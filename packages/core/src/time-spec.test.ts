import { describe, expect, it } from "vitest";
import { buildScheduleConstraintFromSlots } from "./time-spec";
import { scheduleConstraintSchema } from "./index";

describe("buildScheduleConstraintFromSlots", () => {
  it("returns null when no day or time provided", () => {
    expect(buildScheduleConstraintFromSlots({})).toBeNull();
  });

  it("builds constraint from absolute time + tomorrow", () => {
    const result = buildScheduleConstraintFromSlots({
      day: "tomorrow",
      time: { kind: "absolute", hour: 15, minute: 0 },
    });

    expect(result).toMatchObject({
      dayReference: "tomorrow",
      weekday: null,
      weekOffset: null,
      explicitHour: 15,
      minute: 0,
      preferredWindow: null,
    });
    expect(scheduleConstraintSchema.safeParse(result).success).toBe(true);
  });

  it("builds constraint from relative time only", () => {
    const result = buildScheduleConstraintFromSlots({
      time: { kind: "relative", minutes: 15 },
    });

    expect(result).toMatchObject({
      dayReference: null,
      weekday: null,
      weekOffset: null,
      relativeMinutes: 15,
      explicitHour: null,
    });
    expect(scheduleConstraintSchema.safeParse(result).success).toBe(true);
  });

  it("builds constraint from window time + weekday", () => {
    const result = buildScheduleConstraintFromSlots({
      day: "friday",
      time: { kind: "window", window: "morning" },
    });

    expect(result).toMatchObject({
      dayReference: "weekday",
      weekday: "friday",
      weekOffset: 0,
      explicitHour: null,
      preferredWindow: "morning",
    });
    expect(scheduleConstraintSchema.safeParse(result).success).toBe(true);
  });

  it("defaults to morning window when day-only", () => {
    const result = buildScheduleConstraintFromSlots({ day: "today" });

    expect(result).toMatchObject({
      dayReference: "today",
      preferredWindow: "morning",
      explicitHour: null,
    });
    expect(scheduleConstraintSchema.safeParse(result).success).toBe(true);
  });

  it("builds constraint from window time + today", () => {
    const result = buildScheduleConstraintFromSlots({
      day: "today",
      time: { kind: "window", window: "evening" },
    });

    expect(result).toMatchObject({
      dayReference: "today",
      preferredWindow: "evening",
      explicitHour: null,
    });
    expect(scheduleConstraintSchema.safeParse(result).success).toBe(true);
  });

  it("builds constraint from time-only absolute", () => {
    const result = buildScheduleConstraintFromSlots({
      time: { kind: "absolute", hour: 9, minute: 30 },
    });

    expect(result).toMatchObject({
      dayReference: null,
      explicitHour: 9,
      minute: 30,
    });
    expect(scheduleConstraintSchema.safeParse(result).success).toBe(true);
  });

  it("synthesizes readable sourceText", () => {
    const result = buildScheduleConstraintFromSlots({
      day: "tomorrow",
      time: { kind: "absolute", hour: 15, minute: 0 },
    });
    expect(result?.sourceText).toBe("tomorrow at 3pm");
  });
});
