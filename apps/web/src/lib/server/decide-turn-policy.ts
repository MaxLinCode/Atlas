import {
  createEmptyDiscourseState,
  getActivePendingClarifications,
  type TurnPolicyDecision,
  type TurnRoutingInput,
  type TurnInterpretation
} from "@atlas/core";

export type DecideTurnPolicyInput = {
  interpretation: TurnInterpretation;
  routingContext: TurnRoutingInput;
};

export function decideTurnPolicy(input: DecideTurnPolicyInput): TurnPolicyDecision {
  const discourseState = input.routingContext.discourseState ?? createEmptyDiscourseState();
  const activeClarifications = getActivePendingClarifications(discourseState);
  const blockingSlots = unique(
    activeClarifications.filter((clarification) => clarification.blocking).map((clarification) => clarification.slot)
  );
  const targetEntityId = input.interpretation.resolvedEntityIds[0];
  const confirmationRequired = doesTurnRequireProposal(input);

  switch (input.interpretation.turnType) {
    case "informational":
      return {
        action: "reply_only",
        reason: "Informational turn should stay in the conversation responder.",
        requiresWrite: false,
        requiresConfirmation: false,
        useMutationPipeline: false,
        ...(targetEntityId ? { targetEntityId } : {})
      };
    case "follow_up_reply":
      return {
        action: "reply_only",
        reason: "Follow-up style reply reached the normal router without a recoverable write plan.",
        requiresWrite: false,
        requiresConfirmation: false,
        useMutationPipeline: false,
        ...(targetEntityId ? { targetEntityId } : {})
      };
    case "confirmation":
      if (input.interpretation.resolvedProposalId) {
        return {
          action: "recover_and_execute",
          reason: "The turn confirms one recoverable pending proposal.",
          requiresWrite: true,
          requiresConfirmation: false,
          useMutationPipeline: true,
          ...(targetEntityId ? { targetEntityId } : {}),
          targetProposalId: input.interpretation.resolvedProposalId,
          mutationInputSource: "recovered_proposal"
        };
      }

      return {
        action: "ask_clarification",
        reason: "Confirmation language without one recoverable proposal should ask which proposal to apply.",
        requiresWrite: false,
        requiresConfirmation: false,
        useMutationPipeline: false,
        clarificationSlots: ["proposal"]
      };
    case "clarification_answer":
      if (
        input.interpretation.ambiguity === "high" ||
        (input.interpretation.missingSlots?.length ?? 0) > 0 ||
        blockingSlots.length > 0
      ) {
        return {
          action: "ask_clarification",
          reason: "Clarification answer is still too ambiguous to safely continue.",
          requiresWrite: false,
          requiresConfirmation: false,
          useMutationPipeline: false,
          clarificationSlots: input.interpretation.missingSlots ?? blockingSlots
        };
      }

      if (confirmationRequired) {
        return {
          action: "present_proposal",
          reason: "Clarification resolved the missing details, but explicit product policy still requires proposal-first confirmation.",
          requiresWrite: false,
          requiresConfirmation: true,
          useMutationPipeline: false,
          ...(targetEntityId ? { targetEntityId } : {}),
          ...(input.interpretation.resolvedProposalId ? { targetProposalId: input.interpretation.resolvedProposalId } : {}),
          clarificationSlots: input.interpretation.missingSlots
        };
      }

      return {
        action: "execute_mutation",
        reason: "Clarification answer resolves the missing detail needed for the write path.",
        requiresWrite: true,
        requiresConfirmation: false,
        useMutationPipeline: true,
        ...(targetEntityId ? { targetEntityId } : {}),
        mutationInputSource: "direct_user_turn"
      };
    case "planning_request":
    case "edit_request":
      if (input.interpretation.ambiguity === "high") {
        return {
          action: "ask_clarification",
          reason: "Write-like turn is too ambiguous to apply directly.",
          requiresWrite: false,
          requiresConfirmation: false,
          useMutationPipeline: false,
          ...(targetEntityId ? { targetEntityId } : {}),
          clarificationSlots: input.interpretation.missingSlots ?? blockingSlots
        };
      }

      if ((input.interpretation.missingSlots?.length ?? 0) > 0 || blockingSlots.length > 0) {
        return {
          action: "ask_clarification",
          reason: "Required scheduling or target details are still missing.",
          requiresWrite: false,
          requiresConfirmation: false,
          useMutationPipeline: false,
          ...(targetEntityId ? { targetEntityId } : {}),
          clarificationSlots: input.interpretation.missingSlots ?? blockingSlots
        };
      }

      if (confirmationRequired) {
        return {
          action: "present_proposal",
          reason: "Write request is ready, but explicit product policy requires proposal-first confirmation.",
          requiresWrite: false,
          requiresConfirmation: true,
          useMutationPipeline: false,
          ...(targetEntityId ? { targetEntityId } : {}),
          ...(input.interpretation.resolvedProposalId ? { targetProposalId: input.interpretation.resolvedProposalId } : {}),
          clarificationSlots: input.interpretation.missingSlots
        };
      }

      if (input.interpretation.ambiguity === "none") {
        return {
          action: "execute_mutation",
          reason: "Write-ready request can go straight to the mutation pipeline.",
          requiresWrite: true,
          requiresConfirmation: false,
          useMutationPipeline: true,
          ...(targetEntityId ? { targetEntityId } : {}),
          mutationInputSource: "direct_user_turn"
        };
      }

      return {
        action: "ask_clarification",
        reason: "Write intent is present but still needs clarification before applying it.",
        requiresWrite: false,
        requiresConfirmation: false,
        useMutationPipeline: false,
        ...(targetEntityId ? { targetEntityId } : {}),
        clarificationSlots: input.interpretation.missingSlots ?? blockingSlots
      };
    case "unknown":
      return {
        action:
          input.interpretation.ambiguity === "none" && !containsWriteVerb(input.routingContext.normalizedText)
            ? "reply_only"
            : "ask_clarification",
        reason:
          input.interpretation.ambiguity === "none" && !containsWriteVerb(input.routingContext.normalizedText)
            ? "Unknown non-write text should stay in the conversation responder."
            : "Unknown turn meaning should prompt a clarification instead of guessing.",
        requiresWrite: false,
        requiresConfirmation: false,
        useMutationPipeline: false,
        clarificationSlots:
          input.interpretation.ambiguity === "none" && !containsWriteVerb(input.routingContext.normalizedText)
            ? undefined
            : input.interpretation.missingSlots ?? blockingSlots
      };
  }
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function doesTurnRequireProposal(input: DecideTurnPolicyInput) {
  const activeProposal = (input.routingContext.entityRegistry ?? []).find(
    (entity) =>
      entity.kind === "proposal_option" &&
      entity.status === "active" &&
      entity.id === input.interpretation.resolvedProposalId &&
      entity.data.confirmationRequired === true
  );

  return Boolean(activeProposal);
}

function containsWriteVerb(text: string) {
  return /\b(schedule|plan|move|reschedule|shift|create|add|book|put|mark|complete|archive|cancel|delete|change|update)\b/i.test(
    text
  );
}
