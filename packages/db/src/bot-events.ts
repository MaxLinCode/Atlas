import { randomUUID } from "node:crypto";

export type IncomingBotEvent = {
  userId: string;
  eventType: string;
  idempotencyKey: string;
  payload: unknown;
};

export type IncomingBotEventRecordResult =
  | {
      status: "recorded";
      eventId: string;
    }
  | {
      status: "duplicate";
    };

type StoredBotEvent = IncomingBotEvent & {
  id: string;
  direction: "incoming";
  retryState: "received";
};

export interface IncomingBotEventStore {
  has(idempotencyKey: string): Promise<boolean>;
  save(event: StoredBotEvent): Promise<void>;
}

class InMemoryIncomingBotEventStore implements IncomingBotEventStore {
  private readonly eventsByKey = new Map<string, StoredBotEvent>();

  async has(idempotencyKey: string) {
    return this.eventsByKey.has(idempotencyKey);
  }

  async save(event: StoredBotEvent) {
    this.eventsByKey.set(event.idempotencyKey, event);
  }

  reset() {
    this.eventsByKey.clear();
  }

  list() {
    return Array.from(this.eventsByKey.values());
  }
}

const defaultStore = new InMemoryIncomingBotEventStore();

export async function recordIncomingBotEventIfNew(
  input: IncomingBotEvent,
  store: IncomingBotEventStore = defaultStore
): Promise<IncomingBotEventRecordResult> {
  if (await store.has(input.idempotencyKey)) {
    return {
      status: "duplicate"
    };
  }

  const eventId = randomUUID();

  await store.save({
    id: eventId,
    direction: "incoming",
    retryState: "received",
    ...input
  });

  return {
    status: "recorded",
    eventId
  };
}

export function resetIncomingBotEventStoreForTests() {
  defaultStore.reset();
}

export function listIncomingBotEventsForTests() {
  return defaultStore.list();
}
