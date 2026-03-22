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
      if (input.interpretation.ambiguity === "high") {
        return {
          action: "ask_clarification",
          reason: "Clarification answer is still too ambiguous to safely continue.",
          requiresWrite: false,
          requiresConfirmation: false,
          useMutationPipeline: false,
          clarificationSlots: input.interpretation.missingSlots ?? blockingSlots
        };
      }

      if (input.interpretation.resolvedProposalId) {
        return {
          action: "present_proposal",
          reason: "Clarification filled a pending proposal context but confirmation is still preferred.",
          requiresWrite: false,
          requiresConfirmation: true,
          useMutationPipeline: false,
          ...(targetEntityId ? { targetEntityId } : {}),
          targetProposalId: input.interpretation.resolvedProposalId,
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

      if (input.interpretation.confidence >= 0.85 && input.interpretation.ambiguity === "none") {
        return {
          action: "execute_mutation",
          reason: "Direct confident write intent can go straight to the mutation pipeline.",
          requiresWrite: true,
          requiresConfirmation: false,
          useMutationPipeline: true,
          ...(targetEntityId ? { targetEntityId } : {}),
          mutationInputSource: "direct_user_turn"
        };
      }

      return {
        action: "present_proposal",
        reason: "Write intent is present but should be proposed before applying it.",
        requiresWrite: false,
        requiresConfirmation: true,
        useMutationPipeline: false,
        ...(targetEntityId ? { targetEntityId } : {}),
        clarificationSlots: input.interpretation.missingSlots
      };
    case "unknown":
      return {
        action: "ask_clarification",
        reason: "Unknown turn meaning should prompt a clarification instead of guessing.",
        requiresWrite: false,
        requiresConfirmation: false,
        useMutationPipeline: false,
        clarificationSlots: input.interpretation.missingSlots ?? blockingSlots
      };
  }
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}
