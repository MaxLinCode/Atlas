import {
  applyCommitPolicy,
  createEmptyDiscourseState,
  routedTurnSchema,
  type ConversationEntity,
  type ConversationTurn,
  type RoutedTurn,
  type SlotKey,
  deriveAmbiguity,
  type TurnAmbiguity,
  type TurnClassifierOutput,
  type TurnInterpretation,
  type TurnPolicyAction,
  type TurnRoute,
  type TurnRoutingInput,
  type WriteContract,
  type CommitPolicyOutput,
  SLOT_COMMITTING_TURN_TYPES,
  DEFAULT_WRITE_CONTRACT,
  resolveWriteContract
} from "@atlas/core";

import { decideTurnPolicy } from "./decide-turn-policy";
import { classifyTurn } from "./llm-classifier";
import { extractSlots } from "./slot-extractor";

export type TurnRouterInput = TurnRoutingInput;
export type TurnRouterResult = RoutedTurn;


export async function routeMessageTurn(input: TurnRouterInput): Promise<TurnRouterResult> {
  const discourseState = input.discourseState ?? createEmptyDiscourseState();
  const entityRegistry = input.entityRegistry ?? [];

  // Pipeline A: classify intent
  let classification = await classifyTurn({
    normalizedText: input.normalizedText,
    discourseState,
    entityRegistry
  });

  // Guard: reclassify compound confirmations (confirmation + modification payload)
  // so slot extraction runs and the edit is not silently dropped.
  // Scoped to active write/proposal context only.
  if (classification.turnType === "confirmation") {
    const hasActiveProposal = entityRegistry.some(
      (e: ConversationEntity) =>
        e.kind === "proposal_option" &&
        (e.status === "active" || e.status === "presented")
    );

    if (hasActiveProposal && containsModificationPayload(input.normalizedText)) {
      classification = {
        ...classification,
        turnType: "clarification_answer",
        resolvedProposalId: undefined
      };
    }
  }

  // Pipeline B: extract slots (conditional)
  const priorContract = discourseState.pending_write_contract;
  const activeContract = resolveWriteContract({
    turnType: classification.turnType,
    priorContract
  }) ?? DEFAULT_WRITE_CONTRACT;
  let slotExtraction = null;

  if (SLOT_COMMITTING_TURN_TYPES.has(classification.turnType)) {
    slotExtraction = await extractSlots({
      currentTurnText: input.normalizedText,
      pendingSlots: derivePendingSlots(activeContract, discourseState.resolved_slots ?? {}),
      priorResolvedSlots: discourseState.resolved_slots ?? {},
      conversationContext: deriveConversationContext(input.recentTurns)
    });
  }

  // Policy layer: commit + route
  const commitResult = applyCommitPolicy({
    turnType: classification.turnType,
    extractedValues: slotExtraction?.extractedValues ?? {},
    confidence: compactConfidence(slotExtraction?.confidence ?? {}),
    unresolvable: slotExtraction?.unresolvable ?? [],
    priorResolvedSlots: discourseState.resolved_slots ?? {},
    activeContract,
    priorContract
  });

  const policy = decideTurnPolicy({
    classification,
    commitResult,
    routingContext: input
  });

  // Build interpretation for backward compatibility
  const interpretation = buildInterpretation(classification, commitResult);

  return routedTurnSchema.parse({
    interpretation,
    policy: { ...policy, resolvedContract: activeContract }
  });
}

function derivePendingSlots(contract: WriteContract, resolvedSlots: Record<string, unknown>): SlotKey[] {
  return contract.requiredSlots.filter((slot) => resolvedSlots[slot] === undefined);
}

function deriveConversationContext(recentTurns: ConversationTurn[]): string {
  return recentTurns
    .slice(-5)
    .map((t) => `${t.role}: ${t.text}`)
    .join("\n");
}

function buildInterpretation(
  classification: TurnClassifierOutput,
  commitResult: CommitPolicyOutput
): TurnInterpretation {
  const allMissingSlots = unique([
    ...commitResult.missingSlots,
    ...commitResult.needsClarification
  ]);
  const ambiguity = deriveAmbiguity({
    classifierConfidence: classification.confidence,
    missingSlots: commitResult.missingSlots,
    needsClarification: commitResult.needsClarification
  });

  return {
    turnType: classification.turnType,
    confidence: classification.confidence,
    resolvedEntityIds: classification.resolvedEntityIds,
    ...(classification.resolvedProposalId ? { resolvedProposalId: classification.resolvedProposalId } : {}),
    ambiguity,
    ...(ambiguity !== "none"
      ? { ambiguityReason: deriveAmbiguityReason(classification.turnType, ambiguity) }
      : {}),
    ...(allMissingSlots.length > 0 ? { missingSlots: allMissingSlots } : {})
  };
}

function deriveAmbiguityReason(
  turnType: TurnInterpretation["turnType"],
  ambiguity: TurnAmbiguity
): string {
  if (ambiguity === "high") {
    switch (turnType) {
      case "unknown":
        return "The turn did not map cleanly to a recognized intent pattern.";
      case "clarification_answer":
        return "Clarification answer classification has low confidence.";
      default:
        return "Classification confidence is too low for reliable routing.";
    }
  }

  return "Classification confidence is moderate.";
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function compactConfidence(
  confidence: Record<string, number | null | undefined>
): Partial<Record<SlotKey, number>> {
  const result: Partial<Record<SlotKey, number>> = {};
  for (const [key, value] of Object.entries(confidence)) {
    if (typeof value === "number") {
      result[key as SlotKey] = value;
    }
  }
  return result;
}

export function doesPolicyAllowWrites(action: TurnPolicyAction) {
  return action === "execute_mutation" || action === "recover_and_execute";
}

export function getConversationRouteForPolicy(action: TurnPolicyAction): Extract<
  TurnRoute,
  "conversation" | "conversation_then_mutation"
> {
  return action === "reply_only" ? "conversation" : "conversation_then_mutation";
}

export function containsModificationPayload(text: string): boolean {
  const lower = text.toLowerCase();
  // Time patterns: "5pm", "17:00", "at 3"
  if (/\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)/i.test(lower)) return true;
  if (/\d{1,2}:\d{2}/.test(lower)) return true;
  if (/\bat\s+\d{1,2}\b/.test(lower)) return true;
  // Day patterns: "tomorrow", "friday", "next week"
  if (/\b(tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+\w+)\b/.test(lower)) return true;
  // Duration: "for 1 hour", "30 minutes"
  if (/\b\d+\s*(hour|minute|min|hr)s?\b/.test(lower)) return true;
  // Modification signals: "but", "change", "make it", "instead", "actually"
  if (/\b(but|change|make it|instead|switch|rather|actually|different)\b/.test(lower)) return true;
  return false;
}
