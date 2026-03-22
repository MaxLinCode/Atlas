import {
  routedTurnSchema,
  type RoutedTurn,
  type TurnPolicyAction,
  type TurnRoute,
  type TurnRoutingInput
} from "@atlas/core";

import { decideTurnPolicy } from "./decide-turn-policy";
import { interpretTurn } from "./interpret-turn";

export type TurnRouterInput = TurnRoutingInput;
export type TurnRouterResult = RoutedTurn;

export async function routeMessageTurn(input: TurnRouterInput): Promise<TurnRouterResult> {
  const interpretation = await interpretTurn(input);
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
