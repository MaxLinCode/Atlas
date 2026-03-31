# Current Work
REMOVE: pr smoke test
## Active focus

Atlas is a schedule-forward, Google-calendar-gated product with a working mutation pipeline.
Current implementation focus: replace transcript-heavy conversation memory with an explicit conversation-state layer. Atlas now persists a user-scoped conversation snapshot with transcript, summary, entity registry, and discourse state so reference resolution can anchor on known objects instead of reconstructing intent from recent turns alone. Recent work still includes the prompt-asset cleanup, expanded live eval coverage around ambiguous routing and confirmed-mutation recovery, a consolidated `pnpm eval:all` loop plus suite-specific eval reports and prompt-improvement briefs for prompt iteration, chat-first prompt/docs framing, and consistent `referenceTime` threading through scheduling.
The turn-routing pipeline now uses a unified write-interpretation stage for write-capable turns: `classifyTurn -> interpretWriteTurn -> writeCommit -> decideTurnPolicy`. The old router-owned pre-gating around slot extraction is retired from the active path.

DB rollout hardening is now part of the active release path: `packages/db` owns all Drizzle commands and config, root-level DB command aliases are removed, and production migrations are expected to run from GitHub Actions before Vercel production release.

## Near-term milestones

- Finish the prompt-asset cleanup and eval loop:
  - keep each model prompt scoped to one job with explicit sections and output requirements
  - expand live eval fixtures around ambiguous referents, vague confirmations, and partial scheduling requests
  - use eval results to drive prompt revisions before considering model upgrades
- Harden the new conversation-state layer:
  - keep transcript strictly for replay/continuity, not exact object memory
  - expand entity-registry coverage for proposal options, reminders, clarifications, and mutation results
  - improve discourse-state updates so follow-up pronouns and contrastive phrases like `the other one` resolve against the focused entity set
  - thread explicit entity/discourse context through the remaining recovery and follow-up paths
- Preserve deterministic time handling across mutation mode:
  - keep planner interpretation, schedule generation, move logic, and busy-period lookup anchored to `referenceTime`
  - continue removing remaining wall-clock assumptions from scheduling paths and tests
- Carry the chat-first framing through remaining docs and app copy where the behavior is generic rather than transport-specific
- Harden Google Calendar integration for launch review:
  - validate the new one-time `/google-calendar/connect` handoff and short-lived link-session flow in real deployment
  - finish disconnect UX and revoked-account operator visibility
  - tighten reconciliation observability and out-of-sync task handling
  - preserve the no-implicit-fallback rule: runtime scheduling requires a linked Google calendar, while in-memory calendar use stays test-only
  - split the app-owned Google Calendar service by responsibility:
    - link flow and session handling
    - runtime adapter resolution and token refresh
    - reconciliation and drift handling
  - split the Telegram webhook lazy-link gate and outbound gate replies away from the inbox-linked follow-up delivery path
  - detailed execution plan: `docs/workflows/google-calendar-delivery.md`
  - authority and sync ADR: `docs/decisions/0007-google-calendar-authority-and-sync.md`
  - security hardening ADR: `docs/decisions/0008-security-lockdown-and-google-oauth-handoff.md`
- Plan and execute a security hardening pass before any public bot exposure:
  - keep only the minimal external surface: Telegram webhook, Google connect/OAuth routes, and protected cron endpoints
  - maintain the new secret-domain split across webhook, cron, Google handoff, and token encryption
  - enforce encrypted-at-rest Google credentials and redacted linked-account reads
  - define retention and operator-access policy for `bot_events`, `planner_runs`, OAuth states, handoffs, and link sessions
  - rate limits and usage caps to protect OpenAI spend and integration quotas
  - logging, redaction, and admin-surface review to reduce PII exposure
- Tighten outbound Telegram delivery reliability and error observability.
- Thread clarification handling through persisted inbox, planner-run, task, and schedule state so reply messages can resume processing safely.
- Back the admin inbox, planner-runs, and schedule pages with real repository data.
- Define the next data model around task-centric current commitment plus future task history.
- Add the task-level schema and repository support needed for the locked follow-up runtime, including `followup_reminder_sent_at`.
- Implement the background follow-up/reminder dispatch path, turn-boundary drain, and per-user locking against the locked runtime semantics.
- Fix cron follow-up idempotency so concurrent runners cannot send duplicate bundles for the same unresolved task set; repeated reminder eligibility should come from task state transitions rather than timestamp-salted delivery keys.
- Fix webhook follow-up continuation dedupe to compare normalized unresolved bundle membership instead of order-sensitive task-id sequences built from different sort rules.
- Expand integration coverage for follow-up, reminder, late-reply, and reschedule flows under the locked runtime rules.
- Future work: widen the deterministic follow-up reply gate to accept more natural phrasings without reintroducing mixed-intent shortcut hijacking.
- Design the dedicated commitment/history model that eventually replaces planner-facing `schedule_block` aliases.
- Clean up the remaining `schedule_block` compatibility layer and complete the task-first repository design:
  - remove planner/runtime dependence on `schedule_block_*` aliases for existing-item reschedules and move mutations
  - replace `move_schedule_block` with a task/current-commitment-first mutation contract
  - make repository reads and writes treat `tasks` as the only live scheduling source of truth, with any schedule-block-shaped data derived as compatibility output only until the contract is removed
  - once planner contracts, runtime handlers, and tests no longer depend on `schedule_blocks`, drop the table and its remaining migration/test scaffolding
- Expand Postgres integration coverage for ambiguous scheduling cases, clarification flows, and outbound reply loops.
- Preserve safe scheduling and rescheduling over explicit state boundaries in mutation mode.
- TODO: fix scheduler handling for explicit narrow time blocks so requests like `11:05` to `11:09` preserve the requested duration instead of defaulting to the profile focus block.
- TODO: remove `schedule_blocks` once planner/runtime contracts, repositories, migrations, and tests are fully task-first.
- TODO: fix multi-task schedule proposal generation so newly proposed inserts are considered during the same batch and Atlas cannot emit overlapping new blocks when scheduling more than one open task.
- TODO: when a user asks for an explicit time that is already in the past, clarify that the requested time has already passed instead of silently placing it in the past or rolling it forward.

## Handoff notes

- Atlas should be a planning assistant first and a mutation engine second, but in v1 chat-bot use is gated behind an active Google Calendar connection.
- Schedule-forward remains a core product opinion: when work becomes actionable, Atlas should bias toward proposing or placing time on the schedule.
- The emerging direction is external-calendar-backed scheduling with Atlas retaining task and accountability ownership.
- Real Google Calendar integration is now landed in the main mutation path, including OAuth linkage, real event writes, busy-time-aware scheduling inputs, and bounded reconciliation.
- The remaining product-critical step is hardening the linked-calendar path before broader exposure: Atlas must not allow unauthorized users to spend OpenAI credits, access private planning history, or interact with linked private calendars.
- The Telegram allowlist gate is now real and is enough for immediate locked-down private use before the full security hardening pass; boot now fails when `TELEGRAM_ALLOWED_USER_IDS` is missing. It is still not a substitute for proper authz once admin surfaces and calendar linkage matter.
- Every Atlas task should seek scheduled time immediately; unscheduled backlog should not be the default operating model.
- Every scheduled task should receive follow-up after the scheduled block ends, and `awaiting_followup` is now a key lifecycle concept.
- `awaiting_followup` should begin only after the scheduled block has ended and Atlas has issued a follow-up nudge for that task.
- The first follow-up should go out immediately after block end unless Atlas is in the middle of an active conversational turn, in which case it should wait for the turn boundary.
- If the first follow-up goes unanswered, Atlas should send one additional reminder 2 hours later, then leave the task unresolved in `awaiting_followup`.
- If multiple tasks are overdue, Atlas should surface them one by one, oldest unresolved first.
- If an unresolved follow-up exists and the user sends a brand-new request, Atlas should handle the new request first, then circle back to the oldest unresolved follow-up.
- If the user says they did not complete the task, Atlas should not allow passive skipping; it should steer toward rescheduling or archiving.
- The current branch landed the lean external-calendar-backed task model:
  - live scheduled commitment is now stored directly on `tasks`
  - `schedule_blocks` are no longer the active persisted runtime schedule record
  - planner-facing `schedule_block_*` aliases are reconstructed from task state for compatibility
- Phase 2 of the turn-routing refactor is now landed:
  - write-capable turns use one interpretation call instead of a separate slot-extractor pass
  - commit derives required fields from `operationKind` and commits grouped field paths
  - classifier-owned entity resolution is intentionally still in place for now; moving that to the interpretation stage remains Phase 3 work
- Webhook ingress is idempotent and persists canonical `inbox_items` before any planner mutation for linked users.
- Unlinked allowlisted Telegram users are now short-circuited before ingress persistence with a signed Google connect reply. Atlas does not keep stale pre-link messages in v1.
- Telegram webhook ingress is now protected by a required `TELEGRAM_ALLOWED_USER_IDS` allowlist; blocked users are rejected before inbox persistence, planning, or outbound delivery, and app config fails fast when that env var is missing.
- `apps/web` should own orchestration for both conversation mode and mutation mode; `packages/core` should keep schemas and deterministic scheduling helpers for mutation mode; `packages/integrations` should own model and Telegram transport; `packages/db` should keep canonical persistence and audit state.
- For pure conversation or simple new-capture turns, Atlas likely does not need to load the full task and schedule graph.
- Conversation mode may use recent transcript plus relevant state, but conversational scheduling and existing-work mutations must still resolve from explicit Atlas state. Do not rely on broad recent chat history as canonical memory.
- Existing-task mutation turns need a narrow app-owned task candidate matching step before confirmed-mutation recovery or planner application when the user names a task informally, such as `journal` for `Journaling session`.
- Keep that candidate matching deterministic and small-scope:
  - build candidates from persisted non-archived tasks, not summaries
  - prefer exact and near-exact title/token matches from the latest user turn
  - use recent task context only as a tiebreaker, not as primary identity
  - if there is one strong match, bind that task explicitly; if there are multiple plausible matches, ask a clarification
- Compound mutation flow still needs refinement:
  - for now, mixed planner outputs that combine `complete_task` with `create_task` are rejected rather than partially applied
  - future work should define when explicit multi-write turns such as `journal is done, make a new coding task` may safely combine completion with new capture or scheduling
  - that refinement should be validation-driven and task-centric, not a silent app-owned reducer over ambiguous mixed action sets
- The next clarification-rendering slice should be source-based rather than string-pattern-based:
  - planner `clarify` outputs should pass through their user-facing text directly
  - confirmed-mutation recovery `needs_clarification` should pass through `userReplyMessage` directly
  - app/runtime validation or execution failures should keep an internal audit `reason` but render user-facing clarification from app-owned safe copy
  - result contracts should eventually separate internal `reason` from optional user-facing `userMessage` so renderers never need to infer which strings are safe
- Confirmed-mutation recovery currently reconstructs one synthesized write-ready `recoveredText` plus a separate `userReplyMessage`; the recovery output is model-facing and must stay distinct from persisted inbox capture text.
- The confirmed-mutation path should keep reusing the normal mutation planner via `planningInboxTextOverride.text` rather than introducing a second planner contract for short confirmation turns.
- The current runtime now stores live scheduled commitment fields directly on `tasks`: `external_calendar_event_id`, `external_calendar_id`, `scheduled_start_at`, and `scheduled_end_at`.
- The lean follow-up seam should stay on the task row, not in transport history:
  - `last_followup_at`: the most recent outbound accountability follow-up Atlas successfully sent for the task
  - `followup_reminder_sent_at`: the timestamp when Atlas sent the one extra reminder for the current unresolved follow-up episode
- `schedule_blocks` no longer act as the active persisted scheduling record for runtime reads and writes. They remain a transitional artifact in the repo and planner vocabulary while the dedicated commitment/history design is still deferred.
- Remaining cleanup gap: move/reschedule behavior still routes through planner-facing `schedule_block` aliases even though live scheduled state now lives on `tasks`; this should be collapsed into a task-first repository and mutation contract before `schedule_blocks` can be removed cleanly.
- The task row now owns lifecycle state, current commitment snapshot, task-level `reschedule_count`, follow-up timestamps, and inbox provenance directly.
- `0006_external_calendar_task_fields.sql` now backfills scheduled tasks from the old `current_commitment_id -> schedule_blocks` linkage before dropping the transitional column.
- Inbox processing now treats calendar create/update failures like planner failures:
  - failed planner run is recorded
  - inbox item returns to `received`
  - partial scheduled task state is not persisted
- Runtime scheduling and move flows no longer silently fall back to the in-memory calendar adapter. If no linked Google calendar is available, Atlas clarifies instead. The in-memory adapter is now an explicit test seam only.
- Google account linking no longer binds Atlas user identity to a bearer token on the public OAuth-start URL:
  - Telegram now issues a one-time `/google-calendar/connect` handoff token signed with `GOOGLE_LINK_TOKEN_SECRET`
  - the connect route consumes that handoff, creates a short-lived server-side link session, sets an `HttpOnly` cookie, and redirects to OAuth start
  - OAuth start derives the Atlas user from that link session only
- New Google links now target a dedicated Google calendar for Atlas-managed scheduling:
  - if a writable calendar named `Atlas` already exists, Atlas links to it
  - otherwise Atlas creates a new Google calendar named `Atlas` during OAuth callback and stores that as `selected_calendar_id` / `selected_calendar_name`
  - Atlas must not silently fall back to the primary or another writable calendar for new links; if dedicated-calendar creation fails, linking should fail
- Google access and refresh tokens are now encrypted at rest with `GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY`, and normal linked-account reads expose redacted metadata only.
- Test-store parity follow-up:
  - the in-memory Google Calendar connection store still keeps plaintext access and refresh tokens for tests, while the Postgres store encrypts them at rest
  - this is not a production exposure, but it weakens storage-path parity and could hide encryption/regression bugs in tests
  - follow-up: make the in-memory store use the same encrypt-on-write and decrypt-on-credential-read behavior as the Postgres store while preserving redacted non-credential reads
- The public planner/debug mutation routes have been removed. The only intended external app surfaces are:
  - `POST /api/telegram/webhook`
  - `GET /google-calendar/connect`
  - `GET /api/google-calendar/oauth/start`
  - `GET /api/google-calendar/oauth/callback`
  - protected cron routes that require `Authorization: Bearer $CRON_SECRET`
- In-memory and Postgres processing stores now return equivalent write-time `scheduleBlocks` payloads, including planner-provided `reason` and `confidence`.
- `planner_runs` should remain an operational audit trail, but they do not need to become the main product memory layer.
- Symbolic aliases are still important for existing-item mutations, but they are likely unnecessary overhead for simple new-task capture.
- The webhook no longer seeds test-only in-memory processing state. Tests must inject in-memory stores and explicit priming when they want to exercise the handler without Postgres.
- The webhook now attempts outbound Telegram follow-up delivery for planner outcomes, retries once inline on transport failure, and records outgoing transport events in `bot_events`.
- The lazy-link gate no longer pollutes normal recent-turn conversation context:
  - pre-link Google connect replies now use their own bot-event type
  - conversation-history reads explicitly exclude both the new gate event type and legacy persisted gate-copy text
- The current lazy-link gate still intentionally reuses webhook delivery plumbing, but the next cleanup pass should split generic gate replies from inbox-linked follow-up delivery so transport persistence and redaction rules stay explicit.
- Calendar write observability is now present at the app scheduling boundary:
  - `process-inbox-item` logs structured `calendar_write_attempt`, `calendar_write_succeeded`, and `calendar_write_failed` events
  - these logs include user/task ids, calendar ids, event ids when known, scheduled timestamps, and redacted error summaries only
- The app now clarifies instead of applying unsafe planner outputs for:
  - `clarify` mixed with mutating actions
  - unsupported mixes of move and create actions
  - unresolved symbolic aliases
  - duplicate schedule actions for the same existing task
- Verification completed on this branch:
  - `pnpm typecheck`
  - `pnpm test` except for the Postgres-backed integration package, which remains blocked in this environment by local `5432` connection restrictions
  - `pnpm eval:planner`
  - `pnpm eval:turn-router`
  - `pnpm eval:router-confirmation`
  - `pnpm eval:conversation-context`
  - `pnpm eval:confirmed-mutation-recovery`
- Prompt/runtime work completed on this branch:
  - OpenAI prompts now live in `packages/integrations/src/prompts` as explicit per-role prompt assets instead of one dense file-local string block
  - planner, router, conversation, memory-summary, and confirmed-mutation-recovery prompts now have expanded failure-boundary examples and tighter output-shape guidance
  - confirmed-mutation recovery now uses a permissive response-format schema plus a stricter runtime discriminated-union parse
  - schedule actions may now delegate slot choice with `scheduleConstraint: null`, and broad-but-usable timing like `morning but not too early` should map to schedulable intent instead of forcing exact-time clarification
  - scheduling now uses inbox-item `createdAt` / `referenceTime` consistently in planner context, schedule computation, move handling, and busy-calendar lookup
  - Postgres ingress persistence now preserves caller-supplied `createdAt`, keeping deterministic scheduling tests aligned across in-memory and Postgres stores
- Verification completed on this branch:
  - `pnpm --filter @atlas/core typecheck`
  - `pnpm --filter @atlas/db typecheck`
  - `pnpm --filter @atlas/web typecheck`
  - `pnpm --filter @atlas/integration-tests typecheck`
  - `pnpm --filter @atlas/core test`
  - `pnpm --filter @atlas/db test`
  - `pnpm --filter @atlas/web test`
  - `pnpm --filter @atlas/integrations test`
  - `pnpm --filter @atlas/integration-tests test`
  - `pnpm --filter @atlas/integrations typecheck`
  - `pnpm --filter @atlas/integrations test -- src/index.test.ts`
  - `pnpm --filter @atlas/web test -- src/lib/server/google-calendar.test.ts`
  - `pnpm --filter @atlas/web test -- src/lib/server/process-inbox-item.test.ts`
  - `pnpm --filter @atlas/web test -- src/app/api/telegram/webhook/route.test.ts`
  - `pnpm --filter @atlas/db test -- src/index.test.ts`
- The core follow-up and reschedule runtime semantics are now locked in docs. Remaining implementation work should follow those contracts rather than reopening the model.
- The conversational model behavior is now documented as a separate two-path architecture. Remaining work should implement that design incrementally instead of trying to ship a full conversational bot in one slice.
- The first `TurnRouter` slice is now landed:
  - routing is app-owned in `apps/web`
- inbound chat turns now pass through two explicit app-owned stages:
  - `interpretation`: classify the turn as informational, planning/edit intent, clarification answer, confirmation, follow-up reply, or unknown using message text plus persisted conversation state only
  - `policy`: decide whether to `reply_only`, `ask_clarification`, `present_proposal`, `execute_mutation`, or `recover_and_execute`
  - ingress is still persisted canonically before interpretation and policy selection
  - legacy route names are now compatibility-only response shapes at the webhook boundary and are not semantic inputs to interpretation or policy
- Native turn interpretation and policy now own write readiness:
  - clear, fully specified scheduling and edit requests should execute directly
  - missing slots, unresolved references, and blocking clarifications should ask for clarification
  - proposal-first behavior should only happen for explicit confirmation-required product rules
- A live local turn-router eval harness is now available:
  - `pnpm eval:turn-router` calls the real OpenAI Responses API against a curated fixture set
  - this is intended for manual prompt verification, not deterministic CI coverage
- A live local planner eval harness is now available:
  - `pnpm eval:planner` calls the real OpenAI Responses API against curated planner timing fixtures
  - this is intended for manual prompt verification of schedule normalization behavior, not deterministic CI coverage
- A live local router-confirmation eval harness is now available:
  - `pnpm eval:router-confirmation` calls the real OpenAI Responses API against curated short-horizon confirmation fixtures
  - this is intended for manual prompt verification of `confirmed_mutation` behavior, not deterministic CI coverage
- A live local confirmed-mutation recovery eval harness is now available:
  - `pnpm eval:confirmed-mutation-recovery` calls the real OpenAI Responses API against curated recovery fixtures for short-horizon confirmation and completion recovery
  - this is intended for manual prompt verification of recovery output quality, not deterministic CI coverage
- A live local conversation-context eval harness is now available:
  - `pnpm eval:conversation-context` calls the real OpenAI Responses API against curated recent-turn continuity fixtures
  - this is intended for manual prompt verification of context use and hedged conversation behavior, not deterministic CI coverage
- `primeProcessingStore` is now effectively mutation-only webhook plumbing. Conversational turns should not seed mutation-processing state.
- The first conversation-response slice is now landed:
  - non-writing routed turns now go through an app-owned `conversation-response` service
  - the conversation service is model-assisted through `packages/integrations`
  - `conversation` now returns a natural-language planning reply instead of temporary fallback copy
  - `conversation_then_mutation` now returns a natural-language discuss-first reply instead of temporary fallback copy
  - the conversation path still does not write task or schedule state
  - the conversation path must not claim that side effects happened
- The main limitation in conversation mode is now context grounding:
- the conversation path now loads a bounded recent-turn window from persisted messaging transport records before routing, while summaries are only generated when they add value for continuity or clarification rather than by default
- it derives a request-scoped working summary for conversational continuity on non-writing turns only when the recent transcript or ambiguity makes it helpful
- this continuity layer is intentionally non-authoritative and must not be treated as canonical Atlas memory or mutation state
- The conversation response path remains app-owned:
  - `apps/web` assembles ephemeral conversation context for `conversation` and `conversation_then_mutation`
  - `packages/integrations` owns the summary and conversation model calls
  - `packages/db` owns the read model for recent persisted turns
- Mixed-turn confirmation handling is now landed in a native app-owned form:
  - confirmation requires one recoverable active proposal in state
  - `apps/web` recovers a write-ready mutation request from recent context and reuses the existing structured mutation path
  - ambiguous confirmations still stay non-writing and ask for clarification
- Proposal and clarification state are now persisted as explicit conversation entities so confirmation recovery and clarification handling can inspect working state rather than depending only on raw transcript.
- The webhook now logs debug-friendly routing trace points for interpretation, policy, execution branch, and confirmation recovery outcome.
- Routing ownership is now aligned to the intended architecture:
  - `apps/web` owns routing orchestration and route application
  - `packages/core` owns routing and confirmation-recovery product contracts
  - `packages/integrations` owns OpenAI transport, prompts, and parsing against those core-owned contracts
- Mutation replies should be rendered from actual persisted outcome, not from pre-execution planner prose:
  - write-capable planner outputs should stop carrying a mutation `userReplyMessage`
  - the app should execute the mutation first, then render the user-facing reply from `ProcessedInboxResult` and persisted task/schedule state
  - that reply path should be able to mention the real scheduled time, whether Atlas created or updated a calendar event, and other concrete outcome details
- That mutation-reply slice is now landed in app-owned form:
  - write-capable planner outputs no longer carry `userReplyMessage`
  - `apps/web` now renders mutation follow-up replies from persisted `ProcessedInboxResult` data after the write succeeds
  - confirmed-mutation recovery still carries `userReplyMessage` for non-writing clarification replies only
  - follow-up UX pending: add a lightweight timezone UX so Atlas can surface, confirm, and override the inferred scheduling timezone when needed
  - landed follow-up: scheduling and mutation reply rendering now use the user timezone rather than a temporary app-default timezone
- Verification completed on this branch:
  - `pnpm typecheck`
  - `pnpm --filter @atlas/core test`
  - `pnpm --filter @atlas/web test`
  - `pnpm --filter @atlas/integrations test`
  - `pnpm eval:conversation-context`
  - `pnpm eval:router-confirmation`
  - `pnpm eval:turn-router`
- Additional verification attempted:
  - `pnpm test` currently fails only because the existing Postgres-backed integration suite cannot connect to local Postgres in this environment (`EPERM` to `127.0.0.1:5432` / `::1:5432`)
  - `pnpm --filter @atlas/integration-tests test` fails for the same environment reason

## Next Handoff

PR #53 (`codex/turn-routing-refactor`) implements the 3-layer turn routing pipeline (classify → extract → commit). The 4 multi-turn loop bugs are fixed. A code review surfaced the following issues to address before merge:

### Medium — fix before merge

1. **Slot extraction is gated on `pending_write_contract` being truthy** (`turn-router.ts:53-55`), not just on turn type. The first planning request in a conversation (before any contract is set) skips extraction entirely. `DEFAULT_CONTRACT` is defined but only used for `applyCommitPolicy`. This may cause the initial "schedule gym tomorrow at 6pm" to get no extracted slots. Decide whether this is intentional or whether extraction should run against `DEFAULT_CONTRACT` when no contract exists.

### Low — address in follow-up

2. **`resolved_slots` is `.optional()` in the discourse state schema** but `createEmptyDiscourseState` always initializes it to `{}`. Defensive `?? {}` fallbacks are scattered throughout. Make it required in the schema.

3. **Nullable confidence types in schema vs non-nullable in policy.** `slotConfidenceSchema` uses `.nullable().optional()` per slot but `CommitPolicyInput` types confidence as `Partial<Record<SlotKey, number>>`. The `compactConfidence` bridge function handles the mismatch, but the schema should be non-nullable to match.

4. **`TurnTrace` and `_provenance` from the spec are not implemented.** The observability and provenance section calls for fire-and-forget turn traces and a provenance map on `ResolvedSlots`. These may be intentionally deferred but should be tracked.

5. **No integration test for multi-turn slot accumulation.** Commit policy tests verify slot preservation in isolation, but no test exercises the full path where `committedSlots` are persisted through `conversation-state.ts` and used as `priorResolvedSlots` in a subsequent turn.

6. **`deriveParameterFingerprint` regex** (`\b\d{1,2}(?::\d{2})?\s?(?:am|pm)?\b`) matches bare numbers like "3" in any context, which may trigger unnecessary re-consent in proposal compatibility checks.

### Recommended merge sequence

1. Address item 1 on the existing branch if needed
2. Run `pnpm typecheck && pnpm --filter @atlas/core test && pnpm --filter @atlas/web test`
3. Merge PR #53
4. Open follow-up issue for items 2–6

### Follow-up — clarification state cleanup (separate PR)

The stale-slot-readiness fix revealed further simplification opportunities in the clarification persistence model:

1. **`blocking` field on `PendingClarification` is dead weight.** It is hardcoded to `true` everywhere — never set to `false`. The only reader is `deriveMode()`, which checks `hasBlockingClarification` to return `"clarifying"` mode. The field can be removed and `deriveMode` can derive "clarifying" from `pending_write_contract` + `resolved_slots` (contract gaps) instead.

2. **Resolved/cancelled clarifications accumulate as noise.** `getActivePendingClarifications()` filters to `status === "pending"`, so resolved entries just grow the array. No code inspects resolved entries for decisions. They could be pruned on state update or moved to a separate audit trail.

3. **Full `pending_clarifications` array (including resolved entries) is passed to the LLM classifier.** The system prompt says "active clarifications the assistant is waiting on" but the data includes stale resolved entries. This could mislead the model into thinking there are still open questions. Fix: filter to `status === "pending"` before passing to the classifier, or pass only `getActivePendingClarifications()`.

4. **`deriveMode` could derive "clarifying" from canonical slot state.** Instead of checking `hasBlockingClarification` (which depends on persisted clarification entities), check whether `pending_write_contract` exists and has unresolved required slots in `resolved_slots`. This aligns mode derivation with the same canonical source of truth used for routing.

5. **`getActivePendingClarifications` remains needed** for reference resolution (disambiguating pronouns when there's a single active clarification for an entity) and state transitions (marking clarifications as resolved). It is no longer needed for routing decisions after the stale-slot-readiness fix.

### After merge — next priorities

- Stabilize the planner contract and prompt iteration loop using `pnpm eval:planner` and `pnpm eval:all` as the gating loop
- Return to locked-down Google Calendar production-readiness work:
  - validate the Telegram-to-browser Google link handoff in a real deployed environment
  - finish disconnect/revocation UX and operator visibility for linked accounts
  - decide and implement retention jobs for `bot_events` and `planner_runs`
  - add abuse controls and rate limiting around the remaining public surfaces
  - refactor `telegram-webhook.ts` so pre-ingress Google-link gating is a small app-layer helper
  - split `google-calendar.ts` into narrower app services
  - separate pre-ingress lazy-link replies from inbox-linked follow-up delivery semantics

### Locked runtime semantics

- `last_followup_at` is task-scoped, not scheduled-occurrence-scoped. It records the most recent outbound follow-up-style message Atlas successfully sent for the task, including the first post-block follow-up and the one extra reminder.
- `followup_reminder_sent_at` is scoped to the current unresolved follow-up episode. It remains `null` until Atlas sends the one extra reminder, is set exactly once for that unresolved episode, and is cleared when the unresolved episode ends through completion, archive, or reschedule to a new future scheduled block.
- A follow-up episode begins when Atlas sends the first post-block follow-up for a task and moves it into `awaiting_followup`.
- First-follow-up eligibility is controlled by lifecycle state, not by `last_followup_at`. A task is eligible when `lifecycle_state = scheduled` and `scheduled_end_at <= now`.
- On successful first follow-up send, Atlas transitions the task to `awaiting_followup` and sets `last_followup_at = sent_at`.
- Reminder eligibility is: `lifecycle_state = awaiting_followup`, `followup_reminder_sent_at IS NULL`, `last_followup_at IS NOT NULL`, and `now >= last_followup_at + 2 hours`.
- On successful reminder send, Atlas updates `last_followup_at = sent_at` and `followup_reminder_sent_at = sent_at`.
- Late replies resolve against the oldest unresolved `awaiting_followup` task unless the user clearly names or describes a different task.
- Clear completion marks the task `done`.
- Clear cancel / no-longer-needed intent marks the task `archived`.
- Clear not-done plus a usable future scheduling signal enters reschedule flow.
- If the user provides a concrete future time that resolves to one deterministic slot, Atlas may apply that reschedule directly.
- If the user provides a non-concrete but schedulable future preference such as a daypart or broad scheduling window, Atlas should inspect availability and propose the earliest fitting concrete slot instead of asking a generic clarification question.
- Atlas should keep a narrow deterministic reschedule path for automatic or directly-applicable mutations.
- That deterministic path may place the target task into the earliest valid slot and may single-step push later Atlas-managed tasks forward, but it may not perform richer rearrangements such as swaps, pull-earlier moves, or broader schedule rewrites.
- Atlas may still generate smarter schedule rearrangement proposals conversationally, but those richer proposals require explicit user confirmation before any mutation is applied.
- The deterministic reschedule proposal should preserve the task's current scheduled duration, search from `max(now, next 15-minute boundary)` in the user's timezone, respect explicit user constraints first, respect configured availability and external calendar busy time, and choose the earliest valid slot within a 7-day horizon.
- Daypart requests should be treated as non-concrete but schedulable preferences using fixed windows: morning `09:00-12:00`, afternoon `12:00-17:00`, evening `17:00-21:00` in the user's timezone.
- If a requested daypart or broad scheduling window cannot fit the task, Atlas should not silently spill into another window. It should explicitly propose the next available concrete slot instead.
- Clear not-done without a usable future scheduling signal keeps the task unresolved and Atlas must steer toward rescheduling or archiving.
- If no fitting slot can be found for a non-concrete but schedulable preference within the search horizon, Atlas should ask for a narrower scheduling constraint.
- Partial progress never counts as completion.
- If the message contains a clearly unrelated new planning request, Atlas should handle the new request first and then circle back to the unresolved follow-up.
- Runtime ownership is split as follows: `apps/web` owns cron and webhook orchestration, `packages/core` owns pure follow-up selectors and deterministic reschedule logic, `packages/db` owns task queries, transactional updates, and per-user locking, and `packages/integrations` owns Telegram and calendar IO.
- Follow-up detection and reminder sending should run in a background cron path that evaluates persisted task state, sends outbound messages, and updates task state only after successful delivery.
- Turn-boundary handling should run once at the end of inbound webhook processing so Atlas can wait until the active conversational turn finishes before sending a newly due follow-up or reminder.
- Follow-up dispatch, inbound webhook processing, and turn-boundary drain must all use the same per-user lock so only one runtime actor evaluates and mutates follow-up state for a given user at a time.
- While holding that per-user lock, the runtime should select the oldest unresolved follow-up candidate for the user, attempt any needed send, and apply the resulting task-state transition before releasing the lock.

## Inspect AI Guardrails

- Keep route handlers thin. New behavior should land in app-layer services, `packages/core`, or `packages/db`, not directly in Next.js routes.
- Extend the existing core and repository modules before creating new abstractions. Avoid catch-all helpers or conversation-memory utilities.
- Keep conversational awareness grounded in persisted tasks, user profiles, planner runs, and explicit schedule linkage. Chat transcripts are not a source of truth for mutations.
- Validate structured mutation output at the boundary before any task or schedule mutation, and keep model references explicit rather than id-guessing.
- When adding scheduling behavior, preserve the MVP promise: conversationally helpful, schedule-forward, and safe at the mutation boundary.
