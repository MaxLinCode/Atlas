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

  it("asks for clarification when write intent still has missing slots", () => {
    expect(
      decideTurnPolicy({
        interpretation: {
          turnType: "planning_request",
          confidence: 0.7,
          resolvedEntityIds: [],
          ambiguity: "low",
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

  it("presents a proposal for medium-confidence write intent", () => {
    expect(
      decideTurnPolicy({
        interpretation: {
          turnType: "planning_request",
          confidence: 0.68,
          resolvedEntityIds: [],
          ambiguity: "low"
        },
        routingContext: {
          rawText: "Could we move it to tomorrow morning?",
          normalizedText: "Could we move it to tomorrow morning?",
          recentTurns: []
        }
      })
    ).toMatchObject({
      action: "present_proposal",
      requiresConfirmation: true
    });
  });

  it("executes direct confident write intent", () => {
    expect(
      decideTurnPolicy({
        interpretation: {
          turnType: "planning_request",
          confidence: 0.95,
          resolvedEntityIds: [],
          ambiguity: "none"
        },
        routingContext: {
          rawText: "Schedule gym tomorrow evening",
          normalizedText: "Schedule gym tomorrow evening",
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
          recentTurns: []
        }
      })
    ).toMatchObject({
      action: "recover_and_execute",
      targetProposalId: "proposal-1"
    });
  });

  it("falls back to clarification when confirmation has no recoverable proposal", () => {
    expect(
      decideTurnPolicy({
        interpretation: {
          turnType: "confirmation",
          confidence: 0.4,
          resolvedEntityIds: [],
          ambiguity: "high"
        },
        routingContext: {
          rawText: "Yes",
          normalizedText: "Yes",
          recentTurns: []
        }
      })
    ).toMatchObject({
      action: "ask_clarification",
      clarificationSlots: ["proposal"]
    });
  });

  it("asks for clarification on high-ambiguity write-like turns", () => {
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
});
