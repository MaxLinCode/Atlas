import {
  type CommitPolicyOutput,
  type ConversationEntity,
  type TurnAmbiguity,
  type TurnClassifierOutput,
  type TurnInterpretationType,
  type TurnPolicyDecision,
  type TurnRoutingInput
} from "@atlas/core";

export type DecideTurnPolicyInput = {
  classification: TurnClassifierOutput;
  commitResult: CommitPolicyOutput;
  routingContext: TurnRoutingInput;
};

type StructuredWriteReadiness =
  | {
      state: "not_ready";
      reason: string;
      clarificationSlots?: string[];
    }
  | {
      state: "ready_needs_consent";
      reason: string;
      targetProposalId?: string;
    }
  | {
      state: "ready_for_execution";
      reason: string;
    };

export function decideTurnPolicy(input: DecideTurnPolicyInput): TurnPolicyDecision {
  const { classification, commitResult } = input;
  const targetEntityId = classification.resolvedEntityIds[0];
  const ambiguity = deriveAmbiguity(classification, commitResult);

  switch (classification.turnType) {
    case "informational":
      return {
        action: "reply_only",
        reason: "Informational turn should stay in the conversation responder.",
        requiresWrite: false,
        requiresConfirmation: false,
        useMutationPipeline: false,
        ...(targetEntityId ? { targetEntityId } : {}),
        committedSlots: commitResult.committedSlots
      };
    case "follow_up_reply":
      return {
        action: "reply_only",
        reason: "Follow-up style reply reached the normal router without a recoverable write plan.",
        requiresWrite: false,
        requiresConfirmation: false,
        useMutationPipeline: false,
        ...(targetEntityId ? { targetEntityId } : {}),
        committedSlots: commitResult.committedSlots
      };
    case "confirmation":
      if (classification.resolvedProposalId) {
        return {
          action: "recover_and_execute",
          reason: "The turn confirms one recoverable pending proposal.",
          requiresWrite: true,
          requiresConfirmation: false,
          useMutationPipeline: true,
          ...(targetEntityId ? { targetEntityId } : {}),
          targetProposalId: classification.resolvedProposalId,
          mutationInputSource: "recovered_proposal",
          committedSlots: commitResult.committedSlots
        };
      }

      return {
        action: "ask_clarification",
        reason: "Confirmation language without one recoverable proposal should ask which proposal to apply.",
        requiresWrite: false,
        requiresConfirmation: false,
        useMutationPipeline: false,
        clarificationSlots: ["proposal"],
        committedSlots: commitResult.committedSlots
      };
    case "clarification_answer":
    case "planning_request":
    case "edit_request":
      return buildPolicyFromStructuredReadiness(
        deriveStructuredWriteReadiness(input, ambiguity),
        targetEntityId,
        commitResult.committedSlots
      );
    case "unknown": {
      const isNonWrite = ambiguity === "none" && !containsWriteVerb(input.routingContext.normalizedText);
      const clarificationSlots = [
        ...commitResult.missingSlots,
        ...commitResult.needsClarification
      ];
      return {
        action: isNonWrite ? "reply_only" : "ask_clarification",
        reason: isNonWrite
          ? "Unknown non-write text should stay in the conversation responder."
          : "Unknown turn meaning should prompt a clarification instead of guessing.",
        requiresWrite: false,
        requiresConfirmation: false,
        useMutationPipeline: false,
        clarificationSlots: isNonWrite ? undefined : (clarificationSlots.length > 0 ? clarificationSlots : undefined),
        committedSlots: commitResult.committedSlots
      };
    }
  }
}

function deriveAmbiguity(
  classification: TurnClassifierOutput,
  commitResult: CommitPolicyOutput
): TurnAmbiguity {
  if (classification.confidence < 0.6) return "high";
  if (commitResult.missingSlots.length > 0) return "high";
  if (commitResult.needsClarification.length > 0) return "high";
  if (classification.confidence < 0.8) return "low";
  return "none";
}

function deriveStructuredWriteReadiness(
  input: DecideTurnPolicyInput,
  ambiguity: TurnAmbiguity
): StructuredWriteReadiness {
  const { classification, commitResult } = input;
  const allClarificationSlots = [
    ...commitResult.missingSlots,
    ...commitResult.needsClarification
  ];

  if (ambiguity === "high") {
    return {
      state: "not_ready",
      reason:
        classification.turnType === "clarification_answer"
          ? "Clarification answer is still too ambiguous to safely continue."
          : "Write-like turn is too ambiguous to apply directly.",
      clarificationSlots: allClarificationSlots
    };
  }

  if (allClarificationSlots.length > 0) {
    return {
      state: "not_ready",
      reason:
        classification.turnType === "clarification_answer"
          ? "Clarification answer is still missing required write details."
          : "Required scheduling or target details are still missing.",
      clarificationSlots: allClarificationSlots
    };
  }

  // Bug 4 fix: if this is a clarification answer and the proposal is already confirmed,
  // skip re-presenting and go straight to execution
  if (classification.turnType === "clarification_answer") {
    const entityRegistry = input.routingContext.entityRegistry ?? [];
    const alreadyConfirmed = entityRegistry.some(
      (e) =>
        e.kind === "proposal_option" &&
        e.id === classification.resolvedProposalId &&
        e.status === "confirmed"
    );

    if (alreadyConfirmed) {
      return {
        state: "ready_for_execution",
        reason: "Clarification answer resolved the final detail and proposal was already confirmed."
      };
    }
  }

  const consentRequirement = deriveConsentRequirement(input);

  if (consentRequirement.required) {
    return {
      state: "ready_needs_consent",
      reason: consentRequirement.reason,
      ...(consentRequirement.targetProposalId ? { targetProposalId: consentRequirement.targetProposalId } : {})
    };
  }

  return {
    state: "ready_for_execution",
    reason:
      classification.turnType === "clarification_answer"
        ? "Clarification answer resolved the missing detail needed for the write path."
        : "Write-ready request can go straight to the mutation pipeline."
  };
}

function buildPolicyFromStructuredReadiness(
  readiness: StructuredWriteReadiness,
  targetEntityId: string | undefined,
  committedSlots: TurnPolicyDecision["committedSlots"]
): TurnPolicyDecision {
  switch (readiness.state) {
    case "not_ready":
      return {
        action: "ask_clarification",
        reason: readiness.reason,
        requiresWrite: false,
        requiresConfirmation: false,
        useMutationPipeline: false,
        ...(targetEntityId ? { targetEntityId } : {}),
        clarificationSlots: readiness.clarificationSlots,
        committedSlots
      };
    case "ready_needs_consent":
      return {
        action: "present_proposal",
        reason: readiness.reason,
        requiresWrite: false,
        requiresConfirmation: true,
        useMutationPipeline: false,
        ...(targetEntityId ? { targetEntityId } : {}),
        ...(readiness.targetProposalId ? { targetProposalId: readiness.targetProposalId } : {}),
        committedSlots
      };
    case "ready_for_execution":
      return {
        action: "execute_mutation",
        reason: readiness.reason,
        requiresWrite: true,
        requiresConfirmation: false,
        useMutationPipeline: true,
        ...(targetEntityId ? { targetEntityId } : {}),
        mutationInputSource: "direct_user_turn",
        committedSlots
      };
  }
}

function deriveConsentRequirement(input: DecideTurnPolicyInput) {
  const { classification } = input;
  // Bug 2 fix: match "presented" status in addition to "active"
  const activeProposal = (input.routingContext.entityRegistry ?? []).find(
    (entity): entity is Extract<ConversationEntity, { kind: "proposal_option" }> =>
      entity.kind === "proposal_option" &&
      (entity.status === "active" || entity.status === "presented") &&
      entity.id === classification.resolvedProposalId &&
      entity.data.confirmationRequired === true
  );

  if (!activeProposal) {
    return {
      required: false,
      reason: "Deterministic product rules do not require additional consent."
    };
  }

  if (!matchesProposalTarget(activeProposal.data.targetEntityId ?? null, classification.resolvedEntityIds)) {
    return {
      required: false,
      reason: "Deterministic product rules do not require additional consent."
    };
  }

  const compatibility = deriveProposalCompatibility(input, activeProposal);

  if (!compatibility.compatible) {
    return {
      required: true,
      reason: compatibility.reason
    };
  }

  return {
    required: true,
    reason: "Write request is ready, but deterministic product policy still requires user consent.",
    targetProposalId: activeProposal.id
  };
}

function matchesProposalTarget(targetEntityId: string | null, resolvedEntityIds: string[]) {
  if (!targetEntityId || resolvedEntityIds.length === 0) {
    return true;
  }

  return resolvedEntityIds.includes(targetEntityId);
}

function deriveProposalCompatibility(
  input: DecideTurnPolicyInput,
  proposal: Extract<ConversationEntity, { kind: "proposal_option" }>
) {
  if (input.classification.turnType === "clarification_answer") {
    return {
      compatible: true,
      reason: "Clarification answers may continue the same consent-required proposal."
    };
  }

  const currentActionKind = deriveActionKind(input.routingContext.normalizedText, input.classification.turnType);
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

  const currentFingerprint = deriveParameterFingerprint(input.routingContext.normalizedText);
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

function inferProposalTurnType(
  proposal: Extract<ConversationEntity, { kind: "proposal_option" }>
): TurnInterpretationType {
  const source = (proposal.data.originatingTurnText ?? proposal.data.replyText).toLowerCase();

  if (/\b(move|reschedule|shift|push|pull|complete|archive|cancel|delete|update|change|mark)\b/.test(source)) {
    return "edit_request";
  }

  return "planning_request";
}

function deriveActionKind(text: string, turnType: TurnInterpretationType) {
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

function deriveParameterFingerprint(text: string) {
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

function containsWriteVerb(text: string) {
  return /\b(schedule|plan|move|reschedule|shift|create|add|book|put|mark|complete|archive|cancel|delete|change|update)\b/i.test(
    text
  );
}
