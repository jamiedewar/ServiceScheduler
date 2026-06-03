-- Legend Service Scheduler Supabase/Postgres schema.
-- Run this in the Supabase SQL editor before starting backend.py with
-- LEGEND_SCHEDULER_DB=supabase.

create table if not exists public.scheduler_state (
  id integer primary key check (id = 1),
  payload jsonb not null,
  version integer not null default 1,
  updated_at bigint not null,
  updated_by text
);

create table if not exists public.scheduler_users (
  id text primary key,
  name text not null,
  role text not null check (role in ('admin','manager','dispatcher','technician')),
  active boolean not null default true,
  created_at bigint not null
);

create table if not exists public.scheduler_sessions (
  token text primary key,
  user_id text not null references public.scheduler_users(id),
  created_at bigint not null,
  expires_at bigint not null
);

create index if not exists scheduler_sessions_user_idx
  on public.scheduler_sessions (user_id);

create index if not exists scheduler_sessions_expiry_idx
  on public.scheduler_sessions (expires_at);

create table if not exists public.scheduler_audit_log (
  id bigserial primary key,
  actor text not null,
  role text not null,
  action text not null,
  entity_type text,
  entity_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at bigint not null
);

create index if not exists scheduler_audit_log_created_idx
  on public.scheduler_audit_log (created_at desc);

create index if not exists scheduler_audit_log_entity_idx
  on public.scheduler_audit_log (entity_type, entity_id);

create table if not exists public.scheduler_salesforce_imports (
  id bigserial primary key,
  source text not null,
  records_imported integer not null,
  payload jsonb not null,
  created_at bigint not null,
  created_by text not null
);

create table if not exists public.scheduler_error_events (
  id bigserial primary key,
  source text not null,
  message text not null,
  detail text,
  user_id text,
  created_at bigint not null
);

create index if not exists scheduler_error_events_created_idx
  on public.scheduler_error_events (created_at desc);

create table if not exists public.scheduler_attachments (
  id text primary key,
  order_id text not null,
  filename text not null,
  content_type text not null,
  size integer not null,
  data_base64 text not null,
  created_at bigint not null,
  created_by text not null
);

create index if not exists scheduler_attachments_order_idx
  on public.scheduler_attachments (order_id, created_at desc);

alter table public.scheduler_state enable row level security;
alter table public.scheduler_users enable row level security;
alter table public.scheduler_sessions enable row level security;
alter table public.scheduler_audit_log enable row level security;
alter table public.scheduler_salesforce_imports enable row level security;
alter table public.scheduler_error_events enable row level security;
alter table public.scheduler_attachments enable row level security;

-- The Python backend should use SUPABASE_SERVICE_ROLE_KEY server-side.
-- Service role bypasses RLS, so no broad anon policies are required here.
