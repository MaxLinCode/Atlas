# MVP Requirements

## Summary

The MVP is a narrow Telegram-first product with four core functions only:

1. Telegram inbox
2. Task extraction
3. Simple scheduling
4. Simple nag reminders

The goal of this version is to prove the core loop: dump thoughts into Telegram, get usable tasks created, have those tasks placed onto a simple schedule, and receive reminders to act.

## Included In MVP

### 1. Telegram inbox

- User can send any freeform message to the Telegram bot.
- The system accepts and stores the message without requiring structure, formatting, or immediate follow-up questions.
- The inbox is optimized for capture speed, not clean intake.
- Each message is treated as canonical captured input that may represent task capture, a scheduling request, a schedule adjustment, or an unclear request that needs clarification.

### 2. Task extraction

- The system turns a brain-dump message into one or more basic tasks.
- Extraction should handle messy, natural phrasing.
- The system may infer obvious task boundaries from a single message.
- Tasks only need minimal structure in MVP:
  - title or short task text
  - source message
  - optional inferred urgency if clearly stated
- If the message is too ambiguous to safely extract a task, it may remain an inbox item without blocking capture.
- Task capture is schedule-forward in MVP: when Atlas can safely extract a task, it should also try to place that task onto the internal schedule instead of leaving it open-ended by default.
- A single message may contain both task capture and scheduling intent, such as "submit taxes Friday morning."

### 3. Simple scheduling

- Extracted tasks should be assigned a simple planned time whenever Atlas can do so safely.
- Scheduling is allowed to be basic and rule-driven rather than smart.
- MVP scheduling may use simple user-defined availability or a minimal default schedule.
- The system only needs to place tasks onto an internal schedule; no external calendar sync is required.
- The scheduler does not need to optimize deeply for workload, energy, context, or productivity patterns.
- The user may also send follow-up scheduling requests or schedule adjustments in Telegram, and the system should resolve those requests from persisted Atlas state rather than broad recent-chat inference.

### 4. Simple nag reminders

- The system sends Telegram reminders for scheduled tasks.
- Reminder behavior should be basic and predictable, not highly adaptive.
- A scheduled task should support at least one reminder before or at its planned time.
- Reminder messaging should focus on prompting action, not coaching or replanning.

## Explicitly Excluded From MVP

- Adaptive task breakdown or subtasks
- User-tunable breakdown intensity
- Smart scheduling heuristics
- Automatic rescheduling of overdue or missed work
- "What should I do next?" assistant behavior
- Executive-assistant style task ordering
- Google Calendar integration
- Email reminders
- Mobile app
- Rich personalization beyond minimal scheduling settings
- Advanced behavioral psychology features beyond simple reminder timing

## Product Rules

- Capture must never be blocked by the system trying to be clever.
- Extraction quality matters more than post-capture conversation.
- Atlas should optimize for structuring time, not accumulating unscheduled backlog.
- Scheduling in MVP is allowed to be simple, manual-feeling, and limited, as long as it works consistently.
- Conversational scheduling must stay anchored to persisted tasks, schedule blocks, and planner state rather than implicit chat-history memory.
- Reminder functionality should be straightforward and understandable rather than adaptive.
- If a feature introduces ambiguity, hidden autonomy, or product sprawl, it should be deferred rather than squeezed into MVP.

## Acceptance Criteria

- A user can send a messy message in Telegram and have it saved successfully every time.
- A non-trivial portion of brain-dump messages produce usable tasks without manual cleanup.
- A created task can be assigned a scheduled time in the product, and the default path should attempt that scheduling automatically when safe.
- The user receives a Telegram reminder tied to that scheduled task.
- The full loop works without requiring calendar integration, subtasks, or advanced replanning.

## Deferred Beyond MVP

- Adaptive task breakdown
- Smart scheduling
- Rescheduling of overdue or missed items
- "What's next" guidance
