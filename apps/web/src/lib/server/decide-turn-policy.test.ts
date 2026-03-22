import { describe, expect, it } from "vitest";

import { decideTurnPolicy } from "./decide-turn-policy";

describe("decideTurnPolicy", () => {
  it("maps informational turns to reply_only", () => {
    expect(
      decideTurnPolicy({
        interpretation: {
          turnType: "informational",
          confidence: 0.9,
          resolvedEntityIds: [],
          ambiguity: "none"
        },
        routingContext: {
          rawText: "What do I have tomorrow?",
          normalizedText: "What do I have tomorrow?",
          recentTurns: []
        }
      })
    ).toMatchObject({
      action: "reply_only",
      requiresWrite: false
    });
  });

  it("asks for clarification when a scheduling request is still missing required slots", () => {
    expect(
      decideTurnPolicy({
        interpretation: {
          turnType: "planning_request",
          confidence: 0.58,
          resolvedEntityIds: [],
          ambiguity: "high",
          missingSlots: ["time"]
        },
        routingContext: {
          rawText: "Schedule gym tomorrow",
          normalizedText: "Schedule gym tomorrow",
          recentTurns: []
        }
      })
    ).toMatchObject({
      action: "ask_clarification",
      clarificationSlots: ["time"]
    });
  });

  it("does not force proposal mode for low-confidence writes alone", () => {
    expect(
      decideTurnPolicy({
        interpretation: {
          turnType: "planning_request",
          confidence: 0.68,
          resolvedEntityIds: [],
          ambiguity: "none"
        },
        routingContext: {
          rawText: "Schedule gym tomorrow at 6pm",
          normalizedText: "Schedule gym tomorrow at 6pm",
          recentTurns: []
        }
      })
    ).toMatchObject({
      action: "execute_mutation",
      requiresConfirmation: false
    });
  });

  it("executes complete scheduling requests with no ambiguity", () => {
    expect(
      decideTurnPolicy({
        interpretation: {
          turnType: "planning_request",
          confidence: 0.95,
          resolvedEntityIds: [],
          ambiguity: "none"
        },
        routingContext: {
          rawText: "Schedule gym tomorrow at 6pm for 1 hour",
          normalizedText: "Schedule gym tomorrow at 6pm for 1 hour",
          recentTurns: []
        }
      })
    ).toMatchObject({
      action: "execute_mutation",
      mutationInputSource: "direct_user_turn"
    });
  });

  it("recovers and executes when confirmation has one recoverable proposal", () => {
    expect(
      decideTurnPolicy({
        interpretation: {
          turnType: "confirmation",
          confidence: 0.95,
          resolvedEntityIds: [],
          resolvedProposalId: "proposal-1",
          ambiguity: "none"
        },
        routingContext: {
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
                confirmationRequired: true
              }
            }
          ]
        }
      })
    ).toMatchObject({
      action: "recover_and_execute",
      targetProposalId: "proposal-1"
    });
  });

  it("asks for clarification on ambiguous write-like turns", () => {
    expect(
      decideTurnPolicy({
        interpretation: {
          turnType: "edit_request",
          confidence: 0.6,
          resolvedEntityIds: ["task-1"],
          ambiguity: "high",
          ambiguityReason: "Underspecified edit."
        },
        routingContext: {
          rawText: "Move it",
          normalizedText: "Move it",
          recentTurns: []
        }
      })
    ).toMatchObject({
      action: "ask_clarification"
    });
  });

  it("uses present_proposal only for explicit confirmation-required policy", () => {
    expect(
      decideTurnPolicy({
        interpretation: {
          turnType: "planning_request",
          confidence: 0.93,
          resolvedEntityIds: ["task-1"],
          resolvedProposalId: "proposal-1",
          ambiguity: "none"
        },
        routingContext: {
          rawText: "Schedule it tomorrow at 6pm",
          normalizedText: "Schedule it tomorrow at 6pm",
          recentTurns: [],
          entityRegistry: [
            {
              id: "proposal-1",
              conversationId: "conversation-1",
              kind: "proposal_option",
              label: "Schedule it tomorrow at 6pm",
              status: "active",
              createdAt: "2026-03-20T16:00:00.000Z",
              updatedAt: "2026-03-20T16:00:00.000Z",
              data: {
                route: "conversation_then_mutation",
                replyText: "Would you like me to schedule it tomorrow at 6pm?",
                confirmationRequired: true,
                targetEntityId: "task-1"
              }
            }
          ]
        }
      })
    ).toMatchObject({
      action: "present_proposal",
      requiresConfirmation: true
    });
  });
});
