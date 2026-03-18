import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxPlanningOutput } from "@atlas/core";
import {
  getDefaultInboxProcessingStore,
  listPlannerRunsForTests,
  listScheduleBlocksForTests,
  listTasksForTests,
  listInboxItemsForTests,
  listIncomingBotEventsForTests,
  listOutgoingBotEventsForTests,
  recordIncomingTelegramMessageIfNew,
  recordOutgoingTelegramMessageIfNew,
  resetInboxProcessingStoreForTests,
  resetIncomingTelegramIngressStoreForTests,
  seedInboxItemForProcessingTests,
  updateOutgoingTelegramMessage
} from "@atlas/db";
import { resetCalendarAdapterForTests } from "@atlas/integrations";

import { handleTelegramWebhook } from "@/lib/server/telegram-webhook";

const { sendTelegramMessageMock, routeTurnWithResponsesMock } = vi.hoisted(() => ({
  sendTelegramMessageMock: vi.fn(),
  routeTurnWithResponsesMock: vi.fn()
}));

vi.mock("@atlas/integrations", async () => {
  const actual = await vi.importActual<typeof import("@atlas/integrations")>("@atlas/integrations");

  return {
    ...actual,
    getDefaultCalendarAdapter: () => actual.getDefaultCalendarAdapter(),
    planInboxItemWithResponses: async () => ({
      confidence: 0.9,
      summary: "Captured and scheduled Review launch checklist.",
      actions: [
        {
          type: "create_task",
          alias: "new_task_1",
          title: "Review launch checklist",
          priority: "medium",
          urgency: "medium"
        },
        {
          type: "create_schedule_block",
          taskRef: {
            kind: "created_task",
            alias: "new_task_1"
          },
          scheduleConstraint: {
            dayOffset: 0,
            explicitHour: 9,
            minute: 0,
            preferredWindow: null,
            sourceText: "default next slot"
          },
          reason: "Schedule the new task in the next slot."
        }
      ]
    }),
    routeTurnWithResponses: routeTurnWithResponsesMock,
    sendTelegramMessage: sendTelegramMessageMock
  };
});

const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
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

function buildRequest(body: unknown, secret = "test-webhook-secret") {
  return new Request("http://localhost/api/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [TELEGRAM_SECRET_HEADER]: secret
    },
    body: JSON.stringify(body)
  });
}

afterEach(() => {
  restoreEnv("DATABASE_URL");
  restoreEnv("OPENAI_API_KEY");
  restoreEnv("TELEGRAM_BOT_TOKEN");
  restoreEnv("TELEGRAM_WEBHOOK_SECRET");
});

beforeEach(() => {
  process.env.DATABASE_URL = "postgres://atlas:atlas@localhost:5432/atlas";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.TELEGRAM_BOT_TOKEN = "test-telegram-token";
  process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
  resetCalendarAdapterForTests();
  sendTelegramMessageMock.mockReset();
  routeTurnWithResponsesMock.mockReset();
  routeTurnWithResponsesMock.mockResolvedValue({
    route: "mutation",
    reason: "Direct scheduling request."
  });
  sendTelegramMessageMock.mockResolvedValue({
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
  });
  resetIncomingTelegramIngressStoreForTests();
  resetInboxProcessingStoreForTests();
});

describe("telegram webhook route", () => {
  it("rejects requests with the wrong Telegram webhook secret", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const response = await handleTelegramWebhook(
      buildRequest(
        {
          update_id: 1
        },
        "wrong-secret"
      ),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(401);
    await expect(Promise.resolve(response.body)).resolves.toMatchObject({
      accepted: false,
      error: "invalid_webhook_secret"
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(0);
    expect(listInboxItemsForTests()).toHaveLength(0);
  });

  it("normalizes a Telegram text message and hands it to app services", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 42,
        message: {
          message_id: 7,
          date: 1_700_000_000,
          text: " Review   launch checklist ",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin",
            username: "maxl",
            language_code: "en"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    await expect(Promise.resolve(response.body)).resolves.toMatchObject({
      accepted: true,
      idempotencyKey: "telegram:webhook:update:42",
      ingestion: {
        source: "telegram",
        delivery: "webhook",
        updateId: 42,
        messageId: 7,
        chatId: "999",
        rawText: " Review   launch checklist ",
        normalizedText: "Review launch checklist",
        user: {
          telegramUserId: "123",
          displayName: "Max Lin",
          username: "maxl",
          languageCode: "en",
          chatType: "private"
        }
      },
      inboxItem: {
        userId: "123",
        rawText: " Review   launch checklist ",
        normalizedText: "Review launch checklist",
        processingStatus: "received",
        linkedTaskIds: []
      },
      processing: {
        outcome: "planned"
      },
      outboundDelivery: {
        status: "sent",
        attempts: 1
      }
    });
    expect(response.body).toMatchObject({
      outboundDelivery: {
        idempotencyKey: expect.any(String),
        message: {
          message_id: 88
        }
      }
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
    expect(listOutgoingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(1);
    expect(listPlannerRunsForTests()).toHaveLength(1);
    expect(listTasksForTests()).toHaveLength(1);
    expect(listScheduleBlocksForTests()).toHaveLength(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: "999",
      text: "Captured and scheduled Review launch checklist."
    });
  });

  it("preserves mutation behavior when the turn router explicitly returns mutation", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 46,
        message: {
          message_id: 11,
          date: 1_700_000_004,
          text: " Review   launch checklist ",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests,
        turnRouter: async () => ({
          route: "mutation",
          reason: "Direct scheduling request.",
          writesAllowed: true
        })
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      turnRoute: "mutation",
      processing: {
        outcome: "planned"
      },
      outboundDelivery: {
        status: "sent",
        attempts: 1
      }
    });
    expect(listPlannerRunsForTests()).toHaveLength(1);
    expect(listTasksForTests()).toHaveLength(1);
    expect(listScheduleBlocksForTests()).toHaveLength(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
  });

  it("treats confirmed mutation turns as write-capable when recovery finds one concrete proposal", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    await recordOutgoingTelegramMessageIfNew({
      userId: "123",
      eventType: "telegram_followup_message",
      idempotencyKey: "telegram:followup:proposal-confirmed",
      payload: {
        chatId: "999",
        text: "Would you like me to schedule it at 3pm?",
        attempts: 0
      },
      retryState: "sending"
    });
    await updateOutgoingTelegramMessage({
      idempotencyKey: "telegram:followup:proposal-confirmed",
      payload: {
        chatId: "999",
        text: "Would you like me to schedule it at 3pm?",
        attempts: 1
      },
      retryState: "sent"
    });
    const planner = vi.fn(async (): Promise<InboxPlanningOutput> => ({
      confidence: 0.9,
      summary: "Scheduled the dentist reminder for 3pm.",
      actions: [
        {
          type: "create_task",
          alias: "new_task_1",
          title: "Dentist reminder",
          priority: "medium",
          urgency: "medium"
        },
        {
          type: "create_schedule_block",
          taskRef: {
            kind: "created_task",
            alias: "new_task_1"
          },
          scheduleConstraint: {
            dayOffset: 0,
            explicitHour: 15,
            minute: 0,
            preferredWindow: null,
            sourceText: "at 3pm"
          },
          reason: "The user confirmed the proposed 3pm slot."
        }
      ]
    }));
    const confirmedMutationRecoverer = vi.fn(async () => ({
      outcome: "recovered" as const,
      recoveredRawText: "Schedule the dentist reminder at 3pm.",
      recoveredNormalizedText: "Schedule the dentist reminder at 3pm.",
      reason: "The user confirmed the concrete 3pm proposal."
    }));

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 52,
        message: {
          message_id: 17,
          date: 1_700_000_010,
          text: "Yes",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests,
        planner,
        conversationMemorySummarizer: async () => ({
          summary: "The assistant proposed a concrete 3pm schedule and the user is now confirming it."
        }),
        confirmedMutationRecoverer,
        turnRouter: async () => ({
          route: "confirmed_mutation",
          reason: "The user is confirming a recent concrete proposal.",
          writesAllowed: true
        })
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      turnRoute: "confirmed_mutation",
      processing: {
        outcome: "planned"
      }
    });
    expect(confirmedMutationRecoverer).toHaveBeenCalledWith(
      expect.objectContaining({
        rawText: "Yes",
        recentTurns: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            text: "Would you like me to schedule it at 3pm?"
          }),
          expect.objectContaining({
            role: "user",
            text: "Yes"
          })
        ])
      })
    );
    expect(planner).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxItem: expect.objectContaining({
          rawText: "Schedule the dentist reminder at 3pm.",
          normalizedText: "Schedule the dentist reminder at 3pm."
        })
      })
    );
    expect(listPlannerRunsForTests()).toHaveLength(1);
    expect(listTasksForTests()).toHaveLength(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
  });

  it("supports broader follow-up refinements in confirmed mutation turns", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    const planner = vi.fn(async (): Promise<InboxPlanningOutput> => ({
      confidence: 0.88,
      summary: "Moved the scheduled review block one hour later.",
      actions: [
        {
          type: "move_schedule_block",
          blockRef: {
            alias: "schedule_block_1"
          },
          scheduleConstraint: {
            dayOffset: 0,
            explicitHour: 16,
            minute: 0,
            preferredWindow: null,
            sourceText: "1 hour later"
          },
          reason: "The user asked to push it 1 hour later."
        }
      ]
    }));

    seedInboxItemForProcessingTests({
      id: "inbox-existing",
      userId: "123",
      sourceEventId: "event-existing",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: []
    });
    await handleTelegramWebhook(
      buildRequest({
        update_id: 53,
        message: {
          message_id: 18,
          date: 1_700_000_011,
          text: "Review launch checklist",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );
    sendTelegramMessageMock.mockClear();

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 54,
        message: {
          message_id: 19,
          date: 1_700_000_012,
          text: "push it 1 hour later",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests,
        planner,
        conversationMemorySummarizer: async () => ({
          summary: "The recent exchange includes one concrete proposal to move the existing review block one hour later."
        }),
        confirmedMutationRecoverer: async () => ({
          outcome: "recovered",
          recoveredRawText: "Move the scheduled review block 1 hour later.",
          recoveredNormalizedText: "Move the scheduled review block 1 hour later.",
          reason: "The user refined the recent concrete proposal."
        }),
        turnRouter: async () => ({
          route: "confirmed_mutation",
          reason: "The user is refining a recent concrete proposal.",
          writesAllowed: true
        })
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      turnRoute: "confirmed_mutation",
      processing: {
        outcome: "updated_schedule"
      }
    });
    expect(planner).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxItem: expect.objectContaining({
          rawText: "Move the scheduled review block 1 hour later."
        })
      })
    );
  });

  it("falls back to clarification when confirmed mutation recovery is ambiguous", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    const planner = vi.fn();

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 55,
        message: {
          message_id: 20,
          date: 1_700_000_013,
          text: "Yes",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests,
        planner,
        conversationMemorySummarizer: async () => ({
          summary: "There were multiple possible recent proposals."
        }),
        confirmedMutationRecoverer: async () => ({
          outcome: "needs_clarification",
          reason: "I have two recent proposals in view. Which one do you want me to apply?"
        }),
        turnRouter: async () => ({
          route: "confirmed_mutation",
          reason: "This looks like a confirmation but the target is ambiguous.",
          writesAllowed: true
        })
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      turnRoute: "confirmed_mutation",
      processing: {
        outcome: "conversation_replied",
        reply: "I have two recent proposals in view. Which one do you want me to apply?"
      }
    });
    expect(planner).not.toHaveBeenCalled();
    expect(listPlannerRunsForTests()).toHaveLength(0);
    expect(listTasksForTests()).toHaveLength(0);
    expect(listScheduleBlocksForTests()).toHaveLength(0);
  });

  it("keeps conversation turns non-writing", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    vi.useFakeTimers();

    const setNow = (value: string) => {
      vi.setSystemTime(new Date(value));
    };

    try {
      setNow("2026-03-16T16:00:00.000Z");
      await recordIncomingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_message",
        idempotencyKey: "telegram:webhook:update:39",
        payload: {
          update_id: 39
        },
        rawText: "Earlier user one",
        normalizedText: "Earlier user one"
      });
      setNow("2026-03-16T16:01:00.000Z");
      await recordOutgoingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_followup_message",
        idempotencyKey: "telegram:followup:route-1",
        payload: {
          chatId: "999",
          text: "Earlier assistant one",
          attempts: 0
        },
        retryState: "sending"
      });
      await updateOutgoingTelegramMessage({
        idempotencyKey: "telegram:followup:route-1",
        payload: {
          chatId: "999",
          text: "Earlier assistant one",
          attempts: 1
        },
        retryState: "sent"
      });
      setNow("2026-03-16T16:02:00.000Z");
      await recordIncomingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_message",
        idempotencyKey: "telegram:webhook:update:40",
        payload: {
          update_id: 40
        },
        rawText: "Earlier user two",
        normalizedText: "Earlier user two"
      });
      setNow("2026-03-16T16:03:00.000Z");
      await recordOutgoingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_followup_message",
        idempotencyKey: "telegram:followup:route-2",
        payload: {
          chatId: "999",
          text: "Failed assistant turn",
          attempts: 0
        },
        retryState: "sending"
      });
      await updateOutgoingTelegramMessage({
        idempotencyKey: "telegram:followup:route-2",
        payload: {
          chatId: "999",
          text: "Failed assistant turn",
          attempts: 1
        },
        retryState: "failed"
      });
      setNow("2026-03-16T16:04:00.000Z");
      await recordIncomingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_message",
        idempotencyKey: "telegram:webhook:update:41",
        payload: {
          update_id: 41
        },
        rawText: "Earlier user three",
        normalizedText: "Earlier user three"
      });
      setNow("2026-03-16T16:05:00.000Z");
      await recordOutgoingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_followup_message",
        idempotencyKey: "telegram:followup:route-3",
        payload: {
          chatId: "999",
          text: "Earlier assistant two",
          attempts: 0
        },
        retryState: "sending"
      });
      await updateOutgoingTelegramMessage({
        idempotencyKey: "telegram:followup:route-3",
        payload: {
          chatId: "999",
          text: "Earlier assistant two",
          attempts: 1
        },
        retryState: "sent"
      });
      setNow("2026-03-16T16:06:00.000Z");
      await recordIncomingTelegramMessageIfNew({
        userId: "123",
        eventType: "telegram_message",
        idempotencyKey: "telegram:webhook:update:42",
        payload: {
          update_id: 42
        },
        rawText: "Earlier user four",
        normalizedText: "Earlier user four"
      });
      const conversationMemorySummarizer = vi.fn(async () => ({
        summary: "The user wants weekly prioritization help."
      }));
      const conversationResponder = vi.fn(async () => ({
        reply: "Let's sort the week by deadline and energy first."
      }));

      setNow("2026-03-16T16:07:00.000Z");
      const response = await handleTelegramWebhook(
        buildRequest({
          update_id: 47,
          message: {
            message_id: 12,
            date: 1_700_000_005,
            text: "How should I prioritize this week?",
            chat: {
              id: 999,
              type: "private"
            },
            from: {
              id: 123,
              is_bot: false,
              first_name: "Max",
              last_name: "Lin"
            }
          }
        }),
        {
          store: getDefaultInboxProcessingStore(),
          primeProcessingStore: seedInboxItemForProcessingTests,
          conversationMemorySummarizer,
          conversationResponder,
          turnRouter: async () => ({
            route: "conversation",
            reason: "Planning dialogue request.",
            writesAllowed: false
          })
        }
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        accepted: true,
        turnRoute: "conversation",
        processing: {
          outcome: "conversation_replied",
          reply: "Let's sort the week by deadline and energy first."
        },
        outboundDelivery: {
          status: "sent",
          attempts: 1
        }
      });
      expect(listIncomingBotEventsForTests()).toHaveLength(5);
      expect(listInboxItemsForTests()).toHaveLength(5);
      expect(listPlannerRunsForTests()).toHaveLength(0);
      expect(listTasksForTests()).toHaveLength(0);
      expect(listScheduleBlocksForTests()).toHaveLength(0);
      expect(listOutgoingBotEventsForTests()).toHaveLength(4);
      expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
      expect(conversationMemorySummarizer).toHaveBeenCalledWith({
        recentTurns: [
          {
            role: "assistant",
            text: "Earlier assistant one",
            createdAt: expect.any(String)
          },
          {
            role: "user",
            text: "Earlier user two",
            createdAt: expect.any(String)
          },
          {
            role: "user",
            text: "Earlier user three",
            createdAt: expect.any(String)
          },
          {
            role: "assistant",
            text: "Earlier assistant two",
            createdAt: expect.any(String)
          },
          {
            role: "user",
            text: "Earlier user four",
            createdAt: expect.any(String)
          },
          {
            role: "user",
            text: "How should I prioritize this week?",
            createdAt: expect.any(String)
          }
        ]
      });
      expect(conversationResponder).toHaveBeenCalledWith({
        route: "conversation",
        rawText: "How should I prioritize this week?",
        normalizedText: "How should I prioritize this week?",
        recentTurns: [
          {
            role: "assistant",
            text: "Earlier assistant one",
            createdAt: expect.any(String)
          },
          {
            role: "user",
            text: "Earlier user two",
            createdAt: expect.any(String)
          },
          {
            role: "user",
            text: "Earlier user three",
            createdAt: expect.any(String)
          },
          {
            role: "assistant",
            text: "Earlier assistant two",
            createdAt: expect.any(String)
          },
          {
            role: "user",
            text: "Earlier user four",
            createdAt: expect.any(String)
          },
          {
            role: "user",
            text: "How should I prioritize this week?",
            createdAt: expect.any(String)
          }
        ],
        memorySummary: "The user wants weekly prioritization help."
      });
      expect(sendTelegramMessageMock).toHaveBeenCalledWith({
        chatId: "999",
        text: "Let's sort the week by deadline and energy first."
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps conversation_then_mutation turns non-writing on the first slice", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    const conversationResponder = vi.fn(async () => ({
      reply: "We can explore tomorrow morning options first, then I can make the change after you confirm."
    }));

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 48,
        message: {
          message_id: 13,
          date: 1_700_000_006,
          text: "Could we move it to tomorrow morning?",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests,
        conversationMemorySummarizer: async () => ({
          summary: "The user is discussing a possible move to tomorrow morning."
        }),
        conversationResponder,
        turnRouter: async () => ({
          route: "conversation_then_mutation",
          reason: "Mixed turn should discuss first.",
          writesAllowed: false
        })
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      turnRoute: "conversation_then_mutation",
      processing: {
        outcome: "conversation_replied",
        reply: "We can explore tomorrow morning options first, then I can make the change after you confirm."
      },
      outboundDelivery: {
        status: "sent",
        attempts: 1
      }
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(1);
    expect(listPlannerRunsForTests()).toHaveLength(0);
    expect(listTasksForTests()).toHaveLength(0);
    expect(listScheduleBlocksForTests()).toHaveLength(0);
    expect(listOutgoingBotEventsForTests()).toHaveLength(1);
    expect(conversationResponder).toHaveBeenCalledWith({
      route: "conversation_then_mutation",
      rawText: "Could we move it to tomorrow morning?",
      normalizedText: "Could we move it to tomorrow morning?",
      recentTurns: [
        {
          role: "user",
          text: "Could we move it to tomorrow morning?",
          createdAt: expect.any(String)
        }
      ],
      memorySummary: "The user is discussing a possible move to tomorrow morning."
    });
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledWith({
      chatId: "999",
      text: "We can explore tomorrow morning options first, then I can make the change after you confirm."
    });
  });

  it("falls back to recent turns when summary generation fails", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    const conversationResponder = vi.fn(async () => ({
      reply: "From our recent exchange, it sounds like you want to keep talking through it first."
    }));

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 49,
        message: {
          message_id: 14,
          date: 1_700_000_007,
          text: "Should we talk this through first?",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests,
        conversationMemorySummarizer: async () => {
          throw new Error("summary unavailable");
        },
        conversationResponder,
        turnRouter: async () => ({
          route: "conversation",
          reason: "Discussion turn.",
          writesAllowed: false
        })
      }
    );

    expect(response.status).toBe(200);
    expect(conversationResponder).toHaveBeenCalledWith({
      route: "conversation",
      rawText: "Should we talk this through first?",
      normalizedText: "Should we talk this through first?",
      recentTurns: [
        {
          role: "user",
          text: "Should we talk this through first?",
          createdAt: expect.any(String)
        }
      ],
      memorySummary: null
    });
    expect(listPlannerRunsForTests()).toHaveLength(0);
    expect(listTasksForTests()).toHaveLength(0);
    expect(listScheduleBlocksForTests()).toHaveLength(0);
  });

  it("keeps write-adjacent conversation replies hedged instead of making hard system claims", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 50,
        message: {
          message_id: 15,
          date: 1_700_000_008,
          text: "Did you already create that?",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests,
        conversationMemorySummarizer: async () => ({
          summary: "The recent exchange seems to be about a dentist reminder."
        }),
        conversationResponder: async () => ({
          reply: "From our recent exchange, it sounds like you mean the dentist reminder, but I am not treating that as confirmed state."
        }),
        turnRouter: async () => ({
          route: "conversation",
          reason: "Write-adjacent question still needs cautious conversational handling.",
          writesAllowed: false
        })
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      turnRoute: "conversation",
      processing: {
        outcome: "conversation_replied",
        reply: "From our recent exchange, it sounds like you mean the dentist reminder, but I am not treating that as confirmed state."
      }
    });
    expect(listPlannerRunsForTests()).toHaveLength(0);
    expect(listTasksForTests()).toHaveLength(0);
    expect(listScheduleBlocksForTests()).toHaveLength(0);
  });

  it("retries once when Telegram follow-up delivery fails before succeeding", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    sendTelegramMessageMock
      .mockRejectedValueOnce(new Error("temporary network error"))
      .mockResolvedValueOnce({
        ok: true,
        result: {
          message_id: 89,
          date: 1_700_000_001,
          chat: {
            id: "999",
            type: "private"
          },
          text: "Captured and scheduled Review launch checklist."
        }
      });

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 43,
        message: {
          message_id: 8,
          date: 1_700_000_001,
          text: " Review   launch checklist ",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      outboundDelivery: {
        status: "sent",
        attempts: 2
      }
    });
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(2);
    expect(listOutgoingBotEventsForTests()).toHaveLength(1);
  });

  it("accepts the webhook when both follow-up delivery attempts fail", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    sendTelegramMessageMock.mockRejectedValue(new Error("telegram unavailable"));

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 44,
        message: {
          message_id: 9,
          date: 1_700_000_002,
          text: " Review   launch checklist ",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      processing: {
        outcome: "planned"
      },
      outboundDelivery: {
        status: "failed",
        attempts: 2,
        error: "telegram unavailable"
      }
    });
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(2);
    expect(listOutgoingBotEventsForTests()).toHaveLength(1);
    expect(listOutgoingBotEventsForTests()[0]?.retryState).toBe("failed");
  });

  it("skips Telegram delivery when the follow-up idempotency key is already reserved", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const deliveryStore = {
      reserveOutgoingIfAbsent: async () => ({
        status: "duplicate" as const
      }),
      updateOutgoing: async () => {
        throw new Error("should not update duplicate outgoing delivery");
      }
    };

    const response = await handleTelegramWebhook(
      buildRequest({
        update_id: 45,
        message: {
          message_id: 10,
          date: 1_700_000_003,
          text: " Review   launch checklist ",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        deliveryStore,
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      outboundDelivery: {
        status: "duplicate",
        attempts: 0
      }
    });
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });

  it("short-circuits duplicate webhook deliveries before downstream processing", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const dependencies = {
      store: getDefaultInboxProcessingStore(),
      primeProcessingStore: seedInboxItemForProcessingTests
    };

    const firstResponse = await handleTelegramWebhook(
      buildRequest({
        update_id: 42,
        message: {
          message_id: 7,
          date: 1_700_000_000,
          text: " Review   launch checklist ",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      dependencies
    );

    const duplicateResponse = await handleTelegramWebhook(
      buildRequest({
        update_id: 42,
        message: {
          message_id: 7,
          date: 1_700_000_000,
          text: " Review   launch checklist ",
          chat: {
            id: 999,
            type: "private"
          },
          from: {
            id: 123,
            is_bot: false,
            first_name: "Max",
            last_name: "Lin"
          }
        }
      }),
      dependencies
    );

    expect(firstResponse.status).toBe(200);
    const duplicateBody = duplicateResponse.body;

    expect(duplicateBody).toMatchObject({
      accepted: true,
      duplicate: true,
      idempotencyKey: "telegram:webhook:update:42"
    });
    expect(duplicateBody).not.toHaveProperty("ingestion");
    expect(duplicateBody).not.toHaveProperty("inboxItem");
    expect(duplicateBody).not.toHaveProperty("processing");
    expect(duplicateBody).not.toHaveProperty("outboundDelivery");
    expect(listIncomingBotEventsForTests()).toHaveLength(1);
    expect(listInboxItemsForTests()).toHaveLength(1);
    expect(listOutgoingBotEventsForTests()).toHaveLength(1);
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
  });

  it("does not attempt bot-event recording for malformed Telegram payloads", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";

    const response = await handleTelegramWebhook(
      buildRequest({
        message: {
          text: "missing update id"
        }
      }),
      {
        store: getDefaultInboxProcessingStore(),
        primeProcessingStore: seedInboxItemForProcessingTests
      }
    );

    expect(response.status).toBe(400);
    await expect(Promise.resolve(response.body)).resolves.toMatchObject({
      accepted: false,
      error: "invalid_telegram_update"
    });
    expect(listIncomingBotEventsForTests()).toHaveLength(0);
    expect(listInboxItemsForTests()).toHaveLength(0);
    expect(listOutgoingBotEventsForTests()).toHaveLength(0);
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });
});
