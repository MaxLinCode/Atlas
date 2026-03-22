import {
  routedTurnSchema,
  type RoutedTurn,
  type TurnPolicyAction,
  type TurnRoute,
  type TurnRoutingInput,
  type TurnRoutingOutput
} from "@atlas/core";

import { decideTurnPolicy } from "./decide-turn-policy";
import { interpretTurn } from "./interpret-turn";

export type TurnRouterInput = TurnRoutingInput;
export type TurnRouterResult = RoutedTurn;

export type TurnRouterDependencies = {
  classifyTurn?: (input: TurnRouterInput) => Promise<TurnRoutingOutput>;
};

export async function routeMessageTurn(
  input: TurnRouterInput,
  dependencies: TurnRouterDependencies = {}
): Promise<TurnRouterResult> {
  const interpretation = await interpretTurn(input, dependencies);
  const policy = decideTurnPolicy({
    interpretation,
    routingContext: input
  });

  return routedTurnSchema.parse({
    interpretation,
    policy
  });
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

export function getCompatibilityTurnRoute(result: TurnRouterResult): TurnRoute {
  switch (result.policy.action) {
    case "reply_only":
      return "conversation";
    case "ask_clarification":
    case "present_proposal":
      return "conversation_then_mutation";
    case "execute_mutation":
      return "mutation";
    case "recover_and_execute":
      return "confirmed_mutation";
  }
}
