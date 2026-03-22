import { describe, expect, it } from "vitest";

import { interpretTurn } from "./interpret-turn";

describe("interpretTurn", () => {
  it("treats informational questions as informational", async () => {
    const result = await interpretTurn(
      {
        rawText: "What do I have tomorrow?",
        normalizedText: "What do I have tomorrow?",
        recentTurns: []
      },
      {
        classifyTurn: async () => ({
          route: "conversation",
          reason: "Informational question."
        })
      }
    );

    expect(result).toMatchObject({
      turnType: "informational",
      ambiguity: "none"
    });
  });

  it("treats a direct create request as a planning request", async () => {
    const result = await interpretTurn(
      {
        rawText: "Schedule gym tomorrow evening",
        normalizedText: "Schedule gym tomorrow evening",
        recentTurns: []
      },
      {
        classifyTurn: async () => ({
          route: "mutation",
          reason: "Direct scheduling request."
        })
      }
    );

    expect(result).toMatchObject({
      turnType: "planning_request",
      confidence: 0.95
    });
  });

  it("treats focused move requests as edit requests", async () => {
    const result = await interpretTurn(
      {
        rawText: "Move that to Friday",
        normalizedText: "Move that to Friday",
        recentTurns: [],
        discourseState: {
          focus_entity_id: "task-1",
          currently_editable_entity_id: "task-1",
          last_user_mentioned_entity_ids: [],
          last_presented_items: [],
          pending_clarifications: [],
          mode: "editing"
        }
      },
      {
        classifyTurn: async () => ({
          route: "mutation",
          reason: "Edit request."
        })
      }
    );

    expect(result).toMatchObject({
      turnType: "edit_request",
      resolvedEntityIds: ["task-1"]
    });
  });

  it("treats short replies to pending clarifications as clarification answers", async () => {
    const result = await interpretTurn(
      {
        rawText: "Tomorrow afternoon",
        normalizedText: "Tomorrow afternoon",
        recentTurns: [],
        discourseState: {
          focus_entity_id: null,
          currently_editable_entity_id: null,
          last_user_mentioned_entity_ids: [],
          last_presented_items: [],
          pending_clarifications: [
            {
              id: "clar-1",
              slot: "time",
              question: "What time tomorrow?",
              status: "pending",
              blocking: true,
              createdAt: "2026-03-20T16:00:00.000Z",
              createdTurnId: "assistant:1"
            }
          ],
          mode: "clarifying"
        }
      },
      {
        classifyTurn: async () => ({
          route: "conversation_then_mutation",
          reason: "Clarification answer."
        })
      }
    );

    expect(result).toMatchObject({
      turnType: "clarification_answer",
      missingSlots: ["time"]
    });
  });

  it("treats yes with a pending proposal as confirmation", async () => {
    const result = await interpretTurn(
      {
        rawText: "Yes",
        normalizedText: "Yes",
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
              originatingTurnText: "Schedule dentist reminder"
            }
          }
        ]
      },
      {
        classifyTurn: async () => ({
          route: "confirmed_mutation",
          reason: "Confirmation."
        })
      }
    );

    expect(result).toMatchObject({
      turnType: "confirmation",
      resolvedProposalId: "proposal-1",
      ambiguity: "none"
    });
  });

  it("does not treat yes without a pending proposal as recoverable confirmation", async () => {
    const result = await interpretTurn(
      {
        rawText: "Yes",
        normalizedText: "Yes",
        recentTurns: []
      },
      {
        classifyTurn: async () => ({
          route: "confirmed_mutation",
          reason: "Looks like confirmation."
        })
      }
    );

    expect(result).toMatchObject({
      turnType: "unknown",
      ambiguity: "high"
    });
  });

  it("treats ambiguous short replies without context as unknown", async () => {
    const result = await interpretTurn(
      {
        rawText: "Maybe",
        normalizedText: "Maybe",
        recentTurns: []
      },
      {
        classifyTurn: async () => ({
          route: "conversation",
          reason: "Unclear."
        })
      }
    );

    expect(result).toMatchObject({
      turnType: "unknown",
      ambiguity: "high"
    });
  });
});
