import { describe, expect, it } from "vitest";

import {
  addPendingClarification,
  cleanupDiscourseState,
  createEmptyDiscourseState,
  deriveMode,
  getActivePendingClarifications,
  type PendingClarification,
  resolvePendingClarification,
  resolveReference,
  resolvedFieldsSchema,
  updateDiscourseStateFromAssistantTurn,
  updateDiscourseStateFromUserTurn,
} from "./discourse-state";

function buildClarification(
  input: Partial<PendingClarification> &
    Pick<PendingClarification, "id" | "slot" | "question">,
): PendingClarification {
  return {
    status: "pending",
    createdAt: "2026-03-22T10:00:00.000Z",
    createdTurnId: "assistant:turn-1",
    ...input,
  };
}

describe("discourse state", () => {
  it("resolves focus follow-ups through focus_entity_id", () => {
    const afterInitialTurn = updateDiscourseStateFromUserTurn(
      createEmptyDiscourseState(),
      {
        mentionedEntityIds: ["gym"],
        focusEntityId: "gym",
      },
    ).state;

    const resolution = resolveReference(afterInitialTurn, {});

    expect(afterInitialTurn.focus_entity_id).toBe("gym");
    expect(resolution).toEqual({
      status: "resolved",
      entityId: "gym",
      matchedBy: "focus",
    });
  });

  it("resolves editable follow-ups through currently_editable_entity_id", () => {
    const state = updateDiscourseStateFromAssistantTurn(
      createEmptyDiscourseState(),
      {
        editableEntityId: "taxes",
        focusEntityId: "taxes",
      },
    ).state;

    expect(resolveReference(state, {})).toEqual({
      status: "resolved",
      entityId: "taxes",
      matchedBy: "editable",
    });
  });

  it("resolves ordinal references from presented items", () => {
    const state = updateDiscourseStateFromAssistantTurn(
      createEmptyDiscourseState(),
      {
        presentedItems: [
          {
            id: "presented_1",
            type: "entity",
            entityId: "gym",
            ordinal: 1,
            label: "Gym at 6pm",
          },
          {
            id: "presented_2",
            type: "entity",
            entityId: "taxes",
            ordinal: 2,
            label: "Taxes at 8pm",
          },
        ],
      },
    ).state;

    expect(resolveReference(state, { ordinal: 2 })).toEqual({
      status: "resolved",
      entityId: "taxes",
      matchedBy: "ordinal",
    });
  });

  it("resolves the other one against the presented pair", () => {
    const state = updateDiscourseStateFromAssistantTurn(
      createEmptyDiscourseState(),
      {
        presentedItems: [
          {
            id: "presented_1",
            type: "entity",
            entityId: "gym",
            ordinal: 1,
            label: "Gym at 6pm",
          },
          {
            id: "presented_2",
            type: "entity",
            entityId: "taxes",
            ordinal: 2,
            label: "Taxes at 8pm",
          },
        ],
        focusEntityId: "gym",
      },
    ).state;

    expect(resolveReference(state, { refersToOther: true })).toEqual({
      status: "resolved",
      entityId: "taxes",
      matchedBy: "ordinal",
    });
  });

  it("prefers clarification context over generic focus", () => {
    const state = addPendingClarification(
      updateDiscourseStateFromAssistantTurn(createEmptyDiscourseState(), {
        focusEntityId: "taxes",
      }).state,
      buildClarification({
        id: "clar-1",
        entityId: "gym",
        slot: "time",
        question: "What time should gym be?",
      }),
    );

    expect(resolveReference(state, {})).toEqual({
      status: "resolved",
      entityId: "gym",
      clarificationId: "clar-1",
      matchedBy: "clarification",
    });
  });

  it("keeps multiple pending clarifications independently", () => {
    const withClarifications = updateDiscourseStateFromAssistantTurn(
      createEmptyDiscourseState(),
      {
        newClarifications: [
          buildClarification({
            id: "clar-gym",
            entityId: "gym",
            slot: "time",
            question: "What time for gym?",
          }),
          buildClarification({
            id: "clar-taxes",
            entityId: "taxes",
            slot: "duration",
            question: "How long for taxes?",
            createdAt: "2026-03-22T10:05:00.000Z",
          }),
        ],
      },
    ).state;

    const resolvedOne = resolvePendingClarification(
      withClarifications,
      "clar-gym",
    );

    expect(getActivePendingClarifications(resolvedOne)).toEqual([
      expect.objectContaining({
        id: "clar-taxes",
        entityId: "taxes",
        slot: "duration",
        status: "pending",
      }),
    ]);
    expect(resolvedOne.pending_clarifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "clar-gym", status: "resolved" }),
        expect.objectContaining({ id: "clar-taxes", status: "pending" }),
      ]),
    );
  });

  it("returns ambiguous when multiple candidates exist without stronger signals", () => {
    expect(
      resolveReference(createEmptyDiscourseState(), {
        candidateEntityIds: ["gym", "taxes"],
      }),
    ).toEqual({
      status: "ambiguous",
      candidates: ["gym", "taxes"],
    });
  });

  it("uses explicit state transitions for clarifying, confirming, editing, and planning", () => {
    const clarifying = updateDiscourseStateFromAssistantTurn(
      createEmptyDiscourseState(),
      {
        newClarifications: [
          buildClarification({
            id: "clar-1",
            entityId: "gym",
            slot: "time",
            question: "What time for gym?",
          }),
        ],
      },
    ).state;

    expect(clarifying.mode).toBe("clarifying");

    const confirming = updateDiscourseStateFromAssistantTurn(
      createEmptyDiscourseState(),
      {
        pendingConfirmation: true,
      },
    ).state;
    expect(confirming.mode).toBe("confirming");

    const editing = updateDiscourseStateFromAssistantTurn(
      createEmptyDiscourseState(),
      {
        editableEntityId: "taxes",
      },
    ).state;
    expect(editing.mode).toBe("editing");

    const resolved = updateDiscourseStateFromUserTurn(clarifying, {
      resolvedClarificationIds: ["clar-1"],
      editableEntityId: "gym",
    }).state;
    expect(resolved.mode).toBe("editing");

    expect(deriveMode(createEmptyDiscourseState())).toBe("planning");
  });

  it("cleans up stale pointers, replaces presented items, and bounds recency", () => {
    const prepared = updateDiscourseStateFromAssistantTurn(
      createEmptyDiscourseState(),
      {
        presentedItems: [
          { id: "presented_1", type: "entity", entityId: "gym", ordinal: 1 },
          { id: "presented_2", type: "entity", entityId: "taxes", ordinal: 2 },
        ],
        focusEntityId: "gym",
        editableEntityId: "taxes",
      },
    ).state;

    const withMentions = updateDiscourseStateFromUserTurn(prepared, {
      mentionedEntityIds: ["one", "two", "three", "four", "five", "six"],
    }).state;

    const replacedPresented = updateDiscourseStateFromAssistantTurn(
      withMentions,
      {
        presentedItems: [
          { id: "presented_3", type: "entity", entityId: "taxes", ordinal: 1 },
        ],
      },
    ).state;

    const cleaned = cleanupDiscourseState(replacedPresented, {
      validEntityIds: ["taxes", "six", "five", "four", "three", "two"],
    });

    expect(replacedPresented.last_presented_items).toEqual([
      expect.objectContaining({ id: "presented_3", entityId: "taxes" }),
    ]);
    expect(withMentions.last_user_mentioned_entity_ids).toEqual([
      "six",
      "five",
      "four",
      "three",
      "two",
    ]);
    expect(cleaned.focus_entity_id).toBeNull();
    expect(cleaned.currently_editable_entity_id).toBe("taxes");
  });
});

describe("resolvedFieldsSchema urgency", () => {
  it("accepts urgency in taskFields", () => {
    const result = resolvedFieldsSchema.parse({
      taskFields: { urgency: "high" },
    });
    expect(result.taskFields?.urgency).toBe("high");
  });

  it("rejects invalid urgency value", () => {
    expect(() =>
      resolvedFieldsSchema.parse({
        taskFields: { urgency: "critical" },
      }),
    ).toThrow();
  });
});
