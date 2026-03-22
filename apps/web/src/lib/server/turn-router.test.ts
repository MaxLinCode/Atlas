import { describe, expect, it } from "vitest";

import { routeMessageTurn } from "./turn-router";

describe("turn router", () => {
  it("returns both interpretation and policy for legacy conversation-then-mutation behavior", async () => {
    const result = await routeMessageTurn(
      {
        rawText: "I might move this to Friday, what do you think?",
        normalizedText: "I might move this to Friday, what do you think?",
        recentTurns: []
      },
      {
        classifyTurn: async () => ({
          route: "conversation_then_mutation",
          reason: "Mixed turn should discuss first."
        })
      }
    );

    expect(result).toMatchObject({
      interpretation: {
        turnType: "planning_request"
      },
      policy: {
        action: "present_proposal",
        requiresWrite: false
      }
    });
  });

  it("represents confirmed mutation recovery as confirmation plus recover-and-execute", async () => {
    const result = await routeMessageTurn(
      {
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
      },
      {
        classifyTurn: async () => ({
          route: "confirmed_mutation",
          reason: "The user is confirming a recent concrete scheduling proposal."
        })
      }
    );

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
