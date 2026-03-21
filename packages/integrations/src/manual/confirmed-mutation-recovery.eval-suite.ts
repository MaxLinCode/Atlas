import type { ConfirmedMutationRecoveryInput } from "@atlas/core";
import { expect } from "vitest";

import { recoverConfirmedMutationWithResponses } from "../openai";
import type { EvalCaseResult, EvalSuiteResult } from "./shared";

type RecoveryEvalCase = {
  name: string;
  input: ConfirmedMutationRecoveryInput;
  assert: (result: Awaited<ReturnType<typeof recoverConfirmedMutationWithResponses>>) => void;
};

export const RECOVERY_EVAL_CASES: RecoveryEvalCase[] = [
  {
    name: "single concrete confirmation recovers one write-ready request",
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
      memorySummary: "The assistant proposed scheduling it at 3pm."
    },
    assert: (result) => {
      expect(result.outcome).toBe("recovered");
      expect(result.recoveredText).toMatch(/3pm/i);
    }
  },
  {
    name: "vague yes after multiple options requires clarification",
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
      memorySummary: "Two candidate times were proposed."
    },
    assert: (result) => {
      expect(result.outcome).toBe("needs_clarification");
      expect(result.recoveredText).toBeNull();
      expect(result.userReplyMessage).toMatch(/\?/);
    }
  },
  {
    name: "clear completion language recovers a completion request",
    input: {
      rawText: "done",
      normalizedText: "done",
      recentTurns: [
        {
          role: "assistant",
          text: "Did you finish the journaling session?",
          createdAt: "2026-03-17T16:00:00.000Z"
        },
        {
          role: "user",
          text: "done",
          createdAt: "2026-03-17T16:01:00.000Z"
        }
      ],
      memorySummary: "The recent exchange is about the journaling session."
    },
    assert: (result) => {
      expect(result.outcome).toBe("recovered");
      expect(result.recoveredText).toMatch(/journal|done/i);
    }
  }
];

export async function runConfirmedMutationRecoveryEvalSuite(): Promise<EvalSuiteResult> {
  const startedAt = Date.now();
  const cases: EvalCaseResult[] = [];

  for (const testCase of RECOVERY_EVAL_CASES) {
    const result = await recoverConfirmedMutationWithResponses(testCase.input);

    try {
      testCase.assert(result);
      cases.push({
        name: testCase.name,
        pass: true,
        details: {
          input: testCase.input.rawText,
          outcome: result.outcome,
          recoveredText: result.recoveredText,
          reason: result.reason,
          userReplyMessage: result.userReplyMessage
        }
      });
    } catch (error) {
      cases.push({
        name: testCase.name,
        pass: false,
        details: {
          input: testCase.input.rawText,
          outcome: result.outcome,
          recoveredText: result.recoveredText,
          reason: result.reason,
          userReplyMessage: result.userReplyMessage
        },
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const passed = cases.filter((testCase) => testCase.pass).length;

  return {
    suiteName: "confirmed-mutation-recovery",
    total: cases.length,
    passed,
    failed: cases.length - passed,
    durationMs: Date.now() - startedAt,
    cases
  };
}

