"""Narrow, offline-reviewed maintenance for the shared workbench SQLite database.

Read one JSON request from stdin.  ``prepare`` opens the source database read-only,
creates a new private SQLite online backup and a private plan.  ``apply`` requires
the exact plan SHA-256 returned by prepare.  The serving API MUST understand
fullSnapshotRevision and retiredTaskIds before apply is invoked.

This is an operator tool, not a public HTTP endpoint.  It never resets revision,
removes sessions, restores an entire database, or changes serving processes.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
import uuid
from datetime import datetime, timezone


class MaintenanceError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise MaintenanceError(message)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(encoded(value).encode("utf-8")).hexdigest()


def file_digest(path):
    value = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def database_path(value):
    path = Path(value).expanduser().resolve(strict=True)
    require(path.is_file(), "Database is not a regular file")
    return path


def new_path(value):
    path = Path(value).expanduser().absolute()
    require(not path.exists() and not path.is_symlink(), "Output path already exists")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path.resolve(strict=False)


def identity(path):
    stat = path.stat()
    return {"path": str(path), "device": stat.st_dev, "inode": stat.st_ino}


def connect(path, readonly=False):
    connection = sqlite3.connect(path.as_uri() + ("?mode=ro" if readonly else "?mode=rw"), uri=True, isolation_level=None, timeout=0.25)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=250")
    return connection


def rows(connection, table):
    require(table in {"records", "transactions", "sessions", "metadata"}, "Unknown table")
    key = "key" if table == "metadata" else "token_hash" if table == "sessions" else "id"
    return [dict(row) for row in connection.execute(f"SELECT * FROM {table} ORDER BY {key}")]


def metadata(connection):
    return {row["key"]: row["value"] for row in connection.execute("SELECT key,value FROM metadata")}


def integer(value, label):
    require(isinstance(value, str) and value.isdigit(), label + " is invalid")
    result = int(value)
    require(0 <= result <= 9007199254740991, label + " is unsafe")
    return result


def triggers(connection):
    return {row["name"]: row["sql"] for row in connection.execute("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name")}


def validate_schema(connection):
    columns = {
        "records": ["id", "kind", "revision", "ordinal", "json"],
        "transactions": ["id", "revision", "payload_hash", "profile", "created_at", "result"],
        "metadata": ["key", "value"],
        "sessions": ["token_hash", "profile", "created_at", "expires_at"],
    }
    for table, expected in columns.items():
        require([row["name"] for row in connection.execute(f"PRAGMA table_info({table})")] == expected, "Unexpected schema: " + table)
    definitions = triggers(connection)
    for name, clause in {
        "immutable_records_update": "BEFORE UPDATE ON RECORDS",
        "immutable_records_delete": "BEFORE DELETE ON RECORDS",
        "immutable_transactions_update": "BEFORE UPDATE ON TRANSACTIONS",
        "immutable_transactions_delete": "BEFORE DELETE ON TRANSACTIONS",
    }.items():
        sql = definitions.get(name, "").upper()
        require(clause in sql and "RAISE(ABORT" in sql, "Append-only protection missing: " + name)
    values = metadata(connection)
    integer(values.get("revision"), "revision")
    require(isinstance(values.get("createdAt"), str) and values["createdAt"], "createdAt missing")
    return values, definitions


def target_ids(values):
    require(isinstance(values, list) and 0 < len(values) <= 1000, "targetTaskIds must be a non-empty bounded array")
    require(all(isinstance(value, str) and 0 < len(value) <= 200 for value in values), "Invalid task ID")
    require(len(set(values)) == len(values), "Duplicate target task ID")
    return sorted(values)


def select_targets(record_rows, ids, must_exist=True):
    targets, found = set(ids), set()
    selected = []
    for row in record_rows:
        value = json.loads(row["json"])
        require(isinstance(value, dict) and value.get("id") == row["id"], "Record identity mismatch")
        include = False
        if row["kind"] == "tasks" and row["id"] in targets:
            found.add(row["id"])
            include = True
        elif row["kind"] == "events" and value.get("taskId") in targets:
            require(value.get("type") != "group_daily_edit", "Group settings cannot be targeted")
            include = True
        elif row["kind"] == "batches":
            members = value.get("taskIds", [])
            require(isinstance(members, list), "Batch taskIds is invalid")
            if targets.intersection(members):
                require(members and set(members).issubset(targets), "A related batch contains an unrelated task; abort")
                include = True
        if include:
            selected.append(row)
    if must_exist:
        require(found == targets, "Some target tasks no longer exist")
    return sorted(selected, key=lambda row: (row["id"], row["kind"]))


def transaction_changes(transaction_rows, selected, ids):
    removed = {kind: {row["id"] for row in selected if row["kind"] == kind} for kind in ("tasks", "events", "batches")}
    target_set, changes = set(ids), []
    for row in transaction_rows:
        result = json.loads(row["result"])
        require(isinstance(result, dict) and result.get("revision") == row["revision"], "Transaction result revision is invalid")
        delta = result.get("delta")
        require(isinstance(delta, dict), "Transaction delta is invalid")
        changed = False
        for kind in ("tasks", "events", "batches"):
            values = delta.get(kind, [])
            require(isinstance(values, list), "Transaction delta collection is invalid")
            kept = []
            for value in values:
                require(isinstance(value, dict) and isinstance(value.get("id"), str), "Transaction record identity is invalid")
                linked = value["id"] in target_set if kind == "tasks" else value.get("taskId") in target_set if kind == "events" else bool(target_set.intersection(value.get("taskIds", [])))
                if linked:
                    require(value["id"] in removed[kind], "Related transaction contains an unexpected record; abort")
                if value["id"] in removed[kind]:
                    changed = True
                else:
                    kept.append(value)
            if len(kept) != len(values):
                delta[kind] = kept
        if changed:
            changes.append({"before": row, "afterResult": json.dumps(result, ensure_ascii=False, separators=(",", ":"))})
    return sorted(changes, key=lambda item: item["before"]["id"])


def put_metadata(connection, key, value):
    connection.execute("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def prepare(request):
    database = database_path(request["database"])
    ids = target_ids(request["targetTaskIds"])
    operation_id = str(uuid.UUID(request["operationId"]))
    backup_path, plan_path = new_path(request["backup"]), new_path(request["plan"])
    require(len({database, backup_path, plan_path}) == 3, "Database, backup and plan paths must differ")
    source_identity = identity(database)
    source = connect(database, readonly=True)
    descriptor = os.open(backup_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    backup = sqlite3.connect(str(backup_path), isolation_level=None)
    try:
        validate_schema(source)
        require(source.execute("PRAGMA journal_mode").fetchone()[0] == "wal", "Source database must be WAL")
        started = time.monotonic()
        def progress(status, remaining, total):
            require(time.monotonic() - started < 30, "Online backup timeout")
        source.backup(backup, pages=128, progress=progress, sleep=0.01)
        backup.execute("PRAGMA journal_mode=DELETE")
        require(backup.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "Backup integrity failed")
    finally:
        backup.close()
        source.close()
    os.chmod(backup_path, 0o600)
    require(identity(database) == source_identity, "Source database file changed during backup")
    snapshot = connect(backup_path, readonly=True)
    try:
        values, definitions = validate_schema(snapshot)
        require("maintenance_cleanup:" + operation_id not in values, "Operation ID already exists; use its original plan")
        selected = select_targets(rows(snapshot, "records"), ids)
        changes = transaction_changes(rows(snapshot, "transactions"), selected, ids)
        require(not snapshot.execute("SELECT 1 FROM transactions WHERE id=?", (operation_id,)).fetchone(), "Operation ID is already a transaction")
        plan = {
            "format": "workbench-targeted-cleanup-plan", "version": 1,
            "preparedAt": now(), "operationId": operation_id,
            "database": source_identity, "databaseCreatedAt": values["createdAt"],
            "backup": {"path": str(backup_path), "sha256": file_digest(backup_path)},
            "preparedRevision": integer(values["revision"], "revision"), "targetTaskIds": ids,
            "records": selected, "recordDigest": digest(selected),
            "transactions": changes, "transactionDigest": digest(changes), "triggers": definitions,
        }
    finally:
        snapshot.close()
    data = (encoded(plan) + "\n").encode("utf-8")
    descriptor = os.open(plan_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(plan_path, 0o600)
    return {"status": "prepared", "operationId": operation_id, "plan": str(plan_path), "planDigest": hashlib.sha256(data).hexdigest(), "backup": str(backup_path), "backupDigest": plan["backup"]["sha256"], "revision": plan["preparedRevision"], "counts": counts(selected), "affectedTransactions": len(changes)}


def counts(record_rows):
    return {kind: sum(row["kind"] == kind for row in record_rows) for kind in ("tasks", "events", "batches")}


def load_plan(request):
    path = Path(request["plan"]).expanduser().resolve(strict=True)
    data = path.read_bytes()
    require(isinstance(request.get("planDigest"), str) and hashlib.sha256(data).hexdigest() == request["planDigest"], "Plan digest mismatch")
    plan = json.loads(data)
    require(plan.get("format") == "workbench-targeted-cleanup-plan" and plan.get("version") == 1, "Unsupported plan")
    require(digest(plan["records"]) == plan["recordDigest"] and digest(plan["transactions"]) == plan["transactionDigest"], "Plan content digest mismatch")
    require(target_ids(plan["targetTaskIds"]) == plan["targetTaskIds"], "Plan task IDs are invalid")
    require(str(uuid.UUID(plan["operationId"])) == plan["operationId"], "Invalid operation ID")
    database = database_path(request["database"])
    require(identity(database) == plan["database"], "Database identity differs from plan")
    return database, plan


def existing_retired(values):
    result = json.loads(values.get("retiredTaskIds", "[]"))
    require(isinstance(result, list) and all(isinstance(value, str) for value in result), "retiredTaskIds metadata invalid")
    return set(result)


def verify_applied(connection, plan, plan_digest, marker):
    values, definitions = validate_schema(connection)
    require(marker.get("planDigest") == plan_digest and marker.get("operationId") == plan["operationId"], "Cleanup operation marker mismatch")
    require(definitions == plan["triggers"], "Trigger definitions differ after cleanup")
    require(not select_targets(rows(connection, "records"), plan["targetTaskIds"], must_exist=False), "Target records reappeared after cleanup")
    require(set(plan["targetTaskIds"]).issubset(existing_retired(values)), "Retired task guard missing")
    cleanup_revision = marker["revision"]
    require(integer(values["revision"], "revision") >= cleanup_revision, "Current revision precedes cleanup")
    require(integer(values.get("fullSnapshotRevision", "0"), "fullSnapshotRevision") >= cleanup_revision, "Snapshot barrier missing")
    for change in plan["transactions"]:
        before = change["before"]
        actual = connection.execute("SELECT * FROM transactions WHERE id=?", (before["id"],)).fetchone()
        require(actual is not None and dict(actual) == {**before, "result": change["afterResult"]}, "A sanitized transaction differs from the approved cleanup")
    audit = connection.execute("SELECT * FROM transactions WHERE id=?", (plan["operationId"],)).fetchone()
    require(audit is not None and dict(audit) == marker["auditTransaction"], "Cleanup audit transaction mismatch")
    return {"status": "alreadyApplied", "operationId": plan["operationId"], "revision": cleanup_revision, "currentRevision": integer(values["revision"], "revision"), "counts": counts(plan["records"]), "planDigest": plan_digest}


def apply(request, _fault=None):
    database, plan = load_plan(request)
    plan_digest = request["planDigest"]
    require(file_digest(Path(plan["backup"]["path"])) == plan["backup"]["sha256"], "Backup digest mismatch")
    connection = connect(database)
    began = False
    try:
        require(connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal", "Database must remain WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("BEGIN IMMEDIATE")
        began = True
        started = time.monotonic()
        values, definitions = validate_schema(connection)
        require(values["createdAt"] == plan["databaseCreatedAt"], "Database createdAt differs from plan")
        operation_key = "maintenance_cleanup:" + plan["operationId"]
        if operation_key in values:
            result = verify_applied(connection, plan, plan_digest, json.loads(values[operation_key]))
            connection.execute("COMMIT")
            began = False
            return result
        require(definitions == plan["triggers"], "Trigger definitions changed since prepare")
        record_before, transaction_before, session_before = rows(connection, "records"), rows(connection, "transactions"), rows(connection, "sessions")
        selected = select_targets(record_before, plan["targetTaskIds"])
        require(digest(selected) == plan["recordDigest"], "Target records changed since prepare; nothing deleted")
        changes = transaction_changes(transaction_before, selected, plan["targetTaskIds"])
        require(digest(changes) == plan["transactionDigest"], "Related transactions changed since prepare; nothing deleted")
        require(not any(row["id"] == plan["operationId"] for row in transaction_before), "Cleanup operation transaction ID collision")
        revision = integer(values["revision"], "revision")
        require(plan["preparedRevision"] <= revision < 9007199254740991, "Database revision moved backwards or overflowed")
        barrier = integer(values.get("fullSnapshotRevision", "0"), "fullSnapshotRevision")
        require(barrier <= revision, "Existing full snapshot barrier exceeds revision")
        retired = existing_retired(values) | set(plan["targetTaskIds"])
        connection.execute("DROP TRIGGER immutable_records_delete")
        connection.execute("DROP TRIGGER immutable_transactions_update")
        deleted_count = 0
        for row in selected:
            cursor = connection.execute("DELETE FROM records WHERE id=? AND kind=? AND revision=? AND ordinal=? AND json=?", tuple(row[key] for key in ("id", "kind", "revision", "ordinal", "json")))
            require(cursor.rowcount == 1, "Unexpected record delete count")
            deleted_count += cursor.rowcount
        for change in changes:
            cursor = connection.execute("UPDATE transactions SET result=? WHERE id=? AND result=?", (change["afterResult"], change["before"]["id"], change["before"]["result"]))
            require(cursor.rowcount == 1, "Unexpected transaction update count")
        if _fault:
            _fault("after_mutations", connection)
        connection.execute(definitions["immutable_records_delete"])
        connection.execute(definitions["immutable_transactions_update"])
        require(triggers(connection) == definitions, "Append-only trigger restoration failed")
        next_revision = revision + 1
        audit = {"id": plan["operationId"], "revision": next_revision, "payload_hash": digest({"operation": "targeted-test-cleanup", "planDigest": plan_digest}), "profile": encoded({"name": "系统维护", "role": "system", "operation": "targeted-test-cleanup"}), "created_at": now(), "result": encoded({"revision": next_revision, "delta": {"tasks": [], "events": [], "batches": []}})}
        connection.execute("INSERT INTO transactions(id,revision,payload_hash,profile,created_at,result) VALUES(?,?,?,?,?,?)", tuple(audit[key] for key in ("id", "revision", "payload_hash", "profile", "created_at", "result")))
        put_metadata(connection, "revision", str(next_revision))
        put_metadata(connection, "fullSnapshotRevision", str(max(barrier, next_revision)))
        put_metadata(connection, "retiredTaskIds", encoded(sorted(retired)))
        marker = {"operationId": plan["operationId"], "planDigest": plan_digest, "revision": next_revision, "counts": counts(selected), "auditTransaction": audit}
        put_metadata(connection, operation_key, encoded(marker))
        deleted_ids = {row["id"] for row in selected}
        require(deleted_count == len(selected), "Total delete count mismatch")
        require(digest(rows(connection, "records")) == digest([row for row in record_before if row["id"] not in deleted_ids]), "Unrelated records were changed")
        changed_results = {change["before"]["id"]: change["afterResult"] for change in changes}
        expected_transactions = [{**row, "result": changed_results.get(row["id"], row["result"])} for row in transaction_before] + [audit]
        require(digest(rows(connection, "transactions")) == digest(sorted(expected_transactions, key=lambda row: row["id"])), "Unrelated transaction data was changed")
        require(digest(rows(connection, "sessions")) == digest(session_before), "Sessions were changed")
        expected_metadata = {**values, "revision": str(next_revision), "fullSnapshotRevision": str(max(barrier, next_revision)), "retiredTaskIds": encoded(sorted(retired)), operation_key: encoded(marker)}
        require(metadata(connection) == expected_metadata, "Unrelated metadata was changed")
        require(triggers(connection) == definitions, "Trigger definitions were not restored")
        if _fault:
            _fault("before_commit", connection)
        elapsed_ms = round((time.monotonic() - started) * 1000, 3)
        require(elapsed_ms < 1500, "Cleanup transaction exceeded its time budget; rolled back")
        connection.execute("COMMIT")
        began = False
        return {"status": "applied", "operationId": plan["operationId"], "revision": next_revision, "previousRevision": revision, "counts": counts(selected), "affectedTransactions": len(changes), "transactionMs": elapsed_ms, "planDigest": plan_digest}
    except Exception:
        if began:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


def main():
    try:
        request = json.load(sys.stdin)
        require(isinstance(request, dict), "Request must be an object")
        operation = request.get("operation")
        require(operation in {"prepare", "apply"}, "Only prepare and apply are supported")
        result = prepare(request) if operation == "prepare" else apply(request)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        # Avoid echoing raw task or event data in shell logs.
        print(json.dumps({"status": "error", "error": type(error).__name__, "message": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
