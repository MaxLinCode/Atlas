import type {
  ConversationTurn,
  TurnRoute,
  TurnRoutingInput,
} from "@atlas/core";

import { routeTurnWithResponses } from "../openai";
import type { EvalCaseResult, EvalSuiteResult } from "./shared";

type TurnRouterEvalCase = {
  input: TurnRoutingInput;
  expectedRoute: TurnRoute;
  note: string;
};

const ASSISTANT_CONFIRMATION_TURNS: ConversationTurn[] = [
  {
    role: "assistant",
    text: "Would you like me to schedule it at 3pm?",
    createdAt: "2026-03-17T16:00:00.000Z",
  },
  {
    role: "user",
    text: "Yes",
    createdAt: "2026-03-17T16:01:00.000Z",
  },
];

export const TURN_ROUTER_EVAL_CASES: TurnRouterEvalCase[] = [
  {
    input: {
      rawText: "create car maintenance appt",
      normalizedText: "create car maintenance appt",
      recentTurns: [],
    },
    expectedRoute: "conversation_then_mutation",
    note: "Partial scheduling ask should clarify before any write.",
  },
  {
    input: {
      rawText: "schedule oil change for Friday at 2pm",
      normalizedText: "schedule oil change for Friday at 2pm",
      recentTurns: [],
    },
    expectedRoute: "mutation",
    note: "Concrete scheduling request should be write-ready.",
  },
  {
    input: {
      rawText: "schedule an oil change",
      normalizedText: "schedule an oil change",
      recentTurns: [],
    },
    expectedRoute: "mutation",
    note: "Bare scheduling requests should be write-ready when Atlas can choose the next reasonable slot.",
  },
  {
    input: {
      rawText: "schedule the oil change tomorrow morning but not too early",
      normalizedText:
        "schedule the oil change tomorrow morning but not too early",
      recentTurns: [],
    },
    expectedRoute: "mutation",
    note: "Soft but usable timing should still be write-ready.",
  },
  {
    input: {
      rawText: "schedule the oil change for me and just pick an opening",
      normalizedText: "schedule the oil change for me and just pick an opening",
      recentTurns: [],
    },
    expectedRoute: "mutation",
    note: "Delegated slot choice should be write-ready when the task is clear.",
  },
  {
    input: {
      rawText: "should I do the oil change this week or next week?",
      normalizedText: "should I do the oil change this week or next week?",
      recentTurns: [],
    },
    expectedRoute: "conversation",
    note: "Planning discussion without an immediate write.",
  },
  {
    input: {
      rawText: "I might move this to Friday, what do you think?",
      normalizedText: "I might move this to Friday, what do you think?",
      recentTurns: [],
    },
    expectedRoute: "conversation_then_mutation",
    note: "Mixed discussion plus possible write should discuss first.",
  },
  {
    input: {
      rawText: "if tomorrow is slammed push deep work to Friday",
      normalizedText: "if tomorrow is slammed push deep work to Friday",
      recentTurns: [],
    },
    expectedRoute: "conversation_then_mutation",
    note: "Conditional requests should not be treated as write-ready.",
  },
  {
    input: {
      rawText: "Yes",
      normalizedText: "Yes",
      recentTurns: ASSISTANT_CONFIRMATION_TURNS,
    },
    expectedRoute: "confirmed_mutation",
    note: "Short confirmation of one concrete recent proposal should be write-capable.",
  },
  {
    input: {
      rawText: "Friday works",
      normalizedText: "Friday works",
      recentTurns: [
        {
          role: "assistant",
          text: "I can move it to Friday at 3pm.",
          createdAt: "2026-03-17T16:00:00.000Z",
        },
        {
          role: "user",
          text: "Friday works",
          createdAt: "2026-03-17T16:01:00.000Z",
        },
      ],
    },
    expectedRoute: "confirmed_mutation",
    note: "Concrete refinement of one recent proposal should be write-capable.",
  },
  {
    input: {
      rawText: "Yes",
      normalizedText: "Yes",
      recentTurns: [
        {
          role: "assistant",
          text: "I could reschedule the workout or add the grocery reminder first.",
          createdAt: "2026-03-17T17:00:00.000Z",
        },
        {
          role: "user",
          text: "Yes",
          createdAt: "2026-03-17T17:01:00.000Z",
        },
      ],
    },
    expectedRoute: "conversation_then_mutation",
    note: "Vague confirmation after multiple possible actions should stay discuss-first.",
  },
];

export async function runTurnRouterEvalSuite(): Promise<EvalSuiteResult> {
  const startedAt = Date.now();
  const cases: EvalCaseResult[] = [];

  for (const testCase of TURN_ROUTER_EVAL_CASES) {
    const result = await routeTurnWithResponses(testCase.input);
    const pass = result.route === testCase.expectedRoute;

    cases.push({
      name: testCase.input.rawText,
      pass,
      details: {
        expected: testCase.expectedRoute,
        actual: result.route,
        note: testCase.note,
        reason: result.reason,
      },
      ...(pass
        ? {}
        : {
            error: `Expected ${testCase.expectedRoute}, received ${result.route}`,
          }),
    });
  }

  const passed = cases.filter((testCase) => testCase.pass).length;

  return {
    suiteName: "turn-router",
    total: cases.length,
    passed,
    failed: cases.length - passed,
    durationMs: Date.now() - startedAt,
    cases,
  };
}
