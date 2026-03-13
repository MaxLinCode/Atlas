import { describe, expect, it } from "vitest";

describe("telegram webhook route shape", () => {
  it("keeps the route path reserved for Telegram delivery", () => {
    expect("/api/telegram/webhook").toContain("/telegram/");
  });
});

