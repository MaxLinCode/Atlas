import { describe, expect, it } from "vitest";

import { buildDefaultUserProfile } from "@atlas/core";

import { planInboxItemWithResponses, plannedCalendarAdapter } from "./index";

describe("integrations", () => {
  it("keeps calendar support as a planned boundary", () => {
    expect(plannedCalendarAdapter.status).toBe("planned");
  });

  it("parses structured inbox planning output from the Responses API client", async () => {
    const result = await planInboxItemWithResponses(
      {
        inboxItem: {
          id: "inbox-1",
          userId: "123",
          sourceEventId: "event-1",
          rawText: "Submit taxes tomorrow at 3pm",
          normalizedText: "Submit taxes tomorrow at 3pm",
          processingStatus: "received",
          linkedTaskIds: []
        },
        userProfile: buildDefaultUserProfile("123"),
        tasks: [],
        scheduleBlocks: []
      },
      {
        responses: {
          parse: async () => ({
            output_parsed: {
              confidence: 0.91,
              summary: "Create and schedule a tax task.",
              actions: [
                {
                  type: "create_task",
                  alias: "new_task_1",
                  title: "Submit taxes",
                  priority: "medium",
                  urgency: "high"
                },
                {
                  type: "create_schedule_block",
                  taskRef: {
                    kind: "created_task",
                    alias: "new_task_1"
                  },
                  scheduleConstraint: {
                    dayOffset: 1,
                    explicitHour: 15,
                    minute: 0,
                    preferredWindow: null,
                    sourceText: "tomorrow at 3pm"
                  },
                  reason: "The user asked for tomorrow at 3pm."
                }
              ]
            }
          })
        }
      }
    );

    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]?.type).toBe("create_task");
  });

  it("rejects malformed structured Responses API output", async () => {
    await expect(
      planInboxItemWithResponses(
        {
          inboxItem: {
            id: "inbox-1",
            userId: "123",
            sourceEventId: "event-1",
            rawText: "Move it to 3pm",
            normalizedText: "Move it to 3pm",
            processingStatus: "received",
            linkedTaskIds: []
          },
          userProfile: buildDefaultUserProfile("123"),
          tasks: [],
          scheduleBlocks: []
        },
        {
          responses: {
            parse: async () => ({
              output_parsed: {
                confidence: 2,
                summary: "Bad output",
                actions: []
              }
            })
          }
        }
      )
    ).rejects.toThrow();
  });
});
