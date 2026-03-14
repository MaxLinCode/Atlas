import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { botEvents, inboxItems } from "./schema";

export type BotEventDirection = "incoming" | "outgoing";
export type BotEventRetryState = "received" | "sending" | "sent" | "failed";

type StoredBotEvent = {
  id: string;
  userId: string;
  direction: BotEventDirection;
  eventType: string;
  idempotencyKey: string;
  payload: unknown;
  retryState: BotEventRetryState;
};

export type IncomingTelegramMessage = {
  userId: string;
  eventType: string;
  idempotencyKey: string;
  payload: unknown;
  rawText: string;
  normalizedText: string;
};

export type OutgoingTelegramMessage = {
  userId: string;
  eventType: string;
  idempotencyKey: string;
  payload: unknown;
  retryState: Extract<BotEventRetryState, "sending" | "sent" | "failed">;
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

export type OutgoingTelegramMessageRecordResult =
  | {
      status: "reserved";
      eventId: string;
    }
  | {
      status: "duplicate";
    };

export interface IncomingTelegramIngressStore {
  recordIncomingIfAbsent(
    event: StoredBotEvent,
    inboxItem: PersistedInboxItem
  ): Promise<IncomingTelegramMessageRecordResult>;
}

export interface OutgoingTelegramDeliveryStore {
  reserveOutgoingIfAbsent(event: StoredBotEvent): Promise<OutgoingTelegramMessageRecordResult>;
  updateOutgoing(event: Pick<StoredBotEvent, "idempotencyKey" | "payload" | "retryState">): Promise<void>;
}

class InMemoryTelegramBotEventStore
  implements IncomingTelegramIngressStore, OutgoingTelegramDeliveryStore
{
  private readonly eventsByKey = new Map<string, StoredBotEvent>();
  private readonly inboxItemsById = new Map<string, PersistedInboxItem>();

  async recordIncomingIfAbsent(
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

  async reserveOutgoingIfAbsent(event: StoredBotEvent): Promise<OutgoingTelegramMessageRecordResult> {
    if (this.eventsByKey.has(event.idempotencyKey)) {
      return {
        status: "duplicate"
      };
    }

    this.eventsByKey.set(event.idempotencyKey, event);

    return {
      status: "reserved",
      eventId: event.id
    };
  }

  async updateOutgoing(event: Pick<StoredBotEvent, "idempotencyKey" | "payload" | "retryState">): Promise<void> {
    const existingEvent = this.eventsByKey.get(event.idempotencyKey);

    if (!existingEvent) {
      throw new Error(`Outgoing bot event ${event.idempotencyKey} not found.`);
    }

    this.eventsByKey.set(event.idempotencyKey, {
      ...existingEvent,
      payload: event.payload,
      retryState: event.retryState
    });
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

export class PostgresTelegramBotEventStore
  implements IncomingTelegramIngressStore, OutgoingTelegramDeliveryStore
{
  private readonly client;
  private readonly db;

  constructor(databaseUrl = getRequiredDatabaseUrl()) {
    this.client = postgres(databaseUrl, {
      prepare: false
    });
    this.db = drizzle(this.client);
  }

  async recordIncomingIfAbsent(
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

  async reserveOutgoingIfAbsent(event: StoredBotEvent): Promise<OutgoingTelegramMessageRecordResult> {
    const insertedEvent = await this.db
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
        status: "duplicate"
      };
    }

    return {
      status: "reserved",
      eventId: event.id
    };
  }

  async updateOutgoing(event: Pick<StoredBotEvent, "idempotencyKey" | "payload" | "retryState">): Promise<void> {
    await this.db
      .update(botEvents)
      .set({
        payload: event.payload,
        retryState: event.retryState
      })
      .where(sql`${botEvents.idempotencyKey} = ${event.idempotencyKey} and ${botEvents.direction} = 'outgoing'`);
  }

  async close() {
    await this.client.end();
  }
}

const defaultInMemoryStore = new InMemoryTelegramBotEventStore();
let postgresStore: PostgresTelegramBotEventStore | null = null;

export async function recordIncomingTelegramMessageIfNew(
  input: IncomingTelegramMessage,
  store: IncomingTelegramIngressStore = getDefaultStore()
): Promise<IncomingTelegramMessageRecordResult> {
  const eventId = randomUUID();
  const inboxItemId = randomUUID();

  return store.recordIncomingIfAbsent(
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

export async function recordOutgoingTelegramMessageIfNew(
  input: OutgoingTelegramMessage,
  store: OutgoingTelegramDeliveryStore = getDefaultStore()
): Promise<OutgoingTelegramMessageRecordResult> {
  return store.reserveOutgoingIfAbsent({
    id: randomUUID(),
    userId: input.userId,
    direction: "outgoing",
    eventType: input.eventType,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    retryState: input.retryState
  });
}

export async function updateOutgoingTelegramMessage(
  input: Pick<OutgoingTelegramMessage, "idempotencyKey" | "payload" | "retryState">,
  store: OutgoingTelegramDeliveryStore = getDefaultStore()
) {
  await store.updateOutgoing(input);
}

export function resetIncomingTelegramIngressStoreForTests() {
  defaultInMemoryStore.reset();
}

export function listIncomingBotEventsForTests() {
  return defaultInMemoryStore.listEvents().filter((event) => event.direction === "incoming");
}

export function listOutgoingBotEventsForTests() {
  return defaultInMemoryStore.listEvents().filter((event) => event.direction === "outgoing");
}

export function listInboxItemsForTests() {
  return defaultInMemoryStore.listInboxItems();
}

function getDefaultStore(): InMemoryTelegramBotEventStore | PostgresTelegramBotEventStore {
  if (isTestEnvironment()) {
    return defaultInMemoryStore;
  }

  if (!postgresStore) {
    postgresStore = new PostgresTelegramBotEventStore();
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
