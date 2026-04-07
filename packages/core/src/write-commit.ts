import type {
  PendingWriteOperation,
  ResolvedFields,
  TargetRef,
  TimeSpec,
  TurnInterpretation,
  WriteInterpretation,
} from "./index";
import { timeSpecsEqual } from "./time-spec";

type ScheduleFieldKey = "day" | "time" | "duration";

export type WriteCommitInput = {
  turnType: TurnInterpretation["turnType"];
  interpretation: WriteInterpretation;
  priorPendingWriteOperation?: PendingWriteOperation | undefined;
  currentTargetEntityId?: string;
};

export type WriteCommitOutput = {
  resolvedFields: ResolvedFields;
  resolvedTargetRef: TargetRef;
  needsClarification: string[];
  missingFields: string[];
  workflowChanged: boolean;
  committedFieldPaths: string[];
};

export const WRITE_INTERPRETING_TURN_TYPES = new Set<
  TurnInterpretation["turnType"]
>(["clarification_answer", "planning_request", "edit_request"]);

const CONFIDENCE_THRESHOLD = 0.75;
const CORRECTION_THRESHOLD = 0.9;

function requiredFieldsForOperation(operationKind: WriteInterpretation["operationKind"]) {
  switch (operationKind) {
    case "plan":
      return ["day", "time"] as const;
    case "edit":
    case "reschedule":
      return ["time"] as const;
    case "complete":
    case "archive":
      return [] as const;
  }
}

export function applyWriteCommit(input: WriteCommitInput): WriteCommitOutput {
  const {
    turnType,
    interpretation,
    priorPendingWriteOperation,
    currentTargetEntityId,
  } = input;

  const interpretedTargetRef = mergeTargetRef(
    interpretation.targetRef,
    currentTargetEntityId,
  );
  const targetChanged =
    targetRefsEqual(
      interpretedTargetRef,
      priorPendingWriteOperation?.targetRef ?? null,
    ) === false;
  const operationChanged =
    priorPendingWriteOperation != null &&
    (interpretation.operationKind !==
      priorPendingWriteOperation.operationKind ||
      targetChanged);

  const priorScheduleFields = operationChanged
    ? {}
    : { ...(priorPendingWriteOperation?.resolvedFields.scheduleFields ?? {}) };

  const priorTaskFields = operationChanged
    ? {}
    : { ...(priorPendingWriteOperation?.resolvedFields.taskFields ?? {}) };

  const committedScheduleFields: NonNullable<ResolvedFields["scheduleFields"]> =
    { ...priorScheduleFields };
  const committedTaskFields: NonNullable<ResolvedFields["taskFields"]> = {
    ...priorTaskFields,
  };
  const needsClarification: string[] = [];
  const committedFieldPaths: string[] = [];

  if (WRITE_INTERPRETING_TURN_TYPES.has(turnType)) {
    commitScheduleFields({
      interpretation,
      priorScheduleFields,
      committedScheduleFields,
      needsClarification,
      committedFieldPaths,
    });
    commitTaskFields({
      interpretation,
      priorTaskFields,
      committedTaskFields,
      needsClarification,
      committedFieldPaths,
    });
    commitUnresolvedFieldPaths({
      interpretation,
      needsClarification,
      committedFieldPaths,
      committedScheduleFields,
      committedTaskFields,
    });
  }

  const resolvedFields: ResolvedFields = {
    ...(Object.keys(committedScheduleFields).length > 0
      ? { scheduleFields: committedScheduleFields }
      : {}),
    ...(Object.keys(committedTaskFields).length > 0
      ? { taskFields: committedTaskFields }
      : {}),
  };

  const missingFields = requiredFieldsForOperation(interpretation.operationKind)
    .filter((fieldKey) => committedScheduleFields[fieldKey] === undefined)
    .map((fieldKey) => `scheduleFields.${fieldKey}`);

  return {
    resolvedFields,
    resolvedTargetRef:
      interpretedTargetRef ?? (priorPendingWriteOperation?.targetRef ?? null),
    needsClarification,
    missingFields,
    workflowChanged: operationChanged,
    committedFieldPaths,
  };
}

function commitScheduleFields(input: {
  interpretation: WriteInterpretation;
  priorScheduleFields: NonNullable<ResolvedFields["scheduleFields"]>;
  committedScheduleFields: NonNullable<ResolvedFields["scheduleFields"]>;
  needsClarification: string[];
  committedFieldPaths: string[];
}) {
  const {
    interpretation,
    priorScheduleFields,
    committedScheduleFields,
    needsClarification,
    committedFieldPaths,
  } = input;
  const scheduleFields = interpretation.fields.scheduleFields;
  if (!scheduleFields) return;

  const fieldKeys = Object.keys(scheduleFields) as ScheduleFieldKey[];
  for (const fieldKey of fieldKeys) {
    const fieldPath = `scheduleFields.${fieldKey}`;
    const value = scheduleFields[fieldKey];
    if (value === undefined) continue;

    if (interpretation.unresolvedFields.includes(fieldPath)) {
      needsClarification.push(fieldPath);
      continue;
    }

    const fieldConfidence = interpretation.confidence[fieldPath] ?? 0;
    if (fieldConfidence < CONFIDENCE_THRESHOLD) {
      needsClarification.push(fieldPath);
      continue;
    }

    const priorValue = priorScheduleFields[fieldKey];
    const isCorrection =
      priorValue !== undefined &&
      !scheduleFieldValuesEqual(fieldKey, priorValue, value);
    if (isCorrection && fieldConfidence < CORRECTION_THRESHOLD) {
      needsClarification.push(fieldPath);
      continue;
    }

    if (fieldKey === "day" && typeof value === "string") {
      committedScheduleFields.day = value;
    } else if (fieldKey === "duration" && typeof value === "number") {
      committedScheduleFields.duration = value;
    } else if (fieldKey === "time" && value !== undefined) {
      committedScheduleFields.time = value as TimeSpec;
    }
    committedFieldPaths.push(fieldPath);
  }
}

function commitTaskFields(input: {
  interpretation: WriteInterpretation;
  priorTaskFields: NonNullable<ResolvedFields["taskFields"]>;
  committedTaskFields: NonNullable<ResolvedFields["taskFields"]>;
  needsClarification: string[];
  committedFieldPaths: string[];
}) {
  const {
    interpretation,
    priorTaskFields,
    committedTaskFields,
    needsClarification,
    committedFieldPaths,
  } = input;
  const taskFields = interpretation.fields.taskFields;
  if (!taskFields) return;

  const fieldKeys = Object.keys(taskFields) as Array<
    keyof NonNullable<ResolvedFields["taskFields"]>
  >;
  for (const fieldKey of fieldKeys) {
    const fieldPath = `taskFields.${fieldKey}`;
    const value = taskFields[fieldKey];
    if (value === undefined) continue;

    if (interpretation.unresolvedFields.includes(fieldPath)) {
      needsClarification.push(fieldPath);
      continue;
    }

    const fieldConfidence = interpretation.confidence[fieldPath] ?? 0;
    if (fieldConfidence < CONFIDENCE_THRESHOLD) {
      needsClarification.push(fieldPath);
      continue;
    }

    const priorValue = priorTaskFields[fieldKey];
    const isCorrection = priorValue !== undefined && priorValue !== value;
    if (isCorrection && fieldConfidence < CORRECTION_THRESHOLD) {
      needsClarification.push(fieldPath);
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (committedTaskFields as any)[fieldKey] = value;
    committedFieldPaths.push(fieldPath);
  }
}

function commitUnresolvedFieldPaths(input: {
  interpretation: WriteInterpretation;
  needsClarification: string[];
  committedFieldPaths: string[];
  committedScheduleFields: NonNullable<ResolvedFields["scheduleFields"]>;
  committedTaskFields: NonNullable<ResolvedFields["taskFields"]>;
}) {
  const {
    interpretation,
    needsClarification,
    committedScheduleFields,
    committedTaskFields,
  } = input;

  for (const fieldPath of interpretation.unresolvedFields) {
    if (needsClarification.includes(fieldPath)) continue;
    if (fieldPath.startsWith("scheduleFields.")) {
      const fieldKey = fieldPath.replace(
        "scheduleFields.",
        "",
      ) as ScheduleFieldKey;
      if (committedScheduleFields[fieldKey] !== undefined) continue;
    }
    if (fieldPath.startsWith("taskFields.")) {
      const fieldKey = fieldPath.replace(
        "taskFields.",
        "",
      ) as keyof NonNullable<ResolvedFields["taskFields"]>;
      if (committedTaskFields[fieldKey] !== undefined) continue;
    }
    needsClarification.push(fieldPath);
  }
}

function mergeTargetRef(
  interpretedTargetRef: TargetRef,
  currentTargetEntityId?: string,
): TargetRef {
  if (!interpretedTargetRef && !currentTargetEntityId) return null;
  return {
    ...(interpretedTargetRef ?? {}),
    ...(currentTargetEntityId ? { entityId: currentTargetEntityId } : {}),
  };
}

function targetRefsEqual(a: TargetRef, b: TargetRef): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;

  return (
    a.entityId === b.entityId &&
    a.description === b.description &&
    a.entityKind === b.entityKind
  );
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
