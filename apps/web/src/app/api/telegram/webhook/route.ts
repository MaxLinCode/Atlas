import { telegramWebhookHandler } from "@atlas/integrations";
import { jsonOk } from "@/lib/server/http";

export async function POST(request: Request) {
  const result = await telegramWebhookHandler(request);
  return jsonOk(result);
}

