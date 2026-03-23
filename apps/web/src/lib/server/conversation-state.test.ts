import { describe, expect, it } from "vitest";
import type { ConversationStateSnapshot } from "@atlas/core";
import type { ProcessedInboxResult } from "@atlas/db";

import { deriveConversationReplyState, deriveMutationState } from "./conversation-state";

function buildSnapshot(): ConversationStateSnapshot {
  return {
    conversation: {
      id: "conversation-1",
      userId: "user-1",
      title: null,
      mode: "conversation" as const,
      summaryText: null,
      createdAt: "2026-03-22T16:00:00.000Z",
      updatedAt: "2026-03-22T16:00:00.000Z"
    },
    transcript: [],
    entityRegistry: [],
    discourseState: {
      focus_entity_id: null,
      currently_editable_entity_id: null,
      last_user_mentioned_entity_ids: [],
      last_presented_items: [],
      pending_clarifications: [],
      mode: "planning" as const
    }
  };
}

describe("deriveConversationReplyState", () => {
  it("persists a clarification only when structured interpretation still has a real missing slot", () => {
    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policy: {
        action: "ask_clarification",
        committedSlots: {}
      },
      interpretation: {
        turnType: "planning_request",
        confidence: 0.58,
        resolvedEntityIds: [],
        ambiguity: "high",
        missingSlots: ["time"]
      },
      reply: "What time should I schedule the Malaysia trip planning?",
      userTurnText: "schedule malaysia trip planning tomorrow",
      summaryText: null,
      occurredAt: "2026-03-22T16:05:00.000Z"
    });

    expect(result.entityRegistry).toHaveLength(1);
    expect(result.entityRegistry[0]).toMatchObject({
      kind: "clarification",
      status: "active",
      data: {
        reason: "time"
      }
    });
    expect(result.discourseState?.pending_clarifications).toEqual([
      expect.objectContaining({
        slot: "time",
        status: "pending",
        blocking: true
      })
    ]);
    expect(result.discourseState?.mode).toBe("clarifying");
  });

  it("does not persist clarification state for ask_clarification without a real blocking slot", () => {
    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policy: {
        action: "ask_clarification",
        clarificationSlots: ["proposal"],
        committedSlots: {}
      },
      interpretation: {
        turnType: "confirmation",
        confidence: 0.32,
        resolvedEntityIds: [],
        ambiguity: "high"
      },
      reply: "Which proposal do you want me to apply?",
      userTurnText: "ok",
      summaryText: null,
      occurredAt: "2026-03-22T16:05:00.000Z"
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
        committedSlots: {}
      },
      interpretation: {
        turnType: "unknown",
        confidence: 0.42,
        resolvedEntityIds: [],
        ambiguity: "high",
        missingSlots: ["unknown"]
      },
      reply: "Can you clarify what you want me to change?",
      userTurnText: "do it",
      summaryText: null,
      occurredAt: "2026-03-22T16:05:00.000Z"
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
          open: true
        }
      }
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
          blocking: true,
          createdAt: "2026-03-22T16:01:00.000Z",
          createdTurnId: "assistant:1"
        }
      ],
      mode: "clarifying"
    };

    const result = deriveConversationReplyState({
      snapshot,
      policy: {
        action: "present_proposal",
        committedSlots: {}
      },
      interpretation: {
        turnType: "clarification_answer",
        confidence: 0.93,
        resolvedEntityIds: ["task-1"],
        ambiguity: "none"
      },
      reply: "I can schedule the Malaysia trip planning at 5 PM. Want me to do that now?",
      userTurnText: "5pm",
      summaryText: null,
      occurredAt: "2026-03-22T16:05:00.000Z"
    });

    expect(result.entityRegistry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "clar-1",
          kind: "clarification",
          status: "resolved"
        }),
        expect.objectContaining({
          kind: "proposal_option",
          status: "active"
        })
      ])
    );
    expect(result.discourseState?.pending_clarifications).toEqual([
      expect.objectContaining({
        id: "clar-1",
        status: "resolved"
      })
    ]);
    expect(result.discourseState?.mode).toBe("confirming");
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
          open: true
        }
      }
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
          blocking: true,
          createdAt: "2026-03-22T16:01:00.000Z",
          createdTurnId: "assistant:1"
        }
      ],
      mode: "clarifying"
    };

    const processing: ProcessedInboxResult = {
      outcome: "planned",
      inboxItem: {
        id: "inbox-1",
        userId: "user-1",
        rawText: "schedule malaysia trip planning",
        normalizedText: "schedule malaysia trip planning",
        processingStatus: "planned",
        linkedTaskIds: ["task-1"],
        createdAt: "2026-03-22T16:00:00.000Z"
      },
      plannerRun: {
        id: "run-1",
        userId: "user-1",
        inboxItemId: "inbox-1",
        version: "test",
        modelInput: {},
        modelOutput: {},
        confidence: 0.92
      },
      createdTasks: [
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
          urgency: "medium"
        }
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
          externalCalendarId: null
        }
      ],
      followUpMessage: "Scheduled it for 5 PM."
    };

    const result = deriveMutationState({
      snapshot,
      processing,
      occurredAt: "2026-03-22T16:10:00.000Z"
    });

    expect(result.discourseState.pending_clarifications).toEqual([
      expect.objectContaining({
        id: "clar-1",
        status: "resolved"
      })
    ]);
    expect(result.discourseState.mode).toBe("editing");
  });
});
