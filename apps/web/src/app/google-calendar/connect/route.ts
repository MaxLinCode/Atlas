import { NextResponse } from "next/server";

import {
  handleGoogleCalendarConnectConfirm,
  handleGoogleCalendarConnectPreview,
} from "@/lib/server/google-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const result = await handleGoogleCalendarConnectPreview(request);

  if (
    result.status === 200 &&
    "confirmation" in result &&
    result.confirmation
  ) {
    return new NextResponse(
      buildGoogleCalendarConnectHtml({
        token: typeof result.body.token === "string" ? result.body.token : "",
        title: result.confirmation.title,
        message: result.confirmation.message,
        actionLabel: result.confirmation.actionLabel,
      }),
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      },
    );
  }

  const redirectHeaders = getRedirectHeaders(result);

  if (redirectHeaders) {
    const response = NextResponse.redirect(
      new URL(redirectHeaders.location, request.url),
      {
        status: result.status,
      },
    );

    if (redirectHeaders["set-cookie"]) {
      response.headers.set("set-cookie", redirectHeaders["set-cookie"]);
    }

    return response;
  }

  const response = NextResponse.json(
    "body" in result
      ? result.body
      : {
          accepted: false,
          error: "unexpected_connect_result",
        },
    {
      status: result.status,
    },
  );

  const cookieHeaders = getRedirectHeaders(result);
  if (cookieHeaders?.["set-cookie"]) {
    response.headers.set("set-cookie", cookieHeaders["set-cookie"]);
  }

  return response;
}

export async function POST(request: Request) {
  const result = await handleGoogleCalendarConnectConfirm(request);

  const redirectHeaders = getRedirectHeaders(result);

  if (redirectHeaders) {
    const response = NextResponse.redirect(
      new URL(redirectHeaders.location, request.url),
      {
        status: result.status,
      },
    );

    if (redirectHeaders["set-cookie"]) {
      response.headers.set("set-cookie", redirectHeaders["set-cookie"]);
    }

    return response;
  }

  if ("body" in result) {
    return NextResponse.json(result.body, {
      status: result.status,
    });
  }

  return NextResponse.json(
    {
      accepted: false,
      error: "unexpected_connect_result",
    },
    {
      status: 500,
    },
  );
}

function buildGoogleCalendarConnectHtml(input: {
  token: string;
  title: string;
  message: string;
  actionLabel: string;
}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f1e8;
        color: #1f2937;
      }
      main {
        max-width: 34rem;
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
      }
      p {
        margin: 0 0 1.25rem;
        line-height: 1.6;
      }
      button {
        border: 0;
        border-radius: 999px;
        padding: 0.8rem 1.2rem;
        font-size: 1rem;
        font-weight: 600;
        background: #1f2937;
        color: #fffdf8;
        cursor: pointer;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.message)}</p>
      <form method="post">
        <input type="hidden" name="token" value="${escapeHtml(input.token)}" />
        <button type="submit">${escapeHtml(input.actionLabel)}</button>
      </form>
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

function getRedirectHeaders(
  result: unknown,
): { location: string; "set-cookie"?: string } | null {
  if (
    typeof result === "object" &&
    result !== null &&
    "headers" in result &&
    typeof result.headers === "object" &&
    result.headers !== null &&
    "location" in result.headers &&
    typeof result.headers.location === "string"
  ) {
    return result.headers as { location: string; "set-cookie"?: string };
  }

  return null;
}
