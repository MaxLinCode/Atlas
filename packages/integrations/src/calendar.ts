import { randomUUID } from "node:crypto";

import { z } from "zod";

const calendarEventSnapshotSchema = z.object({
  externalCalendarEventId: z.string().min(1),
  externalCalendarId: z.string().min(1),
  scheduledStartAt: z.string().datetime(),
  scheduledEndAt: z.string().datetime()
});

const calendarBusyPeriodSchema = z.object({
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  externalCalendarId: z.string().min(1)
});

const googleTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  id_token: z.string().optional()
});

const googleCalendarListResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      summary: z.string().min(1).default("Google Calendar"),
      primary: z.boolean().optional(),
      accessRole: z.string().optional()
    })
  )
});

const googleCalendarRecordSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1)
});

const googleUserInfoSchema = z.object({
  id: z.string().min(1),
  email: z.string().email()
});

const googleEventResponseSchema = z.object({
  id: z.string().min(1),
  start: z.object({
    dateTime: z.string().datetime({
      offset: true
    })
  }),
  end: z.object({
    dateTime: z.string().datetime({
      offset: true
    })
  })
});

export type CalendarEventSnapshot = z.infer<typeof calendarEventSnapshotSchema>;
export type CalendarBusyPeriod = z.infer<typeof calendarBusyPeriodSchema>;

export type CalendarEventWriteInput = {
  title: string;
  startAt: string;
  endAt: string;
  externalCalendarId?: string | null;
};

export type ExternalCalendarAdapter = {
  provider: "google-calendar";
  createEvent(input: CalendarEventWriteInput): Promise<CalendarEventSnapshot>;
  updateEvent(
    input: CalendarEventWriteInput & {
      externalCalendarEventId: string;
    }
  ): Promise<CalendarEventSnapshot>;
  getEvent(input: {
    externalCalendarEventId: string;
    externalCalendarId: string;
  }): Promise<CalendarEventSnapshot | null>;
  listBusyPeriods(input: {
    startAt: string;
    endAt: string;
    externalCalendarId: string;
  }): Promise<CalendarBusyPeriod[]>;
};

export type GoogleCalendarAuth = {
  accessToken: string;
  selectedCalendarId: string;
};

export type GoogleOAuthTokenExchangeResult = {
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  scopes: string[];
};

export type GoogleCalendarIdentity = {
  providerAccountId: string;
  email: string;
  selectedCalendarId: string;
  selectedCalendarName: string;
};

export type GoogleOAuthRefreshResult = GoogleOAuthTokenExchangeResult;

class InMemoryCalendarAdapter implements ExternalCalendarAdapter {
  readonly provider = "google-calendar" as const;
  private readonly eventsById = new Map<string, CalendarEventSnapshot>();

  async createEvent(input: CalendarEventWriteInput): Promise<CalendarEventSnapshot> {
    const snapshot = calendarEventSnapshotSchema.parse({
      externalCalendarEventId: randomUUID(),
      externalCalendarId: input.externalCalendarId ?? "primary",
      scheduledStartAt: input.startAt,
      scheduledEndAt: input.endAt
    });
    this.eventsById.set(snapshot.externalCalendarEventId, snapshot);
    return snapshot;
  }

  async updateEvent(
    input: CalendarEventWriteInput & {
      externalCalendarEventId: string;
    }
  ): Promise<CalendarEventSnapshot> {
    const snapshot = calendarEventSnapshotSchema.parse({
      externalCalendarEventId: input.externalCalendarEventId,
      externalCalendarId: input.externalCalendarId ?? "primary",
      scheduledStartAt: input.startAt,
      scheduledEndAt: input.endAt
    });
    this.eventsById.set(snapshot.externalCalendarEventId, snapshot);
    return snapshot;
  }

  async getEvent(input: {
    externalCalendarEventId: string;
    externalCalendarId: string;
  }): Promise<CalendarEventSnapshot | null> {
    const snapshot = this.eventsById.get(input.externalCalendarEventId);

    if (!snapshot || snapshot.externalCalendarId !== input.externalCalendarId) {
      return null;
    }

    return snapshot;
  }

  async listBusyPeriods(input: {
    startAt: string;
    endAt: string;
    externalCalendarId: string;
  }): Promise<CalendarBusyPeriod[]> {
    const start = Date.parse(input.startAt);
    const end = Date.parse(input.endAt);

    return Array.from(this.eventsById.values())
      .filter(
        (event) =>
          event.externalCalendarId === input.externalCalendarId &&
          Date.parse(event.scheduledStartAt) < end &&
          Date.parse(event.scheduledEndAt) > start
      )
      .map((event) =>
        calendarBusyPeriodSchema.parse({
          startAt: event.scheduledStartAt,
          endAt: event.scheduledEndAt,
          externalCalendarId: event.externalCalendarId
        })
      );
  }

  reset() {
    this.eventsById.clear();
  }
}

class GoogleCalendarAdapter implements ExternalCalendarAdapter {
  readonly provider = "google-calendar" as const;

  constructor(
    private readonly auth: GoogleCalendarAuth,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async createEvent(input: CalendarEventWriteInput): Promise<CalendarEventSnapshot> {
    const calendarId = input.externalCalendarId ?? this.auth.selectedCalendarId;
    const response = await this.fetchJson(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: "POST",
        body: JSON.stringify(buildGoogleEventBody(input))
      }
    );

    return parseGoogleEvent(response, calendarId);
  }

  async updateEvent(
    input: CalendarEventWriteInput & {
      externalCalendarEventId: string;
    }
  ): Promise<CalendarEventSnapshot> {
    const calendarId = input.externalCalendarId ?? this.auth.selectedCalendarId;
    const response = await this.fetchJson(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(input.externalCalendarEventId)}`,
      {
        method: "PUT",
        body: JSON.stringify(buildGoogleEventBody(input))
      }
    );

    return parseGoogleEvent(response, calendarId);
  }

  async getEvent(input: {
    externalCalendarEventId: string;
    externalCalendarId: string;
  }): Promise<CalendarEventSnapshot | null> {
    const response = await this.fetchImpl(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.externalCalendarId)}/events/${encodeURIComponent(input.externalCalendarEventId)}`,
      {
        headers: buildGoogleHeaders(this.auth.accessToken)
      }
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Google Calendar getEvent failed with status ${response.status}.`);
    }

    return parseGoogleEvent(await response.json(), input.externalCalendarId);
  }

  async listBusyPeriods(input: {
    startAt: string;
    endAt: string;
    externalCalendarId: string;
  }): Promise<CalendarBusyPeriod[]> {
    const response = await this.fetchJson("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      body: JSON.stringify({
        timeMin: input.startAt,
        timeMax: input.endAt,
        items: [{ id: input.externalCalendarId }]
      })
    });

    const periods = Array.isArray(response?.calendars?.[input.externalCalendarId]?.busy)
      ? response.calendars[input.externalCalendarId].busy
      : [];

    return periods.map((period: { start?: string; end?: string }) =>
      calendarBusyPeriodSchema.parse({
        startAt: normalizeGoogleDateTime(period.start),
        endAt: normalizeGoogleDateTime(period.end),
        externalCalendarId: input.externalCalendarId
      })
    );
  }

  private async fetchJson(url: string, init: RequestInit) {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        ...buildGoogleHeaders(this.auth.accessToken),
        ...(init.headers ?? {})
      }
    });

    if (!response.ok) {
      throw new Error(`Google Calendar request failed with status ${response.status}.`);
    }

    return response.json();
  }
}

const defaultCalendarAdapter = new InMemoryCalendarAdapter();

export function getDefaultCalendarAdapter(): ExternalCalendarAdapter {
  return defaultCalendarAdapter;
}

export function createGoogleCalendarAdapter(
  auth: GoogleCalendarAuth,
  dependencies: {
    fetch?: typeof fetch;
  } = {}
): ExternalCalendarAdapter {
  return new GoogleCalendarAdapter(auth, dependencies.fetch);
}

export function buildGoogleCalendarOAuthUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/userinfo.email"
  ].join(" "));
  url.searchParams.set("state", input.state);
  return url.toString();
}

export async function exchangeGoogleOAuthCode(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  fetch?: typeof fetch;
}): Promise<GoogleOAuthTokenExchangeResult> {
  const response = await (input.fetch ?? fetch)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
      grant_type: "authorization_code"
    })
  });

  if (!response.ok) {
    throw new Error(`Google OAuth token exchange failed with status ${response.status}.`);
  }

  const parsed = googleTokenResponseSchema.parse(await response.json());

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    tokenExpiresAt:
      typeof parsed.expires_in === "number"
        ? new Date(Date.now() + parsed.expires_in * 1000).toISOString()
        : null,
    scopes: parsed.scope?.split(" ").filter(Boolean) ?? []
  };
}

export async function refreshGoogleOAuthToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof fetch;
}): Promise<GoogleOAuthRefreshResult> {
  const response = await (input.fetch ?? fetch)("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: "refresh_token"
    })
  });

  if (!response.ok) {
    throw new Error(`Google OAuth token refresh failed with status ${response.status}.`);
  }

  const parsed = googleTokenResponseSchema.parse(await response.json());

  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? input.refreshToken,
    tokenExpiresAt:
      typeof parsed.expires_in === "number"
        ? new Date(Date.now() + parsed.expires_in * 1000).toISOString()
        : null,
    scopes: parsed.scope?.split(" ").filter(Boolean) ?? []
  };
}

export async function fetchGoogleCalendarIdentity(input: {
  accessToken: string;
  fetch?: typeof fetch;
}): Promise<GoogleCalendarIdentity> {
  const fetchImpl = input.fetch ?? fetch;
  const [userInfoResponse, calendarsResponse] = await Promise.all([
    fetchImpl("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: buildGoogleHeaders(input.accessToken)
    }),
    fetchImpl("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
      headers: buildGoogleHeaders(input.accessToken)
    })
  ]);

  if (!userInfoResponse.ok) {
    throw new Error(`Google user info request failed with status ${userInfoResponse.status}.`);
  }

  if (!calendarsResponse.ok) {
    throw new Error(`Google calendar list request failed with status ${calendarsResponse.status}.`);
  }

  const userInfo = googleUserInfoSchema.parse(await userInfoResponse.json());
  const calendarList = googleCalendarListResponseSchema.parse(await calendarsResponse.json());
  const selectedCalendar =
    findExistingAtlasCalendar(calendarList.items) ??
    (await createAtlasCalendar({
      accessToken: input.accessToken,
      fetch: fetchImpl
    }));

  if (!selectedCalendar) {
    throw new Error("Atlas could not select or create its dedicated Google Calendar.");
  }

  return {
    providerAccountId: userInfo.id,
    email: userInfo.email,
    selectedCalendarId: selectedCalendar.id,
    selectedCalendarName: selectedCalendar.summary
  };
}

export function resetCalendarAdapterForTests() {
  defaultCalendarAdapter.reset();
}

function buildGoogleHeaders(accessToken: string) {
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json"
  };
}

function buildGoogleEventBody(input: CalendarEventWriteInput) {
  return {
    summary: input.title,
    start: {
      dateTime: input.startAt
    },
    end: {
      dateTime: input.endAt
    }
  };
}

function parseGoogleEvent(payload: unknown, externalCalendarId: string): CalendarEventSnapshot {
  const parsed = googleEventResponseSchema.parse(payload);

  return calendarEventSnapshotSchema.parse({
    externalCalendarEventId: parsed.id,
    externalCalendarId,
    scheduledStartAt: normalizeGoogleDateTime(parsed.start.dateTime),
    scheduledEndAt: normalizeGoogleDateTime(parsed.end.dateTime)
  });
}

function isWritableCalendar(accessRole?: string) {
  return accessRole === "owner" || accessRole === "writer";
}

function findExistingAtlasCalendar(
  calendars: Array<{
    id: string;
    summary: string;
    primary?: boolean | undefined;
    accessRole?: string | undefined;
  }>
) {
  return (
    calendars.find(
      (calendar) => isWritableCalendar(calendar.accessRole) && calendar.summary.trim().toLowerCase() === "atlas"
    ) ?? null
  );
}

async function createAtlasCalendar(input: {
  accessToken: string;
  fetch: typeof fetch;
}) {
  const response = await input.fetch("https://www.googleapis.com/calendar/v3/calendars", {
    method: "POST",
    headers: buildGoogleHeaders(input.accessToken),
    body: JSON.stringify({
      summary: "Atlas"
    })
  });

  if (!response.ok) {
    throw new Error(`Google calendar creation failed with status ${response.status}.`);
  }

  return googleCalendarRecordSchema.parse(await response.json());
}

function normalizeGoogleDateTime(value: string | undefined) {
  const parsed = z
    .string()
    .datetime({
      offset: true
    })
    .parse(value);

  return new Date(parsed).toISOString();
}
