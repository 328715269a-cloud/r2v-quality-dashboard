#!/usr/bin/env python3
"""Read-only by default; tier completed workbench backups without touching live DB.

The existing hourly backup producer may keep running. It only scans its root
directory, so daily/weekly restore points are moved to ``tiered`` before older
hourly copies are removed. Unknown names and deployment/manual backups are never
managed here. Run under nice/ionice; the first verification reads retained files.
"""
import argparse
import contextlib
import datetime as dt
import json
import os
import pathlib
import re
import sqlite3
import stat
import sys
import time
import uuid

UTC = dt.timezone.utc
CHINA = dt.timezone(dt.timedelta(hours=8))
DEFAULT_ROOT = pathlib.Path('/opt/r2v/group-workbench-data/backups')
NAME = re.compile(r'^workbench-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.sqlite$')
MIN_STABLE_SECONDS = 120
MAX_LATEST_AGE_SECONDS = 4 * 3600
VERIFY_CACHE_SECONDS = 7 * 86400


class SafetyError(RuntimeError):
    pass


def stamp(name):
    m = NAME.fullmatch(name)
    if not m:
        return None
    try:
        return dt.datetime.fromisoformat(f'{m[1]}T{m[2]}:{m[3]}:{m[4]}.{m[5]}+00:00')
    except ValueError:
        return None


def signature(path):
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode) or stat.S_ISLNK(s.st_mode):
        raise SafetyError(f'Not a regular non-symlink file: {path.name}')
    return {'dev': s.st_dev, 'ino': s.st_ino, 'bytes': s.st_size, 'mtimeNs': s.st_mtime_ns}


def safe_root(root):
    root = pathlib.Path(os.path.abspath(root))
    if root.name != 'backups' or not root.is_dir():
        raise SafetyError('Root must be an existing directory named backups')
    for p in [root, *root.parents]:
        if p.is_symlink():
            raise SafetyError(f'Symlink directory is not allowed: {p}')
    # Normalize Windows 8.3 aliases in isolated tests; symlink ancestry was
    # checked first. On the production Linux host this preserves the same path.
    root = root.resolve()
    for name in ['tiered', '.retention']:
        p = root / name
        if p.is_symlink() or (p.exists() and not p.is_dir()):
            raise SafetyError(f'Unsafe maintenance directory: {name}')
    return root


def scan(root, now):
    root = safe_root(root)
    candidates, ignored, fresh = [], [], []
    seen = set()
    for folder in [root, root / 'tiered']:
        if not folder.exists():
            continue
        for p in sorted(folder.iterdir()):
            date = stamp(p.name)
            if date is None:
                if p.is_file() or p.is_symlink():
                    ignored.append(str(p.relative_to(root)))
                continue
            sig = signature(p)
            rel = str(p.relative_to(root))
            if p.name in seen:
                raise SafetyError(f'Duplicate root/tiered backup: {p.name}')
            seen.add(p.name)
            item = {'path': rel, 'name': p.name, 'at': date.isoformat(), 'signature': sig}
            age = (now - date).total_seconds()
            modified_age = now.timestamp() - sig['mtimeNs'] / 1e9
            if age < MIN_STABLE_SECONDS or modified_age < MIN_STABLE_SECONDS:
                fresh.append(item)
                continue
            if (p.with_name(p.name + '-wal')).exists() or (p.with_name(p.name + '-journal')).exists():
                raise SafetyError(f'Backup has an active SQLite sidecar: {p.name}')
            if sig['bytes'] < 512:
                raise SafetyError(f'Backup is empty or incomplete: {p.name}')
            candidates.append(item)
    candidates.sort(key=lambda x: x['at'])
    return candidates, ignored, fresh


def make_plan(root, now=None):
    now = (now or dt.datetime.now(UTC)).astimezone(UTC)
    root = safe_root(root)
    items, ignored, fresh = scan(root, now)
    if not items:
        raise SafetyError('No completed stable automatic backup exists; cleanup refused')
    latest = items[-1]
    if (now - dt.datetime.fromisoformat(latest['at'])).total_seconds() > MAX_LATEST_AGE_SECONDS:
        raise SafetyError('Newest stable automatic backup is more than four hours old; cleanup refused')
    today = now.astimezone(CHINA).date()
    daily_start = today - dt.timedelta(days=13)
    weekly_start = today - dt.timedelta(days=today.weekday() + 21)
    hour_buckets, day_buckets, week_buckets = {}, {}, {}
    for item in items:
        date = dt.datetime.fromisoformat(item['at'])
        local = date.astimezone(CHINA)
        if date >= now - dt.timedelta(hours=48):
            hour_buckets[local.strftime('%Y-%m-%dT%H')] = item
        if local.date() >= daily_start:
            day_buckets[local.date().isoformat()] = item
        week = local.date() - dt.timedelta(days=local.weekday())
        if week >= weekly_start:
            week_buckets[week.isoformat()] = item
    recent = {x['name'] for x in hour_buckets.values()}
    keep = {latest['name'], *recent, *(x['name'] for x in day_buckets.values()), *(x['name'] for x in week_buckets.values())}
    retained, moves, deletes = [], [], []
    for item in items:
        if item['name'] not in keep:
            deletes.append(item)
            continue
        retained.append(item)
        if item['path'] == item['name'] and item['name'] not in recent and item['name'] != latest['name']:
            moves.append({'from': item['path'], 'to': str(pathlib.Path('tiered') / item['name']), 'signature': item['signature']})
    return {'version': 1, 'checkedAt': now.isoformat(), 'root': str(root), 'policy': {'hourlyHours': 48, 'calendarDailyDays': 14, 'calendarWeeklyWeeks': 4, 'timezone': 'Asia/Shanghai'}, 'latestStable': latest['name'], 'retained': retained, 'moves': moves, 'deletes': deletes, 'freshUntouched': fresh, 'manualUntouched': ignored, 'retainedCount': len(retained), 'deleteCount': len(deletes), 'reclaimBytes': sum(x['signature']['bytes'] for x in deletes), 'retainedBytes': sum(x['signature']['bytes'] for x in retained)}


def checked_path(root, relative):
    p = pathlib.Path(relative)
    if p.is_absolute() or '..' in p.parts or len(p.parts) not in [1, 2] or (len(p.parts) == 2 and p.parts[0] != 'tiered') or not NAME.fullmatch(p.name):
        raise SafetyError('Invalid backup relative path')
    path = root / p
    safe_root(root)
    return path


def check_same(root, item):
    path = checked_path(root, item['path'])
    if signature(path) != item['signature']:
        raise SafetyError(f'Backup changed after planning: {item["name"]}')
    return path


def verify_sqlite(path, expected, timeout=60):
    if signature(path) != expected:
        raise SafetyError(f'Backup changed before verification: {path.name}')
    started = time.monotonic()
    db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro&immutable=1', uri=True, timeout=1)
    try:
        db.execute('PRAGMA query_only=ON')
        db.set_progress_handler(lambda: int(time.monotonic() - started > timeout), 10000)
        results = [r[0] for r in db.execute('PRAGMA integrity_check')]
        if results != ['ok']:
            raise SafetyError(f'SQLite integrity failed: {path.name}')
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'metadata', 'records', 'transactions', 'sessions'}.issubset(tables):
            raise SafetyError(f'Not a complete workbench backup: {path.name}')
        row = db.execute("SELECT value FROM metadata WHERE key='revision'").fetchone()
        if row is None or not str(row[0]).isdigit():
            raise SafetyError(f'Backup has no valid revision: {path.name}')
        revision = int(row[0])
    except sqlite3.Error as e:
        raise SafetyError(f'Cannot verify SQLite backup {path.name}: {e}') from e
    finally:
        db.close()
    if signature(path) != expected:
        raise SafetyError(f'Backup changed during verification: {path.name}')
    return {'revision': revision, 'integrity': 'ok', 'verifiedAt': dt.datetime.now(UTC).isoformat()}


def write_json(path, value):
    if path.is_symlink():
        raise SafetyError('Refusing to overwrite a symlink')
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w', encoding='utf8') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n');f.flush();os.fsync(f.fileno())
    os.replace(tmp, path)


@contextlib.contextmanager
def exclusive_lock(root):
    try:
        import fcntl
    except ImportError as e:
        raise SafetyError('Apply requires Linux flock support') from e
    root = safe_root(root)
    folder = root / '.retention';folder.mkdir(mode=0o700, exist_ok=True)
    lock = folder / 'lock'
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            raise SafetyError('Another retention run is active') from e
        yield
    finally:
        os.close(fd)


def apply_plan(root, plan, before_delete=None):
    """Caller must hold exclusive_lock; hook is only for isolated race tests."""
    root = safe_root(root)
    if plan['root'] != str(root):
        raise SafetyError('Plan root mismatch')
    folder = root / '.retention';folder.mkdir(mode=0o700, exist_ok=True)
    cache_path = folder / 'verified.json'
    if cache_path.is_symlink():
        raise SafetyError('Unsafe verification cache')
    try:
        cache = json.loads(cache_path.read_text(encoding='utf8')) if cache_path.exists() else {}
    except (ValueError, OSError):
        cache = {}
    verified, cache_hits = {}, 0
    # Verify every retained restore point before any rename or deletion. A newer
    # hourly producer file is deliberately not part of this frozen plan.
    for item in plan['retained']:
        path = check_same(root, item)
        old = cache.get(item['name'], {})
        try:
            age = (dt.datetime.now(UTC) - dt.datetime.fromisoformat(old['verifiedAt'])).total_seconds()
        except (KeyError, ValueError, TypeError):
            age = VERIFY_CACHE_SECONDS + 1
        if old.get('signature') == item['signature'] and old.get('integrity') == 'ok' and 0 <= age < VERIFY_CACHE_SECONDS:
            verified[item['name']] = old;cache_hits += 1
        else:
            verified[item['name']] = {**verify_sqlite(path, item['signature']), 'signature': item['signature']}
    for item in [*plan['retained'], *plan['deletes']]:
        check_same(root, item)
    write_json(cache_path, verified)
    result = {**plan, 'runId': uuid.uuid4().hex, 'startedAt': dt.datetime.now(UTC).isoformat(), 'verifiedCount': len(verified), 'verificationCacheHits': cache_hits, 'moved': [], 'deleted': [], 'reclaimedBytes': 0, 'ok': False}
    log_path = folder / ('run-' + dt.datetime.now(UTC).strftime('%Y%m%dT%H%M%S') + '-' + result['runId'][:8] + '.json')
    write_json(log_path, result)
    try:
        (root / 'tiered').mkdir(mode=0o700, exist_ok=True)
        for move in plan['moves']:
            source = checked_path(root, move['from']);target = checked_path(root, move['to'])
            if signature(source) != move['signature'] or target.exists() or target.is_symlink():
                raise SafetyError('Archive source changed or destination already exists')
            # Hard-link then unlink makes no data copy and never replaces an
            # existing target. A crash between operations causes a safe abort on
            # the next scan (duplicate name), not loss of a recovery point.
            os.link(source, target, follow_symlinks=False)
            if signature(source) != move['signature'] or signature(target) != move['signature']:
                raise SafetyError('Archive changed during link')
            source.unlink()
            result['moved'].append(move)
        destinations = {m['from']: m['to'] for m in plan['moves']}
        retained_paths = [(checked_path(root, destinations.get(keep['path'], keep['path'])), keep['signature']) for keep in plan['retained']]
        for item in plan['deletes']:
            if before_delete:
                before_delete(item)
            path = check_same(root, item)
            # Retained targets must still exist before each destructive step.
            for kept_path, expected in retained_paths:
                if signature(kept_path) != expected:
                    raise SafetyError('Retained recovery point changed; cleanup stopped')
            path.unlink()
            result['deleted'].append(item['path'])
            result['reclaimedBytes'] += item['signature']['bytes']
        result['ok'] = True
    finally:
        result['finishedAt'] = dt.datetime.now(UTC).isoformat()
        write_json(log_path, result)
        write_json(folder / 'last-run.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=pathlib.Path, default=DEFAULT_ROOT)
    parser.add_argument('--apply', action='store_true', help='Verify restore points, then archive/prune; default is read-only plan')
    args = parser.parse_args()
    try:
        if args.apply:
            with exclusive_lock(args.root):
                value = apply_plan(args.root, make_plan(args.root))
        else:
            value = make_plan(args.root)
        print(json.dumps(value, ensure_ascii=False))
    except (SafetyError, OSError) as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
