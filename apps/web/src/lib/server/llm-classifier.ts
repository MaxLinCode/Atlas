import {
  type ConversationEntity,
  getActivePendingClarifications,
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
  const discourseState = input.discourseState ?? null;
  const normalizedText = input.normalizedText.trim();
  const lower = normalizedText.toLowerCase();

  const activeProposals = entityRegistry.filter(
    (
      entity,
    ): entity is Extract<ConversationEntity, { kind: "proposal_option" }> =>
      entity.kind === "proposal_option" &&
      (entity.status === "active" || entity.status === "presented"),
  );

  const resolvedEntityIds = compactResolvedEntityIds([
    discourseState?.currently_editable_entity_id ?? null,
    discourseState?.focus_entity_id ?? null,
  ]);

  const singleProposal =
    activeProposals.length === 1 ? activeProposals[0] : null;

  // Fast-exit confirmation: exact match + exactly one active/presented proposal
  if (isPureConfirmationTurn(lower) && singleProposal) {
    return {
      turnType: "confirmation",
      confidence: 0.97,
      resolvedEntityIds: singleProposal.data.targetEntityId
        ? [singleProposal.data.targetEntityId]
        : resolvedEntityIds,
      resolvedProposalId: singleProposal.id,
    };
  }

  // TEMP: disabled informational fast-exit until routing stabilizes
  // Fast-exit informational: question lead + no write verbs + no active clarifications
  // const activeClarifications = discourseState
  //   ? getActivePendingClarifications(discourseState)
  //   : [];

  // if (isInformationalTurn(lower) && activeClarifications.length === 0 && !containsWriteVerb(lower)) {
  //   return {
  //     turnType: "informational",
  //     confidence: 0.93,
  //     resolvedEntityIds
  //   };
  // }

  // Everything else → LLM
  try {
    const llmResponse = await classifyTurnWithResponses(input, client);

    return {
      turnType: llmResponse.turnType,
      confidence: Math.max(0, Math.min(1, llmResponse.confidence)),
      resolvedEntityIds,
      ...(singleProposal ? { resolvedProposalId: singleProposal.id } : {}),
    };
  } catch {
    // Degrade gracefully: return unknown with low confidence
    return {
      turnType: "unknown",
      confidence: 0.3,
      resolvedEntityIds,
    };
  }
}

function isPureConfirmationTurn(lower: string) {
  return /^(ok|okay|yes|yep|yeah|confirm|do it|go ahead)([.,!? ]*)?$/.test(
    lower,
  );
}

function isInformationalTurn(lower: string) {
  return /^(what|when|where|why|how|who|which|can you explain|tell me)\b/.test(
    lower,
  );
}

function containsWriteVerb(lower: string) {
  return /\b(schedule|plan|move|reschedule|shift|create|add|book|put|mark|complete|archive|cancel|delete|change|update)\b/.test(
    lower,
  );
}

function compactResolvedEntityIds(entityIds: Array<string | null>) {
  return Array.from(
    new Set(entityIds.filter((id): id is string => Boolean(id))),
  );
}
