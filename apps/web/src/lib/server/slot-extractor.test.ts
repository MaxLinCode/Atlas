import { describe, expect, it, vi } from "vitest";

import type { RawSlotExtraction, SlotExtractorInput } from "@atlas/core";

import { extractSlots } from "./slot-extractor";

function mockClient(output: Partial<RawSlotExtraction>) {
  const full: RawSlotExtraction = {
    time: null,
    day: null,
    duration: null,
    target: null,
    confidence: {},
    unresolvable: [],
    ...output,
  };
  return {
    responses: {
      parse: vi.fn().mockResolvedValue({ output_parsed: full }),
    },
  };
}

function failingClient() {
  return {
    responses: {
      parse: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
    },
  };
}

const baseInput: SlotExtractorInput = {
  currentTurnText: "5pm",
  pendingSlots: ["time"],
  priorResolvedSlots: {},
};

describe("extractSlots", () => {
  it("normalizes a successful time extraction", async () => {
    const client = mockClient({
      time: { hour: 17, minute: 0 },
      confidence: { time: 0.9 },
      unresolvable: [],
    });

    const result = await extractSlots(baseInput, client);

    expect(result.extractedValues).toEqual({ time: "17:00" });
    expect(result.confidence).toEqual({ time: 0.9 });
    expect(result.unresolvable).toEqual([]);
  });

  it("returns unresolvable for vague inputs", async () => {
    const client = mockClient({
      confidence: {},
      unresolvable: ["time"],
    });

    const result = await extractSlots(baseInput, client);

    expect(result.extractedValues).toEqual({});
    expect(result.unresolvable).toEqual(["time"]);
  });

  it("handles multiple slots", async () => {
    const client = mockClient({
      time: { hour: 14, minute: 30 },
      day: { kind: "relative", value: "Tomorrow" },
      confidence: { time: 0.95, day: 0.92 },
      unresolvable: [],
    });

    const input: SlotExtractorInput = {
      currentTurnText: "tomorrow at 2:30pm",
      pendingSlots: ["time", "day"],
      priorResolvedSlots: {},
    };

    const result = await extractSlots(input, client);

    expect(result.extractedValues).toEqual({ time: "14:30", day: "tomorrow" });
  });

  it("degrades gracefully on LLM failure", async () => {
    const client = failingClient();

    const result = await extractSlots(baseInput, client);

    expect(result.extractedValues).toEqual({});
    expect(result.unresolvable).toEqual(["time"]);
  });

  it("degrades gracefully on malformed LLM response", async () => {
    const client = {
      responses: {
        parse: vi.fn().mockResolvedValue({ output_parsed: { invalid: true } }),
      },
    };

    const input: SlotExtractorInput = {
      currentTurnText: "5pm",
      pendingSlots: ["time", "day"],
      priorResolvedSlots: {},
    };

    const result = await extractSlots(input, client);

    expect(result.extractedValues).toEqual({});
    expect(result.unresolvable).toEqual(["time", "day"]);
  });

  it("passes conversation context to the client", async () => {
    const client = mockClient({
      time: { hour: 9, minute: 30 },
      confidence: { time: 0.88 },
      unresolvable: [],
    });

    const input: SlotExtractorInput = {
      currentTurnText: "after the standup",
      pendingSlots: ["time"],
      priorResolvedSlots: { day: "tomorrow" },
      conversationContext: "standup is at 9:30am",
    };

    const result = await extractSlots(input, client);

    expect(result.extractedValues).toEqual({ time: "09:30" });
    expect(client.responses.parse).toHaveBeenCalledOnce();
  });
});
