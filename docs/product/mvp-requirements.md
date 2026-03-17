# MVP Requirements

## Summary

The MVP is a conversation-first planning assistant with a strong schedule-forward bias.

Its core loop is:

1. accept messy conversation
2. help clarify or structure the work
3. proactively propose or place time on the schedule when appropriate
4. support lightweight follow-through through reminders and rescheduling

The goal of this version is to prove that Atlas can feel like a useful planning companion, not just a task bot, while still helping the user commit time and act.

## Included In MVP

### 1. Conversational planning interface

- User can send any freeform message to the Telegram bot.
- The system accepts and stores the message without requiring structure, formatting, or immediate follow-up questions.
- The inbox is optimized for capture speed, not clean intake.
- The assistant should support fluid planning conversation, including discussion, prioritization help, reflective planning, and meta questions about how Atlas should be used.
- Not every message should be forced into task extraction or a mutation workflow.
- Each message may represent conversation, task capture, a scheduling request, a schedule adjustment, a follow-up on existing work, or a request for clarification.

### 2. Task and plan extraction when useful

- The system turns a brain-dump message into one or more basic tasks.
- Extraction should handle messy, natural phrasing.
- The system may infer obvious task boundaries from a single message.
- Tasks only need minimal structure in MVP:
  - title or short task text
  - source message
  - optional inferred urgency if clearly stated
- If the message is too ambiguous to safely extract a task, Atlas may stay in conversation mode or leave it as an inbox item without blocking capture.
- Atlas should only extract tasks when doing so is helpful to the user or clearly implied by the conversation.
- Task capture is schedule-forward in MVP: when Atlas identifies actionable work, it should bias toward also proposing or placing that work onto the schedule instead of leaving it open-ended by default.
- A single message may contain both task capture and scheduling intent, such as "submit taxes Friday morning."

### 3. Schedule-forward planning and mutation

- Atlas should proactively suggest scheduled time when conversation surfaces actionable work.
- Extracted tasks should be assigned a simple planned time whenever Atlas can do so safely.
- Scheduling is allowed to be basic and rule-driven rather than smart.
- MVP scheduling may use simple user-defined availability or a minimal default schedule.
- The system should treat the connected external calendar as the canonical source of scheduled time.
- The scheduler does not need to optimize deeply for workload, energy, context, or productivity patterns.
- The user may also send follow-up scheduling requests or schedule adjustments in Telegram, and the system should resolve those requests from persisted Atlas state rather than broad recent-chat inference.
- Atlas may answer conversational planning turns without taking any side effects, but when it does schedule or reschedule work, those mutations should remain safe and explainable.
- Atlas may offer smarter conversational rearrangement proposals, but broader schedule rewrites should require explicit confirmation rather than being applied automatically.

### 4. Lightweight reminders and follow-through

- The system sends Telegram reminders for scheduled tasks.
- Reminder behavior should be basic and predictable, not highly adaptive.
- A scheduled task should support at least one reminder before or at its planned time.
- Reminder messaging should focus on prompting action, not coaching or replanning.
- After a scheduled task's block ends, Atlas should send a follow-up asking whether it was completed.
- If the first follow-up goes unanswered, Atlas should send one additional reminder 2 hours later.
- If the user still does not respond, the task remains unresolved in `awaiting_followup` until the user completes, reschedules, or archives it.
- Atlas may support lightweight follow-up conversation around missed or delayed work, but full adaptive replanning is deferred.

## Explicitly Excluded From MVP

- Adaptive task breakdown or subtasks
- User-tunable breakdown intensity
- Smart scheduling heuristics
- Automatic rescheduling of overdue or missed work without user involvement
- Executive-assistant style task ordering
- Email reminders
- Mobile app
- Rich personalization beyond minimal scheduling settings
- Advanced behavioral psychology features beyond simple reminder timing

## Product Rules

- Capture must never be blocked by the system trying to be clever.
- Conversation quality matters as much as extraction quality.
- Atlas should optimize for structuring time, not accumulating unscheduled backlog.
- Atlas should feel like a planning assistant first and a mutation engine second.
- Atlas should be schedule-forward: when work is actionable, it should bias toward proposing or placing time on the schedule.
- Scheduling in MVP is allowed to be simple, manual-feeling, and limited, as long as it works consistently.
- Conversational scheduling must stay anchored to persisted tasks, explicit schedule linkage, and planner state rather than implicit chat-history memory.
- Atlas should be able to answer meta questions about how it should be used without forcing those turns through task extraction.
- Reminder functionality should be straightforward and understandable rather than adaptive.
- Every Atlas task should immediately seek scheduled time; unscheduled backlog is not the normal operating model.
- Every scheduled task should receive follow-up after its block ends.
- `awaiting_followup` should begin only after Atlas has actually issued the first follow-up nudge for that task.
- If the user did not complete a task, Atlas should not allow passive skipping; it should steer the user toward rescheduling or archiving.
- If a feature introduces ambiguity, hidden autonomy, or product sprawl, it should be deferred rather than squeezed into MVP.

## Acceptance Criteria

- A user can send a messy message in Telegram and have it saved successfully every time.
- The assistant can respond usefully to a planning conversation even when no task or schedule mutation is needed.
- A non-trivial portion of brain-dump messages produce usable tasks or concrete planning suggestions without manual cleanup.
- When actionable work is identified, the default path should attempt to propose or apply a scheduled time automatically when safe.
- The user receives a Telegram reminder tied to that scheduled task.
- After a scheduled block ends, Atlas can follow up, keep one unresolved task in `awaiting_followup`, and let the user resolve it by completing, rescheduling, or archiving it.
- The full loop works without requiring subtasks or advanced autonomous replanning.

## Deferred Beyond MVP

- Adaptive task breakdown
- Smart scheduling
- Richer automatic rescheduling of overdue or missed items
