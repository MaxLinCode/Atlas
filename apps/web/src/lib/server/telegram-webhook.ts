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
  type Task,
  getConfig,
  normalizeTelegramUpdate,
  telegramUpdateSchema
} from "@atlas/core";
import {
  appendConversationTurn,
  loadConversationState,
  saveConversationState,
  getDefaultInboxProcessingStore,
  listRecentConversationTurns,
  getDefaultFollowUpRuntimeStore,
  getLatestFollowUpBundleContext,
  recordIncomingTelegramMessageIfNew,
  updateOutgoingTelegramMessage,
  type ConversationStateStore,
  type ConversationHistoryStore,
  type FollowUpRuntimeStore,
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
  deriveConversationReplyState,
  deriveMutationState
} from "./conversation-state";
import { renderMutationReply } from "./mutation-reply";
import {
  buildConversationResponse,
  type BuildConversationResponseInput,
  type BuildConversationResponseResult
} from "./conversation-response";
import {
  routeMessageTurn,
  doesPolicyAllowWrites,
  getConversationRouteForPolicy,
  type TurnRouterInput,
  type TurnRouterResult
} from "./turn-router";
import {
  createGoogleCalendarConnectLink,
  hasActiveGoogleCalendarConnection
} from "./google-calendar";
import { buildFollowUpBundle } from "./follow-up";
import { sendTelegramMessageWithPersistence } from "./telegram-webhook-transport";

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
  conversationStateStore?: ConversationStateStore;
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
  followUpStore?: FollowUpRuntimeStore;
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

  await appendConversationTurn(
    {
      userId: normalizedMessage.user.telegramUserId,
      role: "user",
      text: normalizedMessage.rawText
    },
    dependencies.conversationStateStore
  );

  const conversationState =
    (await loadConversationState(
      normalizedMessage.user.telegramUserId,
      RECENT_CONVERSATION_TURN_LIMIT,
      dependencies.conversationStateStore
    )) ??
    null;
  const legacyRecentTurns = await listRecentConversationTurns(
    normalizedMessage.user.telegramUserId,
    RECENT_CONVERSATION_TURN_LIMIT,
    dependencies.conversationHistoryStore
  );
  const recentTurns =
    conversationState && conversationState.transcript.length > 1
      ? conversationState.transcript
      : legacyRecentTurns;
  const followUpIntercept = await tryHandleFollowUpReply(
    {
      normalizedMessage,
      inboxItem: ingress.inboxItem
    },
    dependencies
  );

  if (followUpIntercept) {
    return followUpIntercept;
  }

  const routedWithContext = await (dependencies.turnRouter ?? routeMessageTurn)({
    rawText: normalizedMessage.rawText,
    normalizedText: normalizedMessage.normalizedText,
    recentTurns,
    summaryText: conversationState?.conversation.summaryText ?? null,
    entityRegistry: conversationState?.entityRegistry ?? [],
    discourseState: conversationState?.discourseState ?? null
  });
  console.info("turn_interpreted", {
    userId: normalizedMessage.user.telegramUserId,
    normalizedText: normalizedMessage.normalizedText,
    interpretation: routedWithContext.interpretation
  });
  console.info("turn_policy_decided", {
    userId: normalizedMessage.user.telegramUserId,
    normalizedText: normalizedMessage.normalizedText,
    policy: routedWithContext.policy
  });

  const compatibilityTurnRoute = getCompatibilityTurnRouteFromPolicy(routedWithContext.policy.action);
  const immediateFeedback = buildImmediateRouteFeedback(routedWithContext.policy.action);

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

  if (!doesPolicyAllowWrites(routedWithContext.policy.action)) {
    console.info("turn_execution_branch", {
      userId: normalizedMessage.user.telegramUserId,
      action: routedWithContext.policy.action
    });

    const memorySummary = await buildConversationMemorySummary(recentTurns, dependencies);
    const conversationResponse = await (dependencies.conversationResponder ?? buildConversationResponse)({
      route: getConversationRouteForPolicy(routedWithContext.policy.action),
      rawText: normalizedMessage.rawText,
      normalizedText: normalizedMessage.normalizedText,
      recentTurns,
      memorySummary,
      entityRegistry: conversationState?.entityRegistry ?? [],
      discourseState: conversationState?.discourseState ?? null
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
    const followUpContinuation = await maybeSendOutstandingFollowUpContinuation(
      {
        userId: normalizedMessage.user.telegramUserId,
        chatId: normalizedMessage.chatId,
        inboxItemId: ingress.inboxItem.id
      },
      dependencies
    );

    if (conversationState) {
      await appendConversationTurn(
        {
          userId: normalizedMessage.user.telegramUserId,
          role: "assistant",
          text: conversationResponse.reply
        },
        dependencies.conversationStateStore
      );
      await saveConversationState(
        {
          userId: normalizedMessage.user.telegramUserId,
          ...deriveConversationReplyState({
            snapshot: conversationState,
            policyAction: routedWithContext.policy.action,
            interpretation: routedWithContext.interpretation,
            reply: conversationResponse.reply,
            userTurnText: normalizedMessage.rawText,
            summaryText: memorySummary ?? conversationState.conversation.summaryText
          })
        },
        dependencies.conversationStateStore
      );
    }

    return {
      status: 200,
      body: {
        accepted: true,
        idempotencyKey,
        ingestion: normalizedMessage,
        inboxItem: ingress.inboxItem,
        turnRoute: compatibilityTurnRoute,
        routing: routedWithContext,
        processing: {
          outcome: "conversation_replied",
          reply: conversationResponse.reply
        },
        outboundDelivery,
        followUpContinuation
      }
    };
  }

  if (routedWithContext.policy.action === "recover_and_execute") {
    console.info("turn_execution_branch", {
      userId: normalizedMessage.user.telegramUserId,
      action: routedWithContext.policy.action
    });
    const recoveredMutation = await (dependencies.confirmedMutationRecoverer ??
      recoverConfirmedMutationWithResponses)({
      rawText: normalizedMessage.rawText,
      normalizedText: normalizedMessage.normalizedText,
      recentTurns,
      memorySummary: conversationState?.conversation.summaryText ?? null,
      entityRegistry: conversationState?.entityRegistry ?? [],
      discourseState: conversationState?.discourseState ?? null
    });
    console.info("turn_recovery_result", {
      userId: normalizedMessage.user.telegramUserId,
      action: routedWithContext.policy.action,
      outcome: recoveredMutation.outcome
    });

    if (recoveredMutation.outcome === "needs_clarification") {
      if (conversationState) {
        await appendConversationTurn(
          {
            userId: normalizedMessage.user.telegramUserId,
            role: "assistant",
            text: recoveredMutation.userReplyMessage
          },
          dependencies.conversationStateStore
        );
        await saveConversationState(
          {
            userId: normalizedMessage.user.telegramUserId,
            ...deriveConversationReplyState({
              snapshot: conversationState,
              policyAction: "ask_clarification",
              interpretation: routedWithContext.interpretation,
              reply: recoveredMutation.userReplyMessage,
              userTurnText: normalizedMessage.rawText,
              summaryText: conversationState.conversation.summaryText
            })
          },
          dependencies.conversationStateStore
        );
      }

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
            turnRoute: compatibilityTurnRoute,
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
    const followUpContinuation = await maybeSendOutstandingFollowUpContinuation(
      {
        userId: normalizedMessage.user.telegramUserId,
        chatId: normalizedMessage.chatId,
        inboxItemId: ingress.inboxItem.id
      },
      dependencies
    );

    if (conversationState) {
      await appendConversationTurn(
        {
          userId: normalizedMessage.user.telegramUserId,
          role: "assistant",
          text: processing.followUpMessage
        },
        dependencies.conversationStateStore
      );
      await saveConversationState(
        {
          userId: normalizedMessage.user.telegramUserId,
          ...deriveMutationState({
            snapshot: conversationState,
            processing
          })
        },
        dependencies.conversationStateStore
      );
    }

    return {
      status: 200,
      body: {
        accepted: true,
        idempotencyKey,
        ingestion: normalizedMessage,
        inboxItem: ingress.inboxItem,
        turnRoute: compatibilityTurnRoute,
        routing: routedWithContext,
        processing,
        outboundDelivery,
        followUpContinuation
      }
    };
  }

  console.info("turn_execution_branch", {
    userId: normalizedMessage.user.telegramUserId,
    action: routedWithContext.policy.action
  });
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
  const followUpContinuation = await maybeSendOutstandingFollowUpContinuation(
    {
      userId: normalizedMessage.user.telegramUserId,
      chatId: normalizedMessage.chatId,
      inboxItemId: ingress.inboxItem.id
    },
    dependencies
  );

  if (conversationState) {
    await appendConversationTurn(
      {
        userId: normalizedMessage.user.telegramUserId,
        role: "assistant",
        text: processing.followUpMessage
      },
      dependencies.conversationStateStore
    );
    await saveConversationState(
      {
        userId: normalizedMessage.user.telegramUserId,
        ...deriveMutationState({
          snapshot: conversationState,
          processing
        })
      },
      dependencies.conversationStateStore
    );
  }

  return {
    status: 200,
    body: {
      accepted: true,
      idempotencyKey,
      ingestion: normalizedMessage,
      inboxItem: ingress.inboxItem,
      turnRoute: compatibilityTurnRoute,
      routing: routedWithContext,
      processing,
      outboundDelivery,
      followUpContinuation
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
  return sendTelegramMessageWithPersistence(input, dependencies);
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

async function tryHandleFollowUpReply(
  input: {
    normalizedMessage: NonNullable<ReturnType<typeof normalizeTelegramUpdate>>;
    inboxItem: PersistedInboxItem;
  },
  dependencies: TelegramWebhookDependencies
): Promise<WebhookResult | null> {
  const followUpStore = dependencies.followUpStore ?? (dependencies.store as FollowUpRuntimeStore | undefined) ?? getDefaultFollowUpRuntimeStore();
  const outstandingTasks = await followUpStore.listOutstandingFollowUpTasks(input.normalizedMessage.user.telegramUserId);

  if (outstandingTasks.length === 0) {
    return null;
  }

  const latestContext = await getLatestFollowUpBundleContext(
    input.normalizedMessage.user.telegramUserId,
    dependencies.conversationHistoryStore
  );

  if (!latestContext) {
    return null;
  }

  const unresolvedById = new Map(outstandingTasks.map((task) => [task.id, task]));
  const contextTasks = latestContext.items
    .map((item) => ({
      ...item,
      task: unresolvedById.get(item.taskId) ?? null
    }))
    .filter((item): item is typeof item & { task: Task } => item.task !== null);

  if (contextTasks.length === 0) {
    return null;
  }

  if (!looksLikeFollowUpReply(input.normalizedMessage.normalizedText, contextTasks.length)) {
    return null;
  }

  const parsed = parseFollowUpReply(input.normalizedMessage.normalizedText, contextTasks);

  if (parsed.kind === "new_request") {
    return null;
  }

  if (parsed.kind === "ambiguous") {
    return replyWithText(
      {
        userId: input.normalizedMessage.user.telegramUserId,
        chatId: input.normalizedMessage.chatId,
        inboxItemId: input.inboxItem.id,
        text: "Which one do you mean? Reply with the number or numbers."
      },
      {
        sender: dependencies.sender ?? sendTelegramMessage,
        ...(dependencies.deliveryStore ? { deliveryStore: dependencies.deliveryStore } : {}),
        body: {
          accepted: true,
          inboxItem: input.inboxItem,
          processing: {
            outcome: "conversation_replied",
            reply: "Which one do you mean? Reply with the number or numbers."
          }
        }
      }
    );
  }

  const selectedTasks = parsed.taskIds.map((taskId) => unresolvedById.get(taskId)).filter((task): task is Task => task !== undefined);

  if (selectedTasks.length === 0) {
    return null;
  }

  const directStore = dependencies.store ?? getDefaultInboxProcessingStore();
  await dependencies.primeProcessingStore?.(input.inboxItem);
  const plannerRun = {
    userId: input.inboxItem.userId,
    inboxItemId: input.inboxItem.id,
    version: "followup-direct-v1",
    modelInput: { source: "followup_reply", text: input.normalizedMessage.normalizedText },
    modelOutput: parsed,
    confidence: 1
  };

  if (parsed.kind === "done") {
    const processing = await directStore.saveTaskCompletionResult({
      inboxItemId: input.inboxItem.id,
      confidence: 1,
      plannerRun,
      taskIds: selectedTasks.map((task) => task.id),
      followUpMessage: ""
    });

    return replyWithText(
      {
        userId: input.normalizedMessage.user.telegramUserId,
        chatId: input.normalizedMessage.chatId,
        inboxItemId: input.inboxItem.id,
        text: renderMutationReply(processing)
      },
      {
        sender: dependencies.sender ?? sendTelegramMessage,
        ...(dependencies.deliveryStore ? { deliveryStore: dependencies.deliveryStore } : {}),
        body: {
          accepted: true,
          inboxItem: input.inboxItem,
          processing
        }
      }
    );
  }

  if (parsed.kind === "archive") {
    const processing = await directStore.saveTaskArchiveResult({
      inboxItemId: input.inboxItem.id,
      confidence: 1,
      plannerRun,
      taskIds: selectedTasks.map((task) => task.id),
      followUpMessage: ""
    });

    return replyWithText(
      {
        userId: input.normalizedMessage.user.telegramUserId,
        chatId: input.normalizedMessage.chatId,
        inboxItemId: input.inboxItem.id,
        text: renderMutationReply(processing)
      },
      {
        sender: dependencies.sender ?? sendTelegramMessage,
        ...(dependencies.deliveryStore ? { deliveryStore: dependencies.deliveryStore } : {}),
        body: {
          accepted: true,
          inboxItem: input.inboxItem,
          processing
        }
      }
    );
  }

  if (parsed.kind === "not_yet") {
    const processing = await directStore.saveNeedsClarificationResult({
      inboxItemId: input.inboxItem.id,
      confidence: 1,
      plannerRun,
      reason: "Follow-up reply needs explicit reschedule or archive decision.",
      followUpMessage: "Noted. Tell me when you want to reschedule it, or say archive."
    });

    return replyWithText(
      {
        userId: input.normalizedMessage.user.telegramUserId,
        chatId: input.normalizedMessage.chatId,
        inboxItemId: input.inboxItem.id,
        text: processing.followUpMessage
      },
      {
        sender: dependencies.sender ?? sendTelegramMessage,
        ...(dependencies.deliveryStore ? { deliveryStore: dependencies.deliveryStore } : {}),
        body: {
          accepted: true,
          inboxItem: input.inboxItem,
          processing
        }
      }
    );
  }

  return null;
}

function parseFollowUpReply(
  normalizedText: string,
  contextTasks: Array<{ number: number; taskId: string; title: string; task: Task }>
):
  | { kind: "done"; taskIds: string[] }
  | { kind: "archive"; taskIds: string[] }
  | { kind: "not_yet"; taskIds: string[] }
  | { kind: "ambiguous" }
  | { kind: "new_request" } {
  const lower = normalizedText.toLowerCase();
  const numberToTask = new Map(contextTasks.map((item) => [item.number, item.taskId]));
  const selectedTaskIds = extractFollowUpSelectionNumbers(lower)
    .map((number) => numberToTask.get(number))
    .filter((taskId): taskId is string => Boolean(taskId));
  const action = detectFollowUpAction(lower);

  if (selectedTaskIds.length > 0 && action) {
    return {
      kind: action,
      taskIds: selectedTaskIds
    } as { kind: "done" | "archive" | "not_yet"; taskIds: string[] };
  }

  if (contextTasks.length === 1 && action) {
    const [onlyTask] = contextTasks;

    if (!onlyTask) {
      return { kind: "new_request" };
    }

    return {
      kind: action,
      taskIds: [onlyTask.taskId]
    } as { kind: "done" | "archive" | "not_yet"; taskIds: string[] };
  }

  if (action) {
    return { kind: "ambiguous" };
  }

  return { kind: "new_request" };
}

function looksLikeFollowUpReply(normalizedText: string, outstandingTaskCount: number) {
  const lower = normalizedText.toLowerCase();
  const action = detectFollowUpAction(lower);

  if (!action) {
    return false;
  }

  const stripped = stripFollowUpReplySyntax(lower);

  if (stripped.length > 0) {
    return false;
  }

  const hasExplicitSelection = extractFollowUpSelectionNumbers(lower).length > 0;

  if (hasExplicitSelection) {
    return true;
  }

  return outstandingTaskCount > 0;
}

function detectFollowUpAction(
  lower: string
): "done" | "archive" | "not_yet" | null {
  if (/\b(done|completed|finished)\b/.test(lower)) {
    return "done";
  }

  if (/\b(archive|drop|cancel)\b/.test(lower)) {
    return "archive";
  }

  if (/\b(not yet|later|reschedule|move)\b/.test(lower)) {
    return "not_yet";
  }

  return null;
}

function stripFollowUpReplySyntax(lower: string) {
  return lower
    .replace(/\bnot yet\b/g, " ")
    .replace(/\b(done|completed|finished|archive|drop|cancel|later|reschedule|move)\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/g, " ")
    .replace(/\b(i|i'm|ive|i've|it|them|that|those|the|a|an|my|on|for|please|just|still|one|ones|item|items|task|tasks|number|numbers|no|and)\b/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFollowUpSelectionNumbers(lower: string) {
  const selected = new Set<number>();

  for (const value of lower.match(/\b\d+\b/g) ?? []) {
    selected.add(Number(value));
  }

  for (const [word, number] of Object.entries(FOLLOW_UP_ORDINAL_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) {
      selected.add(number);
    }
  }

  return Array.from(selected);
}

const FOLLOW_UP_ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10
};

async function maybeSendOutstandingFollowUpContinuation(
  input: {
    userId: string;
    chatId: string;
    inboxItemId: string;
  },
  dependencies: TelegramWebhookDependencies
) {
  const followUpStore =
    dependencies.followUpStore ?? (dependencies.store as FollowUpRuntimeStore | undefined) ?? getDefaultFollowUpRuntimeStore();
  const outstandingTasks = await followUpStore.listOutstandingFollowUpTasks(input.userId);

  if (outstandingTasks.length === 0 || (await followUpStore.hasInFlightInboxItem(input.userId))) {
    return null;
  }

  const latestContext = await getLatestFollowUpBundleContext(input.userId, dependencies.conversationHistoryStore);
  const outstandingIds = outstandingTasks.map((task) => task.id);

  if (latestContext && latestContext.taskIds.join(",") === outstandingIds.join(",")) {
    return null;
  }

  const bundle = buildFollowUpBundle(outstandingTasks, "reminder");

  return sendTelegramMessageWithPersistence(
    {
      userId: input.userId,
      chatId: input.chatId,
      inboxItemId: `${input.inboxItemId}:followup-continuation`,
      text: bundle.text,
      bundle
    },
    {
      sender: dependencies.sender ?? sendTelegramMessage,
      ...(dependencies.deliveryStore ? { deliveryStore: dependencies.deliveryStore } : {})
    }
  );
}

function buildLazyLinkReplyIdempotencyKey(updateId: number) {
  return `telegram:lazy-link:${updateId}`;
}

function getCompatibilityTurnRouteFromPolicy(action: TurnRouterResult["policy"]["action"]) {
  switch (action) {
    case "reply_only":
      return "conversation" as const;
    case "ask_clarification":
    case "present_proposal":
      return "conversation_then_mutation" as const;
    case "execute_mutation":
      return "mutation" as const;
    case "recover_and_execute":
      return "confirmed_mutation" as const;
  }
}

function buildImmediateRouteFeedback(action: TurnRouterResult["policy"]["action"]): ImmediateRouteFeedback {
  switch (action) {
    case "execute_mutation":
      return {
        text: "Checking your schedule",
        chatAction: "typing"
      };
    case "recover_and_execute":
      return {
        text: "Applying that",
        chatAction: "typing"
      };
    case "reply_only":
    case "ask_clarification":
    case "present_proposal":
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
