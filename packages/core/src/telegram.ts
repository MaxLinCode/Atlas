import { z } from "zod";

const telegramUserSchema = z
  .object({
    id: z.number().int(),
    is_bot: z.boolean().default(false),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    username: z.string().optional(),
    language_code: z.string().optional()
  })
  .passthrough();

const telegramChatSchema = z
  .object({
    id: z.union([z.number().int(), z.string()]),
    type: z.string()
  })
  .passthrough();

const telegramMessageSchema = z
  .object({
    message_id: z.number().int(),
    date: z.number().int(),
    text: z.string().optional(),
    caption: z.string().optional(),
    from: telegramUserSchema.optional(),
    chat: telegramChatSchema
  })
  .passthrough();

export const telegramUpdateSchema = z
  .object({
    update_id: z.number().int(),
    message: telegramMessageSchema.optional(),
    edited_message: telegramMessageSchema.optional()
  })
  .passthrough();

export const normalizedTelegramMessageSchema = z.object({
  source: z.literal("telegram"),
  delivery: z.literal("webhook"),
  updateId: z.number().int(),
  messageId: z.number().int(),
  chatId: z.string(),
  messageDate: z.string(),
  rawText: z.string(),
  normalizedText: z.string(),
  user: z.object({
    telegramUserId: z.string(),
    isBot: z.boolean(),
    username: z.string().nullable(),
    displayName: z.string(),
    languageCode: z.string().nullable(),
    chatType: z.string()
  })
});

export type NormalizedTelegramMessage = z.infer<typeof normalizedTelegramMessageSchema>;
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

export function normalizeTelegramText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function buildTelegramWebhookIdempotencyKey(updateId: number) {
  return `telegram:webhook:update:${updateId}`;
}

export function buildTelegramFollowUpIdempotencyKey(inboxItemId: string) {
  return `telegram:followup:inbox-item:${inboxItemId}`;
}

export function normalizeTelegramUpdate(update: TelegramUpdate) {
  const message = update.message ?? update.edited_message;

  if (!message) {
    return null;
  }

  const rawText = message.text ?? message.caption;

  if (!rawText) {
    return null;
  }

  const normalizedText = normalizeTelegramText(rawText);

  if (!normalizedText) {
    return null;
  }

  const user = message.from;
  const displayName = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();

  return normalizedTelegramMessageSchema.parse({
    source: "telegram",
    delivery: "webhook",
    updateId: update.update_id,
    messageId: message.message_id,
    chatId: String(message.chat.id),
    messageDate: new Date(message.date * 1000).toISOString(),
    rawText,
    normalizedText,
    user: {
      telegramUserId: String(user?.id ?? message.chat.id),
      isBot: user?.is_bot ?? false,
      username: user?.username ?? null,
      displayName: displayName || user?.username || `telegram:${user?.id ?? message.chat.id}`,
      languageCode: user?.language_code ?? null,
      chatType: message.chat.type
    }
  });
}
