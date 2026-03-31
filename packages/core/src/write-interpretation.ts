import type {
  RawWriteInterpretation,
  ResolvedFields,
  ResolvedSlots,
  TargetRef,
  WriteInterpretation,
} from "./index";
import { normalizeRawExtraction } from "./slot-normalizer";

export function normalizeRawWriteInterpretation(
  raw: RawWriteInterpretation,
  sourceText: string,
): WriteInterpretation {
  const scheduleSlots = normalizeRawExtraction({
    time: raw.fields.scheduleFields?.time ?? null,
    day: raw.fields.scheduleFields?.day ?? null,
    duration: raw.fields.scheduleFields?.duration ?? null,
    target: null,
    confidence: {},
    unresolvable: [],
  });

  const resolvedFields: ResolvedFields = {
    ...(Object.keys(scheduleSlots).length > 0
      ? {
          scheduleFields: {
            ...(scheduleSlots.day !== undefined
              ? { day: scheduleSlots.day }
              : {}),
            ...(scheduleSlots.time !== undefined
              ? { time: scheduleSlots.time }
              : {}),
            ...(scheduleSlots.duration !== undefined
              ? { duration: scheduleSlots.duration }
              : {}),
          } satisfies ResolvedSlots,
        }
      : {}),
    ...(raw.fields.taskFields
      ? {
          taskFields: {
            ...(raw.fields.taskFields.priority
              ? { priority: raw.fields.taskFields.priority }
              : {}),
            ...(raw.fields.taskFields.label
              ? { label: raw.fields.taskFields.label }
              : {}),
            ...(raw.fields.taskFields.sourceText
              ? { sourceText: raw.fields.taskFields.sourceText }
              : {}),
          },
        }
      : {}),
  };

  const normalizedTargetRef: TargetRef =
    raw.targetRef &&
    Object.values(raw.targetRef).some((value) => value !== null)
      ? {
          ...(raw.targetRef.entityId ? { entityId: raw.targetRef.entityId } : {}),
          ...(raw.targetRef.description
            ? { description: raw.targetRef.description }
            : {}),
          ...(raw.targetRef.entityKind
            ? { entityKind: raw.targetRef.entityKind }
            : {}),
        }
      : null;

  return {
    operationKind: raw.operationKind,
    actionDomain: raw.actionDomain,
    targetRef: normalizedTargetRef,
    taskName: raw.taskName,
    fields: resolvedFields,
    sourceText,
    confidence: raw.confidence,
    unresolvedFields: raw.unresolvedFields,
  };
}
