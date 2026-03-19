import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const { reconcileGoogleCalendarConnectionsMock } = vi.hoisted(() => ({
  reconcileGoogleCalendarConnectionsMock: vi.fn()
}));

vi.mock("@/lib/server/google-calendar", () => ({
  reconcileGoogleCalendarConnections: reconcileGoogleCalendarConnectionsMock
}));

describe("reconcile Google Calendar cron route", () => {
  beforeEach(() => {
    delete process.env.CRON_SECRET;
    reconcileGoogleCalendarConnectionsMock.mockReset();
    reconcileGoogleCalendarConnectionsMock.mockResolvedValue({
      accepted: true,
      reconciledConnections: 0,
      syncedTasks: 0,
      outOfSyncTasks: 0,
      failedConnections: 0
    });
  });

  it("rejects unauthenticated cron requests", async () => {
    process.env.CRON_SECRET = "cron-secret";

    const response = await POST(new Request("http://localhost/api/cron/reconcile-google-calendar"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      accepted: false,
      error: "invalid_cron_secret"
    });
    expect(reconcileGoogleCalendarConnectionsMock).not.toHaveBeenCalled();
  });

  it("fails closed when the cron secret is not configured", async () => {
    const response = await POST(
      new Request("http://localhost/api/cron/reconcile-google-calendar", {
        method: "POST"
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      accepted: false,
      error: "cron_secret_not_configured"
    });
  });

  it("runs reconciliation for authorized cron requests", async () => {
    process.env.CRON_SECRET = "cron-secret";

    const response = await POST(
      new Request("http://localhost/api/cron/reconcile-google-calendar", {
        method: "POST",
        headers: {
          authorization: "Bearer cron-secret"
        }
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      reconciledConnections: 0
    });
    expect(reconcileGoogleCalendarConnectionsMock).toHaveBeenCalledTimes(1);
  });
});
