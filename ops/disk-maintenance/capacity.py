#!/usr/bin/env python3
"""Low-cost disk/backup telemetry. Writes only its own maintenance status."""
import datetime as dt
import json
import math
import os
import pathlib
import syslog
import tempfile

BASE = pathlib.Path('/opt/r2v/maintenance/disk')
BACKUPS = pathlib.Path('/opt/r2v/group-workbench-data/backups')


def threshold(percent):
    return next((x for x in (90, 85, 80) if percent >= x), 0)


def collect():
    s = os.statvfs('/')
    used = s.f_blocks - s.f_bfree
    percent = 100 * used / (used + s.f_bavail)
    files = [p for p in BACKUPS.glob('workbench-*.sqlite') if p.is_file() and not p.is_symlink()]
    latest = max(files, key=lambda p:p.stat().st_mtime) if files else None
    now = dt.datetime.now(dt.timezone.utc)
    age = (now.timestamp()-latest.stat().st_mtime) if latest else None
    return {'checkedAt': now.isoformat(), 'usedPercent': round(percent, 2),
            'displayPercent': math.ceil(percent), 'availableBytes': s.f_bavail*s.f_frsize,
            'threshold': threshold(percent), 'latestBackup': latest.name if latest else None,
            'backupAgeSeconds': round(age) if age is not None else None,
            'backupStale': age is None or age > 4*3600,
            'productionDataModified': False}


def main():
    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = BASE/'capacity.json'
    if BASE.is_symlink() or target.is_symlink():
        raise RuntimeError('Unsafe maintenance path')
    previous = json.loads(target.read_text()) if target.exists() else {}
    value = collect()
    signature = (value['threshold'], value['backupStale'])
    old = (previous.get('threshold', 0), previous.get('backupStale', False))
    if signature != old:
        syslog.openlog('r2v-capacity')
        syslog.syslog(syslog.LOG_WARNING if any(signature) else syslog.LOG_NOTICE,
                      json.dumps(value, ensure_ascii=False))
    fd, tmp = tempfile.mkstemp(prefix='.capacity-', dir=BASE)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f); f.write('\n'); f.flush(); os.fsync(f.fileno())
    os.replace(tmp,target)
    print(json.dumps(value))


if __name__ == '__main__':
    main()
