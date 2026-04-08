import type {
  CommitPolicyOutput,
  TimeSpec,
  TurnClassifierOutput,
} from "@atlas/core";
import { describe, expect, it } from "vitest";

function t(hour: number, minute: number): TimeSpec {
  return { kind: "absolute", hour, minute };
}

import {
  type DecideTurnPolicyInput,
  decideTurnPolicy,
} from "./decide-turn-policy";

const emptyCommit: CommitPolicyOutput = {
  resolvedFields: {},
  resolvedTargetRef: null,
  needsClarification: [],
  missingFields: [],
  workflowChanged: false,
  committedFieldPaths: [],
};

function input(
  classification: Partial<TurnClassifierOutput> & {
    resolvedEntityIds?: string[];
    resolvedProposalId?: string;
  },
  commitResult: Partial<CommitPolicyOutput>,
  routingContext: DecideTurnPolicyInput["routingContext"],
): DecideTurnPolicyInput {
  const { resolvedEntityIds, resolvedProposalId, ...classificationRest } =
    classification;
  return {
    classification: {
      turnType: "unknown",
      confidence: 0.5,
      ...classificationRest,
    },
    commitResult: { ...emptyCommit, ...commitResult },
    routingContext,
    ...(resolvedEntityIds?.[0]
      ? { targetEntityId: resolvedEntityIds[0] }
      : {}),
    ...(resolvedProposalId ? { resolvedProposalId } : {}),
  };
}

describe("decideTurnPolicy", () => {
  it("maps informational turns to reply_only", () => {
    expect(
      decideTurnPolicy(
        input(
          { turnType: "informational", confidence: 0.9 },
          {},
          {
            rawText: "What do I have tomorrow?",
            normalizedText: "What do I have tomorrow?",
            recentTurns: [],
          },
        ),
      ),
    ).toMatchObject({
      action: "reply_only",
      requiresWrite: false,
    });
  });

  it("asks for clarification when a scheduling request is still missing required slots", () => {
    expect(
      decideTurnPolicy(
        input(
          { turnType: "planning_request", confidence: 0.58 },
          { missingFields: ["scheduleFields.time"] },
          {
            rawText: "Schedule gym tomorrow",
            normalizedText: "Schedule gym tomorrow",
            recentTurns: [],
          },
        ),
      ),
    ).toMatchObject({
      action: "ask_clarification",
      clarificationSlots: ["scheduleFields.time"],
    });
  });

  it("keeps clarification answers in clarification when required slots remain", () => {
    expect(
      decideTurnPolicy(
        input(
          { turnType: "clarification_answer", confidence: 0.84 },
          { missingFields: ["scheduleFields.time"] },
          { rawText: "Tomorrow", normalizedText: "Tomorrow", recentTurns: [] },
        ),
      ),
    ).toMatchObject({
      action: "ask_clarification",
      clarificationSlots: ["scheduleFields.time"],
    });
  });

  it("does not force proposal mode for low-confidence writes alone", () => {
    expect(
      decideTurnPolicy(
        input(
          { turnType: "planning_request", confidence: 0.68 },
          {
            resolvedFields: {
              scheduleFields: { day: "tomorrow", time: t(18, 0) },
            },
          },
          {
            rawText: "Schedule gym tomorrow at 6pm",
            normalizedText: "Schedule gym tomorrow at 6pm",
            recentTurns: [],
          },
        ),
      ),
    ).toMatchObject({
      action: "execute_mutation",
      requiresConfirmation: false,
    });
  });

  it("executes complete scheduling requests with no ambiguity", () => {
    expect(
      decideTurnPolicy(
        input(
          { turnType: "planning_request", confidence: 0.95 },
          {},
          {
            rawText: "Schedule gym tomorrow at 6pm for 1 hour",
            normalizedText: "Schedule gym tomorrow at 6pm for 1 hour",
            recentTurns: [],
          },
        ),
      ),
    ).toMatchObject({
      action: "execute_mutation",
    });
  });

  it("recovers and executes when confirmation has one recoverable proposal", () => {
    expect(
      decideTurnPolicy(
        input(
          {
            turnType: "confirmation",
            confidence: 0.95,
            resolvedProposalId: "proposal-1",
          },
          {},
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
                  fieldSnapshot: {},
                  operationKind: "plan",
                },
              },
            ],
          },
        ),
      ),
    ).toMatchObject({
      action: "execute_mutation",
      targetProposalId: "proposal-1",
      resolvedOperation: expect.objectContaining({ operationKind: "plan" }),
    });
  });

  it("recovers from registry when confirmation has no resolvedProposalId but one active proposal exists", () => {
    expect(
      decideTurnPolicy(
        input(
          {
            turnType: "confirmation",
            confidence: 0.95,
            // resolvedProposalId intentionally absent — classifier missed it
          },
          {},
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
                  fieldSnapshot: {},
                  operationKind: "plan",
                },
              },
            ],
          },
        ),
      ),
    ).toMatchObject({
      action: "execute_mutation",
      targetProposalId: "proposal-1",
      resolvedOperation: expect.objectContaining({ operationKind: "plan" }),
    });
  });

  it("treats affirmative consent on a pending proposal as execution", () => {
    expect(
      decideTurnPolicy(
        input(
          {
            turnType: "confirmation",
            confidence: 0.97,
            resolvedEntityIds: ["task-1"],
            resolvedProposalId: "proposal-1",
          },
          {},
          {
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
                  targetEntityId: "task-1",
                  fieldSnapshot: {},
                  operationKind: "plan",
                },
              },
            ],
          },
        ),
      ),
    ).toMatchObject({
      action: "execute_mutation",
      targetProposalId: "proposal-1",
      resolvedOperation: expect.objectContaining({ operationKind: "plan" }),
    });
  });

  it("asks for clarification on ambiguous write-like turns", () => {
    expect(
      decideTurnPolicy(
        input(
          {
            turnType: "edit_request",
            confidence: 0.55,
            resolvedEntityIds: ["task-1"],
          },
          {},
          { rawText: "Move it", normalizedText: "Move it", recentTurns: [] },
        ),
      ),
    ).toMatchObject({
      action: "ask_clarification",
    });
  });

  it("uses present_proposal only for explicit confirmation-required policy", () => {
    expect(
      decideTurnPolicy(
        input(
          {
            turnType: "planning_request",
            confidence: 0.93,
            resolvedEntityIds: ["task-1"],
            resolvedProposalId: "proposal-1",
          },
          {},
          {
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
                  replyText:
                    "Would you like me to schedule it tomorrow at 6pm?",
                  confirmationRequired: true,
                  targetEntityId: "task-1",
                  fieldSnapshot: {},
                },
              },
            ],
          },
        ),
      ),
    ).toMatchObject({
      action: "present_proposal",
      requiresConfirmation: true,
    });
  });

  it("routes ready clarification answers to present_proposal when deterministic consent is still required", () => {
    expect(
      decideTurnPolicy(
        input(
          {
            turnType: "clarification_answer",
            confidence: 0.92,
            resolvedEntityIds: ["task-1"],
            resolvedProposalId: "proposal-1",
          },
          {},
          {
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
                  targetEntityId: "task-1",
                  fieldSnapshot: {},
                },
              },
            ],
          },
        ),
      ),
    ).toMatchObject({
      action: "present_proposal",
      requiresConfirmation: true,
      targetProposalId: "proposal-1",
    });
  });

  it("recomputes a parameter edit on an active proposal instead of executing it", () => {
    const result = decideTurnPolicy(
      input(
        {
          turnType: "edit_request",
          confidence: 0.9,
          resolvedEntityIds: ["task-1"],
          resolvedProposalId: "proposal-1",
        },
        {
          resolvedFields: {
            scheduleFields: { time: t(15, 0), day: "tomorrow" },
          },
        },
        {
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
                originatingTurnText: "move it to tomorrow 2pm",
                fieldSnapshot: {
                  scheduleFields: { time: t(14, 0), day: "tomorrow" },
                },
              },
            },
          ],
        },
      ),
    );

    expect(result).toMatchObject({
      action: "present_proposal",
      requiresConfirmation: true,
    });
    expect(result.targetProposalId).toBeUndefined();
  });

  it("does not bind consent to a stale proposal with a different target", () => {
    expect(
      decideTurnPolicy(
        input(
          {
            turnType: "edit_request",
            confidence: 0.91,
            resolvedEntityIds: ["task-2"],
            resolvedProposalId: "proposal-1",
          },
          {},
          {
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
                  targetEntityId: "task-1",
                  fieldSnapshot: {},
                },
              },
            ],
          },
        ),
      ),
    ).toMatchObject({
      action: "execute_mutation",
    });
  });

  // Bug 2: presented proposals should be found by deriveConsentRequirement
  it("finds presented proposals for consent requirement (Bug 2 fix)", () => {
    expect(
      decideTurnPolicy(
        input(
          {
            turnType: "planning_request",
            confidence: 0.93,
            resolvedEntityIds: ["task-1"],
            resolvedProposalId: "proposal-1",
          },
          {},
          {
            rawText: "Schedule it tomorrow at 6pm",
            normalizedText: "Schedule it tomorrow at 6pm",
            recentTurns: [],
            entityRegistry: [
              {
                id: "proposal-1",
                conversationId: "conversation-1",
                kind: "proposal_option",
                label: "Schedule it tomorrow at 6pm",
                status: "presented",
                createdAt: "2026-03-20T16:00:00.000Z",
                updatedAt: "2026-03-20T16:00:00.000Z",
                data: {
                  route: "conversation_then_mutation",
                  replyText:
                    "Would you like me to schedule it tomorrow at 6pm?",
                  confirmationRequired: true,
                  targetEntityId: "task-1",
                  fieldSnapshot: {},
                },
              },
            ],
          },
        ),
      ),
    ).toMatchObject({
      action: "present_proposal",
      requiresConfirmation: true,
      targetProposalId: "proposal-1",
    });
  });

  // Bug 4: clarification answer after confirmation should not re-present
  it("routes clarification answer to execution when proposal is already confirmed (Bug 4 fix)", () => {
    expect(
      decideTurnPolicy(
        input(
          {
            turnType: "clarification_answer",
            confidence: 0.92,
            resolvedEntityIds: ["task-1"],
            resolvedProposalId: "proposal-1",
          },
          {},
          {
            rawText: "5pm",
            normalizedText: "5pm",
            recentTurns: [],
            entityRegistry: [
              {
                id: "proposal-1",
                conversationId: "conversation-1",
                kind: "proposal_option",
                label: "Schedule it at 5pm",
                status: "confirmed",
                createdAt: "2026-03-20T16:00:00.000Z",
                updatedAt: "2026-03-20T16:00:00.000Z",
                data: {
                  route: "conversation_then_mutation",
                  replyText: "Would you like me to schedule it at 5pm?",
                  confirmationRequired: true,
                  targetEntityId: "task-1",
                  fieldSnapshot: {},
                },
              },
            ],
          },
        ),
      ),
    ).toMatchObject({
      action: "execute_mutation",
    });
  });

  it("routes compound confirmation (classified as clarification_answer) with enough info to present_proposal for modified proposal", () => {
    const result = decideTurnPolicy(
      input(
        // resolvedProposalId is cleared by the guard — no stale proposal binding
        {
          turnType: "clarification_answer",
          confidence: 0.9,
          resolvedEntityIds: ["task-1"],
        },
        {
          resolvedFields: {
            scheduleFields: { day: "tomorrow", time: t(17, 0) },
          },
        },
        {
          rawText: "ok but make it 5pm",
          normalizedText: "ok but make it 5pm",
          recentTurns: [],
          entityRegistry: [
            {
              id: "proposal-1",
              conversationId: "conversation-1",
              kind: "proposal_option",
              label: "Schedule it tomorrow at 3pm",
              status: "presented",
              createdAt: "2026-03-20T16:00:00.000Z",
              updatedAt: "2026-03-20T16:00:00.000Z",
              data: {
                route: "conversation_then_mutation",
                replyText: "Would you like me to schedule it tomorrow at 3pm?",
                confirmationRequired: true,
                targetEntityId: "task-1",
                fieldSnapshot: {
                  scheduleFields: { day: "tomorrow", time: t(15, 0) },
                },
              },
            },
          ],
        },
      ),
    );

    // Modified proposal still requires consent — emits new proposal, not the old ID
    expect(result).toMatchObject({
      action: "present_proposal",
      requiresWrite: true,
      requiresConfirmation: true,
    });
  });

  it("routes compound confirmation (classified as clarification_answer) with missing slots to ask_clarification", () => {
    expect(
      decideTurnPolicy(
        input(
          { turnType: "clarification_answer", confidence: 0.9 },
          {
            resolvedFields: { scheduleFields: { day: "tomorrow" } },
            missingFields: ["scheduleFields.time"],
            needsClarification: ["scheduleFields.time"],
          },
          {
            rawText: "ok but tomorrow",
            normalizedText: "ok but tomorrow",
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
                  fieldSnapshot: { scheduleFields: { time: t(15, 0) } },
                },
              },
            ],
          },
        ),
      ),
    ).toMatchObject({
      action: "ask_clarification",
      clarificationSlots: expect.arrayContaining(["scheduleFields.time"]),
    });
  });
});
