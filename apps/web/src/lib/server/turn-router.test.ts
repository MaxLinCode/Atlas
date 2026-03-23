import { describe, expect, it, vi } from "vitest";

import type { TurnClassifierOutput } from "@atlas/core";

import { routeMessageTurn } from "./turn-router";

vi.mock("./llm-classifier", () => ({
  classifyTurn: vi.fn()
}));

import { classifyTurn } from "./llm-classifier";

const mockClassifyTurn = vi.mocked(classifyTurn);

function mockClassification(output: Partial<TurnClassifierOutput>) {
  const full: TurnClassifierOutput = {
    turnType: "unknown",
    confidence: 0.5,
    resolvedEntityIds: [],
    ...output
  };
  mockClassifyTurn.mockResolvedValue(full);
}

describe("turn router", () => {
  it("returns interpretation and direct-write policy for clear scheduling requests", async () => {
    mockClassification({
      turnType: "planning_request",
      confidence: 0.95
    });

    const result = await routeMessageTurn({
      rawText: "Schedule gym tomorrow at 6pm for 1 hour",
      normalizedText: "Schedule gym tomorrow at 6pm for 1 hour",
      recentTurns: []
    });

    expect(result).toMatchObject({
      interpretation: {
        turnType: "planning_request",
        ambiguity: "none"
      },
      policy: {
        action: "execute_mutation",
        mutationInputSource: "direct_user_turn"
      }
    });
  });

  it("represents recoverable confirmation as confirmation plus recover-and-execute", async () => {
    // Confirmation with single proposal is handled by pre-filter — no LLM mock needed
    mockClassification({
      turnType: "confirmation",
      confidence: 0.97,
      resolvedProposalId: "proposal-1"
    });

    const result = await routeMessageTurn({
      rawText: "Yes",
      normalizedText: "Yes",
      recentTurns: [
        {
          role: "assistant",
          text: "Would you like me to schedule it at 3pm?",
          createdAt: "2026-03-17T16:00:00.000Z"
        }
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
            mutationInputSource: null
          }
        }
      ]
    });

    expect(result).toMatchObject({
      interpretation: {
        turnType: "confirmation",
        resolvedProposalId: "proposal-1"
      },
      policy: {
        action: "recover_and_execute",
        targetProposalId: "proposal-1",
        mutationInputSource: "recovered_proposal"
      }
    });
  });

  it("routes punctuated consent on an active proposal to recover-and-execute", async () => {
    // Punctuated "Ok," is handled by pre-filter when single proposal exists
    mockClassification({
      turnType: "confirmation",
      confidence: 0.97,
      resolvedProposalId: "proposal-1"
    });

    const result = await routeMessageTurn({
      rawText: "Ok,",
      normalizedText: "Ok,",
      recentTurns: [
        {
          role: "assistant",
          text: "Would you like me to schedule it at 5pm?",
          createdAt: "2026-03-17T16:00:00.000Z"
        }
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
            mutationInputSource: null
          }
        }
      ]
    });

    expect(result).toMatchObject({
      interpretation: {
        turnType: "confirmation",
        resolvedProposalId: "proposal-1"
      },
      policy: {
        action: "recover_and_execute",
        targetProposalId: "proposal-1"
      }
    });
  });
});
