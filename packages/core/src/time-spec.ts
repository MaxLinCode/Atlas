import type { TimeSpec } from "./discourse-state";

export function timeSpecToHHMM(spec: TimeSpec): string | null {
	if (spec.kind === "absolute") {
		return `${String(spec.hour).padStart(2, "0")}:${String(spec.minute).padStart(2, "0")}`;
	}
	return null;
}

export function formatTimeSpec(spec: TimeSpec): string {
	switch (spec.kind) {
		case "absolute": {
			const period = spec.hour >= 12 ? "pm" : "am";
			const displayHour =
				spec.hour === 0 ? 12 : spec.hour > 12 ? spec.hour - 12 : spec.hour;
			if (spec.minute === 0) {
				return `${displayHour}${period}`;
			}
			return `${displayHour}:${String(spec.minute).padStart(2, "0")}${period}`;
		}
		case "relative": {
			if (spec.minutes < 60) {
				return `in ${spec.minutes} minutes`;
			}
			const hours = Math.floor(spec.minutes / 60);
			const remainder = spec.minutes % 60;
			if (remainder === 0) {
				return `in ${hours} hour${hours > 1 ? "s" : ""}`;
			}
			return `in ${hours}h ${remainder}m`;
		}
		case "window":
			return `in the ${spec.window}`;
	}
}

export function timeSpecToConstraintFields(spec: TimeSpec) {
	switch (spec.kind) {
		case "absolute":
			return {
				explicitHour: spec.hour,
				minute: spec.minute,
				relativeMinutes: null,
				preferredWindow: null,
			};
		case "relative":
			return {
				explicitHour: null,
				minute: null,
				relativeMinutes: spec.minutes,
				preferredWindow: null,
			};
		case "window":
			return {
				explicitHour: null,
				minute: null,
				relativeMinutes: null,
				preferredWindow: spec.window,
			};
	}
}

export function timeSpecsEqual(a: TimeSpec, b: TimeSpec): boolean {
	if (a.kind !== b.kind) return false;
	switch (a.kind) {
		case "absolute":
			return (
				a.hour === (b as typeof a).hour &&
				a.minute === (b as typeof a).minute
			);
		case "relative":
			return a.minutes === (b as typeof a).minutes;
		case "window":
			return a.window === (b as typeof a).window;
	}
}
