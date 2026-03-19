import { randomUUID } from "node:crypto";

import {
  buildGoogleCalendarLinkToken,
  detectTaskCalendarDrift,
  getAppBaseUrl,
  getConfig,
  getGoogleCalendarOAuthConfig,
  getGoogleCalendarSecurityConfig,
  getTelegramAllowedUserIds,
  isTelegramUserAllowed,
  verifyGoogleCalendarLinkToken
} from "@atlas/core";
import {
  getDefaultGoogleCalendarConnectionStore,
  type GoogleCalendarConnection,
  type GoogleCalendarConnectionStore
} from "@atlas/db";
import {
  buildGoogleCalendarOAuthUrl,
  createGoogleCalendarAdapter,
  exchangeGoogleOAuthCode,
  fetchGoogleCalendarIdentity,
  refreshGoogleOAuthToken
} from "@atlas/integrations";

const LINK_HANDOFF_TTL_MS = 5 * 60 * 1000;
const LINK_SESSION_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const RECONCILIATION_LOOKAHEAD_DAYS = 14;
const GOOGLE_LINK_SESSION_COOKIE = "atlas_google_link_session";

export async function createGoogleCalendarConnectLink(
  input: {
    baseUrl: string;
    userId: string;
    expiresAt?: string;
    redirectPath?: string | null;
  },
  dependencies: {
    connectionStore?: GoogleCalendarConnectionStore;
  } = {}
) {
  const config = getConfig();
  const securityConfig = getGoogleCalendarSecurityConfig();
  const allowedUserIds = getTelegramAllowedUserIds(config);

  if (!isTelegramUserAllowed(input.userId, allowedUserIds)) {
    throw new Error(`Google Calendar connect link requested for non-allowlisted user ${input.userId}.`);
  }

  const handoffId = randomUUID();
  const expiresAt = input.expiresAt ?? new Date(Date.now() + LINK_HANDOFF_TTL_MS).toISOString();
  const connectionStore = dependencies.connectionStore ?? getDefaultGoogleCalendarConnectionStore();

  await connectionStore.createLinkHandoff({
    id: handoffId,
    userId: input.userId,
    redirectPath: input.redirectPath ?? null,
    expiresAt
  });

  const url = new URL("/google-calendar/connect", input.baseUrl);
  url.searchParams.set(
    "token",
    buildGoogleCalendarLinkToken({
      userId: input.userId,
      handoffId,
      expiresAt,
      secret: securityConfig.GOOGLE_LINK_TOKEN_SECRET
    })
  );

  if (input.redirectPath) {
    url.searchParams.set("redirectPath", input.redirectPath);
  }

  return url.toString();
}

export async function hasActiveGoogleCalendarConnection(
  userId: string,
  dependencies: {
    connectionStore?: GoogleCalendarConnectionStore;
  } = {}
) {
  const connectionStore = dependencies.connectionStore ?? getDefaultGoogleCalendarConnectionStore();
  const connection = await connectionStore.getConnection(userId);
  return connection !== null;
}

export function getGoogleCalendarConnectBaseUrl() {
  return getAppBaseUrl(getConfig());
}

export async function handleGoogleCalendarConnect(
  request: Request,
  dependencies: {
    connectionStore?: GoogleCalendarConnectionStore;
  } = {}
) {
  return handleGoogleCalendarConnectPreview(request);
}

export async function handleGoogleCalendarConnectPreview(
  request: Request,
  _dependencies: {
    connectionStore?: GoogleCalendarConnectionStore;
  } = {}
) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const config = getConfig();
  const securityConfig = getGoogleCalendarSecurityConfig();

  if (!token) {
    return {
      status: 400,
      body: {
        accepted: false,
        error: "missing_link_token"
      }
    };
  }

  const verifiedToken = verifyGoogleCalendarLinkToken({
    token,
    secret: securityConfig.GOOGLE_LINK_TOKEN_SECRET
  });

  if (!verifiedToken) {
    return {
      status: 403,
      body: {
        accepted: false,
        error: "invalid_link_token"
      }
    };
  }

  const allowedUserIds = getTelegramAllowedUserIds(config);

  if (!isTelegramUserAllowed(verifiedToken.userId, allowedUserIds)) {
    return {
      status: 403,
      body: {
        accepted: false,
        error: "telegram_user_not_allowed"
      }
    };
  }

  return {
    status: 200,
    body: {
      accepted: true,
      token
    },
    confirmation: {
      title: "Connect Google Calendar",
      message: "Atlas needs access to your Google Calendar before it can schedule work for you.",
      actionLabel: "Continue to Google"
    }
  };
}

export async function handleGoogleCalendarConnectConfirm(
  request: Request,
  dependencies: {
    connectionStore?: GoogleCalendarConnectionStore;
  } = {}
) {
  const formData = await request.formData().catch(() => null);
  const tokenValue = formData?.get("token");

  if (typeof tokenValue !== "string" || tokenValue.length === 0) {
    return {
      status: 400,
      body: {
        accepted: false,
        error: "missing_link_token"
      }
    };
  }

  const url = new URL(request.url);
  url.searchParams.set("token", tokenValue);
  const previewResult = await handleGoogleCalendarConnectPreview(new Request(url.toString()));

  if (previewResult.status !== 200) {
    return previewResult;
  }

  const connectionStore = dependencies.connectionStore ?? getDefaultGoogleCalendarConnectionStore();
  const verifiedToken = verifyGoogleCalendarLinkToken({
    token: tokenValue,
    secret: getGoogleCalendarSecurityConfig().GOOGLE_LINK_TOKEN_SECRET
  });

  if (!verifiedToken) {
    return {
      status: 403,
      body: {
        accepted: false,
        error: "invalid_link_token"
      }
    };
  }

  const handoff = await connectionStore.consumeLinkHandoff(verifiedToken.handoffId);

  if (!handoff || handoff.userId !== verifiedToken.userId) {
    return {
      status: 403,
      body: {
        accepted: false,
        error: "invalid_link_token"
      }
    };
  }

  const sessionId = randomUUID();
  const sessionExpiresAt = new Date(Date.now() + LINK_SESSION_TTL_MS).toISOString();
  await connectionStore.createLinkSession({
    id: sessionId,
    userId: handoff.userId,
    redirectPath: handoff.redirectPath,
    expiresAt: sessionExpiresAt
  });

  return {
    status: 302,
    headers: {
      location: "/api/google-calendar/oauth/start",
      "set-cookie": serializeCookie({
        name: GOOGLE_LINK_SESSION_COOKIE,
        value: sessionId,
        request
      })
    }
  };
}

export async function startGoogleCalendarOauth(
  request: Request,
  dependencies: {
    connectionStore?: GoogleCalendarConnectionStore;
  } = {}
) {
  const connectionStore = dependencies.connectionStore ?? getDefaultGoogleCalendarConnectionStore();
  const linkSession = await readLinkSessionFromRequest(request, connectionStore);

  if (!linkSession) {
    return {
      status: 403,
      body: {
        accepted: false,
        error: "invalid_link_session"
      },
      headers: {
        "set-cookie": clearCookie({
          name: GOOGLE_LINK_SESSION_COOKIE,
          request
        })
      }
    };
  }

  const oauthConfig = getGoogleCalendarOAuthConfig();
  const state = randomUUID();

  await connectionStore.createOauthState({
    state,
    userId: linkSession.userId,
    redirectPath: linkSession.redirectPath,
    expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString()
  });

  return {
    status: 302,
    headers: {
      location: buildGoogleCalendarOAuthUrl({
        clientId: oauthConfig.GOOGLE_CLIENT_ID,
        redirectUri: oauthConfig.GOOGLE_OAUTH_REDIRECT_URI,
        state
      })
    }
  };
}

export async function handleGoogleCalendarOauthCallback(
  request: Request,
  dependencies: {
    connectionStore?: GoogleCalendarConnectionStore;
    fetch?: typeof fetch;
  } = {}
) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return {
      status: 400,
      body: {
        accepted: false,
        error: "missing_oauth_params"
      },
      headers: {
        "set-cookie": clearCookie({
          name: GOOGLE_LINK_SESSION_COOKIE,
          request
        })
      }
    };
  }

  const connectionStore = dependencies.connectionStore ?? getDefaultGoogleCalendarConnectionStore();
  const pendingState = await connectionStore.getOauthState(state);

  if (!pendingState) {
    return {
      status: 400,
      body: {
        accepted: false,
        error: "invalid_oauth_state"
      },
      headers: {
        "set-cookie": clearCookie({
          name: GOOGLE_LINK_SESSION_COOKIE,
          request
        })
      }
    };
  }

  const oauthConfig = getGoogleCalendarOAuthConfig();
  const tokens = await exchangeGoogleOAuthCode({
    clientId: oauthConfig.GOOGLE_CLIENT_ID,
    clientSecret: oauthConfig.GOOGLE_CLIENT_SECRET,
    redirectUri: oauthConfig.GOOGLE_OAUTH_REDIRECT_URI,
    code,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {})
  });
  const identity = await fetchGoogleCalendarIdentity({
    accessToken: tokens.accessToken,
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {})
  });

  const connection = await connectionStore.upsertConnection({
    userId: pendingState.userId,
    providerAccountId: identity.providerAccountId,
    email: identity.email,
    selectedCalendarId: identity.selectedCalendarId,
    selectedCalendarName: identity.selectedCalendarName,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: tokens.tokenExpiresAt,
    scopes: tokens.scopes,
    syncCursor: null,
    lastSyncedAt: null,
    revokedAt: null
  });

  await connectionStore.markOauthStateConsumed(state);

  const linkSessionCookie = parseCookies(request.headers.get("cookie")).get(GOOGLE_LINK_SESSION_COOKIE);

  if (linkSessionCookie) {
    await connectionStore.consumeLinkSession(linkSessionCookie);
  }

  return {
    status: 200,
    body: {
      accepted: true,
      userId: connection.userId,
      selectedCalendarId: connection.selectedCalendarId,
      selectedCalendarName: connection.selectedCalendarName
    },
    completion: {
      title: "Google Calendar connected",
      message: "Google Calendar is connected. Go back to Telegram and send that again."
    },
    headers: {
      "set-cookie": clearCookie({
        name: GOOGLE_LINK_SESSION_COOKIE,
        request
      })
    }
  };
}

export async function reconcileGoogleCalendarConnections(
  dependencies: {
    connectionStore?: GoogleCalendarConnectionStore;
    fetch?: typeof fetch;
  } = {}
) {
  const connectionStore = dependencies.connectionStore ?? getDefaultGoogleCalendarConnectionStore();
  const connections = await connectionStore.listActiveConnections();
  const scheduledThrough = new Date(
    Date.now() + RECONCILIATION_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  let syncedTasks = 0;
  let outOfSyncTasks = 0;
  let failedConnections = 0;

  for (const connection of connections) {
    try {
      const { adapter, connection: refreshedConnection } = await resolveGoogleCalendarAdapter(connection, {
        connectionStore,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {})
      });
      const tasks = await connectionStore.listTasksForReconciliation({
        userId: refreshedConnection.userId,
        scheduledThrough
      });

      for (const task of tasks) {
        if (!task.externalCalendarEventId || !task.externalCalendarId) {
          continue;
        }

        const liveEvent = await adapter.getEvent({
          externalCalendarEventId: task.externalCalendarEventId,
          externalCalendarId: task.externalCalendarId
        });
        const drift = detectTaskCalendarDrift({
          task,
          liveEvent
        });

        await connectionStore.reconcileTaskProjection({
          taskId: task.id,
          externalCalendarEventId: drift
            ? task.externalCalendarEventId
            : liveEvent?.externalCalendarEventId ?? task.externalCalendarEventId,
          externalCalendarId: drift
            ? task.externalCalendarId
            : liveEvent?.externalCalendarId ?? task.externalCalendarId,
          scheduledStartAt: drift ? task.scheduledStartAt : liveEvent?.scheduledStartAt ?? task.scheduledStartAt,
          scheduledEndAt: drift ? task.scheduledEndAt : liveEvent?.scheduledEndAt ?? task.scheduledEndAt,
          calendarSyncStatus: drift ? "out_of_sync" : "in_sync",
          calendarSyncUpdatedAt: new Date().toISOString()
        });

        if (drift) {
          outOfSyncTasks += 1;
          continue;
        }

        syncedTasks += 1;
      }
    } catch {
      failedConnections += 1;
    }
  }

  const cleanedOauthStates = await connectionStore.purgeExpiredOauthStates(new Date().toISOString());
  const scrubbedRevokedConnections = await connectionStore.scrubRevokedCredentials();

  return {
    accepted: true,
    reconciledConnections: connections.length,
    syncedTasks,
    outOfSyncTasks,
    failedConnections,
    cleanedOauthStates,
    scrubbedRevokedConnections
  };
}

export async function resolveGoogleCalendarAdapter(
  connection: GoogleCalendarConnection,
  dependencies: {
    connectionStore?: GoogleCalendarConnectionStore;
    fetch?: typeof fetch;
  } = {}
) {
  const connectionStore = dependencies.connectionStore ?? getDefaultGoogleCalendarConnectionStore();
  let credentials = await connectionStore.getConnectionCredentials(connection.userId);

  if (!credentials) {
    throw new Error(`Google Calendar connection for user ${connection.userId} not found.`);
  }

  if (
    credentials.tokenExpiresAt !== null &&
    Date.parse(credentials.tokenExpiresAt) <= Date.now()
  ) {
    if (!credentials.refreshToken) {
      throw new Error(`Google Calendar access token expired for user ${credentials.userId}.`);
    }

    const oauthConfig = getGoogleCalendarOAuthConfig();
    const refreshed = await refreshGoogleOAuthToken({
      clientId: oauthConfig.GOOGLE_CLIENT_ID,
      clientSecret: oauthConfig.GOOGLE_CLIENT_SECRET,
      refreshToken: credentials.refreshToken,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {})
    });

    credentials = await connectionStore.updateConnectionTokens({
      userId: credentials.userId,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      tokenExpiresAt: refreshed.tokenExpiresAt
    });
  }

  return {
    connection: {
      ...connection,
      tokenExpiresAt: credentials.tokenExpiresAt
    },
    adapter: createGoogleCalendarAdapter(
      {
        accessToken: credentials.accessToken,
        selectedCalendarId: connection.selectedCalendarId
      },
      {
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {})
      }
    )
  };
}

async function readLinkSessionFromRequest(
  request: Request,
  connectionStore: GoogleCalendarConnectionStore
) {
  const sessionId = parseCookies(request.headers.get("cookie")).get(GOOGLE_LINK_SESSION_COOKIE);

  if (!sessionId) {
    return null;
  }

  return connectionStore.getLinkSession(sessionId);
}

export function buildGoogleCalendarConnectCookieName() {
  return GOOGLE_LINK_SESSION_COOKIE;
}

function parseCookies(header: string | null) {
  const cookies = new Map<string, string>();

  if (!header) {
    return cookies;
  }

  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");

    if (!name || rest.length === 0) {
      continue;
    }

    cookies.set(name, decodeURIComponent(rest.join("=")));
  }

  return cookies;
}

function serializeCookie(input: {
  name: string;
  value: string;
  request: Request;
}) {
  const url = new URL(input.request.url);
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";

  return [
    `${input.name}=${encodeURIComponent(input.value)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/api/google-calendar",
    `Max-Age=${LINK_SESSION_TTL_MS / 1000}`,
    !isLocalhost ? "Secure" : null
  ]
    .filter(Boolean)
    .join("; ");
}

function clearCookie(input: {
  name: string;
  request: Request;
}) {
  const url = new URL(input.request.url);
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";

  return [
    `${input.name}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/api/google-calendar",
    "Max-Age=0",
    !isLocalhost ? "Secure" : null
  ]
    .filter(Boolean)
    .join("; ");
}
