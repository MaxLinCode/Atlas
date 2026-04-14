import { describe, expect, it } from "vitest";
import { conversationClarificationEntitySchema } from "./index";

describe("clarification parentTargetRef schema", () => {
  const baseClarification = {
    id: "clar-1",
    conversationId: "conv-1",
    kind: "clarification",
    label: "Need a time",
    status: "active",
    createdAt: "2026-04-09T10:00:00.000Z",
    updatedAt: "2026-04-09T10:00:00.000Z",
  };

  it("accepts parentTargetRef: null", () => {
    const entity = conversationClarificationEntitySchema.parse({
      ...baseClarification,
      data: { prompt: "What time?", reason: "scheduleFields.time", open: true, parentTargetRef: null },
    });
    expect(entity.data.parentTargetRef).toBeNull();
  });

  it("accepts parentTargetRef with entityId", () => {
    const entity = conversationClarificationEntitySchema.parse({
      ...baseClarification,
      data: { prompt: "What time?", reason: "scheduleFields.time", open: true, parentTargetRef: { entityId: "task-1" } },
    });
    expect(entity.data.parentTargetRef).toEqual({ entityId: "task-1" });
  });

  it("defaults parentTargetRef to null when omitted (backward compat)", () => {
    const entity = conversationClarificationEntitySchema.parse({
      ...baseClarification,
      data: { prompt: "What time?", reason: "scheduleFields.time", open: true },
    });
    expect(entity.data.parentTargetRef).toBeNull();
  });
});
