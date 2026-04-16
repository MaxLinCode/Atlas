import type {
  ConversationStateSnapshot,
  MutationResult,
  PendingWriteOperation,
  TimeSpec,
} from "@atlas/core";
import { describe, expect, it } from "vitest";

function t(hour: number, minute: number): TimeSpec {
  return { kind: "absolute", hour, minute };
}

function buildPendingWriteOperation(
  overrides?: Partial<PendingWriteOperation>,
): PendingWriteOperation {
  return {
    operationKind: "plan",
    targetRef: null,
    resolvedFields: {},
    missingFields: [],
    originatingText: "schedule gym tomorrow",
    startedAt: "2026-03-22T16:00:00.000Z",
    ...overrides,
  };
}

import {
  deriveConversationReplyState,
  deriveMutationState,
} from "./conversation-state";

function buildSnapshot(): ConversationStateSnapshot {
  return {
    conversation: {
      id: "conversation-1",
      userId: "user-1",
      title: null,
      mode: "conversation" as const,
      summaryText: null,
      createdAt: "2026-03-22T16:00:00.000Z",
      updatedAt: "2026-03-22T16:00:00.000Z",
    },
    transcript: [],
    entityRegistry: [],
    discourseState: {
      focus_entity_id: null,
      currently_editable_entity_id: null,
      last_user_mentioned_entity_ids: [],
      last_presented_items: [],
      pending_clarifications: [],
      mode: "planning" as const,
    },
  };
}

describe("deriveConversationReplyState", () => {
  it("persists a clarification only when structured interpretation still has a real missing slot", () => {
    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policy: {
        action: "ask_clarification",
        clarificationSlots: ["scheduleFields.time"],
      },
      interpretation: {
        turnType: "planning_request",
        confidence: 0.58,
        resolvedEntityIds: [],
        ambiguity: "high",
        missingFields: ["scheduleFields.time"],
      },
      reply: "What time should I schedule the Malaysia trip planning?",
      userTurnText: "schedule malaysia trip planning tomorrow",
      summaryText: null,
      occurredAt: "2026-03-22T16:05:00.000Z",
    });

    expect(result.entityRegistry).toHaveLength(1);
    expect(result.entityRegistry[0]).toMatchObject({
      kind: "clarification",
      status: "active",
      data: {
        reason: "scheduleFields.time",
      },
    });
    expect(result.discourseState?.pending_clarifications).toEqual([
      expect.objectContaining({
        slot: "scheduleFields.time",
        status: "pending",
      }),
    ]);
    expect(result.discourseState?.mode).toBe("clarifying");
  });

  it("does not persist clarification state for ask_clarification without a real blocking slot", () => {
    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policy: {
        action: "ask_clarification",
        clarificationSlots: ["proposal"],
      },
      interpretation: {
        turnType: "confirmation",
        confidence: 0.32,
        resolvedEntityIds: [],
        ambiguity: "high",
      },
      reply: "Which proposal do you want me to apply?",
      userTurnText: "ok",
      summaryText: null,
      occurredAt: "2026-03-22T16:05:00.000Z",
    });

    expect(result.entityRegistry).toHaveLength(0);
    expect(result.discourseState?.pending_clarifications).toEqual([]);
    expect(result.discourseState?.mode).toBe("planning");
  });

  it("rejects slot unknown as a persistable blocking clarification", () => {
    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policy: {
        action: "ask_clarification",
      },
      interpretation: {
        turnType: "unknown",
        confidence: 0.42,
        resolvedEntityIds: [],
        ambiguity: "high",
        missingFields: ["unknown"],
      },
      reply: "Can you clarify what you want me to change?",
      userTurnText: "do it",
      summaryText: null,
      occurredAt: "2026-03-22T16:05:00.000Z",
    });

    expect(result.entityRegistry).toHaveLength(0);
    expect(result.discourseState?.pending_clarifications).toEqual([]);
    expect(result.discourseState?.mode).toBe("planning");
  });

  it("clears active clarification state when a proposal is presented", () => {
    const snapshot = buildSnapshot();
    snapshot.entityRegistry = [
      {
        id: "clar-1",
        conversationId: "conversation-1",
        kind: "clarification",
        label: "Need a time",
        status: "active",
        createdAt: "2026-03-22T16:01:00.000Z",
        updatedAt: "2026-03-22T16:01:00.000Z",
        data: {
          prompt: "What time should I schedule it?",
          reason: "time",
          open: true,
          parentTargetRef: null,
        },
      },
    ];
    snapshot.discourseState = {
      focus_entity_id: "clar-1",
      currently_editable_entity_id: null,
      last_user_mentioned_entity_ids: [],
      last_presented_items: [],
      pending_clarifications: [
        {
          id: "clar-1",
          slot: "time",
          question: "What time should I schedule it?",
          status: "pending",

          createdAt: "2026-03-22T16:01:00.000Z",
          createdTurnId: "assistant:1",
        },
      ],
      mode: "clarifying",
    };

    const result = deriveConversationReplyState({
      snapshot,
      policy: {
        action: "present_proposal",
      },
      interpretation: {
        turnType: "clarification_answer",
        confidence: 0.93,
        resolvedEntityIds: ["task-1"],
        ambiguity: "none",
      },
      reply:
        "I can schedule the Malaysia trip planning at 5 PM. Want me to do that now?",
      userTurnText: "5pm",
      summaryText: null,
      occurredAt: "2026-03-22T16:05:00.000Z",
    });

    expect(result.entityRegistry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "clar-1",
          kind: "clarification",
          status: "resolved",
        }),
        expect.objectContaining({
          kind: "proposal_option",
          status: "active",
        }),
      ]),
    );
    expect(result.discourseState?.pending_clarifications).toEqual([]);
    expect(result.discourseState?.mode).toBe("confirming");
  });

  it("persists pending_write_operation with patched targetRef when draft is created", () => {
    const op = buildPendingWriteOperation({
      resolvedFields: { scheduleFields: { day: "tomorrow" } },
      missingFields: ["scheduleFields.time"],
    });

    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policy: {
        action: "ask_clarification",
        clarificationSlots: ["scheduleFields.time"],
        resolvedOperation: op,
      },
      interpretation: {
        turnType: "planning_request",
        confidence: 0.58,
        resolvedEntityIds: [],
        ambiguity: "high",
        missingFields: ["scheduleFields.time"],
      },
      reply: "What time should I schedule it?",
      userTurnText: "schedule gym tomorrow",
      summaryText: null,
      occurredAt: "2026-03-22T16:05:00.000Z",
    });

    const draftEntity = result.entityRegistry.find((e) => e.kind === "draft_task");
    expect(draftEntity).toBeDefined();
    expect(result.discourseState?.pending_write_operation).toEqual({
      ...op,
      targetRef: { entityId: draftEntity!.id },
    });
  });

  it("does not set pending_write_operation when resolvedOperation is absent", () => {
    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policy: {
        action: "reply_only",
      },
      interpretation: {
        turnType: "informational",
        confidence: 0.93,
        resolvedEntityIds: [],
        ambiguity: "none",
      },
      reply: "Your schedule is empty.",
      userTurnText: "what's on my schedule?",
      summaryText: null,
      occurredAt: "2026-03-22T16:05:00.000Z",
    });

    expect(result.discourseState?.pending_write_operation).toBeUndefined();
  });

  it("clears active clarifications when a clarification_answer resolves all slots", () => {
    const snapshot = buildSnapshot();
    snapshot.entityRegistry = [
      {
        id: "clar-1",
        conversationId: "conversation-1",
        kind: "clarification",
        label: "Need a time",
        status: "active",
        createdAt: "2026-03-22T16:01:00.000Z",
        updatedAt: "2026-03-22T16:01:00.000Z",
        data: {
          prompt: "What time should I schedule it?",
          reason: "time",
          open: true,
          parentTargetRef: null,
        },
      },
    ];
    snapshot.discourseState = {
      focus_entity_id: "clar-1",
      currently_editable_entity_id: null,
      last_user_mentioned_entity_ids: [],
      last_presented_items: [],
      pending_clarifications: [
        {
          id: "clar-1",
          slot: "time",
          question: "What time should I schedule it?",
          status: "pending",
          createdAt: "2026-03-22T16:01:00.000Z",
          createdTurnId: "assistant:1",
        },
      ],
      mode: "clarifying",
    };

    const result = deriveConversationReplyState({
      snapshot,
      policy: {
        action: "present_proposal",
        resolvedOperation: buildPendingWriteOperation({
          resolvedFields: {
            scheduleFields: { day: "tomorrow", time: t(17, 0) },
          },
          missingFields: [],
        }),
      },
      interpretation: {
        turnType: "clarification_answer",
        confidence: 0.93,
        resolvedEntityIds: [],
        ambiguity: "none",
      },
      reply: "I'll schedule gym at 5 PM tomorrow. Sound good?",
      userTurnText: "5pm",
      summaryText: null,
      occurredAt: "2026-03-22T16:05:00.000Z",
    });

    expect(result.discourseState?.pending_clarifications).toEqual([]);
    expect(result.entityRegistry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "clar-1",
          kind: "clarification",
          status: "resolved",
        }),
      ]),
    );
  });

  it("sets parentTargetRef on clarification entity from resolvedOperation targetRef", () => {
    const op = buildPendingWriteOperation({
      targetRef: { entityId: "task-1" },
      resolvedFields: { scheduleFields: { day: "tomorrow" } },
      missingFields: ["scheduleFields.time"],
    });

    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policy: {
        action: "ask_clarification",
        clarificationSlots: ["scheduleFields.time"],
        resolvedOperation: op,
      },
      interpretation: {
        turnType: "planning_request",
        confidence: 0.58,
        resolvedEntityIds: [],
        ambiguity: "high",
        missingFields: ["scheduleFields.time"],
      },
      reply: "What time should I schedule it?",
      userTurnText: "schedule gym tomorrow",
      summaryText: null,
      occurredAt: "2026-03-22T16:05:00.000Z",
    });

    const clarEntity = result.entityRegistry.find((e) => e.kind === "clarification");
    expect(clarEntity).toBeDefined();
    expect(clarEntity!.data.parentTargetRef).toEqual({ entityId: "task-1" });
  });

  it("sets parentTargetRef to draft entity on clarification for new plans", () => {
    const op = buildPendingWriteOperation({
      targetRef: null,
      resolvedFields: { scheduleFields: { day: "tomorrow" } },
      missingFields: ["scheduleFields.time"],
    });

    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policy: {
        action: "ask_clarification",
        clarificationSlots: ["scheduleFields.time"],
        resolvedOperation: op,
      },
      interpretation: {
        turnType: "planning_request",
        confidence: 0.58,
        resolvedEntityIds: [],
        ambiguity: "high",
        missingFields: ["scheduleFields.time"],
      },
      reply: "What time should I schedule it?",
      userTurnText: "schedule gym tomorrow",
      summaryText: null,
      occurredAt: "2026-03-22T16:05:00.000Z",
    });

    const draftEntity = result.entityRegistry.find((e) => e.kind === "draft_task");
    const clarEntity = result.entityRegistry.find((e) => e.kind === "clarification");
    expect(draftEntity).toBeDefined();
    expect(clarEntity).toBeDefined();
    expect(clarEntity!.data.parentTargetRef).toEqual({ entityId: draftEntity!.id });
  });

  it("closes prior open clarification when a new one is created", () => {
    const snapshot = buildSnapshot();
    snapshot.entityRegistry = [
      {
        id: "clar-old",
        conversationId: "conversation-1",
        kind: "clarification",
        label: "Need a time",
        status: "active",
        createdAt: "2026-03-22T16:01:00.000Z",
        updatedAt: "2026-03-22T16:01:00.000Z",
        data: { prompt: "What time?", reason: "scheduleFields.time", open: true, parentTargetRef: null },
      },
    ];
    snapshot.discourseState = {
      focus_entity_id: "clar-old",
      currently_editable_entity_id: null,
      last_user_mentioned_entity_ids: [],
      last_presented_items: [],
      pending_clarifications: [
        { id: "clar-old", slot: "scheduleFields.time", question: "What time?", status: "pending", createdAt: "2026-03-22T16:01:00.000Z", createdTurnId: "assistant:1" },
      ],
      mode: "clarifying",
    };

    const op = buildPendingWriteOperation({
      targetRef: null,
      resolvedFields: { scheduleFields: { day: "tomorrow" } },
      missingFields: ["scheduleFields.duration"],
    });

    const result = deriveConversationReplyState({
      snapshot,
      policy: {
        action: "ask_clarification",
        clarificationSlots: ["scheduleFields.duration"],
        resolvedOperation: op,
      },
      interpretation: {
        turnType: "clarification_answer",
        confidence: 0.8,
        resolvedEntityIds: [],
        ambiguity: "high",
        missingFields: ["scheduleFields.duration"],
      },
      reply: "Got it, 5pm. How long should it be?",
      userTurnText: "5pm",
      summaryText: null,
      occurredAt: "2026-03-22T16:06:00.000Z",
    });

    const oldClar = result.entityRegistry.find((e) => e.id === "clar-old");
    expect(oldClar).toMatchObject({
      status: "resolved",
      data: expect.objectContaining({ open: false }),
    });

    const newClars = result.entityRegistry.filter(
      (e) => e.kind === "clarification" && e.data.open === true,
    );
    expect(newClars).toHaveLength(1);
    expect(newClars[0]!.data).toMatchObject({ reason: "scheduleFields.duration" });
  });

  it("creates a draft_task entity when operationKind is plan and targetRef is null", () => {
    const op = buildPendingWriteOperation({
      operationKind: "plan",
      targetRef: null,
      resolvedFields: { scheduleFields: { day: "tomorrow" } },
      missingFields: ["scheduleFields.time"],
    });

    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policy: {
        action: "ask_clarification",
        clarificationSlots: ["scheduleFields.time"],
        resolvedOperation: op,
      },
      interpretation: {
        turnType: "planning_request",
        confidence: 0.58,
        resolvedEntityIds: [],
        ambiguity: "high",
        missingFields: ["scheduleFields.time"],
      },
      reply: "What time should I schedule gym?",
      userTurnText: "schedule gym tomorrow",
      summaryText: null,
      occurredAt: "2026-04-16T10:00:00.000Z",
    });

    const draftEntity = result.entityRegistry.find(
      (e) => e.kind === "draft_task",
    );
    expect(draftEntity).toBeDefined();
    expect(draftEntity!.status).toBe("active");
    expect(draftEntity!.data).toMatchObject({
      operationKind: "plan",
      taskName: null,
      resolvedFields: { scheduleFields: { day: "tomorrow" } },
      originatingText: "schedule gym tomorrow",
    });
  });

  it("sets parentTargetRef on clarification to draft entity for new plans", () => {
    const op = buildPendingWriteOperation({
      operationKind: "plan",
      targetRef: null,
      resolvedFields: { scheduleFields: { day: "tomorrow" } },
      missingFields: ["scheduleFields.time"],
    });

    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policy: {
        action: "ask_clarification",
        clarificationSlots: ["scheduleFields.time"],
        resolvedOperation: op,
      },
      interpretation: {
        turnType: "planning_request",
        confidence: 0.58,
        resolvedEntityIds: [],
        ambiguity: "high",
        missingFields: ["scheduleFields.time"],
      },
      reply: "What time should I schedule gym?",
      userTurnText: "schedule gym tomorrow",
      summaryText: null,
      occurredAt: "2026-04-16T10:00:00.000Z",
    });

    const draftEntity = result.entityRegistry.find(
      (e) => e.kind === "draft_task",
    );
    const clarEntity = result.entityRegistry.find(
      (e) => e.kind === "clarification",
    );

    expect(draftEntity).toBeDefined();
    expect(clarEntity).toBeDefined();
    expect(clarEntity!.data.parentTargetRef).toEqual({
      entityId: draftEntity!.id,
    });
  });

  it("patches pending_write_operation targetRef to draft entity ID for new plans", () => {
    const op = buildPendingWriteOperation({
      operationKind: "plan",
      targetRef: null,
      resolvedFields: { scheduleFields: { day: "tomorrow" } },
      missingFields: ["scheduleFields.time"],
    });

    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policy: {
        action: "ask_clarification",
        clarificationSlots: ["scheduleFields.time"],
        resolvedOperation: op,
      },
      interpretation: {
        turnType: "planning_request",
        confidence: 0.58,
        resolvedEntityIds: [],
        ambiguity: "high",
        missingFields: ["scheduleFields.time"],
      },
      reply: "What time should I schedule gym?",
      userTurnText: "schedule gym tomorrow",
      summaryText: null,
      occurredAt: "2026-04-16T10:00:00.000Z",
    });

    const draftEntity = result.entityRegistry.find(
      (e) => e.kind === "draft_task",
    );
    expect(draftEntity).toBeDefined();
    expect(result.discourseState?.pending_write_operation?.targetRef).toEqual({
      entityId: draftEntity!.id,
    });
  });

  it("updates existing draft_task instead of creating a new one on subsequent turns", () => {
    const snapshot = buildSnapshot();
    const existingDraft = {
      id: "draft-1",
      conversationId: "conversation-1",
      kind: "draft_task" as const,
      label: "schedule gym tomorrow",
      status: "active" as const,
      createdAt: "2026-04-16T10:00:00.000Z",
      updatedAt: "2026-04-16T10:00:00.000Z",
      data: {
        operationKind: "plan" as const,
        taskName: null,
        resolvedFields: { scheduleFields: { day: "tomorrow" } },
        originatingText: "schedule gym tomorrow",
      },
    };
    snapshot.entityRegistry = [existingDraft as any];

    const op = buildPendingWriteOperation({
      operationKind: "plan",
      targetRef: null,
      resolvedFields: {
        scheduleFields: { day: "tomorrow", time: t(17, 0) },
      },
      missingFields: ["scheduleFields.duration"],
    });

    const result = deriveConversationReplyState({
      snapshot,
      policy: {
        action: "ask_clarification",
        clarificationSlots: ["scheduleFields.duration"],
        resolvedOperation: op,
      },
      interpretation: {
        turnType: "clarification_answer",
        confidence: 0.8,
        resolvedEntityIds: [],
        ambiguity: "high",
        missingFields: ["scheduleFields.duration"],
      },
      reply: "Got it, 5pm. How long should it be?",
      userTurnText: "5pm",
      summaryText: null,
      occurredAt: "2026-04-16T10:05:00.000Z",
    });

    const drafts = result.entityRegistry.filter((e) => e.kind === "draft_task");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.id).toBe("draft-1");
    expect(drafts[0]!.data).toMatchObject({
      resolvedFields: {
        scheduleFields: { day: "tomorrow", time: t(17, 0) },
      },
    });
  });

  it("does not create a draft_task for edit operations", () => {
    const op = buildPendingWriteOperation({
      operationKind: "edit",
      targetRef: { entityId: "task-1" },
      resolvedFields: { scheduleFields: { time: t(17, 0) } },
      missingFields: [],
    });

    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policy: {
        action: "present_proposal",
        resolvedOperation: op,
      },
      interpretation: {
        turnType: "edit_request",
        confidence: 0.95,
        resolvedEntityIds: ["task-1"],
        ambiguity: "none",
      },
      reply: "I'll move it to 5pm. Sound good?",
      userTurnText: "move it to 5pm",
      summaryText: null,
      occurredAt: "2026-04-16T10:00:00.000Z",
    });

    const draftEntity = result.entityRegistry.find(
      (e) => e.kind === "draft_task",
    );
    expect(draftEntity).toBeUndefined();
  });

  it("does not create a draft_task when targetRef is non-null", () => {
    const op = buildPendingWriteOperation({
      operationKind: "plan",
      targetRef: { entityId: "task-1" },
      resolvedFields: { scheduleFields: { day: "tomorrow" } },
      missingFields: ["scheduleFields.time"],
    });

    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policy: {
        action: "ask_clarification",
        clarificationSlots: ["scheduleFields.time"],
        resolvedOperation: op,
      },
      interpretation: {
        turnType: "planning_request",
        confidence: 0.58,
        resolvedEntityIds: [],
        ambiguity: "high",
        missingFields: ["scheduleFields.time"],
      },
      reply: "What time should I schedule it?",
      userTurnText: "schedule gym tomorrow",
      summaryText: null,
      occurredAt: "2026-04-16T10:00:00.000Z",
    });

    const draftEntity = result.entityRegistry.find(
      (e) => e.kind === "draft_task",
    );
    expect(draftEntity).toBeUndefined();
  });
});

describe("deriveMutationState", () => {
  it("clears pending clarifications after execution", () => {
    const snapshot = buildSnapshot();
    snapshot.entityRegistry = [
      {
        id: "clar-1",
        conversationId: "conversation-1",
        kind: "clarification",
        label: "Need a time",
        status: "active",
        createdAt: "2026-03-22T16:01:00.000Z",
        updatedAt: "2026-03-22T16:01:00.000Z",
        data: {
          prompt: "What time should I schedule it?",
          reason: "time",
          open: true,
          parentTargetRef: null,
        },
      },
    ];
    snapshot.discourseState = {
      focus_entity_id: "clar-1",
      currently_editable_entity_id: null,
      last_user_mentioned_entity_ids: [],
      last_presented_items: [],
      pending_clarifications: [
        {
          id: "clar-1",
          slot: "time",
          question: "What time should I schedule it?",
          status: "pending",

          createdAt: "2026-03-22T16:01:00.000Z",
          createdTurnId: "assistant:1",
        },
      ],
      mode: "clarifying",
    };

    const processing: MutationResult = {
      outcome: "created",
      tasks: [
        {
          id: "task-1",
          userId: "user-1",
          sourceInboxItemId: "inbox-1",
          lastInboxItemId: "inbox-1",
          title: "Malaysia trip planning",
          lifecycleState: "scheduled",
          externalCalendarEventId: null,
          externalCalendarId: null,
          scheduledStartAt: "2026-03-23T00:00:00.000Z",
          scheduledEndAt: "2026-03-23T00:30:00.000Z",
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt: null,
          rescheduleCount: 0,
          lastFollowupAt: null,
          followupReminderSentAt: null,
          completedAt: null,
          archivedAt: null,
          priority: "medium",
          urgency: "medium",
        },
      ],
      scheduleBlocks: [
        {
          id: "block-1",
          userId: "user-1",
          taskId: "task-1",
          startAt: "2026-03-23T00:00:00.000Z",
          endAt: "2026-03-23T00:30:00.000Z",
          confidence: 0.92,
          reason: "User requested 5 PM.",
          rescheduleCount: 0,
          externalCalendarId: null,
        },
      ],
      followUpMessage: "Scheduled it for 5 PM.",
    };

    const result = deriveMutationState({
      snapshot,
      processing,
      occurredAt: "2026-03-22T16:10:00.000Z",
    });

    expect(result.discourseState.pending_clarifications).toEqual([]);
    expect(result.discourseState.mode).toBe("editing");
  });

  it("clears pending_write_operation on successful mutation", () => {
    const snapshot = buildSnapshot();
    snapshot.discourseState = {
      ...snapshot.discourseState!,
      pending_write_operation: buildPendingWriteOperation({
        resolvedFields: { scheduleFields: { day: "tomorrow", time: t(17, 0) } },
      }),
    };

    const processing: MutationResult = {
      outcome: "created",
      tasks: [
        {
          id: "task-1",
          userId: "user-1",
          sourceInboxItemId: "inbox-1",
          lastInboxItemId: "inbox-1",
          title: "Gym",
          lifecycleState: "scheduled",
          externalCalendarEventId: null,
          externalCalendarId: null,
          scheduledStartAt: "2026-03-23T17:00:00.000Z",
          scheduledEndAt: "2026-03-23T18:00:00.000Z",
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt: null,
          rescheduleCount: 0,
          lastFollowupAt: null,
          followupReminderSentAt: null,
          completedAt: null,
          archivedAt: null,
          priority: "medium",
          urgency: "medium",
        },
      ],
      scheduleBlocks: [
        {
          id: "block-1",
          userId: "user-1",
          taskId: "task-1",
          startAt: "2026-03-23T17:00:00.000Z",
          endAt: "2026-03-23T18:00:00.000Z",
          confidence: 0.92,
          reason: "User requested 5 PM.",
          rescheduleCount: 0,
          externalCalendarId: null,
        },
      ],
      followUpMessage: "Scheduled gym for 5 PM.",
    };

    const result = deriveMutationState({
      snapshot,
      processing,
      occurredAt: "2026-03-22T16:10:00.000Z",
    });

    expect(result.discourseState.pending_write_operation).toBeUndefined();
  });

  it("preserves pending_write_operation on needs_clarification", () => {
    const op = buildPendingWriteOperation({
      resolvedFields: { scheduleFields: { day: "tomorrow" } },
      missingFields: ["scheduleFields.time"],
    });
    const snapshot = buildSnapshot();
    snapshot.discourseState = {
      ...snapshot.discourseState!,
      pending_write_operation: op,
    };

    const processing: MutationResult = {
      outcome: "needs_clarification",
      reason: "time",
      followUpMessage: "What time should I schedule the gym?",
    };

    const result = deriveMutationState({
      snapshot,
      processing,
      occurredAt: "2026-03-22T16:10:00.000Z",
    });

    expect(result.discourseState.pending_write_operation).toEqual(op);
  });
});
