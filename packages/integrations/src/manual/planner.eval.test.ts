import { beforeAll, describe, expect, it } from "vitest";
import type { InboxPlanningContext, PlanningAction, ScheduleConstraint } from "@atlas/core";
import { buildDefaultUserProfile } from "@atlas/core";

import { planInboxItemWithResponses } from "../openai";

type PlannerEvalCase = {
  name: string;
  input: InboxPlanningContext;
  expectedActionType: PlanningAction["type"];
  expectedConstraint: ScheduleConstraint;
};

const PLANNER_EVAL_CASES: PlannerEvalCase[] = [
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
      now: "2026-03-18T16:00:00.000Z"
    },
    expectedActionType: "create_schedule_block",
    expectedConstraint: {
      dayReference: "weekday",
      weekday: "friday",
      weekOffset: 0,
      explicitHour: 10,
      minute: 0,
      preferredWindow: null,
      sourceText: "Friday at 10am"
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
      now: "2026-03-18T16:00:00.000Z"
    },
    expectedActionType: "create_schedule_block",
    expectedConstraint: {
      dayReference: "weekday",
      weekday: "friday",
      weekOffset: 1,
      explicitHour: 10,
      minute: 0,
      preferredWindow: null,
      sourceText: "next Friday at 10am"
    }
  }
];

beforeAll(() => {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required to run the manual planner eval.");
  }

  process.env.DATABASE_URL ??= "postgresql://manual:manual@localhost:5432/manual_eval";
  process.env.APP_BASE_URL ??= "http://localhost:3000";
  process.env.TELEGRAM_BOT_TOKEN ??= "manual-telegram-token";
  process.env.TELEGRAM_WEBHOOK_SECRET ??= "manual-telegram-webhook-secret";
  process.env.TELEGRAM_ALLOWED_USER_IDS ??= "123";
});

describe.sequential("manual planner eval", () => {
  it("checks curated planner timing cases against the live OpenAI prompt", async () => {
    const rows: Array<{
      name: string;
      expected: string;
      actual: string;
      pass: boolean;
      summary: string;
    }> = [];

    for (const testCase of PLANNER_EVAL_CASES) {
      const result = await planInboxItemWithResponses(testCase.input);
      const scheduleAction = result.actions.find(
        (action): action is Extract<PlanningAction, { type: "create_schedule_block" | "move_schedule_block" }> =>
          action.type === "create_schedule_block" || action.type === "move_schedule_block"
      );

      const actual = scheduleAction
        ? JSON.stringify(scheduleAction.scheduleConstraint)
        : `missing schedule action (${result.actions.map((action) => action.type).join(", ")})`;
      const expected = JSON.stringify(testCase.expectedConstraint);
      const pass = scheduleAction?.type === testCase.expectedActionType && actual === expected;

      rows.push({
        name: testCase.name,
        expected,
        actual,
        pass,
        summary: result.summary
      });

      expect.soft(scheduleAction?.type, testCase.name).toBe(testCase.expectedActionType);
      expect.soft(scheduleAction?.scheduleConstraint, testCase.name).toMatchObject(testCase.expectedConstraint);
    }

    console.table(rows);
  }, 120_000);
});
