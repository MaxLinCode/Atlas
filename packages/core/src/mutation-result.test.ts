import { describe, expect, it } from "vitest";
import type { MutationResult } from "./mutation-result";

describe("MutationResult type", () => {
  it("accepts a created outcome", () => {
    const result: MutationResult = {
      outcome: "created",
      tasks: [],
      scheduleBlocks: [],
      followUpMessage: "Saved.",
    };
    expect(result.outcome).toBe("created");
  });

  it("accepts a scheduled outcome", () => {
    const result: MutationResult = {
      outcome: "scheduled",
      tasks: [],
      scheduleBlocks: [],
      followUpMessage: "Scheduled.",
    };
    expect(result.outcome).toBe("scheduled");
  });

  it("accepts a rescheduled outcome", () => {
    const result: MutationResult = {
      outcome: "rescheduled",
      updatedBlock: {
        id: "block-1",
        userId: "user-1",
        taskId: "task-1",
        startAt: "2026-04-06T09:00:00Z",
        endAt: "2026-04-06T10:00:00Z",
        confidence: 0.9,
        reason: "moved",
        rescheduleCount: 1,
        externalCalendarId: null,
      },
      followUpMessage: "Rescheduled.",
    };
    expect(result.outcome).toBe("rescheduled");
  });

  it("accepts a completed outcome", () => {
    const result: MutationResult = {
      outcome: "completed",
      tasks: [],
      followUpMessage: "Done.",
    };
    expect(result.outcome).toBe("completed");
  });

  it("accepts an archived outcome", () => {
    const result: MutationResult = {
      outcome: "archived",
      tasks: [],
      followUpMessage: "Archived.",
    };
    expect(result.outcome).toBe("archived");
  });

  it("accepts a needs_clarification outcome", () => {
    const result: MutationResult = {
      outcome: "needs_clarification",
      reason: "ambiguous target",
      followUpMessage: "Which task?",
    };
    expect(result.outcome).toBe("needs_clarification");
  });
});
