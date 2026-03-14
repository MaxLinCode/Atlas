import { randomUUID } from "node:crypto";

import type { InboxItem, ScheduleBlock, Task, UserProfile } from "@atlas/core";
import { buildDefaultUserProfile } from "@atlas/core";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { inboxItems, plannerRuns, scheduleBlocks, tasks, userProfiles } from "./schema";

export type PersistedPlannerRun = {
  id: string;
  userId: string;
  inboxItemId: string | null;
  version: string;
  modelInput: unknown;
  modelOutput: unknown;
  confidence: number;
};

export type InboxProcessingContext = {
  inboxItem: InboxItem;
  tasks: Task[];
  scheduleBlocks: ScheduleBlock[];
  userProfile: UserProfile;
};

export type DraftTaskForPersistence = {
  alias: string;
  task: Omit<Task, "id">;
};

export type ProcessedInboxResult =
  | {
      outcome: "planned";
      inboxItem: InboxItem;
      plannerRun: PersistedPlannerRun;
      createdTasks: Task[];
      scheduleBlocks: ScheduleBlock[];
      followUpMessage: string;
    }
  | {
      outcome: "scheduled_existing_tasks";
      inboxItem: InboxItem;
      plannerRun: PersistedPlannerRun;
      scheduledTasks: Task[];
      scheduleBlocks: ScheduleBlock[];
      followUpMessage: string;
    }
  | {
      outcome: "updated_schedule";
      inboxItem: InboxItem;
      plannerRun: PersistedPlannerRun;
      updatedBlock: ScheduleBlock;
      followUpMessage: string;
    }
  | {
      outcome: "needs_clarification";
      inboxItem: InboxItem;
      plannerRun: PersistedPlannerRun;
      reason: string;
      followUpMessage: string;
    };

export interface InboxProcessingStore {
  loadContext(inboxItemId: string): Promise<InboxProcessingContext | null>;
  markInboxProcessing(inboxItemId: string): Promise<void>;
  saveTaskCaptureResult(input: {
    inboxItemId: string;
    confidence: number;
    plannerRun: Omit<PersistedPlannerRun, "id">;
    tasks: DraftTaskForPersistence[];
    scheduleBlocks: ScheduleBlock[];
    followUpMessage: string;
  }): Promise<ProcessedInboxResult>;
  saveScheduleAdjustmentResult(input: {
    inboxItemId: string;
    confidence: number;
    plannerRun: Omit<PersistedPlannerRun, "id">;
    blockId: string;
    newStartAt: string;
    newEndAt: string;
    reason: string;
    followUpMessage: string;
  }): Promise<ProcessedInboxResult>;
  saveScheduleRequestResult(input: {
    inboxItemId: string;
    confidence: number;
    plannerRun: Omit<PersistedPlannerRun, "id">;
    taskIds: string[];
    scheduleBlocks: ScheduleBlock[];
    followUpMessage: string;
  }): Promise<ProcessedInboxResult>;
  saveNeedsClarificationResult(input: {
    inboxItemId: string;
    confidence: number;
    plannerRun: Omit<PersistedPlannerRun, "id">;
    reason: string;
    followUpMessage: string;
  }): Promise<ProcessedInboxResult>;
  saveFailedPlannerRun(input: {
    inboxItemId: string;
    plannerRun: Omit<PersistedPlannerRun, "id">;
  }): Promise<PersistedPlannerRun>;
  saveFailure(inboxItemId: string): Promise<void>;
}

type StoredInboxItem = InboxItem & {
  createdAt?: Date;
};

type StoredTask = Task & {
  createdAt?: Date;
};

type StoredScheduleBlock = ScheduleBlock;

type StoredUserProfile = UserProfile;

class InMemoryInboxProcessingStore implements InboxProcessingStore {
  private readonly inboxItemsById = new Map<string, StoredInboxItem>();
  private readonly tasksById = new Map<string, StoredTask>();
  private readonly scheduleBlocksById = new Map<string, StoredScheduleBlock>();
  private readonly plannerRunsById = new Map<string, PersistedPlannerRun>();
  private readonly userProfilesById = new Map<string, StoredUserProfile>();

  seedInboxItem(inboxItem: InboxItem) {
    this.inboxItemsById.set(inboxItem.id, inboxItem);
  }

  listTasks() {
    return Array.from(this.tasksById.values());
  }

  listScheduleBlocks() {
    return Array.from(this.scheduleBlocksById.values());
  }

  listPlannerRuns() {
    return Array.from(this.plannerRunsById.values());
  }

  reset() {
    this.inboxItemsById.clear();
    this.tasksById.clear();
    this.scheduleBlocksById.clear();
    this.plannerRunsById.clear();
    this.userProfilesById.clear();
  }

  async loadContext(inboxItemId: string): Promise<InboxProcessingContext | null> {
    const inboxItem = this.inboxItemsById.get(inboxItemId);

    if (!inboxItem) {
      return null;
    }

    return {
      inboxItem,
      tasks: Array.from(this.tasksById.values()).filter((task) => task.userId === inboxItem.userId),
      scheduleBlocks: Array.from(this.scheduleBlocksById.values()).filter(
        (block) => block.userId === inboxItem.userId
      ),
      userProfile: this.userProfilesById.get(inboxItem.userId) ?? buildDefaultUserProfile(inboxItem.userId)
    };
  }

  async markInboxProcessing(inboxItemId: string) {
    const inboxItem = this.inboxItemsById.get(inboxItemId);

    if (!inboxItem) {
      return;
    }

    this.inboxItemsById.set(inboxItemId, {
      ...inboxItem,
      processingStatus: "processing"
    });
  }

  async saveTaskCaptureResult(input: {
    inboxItemId: string;
    confidence: number;
    plannerRun: Omit<PersistedPlannerRun, "id">;
    tasks: DraftTaskForPersistence[];
    scheduleBlocks: ScheduleBlock[];
    followUpMessage: string;
  }): Promise<ProcessedInboxResult> {
    const inboxItem = this.requireInboxItem(input.inboxItemId);
    const aliasToCreatedTaskId = new Map<string, string>();
    const createdTasks = input.tasks.map(({ alias, task }) => {
      const createdTask = {
        ...task,
        id: randomUUID()
      };
      this.tasksById.set(createdTask.id, createdTask);
      aliasToCreatedTaskId.set(alias, createdTask.id);
      return createdTask;
    });
    const linkedTaskIds = createdTasks.map((task) => task.id);
    const remappedBlocks = input.scheduleBlocks.map((block) => ({
      ...block,
      taskId: aliasToCreatedTaskId.get(block.taskId) ?? block.taskId
    }));

    for (const block of remappedBlocks) {
      this.scheduleBlocksById.set(block.id, block);
    }

    const plannerRun = this.insertPlannerRun(input.plannerRun);
    const updatedInbox = {
      ...inboxItem,
      processingStatus: "planned" as const,
      linkedTaskIds
    };
    this.inboxItemsById.set(input.inboxItemId, updatedInbox);

    return {
      outcome: "planned",
      inboxItem: updatedInbox,
      plannerRun,
      createdTasks,
      scheduleBlocks: remappedBlocks,
      followUpMessage: input.followUpMessage
    };
  }

  async saveScheduleAdjustmentResult(input: {
    inboxItemId: string;
    confidence: number;
    plannerRun: Omit<PersistedPlannerRun, "id">;
    blockId: string;
    newStartAt: string;
    newEndAt: string;
    reason: string;
    followUpMessage: string;
  }): Promise<ProcessedInboxResult> {
    const inboxItem = this.requireInboxItem(input.inboxItemId);
    const block = this.scheduleBlocksById.get(input.blockId);

    if (!block) {
      throw new Error(`Schedule block ${input.blockId} not found.`);
    }

    const updatedBlock = {
      ...block,
      startAt: input.newStartAt,
      endAt: input.newEndAt,
      reason: input.reason,
      rescheduleCount: block.rescheduleCount + 1,
      confidence: input.confidence
    };
    this.scheduleBlocksById.set(updatedBlock.id, updatedBlock);

    const plannerRun = this.insertPlannerRun(input.plannerRun);
    const updatedInbox = {
      ...inboxItem,
      processingStatus: "planned" as const
    };
    this.inboxItemsById.set(input.inboxItemId, updatedInbox);

    return {
      outcome: "updated_schedule",
      inboxItem: updatedInbox,
      plannerRun,
      updatedBlock,
      followUpMessage: input.followUpMessage
    };
  }

  async saveScheduleRequestResult(input: {
    inboxItemId: string;
    confidence: number;
    plannerRun: Omit<PersistedPlannerRun, "id">;
    taskIds: string[];
    scheduleBlocks: ScheduleBlock[];
    followUpMessage: string;
  }): Promise<ProcessedInboxResult> {
    const inboxItem = this.requireInboxItem(input.inboxItemId);
    const scheduledTasks = input.taskIds
      .map((taskId) => this.tasksById.get(taskId))
      .filter((task): task is Task => Boolean(task));

    for (const block of input.scheduleBlocks) {
      this.scheduleBlocksById.set(block.id, block);
    }

    const plannerRun = this.insertPlannerRun(input.plannerRun);
    const updatedInbox = {
      ...inboxItem,
      processingStatus: "planned" as const,
      linkedTaskIds: input.taskIds
    };
    this.inboxItemsById.set(input.inboxItemId, updatedInbox);

    return {
      outcome: "scheduled_existing_tasks",
      inboxItem: updatedInbox,
      plannerRun,
      scheduledTasks,
      scheduleBlocks: input.scheduleBlocks,
      followUpMessage: input.followUpMessage
    };
  }

  async saveNeedsClarificationResult(input: {
    inboxItemId: string;
    confidence: number;
    plannerRun: Omit<PersistedPlannerRun, "id">;
    reason: string;
    followUpMessage: string;
  }): Promise<ProcessedInboxResult> {
    const inboxItem = this.requireInboxItem(input.inboxItemId);
    const plannerRun = this.insertPlannerRun(input.plannerRun);
    const updatedInbox = {
      ...inboxItem,
      processingStatus: "needs_clarification" as const
    };
    this.inboxItemsById.set(input.inboxItemId, updatedInbox);

    return {
      outcome: "needs_clarification",
      inboxItem: updatedInbox,
      plannerRun,
      reason: input.reason,
      followUpMessage: input.followUpMessage
    };
  }

  async saveFailedPlannerRun(input: {
    inboxItemId: string;
    plannerRun: Omit<PersistedPlannerRun, "id">;
  }) {
    const plannerRun = this.insertPlannerRun(input.plannerRun);
    const inboxItem = this.requireInboxItem(input.inboxItemId);
    this.inboxItemsById.set(input.inboxItemId, {
      ...inboxItem,
      processingStatus: "received"
    });
    return plannerRun;
  }

  async saveFailure(inboxItemId: string) {
    const inboxItem = this.requireInboxItem(inboxItemId);
    this.inboxItemsById.set(inboxItemId, {
      ...inboxItem,
      processingStatus: "received"
    });
  }

  private requireInboxItem(inboxItemId: string) {
    const inboxItem = this.inboxItemsById.get(inboxItemId);

    if (!inboxItem) {
      throw new Error(`Inbox item ${inboxItemId} not found.`);
    }

    return inboxItem;
  }

  private insertPlannerRun(plannerRun: Omit<PersistedPlannerRun, "id">) {
    const created = {
      ...plannerRun,
      id: randomUUID()
    };
    this.plannerRunsById.set(created.id, created);
    return created;
  }
}

export class PostgresInboxProcessingStore implements InboxProcessingStore {
  private readonly client;
  private readonly db;

  constructor(databaseUrl = getRequiredDatabaseUrl()) {
    this.client = postgres(databaseUrl, {
      prepare: false
    });
    this.db = drizzle(this.client);
  }

  async loadContext(inboxItemId: string): Promise<InboxProcessingContext | null> {
    const inboxItemRows = await this.db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, inboxItemId))
      .limit(1);

    const inboxItem = inboxItemRows[0];

    if (!inboxItem) {
      return null;
    }

    const [taskRows, blockRows, profileRows] = await Promise.all([
      this.db.select().from(tasks).where(eq(tasks.userId, inboxItem.userId)),
      this.db.select().from(scheduleBlocks).where(eq(scheduleBlocks.userId, inboxItem.userId)),
      this.db.select().from(userProfiles).where(eq(userProfiles.userId, inboxItem.userId)).limit(1)
    ]);

    return {
      inboxItem: {
        id: inboxItem.id,
        userId: inboxItem.userId,
        sourceEventId: inboxItem.sourceEventId ?? undefined,
        rawText: inboxItem.rawText,
        normalizedText: inboxItem.normalizedText,
        processingStatus: inboxItem.processingStatus as InboxItem["processingStatus"],
        linkedTaskIds: inboxItem.linkedTaskIds
      },
      tasks: taskRows.map((task) => ({
        id: task.id,
        userId: task.userId,
        sourceInboxItemId: task.sourceInboxItemId,
        title: task.title,
        status: task.status as Task["status"],
        priority: task.priority as Task["priority"],
        urgency: task.urgency as Task["urgency"]
      })),
      scheduleBlocks: blockRows.map((block) => ({
        id: block.id,
        userId: block.userId,
        taskId: block.taskId,
        startAt: block.startAt.toISOString(),
        endAt: block.endAt.toISOString(),
        confidence: block.confidence,
        reason: block.reason,
        rescheduleCount: block.rescheduleCount,
        externalCalendarId: block.externalCalendarId
      })),
      userProfile: profileRows[0]
        ? {
            userId: profileRows[0].userId,
            timezone: profileRows[0].timezone,
            workdayStartHour: profileRows[0].workdayStartHour,
            workdayEndHour: profileRows[0].workdayEndHour,
            deepWorkWindows: profileRows[0].deepWorkWindows as UserProfile["deepWorkWindows"],
            blackoutWindows: profileRows[0].blackoutWindows as UserProfile["blackoutWindows"],
            focusBlockMinutes: profileRows[0].focusBlockMinutes,
            reminderStyle: profileRows[0].reminderStyle as UserProfile["reminderStyle"],
            breakdownLevel: profileRows[0].breakdownLevel
          }
        : buildDefaultUserProfile(inboxItem.userId)
    };
  }

  async markInboxProcessing(inboxItemId: string) {
    await this.db
      .update(inboxItems)
      .set({
        processingStatus: "processing"
      })
      .where(eq(inboxItems.id, inboxItemId));
  }

  async saveTaskCaptureResult(input: {
    inboxItemId: string;
    confidence: number;
    plannerRun: Omit<PersistedPlannerRun, "id">;
    tasks: DraftTaskForPersistence[];
    scheduleBlocks: ScheduleBlock[];
    followUpMessage: string;
  }): Promise<ProcessedInboxResult> {
    return this.db.transaction(async (tx) => {
      const inboxItem = await this.loadInboxItemWithin(tx, input.inboxItemId);
      const aliasToCreatedTaskId = new Map<string, string>();
      const createdTasks = await tx
        .insert(tasks)
        .values(
          input.tasks.map(({ task }) => ({
            id: randomUUID(),
            userId: task.userId,
            sourceInboxItemId: task.sourceInboxItemId,
            title: task.title,
            status: task.status,
            priority: task.priority,
            urgency: task.urgency
          }))
        )
        .returning();

      input.tasks.forEach(({ alias }, index) => {
        const createdTask = createdTasks[index];
        if (createdTask) {
          aliasToCreatedTaskId.set(alias, createdTask.id);
        }
      });

      const remappedBlocks = input.scheduleBlocks.map((block) => ({
        ...block,
        taskId: aliasToCreatedTaskId.get(block.taskId) ?? block.taskId
      }));

      await tx.insert(scheduleBlocks).values(
        remappedBlocks.map((block) => ({
          id: block.id,
          userId: block.userId,
          taskId: block.taskId,
          actionId: null,
          startAt: new Date(block.startAt),
          endAt: new Date(block.endAt),
          confidence: block.confidence,
          reason: block.reason,
          rescheduleCount: block.rescheduleCount,
          externalCalendarId: block.externalCalendarId
        }))
      );

      const plannerRun = await this.insertPlannerRunWithin(tx, input.plannerRun);
      const linkedTaskIds = createdTasks.map((task) => task.id);

      await tx
        .update(inboxItems)
        .set({
          processingStatus: "planned",
          linkedTaskIds
        })
        .where(eq(inboxItems.id, input.inboxItemId));

      return {
        outcome: "planned" as const,
        inboxItem: {
          ...inboxItem,
          processingStatus: "planned",
          linkedTaskIds
        },
        plannerRun,
        createdTasks: createdTasks.map((task) => ({
          id: task.id,
          userId: task.userId,
          sourceInboxItemId: task.sourceInboxItemId,
          title: task.title,
          status: task.status as Task["status"],
          priority: task.priority as Task["priority"],
          urgency: task.urgency as Task["urgency"]
        })),
        scheduleBlocks: remappedBlocks,
        followUpMessage: input.followUpMessage
      };
    });
  }

  async saveScheduleAdjustmentResult(input: {
    inboxItemId: string;
    confidence: number;
    plannerRun: Omit<PersistedPlannerRun, "id">;
    blockId: string;
    newStartAt: string;
    newEndAt: string;
    reason: string;
    followUpMessage: string;
  }): Promise<ProcessedInboxResult> {
    return this.db.transaction(async (tx) => {
      const inboxItem = await this.loadInboxItemWithin(tx, input.inboxItemId);
      const [existingBlock] = await tx
        .select()
        .from(scheduleBlocks)
        .where(eq(scheduleBlocks.id, input.blockId))
        .limit(1);

      if (!existingBlock) {
        throw new Error(`Schedule block ${input.blockId} not found.`);
      }

      await tx
        .update(scheduleBlocks)
        .set({
          startAt: new Date(input.newStartAt),
          endAt: new Date(input.newEndAt),
          reason: input.reason,
          confidence: input.confidence,
          rescheduleCount: existingBlock.rescheduleCount + 1
        })
        .where(eq(scheduleBlocks.id, input.blockId));

      const plannerRun = await this.insertPlannerRunWithin(tx, input.plannerRun);

      await tx
        .update(inboxItems)
        .set({
          processingStatus: "planned"
        })
        .where(eq(inboxItems.id, input.inboxItemId));

      return {
        outcome: "updated_schedule",
        inboxItem: {
          ...inboxItem,
          processingStatus: "planned"
        },
        plannerRun,
        updatedBlock: {
          id: existingBlock.id,
          userId: existingBlock.userId,
          taskId: existingBlock.taskId,
          startAt: input.newStartAt,
          endAt: input.newEndAt,
          confidence: input.confidence,
          reason: input.reason,
          rescheduleCount: existingBlock.rescheduleCount + 1,
          externalCalendarId: existingBlock.externalCalendarId
        },
        followUpMessage: input.followUpMessage
      };
    });
  }

  async saveScheduleRequestResult(input: {
    inboxItemId: string;
    confidence: number;
    plannerRun: Omit<PersistedPlannerRun, "id">;
    taskIds: string[];
    scheduleBlocks: ScheduleBlock[];
    followUpMessage: string;
  }): Promise<ProcessedInboxResult> {
    return this.db.transaction(async (tx) => {
      const inboxItem = await this.loadInboxItemWithin(tx, input.inboxItemId);
      const scheduledTasksRows = input.taskIds.length
        ? await tx.select().from(tasks).where(eq(tasks.userId, inboxItem.userId))
        : [];
      const scheduledTasks = scheduledTasksRows
        .filter((task) => input.taskIds.includes(task.id))
        .map((task) => ({
          id: task.id,
          userId: task.userId,
          sourceInboxItemId: task.sourceInboxItemId,
          title: task.title,
          status: task.status as Task["status"],
          priority: task.priority as Task["priority"],
          urgency: task.urgency as Task["urgency"]
        }));

      await tx.insert(scheduleBlocks).values(
        input.scheduleBlocks.map((block) => ({
          id: block.id,
          userId: block.userId,
          taskId: block.taskId,
          actionId: null,
          startAt: new Date(block.startAt),
          endAt: new Date(block.endAt),
          confidence: block.confidence,
          reason: block.reason,
          rescheduleCount: block.rescheduleCount,
          externalCalendarId: block.externalCalendarId
        }))
      );

      const plannerRun = await this.insertPlannerRunWithin(tx, input.plannerRun);

      await tx
        .update(inboxItems)
        .set({
          processingStatus: "planned",
          linkedTaskIds: input.taskIds
        })
        .where(eq(inboxItems.id, input.inboxItemId));

      return {
        outcome: "scheduled_existing_tasks",
        inboxItem: {
          ...inboxItem,
          processingStatus: "planned",
          linkedTaskIds: input.taskIds
        },
        plannerRun,
        scheduledTasks,
        scheduleBlocks: input.scheduleBlocks,
        followUpMessage: input.followUpMessage
      };
    });
  }

  async saveNeedsClarificationResult(input: {
    inboxItemId: string;
    confidence: number;
    plannerRun: Omit<PersistedPlannerRun, "id">;
    reason: string;
    followUpMessage: string;
  }): Promise<ProcessedInboxResult> {
    return this.db.transaction(async (tx) => {
      const inboxItem = await this.loadInboxItemWithin(tx, input.inboxItemId);
      const plannerRun = await this.insertPlannerRunWithin(tx, input.plannerRun);

      await tx
        .update(inboxItems)
        .set({
          processingStatus: "needs_clarification"
        })
        .where(eq(inboxItems.id, input.inboxItemId));

      return {
        outcome: "needs_clarification",
        inboxItem: {
          ...inboxItem,
          processingStatus: "needs_clarification"
        },
        plannerRun,
        reason: input.reason,
        followUpMessage: input.followUpMessage
      };
    });
  }

  async saveFailedPlannerRun(input: {
    inboxItemId: string;
    plannerRun: Omit<PersistedPlannerRun, "id">;
  }) {
    return this.db.transaction(async (tx) => {
      const plannerRun = await this.insertPlannerRunWithin(tx, input.plannerRun);

      await tx
        .update(inboxItems)
        .set({
          processingStatus: "received"
        })
        .where(eq(inboxItems.id, input.inboxItemId));

      return plannerRun;
    });
  }

  async saveFailure(inboxItemId: string) {
    await this.db
      .update(inboxItems)
      .set({
        processingStatus: "received"
      })
      .where(eq(inboxItems.id, inboxItemId));
  }

  async close() {
    await this.client.end();
  }

  private async loadInboxItemWithin(tx: any, inboxItemId: string) {
    const [row] = await tx.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId)).limit(1);

    if (!row) {
      throw new Error(`Inbox item ${inboxItemId} not found.`);
    }

    return {
      id: row.id,
      userId: row.userId,
      sourceEventId: row.sourceEventId ?? undefined,
      rawText: row.rawText,
      normalizedText: row.normalizedText,
      processingStatus: row.processingStatus as InboxItem["processingStatus"],
      linkedTaskIds: row.linkedTaskIds
    };
  }

  private async insertPlannerRunWithin(
    tx: any,
    plannerRun: Omit<PersistedPlannerRun, "id">
  ): Promise<PersistedPlannerRun> {
    const insertedRows = await tx
      .insert(plannerRuns)
      .values({
        id: randomUUID(),
        userId: plannerRun.userId,
        inboxItemId: plannerRun.inboxItemId,
        version: plannerRun.version,
        modelInput: plannerRun.modelInput,
        modelOutput: plannerRun.modelOutput,
        confidence: plannerRun.confidence
      })
      .returning();
    const inserted = insertedRows[0];

    if (!inserted) {
      throw new Error("Failed to insert planner run.");
    }

    return {
      id: inserted.id,
      userId: inserted.userId,
      inboxItemId: inserted.inboxItemId,
      version: inserted.version,
      modelInput: inserted.modelInput,
      modelOutput: inserted.modelOutput,
      confidence: inserted.confidence
    };
  }
}

const defaultInMemoryStore = new InMemoryInboxProcessingStore();
let postgresStore: PostgresInboxProcessingStore | null = null;

export function getDefaultInboxProcessingStore(): InboxProcessingStore {
  if (isTestEnvironment()) {
    return defaultInMemoryStore;
  }

  if (!postgresStore) {
    postgresStore = new PostgresInboxProcessingStore();
  }

  return postgresStore;
}

export function seedInboxItemForProcessingTests(inboxItem: InboxItem) {
  defaultInMemoryStore.seedInboxItem(inboxItem);
}

export function resetInboxProcessingStoreForTests() {
  defaultInMemoryStore.reset();
}

export function listPlannerRunsForTests() {
  return defaultInMemoryStore.listPlannerRuns();
}

export function listTasksForTests() {
  return defaultInMemoryStore.listTasks();
}

export function listScheduleBlocksForTests() {
  return defaultInMemoryStore.listScheduleBlocks();
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
