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
  recordIfAbsent(event: StoredBotEvent): Promise<IncomingBotEventRecordResult>;
}

class InMemoryIncomingBotEventStore implements IncomingBotEventStore {
  private readonly eventsByKey = new Map<string, StoredBotEvent>();

  async recordIfAbsent(event: StoredBotEvent): Promise<IncomingBotEventRecordResult> {
    if (this.eventsByKey.has(event.idempotencyKey)) {
      return {
        status: "duplicate"
      };
    }

    this.eventsByKey.set(event.idempotencyKey, event);

    return {
      status: "recorded",
      eventId: event.id
    };
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
  const eventId = randomUUID();

  return store.recordIfAbsent({
    id: eventId,
    direction: "incoming",
    retryState: "received",
    ...input
  });
}

export function resetIncomingBotEventStoreForTests() {
  defaultStore.reset();
}

export function listIncomingBotEventsForTests() {
  return defaultStore.list();
}
