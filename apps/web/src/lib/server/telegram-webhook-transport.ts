import { buildTelegramFollowUpIdempotencyKey } from "@atlas/core";
import {
  recordOutgoingTelegramMessageIfNew,
  updateOutgoingTelegramMessage,
  type OutgoingTelegramDeliveryStore
} from "@atlas/db";
import { sendTelegramMessage, type TelegramSendMessageResponse } from "@atlas/integrations";

type BundlePayload = {
  kind: "initial" | "reminder";
  taskIds: string[];
  items: Array<{
    number: number;
    taskId: string;
    title: string;
  }>;
  text: string;
};

type SendPersistedTelegramMessageInput = {
  userId: string;
  chatId: string;
  text: string;
  inboxItemId?: string;
  idempotencyKey?: string;
  eventType?: string;
  persistedText?: string;
  bundle?: BundlePayload;
};

type SendPersistedTelegramMessageDependencies = {
  sender: typeof sendTelegramMessage;
  deliveryStore?: OutgoingTelegramDeliveryStore;
};

export async function sendTelegramMessageWithPersistence(
  input: SendPersistedTelegramMessageInput,
  dependencies: SendPersistedTelegramMessageDependencies
) {
  const idempotencyKey =
    input.idempotencyKey ??
    (input.inboxItemId ? buildTelegramFollowUpIdempotencyKey(input.inboxItemId) : null);

  if (!idempotencyKey) {
    throw new Error("Follow-up delivery requires an inboxItemId or explicit idempotencyKey.");
  }

  const reservation = await recordOutgoingTelegramMessageIfNew(
    {
      userId: input.userId,
      eventType: input.eventType ?? "telegram_followup_message",
      idempotencyKey,
      payload: {
        chatId: input.chatId,
        text: input.persistedText ?? input.text,
        attempts: 0,
        ...(input.bundle ?? {})
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
        error: lastError?.message ?? "Unknown Telegram delivery error.",
        ...(input.bundle ?? {})
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
  input: SendPersistedTelegramMessageInput,
  sentMessage: TelegramSendMessageResponse,
  attempts: number,
  metadata?: Record<string, unknown>
) {
  return {
    chatId: input.chatId,
    text: input.persistedText ?? input.text,
    attempts,
    telegram: sentMessage,
    ...(input.bundle ?? {}),
    ...(metadata ?? {})
  };
}
