import type {
  OperationKind,
  PendingWriteOperation,
  ResolvedFields,
  TargetRef,
  TimeSpec,
  TurnInterpretation,
} from "./index";
import { timeSpecsEqual } from "./time-spec";

type ScheduleFieldKey = "day" | "time" | "duration";

export type CommitPolicyInput = {
  turnType: TurnInterpretation["turnType"];
  extractedValues: Partial<Record<ScheduleFieldKey, unknown>>;
  confidence: Partial<Record<ScheduleFieldKey, number>>;
  unresolvable: ScheduleFieldKey[];
  operationKind: OperationKind;
  priorPendingWriteOperation?: PendingWriteOperation | undefined;
  currentTargetEntityId?: string;
};

export type CommitPolicyOutput = {
  resolvedFields: ResolvedFields;
  resolvedTargetRef: TargetRef;
  needsClarification: string[];
  missingFields: string[];
  workflowChanged: boolean;
};

export const FIELD_COMMITTING_TURN_TYPES = new Set<
  TurnInterpretation["turnType"]
>(["clarification_answer", "planning_request", "edit_request"]);

const CONFIDENCE_THRESHOLD = 0.75;
const CORRECTION_THRESHOLD = 0.9;

// Required schedule fields per operation kind.
// Contract derivation lives here rather than as a pre-extraction gate.
function requiredFieldsForOperation(
  operationKind: OperationKind,
): ScheduleFieldKey[] {
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
    currentTargetEntityId,
  } = input;

  // Target change: a new entity ID that differs from the prior workflow's target
  // means the user switched subjects. Treat it the same as an operation change —
  // prior committed schedule fields belong to a different task and must be cleared.
  const targetChanged =
    currentTargetEntityId !== undefined &&
    currentTargetEntityId !== priorPendingWriteOperation?.targetRef?.entityId;

  const operationChanged =
    priorPendingWriteOperation != null &&
    (operationKind !== priorPendingWriteOperation.operationKind ||
      targetChanged);

  const priorScheduleFields: Partial<Record<ScheduleFieldKey, unknown>> =
    operationChanged
      ? {}
      : {
          ...(priorPendingWriteOperation?.resolvedFields.scheduleFields ?? {}),
        };

  const needsClarification: string[] = [];
  const committedScheduleFields: Partial<Record<ScheduleFieldKey, unknown>> = {
    ...priorScheduleFields,
  };

  if (FIELD_COMMITTING_TURN_TYPES.has(turnType)) {
    const extractedFieldKeys = Object.keys(extractedValues) as ScheduleFieldKey[];

    for (const fieldKey of extractedFieldKeys) {
      const value = extractedValues[fieldKey];
      if (value === undefined) continue;

      if (unresolvable.includes(fieldKey)) {
        needsClarification.push(`scheduleFields.${fieldKey}`);
        continue;
      }

      const fieldConfidence = confidence[fieldKey] ?? 0;
      if (fieldConfidence < CONFIDENCE_THRESHOLD) {
        needsClarification.push(`scheduleFields.${fieldKey}`);
        continue;
      }

      const priorValue = priorScheduleFields[fieldKey];
      const isCorrection =
        priorValue !== undefined &&
        !scheduleFieldValuesEqual(fieldKey, priorValue, value);
      if (isCorrection && fieldConfidence < CORRECTION_THRESHOLD) {
        needsClarification.push(`scheduleFields.${fieldKey}`);
        continue;
      }

      committedScheduleFields[fieldKey] = value;
    }

    for (const fieldKey of unresolvable) {
      const dotPath = `scheduleFields.${fieldKey}`;
      if (
        !extractedFieldKeys.includes(fieldKey) &&
        !needsClarification.includes(dotPath) &&
        committedScheduleFields[fieldKey] === undefined
      ) {
        needsClarification.push(dotPath);
      }
    }
  }

  const resolvedFields: ResolvedFields = {
    scheduleFields:
      Object.keys(committedScheduleFields).length > 0
        ? (committedScheduleFields as ResolvedFields["scheduleFields"])
        : undefined,
  };

  const requiredFieldKeys = requiredFieldsForOperation(operationKind);
  const missingFields = requiredFieldKeys
    .filter((fieldKey) => committedScheduleFields[fieldKey] === undefined)
    .map((fieldKey) => `scheduleFields.${fieldKey}`);

  // Carry forward the prior target unless this turn introduced a new one.
  const resolvedTargetRef: TargetRef = currentTargetEntityId
    ? { entityId: currentTargetEntityId }
    : (priorPendingWriteOperation?.targetRef ?? null);

  return {
    resolvedFields,
    resolvedTargetRef,
    needsClarification,
    missingFields,
    workflowChanged: operationChanged,
  };
}

function scheduleFieldValuesEqual(
  fieldKey: ScheduleFieldKey,
  a: unknown,
  b: unknown,
): boolean {
  if (fieldKey === "time" && a && b) {
    return timeSpecsEqual(a as TimeSpec, b as TimeSpec);
  }
  return a === b;
}
