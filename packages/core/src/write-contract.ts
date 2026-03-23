import type { TurnInterpretationType, WriteContract } from "./index";

export const DEFAULT_WRITE_CONTRACT: WriteContract = {
  requiredSlots: ["day", "time"],
  intentKind: "plan"
};

const EDIT_CONTRACT: WriteContract = {
  requiredSlots: ["time"],
  intentKind: "edit"
};

type ResolveWriteContractInput = {
  turnType: TurnInterpretationType;
  priorContract?: WriteContract | undefined;
};

/**
 * Maps a turn type to the active write contract for that turn.
 * Returns undefined only when no contract applies (non-write turn with no prior contract).
 */
export function resolveWriteContract(input: ResolveWriteContractInput): WriteContract | undefined {
  switch (input.turnType) {
    case "planning_request":
      return DEFAULT_WRITE_CONTRACT;
    case "edit_request":
      return EDIT_CONTRACT;
    case "clarification_answer":
    case "confirmation":
    case "follow_up_reply":
    case "informational":
    case "unknown":
      return input.priorContract;
  }
}
