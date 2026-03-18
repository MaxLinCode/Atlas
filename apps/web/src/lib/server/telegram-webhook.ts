import {
  buildTelegramFollowUpIdempotencyKey,
  buildTelegramWebhookIdempotencyKey,
  type ConfirmedMutationRecoveryInput,
  type ConfirmedMutationRecoveryOutput,
  type ConversationTurn,
  getConfig,
  normalizeTelegramUpdate,
  telegramUpdateSchema
} from "@atlas/core";
import {
  listRecentConversationTurns,
  recordIncomingTelegramMessageIfNew,
  recordOutgoingTelegramMessageIfNew,
  updateOutgoingTelegramMessage,
  type ConversationHistoryStore,
  type IncomingTelegramIngressStore,
  type OutgoingTelegramDeliveryStore,
  type PersistedInboxItem
} from "@atlas/db";
import {
  recoverConfirmedMutationWithResponses,
  summarizeConversationMemoryWithResponses,
  sendTelegramMessage,
  type ConversationMemorySummaryInput,
  type ConversationMemorySummaryOutput,
  type TelegramSendMessageResponse
} from "@atlas/integrations";

import { processInboxItem, type ProcessInboxItemDependencies } from "./process-inbox-item";
import {
  buildConversationResponse,
  type BuildConversationResponseInput,
  type BuildConversationResponseResult
} from "./conversation-response";
import {
  routeTelegramTurn,
  type TurnRouterInput,
  type TurnRouterResult
} from "./turn-router";

type WebhookResult = {
  status: number;
  body: Record<string, unknown>;
};

type TelegramWebhookDependencies = ProcessInboxItemDependencies & {
  ingressStore?: IncomingTelegramIngressStore;
  deliveryStore?: OutgoingTelegramDeliveryStore;
  primeProcessingStore?: (inboxItem: PersistedInboxItem) => void | Promise<void>;
  sender?: typeof sendTelegramMessage;
  turnRouter?: (input: TurnRouterInput) => Promise<TurnRouterResult>;
  conversationResponder?: (input: BuildConversationResponseInput) => Promise<BuildConversationResponseResult>;
  conversationHistoryStore?: ConversationHistoryStore;
  conversationMemorySummarizer?: (
    input: ConversationMemorySummaryInput
  ) => Promise<ConversationMemorySummaryOutput>;
  confirmedMutationRecoverer?: (
    input: ConfirmedMutationRecoveryInput
  ) => Promise<ConfirmedMutationRecoveryOutput>;
};

const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
const RECENT_CONVERSATION_TURN_LIMIT = 6;

export async function handleTelegramWebhook(
  request: Request,
  dependencies: TelegramWebhookDependencies = {}
): Promise<WebhookResult> {
  const config = getConfig();
  const providedSecret = request.headers.get(TELEGRAM_SECRET_HEADER);

  if (providedSecret !== config.TELEGRAM_WEBHOOK_SECRET) {
    return {
      status: 401,
      body: {
        accepted: false,
        error: "invalid_webhook_secret"
      }
    };
  }

  const payload = await request.json().catch(() => null);

  if (!payload) {
    return {
      status: 400,
      body: {
        accepted: false,
        error: "invalid_json"
      }
    };
  }

  const parsedUpdate = telegramUpdateSchema.safeParse(payload);

  if (!parsedUpdate.success) {
    return {
      status: 400,
      body: {
        accepted: false,
        error: "invalid_telegram_update"
      }
    };
  }

  const incomingMessage = parsedUpdate.data.message ?? parsedUpdate.data.edited_message;
  const rawText = incomingMessage?.text ?? incomingMessage?.caption;

  if (!incomingMessage || !rawText?.trim()) {
    return {
      status: 200,
      body: {
        accepted: true,
        ignored: true,
        reason: "unsupported_telegram_update"
      }
    };
  }

  const idempotencyKey = buildTelegramWebhookIdempotencyKey(parsedUpdate.data.update_id);
  const normalizedMessage = normalizeTelegramUpdate(parsedUpdate.data);

  if (!normalizedMessage) {
    return {
      status: 200,
      body: {
        accepted: true,
        ignored: true,
        reason: "unsupported_telegram_update"
      }
    };
  }

  const ingress = await recordIncomingTelegramMessageIfNew(
    {
      userId: normalizedMessage.user.telegramUserId,
      eventType: "telegram_message",
      idempotencyKey,
      payload: parsedUpdate.data,
      rawText: normalizedMessage.rawText,
      normalizedText: normalizedMessage.normalizedText
    },
    dependencies.ingressStore
  );

  if (ingress.status === "duplicate") {
    return {
      status: 200,
      body: {
        accepted: true,
        duplicate: true,
        idempotencyKey
      }
    };
  }

  const recentTurns = await listRecentConversationTurns(
    normalizedMessage.user.telegramUserId,
    RECENT_CONVERSATION_TURN_LIMIT,
    dependencies.conversationHistoryStore
  );
  const routedWithContext = await (dependencies.turnRouter ?? routeTelegramTurn)({
    rawText: normalizedMessage.rawText,
    normalizedText: normalizedMessage.normalizedText,
    recentTurns
  });

  if (!routedWithContext.writesAllowed) {
    if (routedWithContext.route === "mutation" || routedWithContext.route === "confirmed_mutation") {
      throw new Error("Turn router returned mutation while writes were disabled.");
    }

    const memorySummary = await buildConversationMemorySummary(recentTurns, dependencies);
    const conversationResponse = await (dependencies.conversationResponder ?? buildConversationResponse)({
      route: routedWithContext.route,
      rawText: normalizedMessage.rawText,
      normalizedText: normalizedMessage.normalizedText,
      recentTurns,
      memorySummary
    });

    const outboundDelivery = await sendFollowUpMessage(
      {
        userId: normalizedMessage.user.telegramUserId,
        chatId: normalizedMessage.chatId,
        inboxItemId: ingress.inboxItem.id,
        text: conversationResponse.reply
      },
      {
        sender: dependencies.sender ?? sendTelegramMessage,
        ...(dependencies.deliveryStore ? { deliveryStore: dependencies.deliveryStore } : {})
      }
    );

    return {
      status: 200,
      body: {
        accepted: true,
        idempotencyKey,
        ingestion: normalizedMessage,
        inboxItem: ingress.inboxItem,
        turnRoute: routedWithContext.route,
        routing: routedWithContext,
        processing: {
          outcome: "conversation_replied",
          reply: conversationResponse.reply
        },
        outboundDelivery
      }
    };
  }

  if (routedWithContext.route === "confirmed_mutation") {
    const recoveredMutation = await (dependencies.confirmedMutationRecoverer ??
      recoverConfirmedMutationWithResponses)({
      rawText: normalizedMessage.rawText,
      normalizedText: normalizedMessage.normalizedText,
      recentTurns,
      memorySummary: null
    });

    if (recoveredMutation.outcome === "needs_clarification") {
      return replyWithText(
        {
          userId: normalizedMessage.user.telegramUserId,
          chatId: normalizedMessage.chatId,
          inboxItemId: ingress.inboxItem.id,
          text: recoveredMutation.reason
        },
        {
          sender: dependencies.sender ?? sendTelegramMessage,
          ...(dependencies.deliveryStore ? { deliveryStore: dependencies.deliveryStore } : {}),
          body: {
            accepted: true,
            idempotencyKey,
            ingestion: normalizedMessage,
            inboxItem: ingress.inboxItem,
            turnRoute: routedWithContext.route,
            routing: routedWithContext,
            processing: {
              outcome: "conversation_replied",
              reply: recoveredMutation.reason
            }
          }
        }
      );
    }

    await dependencies.primeProcessingStore?.(ingress.inboxItem);

    const processing = await processInboxItem(
      {
        inboxItemId: ingress.inboxItem.id,
        planningInboxTextOverride: {
          rawText: recoveredMutation.recoveredRawText!,
          normalizedText: recoveredMutation.recoveredNormalizedText!
        }
      },
      {
        ...(dependencies.store ? { store: dependencies.store } : {}),
        ...(dependencies.planner ? { planner: dependencies.planner } : {})
      }
    );
    const outboundDelivery = await sendFollowUpMessage(
      {
        userId: normalizedMessage.user.telegramUserId,
        chatId: normalizedMessage.chatId,
        inboxItemId: ingress.inboxItem.id,
        text: processing.followUpMessage
      },
      {
        sender: dependencies.sender ?? sendTelegramMessage,
        ...(dependencies.deliveryStore ? { deliveryStore: dependencies.deliveryStore } : {})
      }
    );

    return {
      status: 200,
      body: {
        accepted: true,
        idempotencyKey,
        ingestion: normalizedMessage,
        inboxItem: ingress.inboxItem,
        turnRoute: routedWithContext.route,
        routing: routedWithContext,
        processing,
        outboundDelivery
      }
    };
  }

  await dependencies.primeProcessingStore?.(ingress.inboxItem);

  const processing = await processInboxItem(
    {
      inboxItemId: ingress.inboxItem.id
    },
    {
      ...(dependencies.store ? { store: dependencies.store } : {}),
      ...(dependencies.planner ? { planner: dependencies.planner } : {})
    }
  );
  const outboundDelivery = await sendFollowUpMessage(
    {
      userId: normalizedMessage.user.telegramUserId,
      chatId: normalizedMessage.chatId,
      inboxItemId: ingress.inboxItem.id,
      text: processing.followUpMessage
    },
    {
      sender: dependencies.sender ?? sendTelegramMessage,
      ...(dependencies.deliveryStore ? { deliveryStore: dependencies.deliveryStore } : {})
    }
  );

  return {
    status: 200,
    body: {
      accepted: true,
      idempotencyKey,
      ingestion: normalizedMessage,
      inboxItem: ingress.inboxItem,
      turnRoute: routedWithContext.route,
      routing: routedWithContext,
      processing,
      outboundDelivery
    }
  };
}

type SendFollowUpMessageInput = {
  userId: string;
  chatId: string;
  inboxItemId: string;
  text: string;
};

type SendFollowUpMessageDependencies = {
  sender: typeof sendTelegramMessage;
  deliveryStore?: OutgoingTelegramDeliveryStore;
};

type ReplyWithTextInput = SendFollowUpMessageInput;
type ReplyWithTextDependencies = SendFollowUpMessageDependencies & {
  body: Record<string, unknown>;
};

async function replyWithText(
  input: ReplyWithTextInput,
  dependencies: ReplyWithTextDependencies
) {
  const outboundDelivery = await sendFollowUpMessage(input, dependencies);

  return {
    status: 200,
    body: {
      ...dependencies.body,
      outboundDelivery
    }
  };
}

async function sendFollowUpMessage(
  input: SendFollowUpMessageInput,
  dependencies: SendFollowUpMessageDependencies
) {
  const idempotencyKey = buildTelegramFollowUpIdempotencyKey(input.inboxItemId);
  const reservation = await recordOutgoingTelegramMessageIfNew(
    {
      userId: input.userId,
      eventType: "telegram_followup_message",
      idempotencyKey,
      payload: {
        chatId: input.chatId,
        text: input.text,
        attempts: 0
      },
      retryState: "sending"
    },
    dependencies.deliveryStore
  );

  if (reservation.status === "duplicate") {
    return {
      status: "duplicate",
      attempts: 0,
      idempotencyKey
    };
  }

  let attempts = 0;
  let lastError: Error | null = null;

  while (attempts < 2) {
    attempts += 1;

    try {
      const sentMessage = await dependencies.sender({
        chatId: input.chatId,
        text: input.text
      });

      await updateOutgoingTelegramMessage(
        {
          idempotencyKey,
          payload: buildOutgoingEventPayload(input, sentMessage, attempts),
          retryState: "sent"
        },
        dependencies.deliveryStore
      );

      return {
        status: "sent",
        attempts,
        idempotencyKey,
        message: sentMessage.result
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Failed to send Telegram follow-up message.");
    }
  }

  await updateOutgoingTelegramMessage(
    {
      idempotencyKey,
      payload: {
        chatId: input.chatId,
        text: input.text,
        attempts,
        error: lastError?.message ?? "Unknown Telegram delivery error."
      },
      retryState: "failed"
    },
    dependencies.deliveryStore
  );

  return {
    status: "failed",
    attempts,
    idempotencyKey,
    error: lastError?.message ?? "Unknown Telegram delivery error."
  };
}

function buildOutgoingEventPayload(
  input: SendFollowUpMessageInput,
  sentMessage: TelegramSendMessageResponse,
  attempts: number
) {
  return {
    chatId: input.chatId,
    text: input.text,
    attempts,
    telegram: sentMessage
  };
}

async function buildConversationMemorySummary(
  recentTurns: ConversationTurn[],
  dependencies: TelegramWebhookDependencies
) {
  const summarizer = dependencies.conversationMemorySummarizer ?? summarizeConversationMemoryWithResponses;

  return summarizer({ recentTurns })
    .then((summary) => summary.summary)
    .catch(() => null);
}
