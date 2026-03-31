import { describe, expect, it } from "vitest";

import type { PendingWriteOperation, TimeSpec, WriteInterpretation } from "./index";
import type { WriteCommitInput } from "./write-commit";
import { applyWriteCommit } from "./write-commit";

function t(hour: number, minute: number): TimeSpec {
  return { kind: "absolute", hour, minute };
}

function priorOp(
  operationKind: PendingWriteOperation["operationKind"],
  scheduleFields: PendingWriteOperation["resolvedFields"]["scheduleFields"],
  targetEntityId?: string,
): PendingWriteOperation {
  return {
    operationKind,
    targetRef: targetEntityId ? { entityId: targetEntityId } : null,
    resolvedFields: { scheduleFields },
    missingFields: [],
    originatingText: "prior turn",
    startedAt: new Date().toISOString(),
  };
}

function interpretation(
  overrides: Partial<WriteInterpretation>,
): WriteInterpretation {
  return {
    operationKind: "plan",
    actionDomain: "task",
    targetRef: null,
    taskName: null,
    fields: {},
    sourceText: "source turn",
    confidence: {},
    unresolvedFields: [],
    ...overrides,
  };
}

function buildInput(overrides: Partial<WriteCommitInput>): WriteCommitInput {
  return {
    turnType: "planning_request",
    interpretation: interpretation({}),
    ...overrides,
  };
}

describe("applyWriteCommit", () => {
  it("does not commit fields for informational turns", () => {
    const result = applyWriteCommit(
      buildInput({
        turnType: "informational",
        interpretation: interpretation({
          fields: { scheduleFields: { time: t(15, 0) } },
          confidence: { "scheduleFields.time": 0.95 },
        }),
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toBeUndefined();
  });

  it("commits grouped schedule fields above threshold", () => {
    const result = applyWriteCommit(
      buildInput({
        interpretation: interpretation({
          fields: {
            scheduleFields: { time: t(17, 0), day: "tomorrow" },
          },
          confidence: {
            "scheduleFields.time": 0.9,
            "scheduleFields.day": 0.85,
          },
        }),
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toEqual(t(17, 0));
    expect(result.resolvedFields.scheduleFields?.day).toBe("tomorrow");
    expect(result.committedFieldPaths).toEqual([
      "scheduleFields.time",
      "scheduleFields.day",
    ]);
  });

  it("routes low-confidence grouped fields to clarification", () => {
    const result = applyWriteCommit(
      buildInput({
        interpretation: interpretation({
          fields: { scheduleFields: { time: t(17, 0) } },
          confidence: { "scheduleFields.time": 0.6 },
        }),
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toBeUndefined();
    expect(result.needsClarification).toContain("scheduleFields.time");
  });

  it("does not commit corrections below the correction threshold", () => {
    const result = applyWriteCommit(
      buildInput({
        turnType: "clarification_answer",
        interpretation: interpretation({
          fields: { scheduleFields: { time: t(15, 0) } },
          confidence: { "scheduleFields.time": 0.8 },
        }),
        priorPendingWriteOperation: priorOp("plan", { time: t(14, 0) }),
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toEqual(t(14, 0));
    expect(result.needsClarification).toContain("scheduleFields.time");
  });

  it("commits corrections at or above the correction threshold", () => {
    const result = applyWriteCommit(
      buildInput({
        turnType: "clarification_answer",
        interpretation: interpretation({
          fields: { scheduleFields: { time: t(15, 0) } },
          confidence: { "scheduleFields.time": 0.92 },
        }),
        priorPendingWriteOperation: priorOp("plan", { time: t(14, 0) }),
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toEqual(t(15, 0));
    expect(result.needsClarification).not.toContain("scheduleFields.time");
  });

  it("routes unresolved field paths to clarification", () => {
    const result = applyWriteCommit(
      buildInput({
        turnType: "clarification_answer",
        interpretation: interpretation({
          unresolvedFields: ["scheduleFields.time"],
        }),
      }),
    );

    expect(result.needsClarification).toContain("scheduleFields.time");
  });

  it("derives missingFields from operationKind after merge", () => {
    const result = applyWriteCommit(
      buildInput({
        turnType: "clarification_answer",
        interpretation: interpretation({
          operationKind: "plan",
          fields: { scheduleFields: { time: t(17, 0) } },
          confidence: { "scheduleFields.time": 0.9 },
        }),
        priorPendingWriteOperation: priorOp("plan", { day: "tomorrow" }),
      }),
    );

    expect(result.missingFields).toEqual([]);
    expect(result.resolvedFields.scheduleFields).toEqual({
      day: "tomorrow",
      time: t(17, 0),
    });
  });

  it("reports all required fields as missing when nothing is committed", () => {
    const result = applyWriteCommit(buildInput({}));

    expect(result.missingFields).toEqual([
      "scheduleFields.day",
      "scheduleFields.time",
    ]);
  });

  it("resets prior state when operation kind changes", () => {
    const result = applyWriteCommit(
      buildInput({
        interpretation: interpretation({
          operationKind: "edit",
          fields: { scheduleFields: { day: "friday" } },
          confidence: { "scheduleFields.day": 0.9 },
        }),
        priorPendingWriteOperation: priorOp("plan", {
          time: t(14, 0),
          day: "tomorrow",
        }),
      }),
    );

    expect(result.workflowChanged).toBe(true);
    expect(result.resolvedFields.scheduleFields?.time).toBeUndefined();
    expect(result.resolvedFields.scheduleFields?.day).toBe("friday");
  });

  it("resets prior state when target changes", () => {
    const result = applyWriteCommit(
      buildInput({
        interpretation: interpretation({
          fields: { scheduleFields: { day: "friday" } },
          confidence: { "scheduleFields.day": 0.9 },
        }),
        currentTargetEntityId: "task-xyz",
        priorPendingWriteOperation: priorOp(
          "plan",
          { time: t(14, 0) },
          "task-abc",
        ),
      }),
    );

    expect(result.workflowChanged).toBe(true);
    expect(result.resolvedTargetRef).toEqual({ entityId: "task-xyz" });
    expect(result.resolvedFields.scheduleFields?.time).toBeUndefined();
  });

  it("commits task fields using grouped field paths", () => {
    const result = applyWriteCommit(
      buildInput({
        interpretation: interpretation({
          fields: { taskFields: { label: "Deep work", priority: "high" } },
          confidence: {
            "taskFields.label": 0.95,
            "taskFields.priority": 0.85,
          },
        }),
      }),
    );

    expect(result.resolvedFields.taskFields).toEqual({
      label: "Deep work",
      priority: "high",
    });
  });
});
