import {
  applyCommitPolicy,
  createEmptyDiscourseState,
  getActivePendingClarifications,
  routedTurnSchema,
  type ConversationTurn,
  type DiscourseState,
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
  const classification = await classifyTurn({
    normalizedText: input.normalizedText,
    discourseState,
    entityRegistry
  });

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
  const interpretation = buildInterpretation(classification, commitResult, discourseState);

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
  commitResult: CommitPolicyOutput,
  discourseState: DiscourseState
): TurnInterpretation {
  const blockingSlots = getActivePendingClarifications(discourseState)
    .filter((c) => c.blocking)
    .map((c) => c.slot);
  const allMissingSlots = unique([
    ...commitResult.missingSlots,
    ...commitResult.needsClarification,
    ...blockingSlots
  ]);
  const ambiguity = deriveAmbiguity({
    classifierConfidence: classification.confidence,
    missingSlots: commitResult.missingSlots,
    needsClarification: commitResult.needsClarification,
    blockingSlots
  });

  return {
    turnType: classification.turnType,
    confidence: classification.confidence,
    resolvedEntityIds: classification.resolvedEntityIds,
    ...(classification.resolvedProposalId ? { resolvedProposalId: classification.resolvedProposalId } : {}),
    ambiguity,
    ...(ambiguity !== "none"
      ? { ambiguityReason: deriveAmbiguityReason(classification.turnType, ambiguity, blockingSlots) }
      : {}),
    ...(allMissingSlots.length > 0 ? { missingSlots: allMissingSlots } : {})
  };
}

function deriveAmbiguityReason(
  turnType: TurnInterpretation["turnType"],
  ambiguity: TurnAmbiguity,
  blockingSlots: string[]
): string {
  if (blockingSlots.length > 0) {
    return "Blocking clarification slots are still open.";
  }

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
