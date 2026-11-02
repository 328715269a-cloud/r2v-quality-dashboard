#!/usr/bin/env python3
"""Export through Docker's supported logs API; never truncate the active log."""
import datetime as dt
import gzip
import hashlib
import json
import os
import pathlib
import subprocess

DEST = pathlib.Path('/opt/r2v/maintenance/disk/log-archives')
NAME = 'r2v-db-1'


def main():
    DEST.mkdir(parents=True, mode=0o700, exist_ok=True)
    if DEST.is_symlink(): raise RuntimeError('Unsafe archive directory')
    meta = json.loads(subprocess.check_output(['docker','inspect',NAME]))[0]
    cid = meta['Id']; start = meta['State']['StartedAt']
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    target = DEST/f'{NAME}-{stamp}.log.gz'
    temp = target.with_suffix('.gz.partial')
    digest = hashlib.sha256(); size = 0
    with temp.open('xb') as out:
        os.chmod(temp,0o600)
        # Docker merges captured container stdout/stderr for this export. The
        # command itself must exit successfully before any archive is accepted.
        process = subprocess.Popen(['docker','logs','--timestamps',cid],stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        with gzip.GzipFile(fileobj=out, mode='wb', compresslevel=1, mtime=0) as zipped:
            while True:
                data = process.stdout.read(1024*1024)
                if not data: break
                digest.update(data); size += len(data); zipped.write(data)
        if process.wait() != 0: raise RuntimeError('Docker logs export failed')
        out.flush(); os.fsync(out.fileno())
    check = hashlib.sha256(); restored = 0
    with gzip.open(temp,'rb') as f:
        while True:
            data = f.read(1024*1024)
            if not data:break
            check.update(data);restored+=len(data)
    if restored != size or check.digest() != digest.digest():raise RuntimeError('Archive verification failed')
    after = json.loads(subprocess.check_output(['docker','inspect',NAME]))[0]
    if after['Id'] != cid or after['State']['StartedAt'] != start:raise RuntimeError('Container changed during export')
    os.rename(temp,target)
    proof={'container':NAME,'containerId':cid,'startedAt':start,'file':str(target),'bytes':size,
           'compressedBytes':target.stat().st_size,'sha256':digest.hexdigest(),'verified':True,
           'originalLogRemoved':False,'finishedAt':dt.datetime.now(dt.timezone.utc).isoformat()}
    target.with_suffix('.json').write_text(json.dumps(proof,indent=2))
    print(json.dumps(proof))


if __name__=='__main__':main()
