import { randomUUID } from "node:crypto";

import {
  createEmptyDiscourseState,
  updateDiscourseStateFromAssistantTurn,
  type ConversationEntity,
  type ConversationRecordMode,
  type ConversationStateSnapshot,
  type PendingClarification,
  type PresentedItem,
  type ScheduleBlock,
  type Task,
  type TurnInterpretation,
  type TurnPolicyAction
} from "@atlas/core";
import { type ProcessedInboxResult } from "@atlas/db";

type DeriveConversationReplyStateInput = {
  snapshot: ConversationStateSnapshot;
  policyAction: Extract<TurnPolicyAction, "reply_only" | "ask_clarification" | "present_proposal">;
  interpretation: TurnInterpretation;
  reply: string;
  userTurnText: string;
  summaryText: string | null;
  occurredAt?: string;
};

type DeriveMutationStateInput = {
  snapshot: ConversationStateSnapshot;
  processing: ProcessedInboxResult;
  occurredAt?: string;
};

export function deriveConversationReplyState(input: DeriveConversationReplyStateInput) {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const entityRegistry = [...input.snapshot.entityRegistry];
  const discourseState = input.snapshot.discourseState ?? createEmptyDiscourseState();
  const presentedItems: PresentedItem[] = [];
  const newClarifications: PendingClarification[] = [];
  let nextFocusEntityId: string | null | undefined;

  if (input.policyAction === "present_proposal") {
    const proposalEntity = buildConversationEntity(input.snapshot.conversation.id, {
      kind: "proposal_option",
      label: summarizeLabel(input.reply),
      status: "active",
      createdAt: occurredAt,
      updatedAt: occurredAt,
      data: {
        route: "conversation_then_mutation",
        replyText: input.reply,
        policyAction: input.policyAction,
        targetEntityId: input.interpretation.resolvedEntityIds[0] ?? null,
        mutationInputSource: null,
        confirmationRequired: true,
        originatingTurnText: input.userTurnText,
        missingSlots: input.interpretation.missingSlots
      }
    });

    entityRegistry.push(proposalEntity);
    presentedItems.push({
      id: `presented_${proposalEntity.id}`,
      type: "entity",
      entityId: proposalEntity.id,
      label: proposalEntity.label,
      ordinal: 1
    });
    nextFocusEntityId = proposalEntity.id;
  }

  if (input.policyAction === "ask_clarification") {
    const clarificationEntity = buildConversationEntity(input.snapshot.conversation.id, {
      kind: "clarification",
      label: summarizeLabel(input.reply),
      status: "active",
      createdAt: occurredAt,
      updatedAt: occurredAt,
      data: {
        prompt: input.reply,
        reason: null,
        open: true
      }
    });

    entityRegistry.push(clarificationEntity);
    newClarifications.push({
      id: clarificationEntity.id,
      slot: "unknown",
      question: input.reply,
      status: "pending",
      blocking: true,
      createdAt: occurredAt,
      createdTurnId: `assistant:${occurredAt}`
    });
    nextFocusEntityId ??= clarificationEntity.id;
  }
  const nextDiscourseState = updateDiscourseStateFromAssistantTurn(discourseState, {
    ...(presentedItems.length > 0 ? { presentedItems } : {}),
    ...(newClarifications.length > 0 ? { newClarifications } : {}),
    ...(nextFocusEntityId !== undefined ? { focusEntityId: nextFocusEntityId } : {}),
    pendingConfirmation: input.policyAction === "present_proposal",
    validEntityIds: entityRegistry.map((entity) => entity.id)
  }).state;

  return {
    summaryText: input.summaryText,
    mode: getConversationModeForPolicy(input.policyAction),
    entityRegistry: trimEntityRegistry(entityRegistry),
    discourseState: nextDiscourseState
  };
}

export function deriveMutationState(input: DeriveMutationStateInput) {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const existingByKey = new Map<string, ConversationEntity>(
    input.snapshot.entityRegistry.map((entity) => [entityKey(entity), entity])
  );
  const entityRegistry: ConversationEntity[] = input.snapshot.entityRegistry.map((entity) => {
    if (entity.kind === "proposal_option" || entity.kind === "clarification") {
      return {
        ...entity,
        status: "resolved",
        updatedAt: occurredAt
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
        scheduledEndAt: task.scheduledEndAt
      }
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
        externalCalendarId: block.externalCalendarId ?? null
      }
    });

    replaceEntity(entityRegistry, nextEntity, key);
    lastConcreteEntityId = nextEntity.id;
  }

  const newClarifications: PendingClarification[] = [];

  if (input.processing.outcome === "needs_clarification") {
    const clarificationEntity = buildConversationEntity(input.snapshot.conversation.id, {
      kind: "clarification",
      label: summarizeLabel(input.processing.followUpMessage),
      status: "active",
      createdAt: occurredAt,
      updatedAt: occurredAt,
      data: {
        prompt: input.processing.followUpMessage,
        reason: input.processing.reason,
        open: true
      }
    });

    entityRegistry.push(clarificationEntity);
    newClarifications.push({
      id: clarificationEntity.id,
      entityId: lastConcreteEntityId ?? undefined,
      slot: input.processing.reason,
      question: input.processing.followUpMessage,
      status: "pending",
      blocking: true,
      createdAt: occurredAt,
      createdTurnId: `assistant:${occurredAt}`
    });
  }

  const discourseState = updateDiscourseStateFromAssistantTurn(
    input.snapshot.discourseState ?? createEmptyDiscourseState(),
    {
      ...(newClarifications.length > 0 ? { newClarifications } : {}),
      focusEntityId: lastConcreteEntityId,
      editableEntityId: lastConcreteEntityId,
      pendingConfirmation: false,
      validEntityIds: entityRegistry.map((entity) => entity.id)
    }
  ).state;

  return {
    mode: (input.processing.outcome === "needs_clarification" ? "conversation_then_mutation" : "mutation") as
      ConversationRecordMode,
    entityRegistry: trimEntityRegistry(entityRegistry),
    discourseState
  };
}

function selectTasks(processing: ProcessedInboxResult): Task[] {
  switch (processing.outcome) {
    case "planned":
      return processing.createdTasks;
    case "scheduled_existing_tasks":
      return processing.scheduledTasks;
    case "completed_tasks":
      return processing.completedTasks;
    case "archived_tasks":
      return processing.archivedTasks;
    default:
      return [];
  }
}

function selectScheduleBlocks(processing: ProcessedInboxResult): ScheduleBlock[] {
  switch (processing.outcome) {
    case "planned":
    case "scheduled_existing_tasks":
      return processing.scheduleBlocks;
    case "updated_schedule":
      return [processing.updatedBlock];
    default:
      return [];
  }
}

function findTaskTitleForBlock(block: ScheduleBlock, processing: ProcessedInboxResult) {
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
  policyAction: DeriveConversationReplyStateInput["policyAction"]
): ConversationRecordMode {
  return policyAction === "reply_only" ? "conversation" : "conversation_then_mutation";
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
  }
): ConversationEntity {
  return {
    ...input,
    id: input.id ?? randomUUID(),
    conversationId
  } as ConversationEntity;
}

function entityKey(entity: ConversationEntity) {
  switch (entity.kind) {
    case "task":
      return `task:${entity.data.taskId}`;
    case "scheduled_block":
      return `scheduled_block:${entity.data.blockId}`;
    case "reminder":
      return `reminder:${entity.data.taskId}:${entity.data.reminderKind}`;
    default:
      return `${entity.kind}:${entity.id}`;
  }
}

function replaceEntity(entityRegistry: ConversationEntity[], nextEntity: ConversationEntity, key: string) {
  const index = entityRegistry.findIndex((entity) => entityKey(entity) === key);

  if (index >= 0) {
    entityRegistry.splice(index, 1, nextEntity);
    return;
  }

  entityRegistry.push(nextEntity);
}

function trimEntityRegistry(entityRegistry: ConversationEntity[]) {
  return entityRegistry
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
    .slice(-20);
}
