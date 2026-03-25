import { describe, expect, it } from "vitest";
import type { ConversationEntity, TimeSpec } from "./index";
import type { SynthesizeMutationTextInput } from "./synthesize-mutation-text";
import {
	formatDurationForPlanner,
	synthesizeMutationText,
} from "./synthesize-mutation-text";
import { formatTimeSpec } from "./time-spec";

function t(hour: number, minute: number): TimeSpec {
	return { kind: "absolute", hour, minute };
}

function buildProposalEntity(
	overrides: Partial<{
		id: string;
		originatingTurnText: string | null;
		missingSlots: string[];
		targetEntityId: string | null;
		replyText: string;
	}> = {},
): Extract<ConversationEntity, { kind: "proposal_option" }> {
	return {
		id: overrides.id ?? "proposal-1",
		conversationId: "conv-1",
		kind: "proposal_option",
		label: "test proposal",
		status: "presented",
		createdAt: "2026-03-24T10:00:00Z",
		updatedAt: "2026-03-24T10:00:00Z",
		data: {
			route: "conversation_then_mutation",
			replyText: overrides.replyText ?? "Shall I schedule that?",
			originatingTurnText:
				"originatingTurnText" in overrides
					? overrides.originatingTurnText!
					: "schedule dentist tomorrow",
			targetEntityId: overrides.targetEntityId ?? null,
			missingSlots: overrides.missingSlots ?? [],
			slotSnapshot: {},
		},
	};
}

function buildTaskEntity(id: string, title: string): ConversationEntity {
	return {
		id,
		conversationId: "conv-1",
		kind: "task",
		label: title,
		status: "active",
		createdAt: "2026-03-24T10:00:00Z",
		updatedAt: "2026-03-24T10:00:00Z",
		data: {
			taskId: `task-${id}`,
			title,
			lifecycleState: "pending_schedule",
			scheduledStartAt: null,
			scheduledEndAt: null,
		},
	};
}

function buildInput(
	overrides: Partial<SynthesizeMutationTextInput> = {},
): SynthesizeMutationTextInput {
	return {
		resolvedSlots: {},
		entityRegistry: [],
		...overrides,
	};
}

describe("synthesizeMutationText", () => {
	it("returns originatingTurnText unchanged when no missing slots", () => {
		const result = synthesizeMutationText(
			buildInput({
				proposalEntity: buildProposalEntity({
					originatingTurnText: "schedule dentist tomorrow",
				}),
			}),
		);

		expect(result).toEqual({
			outcome: "synthesized",
			text: "schedule dentist tomorrow",
		});
	});

	it("augments originatingTurnText with resolved time slot", () => {
		const result = synthesizeMutationText(
			buildInput({
				resolvedSlots: { time: t(15, 0) },
				proposalEntity: buildProposalEntity({
					originatingTurnText: "schedule dentist tomorrow",
					missingSlots: ["time"],
				}),
			}),
		);

		expect(result).toEqual({
			outcome: "synthesized",
			text: "schedule dentist tomorrow at 3pm",
		});
	});

	it("augments with multiple missing slots", () => {
		const result = synthesizeMutationText(
			buildInput({
				resolvedSlots: { day: "friday", time: t(9, 30), duration: 60 },
				proposalEntity: buildProposalEntity({
					originatingTurnText: "schedule dentist",
					missingSlots: ["day", "time", "duration"],
				}),
			}),
		);

		expect(result).toEqual({
			outcome: "synthesized",
			text: "schedule dentist on friday at 9:30am for 1 hour",
		});
	});

	it("does not augment slots that were not in missingSlots", () => {
		const result = synthesizeMutationText(
			buildInput({
				resolvedSlots: { day: "friday", time: t(15, 0) },
				proposalEntity: buildProposalEntity({
					originatingTurnText: "schedule dentist on friday",
					missingSlots: ["time"],
				}),
			}),
		);

		expect(result).toEqual({
			outcome: "synthesized",
			text: "schedule dentist on friday at 3pm",
		});
	});

	it("passes through completion requests without augmentation", () => {
		const result = synthesizeMutationText(
			buildInput({
				proposalEntity: buildProposalEntity({
					originatingTurnText: "mark journaling as done",
					missingSlots: [],
				}),
			}),
		);

		expect(result).toEqual({
			outcome: "synthesized",
			text: "mark journaling as done",
		});
	});

	it("resolves target entity name from registry", () => {
		const taskEntity = buildTaskEntity("entity-1", "Team standup");
		const result = synthesizeMutationText(
			buildInput({
				resolvedSlots: { target: "entity-1" },
				proposalEntity: buildProposalEntity({
					originatingTurnText: "schedule it tomorrow at 3pm",
					missingSlots: ["target"],
				}),
				entityRegistry: [taskEntity],
			}),
		);

		expect(result).toEqual({
			outcome: "synthesized",
			text: "schedule it tomorrow at 3pm for Team standup",
		});
	});

	it("falls back to slot-only synthesis when no originatingTurnText", () => {
		const result = synthesizeMutationText(
			buildInput({
				resolvedSlots: { day: "tomorrow", time: t(15, 0) },
				proposalEntity: buildProposalEntity({
					originatingTurnText: null,
				}),
			}),
		);

		expect(result).toEqual({
			outcome: "synthesized",
			text: "Schedule on tomorrow at 3pm",
		});
	});

	it("falls back to slot-only synthesis when no proposal entity", () => {
		const taskEntity = buildTaskEntity("entity-1", "Dentist");
		const result = synthesizeMutationText(
			buildInput({
				resolvedSlots: { target: "entity-1", day: "friday", time: t(14, 0) },
				entityRegistry: [taskEntity],
			}),
		);

		expect(result).toEqual({
			outcome: "synthesized",
			text: "Schedule Dentist on friday at 2pm",
		});
	});

	it("returns insufficient_data when no proposal and no useful slots", () => {
		const result = synthesizeMutationText(
			buildInput({
				resolvedSlots: {},
			}),
		);

		expect(result).toEqual({
			outcome: "insufficient_data",
			reason:
				"No originating turn text and insufficient resolved slots to synthesize a mutation request.",
		});
	});

	it("returns insufficient_data when only target slot with unknown entity", () => {
		const result = synthesizeMutationText(
			buildInput({
				resolvedSlots: { target: "unknown-entity" },
			}),
		);

		expect(result).toEqual({
			outcome: "insufficient_data",
			reason:
				"No originating turn text and insufficient resolved slots to synthesize a mutation request.",
		});
	});

	it("synthesizes from target-only slot when entity exists", () => {
		const taskEntity = buildTaskEntity("entity-1", "Dentist");
		const result = synthesizeMutationText(
			buildInput({
				resolvedSlots: { target: "entity-1" },
				entityRegistry: [taskEntity],
			}),
		);

		expect(result).toEqual({
			outcome: "synthesized",
			text: "Schedule Dentist",
		});
	});
});

describe("formatTimeSpec", () => {
	it("formats absolute 15:00 as 3pm", () => {
		expect(formatTimeSpec(t(15, 0))).toBe("3pm");
	});

	it("formats absolute 09:30 as 9:30am", () => {
		expect(formatTimeSpec(t(9, 30))).toBe("9:30am");
	});

	it("formats absolute 00:00 as 12am", () => {
		expect(formatTimeSpec(t(0, 0))).toBe("12am");
	});

	it("formats absolute 12:00 as 12pm", () => {
		expect(formatTimeSpec(t(12, 0))).toBe("12pm");
	});

	it("formats absolute 12:30 as 12:30pm", () => {
		expect(formatTimeSpec(t(12, 30))).toBe("12:30pm");
	});

	it("formats absolute 17:45 as 5:45pm", () => {
		expect(formatTimeSpec(t(17, 45))).toBe("5:45pm");
	});

	it("formats relative minutes", () => {
		expect(formatTimeSpec({ kind: "relative", minutes: 30 })).toBe(
			"in 30 minutes",
		);
	});

	it("formats relative hours", () => {
		expect(formatTimeSpec({ kind: "relative", minutes: 120 })).toBe(
			"in 2 hours",
		);
	});

	it("formats window", () => {
		expect(formatTimeSpec({ kind: "window", window: "morning" })).toBe(
			"in the morning",
		);
	});
});

describe("formatDurationForPlanner", () => {
	it("formats 30 as 'for 30 minutes'", () => {
		expect(formatDurationForPlanner(30)).toBe("for 30 minutes");
	});

	it("formats 60 as 'for 1 hour'", () => {
		expect(formatDurationForPlanner(60)).toBe("for 1 hour");
	});

	it("formats 120 as 'for 2 hours'", () => {
		expect(formatDurationForPlanner(120)).toBe("for 2 hours");
	});

	it("formats 90 as 'for 1 hour 30 minutes'", () => {
		expect(formatDurationForPlanner(90)).toBe("for 1 hour 30 minutes");
	});

	it("formats 150 as 'for 2 hours 30 minutes'", () => {
		expect(formatDurationForPlanner(150)).toBe("for 2 hours 30 minutes");
	});
});
