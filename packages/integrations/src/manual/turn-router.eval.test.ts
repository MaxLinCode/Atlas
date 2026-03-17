import { beforeAll, describe, expect, it } from "vitest";

import { routeTurnWithResponses, type TurnRoute } from "../openai";

type TurnRouterEvalCase = {
  input: string;
  expectedRoute: TurnRoute;
  note: string;
};

const TURN_ROUTER_EVAL_CASES: TurnRouterEvalCase[] = [
  {
    input: "create car maintenance appt",
    expectedRoute: "conversation_then_mutation",
    note: "Partial scheduling ask should clarify before any write."
  },
  {
    input: "schedule oil change for Friday at 2pm",
    expectedRoute: "mutation",
    note: "Concrete scheduling request should be write-ready."
  },
  {
    input: "should I do the oil change this week or next week?",
    expectedRoute: "conversation",
    note: "Planning discussion without an immediate write."
  },
  {
    input: "I might move this to Friday, what do you think?",
    expectedRoute: "conversation_then_mutation",
    note: "Mixed discussion plus possible write should discuss first."
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
      const result = await routeTurnWithResponses({
        rawText: testCase.input,
        normalizedText: testCase.input
      });

      rows.push({
        input: testCase.input,
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
