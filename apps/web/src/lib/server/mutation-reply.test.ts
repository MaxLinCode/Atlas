import { describe, expect, it } from "vitest";

import { renderMutationReply } from "./mutation-reply";

describe("mutation reply renderer", () => {
  it("lists every scheduled item in a multi-item planned result", () => {
    const reply = renderMutationReply({
      outcome: "planned",
      inboxItem: {
        id: "inbox-1",
        userId: "123",
        sourceEventId: "event-1",
        rawText: "Schedule both",
        normalizedText: "Schedule both",
        processingStatus: "planned",
        linkedTaskIds: ["task-1", "task-2"],
      },
      plannerRun: {
        id: "run-1",
        userId: "123",
        inboxItemId: "inbox-1",
        version: "test",
        modelInput: {},
        modelOutput: {},
        confidence: 0.9,
      },
      createdTasks: [
        {
          id: "task-1",
          userId: "123",
          sourceInboxItemId: "inbox-1",
          lastInboxItemId: "inbox-1",
          title: "Review launch checklist",
          lifecycleState: "scheduled",
          externalCalendarEventId: "event-a",
          externalCalendarId: "primary",
          scheduledStartAt: "2026-03-19T09:00:00.000Z",
          scheduledEndAt: "2026-03-19T10:00:00.000Z",
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt: "2026-03-18T12:00:00.000Z",
          rescheduleCount: 0,
          lastFollowupAt: null,
          followupReminderSentAt: null,
          completedAt: null,
          archivedAt: null,
          priority: "medium",
          urgency: "medium",
        },
        {
          id: "task-2",
          userId: "123",
          sourceInboxItemId: "inbox-1",
          lastInboxItemId: "inbox-1",
          title: "Send client update",
          lifecycleState: "scheduled",
          externalCalendarEventId: "event-b",
          externalCalendarId: "primary",
          scheduledStartAt: "2026-03-19T11:00:00.000Z",
          scheduledEndAt: "2026-03-19T11:30:00.000Z",
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt: "2026-03-18T12:00:00.000Z",
          rescheduleCount: 0,
          lastFollowupAt: null,
          followupReminderSentAt: null,
          completedAt: null,
          archivedAt: null,
          priority: "medium",
          urgency: "medium",
        },
      ],
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
        outcome: "updated_schedule",
        inboxItem: {
          id: "inbox-1",
          userId: "123",
          sourceEventId: "event-1",
          rawText: "Move it",
          normalizedText: "Move it",
          processingStatus: "planned",
          linkedTaskIds: ["task-1"],
        },
        plannerRun: {
          id: "run-1",
          userId: "123",
          inboxItemId: "inbox-1",
          version: "test",
          modelInput: {},
          modelOutput: {},
          confidence: 0.9,
        },
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
      outcome: "completed_tasks",
      inboxItem: {
        id: "inbox-1",
        userId: "123",
        sourceEventId: "event-1",
        rawText: "journal is done",
        normalizedText: "journal is done",
        processingStatus: "planned",
        linkedTaskIds: ["task-1"],
      },
      plannerRun: {
        id: "run-1",
        userId: "123",
        inboxItemId: "inbox-1",
        version: "test",
        modelInput: {},
        modelOutput: {},
        confidence: 0.9,
      },
      completedTasks: [
        {
          id: "task-1",
          userId: "123",
          sourceInboxItemId: "inbox-1",
          lastInboxItemId: "inbox-1",
          title: "Journaling session",
          lifecycleState: "done",
          externalCalendarEventId: null,
          externalCalendarId: null,
          scheduledStartAt: null,
          scheduledEndAt: null,
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt: "2026-03-18T12:00:00.000Z",
          rescheduleCount: 0,
          lastFollowupAt: null,
          followupReminderSentAt: null,
          completedAt: "2026-03-18T12:00:00.000Z",
          archivedAt: null,
          priority: "medium",
          urgency: "medium",
        },
      ],
      followUpMessage: "",
    });

    expect(reply).toBe("Marked 'Journaling session' as done.");
  });

  it("uses the stored follow-up message for clarification replies", () => {
    const reply = renderMutationReply({
      outcome: "needs_clarification",
      inboxItem: {
        id: "inbox-1",
        userId: "123",
        sourceEventId: "event-1",
        rawText: "do it",
        normalizedText: "do it",
        processingStatus: "needs_clarification",
        linkedTaskIds: [],
      },
      plannerRun: {
        id: "run-1",
        userId: "123",
        inboxItemId: "inbox-1",
        version: "test",
        modelInput: {},
        modelOutput: {},
        confidence: 0.9,
      },
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
      outcome: "archived_tasks",
      inboxItem: {
        id: "inbox-1",
        userId: "123",
        sourceEventId: "event-1",
        rawText: "archive it",
        normalizedText: "archive it",
        processingStatus: "planned",
        linkedTaskIds: ["task-1"],
      },
      plannerRun: {
        id: "run-1",
        userId: "123",
        inboxItemId: "inbox-1",
        version: "test",
        modelInput: {},
        modelOutput: {},
        confidence: 1,
      },
      archivedTasks: [
        {
          id: "task-1",
          userId: "123",
          sourceInboxItemId: "inbox-1",
          lastInboxItemId: "inbox-1",
          title: "Journaling session",
          lifecycleState: "archived",
          externalCalendarEventId: null,
          externalCalendarId: null,
          scheduledStartAt: null,
          scheduledEndAt: null,
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt: "2026-03-18T12:00:00.000Z",
          rescheduleCount: 0,
          lastFollowupAt: null,
          followupReminderSentAt: null,
          completedAt: null,
          archivedAt: "2026-03-18T12:00:00.000Z",
          priority: "medium",
          urgency: "medium",
        },
      ],
      followUpMessage: "",
    });

    expect(reply).toBe("Archived 'Journaling session'.");
  });
});
