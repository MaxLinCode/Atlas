import { describe, expect, it } from "vitest";
import type { ConversationEntity, ResolvedFields, TimeSpec } from "./index";
import { deriveProposalCompatibility } from "./proposal-rules";

function t(hour: number, minute: number): TimeSpec {
  return { kind: "absolute", hour, minute };
}

type ScheduleFields = NonNullable<ResolvedFields["scheduleFields"]>;

function sf(fields: ScheduleFields): ResolvedFields {
  return { scheduleFields: fields };
}

type ProposalOption = Extract<ConversationEntity, { kind: "proposal_option" }>;

function makeProposal(
  overrides: Partial<ProposalOption["data"]> & {
    fieldSnapshot: ResolvedFields;
  },
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
  describe("field-based compatibility", () => {
    it("is compatible when committed fields match the snapshot", () => {
      const proposal = makeProposal({
        fieldSnapshot: sf({ time: t(15, 0), day: "friday" }),
      });

      const result = deriveProposalCompatibility(
        "clarification_answer",
        sf({ time: t(15, 0), day: "friday" }),
        proposal,
      );

      expect(result.compatible).toBe(true);
    });

    it("is incompatible when a committed field differs from the snapshot", () => {
      const proposal = makeProposal({
        fieldSnapshot: sf({ time: t(15, 0) }),
      });

      const result = deriveProposalCompatibility(
        "clarification_answer",
        sf({ time: t(17, 0) }),
        proposal,
      );

      expect(result.compatible).toBe(false);
      expect(result.reason).toMatch(/differs from proposal snapshot/);
    });

    it("is compatible when committed field is new (not in snapshot)", () => {
      const proposal = makeProposal({
        fieldSnapshot: sf({ day: "friday" }),
      });

      const result = deriveProposalCompatibility(
        "clarification_answer",
        sf({ day: "friday", time: t(17, 0) }),
        proposal,
      );

      expect(result.compatible).toBe(true);
    });

    it("is compatible when committed fields are empty", () => {
      const proposal = makeProposal({
        fieldSnapshot: sf({ time: t(15, 0), day: "friday" }),
      });

      const result = deriveProposalCompatibility(
        "clarification_answer",
        sf({}),
        proposal,
      );

      expect(result.compatible).toBe(true);
    });

    it("detects duration change as incompatible", () => {
      const proposal = makeProposal({
        fieldSnapshot: sf({ duration: 30 }),
      });

      const result = deriveProposalCompatibility(
        "planning_request",
        sf({ duration: 60 }),
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
        fieldSnapshot: sf({ time: t(15, 0) }),
      });

      const result = deriveProposalCompatibility(
        "edit_request",
        sf({ time: t(15, 0) }),
        proposal,
      );

      expect(result.compatible).toBe(false);
      expect(result.reason).toMatch(/action type/);
    });

    it("skips action kind check for clarification answers", () => {
      const proposal = makeProposal({
        originatingTurnText: "move the meeting",
        fieldSnapshot: sf({ time: t(15, 0) }),
      });

      const result = deriveProposalCompatibility(
        "clarification_answer",
        sf({ time: t(15, 0) }),
        proposal,
      );

      expect(result.compatible).toBe(true);
    });
  });
});
