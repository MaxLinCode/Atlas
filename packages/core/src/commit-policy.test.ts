import { describe, expect, it } from "vitest";

import type { CommitPolicyInput } from "./commit-policy";
import { applyCommitPolicy } from "./commit-policy";
import type { TimeSpec, WriteContract } from "./index";

function t(hour: number, minute: number): TimeSpec {
  return { kind: "absolute", hour, minute };
}

const defaultContract: WriteContract = {
  requiredSlots: ["day", "time"],
  intentKind: "plan",
};

function buildInput(overrides: Partial<CommitPolicyInput>): CommitPolicyInput {
  return {
    turnType: "planning_request",
    extractedValues: {},
    confidence: {},
    unresolvable: [],
    priorResolvedSlots: {},
    activeContract: defaultContract,
    ...overrides,
  };
}

describe("applyCommitPolicy", () => {
  it("does not commit slots for informational turns", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "informational",
        extractedValues: { time: t(15, 0) },
        confidence: { time: 0.95 },
      }),
    );

    expect(result.committedSlots.time).toBeUndefined();
  });

  it("does not commit slots for confirmation turns", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "confirmation",
        extractedValues: { time: t(15, 0) },
        confidence: { time: 0.95 },
      }),
    );

    expect(result.committedSlots.time).toBeUndefined();
  });

  it("commits slots above confidence threshold for planning_request", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "planning_request",
        extractedValues: { time: t(17, 0), day: "tomorrow" },
        confidence: { time: 0.9, day: 0.85 },
      }),
    );

    expect(result.committedSlots.time).toEqual(t(17, 0));
    expect(result.committedSlots.day).toBe("tomorrow");
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

    expect(result.committedSlots.time).toBeUndefined();
    expect(result.needsClarification).toContain("time");
  });

  it("does not commit correction below correction threshold", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "clarification_answer",
        extractedValues: { time: t(15, 0) },
        confidence: { time: 0.8 },
        priorResolvedSlots: { time: t(14, 0) },
      }),
    );

    expect(result.committedSlots.time).toEqual(t(14, 0));
    expect(result.needsClarification).toContain("time");
  });

  it("commits correction at or above correction threshold", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "clarification_answer",
        extractedValues: { time: t(15, 0) },
        confidence: { time: 0.92 },
        priorResolvedSlots: { time: t(14, 0) },
      }),
    );

    expect(result.committedSlots.time).toEqual(t(15, 0));
    expect(result.needsClarification).not.toContain("time");
  });

  it("routes unresolvable slots to needsClarification", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "clarification_answer",
        extractedValues: {},
        unresolvable: ["time"],
      }),
    );

    expect(result.committedSlots.time).toBeUndefined();
    expect(result.needsClarification).toContain("time");
  });

  it("resets prior slots on contract change", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "planning_request",
        extractedValues: { day: "friday" },
        confidence: { day: 0.9 },
        priorResolvedSlots: { time: t(14, 0), day: "tomorrow" },
        activeContract: { requiredSlots: ["day", "time"], intentKind: "edit" },
        priorContract: { requiredSlots: ["day", "time"], intentKind: "plan" },
      }),
    );

    expect(result.committedSlots.time).toBeUndefined();
    expect(result.committedSlots.day).toBe("friday");
  });

  it("does not reset slots when contract intentKind is unchanged", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "planning_request",
        extractedValues: { day: "friday" },
        confidence: { day: 0.9 },
        priorResolvedSlots: { time: t(14, 0) },
        activeContract: { requiredSlots: ["day", "time"], intentKind: "plan" },
        priorContract: { requiredSlots: ["day"], intentKind: "plan" },
      }),
    );

    expect(result.committedSlots.time).toEqual(t(14, 0));
    expect(result.committedSlots.day).toBe("friday");
  });

  it("derives missingSlots from post-commit state", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "planning_request",
        extractedValues: { day: "tomorrow" },
        confidence: { day: 0.9 },
        activeContract: { requiredSlots: ["day", "time"], intentKind: "plan" },
      }),
    );

    expect(result.missingSlots).toEqual(["time"]);
    expect(result.missingSlots).not.toContain("day");
  });

  it("reports all required slots as missing when nothing is committed", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "planning_request",
        extractedValues: {},
        activeContract: {
          requiredSlots: ["day", "time", "target"],
          intentKind: "plan",
        },
      }),
    );

    expect(result.missingSlots).toEqual(["day", "time", "target"]);
  });

  it("preserves prior resolved slots when new turn adds more", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "clarification_answer",
        extractedValues: { time: t(17, 0) },
        confidence: { time: 0.9 },
        priorResolvedSlots: { day: "tomorrow" },
      }),
    );

    expect(result.committedSlots.day).toBe("tomorrow");
    expect(result.committedSlots.time).toEqual(t(17, 0));
  });

  it("commits slots for edit_request turn type", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "edit_request",
        extractedValues: { time: t(10, 0) },
        confidence: { time: 0.88 },
        activeContract: { requiredSlots: ["time"], intentKind: "edit" },
      }),
    );

    expect(result.committedSlots.time).toEqual(t(10, 0));
    expect(result.missingSlots).toEqual([]);
  });

  it("treats missing confidence as zero", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "planning_request",
        extractedValues: { time: t(17, 0) },
        confidence: {},
      }),
    );

    expect(result.committedSlots.time).toBeUndefined();
    expect(result.needsClarification).toContain("time");
  });

  it("does not flag unresolvable slot that is already resolved from prior turn", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "clarification_answer",
        extractedValues: { day: "friday" },
        confidence: { day: 0.9 },
        unresolvable: ["time"],
        priorResolvedSlots: { time: t(14, 0) },
      }),
    );

    expect(result.committedSlots.time).toEqual(t(14, 0));
    expect(result.needsClarification).not.toContain("time");
    expect(result.committedSlots.day).toBe("friday");
  });

  it("handles unresolvable slots not in extractedValues", () => {
    const result = applyCommitPolicy(
      buildInput({
        turnType: "clarification_answer",
        extractedValues: { day: "friday" },
        confidence: { day: 0.9 },
        unresolvable: ["time"],
      }),
    );

    expect(result.committedSlots.day).toBe("friday");
    expect(result.needsClarification).toContain("time");
  });
});
