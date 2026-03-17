import { describe, expect, it } from "vitest";

import { buildConversationResponse } from "./conversation-response";

describe("conversation response service", () => {
  it("returns a model-backed reply for conversation turns", async () => {
    const result = await buildConversationResponse(
      {
        route: "conversation",
        rawText: "How should I prioritize this week?",
        normalizedText: "How should I prioritize this week?"
      },
      {
        respond: async () => ({
          reply: "Start with the deadline-driven work, then group the rest into one planning block."
        })
      }
    );

    expect(result.reply).toContain("deadline-driven work");
  });

  it("returns a model-backed reply for mixed turns without writing", async () => {
    const result = await buildConversationResponse(
      {
        route: "conversation_then_mutation",
        rawText: "Could we move it to tomorrow morning?",
        normalizedText: "Could we move it to tomorrow morning?"
      },
      {
        respond: async () => ({
          reply: "We can talk through options for tomorrow morning first, then make the change after you confirm."
        })
      }
    );

    expect(result.reply).toContain("after you confirm");
  });

  it("rejects empty conversation input", async () => {
    await expect(
      buildConversationResponse({
        route: "conversation",
        rawText: "   ",
        normalizedText: "   "
      })
    ).rejects.toThrow("must include non-empty rawText and normalizedText");
  });
});
