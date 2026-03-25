import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Task } from "@atlas/core";
import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  googleCalendarAccounts,
  googleCalendarLinkHandoffs,
  googleCalendarLinkSessions,
  googleCalendarOauthStates,
  tasks,
} from "./schema";

const CREDENTIAL_CIPHERTEXT_VERSION = "v1";

export type GoogleCalendarConnection = {
  userId: string;
  providerAccountId: string;
  email: string;
  selectedCalendarId: string;
  selectedCalendarName: string;
  tokenExpiresAt: string | null;
  scopes: string[];
  syncCursor: string | null;
  lastSyncedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GoogleCalendarConnectionCredentials = GoogleCalendarConnection & {
  accessToken: string;
  refreshToken: string | null;
};

export type GoogleCalendarOauthState = {
  state: string;
  userId: string;
  redirectPath: string | null;
  expiresAt: string;
  codeVerifier: string | null;
  consumedAt: string | null;
  createdAt: string;
};

export type GoogleCalendarLinkHandoff = {
  id: string;
  userId: string;
  redirectPath: string | null;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
};

export type GoogleCalendarLinkSession = {
  id: string;
  userId: string;
  redirectPath: string | null;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
};

export interface GoogleCalendarConnectionStore {
  getConnection(userId: string): Promise<GoogleCalendarConnection | null>;
  getConnectionCredentials(
    userId: string,
  ): Promise<GoogleCalendarConnectionCredentials | null>;
  upsertConnection(
    input: Omit<GoogleCalendarConnectionCredentials, "createdAt" | "updatedAt">,
  ): Promise<GoogleCalendarConnection>;
  updateConnectionTokens(input: {
    userId: string;
    accessToken: string;
    refreshToken: string | null;
    tokenExpiresAt: string | null;
  }): Promise<GoogleCalendarConnectionCredentials>;
  listActiveConnections(): Promise<GoogleCalendarConnection[]>;
  createOauthState(input: {
    state: string;
    userId: string;
    redirectPath: string | null;
    expiresAt: string;
    codeVerifier?: string | null;
  }): Promise<GoogleCalendarOauthState>;
  getOauthState(state: string): Promise<GoogleCalendarOauthState | null>;
  markOauthStateConsumed(
    state: string,
  ): Promise<GoogleCalendarOauthState | null>;
  createLinkHandoff(input: {
    id: string;
    userId: string;
    redirectPath: string | null;
    expiresAt: string;
  }): Promise<GoogleCalendarLinkHandoff>;
  consumeLinkHandoff(id: string): Promise<GoogleCalendarLinkHandoff | null>;
  createLinkSession(input: {
    id: string;
    userId: string;
    redirectPath: string | null;
    expiresAt: string;
  }): Promise<GoogleCalendarLinkSession>;
  getLinkSession(id: string): Promise<GoogleCalendarLinkSession | null>;
  consumeLinkSession(id: string): Promise<GoogleCalendarLinkSession | null>;
  purgeExpiredOauthStates(before: string): Promise<number>;
  scrubRevokedCredentials(): Promise<number>;
  listTasksForReconciliation(input: {
    userId: string;
    scheduledThrough: string;
  }): Promise<Task[]>;
  reconcileTaskProjection(input: {
    taskId: string;
    externalCalendarEventId: string | null;
    externalCalendarId: string | null;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    calendarSyncStatus: "in_sync" | "out_of_sync";
    calendarSyncUpdatedAt: string;
  }): Promise<void>;
}

type StoredTask = Omit<Task, "createdAt"> & {
  createdAt?: string | undefined;
};

class InMemoryGoogleCalendarConnectionStore
  implements GoogleCalendarConnectionStore
{
  private readonly connectionsByUserId = new Map<
    string,
    GoogleCalendarConnectionCredentials
  >();
  private readonly oauthStatesByState = new Map<
    string,
    GoogleCalendarOauthState
  >();
  private readonly linkHandoffsById = new Map<
    string,
    GoogleCalendarLinkHandoff
  >();
  private readonly linkSessionsById = new Map<
    string,
    GoogleCalendarLinkSession
  >();
  private tasksById: (() => StoredTask[]) | null = null;
  private replaceTaskById: ((taskId: string, task: StoredTask) => void) | null =
    null;

  attachTaskStore(
    getTasks: () => StoredTask[],
    replaceTask: (taskId: string, task: StoredTask) => void,
  ) {
    this.tasksById = getTasks;
    this.replaceTaskById = replaceTask;
  }

  reset() {
    this.connectionsByUserId.clear();
    this.oauthStatesByState.clear();
    this.linkHandoffsById.clear();
    this.linkSessionsById.clear();
  }

  async getConnection(userId: string) {
    const connection = this.connectionsByUserId.get(userId);
    return connection && connection.revokedAt === null
      ? redactConnection(connection)
      : null;
  }

  async getConnectionCredentials(userId: string) {
    const connection = this.connectionsByUserId.get(userId);
    return connection && connection.revokedAt === null ? connection : null;
  }

  async upsertConnection(
    input: Omit<GoogleCalendarConnectionCredentials, "createdAt" | "updatedAt">,
  ) {
    const now = new Date().toISOString();
    const existing = this.connectionsByUserId.get(input.userId);
    const connection: GoogleCalendarConnectionCredentials = {
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.connectionsByUserId.set(input.userId, connection);
    return redactConnection(connection);
  }

  async updateConnectionTokens(input: {
    userId: string;
    accessToken: string;
    refreshToken: string | null;
    tokenExpiresAt: string | null;
  }) {
    const existing = this.connectionsByUserId.get(input.userId);

    if (!existing) {
      throw new Error(
        `Google Calendar connection for user ${input.userId} not found.`,
      );
    }

    const updated: GoogleCalendarConnectionCredentials = {
      ...existing,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      tokenExpiresAt: input.tokenExpiresAt,
      updatedAt: new Date().toISOString(),
    };
    this.connectionsByUserId.set(input.userId, updated);
    return updated;
  }

  async listActiveConnections() {
    return Array.from(this.connectionsByUserId.values())
      .filter((connection) => connection.revokedAt === null)
      .map(redactConnection);
  }

  async createOauthState(input: {
    state: string;
    userId: string;
    redirectPath: string | null;
    expiresAt: string;
    codeVerifier?: string | null;
  }) {
    const stored: GoogleCalendarOauthState = {
      state: input.state,
      userId: input.userId,
      redirectPath: input.redirectPath,
      expiresAt: input.expiresAt,
      codeVerifier: input.codeVerifier ?? null,
      consumedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.oauthStatesByState.set(stored.state, stored);
    return stored;
  }

  async getOauthState(state: string) {
    const existing = this.oauthStatesByState.get(state);

    if (
      !existing ||
      existing.consumedAt !== null ||
      Date.parse(existing.expiresAt) < Date.now()
    ) {
      return null;
    }

    return existing;
  }

  async markOauthStateConsumed(state: string) {
    const existing = await this.getOauthState(state);

    if (!existing) {
      return null;
    }

    const consumed = {
      ...existing,
      consumedAt: new Date().toISOString(),
    };
    this.oauthStatesByState.set(state, consumed);
    return consumed;
  }

  async createLinkHandoff(input: {
    id: string;
    userId: string;
    redirectPath: string | null;
    expiresAt: string;
  }) {
    const handoff: GoogleCalendarLinkHandoff = {
      ...input,
      consumedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.linkHandoffsById.set(input.id, handoff);
    return handoff;
  }

  async consumeLinkHandoff(id: string) {
    const existing = this.linkHandoffsById.get(id);

    if (
      !existing ||
      existing.consumedAt !== null ||
      Date.parse(existing.expiresAt) < Date.now()
    ) {
      return null;
    }

    const consumed: GoogleCalendarLinkHandoff = {
      ...existing,
      consumedAt: new Date().toISOString(),
    };
    this.linkHandoffsById.set(id, consumed);
    return consumed;
  }

  async createLinkSession(input: {
    id: string;
    userId: string;
    redirectPath: string | null;
    expiresAt: string;
  }) {
    const session: GoogleCalendarLinkSession = {
      ...input,
      consumedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.linkSessionsById.set(input.id, session);
    return session;
  }

  async getLinkSession(id: string) {
    const session = this.linkSessionsById.get(id);

    if (
      !session ||
      session.consumedAt !== null ||
      Date.parse(session.expiresAt) < Date.now()
    ) {
      return null;
    }

    return session;
  }

  async consumeLinkSession(id: string) {
    const existing = await this.getLinkSession(id);

    if (!existing) {
      return null;
    }

    const consumed: GoogleCalendarLinkSession = {
      ...existing,
      consumedAt: new Date().toISOString(),
    };
    this.linkSessionsById.set(id, consumed);
    return consumed;
  }

  async purgeExpiredOauthStates(before: string) {
    let deleted = 0;

    for (const [key, value] of this.oauthStatesByState.entries()) {
      if (
        value.consumedAt !== null ||
        Date.parse(value.expiresAt) <= Date.parse(before)
      ) {
        this.oauthStatesByState.delete(key);
        deleted += 1;
      }
    }

    return deleted;
  }

  async scrubRevokedCredentials() {
    let scrubbed = 0;

    for (const [key, value] of this.connectionsByUserId.entries()) {
      if (
        value.revokedAt !== null &&
        (value.accessToken || value.refreshToken !== null)
      ) {
        this.connectionsByUserId.set(key, {
          ...value,
          accessToken: "",
          refreshToken: null,
          updatedAt: new Date().toISOString(),
        });
        scrubbed += 1;
      }
    }

    return scrubbed;
  }

  async listTasksForReconciliation(input: {
    userId: string;
    scheduledThrough: string;
  }) {
    if (!this.tasksById) {
      return [];
    }

    return this.tasksById()
      .filter(
        (task) =>
          task.userId === input.userId &&
          task.externalCalendarEventId !== null &&
          task.externalCalendarId !== null &&
          task.scheduledStartAt !== null &&
          Date.parse(task.scheduledStartAt) <=
            Date.parse(input.scheduledThrough),
      )
      .map((task) => ({
        ...task,
        createdAt: task.createdAt ?? new Date().toISOString(),
      }));
  }

  async reconcileTaskProjection(input: {
    taskId: string;
    externalCalendarEventId: string | null;
    externalCalendarId: string | null;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    calendarSyncStatus: "in_sync" | "out_of_sync";
    calendarSyncUpdatedAt: string;
  }) {
    if (!this.tasksById || !this.replaceTaskById) {
      return;
    }

    const existing = this.tasksById().find((task) => task.id === input.taskId);

    if (!existing) {
      throw new Error(`Task ${input.taskId} not found.`);
    }

    this.replaceTaskById(input.taskId, {
      ...existing,
      externalCalendarEventId: input.externalCalendarEventId,
      externalCalendarId: input.externalCalendarId,
      scheduledStartAt: input.scheduledStartAt,
      scheduledEndAt: input.scheduledEndAt,
      calendarSyncStatus: input.calendarSyncStatus,
      calendarSyncUpdatedAt: input.calendarSyncUpdatedAt,
    });
  }
}

export class PostgresGoogleCalendarConnectionStore
  implements GoogleCalendarConnectionStore
{
  private readonly client;
  private readonly db;

  constructor(databaseUrl = getRequiredDatabaseUrl()) {
    this.client = postgres(databaseUrl, {
      prepare: false,
    });
    this.db = drizzle(this.client);
  }

  async getConnection(userId: string) {
    const [row] = await this.db
      .select()
      .from(googleCalendarAccounts)
      .where(
        and(
          eq(googleCalendarAccounts.userId, userId),
          isNull(googleCalendarAccounts.revokedAt),
        ),
      )
      .limit(1);

    return row ? parseConnectionRow(row) : null;
  }

  async getConnectionCredentials(userId: string) {
    const [row] = await this.db
      .select()
      .from(googleCalendarAccounts)
      .where(
        and(
          eq(googleCalendarAccounts.userId, userId),
          isNull(googleCalendarAccounts.revokedAt),
        ),
      )
      .limit(1);

    return row ? parseConnectionCredentialsRow(row) : null;
  }

  async upsertConnection(
    input: Omit<GoogleCalendarConnectionCredentials, "createdAt" | "updatedAt">,
  ) {
    const now = new Date();

    await this.db
      .insert(googleCalendarAccounts)
      .values({
        userId: input.userId,
        providerAccountId: input.providerAccountId,
        email: input.email,
        selectedCalendarId: input.selectedCalendarId,
        selectedCalendarName: input.selectedCalendarName,
        accessToken: encryptCalendarCredential(input.accessToken),
        refreshToken: input.refreshToken
          ? encryptCalendarCredential(input.refreshToken)
          : null,
        tokenExpiresAt: input.tokenExpiresAt
          ? new Date(input.tokenExpiresAt)
          : null,
        scopes: input.scopes,
        syncCursor: input.syncCursor,
        lastSyncedAt: input.lastSyncedAt ? new Date(input.lastSyncedAt) : null,
        revokedAt: input.revokedAt ? new Date(input.revokedAt) : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: googleCalendarAccounts.userId,
        set: {
          providerAccountId: input.providerAccountId,
          email: input.email,
          selectedCalendarId: input.selectedCalendarId,
          selectedCalendarName: input.selectedCalendarName,
          accessToken: encryptCalendarCredential(input.accessToken),
          refreshToken: input.refreshToken
            ? encryptCalendarCredential(input.refreshToken)
            : null,
          tokenExpiresAt: input.tokenExpiresAt
            ? new Date(input.tokenExpiresAt)
            : null,
          scopes: input.scopes,
          syncCursor: input.syncCursor,
          lastSyncedAt: input.lastSyncedAt
            ? new Date(input.lastSyncedAt)
            : null,
          revokedAt: input.revokedAt ? new Date(input.revokedAt) : null,
          updatedAt: now,
        },
      });

    const connection = await this.getConnection(input.userId);

    if (!connection) {
      throw new Error(
        `Failed to persist Google Calendar connection for user ${input.userId}.`,
      );
    }

    return connection;
  }

  async updateConnectionTokens(input: {
    userId: string;
    accessToken: string;
    refreshToken: string | null;
    tokenExpiresAt: string | null;
  }) {
    await this.db
      .update(googleCalendarAccounts)
      .set({
        accessToken: encryptCalendarCredential(input.accessToken),
        refreshToken: input.refreshToken
          ? encryptCalendarCredential(input.refreshToken)
          : null,
        tokenExpiresAt: input.tokenExpiresAt
          ? new Date(input.tokenExpiresAt)
          : null,
        updatedAt: new Date(),
      })
      .where(eq(googleCalendarAccounts.userId, input.userId));

    const connection = await this.getConnectionCredentials(input.userId);

    if (!connection) {
      throw new Error(
        `Google Calendar connection for user ${input.userId} not found.`,
      );
    }

    return connection;
  }

  async listActiveConnections() {
    const rows = await this.db
      .select()
      .from(googleCalendarAccounts)
      .where(isNull(googleCalendarAccounts.revokedAt));

    return rows.map(parseConnectionRow);
  }

  async createOauthState(input: {
    state: string;
    userId: string;
    redirectPath: string | null;
    expiresAt: string;
    codeVerifier?: string | null;
  }) {
    await this.db.insert(googleCalendarOauthStates).values({
      state: input.state,
      userId: input.userId,
      redirectPath: input.redirectPath,
      expiresAt: new Date(input.expiresAt),
      codeVerifier: input.codeVerifier ?? null,
    });

    return {
      state: input.state,
      userId: input.userId,
      redirectPath: input.redirectPath,
      expiresAt: input.expiresAt,
      codeVerifier: input.codeVerifier ?? null,
      consumedAt: null,
      createdAt: new Date().toISOString(),
    };
  }

  async getOauthState(state: string) {
    const [row] = await this.db
      .select()
      .from(googleCalendarOauthStates)
      .where(eq(googleCalendarOauthStates.state, state))
      .limit(1);

    if (
      !row ||
      row.consumedAt !== null ||
      row.expiresAt.getTime() < Date.now()
    ) {
      return null;
    }

    return {
      state: row.state,
      userId: row.userId,
      redirectPath: row.redirectPath,
      expiresAt: row.expiresAt.toISOString(),
      codeVerifier: row.codeVerifier,
      consumedAt: null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async markOauthStateConsumed(state: string) {
    const existing = await this.getOauthState(state);

    if (!existing) {
      return null;
    }

    const consumedAt = new Date();
    await this.db
      .update(googleCalendarOauthStates)
      .set({
        consumedAt,
      })
      .where(eq(googleCalendarOauthStates.state, state));

    return {
      ...existing,
      consumedAt: consumedAt.toISOString(),
      createdAt: existing.createdAt,
    };
  }

  async createLinkHandoff(input: {
    id: string;
    userId: string;
    redirectPath: string | null;
    expiresAt: string;
  }) {
    await this.db.insert(googleCalendarLinkHandoffs).values({
      id: input.id,
      userId: input.userId,
      redirectPath: input.redirectPath,
      expiresAt: new Date(input.expiresAt),
    });

    return {
      ...input,
      consumedAt: null,
      createdAt: new Date().toISOString(),
    };
  }

  async consumeLinkHandoff(id: string) {
    const [row] = await this.db
      .select()
      .from(googleCalendarLinkHandoffs)
      .where(eq(googleCalendarLinkHandoffs.id, id))
      .limit(1);

    if (
      !row ||
      row.consumedAt !== null ||
      row.expiresAt.getTime() < Date.now()
    ) {
      return null;
    }

    const consumedAt = new Date();
    await this.db
      .update(googleCalendarLinkHandoffs)
      .set({
        consumedAt,
      })
      .where(eq(googleCalendarLinkHandoffs.id, id));

    return {
      id: row.id,
      userId: row.userId,
      redirectPath: row.redirectPath,
      expiresAt: row.expiresAt.toISOString(),
      consumedAt: consumedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async createLinkSession(input: {
    id: string;
    userId: string;
    redirectPath: string | null;
    expiresAt: string;
  }) {
    await this.db.insert(googleCalendarLinkSessions).values({
      id: input.id,
      userId: input.userId,
      redirectPath: input.redirectPath,
      expiresAt: new Date(input.expiresAt),
    });

    return {
      ...input,
      consumedAt: null,
      createdAt: new Date().toISOString(),
    };
  }

  async getLinkSession(id: string) {
    const [row] = await this.db
      .select()
      .from(googleCalendarLinkSessions)
      .where(eq(googleCalendarLinkSessions.id, id))
      .limit(1);

    if (
      !row ||
      row.consumedAt !== null ||
      row.expiresAt.getTime() < Date.now()
    ) {
      return null;
    }

    return {
      id: row.id,
      userId: row.userId,
      redirectPath: row.redirectPath,
      expiresAt: row.expiresAt.toISOString(),
      consumedAt: null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async consumeLinkSession(id: string) {
    const existing = await this.getLinkSession(id);

    if (!existing) {
      return null;
    }

    const consumedAt = new Date();
    await this.db
      .update(googleCalendarLinkSessions)
      .set({
        consumedAt,
      })
      .where(eq(googleCalendarLinkSessions.id, id));

    return {
      ...existing,
      consumedAt: consumedAt.toISOString(),
    };
  }

  async purgeExpiredOauthStates(before: string) {
    const deleted = await this.db
      .delete(googleCalendarOauthStates)
      .where(
        or(
          isNotNull(googleCalendarOauthStates.consumedAt),
          lte(googleCalendarOauthStates.expiresAt, new Date(before)),
        ),
      )
      .returning({ state: googleCalendarOauthStates.state });

    return deleted.length;
  }

  async scrubRevokedCredentials() {
    const scrubbed = await this.db
      .update(googleCalendarAccounts)
      .set({
        accessToken: "",
        refreshToken: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          isNotNull(googleCalendarAccounts.revokedAt),
          or(
            isNotNull(googleCalendarAccounts.refreshToken),
            isNotNull(googleCalendarAccounts.accessToken),
          ),
        ),
      )
      .returning({ userId: googleCalendarAccounts.userId });

    return scrubbed.length;
  }

  async listTasksForReconciliation(input: {
    userId: string;
    scheduledThrough: string;
  }) {
    const rows = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, input.userId),
          lte(tasks.scheduledStartAt, new Date(input.scheduledThrough)),
          or(
            eq(tasks.lifecycleState, "scheduled"),
            eq(tasks.lifecycleState, "awaiting_followup"),
          ),
        ),
      );

    return rows
      .filter(
        (row) =>
          row.externalCalendarEventId !== null &&
          row.externalCalendarId !== null &&
          row.scheduledStartAt !== null &&
          row.scheduledEndAt !== null,
      )
      .map((row) => ({
        id: row.id,
        userId: row.userId,
        sourceInboxItemId: row.sourceInboxItemId,
        lastInboxItemId: row.lastInboxItemId,
        title: row.title,
        lifecycleState: row.lifecycleState as Task["lifecycleState"],
        externalCalendarEventId: row.externalCalendarEventId,
        externalCalendarId: row.externalCalendarId,
        scheduledStartAt: row.scheduledStartAt?.toISOString() ?? null,
        scheduledEndAt: row.scheduledEndAt?.toISOString() ?? null,
        calendarSyncStatus:
          row.calendarSyncStatus as Task["calendarSyncStatus"],
        calendarSyncUpdatedAt: row.calendarSyncUpdatedAt?.toISOString() ?? null,
        rescheduleCount: row.rescheduleCount,
        lastFollowupAt: row.lastFollowupAt?.toISOString() ?? null,
        followupReminderSentAt:
          row.followupReminderSentAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        priority: row.priority as Task["priority"],
        urgency: row.urgency as Task["urgency"],
        createdAt: row.createdAt.toISOString(),
      }));
  }

  async reconcileTaskProjection(input: {
    taskId: string;
    externalCalendarEventId: string | null;
    externalCalendarId: string | null;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    calendarSyncStatus: "in_sync" | "out_of_sync";
    calendarSyncUpdatedAt: string;
  }) {
    await this.db
      .update(tasks)
      .set({
        externalCalendarEventId: input.externalCalendarEventId,
        externalCalendarId: input.externalCalendarId,
        scheduledStartAt: input.scheduledStartAt
          ? new Date(input.scheduledStartAt)
          : null,
        scheduledEndAt: input.scheduledEndAt
          ? new Date(input.scheduledEndAt)
          : null,
        calendarSyncStatus: input.calendarSyncStatus,
        calendarSyncUpdatedAt: new Date(input.calendarSyncUpdatedAt),
      })
      .where(eq(tasks.id, input.taskId));
  }
}

const defaultInMemoryStore = new InMemoryGoogleCalendarConnectionStore();
let postgresStore: PostgresGoogleCalendarConnectionStore | null = null;

export function attachGoogleCalendarConnectionStoreToTasks(input: {
  getTasks: () => StoredTask[];
  replaceTask: (taskId: string, task: StoredTask) => void;
}) {
  defaultInMemoryStore.attachTaskStore(input.getTasks, input.replaceTask);
}

export function getDefaultGoogleCalendarConnectionStore(): GoogleCalendarConnectionStore {
  if (isTestEnvironment()) {
    return defaultInMemoryStore;
  }

  if (!postgresStore) {
    postgresStore = new PostgresGoogleCalendarConnectionStore();
  }

  return postgresStore;
}

export function resetGoogleCalendarConnectionStoreForTests() {
  defaultInMemoryStore.reset();
}

export function encryptCalendarCredential(
  value: string,
  key = process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY,
) {
  const encryptionKey = readEncryptionKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${CREDENTIAL_CIPHERTEXT_VERSION}:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptCalendarCredential(
  value: string,
  key = process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY,
) {
  if (!value) {
    return "";
  }

  const [version, ivValue, tagValue, ciphertextValue] = value.split(":");

  if (
    version !== CREDENTIAL_CIPHERTEXT_VERSION ||
    !ivValue ||
    !tagValue ||
    !ciphertextValue
  ) {
    throw new Error("Invalid encrypted Google Calendar credential format.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    readEncryptionKey(key),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}

function redactConnection(
  connection: GoogleCalendarConnectionCredentials,
): GoogleCalendarConnection {
  return {
    userId: connection.userId,
    providerAccountId: connection.providerAccountId,
    email: connection.email,
    selectedCalendarId: connection.selectedCalendarId,
    selectedCalendarName: connection.selectedCalendarName,
    tokenExpiresAt: connection.tokenExpiresAt,
    scopes: connection.scopes,
    syncCursor: connection.syncCursor,
    lastSyncedAt: connection.lastSyncedAt,
    revokedAt: connection.revokedAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function parseConnectionRow(
  row: typeof googleCalendarAccounts.$inferSelect,
): GoogleCalendarConnection {
  return {
    userId: row.userId,
    providerAccountId: row.providerAccountId,
    email: row.email,
    selectedCalendarId: row.selectedCalendarId,
    selectedCalendarName: row.selectedCalendarName,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    scopes: row.scopes,
    syncCursor: row.syncCursor,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseConnectionCredentialsRow(
  row: typeof googleCalendarAccounts.$inferSelect,
): GoogleCalendarConnectionCredentials {
  return {
    ...parseConnectionRow(row),
    accessToken: decryptCalendarCredential(row.accessToken),
    refreshToken: row.refreshToken
      ? decryptCalendarCredential(row.refreshToken)
      : null,
  };
}

function readEncryptionKey(
  key = process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY,
) {
  if (!key) {
    throw new Error("GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY must be configured.");
  }

  const buffer = Buffer.from(key, "base64");

  if (buffer.length !== 32) {
    throw new Error(
      "GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
    );
  }

  return buffer;
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
