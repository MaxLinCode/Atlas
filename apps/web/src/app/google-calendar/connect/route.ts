import { NextResponse } from "next/server";

import { handleGoogleCalendarConnect } from "@/lib/server/google-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const result = await handleGoogleCalendarConnect(request);

  if ("headers" in result && result.headers.location) {
    const response = NextResponse.redirect(new URL(result.headers.location, request.url), {
      status: result.status
    });

    if (result.headers["set-cookie"]) {
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
