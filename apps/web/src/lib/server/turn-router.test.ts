import { describe, expect, it } from "vitest";

import { routeTelegramTurn } from "./turn-router";

describe("turn router", () => {
  it("routes mutation turns as write-capable", async () => {
    const result = await routeTelegramTurn(
      {
        rawText: "Schedule review tomorrow at 9",
        normalizedText: "Schedule review tomorrow at 9"
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
        normalizedText: "Can you help me prioritize this week?"
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
        normalizedText: "I might move this to Friday, what do you think?"
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
});
