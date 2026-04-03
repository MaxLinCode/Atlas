import { describe, expect, it } from "vitest";

import {
  buildEntityContext,
  renderEntityContext,
  type ConversationEntity,
  type Task,
} from "./index";

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    userId: "user-1",
    sourceInboxItemId: "inbox-1",
    lastInboxItemId: "inbox-1",
    title: "Gym session",
    lifecycleState: "pending_schedule",
    externalCalendarEventId: null,
    externalCalendarId: null,
    scheduledStartAt: null,
    scheduledEndAt: null,
    calendarSyncStatus: "in_sync",
    calendarSyncUpdatedAt: null,
    rescheduleCount: 0,
    lastFollowupAt: null,
    followupReminderSentAt: null,
    completedAt: null,
    archivedAt: null,
    priority: "medium",
    urgency: "medium",
    ...overrides,
  };
}

function buildEntity(
  overrides: Partial<ConversationEntity>,
): ConversationEntity {
  return {
    id: "entity-1",
    conversationId: "conversation-1",
    label: "Entity label",
    status: "active",
    createdAt: "2026-04-01T15:00:00.000Z",
    updatedAt: "2026-04-01T15:00:00.000Z",
    kind: "task",
    data: {
      taskId: "task-1",
      title: "Gym session",
      lifecycleState: "pending_schedule",
      scheduledStartAt: null,
      scheduledEndAt: null,
    },
    ...overrides,
  } as ConversationEntity;
}

describe("entity context", () => {
  it("builds filtered known entities and derives focus, proposal, and clarification helpers", () => {
    const context = buildEntityContext({
      entityRegistry: [
        buildEntity({
          id: "task-entity-1",
          label: "Gym session",
          kind: "task",
          data: {
            taskId: "task-1",
            title: "Gym session",
            lifecycleState: "scheduled",
            scheduledStartAt: "2026-04-02T01:00:00.000Z",
            scheduledEndAt: "2026-04-02T02:00:00.000Z",
          },
        }),
        buildEntity({
          id: "proposal-1",
          label: "Schedule gym tomorrow at 6pm",
          kind: "proposal_option",
          status: "presented",
          data: {
            route: "conversation_then_mutation",
            replyText: "Would you like me to schedule it at 6pm?",
            confirmationRequired: true,
            targetEntityId: "task-entity-1",
            mutationInputSource: null,
            originatingTurnText: "Schedule gym tomorrow at 6pm",
            missingFields: ["scheduleFields.time"],
            fieldSnapshot: {},
          },
        }),
        buildEntity({
          id: "clarification-1",
          label: "What time?",
          kind: "clarification",
          data: {
            prompt: "What time should I schedule it?",
            reason: null,
            open: true,
          },
        }),
        buildEntity({
          id: "block-1",
          label: "Write blog post",
          kind: "scheduled_block",
          data: {
            blockId: "block-db-1",
            taskId: "task-2",
            title: "Write blog post",
            startAt: "2026-04-02T03:00:00.000Z",
            endAt: "2026-04-02T04:00:00.000Z",
            externalCalendarId: "primary",
          },
        }),
        buildEntity({
          id: "reminder-1",
          label: "Review taxes",
          kind: "reminder",
          status: "active",
          data: {
            taskId: "task-3",
            title: "Review taxes",
            reminderKind: "reminder",
            number: 1,
          },
        }),
        // These should be filtered out:
        buildEntity({
          id: "done-task",
          label: "Completed task",
          kind: "task",
          data: {
            taskId: "task-done",
            title: "Completed task",
            lifecycleState: "done",
            scheduledStartAt: null,
            scheduledEndAt: null,
          },
        }),
        buildEntity({
          id: "resolved-proposal",
          label: "Old proposal",
          kind: "proposal_option",
          status: "resolved",
          data: {
            route: "conversation_then_mutation",
            replyText: "Old proposal",
            confirmationRequired: true,
            targetEntityId: null,
            mutationInputSource: null,
            fieldSnapshot: {},
          },
        }),
        buildEntity({
          id: "closed-clarification",
          label: "Closed clarification",
          kind: "clarification",
          data: {
            prompt: "Closed clarification",
            reason: null,
            open: false,
          },
        }),
      ],
      tasks: [
        buildTask({ id: "task-1", title: "Gym session duplicate" }), // matches registry by taskId, should be deduplicated
        buildTask({
          id: "task-2",
          title: "Weekly review",
          lifecycleState: "awaiting_followup",
          externalCalendarEventId: "event-1",
          externalCalendarId: "primary",
          scheduledStartAt: "2026-04-02T05:00:00.000Z",
          scheduledEndAt: "2026-04-02T06:00:00.000Z",
        }),
      ],
      discourseState: {
        focus_entity_id: "task-entity-1",
        currently_editable_entity_id: null,
        last_user_mentioned_entity_ids: [],
        last_presented_items: [],
        pending_clarifications: [],
        mode: "planning",
      },
    });

    // Sorted by expectedType then label then id
    expect(context.knownEntities).toEqual([
      { id: "clarification-1", label: "What time should I schedule it?", expectedType: "clarification", state: "open" },
      { id: "proposal-1", label: "Schedule gym tomorrow at 6pm", expectedType: "proposal", state: "presented" },
      { id: "reminder-1", label: "Review taxes", expectedType: "reminder", state: "active" },
      { id: "block-1", label: "Write blog post", expectedType: "scheduled_block", state: "scheduled" },
      { id: "task-entity-1", label: "Gym session", expectedType: "task", state: "scheduled" },
      { id: "task-2", label: "Weekly review", expectedType: "task", state: "awaiting_followup" },
    ]);
    expect(context.focusedEntityId).toBe("task-entity-1");
    expect(context.activeProposal).toEqual({
      id: "proposal-1",
      summary: "Schedule gym tomorrow at 6pm",
      missingFields: ["scheduleFields.time"],
    });
    expect(context.openClarification).toEqual({
      id: "clarification-1",
      prompt: "What time should I schedule it?",
    });
  });

  it("renders deterministic prompt text with explicit empty sections", () => {
    const rendered = renderEntityContext({
      knownEntities: [
        {
          id: "task-1",
          label: "Gym session",
          expectedType: "task",
          state: "scheduled",
        },
      ],
      focusedEntityId: "task-1",
      activeProposal: null,
      openClarification: null,
    });

    expect(rendered).toBe(
      'Known entities:\n- "Gym session" (task, scheduled) [id: task-1]\n\nCurrently focused: "Gym session" [id: task-1]\n\nNo active proposal.\n\nNo open clarification.',
    );
  });

  it("renders an explicit no-known-entities line when the context is empty", () => {
    expect(
      renderEntityContext({
        knownEntities: [],
        focusedEntityId: null,
        activeProposal: null,
        openClarification: null,
      }),
    ).toBe(
      "Known entities:\nNo known entities.\n\nNo focused entity.\n\nNo active proposal.\n\nNo open clarification.",
    );
  });
});
