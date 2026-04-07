import { describe, expect, it, vi } from "vitest";
import type { MutationResult } from "@atlas/core";
import {
  buildScheduleConstraintFromFields,
  executePendingWrite,
} from "./execute-pending-write";

function makeInput(
  overrides: Partial<Parameters<typeof executePendingWrite>[0]> = {},
) {
  return {
    pendingWriteOperation: {
      operationKind: "plan" as const,
      targetRef: {
        entityId: undefined,
        description: "Go to gym",
        entityKind: undefined,
      },
      resolvedFields: {
        scheduleFields: {
          day: "2026-04-06",
          time: { kind: "absolute" as const, hour: 17, minute: 0 },
          duration: 60,
        },
        taskFields: { priority: "medium" as const },
      },
      missingFields: [],
      originatingText: "schedule gym tomorrow at 5pm",
      startedAt: "2026-04-05T10:00:00.000Z",
    },
    inboxItemId: "test-inbox-item",
    userId: "user-1",
    tasks: [] as any[],
    scheduleBlocks: [] as any[],
    userProfile: {
      timezone: "America/Los_Angeles",
      userId: "user-1",
      workdayStartHour: 9,
      workdayEndHour: 17,
      deepWorkWindows: [],
      blackoutWindows: [],
      focusBlockMinutes: 60,
      reminderStyle: "direct" as const,
      breakdownLevel: 1,
    },
    calendar: null as any,
    googleCalendarConnection: null as any,
    store: {
      saveTaskCaptureResult: vi.fn().mockResolvedValue({
        outcome: "created",
        tasks: [] as any[],
        scheduleBlocks: [],
        followUpMessage: "Saved.",
      } satisfies MutationResult),
      saveScheduleRequestResult: vi.fn(),
      saveTaskCompletionResult: vi.fn(),
      saveScheduleAdjustmentResult: vi.fn(),
      saveTaskArchiveResult: vi.fn(),
      saveNeedsClarificationResult: vi.fn(),
    },
    ...overrides,
  };
}

describe("executePendingWrite", () => {
  describe("plan — new task", () => {
    it("creates a task and returns created outcome", async () => {
      const input = makeInput();
      const result = await executePendingWrite(input);

      expect(result.outcome).toBe("created");
      expect(input.store.saveTaskCaptureResult).toHaveBeenCalledOnce();
    });
  });

  describe("plan — schedule existing task", () => {
    it("schedules an existing task and returns scheduled outcome", async () => {
      const existingTask = {
        id: "task-123",
        title: "Go to gym",
        userId: "user-1",
        lifecycleState: "pending_schedule",
        scheduledStartAt: null,
        scheduledEndAt: null,
        externalCalendarId: null,
        externalCalendarEventId: null,
        sourceInboxItemId: "inbox-1",
        lastInboxItemId: "inbox-1",
        calendarSyncStatus: "in_sync",
        calendarSyncUpdatedAt: null,
        rescheduleCount: 0,
        lastFollowupAt: null,
        followupReminderSentAt: null,
        completedAt: null,
        archivedAt: null,
        priority: "medium",
        urgency: "medium",
      } as any;

      const mockCalendar = {
        provider: "google-calendar" as const,
        createEvent: vi.fn().mockResolvedValue({
          externalCalendarEventId: "gcal-1",
          externalCalendarId: "cal-1",
          scheduledStartAt: "2026-04-06T17:00:00.000Z",
          scheduledEndAt: "2026-04-06T18:00:00.000Z",
        }),
        updateEvent: vi.fn(),
        getEvent: vi.fn().mockResolvedValue(null),
        listBusyPeriods: vi.fn().mockResolvedValue([]),
      };

      const input = makeInput({
        pendingWriteOperation: {
          operationKind: "plan",
          targetRef: {
            entityId: "task-123",
            description: "Go to gym",
            entityKind: undefined,
          },
          resolvedFields: {
            scheduleFields: {
              day: "2026-04-06",
              time: { kind: "absolute" as const, hour: 17, minute: 0 },
              duration: 60,
            },
          },
          missingFields: [],
          originatingText: "schedule gym tomorrow",
          startedAt: "2026-04-05T10:00:00.000Z",
        },
        tasks: [existingTask],
        calendar: mockCalendar,
        googleCalendarConnection: { selectedCalendarId: "cal-1" } as any,
        store: {
          ...makeInput().store,
          saveScheduleRequestResult: vi.fn().mockResolvedValue({
            outcome: "scheduled",
            tasks: [existingTask],
            scheduleBlocks: [],
            followUpMessage: "Scheduled.",
          } satisfies MutationResult),
        },
      });

      const result = await executePendingWrite(input);
      expect(result.outcome).toBe("scheduled");
      expect(input.store.saveScheduleRequestResult).toHaveBeenCalledOnce();
    });
  });

  describe("reschedule", () => {
    it("reschedules an existing block and returns rescheduled outcome", async () => {
      const existingTask = {
        id: "task-123",
        title: "Go to gym",
        userId: "user-1",
        lifecycleState: "scheduled",
        scheduledStartAt: "2026-04-06T09:00:00.000Z",
        scheduledEndAt: "2026-04-06T10:00:00.000Z",
        externalCalendarId: null,
        externalCalendarEventId: null,
        sourceInboxItemId: "inbox-1",
        lastInboxItemId: "inbox-1",
        calendarSyncStatus: "in_sync",
        calendarSyncUpdatedAt: null,
        rescheduleCount: 0,
        lastFollowupAt: null,
        followupReminderSentAt: null,
        completedAt: null,
        archivedAt: null,
        priority: "medium",
        urgency: "medium",
      } as any;

      const existingBlock = {
        id: "block-1",
        userId: "user-1",
        taskId: "task-123",
        startAt: "2026-04-06T09:00:00.000Z",
        endAt: "2026-04-06T10:00:00.000Z",
        confidence: 0.9,
        reason: "Scheduled",
        rescheduleCount: 0,
        externalCalendarId: null,
      } as any;

      const mockCalendar = {
        provider: "google-calendar" as const,
        createEvent: vi.fn(),
        updateEvent: vi.fn(),
        getEvent: vi.fn().mockResolvedValue(null),
        listBusyPeriods: vi.fn().mockResolvedValue([]),
      };

      const input = makeInput({
        pendingWriteOperation: {
          operationKind: "reschedule",
          targetRef: {
            entityId: "task-123",
            description: "Go to gym",
            entityKind: undefined,
          },
          resolvedFields: {
            scheduleFields: {
              time: { kind: "absolute" as const, hour: 14, minute: 0 },
            },
          },
          missingFields: [],
          originatingText: "move gym to 2pm",
          startedAt: "2026-04-05T10:00:00.000Z",
        },
        tasks: [existingTask],
        scheduleBlocks: [existingBlock],
        calendar: mockCalendar,
        googleCalendarConnection: { selectedCalendarId: "cal-1" } as any,
        store: {
          ...makeInput().store,
          saveScheduleAdjustmentResult: vi.fn().mockResolvedValue({
            outcome: "rescheduled",
            updatedBlock: {
              id: "block-1",
              userId: "user-1",
              taskId: "task-123",
              startAt: "2026-04-06T14:00:00.000Z",
              endAt: "2026-04-06T15:00:00.000Z",
              confidence: 0.9,
              reason: "Rescheduled",
              rescheduleCount: 1,
              externalCalendarId: null,
            },
            followUpMessage: "Rescheduled.",
          } satisfies MutationResult),
        },
      });

      const result = await executePendingWrite(input);
      expect(result.outcome).toBe("rescheduled");
      expect(input.store.saveScheduleAdjustmentResult).toHaveBeenCalledOnce();
    });
  });

  describe("complete", () => {
    it("completes a task and returns completed outcome", async () => {
      const existingTask = {
        id: "task-123",
        title: "Go to gym",
        userId: "user-1",
        lifecycleState: "pending_schedule",
        scheduledStartAt: null,
        scheduledEndAt: null,
        externalCalendarId: null,
        externalCalendarEventId: null,
        sourceInboxItemId: "inbox-1",
        lastInboxItemId: "inbox-1",
        calendarSyncStatus: "in_sync",
        calendarSyncUpdatedAt: null,
        rescheduleCount: 0,
        lastFollowupAt: null,
        followupReminderSentAt: null,
        completedAt: null,
        archivedAt: null,
        priority: "medium",
        urgency: "medium",
      } as any;

      const input = makeInput({
        pendingWriteOperation: {
          operationKind: "complete",
          targetRef: {
            entityId: "task-123",
            description: "Go to gym",
            entityKind: undefined,
          },
          resolvedFields: {},
          missingFields: [],
          originatingText: "mark gym as done",
          startedAt: "2026-04-05T10:00:00.000Z",
        },
        tasks: [existingTask],
        store: {
          ...makeInput().store,
          saveTaskCompletionResult: vi.fn().mockResolvedValue({
            outcome: "completed",
            tasks: [{ ...existingTask, lifecycleState: "done" }],
            followUpMessage: "Done.",
          } satisfies MutationResult),
        },
      });

      const result = await executePendingWrite(input);
      expect(result.outcome).toBe("completed");
      expect(input.store.saveTaskCompletionResult).toHaveBeenCalledOnce();
    });
  });

  describe("archive", () => {
    it("archives a task and returns archived outcome", async () => {
      const existingTask = {
        id: "task-123",
        title: "Go to gym",
        userId: "user-1",
        lifecycleState: "pending_schedule",
        scheduledStartAt: null,
        scheduledEndAt: null,
        externalCalendarId: null,
        externalCalendarEventId: null,
        sourceInboxItemId: "inbox-1",
        lastInboxItemId: "inbox-1",
        calendarSyncStatus: "in_sync",
        calendarSyncUpdatedAt: null,
        rescheduleCount: 0,
        lastFollowupAt: null,
        followupReminderSentAt: null,
        completedAt: null,
        archivedAt: null,
        priority: "medium",
        urgency: "medium",
      } as any;

      const input = makeInput({
        pendingWriteOperation: {
          operationKind: "archive",
          targetRef: {
            entityId: "task-123",
            description: "Go to gym",
            entityKind: undefined,
          },
          resolvedFields: {},
          missingFields: [],
          originatingText: "archive gym",
          startedAt: "2026-04-05T10:00:00.000Z",
        },
        tasks: [existingTask],
        store: {
          ...makeInput().store,
          saveTaskArchiveResult: vi.fn().mockResolvedValue({
            outcome: "archived",
            tasks: [{ ...existingTask, lifecycleState: "archived" }],
            followUpMessage: "Archived.",
          } satisfies MutationResult),
        },
      });

      const result = await executePendingWrite(input);
      expect(result.outcome).toBe("archived");
      expect(input.store.saveTaskArchiveResult).toHaveBeenCalledOnce();
    });
  });

  describe("edit (deferred)", () => {
    it("returns needs_clarification for edit operations", async () => {
      const input = makeInput({
        pendingWriteOperation: {
          operationKind: "edit",
          targetRef: {
            entityId: "task-123",
            description: "Go to gym",
            entityKind: undefined,
          },
          resolvedFields: {},
          missingFields: [],
          originatingText: "edit gym",
          startedAt: "2026-04-05T10:00:00.000Z",
        },
      });

      const result = await executePendingWrite(input);
      expect(result.outcome).toBe("needs_clarification");
    });
  });

  describe("schedule constraint mapping", () => {
    it("returns null when no scheduleFields", () => {
      expect(buildScheduleConstraintFromFields(undefined, "test")).toBeNull();
    });

    it("returns null when no time and no day", () => {
      expect(buildScheduleConstraintFromFields({}, "test")).toBeNull();
    });

    it("maps absolute time to explicitHour/minute", () => {
      const result = buildScheduleConstraintFromFields(
        { time: { kind: "absolute", hour: 14, minute: 30 } },
        "at 2:30pm",
      );
      expect(result).toMatchObject({
        explicitHour: 14,
        minute: 30,
        relativeMinutes: null,
        preferredWindow: null,
        sourceText: "at 2:30pm",
      });
    });

    it("maps relative time to relativeMinutes only", () => {
      const result = buildScheduleConstraintFromFields(
        { time: { kind: "relative", minutes: 30 } },
        "in 30 minutes",
      );
      expect(result).toMatchObject({
        relativeMinutes: 30,
        explicitHour: null,
        minute: null,
        dayReference: null,
        weekday: null,
        weekOffset: null,
        preferredWindow: null,
        sourceText: "in 30 minutes",
      });
    });

    it("maps window time to preferredWindow", () => {
      const result = buildScheduleConstraintFromFields(
        { time: { kind: "window", window: "morning" } },
        "in the morning",
      );
      expect(result).toMatchObject({
        preferredWindow: "morning",
        explicitHour: null,
        relativeMinutes: null,
        sourceText: "in the morning",
      });
    });

    it("returns constraint when day present but no time", () => {
      const result = buildScheduleConstraintFromFields(
        { day: "2026-04-06" },
        "tomorrow",
      );
      expect(result).not.toBeNull();
      expect(result!.dayReference).toBeNull(); // known gap: day not mapped yet
    });
  });

  describe("clarification fallbacks", () => {
    it("returns needs_clarification when target task not found", async () => {
      const input = makeInput({
        pendingWriteOperation: {
          operationKind: "complete",
          targetRef: {
            entityId: "nonexistent",
            description: "???",
            entityKind: undefined,
          },
          resolvedFields: {},
          missingFields: [],
          originatingText: "done",
          startedAt: "2026-04-05T10:00:00.000Z",
        },
        tasks: [],
      });

      const result = await executePendingWrite(input);
      expect(result.outcome).toBe("needs_clarification");
    });

    it("returns needs_clarification for ambiguous task title", async () => {
      const tasks = [
        {
          id: "t1",
          title: "Gym",
          userId: "user-1",
          lifecycleState: "pending_schedule",
          scheduledStartAt: null,
          scheduledEndAt: null,
          externalCalendarId: null,
          externalCalendarEventId: null,
          sourceInboxItemId: "inbox-1",
          lastInboxItemId: "inbox-1",
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt: null,
          rescheduleCount: 0,
          lastFollowupAt: null,
          followupReminderSentAt: null,
          completedAt: null,
          archivedAt: null,
          priority: "medium",
          urgency: "medium",
        },
        {
          id: "t2",
          title: "Gym",
          userId: "user-1",
          lifecycleState: "pending_schedule",
          scheduledStartAt: null,
          scheduledEndAt: null,
          externalCalendarId: null,
          externalCalendarEventId: null,
          sourceInboxItemId: "inbox-2",
          lastInboxItemId: "inbox-2",
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt: null,
          rescheduleCount: 0,
          lastFollowupAt: null,
          followupReminderSentAt: null,
          completedAt: null,
          archivedAt: null,
          priority: "medium",
          urgency: "medium",
        },
      ] as any[];

      const input = makeInput({
        pendingWriteOperation: {
          operationKind: "complete",
          targetRef: {
            entityId: "t1",
            description: "Gym",
            entityKind: undefined,
          },
          resolvedFields: {},
          missingFields: [],
          originatingText: "done with gym",
          startedAt: "2026-04-05T10:00:00.000Z",
        },
        tasks,
      });

      const result = await executePendingWrite(input);
      expect(result.outcome).toBe("needs_clarification");
      expect(result.followUpMessage).toContain("multiple tasks");
    });

    it("returns needs_clarification when no calendar for scheduling existing task", async () => {
      const existingTask = {
        id: "task-123",
        title: "Gym",
        userId: "user-1",
        lifecycleState: "pending_schedule",
        scheduledStartAt: null,
        scheduledEndAt: null,
        externalCalendarId: null,
        externalCalendarEventId: null,
        sourceInboxItemId: "inbox-1",
        lastInboxItemId: "inbox-1",
        calendarSyncStatus: "in_sync",
        calendarSyncUpdatedAt: null,
        rescheduleCount: 0,
        lastFollowupAt: null,
        followupReminderSentAt: null,
        completedAt: null,
        archivedAt: null,
        priority: "medium",
        urgency: "medium",
      } as any;

      const input = makeInput({
        pendingWriteOperation: {
          operationKind: "plan",
          targetRef: {
            entityId: "task-123",
            description: "Gym",
            entityKind: undefined,
          },
          resolvedFields: { scheduleFields: { day: "2026-04-06" } },
          missingFields: [],
          originatingText: "schedule gym",
          startedAt: "2026-04-05T10:00:00.000Z",
        },
        tasks: [existingTask],
        calendar: null,
      });

      const result = await executePendingWrite(input);
      expect(result.outcome).toBe("needs_clarification");
      expect(result.followUpMessage.toLowerCase()).toContain("calendar");
    });

    it("returns needs_clarification when reschedule target has no block", async () => {
      const existingTask = {
        id: "task-123",
        title: "Gym",
        userId: "user-1",
        lifecycleState: "pending_schedule",
      } as any;

      const input = makeInput({
        pendingWriteOperation: {
          operationKind: "reschedule",
          targetRef: {
            entityId: "task-123",
            description: "Gym",
            entityKind: undefined,
          },
          resolvedFields: {},
          missingFields: [],
          originatingText: "reschedule gym",
          startedAt: "2026-04-05T10:00:00.000Z",
        },
        tasks: [existingTask],
        scheduleBlocks: [],
      });

      const result = await executePendingWrite(input);
      expect(result.outcome).toBe("needs_clarification");
    });
  });
});
