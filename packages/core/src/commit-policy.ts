import type {
  OperationKind,
  PendingWriteOperation,
  ResolvedFields,
  TimeSpec,
  TurnInterpretation,
} from "./index";
import { timeSpecsEqual } from "./time-spec";

type ScheduleSlot = "day" | "time" | "duration" | "target";

export type CommitPolicyInput = {
  turnType: TurnInterpretation["turnType"];
  extractedValues: Partial<Record<ScheduleSlot, unknown>>;
  confidence: Partial<Record<ScheduleSlot, number>>;
  unresolvable: ScheduleSlot[];
  operationKind: OperationKind;
  priorPendingWriteOperation?: PendingWriteOperation | undefined;
};

export type CommitPolicyOutput = {
  resolvedFields: ResolvedFields;
  needsClarification: string[];
  missingFields: string[];
};

export const SLOT_COMMITTING_TURN_TYPES = new Set<
  TurnInterpretation["turnType"]
>(["clarification_answer", "planning_request", "edit_request"]);

const CONFIDENCE_THRESHOLD = 0.75;
const CORRECTION_THRESHOLD = 0.9;

// Required schedule fields per operation kind.
// Contract derivation lives here rather than as a pre-extraction gate.
function requiredFieldsForOperation(operationKind: OperationKind): ScheduleSlot[] {
  switch (operationKind) {
    case "plan":
      return ["day", "time"];
    case "edit":
    case "reschedule":
      return ["time"];
    case "complete":
    case "archive":
      return [];
  }
}

export function applyCommitPolicy(
  input: CommitPolicyInput,
): CommitPolicyOutput {
  const {
    turnType,
    extractedValues,
    confidence,
    unresolvable,
    operationKind,
    priorPendingWriteOperation,
  } = input;

  const operationChanged =
    priorPendingWriteOperation != null &&
    operationKind !== priorPendingWriteOperation.operationKind;

  const priorScheduleFields: Partial<Record<ScheduleSlot, unknown>> =
    operationChanged
      ? {}
      : { ...(priorPendingWriteOperation?.resolvedFields.scheduleFields ?? {}) };

  const needsClarification: string[] = [];
  const committedSchedule: Partial<Record<ScheduleSlot, unknown>> = {
    ...priorScheduleFields,
  };

  if (SLOT_COMMITTING_TURN_TYPES.has(turnType)) {
    const slotKeys = Object.keys(extractedValues) as ScheduleSlot[];

    for (const slot of slotKeys) {
      const value = extractedValues[slot];
      if (value === undefined) continue;

      if (unresolvable.includes(slot)) {
        needsClarification.push(`scheduleFields.${slot}`);
        continue;
      }

      const slotConfidence = confidence[slot] ?? 0;
      if (slotConfidence < CONFIDENCE_THRESHOLD) {
        needsClarification.push(`scheduleFields.${slot}`);
        continue;
      }

      const priorValue = priorScheduleFields[slot];
      const isCorrection =
        priorValue !== undefined && !slotValuesEqual(slot, priorValue, value);
      if (isCorrection && slotConfidence < CORRECTION_THRESHOLD) {
        needsClarification.push(`scheduleFields.${slot}`);
        continue;
      }

      committedSchedule[slot] = value;
    }

    for (const slot of unresolvable) {
      const dotPath = `scheduleFields.${slot}`;
      if (
        !slotKeys.includes(slot) &&
        !needsClarification.includes(dotPath) &&
        committedSchedule[slot] === undefined
      ) {
        needsClarification.push(dotPath);
      }
    }
  }

  const resolvedFields: ResolvedFields = {
    scheduleFields:
      Object.keys(committedSchedule).length > 0
        ? (committedSchedule as ResolvedFields["scheduleFields"])
        : undefined,
  };

  const requiredSlots = requiredFieldsForOperation(operationKind);
  const missingFields = requiredSlots
    .filter((slot) => committedSchedule[slot] === undefined)
    .map((slot) => `scheduleFields.${slot}`);

  return { resolvedFields, needsClarification, missingFields };
}

function slotValuesEqual(slot: ScheduleSlot, a: unknown, b: unknown): boolean {
  if (slot === "time" && a && b) {
    return timeSpecsEqual(a as TimeSpec, b as TimeSpec);
  }
  return a === b;
}
