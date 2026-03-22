import type { ConversationTurn } from "@atlas/core";
import { expect } from "vitest";

import {
  respondToConversationTurnWithResponses,
  summarizeConversationMemoryWithResponses,
  type ConversationResponseInput
} from "../openai";
import type { EvalCaseResult, EvalSuiteResult } from "./shared";

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

const OIL_CHANGE_TURNS: ConversationTurn[] = [
  {
    role: "user",
    text: "Schedule the oil change.",
    createdAt: "2026-03-16T16:20:00.000Z"
  },
  {
    role: "assistant",
    text: "It sounds like you want to schedule the oil change.",
    createdAt: "2026-03-16T16:21:00.000Z"
  }
];

export const CONVERSATION_CONTEXT_EVAL_CASES: ConversationContextEvalCase[] = [
  {
    name: "mixed-turn reference uses recent context and stays discuss-first",
    input: {
      route: "conversation_then_mutation",
      rawText: "Could we move it to Friday morning instead?",
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
      rawText: "Did you already create that?",
      normalizedText: "Did you already create that?",
      recentTurns: DENTIST_TURNS
    },
    assert: (reply, memorySummary) => {
      expect(memorySummary).toMatch(/dentist|reminder/i);
      expect(reply).toMatch(/if you mean|sounds like|recent exchange|confirmed state|from what we've discussed/i);
      expect(reply).not.toMatch(/\b(i|we) created\b/i);
      expect(reply).not.toMatch(/\bit already exists\b/i);
      expect(reply).not.toMatch(/\bI haven't created\b/i);
    }
  },
  {
    name: "planning dialogue uses recent continuity",
    input: {
      route: "conversation",
      rawText: "How should I prioritize tomorrow?",
      normalizedText: "How should I prioritize tomorrow?",
      recentTurns: PRIORITIZATION_TURNS
    },
    assert: (reply, memorySummary) => {
      expect(memorySummary).toMatch(/week|deadlines|energy|priorit/i);
      expect(reply).toMatch(/priorit|deadline|energy|tomorrow/i);
    }
  },
  {
    name: "unclear referent asks one narrow question",
    input: {
      route: "conversation",
      rawText: "Can you move that?",
      normalizedText: "Can you move that?",
      recentTurns: DENTIST_TURNS
    },
    assert: (reply, memorySummary) => {
      expect(memorySummary).toMatch(/dentist|reminder/i);
      expect(reply).toMatch(/if you mean|which|do you mean|sounds like/i);
      expect(reply).toMatch(/\?|confirm/i);
      expect(reply.split("?").filter(Boolean).length).toBeLessThanOrEqual(2);
    }
  },
  {
    name: "delegated slot choice does not ask for an exact hour",
    input: {
      route: "conversation_then_mutation",
      rawText: "Schedule it for me and pick an open spot.",
      normalizedText: "Schedule it for me and pick an open spot.",
      recentTurns: OIL_CHANGE_TURNS
    },
    assert: (reply, memorySummary) => {
      expect(memorySummary).toMatch(/oil change|schedule/i);
      expect(reply).not.toMatch(
        /exact time|specific time|what time works|what time should|which time|what day|particular day|preferred date|time frame|soonest available|location|provider|shop|service center|where should/i
      );
      expect(reply).not.toMatch(/what time/i);
      expect(reply).not.toMatch(/day in mind/i);
      expect(reply).toMatch(/open spot|pick|schedule|oil change|confirm|if you mean|sounds like/i);
    }
  },
  {
    name: "bare scheduling does not ask follow-up timing questions",
    input: {
      route: "conversation_then_mutation",
      rawText: "Schedule an oil change.",
      normalizedText: "Schedule an oil change.",
      recentTurns: []
    },
    assert: (reply) => {
      expect(reply).not.toMatch(
        /\?|what time|what day|particular day|preferred date|time frame|soonest available|day in mind|specific time|exact time|location|provider|shop|service center|where should/i
      );
      expect(reply).toMatch(/schedule|oil change|next opening|next available|pick|slot/i);
    }
  }
];

export async function runConversationContextEvalSuite(): Promise<EvalSuiteResult> {
  const startedAt = Date.now();
  const cases: EvalCaseResult[] = [];

  for (const testCase of CONVERSATION_CONTEXT_EVAL_CASES) {
    const summary = await summarizeConversationMemoryWithResponses({
      recentTurns: testCase.input.recentTurns
    });
    const result = await respondToConversationTurnWithResponses({
      ...testCase.input,
      memorySummary: summary.summary
    });

    try {
      testCase.assert(result.reply, summary.summary);
      cases.push({
        name: testCase.name,
        pass: true,
        details: {
          route: testCase.input.route,
          memorySummary: summary.summary,
          reply: result.reply
        }
      });
    } catch (error) {
      cases.push({
        name: testCase.name,
        pass: false,
        details: {
          route: testCase.input.route,
          memorySummary: summary.summary,
          reply: result.reply
        },
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const passed = cases.filter((testCase) => testCase.pass).length;

  return {
    suiteName: "conversation-context",
    total: cases.length,
    passed,
    failed: cases.length - passed,
    durationMs: Date.now() - startedAt,
    cases
  };
}
