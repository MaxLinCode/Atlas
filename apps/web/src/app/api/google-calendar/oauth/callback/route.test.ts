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

  it("returns an html expired-link page when oauth state is invalid", async () => {
    handleGoogleCalendarOauthCallbackMock.mockResolvedValueOnce({
      status: 400,
      body: {
        accepted: false,
        error: "invalid_oauth_state"
      },
      headers: {
        "set-cookie": "atlas_google_link_session=; Path=/; Max-Age=0"
      }
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/google-calendar/oauth/callback"));
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("set-cookie")).toContain("atlas_google_link_session=");
    expect(html).toContain("Google Calendar link expired");
    expect(html).toContain("request a fresh connect link");
  });

  it("returns an html failure page when callback handling throws", async () => {
    handleGoogleCalendarOauthCallbackMock.mockRejectedValueOnce(new Error("boom"));

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/google-calendar/oauth/callback"));
    const html = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("Google Calendar connection failed");
    expect(html).toContain("try the link again");
  });
});
