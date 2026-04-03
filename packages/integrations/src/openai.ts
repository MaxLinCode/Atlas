import {
  type ConfirmedMutationRecoveryInput,
  type ConfirmedMutationRecoveryOutput,
  type RawWriteInterpretation,
  confirmedMutationRecoveryInputSchema,
  confirmedMutationRecoveryOutputSchema,
  confirmedMutationRecoveryResponseFormatSchema,
  conversationDiscourseStateSchema,
  conversationEntitySchema,
  conversationTurnSchema,
  getConfig,
  inboxPlanningContextSchema,
  inboxPlanningOutputSchema,
  inboxPlanningResponseFormatSchema,
  type RawSlotExtraction,
  rawSlotExtractionSchema,
  rawWriteInterpretationSchema,
  type SlotExtractorInput,
  slotExtractorInputSchema,
  type TurnClassifierInput,
  type TurnClassifierResponse,
  type TurnRoutingInput,
  type TurnRoutingOutput,
  turnClassifierInputSchema,
  turnClassifierResponseSchema,
  turnRoutingInputSchema,
  turnRoutingOutputSchema,
  type WriteInterpretationInput,
  writeInterpretationInputSchema,
} from "@atlas/core";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { confirmedMutationRecoverySystemPrompt } from "./prompts/confirmed-mutation-recovery";
import { conversationMemorySummarySystemPrompt } from "./prompts/conversation-memory-summary";
import { conversationResponseSystemPrompt } from "./prompts/conversation-response";
import { interpretWriteTurnSystemPrompt } from "./prompts/interpret-write-turn";
import { inboxPlannerSystemPrompt } from "./prompts/planner";
import { slotExtractorSystemPrompt } from "./prompts/slot-extractor";
import { turnClassifierSystemPrompt } from "./prompts/turn-classifier";
import { turnRouterSystemPrompt } from "./prompts/turn-router";

export const DEFAULT_INBOX_PLANNER_MODEL = "gpt-4o-mini";
export const DEFAULT_TURN_ROUTER_MODEL = "gpt-4o-mini";
export const DEFAULT_CONVERSATION_RESPONSE_MODEL = "gpt-4o-mini";
export const DEFAULT_CONVERSATION_MEMORY_SUMMARY_MODEL = "gpt-4o-mini";
export const DEFAULT_CONFIRMED_MUTATION_RECOVERY_MODEL = "gpt-4o-mini";
export const DEFAULT_SLOT_EXTRACTOR_MODEL = "gpt-4o-mini";
export const DEFAULT_TURN_CLASSIFIER_MODEL = "gpt-4o-mini";
export const DEFAULT_WRITE_INTERPRETATION_MODEL = "gpt-4o-mini";

export const conversationMemorySummaryInputSchema = z.object({
  recentTurns: z.array(conversationTurnSchema),
});

export const conversationMemorySummaryOutputSchema = z.object({
  summary: z.string(),
});

export const conversationResponseInputSchema = z.object({
  route: z.enum(["conversation", "conversation_then_mutation"]),
  rawText: z.string().min(1),
  normalizedText: z.string().min(1),
  recentTurns: z.array(conversationTurnSchema),
  memorySummary: z.string().nullable(),
  entityRegistry: z.array(conversationEntitySchema).optional().default([]),
  discourseState: conversationDiscourseStateSchema.nullable().optional(),
  clarificationSlots: z.array(z.string().min(1)).optional(),
});

export const conversationResponseOutputSchema = z.object({
  reply: z.string().min(1),
});

export type ConversationMemorySummaryInput = z.input<
  typeof conversationMemorySummaryInputSchema
>;
export type ConversationMemorySummaryOutput = z.infer<
  typeof conversationMemorySummaryOutputSchema
>;
export type ConversationResponseInput = z.input<
  typeof conversationResponseInputSchema
>;
export type ConversationResponseOutput = z.infer<
  typeof conversationResponseOutputSchema
>;

export type OpenAIResponsesClient = {
  responses: {
    parse: (input: any) => Promise<{
      output_parsed: unknown;
    }>;
  };
};

export function createOpenAIClient() {
  const config = getConfig();
  return new OpenAI({ apiKey: config.OPENAI_API_KEY });
}

export async function planInboxItemWithResponses(
  input: unknown,
  client: OpenAIResponsesClient = createOpenAIClient(),
) {
  const context = inboxPlanningContextSchema.parse(input);

  const response = await client.responses.parse({
    model: DEFAULT_INBOX_PLANNER_MODEL,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: inboxPlannerSystemPrompt,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(context),
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(
        inboxPlanningResponseFormatSchema,
        "atlas_inbox_planning_output",
      ),
    },
  });

  return inboxPlanningOutputSchema.parse(
    normalizePlanningOutput(
      inboxPlanningResponseFormatSchema.parse(response.output_parsed),
    ),
  );
}

export async function routeTurnWithResponses(
  input: unknown,
  client: OpenAIResponsesClient = createOpenAIClient(),
) {
  const context = turnRoutingInputSchema.parse(input);

  const response = await client.responses.parse({
    model: DEFAULT_TURN_ROUTER_MODEL,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: turnRouterSystemPrompt,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(buildTurnRoutingPromptContext(context)),
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(
        turnRoutingOutputSchema,
        "atlas_turn_routing_output",
      ),
    },
  });

  return turnRoutingOutputSchema.parse(response.output_parsed);
}

export async function recoverConfirmedMutationWithResponses(
  input: unknown,
  client: OpenAIResponsesClient = createOpenAIClient(),
) {
  const context = confirmedMutationRecoveryInputSchema.parse(input);

  const response = await client.responses.parse({
    model: DEFAULT_CONFIRMED_MUTATION_RECOVERY_MODEL,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: confirmedMutationRecoverySystemPrompt,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(
              buildConfirmedMutationRecoveryPromptContext(context),
            ),
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(
        confirmedMutationRecoveryResponseFormatSchema,
        "atlas_confirmed_mutation_recovery_output",
      ),
    },
  });

  return confirmedMutationRecoveryOutputSchema.parse(
    normalizeConfirmedMutationRecoveryOutput(
      confirmedMutationRecoveryResponseFormatSchema.parse(
        response.output_parsed,
      ),
    ),
  );
}

export async function respondToConversationTurnWithResponses(
  input: unknown,
  client: OpenAIResponsesClient = createOpenAIClient(),
) {
  const context = conversationResponseInputSchema.parse(input);

  const response = await client.responses.parse({
    model: DEFAULT_CONVERSATION_RESPONSE_MODEL,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: conversationResponseSystemPrompt,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(
              buildConversationResponsePromptContext(context),
            ),
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(
        conversationResponseOutputSchema,
        "atlas_conversation_response_output",
      ),
    },
  });

  return conversationResponseOutputSchema.parse(response.output_parsed);
}

export async function extractSlotsWithResponses(
  input: unknown,
  client: OpenAIResponsesClient = createOpenAIClient(),
): Promise<RawSlotExtraction> {
  const context = slotExtractorInputSchema.parse(input);

  const response = await client.responses.parse({
    model: DEFAULT_SLOT_EXTRACTOR_MODEL,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: slotExtractorSystemPrompt,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(buildSlotExtractorPromptContext(context)),
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(
        rawSlotExtractionSchema,
        "atlas_slot_extraction_output",
      ),
    },
  });

  return rawSlotExtractionSchema.parse(response.output_parsed);
}

export async function interpretWriteTurnWithResponses(
  input: unknown,
  client: OpenAIResponsesClient = createOpenAIClient(),
): Promise<RawWriteInterpretation> {
  const context = writeInterpretationInputSchema.parse(input);

  const response = await client.responses.parse({
    model: DEFAULT_WRITE_INTERPRETATION_MODEL,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: interpretWriteTurnSystemPrompt,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildWriteInterpretationPromptContext(context),
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(
        rawWriteInterpretationSchema,
        "atlas_write_interpretation_output",
      ),
    },
  });

  return rawWriteInterpretationSchema.parse(response.output_parsed);
}

export async function classifyTurnWithResponses(
  input: unknown,
  client: OpenAIResponsesClient = createOpenAIClient(),
): Promise<TurnClassifierResponse> {
  const context = turnClassifierInputSchema.parse(input);

  const response = await client.responses.parse({
    model: DEFAULT_TURN_CLASSIFIER_MODEL,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: turnClassifierSystemPrompt,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(buildTurnClassifierPromptContext(context)),
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(
        turnClassifierResponseSchema,
        "atlas_turn_classifier_output",
      ),
    },
  });

  return turnClassifierResponseSchema.parse(response.output_parsed);
}

function buildTurnClassifierPromptContext(context: TurnClassifierInput) {
  const discourseState = context.discourseState ?? null;
  return {
    normalizedText: context.normalizedText,
    discourseState: discourseState
      ? {
          ...discourseState,
          pending_clarifications: discourseState.pending_clarifications.filter(
            (c) => c.status === "pending",
          ),
        }
      : null,
    entityRegistry: context.entityRegistry ?? [],
  };
}

function buildSlotExtractorPromptContext(context: SlotExtractorInput) {
  return {
    currentTurnText: context.currentTurnText,
    pendingSlots: context.pendingSlots,
    priorResolvedSlots: context.priorResolvedSlots,
    conversationContext: context.conversationContext ?? null,
  };
}

function buildWriteInterpretationPromptContext(
  context: WriteInterpretationInput,
) {
  return [
    "Current turn text:",
    context.currentTurnText,
    "",
    "Turn type:",
    context.turnType,
    "",
    "Prior pending write operation:",
    context.priorPendingWriteOperation
      ? JSON.stringify(context.priorPendingWriteOperation, null, 2)
      : "None",
    "",
    "Conversation context:",
    context.conversationContext ?? "None",
    "",
    "Entity context:",
    context.entityContext ?? "None",
  ].join("\n");
}

function buildTurnRoutingPromptContext(context: TurnRoutingInput) {
  return {
    rawText: context.rawText,
    recentTurns: context.recentTurns,
    summaryText: context.summaryText ?? null,
    entityRegistry: context.entityRegistry ?? [],
    discourseState: context.discourseState ?? null,
  };
}

function buildConfirmedMutationRecoveryPromptContext(
  context: ConfirmedMutationRecoveryInput,
) {
  return {
    rawText: context.rawText,
    recentTurns: context.recentTurns,
    memorySummary: context.memorySummary,
    entityRegistry: context.entityRegistry ?? [],
    discourseState: context.discourseState ?? null,
  };
}

function buildConversationResponsePromptContext(
  context: ConversationResponseInput,
) {
  return {
    route: context.route,
    rawText: context.rawText,
    recentTurns: context.recentTurns,
    memorySummary: context.memorySummary,
    entityRegistry: context.entityRegistry ?? [],
    discourseState: context.discourseState ?? null,
    clarificationSlots: context.clarificationSlots ?? null,
  };
}

export async function summarizeConversationMemoryWithResponses(
  input: unknown,
  client: OpenAIResponsesClient = createOpenAIClient(),
) {
  const context = conversationMemorySummaryInputSchema.parse(input);

  const response = await client.responses.parse({
    model: DEFAULT_CONVERSATION_MEMORY_SUMMARY_MODEL,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: conversationMemorySummarySystemPrompt,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(context),
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(
        conversationMemorySummaryOutputSchema,
        "atlas_conversation_memory_summary_output",
      ),
    },
  });

  return conversationMemorySummaryOutputSchema.parse(response.output_parsed);
}

function normalizeConfirmedMutationRecoveryOutput(
  output: z.infer<typeof confirmedMutationRecoveryResponseFormatSchema>,
) {
  if (output.outcome === "needs_clarification") {
    return {
      ...output,
      recoveredText: null,
    };
  }

  if (!output.recoveredText?.trim()) {
    return {
      outcome: "needs_clarification" as const,
      recoveredText: null,
      reason: output.reason,
      userReplyMessage: output.userReplyMessage,
    };
  }

  return output;
}

function normalizePlanningOutput(
  output: z.infer<typeof inboxPlanningResponseFormatSchema>,
) {
  return {
    confidence: output.confidence,
    summary: output.summary,
    actions: output.actions.map((action) => {
      switch (action.type) {
        case "create_task":
          if (!action.alias || !action.title) {
            return {
              type: "clarify" as const,
              reason: "Model returned an incomplete create_task action.",
            };
          }

          return {
            type: action.type,
            alias: action.alias,
            title: action.title,
            priority: action.priority ?? "medium",
            urgency: action.urgency ?? "medium",
          };
        case "create_schedule_block":
          return {
            type: action.type,
            taskRef: action.taskRef,
            scheduleConstraint: action.scheduleConstraint ?? null,
            reason: action.reason,
          };
        case "move_schedule_block":
          return {
            type: action.type,
            blockRef: action.blockRef,
            scheduleConstraint: action.scheduleConstraint ?? null,
            reason: action.reason,
          };
        case "complete_task":
          return {
            type: action.type,
            taskRef: action.taskRef,
            reason: action.reason,
          };
        case "clarify":
          return {
            type: action.type,
            reason: action.reason,
          };
        default:
          throw new Error(`Unhandled action type`);
      }
    }),
  };
}
