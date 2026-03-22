import { NextResponse } from "next/server";

import { jsonOk } from "@/lib/server/http";
import { runBundledFollowUps } from "@/lib/server/follow-up";

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return {
      ok: false as const,
      status: 503,
      body: {
        accepted: false,
        error: "cron_secret_not_configured"
      }
    };
  }

  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return {
      ok: false as const,
      status: 401,
      body: {
        accepted: false,
        error: "invalid_cron_secret"
      }
    };
  }

  return { ok: true as const };
}

async function handleRequest(request: Request) {
  const auth = isAuthorized(request);

  if (!auth.ok) {
    return NextResponse.json(auth.body, { status: auth.status });
  }

  return jsonOk(await runBundledFollowUps());
}

export async function GET(request: Request) {
  return handleRequest(request);
}

export async function POST(request: Request) {
  return handleRequest(request);
}
