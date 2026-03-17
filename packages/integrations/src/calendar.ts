import { randomUUID } from "node:crypto";

import { z } from "zod";

const calendarEventSnapshotSchema = z.object({
  externalCalendarEventId: z.string().min(1),
  externalCalendarId: z.string().min(1),
  scheduledStartAt: z.string().datetime(),
  scheduledEndAt: z.string().datetime()
});

export type CalendarEventSnapshot = z.infer<typeof calendarEventSnapshotSchema>;

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
};

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

  reset() {
    this.eventsById.clear();
  }
}

const defaultCalendarAdapter = new InMemoryCalendarAdapter();

export function getDefaultCalendarAdapter(): ExternalCalendarAdapter {
  return defaultCalendarAdapter;
}

export function resetCalendarAdapterForTests() {
  defaultCalendarAdapter.reset();
}
