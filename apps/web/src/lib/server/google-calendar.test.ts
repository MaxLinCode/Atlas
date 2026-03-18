import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getDefaultGoogleCalendarConnectionStore,
  getDefaultInboxProcessingStore,
  resetGoogleCalendarConnectionStoreForTests,
  resetInboxProcessingStoreForTests,
  seedInboxItemForProcessingTests,
  listTasksForTests
} from "@atlas/db";

import {
  buildGoogleCalendarConnectCookieName,
  createGoogleCalendarConnectLink,
  handleGoogleCalendarConnect,
  handleGoogleCalendarOauthCallback,
  reconcileGoogleCalendarConnections,
  resolveGoogleCalendarAdapter,
  startGoogleCalendarOauth
} from "./google-calendar";

describe("google calendar app services", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://atlas:atlas@localhost:5432/atlas";
    process.env.APP_BASE_URL = "https://atlas.example.com";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.TELEGRAM_BOT_TOKEN = "test-telegram-token";
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-client-secret";
    process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://example.com/api/google-calendar/oauth/callback";
    process.env.GOOGLE_LINK_TOKEN_SECRET = "google-link-secret";
    process.env.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    resetGoogleCalendarConnectionStoreForTests();
    resetInboxProcessingStoreForTests();
  });

  it("creates a one-time connect link and starts OAuth from a valid link session", async () => {
    const connectionStore = getDefaultGoogleCalendarConnectionStore();
    const connectLink = await createGoogleCalendarConnectLink(
      {
        baseUrl: "http://localhost",
        userId: "123",
        redirectPath: "/settings"
      },
      {
        connectionStore
      }
    );

    const connectResult = await handleGoogleCalendarConnect(new Request(connectLink), {
      connectionStore
    });

    expect(connectResult.status).toBe(302);
    expect("headers" in connectResult ? connectResult.headers.location : "").toBe("/api/google-calendar/oauth/start");
    const cookie = "headers" in connectResult ? connectResult.headers["set-cookie"] : "";

    const startResult = await startGoogleCalendarOauth(
      new Request("http://localhost/api/google-calendar/oauth/start", {
        headers: {
          cookie
        }
      }),
      {
        connectionStore
      }
    );

    expect(startResult.status).toBe(302);
    expect("headers" in startResult ? startResult.headers.location : "").toContain("accounts.google.com");
  });

  it("persists the linked account from the OAuth callback and clears the link session cookie", async () => {
    const connectionStore = getDefaultGoogleCalendarConnectionStore();
    const connectLink = await createGoogleCalendarConnectLink(
      {
        baseUrl: "http://localhost",
        userId: "123"
      },
      {
        connectionStore
      }
    );
    const connectResult = await handleGoogleCalendarConnect(new Request(connectLink), {
      connectionStore
    });
    const cookie = "headers" in connectResult ? connectResult.headers["set-cookie"] : "";
    const start = await startGoogleCalendarOauth(
      new Request("http://localhost/api/google-calendar/oauth/start", {
        headers: {
          cookie
        }
      }),
      {
        connectionStore
      }
    );
    const redirectUrl = new URL(("headers" in start ? start.headers.location : "") || "http://localhost");
    const state = redirectUrl.searchParams.get("state");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "refresh-token",
            expires_in: 3600,
            scope: "scope-a scope-b"
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "google-user-1",
            email: "max@example.com"
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: "primary",
                summary: "Primary",
                primary: true,
                accessRole: "owner"
              }
            ]
          })
        )
      );

    const result = await handleGoogleCalendarOauthCallback(
      new Request(`http://localhost/api/google-calendar/oauth/callback?code=oauth-code&state=${state}`, {
        headers: {
          cookie
        }
      }),
      {
        connectionStore,
        fetch: fetchMock
      }
    );

    expect(result.status).toBe(200);
    expect("completion" in result ? result.completion : null).toMatchObject({
      title: "Google Calendar connected"
    });
    await expect(connectionStore.getConnection("123")).resolves.toMatchObject({
      email: "max@example.com",
      selectedCalendarId: "primary"
    });
    expect("headers" in result ? result.headers["set-cookie"] : "").toContain(
      `${buildGoogleCalendarConnectCookieName()}=`
    );
  });

  it("rejects replayed or forged handoff tokens", async () => {
    const connectionStore = getDefaultGoogleCalendarConnectionStore();
    const connectLink = await createGoogleCalendarConnectLink(
      {
        baseUrl: "http://localhost",
        userId: "123"
      },
      {
        connectionStore
      }
    );

    const first = await handleGoogleCalendarConnect(new Request(connectLink), {
      connectionStore
    });
    const replay = await handleGoogleCalendarConnect(new Request(connectLink), {
      connectionStore
    });
    const forged = await handleGoogleCalendarConnect(
      new Request("http://localhost/google-calendar/connect?token=forged"),
      {
        connectionStore
      }
    );

    expect(first.status).toBe(302);
    expect(replay.status).toBe(403);
    expect(forged.status).toBe(403);
  });

  it("rejects connect-link creation for non-allowlisted users before issuing a handoff", async () => {
    const connectionStore = getDefaultGoogleCalendarConnectionStore();

    await expect(
      createGoogleCalendarConnectLink(
        {
          baseUrl: "http://localhost",
          userId: "999"
        },
        {
          connectionStore
        }
      )
    ).rejects.toThrow(/non-allowlisted user/);
  });

  it("does not start OAuth without a valid link session cookie", async () => {
    const result = await startGoogleCalendarOauth(
      new Request("http://localhost/api/google-calendar/oauth/start")
    );

    expect(result.status).toBe(403);
  });

  it("does not consume oauth state when token exchange fails", async () => {
    const connectionStore = getDefaultGoogleCalendarConnectionStore();
    const connectLink = await createGoogleCalendarConnectLink(
      {
        baseUrl: "http://localhost",
        userId: "123"
      },
      {
        connectionStore
      }
    );
    const connectResult = await handleGoogleCalendarConnect(new Request(connectLink), {
      connectionStore
    });
    const cookie = "headers" in connectResult ? connectResult.headers["set-cookie"] : "";
    const start = await startGoogleCalendarOauth(
      new Request("http://localhost/api/google-calendar/oauth/start", {
        headers: {
          cookie
        }
      }),
      {
        connectionStore
      }
    );
    const redirectUrl = new URL(("headers" in start ? start.headers.location : "") || "http://localhost");
    const state = redirectUrl.searchParams.get("state");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("bad", { status: 500 }));

    await expect(
      handleGoogleCalendarOauthCallback(
        new Request(`http://localhost/api/google-calendar/oauth/callback?code=oauth-code&state=${state}`, {
          headers: {
            cookie
          }
        }),
        {
          connectionStore,
          fetch: fetchMock
        }
      )
    ).rejects.toThrow();

    await expect(connectionStore.getOauthState(state!)).resolves.toMatchObject({
      state
    });
  });

  it("refreshes expired tokens before building a Google adapter without exposing tokens on the public connection", async () => {
    const connectionStore = getDefaultGoogleCalendarConnectionStore();
    await connectionStore.upsertConnection({
      userId: "123",
      providerAccountId: "google-user-1",
      email: "max@example.com",
      selectedCalendarId: "primary",
      selectedCalendarName: "Primary",
      accessToken: "stale-token",
      refreshToken: "refresh-token",
      tokenExpiresAt: "2020-03-20T17:00:00.000Z",
      scopes: ["calendar"],
      syncCursor: null,
      lastSyncedAt: null,
      revokedAt: null
    });
    const connection = await connectionStore.getConnection("123");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "fresh-token",
          expires_in: 3600
        })
      )
    );

    const resolved = await resolveGoogleCalendarAdapter(connection!, {
      connectionStore,
      fetch: fetchMock
    });

    expect("accessToken" in resolved.connection).toBe(false);
    await expect(connectionStore.getConnectionCredentials("123")).resolves.toMatchObject({
      accessToken: "fresh-token"
    });
  });

  it("marks tasks out of sync during reconciliation when Google drift is detected", async () => {
    const inboxStore = getDefaultInboxProcessingStore();
    const connectionStore = getDefaultGoogleCalendarConnectionStore();

    seedInboxItemForProcessingTests({
      id: "inbox-1",
      userId: "123",
      sourceEventId: "event-1",
      rawText: "Review launch checklist",
      normalizedText: "Review launch checklist",
      processingStatus: "received",
      linkedTaskIds: []
    });

    await inboxStore.saveTaskCaptureResult({
      inboxItemId: "inbox-1",
      confidence: 0.9,
      plannerRun: {
        userId: "123",
        inboxItemId: "inbox-1",
        version: "test-v1",
        modelInput: {},
        modelOutput: {},
        confidence: 0.9
      },
      tasks: [
        {
          alias: "new_task_1",
          task: {
            userId: "123",
            sourceInboxItemId: "inbox-1",
            lastInboxItemId: "inbox-1",
            title: "Review launch checklist",
            lifecycleState: "pending_schedule",
            externalCalendarEventId: null,
            externalCalendarId: null,
            scheduledStartAt: null,
            scheduledEndAt: null,
            calendarSyncStatus: "in_sync",
            calendarSyncUpdatedAt: null,
            rescheduleCount: 0,
            lastFollowupAt: null,
            completedAt: null,
            archivedAt: null,
            priority: "medium",
            urgency: "medium"
          }
        }
      ],
      scheduleBlocks: [
        {
          id: "event-1",
          userId: "123",
          taskId: "new_task_1",
          startAt: "2026-03-20T17:00:00.000Z",
          endAt: "2026-03-20T18:00:00.000Z",
          confidence: 0.9,
          reason: "Scheduled",
          rescheduleCount: 0,
          externalCalendarId: "primary"
        }
      ],
      followUpMessage: "Scheduled"
    });

    await connectionStore.upsertConnection({
      userId: "123",
      providerAccountId: "google-user-1",
      email: "max@example.com",
      selectedCalendarId: "primary",
      selectedCalendarName: "Primary",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenExpiresAt: "2026-03-20T17:00:00.000Z",
      scopes: ["calendar"],
      syncCursor: null,
      lastSyncedAt: null,
      revokedAt: null
    });

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "event-1",
          start: {
            dateTime: "2026-03-20T18:00:00.000Z"
          },
          end: {
            dateTime: "2026-03-20T19:00:00.000Z"
          }
        })
      )
    );

    await expect(
      reconcileGoogleCalendarConnections({
        connectionStore,
        fetch: fetchMock
      })
    ).resolves.toMatchObject({
      outOfSyncTasks: 1
    });

    expect(listTasksForTests()[0]).toMatchObject({
      calendarSyncStatus: "out_of_sync"
    });
  });

  it("continues reconciling other users when one connection fails", async () => {
    const connectionStore = getDefaultGoogleCalendarConnectionStore();

    await connectionStore.upsertConnection({
      userId: "123",
      providerAccountId: "google-user-1",
      email: "max@example.com",
      selectedCalendarId: "primary",
      selectedCalendarName: "Primary",
      accessToken: "expired-token",
      refreshToken: null,
      tokenExpiresAt: "2020-03-20T17:00:00.000Z",
      scopes: ["calendar"],
      syncCursor: null,
      lastSyncedAt: null,
      revokedAt: null
    });
    await connectionStore.upsertConnection({
      userId: "456",
      providerAccountId: "google-user-2",
      email: "sara@example.com",
      selectedCalendarId: "primary",
      selectedCalendarName: "Primary",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenExpiresAt: "2026-03-20T17:00:00.000Z",
      scopes: ["calendar"],
      syncCursor: null,
      lastSyncedAt: null,
      revokedAt: null
    });

    seedInboxItemForProcessingTests({
      id: "inbox-2",
      userId: "456",
      sourceEventId: "event-2",
      rawText: "Prepare review",
      normalizedText: "Prepare review",
      processingStatus: "received",
      linkedTaskIds: []
    });

    await getDefaultInboxProcessingStore().saveTaskCaptureResult({
      inboxItemId: "inbox-2",
      confidence: 0.9,
      plannerRun: {
        userId: "456",
        inboxItemId: "inbox-2",
        version: "test-v1",
        modelInput: {},
        modelOutput: {},
        confidence: 0.9
      },
      tasks: [
        {
          alias: "new_task_1",
          task: {
            userId: "456",
            sourceInboxItemId: "inbox-2",
            lastInboxItemId: "inbox-2",
            title: "Prepare review",
            lifecycleState: "pending_schedule",
            externalCalendarEventId: null,
            externalCalendarId: null,
            scheduledStartAt: null,
            scheduledEndAt: null,
            calendarSyncStatus: "in_sync",
            calendarSyncUpdatedAt: null,
            rescheduleCount: 0,
            lastFollowupAt: null,
            completedAt: null,
            archivedAt: null,
            priority: "medium",
            urgency: "medium"
          }
        }
      ],
      scheduleBlocks: [
        {
          id: "event-2",
          userId: "456",
          taskId: "new_task_1",
          startAt: "2026-03-20T17:00:00.000Z",
          endAt: "2026-03-20T18:00:00.000Z",
          confidence: 0.9,
          reason: "Scheduled",
          rescheduleCount: 0,
          externalCalendarId: "primary"
        }
      ],
      followUpMessage: "Scheduled"
    });

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "event-2",
          start: {
            dateTime: "2026-03-20T17:00:00.000Z"
          },
          end: {
            dateTime: "2026-03-20T18:00:00.000Z"
          }
        })
      )
    );

    await expect(
      reconcileGoogleCalendarConnections({
        connectionStore,
        fetch: fetchMock
      })
    ).resolves.toMatchObject({
      reconciledConnections: 2,
      failedConnections: 1,
      syncedTasks: 1
    });
  });
});
