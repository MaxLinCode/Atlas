import { describe, expect, it } from "vitest";

import { getRepositoryHealth } from "./index";

describe("db package", () => {
  it("exposes a repository placeholder", () => {
    expect(getRepositoryHealth().status).toBe("unconfigured");
  });
});

