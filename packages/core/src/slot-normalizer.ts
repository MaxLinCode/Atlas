import type { RawSlotExtraction, ResolvedSlots } from "./index";

export function normalizeRawExtraction(raw: RawSlotExtraction): Partial<ResolvedSlots> {
  const result: Partial<ResolvedSlots> = {};

  if (raw.time && raw.time.hour >= 0 && raw.time.hour <= 23 && raw.time.minute >= 0 && raw.time.minute <= 59) {
    result.time = `${String(raw.time.hour).padStart(2, "0")}:${String(raw.time.minute).padStart(2, "0")}`;
  }

  if (raw.day) {
    result.day = raw.day.kind === "absolute" ? raw.day.value : raw.day.value.toLowerCase();
  }

  if (raw.duration && raw.duration.minutes >= 0) {
    result.duration = raw.duration.minutes;
  }

  if (raw.target) {
    result.target = raw.target.entityId;
  }

  return result;
}
