import { randomUUID } from "node:crypto";

import type { InboxItem, ScheduleBlock, Task, UserProfile } from "@atlas/core";
import { buildDefaultUserProfile, buildScheduleBlocksFromTasks } from "@atlas/core";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { inboxItems, plannerRuns, tasks, userProfiles } from "./schema";
import {
  attachGoogleCalendarConnectionStoreToTasks,
  getDefaultGoogleCalendarConnectionStore,
  type GoogleCalendarConnection
} from "./google-calendar";

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
  googleCalendarConnection: GoogleCalendarConnection | null;
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
      outcome: "completed_tasks";
      inboxItem: InboxItem;
      plannerRun: PersistedPlannerRun;
      completedTasks: Task[];
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
  saveTaskCompletionResult(input: {
    inboxItemId: string;
    confidence: number;
    plannerRun: Omit<PersistedPlannerRun, "id">;
    taskIds: string[];
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
  reconcileTaskCalendarProjection(input: {
    taskId: string;
    externalCalendarEventId: string | null;
    externalCalendarId: string | null;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    calendarSyncStatus: "in_sync" | "out_of_sync";
    calendarSyncUpdatedAt: string;
  }): Promise<void>;
}

type StoredInboxItem = InboxItem;

type StoredTask = Omit<Task, "createdAt"> & {
  createdAt?: string | undefined;
};

type StoredUserProfile = UserProfile;

class InMemoryInboxProcessingStore implements InboxProcessingStore {
  private readonly inboxItemsById = new Map<string, StoredInboxItem>();
  private readonly tasksById = new Map<string, StoredTask>();
  private readonly plannerRunsById = new Map<string, PersistedPlannerRun>();
  private readonly userProfilesById = new Map<string, StoredUserProfile>();

  seedInboxItem(inboxItem: InboxItem) {
    this.inboxItemsById.set(inboxItem.id, inboxItem);
  }

  listTasks() {
    return Array.from(this.tasksById.values());
  }

  replaceTask(taskId: string, task: StoredTask) {
    this.tasksById.set(taskId, task);
  }

  listScheduleBlocks() {
    return buildScheduleBlocksFromTasks(this.listTasks());
  }

  listPlannerRuns() {
    return Array.from(this.plannerRunsById.values());
  }

  reset() {
    this.inboxItemsById.clear();
    this.tasksById.clear();
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
        scheduleBlocks: buildScheduleBlocksFromTasks(
          Array.from(this.tasksById.values()).filter((task) => task.userId === inboxItem.userId)
        ),
        userProfile: this.userProfilesById.get(inboxItem.userId) ?? buildDefaultUserProfile(inboxItem.userId),
        googleCalendarConnection: await getDefaultGoogleCalendarConnectionStore().getConnection(inboxItem.userId)
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
      const createdTask: StoredTask = {
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

    const persistedCreatedTasks = createdTasks.map((task) => {
      const currentBlock = remappedBlocks.find((block) => block.taskId === task.id) ?? null;
      const persistedTask: StoredTask = {
        ...task,
        lifecycleState: currentBlock ? "scheduled" : task.lifecycleState,
        externalCalendarEventId: currentBlock?.id ?? null,
        externalCalendarId: currentBlock?.externalCalendarId ?? null,
        scheduledStartAt: currentBlock?.startAt ?? null,
        scheduledEndAt: currentBlock?.endAt ?? null,
        calendarSyncStatus: "in_sync",
        calendarSyncUpdatedAt: currentBlock ? new Date().toISOString() : task.calendarSyncUpdatedAt
      };
      this.tasksById.set(task.id, persistedTask);
      return persistedTask;
    });

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
      createdTasks: persistedCreatedTasks,
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
    const task = Array.from(this.tasksById.values()).find((candidate) => candidate.externalCalendarEventId === input.blockId);

    if (task) {
      const updatedTask: StoredTask = {
        ...task,
        lastInboxItemId: input.inboxItemId,
        lifecycleState: "scheduled",
        externalCalendarEventId: input.blockId,
        externalCalendarId: task.externalCalendarId,
        scheduledStartAt: input.newStartAt,
        scheduledEndAt: input.newEndAt,
        calendarSyncStatus: "in_sync",
        calendarSyncUpdatedAt: new Date().toISOString(),
        rescheduleCount: task.rescheduleCount + 1
      };
      this.tasksById.set(task.id, updatedTask);
    }

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
      updatedBlock: {
        id: input.blockId,
        userId: task?.userId ?? inboxItem.userId,
        taskId: task?.id ?? "",
        startAt: input.newStartAt,
        endAt: input.newEndAt,
        confidence: input.confidence,
        reason: input.reason,
        rescheduleCount: (task?.rescheduleCount ?? 0) + 1,
        externalCalendarId: task?.externalCalendarId ?? null
      },
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
    const scheduledTasks: Task[] = [];

    const scheduledBlocks: ScheduleBlock[] = [];

    for (const block of input.scheduleBlocks) {
      const task = this.tasksById.get(block.taskId);

      if (task) {
        const isReschedule =
          task.externalCalendarEventId !== null &&
          task.externalCalendarEventId === block.id &&
          task.scheduledStartAt !== null &&
          task.scheduledEndAt !== null;
        const updatedTask: StoredTask = {
          ...task,
          lastInboxItemId: input.inboxItemId,
          lifecycleState: "scheduled",
          externalCalendarEventId: block.id,
          externalCalendarId: block.externalCalendarId,
          scheduledStartAt: block.startAt,
          scheduledEndAt: block.endAt,
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt: new Date().toISOString(),
          rescheduleCount: isReschedule ? task.rescheduleCount + 1 : task.rescheduleCount
        };
        this.tasksById.set(task.id, updatedTask);
        scheduledTasks.push(updatedTask);
        scheduledBlocks.push({
          ...block,
          taskId: updatedTask.id
        });
      }
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
      scheduleBlocks: scheduledBlocks,
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

  async saveTaskCompletionResult(input: {
    inboxItemId: string;
    confidence: number;
    plannerRun: Omit<PersistedPlannerRun, "id">;
    taskIds: string[];
    followUpMessage: string;
  }): Promise<ProcessedInboxResult> {
    const inboxItem = this.requireInboxItem(input.inboxItemId);
    const completedAt = new Date().toISOString();
    const completedTasks = input.taskIds.flatMap((taskId) => {
      const task = this.tasksById.get(taskId);

      if (!task) {
        return [];
      }

      const updatedTask: StoredTask = {
        ...task,
        lastInboxItemId: input.inboxItemId,
        lifecycleState: "done",
        externalCalendarEventId: null,
        externalCalendarId: null,
        scheduledStartAt: null,
        scheduledEndAt: null,
        calendarSyncStatus: "in_sync",
        calendarSyncUpdatedAt: completedAt,
        completedAt
      };
      this.tasksById.set(task.id, updatedTask);
      return [updatedTask];
    });

    const plannerRun = this.insertPlannerRun(input.plannerRun);
    const updatedInbox = {
      ...inboxItem,
      processingStatus: "planned" as const,
      linkedTaskIds: input.taskIds
    };
    this.inboxItemsById.set(input.inboxItemId, updatedInbox);

    return {
      outcome: "completed_tasks",
      inboxItem: updatedInbox,
      plannerRun,
      completedTasks,
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

  async reconcileTaskCalendarProjection(input: {
    taskId: string;
    externalCalendarEventId: string | null;
    externalCalendarId: string | null;
    scheduledStartAt: string | null;
    scheduledEndAt: string | null;
    calendarSyncStatus: "in_sync" | "out_of_sync";
    calendarSyncUpdatedAt: string;
  }) {
    const existing = this.tasksById.get(input.taskId);

    if (!existing) {
      throw new Error(`Task ${input.taskId} not found.`);
    }

    this.tasksById.set(input.taskId, {
      ...existing,
      externalCalendarEventId: input.externalCalendarEventId,
      externalCalendarId: input.externalCalendarId,
      scheduledStartAt: input.scheduledStartAt,
      scheduledEndAt: input.scheduledEndAt,
      calendarSyncStatus: input.calendarSyncStatus,
      calendarSyncUpdatedAt: input.calendarSyncUpdatedAt
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

    const [taskRows, profileRows] = await Promise.all([
      this.db.select().from(tasks).where(eq(tasks.userId, inboxItem.userId)),
      this.db.select().from(userProfiles).where(eq(userProfiles.userId, inboxItem.userId)).limit(1)
    ]);

    const parsedTasks = taskRows.map((task) => ({
      id: task.id,
      userId: task.userId,
      sourceInboxItemId: task.sourceInboxItemId,
      lastInboxItemId: task.lastInboxItemId,
      title: task.title,
      lifecycleState: task.lifecycleState as Task["lifecycleState"],
      externalCalendarEventId: task.externalCalendarEventId,
      externalCalendarId: task.externalCalendarId,
      scheduledStartAt: task.scheduledStartAt?.toISOString() ?? null,
      scheduledEndAt: task.scheduledEndAt?.toISOString() ?? null,
      calendarSyncStatus: task.calendarSyncStatus as Task["calendarSyncStatus"],
      calendarSyncUpdatedAt: task.calendarSyncUpdatedAt?.toISOString() ?? null,
      rescheduleCount: task.rescheduleCount,
      lastFollowupAt: task.lastFollowupAt?.toISOString() ?? null,
      completedAt: task.completedAt?.toISOString() ?? null,
      archivedAt: task.archivedAt?.toISOString() ?? null,
      priority: task.priority as Task["priority"],
      urgency: task.urgency as Task["urgency"],
      createdAt: task.createdAt.toISOString()
    }));

    return {
      inboxItem: {
        id: inboxItem.id,
        userId: inboxItem.userId,
        sourceEventId: inboxItem.sourceEventId ?? undefined,
        rawText: inboxItem.rawText,
        normalizedText: inboxItem.normalizedText,
        processingStatus: inboxItem.processingStatus as InboxItem["processingStatus"],
        linkedTaskIds: inboxItem.linkedTaskIds,
        createdAt: inboxItem.createdAt.toISOString()
      },
      tasks: parsedTasks,
      scheduleBlocks: buildScheduleBlocksFromTasks(parsedTasks),
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
        : buildDefaultUserProfile(inboxItem.userId),
      googleCalendarConnection: await getDefaultGoogleCalendarConnectionStore().getConnection(inboxItem.userId)
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
            lastInboxItemId: task.lastInboxItemId,
            title: task.title,
            lifecycleState: task.lifecycleState,
            externalCalendarEventId: task.externalCalendarEventId,
            externalCalendarId: task.externalCalendarId,
            scheduledStartAt: task.scheduledStartAt ? new Date(task.scheduledStartAt) : null,
            scheduledEndAt: task.scheduledEndAt ? new Date(task.scheduledEndAt) : null,
            calendarSyncStatus: task.calendarSyncStatus,
            calendarSyncUpdatedAt: task.calendarSyncUpdatedAt ? new Date(task.calendarSyncUpdatedAt) : null,
            rescheduleCount: task.rescheduleCount,
            lastFollowupAt: task.lastFollowupAt ? new Date(task.lastFollowupAt) : null,
            completedAt: task.completedAt ? new Date(task.completedAt) : null,
            archivedAt: task.archivedAt ? new Date(task.archivedAt) : null,
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

      for (const createdTask of createdTasks) {
        const currentBlock = remappedBlocks.find((block) => block.taskId === createdTask.id) ?? null;

        await tx
          .update(tasks)
          .set({
            lifecycleState: currentBlock ? "scheduled" : createdTask.lifecycleState,
            externalCalendarEventId: currentBlock?.id ?? null,
            externalCalendarId: currentBlock?.externalCalendarId ?? null,
            scheduledStartAt: currentBlock?.startAt ? new Date(currentBlock.startAt) : null,
            scheduledEndAt: currentBlock?.endAt ? new Date(currentBlock.endAt) : null,
            calendarSyncStatus: "in_sync",
            calendarSyncUpdatedAt: currentBlock ? new Date() : createdTask.calendarSyncUpdatedAt
          })
          .where(eq(tasks.id, createdTask.id));
      }

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
          lastInboxItemId: task.lastInboxItemId,
          title: task.title,
          lifecycleState: remappedBlocks.some((block) => block.taskId === task.id)
            ? "scheduled"
            : (task.lifecycleState as Task["lifecycleState"]),
          externalCalendarEventId:
            remappedBlocks.find((block) => block.taskId === task.id)?.id ?? task.externalCalendarEventId,
          externalCalendarId:
            remappedBlocks.find((block) => block.taskId === task.id)?.externalCalendarId ?? task.externalCalendarId,
          scheduledStartAt:
            remappedBlocks.find((block) => block.taskId === task.id)?.startAt ??
            task.scheduledStartAt?.toISOString() ??
            null,
          scheduledEndAt:
            remappedBlocks.find((block) => block.taskId === task.id)?.endAt ??
            task.scheduledEndAt?.toISOString() ??
            null,
          calendarSyncStatus: "in_sync",
          calendarSyncUpdatedAt:
            remappedBlocks.find((block) => block.taskId === task.id) !== undefined
              ? new Date().toISOString()
              : task.calendarSyncUpdatedAt?.toISOString() ?? null,
          rescheduleCount: task.rescheduleCount,
          lastFollowupAt: task.lastFollowupAt?.toISOString() ?? null,
          completedAt: task.completedAt?.toISOString() ?? null,
          archivedAt: task.archivedAt?.toISOString() ?? null,
          priority: task.priority as Task["priority"],
          urgency: task.urgency as Task["urgency"],
          createdAt: task.createdAt.toISOString()
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
      const [existingTask] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.externalCalendarEventId, input.blockId))
        .limit(1);

      if (existingTask) {
        await tx
          .update(tasks)
          .set({
            lastInboxItemId: input.inboxItemId,
            lifecycleState: "scheduled",
            externalCalendarEventId: input.blockId,
            externalCalendarId: existingTask.externalCalendarId,
            scheduledStartAt: new Date(input.newStartAt),
            scheduledEndAt: new Date(input.newEndAt),
            calendarSyncStatus: "in_sync",
            calendarSyncUpdatedAt: new Date(),
            rescheduleCount: existingTask.rescheduleCount + 1
          })
          .where(eq(tasks.id, existingTask.id));
      } else {
        throw new Error(`Schedule block ${input.blockId} not found.`);
      }

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
          id: input.blockId,
          userId: existingTask.userId,
          taskId: existingTask.id,
          startAt: input.newStartAt,
          endAt: input.newEndAt,
          confidence: input.confidence,
          reason: input.reason,
          rescheduleCount: existingTask.rescheduleCount + 1,
          externalCalendarId: existingTask.externalCalendarId
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
      const existingTasksRows = input.taskIds.length
        ? await tx.select().from(tasks).where(eq(tasks.userId, inboxItem.userId))
        : [];
      const existingTasksById = new Map(existingTasksRows.map((task) => [task.id, task]));

      for (const block of input.scheduleBlocks) {
        const existingTask = existingTasksById.get(block.taskId);
        const isReschedule =
          existingTask !== undefined &&
          existingTask.externalCalendarEventId !== null &&
          existingTask.externalCalendarEventId === block.id &&
          existingTask.scheduledStartAt !== null &&
          existingTask.scheduledEndAt !== null;
        await tx
          .update(tasks)
          .set({
            lastInboxItemId: input.inboxItemId,
            lifecycleState: "scheduled",
            externalCalendarEventId: block.id,
            externalCalendarId: block.externalCalendarId,
            scheduledStartAt: new Date(block.startAt),
            scheduledEndAt: new Date(block.endAt),
            calendarSyncStatus: "in_sync",
            calendarSyncUpdatedAt: new Date(),
            rescheduleCount: isReschedule
              ? (existingTask?.rescheduleCount ?? 0) + 1
              : (existingTask?.rescheduleCount ?? 0)
          })
          .where(eq(tasks.id, block.taskId));
      }

      const updatedScheduledTasksRows = input.taskIds.length
        ? await tx.select().from(tasks).where(eq(tasks.userId, inboxItem.userId))
        : [];
      const scheduledTasks = updatedScheduledTasksRows
        .filter((task) => input.taskIds.includes(task.id))
        .map((task) => ({
          id: task.id,
          userId: task.userId,
          sourceInboxItemId: task.sourceInboxItemId,
          lastInboxItemId: task.lastInboxItemId,
          title: task.title,
          lifecycleState: task.lifecycleState as Task["lifecycleState"],
          externalCalendarEventId: task.externalCalendarEventId,
          externalCalendarId: task.externalCalendarId,
          scheduledStartAt: task.scheduledStartAt?.toISOString() ?? null,
          scheduledEndAt: task.scheduledEndAt?.toISOString() ?? null,
          calendarSyncStatus: task.calendarSyncStatus as Task["calendarSyncStatus"],
          calendarSyncUpdatedAt: task.calendarSyncUpdatedAt?.toISOString() ?? null,
          rescheduleCount: task.rescheduleCount,
          lastFollowupAt: task.lastFollowupAt?.toISOString() ?? null,
          completedAt: task.completedAt?.toISOString() ?? null,
          archivedAt: task.archivedAt?.toISOString() ?? null,
          priority: task.priority as Task["priority"],
          urgency: task.urgency as Task["urgency"],
          createdAt: task.createdAt.toISOString()
        }));

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

  async saveTaskCompletionResult(input: {
    inboxItemId: string;
    confidence: number;
    plannerRun: Omit<PersistedPlannerRun, "id">;
    taskIds: string[];
    followUpMessage: string;
  }): Promise<ProcessedInboxResult> {
    return this.db.transaction(async (tx) => {
      const inboxItem = await this.loadInboxItemWithin(tx, input.inboxItemId);
      const completedAt = new Date();

      for (const taskId of input.taskIds) {
        await tx
          .update(tasks)
          .set({
            lastInboxItemId: input.inboxItemId,
            lifecycleState: "done",
            externalCalendarEventId: null,
            externalCalendarId: null,
            scheduledStartAt: null,
            scheduledEndAt: null,
            calendarSyncStatus: "in_sync",
            calendarSyncUpdatedAt: completedAt,
            completedAt
          })
          .where(eq(tasks.id, taskId));
      }

      const completedTasksRows = input.taskIds.length
        ? await tx.select().from(tasks).where(eq(tasks.userId, inboxItem.userId))
        : [];
      const completedTasks = completedTasksRows
        .filter((task) => input.taskIds.includes(task.id))
        .map((task) => ({
          id: task.id,
          userId: task.userId,
          sourceInboxItemId: task.sourceInboxItemId,
          lastInboxItemId: task.lastInboxItemId,
          title: task.title,
          lifecycleState: task.lifecycleState as Task["lifecycleState"],
          externalCalendarEventId: task.externalCalendarEventId,
          externalCalendarId: task.externalCalendarId,
          scheduledStartAt: task.scheduledStartAt?.toISOString() ?? null,
          scheduledEndAt: task.scheduledEndAt?.toISOString() ?? null,
          calendarSyncStatus: task.calendarSyncStatus as Task["calendarSyncStatus"],
          calendarSyncUpdatedAt: task.calendarSyncUpdatedAt?.toISOString() ?? null,
          rescheduleCount: task.rescheduleCount,
          lastFollowupAt: task.lastFollowupAt?.toISOString() ?? null,
          completedAt: task.completedAt?.toISOString() ?? null,
          archivedAt: task.archivedAt?.toISOString() ?? null,
          priority: task.priority as Task["priority"],
          urgency: task.urgency as Task["urgency"],
          createdAt: task.createdAt.toISOString()
        }));

      const plannerRun = await this.insertPlannerRunWithin(tx, input.plannerRun);

      await tx
        .update(inboxItems)
        .set({
          processingStatus: "planned",
          linkedTaskIds: input.taskIds
        })
        .where(eq(inboxItems.id, input.inboxItemId));

      return {
        outcome: "completed_tasks",
        inboxItem: {
          ...inboxItem,
          processingStatus: "planned",
          linkedTaskIds: input.taskIds
        },
        plannerRun,
        completedTasks,
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

  async reconcileTaskCalendarProjection(input: {
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
        scheduledStartAt: input.scheduledStartAt ? new Date(input.scheduledStartAt) : null,
        scheduledEndAt: input.scheduledEndAt ? new Date(input.scheduledEndAt) : null,
        calendarSyncStatus: input.calendarSyncStatus,
        calendarSyncUpdatedAt: new Date(input.calendarSyncUpdatedAt)
      })
      .where(eq(tasks.id, input.taskId));
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
      linkedTaskIds: row.linkedTaskIds,
      createdAt: row.createdAt.toISOString()
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
attachGoogleCalendarConnectionStoreToTasks({
  getTasks: () => defaultInMemoryStore.listTasks(),
  replaceTask: (taskId, task) => defaultInMemoryStore.replaceTask(taskId, task)
});
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
