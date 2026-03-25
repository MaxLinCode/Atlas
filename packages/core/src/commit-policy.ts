import type {
  ResolvedSlots,
  SlotKey,
  TurnInterpretation,
  WriteContract,
} from "./index";

export type CommitPolicyInput = {
  turnType: TurnInterpretation["turnType"];
  extractedValues: Partial<ResolvedSlots>;
  confidence: Partial<Record<SlotKey, number>>;
  unresolvable: SlotKey[];
  priorResolvedSlots: ResolvedSlots;
  activeContract: WriteContract;
  priorContract?: WriteContract | undefined;
};

export type CommitPolicyOutput = {
  committedSlots: ResolvedSlots;
  needsClarification: SlotKey[];
  missingSlots: SlotKey[];
};

export const SLOT_COMMITTING_TURN_TYPES = new Set<
  TurnInterpretation["turnType"]
>(["clarification_answer", "planning_request", "edit_request"]);

const CONFIDENCE_THRESHOLD = 0.75;
const CORRECTION_THRESHOLD = 0.9;

export function applyCommitPolicy(
  input: CommitPolicyInput,
): CommitPolicyOutput {
  const {
    turnType,
    extractedValues,
    confidence,
    unresolvable,
    activeContract,
    priorContract,
  } = input;

  const contractChanged =
    priorContract != null &&
    activeContract.intentKind !== priorContract.intentKind;
  const priorSlots: ResolvedSlots = contractChanged
    ? {}
    : { ...input.priorResolvedSlots };

  const needsClarification: SlotKey[] = [];
  const committedSlots: ResolvedSlots = { ...priorSlots };

  if (!SLOT_COMMITTING_TURN_TYPES.has(turnType)) {
    return {
      committedSlots,
      needsClarification,
      missingSlots: deriveMissingSlots(activeContract, committedSlots),
    };
  }

  const slotKeys = Object.keys(extractedValues) as SlotKey[];

  for (const slot of slotKeys) {
    const value = extractedValues[slot];
    if (value === undefined) continue;

    if (unresolvable.includes(slot)) {
      needsClarification.push(slot);
      continue;
    }

    const slotConfidence = confidence[slot] ?? 0;
    if (slotConfidence < CONFIDENCE_THRESHOLD) {
      needsClarification.push(slot);
      continue;
    }

    const priorValue = priorSlots[slot];
    const isCorrection = priorValue !== undefined && priorValue !== value;
    if (isCorrection && slotConfidence < CORRECTION_THRESHOLD) {
      needsClarification.push(slot);
      continue;
    }

    (committedSlots as Record<string, unknown>)[slot] = value;
  }

  for (const slot of unresolvable) {
    if (!slotKeys.includes(slot) && !needsClarification.includes(slot)) {
      needsClarification.push(slot);
    }
  }

  return {
    committedSlots,
    needsClarification,
    missingSlots: deriveMissingSlots(activeContract, committedSlots),
  };
}

function deriveMissingSlots(
  contract: WriteContract,
  committed: ResolvedSlots,
): SlotKey[] {
  return contract.requiredSlots.filter((slot) => committed[slot] === undefined);
}
