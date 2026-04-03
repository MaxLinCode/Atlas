import type { ConversationDiscourseState } from "./discourse-state";
import type { ConversationEntity, Task } from "./index";

export type EntityContextEntry = {
  id: string;
  label: string;
  expectedType:
    | "task"
    | "proposal"
    | "clarification"
    | "scheduled_block"
    | "reminder";
  state: string;
};

export type EntityContext = {
  knownEntities: EntityContextEntry[];
  focusedEntityId: string | null;
  activeProposal: { id: string; summary: string; missingFields?: string[] } | null;
  openClarification: { id: string; prompt: string } | null;
};

type BuildEntityContextInput = {
  entityRegistry: ConversationEntity[];
  tasks: Task[];
  discourseState: ConversationDiscourseState | null;
};

const INACTIVE_TASK_STATES = new Set(["done", "archived"]);
const INACTIVE_PROPOSAL_STATES = new Set(["resolved", "superseded"]);

export function buildEntityContext(
  input: BuildEntityContextInput,
): EntityContext {
  const registryTaskIds = new Set(
    input.entityRegistry
      .filter(
        (entity): entity is Extract<ConversationEntity, { kind: "task" }> =>
          entity.kind === "task",
      )
      .map((entity) => entity.data.taskId),
  );

  const knownEntities: EntityContextEntry[] = [];

  for (const entity of input.entityRegistry) {
    switch (entity.kind) {
      case "task":
        if (!INACTIVE_TASK_STATES.has(entity.data.lifecycleState)) {
          knownEntities.push({
            id: entity.id,
            label: entity.data.title,
            expectedType: "task",
            state: entity.data.lifecycleState,
          });
        }
        break;
      case "proposal_option":
        if (!INACTIVE_PROPOSAL_STATES.has(entity.status)) {
          knownEntities.push({
            id: entity.id,
            label:
              entity.data.originatingTurnText ??
              entity.data.replyText ??
              entity.label,
            expectedType: "proposal",
            state: entity.status,
          });
        }
        break;
      case "clarification":
        if (entity.data.open) {
          knownEntities.push({
            id: entity.id,
            label: entity.data.prompt,
            expectedType: "clarification",
            state: "open",
          });
        }
        break;
      case "scheduled_block":
        knownEntities.push({
          id: entity.id,
          label: entity.data.title,
          expectedType: "scheduled_block",
          state: "scheduled",
        });
        break;
      case "reminder":
        knownEntities.push({
          id: entity.id,
          label: entity.data.title,
          expectedType: "reminder",
          state: entity.status,
        });
        break;
    }
  }

  for (const task of input.tasks) {
    if (
      !registryTaskIds.has(task.id) &&
      !INACTIVE_TASK_STATES.has(task.lifecycleState)
    ) {
      knownEntities.push({
        id: task.id,
        label: task.title,
        expectedType: "task",
        state: task.lifecycleState,
      });
    }
  }

  knownEntities.sort(
    (left, right) =>
      left.expectedType.localeCompare(right.expectedType) ||
      left.label.localeCompare(right.label) ||
      left.id.localeCompare(right.id),
  );

  const knownEntityIds = new Set(knownEntities.map((entity) => entity.id));
  const focusedEntityId =
    input.discourseState?.focus_entity_id &&
    knownEntityIds.has(input.discourseState.focus_entity_id)
      ? input.discourseState.focus_entity_id
      : null;

  const activeProposals = input.entityRegistry.filter(
    (
      entity,
    ): entity is Extract<ConversationEntity, { kind: "proposal_option" }> =>
      entity.kind === "proposal_option" &&
      !INACTIVE_PROPOSAL_STATES.has(entity.status),
  );
  const singleActiveProposal =
    activeProposals.length === 1 ? activeProposals[0] : null;
  const activeProposal =
    singleActiveProposal
      ? {
          id: singleActiveProposal.id,
          summary:
            singleActiveProposal.data.originatingTurnText ??
            singleActiveProposal.data.replyText,
          ...(singleActiveProposal.data.missingFields?.length
            ? { missingFields: singleActiveProposal.data.missingFields }
            : {}),
        }
      : null;

  const openClarifications = input.entityRegistry.filter(
    (
      entity,
    ): entity is Extract<ConversationEntity, { kind: "clarification" }> =>
      entity.kind === "clarification" && entity.data.open,
  );
  const singleOpenClarification =
    openClarifications.length === 1 ? openClarifications[0] : null;
  const openClarification =
    singleOpenClarification
      ? {
          id: singleOpenClarification.id,
          prompt: singleOpenClarification.data.prompt,
        }
      : null;

  return {
    knownEntities,
    focusedEntityId,
    activeProposal,
    openClarification,
  };
}
