# Legend Service Scheduler

AI-assisted shop/field-service scheduling MVP. A static frontend (HTML/CSS/JS) served by a Python standard-library HTTP backend that also exposes a JSON API backed by SQLite (with an optional Supabase/Postgres mode).

## Project Structure

- `backend.py` — Python stdlib HTTP + SQLite server. Serves the static app and the `/api/*` JSON API on a single port.
- `index.html`, `app.js`, `styles.css` — frontend single-page app.
- `supabase/schema.sql` — schema for optional Supabase/Postgres mode.
- `tests/` — validation scripts.
- `data/` — runtime SQLite DB, attachments, and backups (gitignored).

## Replit Environment Setup

- Single combined server: the backend serves both the frontend and the API.
- Workflow `Start application` runs `python3 backend.py --host 0.0.0.0 --port 5000` on port 5000 (webview).
- No build step or external dependencies — pure Python standard library and a static frontend.
- Database is local SQLite at `data/scheduler.sqlite3`, auto-initialized on server start.

## Deployment

- Target: `vm` (always-running) because the app keeps persistent state in a local SQLite file and stores attachments on disk.
- Run command: `python3 backend.py --host 0.0.0.0 --port 5000`.

## Configuration

Environment variables (see `.env.example`):
- `LEGEND_SCHEDULER_DB` — `sqlite` (default) or `supabase`.
- `LEGEND_SCHEDULER_AUTH` — set to `pin` to enable PIN-based bearer auth.
- Supabase mode requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## User Preferences

(none recorded yet)
