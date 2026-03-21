import type { TurnRoutingInput } from "@atlas/core";

import { routeTurnWithResponses } from "../openai";
import type { EvalCaseResult, EvalSuiteResult } from "./shared";

type RouterConfirmationEvalCase = {
  name: string;
  input: TurnRoutingInput;
  expectedRoute: "confirmed_mutation" | "conversation_then_mutation";
};

export const ROUTER_CONFIRMATION_EVAL_CASES: RouterConfirmationEvalCase[] = [
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
      ]
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
      ]
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
      ]
    },
    expectedRoute: "conversation_then_mutation"
  }
];

export async function runRouterConfirmationEvalSuite(): Promise<EvalSuiteResult> {
  const startedAt = Date.now();
  const cases: EvalCaseResult[] = [];

  for (const testCase of ROUTER_CONFIRMATION_EVAL_CASES) {
    const result = await routeTurnWithResponses(testCase.input);
    const pass = result.route === testCase.expectedRoute;

    cases.push({
      name: testCase.name,
      pass,
      details: {
        input: testCase.input.rawText,
        expected: testCase.expectedRoute,
        actual: result.route,
        reason: result.reason
      },
      ...(pass ? {} : { error: `Expected ${testCase.expectedRoute}, received ${result.route}` })
    });
  }

  const passed = cases.filter((testCase) => testCase.pass).length;

  return {
    suiteName: "router-confirmation",
    total: cases.length,
    passed,
    failed: cases.length - passed,
    durationMs: Date.now() - startedAt,
    cases
  };
}
