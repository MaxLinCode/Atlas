import { NextResponse } from "next/server";

export function jsonOk<T>(payload: T, init?: ResponseInit) {
  return NextResponse.json(payload, {
    status: 200,
    ...init,
  });
}
