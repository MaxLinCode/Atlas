import { describe, expect, it } from "vitest";

import type { WriteContract } from "./index";
import { DEFAULT_WRITE_CONTRACT, resolveWriteContract } from "./write-contract";

describe("resolveWriteContract", () => {
  it("returns the default plan contract for planning_request", () => {
    expect(resolveWriteContract({ turnType: "planning_request" })).toEqual(
      DEFAULT_WRITE_CONTRACT,
    );
  });

  it("returns an edit contract for edit_request", () => {
    const result = resolveWriteContract({ turnType: "edit_request" });
    expect(result).toEqual({
      requiredSlots: ["time"],
      intentKind: "edit",
    });
  });

  it("carries forward priorContract for clarification_answer", () => {
    const prior: WriteContract = {
      requiredSlots: ["day", "time"],
      intentKind: "plan",
    };
    expect(
      resolveWriteContract({
        turnType: "clarification_answer",
        priorContract: prior,
      }),
    ).toBe(prior);
  });

  it("carries forward priorContract for confirmation", () => {
    const prior: WriteContract = {
      requiredSlots: ["time"],
      intentKind: "edit",
    };
    expect(
      resolveWriteContract({ turnType: "confirmation", priorContract: prior }),
    ).toBe(prior);
  });

  it("carries forward priorContract for follow_up_reply", () => {
    const prior: WriteContract = {
      requiredSlots: ["day", "time"],
      intentKind: "plan",
    };
    expect(
      resolveWriteContract({
        turnType: "follow_up_reply",
        priorContract: prior,
      }),
    ).toBe(prior);
  });

  it("carries forward priorContract for informational", () => {
    const prior: WriteContract = {
      requiredSlots: ["day", "time"],
      intentKind: "plan",
    };
    expect(
      resolveWriteContract({ turnType: "informational", priorContract: prior }),
    ).toBe(prior);
  });

  it("carries forward priorContract for unknown", () => {
    const prior: WriteContract = {
      requiredSlots: ["day", "time"],
      intentKind: "plan",
    };
    expect(
      resolveWriteContract({ turnType: "unknown", priorContract: prior }),
    ).toBe(prior);
  });

  it("returns undefined for carry-forward turn types with no prior contract", () => {
    expect(
      resolveWriteContract({ turnType: "clarification_answer" }),
    ).toBeUndefined();
    expect(resolveWriteContract({ turnType: "confirmation" })).toBeUndefined();
    expect(resolveWriteContract({ turnType: "informational" })).toBeUndefined();
    expect(resolveWriteContract({ turnType: "unknown" })).toBeUndefined();
  });

  it("ignores priorContract for planning_request — always returns fresh plan contract", () => {
    const prior: WriteContract = {
      requiredSlots: ["time"],
      intentKind: "edit",
    };
    const result = resolveWriteContract({
      turnType: "planning_request",
      priorContract: prior,
    });
    expect(result).toEqual(DEFAULT_WRITE_CONTRACT);
    expect(result).not.toBe(prior);
  });

  it("ignores priorContract for edit_request — always returns fresh edit contract", () => {
    const prior: WriteContract = {
      requiredSlots: ["day", "time"],
      intentKind: "plan",
    };
    const result = resolveWriteContract({
      turnType: "edit_request",
      priorContract: prior,
    });
    expect(result?.intentKind).toBe("edit");
    expect(result).not.toBe(prior);
  });
});
