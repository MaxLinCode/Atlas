import { describe, expect, it } from "vitest";
import { rehydratePendingWriteFromProposal } from "./rehydrate-proposal";

describe("rehydratePendingWriteFromProposal", () => {
  const baseProposal = {
    id: "prop-1",
    conversationId: "conv-1",
    kind: "proposal_option" as const,
    label: "Schedule gym",
    status: "active" as const,
    createdAt: "2026-04-05T10:00:00Z",
    updatedAt: "2026-04-05T10:00:00Z",
    data: {
      route: "conversation_then_mutation" as const,
      replyText: "Schedule gym at 5pm?",
      fieldSnapshot: {
        scheduleFields: { day: "2026-04-06", time: { hour: 17, minute: 0 }, duration: 60 },
        taskFields: { priority: "medium" },
      },
      targetEntityId: "task-123",
      operationKind: "plan" as const,
      originatingTurnText: "schedule gym tomorrow at 5pm",
    },
  };

  it("rehydrates PendingWriteOperation from proposal with all fields", () => {
    const result = rehydratePendingWriteFromProposal(baseProposal);

    expect(result).not.toBeNull();
    expect(result!.operationKind).toBe("plan");
    expect(result!.targetRef).toEqual({
      entityId: "task-123",
      description: "Schedule gym",
      entityKind: null,
    });
    expect(result!.resolvedFields).toEqual(baseProposal.data.fieldSnapshot);
    expect(result!.originatingText).toBe("schedule gym tomorrow at 5pm");
    expect(result!.missingFields).toEqual([]);
  });

  it("returns null when proposal has no operationKind", () => {
    const proposal = {
      ...baseProposal,
      data: { ...baseProposal.data, operationKind: undefined },
    };
    const result = rehydratePendingWriteFromProposal(proposal as any);
    expect(result).toBeNull();
  });

  it("handles proposal with missing targetEntityId (new task)", () => {
    const proposal = {
      ...baseProposal,
      data: { ...baseProposal.data, targetEntityId: null },
    };
    const result = rehydratePendingWriteFromProposal(proposal);

    expect(result).not.toBeNull();
    expect(result!.targetRef).toEqual({
      entityId: null,
      description: "Schedule gym",
      entityKind: null,
    });
  });

  it("preserves missingFields from proposal data", () => {
    const proposal = {
      ...baseProposal,
      data: { ...baseProposal.data, missingFields: ["duration"] },
    };
    const result = rehydratePendingWriteFromProposal(proposal);

    expect(result).not.toBeNull();
    expect(result!.missingFields).toEqual(["duration"]);
  });
});
