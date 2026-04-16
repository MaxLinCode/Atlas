import { randomUUID } from "node:crypto";

import {
  type ConversationEntity,
  type ConversationRecordMode,
  type ConversationStateSnapshot,
  createEmptyDiscourseState,
  getActivePendingClarifications,
  type MutationResult,
  type PendingClarification,
  type PresentedItem,
  type ScheduleBlock,
  type Task,
  type TurnInterpretation,
  type TurnPolicyAction,
  type TurnPolicyDecision,
  updateDiscourseStateFromAssistantTurn,
} from "@atlas/core";

type DeriveConversationReplyStateInput = {
  snapshot: ConversationStateSnapshot;
  policy: Pick<
    TurnPolicyDecision,
    "action" | "clarificationSlots" | "targetProposalId" | "resolvedOperation"
  > & {
    action: Extract<
      TurnPolicyAction,
      "reply_only" | "ask_clarification" | "present_proposal"
    >;
  };
  interpretation: TurnInterpretation;
  reply: string;
  userTurnText: string;
  summaryText: string | null;
  occurredAt?: string;
};

type DeriveMutationStateInput = {
  snapshot: ConversationStateSnapshot;
  processing: MutationResult;
  occurredAt?: string;
};

export function deriveConversationReplyState(
  input: DeriveConversationReplyStateInput,
) {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const entityRegistry = [...input.snapshot.entityRegistry];
  const discourseState =
    input.snapshot.discourseState ?? createEmptyDiscourseState();
  const presentedItems: PresentedItem[] = [];
  const newClarifications: PendingClarification[] = [];
  const resolvedClarificationIds: string[] = [];
  const activePendingClarifications =
    getActivePendingClarifications(discourseState);
  const persistableClarificationSlots = derivePersistableClarificationSlots(
    input.policy.clarificationSlots,
  );
  const shouldPersistClarification =
    input.policy.action === "ask_clarification" &&
    persistableClarificationSlots.length > 0;
  const shouldClearActiveClarifications =
    shouldPersistClarification ||
    input.policy.action === "present_proposal" ||
    input.interpretation.turnType === "confirmation" ||
    (input.interpretation.turnType === "clarification_answer" &&
      !shouldPersistClarification);
  let nextFocusEntityId: string | null | undefined;

  if (shouldClearActiveClarifications) {
    resolvedClarificationIds.push(
      ...activePendingClarifications.map((clarification) => clarification.id),
    );

    for (let index = 0; index < entityRegistry.length; index += 1) {
      const entity = entityRegistry[index];

      if (entity?.kind === "clarification" && entity.status === "active") {
        entityRegistry[index] = {
          ...entity,
          status: "resolved",
          updatedAt: occurredAt,
        };
      }
    }
  }

  if (input.policy.action === "present_proposal") {
    const proposalEntity = upsertActiveProposalEntity(
      entityRegistry,
      input.snapshot.conversation.id,
      compactObject({
        proposalId: input.policy.targetProposalId,
        kind: "proposal_option" as const,
        label: summarizeLabel(input.reply),
        status: "active" as const,
        createdAt: occurredAt,
        updatedAt: occurredAt,
        data: {
          route: "conversation_then_mutation" as const,
          replyText: input.reply,
          policyAction: input.policy.action,
          targetEntityId: input.interpretation.resolvedEntityIds[0] ?? null,
          confirmationRequired: true,
          originatingTurnText: input.userTurnText,
          missingFields: input.policy.clarificationSlots,
          fieldSnapshot: input.policy.resolvedOperation?.resolvedFields ?? {},
        },
      }),
    );

    presentedItems.push({
      id: `presented_${proposalEntity.id}`,
      type: "entity",
      entityId: proposalEntity.id,
      label: proposalEntity.label,
      ordinal: 1,
    });
    nextFocusEntityId = proposalEntity.id;
  }

  if (shouldPersistClarification) {
    const [clarificationSlot] = persistableClarificationSlots;

    if (!clarificationSlot) {
      throw new Error(
        "Expected a persistable clarification slot when persisting clarification state.",
      );
    }

    const parentTargetRef =
      input.policy.resolvedOperation?.targetRef ?? null;

    // Close any prior open clarifications (one-open-per-workflow)
    for (let i = 0; i < entityRegistry.length; i++) {
      const entity = entityRegistry[i]!;
      if (entity.kind === "clarification" && entity.data.open) {
        entityRegistry[i] = {
          ...entity,
          status: "resolved" as const,
          updatedAt: occurredAt,
          data: { ...entity.data, open: false },
        };
        resolvedClarificationIds.push(entity.id);
      }
    }

    const clarificationEntity = buildConversationEntity(
      input.snapshot.conversation.id,
      {
        kind: "clarification",
        label: summarizeLabel(input.reply),
        status: "active",
        createdAt: occurredAt,
        updatedAt: occurredAt,
        data: {
          prompt: input.reply,
          reason: clarificationSlot,
          open: true,
          parentTargetRef,
        },
      },
    );

    entityRegistry.push(clarificationEntity);
    newClarifications.push({
      id: clarificationEntity.id,
      slot: clarificationSlot,
      question: input.reply,
      status: "pending",
      createdAt: occurredAt,
      createdTurnId: `assistant:${occurredAt}`,
    });
    nextFocusEntityId ??= clarificationEntity.id;
  }
  const updatedDiscourseState = updateDiscourseStateFromAssistantTurn(
    discourseState,
    {
      ...(presentedItems.length > 0 ? { presentedItems } : {}),
      ...(newClarifications.length > 0 ? { newClarifications } : {}),
      ...(resolvedClarificationIds.length > 0
        ? { resolvedClarificationIds }
        : {}),
      ...(nextFocusEntityId !== undefined
        ? { focusEntityId: nextFocusEntityId }
        : {}),
      pendingConfirmation: input.policy.action === "present_proposal",
      validEntityIds: entityRegistry.map((entity) => entity.id),
    },
  ).state;

  const nextDiscourseState = {
    ...updatedDiscourseState,
    ...(input.policy.resolvedOperation
      ? { pending_write_operation: input.policy.resolvedOperation }
      : {}),
  };

  return {
    summaryText: input.summaryText,
    mode: getConversationModeForPolicy(input.policy.action),
    entityRegistry: trimEntityRegistry(entityRegistry),
    discourseState: nextDiscourseState,
  };
}

export function deriveMutationState(input: DeriveMutationStateInput) {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const existingByKey = new Map<string, ConversationEntity>(
    input.snapshot.entityRegistry.map((entity) => [entityKey(entity), entity]),
  );
  const currentDiscourseState =
    input.snapshot.discourseState ?? createEmptyDiscourseState();
  const resolvedClarificationIds = getActivePendingClarifications(
    currentDiscourseState,
  ).map((clarification) => clarification.id);
  const entityRegistry: ConversationEntity[] =
    input.snapshot.entityRegistry.map((entity) => {
      if (
        entity.kind === "proposal_option" ||
        entity.kind === "clarification"
      ) {
        return {
          ...entity,
          status: "resolved",
          updatedAt: occurredAt,
        };
      }

      return entity;
    });
  let lastConcreteEntityId: string | null = null;

  for (const task of selectTasks(input.processing)) {
    const key = `task:${task.id}`;
    const existing = existingByKey.get(key);
    const nextEntity = buildConversationEntity(input.snapshot.conversation.id, {
      kind: "task",
      label: task.title,
      status: isTaskResolved(task) ? "resolved" : "active",
      createdAt: existing?.createdAt ?? occurredAt,
      updatedAt: occurredAt,
      ...(existing ? { id: existing.id } : {}),
      data: {
        taskId: task.id,
        title: task.title,
        lifecycleState: task.lifecycleState,
        scheduledStartAt: task.scheduledStartAt,
        scheduledEndAt: task.scheduledEndAt,
      },
    });

    replaceEntity(entityRegistry, nextEntity, key);
    lastConcreteEntityId = nextEntity.id;
  }

  for (const block of selectScheduleBlocks(input.processing)) {
    const taskTitle = findTaskTitleForBlock(block, input.processing);
    const key = `scheduled_block:${block.id}`;
    const existing = existingByKey.get(key);
    const nextEntity = buildConversationEntity(input.snapshot.conversation.id, {
      kind: "scheduled_block",
      label: `${taskTitle} at ${block.startAt}`,
      status: "active",
      createdAt: existing?.createdAt ?? occurredAt,
      updatedAt: occurredAt,
      ...(existing ? { id: existing.id } : {}),
      data: {
        blockId: block.id,
        taskId: block.taskId,
        title: taskTitle,
        startAt: block.startAt,
        endAt: block.endAt,
        externalCalendarId: block.externalCalendarId ?? null,
      },
    });

    replaceEntity(entityRegistry, nextEntity, key);
    lastConcreteEntityId = nextEntity.id;
  }

  const newClarifications: PendingClarification[] = [];

  if (input.processing.outcome === "needs_clarification") {
    const clarificationEntity = buildConversationEntity(
      input.snapshot.conversation.id,
      {
        kind: "clarification",
        label: summarizeLabel(input.processing.followUpMessage),
        status: "active",
        createdAt: occurredAt,
        updatedAt: occurredAt,
        data: {
          prompt: input.processing.followUpMessage,
          reason: input.processing.reason,
          open: true,
          parentTargetRef: null,
        },
      },
    );

    entityRegistry.push(clarificationEntity);
    newClarifications.push({
      id: clarificationEntity.id,
      entityId: lastConcreteEntityId ?? undefined,
      slot: input.processing.reason,
      question: input.processing.followUpMessage,
      status: "pending",
      createdAt: occurredAt,
      createdTurnId: `assistant:${occurredAt}`,
    });
  }

  const discourseState = updateDiscourseStateFromAssistantTurn(
    currentDiscourseState,
    {
      ...(newClarifications.length > 0 ? { newClarifications } : {}),
      ...(resolvedClarificationIds.length > 0
        ? { resolvedClarificationIds }
        : {}),
      focusEntityId: lastConcreteEntityId,
      editableEntityId: lastConcreteEntityId,
      pendingConfirmation: false,
      validEntityIds: entityRegistry.map((entity) => entity.id),
    },
  ).state;

  const isFlowComplete = input.processing.outcome !== "needs_clarification";
  const finalDiscourseState = isFlowComplete
    ? {
        ...discourseState,
        pending_write_operation: undefined,
      }
    : discourseState;

  return {
    mode: (input.processing.outcome === "needs_clarification"
      ? "conversation_then_mutation"
      : "mutation") as ConversationRecordMode,
    entityRegistry: trimEntityRegistry(entityRegistry),
    discourseState: finalDiscourseState,
  };
}

function selectTasks(processing: MutationResult): Task[] {
  switch (processing.outcome) {
    case "created":
    case "scheduled":
    case "completed":
    case "archived":
      return processing.tasks;
    default:
      return [];
  }
}

function selectScheduleBlocks(processing: MutationResult): ScheduleBlock[] {
  switch (processing.outcome) {
    case "created":
    case "scheduled":
      return processing.scheduleBlocks;
    case "rescheduled":
      return [processing.updatedBlock];
    default:
      return [];
  }
}

function findTaskTitleForBlock(
  block: ScheduleBlock,
  processing: MutationResult,
) {
  return (
    selectTasks(processing).find((task) => task.id === block.taskId)?.title ??
    "Scheduled work"
  );
}

function isTaskResolved(task: Task) {
  return task.lifecycleState === "done" || task.lifecycleState === "archived";
}

function summarizeLabel(text: string) {
  return text.trim().slice(0, 120);
}

function getConversationModeForPolicy(
  policyAction: DeriveConversationReplyStateInput["policy"]["action"],
): ConversationRecordMode {
  return policyAction === "reply_only"
    ? "conversation"
    : "conversation_then_mutation";
}

function buildConversationEntity(
  conversationId: string,
  input: {
    id?: string;
    kind: ConversationEntity["kind"];
    label: string;
    status: ConversationEntity["status"];
    createdAt: string;
    updatedAt: string;
    data: ConversationEntity["data"];
  },
): ConversationEntity {
  return {
    ...input,
    id: input.id ?? randomUUID(),
    conversationId,
  } as ConversationEntity;
}

function upsertActiveProposalEntity(
  entityRegistry: ConversationEntity[],
  conversationId: string,
  input: {
    proposalId?: string;
    kind: Extract<ConversationEntity["kind"], "proposal_option">;
    label: string;
    status: Extract<ConversationEntity["status"], "active">;
    createdAt: string;
    updatedAt: string;
    data: Extract<ConversationEntity, { kind: "proposal_option" }>["data"];
  },
) {
  let existingProposal: Extract<
    ConversationEntity,
    { kind: "proposal_option" }
  > | null = null;

  for (let index = 0; index < entityRegistry.length; index += 1) {
    const entity = entityRegistry[index];

    if (entity?.kind !== "proposal_option") {
      continue;
    }

    if (input.proposalId && entity.id === input.proposalId) {
      existingProposal = entity;
      continue;
    }

    if (entity.status === "active") {
      entityRegistry[index] = {
        ...entity,
        status: "superseded",
        updatedAt: input.updatedAt,
      };
    }
  }

  const nextProposal = buildConversationEntity(conversationId, {
    kind: input.kind,
    label: input.label,
    status: input.status,
    createdAt: existingProposal?.createdAt ?? input.createdAt,
    updatedAt: input.updatedAt,
    data: input.data,
  }) as Extract<ConversationEntity, { kind: "proposal_option" }>;

  const proposalId = input.proposalId ?? existingProposal?.id;

  if (proposalId) {
    nextProposal.id = proposalId;
  }

  replaceEntity(
    entityRegistry,
    nextProposal,
    `proposal_option:${nextProposal.id}`,
  );

  return nextProposal;
}

const PERSISTABLE_SLOT_KEYS = new Set([
  "scheduleFields.day",
  "scheduleFields.time",
  "scheduleFields.duration",
]);

function derivePersistableClarificationSlots(slots: string[] | undefined) {
  if (!slots) {
    return [];
  }

  return Array.from(
    new Set(
      slots
        .map((slot) => slot.trim())
        .filter((slot) => PERSISTABLE_SLOT_KEYS.has(slot)),
    ),
  );
}

function compactObject<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as {
    [K in keyof T as undefined extends T[K] ? never : K]: Exclude<
      T[K],
      undefined
    >;
  } & {
    [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
      T[K],
      undefined
    >;
  };
}

function entityKey(entity: ConversationEntity) {
  switch (entity.kind) {
    case "task":
      return `task:${entity.data.taskId}`;
    case "scheduled_block":
      return `scheduled_block:${entity.data.blockId}`;
    case "reminder":
      return `reminder:${entity.data.taskId}:${entity.data.reminderKind}`;
    case "draft_task":
      return `draft_task:${entity.id}`;
    default:
      return `${entity.kind}:${entity.id}`;
  }
}

function replaceEntity(
  entityRegistry: ConversationEntity[],
  nextEntity: ConversationEntity,
  key: string,
) {
  const index = entityRegistry.findIndex((entity) => entityKey(entity) === key);

  if (index >= 0) {
    entityRegistry.splice(index, 1, nextEntity);
    return;
  }

  entityRegistry.push(nextEntity);
}

function trimEntityRegistry(entityRegistry: ConversationEntity[]) {
  return entityRegistry
    .sort(
      (left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt),
    )
    .slice(-20);
}
