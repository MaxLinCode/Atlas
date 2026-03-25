import type { z } from "zod";
import type { resolvedSlotsSchema } from "./discourse-state";
import type {
	conversationEntitySchema,
	conversationProposalOptionEntitySchema,
} from "./index";
import { formatTimeSpec } from "./time-spec";

type ResolvedSlots = z.infer<typeof resolvedSlotsSchema>;
type ConversationEntity = z.infer<typeof conversationEntitySchema>;
type ProposalOptionEntity = z.infer<
	typeof conversationProposalOptionEntitySchema
>;

export type SynthesizeMutationTextInput = {
	resolvedSlots: ResolvedSlots;
	proposalEntity?: ProposalOptionEntity | undefined;
	entityRegistry: ConversationEntity[];
};

export type SynthesizeMutationTextResult =
	| { outcome: "synthesized"; text: string }
	| { outcome: "insufficient_data"; reason: string };

export function synthesizeMutationText(
	input: SynthesizeMutationTextInput,
): SynthesizeMutationTextResult {
	const { resolvedSlots, proposalEntity, entityRegistry } = input;

	const originatingText = proposalEntity?.data.originatingTurnText;
	const missingSlots = new Set(proposalEntity?.data.missingSlots ?? []);

	if (originatingText) {
		const augmentations = buildSlotAugmentations(
			resolvedSlots,
			missingSlots,
			entityRegistry,
		);
		const text =
			augmentations.length > 0
				? `${originatingText} ${augmentations.join(" ")}`
				: originatingText;
		return { outcome: "synthesized", text };
	}

	const synthesized = buildFromSlotsOnly(resolvedSlots, entityRegistry);
	if (synthesized) {
		return { outcome: "synthesized", text: synthesized };
	}

	return {
		outcome: "insufficient_data",
		reason:
			"No originating turn text and insufficient resolved slots to synthesize a mutation request.",
	};
}

function buildSlotAugmentations(
	slots: ResolvedSlots,
	missingSlots: Set<string>,
	entityRegistry: ConversationEntity[],
): string[] {
	const parts: string[] = [];

	if (slots.day && missingSlots.has("day")) {
		parts.push(`on ${slots.day}`);
	}
	if (slots.time && missingSlots.has("time")) {
		parts.push(`at ${formatTimeSpec(slots.time)}`);
	}
	if (slots.duration != null && missingSlots.has("duration")) {
		parts.push(formatDurationForPlanner(slots.duration));
	}
	if (slots.target && missingSlots.has("target")) {
		const name = resolveEntityName(slots.target, entityRegistry);
		if (name) {
			parts.push(`for ${name}`);
		}
	}

	return parts;
}

function buildFromSlotsOnly(
	slots: ResolvedSlots,
	entityRegistry: ConversationEntity[],
): string | null {
	const parts: string[] = [];

	const targetName = slots.target
		? resolveEntityName(slots.target, entityRegistry)
		: null;

	if (targetName) {
		parts.push(`Schedule ${targetName}`);
	} else if (slots.day || slots.time) {
		parts.push("Schedule");
	} else {
		return null;
	}

	if (slots.day) {
		parts.push(`on ${slots.day}`);
	}
	if (slots.time) {
		parts.push(`at ${formatTimeSpec(slots.time)}`);
	}
	if (slots.duration != null) {
		parts.push(formatDurationForPlanner(slots.duration));
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
