import type { RawSlotExtraction, ResolvedSlots } from "./index";

export function normalizeRawExtraction(
  raw: RawSlotExtraction,
): Partial<ResolvedSlots> {
  const result: Partial<ResolvedSlots> = {};

  if (raw.time) {
    if (raw.time.kind === "relative") {
      result.time = { kind: "relative", minutes: raw.time.minutes };
    } else if (raw.time.kind === "window") {
      result.time = { kind: "window", window: raw.time.window };
    } else if (
      raw.time.hour >= 0 &&
      raw.time.hour <= 23 &&
      raw.time.minute >= 0 &&
      raw.time.minute <= 59
    ) {
      result.time = {
        kind: "absolute",
        hour: raw.time.hour,
        minute: raw.time.minute,
      };
    }
  }

  if (raw.day) {
    result.day =
      raw.day.kind === "absolute" ? raw.day.value : raw.day.value.toLowerCase();
  }

  if (raw.duration && raw.duration.minutes >= 0) {
    result.duration = raw.duration.minutes;
  }

  if (raw.target) {
    result.target = raw.target.entityId;
  }

  return result;
}
