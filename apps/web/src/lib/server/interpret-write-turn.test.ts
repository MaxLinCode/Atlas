import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@atlas/integrations", () => ({
  interpretWriteTurnWithResponses: vi.fn(),
}));

import { interpretWriteTurnWithResponses } from "@atlas/integrations";

import { interpretWriteTurn } from "./interpret-write-turn";

const mockInterpretWriteTurnWithResponses = vi.mocked(
  interpretWriteTurnWithResponses,
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("interpretWriteTurn", () => {
  it("forwards entityContext to the integrations layer", async () => {
    mockInterpretWriteTurnWithResponses.mockResolvedValueOnce({
      operationKind: "plan",
      actionDomain: "task",
      targetRef: { entityId: "task-1", description: null, entityKind: null },
      taskName: null,
      fields: {
        scheduleFields: null,
        taskFields: null,
      },
      confidence: {},
      unresolvedFields: [],
    });

    await interpretWriteTurn({
      currentTurnText: "move gym",
      turnType: "edit_request",
      entityContext: 'Known entities:\n- "Gym" (task, scheduled) [id: task-1]',
    });

    expect(mockInterpretWriteTurnWithResponses).toHaveBeenCalledWith(
      expect.objectContaining({
        entityContext:
          'Known entities:\n- "Gym" (task, scheduled) [id: task-1]',
      }),
      undefined,
    );
  });

  it("falls back cleanly when the integrations layer returns malformed output", async () => {
    mockInterpretWriteTurnWithResponses.mockResolvedValueOnce({
      operationKind: "plan",
      actionDomain: "task",
      targetRef: null,
      taskName: null,
      fields: {
        scheduleFields: null,
        taskFields: null,
      },
      confidence: {
        bad: 2,
      },
      unresolvedFields: [],
    } as never);

    await expect(
      interpretWriteTurn({
        currentTurnText: "schedule gym",
        turnType: "planning_request",
      }),
    ).resolves.toMatchObject({
      operationKind: "plan",
      targetRef: null,
      sourceText: "schedule gym",
    });
  });
});
