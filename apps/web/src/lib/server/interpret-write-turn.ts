import {
  normalizeRawWriteInterpretation,
  rawWriteInterpretationSchema,
  type WriteInterpretation,
  type WriteInterpretationInput,
} from "@atlas/core";
import {
  interpretWriteTurnWithResponses,
  type OpenAIResponsesClient,
} from "@atlas/integrations";

export async function interpretWriteTurn(
  input: WriteInterpretationInput,
  client?: OpenAIResponsesClient,
): Promise<WriteInterpretation> {
  try {
    const raw = await interpretWriteTurnWithResponses(input, client);
    const parsed = rawWriteInterpretationSchema.safeParse(raw);

    if (!parsed.success) {
      return fallbackInterpretation(input);
    }

    return normalizeRawWriteInterpretation(parsed.data, input.currentTurnText);
  } catch {
    return fallbackInterpretation(input);
  }
}

function fallbackInterpretation(
  input: WriteInterpretationInput,
): WriteInterpretation {
  return {
    operationKind:
      input.priorPendingWriteOperation?.operationKind ?? inferFallbackOperation(input.turnType),
    actionDomain: "task",
    targetRef: input.priorPendingWriteOperation?.targetRef ?? null,
    taskName: null,
    fields: {},
    sourceText: input.currentTurnText,
    confidence: {},
    unresolvedFields: [],
  };
}

function inferFallbackOperation(turnType: WriteInterpretationInput["turnType"]) {
  switch (turnType) {
    case "edit_request":
      return "edit" as const;
    case "clarification_answer":
    case "planning_request":
    default:
      return "plan" as const;
  }
}
