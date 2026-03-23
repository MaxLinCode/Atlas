import { describe, expect, it } from "vitest";

import type { RawSlotExtraction } from "./index";
import { normalizeRawExtraction } from "./slot-normalizer";

describe("normalizeRawExtraction", () => {
  it("normalizes time to zero-padded HH:MM", () => {
    expect(normalizeRawExtraction(extraction({ time: { hour: 17, minute: 0 } }))).toMatchObject({
      time: "17:00"
    });
  });

  it("pads single-digit hours and minutes", () => {
    expect(normalizeRawExtraction(extraction({ time: { hour: 9, minute: 30 } }))).toMatchObject({
      time: "09:30"
    });
  });

  it("normalizes weekday to lowercase", () => {
    expect(normalizeRawExtraction(extraction({ day: { kind: "weekday", value: "Friday" } }))).toMatchObject({
      day: "friday"
    });
  });

  it("passes through absolute day value", () => {
    expect(normalizeRawExtraction(extraction({ day: { kind: "absolute", value: "2026-03-25" } }))).toMatchObject({
      day: "2026-03-25"
    });
  });

  it("normalizes relative day to lowercase", () => {
    expect(normalizeRawExtraction(extraction({ day: { kind: "relative", value: "Tomorrow" } }))).toMatchObject({
      day: "tomorrow"
    });
  });

  it("extracts duration minutes", () => {
    expect(normalizeRawExtraction(extraction({ duration: { minutes: 60 } }))).toMatchObject({
      duration: 60
    });
  });

  it("extracts target entityId", () => {
    expect(normalizeRawExtraction(extraction({ target: { entityId: "task-123" } }))).toMatchObject({
      target: "task-123"
    });
  });

  it("returns empty object when no slots present", () => {
    expect(normalizeRawExtraction(extraction({}))).toEqual({});
  });

  it("normalizes multiple slots at once", () => {
    const result = normalizeRawExtraction(extraction({
      time: { hour: 14, minute: 15 },
      day: { kind: "relative", value: "Tomorrow" },
      duration: { minutes: 45 },
      target: { entityId: "task-1" }
    }));

    expect(result).toEqual({
      time: "14:15",
      day: "tomorrow",
      duration: 45,
      target: "task-1"
    });
  });
});

function extraction(overrides: Partial<RawSlotExtraction>): RawSlotExtraction {
  return {
    time: null,
    day: null,
    duration: null,
    target: null,
    confidence: {},
    unresolvable: [],
    ...overrides
  };
}
