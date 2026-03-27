import { describe, expect, it } from "vitest";

import { resolveOperationKind } from "./write-contract";

describe("resolveOperationKind", () => {
  it("returns 'plan' for planning_request", () => {
    expect(resolveOperationKind({ turnType: "planning_request" })).toBe("plan");
  });

  it("returns 'edit' for edit_request", () => {
    expect(resolveOperationKind({ turnType: "edit_request" })).toBe("edit");
  });

  it("carries forward priorOperationKind for clarification_answer", () => {
    expect(
      resolveOperationKind({
        turnType: "clarification_answer",
        priorOperationKind: "plan",
      }),
    ).toBe("plan");
  });

  it("carries forward priorOperationKind for confirmation", () => {
    expect(
      resolveOperationKind({
        turnType: "confirmation",
        priorOperationKind: "edit",
      }),
    ).toBe("edit");
  });

  it("carries forward priorOperationKind for follow_up_reply", () => {
    expect(
      resolveOperationKind({
        turnType: "follow_up_reply",
        priorOperationKind: "plan",
      }),
    ).toBe("plan");
  });

  it("carries forward priorOperationKind for informational", () => {
    expect(
      resolveOperationKind({
        turnType: "informational",
        priorOperationKind: "plan",
      }),
    ).toBe("plan");
  });

  it("carries forward priorOperationKind for unknown", () => {
    expect(
      resolveOperationKind({ turnType: "unknown", priorOperationKind: "plan" }),
    ).toBe("plan");
  });

  it("returns undefined for carry-forward turn types with no prior operation", () => {
    expect(
      resolveOperationKind({ turnType: "clarification_answer" }),
    ).toBeUndefined();
    expect(
      resolveOperationKind({ turnType: "confirmation" }),
    ).toBeUndefined();
    expect(
      resolveOperationKind({ turnType: "informational" }),
    ).toBeUndefined();
    expect(
      resolveOperationKind({ turnType: "unknown" }),
    ).toBeUndefined();
  });

  it("ignores priorOperationKind for planning_request — always returns 'plan'", () => {
    expect(
      resolveOperationKind({
        turnType: "planning_request",
        priorOperationKind: "edit",
      }),
    ).toBe("plan");
  });

  it("ignores priorOperationKind for edit_request — always returns 'edit'", () => {
    expect(
      resolveOperationKind({
        turnType: "edit_request",
        priorOperationKind: "plan",
      }),
    ).toBe("edit");
  });
});
