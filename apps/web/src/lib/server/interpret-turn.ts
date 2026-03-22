import {
  createEmptyDiscourseState,
  getActivePendingClarifications,
  type ConversationEntity,
  type TurnInterpretation,
  type TurnRoutingInput,
  type TurnRoutingOutput
} from "@atlas/core";
import { routeTurnWithResponses } from "@atlas/integrations";

export type InterpretTurnInput = TurnRoutingInput;

export type InterpretTurnDependencies = {
  classifyTurn?: (input: InterpretTurnInput) => Promise<TurnRoutingOutput>;
};

export async function interpretTurn(
  input: InterpretTurnInput,
  dependencies: InterpretTurnDependencies = {}
): Promise<TurnInterpretation> {
  const parsedInput = parseInterpretTurnInput(input);
  const classifyTurn = dependencies.classifyTurn ?? routeTurnWithResponses;
  const legacyRoute = await classifyTurn(parsedInput);

  const discourseState = parsedInput.discourseState ?? createEmptyDiscourseState();
  const activeClarifications = getActivePendingClarifications(discourseState);
  const entityRegistry = parsedInput.entityRegistry ?? [];
  const activeProposals = entityRegistry.filter(
    (entity): entity is Extract<ConversationEntity, { kind: "proposal_option" }> =>
      entity.kind === "proposal_option" && entity.status === "active"
  );
  const normalizedText = parsedInput.normalizedText.trim();
  const lower = normalizedText.toLowerCase();
  const resolvedEntityIds = compactResolvedEntityIds([
    discourseState.currently_editable_entity_id,
    discourseState.focus_entity_id
  ]);
  const singleProposal = activeProposals.length === 1 ? activeProposals[0] : null;
  const missingSlots = unique(
    activeClarifications.filter((clarification) => clarification.blocking).map((clarification) => clarification.slot)
  );

  if (isConfirmationTurn(lower) && singleProposal) {
    return {
      turnType: "confirmation",
      confidence: legacyRoute.route === "confirmed_mutation" ? 0.98 : 0.9,
      resolvedEntityIds: singleProposal.data.targetEntityId ? [singleProposal.data.targetEntityId] : resolvedEntityIds,
      resolvedProposalId: singleProposal.id,
      ambiguity: "none",
      notes: buildLegacyRouteNotes(legacyRoute.route)
    };
  }

  if (isClarificationAnswer(lower, normalizedText, activeClarifications)) {
    return {
      turnType: "clarification_answer",
      confidence: 0.88,
      resolvedEntityIds,
      resolvedProposalId: singleProposal?.id,
      ambiguity: legacyRoute.route === "conversation_then_mutation" ? "low" : "none",
      ...(missingSlots.length > 0 ? { missingSlots } : {}),
      notes: buildLegacyRouteNotes(legacyRoute.route)
    };
  }

  if (legacyRoute.route === "confirmed_mutation") {
    return {
      turnType: activeProposals.length > 0 ? "confirmation" : "unknown",
      confidence: activeProposals.length > 0 ? 0.9 : 0.45,
      resolvedEntityIds,
      ...(singleProposal ? { resolvedProposalId: singleProposal.id } : {}),
      ambiguity: activeProposals.length > 0 ? "none" : "high",
      ...(activeProposals.length > 0
        ? {}
        : { ambiguityReason: "Confirmation-like turn arrived without one recoverable pending proposal." }),
      notes: buildLegacyRouteNotes(legacyRoute.route)
    };
  }

  if (isWriteIntentTurn(lower, legacyRoute.route)) {
    const turnType = isEditRequest(lower, normalizedText, discourseState, resolvedEntityIds) ? "edit_request" : "planning_request";
    const ambiguity = deriveWriteAmbiguity(normalizedText, legacyRoute.route, activeClarifications.length);

    return {
      turnType,
      confidence: confidenceFromLegacyRoute(legacyRoute.route),
      resolvedEntityIds,
      resolvedProposalId: singleProposal?.id,
      ambiguity: ambiguity.level,
      ...(ambiguity.reason ? { ambiguityReason: ambiguity.reason } : {}),
      ...(missingSlots.length > 0 ? { missingSlots } : {}),
      notes: buildLegacyRouteNotes(legacyRoute.route)
    };
  }

  if (isInformationalTurn(lower, legacyRoute.route)) {
    return {
      turnType: "informational",
      confidence: legacyRoute.route === "conversation" ? 0.92 : 0.72,
      resolvedEntityIds,
      ambiguity: "none",
      notes: buildLegacyRouteNotes(legacyRoute.route)
    };
  }

  if (looksLikeFollowUpReply(lower)) {
    return {
      turnType: "follow_up_reply",
      confidence: 0.7,
      resolvedEntityIds,
      ambiguity: "low",
      ambiguityReason: "Follow-up style reply reached normal turn routing.",
      notes: buildLegacyRouteNotes(legacyRoute.route)
    };
  }

  return {
    turnType: "unknown",
    confidence: legacyRoute.route === "conversation" ? 0.55 : 0.35,
    resolvedEntityIds,
    ambiguity: normalizedText.split(/\s+/).length <= 3 ? "high" : "low",
    ambiguityReason: "The turn did not map cleanly to an informational, edit, or write-intent pattern.",
    ...(missingSlots.length > 0 ? { missingSlots } : {}),
    notes: buildLegacyRouteNotes(legacyRoute.route)
  };
}

function parseInterpretTurnInput(input: InterpretTurnInput): InterpretTurnInput {
  if (!input.rawText.trim() || !input.normalizedText.trim()) {
    throw new Error("Turn interpretation input must include non-empty rawText and normalizedText.");
  }

  return input;
}

function compactResolvedEntityIds(entityIds: Array<string | null>) {
  return unique(entityIds.filter((entityId): entityId is string => Boolean(entityId)));
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function buildLegacyRouteNotes(route: TurnRoutingOutput["route"]) {
  return [`legacy_route:${route}`];
}

function confidenceFromLegacyRoute(route: TurnRoutingOutput["route"]) {
  switch (route) {
    case "mutation":
      return 0.95;
    case "conversation_then_mutation":
      return 0.68;
    case "conversation":
      return 0.62;
    case "confirmed_mutation":
      return 0.9;
  }
}

function isConfirmationTurn(lower: string) {
  return /^(yes|yeah|yep|ok|okay|do it|sounds good|works|that works|go ahead|please do|confirm)([.! ]*)?$/.test(
    lower
  );
}

function isClarificationAnswer(
  lower: string,
  normalizedText: string,
  activeClarifications: ReturnType<typeof getActivePendingClarifications>
) {
  if (activeClarifications.length === 0) {
    return false;
  }

  if (isConfirmationTurn(lower)) {
    return false;
  }

  if (normalizedText.endsWith("?")) {
    return false;
  }

  return normalizedText.split(/\s+/).length <= 6;
}

function isInformationalTurn(lower: string, legacyRoute: TurnRoutingOutput["route"]) {
  if (legacyRoute !== "conversation") {
    return false;
  }

  if (/^(what|when|where|why|how|who)\b/.test(lower)) {
    return true;
  }

  return lower.includes("?") && !isWriteIntentTurn(lower, legacyRoute);
}

function looksLikeFollowUpReply(lower: string) {
  if (lower.includes(" and ")) {
    return false;
  }

  if (/\b(schedule|plan|create|add|book)\b/.test(lower)) {
    return false;
  }

  return /^(?:\d+\s+)?(?:done|completed|finished|archive|drop|cancel|later|reschedule|move)(?:\s+\d+)?$/.test(
    lower.trim()
  );
}

function isWriteIntentTurn(lower: string, legacyRoute: TurnRoutingOutput["route"]) {
  if (legacyRoute === "mutation" || legacyRoute === "conversation_then_mutation") {
    return true;
  }

  return /\b(schedule|plan|move|reschedule|shift|create|add|book|put|mark|complete|archive|cancel|delete)\b/.test(
    lower
  );
}

function isEditRequest(
  lower: string,
  normalizedText: string,
  discourseState: ReturnType<typeof createEmptyDiscourseState>,
  resolvedEntityIds: string[]
) {
  if (resolvedEntityIds.length === 0) {
    return false;
  }

  if (/\b(move|reschedule|shift|push|pull|complete|archive|cancel|delete|update|change)\b/.test(lower)) {
    return true;
  }

  return /\b(it|that|this)\b/.test(lower) && normalizedText.split(/\s+/).length <= 8
    ? Boolean(discourseState.focus_entity_id || discourseState.currently_editable_entity_id)
    : false;
}

function deriveWriteAmbiguity(
  normalizedText: string,
  legacyRoute: TurnRoutingOutput["route"],
  activeClarificationCount: number
) {
  if (activeClarificationCount > 0) {
    return {
      level: "high" as const,
      reason: "A blocking clarification is already pending."
    };
  }

  if (legacyRoute === "conversation_then_mutation") {
    return {
      level: "low" as const,
      reason: "The turn looks write-oriented but still needs discussion or confirmation."
    };
  }

  if (legacyRoute === "mutation") {
    return {
      level: "none" as const
    };
  }

  if (normalizedText.split(/\s+/).length <= 3) {
    return {
      level: "high" as const,
      reason: "The write-like turn is very short and underspecified."
    };
  }

  return {
    level: "none" as const
  };
}
