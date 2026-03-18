import {
  type TurnRoute,
  type TurnRoutingInput,
  type TurnRoutingOutput
} from "@atlas/core";
import { routeTurnWithResponses } from "@atlas/integrations";

export type TurnRouterInput = TurnRoutingInput;
export type TurnRouterResult = {
  route: TurnRoute;
  reason: string;
  writesAllowed: boolean;
};

export type TurnRouterDependencies = {
  classifyTurn?: (input: TurnRouterInput) => Promise<TurnRoutingOutput>;
};

export async function routeTelegramTurn(
  input: TurnRouterInput,
  dependencies: TurnRouterDependencies = {}
): Promise<TurnRouterResult> {
  const parsedInput = parseTurnRouterInput(input);
  const classifyTurn = dependencies.classifyTurn ?? routeTurnWithResponses;
  const classified = await classifyTurn(parsedInput);

  return {
    route: classified.route,
    reason: classified.reason,
    writesAllowed: allowsWrites(classified.route)
  };
}

function allowsWrites(route: TurnRoute) {
  return route === "mutation" || route === "confirmed_mutation";
}

function parseTurnRouterInput(input: TurnRouterInput): TurnRouterInput {
  if (!input.rawText.trim() || !input.normalizedText.trim()) {
    throw new Error("Turn router input must include non-empty rawText and normalizedText.");
  }

  return input;
}
