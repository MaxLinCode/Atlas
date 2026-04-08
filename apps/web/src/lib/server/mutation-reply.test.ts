import { describe, expect, it } from "vitest";

import { renderMutationReply } from "./mutation-reply";

describe("mutation reply renderer", () => {
  it("lists every scheduled item in a multi-item planned result", () => {
    const reply = renderMutationReply({
      outcome: "created",
      tasks: [
        { id: "task-1", title: "Review launch checklist" },
        { id: "task-2", title: "Send client update" },
      ] as any,
      scheduleBlocks: [
        {
          id: "event-a",
          userId: "123",
          taskId: "task-1",
          startAt: "2026-03-19T09:00:00.000Z",
          endAt: "2026-03-19T10:00:00.000Z",
          confidence: 0.9,
          reason: "First task",
          rescheduleCount: 0,
          externalCalendarId: "primary",
        },
        {
          id: "event-b",
          userId: "123",
          taskId: "task-2",
          startAt: "2026-03-19T11:00:00.000Z",
          endAt: "2026-03-19T11:30:00.000Z",
          confidence: 0.9,
          reason: "Second task",
          rescheduleCount: 0,
          externalCalendarId: "primary",
        },
      ],
      followUpMessage: "",
    });

    expect(reply).toContain("Scheduled:");
    expect(reply).toContain("'Review launch checklist'");
    expect(reply).toContain("'Send client update'");
  });

  it("formats scheduled times in the supplied user timezone", () => {
    const reply = renderMutationReply(
      {
        outcome: "rescheduled",
        updatedBlock: {
          id: "event-a",
          userId: "123",
          taskId: "task-1",
          startAt: "2026-03-20T16:00:00.000Z",
          endAt: "2026-03-20T17:00:00.000Z",
          confidence: 0.9,
          reason: "Moved",
          rescheduleCount: 1,
          externalCalendarId: "primary",
        },
        followUpMessage: "",
      },
      {
        timeZone: "America/Los_Angeles",
      },
    );

    expect(reply).toContain("Mar 20");
    expect(reply).toContain("9:00 AM");
  });

  it("renders completed task replies from persisted outcomes", () => {
    const reply = renderMutationReply({
      outcome: "completed",
      tasks: [{ id: "task-1", title: "Journaling session" }] as any,
      followUpMessage: "",
    });

    expect(reply).toBe("Marked 'Journaling session' as done.");
  });

  it("uses the stored follow-up message for clarification replies", () => {
    const reply = renderMutationReply({
      outcome: "needs_clarification",
      reason:
        "Model returned invalid or mixed schedule references for newly created tasks.",
      followUpMessage:
        "I couldn't safely apply that update. Tell me the exact task and what you'd like me to change.",
    });

    expect(reply).toBe(
      "I couldn't safely apply that update. Tell me the exact task and what you'd like me to change.",
    );
  });

  it("renders archived task replies from persisted outcomes", () => {
    const reply = renderMutationReply({
      outcome: "archived",
      tasks: [{ id: "task-1", title: "Journaling session" }] as any,
      followUpMessage: "",
    });

    expect(reply).toBe("Archived 'Journaling session'.");
  });
});
