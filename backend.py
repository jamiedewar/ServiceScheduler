#!/usr/bin/env python3
"""Legend Service Scheduler backend.

Standard-library HTTP + SQLite service for the launch-ready path. It serves the
static app and exposes a small JSON API that can replace browser-only
localStorage when the frontend is wired to it.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import os
import secrets
import sqlite3
import time
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen


APP_DIR = Path(__file__).resolve().parent
DB_PATH = APP_DIR / "data" / "scheduler.sqlite3"
ATTACHMENTS_DIR = APP_DIR / "data" / "attachments"
BACKUPS_DIR = APP_DIR / "data" / "backups"
ROLES = {"admin", "manager", "dispatcher", "technician"}
WRITE_ROLES = {"admin", "manager", "dispatcher"}
DEFAULT_USERS = [
  ("admin", "Admin", "admin"),
  ("manager", "Manager", "manager"),
  ("dispatcher", "Dispatcher", "dispatcher"),
  ("technician", "Technician", "technician"),
]


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','manager','dispatcher','technician')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  payload TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS salesforce_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  records_imported INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS error_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  user_id TEXT,
  created_at INTEGER NOT NULL
);
"""


def now() -> int:
  return int(time.time())


def database_mode() -> str:
  return os.environ.get("LEGEND_SCHEDULER_DB", "sqlite").strip().lower()


def use_supabase() -> bool:
  return database_mode() in {"supabase", "postgres"}


class SupabaseStore:
  """Small PostgREST client for Supabase-backed launch/staging persistence."""

  def __init__(self) -> None:
    self.url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    self.key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")
    if not self.url or not self.key:
      raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY are required")
    self.rest_url = f"{self.url}/rest/v1"

  def request(self, method: str, table: str, query: str = "", body: Any | None = None, prefer: str = "") -> Any:
    url = f"{self.rest_url}/{table}{query}"
    data = None
    if body is not None:
      data = json.dumps(body, separators=(",", ":")).encode("utf-8")
    headers = {
      "apikey": self.key,
      "Authorization": f"Bearer {self.key}",
      "Content-Type": "application/json",
      "Accept": "application/json",
    }
    if prefer:
      headers["Prefer"] = prefer
    req = Request(url, data=data, headers=headers, method=method)
    with urlopen(req, timeout=10) as response:
      raw = response.read().decode("utf-8")
      return json.loads(raw) if raw else None

  def row(self, table: str, query: str) -> dict[str, Any] | None:
    rows = self.request("GET", table, query)
    return rows[0] if rows else None

  def init(self) -> None:
    if self.row("scheduler_state", "?id=eq.1&select=id") is None:
      self.request(
        "POST",
        "scheduler_state",
        "?on_conflict=id",
        body={"id": 1, "payload": default_state(), "version": 1, "updated_at": now(), "updated_by": "system"},
        prefer="resolution=merge-duplicates",
      )
    for user_id, name, role in DEFAULT_USERS:
      if self.row("scheduler_users", f"?id=eq.{user_id}&select=id") is None:
        self.request(
          "POST",
          "scheduler_users",
          body={"id": user_id, "name": name, "role": role, "active": True, "created_at": now()},
        )

  def get_state(self) -> dict[str, Any]:
    row = self.row("scheduler_state", "?id=eq.1&select=payload,version,updated_at,updated_by")
    if row is None:
      return default_state()
    payload = row.get("payload") or default_state()
    if isinstance(payload, str):
      payload = json.loads(payload)
    payload["_meta"] = {"version": row.get("version"), "updatedAt": row.get("updated_at"), "updatedBy": row.get("updated_by")}
    return payload

  def save_state(self, state: dict[str, Any], actor: str, role: str, action: str = "state.save") -> int:
    state = {k: v for k, v in state.items() if k != "_meta"}
    row = self.row("scheduler_state", "?id=eq.1&select=payload,version")
    previous_state = row.get("payload") if row else default_state()
    if isinstance(previous_state, str):
      previous_state = json.loads(previous_state)
    version = int(row.get("version") or 0) + 1 if row else 1
    self.request(
      "POST",
      "scheduler_state",
      "?on_conflict=id",
      body={"id": 1, "payload": state, "version": version, "updated_at": now(), "updated_by": actor},
      prefer="resolution=merge-duplicates",
    )
    self.audit(actor, role, action, "app_state", "1", {"version": version})
    self.audit_order_changes(previous_state, state, actor, role, version)
    self.audit_master_data_changes(previous_state, state, actor, role, version)
    return version

  def audit(
    self,
    actor: str,
    role: str,
    action: str,
    entity_type: str | None = None,
    entity_id: str | None = None,
    payload: dict[str, Any] | None = None,
  ) -> None:
    self.request(
      "POST",
      "scheduler_audit_log",
      body={
        "actor": actor,
        "role": role,
        "action": action,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "payload": payload or {},
        "created_at": now(),
      },
    )

  def audit_order_changes(
    self,
    previous_state: dict[str, Any],
    next_state: dict[str, Any],
    actor: str,
    role: str,
    version: int,
  ) -> None:
    previous_orders = {order.get("id"): order for order in previous_state.get("orders", []) if order.get("id")}
    next_orders = {order.get("id"): order for order in next_state.get("orders", []) if order.get("id")}
    for order_id, order in next_orders.items():
      previous = previous_orders.get(order_id)
      if previous is None:
        self.audit(actor, role, "work_order.create", "work_order", order_id, {"version": version, "next": comparable_schedule(order)})
        continue
      before = comparable_schedule(previous)
      after = comparable_schedule(order)
      changes = {field: {"before": before[field], "after": after[field]} for field in after if before.get(field) != after.get(field)}
      if changes:
        schedule_fields = {"techId", "scheduledDate", "start", "segments", "bay"}
        event_action = "schedule.change" if any(field in changes for field in schedule_fields) else "work_order.update"
        self.audit(actor, role, event_action, "work_order", order_id, {"version": version, "changes": changes})
    for order_id, order in previous_orders.items():
      if order_id not in next_orders:
        self.audit(actor, role, "work_order.delete", "work_order", order_id, {"version": version, "previous": comparable_schedule(order)})

  def audit_master_data_changes(
    self,
    previous_state: dict[str, Any],
    next_state: dict[str, Any],
    actor: str,
    role: str,
    version: int,
  ) -> None:
    for event in master_data_audit_events(previous_state, next_state, version):
      self.audit(actor, role, event["action"], event["entityType"], event["entityId"], event["payload"])

  def list_audit(self, limit: int = 100) -> list[dict[str, Any]]:
    rows = self.request(
      "GET",
      "scheduler_audit_log",
      f"?select=actor,role,action,entity_type,entity_id,payload,created_at&order=id.desc&limit={limit}",
    ) or []
    return [
      {
        "actor": row.get("actor"),
        "role": row.get("role"),
        "action": row.get("action"),
        "entityType": row.get("entity_type"),
        "entityId": row.get("entity_id"),
        "payload": row.get("payload") or {},
        "createdAt": row.get("created_at"),
      }
      for row in rows
    ]

  def list_errors(self, limit: int = 100) -> list[dict[str, Any]]:
    rows = self.request(
      "GET",
      "scheduler_error_events",
      f"?select=source,message,detail,user_id,created_at&order=id.desc&limit={limit}",
    ) or []
    return [
      {
        "source": row.get("source"),
        "message": row.get("message"),
        "detail": row.get("detail"),
        "userId": row.get("user_id"),
        "createdAt": row.get("created_at"),
      }
      for row in rows
    ]

  def record_error(self, source: str, message: str, detail: str = "", user_id: str = "") -> None:
    self.request(
      "POST",
      "scheduler_error_events",
      body={"source": source[:80], "message": message[:1000], "detail": detail[:4000], "user_id": user_id[:120], "created_at": now()},
    )

  def record_salesforce_import(self, payload: dict[str, Any], count: int, actor: str) -> None:
    self.request(
      "POST",
      "scheduler_salesforce_imports",
      body={"source": "salesforce", "records_imported": count, "payload": payload, "created_at": now(), "created_by": actor},
    )

  def list_salesforce_imports(self) -> list[dict[str, Any]]:
    rows = self.request(
      "GET",
      "scheduler_salesforce_imports",
      "?select=source,records_imported,payload,created_at,created_by&order=id.asc",
    ) or []
    return [
      {
        "source": row.get("source"),
        "recordsImported": row.get("records_imported"),
        "payload": row.get("payload") or {},
        "createdAt": row.get("created_at"),
        "createdBy": row.get("created_by"),
      }
      for row in rows
    ]

  def save_attachment(self, order_id: str, filename: str, content_type: str, data: bytes, actor: str, role: str) -> dict[str, Any]:
    if not order_id:
      raise ValueError("orderId is required")
    attachment_id = f"att-{uuid.uuid4().hex[:12]}"
    created_at = now()
    self.request(
      "POST",
      "scheduler_attachments",
      body={
        "id": attachment_id,
        "order_id": order_id,
        "filename": filename,
        "content_type": content_type,
        "size": len(data),
        "data_base64": base64.b64encode(data).decode("ascii"),
        "created_at": created_at,
        "created_by": actor,
      },
    )
    self.audit(actor, role, "attachment.upload", "work_order", order_id, {"attachmentId": attachment_id, "filename": filename})
    return {
      "id": attachment_id,
      "orderId": order_id,
      "name": filename,
      "type": content_type,
      "size": len(data),
      "addedAt": created_at,
      "addedBy": actor,
      "url": f"/api/attachments/{attachment_id}",
    }

  def list_attachments(self, order_id: str = "") -> list[dict[str, Any]]:
    query = "?select=id,order_id,filename,content_type,size,created_at,created_by&order=created_at.desc"
    if order_id:
      query = f"?order_id=eq.{order_id}&select=id,order_id,filename,content_type,size,created_at,created_by&order=created_at.desc"
    rows = self.request("GET", "scheduler_attachments", query) or []
    return [
      {
        "id": row.get("id"),
        "orderId": row.get("order_id"),
        "name": row.get("filename"),
        "type": row.get("content_type"),
        "size": row.get("size"),
        "addedAt": row.get("created_at"),
        "addedBy": row.get("created_by"),
        "url": f"/api/attachments/{row.get('id')}",
      }
      for row in rows
    ]

  def get_attachment(self, attachment_id: str) -> dict[str, Any] | None:
    row = self.row(
      "scheduler_attachments",
      f"?id=eq.{attachment_id}&select=id,order_id,filename,content_type,size,data_base64",
    )
    if row is None:
      return None
    return {
      "orderId": row.get("order_id") or "",
      "filename": row.get("filename") or "attachment.bin",
      "contentType": row.get("content_type") or "application/octet-stream",
      "data": base64.b64decode(row.get("data_base64") or ""),
    }

  def attachment_backup_rows(self) -> list[dict[str, Any]]:
    rows = self.request(
      "GET",
      "scheduler_attachments",
      "?select=id,order_id,filename,content_type,size,data_base64,created_at,created_by&order=created_at.asc",
    ) or []
    return [
      {
        "id": row.get("id"),
        "orderId": row.get("order_id"),
        "filename": row.get("filename"),
        "contentType": row.get("content_type"),
        "size": row.get("size"),
        "createdAt": row.get("created_at"),
        "createdBy": row.get("created_by"),
        "data": row.get("data_base64") or "",
      }
      for row in rows
    ]

  def create_session(self, user_id: str, pin: str = "") -> dict[str, Any]:
    row = self.row("scheduler_users", f"?id=eq.{user_id}&select=id,name,role,active")
    if row is None or not row.get("active", True):
      raise ValueError("Unknown or inactive user")
    verify_login_pin(user_id, pin)
    token = secrets.token_urlsafe(32)
    created_at = now()
    expires_at = created_at + session_ttl_seconds()
    self.request(
      "POST",
      "scheduler_sessions",
      body={"token": token, "user_id": user_id, "created_at": created_at, "expires_at": expires_at},
    )
    self.audit(row["id"], row["role"], "auth.login", "user", row["id"])
    return {
      "token": token,
      "expiresAt": expires_at,
      "user": {"id": row["id"], "name": row["name"], "role": row["role"]},
    }

  def session_user(self, token: str) -> dict[str, str] | None:
    if not token:
      return None
    session = self.row("scheduler_sessions", f"?token=eq.{token}&select=token,user_id,expires_at")
    if session is None or int(session.get("expires_at") or 0) <= now():
      return None
    user = self.row("scheduler_users", f"?id=eq.{session.get('user_id')}&select=id,name,role,active")
    if user is None or not user.get("active", True):
      return None
    return {"id": user["id"], "name": user["name"], "role": user["role"]}

  def cleanup_expired_sessions(self) -> None:
    self.request("DELETE", "scheduler_sessions", f"?expires_at=lte.{now()}")

  def session_status(self) -> dict[str, int]:
    rows = self.request("GET", "scheduler_sessions", "?select=expires_at") or []
    current = now()
    active = sum(1 for row in rows if int(row.get("expires_at") or 0) > current)
    expired = sum(1 for row in rows if int(row.get("expires_at") or 0) <= current)
    return {"active": active, "expired": expired}

  def delete_session(self, token: str) -> None:
    if token:
      self.request("DELETE", "scheduler_sessions", f"?token=eq.{token}")

  def delete_all(self, table: str, column: str = "id") -> None:
    self.request("DELETE", table, f"?{column}=not.is.null")

  def restore_operational_tables(self, backup: dict[str, Any], actor: str) -> None:
    self.delete_all("scheduler_attachments")
    self.delete_all("scheduler_salesforce_imports")
    self.delete_all("scheduler_error_events")
    self.delete_all("scheduler_audit_log")
    for event in backup.get("auditLog", []):
      self.request(
        "POST",
        "scheduler_audit_log",
        body={
          "actor": event.get("actor", "system"),
          "role": event.get("role", "admin"),
          "action": event.get("action", "unknown"),
          "entity_type": event.get("entityType"),
          "entity_id": event.get("entityId"),
          "payload": event.get("payload") or {},
          "created_at": int(event.get("createdAt") or now()),
        },
      )
    for imported in backup.get("salesforceImports", []):
      self.request(
        "POST",
        "scheduler_salesforce_imports",
        body={
          "source": imported.get("source", "salesforce"),
          "records_imported": int(imported.get("recordsImported") or 0),
          "payload": imported.get("payload") or {},
          "created_at": int(imported.get("createdAt") or now()),
          "created_by": imported.get("createdBy") or actor,
        },
      )
    for error_event in backup.get("errorEvents", []):
      self.request(
        "POST",
        "scheduler_error_events",
        body={
          "source": error_event.get("source", "unknown"),
          "message": error_event.get("message", "Unknown error"),
          "detail": error_event.get("detail") or "",
          "user_id": error_event.get("userId") or "",
          "created_at": int(error_event.get("createdAt") or now()),
        },
      )
    for attachment in backup.get("attachments", []):
      attachment_id = attachment.get("id") or f"att-{uuid.uuid4().hex[:12]}"
      data_base64 = attachment.get("data") or ""
      self.request(
        "POST",
        "scheduler_attachments",
        body={
          "id": attachment_id,
          "order_id": attachment.get("orderId") or "",
          "filename": attachment.get("filename") or "attachment.bin",
          "content_type": attachment.get("contentType") or "application/octet-stream",
          "size": int(attachment.get("size") or len(base64.b64decode(data_base64 or ""))),
          "data_base64": data_base64,
          "created_at": int(attachment.get("createdAt") or now()),
          "created_by": attachment.get("createdBy") or actor,
        },
      )

  def role_counts(self) -> dict[str, int]:
    rows = self.request("GET", "scheduler_users", "?select=role,active") or []
    counts: dict[str, int] = {}
    for row in rows:
      if row.get("active", True):
        role = str(row.get("role") or "")
        counts[role] = counts.get(role, 0) + 1
    return counts

  def health(self) -> dict[str, Any]:
    row = self.row("scheduler_state", "?id=eq.1&select=version,updated_at,updated_by")
    errors = self.request("GET", "scheduler_error_events", "?select=id") or []
    return {
      "ok": True,
      "database": "supabase",
      "stateVersion": row.get("version") if row else None,
      "stateUpdatedAt": row.get("updated_at") if row else None,
      "errorCount": len(errors),
    }


def supabase_store() -> SupabaseStore:
  return SupabaseStore()


def connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
  db_path.parent.mkdir(parents=True, exist_ok=True)
  conn = sqlite3.connect(db_path)
  conn.row_factory = sqlite3.Row
  conn.execute("PRAGMA foreign_keys = ON")
  return conn


def init_db(db_path: Path = DB_PATH) -> None:
  with connect(db_path) as conn:
    conn.executescript(SCHEMA)
    seed_users(conn)
    if conn.execute("SELECT COUNT(*) FROM app_state").fetchone()[0] == 0:
      conn.execute(
        "INSERT INTO app_state (id, payload, version, updated_at, updated_by) VALUES (1, ?, 1, ?, ?)",
        (json.dumps(default_state(), separators=(",", ":")), now(), "system"),
      )


def seed_users(conn: sqlite3.Connection) -> None:
  for user_id, name, role in DEFAULT_USERS:
    conn.execute(
      "INSERT OR IGNORE INTO users (id, name, role, active, created_at) VALUES (?, ?, ?, 1, ?)",
      (user_id, name, role, now()),
    )


def default_saved_views() -> list[dict[str, Any]]:
  base = {"team": "", "skill": "", "status": "", "parts": "", "due": "", "text": ""}
  return [
    {"name": "Service", "filters": {**base, "team": "Service"}, "boardMode": "day"},
    {"name": "Production", "filters": {**base}, "boardMode": "week"},
    {"name": "Rigging", "filters": {**base, "team": "Rigging"}, "boardMode": "week"},
    {"name": "PDI", "filters": {**base, "skill": "PDI"}, "boardMode": "day"},
    {"name": "Warranty", "filters": {**base, "skill": "Warranty"}, "boardMode": "day"},
    {"name": "Detail", "filters": {**base, "team": "Detail"}, "boardMode": "day"},
    {"name": "Yard", "filters": {**base, "team": "Yard"}, "boardMode": "week"},
  ]


def default_state() -> dict[str, Any]:
  return {
    "selectedOrderId": None,
    "activeOrderId": None,
    "schedulerMode": "balanced",
    "filters": {"team": "", "skill": "", "status": "", "parts": "", "due": "", "text": ""},
    "savedViews": default_saved_views(),
    "auditLog": [],
    "errorLog": [],
    "boardMode": "day",
    "boardDate": "",
    "recommendations": [],
    "aiPlan": None,
    "scenarioDiff": None,
    "absences": [],
    "userTechnicianLinks": {},
    "bays": [
      "Service Bay 1",
      "Service Bay 2",
      "Rigging Bay",
      "Electronics Bench",
      "PDI Lane",
      "Fiberglass Booth",
      "Detail Bay",
      "Yard / Trailer",
    ],
    "bayAvailability": {},
    "workTypes": [],
    "technicians": [],
    "orders": [],
  }


def get_state(conn: sqlite3.Connection) -> dict[str, Any]:
  row = conn.execute("SELECT payload, version, updated_at, updated_by FROM app_state WHERE id = 1").fetchone()
  if row is None:
    return default_state()
  data = json.loads(row["payload"])
  data["_meta"] = {"version": row["version"], "updatedAt": row["updated_at"], "updatedBy": row["updated_by"]}
  return data


def save_state(conn: sqlite3.Connection, state: dict[str, Any], actor: str, role: str, action: str = "state.save") -> int:
  state = {k: v for k, v in state.items() if k != "_meta"}
  current = conn.execute("SELECT payload, version FROM app_state WHERE id = 1").fetchone()
  previous_state = json.loads(current["payload"]) if current and current["payload"] else default_state()
  version = int(current["version"]) + 1 if current else 1
  payload = json.dumps(state, separators=(",", ":"))
  conn.execute(
    """
    INSERT INTO app_state (id, payload, version, updated_at, updated_by)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload=excluded.payload,
      version=excluded.version,
      updated_at=excluded.updated_at,
      updated_by=excluded.updated_by
    """,
    (payload, version, now(), actor),
  )
  audit(conn, actor, role, action, "app_state", "1", {"version": version})
  audit_order_changes(conn, previous_state, state, actor, role, version)
  audit_master_data_changes(conn, previous_state, state, actor, role, version)
  if action != "backup.restore":
    write_auto_backup(conn, version, action)
  return version


def comparable_schedule(order: dict[str, Any]) -> dict[str, Any]:
  return {
    "status": order.get("status", ""),
    "techId": order.get("techId", ""),
    "scheduledDate": order.get("scheduledDate", ""),
    "start": order.get("start", ""),
    "segments": order.get("segments") or [],
    "bay": order.get("bay", ""),
    "parts": order.get("parts", ""),
    "earliestStartDate": order.get("earliestStartDate", ""),
    "customerUrgency": order.get("customerUrgency", "Normal"),
    "continuityTechId": order.get("continuityTechId", ""),
    "actualHours": order.get("actualHours", 0),
    "qualityHold": bool(order.get("qualityHold")),
    "rework": bool(order.get("rework")),
  }


def audit_order_changes(
  conn: sqlite3.Connection,
  previous_state: dict[str, Any],
  next_state: dict[str, Any],
  actor: str,
  role: str,
  version: int,
) -> None:
  previous_orders = {order.get("id"): order for order in previous_state.get("orders", []) if order.get("id")}
  next_orders = {order.get("id"): order for order in next_state.get("orders", []) if order.get("id")}
  for order_id, order in next_orders.items():
    previous = previous_orders.get(order_id)
    if previous is None:
      audit(conn, actor, role, "work_order.create", "work_order", order_id, {"version": version, "next": comparable_schedule(order)})
      continue
    before = comparable_schedule(previous)
    after = comparable_schedule(order)
    changes = {field: {"before": before[field], "after": after[field]} for field in after if before.get(field) != after.get(field)}
    if changes:
      schedule_fields = {"techId", "scheduledDate", "start", "segments", "bay"}
      action = "schedule.change" if any(field in changes for field in schedule_fields) else "work_order.update"
      audit(conn, actor, role, action, "work_order", order_id, {"version": version, "changes": changes})
  for order_id, order in previous_orders.items():
    if order_id not in next_orders:
      audit(conn, actor, role, "work_order.delete", "work_order", order_id, {"version": version, "previous": comparable_schedule(order)})


def comparable_master_record(record: dict[str, Any]) -> dict[str, Any]:
  return {key: value for key, value in record.items() if key != "_meta"}


def record_collection_events(
  previous_items: list[dict[str, Any]],
  next_items: list[dict[str, Any]],
  id_key: str,
  entity_type: str,
  action_prefix: str,
  version: int,
) -> list[dict[str, Any]]:
  events = []
  previous = {item.get(id_key): item for item in previous_items if item.get(id_key)}
  next_map = {item.get(id_key): item for item in next_items if item.get(id_key)}
  for item_id, item in next_map.items():
    if item_id not in previous:
      events.append({
        "action": f"{action_prefix}.create",
        "entityType": entity_type,
        "entityId": item_id,
        "payload": {"version": version, "next": comparable_master_record(item)},
      })
      continue
    before = comparable_master_record(previous[item_id])
    after = comparable_master_record(item)
    changes = {field: {"before": before.get(field), "after": after.get(field)} for field in after if before.get(field) != after.get(field)}
    removed = {field: {"before": before.get(field), "after": None} for field in before if field not in after}
    changes.update(removed)
    if changes:
      events.append({
        "action": f"{action_prefix}.update",
        "entityType": entity_type,
        "entityId": item_id,
        "payload": {"version": version, "changes": changes},
      })
  for item_id, item in previous.items():
    if item_id not in next_map:
      events.append({
        "action": f"{action_prefix}.delete",
        "entityType": entity_type,
        "entityId": item_id,
        "payload": {"version": version, "previous": comparable_master_record(item)},
      })
  return events


def master_data_audit_events(previous_state: dict[str, Any], next_state: dict[str, Any], version: int) -> list[dict[str, Any]]:
  events = []
  events.extend(record_collection_events(previous_state.get("technicians", []), next_state.get("technicians", []), "id", "technician", "technician", version))
  events.extend(record_collection_events(previous_state.get("workTypes", []), next_state.get("workTypes", []), "id", "work_type", "work_type", version))
  previous_bays = set(previous_state.get("bays") or [])
  next_bays = set(next_state.get("bays") or [])
  for bay in sorted(next_bays - previous_bays):
    events.append({"action": "resource.create", "entityType": "resource", "entityId": bay, "payload": {"version": version, "next": {"name": bay}}})
  for bay in sorted(previous_bays - next_bays):
    events.append({"action": "resource.delete", "entityType": "resource", "entityId": bay, "payload": {"version": version, "previous": {"name": bay}}})
  previous_availability = previous_state.get("bayAvailability") or {}
  next_availability = next_state.get("bayAvailability") or {}
  for bay in sorted(next_bays & previous_bays):
    before = previous_availability.get(bay) or {}
    after = next_availability.get(bay) or {}
    if before != after:
      events.append({
        "action": "resource.update",
        "entityType": "resource",
        "entityId": bay,
        "payload": {"version": version, "changes": {"availability": {"before": before, "after": after}}},
      })
  return events


def audit_master_data_changes(
  conn: sqlite3.Connection,
  previous_state: dict[str, Any],
  next_state: dict[str, Any],
  actor: str,
  role: str,
  version: int,
) -> None:
  for event in master_data_audit_events(previous_state, next_state, version):
    audit(conn, actor, role, event["action"], event["entityType"], event["entityId"], event["payload"])


def stripped_order_for_technician_compare(order: dict[str, Any]) -> dict[str, Any]:
  allowed = {"status", "actualHours", "timeEntries", "checklist", "operations", "unitHistory", "attachments"}
  return {key: value for key, value in order.items() if key not in allowed}


def stripped_work_type_for_technician_compare(work_type: dict[str, Any]) -> dict[str, Any]:
  allowed = {"actualSamples", "learnedDuration"}
  return {key: value for key, value in work_type.items() if key not in allowed}


def technician_ids_for_user(state: dict[str, Any], actor: str) -> set[str]:
  if not actor:
    return set()
  linked = (state.get("userTechnicianLinks") or {}).get(actor)
  if isinstance(linked, str):
    return {linked} if linked else set()
  if isinstance(linked, list):
    return {str(item) for item in linked if item}
  technician_ids = {str(tech.get("id")) for tech in state.get("technicians", []) if tech.get("id")}
  return {actor} if actor in technician_ids else set()


def order_assigned_to_technician(order: dict[str, Any], technician_ids: set[str]) -> bool:
  if not technician_ids:
    return False
  if order.get("techId") in technician_ids:
    return True
  return any(segment.get("techId") in technician_ids for segment in schedule_segments(order))


def technician_can_access_order(state: dict[str, Any], order_id: str, actor: str) -> bool:
  order = next((item for item in state.get("orders", []) if item.get("id") == order_id), None)
  if not order:
    return False
  return order_assigned_to_technician(order, technician_ids_for_user(state, actor))


def validate_technician_state_change(previous_state: dict[str, Any], next_state: dict[str, Any], actor: str = "") -> list[str]:
  """Allow tablets to persist progress without granting dispatcher authority."""
  errors: list[str] = []
  allowed_top_level = {"selectedOrderId", "activeOrderId", "auditLog", "errorLog", "_meta"}
  for key, previous_value in previous_state.items():
    if key in allowed_top_level or key in {"orders", "workTypes"}:
      continue
    if next_state.get(key) != previous_value:
      errors.append(f"{key} cannot be changed by technician role")
  for key in next_state:
    if key not in previous_state and key not in allowed_top_level:
      errors.append(f"{key} cannot be added by technician role")

  previous_orders = {order.get("id"): order for order in previous_state.get("orders", []) if order.get("id")}
  next_orders = {order.get("id"): order for order in next_state.get("orders", []) if order.get("id")}
  if set(previous_orders) != set(next_orders):
    errors.append("technician role cannot create or delete work orders")
  for order_id, order in next_orders.items():
    previous = previous_orders.get(order_id)
    if not previous:
      continue
    if stripped_order_for_technician_compare(previous) != stripped_order_for_technician_compare(order):
      errors.append(f"{order_id} has non-progress work-order changes")
      continue
    if actor and previous != order:
      allowed_tech_ids = technician_ids_for_user(previous_state, actor)
      if not order_assigned_to_technician(previous, allowed_tech_ids):
        errors.append(f"{order_id} is not assigned to technician user {actor}")

  previous_types = {item.get("id"): item for item in previous_state.get("workTypes", []) if item.get("id")}
  next_types = {item.get("id"): item for item in next_state.get("workTypes", []) if item.get("id")}
  if set(previous_types) != set(next_types):
    errors.append("technician role cannot create or delete work types")
  for type_id, work_type in next_types.items():
    previous = previous_types.get(type_id)
    if not previous:
      continue
    if stripped_work_type_for_technician_compare(previous) != stripped_work_type_for_technician_compare(work_type):
      errors.append(f"{type_id} has non-learning work-type changes")
  return errors


def validate_dispatcher_state_change(previous_state: dict[str, Any], next_state: dict[str, Any]) -> list[str]:
  """Allow dispatch work while keeping manager/admin ownership of master data."""
  errors: list[str] = []
  bootstrap_empty = not previous_state.get("orders") and not previous_state.get("technicians") and not previous_state.get("workTypes")
  if bootstrap_empty:
    return errors
  master_fields = {
    "technicians": "technician list",
    "workTypes": "work type list",
    "bays": "schedulable resource list",
    "bayAvailability": "schedulable resource availability",
    "userTechnicianLinks": "technician user links",
  }
  for key, label in master_fields.items():
    if next_state.get(key) != previous_state.get(key):
      errors.append(f"dispatcher role cannot change {label}")
  return errors


def audit(
  conn: sqlite3.Connection,
  actor: str,
  role: str,
  action: str,
  entity_type: str | None = None,
  entity_id: str | None = None,
  payload: dict[str, Any] | None = None,
) -> None:
  conn.execute(
    """
    INSERT INTO audit_log (actor, role, action, entity_type, entity_id, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    """,
    (actor, role, action, entity_type, entity_id, json.dumps(payload or {}, separators=(",", ":")), now()),
  )


def list_audit(conn: sqlite3.Connection, limit: int = 100) -> list[dict[str, Any]]:
  rows = conn.execute(
    "SELECT actor, role, action, entity_type, entity_id, payload, created_at FROM audit_log ORDER BY id DESC LIMIT ?",
    (limit,),
  ).fetchall()
  return [
    {
      "actor": r["actor"],
      "role": r["role"],
      "action": r["action"],
      "entityType": r["entity_type"],
      "entityId": r["entity_id"],
      "payload": json.loads(r["payload"] or "{}"),
      "createdAt": r["created_at"],
    }
    for r in rows
  ]


def list_attachments(conn: sqlite3.Connection, order_id: str = "") -> list[dict[str, Any]]:
  if order_id:
    rows = conn.execute(
      "SELECT id, order_id, filename, content_type, size, created_at, created_by FROM attachments WHERE order_id = ? ORDER BY created_at DESC",
      (order_id,),
    ).fetchall()
  else:
    rows = conn.execute(
      "SELECT id, order_id, filename, content_type, size, created_at, created_by FROM attachments ORDER BY created_at DESC LIMIT 200"
    ).fetchall()
  return [
    {
      "id": row["id"],
      "orderId": row["order_id"],
      "name": row["filename"],
      "type": row["content_type"],
      "size": row["size"],
      "addedAt": row["created_at"],
      "addedBy": row["created_by"],
      "url": f"/api/attachments/{row['id']}",
    }
    for row in rows
  ]


def list_errors(conn: sqlite3.Connection, limit: int = 100) -> list[dict[str, Any]]:
  rows = conn.execute(
    "SELECT source, message, detail, user_id, created_at FROM error_events ORDER BY id DESC LIMIT ?",
    (limit,),
  ).fetchall()
  return [
    {
      "source": row["source"],
      "message": row["message"],
      "detail": row["detail"],
      "userId": row["user_id"],
      "createdAt": row["created_at"],
    }
    for row in rows
  ]


def record_error(
  conn: sqlite3.Connection,
  source: str,
  message: str,
  detail: str = "",
  user_id: str = "",
) -> None:
  conn.execute(
    "INSERT INTO error_events (source, message, detail, user_id, created_at) VALUES (?, ?, ?, ?, ?)",
    ((source or "unknown")[:80], (message or "Unknown error")[:1000], detail[:4000], user_id[:120], now()),
  )


def auth_mode() -> str:
  return os.environ.get("LEGEND_SCHEDULER_AUTH", "demo").strip().lower()


def expected_pin_for_user(user_id: str) -> str:
  key = f"LEGEND_SCHEDULER_PIN_{user_id.upper().replace('-', '_')}"
  return os.environ.get(key) or os.environ.get("LEGEND_SCHEDULER_PIN", "")


def verify_login_pin(user_id: str, pin: str = "") -> None:
  if auth_mode() != "pin":
    return
  expected = expected_pin_for_user(user_id)
  if not expected:
    raise ValueError(f"PIN auth is enabled but no PIN is configured for {user_id}")
  if not secrets.compare_digest(str(pin or ""), expected):
    raise ValueError("Invalid PIN")


def session_ttl_seconds() -> int:
  try:
    return max(900, int(os.environ.get("LEGEND_SCHEDULER_SESSION_TTL_SECONDS", str(12 * 60 * 60))))
  except ValueError:
    return 12 * 60 * 60


def create_session(conn: sqlite3.Connection, user_id: str, pin: str = "") -> dict[str, Any]:
  row = conn.execute("SELECT id, name, role FROM users WHERE id = ? AND active = 1", (user_id,)).fetchone()
  if row is None:
    raise ValueError("Unknown or inactive user")
  verify_login_pin(user_id, pin)
  token = secrets.token_urlsafe(32)
  created_at = now()
  expires_at = created_at + session_ttl_seconds()
  conn.execute(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    (token, user_id, created_at, expires_at),
  )
  audit(conn, row["id"], row["role"], "auth.login", "user", row["id"])
  return {
    "token": token,
    "expiresAt": expires_at,
    "user": {"id": row["id"], "name": row["name"], "role": row["role"]},
  }


def session_user(conn: sqlite3.Connection, token: str) -> dict[str, str] | None:
  if not token:
    return None
  row = conn.execute(
    """
    SELECT users.id, users.name, users.role
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ? AND sessions.expires_at > ? AND users.active = 1
    """,
    (token, now()),
  ).fetchone()
  if row is None:
    return None
  return {"id": row["id"], "name": row["name"], "role": row["role"]}


def cleanup_expired_sessions(conn: sqlite3.Connection) -> int:
  cursor = conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now(),))
  return cursor.rowcount if cursor.rowcount is not None else 0


def session_status(conn: sqlite3.Connection) -> dict[str, int]:
  current = now()
  active = conn.execute("SELECT COUNT(*) FROM sessions WHERE expires_at > ?", (current,)).fetchone()[0]
  expired = conn.execute("SELECT COUNT(*) FROM sessions WHERE expires_at <= ?", (current,)).fetchone()[0]
  return {"active": int(active), "expired": int(expired)}


def delete_session(conn: sqlite3.Connection, token: str) -> None:
  if token:
    conn.execute("DELETE FROM sessions WHERE token = ?", (token,))


def parse_minutes(value: str) -> int:
  try:
    hours, minutes = str(value).split(":", 1)
    return int(hours) * 60 + int(minutes)
  except (TypeError, ValueError):
    return 0


def schedule_segments(order: dict[str, Any]) -> list[dict[str, Any]]:
  segments = order.get("segments") or []
  if isinstance(segments, list) and segments:
    return [segment for segment in segments if isinstance(segment, dict)]
  if order.get("techId") and order.get("scheduledDate") and order.get("start"):
    return [
      {
        "techId": order.get("techId"),
        "date": order.get("scheduledDate"),
        "start": order.get("start"),
        "duration": float(order.get("duration") or 0),
      }
    ]
  return []


def normalized_bay_availability(state: dict[str, Any], bay: str) -> dict[str, Any]:
  availability = (state.get("bayAvailability") or {}).get(bay) or {}
  return {
    "start": availability.get("start") or "08:00",
    "end": availability.get("end") or "17:00",
    "outages": availability.get("outages") or [],
  }


def bay_is_outaged(state: dict[str, Any], bay: str, day: str) -> bool:
  return any(outage.get("date") == day for outage in normalized_bay_availability(state, bay).get("outages") or [])


def validate_state_integrity(state: dict[str, Any]) -> list[dict[str, Any]]:
  findings: list[dict[str, Any]] = []
  orders = state.get("orders") or []
  technicians = state.get("technicians") or []
  bays = set(state.get("bays") or [])
  tech_by_id = {tech.get("id"): tech for tech in technicians}
  active_tech_ids = {tech.get("id") for tech in technicians if tech.get("active", True)}
  order_ids: set[str] = set()
  tech_blocks: dict[tuple[str, str], list[dict[str, Any]]] = {}
  bay_blocks: dict[tuple[str, str], list[dict[str, Any]]] = {}
  absences = {(absence.get("techId"), absence.get("date")) for absence in state.get("absences") or []}

  def add(level: str, code: str, message: str, entity_id: str = "") -> None:
    findings.append({"level": level, "code": code, "message": message, "entityId": entity_id})

  for order in orders:
    order_id = str(order.get("id") or "")
    if not order_id:
      add("error", "order.missing_id", "A work order is missing an id.")
      continue
    if order_id in order_ids:
      add("error", "order.duplicate_id", f"{order_id} is duplicated.", order_id)
    order_ids.add(order_id)
    if order.get("bay") and order.get("bay") not in bays:
      add("warning", "order.unknown_bay", f"{order_id} references unknown bay {order.get('bay')}.", order_id)
    if order.get("status") == "Scheduled" and order.get("parts") not in {"Ready", "Staged"}:
      add("warning", "schedule.parts_not_ready", f"{order_id} is scheduled while parts are {order.get('parts')}.", order_id)
    if order.get("status") == "Complete":
      blockers = completion_blockers(order)
      if blockers:
        add("error", "quality.complete_blocked", f"{order_id} is complete with unresolved quality blockers: {'; '.join(blockers)}", order_id)

    for segment in schedule_segments(order):
      tech_id = segment.get("techId")
      day = segment.get("date")
      earliest_start = order.get("earliestStartDate") or ""
      if earliest_start and day and day < earliest_start:
        add("error", "schedule.before_earliest_start", f"{order_id} is scheduled before earliest start date {earliest_start}.", order_id)
      start = parse_minutes(segment.get("start") or "")
      duration = float(segment.get("duration") or order.get("duration") or 0)
      end = start + round(duration * 60)
      tech = tech_by_id.get(tech_id)
      if tech_id not in active_tech_ids:
        add("error", "schedule.inactive_or_missing_tech", f"{order_id} is assigned to inactive or missing technician {tech_id}.", order_id)
        continue
      if (tech_id, day) in absences:
        add("error", "schedule.absent_tech", f"{order_id} is assigned to {tech.get('name')} on an absence day.", order_id)
      if start < parse_minutes(tech.get("start")) or end > parse_minutes(tech.get("end")):
        add("error", "schedule.outside_shift", f"{order_id} is outside {tech.get('name')}'s shift.", order_id)
      bay = order.get("bay") or ""
      bay_availability = normalized_bay_availability(state, bay)
      if bay_is_outaged(state, bay, day):
        add("error", "schedule.bay_unavailable", f"{order_id} is scheduled in {bay} on an outage day.", order_id)
      if start < parse_minutes(bay_availability.get("start")) or end > parse_minutes(bay_availability.get("end")):
        add("error", "schedule.outside_bay_availability", f"{order_id} is outside {bay} availability.", order_id)
      missing_skills = [skill for skill in order.get("skills") or [] if skill not in (tech.get("skills") or [])]
      if missing_skills:
        add("warning", "schedule.missing_skills", f"{order_id} is missing technician skills: {', '.join(missing_skills)}.", order_id)
      missing_certs = [
        cert for cert in order.get("requiredCertifications") or [] if cert not in (tech.get("certifications") or [])
      ]
      if missing_certs:
        add("warning", "schedule.missing_certifications", f"{order_id} is missing certifications: {', '.join(missing_certs)}.", order_id)

      block = {"orderId": order_id, "start": start, "end": end}
      tech_blocks.setdefault((tech_id, day), []).append(block)
      bay_blocks.setdefault((order.get("bay"), day), []).append(block)

  for (tech_id, day), blocks in tech_blocks.items():
    for previous, current in zip(sorted(blocks, key=lambda item: item["start"]), sorted(blocks, key=lambda item: item["start"])[1:]):
      if current["start"] < previous["end"]:
        add("error", "schedule.tech_overlap", f"{previous['orderId']} overlaps {current['orderId']} for technician {tech_id} on {day}.")
  for (bay, day), blocks in bay_blocks.items():
    for previous, current in zip(sorted(blocks, key=lambda item: item["start"]), sorted(blocks, key=lambda item: item["start"])[1:]):
      if current["start"] < previous["end"]:
        add("error", "schedule.bay_overlap", f"{previous['orderId']} overlaps {current['orderId']} in {bay} on {day}.")
  return findings


def completion_blockers(order: dict[str, Any]) -> list[str]:
  blockers: list[str] = []
  if order.get("qualityHold"):
    blockers.append("quality hold")
  if order.get("rework"):
    blockers.append("rework flag")
  open_operations = [str(item.get("name") or item.get("text") or item.get("id")) for item in order.get("operations") or [] if not item.get("done")]
  if open_operations:
    blockers.append(f"open operations {', '.join(open_operations)}")
  open_checklist = [str(item.get("text") or item.get("name") or item.get("id")) for item in order.get("checklist") or [] if not item.get("done")]
  if open_checklist:
    blockers.append(f"open checklist {', '.join(open_checklist)}")
  return blockers


def quality_completion_errors(state: dict[str, Any]) -> list[str]:
  errors: list[str] = []
  for order in state.get("orders") or []:
    if order.get("status") != "Complete":
      continue
    blockers = completion_blockers(order)
    if blockers:
      errors.append(f"{order.get('id') or 'work order'} cannot be completed: {'; '.join(blockers)}")
  return errors


def readiness_report(conn: sqlite3.Connection, db_path: Path) -> dict[str, Any]:
  state = get_state(conn)
  cleaned_sessions = cleanup_expired_sessions(conn)
  users = conn.execute("SELECT role, COUNT(*) AS count FROM users WHERE active = 1 GROUP BY role").fetchall()
  role_counts = {row["role"]: row["count"] for row in users}
  sessions = session_status(conn)
  errors = list_errors(conn, 20)
  findings = validate_state_integrity(state)
  backups = backup_status()
  checks = [
    {
      "name": "database",
      "ok": db_path.exists(),
      "detail": f"{db_path} ({db_path.stat().st_size if db_path.exists() else 0} bytes)",
    },
    {
      "name": "roles",
      "ok": all(role_counts.get(role, 0) for role in ROLES),
      "detail": ", ".join(f"{role}:{role_counts.get(role, 0)}" for role in sorted(ROLES)),
    },
    {
      "name": "sessions",
      "ok": sessions["expired"] == 0,
      "detail": f"{sessions['active']} active; {sessions['expired']} expired; {cleaned_sessions} cleaned",
    },
    {
      "name": "state",
      "ok": bool(state.get("orders")) and bool(state.get("technicians")) and bool(state.get("workTypes")),
      "detail": f"{len(state.get('orders') or [])} orders, {len(state.get('technicians') or [])} techs, {len(state.get('workTypes') or [])} work types",
    },
    {
      "name": "attachments",
      "ok": ATTACHMENTS_DIR.parent.exists(),
      "detail": str(ATTACHMENTS_DIR),
    },
    {
      "name": "state_integrity",
      "ok": not any(finding["level"] == "error" for finding in findings),
      "detail": f"{len(findings)} finding(s)",
    },
    {
      "name": "auto_backups",
      "ok": (not backups["enabled"]) or backups["writable"],
      "detail": f"{backups['count']} snapshot(s) in {backups['directory']}",
    },
  ]
  return {
    "ok": all(check["ok"] for check in checks),
    "environment": os.environ.get("LEGEND_SCHEDULER_ENV", "local"),
    "service": "legend-service-scheduler",
    "checks": checks,
    "findings": findings,
    "recentErrors": errors,
    "backups": backups,
    "stateMeta": state.get("_meta", {}),
  }


def readiness_report_supabase(store: SupabaseStore) -> dict[str, Any]:
  state = store.get_state()
  findings = validate_state_integrity(state)
  store.cleanup_expired_sessions()
  role_counts = store.role_counts()
  sessions = store.session_status()
  checks = [
    {"name": "database", "ok": True, "detail": "Supabase Postgres via PostgREST"},
    {
      "name": "roles",
      "ok": all(role_counts.get(role, 0) for role in ROLES),
      "detail": ", ".join(f"{role}:{role_counts.get(role, 0)}" for role in sorted(ROLES)),
    },
    {"name": "sessions", "ok": sessions["expired"] == 0, "detail": f"{sessions['active']} active; {sessions['expired']} expired"},
    {
      "name": "state",
      "ok": bool(state.get("orders")) and bool(state.get("technicians")) and bool(state.get("workTypes")),
      "detail": f"{len(state.get('orders') or [])} orders, {len(state.get('technicians') or [])} techs, {len(state.get('workTypes') or [])} work types",
    },
    {
      "name": "state_integrity",
      "ok": not any(finding["level"] == "error" for finding in findings),
      "detail": f"{len(findings)} finding(s)",
    },
    {"name": "audit_log", "ok": True, "detail": "scheduler_audit_log table reachable"},
    {"name": "error_log", "ok": True, "detail": f"{len(store.list_errors(20))} recent error event(s) readable"},
  ]
  return {
    "ok": all(check["ok"] for check in checks),
    "environment": os.environ.get("LEGEND_SCHEDULER_ENV", "local"),
    "service": "legend-service-scheduler",
    "database": "supabase",
    "checks": checks,
    "findings": findings,
    "recentErrors": store.list_errors(20),
    "stateMeta": state.get("_meta", {}),
  }


def create_backup(conn: sqlite3.Connection) -> dict[str, Any]:
  state_row = conn.execute("SELECT payload, version, updated_at, updated_by FROM app_state WHERE id = 1").fetchone()
  state = json.loads(state_row["payload"]) if state_row else default_state()
  audit_rows = conn.execute(
    "SELECT actor, role, action, entity_type, entity_id, payload, created_at FROM audit_log ORDER BY id"
  ).fetchall()
  import_rows = conn.execute(
    "SELECT source, records_imported, payload, created_at, created_by FROM salesforce_imports ORDER BY id"
  ).fetchall()
  error_rows = conn.execute(
    "SELECT source, message, detail, user_id, created_at FROM error_events ORDER BY id"
  ).fetchall()
  attachment_rows = conn.execute(
    "SELECT id, order_id, filename, content_type, size, storage_path, created_at, created_by FROM attachments ORDER BY created_at"
  ).fetchall()
  attachments = []
  for row in attachment_rows:
    storage_path = ATTACHMENTS_DIR / row["storage_path"]
    attachments.append(
      {
        "id": row["id"],
        "orderId": row["order_id"],
        "filename": row["filename"],
        "contentType": row["content_type"],
        "size": row["size"],
        "createdAt": row["created_at"],
        "createdBy": row["created_by"],
        "data": base64.b64encode(storage_path.read_bytes()).decode("ascii") if storage_path.exists() else "",
      }
    )
  return {
    "format": "legend-service-scheduler-backup-v1",
    "createdAt": now(),
    "state": state,
    "stateMeta": {
      "version": state_row["version"] if state_row else 1,
      "updatedAt": state_row["updated_at"] if state_row else now(),
      "updatedBy": state_row["updated_by"] if state_row else "system",
    },
    "auditLog": [
      {
        "actor": row["actor"],
        "role": row["role"],
        "action": row["action"],
        "entityType": row["entity_type"],
        "entityId": row["entity_id"],
        "payload": json.loads(row["payload"] or "{}"),
        "createdAt": row["created_at"],
      }
      for row in audit_rows
    ],
    "salesforceImports": [
      {
        "source": row["source"],
        "recordsImported": row["records_imported"],
        "payload": json.loads(row["payload"] or "{}"),
        "createdAt": row["created_at"],
        "createdBy": row["created_by"],
      }
      for row in import_rows
    ],
    "errorEvents": [
      {
        "source": row["source"],
        "message": row["message"],
        "detail": row["detail"],
        "userId": row["user_id"],
        "createdAt": row["created_at"],
      }
      for row in error_rows
    ],
    "attachments": attachments,
  }


def backup_retention_count() -> int:
  try:
    return max(1, int(os.environ.get("LEGEND_SCHEDULER_BACKUP_RETENTION", "20")))
  except ValueError:
    return 20


def auto_backups_enabled() -> bool:
  return os.environ.get("LEGEND_SCHEDULER_AUTO_BACKUP", "1").strip().lower() not in {"0", "false", "no"}


def backup_dir() -> Path:
  return Path(os.environ.get("LEGEND_SCHEDULER_BACKUP_DIR", str(BACKUPS_DIR)))


def list_backup_snapshots(path: Path | None = None) -> list[Path]:
  target = path or backup_dir()
  if not target.exists():
    return []
  return sorted(target.glob("scheduler-backup-v*.json"), key=lambda item: item.stat().st_mtime, reverse=True)


def backup_status(path: Path | None = None) -> dict[str, Any]:
  target = path or backup_dir()
  writable = False
  try:
    target.mkdir(parents=True, exist_ok=True)
    probe = target / ".write-test"
    probe.write_text("ok", encoding="utf-8")
    probe.unlink(missing_ok=True)
    writable = True
  except OSError:
    writable = False
  snapshots = list_backup_snapshots(target)
  latest = snapshots[0] if snapshots else None
  return {
    "enabled": auto_backups_enabled(),
    "directory": str(target),
    "writable": writable,
    "retention": backup_retention_count(),
    "count": len(snapshots),
    "latest": latest.name if latest else "",
    "latestBytes": latest.stat().st_size if latest else 0,
  }


def write_auto_backup(conn: sqlite3.Connection, version: int, action: str, directory: Path | None = None) -> Path | None:
  if not auto_backups_enabled():
    return None
  target = directory or backup_dir()
  target.mkdir(parents=True, exist_ok=True)
  backup = create_backup(conn)
  backup["autoBackup"] = {"version": version, "action": action, "createdAt": now()}
  path = target / f"scheduler-backup-v{version}-{now()}.json"
  path.write_text(json.dumps(backup, indent=2), encoding="utf-8")
  snapshots = list_backup_snapshots(target)
  for old in snapshots[backup_retention_count():]:
    old.unlink()
  return path


def create_backup_supabase(store: SupabaseStore) -> dict[str, Any]:
  state = store.get_state()
  state_meta = state.pop("_meta", {})
  return {
    "format": "legend-service-scheduler-backup-v1",
    "createdAt": now(),
    "database": "supabase",
    "state": state,
    "stateMeta": state_meta,
    "auditLog": store.list_audit(1000),
    "salesforceImports": store.list_salesforce_imports(),
    "errorEvents": store.list_errors(1000),
    "attachments": store.attachment_backup_rows(),
  }


def validate_backup_payload(backup: dict[str, Any]) -> dict[str, Any]:
  if not isinstance(backup, dict):
    raise ValueError("Backup payload must be an object")
  if backup.get("format") != "legend-service-scheduler-backup-v1":
    raise ValueError("Unsupported backup format")
  state = backup.get("state")
  if not isinstance(state, dict):
    raise ValueError("Backup state is missing")

  for section in ("auditLog", "salesforceImports", "errorEvents", "attachments"):
    rows = backup.get(section, [])
    if not isinstance(rows, list):
      raise ValueError(f"Backup {section} must be a list")
    if any(not isinstance(row, dict) for row in rows):
      raise ValueError(f"Backup {section} must contain objects")

  for attachment in backup.get("attachments", []):
    try:
      base64.b64decode(attachment.get("data") or "", validate=True)
    except (binascii.Error, TypeError, ValueError) as exc:
      raise ValueError("Backup attachment data is invalid") from exc

  findings = validate_state_integrity(state)
  errors = [finding for finding in findings if finding.get("level") == "error"]
  if errors:
    summary = "; ".join(f"{finding.get('code')}: {finding.get('message')}" for finding in errors[:3])
    raise ValueError(f"Backup state integrity failed: {summary}")
  return state


def restore_backup(conn: sqlite3.Connection, backup: dict[str, Any], actor: str, role: str) -> int:
  state = validate_backup_payload(backup)
  for row in conn.execute("SELECT storage_path FROM attachments").fetchall():
    path = ATTACHMENTS_DIR / row["storage_path"]
    if path.exists():
      path.unlink()
  conn.execute("DELETE FROM attachments")
  conn.execute("DELETE FROM salesforce_imports")
  conn.execute("DELETE FROM error_events")
  conn.execute("DELETE FROM audit_log")
  version = save_state(conn, state, actor, role, "backup.restore")
  for event in backup.get("auditLog", []):
    conn.execute(
      """
      INSERT INTO audit_log (actor, role, action, entity_type, entity_id, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      """,
      (
        event.get("actor", "system"),
        event.get("role", "admin"),
        event.get("action", "unknown"),
        event.get("entityType"),
        event.get("entityId"),
        json.dumps(event.get("payload", {}), separators=(",", ":")),
        int(event.get("createdAt") or now()),
      ),
    )
  for imported in backup.get("salesforceImports", []):
    conn.execute(
      "INSERT INTO salesforce_imports (source, records_imported, payload, created_at, created_by) VALUES (?, ?, ?, ?, ?)",
      (
        imported.get("source", "salesforce"),
        int(imported.get("recordsImported") or 0),
        json.dumps(imported.get("payload", {}), separators=(",", ":")),
        int(imported.get("createdAt") or now()),
        imported.get("createdBy", actor),
      ),
    )
  for error_event in backup.get("errorEvents", []):
    conn.execute(
      "INSERT INTO error_events (source, message, detail, user_id, created_at) VALUES (?, ?, ?, ?, ?)",
      (
        error_event.get("source", "unknown"),
        error_event.get("message", "Unknown error"),
        error_event.get("detail") or "",
        error_event.get("userId") or "",
        int(error_event.get("createdAt") or now()),
      ),
    )
  ATTACHMENTS_DIR.mkdir(parents=True, exist_ok=True)
  for attachment in backup.get("attachments", []):
    attachment_id = attachment.get("id") or f"att-{uuid.uuid4().hex[:12]}"
    filename = attachment.get("filename") or "attachment.bin"
    safe_name = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in filename) or "attachment.bin"
    storage_name = f"{attachment_id}-{safe_name}"
    data = base64.b64decode(attachment.get("data") or "")
    (ATTACHMENTS_DIR / storage_name).write_bytes(data)
    conn.execute(
      """
      INSERT INTO attachments (id, order_id, filename, content_type, size, storage_path, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      """,
      (
        attachment_id,
        attachment.get("orderId") or "",
        filename,
        attachment.get("contentType") or "application/octet-stream",
        len(data),
        storage_name,
        int(attachment.get("createdAt") or now()),
        attachment.get("createdBy") or actor,
      ),
    )
  audit(conn, actor, role, "backup.restore", "app_state", "1", {"version": version})
  return version


def reset_demo_state(conn: sqlite3.Connection, state: dict[str, Any], actor: str, role: str) -> int:
  if not isinstance(state, dict):
    raise ValueError("Seed state is missing")
  for row in conn.execute("SELECT storage_path FROM attachments").fetchall():
    path = ATTACHMENTS_DIR / row["storage_path"]
    if path.exists():
      path.unlink()
  conn.execute("DELETE FROM attachments")
  conn.execute("DELETE FROM salesforce_imports")
  conn.execute("DELETE FROM error_events")
  conn.execute("DELETE FROM audit_log")
  version = save_state(conn, state, actor, role, "demo.seed_reset")
  audit(conn, actor, role, "demo.seed_reset", "app_state", "1", {"version": version})
  return version


def restore_backup_supabase(store: SupabaseStore, backup: dict[str, Any], actor: str, role: str) -> int:
  state = validate_backup_payload(backup)
  version = store.save_state(state, actor, role, "backup.restore")
  store.restore_operational_tables(backup, actor)
  store.audit(actor, role, "backup.restore", "app_state", "1", {"version": version})
  return version


def reset_demo_state_supabase(store: SupabaseStore, state: dict[str, Any], actor: str, role: str) -> int:
  if not isinstance(state, dict):
    raise ValueError("Seed state is missing")
  store.restore_operational_tables({"auditLog": [], "salesforceImports": [], "errorEvents": [], "attachments": []}, actor)
  version = store.save_state(state, actor, role, "demo.seed_reset")
  store.audit(actor, role, "demo.seed_reset", "app_state", "1", {"version": version})
  return version


def save_attachment(
  conn: sqlite3.Connection,
  order_id: str,
  filename: str,
  content_type: str,
  data: bytes,
  actor: str,
  role: str,
) -> dict[str, Any]:
  if not order_id:
    raise ValueError("orderId is required")
  attachment_id = f"att-{uuid.uuid4().hex[:12]}"
  safe_name = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in filename) or "attachment.bin"
  storage_name = f"{attachment_id}-{safe_name}"
  ATTACHMENTS_DIR.mkdir(parents=True, exist_ok=True)
  (ATTACHMENTS_DIR / storage_name).write_bytes(data)
  created_at = now()
  conn.execute(
    """
    INSERT INTO attachments (id, order_id, filename, content_type, size, storage_path, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """,
    (attachment_id, order_id, filename, content_type, len(data), storage_name, created_at, actor),
  )
  audit(conn, actor, role, "attachment.upload", "work_order", order_id, {"attachmentId": attachment_id, "filename": filename})
  return {
    "id": attachment_id,
    "orderId": order_id,
    "name": filename,
    "type": content_type,
    "size": len(data),
    "addedAt": created_at,
    "addedBy": actor,
    "url": f"/api/attachments/{attachment_id}",
  }


class SchedulerHandler(SimpleHTTPRequestHandler):
  def __init__(self, *args: Any, db_path: Path = DB_PATH, **kwargs: Any) -> None:
    self.db_path = db_path
    super().__init__(*args, directory=str(APP_DIR), **kwargs)

  def do_GET(self) -> None:  # noqa: N802
    path = urlparse(self.path).path
    if path == "/api/health":
      if use_supabase():
        health = supabase_store().health()
        self.json_response({
          "ok": health["ok"],
          "service": "legend-service-scheduler",
          "environment": os.environ.get("LEGEND_SCHEDULER_ENV", "local"),
          **health,
        })
        return
      with connect(self.db_path) as conn:
        state_row = conn.execute("SELECT version, updated_at FROM app_state WHERE id = 1").fetchone()
        error_count = conn.execute("SELECT COUNT(*) FROM error_events").fetchone()[0]
      self.json_response({
        "ok": True,
        "service": "legend-service-scheduler",
        "environment": os.environ.get("LEGEND_SCHEDULER_ENV", "local"),
        "stateVersion": state_row["version"] if state_row else None,
        "stateUpdatedAt": state_row["updated_at"] if state_row else None,
        "errorCount": error_count,
      })
      return
    if path == "/api/readiness":
      if not self.require_authenticated_api():
        return
      if use_supabase():
        report = readiness_report_supabase(supabase_store())
        self.json_response(report, HTTPStatus.OK if report["ok"] else HTTPStatus.SERVICE_UNAVAILABLE)
        return
      with connect(self.db_path) as conn:
        report = readiness_report(conn, self.db_path)
      self.json_response(report, HTTPStatus.OK if report["ok"] else HTTPStatus.SERVICE_UNAVAILABLE)
      return
    if path == "/api/session":
      user = self.session_from_request()
      self.json_response({"user": user})
      return
    if path == "/api/state":
      if not self.require_authenticated_api():
        return
      if use_supabase():
        self.json_response(supabase_store().get_state())
        return
      with connect(self.db_path) as conn:
        self.json_response(get_state(conn))
      return
    if path == "/api/audit":
      authorized = self.require_authenticated_api()
      if not authorized:
        return
      actor, role = authorized
      if role not in {"admin", "manager"}:
        self.json_response({"error": "Audit log access denied"}, HTTPStatus.FORBIDDEN)
        return
      if use_supabase():
        self.json_response({"events": supabase_store().list_audit()})
        return
      with connect(self.db_path) as conn:
        self.json_response({"events": list_audit(conn)})
      return
    if path == "/api/errors":
      authorized = self.require_authenticated_api()
      if not authorized:
        return
      actor, role = authorized
      if role not in {"admin", "manager"}:
        self.json_response({"error": "Error log access denied"}, HTTPStatus.FORBIDDEN)
        return
      if use_supabase():
        self.json_response({"events": supabase_store().list_errors()})
        return
      with connect(self.db_path) as conn:
        self.json_response({"events": list_errors(conn)})
      return
    if path == "/api/backup":
      authorized = self.require_authenticated_api()
      if not authorized:
        return
      actor, role = authorized
      if role not in WRITE_ROLES:
        self.json_response({"error": "Backup access denied"}, HTTPStatus.FORBIDDEN)
        return
      if use_supabase():
        store = supabase_store()
        backup = create_backup_supabase(store)
        store.audit(actor, role, "backup.export", "app_state", "1", {"version": backup["stateMeta"].get("version")})
        self.json_response(backup)
        return
      with connect(self.db_path) as conn:
        backup = create_backup(conn)
        audit(conn, actor, role, "backup.export", "app_state", "1", {"version": backup["stateMeta"]["version"]})
      self.json_response(backup)
      return
    if path == "/api/export/salesforce":
      authorized = self.require_authenticated_api()
      if not authorized:
        return
      actor, role = authorized
      if role not in WRITE_ROLES:
        self.json_response({"error": "Salesforce export access denied"}, HTTPStatus.FORBIDDEN)
        return
      if use_supabase():
        store = supabase_store()
        payload = salesforce_export_payload(store.get_state())
        store.audit(actor, role, "salesforce.export", "app_state", "1", {"recordsExported": len(payload["records"])})
        self.json_response(payload)
        return
      with connect(self.db_path) as conn:
        payload = salesforce_export_payload(get_state(conn))
        audit(conn, actor, role, "salesforce.export", "app_state", "1", {"recordsExported": len(payload["records"])})
      self.json_response(payload)
      return
    if path == "/api/events":
      self.stream_events()
      return
    if path == "/api/attachments":
      authorized = self.require_authenticated_api()
      if not authorized:
        return
      actor, role = authorized
      query = parse_qs(urlparse(self.path).query)
      order_id = query.get("orderId", [""])[0]
      if use_supabase():
        store = supabase_store()
        if role == "technician" and not technician_can_access_order(store.get_state(), order_id, actor):
          self.json_response({"error": "Attachment access denied"}, HTTPStatus.FORBIDDEN)
          return
        self.json_response({"attachments": store.list_attachments(order_id)})
        return
      with connect(self.db_path) as conn:
        if role == "technician" and not technician_can_access_order(get_state(conn), order_id, actor):
          self.json_response({"error": "Attachment access denied"}, HTTPStatus.FORBIDDEN)
          return
        self.json_response({"attachments": list_attachments(conn, order_id)})
      return
    if path.startswith("/api/attachments/"):
      authorized = self.require_authenticated_api()
      if not authorized:
        return
      actor, role = authorized
      self.download_attachment(path.rsplit("/", 1)[-1], actor, role)
      return
    super().do_GET()

  def do_POST(self) -> None:  # noqa: N802
    path = urlparse(self.path).path
    if path == "/api/login":
      body = self.read_json()
      user_id = body.get("userId", "dispatcher")
      try:
        if use_supabase():
          store = supabase_store()
          store.cleanup_expired_sessions()
          session = store.create_session(user_id, str(body.get("pin") or ""))
        else:
          with connect(self.db_path) as conn:
            cleanup_expired_sessions(conn)
            session = create_session(conn, user_id, str(body.get("pin") or ""))
      except ValueError as error:
        self.json_response({"error": str(error)}, HTTPStatus.UNAUTHORIZED)
        return
      self.json_response({"ok": True, **session})
      return
    if path == "/api/logout":
      token = self.bearer_token()
      if use_supabase():
        store = supabase_store()
        user = store.session_user(token)
        if user:
          store.audit(user["id"], user["role"], "auth.logout", "user", user["id"])
        store.delete_session(token)
      else:
        with connect(self.db_path) as conn:
          user = session_user(conn, token)
          if user:
            audit(conn, user["id"], user["role"], "auth.logout", "user", user["id"])
          delete_session(conn, token)
      self.json_response({"ok": True})
      return
    actor, role = self.actor()
    if role not in ROLES:
      self.json_response({"error": "Invalid role"}, HTTPStatus.FORBIDDEN)
      return
    if path == "/api/errors":
      body = self.read_json()
      if use_supabase():
        store = supabase_store()
        detail = json.dumps(body.get("detail") or {}, separators=(",", ":")) if not isinstance(body.get("detail"), str) else body.get("detail")
        store.record_error(str(body.get("source") or "frontend"), str(body.get("message") or "Unknown frontend error"), detail, actor)
        store.audit(actor, role, "error.report", "error_event", None, {"source": body.get("source") or "frontend"})
        self.json_response({"ok": True})
        return
      with connect(self.db_path) as conn:
        record_error(
          conn,
          str(body.get("source") or "frontend"),
          str(body.get("message") or "Unknown frontend error"),
          json.dumps(body.get("detail") or {}, separators=(",", ":")) if not isinstance(body.get("detail"), str) else body.get("detail"),
          actor,
        )
        audit(conn, actor, role, "error.report", "error_event", None, {"source": body.get("source") or "frontend"})
      self.json_response({"ok": True})
      return
    if path == "/api/state":
      body = self.read_json()
      query = parse_qs(urlparse(self.path).query)
      action = query.get("action", ["state.save"])[0]
      if use_supabase():
        store = supabase_store()
        current_state = store.get_state()
        if role not in WRITE_ROLES:
          if role != "technician":
            self.json_response({"error": "Write access denied"}, HTTPStatus.FORBIDDEN)
            return
          errors = validate_technician_state_change(current_state, body, actor)
          if errors:
            self.json_response({"error": "Technician update denied", "details": errors}, HTTPStatus.FORBIDDEN)
            return
        elif role == "dispatcher":
          errors = validate_dispatcher_state_change(current_state, body)
          if errors:
            self.json_response({"error": "Dispatcher update denied", "details": errors}, HTTPStatus.FORBIDDEN)
            return
        quality_errors = quality_completion_errors(body)
        if quality_errors:
          self.json_response({"error": "Quality completion denied", "details": quality_errors}, HTTPStatus.BAD_REQUEST)
          return
        version = store.save_state(body, actor, role, action)
        self.json_response({"ok": True, "version": version})
        return
      with connect(self.db_path) as conn:
        current_state = get_state(conn)
        if role not in WRITE_ROLES:
          if role != "technician":
            self.json_response({"error": "Write access denied"}, HTTPStatus.FORBIDDEN)
            return
          errors = validate_technician_state_change(current_state, body, actor)
          if errors:
            self.json_response({"error": "Technician update denied", "details": errors}, HTTPStatus.FORBIDDEN)
            return
        elif role == "dispatcher":
          errors = validate_dispatcher_state_change(current_state, body)
          if errors:
            self.json_response({"error": "Dispatcher update denied", "details": errors}, HTTPStatus.FORBIDDEN)
            return
        quality_errors = quality_completion_errors(body)
        if quality_errors:
          self.json_response({"error": "Quality completion denied", "details": quality_errors}, HTTPStatus.BAD_REQUEST)
          return
        version = save_state(conn, body, actor, role, action)
      self.json_response({"ok": True, "version": version})
      return
    if path == "/api/import/salesforce":
      if role not in WRITE_ROLES:
        self.json_response({"error": "Import access denied"}, HTTPStatus.FORBIDDEN)
        return
      body = self.read_json()
      if use_supabase():
        store = supabase_store()
        current = store.get_state()
        imported = normalize_salesforce_import(body)
        current.setdefault("orders", []).extend(imported)
        quality_errors = quality_completion_errors(current)
        if quality_errors:
          self.json_response({"error": "Quality completion denied", "details": quality_errors}, HTTPStatus.BAD_REQUEST)
          return
        version = store.save_state(current, actor, role, "salesforce.import")
        store.record_salesforce_import(body, len(imported), actor)
        store.audit(actor, role, "salesforce.import.detail", "app_state", "1", {"version": version, "recordsImported": len(imported)})
        self.json_response({"ok": True, "recordsImported": len(imported), "version": version})
        return
      with connect(self.db_path) as conn:
        current = get_state(conn)
        imported = normalize_salesforce_import(body)
        current.setdefault("orders", []).extend(imported)
        quality_errors = quality_completion_errors(current)
        if quality_errors:
          self.json_response({"error": "Quality completion denied", "details": quality_errors}, HTTPStatus.BAD_REQUEST)
          return
        version = save_state(conn, current, actor, role, "salesforce.import")
        conn.execute(
          "INSERT INTO salesforce_imports (source, records_imported, payload, created_at, created_by) VALUES (?, ?, ?, ?, ?)",
          ("salesforce", len(imported), json.dumps(body, separators=(",", ":")), now(), actor),
        )
        audit(conn, actor, role, "salesforce.import.detail", "app_state", "1", {"version": version, "recordsImported": len(imported)})
      self.json_response({"ok": True, "recordsImported": len(imported), "version": version})
      return
    if path == "/api/demo/reset":
      if role not in WRITE_ROLES:
        self.json_response({"error": "Demo reset access denied"}, HTTPStatus.FORBIDDEN)
        return
      body = self.read_json()
      state = body.get("state") if "state" in body else body
      quality_errors = quality_completion_errors(state)
      if quality_errors:
        self.json_response({"error": "Quality completion denied", "details": quality_errors}, HTTPStatus.BAD_REQUEST)
        return
      try:
        if use_supabase():
          version = reset_demo_state_supabase(supabase_store(), state, actor, role)
          self.json_response({"ok": True, "version": version})
          return
        with connect(self.db_path) as conn:
          version = reset_demo_state(conn, state, actor, role)
      except ValueError as error:
        self.json_response({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        return
      self.json_response({"ok": True, "version": version})
      return
    if path == "/api/attachments":
      if role not in WRITE_ROLES and role != "technician":
        self.json_response({"error": "Attachment access denied"}, HTTPStatus.FORBIDDEN)
        return
      query = parse_qs(urlparse(self.path).query)
      order_id = query.get("orderId", [""])[0]
      filename = query.get("filename", ["attachment.bin"])[0]
      content_type = self.headers.get("Content-Type", "application/octet-stream")
      size = int(self.headers.get("Content-Length", "0"))
      raw = self.rfile.read(size)
      if use_supabase():
        store = supabase_store()
        if role == "technician" and not technician_can_access_order(store.get_state(), order_id, actor):
          self.json_response({"error": "Attachment access denied"}, HTTPStatus.FORBIDDEN)
          return
        attachment = store.save_attachment(order_id, filename, content_type, raw, actor, role)
      else:
        with connect(self.db_path) as conn:
          if role == "technician" and not technician_can_access_order(get_state(conn), order_id, actor):
            self.json_response({"error": "Attachment access denied"}, HTTPStatus.FORBIDDEN)
            return
          attachment = save_attachment(conn, order_id, filename, content_type, raw, actor, role)
      self.json_response({"ok": True, "attachment": attachment})
      return
    if path == "/api/restore":
      if role not in {"admin", "manager"}:
        self.json_response({"error": "Restore access denied"}, HTTPStatus.FORBIDDEN)
        return
      body = self.read_json()
      try:
        if use_supabase():
          version = restore_backup_supabase(supabase_store(), body, actor, role)
          self.json_response({"ok": True, "version": version})
          return
        with connect(self.db_path) as conn:
          version = restore_backup(conn, body, actor, role)
      except ValueError as error:
        self.json_response({"error": str(error)}, HTTPStatus.BAD_REQUEST)
        return
      self.json_response({"ok": True, "version": version})
      return
    self.json_response({"error": "Not found"}, HTTPStatus.NOT_FOUND)

  def actor(self) -> tuple[str, str]:
    if self.bearer_token() and not self.session_from_request():
      return "", "invalid"
    user = self.session_from_request()
    if user:
      return user["id"], user["role"]
    if auth_mode() == "pin":
      return "", "invalid"
    actor = self.headers.get("X-User", "dispatcher")
    role = self.headers.get("X-Role", "dispatcher")
    return actor, role

  def require_authenticated_api(self) -> tuple[str, str] | None:
    actor, role = self.actor()
    if role not in ROLES:
      self.json_response({"error": "Authentication required"}, HTTPStatus.UNAUTHORIZED)
      return None
    return actor, role

  def bearer_token(self) -> str:
    auth = self.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
      return ""
    return auth.split(" ", 1)[1].strip()

  def session_from_request(self) -> dict[str, str] | None:
    token = self.bearer_token()
    if not token:
      return None
    if use_supabase():
      return supabase_store().session_user(token)
    with connect(self.db_path) as conn:
      return session_user(conn, token)

  def read_json(self) -> dict[str, Any]:
    length = int(self.headers.get("Content-Length", "0"))
    if length == 0:
      return {}
    raw = self.rfile.read(length)
    return json.loads(raw.decode("utf-8"))

  def json_response(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
    data = json.dumps(payload, indent=2).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json")
    self.send_header("Content-Length", str(len(data)))
    self.end_headers()
    self.wfile.write(data)

  def stream_events(self) -> None:
    self.send_response(HTTPStatus.OK)
    self.send_header("Content-Type", "text/event-stream")
    self.send_header("Cache-Control", "no-cache")
    self.send_header("Connection", "keep-alive")
    self.end_headers()
    last_version = None
    for _ in range(120):
      if use_supabase():
        row = supabase_store().row("scheduler_state", "?id=eq.1&select=version,updated_at,updated_by")
        version = row.get("version") if row else None
        updated_at = row.get("updated_at") if row else None
        updated_by = row.get("updated_by") if row else None
      else:
        with connect(self.db_path) as conn:
          row = conn.execute("SELECT version, updated_at, updated_by FROM app_state WHERE id = 1").fetchone()
        version = row["version"] if row else None
        updated_at = row["updated_at"] if row else None
        updated_by = row["updated_by"] if row else None
      if version and version != last_version:
        last_version = version
        payload = {"version": version, "updatedAt": updated_at, "updatedBy": updated_by}
        self.wfile.write(f"event: state\n".encode("utf-8"))
        self.wfile.write(f"data: {json.dumps(payload, separators=(',', ':'))}\n\n".encode("utf-8"))
        self.wfile.flush()
      time.sleep(1)

  def download_attachment(self, attachment_id: str, actor: str, role: str) -> None:
    if use_supabase():
      store = supabase_store()
      attachment = store.get_attachment(attachment_id)
      if attachment is None:
        self.json_response({"error": "Attachment not found"}, HTTPStatus.NOT_FOUND)
        return
      if role == "technician" and not technician_can_access_order(store.get_state(), attachment.get("orderId") or "", actor):
        self.json_response({"error": "Attachment access denied"}, HTTPStatus.FORBIDDEN)
        return
      data = attachment["data"]
      self.send_response(HTTPStatus.OK)
      self.send_header("Content-Type", attachment["contentType"])
      self.send_header("Content-Length", str(len(data)))
      self.send_header("Content-Disposition", f'attachment; filename="{attachment["filename"]}"')
      self.end_headers()
      self.wfile.write(data)
      return
    with connect(self.db_path) as conn:
      row = conn.execute("SELECT order_id, filename, content_type, size, storage_path FROM attachments WHERE id = ?", (attachment_id,)).fetchone()
      state = get_state(conn) if role == "technician" else None
    if row is None:
      self.json_response({"error": "Attachment not found"}, HTTPStatus.NOT_FOUND)
      return
    if role == "technician" and not technician_can_access_order(state or {}, row["order_id"], actor):
      self.json_response({"error": "Attachment access denied"}, HTTPStatus.FORBIDDEN)
      return
    path = ATTACHMENTS_DIR / row["storage_path"]
    if not path.exists():
      self.json_response({"error": "Attachment file missing"}, HTTPStatus.NOT_FOUND)
      return
    data = path.read_bytes()
    self.send_response(HTTPStatus.OK)
    self.send_header("Content-Type", row["content_type"])
    self.send_header("Content-Length", str(len(data)))
    self.send_header("Content-Disposition", f'attachment; filename="{row["filename"]}"')
    self.end_headers()
    self.wfile.write(data)


def normalize_salesforce_import(payload: dict[str, Any]) -> list[dict[str, Any]]:
  records = payload.get("records", payload if isinstance(payload, list) else [])
  output = []
  for idx, record in enumerate(records):
    work_type = record.get("workType") or record.get("WorkType") or record.get("Type") or "Warranty Repair"
    segments = list_field(record.get("segments") or record.get("ScheduleSegments"))
    status = record.get("status") or record.get("Status") or ("Scheduled" if segments else "Unscheduled")
    output.append(
      {
        "id": record.get("id") or record.get("Id") or f"SF-{idx + 1:04d}",
        "title": record.get("title") or record.get("Subject") or record.get("WorkOrderNumber") or "Salesforce Work Order",
        "customer": record.get("customer") or record.get("CustomerName") or record.get("AccountName") or "",
        "dealer": record.get("dealer") or record.get("DealerName") or record.get("Dealer") or "",
        "boat": record.get("boat") or record.get("AssetName") or record.get("UnitName") or record.get("AccountName") or "Salesforce import",
        "description": record.get("description") or record.get("Description") or "",
        "workType": work_type,
        "priority": record.get("priority") or record.get("Priority") or "Medium",
        "customerUrgency": record.get("customerUrgency") or record.get("CustomerUrgency") or record.get("Urgency") or "Normal",
        "dueDate": record.get("dueDate") or record.get("DueDate") or "",
        "earliestStartDate": record.get("earliestStartDate") or record.get("EarliestStartDate") or record.get("ReadyDate") or record.get("DropoffDate") or record.get("ArrivalDate") or "",
        "duration": float(record.get("duration") or record.get("EstimatedDuration") or 2),
        "durationLocked": bool(record.get("duration") or record.get("EstimatedDuration")),
        "skills": list_field(record.get("skills") or record.get("Skills") or record.get("RequiredSkills")),
        "requiredCertifications": list_field(record.get("requiredCertifications") or record.get("RequiredCertifications")),
        "preferredTechId": record.get("preferredTechId") or record.get("PreferredTechnicianId") or "",
        "continuityTechId": record.get("continuityTechId") or record.get("ContinuityTechId") or "",
        "parts": record.get("parts") or record.get("PartsReadiness") or "Ready",
        "bay": record.get("bay") or record.get("Bay") or record.get("ServiceTerritory") or "Service Bay 1",
        "status": status,
        "techId": record.get("techId") or record.get("AssignedTechnicianId") or (segments[0].get("techId") if segments else ""),
        "scheduledDate": record.get("scheduledDate") or record.get("ScheduledDate") or (segments[0].get("date") if segments else ""),
        "start": record.get("start") or record.get("ScheduledStart") or (segments[0].get("start") if segments else ""),
        "segments": segments,
        "notes": record.get("notes") or record.get("Notes") or "Imported from Salesforce",
        "operations": list_field(record.get("operations") or record.get("Operations")),
        "checklist": list_field(record.get("checklist") or record.get("Checklist")),
        "dependencies": record.get("dependencies") or record.get("Dependencies") or "",
        "actualHours": float(record.get("actualHours") or record.get("ActualHours") or 0),
        "timeEntries": list_field(record.get("timeEntries") or record.get("TimeEntries")),
        "rework": bool_field(record.get("rework", record.get("ReworkFlag"))),
        "qualityHold": bool_field(record.get("qualityHold", record.get("QualityHold"))),
        "unitHistory": list_field(record.get("unitHistory") or record.get("UnitHistory"), ["Imported from Salesforce"]),
        "attachments": [normalize_salesforce_attachment(item) for item in list_field(record.get("attachments") or record.get("Attachments"))],
      }
    )
  return output


def list_field(value: Any, fallback: list[Any] | None = None) -> list[Any]:
  if isinstance(value, list):
    return value
  if isinstance(value, str) and value.strip():
    return [item.strip() for item in value.split(",") if item.strip()]
  return list(fallback or [])


def bool_field(value: Any) -> bool:
  if isinstance(value, bool):
    return value
  if isinstance(value, str):
    return value.lower() in {"true", "yes", "1"}
  return bool(value)


def normalize_salesforce_attachment(attachment: dict[str, Any]) -> dict[str, Any]:
  return {
    "id": attachment.get("id") or attachment.get("Id") or f"att-{uuid.uuid4().hex[:12]}",
    "name": attachment.get("name") or attachment.get("Name") or attachment.get("Filename") or "Salesforce attachment",
    "type": attachment.get("type") or attachment.get("ContentType") or "unknown",
    "size": int(attachment.get("size") or attachment.get("Size") or 0),
    "url": attachment.get("url") or attachment.get("Url") or "",
    "addedAt": attachment.get("addedAt") or attachment.get("CreatedDate") or now(),
  }


def salesforce_export_payload(state: dict[str, Any]) -> dict[str, Any]:
  technicians = {tech.get("id"): tech for tech in state.get("technicians", []) if tech.get("id")}
  records = []
  for order in state.get("orders", []):
    tech = technicians.get(order.get("techId")) or {}
    records.append(
      {
        "Id": order.get("id"),
        "WorkOrderNumber": order.get("id"),
        "Subject": order.get("title") or order.get("id"),
        "Description": order.get("description") or order.get("notes") or "",
        "AccountName": order.get("customer") or order.get("boat") or "",
        "DealerName": order.get("dealer") or "",
        "AssetName": order.get("boat") or "",
        "WorkType": order.get("workType") or "",
        "Status": order.get("status") or "Unscheduled",
        "Priority": order.get("priority") or "Medium",
        "CustomerUrgency": order.get("customerUrgency") or "Normal",
        "DueDate": order.get("dueDate") or "",
        "EarliestStartDate": order.get("earliestStartDate") or "",
        "EstimatedDuration": float(order.get("duration") or 0),
        "ActualHours": float(order.get("actualHours") or 0),
        "TimeEntries": order.get("timeEntries") or [],
        "PartsReadiness": order.get("parts") or "",
        "ServiceTerritory": order.get("bay") or "",
        "Bay": order.get("bay") or "",
        "AssignedTechnicianId": order.get("techId") or "",
        "AssignedTechnicianName": tech.get("name") or "",
        "ScheduledDate": order.get("scheduledDate") or "",
        "ScheduledStart": order.get("start") or "",
        "RequiredSkills": order.get("skills") or [],
        "RequiredCertifications": order.get("requiredCertifications") or [],
        "PreferredTechnicianId": order.get("preferredTechId") or "",
        "ContinuityTechnicianId": order.get("continuityTechId") or "",
        "ReworkFlag": bool(order.get("rework")),
        "QualityHold": bool(order.get("qualityHold")),
        "Dependencies": order.get("dependencies") or "",
        "ScheduleSegments": order.get("segments") or [],
        "Operations": order.get("operations") or [],
        "Checklist": order.get("checklist") or [],
        "UnitHistory": order.get("unitHistory") or [],
        "Attachments": [
          {
            "Name": attachment.get("name"),
            "ContentType": attachment.get("type"),
            "Size": attachment.get("size"),
            "Url": attachment.get("url") or "",
          }
          for attachment in order.get("attachments", [])
        ],
      }
    )
  return {
    "format": "legend-service-scheduler-salesforce-export-v1",
    "exportedAt": now(),
    "source": "legend-service-scheduler",
    "records": records,
  }


def serve(host: str, port: int, db_path: Path) -> None:
  if use_supabase():
    supabase_store().init()
  else:
    init_db(db_path)

  class BoundHandler(SchedulerHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
      super().__init__(*args, db_path=db_path, **kwargs)

  httpd = ThreadingHTTPServer((host, port), BoundHandler)
  print(f"Legend Service Scheduler running at http://{host}:{port}")
  httpd.serve_forever()


def main() -> None:
  parser = argparse.ArgumentParser()
  parser.add_argument("--host", default="127.0.0.1")
  parser.add_argument("--port", type=int, default=4173)
  parser.add_argument("--db", type=Path, default=DB_PATH)
  parser.add_argument("--init-only", action="store_true")
  args = parser.parse_args()
  if use_supabase():
    supabase_store().init()
  else:
    init_db(args.db)
  if not args.init_only:
    serve(args.host, args.port, args.db)


if __name__ == "__main__":
  main()
