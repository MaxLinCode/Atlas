import type { RawSlotExtraction, ResolvedSlots } from "./index";

export function normalizeRawExtraction(raw: RawSlotExtraction): Partial<ResolvedSlots> {
  const result: Partial<ResolvedSlots> = {};

  if (raw.time) {
    result.time = `${String(raw.time.hour).padStart(2, "0")}:${String(raw.time.minute).padStart(2, "0")}`;
  }

  if (raw.day) {
    result.day = raw.day.kind === "absolute" ? raw.day.value : raw.day.value.toLowerCase();
  }

  if (raw.duration) {
    result.duration = raw.duration.minutes;
  }

  if (raw.target) {
    result.target = raw.target.entityId;
  }

  return result;
}
