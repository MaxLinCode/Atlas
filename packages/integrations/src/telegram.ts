import { getConfig } from "@atlas/core";

export type SendTelegramMessageInput = {
  chatId: string;
  text: string;
};

export type EditTelegramMessageInput = {
  chatId: string;
  messageId: number;
  text: string;
};

export type TelegramChatAction = "typing";

export type SendTelegramChatActionInput = {
  chatId: string;
  action: TelegramChatAction;
};

export type TelegramSendMessageResponse = {
  ok: boolean;
  result: {
    message_id: number;
    date: number;
    chat: {
      id: number | string;
      type: string;
    };
    text?: string;
  };
};

export async function sendTelegramMessage(
  input: SendTelegramMessageInput,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramSendMessageResponse> {
  const config = getConfig();
  const response = await fetchImpl(
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text,
      }),
    },
  );

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => null);
    const errorDescription = getTelegramErrorDescription(errorPayload);

    throw new Error(
      errorDescription
        ? `Telegram sendMessage failed with status ${response.status}: ${errorDescription}.`
        : `Telegram sendMessage failed with status ${response.status}.`,
    );
  }

  return parseTelegramSendMessageResponse(await response.json());
}

export async function sendTelegramChatAction(
  input: SendTelegramChatActionInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const config = getConfig();
  const response = await fetchImpl(
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendChatAction`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: input.chatId,
        action: input.action,
      }),
    },
  );

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => null);
    const errorDescription = getTelegramErrorDescription(errorPayload);

    throw new Error(
      errorDescription
        ? `Telegram sendChatAction failed with status ${response.status}: ${errorDescription}.`
        : `Telegram sendChatAction failed with status ${response.status}.`,
    );
  }
}

export async function editTelegramMessage(
  input: EditTelegramMessageInput,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramSendMessageResponse> {
  const config = getConfig();
  const response = await fetchImpl(
    `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/editMessageText`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: input.chatId,
        message_id: input.messageId,
        text: input.text,
      }),
    },
  );

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => null);
    const errorDescription = getTelegramErrorDescription(errorPayload);

    throw new Error(
      errorDescription
        ? `Telegram editMessageText failed with status ${response.status}: ${errorDescription}.`
        : `Telegram editMessageText failed with status ${response.status}.`,
    );
  }

  return parseTelegramSendMessageResponse(await response.json());
}

function getTelegramErrorDescription(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const description = (payload as Record<string, unknown>).description;

  return typeof description === "string" && description.trim()
    ? description.trim()
    : null;
}

function parseTelegramSendMessageResponse(
  payload: unknown,
): TelegramSendMessageResponse {
  if (!isTelegramSendMessageResponse(payload)) {
    throw new Error("Telegram sendMessage returned an invalid payload.");
  }

  return payload;
}

function isTelegramSendMessageResponse(
  payload: unknown,
): payload is TelegramSendMessageResponse {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const candidate = payload as Record<string, unknown>;
  const result = candidate.result;

  if (candidate.ok !== true || !result || typeof result !== "object") {
    return false;
  }

  const message = result as Record<string, unknown>;
  const chat = message.chat;

  return (
    typeof message.message_id === "number" &&
    typeof message.date === "number" &&
    !!chat &&
    typeof chat === "object" &&
    (typeof (chat as Record<string, unknown>).id === "number" ||
      typeof (chat as Record<string, unknown>).id === "string") &&
    typeof (chat as Record<string, unknown>).type === "string"
  );
}

export async function telegramWebhookHandler(request: Request) {
  const payload = await request.json().catch(() => null);

  return {
    accepted: true,
    delivery: "webhook",
    payload,
  };
}

export async function dispatchReminderBatch() {
  return {
    dispatched: 0,
    message: "Reminder dispatch is not implemented yet.",
  };
}
