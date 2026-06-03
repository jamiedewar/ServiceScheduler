# Legend Service Scheduler MVP

Static web app MVP for replacing clunky field-service scheduling with a faster shop/service dispatch workflow.

## What Works

- Create, edit, and delete work orders.
- Create, edit, and delete technicians with skills, certifications, shift hours, capacity, and shop area.
- Create, edit, and delete work types/templates with default duration and required skills.
- Track parts readiness on each work order: Ready, Staged, Waiting on Parts, Backordered.
- Assign work orders to manager-maintained shop bays/resources such as Rigging Bay, Electronics Bench, PDI Lane, Fiberglass Booth, Detail Bay, or Yard / Trailer, with resource hours and outage dates.
- Work orders include operation steps, checklists, dependencies, structured time entries, actual-hour rollups, unit history, rework flags, and quality hold flags.
- Detail drawer supports updating parts, bay, status, time entries, actual hours, operations, checklist items, added checklist items, dependencies, quality hold, and rework.
- Work orders cannot be marked Complete while a quality hold, rework flag, open operation, or open checklist item remains.
- Backend state saves, Salesforce imports, demo resets, and backup restores reject completed work orders with unresolved quality blockers before persisting them.
- Detail drawer supports attachment/photo metadata, backend file/photo upload when served by `backend.py`, and operation-level splitting with child-job completion synced back to the parent operation/checklist.
- Saved dispatch views support filters by team, skill, status, and parts readiness.
- Seed/default dispatch views are included for Service, Production, Rigging, PDI, Warranty, Detail, and Yard.
- Demo/training reset restores the realistic Legend Boats seed set and clears operational residue such as imported Salesforce history, runtime errors, audit history, and attachments when served by `backend.py`.
- Dispatch filters include team, skill, status, parts readiness, due date, and customer/boat search.
- Seed data includes 8 technicians, 9 work types, and 20 realistic Legend Boats work orders.
- `Schedule with AI` runs a local rules-plus-scoring scheduler with hard constraints for:
  - required skill match
  - required certification match
  - technician availability
  - technician absences
  - bay/resource availability
  - bay/resource closed hours and outage dates
  - parts readiness
  and weighted scoring for:
  - estimated duration
  - preferred technician
  - customer urgency
  - continuity with previous technician/unit history
  - priority
  - due date
  - existing workload/capacity
- AI scheduling modes: Balanced, Protect Delivery Dates, Balance Utilization, and Critical Warranty First.
- Work orders include customer urgency and continuity technician controls, and AI explanations call out urgency scoring and continuity preservation when they influence the assignment.
- Multi-day jobs are scheduled as dated segments while preserving one work-order history.
- What Changed rescheduling previews the impact of absences, schedule drift, or jobs running long before committing changes.
- Actual-hours entry updates learned duration averages on work types and those learned estimates drive future unlocked work-order defaults and planning.
- Jobs marked Waiting on Parts or Backordered are intentionally held unscheduled until readiness changes.
- Morning AI Plan previews proposed assignments before applying them; dispatchers can approve the plan in one action.
- Dispatch board supports day/week views, unscheduled queue, manual assignment, unscheduling, and status updates.
- Day dispatch board renders technician-by-time-slot drop targets so dispatchers can drag work directly to a specific technician and start time.
- Week dispatch board supports technician/day drag-and-drop for multi-day planning.
- Conflict banner previews selected-work assignment problems before dispatchers commit manual assignments, including parts readiness, absent technicians, shift conflicts, bay/resource outages, skills/certification gaps, and bay/technician time conflicts.
- Keyboard shortcuts:
  - `G` generate Morning AI Plan
  - `A` approve Morning AI Plan
  - `S` run Schedule with AI
  - `Cmd/Ctrl+Z` undo
  - `Cmd/Ctrl+Y` redo
  - `Esc` close detail drawer
- Technician view shows a mobile-friendly daily job list with notes, checklist controls, job-specific checklist item creation, status updates, structured time-entry logging, and camera/photo attachment uploads.
- Work orders carry first-class customer, dealer, and boat/unit fields; dispatcher search and saved views can target customer/dealer text directly.
- Manager dashboard shows bottlenecks, schedule confidence, utilization, missing skills, certification gaps, absences, schedule risks, manager/admin durable backend audit events, recent errors, waiting parts, quality holds, rework, overdue work, and live backend readiness checks.
- Undo supports restoring the last major scheduling or work-order change.
- Redo restores the undone change.
- Export/import JSON supports browser-state export/import and full backend backup/restore when served by `backend.py`.
- Local backend mode writes retained automatic JSON backup snapshots after normal state saves; `/api/readiness` reports backup status.
- Data persists in browser `localStorage`.
- When served by `backend.py`, the frontend loads and saves state through `/api/state`.
- When served by `backend.py`, every backend state save is diffed into durable audit events for work-order schedule changes, status updates, creates, and deletes, plus technician, work-type, schedulable resource master-data changes, auth login/logout, attachment uploads, Salesforce imports/exports, backup export/restore, demo resets, and error reports.
- Backend persistence can run in local SQLite mode or Supabase/Postgres mode through the standard-library PostgREST adapter.
- When served by `backend.py`, users can create lightweight local sessions for admin, manager, dispatcher, and technician demo roles.
- Optional PIN-auth mode requires bearer sessions for staging/internal API access while keeping demo mode frictionless for training.
- Frontend controls are role-aware: technicians are read/update oriented, dispatchers can schedule/import, and manager/admin roles can manage technicians, work types, and schedulable bay/resource lists.
- Frontend export, Salesforce import/export, and seed reset controls are role-limited to dispatcher, manager, and admin users; full scheduler import/restore is limited to manager/admin users; technician sessions are limited to progress updates.
- Backend permissions allow technician-role tablet saves only for progress fields on work orders assigned to the logged-in user's linked technician profile, such as status, actual hours, time entries, checklist/operation completion, attachment metadata, unit history, and learned-duration samples. Technician attachment list/upload/download APIs are scoped to those assigned work orders as well. Dispatcher saves can change orders and schedules but cannot edit technician, work-type, user-technician link, or schedulable resource master data after initial demo bootstrap; those master lists remain manager/admin-only.
- Backend mode includes Server-Sent Events with polling fallback so multiple shop screens can pick up remote schedule changes.
- Backend mode includes `/api/readiness` operational checks for database access, seeded roles, state integrity, schedule conflicts, invalid completed quality records, attachment storage, and recent errors.
- Frontend runtime errors are kept locally and posted to the backend error log when online.
- Salesforce JSON import and Salesforce-shaped schedule export are available from both the UI and backend API, preserving customer/dealer/unit identity, schedule segments, parts readiness, progress, quality flags, operations, checklists, time entries, unit history, and attachment metadata where present.
- Runtime browser errors are captured into the local operational error log.
- When opened directly as a file, the frontend falls back to browser-only localStorage.

## Research Patterns Borrowed

- Salesforce Field Service: work orders, service resources, skills, scheduling optimization.
- ServiceTitan: daily/weekly dispatch board, unassigned job tray, technician skill filters, multi-day crew planning, dispatcher control.
- Jobber: simple mobile tech app and quick daily schedule visibility.
- Housecall Pro: drag-and-drop style scheduling, visual calendar/map thinking, live status.
- Oracle Field Service: resource calendars, work zones, work skills, overtime avoidance, optimization goals.
- FieldCamp: AI dispatcher, confidence-style recommendations, skill/certification matching, capacity and workload balancing.
- eLogii: constraints-first scheduling with time windows, driver schedules, skills/capabilities, service duration, capacity utilization.
- Fieldpoint: technician qualifications, certifications, work-order context, and mobile work access.

## Run

On macOS, double-click:

```text
Launch Legend Scheduler.command
```

The launcher starts `backend.py` at `http://127.0.0.1:4173` when Python is available, opens the app in the browser, and falls back to direct `file:` mode if the backend cannot start.

Manual static-server path from this folder:

```bash
python3 -m http.server 4173
```

Then open:

```text
http://localhost:4173
```

In this Codex session, starting the server required approval and was declined, so the app was validated with code-level checks and file-mode DOM smoke tests instead of a live localhost URL.

## Backend API Path

A standard-library backend has been added at `backend.py`. It runs with local SQLite by default and can use Supabase/Postgres for staging or internal launch persistence.

Initialize the database:

```bash
python3 backend.py --init-only
```

Run the API + static app server:

```bash
python3 backend.py --host 127.0.0.1 --port 4173
```

Run against Supabase/Postgres:

```bash
LEGEND_SCHEDULER_DB=supabase \
SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
LEGEND_SCHEDULER_ENV=staging \
python3 backend.py --host 127.0.0.1 --port 4173
```

Before using Supabase mode, run [supabase/schema.sql](supabase/schema.sql) in the Supabase SQL editor. Supabase mode persists scheduler state, auth users/sessions, audit events, runtime errors, Salesforce import history, and attachment/photo records to Postgres via PostgREST. Local SQLite mode remains available for seed/demo training environments.

Full backup/restore works in both SQLite and Supabase modes. Restore validates the backup shape, attachment payloads, and scheduler state integrity before replacing operational data. Supabase restore rebuilds scheduler state, audit events, Salesforce import history, runtime error history, and attachment/photo records from the exported backup snapshot.

## Deployment

Container deployment artifacts are included for staging/internal rollout:

- [Dockerfile](Dockerfile)
- [docker-compose.yml](docker-compose.yml)
- [.env.example](.env.example)

Run locally with Docker Compose:

```bash
docker compose up --build
```

Then open:

```text
http://127.0.0.1:4173
```

The container exposes `/api/health` as its healthcheck and stores SQLite data/attachments in the `legend_scheduler_data` volume at `/app/data`. For Supabase-backed staging, copy `.env.example`, set `LEGEND_SCHEDULER_DB=supabase`, configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and run [supabase/schema.sql](supabase/schema.sql) first.

Automatic local backup snapshots are enabled by default:

```bash
LEGEND_SCHEDULER_AUTO_BACKUP=1
LEGEND_SCHEDULER_BACKUP_RETENTION=20
LEGEND_SCHEDULER_BACKUP_DIR=/path/to/backups
```

By default snapshots are written to `data/backups` and pruned to the newest 20 files. Set `LEGEND_SCHEDULER_AUTO_BACKUP=0` to disable retained snapshots when a managed Supabase/Postgres backup policy is already in place.

API endpoints:

- `GET /api/health`
- `GET /api/readiness`
- `GET /api/session`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/state`
- `POST /api/state`
- `GET /api/audit`
- `GET /api/errors`
- `POST /api/errors`
- `POST /api/import/salesforce`
- `GET /api/export/salesforce`
- `POST /api/demo/reset`
- `GET /api/backup`
- `POST /api/restore`
- `GET /api/events`
- `GET /api/attachments?orderId=WO-001`
- `POST /api/attachments?orderId=WO-001&filename=photo.jpg`
- `GET /api/attachments/{attachmentId}`

Auth supports local bearer sessions from `/api/login`. The demo header fallback works only when `LEGEND_SCHEDULER_AUTH` is left in demo mode for development and code-level validation:

- `X-User: dispatcher`
- `X-Role: dispatcher`

Demo mode is the default. To require PINs for local/staging login:

```bash
LEGEND_SCHEDULER_AUTH=pin \
LEGEND_SCHEDULER_PIN_DISPATCHER=2468 \
LEGEND_SCHEDULER_PIN_MANAGER=1357 \
LEGEND_SCHEDULER_PIN_TECHNICIAN=1122 \
LEGEND_SCHEDULER_PIN_ADMIN=9999 \
LEGEND_SCHEDULER_SESSION_TTL_SECONDS=43200 \
python3 backend.py --host 127.0.0.1 --port 4173
```

`LEGEND_SCHEDULER_PIN` can be used as a shared fallback PIN, but role-specific `LEGEND_SCHEDULER_PIN_<ROLE>` values are preferred.
When `LEGEND_SCHEDULER_AUTH=pin`, scheduler state, readiness, audit/error logs, backup/restore, Salesforce import/export, and attachment APIs require a valid bearer session; client-supplied `X-User` / `X-Role` headers are ignored.
Sessions default to 12 hours; set `LEGEND_SCHEDULER_SESSION_TTL_SECONDS` to adjust the expiry window. Readiness cleanup removes expired sessions and reports active session counts.

Available roles seeded in SQLite:

- `admin`
- `manager`
- `dispatcher`
- `technician`

Backend tables:

- `users`
- `sessions`
- `app_state`
- `audit_log`
- `salesforce_imports`
- `attachments`
- `error_events`

Supabase/Postgres tables:

- `scheduler_state`
- `scheduler_users`
- `scheduler_sessions`
- `scheduler_audit_log`
- `scheduler_salesforce_imports`
- `scheduler_error_events`
- `scheduler_attachments`

Production/staging environments can label health and readiness responses by setting:

```bash
LEGEND_SCHEDULER_ENV=staging python3 backend.py --host 127.0.0.1 --port 4173
```

Use `/api/readiness` before putting a shop screen or tablet station into rotation. A non-200 response means the backend found a launch-blocking integrity issue such as an inactive technician assignment, an absent technician assignment, an outside-shift segment, overlapping technician/bay bookings, or a completed work order with unresolved quality blockers. Managers can also view and refresh this readiness report from the Manager Dashboard.

## Validation

The scheduler logic was executed in a JS validation harness:

- work orders: 20
- technicians: 8
- work types: 9
- resource-aware validation added:
  - batch-created orders: supported
  - non-ready parts jobs: held unscheduled intentionally
  - ready/staged jobs: scheduled
  - missing-skill scheduled jobs: 0
  - bay conflicts: 0
- expanded validation added:
  - scenario mode appears in AI explanations
  - actual-hours learning updates work type learned duration, uses learned estimates for future unlocked work, and preserves explicitly locked durations
  - operation checklist changes are undoable
- latest validation added:
  - AI plan preview does not apply schedule until approved
  - plan approval schedules work
  - operation splitting creates child operation work orders
  - completing split child operation jobs updates the parent operation/checklist and clears the parent quality hold after all children complete
  - completion is blocked while quality holds, rework flags, operations, or checklist items remain open
  - backend write validation rejects completed work with unresolved quality blockers from state saves, Salesforce imports, and demo resets
  - undo and redo restore split state
- dependency-aware scheduler validation added:
  - dependent rigging/PDI work is sequenced after prerequisite finish time plus handoff delay
  - dependent work moves to the next available day when it cannot fit after the prerequisite
  - parts-held work remains unscheduled without stopping other ready work from scheduling
- backend validation added:
  - SQLite schema initializes
  - Supabase/Postgres schema path is defined in `supabase/schema.sql`
  - Supabase/PostgREST adapter saves state, reads state, persists auth users/sessions, records audit events, records runtime errors, stores attachment/photo records, supports readiness checks, and produces/restores full backups under mocked HTTP validation
  - demo roles seed
  - state save/load works
  - local login/session/logout works
  - optional PIN-auth mode rejects wrong PINs and accepts configured role PINs
  - PIN-auth mode rejects spoofed demo identity headers and requires bearer sessions for API data access
  - configurable session TTLs are honored and readiness cleanup removes expired sessions
  - audit log records app-state saves, auth login/logout, attachment upload, import/export, restore/reset, and error-report operational actions
  - audit log records work-order creates, schedule changes with before/after values, technician status updates, deletes, and manager/admin master-data changes for technicians, work types, and schedulable resources
  - technician-role backend saves accept status, checklist completion, added checklist items, operation, unit-history, and structured time-entry progress updates while rejecting schedule/resource edits
  - dispatcher backend saves reject technician, work-type, and schedulable resource master-data edits while allowing order/schedule updates
  - readiness checks validate database access, seeded roles, active sessions, populated scheduler state, attachment storage, and schedule integrity
  - schedule integrity catches missing technicians, missing skills/certifications, parts-not-ready assignments, absent technician assignments, shift violations, bay/resource outages, outside-bay-availability schedules, technician/bay overlaps, and completed work with unresolved quality blockers
  - backend error events persist and survive full backup/restore
  - automatic local backup snapshots are written, readiness reports backup status, and retention pruning keeps the newest configured snapshots
  - container deployment artifacts define healthchecks, persistent data volume, staging env knobs, and Supabase/PIN auth configuration
  - Salesforce-style import normalization and schedule export shaping preserve rich work-order, schedule, progress, quality, and attachment fields
  - binary attachment storage works
  - attachment IDs are unique across rapid uploads
  - full backup snapshots include state, audit/import history, attachment metadata, and attachment bytes
  - restore recovers scheduler state and uploaded attachments
  - malformed or integrity-failing backup restores are rejected before live scheduler data is replaced
  - demo reset restores seed state and clears operational residue in both SQLite and Supabase modes
- launch-ready scheduler validation added:
  - long jobs split into multi-day schedule segments
  - required certifications and preferred technicians influence assignment
  - customer urgency changes same-priority scheduling order and appears in AI explanations
  - continuity with prior related unit work changes technician selection and appears in AI explanations
  - absences block same-day technician assignments
  - bay/resource outages and availability windows block optimizer and manual assignment paths
  - job-overrun What Changed scenarios preview downstream schedule changes without mutating the live schedule
  - manual assignment conflict validation catches parts readiness before override
  - pre-assignment conflict preview reports parts and skill problems before committing a manual assignment
  - time-slot drag/drop honors the dropped technician, date, and start time
  - technician time entries store hours, technician notes, source metadata, roll up actual hours, and appear in unit history
  - mobile technicians can add job-specific checklist items that remain in the checklist and unit history
  - schedulable bay/resources can be created, assigned availability/outage windows, and unused resources can be deleted while assigned resources are protected
- frontend/backend sync validation added:
  - file/offline mode still schedules work
  - HTTP mode loads remote `/api/state`
  - HTTP mode posts state changes back to the backend
  - bearer session tokens are used for authenticated frontend API calls
  - Manager Dashboard readiness refresh calls `/api/readiness` with bearer auth and renders backend check status
  - Manager Dashboard audit refresh calls `/api/audit` with manager/admin bearer auth and renders durable backend schedule-change events
  - login submits optional PINs to `/api/login`
  - technician role cannot trigger protected export/reset/restore endpoints from exposed frontend functions
  - seed state links the demo technician login to a technician profile for scoped tablet saves
  - technician progress photo uploads use technician bearer auth and keep attachment metadata on the work order
  - full backup restore uses manager/admin bearer auth in frontend API flows
  - technician progress autosave uses technician bearer auth and the shared backend state endpoint
  - Export / Backup requests a full backend backup when online
  - Import / Restore posts full backup snapshots back to `/api/restore`
  - Salesforce Export requests Salesforce-shaped work order records from `/api/export/salesforce`
  - Reset Seed Data posts the canonical training seed to `/api/demo/reset` when online
  - SSE subscribes to `/api/events`
  - SSE-triggered polling applies remote schedule updates
  - backend attachment upload stores returned file URLs on work orders
  - partial Salesforce-style records are normalized before rendering
- file-mode launch smoke validation added:
  - direct `file:` launch initializes without backend fetches or Server-Sent Events
  - startup render populates metrics, unscheduled queue, and dispatch board
  - day dispatch board renders hourly time-slot drop targets
  - mobile technician view renders assigned work and checklist controls
  - clicking `Schedule with AI` schedules work from the rendered app controls
  - scheduled jobs include technician, date, start time, and full required-skill matches
  - dispatch board and AI recommendations re-render after scheduling
- launcher validation added:
  - `Launch Legend Scheduler.command` is executable
  - zsh syntax validation exits successfully
  - launcher starts the backend when available and falls back to direct file mode
- dispatcher UX validation added:
  - customer/boat search filters work orders
  - due-date filter narrows visible work
  - required shop saved views are seeded, normalized into older state, and rendered in the selector
  - keyboard shortcut path can generate and approve an AI plan
- scheduled jobs with missing required skills: 0

Commands run in this session:

```bash
python3 Outputs/legend-service-scheduler/tests/validate_backend.py
node Outputs/legend-service-scheduler/tests/validate_launch_ready_scheduler.js
node Outputs/legend-service-scheduler/tests/validate_frontend_api.js
node Outputs/legend-service-scheduler/tests/validate_file_mode_launch.js
node Outputs/legend-service-scheduler/tests/validate_scheduler_dependencies.js
python3 Outputs/legend-service-scheduler/tests/validate_deployment.py
/bin/zsh -f -n 'Outputs/legend-service-scheduler/Launch Legend Scheduler.command'
```

## Launch Notes

The app now implements the requested launch-ready operating workflow inside the existing local app architecture. External enterprise services such as SSO providers, managed Postgres/Supabase hosting, and live Salesforce OAuth/API sync are represented by local demo auth, SQLite persistence, backup/restore, and Salesforce JSON import/export paths so the shop workflow is functional without new third-party setup.

Rendered browser/server verification could not be completed in this Codex session because local server approval was declined. Direct file-mode launch, backend initialization, backend API behavior, frontend/backend sync, and scheduling behavior are covered by the validation harnesses above.
