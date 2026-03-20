import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxPlanningOutput } from "@atlas/core";
import {
  getDefaultGoogleCalendarConnectionStore,
  getDefaultInboxProcessingStore,
  listPlannerRunsForTests,
  listScheduleBlocksForTests,
  listTasksForTests,
  resetGoogleCalendarConnectionStoreForTests,
  resetInboxProcessingStoreForTests,
  seedInboxItemForProcessingTests
} from "@atlas/db";
import { getDefaultCalendarAdapter, resetCalendarAdapterForTests } from "@atlas/integrations";

import { processInboxItem } from "./process-inbox-item";

describe("process inbox item service", () => {
  beforeEach(() => {
    resetInboxProcessingStoreForTests();
    resetGoogleCalendarConnectionStoreForTests();
    resetCalendarAdapterForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a task and calendar-backed current commitment from model-driven capture", async () => {
    seedInboxItemForProcessingTests({
      id: "inbox-1",
      userId: "123",
      sourceEventId: "event-1",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: [],
      createdAt: "2026-03-18T16:00:00.000Z"
    });

    const result = await processInboxItem(
      {
        inboxItemId: "inbox-1"
      },
      {
        calendar: getDefaultCalendarAdapter(),
        planner: async () => ({
          confidence: 0.9,
          summary: "Captured and scheduled Review launch checklist.",
          actions: [
            {
              type: "create_task",
              alias: "new_task_1",
              title: "Review launch checklist",
              priority: "medium",
              urgency: "medium"
            },
            {
              type: "create_schedule_block",
              taskRef: {
                kind: "created_task",
                alias: "new_task_1"
              },
              scheduleConstraint: {
                dayReference: null,
                weekday: null,
                weekOffset: null,
                explicitHour: 9,
                minute: 0,
                preferredWindow: null,
                sourceText: "default next slot"
              },
              reason: "Schedule the new task in the next slot."
            }
          ]
        })
      }
    );

    expect(result.outcome).toBe("planned");
    expect(listPlannerRunsForTests()).toHaveLength(1);
    expect(listPlannerRunsForTests()[0]?.modelInput).toMatchObject({
      now: "2026-03-18T16:00:00.000Z"
    });
    expect(listScheduleBlocksForTests()).toHaveLength(1);
    expect(listTasksForTests()[0]).toMatchObject({
      sourceInboxItemId: "inbox-1",
      lastInboxItemId: "inbox-1",
      lifecycleState: "scheduled",
      externalCalendarEventId: expect.any(String),
      externalCalendarId: "primary",
      rescheduleCount: 0
    });
    expect(result.followUpMessage).toContain("Scheduled 'Review launch checklist'");
  });

  it("asks for Google Calendar linking instead of scheduling against the in-memory fallback", async () => {
    resetGoogleCalendarConnectionStoreForTests();
    seedInboxItemForProcessingTests({
      id: "inbox-unlinked",
      userId: "123",
      sourceEventId: "event-unlinked",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: []
    });

    const result = await processInboxItem(
      {
        inboxItemId: "inbox-unlinked"
      },
      {
        calendar: null,
        planner: async () => ({
          confidence: 0.9,
          summary: "Captured and scheduled Review launch checklist.",
          actions: [
            {
              type: "create_task",
              alias: "new_task_1",
              title: "Review launch checklist",
              priority: "medium",
              urgency: "medium"
            },
            {
              type: "create_schedule_block",
              taskRef: {
                kind: "created_task",
                alias: "new_task_1"
              },
              scheduleConstraint: {
                dayReference: null,
                weekday: null,
                weekOffset: null,
                explicitHour: 9,
                minute: 0,
                preferredWindow: null,
                sourceText: "default next slot"
              },
              reason: "Schedule the new task in the next slot."
            }
          ]
        })
      }
    );

    expect(result.outcome).toBe("needs_clarification");
    expect(listTasksForTests()).toHaveLength(0);
    expect(result.followUpMessage).toContain("connect Google Calendar");
  });

  it("logs calendar write attempts and success for scheduled task creation", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    seedInboxItemForProcessingTests({
      id: "inbox-log-create",
      userId: "123",
      sourceEventId: "event-log-create",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: []
    });

    await processInboxItem(
      {
        inboxItemId: "inbox-log-create"
      },
      {
        calendar: getDefaultCalendarAdapter(),
        planner: async () => ({
          confidence: 0.9,
          summary: "Captured and scheduled Review launch checklist.",
          actions: [
            {
              type: "create_task",
              alias: "new_task_1",
              title: "Review launch checklist",
              priority: "medium",
              urgency: "medium"
            },
            {
              type: "create_schedule_block",
              taskRef: {
                kind: "created_task",
                alias: "new_task_1"
              },
              scheduleConstraint: {
                dayReference: null,
                weekday: null,
                weekOffset: null,
                explicitHour: 9,
                minute: 0,
                preferredWindow: null,
                sourceText: "default next slot"
              },
              reason: "Schedule the new task in the next slot."
            }
          ]
        })
      }
    );

    expect(infoSpy).toHaveBeenCalledWith(
      "calendar_write_attempt",
      expect.objectContaining({
        operation: "create",
        userId: "123"
      })
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "calendar_write_succeeded",
      expect.objectContaining({
        operation: "create",
        userId: "123",
        externalCalendarId: "primary"
      })
    );
  });

  it("uses model-provided timing constraints for combined task and schedule requests", async () => {
    seedInboxItemForProcessingTests({
      id: "inbox-2",
      userId: "123",
      sourceEventId: "event-2",
      rawText: "Submit taxes tomorrow at 3pm",
      normalizedText: "Submit taxes tomorrow at 3pm",
      processingStatus: "received",
      linkedTaskIds: []
    });

    const result = await processInboxItem(
      {
        inboxItemId: "inbox-2"
      },
      {
        calendar: getDefaultCalendarAdapter(),
        planner: async () => ({
          confidence: 0.91,
          summary: "Scheduled Submit taxes for tomorrow at 3pm.",
          actions: [
            {
              type: "create_task",
              alias: "new_task_1",
              title: "Submit taxes",
              priority: "medium",
              urgency: "high"
            },
            {
              type: "create_schedule_block",
              taskRef: {
                kind: "created_task",
                alias: "new_task_1"
              },
              scheduleConstraint: {
                dayReference: "tomorrow",
                weekday: null,
                weekOffset: null,
                explicitHour: 15,
                minute: 0,
                preferredWindow: null,
                sourceText: "tomorrow at 3pm"
              },
              reason: "The user requested tomorrow at 3pm."
            }
          ]
        })
      }
    );

    expect(result.outcome).toBe("planned");
    expect("scheduleBlocks" in result ? result.scheduleBlocks[0]?.startAt : "").toContain("T22:00:00.000Z");
  });

  it("allows an app-owned planning text override for confirmed mutation recovery", async () => {
    const planner = vi.fn(async (): Promise<InboxPlanningOutput> => ({
      confidence: 0.9,
      summary: "Scheduled the dentist reminder for 3pm.",
      actions: [
        {
          type: "create_task",
          alias: "new_task_1",
          title: "Dentist reminder",
          priority: "medium",
          urgency: "medium"
        },
        {
          type: "create_schedule_block",
          taskRef: {
            kind: "created_task",
            alias: "new_task_1"
          },
          scheduleConstraint: {
            dayReference: null,
            weekday: null,
            weekOffset: null,
            explicitHour: 15,
            minute: 0,
            preferredWindow: null,
            sourceText: "at 3pm"
          },
          reason: "The user confirmed the 3pm proposal."
        }
      ]
    }));

    seedInboxItemForProcessingTests({
      id: "inbox-confirm",
      userId: "123",
      sourceEventId: "event-confirm",
      rawText: "Yes",
      normalizedText: "Yes",
      processingStatus: "received",
      linkedTaskIds: []
    });

    const result = await processInboxItem(
      {
        inboxItemId: "inbox-confirm",
        planningInboxTextOverride: {
          text: "Schedule the dentist reminder at 3pm."
        }
      },
      {
        calendar: getDefaultCalendarAdapter(),
        planner
      }
    );

    expect(result.outcome).toBe("planned");
    expect(planner).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxItem: expect.objectContaining({
          rawText: "Schedule the dentist reminder at 3pm.",
          normalizedText: "Schedule the dentist reminder at 3pm."
        })
      })
    );
  });

  it("keeps confirmed mutation time refinements on the already scheduled day", async () => {
    const store = getDefaultInboxProcessingStore();

    seedInboxItemForProcessingTests({
      id: "inbox-plane-tickets",
      userId: "123",
      sourceEventId: "event-plane-tickets",
      rawText: "Buying plane tickets tomorrow morning",
      normalizedText: "Buying plane tickets tomorrow morning",
      processingStatus: "received",
      linkedTaskIds: [],
      createdAt: "2026-03-20T16:00:00.000Z"
    });

    await processInboxItem(
      { inboxItemId: "inbox-plane-tickets" },
      {
        store,
        calendar: getDefaultCalendarAdapter(),
        planner: async () => ({
          confidence: 0.9,
          summary: "Scheduled Buying plane tickets for tomorrow morning.",
          actions: [
            {
              type: "create_task",
              alias: "new_task_1",
              title: "Buying plane tickets",
              priority: "medium",
              urgency: "medium"
            },
            {
              type: "create_schedule_block",
              taskRef: {
                kind: "created_task",
                alias: "new_task_1"
              },
              scheduleConstraint: {
                dayReference: "tomorrow",
                weekday: null,
                weekOffset: null,
                explicitHour: 9,
                minute: 0,
                preferredWindow: "morning",
                sourceText: "tomorrow morning"
              },
              reason: "The user asked for tomorrow morning."
            }
          ]
        })
      }
    );

    seedInboxItemForProcessingTests({
      id: "inbox-plane-tickets-refine",
      userId: "123",
      sourceEventId: "event-plane-tickets-refine",
      rawText: "I mean 10am",
      normalizedText: "I mean 10am",
      processingStatus: "received",
      linkedTaskIds: [],
      createdAt: "2026-03-20T16:05:00.000Z"
    });

    const result = await processInboxItem(
      {
        inboxItemId: "inbox-plane-tickets-refine",
        planningInboxTextOverride: {
          text: "Move the scheduled Buying plane tickets block to 10am."
        }
      },
      {
        store,
        calendar: getDefaultCalendarAdapter(),
        planner: async () => ({
          confidence: 0.86,
          summary: "Moved Buying plane tickets to 10am.",
          actions: [
            {
              type: "move_schedule_block",
              blockRef: {
                alias: "schedule_block_1"
              },
              scheduleConstraint: {
                dayReference: null,
                weekday: null,
                weekOffset: null,
                explicitHour: 10,
                minute: 0,
                preferredWindow: null,
                sourceText: "10am"
              },
              reason: "The user clarified the time."
            }
          ]
        })
      }
    );

    expect(result.outcome).toBe("updated_schedule");
    expect("updatedBlock" in result ? result.updatedBlock.startAt : "").toBe("2026-03-21T17:00:00.000Z");
  });

  it("marks an existing task as done through the mutation path", async () => {
    const store = getDefaultInboxProcessingStore();

    seedInboxItemForProcessingTests({
      id: "inbox-journal-task",
      userId: "123",
      sourceEventId: "event-journal-task",
      rawText: "Journaling session",
      normalizedText: "Journaling session",
      processingStatus: "received",
      linkedTaskIds: []
    });
    await processInboxItem(
      { inboxItemId: "inbox-journal-task" },
      {
        store,
        calendar: getDefaultCalendarAdapter(),
        planner: async () => ({
          confidence: 0.9,
          summary: "Scheduled Journaling session.",
          actions: [
            {
              type: "create_task",
              alias: "new_task_1",
              title: "Journaling session",
              priority: "medium",
              urgency: "medium"
            },
            {
              type: "create_schedule_block",
              taskRef: {
                kind: "created_task",
                alias: "new_task_1"
              },
              scheduleConstraint: {
                dayReference: null,
                weekday: null,
                weekOffset: null,
                explicitHour: 9,
                minute: 0,
                preferredWindow: null,
                sourceText: "default next slot"
              },
              reason: "Schedule the new task in the next slot."
            }
          ]
        })
      }
    );

    seedInboxItemForProcessingTests({
      id: "inbox-journal-done",
      userId: "123",
      sourceEventId: "event-journal-done",
      rawText: "journal is done",
      normalizedText: "journal is done",
      processingStatus: "received",
      linkedTaskIds: []
    });

    const result = await processInboxItem(
      {
        inboxItemId: "inbox-journal-done",
        planningInboxTextOverride: {
          text: "Mark the journaling session as done."
        }
      },
      {
        store,
        calendar: getDefaultCalendarAdapter(),
        planner: async () => ({
          confidence: 0.91,
          summary: "Marked the journaling session as done.",
          actions: [
            {
              type: "complete_task",
              taskRef: {
                kind: "existing_task",
                alias: "existing_task_1"
              },
              reason: "The user said the journaling session is done."
            }
          ]
        })
      }
    );

    expect(result.outcome).toBe("completed_tasks");
    expect(listTasksForTests()[0]).toMatchObject({
      lastInboxItemId: "inbox-journal-done",
      lifecycleState: "done",
      externalCalendarEventId: null,
      externalCalendarId: null
    });
    expect(listTasksForTests()[0]?.completedAt).toBeTruthy();
    expect(result.followUpMessage).toBe("Marked 'Journaling session' as done.");
  });

  it("moves an existing scheduled task by updating the same calendar event", async () => {
    const store = getDefaultInboxProcessingStore();

    seedInboxItemForProcessingTests({
      id: "inbox-task",
      userId: "123",
      sourceEventId: "event-task",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: [],
      createdAt: "2026-03-19T16:00:00.000Z"
    });
    await processInboxItem(
      { inboxItemId: "inbox-task" },
      {
        store,
        calendar: getDefaultCalendarAdapter(),
        planner: async () => ({
          confidence: 0.9,
          summary: "Scheduled Review launch checklist.",
          actions: [
            {
              type: "create_task",
              alias: "new_task_1",
              title: "Review launch checklist",
              priority: "medium",
              urgency: "medium"
            },
            {
              type: "create_schedule_block",
              taskRef: {
                kind: "created_task",
                alias: "new_task_1"
              },
              scheduleConstraint: {
                dayReference: null,
                weekday: null,
                weekOffset: null,
                explicitHour: 9,
                minute: 0,
                preferredWindow: null,
                sourceText: "default next slot"
              },
              reason: "Schedule the new task in the next slot."
            }
          ]
        })
      }
    );

    seedInboxItemForProcessingTests({
      id: "inbox-move",
      userId: "123",
      sourceEventId: "event-move",
      rawText: "move it to 3pm",
      normalizedText: "move it to 3pm",
      processingStatus: "received",
      linkedTaskIds: [],
      createdAt: "2026-03-19T17:00:00.000Z"
    });

    const result = await processInboxItem(
      { inboxItemId: "inbox-move" },
      {
        store,
        calendar: getDefaultCalendarAdapter(),
        planner: async () => ({
          confidence: 0.83,
          summary: "Moved the scheduled review block to 3pm.",
          actions: [
            {
              type: "move_schedule_block",
              blockRef: {
                alias: "schedule_block_1"
              },
              scheduleConstraint: {
                dayReference: null,
                weekday: null,
                weekOffset: null,
                explicitHour: 15,
                minute: 0,
                preferredWindow: null,
                sourceText: "at 3pm"
              },
              reason: "The user asked to move it to 3pm."
            }
          ]
        })
      }
    );

    expect(result.outcome).toBe("updated_schedule");
    expect("updatedBlock" in result ? result.updatedBlock.startAt : "").toBe("2026-03-20T22:00:00.000Z");
    expect("updatedBlock" in result ? result.updatedBlock.id : "").toBe(listTasksForTests()[0]?.externalCalendarEventId);
    expect(listTasksForTests()[0]).toMatchObject({
      lastInboxItemId: "inbox-move",
      lifecycleState: "scheduled",
      rescheduleCount: 1
    });
    expect(result.followUpMessage).toContain("Moved it to");
  });

  it("keeps move scheduling out of Google-busy slots", async () => {
    const store = getDefaultInboxProcessingStore();
    await getDefaultGoogleCalendarConnectionStore().upsertConnection({
      userId: "123",
      providerAccountId: "google-user-1",
      email: "max@example.com",
      selectedCalendarId: "primary",
      selectedCalendarName: "Primary",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenExpiresAt: "2026-03-20T17:00:00.000Z",
      scopes: ["calendar"],
      syncCursor: null,
      lastSyncedAt: null,
      revokedAt: null
    });

    seedInboxItemForProcessingTests({
      id: "inbox-task-busy",
      userId: "123",
      sourceEventId: "event-task-busy",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: [],
      createdAt: "2026-03-19T16:00:00.000Z"
    });

    await processInboxItem(
      { inboxItemId: "inbox-task-busy" },
      {
        store,
        calendar: {
          provider: "google-calendar",
          createEvent: async (input) => ({
            externalCalendarEventId: "event-1",
            externalCalendarId: input.externalCalendarId ?? "primary",
            scheduledStartAt: input.startAt,
            scheduledEndAt: input.endAt
          }),
          updateEvent: async (input) => ({
            externalCalendarEventId: input.externalCalendarEventId,
            externalCalendarId: input.externalCalendarId ?? "primary",
            scheduledStartAt: input.startAt,
            scheduledEndAt: input.endAt
          }),
          getEvent: async () => ({
            externalCalendarEventId: "event-1",
            externalCalendarId: "primary",
            scheduledStartAt: "2026-03-19T17:00:00.000Z",
            scheduledEndAt: "2026-03-19T18:00:00.000Z"
          }),
          listBusyPeriods: async () => [
            {
              startAt: "2026-03-18T15:00:00.000Z",
              endAt: "2026-03-18T16:00:00.000Z",
              externalCalendarId: "primary"
            }
          ]
        },
        planner: async () => ({
          confidence: 0.9,
          summary: "Scheduled Review launch checklist.",
          actions: [
            {
              type: "create_task",
              alias: "new_task_1",
              title: "Review launch checklist",
              priority: "medium",
              urgency: "medium"
            },
            {
              type: "create_schedule_block",
              taskRef: {
                kind: "created_task",
                alias: "new_task_1"
              },
              scheduleConstraint: {
                dayReference: null,
                weekday: null,
                weekOffset: null,
                explicitHour: 17,
                minute: 0,
                preferredWindow: null,
                sourceText: "5pm"
              },
              reason: "Schedule the new task."
            }
          ]
        })
      }
    );

    seedInboxItemForProcessingTests({
      id: "inbox-move-busy",
      userId: "123",
      sourceEventId: "event-move-busy",
      rawText: "move it to 3pm",
      normalizedText: "move it to 3pm",
      processingStatus: "received",
      linkedTaskIds: [],
      createdAt: "2026-03-19T17:00:00.000Z"
    });

    const result = await processInboxItem(
      { inboxItemId: "inbox-move-busy" },
      {
        store,
        calendar: {
          provider: "google-calendar",
          createEvent: async () => {
            throw new Error("not used");
          },
          updateEvent: async (input) => ({
            externalCalendarEventId: input.externalCalendarEventId,
            externalCalendarId: input.externalCalendarId ?? "primary",
            scheduledStartAt: input.startAt,
            scheduledEndAt: input.endAt
          }),
          getEvent: async () => {
            const task = listTasksForTests()[0];
            if (!task?.externalCalendarEventId || !task.externalCalendarId || !task.scheduledStartAt || !task.scheduledEndAt) {
              return null;
            }
            return {
              externalCalendarEventId: task.externalCalendarEventId,
              externalCalendarId: task.externalCalendarId,
              scheduledStartAt: task.scheduledStartAt,
              scheduledEndAt: task.scheduledEndAt
            };
          },
          listBusyPeriods: async () => [
            {
              startAt: "2026-03-18T15:00:00.000Z",
              endAt: "2026-03-18T16:00:00.000Z",
              externalCalendarId: "primary"
            }
          ]
        },
        planner: async () => ({
          confidence: 0.83,
          summary: "Moved the scheduled review block to 3pm.",
          actions: [
            {
              type: "move_schedule_block",
              blockRef: {
                alias: "schedule_block_1"
              },
              scheduleConstraint: {
                dayReference: null,
                weekday: null,
                weekOffset: null,
                explicitHour: 15,
                minute: 0,
                preferredWindow: null,
                sourceText: "at 3pm"
              },
              reason: "The user asked to move it to 3pm."
            }
          ]
        })
      }
    );

    expect(result.outcome).toBe("updated_schedule");
    expect("updatedBlock" in result ? result.updatedBlock.startAt : "").toBe("2026-03-20T22:00:00.000Z");
  });

  it("marks invalid model output references for clarification", async () => {
    seedInboxItemForProcessingTests({
      id: "inbox-3",
      userId: "123",
      sourceEventId: "event-3",
      rawText: "move it to 3pm",
      normalizedText: "move it to 3pm",
      processingStatus: "received",
      linkedTaskIds: []
    });

    const result = await processInboxItem(
      { inboxItemId: "inbox-3" },
      {
        calendar: getDefaultCalendarAdapter(),
        planner: async () => ({
          confidence: 0.35,
          summary: "Move the block.",
          actions: [
            {
              type: "move_schedule_block",
              blockRef: {
                alias: "schedule_block_999"
              },
              scheduleConstraint: {
                dayReference: null,
                weekday: null,
                weekOffset: null,
                explicitHour: 15,
                minute: 0,
                preferredWindow: null,
                sourceText: "at 3pm"
              },
              reason: "Move the most likely block."
            }
          ]
        })
      }
    );

    expect(result.outcome).toBe("needs_clarification");
    expect(listTasksForTests()).toHaveLength(0);
  });

  it("does not leak internal clarification reasons to the user", async () => {
    seedInboxItemForProcessingTests({
      id: "inbox-safe-clarify",
      userId: "123",
      sourceEventId: "event-safe-clarify",
      rawText: "schedule both",
      normalizedText: "schedule both",
      processingStatus: "received",
      linkedTaskIds: []
    });

    const result = await processInboxItem(
      { inboxItemId: "inbox-safe-clarify" },
      {
        calendar: getDefaultCalendarAdapter(),
        planner: async () => ({
          confidence: 0.3,
          summary: "Captured and scheduled tasks.",
          actions: [
            {
              type: "create_task",
              alias: "new_task_1",
              title: "Car maintenance",
              priority: "medium",
              urgency: "medium"
            },
            {
              type: "create_schedule_block",
              taskRef: {
                kind: "existing_task",
                alias: "existing_task_1"
              },
              scheduleConstraint: {
                dayReference: null,
                weekday: null,
                weekOffset: null,
                explicitHour: 9,
                minute: 0,
                preferredWindow: null,
                sourceText: "9am"
              },
              reason: "Schedule the task."
            }
          ]
        })
      }
    );

    expect(result.outcome).toBe("needs_clarification");
    expect("reason" in result ? result.reason : "").toBe(
      "Model returned invalid or mixed schedule references for newly created tasks."
    );
    expect(result.followUpMessage).toBe(
      "I couldn't safely apply that update. Tell me the exact task and what you'd like me to change."
    );
  });

  it("rejects mixed completion and creation actions instead of partially applying them", async () => {
    seedInboxItemForProcessingTests({
      id: "inbox-mixed-complete-create",
      userId: "123",
      sourceEventId: "event-mixed-complete-create",
      rawText: "journal is done, make a new coding task",
      normalizedText: "journal is done, make a new coding task",
      processingStatus: "received",
      linkedTaskIds: []
    });

    const result = await processInboxItem(
      { inboxItemId: "inbox-mixed-complete-create" },
      {
        calendar: getDefaultCalendarAdapter(),
        planner: async () => ({
          confidence: 0.4,
          summary: "Mark the journal task as done and create a coding task.",
          actions: [
            {
              type: "create_task",
              alias: "new_task_1",
              title: "Coding session",
              priority: "medium",
              urgency: "medium"
            },
            {
              type: "complete_task",
              taskRef: {
                kind: "existing_task",
                alias: "existing_task_1"
              },
              reason: "The user said journal is done."
            }
          ]
        })
      }
    );

    expect(result.outcome).toBe("needs_clarification");
    expect(listTasksForTests()).toHaveLength(0);
    expect("reason" in result ? result.reason : "").toBe(
      "Model returned an unsupported mix of completion and creation actions."
    );
  });

  it("resets processing state and records a failed planner run when calendar creation fails", async () => {
    const store = getDefaultInboxProcessingStore();

    seedInboxItemForProcessingTests({
      id: "inbox-calendar-fail",
      userId: "123",
      sourceEventId: "event-calendar-fail",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: []
    });

    await expect(
      processInboxItem(
        {
          inboxItemId: "inbox-calendar-fail"
        },
        {
          store,
          calendar: {
            provider: "google-calendar",
            createEvent: async () => {
              throw new Error("calendar unavailable");
            },
            updateEvent: async () => {
              throw new Error("calendar unavailable");
            },
            getEvent: async () => null,
            listBusyPeriods: async () => []
          },
          planner: async () => ({
            confidence: 0.9,
            summary: "Captured and scheduled Review launch checklist.",
            actions: [
              {
                type: "create_task",
                alias: "new_task_1",
                title: "Review launch checklist",
                priority: "medium",
                urgency: "medium"
              },
              {
                type: "create_schedule_block",
                taskRef: {
                  kind: "created_task",
                  alias: "new_task_1"
                },
                scheduleConstraint: {
                  dayReference: null,
                  weekday: null,
                  weekOffset: null,
                  explicitHour: 9,
                  minute: 0,
                  preferredWindow: null,
                  sourceText: "default next slot"
                },
                reason: "Schedule the new task in the next slot."
              }
            ]
          })
        }
      )
    ).rejects.toThrow("calendar unavailable");

    expect(listTasksForTests()).toHaveLength(0);
    expect(listPlannerRunsForTests()).toHaveLength(1);
    await expect(store.loadContext("inbox-calendar-fail")).resolves.toMatchObject({
      inboxItem: {
        processingStatus: "received"
      }
    });
  });

  it("resets processing state and records a failed planner run when calendar rescheduling fails", async () => {
    const store = getDefaultInboxProcessingStore();

    seedInboxItemForProcessingTests({
      id: "inbox-task",
      userId: "123",
      sourceEventId: "event-task",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: []
    });
    await processInboxItem(
      { inboxItemId: "inbox-task" },
      {
        store,
        calendar: getDefaultCalendarAdapter(),
        planner: async () => ({
          confidence: 0.9,
          summary: "Scheduled Review launch checklist.",
          actions: [
            {
              type: "create_task",
              alias: "new_task_1",
              title: "Review launch checklist",
              priority: "medium",
              urgency: "medium"
            },
            {
              type: "create_schedule_block",
              taskRef: {
                kind: "created_task",
                alias: "new_task_1"
              },
              scheduleConstraint: {
                dayReference: null,
                weekday: null,
                weekOffset: null,
                explicitHour: 9,
                minute: 0,
                preferredWindow: null,
                sourceText: "default next slot"
              },
              reason: "Schedule the new task in the next slot."
            }
          ]
        })
      }
    );

    seedInboxItemForProcessingTests({
      id: "inbox-move-fail",
      userId: "123",
      sourceEventId: "event-move-fail",
      rawText: "move it to 3pm",
      normalizedText: "move it to 3pm",
      processingStatus: "received",
      linkedTaskIds: []
    });

    await expect(
      processInboxItem(
        { inboxItemId: "inbox-move-fail" },
        {
          store,
          calendar: {
            provider: "google-calendar",
            createEvent: async () => {
              throw new Error("calendar unavailable");
            },
            updateEvent: async () => {
              throw new Error("calendar unavailable");
            },
            getEvent: async () => {
              const task = listTasksForTests()[0];
              if (
                !task?.externalCalendarEventId ||
                !task.externalCalendarId ||
                !task.scheduledStartAt ||
                !task.scheduledEndAt
              ) {
                return null;
              }

              return {
                externalCalendarEventId: task.externalCalendarEventId,
                externalCalendarId: task.externalCalendarId,
                scheduledStartAt: task.scheduledStartAt,
                scheduledEndAt: task.scheduledEndAt
              };
            },
            listBusyPeriods: async () => []
          },
          planner: async () => ({
            confidence: 0.83,
            summary: "Moved the scheduled review block to 3pm.",
            actions: [
              {
                type: "move_schedule_block",
                blockRef: {
                  alias: "schedule_block_1"
                },
                scheduleConstraint: {
                  dayReference: null,
                  weekday: null,
                  weekOffset: null,
                  explicitHour: 15,
                  minute: 0,
                  preferredWindow: null,
                  sourceText: "at 3pm"
                },
                reason: "The user asked to move it to 3pm."
              }
            ]
          })
        }
      )
    ).rejects.toThrow("calendar unavailable");

    expect(listPlannerRunsForTests()).toHaveLength(2);
    await expect(store.loadContext("inbox-move-fail")).resolves.toMatchObject({
      inboxItem: {
        processingStatus: "received"
      }
    });
  });
});
