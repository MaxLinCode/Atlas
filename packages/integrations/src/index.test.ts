import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDefaultUserProfile, buildTelegramFollowUpIdempotencyKey } from "@atlas/core";

import {
  recoverConfirmedMutationWithResponses,
  respondToConversationTurnWithResponses,
  getDefaultCalendarAdapter,
  planInboxItemWithResponses,
  routeTurnWithResponses,
  summarizeConversationMemoryWithResponses,
  resetCalendarAdapterForTests,
  sendTelegramMessage
} from "./index";

const ORIGINAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET
};

function restoreEnv(name: keyof typeof ORIGINAL_ENV) {
  const value = ORIGINAL_ENV[name];

  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

beforeEach(() => {
  process.env.DATABASE_URL = "postgres://atlas:atlas@localhost:5432/atlas";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.TELEGRAM_BOT_TOKEN = "test-telegram-token";
  process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
  resetCalendarAdapterForTests();
});

afterEach(() => {
  restoreEnv("DATABASE_URL");
  restoreEnv("OPENAI_API_KEY");
  restoreEnv("TELEGRAM_BOT_TOKEN");
  restoreEnv("TELEGRAM_WEBHOOK_SECRET");
});

describe("integrations", () => {
  it("creates and updates task-backed calendar events through the adapter contract", async () => {
    resetCalendarAdapterForTests();
    const adapter = getDefaultCalendarAdapter();
    const created = await adapter.createEvent({
      title: "Review launch checklist",
      startAt: "2026-03-17T17:00:00.000Z",
      endAt: "2026-03-17T18:00:00.000Z"
    });
    const updated = await adapter.updateEvent({
      externalCalendarEventId: created.externalCalendarEventId,
      externalCalendarId: created.externalCalendarId,
      title: "Review launch checklist",
      startAt: "2026-03-18T17:00:00.000Z",
      endAt: "2026-03-18T18:00:00.000Z"
    });

    expect(updated.externalCalendarEventId).toBe(created.externalCalendarEventId);
    expect(updated.scheduledStartAt).toBe("2026-03-18T17:00:00.000Z");
  });

  it("parses structured inbox planning output from the Responses API client", async () => {
    const result = await planInboxItemWithResponses(
      {
        inboxItem: {
          id: "inbox-1",
          userId: "123",
          sourceEventId: "event-1",
          rawText: "Submit taxes tomorrow at 3pm",
          normalizedText: "Submit taxes tomorrow at 3pm",
          processingStatus: "received",
          linkedTaskIds: []
        },
        userProfile: buildDefaultUserProfile("123"),
        tasks: [],
        scheduleBlocks: []
      },
      {
        responses: {
          parse: async () => ({
            output_parsed: {
              confidence: 0.91,
              summary: "Create and schedule a tax task.",
              actions: [
                {
                  type: "create_task",
                  alias: "new_task_1",
                  title: "Submit taxes",
                  priority: "medium",
                  urgency: "high"
                },
                {
                  type: "create_schedule_block",
                  taskRef: {
                    kind: "created_task",
                    alias: "new_task_1"
                  },
                  scheduleConstraint: {
                    dayOffset: 1,
                    explicitHour: 15,
                    minute: 0,
                    preferredWindow: null,
                    sourceText: "tomorrow at 3pm"
                  },
                  reason: "The user asked for tomorrow at 3pm."
                }
              ]
            }
          })
        }
      }
    );

    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]?.type).toBe("create_task");
  });

  it("rejects malformed structured Responses API output", async () => {
    await expect(
      planInboxItemWithResponses(
        {
          inboxItem: {
            id: "inbox-1",
            userId: "123",
            sourceEventId: "event-1",
            rawText: "Move it to 3pm",
            normalizedText: "Move it to 3pm",
            processingStatus: "received",
            linkedTaskIds: []
          },
          userProfile: buildDefaultUserProfile("123"),
          tasks: [],
          scheduleBlocks: []
        },
        {
          responses: {
            parse: async () => ({
              output_parsed: {
                confidence: 2,
                summary: "Bad output",
                actions: []
              }
            })
          }
        }
      )
    ).rejects.toThrow();
  });

  it("parses structured turn routing output from the Responses API client", async () => {
    const result = await routeTurnWithResponses(
      {
        rawText: "Can you help me plan tomorrow first?",
        normalizedText: "Can you help me plan tomorrow first?",
        recentTurns: [],
      },
      {
        responses: {
          parse: async () => ({
            output_parsed: {
              route: "conversation_then_mutation",
              reason: "This is a mixed discussion and scheduling turn."
            }
          })
        }
      }
    );

    expect(result).toMatchObject({
      route: "conversation_then_mutation"
    });
  });

  it("rejects malformed structured turn routing output", async () => {
    await expect(
      routeTurnWithResponses(
        {
          rawText: "schedule this",
          normalizedText: "schedule this",
          recentTurns: [],
        },
        {
          responses: {
            parse: async () => ({
              output_parsed: {
                route: "write_now",
                reason: ""
              }
            })
          }
        }
      )
    ).rejects.toThrow();
  });

  it("accepts confirmed mutation as a valid structured turn route", async () => {
    const result = await routeTurnWithResponses(
      {
        rawText: "Yes",
        normalizedText: "Yes",
        recentTurns: [
          {
            role: "assistant",
            text: "Would you like me to schedule it at 3pm?",
            createdAt: "2026-03-17T16:00:00.000Z"
          }
        ],
      },
      {
        responses: {
          parse: async () => ({
            output_parsed: {
              route: "confirmed_mutation",
              reason: "The latest turn confirms a recent concrete proposal."
            }
          })
        }
      }
    );

    expect(result.route).toBe("confirmed_mutation");
  });

  it("parses structured confirmed mutation recovery output from the Responses API client", async () => {
    const result = await recoverConfirmedMutationWithResponses(
      {
        rawText: "Yes",
        normalizedText: "Yes",
        recentTurns: [
          {
            role: "assistant",
            text: "Would you like me to schedule the dentist reminder at 3pm?",
            createdAt: "2026-03-17T16:00:00.000Z"
          },
          {
            role: "user",
            text: "Yes",
            createdAt: "2026-03-17T16:01:00.000Z"
          }
        ],
        memorySummary: "The recent exchange contains a concrete 3pm proposal for the dentist reminder."
      },
      {
        responses: {
          parse: async () => ({
            output_parsed: {
              outcome: "recovered",
              recoveredRawText: "Schedule the dentist reminder at 3pm.",
              recoveredNormalizedText: "Schedule the dentist reminder at 3pm.",
              reason: "The user confirmed the recent concrete proposal."
            }
          })
        }
      }
    );

    expect(result).toMatchObject({
      outcome: "recovered",
      recoveredNormalizedText: "Schedule the dentist reminder at 3pm."
    });
  });

  it("rejects malformed confirmed mutation recovery output", async () => {
    await expect(
      recoverConfirmedMutationWithResponses(
        {
          rawText: "Friday works",
          normalizedText: "Friday works",
          recentTurns: [
            {
              role: "assistant",
              text: "I can move it to Friday at 3pm.",
              createdAt: "2026-03-17T16:00:00.000Z"
            }
          ],
          memorySummary: "The recent exchange includes a Friday proposal."
        },
        {
          responses: {
            parse: async () => ({
              output_parsed: {
                outcome: "recovered",
                reason: "Missing recovered text."
              }
            })
          }
        }
      )
    ).rejects.toThrow();
  });

  it("parses structured conversation response output from the Responses API client", async () => {
    const result = await respondToConversationTurnWithResponses(
      {
        route: "conversation",
        rawText: "How should I plan tomorrow?",
        normalizedText: "How should I plan tomorrow?",
        recentTurns: [
          {
            role: "user",
            text: "I am overloaded this week.",
            createdAt: "2026-03-16T16:00:00.000Z"
          }
        ],
        memorySummary: "The user wants help prioritizing tomorrow."
      },
      {
        responses: {
          parse: async () => ({
            output_parsed: {
              reply: "Start by picking the one thing that must happen tomorrow, then give it the first focus block."
            }
          })
        }
      }
    );

    expect(result.reply).toContain("first focus block");
  });

  it("rejects malformed structured conversation response output", async () => {
    await expect(
      respondToConversationTurnWithResponses(
        {
          route: "conversation_then_mutation",
          rawText: "Could we move it to Friday?",
          normalizedText: "Could we move it to Friday?",
          recentTurns: [
            {
              role: "assistant",
              text: "It sounds like you mean the dentist reminder.",
              createdAt: "2026-03-16T16:01:00.000Z"
            }
          ],
          memorySummary: "The recent exchange is about a dentist reminder."
        },
        {
          responses: {
            parse: async () => ({
              output_parsed: {
                reply: ""
              }
            })
          }
        }
      )
    ).rejects.toThrow();
  });

  it("parses structured conversation memory summary output from the Responses API client", async () => {
    const result = await summarizeConversationMemoryWithResponses(
      {
        recentTurns: [
          {
            role: "user",
            text: "Can we move the dentist thing to Friday?",
            createdAt: "2026-03-16T16:00:00.000Z"
          },
          {
            role: "assistant",
            text: "If you mean the dentist reminder, Friday could work.",
            createdAt: "2026-03-16T16:01:00.000Z"
          }
        ]
      },
      {
        responses: {
          parse: async () => ({
            output_parsed: {
              summary: "Recent exchange likely refers to the dentist reminder and a possible Friday move."
            }
          })
        }
      }
    );

    expect(result.summary).toContain("dentist reminder");
  });

  it("rejects malformed conversation memory summary output", async () => {
    await expect(
      summarizeConversationMemoryWithResponses(
        {
          recentTurns: [
            {
              role: "user",
              text: "Did you already create that?",
              createdAt: "2026-03-16T16:00:00.000Z"
            }
          ]
        },
        {
          responses: {
            parse: async () => ({
              output_parsed: {
                summary: 42
              }
            })
          }
        }
      )
    ).rejects.toThrow();
  });

  it("sends a Telegram follow-up message through sendMessage", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 88,
            date: 1_700_000_000,
            chat: {
              id: "999",
              type: "private"
            },
            text: "Captured and scheduled Review launch checklist."
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    const result = await sendTelegramMessage(
      {
        chatId: "999",
        text: "Captured and scheduled Review launch checklist."
      },
      fetchMock
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottest-telegram-token/sendMessage",
      expect.objectContaining({
        method: "POST"
      })
    );
    expect(result.result.message_id).toBe(88);
  });

  it("builds a stable Telegram follow-up idempotency key", () => {
    expect(buildTelegramFollowUpIdempotencyKey("inbox-1")).toBe(
      "telegram:followup:inbox-item:inbox-1"
    );
  });

  it("includes Telegram error descriptions when sendMessage fails", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          ok: false,
          description: "Bad Request: chat not found"
        }),
        {
          status: 400,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    await expect(
      sendTelegramMessage(
        {
          chatId: "999",
          text: "Captured and scheduled Review launch checklist."
        },
        fetchMock
      )
    ).rejects.toThrow("Telegram sendMessage failed with status 400: Bad Request: chat not found.");
  });
});
