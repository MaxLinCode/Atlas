import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxPlanningOutput } from "@atlas/core";
import {
  getDefaultInboxProcessingStore,
  listPlannerRunsForTests,
  listScheduleBlocksForTests,
  listTasksForTests,
  resetInboxProcessingStoreForTests,
  seedInboxItemForProcessingTests
} from "@atlas/db";
import { resetCalendarAdapterForTests } from "@atlas/integrations";

import { processInboxItem } from "./process-inbox-item";

describe("process inbox item service", () => {
  beforeEach(() => {
    resetInboxProcessingStoreForTests();
    resetCalendarAdapterForTests();
  });

  it("creates a task and calendar-backed current commitment from model-driven capture", async () => {
    seedInboxItemForProcessingTests({
      id: "inbox-1",
      userId: "123",
      sourceEventId: "event-1",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: []
    });

    const result = await processInboxItem(
      {
        inboxItemId: "inbox-1"
      },
      {
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
                dayOffset: 0,
                explicitHour: 9,
                minute: 0,
                preferredWindow: null,
                sourceText: "default next slot"
              },
              reason: "Schedule the new task in the next slot."
            }
          ],
          userReplyMessage: "Got it - I've added 'Review launch checklist' to your schedule for tomorrow at 9am."
        })
      }
    );

    expect(result.outcome).toBe("planned");
    expect(listPlannerRunsForTests()).toHaveLength(1);
    expect(listScheduleBlocksForTests()).toHaveLength(1);
    expect(listTasksForTests()[0]).toMatchObject({
      sourceInboxItemId: "inbox-1",
      lastInboxItemId: "inbox-1",
      lifecycleState: "scheduled",
      externalCalendarEventId: expect.any(String),
      externalCalendarId: "primary",
      rescheduleCount: 0
    });
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
                dayOffset: 1,
                explicitHour: 15,
                minute: 0,
                preferredWindow: null,
                sourceText: "tomorrow at 3pm"
              },
              reason: "The user requested tomorrow at 3pm."
            }
          ],
          userReplyMessage: "Got it--I've added 'Submit taxes' to your schedule for tomorrow at 3pm."
        })
      }
    );

    expect(result.outcome).toBe("planned");
    expect("scheduleBlocks" in result ? result.scheduleBlocks[0]?.startAt : "").toContain("T15:00:00.000Z");
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
            dayOffset: 0,
            explicitHour: 15,
            minute: 0,
            preferredWindow: null,
            sourceText: "at 3pm"
          },
          reason: "The user confirmed the 3pm proposal."
        }
      ],
          userReplyMessage: "Got it--I've added 'Submit taxes' to your schedule for tomorrow at 3pm."
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
          rawText: "Schedule the dentist reminder at 3pm.",
          normalizedText: "Schedule the dentist reminder at 3pm."
        }
      },
      {
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

  it("moves an existing scheduled task by updating the same calendar event", async () => {
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
                dayOffset: 0,
                explicitHour: 9,
                minute: 0,
                preferredWindow: null,
                sourceText: "default next slot"
              },
              reason: "Schedule the new task in the next slot."
            }
          ],
          userReplyMessage: "Got it - I've added 'Review launch checklist' to your schedule for tomorrow at 9am."
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
      linkedTaskIds: []
    });

    const result = await processInboxItem(
      { inboxItemId: "inbox-move" },
      {
        store,
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
                dayOffset: 0,
                explicitHour: 15,
                minute: 0,
                preferredWindow: null,
                sourceText: "at 3pm"
              },
              reason: "The user asked to move it to 3pm."
            }
          ],
          userReplyMessage: "Perfect - I've moved your review to 3pm today."
        })
      }
    );

    expect(result.outcome).toBe("updated_schedule");
    expect("updatedBlock" in result ? result.updatedBlock.startAt : "").toContain("T15:00:00.000Z");
    expect("updatedBlock" in result ? result.updatedBlock.id : "").toBe(listTasksForTests()[0]?.externalCalendarEventId);
    expect(listTasksForTests()[0]).toMatchObject({
      lastInboxItemId: "inbox-move",
      lifecycleState: "scheduled",
      rescheduleCount: 1
    });
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
                dayOffset: 0,
                explicitHour: 15,
                minute: 0,
                preferredWindow: null,
                sourceText: "at 3pm"
              },
              reason: "Move the most likely block."
            }
          ],
          userReplyMessage: "I found your review block, but I'm not sure which one you meant. Can you clarify which event you want to move?"
        })
      }
    );

    expect(result.outcome).toBe("needs_clarification");
    expect(listTasksForTests()).toHaveLength(0);
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
            getEvent: async () => null
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
                  dayOffset: 0,
                  explicitHour: 9,
                  minute: 0,
                  preferredWindow: null,
                  sourceText: "default next slot"
                },
                reason: "Schedule the new task in the next slot."
              }
            ],
            userReplyMessage: "Got it--I've added 'Review launch checklist' to your schedule for tomorrow at 9am."
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
                dayOffset: 0,
                explicitHour: 9,
                minute: 0,
                preferredWindow: null,
                sourceText: "default next slot"
              },
              reason: "Schedule the new task in the next slot."
            }
          ],
          userReplyMessage: "Got it - I've added 'Review launch checklist' to your schedule for tomorrow at 9am."
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
            }
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
                  dayOffset: 0,
                  explicitHour: 15,
                  minute: 0,
                  preferredWindow: null,
                  sourceText: "at 3pm"
                },
                reason: "The user asked to move it to 3pm."
              }
            ],
            userReplyMessage: "Perfect--I've moved your review to 3pm today."
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
