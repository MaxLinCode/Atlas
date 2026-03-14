import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { botEvents, inboxItems } from "./schema";

export type IncomingTelegramMessage = {
  userId: string;
  eventType: string;
  idempotencyKey: string;
  payload: unknown;
  rawText: string;
  normalizedText: string;
};

export type PersistedInboxItem = {
  id: string;
  userId: string;
  sourceEventId: string;
  rawText: string;
  normalizedText: string;
  processingStatus: "received";
  linkedTaskIds: string[];
};

export type IncomingTelegramMessageRecordResult =
  | {
      status: "recorded";
      eventId: string;
      inboxItem: PersistedInboxItem;
    }
  | {
      status: "duplicate";
    };

type StoredBotEvent = {
  id: string;
  userId: string;
  direction: "incoming";
  eventType: string;
  idempotencyKey: string;
  payload: unknown;
  retryState: "received";
};

export interface IncomingTelegramIngressStore {
  recordIfAbsent(
    event: StoredBotEvent,
    inboxItem: PersistedInboxItem
  ): Promise<IncomingTelegramMessageRecordResult>;
}

class InMemoryIncomingTelegramIngressStore implements IncomingTelegramIngressStore {
  private readonly eventsByKey = new Map<string, StoredBotEvent>();
  private readonly inboxItemsById = new Map<string, PersistedInboxItem>();

  async recordIfAbsent(
    event: StoredBotEvent,
    inboxItem: PersistedInboxItem
  ): Promise<IncomingTelegramMessageRecordResult> {
    if (this.eventsByKey.has(event.idempotencyKey)) {
      return {
        status: "duplicate"
      };
    }

    this.eventsByKey.set(event.idempotencyKey, event);
    this.inboxItemsById.set(inboxItem.id, inboxItem);

    return {
      status: "recorded",
      eventId: event.id,
      inboxItem
    };
  }

  reset() {
    this.eventsByKey.clear();
    this.inboxItemsById.clear();
  }

  listEvents() {
    return Array.from(this.eventsByKey.values());
  }

  listInboxItems() {
    return Array.from(this.inboxItemsById.values());
  }
}

export class PostgresIncomingTelegramIngressStore implements IncomingTelegramIngressStore {
  private readonly client;
  private readonly db;

  constructor(databaseUrl = getRequiredDatabaseUrl()) {
    this.client = postgres(databaseUrl, {
      prepare: false
    });
    this.db = drizzle(this.client);
  }

  async recordIfAbsent(
    event: StoredBotEvent,
    inboxItem: PersistedInboxItem
  ): Promise<IncomingTelegramMessageRecordResult> {
    return this.db.transaction(async (tx) => {
      const insertedEvent = await tx
        .insert(botEvents)
        .values({
          id: event.id,
          userId: event.userId,
          direction: event.direction,
          eventType: event.eventType,
          idempotencyKey: event.idempotencyKey,
          payload: event.payload,
          retryState: event.retryState
        })
        .onConflictDoNothing({
          target: botEvents.idempotencyKey
        })
        .returning({
          id: botEvents.id
        });

      if (insertedEvent.length === 0) {
        return {
          status: "duplicate" as const
        };
      }

      await tx.insert(inboxItems).values({
        id: inboxItem.id,
        userId: inboxItem.userId,
        sourceEventId: inboxItem.sourceEventId,
        rawText: inboxItem.rawText,
        normalizedText: inboxItem.normalizedText,
        processingStatus: inboxItem.processingStatus,
        linkedTaskIds: inboxItem.linkedTaskIds
      });

      return {
        status: "recorded" as const,
        eventId: event.id,
        inboxItem
      };
    });
  }

  async close() {
    await this.client.end();
  }
}

const defaultInMemoryStore = new InMemoryIncomingTelegramIngressStore();
let postgresStore: PostgresIncomingTelegramIngressStore | null = null;

export async function recordIncomingTelegramMessageIfNew(
  input: IncomingTelegramMessage,
  store: IncomingTelegramIngressStore = getDefaultStore()
): Promise<IncomingTelegramMessageRecordResult> {
  const eventId = randomUUID();
  const inboxItemId = randomUUID();

  return store.recordIfAbsent(
    {
      id: eventId,
      userId: input.userId,
      direction: "incoming",
      eventType: input.eventType,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      retryState: "received"
    },
    {
      id: inboxItemId,
      userId: input.userId,
      sourceEventId: eventId,
      rawText: input.rawText,
      normalizedText: input.normalizedText,
      processingStatus: "received",
      linkedTaskIds: []
    }
  );
}

export function resetIncomingTelegramIngressStoreForTests() {
  defaultInMemoryStore.reset();
}

export function listIncomingBotEventsForTests() {
  return defaultInMemoryStore.listEvents();
}

export function listInboxItemsForTests() {
  return defaultInMemoryStore.listInboxItems();
}

function getDefaultStore(): IncomingTelegramIngressStore {
  if (isTestEnvironment()) {
    return defaultInMemoryStore;
  }

  if (!postgresStore) {
    postgresStore = new PostgresIncomingTelegramIngressStore();
  }

  return postgresStore;
}

function isTestEnvironment() {
  return process.env.NODE_ENV === "test";
}

function hasConfiguredDatabaseUrl(url = process.env.DATABASE_URL) {
  return typeof url === "string" && /^postgres(ql)?:\/\//.test(url);
}

function getRequiredDatabaseUrl(url = process.env.DATABASE_URL) {
  if (typeof url !== "string" || !hasConfiguredDatabaseUrl(url)) {
    throw new Error("DATABASE_URL must be a Postgres connection string.");
  }

  return url;
}
