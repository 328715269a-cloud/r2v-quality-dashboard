"""Isolated regression checks for maintenance.py; never opens a production path."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid


sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("maintenance", HERE / "maintenance.py")
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)


def uid():
    return str(uuid.uuid4())


def append(path, delta, transaction_id=None):
    connection = maintenance.connect(path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        revision = int(maintenance.metadata(connection)["revision"]) + 1
        for ordinal, (kind, value) in enumerate((kind, value) for kind in ("tasks", "batches", "events") for value in delta.get(kind, [])):
            connection.execute("INSERT INTO records VALUES(?,?,?,?,?)", (value["id"], kind, revision, ordinal, maintenance.encoded(value)))
        result = {"revision": revision, "delta": {kind: delta.get(kind, []) for kind in ("tasks", "events", "batches")}}
        connection.execute("INSERT INTO transactions VALUES(?,?,?,?,?,?)", (transaction_id or uid(), revision, maintenance.digest(delta), maintenance.encoded({"name": "测试人员", "role": "admin"}), "2026-01-01T00:00:00.000Z", maintenance.encoded(result)))
        connection.execute("UPDATE metadata SET value=? WHERE key='revision'", (str(revision),))
        connection.execute("COMMIT")
        return revision
    finally:
        connection.close()


def fixture(directory):
    path = directory / "workbench.sqlite"
    connection = sqlite3.connect(path, isolation_level=None)
    connection.executescript("""
    PRAGMA journal_mode=WAL;
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('tasks','events','batches')),revision INTEGER NOT NULL,ordinal INTEGER NOT NULL,json TEXT NOT NULL);
    CREATE INDEX records_revision ON records(revision,ordinal);
    CREATE TABLE transactions(id TEXT PRIMARY KEY,revision INTEGER NOT NULL UNIQUE,payload_hash TEXT NOT NULL,profile TEXT NOT NULL,created_at TEXT NOT NULL,result TEXT NOT NULL);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,profile TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TRIGGER immutable_records_update BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT,'records are append only'); END;
    CREATE TRIGGER immutable_records_delete BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT,'records are append only'); END;
    CREATE TRIGGER immutable_transactions_update BEFORE UPDATE ON transactions BEGIN SELECT RAISE(ABORT,'transactions are append only'); END;
    CREATE TRIGGER immutable_transactions_delete BEFORE DELETE ON transactions BEGIN SELECT RAISE(ABORT,'transactions are append only'); END;
    INSERT INTO metadata VALUES('createdAt','2026-01-01T00:00:00.000Z');
    INSERT INTO metadata VALUES('revision','0');
    INSERT INTO metadata VALUES('otherSetting','do not modify');
    """)
    connection.execute("INSERT INTO sessions VALUES(?,?,?,?)", ("opaque-session-hash", maintenance.encoded({"name": "持续作业", "role": "qc"}), 1000, 9999999999999))
    connection.close()
    targets = [{"id": uid(), "tid": "synthetic-" + uid(), "groupId": "g01", "mode": "single"} for _ in range(3)]
    other = {"id": uid(), "tid": "unrelated-" + uid(), "groupId": "g01", "mode": "single"}
    ids = [task["id"] for task in targets]
    batches = [{"id": uid(), "kind": "import", "taskIds": ids}, {"id": uid(), "kind": "handoff", "taskIds": ids[:2]}, {"id": uid(), "kind": "handoff", "taskIds": ids[1:]}]
    events = [{"id": uid(), "type": "dispatch" if index < 3 else "submit", "taskId": ids[index % 3], "actor": "测试人员", "at": "2026-01-01T00:00:00.000Z"} for index in range(26)]
    daily = {"id": uid(), "type": "group_daily_edit", "taskId": "group:g01", "groupId": "g01", "after": {"leader": "在班组长", "headcount": 0.5}}
    other_event = {"id": uid(), "type": "claim", "taskId": other["id"], "actor": "持续作业"}
    mixed_id = uid()
    append(path, {"tasks": targets + [other], "batches": batches[:1], "events": events[:3] + [daily, other_event]}, mixed_id)
    append(path, {"batches": batches[1:2], "events": events[3:17]})
    append(path, {"batches": batches[2:], "events": events[17:]})
    return {"path": path, "ids": ids, "other": other, "daily": daily, "batches": batches, "mixedId": mixed_id}


def snapshot(path):
    connection = maintenance.connect(path, readonly=True)
    try:
        return {**{name: maintenance.rows(connection, name) for name in ("records", "transactions", "sessions", "metadata")}, "triggers": maintenance.triggers(connection)}
    finally:
        connection.close()


def prepare(fixture_value, directory):
    request = {"operation": "prepare", "database": str(fixture_value["path"]), "backup": str(directory / "private-backup.sqlite"), "plan": str(directory / "private-plan.json"), "targetTaskIds": fixture_value["ids"], "operationId": uid()}
    result = maintenance.prepare(request)
    return request, result, {"operation": "apply", "database": request["database"], "plan": request["plan"], "planDigest": result["planDigest"]}


def fail(action, contains):
    try:
        action()
    except Exception as error:
        assert contains in str(error), (contains, str(error))
    else:
        raise AssertionError("Expected failure: " + contains)


passed = []


def test(name, function):
    with tempfile.TemporaryDirectory(prefix="workbench-maintenance-test-") as temporary:
        function(Path(temporary))
    passed.append(name)


def normal(directory):
    value = fixture(directory)
    before = snapshot(value["path"])
    request, prepared, apply_request = prepare(value, directory)
    assert snapshot(value["path"]) == before, "prepare changed source data"
    assert prepared["counts"] == {"tasks": 3, "events": 26, "batches": 3}
    backup = snapshot(Path(prepared["backup"]))
    assert backup == before
    if os.name != "nt":
        assert Path(request["backup"]).stat().st_mode & 0o777 == 0o600
        assert Path(request["plan"]).stat().st_mode & 0o777 == 0o600
    # Another user saves both records and a session after the plan was prepared.
    added_task = {"id": uid(), "tid": "new-live-task", "groupId": "g02"}
    added_daily = {"id": uid(), "type": "group_daily_edit", "taskId": "group:g02", "groupId": "g02", "after": {"headcount": 2}}
    latest = append(value["path"], {"tasks": [added_task], "events": [added_daily]})
    connection = maintenance.connect(value["path"])
    connection.execute("INSERT INTO sessions VALUES(?,?,?,?)", ("new-live-session", "{}", 2000, 9999999999999))
    connection.execute("INSERT INTO metadata VALUES('retiredTaskIds',?)", (maintenance.encoded(["previously-retired-id"]),))
    connection.execute("INSERT INTO metadata VALUES('fullSnapshotRevision','2')")
    connection.close()
    just_before = snapshot(value["path"])
    result = maintenance.apply(apply_request)
    assert result["status"] == "applied" and result["revision"] == latest + 1
    after = snapshot(value["path"])
    assert after["sessions"] == just_before["sessions"]
    assert after["triggers"] == before["triggers"]
    remaining = {row["id"] for row in after["records"]}
    assert value["other"]["id"] in remaining and value["daily"]["id"] in remaining
    assert added_task["id"] in remaining and added_daily["id"] in remaining
    assert not remaining.intersection(value["ids"])
    before_transaction = next(row for row in before["transactions"] if row["id"] == value["mixedId"])
    after_transaction = next(row for row in after["transactions"] if row["id"] == value["mixedId"])
    assert {key: val for key, val in before_transaction.items() if key != "result"} == {key: val for key, val in after_transaction.items() if key != "result"}
    mixed_delta = json.loads(after_transaction["result"])["delta"]
    assert mixed_delta["tasks"] == [value["other"]] and mixed_delta["batches"] == []
    assert len(mixed_delta["events"]) == 2 and value["daily"] in mixed_delta["events"]
    meta = {row["key"]: row["value"] for row in after["metadata"]}
    assert set(json.loads(meta["retiredTaskIds"])) == set(value["ids"]) | {"previously-retired-id"}
    assert int(meta["fullSnapshotRevision"]) == result["revision"]
    assert maintenance.apply(apply_request)["status"] == "alreadyApplied"
    assert snapshot(value["path"]) == after, "repeat apply wrote new records"
    assert maintenance.file_digest(Path(request["backup"])) == prepared["backupDigest"]


test("read-only prepare, complete online backup, 32 exact removals, mixed transaction retention, unrelated saves/sessions/settings, monotonic revision and idempotency", normal)


def shared_batch(directory):
    value = fixture(directory)
    append(value["path"], {"batches": [{"id": uid(), "kind": "handoff", "taskIds": [value["ids"][0], value["other"]["id"]]}]})
    before = snapshot(value["path"])
    fail(lambda: prepare(value, directory), "unrelated task")
    assert snapshot(value["path"]) == before


test("shared import/handoff batch membership prevents scope expansion", shared_batch)


def target_changed(directory):
    value = fixture(directory)
    _, _, apply_request = prepare(value, directory)
    append(value["path"], {"events": [{"id": uid(), "type": "qc_pass", "taskId": value["ids"][0]}]})
    before = snapshot(value["path"])
    fail(lambda: maintenance.apply(apply_request), "Target records changed")
    assert snapshot(value["path"]) == before


test("target event saved after prepare causes atomic CAS rejection", target_changed)


def related_transaction_changed(directory):
    value = fixture(directory)
    _, _, apply_request = prepare(value, directory)
    connection = maintenance.connect(value["path"])
    definition = maintenance.triggers(connection)["immutable_transactions_update"]
    connection.execute("BEGIN IMMEDIATE")
    connection.execute("DROP TRIGGER immutable_transactions_update")
    connection.execute("UPDATE transactions SET profile=? WHERE id=?", ('{"role":"changed"}', value["mixedId"]))
    connection.execute(definition)
    connection.execute("COMMIT")
    connection.close()
    before = snapshot(value["path"])
    fail(lambda: maintenance.apply(apply_request), "Related transactions changed")
    assert snapshot(value["path"]) == before


test("related transaction original-result and identity CAS prevents stale sanitization", related_transaction_changed)


def tampering(directory):
    value = fixture(directory)
    request, _, apply_request = prepare(value, directory)
    before = snapshot(value["path"])
    plan_path = Path(request["plan"])
    original = plan_path.read_bytes()
    plan_path.write_bytes(original + b" ")
    fail(lambda: maintenance.apply(apply_request), "Plan digest mismatch")
    plan_path.write_bytes(original)
    backup_path = Path(request["backup"])
    with backup_path.open("ab") as stream:
        stream.write(b"changed")
    fail(lambda: maintenance.apply(apply_request), "Backup digest mismatch")
    assert snapshot(value["path"]) == before


test("external plan SHA and online-backup SHA prevent tampered execution", tampering)


def rollback(directory):
    value = fixture(directory)
    _, _, apply_request = prepare(value, directory)
    before = snapshot(value["path"])
    for stage in ("after_mutations", "before_commit"):
        def fault(point, connection):
            if point == stage:
                raise RuntimeError("injected failure")
        fail(lambda: maintenance.apply(apply_request, _fault=fault), "injected failure")
        assert snapshot(value["path"]) == before, "rollback did not restore every table/trigger"
        connection = maintenance.connect(value["path"])
        try:
            fail(lambda: connection.execute("DELETE FROM records WHERE id=?", (value["other"]["id"],)), "append only")
            fail(lambda: connection.execute("UPDATE transactions SET profile='{}' WHERE id=?", (value["mixedId"],)), "append only")
        finally:
            connection.close()
    assert maintenance.apply(apply_request)["status"] == "applied"


test("failures before trigger restoration and before commit roll back records, results, metadata and protection", rollback)


def cross_connection(directory):
    value = fixture(directory)
    _, _, apply_request = prepare(value, directory)
    outcomes, threads = [], []
    added_id = uid()
    def writer():
        try:
            append(value["path"], {"tasks": [{"id": added_id, "tid": "concurrent-unrelated"}]})
            outcomes.append("saved")
        except Exception as error:
            outcomes.append(str(error))
    def cannot_bypass_trigger():
        connection = maintenance.connect(value["path"])
        try:
            connection.execute("DELETE FROM records WHERE id=?", (value["other"]["id"],))
            outcomes.append("protection-bypassed")
        except sqlite3.IntegrityError as error:
            outcomes.append(str(error))
        finally:
            connection.close()
    def observer(stage, connection):
        if stage == "after_mutations":
            other = maintenance.connect(value["path"], readonly=True)
            try:
                assert maintenance.triggers(other) == json.loads(Path(apply_request["plan"]).read_text(encoding="utf-8"))["triggers"]
                assert len(maintenance.select_targets(maintenance.rows(other, "records"), value["ids"])) == 32
            finally:
                other.close()
            for function in (writer, cannot_bypass_trigger):
                thread = threading.Thread(target=function)
                threads.append(thread)
                thread.start()
            time.sleep(0.03)
    result = maintenance.apply(apply_request, _fault=observer)
    for thread in threads:
        thread.join(timeout=3)
        assert not thread.is_alive()
    assert "saved" in outcomes and "records are append only" in outcomes and "protection-bypassed" not in outcomes, outcomes
    after = snapshot(value["path"])
    assert added_id in {row["id"] for row in after["records"]}
    assert int(next(row["value"] for row in after["metadata"] if row["key"] == "revision")) == result["revision"] + 1


test("WAL reader retains old committed schema; concurrent unrelated writer succeeds and cannot exploit transient trigger removal", cross_connection)


def repeat_validation(directory):
    value = fixture(directory)
    _, _, apply_request = prepare(value, directory)
    maintenance.apply(apply_request)
    connection = maintenance.connect(value["path"])
    connection.execute("UPDATE metadata SET value='[]' WHERE key='retiredTaskIds'")
    connection.close()
    before = snapshot(value["path"])
    fail(lambda: maintenance.apply(apply_request), "Retired task guard missing")
    assert snapshot(value["path"]) == before


test("repeat apply verifies retired guard instead of trusting an operation marker alone", repeat_validation)


def cli(directory):
    value = fixture(directory)
    request = {"operation": "prepare", "database": str(value["path"]), "backup": str(directory / "cli-backup.sqlite"), "plan": str(directory / "cli-plan.json"), "targetTaskIds": value["ids"], "operationId": uid()}
    def invoke(payload):
        process = subprocess.run([sys.executable, str(HERE / "maintenance.py")], input=json.dumps(payload), text=True, capture_output=True, encoding="utf-8")
        assert process.returncode == 0, process.stderr + process.stdout
        return json.loads(process.stdout)
    prepared = invoke(request)
    result = invoke({"operation": "apply", "database": str(value["path"]), "plan": prepared["plan"], "planDigest": prepared["planDigest"]})
    assert result["status"] == "applied"
    assert not set(value["ids"]).intersection(result), "CLI should not expose task data"


test("stdin JSON prepare/apply CLI works without business data in stdout", cli)


print(json.dumps({"ok": True, "tests": len(passed), "checks": passed, "python": sys.version.split()[0], "sqlite": sqlite3.sqlite_version, "maintenanceSha256": maintenance.file_digest(HERE / "maintenance.py")}, ensure_ascii=False, indent=2))
