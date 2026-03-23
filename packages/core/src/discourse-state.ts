import { z } from "zod";

export const MAX_LAST_USER_MENTIONED_ENTITY_IDS = 5;

export const conversationModeSchema = z.enum([
  "planning",
  "editing",
  "clarifying",
  "confirming"
]);

export const presentedEntitySchema = z.object({
  id: z.string().min(1),
  type: z.literal("entity"),
  entityId: z.string().min(1),
  label: z.string().min(1).optional(),
  ordinal: z.number().int().positive().optional()
});

export const presentedOptionSchema = z.object({
  id: z.string().min(1),
  type: z.literal("option"),
  optionKey: z.string().min(1),
  label: z.string().min(1).optional(),
  ordinal: z.number().int().positive().optional(),
  linkedEntityId: z.string().min(1).optional(),
  payload: z.record(z.unknown()).optional()
});

export const presentedItemSchema = z.discriminatedUnion("type", [
  presentedEntitySchema,
  presentedOptionSchema
]);

export const pendingClarificationSchema = z.object({
  id: z.string().min(1),
  entityId: z.string().min(1).optional(),
  slot: z.string().min(1),
  question: z.string().min(1),
  status: z.enum(["pending", "resolved", "cancelled"]),
  createdAt: z.string().datetime(),
  createdTurnId: z.string().min(1),
  priority: z.number().int().optional()
});

export const resolvedSlotsSchema = z.object({
  day: z.string().optional(),
  time: z.string().optional(),
  duration: z.number().optional(),
  target: z.string().optional()
});

export type ResolvedSlots = z.infer<typeof resolvedSlotsSchema>;

export const writeContractSchema = z.object({
  requiredSlots: z.array(z.enum(["day", "time", "duration", "target"])),
  optionalSlots: z.array(z.enum(["day", "time", "duration", "target"])).optional(),
  intentKind: z.enum(["plan", "edit"])
});

export type WriteContract = z.infer<typeof writeContractSchema>;

export const discourseStateSchema = z.object({
  focus_entity_id: z.string().min(1).nullable(),
  currently_editable_entity_id: z.string().min(1).nullable(),
  last_user_mentioned_entity_ids: z.array(z.string().min(1)),
  last_presented_items: z.array(presentedItemSchema),
  pending_clarifications: z.array(pendingClarificationSchema),
  resolved_slots: resolvedSlotsSchema.optional(),
  pending_write_contract: writeContractSchema.optional(),
  mode: conversationModeSchema
});

export const referenceResolutionResultSchema = z.object({
  status: z.enum(["resolved", "ambiguous", "unresolved"]),
  entityId: z.string().min(1).optional(),
  matchedBy: z.enum([
    "explicit",
    "ordinal",
    "clarification",
    "editable",
    "focus",
    "single_candidate",
    "recency"
  ]).optional(),
  clarificationId: z.string().min(1).optional(),
  candidates: z.array(z.string().min(1)).optional()
});

export type ConversationMode = z.infer<typeof conversationModeSchema>;
export type PresentedItem = z.infer<typeof presentedItemSchema>;
export type PendingClarification = z.infer<typeof pendingClarificationSchema>;
export type DiscourseState = z.infer<typeof discourseStateSchema>;
export type ReferenceResolutionResult = z.infer<typeof referenceResolutionResultSchema>;

export type DiscourseTrace<TInput = unknown> = {
  before: DiscourseState;
  input: TInput;
  referenceResolution?: ReferenceResolutionResult;
  after: DiscourseState;
};

export type DiscourseStateUpdateResult<TInput = unknown> = {
  state: DiscourseState;
  trace: DiscourseTrace<TInput> | null;
};

export type ModeDerivationSignals = {
  pendingConfirmation?: boolean;
  editableEntityId?: string | null;
};

export type ResolveReferenceInput = {
  explicitEntityIds?: string[];
  ordinal?: number | null;
  optionKey?: string | null;
  refersToOther?: boolean;
  candidateEntityIds?: string[];
};

export type CleanupDiscourseStateInput = {
  validEntityIds?: string[];
};

export type UpdateDiscourseStateFromUserTurnInput = {
  mentionedEntityIds?: string[];
  reference?: ResolveReferenceInput;
  resolvedClarificationIds?: string[];
  cancelledClarificationIds?: string[];
  cancelledClarificationEntityIds?: string[];
  focusEntityId?: string | null;
  editableEntityId?: string | null;
  pendingConfirmation?: boolean;
  validEntityIds?: string[];
  includeTrace?: boolean;
};

export type UpdateDiscourseStateFromAssistantTurnInput = {
  presentedItems?: PresentedItem[];
  newClarifications?: PendingClarification[];
  resolvedClarificationIds?: string[];
  cancelledClarificationIds?: string[];
  cancelledClarificationEntityIds?: string[];
  focusEntityId?: string | null;
  editableEntityId?: string | null;
  pendingConfirmation?: boolean;
  validEntityIds?: string[];
  includeTrace?: boolean;
};

export const conversationDiscourseStateSchema = discourseStateSchema;
export type ConversationDiscourseState = DiscourseState;

export function createEmptyDiscourseState(): DiscourseState {
  return discourseStateSchema.parse({
    focus_entity_id: null,
    currently_editable_entity_id: null,
    last_user_mentioned_entity_ids: [],
    last_presented_items: [],
    pending_clarifications: [],
    resolved_slots: {},
    mode: "planning"
  });
}

export function setFocusEntity(state: DiscourseState, entityId: string | null): DiscourseState {
  return discourseStateSchema.parse({
    ...state,
    focus_entity_id: entityId
  });
}

export function setEditableEntity(state: DiscourseState, entityId: string | null): DiscourseState {
  return discourseStateSchema.parse({
    ...state,
    currently_editable_entity_id: entityId
  });
}

export function pushUserMentionedEntities(
  state: DiscourseState,
  entityIds: string[],
  maxSize = MAX_LAST_USER_MENTIONED_ENTITY_IDS
): DiscourseState {
  if (entityIds.length === 0) {
    return state;
  }

  const nextIds: string[] = [];

  for (const entityId of [...entityIds].reverse()) {
    if (!nextIds.includes(entityId)) {
      nextIds.push(entityId);
    }
  }

  for (const entityId of state.last_user_mentioned_entity_ids) {
    if (!nextIds.includes(entityId)) {
      nextIds.push(entityId);
    }
  }

  return discourseStateSchema.parse({
    ...state,
    last_user_mentioned_entity_ids: nextIds.slice(0, maxSize)
  });
}

export function setPresentedItems(state: DiscourseState, items: PresentedItem[]): DiscourseState {
  return discourseStateSchema.parse({
    ...state,
    last_presented_items: items
  });
}

export function getActivePendingClarifications(state: DiscourseState): PendingClarification[] {
  return state.pending_clarifications.filter((clarification) => clarification.status === "pending");
}

export function addPendingClarification(
  state: DiscourseState,
  clarification: PendingClarification
): DiscourseState {
  const nextClarifications = [
    ...state.pending_clarifications.filter((existing) => existing.id !== clarification.id),
    clarification
  ];

  return discourseStateSchema.parse({
    ...state,
    pending_clarifications: nextClarifications
  });
}

export function resolvePendingClarification(
  state: DiscourseState,
  clarificationId: string
): DiscourseState {
  return discourseStateSchema.parse({
    ...state,
    pending_clarifications: state.pending_clarifications.map((clarification) =>
      clarification.id === clarificationId && clarification.status === "pending"
        ? { ...clarification, status: "resolved" }
        : clarification
    )
  });
}

export function cancelPendingClarificationsForEntity(
  state: DiscourseState,
  entityId: string
): DiscourseState {
  return discourseStateSchema.parse({
    ...state,
    pending_clarifications: state.pending_clarifications.map((clarification) =>
      clarification.entityId === entityId && clarification.status === "pending"
        ? { ...clarification, status: "cancelled" }
        : clarification
    )
  });
}

export function deriveMode(
  state: DiscourseState,
  signals: ModeDerivationSignals = {}
): ConversationMode {
  if (hasContractGaps(state) || getActivePendingClarifications(state).length > 0) {
    return "clarifying";
  }

  if (signals.pendingConfirmation) {
    return "confirming";
  }

  if (signals.editableEntityId ?? state.currently_editable_entity_id) {
    return "editing";
  }

  return "planning";
}

function hasContractGaps(state: DiscourseState): boolean {
  const contract = state.pending_write_contract;
  if (!contract) return false;
  const resolved = state.resolved_slots ?? {};
  return contract.requiredSlots.some((slot) => resolved[slot] === undefined);
}

export function cleanupDiscourseState(
  state: DiscourseState,
  input: CleanupDiscourseStateInput = {}
): DiscourseState {
  if (!input.validEntityIds) {
    return discourseStateSchema.parse({
      ...state,
      last_user_mentioned_entity_ids: state.last_user_mentioned_entity_ids.slice(0, MAX_LAST_USER_MENTIONED_ENTITY_IDS)
    });
  }

  const validEntityIds = new Set(input.validEntityIds);
  const pendingClarifications = state.pending_clarifications.map((clarification) => {
    if (
      clarification.entityId &&
      !validEntityIds.has(clarification.entityId) &&
      clarification.status === "pending"
    ) {
      return {
        ...clarification,
        status: "cancelled" as const
      };
    }

    return clarification;
  });

  return discourseStateSchema.parse({
    ...state,
    focus_entity_id:
      state.focus_entity_id && validEntityIds.has(state.focus_entity_id) ? state.focus_entity_id : null,
    currently_editable_entity_id:
      state.currently_editable_entity_id && validEntityIds.has(state.currently_editable_entity_id)
        ? state.currently_editable_entity_id
        : null,
    last_user_mentioned_entity_ids: state.last_user_mentioned_entity_ids
      .filter((entityId) => validEntityIds.has(entityId))
      .slice(0, MAX_LAST_USER_MENTIONED_ENTITY_IDS),
    last_presented_items: state.last_presented_items.reduce<PresentedItem[]>((items, item) => {
      if (item.type === "entity") {
        if (validEntityIds.has(item.entityId)) {
          items.push(item);
        }

        return items;
      }

      if (item.linkedEntityId && !validEntityIds.has(item.linkedEntityId)) {
        const { linkedEntityId: _linkedEntityId, ...rest } = item;
        items.push(rest);
        return items;
      }

      items.push(item);
      return items;
    }, []),
    pending_clarifications: pendingClarifications,
    mode: deriveMode(
      {
        ...state,
        focus_entity_id:
          state.focus_entity_id && validEntityIds.has(state.focus_entity_id) ? state.focus_entity_id : null,
        currently_editable_entity_id:
          state.currently_editable_entity_id && validEntityIds.has(state.currently_editable_entity_id)
            ? state.currently_editable_entity_id
            : null,
        pending_clarifications: pendingClarifications
      },
      {
        editableEntityId:
          state.currently_editable_entity_id && validEntityIds.has(state.currently_editable_entity_id)
            ? state.currently_editable_entity_id
            : null
      }
    )
  });
}

export function resolveReference(
  state: DiscourseState,
  input: ResolveReferenceInput = {}
): ReferenceResolutionResult {
  const explicitEntityIds = unique(input.explicitEntityIds ?? []);

  if (explicitEntityIds.length === 1) {
    return {
      status: "resolved",
      entityId: explicitEntityIds[0],
      matchedBy: "explicit"
    };
  }

  if (explicitEntityIds.length > 1) {
    return {
      status: "ambiguous",
      candidates: explicitEntityIds
    };
  }

  const ordinalLookupInput: { ordinal?: number; optionKey?: string } = {};

  if (typeof input.ordinal === "number") {
    ordinalLookupInput.ordinal = input.ordinal;
  }

  if (typeof input.optionKey === "string") {
    ordinalLookupInput.optionKey = input.optionKey;
  }

  const ordinalMatch = findPresentedItemByOrdinalOrOption(state.last_presented_items, ordinalLookupInput);
  const ordinalEntityId = getPresentedItemEntityId(ordinalMatch);

  if (ordinalEntityId) {
    return {
      status: "resolved",
      entityId: ordinalEntityId,
      matchedBy: "ordinal"
    };
  }

  if (input.refersToOther) {
    const otherResolution = resolveOtherPresentedItem(state, input.candidateEntityIds ?? []);

    if (otherResolution) {
      return otherResolution;
    }
  }

  const activeClarifications = getActivePendingClarifications(state).sort(sortClarifications);
  const singleClarificationEntityIds = unique(
    activeClarifications
      .map((clarification) => clarification.entityId)
      .filter((entityId): entityId is string => typeof entityId === "string")
  );

  if (activeClarifications.length === 1 && singleClarificationEntityIds.length === 1) {
    return {
      status: "resolved",
      entityId: singleClarificationEntityIds[0],
      clarificationId: activeClarifications[0]?.id,
      matchedBy: "clarification"
    };
  }

  if (state.currently_editable_entity_id) {
    return {
      status: "resolved",
      entityId: state.currently_editable_entity_id,
      matchedBy: "editable"
    };
  }

  if (state.focus_entity_id) {
    return {
      status: "resolved",
      entityId: state.focus_entity_id,
      matchedBy: "focus"
    };
  }

  const candidateEntityIds = unique(input.candidateEntityIds ?? []);

  if (candidateEntityIds.length === 1) {
    return {
      status: "resolved",
      entityId: candidateEntityIds[0],
      matchedBy: "single_candidate"
    };
  }

  const recentCandidate = state.last_user_mentioned_entity_ids.find((entityId) =>
    candidateEntityIds.length === 0 ? true : candidateEntityIds.includes(entityId)
  );

  if (recentCandidate) {
    return {
      status: "resolved",
      entityId: recentCandidate,
      matchedBy: "recency"
    };
  }

  if (candidateEntityIds.length > 1 || singleClarificationEntityIds.length > 1) {
    return {
      status: "ambiguous",
      candidates: candidateEntityIds.length > 1 ? candidateEntityIds : singleClarificationEntityIds
    };
  }

  return {
    status: "unresolved"
  };
}

export function updateDiscourseStateFromUserTurn(
  state: DiscourseState,
  input: UpdateDiscourseStateFromUserTurnInput
): DiscourseStateUpdateResult<UpdateDiscourseStateFromUserTurnInput> {
  const before = discourseStateSchema.parse(state);
  const referenceResolution = input.reference ? resolveReference(before, input.reference) : undefined;
  let nextState = before;

  if (input.mentionedEntityIds?.length) {
    nextState = pushUserMentionedEntities(nextState, input.mentionedEntityIds);
  }

  for (const clarificationId of input.resolvedClarificationIds ?? []) {
    nextState = resolvePendingClarification(nextState, clarificationId);
  }

  for (const clarificationId of input.cancelledClarificationIds ?? []) {
    nextState = discourseStateSchema.parse({
      ...nextState,
      pending_clarifications: nextState.pending_clarifications.map((clarification) =>
        clarification.id === clarificationId && clarification.status === "pending"
          ? { ...clarification, status: "cancelled" }
          : clarification
      )
    });
  }

  for (const entityId of input.cancelledClarificationEntityIds ?? []) {
    nextState = cancelPendingClarificationsForEntity(nextState, entityId);
  }

  const resolvedEntityId =
    input.focusEntityId === undefined
      ? referenceResolution?.status === "resolved"
        ? referenceResolution.entityId ?? null
        : nextState.focus_entity_id
      : input.focusEntityId;

  if (resolvedEntityId !== undefined) {
    nextState = setFocusEntity(nextState, resolvedEntityId);
  }

  if (input.editableEntityId !== undefined) {
    nextState = setEditableEntity(nextState, input.editableEntityId);
  }

  nextState = pruneStaleClarifications(nextState);
  nextState = cleanupDiscourseState(nextState, compactObject({
    validEntityIds: input.validEntityIds
  }));
  nextState = discourseStateSchema.parse({
    ...nextState,
    mode: deriveMode(nextState, compactObject({
      pendingConfirmation: input.pendingConfirmation,
      editableEntityId: input.editableEntityId
    }))
  });

  return {
    state: nextState,
    trace: input.includeTrace
      ? {
          before,
          input,
          ...(referenceResolution ? { referenceResolution } : {}),
          after: nextState
        }
      : null
  };
}

export function updateDiscourseStateFromAssistantTurn(
  state: DiscourseState,
  input: UpdateDiscourseStateFromAssistantTurnInput
): DiscourseStateUpdateResult<UpdateDiscourseStateFromAssistantTurnInput> {
  const before = discourseStateSchema.parse(state);
  let nextState = before;

  if (input.presentedItems) {
    nextState = setPresentedItems(nextState, input.presentedItems);
  }

  for (const clarification of input.newClarifications ?? []) {
    nextState = addPendingClarification(nextState, clarification);
  }

  for (const clarificationId of input.resolvedClarificationIds ?? []) {
    nextState = resolvePendingClarification(nextState, clarificationId);
  }

  if ((input.cancelledClarificationIds ?? []).length > 0) {
    nextState = discourseStateSchema.parse({
      ...nextState,
      pending_clarifications: nextState.pending_clarifications.map((clarification) =>
        input.cancelledClarificationIds?.includes(clarification.id) && clarification.status === "pending"
          ? { ...clarification, status: "cancelled" }
          : clarification
      )
    });
  }

  for (const entityId of input.cancelledClarificationEntityIds ?? []) {
    nextState = cancelPendingClarificationsForEntity(nextState, entityId);
  }

  if (input.focusEntityId !== undefined) {
    nextState = setFocusEntity(nextState, input.focusEntityId);
  }

  if (input.editableEntityId !== undefined) {
    nextState = setEditableEntity(nextState, input.editableEntityId);
  }

  nextState = pruneStaleClarifications(nextState);
  nextState = cleanupDiscourseState(nextState, compactObject({
    validEntityIds: input.validEntityIds
  }));
  nextState = discourseStateSchema.parse({
    ...nextState,
    mode: deriveMode(nextState, compactObject({
      pendingConfirmation: input.pendingConfirmation,
      editableEntityId: input.editableEntityId
    }))
  });

  return {
    state: nextState,
    trace: input.includeTrace
      ? {
          before,
          input,
          after: nextState
        }
      : null
  };
}

function pruneStaleClarifications(state: DiscourseState): DiscourseState {
  const pending = state.pending_clarifications.filter((c) => c.status === "pending");
  if (pending.length === state.pending_clarifications.length) return state;
  return discourseStateSchema.parse({
    ...state,
    pending_clarifications: pending
  });
}

function findPresentedItemByOrdinalOrOption(
  items: PresentedItem[],
  input: { ordinal?: number; optionKey?: string }
) {
  return items.find((item) => {
    if (input.ordinal !== undefined && item.ordinal === input.ordinal) {
      return true;
    }

    if (item.type === "option" && input.optionKey && item.optionKey === input.optionKey) {
      return true;
    }

    return false;
  });
}

function getPresentedItemEntityId(item: PresentedItem | undefined) {
  if (!item) {
    return undefined;
  }

  return item.type === "entity" ? item.entityId : item.linkedEntityId;
}

function resolveOtherPresentedItem(
  state: DiscourseState,
  candidateEntityIds: string[]
): ReferenceResolutionResult | null {
  const entityItems = state.last_presented_items
    .map((item) => {
      if (item.type === "entity") {
        return item.entityId;
      }

      return item.linkedEntityId ?? null;
    })
    .filter((entityId): entityId is string => typeof entityId === "string");

  const uniqueEntities = unique(entityItems);

  if (uniqueEntities.length !== 2) {
    return {
      status: "ambiguous",
      candidates: uniqueEntities
    };
  }

  const excluded = candidateEntityIds.find((entityId) => entityId === state.focus_entity_id) ?? state.focus_entity_id;

  if (!excluded || !uniqueEntities.includes(excluded)) {
    return {
      status: "ambiguous",
      candidates: uniqueEntities
    };
  }

  return {
    status: "resolved",
    entityId: uniqueEntities.find((entityId) => entityId !== excluded),
    matchedBy: "ordinal"
  };
}

function sortClarifications(left: PendingClarification, right: PendingClarification) {
  const priorityDelta = (right.priority ?? 0) - (left.priority ?? 0);

  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return left.createdAt.localeCompare(right.createdAt);
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function compactObject<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as {
    [Key in keyof T as undefined extends T[Key] ? never : Key]: T[Key];
  } & Partial<T>;
}
