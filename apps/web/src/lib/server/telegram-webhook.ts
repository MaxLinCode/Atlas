import {
  buildTelegramFollowUpIdempotencyKey,
  buildTelegramWebhookIdempotencyKey,
  getConfig,
  normalizeTelegramUpdate,
  telegramUpdateSchema
} from "@atlas/core";
import {
  recordIncomingTelegramMessageIfNew,
  recordOutgoingTelegramMessageIfNew,
  updateOutgoingTelegramMessage,
  type IncomingTelegramIngressStore,
  type OutgoingTelegramDeliveryStore,
  type PersistedInboxItem
} from "@atlas/db";
import {
  sendTelegramMessage,
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
};

const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

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

  const routing = await (dependencies.turnRouter ?? routeTelegramTurn)({
    rawText: normalizedMessage.rawText,
    normalizedText: normalizedMessage.normalizedText,
  });

  if (!routing.writesAllowed) {
    if (routing.route === "mutation") {
      throw new Error("Turn router returned mutation while writes were disabled.");
    }

    const conversationResponse = await (dependencies.conversationResponder ?? buildConversationResponse)({
      route: routing.route,
      rawText: normalizedMessage.rawText,
      normalizedText: normalizedMessage.normalizedText
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
        turnRoute: routing.route,
        routing,
        processing: {
          outcome: "conversation_replied",
          reply: conversationResponse.reply
        },
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
      turnRoute: routing.route,
      routing,
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
