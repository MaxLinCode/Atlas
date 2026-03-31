import type { z } from "zod";
import type { resolvedFieldsSchema } from "./discourse-state";
import type {
  conversationEntitySchema,
  conversationProposalOptionEntitySchema,
} from "./index";
import { formatTimeSpec } from "./time-spec";

type ResolvedFields = z.infer<typeof resolvedFieldsSchema>;
type ConversationEntity = z.infer<typeof conversationEntitySchema>;
type ProposalOptionEntity = z.infer<
  typeof conversationProposalOptionEntitySchema
>;

export type SynthesizeMutationTextInput = {
  resolvedFields: ResolvedFields;
  targetEntityId?: string | undefined;
  proposalEntity?: ProposalOptionEntity | undefined;
  entityRegistry: ConversationEntity[];
};

export type SynthesizeMutationTextResult =
  | { outcome: "synthesized"; text: string }
  | { outcome: "insufficient_data"; reason: string };

export function synthesizeMutationText(
  input: SynthesizeMutationTextInput,
): SynthesizeMutationTextResult {
  const { resolvedFields, proposalEntity, entityRegistry } = input;
  const scheduleFields = resolvedFields.scheduleFields ?? {};
  const targetEntityId =
    input.targetEntityId ?? proposalEntity?.data.targetEntityId ?? undefined;

  const originatingText = proposalEntity?.data.originatingTurnText;
  const missingFields = new Set(proposalEntity?.data.missingFields ?? []);

  if (originatingText) {
    const augmentations = buildFieldAugmentations(
      scheduleFields,
      targetEntityId,
      missingFields,
      entityRegistry,
    );
    const text =
      augmentations.length > 0
        ? `${originatingText} ${augmentations.join(" ")}`
        : originatingText;
    return { outcome: "synthesized", text };
  }

  const synthesized = buildFromFieldsOnly(
    scheduleFields,
    targetEntityId,
    entityRegistry,
  );
  if (synthesized) {
    return { outcome: "synthesized", text: synthesized };
  }

  return {
    outcome: "insufficient_data",
    reason:
      "No originating turn text and insufficient resolved fields to synthesize a mutation request.",
  };
}

type ScheduleFields = NonNullable<ResolvedFields["scheduleFields"]>;

function buildFieldAugmentations(
  fields: ScheduleFields,
  targetEntityId: string | undefined,
  missingFields: Set<string>,
  entityRegistry: ConversationEntity[],
): string[] {
  const parts: string[] = [];

  if (fields.day && missingFields.has("day")) {
    parts.push(`on ${fields.day}`);
  }
  if (fields.time && missingFields.has("time")) {
    parts.push(`at ${formatTimeSpec(fields.time)}`);
  }
  if (fields.duration != null && missingFields.has("duration")) {
    parts.push(formatDurationForPlanner(fields.duration));
  }
  if (targetEntityId && missingFields.has("target")) {
    const name = resolveEntityName(targetEntityId, entityRegistry);
    if (name) {
      parts.push(`for ${name}`);
    }
  }

  return parts;
}

function buildFromFieldsOnly(
  fields: ScheduleFields,
  targetEntityId: string | undefined,
  entityRegistry: ConversationEntity[],
): string | null {
  const parts: string[] = [];

  const targetName = targetEntityId
    ? resolveEntityName(targetEntityId, entityRegistry)
    : null;

  if (targetName) {
    parts.push(`Schedule ${targetName}`);
  } else if (fields.day || fields.time) {
    parts.push("Schedule");
  } else {
    return null;
  }

  if (fields.day) {
    parts.push(`on ${fields.day}`);
  }
  if (fields.time) {
    parts.push(`at ${formatTimeSpec(fields.time)}`);
  }
  if (fields.duration != null) {
    parts.push(formatDurationForPlanner(fields.duration));
  }

  return parts.join(" ");
}

function resolveEntityName(
  entityId: string,
  entityRegistry: ConversationEntity[],
): string | null {
  const entity = entityRegistry.find((e) => e.id === entityId);
  if (!entity) return null;
  if (entity.kind === "task") return entity.data.title;
  return entity.label;
}

export function formatDurationForPlanner(minutes: number): string {
  if (minutes < 60) {
    return `for ${minutes} minutes`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (remainder === 0) {
    return `for ${hours} hour${hours > 1 ? "s" : ""}`;
  }
  return `for ${hours} hour${hours > 1 ? "s" : ""} ${remainder} minutes`;
}
