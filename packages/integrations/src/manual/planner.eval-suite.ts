import type { InboxPlanningContext, InboxPlanningOutput, PlanningAction, ScheduleConstraint } from "@atlas/core";
import { buildDefaultUserProfile } from "@atlas/core";
import { expect } from "vitest";

import { planInboxItemWithResponses } from "../openai";
import type { EvalCaseResult, EvalSuiteResult } from "./shared";

type PlannerEvalCase = {
  name: string;
  input: InboxPlanningContext;
  assert: (result: InboxPlanningOutput) => void;
};

export const PLANNER_EVAL_CASES: PlannerEvalCase[] = [
  {
    name: "weekday scheduling resolves bare friday",
    input: {
      inboxItem: {
        id: "inbox-1",
        userId: "123",
        sourceEventId: "event-1",
        rawText: "Schedule car maintenance for Friday at 10am.",
        normalizedText: "Schedule car maintenance for Friday at 10am.",
        processingStatus: "received",
        linkedTaskIds: [],
        createdAt: "2026-03-18T16:00:00.000Z"
      },
      userProfile: {
        ...buildDefaultUserProfile("123"),
        timezone: "America/Los_Angeles"
      },
      tasks: [],
      scheduleBlocks: [],
      referenceTime: "2026-03-18T16:00:00.000Z"
    },
    assert: (result) => {
      const scheduleAction = result.actions.find(
        (action): action is Extract<PlanningAction, { type: "create_schedule_block" | "move_schedule_block" }> =>
          action.type === "create_schedule_block" || action.type === "move_schedule_block"
      );

      expect(scheduleAction?.type).toBe("create_schedule_block");
      expect(scheduleAction?.scheduleConstraint).toMatchObject({
        dayReference: "weekday",
        weekday: "friday",
        weekOffset: 0,
        relativeMinutes: null,
        explicitHour: 10,
        minute: 0,
        preferredWindow: null,
        sourceText: "Friday at 10am"
      } satisfies ScheduleConstraint);
    }
  },
  {
    name: "weekday scheduling resolves next friday",
    input: {
      inboxItem: {
        id: "inbox-2",
        userId: "123",
        sourceEventId: "event-2",
        rawText: "Schedule car maintenance for next Friday at 10am.",
        normalizedText: "Schedule car maintenance for next Friday at 10am.",
        processingStatus: "received",
        linkedTaskIds: [],
        createdAt: "2026-03-18T16:00:00.000Z"
      },
      userProfile: {
        ...buildDefaultUserProfile("123"),
        timezone: "America/Los_Angeles"
      },
      tasks: [],
      scheduleBlocks: [],
      referenceTime: "2026-03-18T16:00:00.000Z"
    },
    assert: (result) => {
      const scheduleAction = result.actions.find(
        (action): action is Extract<PlanningAction, { type: "create_schedule_block" | "move_schedule_block" }> =>
          action.type === "create_schedule_block" || action.type === "move_schedule_block"
      );

      expect(scheduleAction?.type).toBe("create_schedule_block");
      expect(scheduleAction?.scheduleConstraint).toMatchObject({
        dayReference: "weekday",
        weekday: "friday",
        weekOffset: 1,
        relativeMinutes: null,
        explicitHour: 10,
        minute: 0,
        preferredWindow: null,
        sourceText: "next Friday at 10am"
      } satisfies ScheduleConstraint);
    }
  },
  {
    name: "conditional scheduling request clarifies instead of mutating",
    input: {
      inboxItem: {
        id: "inbox-3",
        userId: "123",
        sourceEventId: "event-3",
        rawText: "If tomorrow is slammed, push the workout to Friday.",
        normalizedText: "If tomorrow is slammed, push the workout to Friday.",
        processingStatus: "received",
        linkedTaskIds: [],
        createdAt: "2026-03-18T16:00:00.000Z"
      },
      userProfile: {
        ...buildDefaultUserProfile("123"),
        timezone: "America/Los_Angeles"
      },
      tasks: [
        {
          alias: "existing_task_1",
          task: {
            id: "task-1",
            userId: "123",
            title: "Workout",
            sourceInboxItemId: "inbox-0",
            lastInboxItemId: "inbox-0",
            lifecycleState: "pending_schedule",
            externalCalendarEventId: null,
            externalCalendarId: null,
            scheduledStartAt: null,
            scheduledEndAt: null,
            calendarSyncStatus: "in_sync",
            calendarSyncUpdatedAt: null,
            rescheduleCount: 0,
            lastFollowupAt: null,
            followupReminderSentAt: null,
            completedAt: null,
            archivedAt: null,
            priority: "medium",
            urgency: "medium",
            createdAt: "2026-03-18T15:00:00.000Z"
          }
        }
      ],
      scheduleBlocks: [],
      referenceTime: "2026-03-18T16:00:00.000Z"
    },
    assert: (result) => {
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]?.type).toBe("clarify");
    }
  },
  {
    name: "clear completion uses the existing task alias",
    input: {
      inboxItem: {
        id: "inbox-4",
        userId: "123",
        sourceEventId: "event-4",
        rawText: "Journal is done.",
        normalizedText: "Journal is done.",
        processingStatus: "received",
        linkedTaskIds: [],
        createdAt: "2026-03-18T16:00:00.000Z"
      },
      userProfile: {
        ...buildDefaultUserProfile("123"),
        timezone: "America/Los_Angeles"
      },
      tasks: [
        {
          alias: "existing_task_1",
          task: {
            id: "task-2",
            userId: "123",
            title: "Journaling session",
            sourceInboxItemId: "inbox-0",
            lastInboxItemId: "inbox-0",
            lifecycleState: "pending_schedule",
            externalCalendarEventId: null,
            externalCalendarId: null,
            scheduledStartAt: null,
            scheduledEndAt: null,
            calendarSyncStatus: "in_sync",
            calendarSyncUpdatedAt: null,
            rescheduleCount: 0,
            lastFollowupAt: null,
            followupReminderSentAt: null,
            completedAt: null,
            archivedAt: null,
            priority: "medium",
            urgency: "medium",
            createdAt: "2026-03-18T15:00:00.000Z"
          }
        }
      ],
      scheduleBlocks: [],
      referenceTime: "2026-03-18T16:00:00.000Z"
    },
    assert: (result) => {
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toMatchObject({
        type: "complete_task",
        taskRef: {
          kind: "existing_task",
          alias: "existing_task_1"
        }
      });
    }
  },
  {
    name: "ambiguous mixed new and existing work clarifies",
    input: {
      inboxItem: {
        id: "inbox-5",
        userId: "123",
        sourceEventId: "event-5",
        rawText: "Move that to Friday and add a grocery task.",
        normalizedText: "Move that to Friday and add a grocery task.",
        processingStatus: "received",
        linkedTaskIds: [],
        createdAt: "2026-03-18T16:00:00.000Z"
      },
      userProfile: {
        ...buildDefaultUserProfile("123"),
        timezone: "America/Los_Angeles"
      },
      tasks: [
        {
          alias: "existing_task_1",
          task: {
            id: "task-3",
            userId: "123",
            title: "Workout",
            sourceInboxItemId: "inbox-0",
            lastInboxItemId: "inbox-0",
            lifecycleState: "pending_schedule",
            externalCalendarEventId: null,
            externalCalendarId: null,
            scheduledStartAt: null,
            scheduledEndAt: null,
            calendarSyncStatus: "in_sync",
            calendarSyncUpdatedAt: null,
            rescheduleCount: 0,
            lastFollowupAt: null,
            followupReminderSentAt: null,
            completedAt: null,
            archivedAt: null,
            priority: "medium",
            urgency: "medium",
            createdAt: "2026-03-18T15:00:00.000Z"
          }
        }
      ],
      scheduleBlocks: [],
      referenceTime: "2026-03-18T16:00:00.000Z"
    },
    assert: (result) => {
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]?.type).toBe("clarify");
    }
  },
  {
    name: "delegated slot choice uses a null schedule constraint",
    input: {
      inboxItem: {
        id: "inbox-6",
        userId: "123",
        sourceEventId: "event-6",
        rawText: "Schedule the oil change for me and just pick an opening.",
        normalizedText: "Schedule the oil change for me and just pick an opening.",
        processingStatus: "received",
        linkedTaskIds: [],
        createdAt: "2026-03-18T16:00:00.000Z"
      },
      userProfile: {
        ...buildDefaultUserProfile("123"),
        timezone: "America/Los_Angeles"
      },
      tasks: [],
      scheduleBlocks: [],
      referenceTime: "2026-03-18T16:00:00.000Z"
    },
    assert: (result) => {
      const scheduleAction = result.actions.find(
        (action): action is Extract<PlanningAction, { type: "create_schedule_block" }> =>
          action.type === "create_schedule_block"
      );

      expect(scheduleAction?.scheduleConstraint).toBeNull();
    }
  },
  {
    name: "bare scheduling request defaults to next best opening",
    input: {
      inboxItem: {
        id: "inbox-6b",
        userId: "123",
        sourceEventId: "event-6b",
        rawText: "Schedule an oil change.",
        normalizedText: "Schedule an oil change.",
        processingStatus: "received",
        linkedTaskIds: [],
        createdAt: "2026-03-18T16:00:00.000Z"
      },
      userProfile: {
        ...buildDefaultUserProfile("123"),
        timezone: "America/Los_Angeles"
      },
      tasks: [],
      scheduleBlocks: [],
      referenceTime: "2026-03-18T16:00:00.000Z"
    },
    assert: (result) => {
      const createTaskAction = result.actions.find(
        (action): action is Extract<PlanningAction, { type: "create_task" }> => action.type === "create_task"
      );
      const scheduleAction = result.actions.find(
        (action): action is Extract<PlanningAction, { type: "create_schedule_block" }> =>
          action.type === "create_schedule_block"
      );

      expect(createTaskAction?.title).toMatch(/oil change/i);
      expect(scheduleAction?.scheduleConstraint).toBeNull();
    }
  },
  {
    name: "soft late-morning preference infers a concrete time",
    input: {
      inboxItem: {
        id: "inbox-7",
        userId: "123",
        sourceEventId: "event-7",
        rawText: "Schedule the dentist tomorrow morning but not too early.",
        normalizedText: "Schedule the dentist tomorrow morning but not too early.",
        processingStatus: "received",
        linkedTaskIds: [],
        createdAt: "2026-03-18T16:00:00.000Z"
      },
      userProfile: {
        ...buildDefaultUserProfile("123"),
        timezone: "America/Los_Angeles"
      },
      tasks: [],
      scheduleBlocks: [],
      referenceTime: "2026-03-18T16:00:00.000Z"
    },
    assert: (result) => {
      const scheduleAction = result.actions.find(
        (action): action is Extract<PlanningAction, { type: "create_schedule_block" }> =>
          action.type === "create_schedule_block"
      );

      expect(scheduleAction?.scheduleConstraint).toMatchObject({
        dayReference: "tomorrow",
        relativeMinutes: null,
        explicitHour: 10,
        minute: 30
      });
    }
  },
  {
    name: "relative-minute scheduling uses relativeMinutes instead of inventing a clock time",
    input: {
      inboxItem: {
        id: "inbox-8",
        userId: "123",
        sourceEventId: "event-8",
        rawText: "add schedule my car maintenance to my cal in like 15 min",
        normalizedText: "add schedule my car maintenance to my cal in like 15 min",
        processingStatus: "received",
        linkedTaskIds: [],
        createdAt: "2026-03-20T01:02:00.000Z"
      },
      userProfile: {
        ...buildDefaultUserProfile("123"),
        timezone: "America/Los_Angeles"
      },
      tasks: [],
      scheduleBlocks: [],
      referenceTime: "2026-03-20T01:02:00.000Z"
    },
    assert: (result) => {
      const scheduleAction = result.actions.find(
        (action): action is Extract<PlanningAction, { type: "create_schedule_block" }> =>
          action.type === "create_schedule_block"
      );

      expect(scheduleAction?.scheduleConstraint).toMatchObject({
        dayReference: null,
        weekday: null,
        weekOffset: null,
        relativeMinutes: 15,
        explicitHour: null,
        minute: null,
        preferredWindow: null
      } satisfies Partial<ScheduleConstraint>);
    }
  }
];

export async function runPlannerEvalSuite(): Promise<EvalSuiteResult> {
  const startedAt = Date.now();
  const cases: EvalCaseResult[] = [];

  for (const testCase of PLANNER_EVAL_CASES) {
    const result = await planInboxItemWithResponses(testCase.input);

    try {
      testCase.assert(result);
      cases.push({
        name: testCase.name,
        pass: true,
        details: {
          actionTypes: result.actions.map((action) => action.type),
          summary: result.summary
        }
      });
    } catch (error) {
      cases.push({
        name: testCase.name,
        pass: false,
        details: {
          actionTypes: result.actions.map((action) => action.type),
          summary: result.summary
        },
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const passed = cases.filter((testCase) => testCase.pass).length;

  return {
    suiteName: "planner",
    total: cases.length,
    passed,
    failed: cases.length - passed,
    durationMs: Date.now() - startedAt,
    cases
  };
}
