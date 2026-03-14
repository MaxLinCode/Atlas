import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import { getConfig, inboxPlanningContextSchema, inboxPlanningOutputSchema } from "@atlas/core";

export const DEFAULT_INBOX_PLANNER_MODEL = "gpt-4o-mini";

export type OpenAIResponsesClient = {
  responses: {
    parse: (input: {
      model: string;
      input: Array<{
        role: "system" | "user";
        content: Array<{
          type: "input_text";
          text: string;
        }>;
      }>;
      text: {
        format: ReturnType<typeof zodTextFormat<typeof inboxPlanningOutputSchema>>;
      };
    }) => Promise<{
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
    "Return only valid structured actions that the application can safely validate and apply."
  ].join(" ");
}
