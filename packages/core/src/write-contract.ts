import type { OperationKind, TurnInterpretationType } from "./index";

type ResolveOperationKindInput = {
  turnType: TurnInterpretationType;
  priorOperationKind?: OperationKind | undefined;
};

/**
 * Maps a turn type to the active operation kind for that turn.
 * Returns undefined only when no operation applies (non-write turn with no prior operation).
 */
export function resolveOperationKind(
  input: ResolveOperationKindInput,
): OperationKind | undefined {
  switch (input.turnType) {
    case "planning_request":
      return "plan";
    case "edit_request":
      return "edit";
    case "clarification_answer":
    case "confirmation":
    case "follow_up_reply":
    case "informational":
    case "unknown":
      return input.priorOperationKind;
  }
}
