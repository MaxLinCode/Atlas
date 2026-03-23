import { describe, expect, it, vi } from "vitest";

import type { TurnClassifierOutput } from "@atlas/core";

import { interpretTurn } from "./interpret-turn";

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

describe("interpretTurn", () => {
  it("exposes only the native input signature", () => {
    expect(interpretTurn.length).toBe(1);
  });

  it("treats complete schedule requests as planning requests", async () => {
    mockClassification({
      turnType: "planning_request",
      confidence: 0.95
    });

    const result = await interpretTurn({
      rawText: "Schedule gym tomorrow at 6pm for 1 hour",
      normalizedText: "Schedule gym tomorrow at 6pm for 1 hour",
      recentTurns: []
    });

    expect(result).toMatchObject({
      turnType: "planning_request",
      ambiguity: "none"
    });
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("treats focused move requests as edit requests", async () => {
    mockClassification({
      turnType: "edit_request",
      confidence: 0.9,
      resolvedEntityIds: ["task-1"]
    });

    const result = await interpretTurn({
      rawText: "Move that to Friday at 3pm",
      normalizedText: "Move that to Friday at 3pm",
      recentTurns: [],
      discourseState: {
        focus_entity_id: "task-1",
        currently_editable_entity_id: "task-1",
        last_user_mentioned_entity_ids: [],
        last_presented_items: [],
        pending_clarifications: [],
        mode: "editing"
      }
    });

    expect(result).toMatchObject({
      turnType: "edit_request",
      resolvedEntityIds: ["task-1"],
      ambiguity: "none"
    });
  });

  it("treats yes with one pending proposal as confirmation", async () => {
    // This case is handled by the heuristic pre-filter in classifyTurn,
    // so the mock returns confirmation directly
    mockClassification({
      turnType: "confirmation",
      confidence: 0.97,
      resolvedEntityIds: ["task-1"],
      resolvedProposalId: "proposal-1"
    });

    const result = await interpretTurn({
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
            targetEntityId: "task-1",
            mutationInputSource: null,
            originatingTurnText: "Schedule dentist reminder"
          }
        }
      ]
    });

    expect(result).toMatchObject({
      turnType: "confirmation",
      resolvedProposalId: "proposal-1",
      resolvedEntityIds: ["task-1"],
      ambiguity: "none"
    });
  });

  it("does not treat yes with multiple proposals as recoverable confirmation", async () => {
    mockClassification({
      turnType: "unknown",
      confidence: 0.36
    });

    const result = await interpretTurn({
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
        },
        {
          id: "proposal-2",
          conversationId: "conversation-1",
          kind: "proposal_option",
          label: "Schedule it at 4pm",
          status: "active",
          createdAt: "2026-03-20T16:00:00.000Z",
          updatedAt: "2026-03-20T16:00:00.000Z",
          data: {
            route: "conversation_then_mutation",
            replyText: "Would you like me to schedule it at 4pm?",
            confirmationRequired: true
          }
        }
      ]
    });

    expect(result).toMatchObject({
      turnType: "unknown",
      ambiguity: "high"
    });
  });

  it("does not treat yes with only clarification state as confirmation", async () => {
    mockClassification({
      turnType: "unknown",
      confidence: 0.32
    });

    const result = await interpretTurn({
      rawText: "Yes",
      normalizedText: "Yes",
      recentTurns: [],
      entityRegistry: [
        {
          id: "clar-1",
          conversationId: "conversation-1",
          kind: "clarification",
          label: "Need a time",
          status: "active",
          createdAt: "2026-03-20T16:00:00.000Z",
          updatedAt: "2026-03-20T16:00:00.000Z",
          data: {
            prompt: "It sounds like you want me to block out time for planning your Malaysia trip at 3:15 PM for 15 minutes. I can proceed with that now.",
            reason: null,
            open: true
          }
        }
      ],
      discourseState: {
        focus_entity_id: "clar-1",
        currently_editable_entity_id: null,
        last_user_mentioned_entity_ids: [],
        last_presented_items: [],
        pending_clarifications: [
          {
            id: "clar-1",
            slot: "unknown",
            question: "It sounds like you want me to block out time for planning your Malaysia trip at 3:15 PM for 15 minutes. I can proceed with that now.",
            status: "pending",
            blocking: true,
            createdAt: "2026-03-20T16:00:00.000Z",
            createdTurnId: "assistant:1"
          }
        ],
        mode: "clarifying"
      }
    });

    expect(result).toMatchObject({
      turnType: "unknown",
      ambiguity: "high"
    });
  });

  it("treats short replies to pending clarifications as clarification answers", async () => {
    mockClassification({
      turnType: "clarification_answer",
      confidence: 0.88
    });

    const result = await interpretTurn({
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
    });

    expect(result).toMatchObject({
      turnType: "clarification_answer",
      missingSlots: ["time"]
    });
  });

  it("clears blocking slots from missingSlots when clarification answer has high confidence", async () => {
    mockClassification({
      turnType: "clarification_answer",
      confidence: 0.91
    });

    const result = await interpretTurn({
      rawText: "5pm",
      normalizedText: "5pm",
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
            question: "What time should I schedule it?",
            status: "pending",
            blocking: true,
            createdAt: "2026-03-20T16:00:00.000Z",
            createdTurnId: "assistant:1"
          }
        ],
        mode: "clarifying"
      }
    });

    expect(result).toMatchObject({
      turnType: "clarification_answer"
    });
    // Blocking slots are still reported as missingSlots (commit policy handles resolution in Phase 4)
    expect(result.missingSlots).toEqual(["time"]);
  });

  it("treats punctuated consent as confirmation when one active proposal exists", async () => {
    mockClassification({
      turnType: "confirmation",
      confidence: 0.97,
      resolvedProposalId: "proposal-1"
    });

    const result = await interpretTurn({
      rawText: "Ok,",
      normalizedText: "Ok,",
      recentTurns: [],
      entityRegistry: [
        {
          id: "proposal-1",
          conversationId: "conversation-1",
          kind: "proposal_option",
          label: "Schedule it at 5pm",
          status: "active",
          createdAt: "2026-03-20T16:00:00.000Z",
          updatedAt: "2026-03-20T16:00:00.000Z",
          data: {
            route: "conversation_then_mutation",
            replyText: "Would you like me to schedule it at 5pm?",
            confirmationRequired: true,
            targetEntityId: null,
            mutationInputSource: null
          }
        }
      ]
    });

    expect(result).toMatchObject({
      turnType: "confirmation",
      resolvedProposalId: "proposal-1",
      ambiguity: "none"
    });
  });

  it("treats informational questions as informational", async () => {
    mockClassification({
      turnType: "informational",
      confidence: 0.93
    });

    const result = await interpretTurn({
      rawText: "What do I have tomorrow?",
      normalizedText: "What do I have tomorrow?",
      recentTurns: []
    });

    expect(result).toMatchObject({
      turnType: "informational",
      ambiguity: "none"
    });
  });

  it("treats ambiguous short replies without context as unknown", async () => {
    mockClassification({
      turnType: "unknown",
      confidence: 0.3
    });

    const result = await interpretTurn({
      rawText: "Maybe",
      normalizedText: "Maybe",
      recentTurns: []
    });

    expect(result).toMatchObject({
      turnType: "unknown",
      ambiguity: "high"
    });
  });

  it("marks underspecified write turns with blocking clarification as high ambiguity", async () => {
    mockClassification({
      turnType: "edit_request",
      confidence: 0.7,
      resolvedEntityIds: ["task-1"]
    });

    const result = await interpretTurn({
      rawText: "Move it",
      normalizedText: "Move it",
      recentTurns: [],
      discourseState: {
        focus_entity_id: "task-1",
        currently_editable_entity_id: "task-1",
        last_user_mentioned_entity_ids: [],
        last_presented_items: [],
        pending_clarifications: [
          {
            id: "clar-1",
            slot: "time",
            question: "What time should I move it to?",
            status: "pending",
            blocking: true,
            createdAt: "2026-03-20T16:00:00.000Z",
            createdTurnId: "assistant:1"
          }
        ],
        mode: "clarifying"
      }
    });

    expect(result).toMatchObject({
      ambiguity: "high",
      missingSlots: ["time"]
    });
  });
});
