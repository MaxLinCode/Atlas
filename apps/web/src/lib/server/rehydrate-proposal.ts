import type { ConversationEntity, PendingWriteOperation } from "@atlas/core";

type ProposalEntity = Extract<ConversationEntity, { kind: "proposal_option" }>;

export function rehydratePendingWriteFromProposal(
  proposal: ProposalEntity,
): PendingWriteOperation | null {
  const { data } = proposal;

  if (!data.operationKind) {
    return null;
  }

  return {
    operationKind: data.operationKind,
    targetRef: {
      entityId: data.targetEntityId ?? null,
      description: proposal.label,
      entityKind: null,
    },
    resolvedFields: data.fieldSnapshot,
    missingFields: data.missingFields ?? [],
    originatingText: data.originatingTurnText ?? proposal.label,
    startedAt: proposal.createdAt,
  };
}
