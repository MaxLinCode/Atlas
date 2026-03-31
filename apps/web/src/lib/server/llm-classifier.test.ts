import type { TurnClassifierResponse } from "@atlas/core";
import { describe, expect, it, vi } from "vitest";

import { classifyTurn } from "./llm-classifier";

function mockClient(output: TurnClassifierResponse) {
  return {
    responses: {
      parse: vi.fn().mockResolvedValue({ output_parsed: output }),
    },
  };
}

function failingClient() {
  return {
    responses: {
      parse: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
    },
  };
}

describe("classifyTurn", () => {
  describe("heuristic pre-filter", () => {
    it("fast-exits confirmation when one active proposal exists", async () => {
      const result = await classifyTurn({
        normalizedText: "Yes",
        discourseState: null,
        entityRegistry: [
          {
            id: "proposal-1",
            conversationId: "c-1",
            kind: "proposal_option",
            label: "Schedule it at 3pm",
            status: "active",
            createdAt: "2026-03-20T16:00:00.000Z",
            updatedAt: "2026-03-20T16:00:00.000Z",
            data: {
              route: "conversation_then_mutation",
              replyText: "Would you like me to schedule it at 3pm?",
              confirmationRequired: true,
              targetEntityId: "task-1",
              fieldSnapshot: {},
            },
          },
        ],
      });

      expect(result).toMatchObject({
        turnType: "confirmation",
        confidence: 0.97,
        resolvedEntityIds: ["task-1"],
        resolvedProposalId: "proposal-1",
      });
    });

    it("fast-exits confirmation for presented proposals", async () => {
      const result = await classifyTurn({
        normalizedText: "ok",
        discourseState: null,
        entityRegistry: [
          {
            id: "proposal-1",
            conversationId: "c-1",
            kind: "proposal_option",
            label: "Move it",
            status: "presented",
            createdAt: "2026-03-20T16:00:00.000Z",
            updatedAt: "2026-03-20T16:00:00.000Z",
            data: {
              route: "conversation_then_mutation",
              replyText: "Move it to 3pm?",
              confirmationRequired: true,
              fieldSnapshot: {},
            },
          },
        ],
      });

      expect(result).toMatchObject({
        turnType: "confirmation",
        resolvedProposalId: "proposal-1",
      });
    });

    it("does not fast-exit confirmation with multiple proposals", async () => {
      const client = mockClient({
        turnType: "unknown",
        confidence: 0.4,
        reasoning: "Multiple proposals",
      });

      const result = await classifyTurn(
        {
          normalizedText: "Yes",
          discourseState: null,
          entityRegistry: [
            {
              id: "p-1",
              conversationId: "c-1",
              kind: "proposal_option",
              label: "Option A",
              status: "active",
              createdAt: "2026-03-20T16:00:00.000Z",
              updatedAt: "2026-03-20T16:00:00.000Z",
              data: {
                route: "conversation_then_mutation",
                replyText: "A?",
                confirmationRequired: true,
                fieldSnapshot: {},
              },
            },
            {
              id: "p-2",
              conversationId: "c-1",
              kind: "proposal_option",
              label: "Option B",
              status: "active",
              createdAt: "2026-03-20T16:00:00.000Z",
              updatedAt: "2026-03-20T16:00:00.000Z",
              data: {
                route: "conversation_then_mutation",
                replyText: "B?",
                confirmationRequired: true,
                fieldSnapshot: {},
              },
            },
          ],
        },
        client,
      );

      expect(result.turnType).toBe("unknown");
      expect(client.responses.parse).toHaveBeenCalledOnce();
    });

    it("routes informational questions through LLM when fast-exit is disabled", async () => {
      const client = mockClient({
        turnType: "informational",
        confidence: 0.91,
        reasoning: "User is asking about their schedule",
      });

      const result = await classifyTurn(
        {
          normalizedText: "What do I have tomorrow?",
          discourseState: null,
          entityRegistry: [],
        },
        client,
      );

      expect(result).toMatchObject({
        turnType: "informational",
        confidence: 0.91,
      });
      expect(client.responses.parse).toHaveBeenCalledOnce();
    });

    it("does not fast-exit informational when active clarifications exist", async () => {
      const client = mockClient({
        turnType: "clarification_answer",
        confidence: 0.85,
        reasoning: "Answering pending clarification",
      });

      const result = await classifyTurn(
        {
          normalizedText: "When is that?",
          discourseState: {
            focus_entity_id: null,
            currently_editable_entity_id: null,
            last_user_mentioned_entity_ids: [],
            last_presented_items: [],
            pending_clarifications: [
              {
                id: "c-1",
                slot: "time",
                question: "What time?",
                status: "pending",
                createdAt: "2026-03-20T16:00:00.000Z",
                createdTurnId: "t-1",
              },
            ],
            mode: "clarifying",
          },
          entityRegistry: [],
        },
        client,
      );

      expect(client.responses.parse).toHaveBeenCalledOnce();
      expect(result.turnType).toBe("clarification_answer");
    });
  });

  describe("LLM classification", () => {
    it("classifies planning requests via LLM", async () => {
      const client = mockClient({
        turnType: "planning_request",
        confidence: 0.92,
        reasoning: "User wants to schedule something new",
      });

      const result = await classifyTurn(
        {
          normalizedText: "Schedule gym tomorrow at 6pm",
          discourseState: null,
          entityRegistry: [],
        },
        client,
      );

      expect(result).toMatchObject({
        turnType: "planning_request",
        confidence: 0.92,
      });
    });

    it("classifies edit requests via LLM", async () => {
      const client = mockClient({
        turnType: "edit_request",
        confidence: 0.88,
        reasoning: "User wants to move an existing entity",
      });

      const result = await classifyTurn(
        {
          normalizedText: "Move that to Friday",
          discourseState: {
            focus_entity_id: "task-1",
            currently_editable_entity_id: "task-1",
            last_user_mentioned_entity_ids: [],
            last_presented_items: [],
            pending_clarifications: [],
            mode: "editing",
          },
          entityRegistry: [],
        },
        client,
      );

      expect(result).toMatchObject({
        turnType: "edit_request",
        confidence: 0.88,
        resolvedEntityIds: ["task-1"],
      });
    });

    it("classifies clarification answers via LLM", async () => {
      const client = mockClient({
        turnType: "clarification_answer",
        confidence: 0.91,
        reasoning: "Short reply providing time to pending clarification",
      });

      const result = await classifyTurn(
        {
          normalizedText: "5pm",
          discourseState: {
            focus_entity_id: null,
            currently_editable_entity_id: null,
            last_user_mentioned_entity_ids: [],
            last_presented_items: [],
            pending_clarifications: [
              {
                id: "c-1",
                slot: "time",
                question: "What time?",
                status: "pending",
                createdAt: "2026-03-20T16:00:00.000Z",
                createdTurnId: "t-1",
              },
            ],
            mode: "clarifying",
          },
          entityRegistry: [],
        },
        client,
      );

      expect(result).toMatchObject({
        turnType: "clarification_answer",
        confidence: 0.91,
      });
    });

    it("attaches resolvedProposalId when single proposal exists", async () => {
      const client = mockClient({
        turnType: "clarification_answer",
        confidence: 0.88,
        reasoning: "Answering clarification",
      });

      const result = await classifyTurn(
        {
          normalizedText: "3pm",
          discourseState: null,
          entityRegistry: [
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
        },
        client,
      );

      expect(result.resolvedProposalId).toBe("proposal-1");
    });

    it("clamps confidence to 0-1 range", async () => {
      const client = mockClient({
        turnType: "planning_request",
        confidence: 1.5,
        reasoning: "test",
      });

      const result = await classifyTurn(
        {
          normalizedText: "schedule gym",
          discourseState: null,
          entityRegistry: [],
        },
        client,
      );

      expect(result.confidence).toBe(1);
    });
  });

  describe("error handling", () => {
    it("degrades gracefully on LLM failure", async () => {
      const client = failingClient();

      const result = await classifyTurn(
        {
          normalizedText: "schedule something",
          discourseState: null,
          entityRegistry: [],
        },
        client,
      );

      expect(result).toMatchObject({
        turnType: "unknown",
        confidence: 0.3,
      });
    });
  });
});
