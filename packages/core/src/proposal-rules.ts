import type {
  ConversationEntity,
  ResolvedSlots,
  TurnClassifierOutput,
  TurnInterpretationType,
} from "./index";
import { timeSpecsEqual } from "./time-spec";

type ProposalOption = Extract<ConversationEntity, { kind: "proposal_option" }>;

export type ConsentRequirementInput = {
  classification: TurnClassifierOutput;
  entityRegistry: ConversationEntity[];
  committedSlots: ResolvedSlots;
};

export function deriveConsentRequirement(input: ConsentRequirementInput) {
  const { classification } = input;

  const consentRequiringProposals = input.entityRegistry.filter(
    (entity): entity is ProposalOption =>
      entity.kind === "proposal_option" &&
      (entity.status === "active" || entity.status === "presented") &&
      entity.data.confirmationRequired === true,
  );

  // Match by resolvedProposalId if available, otherwise fall back to the
  // single active/presented proposal (covers modified-proposal case where
  // the guard cleared resolvedProposalId).
  const matchedById = classification.resolvedProposalId
    ? consentRequiringProposals.find(
        (p) => p.id === classification.resolvedProposalId,
      )
    : undefined;
  const inferredProposal =
    !matchedById && consentRequiringProposals.length === 1
      ? consentRequiringProposals[0]
      : undefined;
  const activeProposal = matchedById ?? inferredProposal;

  if (!activeProposal) {
    return {
      required: false as const,
      reason: "Deterministic product rules do not require additional consent.",
    };
  }

  if (
    !matchesProposalTarget(
      activeProposal.data.targetEntityId ?? null,
      classification.resolvedEntityIds,
    )
  ) {
    return {
      required: false as const,
      reason: "Deterministic product rules do not require additional consent.",
    };
  }

  const compatibility = deriveProposalCompatibility(
    classification.turnType,
    input.committedSlots,
    activeProposal,
  );

  if (!compatibility.compatible) {
    return {
      required: true as const,
      reason: compatibility.reason,
    };
  }

  // When the proposal was inferred (not matched by ID), consent is required
  // but we do NOT return targetProposalId — the caller should emit a new
  // proposal rather than resurrecting the old one for direct execution.
  if (inferredProposal) {
    return {
      required: true as const,
      reason:
        "Write request is ready, but the proposal was modified and needs fresh consent.",
    };
  }

  return {
    required: true as const,
    reason:
      "Write request is ready, but deterministic product policy still requires user consent.",
    targetProposalId: activeProposal.id,
  };
}

export function matchesProposalTarget(
  targetEntityId: string | null,
  resolvedEntityIds: string[],
) {
  if (!targetEntityId || resolvedEntityIds.length === 0) {
    return true;
  }

  return resolvedEntityIds.includes(targetEntityId);
}

export function deriveProposalCompatibility(
  turnType: TurnInterpretationType,
  committedSlots: ResolvedSlots,
  proposal: ProposalOption,
) {
  if (turnType === "clarification_answer") {
    return deriveSlotsCompatibility(committedSlots, proposal.data.slotSnapshot);
  }

  const currentActionKind = turnType === "edit_request" ? "edit" : "plan";
  const proposalActionKind =
    inferProposalTurnType(proposal) === "edit_request" ? "edit" : "plan";

  if (currentActionKind !== proposalActionKind) {
    return {
      compatible: false,
      reason:
        "The new turn changes the action type, so it needs fresh consent.",
    };
  }

  return deriveSlotsCompatibility(committedSlots, proposal.data.slotSnapshot);
}

function deriveSlotsCompatibility(
  committedSlots: ResolvedSlots,
  snapshotSlots: ResolvedSlots,
) {
  const scalarKeys = ["day", "duration", "target"] as const;

  for (const key of scalarKeys) {
    const committed = committedSlots[key];
    const snapshot = snapshotSlots[key];

    if (
      committed !== undefined &&
      snapshot !== undefined &&
      committed !== snapshot
    ) {
      return {
        compatible: false,
        reason: `Committed slot "${key}" differs from proposal snapshot, so it needs fresh consent.`,
      };
    }
  }

  if (
    committedSlots.time !== undefined &&
    snapshotSlots.time !== undefined &&
    !timeSpecsEqual(committedSlots.time, snapshotSlots.time)
  ) {
    return {
      compatible: false,
      reason: `Committed slot "time" differs from proposal snapshot, so it needs fresh consent.`,
    };
  }

  return {
    compatible: true,
    reason: "Committed slots are compatible with the proposal snapshot.",
  };
}

export function inferProposalTurnType(
  proposal: ProposalOption,
): TurnInterpretationType {
  const source = (
    proposal.data.originatingTurnText ?? proposal.data.replyText
  ).toLowerCase();

  if (
    /\b(move|reschedule|shift|push|pull|complete|archive|cancel|delete|update|change|mark)\b/.test(
      source,
    )
  ) {
    return "edit_request";
  }

  return "planning_request";
}

export function containsWriteVerb(text: string) {
  return /\b(schedule|plan|move|reschedule|shift|create|add|book|put|mark|complete|archive|cancel|delete|change|update)\b/i.test(
    text,
  );
}
