import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import {
  getConfig,
  inboxPlanningContextSchema,
  inboxPlanningOutputSchema,
  turnRoutingInputSchema,
  turnRoutingOutputSchema,
  conversationTurnSchema,
  confirmedMutationRecoveryInputSchema,
  confirmedMutationRecoveryOutputSchema,
  type TurnRoutingInput,
  type TurnRoutingOutput,
  type ConfirmedMutationRecoveryInput,
  type ConfirmedMutationRecoveryOutput
} from "@atlas/core";

export const DEFAULT_INBOX_PLANNER_MODEL = "gpt-4o-mini";
export const DEFAULT_TURN_ROUTER_MODEL = "gpt-4o-mini";
export const DEFAULT_CONVERSATION_RESPONSE_MODEL = "gpt-4o-mini";
export const DEFAULT_CONVERSATION_MEMORY_SUMMARY_MODEL = "gpt-4o-mini";
export const DEFAULT_CONFIRMED_MUTATION_RECOVERY_MODEL = "gpt-4o-mini";

export const conversationMemorySummaryInputSchema = z.object({
  recentTurns: z.array(conversationTurnSchema)
});

export const conversationMemorySummaryOutputSchema = z.object({
  summary: z.string()
});

export const conversationResponseInputSchema = z.object({
  route: z.enum(["conversation", "conversation_then_mutation"]),
  normalizedText: z.string().min(1),
  recentTurns: z.array(conversationTurnSchema),
  memorySummary: z.string().nullable()
});

export const conversationResponseOutputSchema = z.object({
  reply: z.string().min(1)
});

export type ConversationMemorySummaryInput = z.infer<typeof conversationMemorySummaryInputSchema>;
export type ConversationMemorySummaryOutput = z.infer<typeof conversationMemorySummaryOutputSchema>;
export type ConversationResponseInput = z.infer<typeof conversationResponseInputSchema>;
export type ConversationResponseOutput = z.infer<typeof conversationResponseOutputSchema>;

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
  client: OpenAIResponsesClient = createOpenAIClient()
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
            text: buildSystemPrompt()
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(context)
          }
        ]
      }
    ],
    text: {
      format: zodTextFormat(inboxPlanningOutputSchema, "atlas_inbox_planning_output")
    }
  });

  return inboxPlanningOutputSchema.parse(response.output_parsed);
}

export async function routeTurnWithResponses(
  input: unknown,
  client: OpenAIResponsesClient = createOpenAIClient()
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
            text: buildTurnRouterSystemPrompt()
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(context)
          }
        ]
      }
    ],
    text: {
      format: zodTextFormat(turnRoutingOutputSchema, "atlas_turn_routing_output")
    }
  });

  return turnRoutingOutputSchema.parse(response.output_parsed);
}

export async function recoverConfirmedMutationWithResponses(
  input: unknown,
  client: OpenAIResponsesClient = createOpenAIClient()
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
            text: buildConfirmedMutationRecoverySystemPrompt()
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(context)
          }
        ]
      }
    ],
    text: {
      format: zodTextFormat(confirmedMutationRecoveryOutputSchema, "atlas_confirmed_mutation_recovery_output")
    }
  });

  return confirmedMutationRecoveryOutputSchema.parse(response.output_parsed);
}

export async function respondToConversationTurnWithResponses(
  input: unknown,
  client: OpenAIResponsesClient = createOpenAIClient()
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
            text: buildConversationResponseSystemPrompt()
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(context)
          }
        ]
      }
    ],
    text: {
      format: zodTextFormat(conversationResponseOutputSchema, "atlas_conversation_response_output")
    }
  });

  return conversationResponseOutputSchema.parse(response.output_parsed);
}

export async function summarizeConversationMemoryWithResponses(
  input: unknown,
  client: OpenAIResponsesClient = createOpenAIClient()
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
            text: buildConversationMemorySummarySystemPrompt()
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(context)
          }
        ]
      }
    ],
    text: {
      format: zodTextFormat(conversationMemorySummaryOutputSchema, "atlas_conversation_memory_summary_output")
    }
  });

  return conversationMemorySummaryOutputSchema.parse(response.output_parsed);
}

function buildSystemPrompt() {
  return [
    "You are Atlas, a Telegram-first planning assistant.",
    "A user sends freeform inbox messages, and you must turn them into structured planning actions that the application will validate and apply.",
    "Return only a structured planning result.",
    "The planner does not write to the database directly.",
    "Do not reference database ids.",
    "Only use symbolic aliases that appear in the provided context for existing items, or aliases created in your own create_task actions.",
    "The planner may return action objects like: create_task, create_schedule_block, move_schedule_block, or clarify.",
    "The planner receives the latest inbox message, user profile or scheduling preferences, existing tasks, existing schedule blocks, and symbolic aliases for existing tasks and schedule blocks.",
    "Behavior rules:",
    "Recognize when a message introduces new tasks.",
    "Recognize when a message schedules those tasks.",
    "Recognize when a message refers to existing scheduled work.",
    "Return the smallest valid action set.",
    "Prefer concise reasons.",
    "Keep the action list minimal.",
    "It must never return raw database ids, only provided symbolic aliases.",
    "Do not invent aliases that were not provided in the context or created in your own create_task actions.",
    "Do not assume an existing task alias or schedule_block alias unless the message clearly refers to that item.",
    "Action selection rules:",
    "Use create_task when the inbox item introduces new work.",
    "If the user asks to schedule new work, use create_task and create_schedule_block for that work, unless clarification is required.",
    "Use create_schedule_block to schedule either a created task alias or an existing task alias.",
    "Use move_schedule_block only for an existing schedule_block alias from the provided context, and only when a single existing block is clearly referenced.",
    "Do not emit conflicting actions for the same work item.",
    "Do not mix incompatible action types unless the request is truly a safe combined plan.",
    "Clarification rules:",
    "If the request is ambiguous, missing a safe target, under-specified, conditional, or should not mutate state, return exactly one clarify action.",
    "Do not mix clarify with mutating actions.",
    "If a request mixes new work and existing work in a way that is ambiguous, prefer clarify.",
    "If the request is conditional, such as if tomorrow is slammed push X to Friday, prefer clarify unless the application explicitly supports conditional planning branches.",
    "Safety priorities:",
    "Do not return schedule actions without a complete task model.",
    "Do not convert conditional language into multiple concrete schedule mutations.",
    "Do not overconfidently use existing aliases when the message also introduces new tasks.",
    "Do not emit multiple conflicting schedule actions for the same item.",
    "User-facing reply:",
    "Include a userReplyMessage field with a friendly, natural response summarizing what you are planning to do (e.g., 'Got it, I've scheduled your dentist appointment for Friday at 2pm.') or clarifying what you need from the user.",
    "Return only valid structured actions that the application can safely validate and apply."
  ].join(" ");
}

function buildTurnRouterSystemPrompt() {
  return [
    "You are Atlas's turn router for Telegram.",
    "Select exactly one route for the current turn: conversation, mutation, conversation_then_mutation, or confirmed_mutation.",
    "Definitions:",
    "conversation: reflective discussion, prioritization, advice, planning dialogue, meta questions, or broad proposals without immediate writes.",
    "mutation: clear, direct, and sufficiently specified request to capture, schedule, reschedule, complete, archive, or otherwise update Atlas task or schedule state now.",
    "Do not choose mutation when the write request is partial, ambiguous, conditional, mixed with discussion, or missing key details needed to complete the update safely.",
    "conversation_then_mutation: a turn that includes a possible write but requires discussion, clarification, or later confirmation before any mutation.",
    "This includes mixed discussion-plus-action turns, partial scheduling asks, underspecified capture requests, and ambiguous update requests.",
    "confirmed_mutation: the current turn confirms or concretely refines one recent proposed write strongly enough that Atlas may enter the structured mutation path now.",
    "Use recent turns as short-horizon confirmation context only.",
    "Choose confirmed_mutation only when recent context contains one concrete recoverable proposal and the latest turn clearly confirms or refines it, such as yes, sure, do it, 3pm is fine, Friday works, or push it 1 hour later.",
    "Do not choose confirmed_mutation when there are multiple plausible proposals, the prior proposal was still vague, or the latest turn adds ambiguity.",
    "Safety rules:",
    "When uncertain between confirmed_mutation and conversation_then_mutation, choose conversation_then_mutation.",
    "When uncertain between mutation and conversation_then_mutation, choose conversation_then_mutation.",
    "Do not assume writes happened in conversation routes.",
    "Examples:",
    "Input: 'create car maintenance appt' -> conversation_then_mutation",
    "Input: 'schedule oil change for Friday at 2pm' -> mutation",
    "Input: 'should I do the oil change this week or next week?' -> conversation",
    "Input: 'I might move this to Friday, what do you think?' -> conversation_then_mutation",
    "Recent assistant proposal: 'Would you like me to schedule it at 3pm?' Current input: 'Yes' -> confirmed_mutation",
    "Recent proposal: 'I can move it to Friday at 3pm.' Current input: 'Friday works' -> confirmed_mutation",
    "Recent assistant proposal: 'I could do 3pm or 4pm.' Current input: 'Yes' -> conversation_then_mutation",
    "Return only the structured routing output."
  ].join(" ");
}

function buildConversationResponseSystemPrompt() {
  return [
    "You are Atlas, a Telegram-first planning assistant.",
    "You are responding on the non-writing conversation path.",
    "The provided recent turns and memory summary are continuity context only, not authoritative Atlas state.",
    "Reply in natural language as Atlas.",
    "Be helpful, concise, and planning-oriented.",
    "Do not make hard claims that any task, schedule, or reminder definitely exists or was created, updated, moved, completed, or archived.",
    "Use cautious phrasing when inferring from conversation context, such as it sounds like, if you mean, or from our recent exchange.",
    "If the route is conversation_then_mutation, discuss the request first and make clear that any actual change would require later confirmation.",
    "If the referent is still unclear, ask a narrow clarifying question.",
    "Prefer actionable planning guidance, prioritization help, or a concrete next step.",
    "Return only the structured response."
  ].join(" ");
}

function buildConversationMemorySummarySystemPrompt() {
  return [
    "You are Atlas, building a short working summary of a recent Telegram exchange.",
    "Summarize only what appears in the provided recent turns.",
    "Keep the summary compact, neutral, and request-scoped.",
    "Capture likely referents, tentative plans, unresolved questions, and recent suggestions that will help the next conversation turn.",
    "Do not invent system state.",
    "Do not claim any write succeeded unless the conversation explicitly states that outcome.",
    "This summary is continuity context only, not authoritative Atlas memory.",
    "Return only the structured response."
  ].join(" ");
}

function buildConfirmedMutationRecoverySystemPrompt() {
  return [
    "You are Atlas, reconstructing a concrete write-ready mutation request from short-horizon confirmation context.",
    "The latest user turn may be a confirmation or refinement of one recent proposed write.",
    "Use only the provided latest turn, recent turns, and any optional working summary.",
    "Return 'recovered' only when the recent context supports exactly one concrete mutation that Atlas may safely pass into the existing structured mutation path now.",
    "The recovered text should be a concise natural-language request that restates the intended write directly.",
    "If the latest turn only confirms a vague or multi-option proposal, or if there are multiple plausible proposals, return needs_clarification.",
    "Do not invent task identity or scheduling details that are not supported by the provided context.",
    "Transcript is short-horizon confirmation context only, not canonical state.",
    "If outcome is 'recovered', set recoveredText to the concrete write-ready request and userReplyMessage to a brief natural confirmation of the action.",
    "If outcome is 'needs_clarification', set recoveredText to null and userReplyMessage to a helpful clarifying question for the user.",
    "Return only the structured response."
  ].join(" ");
}
