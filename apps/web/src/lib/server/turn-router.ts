import {
  applyCommitPolicy,
  createEmptyDiscourseState,
  getActivePendingClarifications,
  routedTurnSchema,
  type ConversationTurn,
  type DiscourseState,
  type RoutedTurn,
  type SlotKey,
  type TurnAmbiguity,
  type TurnClassifierOutput,
  type TurnInterpretation,
  type TurnPolicyAction,
  type TurnRoute,
  type TurnRoutingInput,
  type WriteContract,
  type CommitPolicyOutput
} from "@atlas/core";

import { decideTurnPolicy } from "./decide-turn-policy";
import { classifyTurn } from "./llm-classifier";
import { extractSlots } from "./slot-extractor";

export type TurnRouterInput = TurnRoutingInput;
export type TurnRouterResult = RoutedTurn;

const SLOT_COMMITTING_TURN_TYPES = new Set([
  "clarification_answer",
  "planning_request",
  "edit_request"
]);

const DEFAULT_CONTRACT: WriteContract = {
  requiredSlots: [],
  intentKind: "plan"
};

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
  const activeContract = discourseState.pending_write_contract ?? DEFAULT_CONTRACT;
  let slotExtraction = null;

  if (
    SLOT_COMMITTING_TURN_TYPES.has(classification.turnType) &&
    discourseState.pending_write_contract
  ) {
    slotExtraction = await extractSlots({
      currentTurnText: input.normalizedText,
      pendingSlots: derivePendingSlots(discourseState),
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
    activeContract
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
    policy
  });
}

function derivePendingSlots(discourseState: DiscourseState): SlotKey[] {
  const contract = discourseState.pending_write_contract;
  if (!contract) return [];
  const resolved = discourseState.resolved_slots ?? {};
  return contract.requiredSlots.filter((slot) => resolved[slot] === undefined);
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
  const ambiguity = deriveAmbiguity(classification, commitResult, blockingSlots);

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

function deriveAmbiguity(
  classification: TurnClassifierOutput,
  commitResult: CommitPolicyOutput,
  blockingSlots: string[]
): TurnAmbiguity {
  if (blockingSlots.length > 0) return "high";
  if (classification.confidence < 0.6) return "high";
  if (commitResult.missingSlots.length > 0) return "high";
  if (commitResult.needsClarification.length > 0) return "high";
  if (classification.confidence < 0.8) return "low";
  return "none";
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
