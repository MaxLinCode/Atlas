import { NextResponse } from "next/server";

import { handleGoogleCalendarOauthCallback } from "@/lib/server/google-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const result = await handleGoogleCalendarOauthCallback(request);

    if (result.status === 200 && "completion" in result && result.completion) {
      const response = buildHtmlResponse({
        status: 200,
        title: result.completion.title,
        message: result.completion.message,
      });

      if ("headers" in result && result.headers["set-cookie"]) {
        response.headers.set("set-cookie", result.headers["set-cookie"]);
      }

      return response;
    }

    const response = buildHtmlResponse({
      status: result.status,
      ...buildFailureContent(result),
    });

    if ("headers" in result && result.headers["set-cookie"]) {
      response.headers.set("set-cookie", result.headers["set-cookie"]);
    }

    return response;
  } catch {
    return buildHtmlResponse({
      status: 500,
      title: "Google Calendar connection failed",
      message:
        "Atlas could not finish connecting Google Calendar. Please go back to Telegram and try the link again.",
    });
  }
}

function buildHtmlResponse(input: {
  status: number;
  title: string;
  message: string;
}) {
  return new NextResponse(
    buildGoogleCalendarConnectedHtml(input.title, input.message),
    {
      status: input.status,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    },
  );
}

function buildFailureContent(result: { status: number; body?: unknown }) {
  const error =
    typeof result.body === "object" &&
    result.body !== null &&
    "error" in result.body &&
    typeof result.body.error === "string"
      ? result.body.error
      : null;

  if (error === "invalid_oauth_state" || error === "missing_oauth_params") {
    return {
      title: "Google Calendar link expired",
      message:
        "This Google Calendar link is no longer valid. Go back to Telegram and request a fresh connect link.",
    };
  }

  return {
    title: "Google Calendar connection failed",
    message:
      "Atlas could not finish connecting Google Calendar. Please go back to Telegram and try the link again.",
  };
}

function buildGoogleCalendarConnectedHtml(title: string, message: string) {
  const escapedTitle = escapeHtml(title);
  const escapedMessage = escapeHtml(message);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapedTitle}</title>
    <style>
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f1e8;
        color: #1f2937;
      }
      main {
        max-width: 32rem;
        margin: 12vh auto;
        padding: 2rem;
        background: #fffdf8;
        border: 1px solid #d6cfc2;
        border-radius: 1rem;
        box-shadow: 0 10px 30px rgba(31, 41, 55, 0.08);
      }
      h1 {
        margin: 0 0 0.75rem;
        font-size: 1.75rem;
        line-height: 1.2;
      }
      p {
        margin: 0;
        font-size: 1rem;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapedTitle}</h1>
      <p>${escapedMessage}</p>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
