import { describe, expect, it } from "vitest";

import type { CommitPolicyInput } from "./commit-policy";
import { applyCommitPolicy } from "./commit-policy";
import type { PendingWriteOperation, TimeSpec } from "./index";

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

function buildInput(overrides: Partial<CommitPolicyInput>): CommitPolicyInput {
  return {
    turnType: "planning_request",
    extractedValues: {},
    confidence: {},
    unresolvable: [],
    operationKind: "plan",
    ...overrides,
  };
}

describe("applyCommitPolicy", () => {
  it("does not commit fields for informational turns", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "informational",
        extractedValues: { time: t(15, 0) },
        confidence: { time: 0.95 },
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toBeUndefined();
  });

  it("does not commit fields for confirmation turns", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "confirmation",
        extractedValues: { time: t(15, 0) },
        confidence: { time: 0.95 },
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toBeUndefined();
  });

  it("commits fields above confidence threshold for planning_request", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "planning_request",
        extractedValues: { time: t(17, 0), day: "tomorrow" },
        confidence: { time: 0.9, day: 0.85 },
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toEqual(t(17, 0));
    expect(result.resolvedFields.scheduleFields?.day).toBe("tomorrow");
    expect(result.needsClarification).toEqual([]);
  });

  it("routes low confidence extraction to needsClarification", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "planning_request",
        extractedValues: { time: t(17, 0) },
        confidence: { time: 0.6 },
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toBeUndefined();
    expect(result.needsClarification).toContain("scheduleFields.time");
  });

  it("does not commit correction below correction threshold", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "clarification_answer",
        extractedValues: { time: t(15, 0) },
        confidence: { time: 0.8 },
        priorPendingWriteOperation: priorOp("plan", { time: t(14, 0) }),
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toEqual(t(14, 0));
    expect(result.needsClarification).toContain("scheduleFields.time");
  });

  it("commits correction at or above correction threshold", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "clarification_answer",
        extractedValues: { time: t(15, 0) },
        confidence: { time: 0.92 },
        priorPendingWriteOperation: priorOp("plan", { time: t(14, 0) }),
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toEqual(t(15, 0));
    expect(result.needsClarification).not.toContain("scheduleFields.time");
  });

  it("routes unresolvable fields to needsClarification", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "clarification_answer",
        extractedValues: {},
        unresolvable: ["time"],
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toBeUndefined();
    expect(result.needsClarification).toContain("scheduleFields.time");
  });

  it("resets prior fields on operation kind change", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "planning_request",
        extractedValues: { day: "friday" },
        confidence: { day: 0.9 },
        operationKind: "edit",
        priorPendingWriteOperation: priorOp("plan", {
          time: t(14, 0),
          day: "tomorrow",
        }),
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toBeUndefined();
    expect(result.resolvedFields.scheduleFields?.day).toBe("friday");
  });

  it("does not reset fields when operation kind is unchanged", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "planning_request",
        extractedValues: { day: "friday" },
        confidence: { day: 0.9 },
        operationKind: "plan",
        priorPendingWriteOperation: priorOp("plan", { time: t(14, 0) }),
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toEqual(t(14, 0));
    expect(result.resolvedFields.scheduleFields?.day).toBe("friday");
  });

  it("derives missingFields from post-commit state for plan", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "planning_request",
        extractedValues: { day: "tomorrow" },
        confidence: { day: 0.9 },
        operationKind: "plan",
      }),
    );

    expect(result.missingFields).toContain("scheduleFields.time");
    expect(result.missingFields).not.toContain("scheduleFields.day");
  });

  it("reports all required fields as missing when nothing is committed", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "planning_request",
        extractedValues: {},
        operationKind: "plan",
      }),
    );

    expect(result.missingFields).toContain("scheduleFields.day");
    expect(result.missingFields).toContain("scheduleFields.time");
  });

  it("preserves prior resolved fields when new turn adds more", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "clarification_answer",
        extractedValues: { time: t(17, 0) },
        confidence: { time: 0.9 },
        priorPendingWriteOperation: priorOp("plan", { day: "tomorrow" }),
      }),
    );

    expect(result.resolvedFields.scheduleFields?.day).toBe("tomorrow");
    expect(result.resolvedFields.scheduleFields?.time).toEqual(t(17, 0));
  });

  it("commits fields for edit_request turn type", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "edit_request",
        extractedValues: { time: t(10, 0) },
        confidence: { time: 0.88 },
        operationKind: "edit",
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toEqual(t(10, 0));
    expect(result.missingFields).toEqual([]);
  });

  it("treats missing confidence as zero", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "planning_request",
        extractedValues: { time: t(17, 0) },
        confidence: {},
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toBeUndefined();
    expect(result.needsClarification).toContain("scheduleFields.time");
  });

  it("does not flag an unresolvable field that is already resolved from prior turn", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "clarification_answer",
        extractedValues: { day: "friday" },
        confidence: { day: 0.9 },
        unresolvable: ["time"],
        priorPendingWriteOperation: priorOp("plan", { time: t(14, 0) }),
      }),
    );

    expect(result.resolvedFields.scheduleFields?.time).toEqual(t(14, 0));
    expect(result.needsClarification).not.toContain("scheduleFields.time");
    expect(result.resolvedFields.scheduleFields?.day).toBe("friday");
  });

  it("handles unresolvable fields not in extractedValues", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "clarification_answer",
        extractedValues: { day: "friday" },
        confidence: { day: 0.9 },
        unresolvable: ["time"],
      }),
    );

    expect(result.resolvedFields.scheduleFields?.day).toBe("friday");
    expect(result.needsClarification).toContain("scheduleFields.time");
  });

  it("sets resolvedTargetRef from currentTargetEntityId when no prior operation", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "planning_request",
        currentTargetEntityId: "task-abc",
      }),
    );

    expect(result.resolvedTargetRef).toEqual({ entityId: "task-abc" });
    expect(result.workflowChanged).toBe(false);
  });

  it("carries forward prior targetRef when no new entity is resolved", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "clarification_answer",
        priorPendingWriteOperation: priorOp(
          "plan",
          { day: "tomorrow" },
          "task-abc",
        ),
      }),
    );

    expect(result.resolvedTargetRef).toEqual({ entityId: "task-abc" });
    expect(result.workflowChanged).toBe(false);
  });

  it("clears prior schedule fields and sets workflowChanged when target changes", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "planning_request",
        extractedValues: { day: "friday" },
        confidence: { day: 0.9 },
        currentTargetEntityId: "task-xyz",
        priorPendingWriteOperation: priorOp(
          "plan",
          { time: t(14, 0) },
          "task-abc",
        ),
      }),
    );

    expect(result.resolvedTargetRef).toEqual({ entityId: "task-xyz" });
    expect(result.workflowChanged).toBe(true);
    expect(result.resolvedFields.scheduleFields?.time).toBeUndefined();
    expect(result.resolvedFields.scheduleFields?.day).toBe("friday");
  });

  it("does not set workflowChanged when target is the same entity", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "clarification_answer",
        extractedValues: { time: t(17, 0) },
        confidence: { time: 0.9 },
        currentTargetEntityId: "task-abc",
        priorPendingWriteOperation: priorOp(
          "plan",
          { day: "tomorrow" },
          "task-abc",
        ),
      }),
    );

    expect(result.resolvedTargetRef).toEqual({ entityId: "task-abc" });
    expect(result.workflowChanged).toBe(false);
    expect(result.resolvedFields.scheduleFields?.day).toBe("tomorrow");
    expect(result.resolvedFields.scheduleFields?.time).toEqual(t(17, 0));
  });
});
