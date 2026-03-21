import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const { runBundledFollowUpsMock } = vi.hoisted(() => ({
  runBundledFollowUpsMock: vi.fn()
}));

vi.mock("@/lib/server/follow-up", () => ({
  runBundledFollowUps: runBundledFollowUpsMock
}));

describe("send followups cron route", () => {
  beforeEach(() => {
    delete process.env.CRON_SECRET;
    runBundledFollowUpsMock.mockReset();
    runBundledFollowUpsMock.mockResolvedValue({
      accepted: true,
      sentBundles: 0,
      skippedActiveTurns: 0
    });
  });

  it("rejects unauthenticated cron requests", async () => {
    process.env.CRON_SECRET = "cron-secret";

    const response = await POST(new Request("http://localhost/api/cron/send-followups", { method: "POST" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      accepted: false,
      error: "invalid_cron_secret"
    });
  });

  it("fails closed when the cron secret is not configured", async () => {
    const response = await POST(new Request("http://localhost/api/cron/send-followups", { method: "POST" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      accepted: false,
      error: "cron_secret_not_configured"
    });
  });

  it("runs followups for authorized cron requests", async () => {
    process.env.CRON_SECRET = "cron-secret";

    const response = await POST(
      new Request("http://localhost/api/cron/send-followups", {
        method: "POST",
        headers: { authorization: "Bearer cron-secret" }
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      sentBundles: 0
    });
    expect(runBundledFollowUpsMock).toHaveBeenCalledTimes(1);
  });
});
