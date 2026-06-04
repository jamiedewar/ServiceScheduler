#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("backend", ROOT / "backend.py")
backend = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(backend)


class FakeResponse:
  def __init__(self, payload):
    self.payload = payload

  def __enter__(self):
    return self

  def __exit__(self, *_):
    return False

  def read(self):
    return json.dumps(self.payload).encode("utf-8")


def run_supabase_validation() -> None:
  tables = {
    "scheduler_state": [],
    "scheduler_users": [],
    "scheduler_sessions": [],
    "scheduler_audit_log": [],
    "scheduler_error_events": [],
    "scheduler_salesforce_imports": [],
    "scheduler_attachments": [],
  }

  def fake_urlopen(req, timeout=10):
    parsed = urlparse(req.full_url)
    table = parsed.path.rsplit("/", 1)[-1]
    query = parse_qs(parsed.query)
    method = req.get_method()
    body = json.loads(req.data.decode("utf-8")) if req.data else None
    if method == "GET":
      rows = list(tables[table])
      if "id" in query and query["id"][0].startswith("eq."):
        wanted = query["id"][0].split(".", 1)[1]
        rows = [row for row in rows if str(row.get("id")) == wanted]
      if "token" in query and query["token"][0].startswith("eq."):
        wanted = query["token"][0].split(".", 1)[1]
        rows = [row for row in rows if str(row.get("token")) == wanted]
      if "order_id" in query and query["order_id"][0].startswith("eq."):
        wanted = query["order_id"][0].split(".", 1)[1]
        rows = [row for row in rows if str(row.get("order_id")) == wanted]
      if query.get("order", [""])[0] == "id.desc":
        rows = sorted(rows, key=lambda row: row.get("id", 0), reverse=True)
      if query.get("order", [""])[0] == "created_at.desc":
        rows = sorted(rows, key=lambda row: row.get("created_at", 0), reverse=True)
      if query.get("order", [""])[0] == "created_at.asc":
        rows = sorted(rows, key=lambda row: row.get("created_at", 0))
      if "limit" in query:
        rows = rows[:int(query["limit"][0])]
      return FakeResponse(rows)
    if method == "POST":
      row = dict(body)
      if table == "scheduler_state":
        existing = next((item for item in tables[table] if item.get("id") == row.get("id")), None)
        if existing:
          existing.update(row)
        else:
          tables[table].append(row)
      else:
        row["id"] = row.get("id") or len(tables[table]) + 1
        tables[table].append(row)
      return FakeResponse([row])
    if method == "DELETE":
      if "token" in query and query["token"][0].startswith("eq."):
        wanted = query["token"][0].split(".", 1)[1]
        tables[table] = [row for row in tables[table] if str(row.get("token")) != wanted]
      elif "expires_at" in query and query["expires_at"][0].startswith("lte."):
        cutoff = int(query["expires_at"][0].split(".", 1)[1])
        tables[table] = [row for row in tables[table] if int(row.get("expires_at") or 0) > cutoff]
      elif query.get("id", [""])[0] == "not.is.null":
        tables[table] = []
      return FakeResponse([])
    raise AssertionError(f"Unexpected Supabase method {method}")

  old_urlopen = backend.urlopen
  old_env = {
    key: os.environ.get(key)
    for key in [
      "LEGEND_SCHEDULER_DB",
      "SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "LEGEND_SCHEDULER_AUTH",
      "LEGEND_SCHEDULER_PIN_DISPATCHER",
    ]
  }
  backend.urlopen = fake_urlopen
  os.environ["LEGEND_SCHEDULER_DB"] = "supabase"
  os.environ["SUPABASE_URL"] = "https://example.supabase.co"
  os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "service-role-key"
  try:
    store = backend.supabase_store()
    store.init()
    assert store.role_counts()["dispatcher"] == 1
    session = store.create_session("dispatcher")
    assert session["token"]
    assert store.session_user(session["token"])["role"] == "dispatcher"
    tables["scheduler_sessions"].append({"token": "expired-supa", "user_id": "dispatcher", "created_at": 1, "expires_at": 1})
    assert store.session_status()["expired"] == 1
    store.cleanup_expired_sessions()
    assert store.session_status()["expired"] == 0
    store.delete_session(session["token"])
    assert store.session_user(session["token"]) is None
    os.environ["LEGEND_SCHEDULER_AUTH"] = "pin"
    os.environ["LEGEND_SCHEDULER_PIN_DISPATCHER"] = "2468"
    try:
      store.create_session("dispatcher", "0000")
      raise AssertionError("wrong Supabase PIN should fail")
    except ValueError as error:
      assert "Invalid PIN" in str(error)
    pinned_session = store.create_session("dispatcher", "2468")
    assert store.session_user(pinned_session["token"])["id"] == "dispatcher"
    store.audit("dispatcher", "dispatcher", "auth.logout", "user", "dispatcher")
    assert any(event["action"] == "auth.logout" and event["entityId"] == "dispatcher" for event in store.list_audit())
    os.environ.pop("LEGEND_SCHEDULER_AUTH", None)
    os.environ.pop("LEGEND_SCHEDULER_PIN_DISPATCHER", None)
    state = store.get_state()
    state["bays"] = ["Service Bay 1"]
    state["technicians"] = [{
      "id": "tech-supa",
      "name": "Supabase Tech",
      "role": "Technician",
      "skills": ["Mechanical"],
      "certifications": [],
      "start": "08:00",
      "end": "16:30",
      "capacity": 100,
      "area": "Service",
      "active": True,
    }]
    state["userTechnicianLinks"] = {"technician": "tech-supa"}
    state["workTypes"] = [{"id": "type-supa", "name": "Mechanical Inspection", "duration": 2, "skills": ["Mechanical"]}]
    state["orders"] = [{
      "id": "WO-SUPA",
      "title": "Supabase order",
      "status": "Unscheduled",
      "parts": "Ready",
      "bay": "Service Bay 1",
      "duration": 2,
      "skills": ["Mechanical"],
    }]
    version = store.save_state(state, "dispatcher", "dispatcher", "test.supabase_seed")
    assert version == 2
    state["orders"][0].update({
      "status": "Scheduled",
      "techId": "tech-supa",
      "scheduledDate": "2026-06-03",
      "start": "08:00",
      "segments": [{"techId": "tech-supa", "date": "2026-06-03", "start": "08:00", "duration": 2}],
    })
    store.save_state(state, "dispatcher", "dispatcher", "test.supabase_schedule")
    audit_events = store.list_audit()
    assert any(event["action"] == "schedule.change" and event["entityId"] == "WO-SUPA" for event in audit_events)
    manager_state = store.get_state()
    manager_state["technicians"][0]["capacity"] = 85
    manager_state["workTypes"][0]["duration"] = 3
    manager_state["bays"].append("Supabase Detail Bay")
    manager_state["bayAvailability"] = {
      "Service Bay 1": {"start": "08:00", "end": "15:00", "outages": [{"date": "2026-06-05", "reason": "Maintenance"}]}
    }
    store.save_state(manager_state, "manager", "manager", "test.supabase_master_data")
    master_events = store.list_audit()
    technician_event = next(event for event in master_events if event["action"] == "technician.update" and event["entityId"] == "tech-supa")
    assert technician_event["payload"]["changes"]["capacity"]["before"] == 100
    assert technician_event["payload"]["changes"]["capacity"]["after"] == 85
    assert any(event["action"] == "work_type.update" and event["entityId"] == "type-supa" for event in master_events)
    assert any(event["action"] == "resource.create" and event["entityId"] == "Supabase Detail Bay" for event in master_events)
    assert any(event["action"] == "resource.update" and event["entityId"] == "Service Bay 1" for event in master_events)
    store.record_error("frontend", "Supabase browser error", "{}", "dispatcher")
    assert store.list_errors()[0]["message"] == "Supabase browser error"
    attachment = store.save_attachment("WO-SUPA", "supabase-photo.jpg", "image/jpeg", b"supabase-bytes", "dispatcher", "dispatcher")
    assert attachment["orderId"] == "WO-SUPA"
    assert attachment["url"].startswith("/api/attachments/")
    listed = store.list_attachments("WO-SUPA")
    assert len(listed) == 1
    assert listed[0]["name"] == "supabase-photo.jpg"
    downloaded = store.get_attachment(attachment["id"])
    assert downloaded is not None
    assert downloaded["orderId"] == "WO-SUPA"
    assert downloaded["data"] == b"supabase-bytes"
    readiness = backend.readiness_report_supabase(store)
    assert readiness["ok"], readiness
    backup = backend.create_backup_supabase(store)
    assert backup["database"] == "supabase"
    assert backup["state"]["orders"][0]["id"] == "WO-SUPA"
    assert any(row["filename"] == "supabase-photo.jpg" and row["data"] for row in backup["attachments"])
    invalid_backup = json.loads(json.dumps(backup))
    invalid_backup["auditLog"] = {}
    try:
      backend.restore_backup_supabase(store, invalid_backup, "manager", "manager")
      raise AssertionError("Supabase restore accepted malformed audit log")
    except ValueError as exc:
      assert "auditLog must be a list" in str(exc)
    assert store.get_state()["orders"][0]["id"] == "WO-SUPA"
    mutated = store.get_state()
    mutated["orders"] = [{"id": "WO-SUPA-MUTATED", "title": "Mutated Supabase order"}]
    store.save_state(mutated, "dispatcher", "dispatcher", "test.supabase_mutate")
    store.record_error("frontend", "Mutation error", "{}", "dispatcher")
    store.save_attachment("WO-SUPA-MUTATED", "mutation.jpg", "image/jpeg", b"mutation-bytes", "dispatcher", "dispatcher")
    restored_version = backend.restore_backup_supabase(store, backup, "manager", "manager")
    assert restored_version > 0
    restored = store.get_state()
    assert restored["orders"][0]["id"] == "WO-SUPA"
    assert not any(order.get("id") == "WO-SUPA-MUTATED" for order in restored["orders"])
    assert any(event["action"] == "backup.restore" for event in store.list_audit())
    assert any(event["action"] == "schedule.change" and event["entityId"] == "WO-SUPA" for event in store.list_audit())
    assert any(event["message"] == "Supabase browser error" for event in store.list_errors())
    assert not any(event["message"] == "Mutation error" for event in store.list_errors())
    restored_attachments = store.list_attachments("WO-SUPA")
    assert len(restored_attachments) == 1
    assert restored_attachments[0]["name"] == "supabase-photo.jpg"
    assert store.get_attachment(attachment["id"])["data"] == b"supabase-bytes"
    seed_state = backend.default_state()
    seed_state["bays"] = ["Service Bay 1"]
    seed_state["technicians"] = [{
      "id": "tech-supa-seed",
      "name": "Supabase Seed Tech",
      "role": "Technician",
      "skills": ["Mechanical"],
      "certifications": [],
      "start": "08:00",
      "end": "16:00",
      "capacity": 100,
      "area": "Service",
      "active": True,
    }]
    seed_state["workTypes"] = [{"id": "type-supa-seed", "name": "Seed Service", "duration": 2, "skills": ["Mechanical"]}]
    seed_state["orders"] = [{"id": "WO-SUPA-SEED", "title": "Supabase seed order", "status": "Unscheduled", "parts": "Ready"}]
    reset_version = backend.reset_demo_state_supabase(store, seed_state, "manager", "manager")
    assert reset_version > 0
    assert store.get_state()["orders"][0]["id"] == "WO-SUPA-SEED"
    assert store.list_attachments("WO-SUPA") == []
    assert store.list_errors() == []
    assert any(event["action"] == "demo.seed_reset" for event in store.list_audit())
    assert backend.supabase_store().health()["database"] == "supabase"
  finally:
    backend.urlopen = old_urlopen
    for key, value in old_env.items():
      if value is None:
        os.environ.pop(key, None)
      else:
        os.environ[key] = value


def validate_auth_identity_mode() -> None:
  old_auth = os.environ.get("LEGEND_SCHEDULER_AUTH")

  class DummyHandler:
    def __init__(self, headers, user=None, token=""):
      self.headers = headers
      self._user = user
      self._token = token

    def bearer_token(self):
      return self._token

    def session_from_request(self):
      return self._user

  try:
    os.environ.pop("LEGEND_SCHEDULER_AUTH", None)
    demo = DummyHandler({"X-User": "manager", "X-Role": "manager"})
    assert backend.SchedulerHandler.actor(demo) == ("manager", "manager")

    os.environ["LEGEND_SCHEDULER_AUTH"] = "pin"
    spoofed = DummyHandler({"X-User": "manager", "X-Role": "manager"})
    assert backend.SchedulerHandler.actor(spoofed) == ("", "invalid")
    invalid_bearer = DummyHandler({}, token="bad-token")
    assert backend.SchedulerHandler.actor(invalid_bearer) == ("", "invalid")
    session = DummyHandler({}, user={"id": "dispatcher", "name": "Dispatcher", "role": "dispatcher"}, token="valid-token")
    assert backend.SchedulerHandler.actor(session) == ("dispatcher", "dispatcher")
  finally:
    if old_auth is None:
      os.environ.pop("LEGEND_SCHEDULER_AUTH", None)
    else:
      os.environ["LEGEND_SCHEDULER_AUTH"] = old_auth


def main() -> None:
  validate_auth_identity_mode()
  with tempfile.TemporaryDirectory() as tmp:
    db = Path(tmp) / "scheduler.sqlite3"
    backend.init_db(db)
    with backend.connect(db) as conn:
      state = backend.get_state(conn)
      assert "orders" in state
      assert sorted(view["name"] for view in state["savedViews"]) == sorted(["Service", "Production", "Rigging", "PDI", "Warranty", "Detail", "Yard"])
      state["bays"] = ["Service Bay 1"]
      state["technicians"] = [{
        "id": "tech-test",
        "name": "Test Tech",
        "role": "Technician",
        "skills": ["Mechanical"],
        "certifications": ["PDI Signoff"],
        "start": "08:00",
        "end": "16:30",
        "capacity": 100,
        "area": "Service",
        "active": True,
      }]
      state["workTypes"] = [{
        "id": "type-test",
        "name": "Mechanical Inspection",
        "duration": 2,
        "skills": ["Mechanical"],
        "notes": "",
        "actualSamples": [],
        "learnedDuration": 2,
      }]
      state["userTechnicianLinks"] = {"technician": "tech-test"}
      state["orders"].append({
        "id": "WO-TEST",
        "title": "Test order",
        "status": "Scheduled",
        "parts": "Ready",
        "bay": "Service Bay 1",
        "duration": 2,
        "skills": ["Mechanical"],
        "requiredCertifications": ["PDI Signoff"],
        "techId": "tech-test",
        "scheduledDate": "2026-06-03",
        "start": "08:00",
      })
      state["orders"].append({
        "id": "WO-OTHER",
        "title": "Other tech order",
        "status": "Unscheduled",
        "parts": "Ready",
        "bay": "Service Bay 1",
        "duration": 1,
        "skills": ["Mechanical"],
      })
      backend.save_state(conn, state, "dispatcher", "dispatcher", "test.save")
      saved = backend.get_state(conn)
      assert any(order.get("id") == "WO-TEST" for order in saved["orders"])
      findings = backend.validate_state_integrity(saved)
      assert not any(finding["level"] == "error" for finding in findings)
      readiness = backend.readiness_report(conn, db)
      assert readiness["ok"], readiness
      bad_state = backend.get_state(conn)
      bad_state["orders"].append({
        "id": "WO-BAD",
        "title": "Bad order",
        "status": "Scheduled",
        "parts": "Backordered",
        "bay": "Service Bay 1",
        "duration": 2,
        "skills": ["Electrical"],
        "techId": "missing-tech",
        "scheduledDate": "2026-06-03",
        "start": "08:30",
      })
      bad_findings = backend.validate_state_integrity(bad_state)
      assert any(finding["code"] == "schedule.inactive_or_missing_tech" for finding in bad_findings)
      assert any(finding["code"] == "schedule.parts_not_ready" for finding in bad_findings)
      bay_bad_state = backend.get_state(conn)
      bay_bad_state["bayAvailability"] = {"Service Bay 1": {"start": "08:00", "end": "09:00", "outages": [{"date": "2026-06-03", "reason": "Maintenance"}]}}
      bay_findings = backend.validate_state_integrity(bay_bad_state)
      assert any(finding["code"] == "schedule.bay_unavailable" for finding in bay_findings)
      assert any(finding["code"] == "schedule.outside_bay_availability" for finding in bay_findings)
      complete_bad_state = backend.get_state(conn)
      complete_bad_order = next(order for order in complete_bad_state["orders"] if order["id"] == "WO-TEST")
      complete_bad_order["status"] = "Complete"
      complete_bad_order["qualityHold"] = True
      complete_bad_order["operations"] = [{"id": "op-open", "name": "Open operation", "done": False}]
      complete_bad_order["checklist"] = [{"id": "check-open", "text": "Open checklist", "done": False}]
      complete_findings = backend.validate_state_integrity(complete_bad_state)
      assert any(finding["code"] == "quality.complete_blocked" for finding in complete_findings)
      quality_errors = backend.quality_completion_errors(complete_bad_state)
      assert any("WO-TEST cannot be completed" in error for error in quality_errors)
      complete_bad_order["qualityHold"] = False
      complete_bad_order["operations"][0]["done"] = True
      complete_bad_order["checklist"][0]["done"] = True
      assert not any(finding["code"] == "quality.complete_blocked" for finding in backend.validate_state_integrity(complete_bad_state))
      assert backend.quality_completion_errors(complete_bad_state) == []
      backup_dir = Path(tmp) / "backups"
      auto_path = backend.write_auto_backup(conn, 99, "test.manual_auto_backup", backup_dir)
      assert auto_path is not None
      assert auto_path.exists()
      assert backend.backup_status(backup_dir)["count"] == 1
      old_retention = os.environ.get("LEGEND_SCHEDULER_BACKUP_RETENTION")
      os.environ["LEGEND_SCHEDULER_BACKUP_RETENTION"] = "2"
      try:
        backend.write_auto_backup(conn, 100, "test.retention", backup_dir)
        backend.write_auto_backup(conn, 101, "test.retention", backup_dir)
        assert backend.backup_status(backup_dir)["count"] == 2
      finally:
        if old_retention is None:
          os.environ.pop("LEGEND_SCHEDULER_BACKUP_RETENTION", None)
        else:
          os.environ["LEGEND_SCHEDULER_BACKUP_RETENTION"] = old_retention
      events = backend.list_audit(conn)
      assert any(event["action"] == "test.save" for event in events)
      assert any(event["action"] == "work_order.create" and event["entityId"] == "WO-TEST" for event in events)
      master_changed = backend.get_state(conn)
      master_changed["technicians"][0]["capacity"] = 75
      master_changed["workTypes"][0]["notes"] = "Manager-reviewed estimate"
      master_changed["bays"].append("QA Hold Bay")
      master_changed["bayAvailability"] = {
        "Service Bay 1": {"start": "08:00", "end": "15:00", "outages": [{"date": "2026-06-05", "reason": "Maintenance"}]}
      }
      backend.save_state(conn, master_changed, "manager", "manager", "test.master_data_change")
      master_events = backend.list_audit(conn)
      technician_event = next(event for event in master_events if event["action"] == "technician.update" and event["entityId"] == "tech-test")
      assert technician_event["payload"]["changes"]["capacity"]["before"] == 100
      assert technician_event["payload"]["changes"]["capacity"]["after"] == 75
      assert any(event["action"] == "work_type.update" and event["entityId"] == "type-test" for event in master_events)
      assert any(event["action"] == "resource.create" and event["entityId"] == "QA Hold Bay" for event in master_events)
      assert any(event["action"] == "resource.update" and event["entityId"] == "Service Bay 1" for event in master_events)
      changed = backend.get_state(conn)
      changed_order = next(order for order in changed["orders"] if order["id"] == "WO-TEST")
      changed_order["techId"] = "tech-test"
      changed_order["scheduledDate"] = "2026-06-04"
      changed_order["start"] = "10:00"
      changed_order["segments"] = [{"techId": "tech-test", "date": "2026-06-04", "start": "10:00", "duration": 2}]
      changed_order["status"] = "Scheduled"
      backend.save_state(conn, changed, "dispatcher", "dispatcher", "test.schedule_change")
      schedule_events = [
        event for event in backend.list_audit(conn)
        if event["action"] == "schedule.change" and event["entityId"] == "WO-TEST"
      ]
      assert schedule_events
      assert schedule_events[0]["payload"]["changes"]["scheduledDate"]["before"] == "2026-06-03"
      assert schedule_events[0]["payload"]["changes"]["scheduledDate"]["after"] == "2026-06-04"
      assert "segments" in schedule_events[0]["payload"]["changes"]
      status_changed = backend.get_state(conn)
      status_order = next(order for order in status_changed["orders"] if order["id"] == "WO-TEST")
      status_order["status"] = "Complete"
      status_order["checklist"] = [
        *status_order.get("checklist", []),
        {"id": "check-tech-added", "text": "Confirm tech-added checklist", "done": True, "source": "mobile"},
      ]
      status_order["timeEntries"] = [{
        "id": "time-test",
        "techId": "tech-test",
        "hours": 1.25,
        "note": "Technician found loose fastener",
        "date": "2026-06-03 10:15",
        "source": "mobile",
      }]
      status_order["actualHours"] = 1.25
      status_order["unitHistory"] = [*status_order.get("unitHistory", []), "2026-06-03: 1.25h logged by Test Tech"]
      status_order["attachments"] = [{
        "id": "att-technician",
        "orderId": "WO-TEST",
        "name": "tech-photo.jpg",
        "type": "image/jpeg",
        "size": 42,
        "addedAt": "2026-06-03 10:17",
        "addedBy": "technician",
        "url": "/api/attachments/att-technician",
      }]
      progress_errors = backend.validate_technician_state_change(backend.get_state(conn), status_changed, "technician")
      assert progress_errors == []
      assert backend.technician_can_access_order(backend.get_state(conn), "WO-TEST", "technician")
      assert not backend.technician_can_access_order(backend.get_state(conn), "WO-OTHER", "technician")
      backend.save_state(conn, status_changed, "technician", "technician", "test.status_change")
      assert any(
        event["action"] == "work_order.update" and event["entityId"] == "WO-TEST" and "status" in event["payload"]["changes"]
        for event in backend.list_audit(conn)
      )
      denied = backend.get_state(conn)
      denied_order = next(order for order in denied["orders"] if order["id"] == "WO-TEST")
      denied_order["scheduledDate"] = "2026-06-06"
      denied_errors = backend.validate_technician_state_change(backend.get_state(conn), denied, "technician")
      assert any("non-progress work-order changes" in error for error in denied_errors)
      unassigned_denied = backend.get_state(conn)
      unassigned_order = next(order for order in unassigned_denied["orders"] if order["id"] == "WO-OTHER")
      unassigned_order["status"] = "In Progress"
      unassigned_errors = backend.validate_technician_state_change(backend.get_state(conn), unassigned_denied, "technician")
      assert any("not assigned to technician user" in error for error in unassigned_errors)
      dispatcher_current = backend.get_state(conn)
      dispatcher_schedule = backend.get_state(conn)
      dispatcher_schedule["orders"][0]["status"] = "Blocked"
      assert backend.validate_dispatcher_state_change(dispatcher_current, dispatcher_schedule) == []
      dispatcher_denied = backend.get_state(conn)
      dispatcher_denied["bays"] = [*dispatcher_denied["bays"], "Unauthorized Bay"]
      dispatcher_errors = backend.validate_dispatcher_state_change(dispatcher_current, dispatcher_denied)
      assert any("schedulable resource list" in error for error in dispatcher_errors)
      dispatcher_denied = backend.get_state(conn)
      dispatcher_denied["bayAvailability"] = {"Service Bay 1": {"start": "08:00", "end": "12:00", "outages": []}}
      dispatcher_errors = backend.validate_dispatcher_state_change(dispatcher_current, dispatcher_denied)
      assert any("schedulable resource availability" in error for error in dispatcher_errors)
      dispatcher_denied = backend.get_state(conn)
      dispatcher_denied["technicians"].append({
        "id": "tech-unauthorized",
        "name": "Unauthorized",
        "role": "Technician",
        "skills": [],
        "certifications": [],
        "start": "08:00",
        "end": "16:00",
        "capacity": 100,
        "area": "Service",
        "active": True,
      })
      dispatcher_errors = backend.validate_dispatcher_state_change(dispatcher_current, dispatcher_denied)
      assert any("technician list" in error for error in dispatcher_errors)
      backend.record_error(conn, "frontend", "Test browser error", "{\"path\":\"/\"}", "dispatcher")
      assert backend.list_errors(conn)[0]["message"] == "Test browser error"
      conn.execute(
        "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        ("expired-token", "dispatcher", 1, 1),
      )
      assert backend.session_status(conn)["expired"] == 1
      readiness_after_cleanup = backend.readiness_report(conn, db)
      assert readiness_after_cleanup["ok"], readiness_after_cleanup
      assert backend.session_status(conn)["expired"] == 0
      session = backend.create_session(conn, "dispatcher")
      assert session["token"]
      assert session["user"]["role"] == "dispatcher"
      old_auth = os.environ.get("LEGEND_SCHEDULER_AUTH")
      old_pin = os.environ.get("LEGEND_SCHEDULER_PIN_DISPATCHER")
      old_ttl = os.environ.get("LEGEND_SCHEDULER_SESSION_TTL_SECONDS")
      os.environ["LEGEND_SCHEDULER_AUTH"] = "pin"
      os.environ["LEGEND_SCHEDULER_PIN_DISPATCHER"] = "2468"
      os.environ["LEGEND_SCHEDULER_SESSION_TTL_SECONDS"] = "1800"
      try:
        try:
          backend.create_session(conn, "dispatcher", "0000")
          raise AssertionError("wrong PIN should fail")
        except ValueError as error:
          assert "Invalid PIN" in str(error)
        pinned = backend.create_session(conn, "dispatcher", "2468")
        assert pinned["token"]
        assert pinned["expiresAt"] - backend.now() <= 1800
      finally:
        if old_auth is None:
          os.environ.pop("LEGEND_SCHEDULER_AUTH", None)
        else:
          os.environ["LEGEND_SCHEDULER_AUTH"] = old_auth
        if old_pin is None:
          os.environ.pop("LEGEND_SCHEDULER_PIN_DISPATCHER", None)
        else:
          os.environ["LEGEND_SCHEDULER_PIN_DISPATCHER"] = old_pin
        if old_ttl is None:
          os.environ.pop("LEGEND_SCHEDULER_SESSION_TTL_SECONDS", None)
        else:
          os.environ["LEGEND_SCHEDULER_SESSION_TTL_SECONDS"] = old_ttl
      user = backend.session_user(conn, session["token"])
      assert user is not None
      assert user["id"] == "dispatcher"
      backend.audit(conn, user["id"], user["role"], "auth.logout", "user", user["id"])
      assert any(event["action"] == "auth.logout" and event["entityId"] == "dispatcher" for event in backend.list_audit(conn))
      backend.delete_session(conn, session["token"])
      assert backend.session_user(conn, session["token"]) is None
      imported = backend.normalize_salesforce_import(
        {"records": [{
          "Id": "SF-1",
          "Subject": "Warranty test",
          "AccountName": "Jamie Dewar",
          "DealerName": "Sudbury Marine",
          "AssetName": "21 XTR",
          "Priority": "High",
          "EstimatedDuration": 3,
          "EarliestStartDate": "2026-06-04",
          "ActualHours": 2.5,
          "PartsReadiness": "Staged",
          "Bay": "Service Bay 1",
          "AssignedTechnicianId": "tech-test",
          "ScheduledDate": "2026-06-03",
          "ScheduledStart": "09:00",
          "RequiredSkills": ["Mechanical"],
          "RequiredCertifications": ["PDI Signoff"],
          "PreferredTechnicianId": "tech-test",
          "ContinuityTechnicianId": "tech-test",
          "ReworkFlag": True,
          "QualityHold": "true",
          "Dependencies": "WO-0001 complete",
          "ScheduleSegments": [{"techId": "tech-test", "date": "2026-06-03", "start": "09:00", "duration": 3}],
          "Operations": [{"id": "op-sf", "name": "Inspect", "done": False}],
          "Checklist": [{"id": "check-sf", "text": "Photo uploaded", "done": True}],
          "TimeEntries": [{"id": "time-sf", "techId": "tech-test", "hours": 2.5}],
          "UnitHistory": ["Salesforce history"],
          "Attachments": [{"Name": "sf-photo.jpg", "ContentType": "image/jpeg", "Size": 123, "Url": "https://example.test/sf-photo.jpg"}],
        }]}
      )
      assert imported[0]["id"] == "SF-1"
      assert imported[0]["customer"] == "Jamie Dewar"
      assert imported[0]["dealer"] == "Sudbury Marine"
      assert imported[0]["boat"] == "21 XTR"
      assert imported[0]["status"] == "Scheduled"
      assert imported[0]["actualHours"] == 2.5
      assert imported[0]["earliestStartDate"] == "2026-06-04"
      assert imported[0]["parts"] == "Staged"
      assert imported[0]["segments"][0]["start"] == "09:00"
      assert imported[0]["operations"][0]["name"] == "Inspect"
      assert imported[0]["checklist"][0]["done"] is True
      assert imported[0]["timeEntries"][0]["hours"] == 2.5
      assert imported[0]["rework"] is True
      assert imported[0]["qualityHold"] is True
      assert imported[0]["attachments"][0]["name"] == "sf-photo.jpg"
      bad_completed_import = backend.normalize_salesforce_import(
        {"records": [{
          "Id": "SF-BAD-COMPLETE",
          "Subject": "Bad completed import",
          "Status": "Complete",
          "QualityHold": True,
          "Operations": [{"id": "op-bad", "name": "Open imported operation", "done": False}],
        }]}
      )
      assert any("SF-BAD-COMPLETE cannot be completed" in error for error in backend.quality_completion_errors({"orders": bad_completed_import}))
      backend.audit(conn, "dispatcher", "dispatcher", "salesforce.import.detail", "app_state", "1", {"recordsImported": len(imported)})
      assert any(
        event["action"] == "salesforce.import.detail" and event["payload"]["recordsImported"] == 1
        for event in backend.list_audit(conn)
      )
      salesforce_export = backend.salesforce_export_payload(backend.get_state(conn))
      assert salesforce_export["format"] == "legend-service-scheduler-salesforce-export-v1"
      assert salesforce_export["records"]
      first_export = salesforce_export["records"][0]
      assert "WorkOrderNumber" in first_export
      assert "PartsReadiness" in first_export
      assert "EarliestStartDate" in first_export
      assert "ScheduleSegments" in first_export
      assert "AccountName" in first_export
      assert "DealerName" in first_export
      early_start_state = backend.get_state(conn)
      early_start_state["orders"][0]["earliestStartDate"] = "2026-06-05"
      early_start_state["orders"][0]["status"] = "Scheduled"
      early_start_state["orders"][0]["scheduledDate"] = "2026-06-04"
      early_start_state["orders"][0]["start"] = "08:00"
      early_start_state["orders"][0]["segments"] = [{"techId": "tech-test", "date": "2026-06-04", "start": "08:00", "duration": 2}]
      assert any(finding["code"] == "schedule.before_earliest_start" for finding in backend.validate_state_integrity(early_start_state))
      attachment = backend.save_attachment(
        conn,
        "WO-TEST",
        "photo.jpg",
        "image/jpeg",
        b"fake-image-bytes",
        "dispatcher",
        "dispatcher",
      )
      assert attachment["orderId"] == "WO-TEST"
      assert attachment["url"].startswith("/api/attachments/")
      attachments = backend.list_attachments(conn, "WO-TEST")
      assert len(attachments) == 1
      assert attachments[0]["name"] == "photo.jpg"
      second_attachment = backend.save_attachment(
        conn,
        "WO-TEST",
        "second-photo.jpg",
        "image/jpeg",
        b"fake-image-bytes-2",
        "dispatcher",
        "dispatcher",
      )
      assert second_attachment["id"] != attachment["id"]
      assert len(backend.list_attachments(conn, "WO-TEST")) == 2
      backup = backend.create_backup(conn)
      assert backup["format"] == "legend-service-scheduler-backup-v1"
      assert any(a["filename"] == "photo.jpg" and a["data"] for a in backup["attachments"])
      assert any(e["message"] == "Test browser error" for e in backup["errorEvents"])
      malformed_backup = json.loads(json.dumps(backup))
      malformed_backup["attachments"] = [{"filename": "bad-photo.jpg", "data": "not-base64!"}]
      try:
        backend.restore_backup(conn, malformed_backup, "manager", "manager")
        raise AssertionError("Restore accepted malformed attachment data")
      except ValueError as exc:
        assert "attachment data is invalid" in str(exc)
      integrity_backup = json.loads(json.dumps(backup))
      integrity_backup["state"]["orders"].append(
        {
          "id": "WO-BAD-RESTORE",
          "title": "Invalid restore assignment",
          "status": "Scheduled",
          "parts": "Ready",
          "bay": "Service Bay 1",
          "techId": "missing-tech",
          "scheduledDate": "2026-06-03",
          "start": "09:00",
          "duration": 1,
        }
      )
      try:
        backend.restore_backup(conn, integrity_backup, "manager", "manager")
        raise AssertionError("Restore accepted integrity-breaking state")
      except ValueError as exc:
        assert "Backup state integrity failed" in str(exc)
      assert len(backend.list_attachments(conn, "WO-TEST")) == 2
      mutated = backend.get_state(conn)
      mutated["orders"] = [{"id": "WO-MUTATED", "title": "Mutated order"}]
      backend.save_state(conn, mutated, "dispatcher", "dispatcher", "test.mutate")
      restored_version = backend.restore_backup(conn, backup, "manager", "manager")
      assert restored_version > 0
      restored = backend.get_state(conn)
      assert any(order.get("id") == "WO-TEST" for order in restored["orders"])
      assert not any(order.get("id") == "WO-MUTATED" for order in restored["orders"])
      restored_attachments = backend.list_attachments(conn, "WO-TEST")
      assert len(restored_attachments) == 2
      assert any(a["name"] == "second-photo.jpg" for a in restored_attachments)
      assert any(e["message"] == "Test browser error" for e in backend.list_errors(conn))
      seed_state = backend.default_state()
      seed_state["bays"] = ["Service Bay 1"]
      seed_state["technicians"] = [{
        "id": "tech-seed",
        "name": "Seed Tech",
        "role": "Technician",
        "skills": ["Mechanical"],
        "certifications": [],
        "start": "08:00",
        "end": "16:00",
        "capacity": 100,
        "area": "Service",
        "active": True,
      }]
      seed_state["workTypes"] = [{"id": "type-seed", "name": "Seed Service", "duration": 2, "skills": ["Mechanical"]}]
      seed_state["orders"] = [{"id": "WO-SEED", "title": "Seed order", "status": "Unscheduled", "parts": "Ready"}]
      reset_version = backend.reset_demo_state(conn, seed_state, "manager", "manager")
      assert reset_version > 0
      reset_state = backend.get_state(conn)
      assert reset_state["orders"][0]["id"] == "WO-SEED"
      assert backend.list_attachments(conn, "WO-TEST") == []
      assert backend.list_errors(conn) == []
      assert any(event["action"] == "demo.seed_reset" for event in backend.list_audit(conn))
  run_supabase_validation()
  print("backend validation passed")


if __name__ == "__main__":
  main()
