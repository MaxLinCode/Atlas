import { describe, expect, it } from "vitest";

import { plannedCalendarAdapter } from "./index";

describe("integrations", () => {
  it("keeps calendar support as a planned boundary", () => {
    expect(plannedCalendarAdapter.status).toBe("planned");
  });
});

