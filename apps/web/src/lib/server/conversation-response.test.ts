import { describe, expect, it, vi } from "vitest";

import { buildConversationResponse } from "./conversation-response";

describe("conversation response service", () => {
  it("returns a model-backed reply for conversation turns", async () => {
    const respond = vi.fn(async () => ({
      reply: "Start with the deadline-driven work, then group the rest into one planning block."
    }));
    const result = await buildConversationResponse(
      {
        route: "conversation",
        rawText: "How should I prioritize this week?",
        normalizedText: "How should I prioritize this week?",
        recentTurns: [
          {
            role: "user",
            text: "I have too much going on this week.",
            createdAt: "2026-03-16T16:00:00.000Z"
          }
        ],
        memorySummary: "The user wants help prioritizing the current week."
      },
      {
        respond
      }
    );

    expect(result.reply).toContain("deadline-driven work");
    expect(respond).toHaveBeenCalledWith({
      route: "conversation",
      rawText: "How should I prioritize this week?",
      normalizedText: "How should I prioritize this week?",
      recentTurns: [
        {
          role: "user",
          text: "I have too much going on this week.",
          createdAt: "2026-03-16T16:00:00.000Z"
        }
      ],
      memorySummary: "The user wants help prioritizing the current week."
    });
  });

  it("returns a model-backed reply for mixed turns without writing", async () => {
    const result = await buildConversationResponse(
      {
        route: "conversation_then_mutation",
        rawText: "Could we move it to tomorrow morning?",
        normalizedText: "Could we move it to tomorrow morning?",
        recentTurns: [
          {
            role: "assistant",
            text: "It sounds like you were talking about the dentist reminder.",
            createdAt: "2026-03-16T16:01:00.000Z"
          }
        ],
        memorySummary: "The recent exchange is about the dentist reminder."
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
        normalizedText: "   ",
        recentTurns: [],
        memorySummary: null
      })
    ).rejects.toThrow("must include non-empty rawText and normalizedText");
  });
});
