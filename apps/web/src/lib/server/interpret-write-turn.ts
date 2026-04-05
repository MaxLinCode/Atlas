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
      console.error("interpret_write_turn_parse_failed", {
        zodError: parsed.error.format(),
        rawOutput: raw,
      });
      return fallbackInterpretation(input);
    }

    return normalizeRawWriteInterpretation(parsed.data, input.currentTurnText);
  } catch (err) {
    console.error("interpret_write_turn_error", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
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
