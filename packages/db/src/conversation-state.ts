import { randomUUID } from "node:crypto";

import {
  type ConversationDiscourseState,
  type ConversationEntity,
  type ConversationRecord,
  type ConversationRecordMode,
  type ConversationStateSnapshot,
  type ConversationTurn,
  conversationDiscourseStateSchema,
  conversationEntitySchema,
  conversationRecordModeSchema,
  conversationRecordSchema,
  conversationStateSnapshotSchema,
  conversationTurnSchema,
  createEmptyDiscourseState,
} from "@atlas/core";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  conversationDiscourseStates,
  conversationEntities,
  conversations,
  conversationTurns,
} from "./schema";

export interface ConversationStateStore {
  loadConversationState(
    userId: string,
    transcriptLimit: number,
  ): Promise<ConversationStateSnapshot | null>;
  appendConversationTurn(input: {
    userId: string;
    role: ConversationTurn["role"];
    text: string;
    createdAt?: string;
  }): Promise<void>;
  saveConversationState(input: {
    userId: string;
    title?: string | null;
    summaryText?: string | null;
    mode?: ConversationRecordMode | null;
    entityRegistry?: ConversationEntity[];
    discourseState?: ConversationDiscourseState | null;
    updatedAt?: string;
  }): Promise<ConversationStateSnapshot>;
}

class InMemoryConversationStateStore implements ConversationStateStore {
  private readonly conversationsByUserId = new Map<
    string,
    ConversationRecord
  >();
  private readonly turnsByConversationId = new Map<
    string,
    ConversationTurn[]
  >();
  private readonly entitiesByConversationId = new Map<
    string,
    ConversationEntity[]
  >();
  private readonly discourseByConversationId = new Map<
    string,
    ConversationDiscourseState | null
  >();

  async loadConversationState(
    userId: string,
    transcriptLimit: number,
  ): Promise<ConversationStateSnapshot | null> {
    const conversation = this.conversationsByUserId.get(userId);

    if (!conversation) {
      return null;
    }

    return buildSnapshot({
      conversation,
      transcript: (this.turnsByConversationId.get(conversation.id) ?? []).slice(
        -transcriptLimit,
      ),
      entityRegistry: this.entitiesByConversationId.get(conversation.id) ?? [],
      discourseState:
        this.discourseByConversationId.get(conversation.id) ?? null,
    });
  }

  async appendConversationTurn(input: {
    userId: string;
    role: ConversationTurn["role"];
    text: string;
    createdAt?: string;
  }): Promise<void> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const conversation = this.ensureConversation(input.userId, createdAt);
    const turns = this.turnsByConversationId.get(conversation.id) ?? [];

    turns.push(
      conversationTurnSchema.parse({
        role: input.role,
        text: input.text,
        createdAt,
      }),
    );

    this.turnsByConversationId.set(conversation.id, turns);
    this.conversationsByUserId.set(input.userId, {
      ...conversation,
      updatedAt: createdAt,
    });
  }

  async saveConversationState(input: {
    userId: string;
    title?: string | null;
    summaryText?: string | null;
    mode?: ConversationRecordMode | null;
    entityRegistry?: ConversationEntity[];
    discourseState?: ConversationDiscourseState | null;
    updatedAt?: string;
  }): Promise<ConversationStateSnapshot> {
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const existing = this.ensureConversation(input.userId, updatedAt);
    const nextConversation = conversationRecordSchema.parse({
      ...existing,
      title: input.title !== undefined ? input.title : existing.title,
      summaryText:
        input.summaryText !== undefined
          ? input.summaryText
          : existing.summaryText,
      mode: input.mode !== undefined ? input.mode : existing.mode,
      updatedAt,
    });

    this.conversationsByUserId.set(input.userId, nextConversation);

    if (input.entityRegistry !== undefined) {
      this.entitiesByConversationId.set(
        nextConversation.id,
        input.entityRegistry.map((entity) =>
          conversationEntitySchema.parse({
            ...entity,
            conversationId: nextConversation.id,
          }),
        ),
      );
    }

    if (input.discourseState !== undefined) {
      this.discourseByConversationId.set(
        nextConversation.id,
        input.discourseState
          ? conversationDiscourseStateSchema.parse(input.discourseState)
          : null,
      );
    }

    return buildSnapshot({
      conversation: nextConversation,
      transcript: this.turnsByConversationId.get(nextConversation.id) ?? [],
      entityRegistry:
        this.entitiesByConversationId.get(nextConversation.id) ?? [],
      discourseState:
        this.discourseByConversationId.get(nextConversation.id) ?? null,
    });
  }

  reset() {
    this.conversationsByUserId.clear();
    this.turnsByConversationId.clear();
    this.entitiesByConversationId.clear();
    this.discourseByConversationId.clear();
  }

  listSnapshots() {
    return Array.from(this.conversationsByUserId.keys());
  }

  private ensureConversation(userId: string, now: string) {
    const existing = this.conversationsByUserId.get(userId);

    if (existing) {
      return existing;
    }

    const created = conversationRecordSchema.parse({
      id: randomUUID(),
      userId,
      title: null,
      summaryText: null,
      mode: null,
      createdAt: now,
      updatedAt: now,
    });

    this.conversationsByUserId.set(userId, created);
    this.discourseByConversationId.set(created.id, createEmptyDiscourseState());

    return created;
  }
}

export class PostgresConversationStateStore implements ConversationStateStore {
  private readonly client;
  private readonly db;

  constructor(databaseUrl = getRequiredDatabaseUrl()) {
    this.client = postgres(databaseUrl, {
      prepare: false,
    });
    this.db = drizzle(this.client);
  }

  async loadConversationState(
    userId: string,
    transcriptLimit: number,
  ): Promise<ConversationStateSnapshot | null> {
    const conversation = await this.getLatestConversation(userId);

    if (!conversation) {
      return null;
    }

    const [turnRows, entityRows, discourseRow] = await Promise.all([
      this.db
        .select({
          role: conversationTurns.role,
          text: conversationTurns.text,
          createdAt: conversationTurns.createdAt,
        })
        .from(conversationTurns)
        .where(eq(conversationTurns.conversationId, conversation.id))
        .orderBy(desc(conversationTurns.createdAt))
        .limit(transcriptLimit),
      this.db
        .select({
          id: conversationEntities.id,
          kind: conversationEntities.kind,
          label: conversationEntities.label,
          status: conversationEntities.status,
          payload: conversationEntities.payload,
          createdAt: conversationEntities.createdAt,
          updatedAt: conversationEntities.updatedAt,
        })
        .from(conversationEntities)
        .where(eq(conversationEntities.conversationId, conversation.id))
        .orderBy(desc(conversationEntities.updatedAt)),
      this.db
        .select({
          payload: conversationDiscourseStates.payload,
        })
        .from(conversationDiscourseStates)
        .where(eq(conversationDiscourseStates.conversationId, conversation.id))
        .limit(1),
    ]);

    return buildSnapshot({
      conversation,
      transcript: turnRows.reverse().map((row) =>
        conversationTurnSchema.parse({
          role: row.role,
          text: row.text,
          createdAt: row.createdAt.toISOString(),
        }),
      ),
      entityRegistry: entityRows.map((row) =>
        conversationEntitySchema.parse({
          id: row.id,
          conversationId: conversation.id,
          kind: row.kind,
          label: row.label,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          data: row.payload,
        }),
      ),
      discourseState: discourseRow[0]
        ? conversationDiscourseStateSchema.parse(discourseRow[0].payload)
        : null,
    });
  }

  async appendConversationTurn(input: {
    userId: string;
    role: ConversationTurn["role"];
    text: string;
    createdAt?: string;
  }): Promise<void> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const conversation = await this.ensureConversation(input.userId, createdAt);

    await this.db.transaction(async (tx) => {
      await tx.insert(conversationTurns).values({
        id: randomUUID(),
        conversationId: conversation.id,
        userId: input.userId,
        role: input.role,
        text: input.text,
        createdAt: new Date(createdAt),
      });

      await tx
        .update(conversations)
        .set({
          updatedAt: new Date(createdAt),
        })
        .where(eq(conversations.id, conversation.id));
    });
  }

  async saveConversationState(input: {
    userId: string;
    title?: string | null;
    summaryText?: string | null;
    mode?: ConversationRecordMode | null;
    entityRegistry?: ConversationEntity[];
    discourseState?: ConversationDiscourseState | null;
    updatedAt?: string;
  }): Promise<ConversationStateSnapshot> {
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const conversation = await this.ensureConversation(input.userId, updatedAt);

    await this.db.transaction(async (tx) => {
      await tx
        .update(conversations)
        .set({
          title: input.title !== undefined ? input.title : conversation.title,
          summaryText:
            input.summaryText !== undefined
              ? input.summaryText
              : conversation.summaryText,
          mode: input.mode !== undefined ? input.mode : conversation.mode,
          updatedAt: new Date(updatedAt),
        })
        .where(eq(conversations.id, conversation.id));

      if (input.entityRegistry !== undefined) {
        await tx
          .delete(conversationEntities)
          .where(eq(conversationEntities.conversationId, conversation.id));

        if (input.entityRegistry.length > 0) {
          await tx.insert(conversationEntities).values(
            input.entityRegistry.map((entity) => ({
              id: entity.id,
              conversationId: conversation.id,
              userId: input.userId,
              kind: entity.kind,
              label: entity.label,
              status: entity.status,
              payload: entity.data,
              createdAt: new Date(entity.createdAt),
              updatedAt: new Date(entity.updatedAt),
            })),
          );
        }
      }

      if (input.discourseState !== undefined) {
        await tx
          .delete(conversationDiscourseStates)
          .where(
            eq(conversationDiscourseStates.conversationId, conversation.id),
          );

        if (input.discourseState) {
          await tx.insert(conversationDiscourseStates).values({
            conversationId: conversation.id,
            userId: input.userId,
            payload: conversationDiscourseStateSchema.parse(
              input.discourseState,
            ),
            updatedAt: new Date(updatedAt),
          });
        }
      }
    });

    const snapshot = await this.loadConversationState(input.userId, 50);

    if (!snapshot) {
      throw new Error(
        `Conversation state for user ${input.userId} was not persisted.`,
      );
    }

    return snapshot;
  }

  async close() {
    await this.client.end();
  }

  private async ensureConversation(userId: string, now: string) {
    const existing = await this.getLatestConversation(userId);

    if (existing) {
      return existing;
    }

    const created = conversationRecordSchema.parse({
      id: randomUUID(),
      userId,
      title: null,
      summaryText: null,
      mode: null,
      createdAt: now,
      updatedAt: now,
    });

    await this.db.transaction(async (tx) => {
      await tx.insert(conversations).values({
        id: created.id,
        userId: created.userId,
        title: created.title,
        summaryText: created.summaryText,
        mode: created.mode,
        createdAt: new Date(created.createdAt),
        updatedAt: new Date(created.updatedAt),
      });

      await tx.insert(conversationDiscourseStates).values({
        conversationId: created.id,
        userId,
        payload: createEmptyDiscourseState(),
        updatedAt: new Date(now),
      });
    });

    return created;
  }

  private async getLatestConversation(
    userId: string,
  ): Promise<ConversationRecord | null> {
    const rows = await this.db
      .select({
        id: conversations.id,
        userId: conversations.userId,
        title: conversations.title,
        summaryText: conversations.summaryText,
        mode: conversations.mode,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(desc(conversations.updatedAt))
      .limit(1);

    const row = rows[0];

    if (!row) {
      return null;
    }

    return conversationRecordSchema.parse({
      id: row.id,
      userId: row.userId,
      title: row.title,
      summaryText: row.summaryText,
      mode:
        row.mode === null ? null : conversationRecordModeSchema.parse(row.mode),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }
}

const defaultInMemoryStore = new InMemoryConversationStateStore();
let postgresStore: PostgresConversationStateStore | null = null;

export async function loadConversationState(
  userId: string,
  transcriptLimit: number,
  store: ConversationStateStore = getDefaultStore(),
) {
  return store.loadConversationState(userId, transcriptLimit);
}

export async function appendConversationTurn(
  input: {
    userId: string;
    role: ConversationTurn["role"];
    text: string;
    createdAt?: string;
  },
  store: ConversationStateStore = getDefaultStore(),
) {
  await store.appendConversationTurn(input);
}

export async function saveConversationState(
  input: {
    userId: string;
    title?: string | null;
    summaryText?: string | null;
    mode?: ConversationRecordMode | null;
    entityRegistry?: ConversationEntity[];
    discourseState?: ConversationDiscourseState | null;
    updatedAt?: string;
  },
  store: ConversationStateStore = getDefaultStore(),
) {
  return store.saveConversationState(input);
}

export function resetConversationStateStoreForTests() {
  defaultInMemoryStore.reset();
}

export function listConversationStateUsersForTests() {
  return defaultInMemoryStore.listSnapshots();
}

function getDefaultStore():
  | InMemoryConversationStateStore
  | PostgresConversationStateStore {
  if (isTestEnvironment()) {
    return defaultInMemoryStore;
  }

  if (!postgresStore) {
    postgresStore = new PostgresConversationStateStore();
  }

  return postgresStore;
}

function buildSnapshot(input: {
  conversation: ConversationRecord;
  transcript: ConversationTurn[];
  entityRegistry: ConversationEntity[];
  discourseState: ConversationDiscourseState | null;
}) {
  return conversationStateSnapshotSchema.parse(input);
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
