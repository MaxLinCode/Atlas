import {
  applyWriteCommit,
  buildEntityContext,
  type ConversationDiscourseState,
  type ConversationEntity,
  type ConversationTurn,
  createEmptyDiscourseState,
  deriveAmbiguity,
  type PendingWriteOperation,
  renderEntityContext,
  type RoutedTurn,
  routedTurnSchema,
  taskSchema,
  type TurnAmbiguity,
  type TurnClassifierOutput,
  type TurnInterpretation,
  type TurnInterpretationType,
  type TurnPolicyAction,
  type TurnRoute,
  type TurnRoutingInput,
  type WriteCommitOutput,
  WRITE_INTERPRETING_TURN_TYPES,
} from "@atlas/core";

import { decideTurnPolicy } from "./decide-turn-policy";
import { classifyTurn } from "./llm-classifier";
import { interpretWriteTurn } from "./interpret-write-turn";

export type TurnRouterInput = TurnRoutingInput;
export type TurnRouterResult = RoutedTurn;

export type WriteTarget = {
  targetEntityId?: string;
  resolvedProposalId?: string;
};

export function resolveWriteTarget(
  discourseState: ConversationDiscourseState | null,
  entityRegistry: ConversationEntity[],
  turnType: TurnInterpretationType,
): WriteTarget {
  const resolvedEntityIds = compactResolvedEntityIds([
    discourseState?.currently_editable_entity_id ?? null,
    discourseState?.focus_entity_id ?? null,
  ]);

  const activeProposals = entityRegistry.filter(
    (e): e is Extract<ConversationEntity, { kind: "proposal_option" }> =>
      e.kind === "proposal_option" &&
      (e.status === "active" || e.status === "presented"),
  );
  const singleProposal =
    activeProposals.length === 1 ? activeProposals[0] : null;

  if (turnType === "confirmation" && singleProposal) {
    const entityId =
      singleProposal.data.targetEntityId ?? resolvedEntityIds[0];
    return {
      ...(entityId ? { targetEntityId: entityId } : {}),
      resolvedProposalId: singleProposal.id,
    };
  }

  return {
    ...(resolvedEntityIds[0] ? { targetEntityId: resolvedEntityIds[0] } : {}),
    ...(singleProposal ? { resolvedProposalId: singleProposal.id } : {}),
  };
}

function compactResolvedEntityIds(entityIds: Array<string | null>) {
  return Array.from(
    new Set(entityIds.filter((id): id is string => Boolean(id))),
  );
}

export async function routeMessageTurn(
  input: TurnRouterInput,
): Promise<TurnRouterResult> {
  const discourseState = input.discourseState ?? createEmptyDiscourseState();
  const entityRegistry = input.entityRegistry ?? [];
  const tasks = (input.tasks ?? []).map((task) => taskSchema.parse(task));

  // Pipeline A: classify intent
  let classification = await classifyTurn({
    normalizedText: input.normalizedText,
    discourseState,
    entityRegistry,
  });

  // Resolve entity targets from discourse state (not classifier)
  const writeTarget = resolveWriteTarget(
    discourseState,
    entityRegistry,
    classification.turnType,
  );

  // Guard: reclassify compound confirmations (confirmation + modification payload)
  // so field extraction runs and the edit is not silently dropped.
  // Scoped to active write/proposal context only.
  if (classification.turnType === "confirmation") {
    const hasActiveProposal = entityRegistry.some(
      (e: ConversationEntity) =>
        e.kind === "proposal_option" &&
        (e.status === "active" || e.status === "presented"),
    );

    if (
      hasActiveProposal &&
      containsModificationPayload(input.normalizedText)
    ) {
      classification = {
        ...classification,
        turnType: "clarification_answer",
      };
      delete writeTarget.resolvedProposalId;
    }
  }

  // Pipeline B: interpret write intent for write-capable turns only.
  const priorOperation = discourseState.pending_write_operation;
  const writeInterpretation = WRITE_INTERPRETING_TURN_TYPES.has(
    classification.turnType,
  )
    ? await interpretWriteTurn({
        currentTurnText: input.normalizedText,
        turnType: classification.turnType,
        priorPendingWriteOperation: priorOperation,
        conversationContext: deriveConversationContext(input.recentTurns),
        entityContext: renderEntityContext(
          buildEntityContext({
            entityRegistry,
            tasks,
            discourseState,
          }),
        ),
      })
    : {
        operationKind: priorOperation?.operationKind ?? "plan",
        actionDomain: "task",
        targetRef: priorOperation?.targetRef ?? null,
        taskName: null,
        fields: {},
        sourceText: input.normalizedText,
        confidence: {},
        unresolvedFields: [],
      };

  // Policy layer: commit + route
  const commitResult = applyWriteCommit({
    turnType: classification.turnType,
    interpretation: writeInterpretation,
    priorPendingWriteOperation: priorOperation,
    ...(writeTarget.targetEntityId !== undefined
      ? { currentTargetEntityId: writeTarget.targetEntityId }
      : {}),
  });

  const policy = decideTurnPolicy({
    classification,
    commitResult,
    routingContext: input,
    ...writeTarget,
  });

  // Assemble the resolved PendingWriteOperation for any turn that advances or maintains
  // a write workflow. reply_only turns must not create or overwrite pending_write_operation
  // in discourse state — they carry no write intent.
  const resolvedOperation =
    policy.action !== "reply_only"
      ? buildResolvedOperation(
          writeInterpretation.operationKind,
          commitResult,
          priorOperation,
          writeInterpretation.sourceText,
        )
      : undefined;

  // Build interpretation for backward compatibility
  const interpretation = buildInterpretation(
    classification,
    commitResult,
    writeTarget,
  );

  return routedTurnSchema.parse({
    interpretation,
    policy: { ...policy, resolvedOperation },
  });
}

function buildResolvedOperation(
  operationKind: PendingWriteOperation["operationKind"],
  commitResult: WriteCommitOutput,
  priorOperation: PendingWriteOperation | undefined,
  currentTurnText: string,
): PendingWriteOperation {
  const isNewWorkflow = commitResult.workflowChanged || !priorOperation;
  return {
    operationKind,
    targetRef: commitResult.resolvedTargetRef,
    resolvedFields: commitResult.resolvedFields,
    missingFields: commitResult.missingFields,
    originatingText: isNewWorkflow
      ? currentTurnText
      : priorOperation.originatingText,
    startedAt: isNewWorkflow
      ? new Date().toISOString()
      : priorOperation.startedAt,
  };
}

function deriveConversationContext(recentTurns: ConversationTurn[]): string {
  return recentTurns
    .slice(-5)
    .map((t) => `${t.role}: ${t.text}`)
    .join("\n");
}

function buildInterpretation(
  classification: TurnClassifierOutput,
  commitResult: WriteCommitOutput,
  writeTarget: WriteTarget,
): TurnInterpretation {
  const allMissingFields = unique([
    ...commitResult.missingFields,
    ...commitResult.needsClarification,
  ]);
  const ambiguity = deriveAmbiguity({
    classifierConfidence: classification.confidence,
    missingFields: commitResult.missingFields,
    needsClarification: commitResult.needsClarification,
  });

  const resolvedEntityIds = writeTarget.targetEntityId
    ? [writeTarget.targetEntityId]
    : [];

  return {
    turnType: classification.turnType,
    confidence: classification.confidence,
    resolvedEntityIds,
    ...(writeTarget.resolvedProposalId
      ? { resolvedProposalId: writeTarget.resolvedProposalId }
      : {}),
    ambiguity,
    ...(ambiguity !== "none"
      ? {
          ambiguityReason: deriveAmbiguityReason(
            classification.turnType,
            ambiguity,
          ),
        }
      : {}),
    ...(allMissingFields.length > 0 ? { missingFields: allMissingFields } : {}),
  };
}

function deriveAmbiguityReason(
  turnType: TurnInterpretation["turnType"],
  ambiguity: TurnAmbiguity,
): string {
  if (ambiguity === "high") {
    switch (turnType) {
      case "unknown":
        return "The turn did not map cleanly to a recognized intent pattern.";
      case "clarification_answer":
        return "Clarification answer classification has low confidence.";
      default:
        return "Classification confidence is too low for reliable routing.";
    }
  }

  return "Classification confidence is moderate.";
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

export function doesPolicyAllowWrites(action: TurnPolicyAction) {
  return action === "execute_mutation" || action === "recover_and_execute";
}

export function getConversationRouteForPolicy(
  action: TurnPolicyAction,
): Extract<TurnRoute, "conversation" | "conversation_then_mutation"> {
  return action === "reply_only"
    ? "conversation"
    : "conversation_then_mutation";
}

export function containsModificationPayload(text: string): boolean {
  const lower = text.toLowerCase();
  // Time patterns: "5pm", "17:00", "at 3"
  if (/\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)/i.test(lower)) return true;
  if (/\d{1,2}:\d{2}/.test(lower)) return true;
  if (/\bat\s+\d{1,2}\b/.test(lower)) return true;
  // Day patterns: "tomorrow", "friday", "next week"
  if (
    /\b(tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next\s+\w+)\b/.test(
      lower,
    )
  )
    return true;
  // Duration: "for 1 hour", "30 minutes"
  if (/\b\d+\s*(hour|minute|min|hr)s?\b/.test(lower)) return true;
  // Modification signals: "but", "change", "make it", "instead", "actually"
  if (
    /\b(but|change|make it|instead|switch|rather|actually|different)\b/.test(
      lower,
    )
  )
    return true;
  return false;
}
