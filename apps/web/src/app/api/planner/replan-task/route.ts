import { replanTask } from "@atlas/core";
import { jsonOk } from "@/lib/server/http";

export async function POST(request: Request) {
  const body = await request.json();
  const result = await replanTask(body);
  return jsonOk(result);
}
