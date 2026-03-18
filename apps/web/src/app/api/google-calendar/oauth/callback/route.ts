import { NextResponse } from "next/server";

import { handleGoogleCalendarOauthCallback } from "@/lib/server/google-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const result = await handleGoogleCalendarOauthCallback(request);

  if (result.status === 200 && "completion" in result && result.completion) {
    const response = new NextResponse(
      buildGoogleCalendarConnectedHtml(result.completion.title, result.completion.message),
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8"
        }
      }
    );

    if ("headers" in result && result.headers["set-cookie"]) {
      response.headers.set("set-cookie", result.headers["set-cookie"]);
    }

    return response;
  }

  const response = NextResponse.json(result.body, {
    status: result.status
  });

  if ("headers" in result && result.headers["set-cookie"]) {
    response.headers.set("set-cookie", result.headers["set-cookie"]);
  }

  return response;
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
