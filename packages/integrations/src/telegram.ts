export async function telegramWebhookHandler(request: Request) {
  const payload = await request.json().catch(() => null);

  return {
    accepted: true,
    delivery: "webhook",
    payload
  };
}

export async function dispatchReminderBatch() {
  return {
    dispatched: 0,
    message: "Reminder dispatch is not implemented yet."
  };
}

