import type { TurnAmbiguity } from "./index";

export type DeriveAmbiguityInput = {
  classifierConfidence: number;
  missingFields: string[];
  needsClarification: string[];
};

export function deriveAmbiguity(input: DeriveAmbiguityInput): TurnAmbiguity {
  if (input.classifierConfidence < 0.6) return "high";
  if (input.missingFields.length > 0) return "high";
  if (input.needsClarification.length > 0) return "high";
  if (input.classifierConfidence < 0.8) return "low";
  return "none";
}
