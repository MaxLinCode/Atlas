import {
  normalizeRawExtraction,
  rawSlotExtractionSchema,
  type SlotExtractorInput,
  type SlotExtractorOutput
} from "@atlas/core";
import { extractSlotsWithResponses, type OpenAIResponsesClient } from "@atlas/integrations";

export async function extractSlots(
  input: SlotExtractorInput,
  client?: OpenAIResponsesClient
): Promise<SlotExtractorOutput> {
  try {
    const raw = await extractSlotsWithResponses(input, client);
    const parsed = rawSlotExtractionSchema.safeParse(raw);

    if (!parsed.success) {
      return {
        extractedValues: {},
        confidence: {},
        unresolvable: [...input.pendingSlots]
      };
    }

    return {
      extractedValues: normalizeRawExtraction(parsed.data),
      confidence: parsed.data.confidence,
      unresolvable: parsed.data.unresolvable
    };
  } catch {
    return {
      extractedValues: {},
      confidence: {},
      unresolvable: [...input.pendingSlots]
    };
  }
}
