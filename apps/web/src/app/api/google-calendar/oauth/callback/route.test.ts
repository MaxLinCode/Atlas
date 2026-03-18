import { describe, expect, it, vi } from "vitest";

const { handleGoogleCalendarOauthCallbackMock } = vi.hoisted(() => ({
  handleGoogleCalendarOauthCallbackMock: vi.fn()
}));

vi.mock("@/lib/server/google-calendar", () => ({
  handleGoogleCalendarOauthCallback: handleGoogleCalendarOauthCallbackMock
}));

describe("google calendar oauth callback route", () => {
  it("returns an html success page for completed linking", async () => {
    handleGoogleCalendarOauthCallbackMock.mockResolvedValueOnce({
      status: 200,
      body: {
        accepted: true
      },
      completion: {
        title: "Google Calendar connected",
        message: "Google Calendar is connected. Go back to Telegram and send that again."
      },
      headers: {
        "set-cookie": "atlas_google_link_session=; Path=/; Max-Age=0"
      }
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/google-calendar/oauth/callback"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("set-cookie")).toContain("atlas_google_link_session=");
    expect(html).toContain("Google Calendar connected");
    expect(html).toContain("Go back to Telegram and send that again.");
  });
});
