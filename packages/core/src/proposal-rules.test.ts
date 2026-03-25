import { describe, expect, it } from "vitest";

import { deriveProposalCompatibility } from "./proposal-rules";

import type { ConversationEntity, ResolvedSlots } from "./index";

type ProposalOption = Extract<ConversationEntity, { kind: "proposal_option" }>;

function makeProposal(
  overrides: Partial<ProposalOption["data"]> & { slotSnapshot: ResolvedSlots },
): ProposalOption {
  return {
    id: "proposal-1",
    conversationId: "c-1",
    kind: "proposal_option",
    label: "Test proposal",
    status: "active",
    createdAt: "2026-03-20T16:00:00.000Z",
    updatedAt: "2026-03-20T16:00:00.000Z",
    data: {
      route: "conversation_then_mutation",
      replyText: "Would you like me to schedule it?",
      confirmationRequired: true,
      ...overrides,
    },
  };
}

describe("deriveProposalCompatibility", () => {
  describe("slot-based compatibility", () => {
    it("is compatible when committed slots match the snapshot", () => {
      const proposal = makeProposal({
        slotSnapshot: { time: "15:00", day: "friday" },
      });

      const result = deriveProposalCompatibility(
        "clarification_answer",
        { time: "15:00", day: "friday" },
        proposal,
      );

      expect(result.compatible).toBe(true);
    });

    it("is incompatible when a committed slot differs from the snapshot", () => {
      const proposal = makeProposal({
        slotSnapshot: { time: "15:00" },
      });

      const result = deriveProposalCompatibility(
        "clarification_answer",
        { time: "17:00" },
        proposal,
      );

      expect(result.compatible).toBe(false);
      expect(result.reason).toMatch(/differs from proposal snapshot/);
    });

    it("is compatible when committed slot is new (not in snapshot)", () => {
      const proposal = makeProposal({
        slotSnapshot: { day: "friday" },
      });

      const result = deriveProposalCompatibility(
        "clarification_answer",
        { day: "friday", time: "17:00" },
        proposal,
      );

      expect(result.compatible).toBe(true);
    });

    it("is compatible when committed slots are empty", () => {
      const proposal = makeProposal({
        slotSnapshot: { time: "15:00", day: "friday" },
      });

      const result = deriveProposalCompatibility(
        "clarification_answer",
        {},
        proposal,
      );

      expect(result.compatible).toBe(true);
    });

    it("detects duration change as incompatible", () => {
      const proposal = makeProposal({
        slotSnapshot: { duration: 30 },
      });

      const result = deriveProposalCompatibility(
        "planning_request",
        { duration: 60 },
        proposal,
      );

      expect(result.compatible).toBe(false);
      expect(result.reason).toMatch(/duration.*differs/);
    });
  });

  describe("action kind check for non-clarification turns", () => {
    it("is incompatible when action kind changes from plan to edit", () => {
      const proposal = makeProposal({
        originatingTurnText: "schedule a meeting",
        slotSnapshot: { time: "15:00" },
      });

      const result = deriveProposalCompatibility(
        "edit_request",
        { time: "15:00" },
        proposal,
      );

      expect(result.compatible).toBe(false);
      expect(result.reason).toMatch(/action type/);
    });

    it("skips action kind check for clarification answers", () => {
      const proposal = makeProposal({
        originatingTurnText: "move the meeting",
        slotSnapshot: { time: "15:00" },
      });

      const result = deriveProposalCompatibility(
        "clarification_answer",
        { time: "15:00" },
        proposal,
      );

      expect(result.compatible).toBe(true);
    });
  });
});
