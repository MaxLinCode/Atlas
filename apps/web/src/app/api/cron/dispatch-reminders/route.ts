import { dispatchReminderBatch } from "@atlas/integrations";
import { jsonOk } from "@/lib/server/http";

export async function POST() {
  const result = await dispatchReminderBatch();
  return jsonOk(result);
}

