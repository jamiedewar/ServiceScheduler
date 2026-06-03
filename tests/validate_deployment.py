#!/usr/bin/env python3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(name: str) -> str:
  return (ROOT / name).read_text()


def main() -> None:
  dockerfile = read("Dockerfile")
  compose = read("docker-compose.yml")
  env = read(".env.example")
  schema = read("supabase/schema.sql")

  assert "FROM python:3.12-slim" in dockerfile
  assert "EXPOSE 4173" in dockerfile
  assert "/api/health" in dockerfile
  assert "--db /app/data/scheduler.sqlite3" in dockerfile
  assert "COPY supabase ./supabase" in dockerfile

  assert "legend-service-scheduler" in compose
  assert '"4173:4173"' in compose
  assert "legend_scheduler_data:/app/data" in compose
  assert "/api/health" in compose
  assert "restart: unless-stopped" in compose

  assert "LEGEND_SCHEDULER_ENV=local" in env
  assert "LEGEND_SCHEDULER_DB=sqlite" in env
  assert "LEGEND_SCHEDULER_AUTO_BACKUP=1" in env
  assert "LEGEND_SCHEDULER_BACKUP_RETENTION=20" in env
  assert "LEGEND_SCHEDULER_AUTH=pin" in env
  assert "LEGEND_SCHEDULER_SESSION_TTL_SECONDS=43200" in env
  assert "SUPABASE_URL=" in env
  assert "SUPABASE_SERVICE_ROLE_KEY=" in env
  assert "create table if not exists public.scheduler_users" in schema
  assert "create table if not exists public.scheduler_sessions" in schema
  assert "alter table public.scheduler_users enable row level security" in schema
  assert "alter table public.scheduler_sessions enable row level security" in schema
  assert "create table if not exists public.scheduler_attachments" in schema
  assert "data_base64 text not null" in schema
  assert "alter table public.scheduler_attachments enable row level security" in schema
  print("deployment validation passed")


if __name__ == "__main__":
  main()
