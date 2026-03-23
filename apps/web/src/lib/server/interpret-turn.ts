import {
  createEmptyDiscourseState,
  getActivePendingClarifications,
  type TurnAmbiguity,
  type TurnInterpretation,
  type TurnRoutingInput
} from "@atlas/core";

import { classifyTurn } from "./llm-classifier";

export type InterpretTurnInput = TurnRoutingInput;

export async function interpretTurn(input: InterpretTurnInput): Promise<TurnInterpretation> {
  const parsedInput = parseInterpretTurnInput(input);
  const discourseState = parsedInput.discourseState ?? createEmptyDiscourseState();
  const activeClarifications = getActivePendingClarifications(discourseState);
  const blockingSlots = unique(
    activeClarifications.filter((c) => c.blocking).map((c) => c.slot)
  );

  const classification = await classifyTurn({
    normalizedText: parsedInput.normalizedText,
    discourseState,
    entityRegistry: parsedInput.entityRegistry
  });

  const ambiguity = deriveAmbiguityFromConfidence(classification.confidence, blockingSlots);

  return {
    turnType: classification.turnType,
    confidence: classification.confidence,
    resolvedEntityIds: classification.resolvedEntityIds,
    ...(classification.resolvedProposalId ? { resolvedProposalId: classification.resolvedProposalId } : {}),
    ambiguity,
    ...(ambiguity !== "none"
      ? { ambiguityReason: deriveAmbiguityReason(classification.turnType, ambiguity, blockingSlots) }
      : {}),
    ...(blockingSlots.length > 0 ? { missingSlots: blockingSlots } : {})
  };
}

function parseInterpretTurnInput(input: InterpretTurnInput): InterpretTurnInput {
  if (!input.rawText.trim() || !input.normalizedText.trim()) {
    throw new Error("Turn interpretation input must include non-empty rawText and normalizedText.");
  }

  return input;
}

function deriveAmbiguityFromConfidence(confidence: number, blockingSlots: string[]): TurnAmbiguity {
  if (blockingSlots.length > 0) return "high";
  if (confidence < 0.6) return "high";
  if (confidence < 0.8) return "low";
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
