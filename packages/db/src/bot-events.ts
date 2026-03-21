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
  createdAt: string;
};

type StoredInboxItem = PersistedInboxItem & {
  createdAt: string;
};

export type IncomingTelegramMessage = {
  userId: string;
  eventType: string;
  idempotencyKey: string;
  payload: unknown;
  rawText: string;
  normalizedText: string;
  createdAt?: string;
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

export type ConversationTurn = {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
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
    inboxItem: StoredInboxItem
  ): Promise<IncomingTelegramMessageRecordResult>;
}

export interface OutgoingTelegramDeliveryStore {
  reserveOutgoingIfAbsent(event: StoredBotEvent): Promise<OutgoingTelegramMessageRecordResult>;
  updateOutgoing(event: Pick<StoredBotEvent, "idempotencyKey" | "payload" | "retryState">): Promise<void>;
}

export interface ConversationHistoryStore {
  listRecentConversationTurns(userId: string, limit: number): Promise<ConversationTurn[]>;
}

class InMemoryTelegramBotEventStore
  implements IncomingTelegramIngressStore, OutgoingTelegramDeliveryStore, ConversationHistoryStore
{
  private readonly eventsByKey = new Map<string, StoredBotEvent>();
  private readonly inboxItemsById = new Map<string, StoredInboxItem>();

  async recordIncomingIfAbsent(
    event: StoredBotEvent,
    inboxItem: StoredInboxItem
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

  async listRecentConversationTurns(userId: string, limit: number): Promise<ConversationTurn[]> {
    return buildRecentConversationTurns({
      inboxItems: Array.from(this.inboxItemsById.values()).filter((item) => item.userId === userId),
      events: Array.from(this.eventsByKey.values()).filter((event) => event.userId === userId),
      limit
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
  implements IncomingTelegramIngressStore, OutgoingTelegramDeliveryStore, ConversationHistoryStore
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
    inboxItem: StoredInboxItem
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
          retryState: event.retryState,
          createdAt: new Date(event.createdAt)
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
        linkedTaskIds: inboxItem.linkedTaskIds,
        createdAt: new Date(inboxItem.createdAt)
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
        retryState: event.retryState,
        createdAt: new Date(event.createdAt)
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

  async listRecentConversationTurns(userId: string, limit: number): Promise<ConversationTurn[]> {
    const [inboxItemRows, eventRows] = await Promise.all([
      this.db
        .select({
          rawText: inboxItems.rawText,
          createdAt: inboxItems.createdAt
        })
        .from(inboxItems)
        .where(sql`${inboxItems.userId} = ${userId}`)
        .orderBy(sql`${inboxItems.createdAt} desc`)
        .limit(limit),
      this.db
        .select({
          eventType: botEvents.eventType,
          payload: botEvents.payload,
          createdAt: botEvents.createdAt
        })
        .from(botEvents)
        .where(
          sql`${botEvents.userId} = ${userId} and ${botEvents.direction} = 'outgoing' and ${botEvents.retryState} = 'sent'`
        )
        .orderBy(sql`${botEvents.createdAt} desc`)
        .limit(limit)
    ]);

    return buildRecentConversationTurns({
      inboxItems: inboxItemRows.reverse().map((row) => ({
        rawText: row.rawText,
        createdAt: row.createdAt.toISOString()
      })),
      events: eventRows.reverse().map((row) => ({
        eventType: row.eventType,
        payload: row.payload,
        createdAt: row.createdAt.toISOString(),
        retryState: "sent" as const
      })),
      limit
    });
  }

  async close() {
    await this.client.end();
  }
}

export class PostgresIncomingTelegramIngressStore extends PostgresTelegramBotEventStore {}
export class PostgresOutgoingTelegramDeliveryStore extends PostgresTelegramBotEventStore {}

const defaultInMemoryStore = new InMemoryTelegramBotEventStore();
let postgresStore: PostgresTelegramBotEventStore | null = null;

export async function recordIncomingTelegramMessageIfNew(
  input: IncomingTelegramMessage,
  store: IncomingTelegramIngressStore = getDefaultStore()
): Promise<IncomingTelegramMessageRecordResult> {
  const eventId = randomUUID();
  const inboxItemId = randomUUID();
  const createdAt = input.createdAt ?? new Date().toISOString();

  return store.recordIncomingIfAbsent(
    {
      id: eventId,
      userId: input.userId,
      direction: "incoming",
      eventType: input.eventType,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      retryState: "received",
      createdAt
    },
    {
      id: inboxItemId,
      userId: input.userId,
      sourceEventId: eventId,
      rawText: input.rawText,
      normalizedText: input.normalizedText,
      processingStatus: "received",
      linkedTaskIds: [],
      createdAt
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
    retryState: input.retryState,
    createdAt: new Date().toISOString()
  });
}

export async function listRecentConversationTurns(
  userId: string,
  limit: number,
  store: ConversationHistoryStore = getDefaultStore()
) {
  return store.listRecentConversationTurns(userId, limit);
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

function buildRecentConversationTurns(input: {
  inboxItems: Array<{
    rawText: string;
    createdAt: string;
  }>;
  events: Array<{
    eventType?: string;
    payload: unknown;
    createdAt: string;
    retryState?: BotEventRetryState;
  }>;
  limit: number;
}) {
  const turns = [
    ...input.inboxItems.map<ConversationTurn>((item) => ({
      role: "user",
      text: item.rawText,
      createdAt: item.createdAt
    })),
    ...input.events.flatMap<ConversationTurn>((event) => {
      if (event.retryState && event.retryState !== "sent") {
        return [];
      }

      const text = readOutgoingText(event.payload);

      if (!text || shouldExcludeConversationEvent(event.eventType, text)) {
        return [];
      }

      return [
        {
          role: "assistant",
          text,
          createdAt: event.createdAt
        }
      ];
    })
  ];

  return turns
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(-input.limit);
}

function readOutgoingText(payload: unknown) {
  if (!payload || typeof payload !== "object" || !("text" in payload)) {
    return null;
  }

  const { text } = payload;
  return typeof text === "string" && text.trim() ? text : null;
}

function shouldExcludeConversationEvent(eventType: string | undefined, text: string) {
  if (eventType === "telegram_google_calendar_link") {
    return true;
  }

  return (
    text.includes("[redacted Google Calendar connect link]") ||
    text.includes("I need access to your Google Calendar first. Connect here:")
  );
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
