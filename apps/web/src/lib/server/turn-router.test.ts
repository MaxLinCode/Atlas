import type {
  PendingWriteOperation,
  TimeSpec,
  TurnClassifierOutput,
} from "@atlas/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

function t(hour: number, minute: number): TimeSpec {
  return { kind: "absolute", hour, minute };
}

import {
  containsModificationPayload,
  resolveWriteTarget,
  routeMessageTurn,
} from "./turn-router";

vi.mock("./llm-classifier", () => ({
  classifyTurn: vi.fn(),
}));

vi.mock("./interpret-write-turn", () => ({
  interpretWriteTurn: vi.fn().mockResolvedValue({
    operationKind: "plan",
    actionDomain: "task",
    targetRef: null,
    taskName: null,
    fields: {},
    sourceText: "default",
    confidence: {},
    unresolvedFields: [],
  }),
}));

import { classifyTurn } from "./llm-classifier";
import { interpretWriteTurn } from "./interpret-write-turn";

const mockClassifyTurn = vi.mocked(classifyTurn);
const mockInterpretWriteTurn = vi.mocked(interpretWriteTurn);

beforeEach(() => {
  vi.clearAllMocks();
  mockInterpretWriteTurn.mockResolvedValue({
    operationKind: "plan",
    actionDomain: "task",
    targetRef: null,
    taskName: null,
    fields: {},
    sourceText: "default",
    confidence: {},
    unresolvedFields: [],
  });
});

function mockClassification(output: Partial<TurnClassifierOutput>) {
  const full: TurnClassifierOutput = {
    turnType: "unknown",
    confidence: 0.5,
    ...output,
  };
  mockClassifyTurn.mockResolvedValue(full);
}

describe("turn router", () => {
  it("returns interpretation and direct-write policy for clear scheduling requests", async () => {
    mockClassification({
      turnType: "planning_request",
      confidence: 0.95,
    });
    mockInterpretWriteTurn.mockResolvedValueOnce({
      operationKind: "plan",
      actionDomain: "task",
      targetRef: null,
      taskName: "gym",
      fields: { scheduleFields: { day: "tomorrow", time: t(18, 0) } },
      sourceText: "Schedule gym tomorrow at 6pm for 1 hour",
      confidence: {
        "scheduleFields.day": 0.95,
        "scheduleFields.time": 0.95,
      },
      unresolvedFields: [],
    });

    const result = await routeMessageTurn({
      rawText: "Schedule gym tomorrow at 6pm for 1 hour",
      normalizedText: "Schedule gym tomorrow at 6pm for 1 hour",
      recentTurns: [],
    });

    expect(result).toMatchObject({
      interpretation: {
        turnType: "planning_request",
        ambiguity: "none",
      },
      policy: {
        action: "execute_mutation",
        mutationInputSource: "direct_user_turn",
      },
    });
  });

  it("represents recoverable confirmation as confirmation plus recover-and-execute", async () => {
    mockClassification({
      turnType: "confirmation",
      confidence: 0.97,
    });

    const result = await routeMessageTurn({
      rawText: "Yes",
      normalizedText: "Yes",
      recentTurns: [
        {
          role: "assistant",
          text: "Would you like me to schedule it at 3pm?",
          createdAt: "2026-03-17T16:00:00.000Z",
        },
      ],
      entityRegistry: [
        {
          id: "proposal-1",
          conversationId: "conversation-1",
          kind: "proposal_option",
          label: "Schedule it at 3pm",
          status: "active",
          createdAt: "2026-03-17T16:00:00.000Z",
          updatedAt: "2026-03-17T16:00:00.000Z",
          data: {
            route: "conversation_then_mutation",
            replyText: "Would you like me to schedule it at 3pm?",
            confirmationRequired: true,
            originatingTurnText: "Schedule dentist reminder tomorrow",
            targetEntityId: null,
            mutationInputSource: null,
            fieldSnapshot: {},
          },
        },
      ],
    });

    expect(result).toMatchObject({
      interpretation: {
        turnType: "confirmation",
        resolvedProposalId: "proposal-1",
      },
      policy: {
        action: "recover_and_execute",
        targetProposalId: "proposal-1",
        mutationInputSource: "recovered_proposal",
      },
    });
  });

  it("routes punctuated consent on an active proposal to recover-and-execute", async () => {
    mockClassification({
      turnType: "confirmation",
      confidence: 0.97,
    });

    const result = await routeMessageTurn({
      rawText: "Ok,",
      normalizedText: "Ok,",
      recentTurns: [
        {
          role: "assistant",
          text: "Would you like me to schedule it at 5pm?",
          createdAt: "2026-03-17T16:00:00.000Z",
        },
      ],
      entityRegistry: [
        {
          id: "proposal-1",
          conversationId: "conversation-1",
          kind: "proposal_option",
          label: "Schedule it at 5pm",
          status: "active",
          createdAt: "2026-03-17T16:00:00.000Z",
          updatedAt: "2026-03-17T16:00:00.000Z",
          data: {
            route: "conversation_then_mutation",
            replyText: "Would you like me to schedule it at 5pm?",
            confirmationRequired: true,
            originatingTurnText: "Schedule Malaysia trip planning at 5pm",
            targetEntityId: null,
            mutationInputSource: null,
            fieldSnapshot: {},
          },
        },
      ],
    });

    expect(result).toMatchObject({
      interpretation: {
        turnType: "confirmation",
        resolvedProposalId: "proposal-1",
      },
      policy: {
        action: "recover_and_execute",
        targetProposalId: "proposal-1",
      },
    });
  });

  it("does not set resolvedOperation for reply_only turns", async () => {
    mockClassification({
      turnType: "informational",
      confidence: 0.93,
    });

    const result = await routeMessageTurn({
      rawText: "What's on my schedule?",
      normalizedText: "What's on my schedule?",
      recentTurns: [],
    });

    expect(result.policy.action).toBe("reply_only");
    expect(result.policy.resolvedOperation).toBeUndefined();
  });

  it("includes resolvedOperation with extracted fields for planning_request", async () => {
    mockClassification({
      turnType: "planning_request",
      confidence: 0.95,
    });
    mockInterpretWriteTurn.mockResolvedValueOnce({
      operationKind: "plan",
      actionDomain: "task",
      targetRef: null,
      taskName: "gym",
      fields: { scheduleFields: { day: "tomorrow", time: t(18, 0) } },
      sourceText: "Schedule gym tomorrow at 6pm",
      confidence: {
        "scheduleFields.day": 0.95,
        "scheduleFields.time": 0.95,
      },
      unresolvedFields: [],
    });

    const result = await routeMessageTurn({
      rawText: "Schedule gym tomorrow at 6pm",
      normalizedText: "Schedule gym tomorrow at 6pm",
      recentTurns: [],
    });

    expect(result.policy.resolvedOperation).toMatchObject({
      operationKind: "plan",
      resolvedFields: {
        scheduleFields: { day: "tomorrow", time: t(18, 0) },
      },
      missingFields: [],
    });
  });

  it("carries forward operationKind from prior pending_write_operation for clarification_answer", async () => {
    const priorOperation: PendingWriteOperation = {
      operationKind: "edit",
      targetRef: null,
      resolvedFields: {},
      missingFields: ["scheduleFields.time"],
      originatingText: "reschedule gym",
      startedAt: new Date().toISOString(),
    };

    mockClassification({
      turnType: "clarification_answer",
      confidence: 0.9,
    });
    mockInterpretWriteTurn.mockResolvedValueOnce({
      operationKind: "edit",
      actionDomain: "task",
      targetRef: null,
      taskName: null,
      fields: { scheduleFields: { time: t(17, 0) } },
      sourceText: "5pm",
      confidence: { "scheduleFields.time": 0.92 },
      unresolvedFields: [],
    });

    const result = await routeMessageTurn({
      rawText: "5pm",
      normalizedText: "5pm",
      recentTurns: [],
      discourseState: {
        focus_entity_id: null,
        currently_editable_entity_id: null,
        last_user_mentioned_entity_ids: [],
        last_presented_items: [],
        pending_clarifications: [],
        pending_write_operation: priorOperation,
        mode: "clarifying",
      },
    });

    expect(result.policy.resolvedOperation).toMatchObject({
      operationKind: "edit",
      resolvedFields: { scheduleFields: { time: t(17, 0) } },
    });
  });

  it("defaults to plan operationKind when no prior operation exists for clarification_answer", async () => {
    mockClassification({
      turnType: "clarification_answer",
      confidence: 0.9,
    });
    mockInterpretWriteTurn.mockResolvedValueOnce({
      operationKind: "plan",
      actionDomain: "task",
      targetRef: null,
      taskName: null,
      fields: { scheduleFields: { time: t(17, 0) } },
      sourceText: "5pm",
      confidence: { "scheduleFields.time": 0.92 },
      unresolvedFields: [],
    });

    const result = await routeMessageTurn({
      rawText: "5pm",
      normalizedText: "5pm",
      recentTurns: [],
    });

    expect(result.policy.resolvedOperation).toMatchObject({
      operationKind: "plan",
      resolvedFields: { scheduleFields: { time: t(17, 0) } },
    });
  });

  it("reclassifies compound confirmation with active proposal to clarification_answer", async () => {
    mockClassification({
      turnType: "confirmation",
      confidence: 0.95,
    });
    mockInterpretWriteTurn.mockResolvedValueOnce({
      operationKind: "plan",
      actionDomain: "task",
      targetRef: null,
      taskName: null,
      fields: { scheduleFields: { time: t(17, 0) } },
      sourceText: "ok but make it 5pm",
      confidence: { "scheduleFields.time": 0.92 },
      unresolvedFields: [],
    });

    const result = await routeMessageTurn({
      rawText: "ok but make it 5pm",
      normalizedText: "ok but make it 5pm",
      recentTurns: [],
      entityRegistry: [
        {
          id: "proposal-1",
          conversationId: "conversation-1",
          kind: "proposal_option",
          label: "Schedule it at 3pm",
          status: "presented",
          createdAt: "2026-03-20T16:00:00.000Z",
          updatedAt: "2026-03-20T16:00:00.000Z",
          data: {
            route: "conversation_then_mutation",
            replyText: "Would you like me to schedule it at 3pm?",
            confirmationRequired: true,
            targetEntityId: null,
            mutationInputSource: null,
            fieldSnapshot: {},
          },
        },
      ],
    });

    expect(result.interpretation.turnType).toBe("clarification_answer");
    expect(result.interpretation.resolvedProposalId).toBeUndefined();
    expect(result.policy.action).not.toBe("recover_and_execute");
  });

  it("does not reclassify pure confirmation with active proposal", async () => {
    mockClassification({
      turnType: "confirmation",
      confidence: 0.97,
    });

    const result = await routeMessageTurn({
      rawText: "ok",
      normalizedText: "ok",
      recentTurns: [],
      entityRegistry: [
        {
          id: "proposal-1",
          conversationId: "conversation-1",
          kind: "proposal_option",
          label: "Schedule it at 3pm",
          status: "active",
          createdAt: "2026-03-20T16:00:00.000Z",
          updatedAt: "2026-03-20T16:00:00.000Z",
          data: {
            route: "conversation_then_mutation",
            replyText: "Would you like me to schedule it at 3pm?",
            confirmationRequired: true,
            targetEntityId: null,
            mutationInputSource: null,
            fieldSnapshot: {},
          },
        },
      ],
    });

    expect(result.interpretation.turnType).toBe("confirmation");
    expect(result.policy.action).toBe("recover_and_execute");
  });

  it("does not reclassify compound confirmation without active proposal context", async () => {
    mockClassification({
      turnType: "confirmation",
      confidence: 0.9,
    });

    const result = await routeMessageTurn({
      rawText: "ok but 5pm",
      normalizedText: "ok but 5pm",
      recentTurns: [],
      entityRegistry: [],
    });

    expect(result.interpretation.turnType).toBe("confirmation");
  });

  it("does not run write interpretation for informational turns", async () => {
    mockClassification({
      turnType: "informational",
      confidence: 0.9,
    });

    await routeMessageTurn({
      rawText: "What's later today?",
      normalizedText: "What's later today?",
      recentTurns: [],
    });

    expect(mockInterpretWriteTurn).not.toHaveBeenCalled();
  });

  it("prefers the interpreter targetRef entity over discourse focus for write turns", async () => {
    mockClassification({
      turnType: "edit_request",
      confidence: 0.96,
    });
    mockInterpretWriteTurn.mockResolvedValueOnce({
      operationKind: "edit",
      actionDomain: "task",
      targetRef: { entityId: "task-2" },
      taskName: null,
      fields: { scheduleFields: { time: t(11, 0) } },
      sourceText: "Move weekly review to 11",
      confidence: {
        "scheduleFields.time": 0.95,
      },
      unresolvedFields: [],
    });

    const result = await routeMessageTurn({
      rawText: "Move weekly review to 11",
      normalizedText: "Move weekly review to 11",
      recentTurns: [],
      tasks: [
        {
          id: "task-2",
          userId: "user-1",
          sourceInboxItemId: "inbox-1",
          lastInboxItemId: "inbox-1",
          title: "Weekly review",
          lifecycleState: "pending_schedule",
          externalCalendarEventId: null,
          externalCalendarId: null,
          scheduledStartAt: null,
          scheduledEndAt: null,
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
      discourseState: {
        focus_entity_id: "task-1",
        currently_editable_entity_id: "task-1",
        last_user_mentioned_entity_ids: [],
        last_presented_items: [],
        pending_clarifications: [],
        mode: "editing",
      },
    });

    expect(result.interpretation.resolvedEntityIds).toEqual(["task-2"]);
    expect(result.policy.targetEntityId).toBe("task-2");
    expect(result.policy.resolvedOperation?.targetRef).toEqual({
      entityId: "task-2",
    });
  });

  it("falls back to resolveWriteTarget when the interpreter does not resolve an entity", async () => {
    mockClassification({
      turnType: "edit_request",
      confidence: 0.96,
    });
    mockInterpretWriteTurn.mockResolvedValueOnce({
      operationKind: "edit",
      actionDomain: "task",
      targetRef: null,
      taskName: null,
      fields: { scheduleFields: { time: t(11, 0) } },
      sourceText: "Move it to 11",
      confidence: {
        "scheduleFields.time": 0.95,
      },
      unresolvedFields: [],
    });

    const result = await routeMessageTurn({
      rawText: "Move it to 11",
      normalizedText: "Move it to 11",
      recentTurns: [],
      discourseState: {
        focus_entity_id: "task-1",
        currently_editable_entity_id: null,
        last_user_mentioned_entity_ids: [],
        last_presented_items: [],
        pending_clarifications: [],
        mode: "editing",
      },
    });

    expect(result.interpretation.resolvedEntityIds).toEqual(["task-1"]);
    expect(result.policy.targetEntityId).toBe("task-1");
    expect(result.policy.resolvedOperation?.targetRef).toEqual({
      entityId: "task-1",
    });
  });

  it("clears prior committed fields when the interpreted workflow changes", async () => {
    mockClassification({
      turnType: "planning_request",
      confidence: 0.94,
    });
    mockInterpretWriteTurn.mockResolvedValueOnce({
      operationKind: "edit",
      actionDomain: "task",
      targetRef: null,
      taskName: null,
      fields: { scheduleFields: { time: t(11, 0) } },
      sourceText: "Move it to 11",
      confidence: { "scheduleFields.time": 0.94 },
      unresolvedFields: [],
    });

    const result = await routeMessageTurn({
      rawText: "Move it to 11",
      normalizedText: "Move it to 11",
      recentTurns: [],
      discourseState: {
        focus_entity_id: null,
        currently_editable_entity_id: null,
        last_user_mentioned_entity_ids: [],
        last_presented_items: [],
        pending_clarifications: [],
        pending_write_operation: {
          operationKind: "plan",
          targetRef: null,
          resolvedFields: {
            scheduleFields: { day: "tomorrow", time: t(18, 0) },
          },
          missingFields: [],
          originatingText: "Schedule gym tomorrow at 6",
          startedAt: new Date().toISOString(),
        },
        mode: "planning",
      },
    });

    expect(result.policy.resolvedOperation).toMatchObject({
      operationKind: "edit",
      resolvedFields: { scheduleFields: { time: t(11, 0) } },
    });
    expect(
      result.policy.resolvedOperation?.resolvedFields.scheduleFields?.day,
    ).toBeUndefined();
  });
});

describe("resolveWriteTarget", () => {
  it("resolves entity IDs from discourse state with deduplication", () => {
    const result = resolveWriteTarget(
      {
        focus_entity_id: "task-1",
        currently_editable_entity_id: "task-1",
        last_user_mentioned_entity_ids: [],
        last_presented_items: [],
        pending_clarifications: [],
        mode: "editing",
      },
      [],
      "edit_request",
    );

    expect(result).toEqual({ targetEntityId: "task-1" });
  });

  it("resolves proposal for confirmation with single active proposal", () => {
    const result = resolveWriteTarget(
      null,
      [
        {
          id: "proposal-1",
          conversationId: "c-1",
          kind: "proposal_option",
          label: "Schedule at 3pm",
          status: "active",
          createdAt: "2026-03-20T16:00:00.000Z",
          updatedAt: "2026-03-20T16:00:00.000Z",
          data: {
            route: "conversation_then_mutation",
            replyText: "Schedule at 3pm?",
            confirmationRequired: true,
            targetEntityId: "task-1",
            fieldSnapshot: {},
          },
        },
      ],
      "confirmation",
    );

    expect(result).toEqual({
      targetEntityId: "task-1",
      resolvedProposalId: "proposal-1",
    });
  });

  it("overrides discourse state entity with proposal targetEntityId for confirmation", () => {
    const result = resolveWriteTarget(
      {
        focus_entity_id: "task-2",
        currently_editable_entity_id: "task-2",
        last_user_mentioned_entity_ids: [],
        last_presented_items: [],
        pending_clarifications: [],
        mode: "editing",
      },
      [
        {
          id: "proposal-1",
          conversationId: "c-1",
          kind: "proposal_option",
          label: "Move it",
          status: "active",
          createdAt: "2026-03-20T16:00:00.000Z",
          updatedAt: "2026-03-20T16:00:00.000Z",
          data: {
            route: "conversation_then_mutation",
            replyText: "Move to 3pm?",
            confirmationRequired: true,
            targetEntityId: "task-1",
            fieldSnapshot: {},
          },
        },
      ],
      "confirmation",
    );

    expect(result).toEqual({
      targetEntityId: "task-1",
      resolvedProposalId: "proposal-1",
    });
  });

  it("returns empty result with no discourse state and no proposals", () => {
    const result = resolveWriteTarget(null, [], "planning_request");

    expect(result).toEqual({});
  });

  it("uses parentTargetRef from open clarification instead of focus_entity_id for clarification_answer", () => {
    const result = resolveWriteTarget(
      {
        focus_entity_id: "clar-1",
        currently_editable_entity_id: null,
        last_user_mentioned_entity_ids: [],
        last_presented_items: [],
        pending_clarifications: [
          {
            id: "clar-1",
            slot: "scheduleFields.time",
            question: "What time?",
            status: "pending",
            createdAt: "2026-04-09T10:00:00.000Z",
            createdTurnId: "assistant:1",
            parentTargetRef: { entityId: "task-1" },
          },
        ],
        mode: "clarifying",
      },
      [
        {
          id: "clar-1",
          conversationId: "c-1",
          kind: "clarification",
          label: "What time?",
          status: "active",
          createdAt: "2026-04-09T10:00:00.000Z",
          updatedAt: "2026-04-09T10:00:00.000Z",
          data: {
            prompt: "What time?",
            reason: "scheduleFields.time",
            open: true,
            parentTargetRef: { entityId: "task-1" },
          },
        },
      ],
      "clarification_answer",
    );

    expect(result.targetEntityId).toBe("task-1");
  });

  it("returns no targetEntityId when clarification parentTargetRef is null (new plan)", () => {
    const result = resolveWriteTarget(
      {
        focus_entity_id: "clar-1",
        currently_editable_entity_id: null,
        last_user_mentioned_entity_ids: [],
        last_presented_items: [],
        pending_clarifications: [
          {
            id: "clar-1",
            slot: "scheduleFields.time",
            question: "What time?",
            status: "pending",
            createdAt: "2026-04-09T10:00:00.000Z",
            createdTurnId: "assistant:1",
            parentTargetRef: null,
          },
        ],
        mode: "clarifying",
      },
      [
        {
          id: "clar-1",
          conversationId: "c-1",
          kind: "clarification",
          label: "What time?",
          status: "active",
          createdAt: "2026-04-09T10:00:00.000Z",
          updatedAt: "2026-04-09T10:00:00.000Z",
          data: {
            prompt: "What time?",
            reason: "scheduleFields.time",
            open: true,
            parentTargetRef: null,
          },
        },
      ],
      "clarification_answer",
    );

    expect(result.targetEntityId).toBeUndefined();
  });

  it("does not use clarification parentTargetRef for non-clarification_answer turns", () => {
    const result = resolveWriteTarget(
      {
        focus_entity_id: "task-2",
        currently_editable_entity_id: null,
        last_user_mentioned_entity_ids: [],
        last_presented_items: [],
        pending_clarifications: [
          {
            id: "clar-1",
            slot: "scheduleFields.time",
            question: "What time?",
            status: "pending",
            createdAt: "2026-04-09T10:00:00.000Z",
            createdTurnId: "assistant:1",
            parentTargetRef: { entityId: "task-1" },
          },
        ],
        mode: "clarifying",
      },
      [],
      "edit_request",
    );

    // For non-clarification_answer, should use normal focus_entity_id path
    expect(result.targetEntityId).toBe("task-2");
  });

  it("attaches resolvedProposalId for non-confirmation turns when single proposal exists", () => {
    const result = resolveWriteTarget(
      null,
      [
        {
          id: "proposal-1",
          conversationId: "c-1",
          kind: "proposal_option",
          label: "Schedule at 3pm",
          status: "active",
          createdAt: "2026-03-20T16:00:00.000Z",
          updatedAt: "2026-03-20T16:00:00.000Z",
          data: {
            route: "conversation_then_mutation",
            replyText: "Schedule at 3pm?",
            confirmationRequired: true,
            fieldSnapshot: {},
          },
        },
      ],
      "clarification_answer",
    );

    expect(result).toEqual({
      resolvedProposalId: "proposal-1",
    });
  });
});

describe("containsModificationPayload", () => {
  it("detects time patterns", () => {
    expect(containsModificationPayload("ok but 5pm")).toBe(true);
    expect(containsModificationPayload("sure, at 3")).toBe(true);
    expect(containsModificationPayload("yes 17:00")).toBe(true);
  });

  it("detects day patterns", () => {
    expect(containsModificationPayload("ok but tomorrow")).toBe(true);
    expect(containsModificationPayload("yes friday")).toBe(true);
  });

  it("detects modification signals", () => {
    expect(containsModificationPayload("ok but different")).toBe(true);
    expect(containsModificationPayload("yes change it")).toBe(true);
    expect(containsModificationPayload("sure, actually")).toBe(true);
  });

  it("does not match pure confirmations", () => {
    expect(containsModificationPayload("ok")).toBe(false);
    expect(containsModificationPayload("yes")).toBe(false);
    expect(containsModificationPayload("sure")).toBe(false);
    expect(containsModificationPayload("do it")).toBe(false);
    expect(containsModificationPayload("yup")).toBe(false);
  });
});
