import { describe, expect, it } from "vitest";

import { routeMessageTurn } from "./turn-router";

describe("turn router", () => {
  it("returns interpretation and direct-write policy for clear scheduling requests", async () => {
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
});
