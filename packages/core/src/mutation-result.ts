import type { ScheduleBlock, Task } from "./index";

export type MutationResult =
  | {
      outcome: "created";
      tasks: Task[];
      scheduleBlocks: ScheduleBlock[];
      followUpMessage: string;
    }
  | {
      outcome: "scheduled";
      tasks: Task[];
      scheduleBlocks: ScheduleBlock[];
      followUpMessage: string;
    }
  | {
      outcome: "rescheduled";
      updatedBlock: ScheduleBlock;
      followUpMessage: string;
    }
  | {
      outcome: "completed";
      tasks: Task[];
      followUpMessage: string;
    }
  | {
      outcome: "archived";
      tasks: Task[];
      followUpMessage: string;
    }
  | {
      outcome: "needs_clarification";
      reason: string;
      followUpMessage: string;
    };
