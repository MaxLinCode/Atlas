import {
  buildTelegramWebhookIdempotencyKey,
  getConfig,
  normalizeTelegramUpdate,
  processInboxItem,
  telegramUpdateSchema
} from "@atlas/core";
import { recordIncomingTelegramMessageIfNew } from "@atlas/db";

type WebhookResult = {
  status: number;
  body: Record<string, unknown>;
};

const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

export async function handleTelegramWebhook(request: Request): Promise<WebhookResult> {
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

  const ingress = await recordIncomingTelegramMessageIfNew({
    userId: normalizedMessage.user.telegramUserId,
    eventType: "telegram_message",
    idempotencyKey,
    payload: parsedUpdate.data,
    rawText: normalizedMessage.rawText,
    normalizedText: normalizedMessage.normalizedText
  });

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

  const processing = await processInboxItem({
    inboxItemId: ingress.inboxItem.id,
    sourceEventId: ingress.eventId,
    source: normalizedMessage.source,
    delivery: normalizedMessage.delivery,
    event: normalizedMessage,
    userId: normalizedMessage.user.telegramUserId,
    rawText: normalizedMessage.rawText,
    normalizedText: normalizedMessage.normalizedText,
    metadata: {
      telegramUpdateId: normalizedMessage.updateId,
      telegramMessageId: normalizedMessage.messageId,
      chatId: normalizedMessage.chatId,
      messageDate: normalizedMessage.messageDate,
      user: normalizedMessage.user
    }
  });

  return {
    status: 200,
    body: {
      accepted: true,
      idempotencyKey,
      ingestion: normalizedMessage,
      inboxItem: ingress.inboxItem,
      processing
    }
  };
}
