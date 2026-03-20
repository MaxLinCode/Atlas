import { beforeAll, describe, expect, it } from "vitest";
import type { ConfirmedMutationRecoveryInput } from "@atlas/core";

import { recoverConfirmedMutationWithResponses } from "../openai";

type RecoveryEvalCase = {
  name: string;
  input: ConfirmedMutationRecoveryInput;
  assert: (result: Awaited<ReturnType<typeof recoverConfirmedMutationWithResponses>>) => void;
};

const RECOVERY_EVAL_CASES: RecoveryEvalCase[] = [
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

beforeAll(() => {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required to run the manual confirmed-mutation recovery eval.");
  }

  process.env.DATABASE_URL ??= "postgresql://manual:manual@localhost:5432/manual_eval";
  process.env.APP_BASE_URL ??= "http://localhost:3000";
  process.env.TELEGRAM_BOT_TOKEN ??= "manual-telegram-token";
  process.env.TELEGRAM_WEBHOOK_SECRET ??= "manual-telegram-webhook-secret";
  process.env.TELEGRAM_ALLOWED_USER_IDS ??= "123";
});

describe.sequential("manual confirmed-mutation recovery eval", () => {
  it("checks curated recovery cases against the live OpenAI prompt", async () => {
    const rows: Array<{
      name: string;
      input: string;
      outcome: string;
      recoveredText: string | null;
      reason: string;
      userReplyMessage: string;
      pass: boolean;
    }> = [];

    for (const testCase of RECOVERY_EVAL_CASES) {
      const result = await recoverConfirmedMutationWithResponses(testCase.input);

      let pass = true;

      try {
        testCase.assert(result);
      } catch (error) {
        pass = false;
        throw error;
      } finally {
        rows.push({
          name: testCase.name,
          input: testCase.input.rawText,
          outcome: result.outcome,
          recoveredText: result.recoveredText,
          reason: result.reason,
          userReplyMessage: result.userReplyMessage,
          pass
        });
      }
    }

    console.table(rows);
  }, 120_000);
});
