import {
  type CommitPolicyOutput,
  containsWriteVerb,
  type ConversationEntity,
  deriveAmbiguity,
  deriveConsentRequirement,
  type TurnAmbiguity,
  type TurnClassifierOutput,
  type TurnPolicyDecision,
  type TurnRoutingInput,
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

export function decideTurnPolicy(
  input: DecideTurnPolicyInput,
): TurnPolicyDecision {
  const { classification, commitResult } = input;
  const targetEntityId = classification.resolvedEntityIds[0];
  const ambiguity = deriveAmbiguity({
    classifierConfidence: classification.confidence,
    missingFields: commitResult.missingFields,
    needsClarification: commitResult.needsClarification,
  });

  switch (classification.turnType) {
    case "informational":
      return {
        action: "reply_only",
        reason: "Informational turn should stay in the conversation responder.",
        requiresWrite: false,
        requiresConfirmation: false,
        useMutationPipeline: false,
        ...(targetEntityId ? { targetEntityId } : {}),
      };
    case "follow_up_reply":
      return {
        action: "reply_only",
        reason:
          "Follow-up style reply reached the normal router without a recoverable write plan.",
        requiresWrite: false,
        requiresConfirmation: false,
        useMutationPipeline: false,
        ...(targetEntityId ? { targetEntityId } : {}),
      };
    case "confirmation": {
      const proposalId =
        classification.resolvedProposalId ??
        resolveSingleActiveProposalId(
          input.routingContext.entityRegistry ?? [],
        );

      if (proposalId) {
        return {
          action: "recover_and_execute",
          reason: "The turn confirms one recoverable pending proposal.",
          requiresWrite: true,
          requiresConfirmation: false,
          useMutationPipeline: true,
          ...(targetEntityId ? { targetEntityId } : {}),
          targetProposalId: proposalId,
          mutationInputSource: "recovered_proposal",
        };
      }

      return {
        action: "present_proposal",
        reason:
          "Confirmation language arrived but no recoverable proposal exists; present proposal now.",
        requiresWrite: true,
        requiresConfirmation: true,
        useMutationPipeline: false,
        clarificationSlots: [],
      };
    }
    case "clarification_answer":
    case "planning_request":
    case "edit_request":
      return buildPolicyFromStructuredReadiness(
        deriveStructuredWriteReadiness(input, ambiguity),
        targetEntityId,
      );
    case "unknown": {
      const isNonWrite =
        ambiguity === "none" &&
        !containsWriteVerb(input.routingContext.normalizedText);
      const clarificationSlots = Array.from(
        new Set([
          ...commitResult.missingFields,
          ...commitResult.needsClarification,
        ]),
      );
      return {
        action: isNonWrite ? "reply_only" : "ask_clarification",
        reason: isNonWrite
          ? "Unknown non-write text should stay in the conversation responder."
          : "Unknown turn meaning should prompt a clarification instead of guessing.",
        requiresWrite: false,
        requiresConfirmation: false,
        useMutationPipeline: false,
        clarificationSlots: isNonWrite
          ? undefined
          : clarificationSlots.length > 0
            ? clarificationSlots
            : undefined,
      };
    }
  }
}

function deriveStructuredWriteReadiness(
  input: DecideTurnPolicyInput,
  ambiguity: TurnAmbiguity,
): StructuredWriteReadiness {
  const { classification, commitResult } = input;
  const allClarificationSlots = Array.from(
    new Set([
      ...commitResult.missingFields,
      ...commitResult.needsClarification,
    ]),
  );

  if (ambiguity === "high") {
    return {
      state: "not_ready",
      reason:
        classification.turnType === "clarification_answer"
          ? "Clarification answer is still too ambiguous to safely continue."
          : "Write-like turn is too ambiguous to apply directly.",
      clarificationSlots: allClarificationSlots,
    };
  }

  if (allClarificationSlots.length > 0) {
    return {
      state: "not_ready",
      reason:
        classification.turnType === "clarification_answer"
          ? "Clarification answer is still missing required write details."
          : "Required scheduling or target details are still missing.",
      clarificationSlots: allClarificationSlots,
    };
  }

  if (classification.turnType === "clarification_answer") {
    const entityRegistry = input.routingContext.entityRegistry ?? [];
    const alreadyConfirmed = entityRegistry.some(
      (e) =>
        e.kind === "proposal_option" &&
        e.id === classification.resolvedProposalId &&
        e.status === "confirmed",
    );

    if (alreadyConfirmed) {
      return {
        state: "ready_for_execution",
        reason:
          "Clarification answer resolved the final detail and proposal was already confirmed.",
      };
    }
  }

  const consentRequirement = deriveConsentRequirement({
    classification,
    entityRegistry: input.routingContext.entityRegistry ?? [],
    resolvedFields: commitResult.resolvedFields,
  });

  if (consentRequirement.required) {
    return {
      state: "ready_needs_consent",
      reason: consentRequirement.reason,
      ...(consentRequirement.required &&
      "targetProposalId" in consentRequirement
        ? { targetProposalId: consentRequirement.targetProposalId }
        : {}),
    };
  }

  return {
    state: "ready_for_execution",
    reason:
      classification.turnType === "clarification_answer"
        ? "Clarification answer resolved the missing detail needed for the write path."
        : "Write-ready request can go straight to the mutation pipeline.",
  };
}

function resolveSingleActiveProposalId(
  registry: ConversationEntity[],
): string | undefined {
  const active = registry.filter(
    (e) =>
      e.kind === "proposal_option" &&
      (e.status === "active" || e.status === "presented"),
  );
  return active.length === 1 ? active[0]!.id : undefined;
}

function buildPolicyFromStructuredReadiness(
  readiness: StructuredWriteReadiness,
  targetEntityId: string | undefined,
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
      };
    case "ready_needs_consent":
      return {
        action: "present_proposal",
        reason: readiness.reason,
        requiresWrite: true,
        requiresConfirmation: true,
        useMutationPipeline: false,
        ...(targetEntityId ? { targetEntityId } : {}),
        ...(readiness.targetProposalId
          ? { targetProposalId: readiness.targetProposalId }
          : {}),
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
      };
  }
}
