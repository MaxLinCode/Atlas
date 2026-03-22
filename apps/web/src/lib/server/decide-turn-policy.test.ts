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

  it("keeps clarification answers in clarification when required slots remain", () => {
    expect(
      decideTurnPolicy({
        interpretation: {
          turnType: "clarification_answer",
          confidence: 0.84,
          resolvedEntityIds: [],
          ambiguity: "high",
          missingSlots: ["time"]
        },
        routingContext: {
          rawText: "Tomorrow",
          normalizedText: "Tomorrow",
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

  it("treats affirmative consent on a pending proposal as execution", () => {
    expect(
      decideTurnPolicy({
        interpretation: {
          turnType: "confirmation",
          confidence: 0.97,
          resolvedEntityIds: ["task-1"],
          resolvedProposalId: "proposal-1",
          ambiguity: "none"
        },
        routingContext: {
          rawText: "yes",
          normalizedText: "yes",
          recentTurns: [],
          entityRegistry: [
            {
              id: "proposal-1",
              conversationId: "conversation-1",
              kind: "proposal_option",
              label: "Move it to 3pm",
              status: "active",
              createdAt: "2026-03-20T16:00:00.000Z",
              updatedAt: "2026-03-20T16:00:00.000Z",
              data: {
                route: "conversation_then_mutation",
                replyText: "Would you like me to move it to 3pm?",
                confirmationRequired: true,
                targetEntityId: "task-1"
              }
            }
          ]
        }
      })
    ).toMatchObject({
      action: "recover_and_execute",
      targetProposalId: "proposal-1",
      mutationInputSource: "recovered_proposal"
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

  it("routes ready clarification answers to present_proposal when deterministic consent is still required", () => {
    expect(
      decideTurnPolicy({
        interpretation: {
          turnType: "clarification_answer",
          confidence: 0.92,
          resolvedEntityIds: ["task-1"],
          resolvedProposalId: "proposal-1",
          ambiguity: "none"
        },
        routingContext: {
          rawText: "3:15pm",
          normalizedText: "3:15pm",
          recentTurns: [],
          entityRegistry: [
            {
              id: "proposal-1",
              conversationId: "conversation-1",
              kind: "proposal_option",
              label: "Move it to 3:15pm",
              status: "active",
              createdAt: "2026-03-20T16:00:00.000Z",
              updatedAt: "2026-03-20T16:00:00.000Z",
              data: {
                route: "conversation_then_mutation",
                replyText: "Would you like me to move it to 3:15pm?",
                confirmationRequired: true,
                targetEntityId: "task-1"
              }
            }
          ]
        }
      })
    ).toMatchObject({
      action: "present_proposal",
      requiresConfirmation: true,
      targetProposalId: "proposal-1"
    });
  });

  it("recomputes a parameter edit on an active proposal instead of executing it", () => {
    const result = decideTurnPolicy({
      interpretation: {
        turnType: "edit_request",
        confidence: 0.9,
        resolvedEntityIds: ["task-1"],
        resolvedProposalId: "proposal-1",
        ambiguity: "none"
      },
      routingContext: {
        rawText: "make it 3 instead",
        normalizedText: "make it 3 instead",
        recentTurns: [],
        entityRegistry: [
          {
            id: "proposal-1",
            conversationId: "conversation-1",
            kind: "proposal_option",
            label: "Move it to tomorrow 2pm",
            status: "active",
            createdAt: "2026-03-20T16:00:00.000Z",
            updatedAt: "2026-03-20T16:00:00.000Z",
            data: {
              route: "conversation_then_mutation",
              replyText: "Would you like me to move it to tomorrow 2pm?",
              confirmationRequired: true,
              targetEntityId: "task-1",
              originatingTurnText: "move it to tomorrow 2pm"
            }
          }
        ]
      }
    });

    expect(result).toMatchObject({
      action: "present_proposal",
      requiresConfirmation: true
    });
    expect(result.targetProposalId).toBeUndefined();
  });

  it("does not bind consent to a stale proposal with a different target", () => {
    expect(
      decideTurnPolicy({
        interpretation: {
          turnType: "edit_request",
          confidence: 0.91,
          resolvedEntityIds: ["task-2"],
          resolvedProposalId: "proposal-1",
          ambiguity: "none"
        },
        routingContext: {
          rawText: "move that to 3pm",
          normalizedText: "move that to 3pm",
          recentTurns: [],
          entityRegistry: [
            {
              id: "proposal-1",
              conversationId: "conversation-1",
              kind: "proposal_option",
              label: "Move task one to 2pm",
              status: "active",
              createdAt: "2026-03-20T16:00:00.000Z",
              updatedAt: "2026-03-20T16:00:00.000Z",
              data: {
                route: "conversation_then_mutation",
                replyText: "Would you like me to move task one to 2pm?",
                confirmationRequired: true,
                targetEntityId: "task-1"
              }
            }
          ]
        }
      })
    ).toMatchObject({
      action: "execute_mutation",
      mutationInputSource: "direct_user_turn"
    });
  });
});
