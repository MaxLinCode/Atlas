import { describe, expect, it, vi } from "vitest";

import type { TurnClassifierOutput } from "@atlas/core";

import { routeMessageTurn, containsModificationPayload } from "./turn-router";

vi.mock("./llm-classifier", () => ({
  classifyTurn: vi.fn()
}));

vi.mock("./slot-extractor", () => ({
  extractSlots: vi.fn().mockResolvedValue({
    extractedValues: {},
    confidence: {},
    unresolvable: []
  })
}));

import { classifyTurn } from "./llm-classifier";
import { extractSlots } from "./slot-extractor";

const mockClassifyTurn = vi.mocked(classifyTurn);
const mockExtractSlots = vi.mocked(extractSlots);

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
    mockExtractSlots.mockResolvedValueOnce({
      extractedValues: { day: "tomorrow", time: "18:00" },
      confidence: { day: 0.95, time: 0.95 },
      unresolvable: []
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

  it("includes committedSlots on policy output", async () => {
    mockClassification({
      turnType: "informational",
      confidence: 0.93
    });

    const result = await routeMessageTurn({
      rawText: "What's on my schedule?",
      normalizedText: "What's on my schedule?",
      recentTurns: []
    });

    expect(result.policy.committedSlots).toEqual({});
  });

  it("includes resolvedContract on policy output for planning_request", async () => {
    mockClassification({
      turnType: "planning_request",
      confidence: 0.95
    });
    mockExtractSlots.mockResolvedValueOnce({
      extractedValues: { day: "tomorrow", time: "18:00" },
      confidence: { day: 0.95, time: 0.95 },
      unresolvable: []
    });

    const result = await routeMessageTurn({
      rawText: "Schedule gym tomorrow at 6pm",
      normalizedText: "Schedule gym tomorrow at 6pm",
      recentTurns: []
    });

    expect(result.policy.resolvedContract).toEqual({
      requiredSlots: ["day", "time"],
      intentKind: "plan"
    });
  });

  it("carries forward priorContract from discourse state for clarification_answer", async () => {
    const priorContract = { requiredSlots: ["time"] as ("day" | "time" | "duration" | "target")[], intentKind: "edit" as const };

    mockClassification({
      turnType: "clarification_answer",
      confidence: 0.9
    });
    mockExtractSlots.mockResolvedValueOnce({
      extractedValues: { time: "17:00" },
      confidence: { time: 0.92 },
      unresolvable: []
    });

    const result = await routeMessageTurn({
      rawText: "5pm",
      normalizedText: "5pm",
      recentTurns: [],
      discourseState: {
        focus_entity_id: null,
        currently_editable_entity_id: null,
        last_user_mentioned_entity_ids: [],
        last_presented_items: [],
        pending_clarifications: [],
        pending_write_contract: priorContract,
        mode: "clarifying"
      }
    });

    expect(result.policy.resolvedContract).toEqual(priorContract);
  });

  it("falls back to default contract when no prior contract exists", async () => {
    mockClassification({
      turnType: "clarification_answer",
      confidence: 0.9
    });
    mockExtractSlots.mockResolvedValueOnce({
      extractedValues: { time: "17:00" },
      confidence: { time: 0.92 },
      unresolvable: []
    });

    const result = await routeMessageTurn({
      rawText: "5pm",
      normalizedText: "5pm",
      recentTurns: []
    });

    expect(result.policy.resolvedContract).toEqual({
      requiredSlots: ["day", "time"],
      intentKind: "plan"
    });
  });

  it("reclassifies compound confirmation with active proposal to clarification_answer", async () => {
    mockClassification({
      turnType: "confirmation",
      confidence: 0.95,
      resolvedProposalId: "proposal-1"
    });
    mockExtractSlots.mockResolvedValueOnce({
      extractedValues: { time: "17:00" },
      confidence: { time: 0.92 },
      unresolvable: []
    });

    const result = await routeMessageTurn({
      rawText: "ok but make it 5pm",
      normalizedText: "ok but make it 5pm",
      recentTurns: [],
      entityRegistry: [
        {
          id: "proposal-1",
          conversationId: "conversation-1",
          kind: "proposal_option",
          label: "Schedule it at 3pm",
          status: "presented",
          createdAt: "2026-03-20T16:00:00.000Z",
          updatedAt: "2026-03-20T16:00:00.000Z",
          data: {
            route: "conversation_then_mutation",
            replyText: "Would you like me to schedule it at 3pm?",
            confirmationRequired: true,
            targetEntityId: null,
            mutationInputSource: null
          }
        }
      ]
    });

    expect(result.interpretation.turnType).toBe("clarification_answer");
    expect(result.interpretation.resolvedProposalId).toBeUndefined();
    expect(result.policy.action).not.toBe("recover_and_execute");
  });

  it("does not reclassify pure confirmation with active proposal", async () => {
    mockClassification({
      turnType: "confirmation",
      confidence: 0.97,
      resolvedProposalId: "proposal-1"
    });

    const result = await routeMessageTurn({
      rawText: "ok",
      normalizedText: "ok",
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
            mutationInputSource: null
          }
        }
      ]
    });

    expect(result.interpretation.turnType).toBe("confirmation");
    expect(result.policy.action).toBe("recover_and_execute");
  });

  it("does not reclassify compound confirmation without active proposal context", async () => {
    mockClassification({
      turnType: "confirmation",
      confidence: 0.9
    });

    const result = await routeMessageTurn({
      rawText: "ok but 5pm",
      normalizedText: "ok but 5pm",
      recentTurns: [],
      entityRegistry: []
    });

    expect(result.interpretation.turnType).toBe("confirmation");
  });
});

describe("containsModificationPayload", () => {
  it("detects time patterns", () => {
    expect(containsModificationPayload("ok but 5pm")).toBe(true);
    expect(containsModificationPayload("sure, at 3")).toBe(true);
    expect(containsModificationPayload("yes 17:00")).toBe(true);
  });

  it("detects day patterns", () => {
    expect(containsModificationPayload("ok but tomorrow")).toBe(true);
    expect(containsModificationPayload("yes friday")).toBe(true);
  });

  it("detects modification signals", () => {
    expect(containsModificationPayload("ok but different")).toBe(true);
    expect(containsModificationPayload("yes change it")).toBe(true);
    expect(containsModificationPayload("sure, actually")).toBe(true);
  });

  it("does not match pure confirmations", () => {
    expect(containsModificationPayload("ok")).toBe(false);
    expect(containsModificationPayload("yes")).toBe(false);
    expect(containsModificationPayload("sure")).toBe(false);
    expect(containsModificationPayload("do it")).toBe(false);
    expect(containsModificationPayload("yup")).toBe(false);
  });
});
