import { beforeAll, describe, expect, it } from "vitest";
import type { ConversationTurn } from "@atlas/core";

import {
  respondToConversationTurnWithResponses,
  summarizeConversationMemoryWithResponses,
  type ConversationResponseInput
} from "../openai";

type ConversationContextEvalCase = {
  name: string;
  input: Omit<ConversationResponseInput, "memorySummary">;
  assert: (reply: string, memorySummary: string | null) => void;
};

const DENTIST_TURNS: ConversationTurn[] = [
  {
    role: "user",
    text: "Create a dentist reminder for next week.",
    createdAt: "2026-03-16T16:00:00.000Z"
  },
  {
    role: "assistant",
    text: "It sounds like you want a dentist reminder next week, but I have not treated that as confirmed state yet.",
    createdAt: "2026-03-16T16:01:00.000Z"
  }
];

const PRIORITIZATION_TURNS: ConversationTurn[] = [
  {
    role: "user",
    text: "I have too much going on this week.",
    createdAt: "2026-03-16T16:10:00.000Z"
  },
  {
    role: "assistant",
    text: "We can sort it by deadlines and energy.",
    createdAt: "2026-03-16T16:11:00.000Z"
  }
];

const CONVERSATION_CONTEXT_EVAL_CASES: ConversationContextEvalCase[] = [
  {
    name: "mixed-turn reference uses recent context and stays discuss-first",
    input: {
      route: "conversation_then_mutation",
      normalizedText: "Could we move it to Friday morning instead?",
      recentTurns: DENTIST_TURNS
    },
    assert: (reply, memorySummary) => {
      expect(memorySummary).toMatch(/dentist|reminder/i);
      expect(reply).toMatch(/friday|morning/i);
      expect(reply).toMatch(/it seems|if you mean|sounds like|recent exchange/i);
      expect(reply).toMatch(/confirm|later|talk through|discuss/i);
      expect(reply).not.toMatch(/\b(i|we) moved\b/i);
    }
  },
  {
    name: "write-adjacent question stays hedged",
    input: {
      route: "conversation",
      normalizedText: "Did you already create that?",
      recentTurns: DENTIST_TURNS
    },
    assert: (reply, memorySummary) => {
      expect(memorySummary).toMatch(/dentist|reminder/i);
      expect(reply).toMatch(/if you mean|sounds like|recent exchange|not treating/i);
      expect(reply).not.toMatch(/\b(i|we) created\b/i);
      expect(reply).not.toMatch(/\bit already exists\b/i);
    }
  },
  {
    name: "planning dialogue uses recent continuity",
    input: {
      route: "conversation",
      normalizedText: "How should I prioritize tomorrow?",
      recentTurns: PRIORITIZATION_TURNS
    },
    assert: (reply, memorySummary) => {
      expect(memorySummary).toMatch(/week|deadlines|energy|priorit/i);
      expect(reply).toMatch(/priorit|deadline|energy|tomorrow/i);
    }
  }
];

beforeAll(() => {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required to run the manual conversation-context eval.");
  }

  process.env.DATABASE_URL ??= "postgresql://manual:manual@localhost:5432/manual_eval";
  process.env.TELEGRAM_BOT_TOKEN ??= "manual-telegram-token";
  process.env.TELEGRAM_WEBHOOK_SECRET ??= "manual-telegram-webhook-secret";
});

describe.sequential("manual conversation context eval", () => {
  it("checks curated continuity cases against the live OpenAI prompts", async () => {
    const rows: Array<{
      name: string;
      route: ConversationResponseInput["route"];
      pass: boolean;
      memorySummary: string | null;
      reply: string;
    }> = [];

    for (const testCase of CONVERSATION_CONTEXT_EVAL_CASES) {
      const summary = await summarizeConversationMemoryWithResponses({
        recentTurns: testCase.input.recentTurns
      });
      const result = await respondToConversationTurnWithResponses({
        ...testCase.input,
        memorySummary: summary.summary
      });

      let pass = true;

      try {
        testCase.assert(result.reply, summary.summary);
      } catch (error) {
        pass = false;
        throw error;
      } finally {
        rows.push({
          name: testCase.name,
          route: testCase.input.route,
          pass,
          memorySummary: summary.summary,
          reply: result.reply
        });
      }
    }

    console.table(rows);
  }, 120_000);
});
