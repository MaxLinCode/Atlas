import { beforeAll, describe, expect, it } from "vitest";

import { routeTurnWithResponses, type TurnRoutingInput } from "../openai";

type RouterConfirmationEvalCase = {
  name: string;
  input: TurnRoutingInput;
  expectedRoute: "confirmed_mutation" | "conversation_then_mutation";
};

const ROUTER_CONFIRMATION_EVAL_CASES: RouterConfirmationEvalCase[] = [
  {
    name: "assistant proposal plus yes confirms one concrete write",
      input: {
        rawText: "Yes",
        normalizedText: "Yes",
        recentTurns: [
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
      ],
      },
    expectedRoute: "confirmed_mutation"
  },
  {
    name: "broader refinement confirms one concrete write",
      input: {
        rawText: "push it 1 hour later",
        normalizedText: "push it 1 hour later",
        recentTurns: [
        {
          role: "assistant",
          text: "I can move it to 3pm.",
          createdAt: "2026-03-17T16:00:00.000Z"
        },
        {
          role: "user",
          text: "push it 1 hour later",
          createdAt: "2026-03-17T16:01:00.000Z"
        }
      ],
      },
    expectedRoute: "confirmed_mutation"
  },
  {
    name: "ambiguous yes stays discuss-first",
      input: {
        rawText: "Yes",
        normalizedText: "Yes",
        recentTurns: [
        {
          role: "assistant",
          text: "I could do 3pm or 4pm.",
          createdAt: "2026-03-17T16:00:00.000Z"
        },
        {
          role: "user",
          text: "Yes",
          createdAt: "2026-03-17T16:01:00.000Z"
        }
      ],
      },
    expectedRoute: "conversation_then_mutation"
  }
];

beforeAll(() => {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required to run the manual router confirmation eval.");
  }

  process.env.DATABASE_URL ??= "postgresql://manual:manual@localhost:5432/manual_eval";
  process.env.TELEGRAM_BOT_TOKEN ??= "manual-telegram-token";
  process.env.TELEGRAM_WEBHOOK_SECRET ??= "manual-telegram-webhook-secret";
});

describe.sequential("manual router confirmation eval", () => {
  it("checks curated confirmation cases against the live OpenAI prompt", async () => {
    const rows: Array<{
      name: string;
      input: string;
      expected: RouterConfirmationEvalCase["expectedRoute"];
      actual: string;
      pass: boolean;
      reason: string;
    }> = [];

    for (const testCase of ROUTER_CONFIRMATION_EVAL_CASES) {
      const result = await routeTurnWithResponses(testCase.input);

      rows.push({
        name: testCase.name,
        input: testCase.input.rawText,
        expected: testCase.expectedRoute,
        actual: result.route,
        pass: result.route === testCase.expectedRoute,
        reason: result.reason
      });

      expect.soft(result.route, testCase.name).toBe(testCase.expectedRoute);
    }

    console.table(rows);
  }, 120_000);
});
