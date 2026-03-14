import { jsonOk } from "@/lib/server/http";
import { processInboxItem } from "@/lib/server/process-inbox-item";

export async function POST(request: Request) {
  const body = await request.json();
  const result = await processInboxItem(body);
  return jsonOk(result);
}
