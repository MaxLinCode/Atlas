import { beforeEach, describe, expect, it } from "vitest";
import {
  getDefaultInboxProcessingStore,
  listPlannerRunsForTests,
  listScheduleBlocksForTests,
  listTasksForTests,
  resetInboxProcessingStoreForTests,
  seedInboxItemForProcessingTests
} from "@atlas/db";

import { processInboxItem } from "./process-inbox-item";

describe("process inbox item service", () => {
  beforeEach(() => {
    resetInboxProcessingStoreForTests();
  });

  it("creates a task and schedule block from model-driven plain task capture", async () => {
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
          ]
        })
      }
    );

    expect(result.outcome).toBe("planned");
    expect(listTasksForTests()).toHaveLength(1);
    expect(listScheduleBlocksForTests()).toHaveLength(1);
    expect(listPlannerRunsForTests()).toHaveLength(1);
    expect(listTasksForTests()[0]).toMatchObject({
      sourceInboxItemId: "inbox-1",
      lastInboxItemId: "inbox-1",
      lifecycleState: "scheduled",
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
          ]
        })
      }
    );

    expect(result.outcome).toBe("planned");
    expect("scheduleBlocks" in result ? result.scheduleBlocks[0]?.startAt : "").toContain("T15:00:00.000Z");
  });

  it("moves an existing schedule block when the model selects one safe alias", async () => {
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
      {
        inboxItemId: "inbox-task"
      },
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
      linkedTaskIds: []
    });

    const result = await processInboxItem(
      {
        inboxItemId: "inbox-move"
      },
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
          ]
        })
      }
    );

    expect(result.outcome).toBe("updated_schedule");
    expect("updatedBlock" in result ? result.updatedBlock.startAt : "").toContain("T15:00:00.000Z");
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
      {
        inboxItemId: "inbox-3"
      },
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
          ]
        })
      }
    );

    expect(result.outcome).toBe("needs_clarification");
  });

  it("marks duplicate existing-task schedule actions for clarification", async () => {
    const store = getDefaultInboxProcessingStore();

    seedInboxItemForProcessingTests({
      id: "inbox-existing-task",
      userId: "123",
      sourceEventId: "event-existing-task",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: []
    });

    await processInboxItem(
      {
        inboxItemId: "inbox-existing-task"
      },
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
          ]
        })
      }
    );

    seedInboxItemForProcessingTests({
      id: "inbox-duplicate-existing-schedule",
      userId: "123",
      sourceEventId: "event-duplicate-existing-schedule",
      rawText: "schedule the checklist twice",
      normalizedText: "schedule the checklist twice",
      processingStatus: "received",
      linkedTaskIds: []
    });

    const result = await processInboxItem(
      {
        inboxItemId: "inbox-duplicate-existing-schedule"
      },
      {
        store,
        planner: async () => ({
          confidence: 0.42,
          summary: "Schedule the checklist twice.",
          actions: [
            {
              type: "create_schedule_block",
              taskRef: {
                kind: "existing_task",
                alias: "existing_task_1"
              },
              scheduleConstraint: {
                dayOffset: 1,
                explicitHour: 9,
                minute: 0,
                preferredWindow: null,
                sourceText: "tomorrow at 9am"
              },
              reason: "Schedule the checklist tomorrow morning."
            },
            {
              type: "create_schedule_block",
              taskRef: {
                kind: "existing_task",
                alias: "existing_task_1"
              },
              scheduleConstraint: {
                dayOffset: 1,
                explicitHour: 14,
                minute: 0,
                preferredWindow: "afternoon",
                sourceText: "tomorrow afternoon"
              },
              reason: "Also schedule the checklist tomorrow afternoon."
            }
          ]
        })
      }
    );

    expect(result.outcome).toBe("needs_clarification");
    expect(listScheduleBlocksForTests()).toHaveLength(1);
  });

  it("does not fall back to heuristics when planning fails", async () => {
    seedInboxItemForProcessingTests({
      id: "inbox-4",
      userId: "123",
      sourceEventId: "event-4",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: []
    });

    await expect(
      processInboxItem(
        {
          inboxItemId: "inbox-4"
        },
        {
          planner: async () => {
            throw new Error("planner unavailable");
          }
        }
      )
    ).rejects.toThrow("planner unavailable");

    expect(listTasksForTests()).toHaveLength(0);
    expect(listScheduleBlocksForTests()).toHaveLength(0);
    expect(listPlannerRunsForTests()).toHaveLength(1);
  });
});
