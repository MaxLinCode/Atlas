import { describe, expect, it, vi } from "vitest";

const { handleGoogleCalendarConnectConfirmMock, handleGoogleCalendarConnectPreviewMock } = vi.hoisted(() => ({
  handleGoogleCalendarConnectPreviewMock: vi.fn(),
  handleGoogleCalendarConnectConfirmMock: vi.fn()
}));

vi.mock("@/lib/server/google-calendar", () => ({
  handleGoogleCalendarConnectPreview: handleGoogleCalendarConnectPreviewMock,
  handleGoogleCalendarConnectConfirm: handleGoogleCalendarConnectConfirmMock
}));

describe("google calendar connect route", () => {
  it("renders a confirmation page on get without consuming the handoff", async () => {
    handleGoogleCalendarConnectPreviewMock.mockResolvedValueOnce({
      status: 200,
      body: {
        accepted: true,
        token: "signed-token"
      },
      confirmation: {
        title: "Connect Google Calendar",
        message: "Atlas needs access to your Google Calendar before it can schedule work for you.",
        actionLabel: "Continue to Google"
      }
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/google-calendar/connect?token=signed-token"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("Connect Google Calendar");
    expect(html).toContain('method="post"');
    expect(html).toContain('name="token" value="signed-token"');
  });

  it("consumes the handoff and redirects on post", async () => {
    handleGoogleCalendarConnectConfirmMock.mockResolvedValueOnce({
      status: 302,
      headers: {
        location: "/api/google-calendar/oauth/start",
        "set-cookie": "atlas_google_link_session=abc; Path=/"
      }
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/google-calendar/connect", {
        method: "POST",
        body: new URLSearchParams({
          token: "signed-token"
        })
      })
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost/api/google-calendar/oauth/start");
    expect(response.headers.get("set-cookie")).toContain("atlas_google_link_session=abc");
  });
});
