import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const backupRoot = path.resolve(repo, '..', 'backups', 'r2v-quality');
const configText = await readFile(path.join(repo, 'config.js'), 'utf8');
const supabaseUrl = configText.match(/supabaseUrl:\s*["']([^"']+)/)?.[1];
const supabaseKey = configText.match(/supabaseKey:\s*["']([^"']+)/)?.[1];
if (!supabaseUrl || !supabaseKey) throw new Error('无法从 config.js 读取 Supabase 配置');

const tables = [
  'r2v_quality_events',
  'r2v_quality_feedback',
  'r2v_quality_appeals',
  'r2v_quality_staff_roles',
  'r2v_quality_imports',
  'r2v_quality_admin_audit'
];
const headers = { apikey: supabaseKey };

async function readAll(table) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const url = `${supabaseUrl}/rest/v1/${table}?select=*&limit=1000&offset=${offset}`;
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`${table} 读取失败：HTTP ${response.status}`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

const snapshot = { createdAt: new Date().toISOString(), source: supabaseUrl, tables: {} };
for (const table of tables) snapshot.tables[table] = await readAll(table);

await mkdir(path.join(backupRoot, 'snapshots'), { recursive: true });
await mkdir(path.join(backupRoot, 'evidence'), { recursive: true });
const stamp = snapshot.createdAt.replace(/[:.]/g, '-');
const snapshotPath = path.join(backupRoot, 'snapshots', `${stamp}.json.gz`);
await writeFile(snapshotPath, gzipSync(JSON.stringify(snapshot)));

const evidenceUrls = [...new Set(snapshot.tables.r2v_quality_feedback.flatMap(row => Array.isArray(row.evidence) ? row.evidence : []))];
let downloaded = 0, failed = 0;
async function backupEvidence(url) {
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'evidence.bin').replace(/[<>:"/\\|?*]/g, '_');
  const destination = path.join(backupRoot, 'evidence', name);
  try { await access(destination); return; } catch {}
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
  downloaded++;
}
for (let index = 0; index < evidenceUrls.length; index += 8) {
  const results = await Promise.allSettled(evidenceUrls.slice(index, index + 8).map(backupEvidence));
  failed += results.filter(result => result.status === 'rejected').length;
}

const manifest = {
  lastBackupAt: snapshot.createdAt,
  lastSnapshot: snapshotPath,
  tableCounts: Object.fromEntries(Object.entries(snapshot.tables).map(([table, rows]) => [table, rows.length])),
  evidenceReferenced: evidenceUrls.length,
  evidenceDownloadedThisRun: downloaded,
  evidenceFailedThisRun: failed
};
await writeFile(path.join(backupRoot, 'latest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
