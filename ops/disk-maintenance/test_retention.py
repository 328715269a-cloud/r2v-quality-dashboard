import datetime as dt
import importlib.util
import json
import os
import pathlib
import sqlite3
import tempfile
import unittest

MODULE = pathlib.Path(__file__).with_name('retention.py')
spec = importlib.util.spec_from_file_location('retention', MODULE)
r = importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
NOW = dt.datetime(2026, 11, 2, 3, 56, tzinfo=r.UTC)


def filename(at):
    return 'workbench-' + at.astimezone(r.UTC).strftime('%Y-%m-%dT%H-%M-%S-000Z') + '.sqlite'


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name) / 'backups'
        self.root.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def backup(self, at, *, folder=None, valid=True, name=None):
        parent = folder or self.root;parent.mkdir(exist_ok=True)
        p = parent / (name or filename(at))
        if valid:
            db = sqlite3.connect(p)
            db.execute('PRAGMA synchronous=OFF')  # Disposable fixture only.
            db.executescript("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO metadata VALUES('revision','34349'); CREATE TABLE records(id TEXT PRIMARY KEY,json TEXT); INSERT INTO records VALUES('a','{}'); CREATE TABLE transactions(id TEXT PRIMARY KEY,result TEXT); CREATE TABLE sessions(id TEXT PRIMARY KEY);")
            db.close()
        else:
            p.write_bytes(b'corrupt backup' * 100)
        os.utime(p, (at.timestamp(), at.timestamp()))
        return p

    def populate(self, hours=24*35):
        for age in range(1, hours + 1):
            self.backup(NOW - dt.timedelta(hours=age))

    def test_dry_run_has_no_filesystem_mutation_and_manual_untouched(self):
        self.populate(60)
        manual = self.backup(NOW - dt.timedelta(days=100), name='release-critical-20260701.sqlite')
        before = {str(p.relative_to(self.root)): (p.stat().st_size, p.stat().st_mtime_ns) for p in self.root.rglob('*')}
        plan = r.make_plan(self.root, NOW)
        self.assertIn(manual.name, plan['manualUntouched'])
        self.assertGreater(plan['deleteCount'], 0)
        self.assertEqual(before, {str(p.relative_to(self.root)): (p.stat().st_size, p.stat().st_mtime_ns) for p in self.root.rglob('*')})

    def test_policy_hour_daily_week_counts_and_longterm_location(self):
        self.populate()
        plan = r.make_plan(self.root, NOW)
        self.assertLessEqual(plan['retainedCount'], 48+14+4)
        kept = {i['name'] for i in plan['retained']}
        for age in range(1, 49):
            self.assertIn(filename(NOW-dt.timedelta(hours=age)), kept)
        for m in plan['moves']:
            self.assertEqual(pathlib.Path(m['to']).parts[0], 'tiered')
        self.assertGreater(len(plan['moves']), 10)
        self.assertNotIn(filename(NOW-dt.timedelta(days=35)), kept)
        local_today = NOW.astimezone(r.CHINA).date()
        for day in range(14):
            target = local_today-dt.timedelta(days=day)
            matches = [i for i in plan['retained'] if dt.datetime.fromisoformat(i['at']).astimezone(r.CHINA).date() == target]
            self.assertTrue(matches, str(target))

    def test_chinese_midnight_daily_and_monday_week_boundary(self):
        self.backup(NOW-dt.timedelta(hours=1))
        a = self.backup(dt.datetime(2026,10,25,15,59,tzinfo=r.UTC))  # Sun 23:59 CST
        b = self.backup(dt.datetime(2026,10,25,16,1,tzinfo=r.UTC))   # Mon 00:01 CST
        c = self.backup(dt.datetime(2026,10,25,17,1,tzinfo=r.UTC))
        plan = r.make_plan(self.root, NOW)
        kept = {i['name'] for i in plan['retained']}
        self.assertIn(a.name, kept);self.assertIn(c.name, kept);self.assertNotIn(b.name, kept)

    def test_fresh_file_is_untouched_and_old_latest_stops_all_cleanup(self):
        self.populate(60)
        fresh = self.backup(NOW-dt.timedelta(seconds=30), valid=False)
        plan = r.make_plan(self.root, NOW)
        self.assertIn(fresh.name, {i['name'] for i in plan['freshUntouched']})
        with self.assertRaisesRegex(r.SafetyError, 'four hours'):
            r.make_plan(self.root, NOW+dt.timedelta(hours=6))

    def test_recent_file_modified_now_is_not_touched(self):
        self.populate(60)
        changing = self.root/filename(NOW-dt.timedelta(hours=55))
        os.utime(changing, (NOW.timestamp(), NOW.timestamp()))
        plan = r.make_plan(self.root, NOW)
        self.assertIn(changing.name, {i['name'] for i in plan['freshUntouched']})

    def test_corrupt_retained_backup_prevents_every_deletion(self):
        self.populate(60)
        latest = self.root/filename(NOW-dt.timedelta(hours=1))
        latest.write_bytes(b'corrupt backup'*100)
        t=(NOW-dt.timedelta(hours=1)).timestamp();os.utime(latest, (t,t))
        plan=r.make_plan(self.root,NOW)
        before={p.name for p in self.root.glob('*.sqlite')}
        with self.assertRaisesRegex(r.SafetyError, 'Cannot verify'):
            r.apply_plan(self.root,plan)
        self.assertEqual(before,{p.name for p in self.root.glob('*.sqlite')})

    def test_apply_validates_moves_retains_latest_and_cache_reuse(self):
        self.populate(24*16)
        manual=self.backup(NOW-dt.timedelta(days=100),name='release-critical.sqlite')
        original_manual=manual.read_bytes()
        plan=r.make_plan(self.root,NOW)
        result=r.apply_plan(self.root,plan)
        self.assertTrue(result['ok']);self.assertEqual(result['verifiedCount'],plan['retainedCount'])
        self.assertEqual(result['reclaimedBytes'],plan['reclaimBytes'])
        self.assertTrue((self.root/plan['latestStable']).exists())
        self.assertEqual(manual.read_bytes(),original_manual)
        for move in plan['moves']:
            self.assertFalse((self.root/move['from']).exists())
            self.assertEqual(r.signature(self.root/move['to']),move['signature'])
        plan2=r.make_plan(self.root,NOW)
        self.assertEqual(plan2['deleteCount'],0);self.assertFalse(plan2['moves'])
        result2=r.apply_plan(self.root,plan2)
        self.assertEqual(result2['verificationCacheHits'],plan2['retainedCount'])
        self.assertTrue((self.root/'.retention'/'last-run.json').exists())

    def test_delete_fingerprint_conflict_and_new_hourly_file_safe(self):
        self.populate(60)
        plan=r.make_plan(self.root,NOW)
        victim=plan['deletes'][0]
        new=self.backup(NOW-dt.timedelta(minutes=10))
        def race(item):
            if item['name']==victim['name']:
                p=self.root/item['path'];os.utime(p,None)
        with self.assertRaisesRegex(r.SafetyError,'changed after planning'):
            r.apply_plan(self.root,plan,before_delete=race)
        self.assertTrue((self.root/victim['path']).exists());self.assertTrue(new.exists())
        logged=json.loads((self.root/'.retention'/'last-run.json').read_text())
        self.assertFalse(logged['ok']);self.assertEqual(logged['deleted'],[])

    def test_changed_recovery_point_stops_delete(self):
        self.populate(60);plan=r.make_plan(self.root,NOW)
        latest=self.root/plan['latestStable']
        def race(item):os.utime(latest,None)
        with self.assertRaisesRegex(r.SafetyError,'Retained recovery point changed'):
            r.apply_plan(self.root,plan,before_delete=race)
        self.assertTrue(all((self.root/i['path']).exists() for i in plan['deletes']))

    def test_duplicate_root_tiered_fails_closed(self):
        p=self.backup(NOW-dt.timedelta(hours=1));(self.root/'tiered').mkdir()
        os.link(p,self.root/'tiered'/p.name)
        with self.assertRaisesRegex(r.SafetyError,'Duplicate'):
            r.make_plan(self.root,NOW)

    def test_active_sqlite_sidecar_fails_closed(self):
        p=self.backup(NOW-dt.timedelta(hours=1));p.with_name(p.name+'-wal').write_bytes(b'x')
        with self.assertRaisesRegex(r.SafetyError,'sidecar'):
            r.make_plan(self.root,NOW)

    def test_path_traversal_and_wrong_root_rejected(self):
        with self.assertRaisesRegex(r.SafetyError,'named backups'):
            r.safe_root(self.root.parent)
        with self.assertRaisesRegex(r.SafetyError,'relative path'):
            r.checked_path(self.root,'../workbench.sqlite')
        with self.assertRaisesRegex(r.SafetyError,'relative path'):
            r.checked_path(self.root,'tiered/nested/'+filename(NOW))

    def test_symlinks_fail_closed(self):
        target=self.backup(NOW-dt.timedelta(hours=1))
        link=self.root/filename(NOW-dt.timedelta(hours=2))
        try:link.symlink_to(target)
        except OSError:self.skipTest('OS does not permit symlinks for test account')
        with self.assertRaisesRegex(r.SafetyError,'regular non-symlink'):
            r.make_plan(self.root,NOW)

    @unittest.skipIf(os.name=='nt','Linux flock runtime check')
    def test_overlapping_run_refused(self):
        with r.exclusive_lock(self.root):
            with self.assertRaisesRegex(r.SafetyError,'Another retention run'):
                with r.exclusive_lock(self.root):pass


if __name__=='__main__':unittest.main(verbosity=2)
