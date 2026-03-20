import {
  buildTelegramFollowUpIdempotencyKey,
  buildTelegramWebhookIdempotencyKey,
  getAppBaseUrl,
  getTelegramAllowedUserIds,
  isConfirmedMutationRecovered,
  isTelegramUserAllowed,
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
  editTelegramMessage,
  recoverConfirmedMutationWithResponses,
  sendTelegramChatAction,
  summarizeConversationMemoryWithResponses,
  sendTelegramMessage,
  type ConversationMemorySummaryInput,
  type ConversationMemorySummaryOutput,
  type TelegramChatAction,
  type TelegramSendMessageResponse
} from "@atlas/integrations";

import { processInboxItem, type ProcessInboxItemDependencies } from "./process-inbox-item";
import {
  buildConversationResponse,
  type BuildConversationResponseInput,
  type BuildConversationResponseResult
} from "./conversation-response";
import {
  routeMessageTurn,
  type TurnRouterInput,
  type TurnRouterResult
} from "./turn-router";
import {
  createGoogleCalendarConnectLink,
  hasActiveGoogleCalendarConnection
} from "./google-calendar";

type WebhookResult = {
  status: number;
  body: Record<string, unknown>;
};

type TelegramWebhookDependencies = ProcessInboxItemDependencies & {
  ingressStore?: IncomingTelegramIngressStore;
  deliveryStore?: OutgoingTelegramDeliveryStore;
  primeProcessingStore?: (inboxItem: PersistedInboxItem) => void | Promise<void>;
  sender?: typeof sendTelegramMessage;
  editor?: typeof editTelegramMessage;
  chatActionSender?: typeof sendTelegramChatAction;
  turnRouter?: (input: TurnRouterInput) => Promise<TurnRouterResult>;
  conversationResponder?: (input: BuildConversationResponseInput) => Promise<BuildConversationResponseResult>;
  conversationHistoryStore?: ConversationHistoryStore;
  conversationMemorySummarizer?: (
    input: ConversationMemorySummaryInput
  ) => Promise<ConversationMemorySummaryOutput>;
  confirmedMutationRecoverer?: (
    input: ConfirmedMutationRecoveryInput
  ) => Promise<ConfirmedMutationRecoveryOutput>;
  googleCalendarConnectionChecker?: (userId: string) => Promise<boolean>;
  googleCalendarConnectLinkBuilder?: (input: {
    baseUrl: string;
    userId: string;
    redirectPath?: string | null;
  }) => Promise<string>;
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

  const allowedTelegramUserIds = getTelegramAllowedUserIds(config);

  if (!isTelegramUserAllowed(normalizedMessage.user.telegramUserId, allowedTelegramUserIds)) {
    return {
      status: 403,
      body: {
        accepted: false,
        error: "telegram_user_not_allowed"
      }
    };
  }

  const hasActiveGoogleCalendar =
    (await (dependencies.googleCalendarConnectionChecker ?? hasActiveGoogleCalendarConnection)(
      normalizedMessage.user.telegramUserId
    )) ?? false;

  if (!hasActiveGoogleCalendar) {
    const connectLink = await (dependencies.googleCalendarConnectLinkBuilder ??
      createGoogleCalendarConnectLink)({
      baseUrl: getAppBaseUrl(config),
      userId: normalizedMessage.user.telegramUserId
    });
    const connectReply = buildGoogleCalendarConnectReply(connectLink);

    return replyWithText(
      {
        userId: normalizedMessage.user.telegramUserId,
        chatId: normalizedMessage.chatId,
        idempotencyKey: buildLazyLinkReplyIdempotencyKey(parsedUpdate.data.update_id),
        eventType: "telegram_google_calendar_link",
        text: connectReply,
        persistedText: redactTokenizedUrls(connectReply)
      },
      {
        sender: dependencies.sender ?? sendTelegramMessage,
        ...(dependencies.deliveryStore ? { deliveryStore: dependencies.deliveryStore } : {}),
        body: {
          accepted: true,
          lazyLinkRequired: true,
          idempotencyKey
        }
      }
    );
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
  const routedWithContext = await (dependencies.turnRouter ?? routeMessageTurn)({
    rawText: normalizedMessage.rawText,
    normalizedText: normalizedMessage.normalizedText,
    recentTurns
  });
  const immediateFeedback = buildImmediateRouteFeedback(routedWithContext.route);

  const placeholderDelivery = await sendImmediateRouteFeedback(
    {
      userId: normalizedMessage.user.telegramUserId,
      chatId: normalizedMessage.chatId,
      inboxItemId: ingress.inboxItem.id,
      feedback: immediateFeedback
    },
    {
      sender: dependencies.sender ?? sendTelegramMessage,
      chatActionSender: dependencies.chatActionSender ?? sendTelegramChatAction,
      ...(dependencies.deliveryStore ? { deliveryStore: dependencies.deliveryStore } : {})
    }
  );

  if (!routedWithContext.writesAllowed) {
    if (routedWithContext.route === "mutation" || routedWithContext.route === "confirmed_mutation") {
      throw new Error("Turn router returned mutation while writes were disabled.");
    }

    const memorySummary = await buildConversationMemorySummary(recentTurns, dependencies);
    const conversationResponse = await (dependencies.conversationResponder ?? buildConversationResponse)({
      route: routedWithContext.route,
      normalizedText: normalizedMessage.normalizedText,
      recentTurns,
      memorySummary
    });

    const outboundDelivery = await finalizeFollowUpMessage(
      {
        userId: normalizedMessage.user.telegramUserId,
        chatId: normalizedMessage.chatId,
        inboxItemId: ingress.inboxItem.id,
        text: conversationResponse.reply
      },
      {
        editor: dependencies.editor ?? editTelegramMessage,
        placeholderDelivery,
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
          text: recoveredMutation.userReplyMessage
        },
        {
          editor: dependencies.editor ?? editTelegramMessage,
          placeholderDelivery,
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
              reply: recoveredMutation.userReplyMessage
            }
          }
        }
      );
    }

    await dependencies.primeProcessingStore?.(ingress.inboxItem);

    if (!isConfirmedMutationRecovered(recoveredMutation)) {
      throw new Error("Expected recovered mutation to include recoveredText");
    }

    const processing = await processInboxItem(
      {
        inboxItemId: ingress.inboxItem.id,
        planningInboxTextOverride: {
          text: recoveredMutation.recoveredText
        }
      },
      {
        ...(dependencies.store ? { store: dependencies.store } : {}),
        ...(dependencies.planner ? { planner: dependencies.planner } : {}),
        ...(dependencies.calendar !== undefined ? { calendar: dependencies.calendar } : {})
      }
    );
    const outboundDelivery = await finalizeFollowUpMessage(
      {
        userId: normalizedMessage.user.telegramUserId,
        chatId: normalizedMessage.chatId,
        inboxItemId: ingress.inboxItem.id,
        text: processing.followUpMessage
      },
      {
        editor: dependencies.editor ?? editTelegramMessage,
        placeholderDelivery,
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
      ...(dependencies.planner ? { planner: dependencies.planner } : {}),
      ...(dependencies.calendar !== undefined ? { calendar: dependencies.calendar } : {})
    }
  );
  const outboundDelivery = await finalizeFollowUpMessage(
    {
      userId: normalizedMessage.user.telegramUserId,
      chatId: normalizedMessage.chatId,
      inboxItemId: ingress.inboxItem.id,
      text: processing.followUpMessage
    },
    {
      editor: dependencies.editor ?? editTelegramMessage,
      placeholderDelivery,
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
  inboxItemId?: string;
  idempotencyKey?: string;
  eventType?: string;
  text: string;
  persistedText?: string;
};

type ImmediateRouteFeedback = {
  text: string;
  chatAction: TelegramChatAction;
};

type SendImmediateRouteFeedbackInput = {
  userId: string;
  chatId: string;
  inboxItemId: string;
  feedback: ImmediateRouteFeedback;
};

type SendFollowUpMessageDependencies = {
  sender: typeof sendTelegramMessage;
  deliveryStore?: OutgoingTelegramDeliveryStore;
};

type SendImmediateRouteFeedbackDependencies = SendFollowUpMessageDependencies & {
  chatActionSender: typeof sendTelegramChatAction;
};

type FinalizeFollowUpMessageDependencies = SendFollowUpMessageDependencies & {
  editor: typeof editTelegramMessage;
  placeholderDelivery: Awaited<ReturnType<typeof sendFollowUpMessage>>;
};

type ReplyWithTextInput = SendFollowUpMessageInput;
type ReplyWithTextDependencies = SendFollowUpMessageDependencies & {
  body: Record<string, unknown>;
};

async function replyWithText(
  input: ReplyWithTextInput,
  dependencies: ReplyWithTextDependencies | (ReplyWithTextDependencies & FinalizeFollowUpMessageDependencies)
) {
  const outboundDelivery =
    "placeholderDelivery" in dependencies
      ? await finalizeFollowUpMessage(input, dependencies)
      : await sendFollowUpMessage(input, dependencies);

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

async function sendImmediateRouteFeedback(
  input: SendImmediateRouteFeedbackInput,
  dependencies: SendImmediateRouteFeedbackDependencies
) {
  await dependencies
    .chatActionSender({
      chatId: input.chatId,
      action: input.feedback.chatAction
    })
    .catch(() => null);

  return sendFollowUpMessage(
    {
      userId: input.userId,
      chatId: input.chatId,
      inboxItemId: input.inboxItemId,
      text: input.feedback.text
    },
    dependencies
  );
}

async function finalizeFollowUpMessage(
  input: SendFollowUpMessageInput,
  dependencies: FinalizeFollowUpMessageDependencies
) {
  if (dependencies.placeholderDelivery.status === "sent" && dependencies.placeholderDelivery.message) {
    return editExistingFollowUpMessage(
      input,
      dependencies.placeholderDelivery.message.message_id,
      dependencies
    );
  }

  if (dependencies.placeholderDelivery.status === "failed") {
    return sendFailedPlaceholderRecoveryMessage(input, dependencies);
  }

  return dependencies.placeholderDelivery;
}

async function editExistingFollowUpMessage(
  input: SendFollowUpMessageInput,
  messageId: number,
  dependencies: FinalizeFollowUpMessageDependencies
) {
  const idempotencyKey =
    input.idempotencyKey ??
    (input.inboxItemId ? buildTelegramFollowUpIdempotencyKey(input.inboxItemId) : null);

  if (!idempotencyKey) {
    throw new Error("Follow-up delivery requires an inboxItemId or explicit idempotencyKey.");
  }

  try {
    const editedMessage = await dependencies.editor({
      chatId: input.chatId,
      messageId,
      text: input.text
    });

    await updateOutgoingTelegramMessage(
      {
        idempotencyKey,
        payload: buildOutgoingEventPayload(input, editedMessage, dependencies.placeholderDelivery.attempts, {
          editTargetMessageId: messageId,
          edited: true
        }),
        retryState: "sent"
      },
      dependencies.deliveryStore
    );

    return {
      status: "edited",
      attempts: dependencies.placeholderDelivery.attempts,
      idempotencyKey,
      message: editedMessage.result
    };
  } catch (error) {
    return sendFailedPlaceholderRecoveryMessage(input, dependencies, error);
  }
}

async function sendFailedPlaceholderRecoveryMessage(
  input: SendFollowUpMessageInput,
  dependencies: FinalizeFollowUpMessageDependencies,
  cause?: unknown
) {
  const idempotencyKey =
    input.idempotencyKey ??
    (input.inboxItemId ? buildTelegramFollowUpIdempotencyKey(input.inboxItemId) : null);

  if (!idempotencyKey) {
    throw new Error("Follow-up delivery requires an inboxItemId or explicit idempotencyKey.");
  }

  let attempts = 0;
  let lastError = cause instanceof Error ? cause : null;

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
          payload: buildOutgoingEventPayload(input, sentMessage, dependencies.placeholderDelivery.attempts + attempts, {
            edited: false,
            replacedPlaceholder: true
          }),
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
        attempts: dependencies.placeholderDelivery.attempts + attempts,
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
  attempts: number,
  metadata?: Record<string, unknown>
) {
  return {
    chatId: input.chatId,
    text: input.persistedText ?? input.text,
    attempts,
    telegram: sentMessage,
    ...(metadata ?? {})
  };
}

function buildLazyLinkReplyIdempotencyKey(updateId: number) {
  return `telegram:lazy-link:${updateId}`;
}

function buildImmediateRouteFeedback(route: TurnRouterResult["route"]): ImmediateRouteFeedback {
  switch (route) {
    case "mutation":
      return {
        text: "Checking your schedule",
        chatAction: "typing"
      };
    case "confirmed_mutation":
      return {
        text: "Applying that",
        chatAction: "typing"
      };
    case "conversation":
    case "conversation_then_mutation":
      return {
        text: "Thinking",
        chatAction: "typing"
      };
  }
}

function buildGoogleCalendarConnectReply(connectLink: string) {
  return `I can do that, but I need access to your Google Calendar first. Connect here: ${connectLink}. Once connected, send that again.`;
}

function redactTokenizedUrls(text: string) {
  return text.replace(
    /https?:\/\/\S*\/google-calendar\/connect\?token=[^\s.]+/g,
    "[redacted Google Calendar connect link]"
  );
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
