import {
  createEmptyDiscourseState,
  getActivePendingClarifications,
  type ConversationEntity,
  type TurnInterpretation,
  type TurnRoutingInput
} from "@atlas/core";

export type InterpretTurnInput = TurnRoutingInput;

export async function interpretTurn(input: InterpretTurnInput): Promise<TurnInterpretation> {
  const parsedInput = parseInterpretTurnInput(input);
  const discourseState = parsedInput.discourseState ?? createEmptyDiscourseState();
  const activeClarifications = getActivePendingClarifications(discourseState);
  const entityRegistry = parsedInput.entityRegistry ?? [];
  const activeProposals = entityRegistry.filter(
    (entity): entity is Extract<ConversationEntity, { kind: "proposal_option" }> =>
      entity.kind === "proposal_option" && entity.status === "active"
  );
  const normalizedText = parsedInput.normalizedText.trim();
  const lower = normalizedText.toLowerCase();
  const tokenCount = normalizedText.split(/\s+/).length;
  const resolvedEntityIds = compactResolvedEntityIds([
    discourseState.currently_editable_entity_id,
    discourseState.focus_entity_id
  ]);
  const blockingSlots = unique(
    activeClarifications.filter((clarification) => clarification.blocking).map((clarification) => clarification.slot)
  );
  const singleProposal = activeProposals.length === 1 ? activeProposals[0] : null;
  const confirmationLike = isConfirmationTurn(lower);
  const clarificationLike = isClarificationAnswer(lower, normalizedText, activeClarifications);
  const writeSignals = analyzeWriteSignals(lower, normalizedText, resolvedEntityIds);

  if (confirmationLike) {
    if (singleProposal) {
      return {
        turnType: "confirmation",
        confidence: 0.97,
        resolvedEntityIds: singleProposal.data.targetEntityId
          ? [singleProposal.data.targetEntityId]
          : resolvedEntityIds,
        resolvedProposalId: singleProposal.id,
        ambiguity: "none"
      };
    }

    return {
      turnType: "unknown",
      confidence: activeProposals.length > 1 ? 0.36 : 0.32,
      resolvedEntityIds,
      ambiguity: "high",
      ambiguityReason:
        activeProposals.length > 1
          ? "Confirmation-like text matches multiple recoverable proposals."
          : "Confirmation-like text arrived without one recoverable proposal."
    };
  }

  if (clarificationLike) {
    const ambiguity = blockingSlots.length > 0 ? "high" : "none";

    return {
      turnType: "clarification_answer",
      confidence: tokenCount <= 3 ? 0.91 : 0.84,
      resolvedEntityIds,
      ...(singleProposal ? { resolvedProposalId: singleProposal.id } : {}),
      ambiguity,
      ...(ambiguity === "high"
        ? { ambiguityReason: "Blocking clarification slots are still open." }
        : {}),
      ...(blockingSlots.length > 0 ? { missingSlots: blockingSlots } : {})
    };
  }

  if (writeSignals.isWriteIntent) {
    const turnType = isEditRequest(lower, normalizedText, discourseState, resolvedEntityIds)
      ? "edit_request"
      : "planning_request";
    const missingSlots = deriveMissingSlots({
      turnType,
      writeSignals,
      resolvedEntityIds,
      blockingSlots
    });
    const ambiguity = deriveWriteAmbiguity({
      normalizedText,
      resolvedEntityIds,
      activeProposals,
      blockingSlots,
      writeSignals,
      missingSlots
    });

    return {
      turnType,
      confidence: deriveWriteConfidence({
        turnType,
        ambiguity: ambiguity.level,
        missingSlots,
        writeSignals,
        resolvedEntityIds,
        hasSingleProposal: Boolean(singleProposal)
      }),
      resolvedEntityIds,
      ...(singleProposal ? { resolvedProposalId: singleProposal.id } : {}),
      ambiguity: ambiguity.level,
      ...(ambiguity.reason ? { ambiguityReason: ambiguity.reason } : {}),
      ...(missingSlots.length > 0 ? { missingSlots } : {})
    };
  }

  if (isInformationalTurn(lower)) {
    return {
      turnType: "informational",
      confidence: normalizedText.includes("?") ? 0.93 : 0.82,
      resolvedEntityIds,
      ambiguity: "none"
    };
  }

  if (looksLikeFollowUpReply(lower)) {
    return {
      turnType: "follow_up_reply",
      confidence: 0.72,
      resolvedEntityIds,
      ambiguity: "low",
      ambiguityReason: "Follow-up style reply reached normal turn routing."
    };
  }

  return {
    turnType: "unknown",
    confidence: tokenCount <= 3 ? 0.3 : 0.42,
    resolvedEntityIds,
    ambiguity: tokenCount <= 3 || blockingSlots.length > 0 ? "high" : "low",
    ambiguityReason: "The turn did not map cleanly to an informational, edit, or write-intent pattern.",
    ...(blockingSlots.length > 0 ? { missingSlots: blockingSlots } : {})
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

  if (isConfirmationTurn(lower) || normalizedText.endsWith("?")) {
    return false;
  }

  return normalizedText.split(/\s+/).length <= 6;
}

function isInformationalTurn(lower: string) {
  if (/^(what|when|where|why|how|who|which|can you explain|tell me)\b/.test(lower)) {
    return true;
  }

  if (!lower.includes("?")) {
    return false;
  }

  return !containsWriteVerb(lower);
}

function looksLikeFollowUpReply(lower: string) {
  if (lower.includes(" and ") || containsWriteVerb(lower)) {
    return false;
  }

  return /^(?:\d+\s+)?(?:done|completed|finished|archive|drop|cancel|later|reschedule|move)(?:\s+\d+)?$/.test(
    lower.trim()
  );
}

function containsWriteVerb(lower: string) {
  return /\b(schedule|plan|move|reschedule|shift|create|add|book|put|mark|complete|archive|cancel|delete|change|update)\b/.test(
    lower
  );
}

function analyzeWriteSignals(lower: string, normalizedText: string, resolvedEntityIds: string[]) {
  const hasSchedulingVerb = /\b(schedule|plan|create|add|book|put)\b/.test(lower);
  const hasEditVerb = /\b(move|reschedule|shift|push|pull|complete|archive|cancel|delete|update|change|mark)\b/.test(
    lower
  );
  const hasWriteVerb = hasSchedulingVerb || hasEditVerb;
  const hasQuestionLead = /^(can|could|would|should|will)\b/.test(lower);
  const referencesFocusedEntity =
    /\b(it|that|this)\b/.test(lower) && (resolvedEntityIds.length > 0 || /\b(move|reschedule|shift|update|change)\b/.test(lower));
  const hasDayReference = /\b(today|tonight|tomorrow|tmr|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|next week|next month|next|this morning|this afternoon|this evening|morning|afternoon|evening)\b/.test(
    lower
  );
  const hasClockTime = /\b\d{1,2}(?::\d{2})?\s?(am|pm)\b|\bnoon\b|\bmidnight\b/.test(lower);
  const hasDuration = /\bfor\s+\d+\s*(minutes?|mins?|hours?|hrs?)\b|\b\d+\s*(minutes?|mins?|hours?|hrs?)\b/.test(lower);
  const temporalDetailCount = Number(hasDayReference) + Number(hasClockTime) + Number(hasDuration);
  const tokenCount = normalizedText.split(/\s+/).length;
  const contentTokens = normalizedText
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => !STOPWORDS.has(token.replace(/[^\w:]/g, "")));
  const hasConcreteSubject = referencesFocusedEntity || contentTokens.length >= 2;
  const hasTaskCaptureFragment =
    !hasWriteVerb &&
    !normalizedText.endsWith("?") &&
    !/^(what|when|where|why|how|who|which|can|could|would|should)\b/.test(lower) &&
    tokenCount >= 2 &&
    tokenCount <= 8 &&
    hasConcreteSubject;

  return {
    isWriteIntent: hasWriteVerb || referencesFocusedEntity || hasTaskCaptureFragment,
    hasSchedulingVerb,
    hasEditVerb,
    hasTaskCaptureFragment,
    referencesFocusedEntity,
    hasDayReference,
    hasClockTime,
    hasDuration,
    hasConcreteSubject,
    temporalDetailCount,
    usesExploratoryQuestionLead: hasQuestionLead && normalizedText.endsWith("?")
  };
}

function isEditRequest(
  lower: string,
  normalizedText: string,
  discourseState: ReturnType<typeof createEmptyDiscourseState>,
  resolvedEntityIds: string[]
) {
  if (resolvedEntityIds.length > 0 && /\b(move|reschedule|shift|push|pull|complete|archive|cancel|delete|update|change|mark)\b/.test(lower)) {
    return true;
  }

  return /\b(it|that|this)\b/.test(lower) && normalizedText.split(/\s+/).length <= 8
    ? Boolean(discourseState.focus_entity_id || discourseState.currently_editable_entity_id)
    : false;
}

function deriveMissingSlots(input: {
  turnType: TurnInterpretation["turnType"];
  writeSignals: ReturnType<typeof analyzeWriteSignals>;
  resolvedEntityIds: string[];
  blockingSlots: string[];
}) {
  const missingSlots = [...input.blockingSlots];

  if (input.turnType === "planning_request" && input.writeSignals.hasSchedulingVerb) {
    if (!input.writeSignals.hasConcreteSubject) {
      missingSlots.push("target");
    }

    if (!input.writeSignals.hasDayReference) {
      missingSlots.push("day");
    }

    if (!input.writeSignals.hasClockTime) {
      missingSlots.push("time");
    }
  }

  if (input.turnType === "edit_request") {
    if (input.resolvedEntityIds.length === 0 && input.writeSignals.referencesFocusedEntity) {
      missingSlots.push("target");
    }

    if (!input.writeSignals.hasDayReference && !input.writeSignals.hasClockTime && !input.writeSignals.hasDuration) {
      missingSlots.push("time");
    }
  }

  return unique(missingSlots);
}

function deriveWriteAmbiguity(input: {
  normalizedText: string;
  resolvedEntityIds: string[];
  activeProposals: Array<Extract<ConversationEntity, { kind: "proposal_option" }>>;
  blockingSlots: string[];
  writeSignals: ReturnType<typeof analyzeWriteSignals>;
  missingSlots: string[];
}) {
  if (input.blockingSlots.length > 0) {
    return {
      level: "high" as const,
      reason: "A blocking clarification is already pending."
    };
  }

  if (input.writeSignals.referencesFocusedEntity && input.resolvedEntityIds.length === 0) {
    return {
      level: "high" as const,
      reason: "The request refers to an entity that is not uniquely resolved in state."
    };
  }

  if (input.missingSlots.length > 0) {
    return {
      level: "high" as const,
      reason: "Required write details are still missing."
    };
  }

  if (input.activeProposals.length > 1 && /^(it|that|this)\b/.test(input.normalizedText.toLowerCase())) {
    return {
      level: "high" as const,
      reason: "Multiple active proposals make the target ambiguous."
    };
  }

  if (
    input.normalizedText.split(/\s+/).length <= 3 &&
    input.writeSignals.temporalDetailCount === 0 &&
    !input.writeSignals.hasTaskCaptureFragment
  ) {
    return {
      level: "high" as const,
      reason: "Very short write-like request is underspecified."
    };
  }

  if (input.writeSignals.usesExploratoryQuestionLead) {
    return {
      level: "low" as const,
      reason: "The request is action-oriented but phrased as a tentative question."
    };
  }

  return {
    level: "none" as const,
    reason: undefined
  };
}

function deriveWriteConfidence(input: {
  turnType: TurnInterpretation["turnType"];
  ambiguity: TurnInterpretation["ambiguity"];
  missingSlots: string[];
  writeSignals: ReturnType<typeof analyzeWriteSignals>;
  resolvedEntityIds: string[];
  hasSingleProposal: boolean;
}) {
  let confidence = input.turnType === "edit_request" ? 0.82 : 0.8;

  if (input.writeSignals.hasSchedulingVerb || input.writeSignals.hasEditVerb) {
    confidence += 0.08;
  }

  if (input.writeSignals.hasTaskCaptureFragment) {
    confidence += 0.05;
  }

  if (input.writeSignals.hasConcreteSubject) {
    confidence += 0.04;
  }

  if (input.writeSignals.hasDayReference) {
    confidence += 0.05;
  }

  if (input.writeSignals.hasClockTime) {
    confidence += 0.07;
  }

  if (input.writeSignals.hasDuration) {
    confidence += 0.03;
  }

  if (input.resolvedEntityIds.length === 1 || input.hasSingleProposal) {
    confidence += 0.04;
  }

  if (input.writeSignals.usesExploratoryQuestionLead) {
    confidence -= 0.08;
  }

  if (input.missingSlots.length > 0) {
    confidence -= 0.22;
  }

  if (input.ambiguity === "low") {
    confidence -= 0.1;
  }

  if (input.ambiguity === "high") {
    confidence -= 0.28;
  }

  return Math.max(0.05, Math.min(0.99, Number(confidence.toFixed(2))));
}

const STOPWORDS = new Set([
  "a",
  "an",
  "at",
  "book",
  "by",
  "change",
  "complete",
  "create",
  "delete",
  "for",
  "friday",
  "hour",
  "hours",
  "i",
  "it",
  "mark",
  "me",
  "move",
  "my",
  "next",
  "on",
  "pm",
  "please",
  "put",
  "reschedule",
  "schedule",
  "shift",
  "that",
  "the",
  "this",
  "to",
  "tomorrow",
  "update"
]);
