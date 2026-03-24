import { describe, expect, it } from "vitest";

import { deriveProposalCompatibility } from "./proposal-rules";

import type { ConversationEntity } from "./index";

type ProposalOption = Extract<ConversationEntity, { kind: "proposal_option" }>;

function makeProposal(overrides: Partial<ProposalOption["data"]> = {}): ProposalOption {
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
      ...overrides
    }
  };
}

describe("deriveProposalCompatibility", () => {
  describe("clarification_answer parameter fingerprint check", () => {
    it("is compatible when parameters match", () => {
      const proposal = makeProposal({
        replyText: "Would you like me to move it to 3:15pm?"
      });

      const result = deriveProposalCompatibility("clarification_answer", "3:15pm", proposal);

      expect(result.compatible).toBe(true);
    });

    it("is incompatible when parameters differ", () => {
      const proposal = makeProposal({
        replyText: "Would you like me to schedule it at 3pm?"
      });

      const result = deriveProposalCompatibility("clarification_answer", "5pm", proposal);

      expect(result.compatible).toBe(false);
      expect(result.reason).toMatch(/changes proposal parameters/);
    });

    it("is compatible when clarification has no explicit parameters", () => {
      const proposal = makeProposal({
        replyText: "Would you like me to schedule it at 3pm?"
      });

      const result = deriveProposalCompatibility("clarification_answer", "yes", proposal);

      expect(result.compatible).toBe(true);
    });

    it("is compatible when proposal has no explicit parameters", () => {
      const proposal = makeProposal({
        replyText: "Would you like me to schedule it?"
      });

      const result = deriveProposalCompatibility("clarification_answer", "5pm", proposal);

      expect(result.compatible).toBe(true);
    });

    it("uses originatingTurnText over replyText when available", () => {
      const proposal = makeProposal({
        replyText: "Would you like me to move it to 3pm?",
        originatingTurnText: "move it to 3pm"
      });

      const result = deriveProposalCompatibility("clarification_answer", "5pm", proposal);

      expect(result.compatible).toBe(false);
    });
  });
});
