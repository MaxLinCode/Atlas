import { beforeAll, describe, expect, it } from "vitest";

import {
  routeTurnWithResponses,
  type ConversationTurn,
  type TurnRoute,
  type TurnRoutingInput
} from "../openai";

type TurnRouterEvalCase = {
  input: TurnRoutingInput;
  expectedRoute: TurnRoute;
  note: string;
};

const ASSISTANT_CONFIRMATION_TURNS: ConversationTurn[] = [
  {
    role: "assistant",
    text: "Would you like me to schedule it at 3pm?",
    createdAt: "2026-03-17T16:00:00.000Z"
  },
  {
    role: "user",
    text: "Yes",
    createdAt: "2026-03-17T16:01:00.000Z"
  }
];

const TURN_ROUTER_EVAL_CASES: TurnRouterEvalCase[] = [
  {
      input: {
        rawText: "create car maintenance appt",
        normalizedText: "create car maintenance appt",
        recentTurns: [],
      },
    expectedRoute: "conversation_then_mutation",
    note: "Partial scheduling ask should clarify before any write."
  },
  {
      input: {
        rawText: "schedule oil change for Friday at 2pm",
        normalizedText: "schedule oil change for Friday at 2pm",
        recentTurns: [],
      },
    expectedRoute: "mutation",
    note: "Concrete scheduling request should be write-ready."
  },
  {
      input: {
        rawText: "should I do the oil change this week or next week?",
        normalizedText: "should I do the oil change this week or next week?",
        recentTurns: [],
      },
    expectedRoute: "conversation",
    note: "Planning discussion without an immediate write."
  },
  {
      input: {
        rawText: "I might move this to Friday, what do you think?",
        normalizedText: "I might move this to Friday, what do you think?",
        recentTurns: [],
      },
    expectedRoute: "conversation_then_mutation",
    note: "Mixed discussion plus possible write should discuss first."
  },
  {
    input: {
      rawText: "Yes",
      normalizedText: "Yes",
      recentTurns: ASSISTANT_CONFIRMATION_TURNS,
    },
    expectedRoute: "confirmed_mutation",
    note: "Short confirmation of one concrete recent proposal should be write-capable."
  },
  {
    input: {
      rawText: "Friday works",
      normalizedText: "Friday works",
      recentTurns: [
        {
          role: "assistant",
          text: "I can move it to Friday at 3pm.",
          createdAt: "2026-03-17T16:00:00.000Z"
        },
        {
          role: "user",
          text: "Friday works",
          createdAt: "2026-03-17T16:01:00.000Z"
        }
      ],
    },
    expectedRoute: "confirmed_mutation",
    note: "Concrete refinement of one recent proposal should be write-capable."
  }
];

beforeAll(() => {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required to run the manual turn-router eval.");
  }

  process.env.DATABASE_URL ??= "postgresql://manual:manual@localhost:5432/manual_eval";
  process.env.TELEGRAM_BOT_TOKEN ??= "manual-telegram-token";
  process.env.TELEGRAM_WEBHOOK_SECRET ??= "manual-telegram-webhook-secret";
});

describe.sequential("manual turn router eval", () => {
  it("checks curated routing cases against the live OpenAI prompt", async () => {
    const rows: Array<{
      input: string;
      expected: TurnRoute;
      actual: TurnRoute;
      pass: boolean;
      reason: string;
    }> = [];

    for (const testCase of TURN_ROUTER_EVAL_CASES) {
      const result = await routeTurnWithResponses(testCase.input);

      rows.push({
        input: testCase.input.rawText,
        expected: testCase.expectedRoute,
        actual: result.route,
        pass: result.route === testCase.expectedRoute,
        reason: result.reason
      });

      expect.soft(result.route, testCase.note).toBe(testCase.expectedRoute);
    }

    console.table(rows);
  }, 60_000);
});
