import { describe, expect, it } from "vitest";

import { deriveConversationReplyState } from "./conversation-state";

function buildSnapshot() {
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
      mode: "clarifying" as const
    }
  };
}

describe("deriveConversationReplyState", () => {
  it("keeps clarifications as clarifications when required slots are still missing", () => {
    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policyAction: "ask_clarification",
      interpretation: {
        turnType: "planning_request",
        confidence: 0.58,
        resolvedEntityIds: [],
        ambiguity: "high",
        missingSlots: ["time"]
      },
      reply: "It sounds like you want me to block out time for planning your Malaysia trip. I can proceed with that now once I know the time.",
      userTurnText: "schedule malaysia trip planning tomorrow",
      summaryText: null,
      occurredAt: "2026-03-22T16:05:00.000Z"
    });

    expect(result.mode).toBe("conversation_then_mutation");
    expect(result.entityRegistry).toHaveLength(1);
    expect(result.entityRegistry[0]).toMatchObject({
      kind: "clarification",
      status: "active"
    });
    expect(result.discourseState?.mode).toBe("clarifying");
  });

  it("does not upgrade to proposal based on wording alone", () => {
    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policyAction: "ask_clarification",
      interpretation: {
        turnType: "planning_request",
        confidence: 0.91,
        resolvedEntityIds: [],
        ambiguity: "none"
      },
      reply: "It sounds like you want me to block out time for planning your Malaysia trip at 3:15 PM for 15 minutes. I can proceed with that now.",
      userTurnText: "schedule malaysia trip planning at 3:15pm for 15 minutes",
      summaryText: null,
      occurredAt: "2026-03-22T16:05:00.000Z"
    });

    expect(result.entityRegistry[0]).toMatchObject({
      kind: "clarification"
    });
    expect(result.discourseState?.mode).toBe("clarifying");
  });

  it("persists proposal state only when policy already says present_proposal", () => {
    const result = deriveConversationReplyState({
      snapshot: buildSnapshot(),
      policyAction: "present_proposal",
      interpretation: {
        turnType: "edit_request",
        confidence: 0.94,
        resolvedEntityIds: ["task-1"],
        ambiguity: "none"
      },
      reply: "I can move the planning block to 3:15 PM for 15 minutes. Would you like me to do that now?",
      userTurnText: "move it to 3:15pm for 15 minutes",
      summaryText: null,
      occurredAt: "2026-03-22T16:05:00.000Z"
    });

    expect(result.entityRegistry).toHaveLength(1);
    expect(result.entityRegistry[0]).toMatchObject({
      kind: "proposal_option",
      status: "active",
      data: {
        targetEntityId: "task-1",
        policyAction: "present_proposal",
        confirmationRequired: true
      }
    });
    expect(result.discourseState?.mode).toBe("confirming");
  });
});
