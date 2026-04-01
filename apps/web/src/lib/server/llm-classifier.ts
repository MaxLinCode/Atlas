import {
  type ConversationEntity,
  type TurnClassifierInput,
  type TurnClassifierOutput,
} from "@atlas/core";
import {
  classifyTurnWithResponses,
  type OpenAIResponsesClient,
} from "@atlas/integrations";

export async function classifyTurn(
  input: TurnClassifierInput,
  client?: OpenAIResponsesClient,
): Promise<TurnClassifierOutput> {
  const entityRegistry = input.entityRegistry ?? [];
  const normalizedText = input.normalizedText.trim();
  const lower = normalizedText.toLowerCase();

  const activeProposals = entityRegistry.filter(
    (
      entity,
    ): entity is Extract<ConversationEntity, { kind: "proposal_option" }> =>
      entity.kind === "proposal_option" &&
      (entity.status === "active" || entity.status === "presented"),
  );

  const singleProposal =
    activeProposals.length === 1 ? activeProposals[0] : null;

  // Fast-exit confirmation: exact match + exactly one active/presented proposal
  if (isPureConfirmationTurn(lower) && singleProposal) {
    return {
      turnType: "confirmation",
      confidence: 0.97,
    };
  }

  // Everything else → LLM
  try {
    const llmResponse = await classifyTurnWithResponses(input, client);

    return {
      turnType: llmResponse.turnType,
      confidence: Math.max(0, Math.min(1, llmResponse.confidence)),
    };
  } catch {
    // Degrade gracefully: return unknown with low confidence
    return {
      turnType: "unknown",
      confidence: 0.3,
    };
  }
}

function isPureConfirmationTurn(lower: string) {
  return /^(ok|okay|yes|yep|yeah|confirm|do it|go ahead)([.,!? ]*)?$/.test(
    lower,
  );
}

