import {
  type ConversationResponseInput,
  type ConversationResponseOutput,
  respondToConversationTurnWithResponses,
} from "@atlas/integrations";

export type BuildConversationResponseInput = ConversationResponseInput;
export type BuildConversationResponseResult = ConversationResponseOutput;

export type ConversationResponseDependencies = {
  respond?: (
    input: BuildConversationResponseInput,
  ) => Promise<BuildConversationResponseResult>;
};

export async function buildConversationResponse(
  input: BuildConversationResponseInput,
  dependencies: ConversationResponseDependencies = {},
): Promise<BuildConversationResponseResult> {
  const parsed = parseConversationResponseInput(input);
  const respond =
    dependencies.respond ?? respondToConversationTurnWithResponses;

  return respond(parsed);
}

function parseConversationResponseInput(
  input: BuildConversationResponseInput,
): BuildConversationResponseInput {
  if (!input.rawText.trim() || !input.normalizedText.trim()) {
    throw new Error(
      "Conversation response input must include non-empty rawText and normalizedText.",
    );
  }

  return input;
}
