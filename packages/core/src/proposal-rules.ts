import type {
  ConversationEntity,
  TurnClassifierOutput,
  TurnInterpretationType
} from "./index";

type ProposalOption = Extract<ConversationEntity, { kind: "proposal_option" }>;

export type ConsentRequirementInput = {
  classification: TurnClassifierOutput;
  entityRegistry: ConversationEntity[];
  normalizedText: string;
};

export function deriveConsentRequirement(input: ConsentRequirementInput) {
  const { classification } = input;
  const activeProposal = input.entityRegistry.find(
    (entity): entity is ProposalOption =>
      entity.kind === "proposal_option" &&
      (entity.status === "active" || entity.status === "presented") &&
      entity.id === classification.resolvedProposalId &&
      entity.data.confirmationRequired === true
  );

  if (!activeProposal) {
    return {
      required: false as const,
      reason: "Deterministic product rules do not require additional consent."
    };
  }

  if (!matchesProposalTarget(activeProposal.data.targetEntityId ?? null, classification.resolvedEntityIds)) {
    return {
      required: false as const,
      reason: "Deterministic product rules do not require additional consent."
    };
  }

  const compatibility = deriveProposalCompatibility(
    classification.turnType,
    input.normalizedText,
    activeProposal
  );

  if (!compatibility.compatible) {
    return {
      required: true as const,
      reason: compatibility.reason
    };
  }

  return {
    required: true as const,
    reason: "Write request is ready, but deterministic product policy still requires user consent.",
    targetProposalId: activeProposal.id
  };
}

export function matchesProposalTarget(targetEntityId: string | null, resolvedEntityIds: string[]) {
  if (!targetEntityId || resolvedEntityIds.length === 0) {
    return true;
  }

  return resolvedEntityIds.includes(targetEntityId);
}

export function deriveProposalCompatibility(
  turnType: TurnInterpretationType,
  normalizedText: string,
  proposal: ProposalOption
) {
  if (turnType === "clarification_answer") {
    return {
      compatible: true,
      reason: "Clarification answers may continue the same consent-required proposal."
    };
  }

  const currentActionKind = deriveActionKind(normalizedText, turnType);
  const proposalActionKind = deriveActionKind(
    proposal.data.originatingTurnText ?? proposal.data.replyText,
    inferProposalTurnType(proposal)
  );

  if (currentActionKind !== proposalActionKind) {
    return {
      compatible: false,
      reason: "The new turn changes the action type, so it needs fresh consent."
    };
  }

  const currentFingerprint = deriveParameterFingerprint(normalizedText);
  const proposalFingerprint = deriveParameterFingerprint(proposal.data.originatingTurnText ?? proposal.data.replyText);

  if (currentFingerprint.explicit && proposalFingerprint.explicit && currentFingerprint.value !== proposalFingerprint.value) {
    return {
      compatible: false,
      reason: "The new turn changes proposal parameters, so it needs fresh consent."
    };
  }

  return {
    compatible: true,
    reason: "The pending proposal still matches the current turn."
  };
}

export function inferProposalTurnType(
  proposal: ProposalOption
): TurnInterpretationType {
  const source = (proposal.data.originatingTurnText ?? proposal.data.replyText).toLowerCase();

  if (/\b(move|reschedule|shift|push|pull|complete|archive|cancel|delete|update|change|mark)\b/.test(source)) {
    return "edit_request";
  }

  return "planning_request";
}

export function deriveActionKind(text: string, turnType: TurnInterpretationType) {
  if (turnType === "edit_request") {
    return "edit";
  }

  if (turnType === "planning_request") {
    return "plan";
  }

  const lower = text.toLowerCase();

  if (/\b(move|reschedule|shift|push|pull|complete|archive|cancel|delete|update|change|mark)\b/.test(lower)) {
    return "edit";
  }

  return "plan";
}

export function deriveParameterFingerprint(text: string) {
  const lower = text.toLowerCase();
  const dayTokens = lower.match(
    /\b(today|tonight|tomorrow|tmr|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|next week|next month|morning|afternoon|evening)\b/g
  ) ?? [];
  const timeTokens =
    lower.match(/\b\d{1,2}(?::\d{2})?\s?(?:am|pm)?\b|\bnoon\b|\bmidnight\b/g) ?? [];
  const durationTokens =
    lower.match(/\bfor\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)\b|\b\d+\s*(?:minutes?|mins?|hours?|hrs?)\b/g) ?? [];
  const fingerprintParts = [...dayTokens, ...timeTokens, ...durationTokens].map((part) => part.trim()).sort();

  return {
    explicit: fingerprintParts.length > 0,
    value: fingerprintParts.join("|")
  };
}

export function containsWriteVerb(text: string) {
  return /\b(schedule|plan|move|reschedule|shift|create|add|book|put|mark|complete|archive|cancel|delete|change|update)\b/i.test(
    text
  );
}
