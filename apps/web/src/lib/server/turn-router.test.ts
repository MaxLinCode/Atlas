import { describe, expect, it } from "vitest";

import { routeTelegramTurn } from "./turn-router";

describe("turn router", () => {
  it("routes mutation turns as write-capable", async () => {
    const result = await routeTelegramTurn(
      {
        rawText: "Schedule review tomorrow at 9",
        normalizedText: "Schedule review tomorrow at 9",
        recentTurns: [],
      },
      {
        classifyTurn: async () => ({
          route: "mutation",
          reason: "Direct scheduling request."
        })
      }
    );

    expect(result).toMatchObject({
      route: "mutation",
      writesAllowed: true
    });
  });

  it("routes conversation turns as non-writing", async () => {
    const result = await routeTelegramTurn(
      {
        rawText: "Can you help me prioritize this week?",
        normalizedText: "Can you help me prioritize this week?",
        recentTurns: [],
      },
      {
        classifyTurn: async () => ({
          route: "conversation",
          reason: "Planning dialogue request."
        })
      }
    );

    expect(result).toMatchObject({
      route: "conversation",
      writesAllowed: false
    });
  });

  it("keeps mixed turns non-writing in the first slice", async () => {
    const result = await routeTelegramTurn(
      {
        rawText: "I might move this to Friday, what do you think?",
        normalizedText: "I might move this to Friday, what do you think?",
        recentTurns: [],
      },
      {
        classifyTurn: async () => ({
          route: "conversation_then_mutation",
          reason: "Mixed turn should discuss first."
        })
      }
    );

    expect(result).toMatchObject({
      route: "conversation_then_mutation",
      writesAllowed: false
    });
  });

  it("routes confirmed mutation turns as write-capable", async () => {
    const result = await routeTelegramTurn(
      {
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
      {
        classifyTurn: async () => ({
          route: "confirmed_mutation",
          reason: "The user is confirming a recent concrete scheduling proposal."
        })
      }
    );

    expect(result).toMatchObject({
      route: "confirmed_mutation",
      writesAllowed: true
    });
  });
});
