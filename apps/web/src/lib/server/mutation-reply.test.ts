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
        linkedTaskIds: ["task-1", "task-2"]
      },
      plannerRun: {
        id: "run-1",
        userId: "123",
        inboxItemId: "inbox-1",
        version: "test",
        modelInput: {},
        modelOutput: {},
        confidence: 0.9
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
          completedAt: null,
          archivedAt: null,
          priority: "medium",
          urgency: "medium"
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
          completedAt: null,
          archivedAt: null,
          priority: "medium",
          urgency: "medium"
        }
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
          externalCalendarId: "primary"
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
          externalCalendarId: "primary"
        }
      ],
      followUpMessage: ""
    });

    expect(reply).toContain("Scheduled:");
    expect(reply).toContain("'Review launch checklist'");
    expect(reply).toContain("'Send client update'");
  });
});
