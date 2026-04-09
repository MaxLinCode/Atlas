import { describe, expect, it } from "vitest";
import {
  conversationClarificationEntitySchema,
  pendingClarificationSchema,
} from "./index";

describe("clarification parentTargetRef schema", () => {
  it("accepts parentTargetRef: null on clarification entity", () => {
    const entity = conversationClarificationEntitySchema.parse({
      id: "clar-1",
      conversationId: "conv-1",
      kind: "clarification",
      label: "Need a time",
      status: "active",
      createdAt: "2026-04-09T10:00:00.000Z",
      updatedAt: "2026-04-09T10:00:00.000Z",
      data: {
        prompt: "What time?",
        reason: "scheduleFields.time",
        open: true,
        parentTargetRef: null,
      },
    });
    expect(entity.data.parentTargetRef).toBeNull();
  });

  it("accepts parentTargetRef with entityId on clarification entity", () => {
    const entity = conversationClarificationEntitySchema.parse({
      id: "clar-1",
      conversationId: "conv-1",
      kind: "clarification",
      label: "Need a time",
      status: "active",
      createdAt: "2026-04-09T10:00:00.000Z",
      updatedAt: "2026-04-09T10:00:00.000Z",
      data: {
        prompt: "What time?",
        reason: "scheduleFields.time",
        open: true,
        parentTargetRef: { entityId: "task-1" },
      },
    });
    expect(entity.data.parentTargetRef).toEqual({ entityId: "task-1" });
  });

  it("defaults parentTargetRef to null when omitted (backward compat)", () => {
    const entity = conversationClarificationEntitySchema.parse({
      id: "clar-1",
      conversationId: "conv-1",
      kind: "clarification",
      label: "Need a time",
      status: "active",
      createdAt: "2026-04-09T10:00:00.000Z",
      updatedAt: "2026-04-09T10:00:00.000Z",
      data: {
        prompt: "What time?",
        reason: "scheduleFields.time",
        open: true,
      },
    });
    expect(entity.data.parentTargetRef).toBeNull();
  });

  it("accepts parentTargetRef on pending clarification", () => {
    const pc = pendingClarificationSchema.parse({
      id: "clar-1",
      slot: "scheduleFields.time",
      question: "What time?",
      status: "pending",
      createdAt: "2026-04-09T10:00:00.000Z",
      createdTurnId: "assistant:1",
      parentTargetRef: null,
    });
    expect(pc.parentTargetRef).toBeNull();
  });

  it("defaults parentTargetRef to null on pending clarification when omitted", () => {
    const pc = pendingClarificationSchema.parse({
      id: "clar-1",
      slot: "scheduleFields.time",
      question: "What time?",
      status: "pending",
      createdAt: "2026-04-09T10:00:00.000Z",
      createdTurnId: "assistant:1",
    });
    expect(pc.parentTargetRef).toBeNull();
  });
});
