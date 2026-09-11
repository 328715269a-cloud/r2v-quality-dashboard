'use strict';

// The launcher itself has no npm dependencies. --browser adds an optional local
// Playwright smoke check when the supplied development repository has it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { start } = require('./dev-server.cjs');
const args = process.argv.slice(2);
const repoIndex = args.indexOf('--repo');
const repo = path.resolve(repoIndex >= 0 ? args[repoIndex + 1] : path.join(__dirname, '..', 'github-r2v-quality-dashboard'));
const out = path.join(__dirname, 'dev-server-verification.json');
const sha = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const sourceFiles = ['index.html', 'styles.css', 'app.js', 'data-io.js', 'shared-store.js', 'workflow.js', 'reports.js'].map(f => 'group-workbench/' + f).concat(['workbench-api/server.cjs', 'workbench-api/rules.cjs']);
const sourceHashes = () => Object.fromEntries(sourceFiles.map(file => [file, sha(path.join(repo, file))]));
const originalEnvironment = Object.fromEntries(['WB_LOCAL_ADMIN_PIN', 'WB_LOCAL_GROUP_PIN', 'DATA_DIR', 'ADMIN_PIN', 'GROUP_PIN', 'HOST', 'PORT', 'EXISTING_DATABASE_ONLY', 'BACKUP_INTERVAL_MS'].map(key => [key, process.env[key]]));
const report = { ok: false, productionAccess: false, externalRequests: [], checks: {}, sourceHashes: sourceHashes(), dataDirectories: [] };
const openServers = [];
let browser;
function raw(origin, rawPath, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const req = http.request({ hostname: url.hostname, port: url.port, path: rawPath, method, headers }, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', part => body += part);
      response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
    });
    req.on('error', reject); req.end();
  });
}
async function api(server, endpoint, method = 'GET', token, body) {
  const response = await fetch(server.origin + '/group-workbench-api/' + endpoint, { method, headers: { 'X-Workbench-Client': 'import-delete-v1', ...(token ? { 'X-Workbench-Session': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  assert.equal(response.status, 200, endpoint + ': ' + JSON.stringify(result));
  return result;
}
async function launch(options) {
  const server = await start({ repo, ...options });
  openServers.push(server);
  report.dataDirectories.push(server.directory);
  assert.equal(server.server.address().address, '127.0.0.1');
  return server;
}

(async () => {
  try {
    delete process.env.WB_LOCAL_ADMIN_PIN; delete process.env.WB_LOCAL_GROUP_PIN;
    await assert.rejects(start({ repo }), /WB_LOCAL_ADMIN_PIN/);
    report.checks.explicitLocalPinsRequired = true;
    const localAdminPin = crypto.randomBytes(16).toString('hex');
    const localGroupPin = crypto.randomBytes(16).toString('hex');
    process.env.WB_LOCAL_ADMIN_PIN = localAdminPin; process.env.WB_LOCAL_GROUP_PIN = localGroupPin;
    const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-unrelated-'));
    fs.writeFileSync(path.join(unrelated, 'do-not-adopt.txt'), 'Unrelated directory must remain untouched.');
    process.env.DATA_DIR = unrelated; process.env.ADMIN_PIN = 'not-the-local-pin'; process.env.GROUP_PIN = 'not-the-local-pin';
    process.env.HOST = '0.0.0.0'; process.env.PORT = '8895'; process.env.EXISTING_DATABASE_ONLY = '1'; process.env.BACKUP_INTERVAL_MS = '1';
    await assert.rejects(start({ repo, dataDir: unrelated }), /nonempty directory/);
    await assert.rejects(start({ repo, port: 'not-a-port' }), /--port/);
    const first = await launch();
    assert.notEqual(first.directory, unrelated);
    assert.equal(fs.readdirSync(unrelated).join(','), 'do-not-adopt.txt');
    report.checks.productionEnvironmentIgnoredAndUnmarkedDirectoryRejected = true;
    const health = await api(first, 'health');
    assert.equal(health.revision, 0); assert.equal(health.capabilities.importDelete.enabled, true);
    const html = await raw(first.origin, '/group-workbench/');
    assert.equal(html.status, 200); assert.match(html.body, /\[本地开发\]/); assert.match(html.body, /本地开发：任务保存在独立 SQLite/);
    assert.doesNotMatch(html.body, /href=["']\/work-mode-entry\./);
    assert.match(html.headers['content-security-policy'], /connect-src 'self'/);
    for (const name of ['styles.css', 'app.js', 'data-io.js', 'shared-store.js', 'workflow.js', 'reports.js']) {
      const response = await fetch(first.url + name + '?v=local-test');
      assert.equal(response.status, 200);
      assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), report.sourceHashes['group-workbench/' + name]);
    }
    assert.equal((await raw(first.origin, '/')).status, 302);
    for (const route of ['/group-workbench/HANDOFF.md', '/workbench-api/server.cjs', '/group-workbench-api/other', '/group-beta/', '/group-workbench-beta/', '/work-mode-entry.20260910.css', '/.git/config']) assert.equal((await raw(first.origin, route)).status, 404, route);
    for (const route of ['/group-workbench/../workbench-api/server.cjs', '/group-workbench/%2e%2e/server.cjs', '/group-workbench/%2e%2e%2fserver.cjs', '/group-workbench/%5c..%5cserver.cjs', '/group-workbench/%00', '/group-workbench/%', '//example.invalid/']) assert.equal((await raw(first.origin, route)).status, 400, route);
    assert.equal((await raw(first.origin, '/group-workbench/', { Host: 'example.invalid' })).status, 421);
    assert.equal((await raw(first.origin, '/group-workbench-api/health', { Origin: 'https://example.invalid' })).status, 403);
    assert.equal((await raw(first.origin, '/group-workbench/app.js', {}, 'POST')).status, 405);
    report.checks.loopbackOnlyStrictWhitelistTraversalHostAndOrigin = true;
    report.checks.pageAndAllAssetsLoadWithoutSourceChanges = true;
    const login = await api(first, 'session', 'POST', null, { profile: { name: 'admin', role: 'admin' }, pin: localAdminPin });
    assert.equal((await api(first, 'state', 'GET', login.token)).state.tasks.length, 0);
    const groupSession = await api(first, 'session', 'POST', null, { profile: { name: '本地组长', role: 'qc', mode: 'single', groupId: 'g01' }, pin: localGroupPin });
    await api(first, 'session', 'DELETE', groupSession.token);
    const batchId = crypto.randomUUID(), taskId = crypto.randomUUID();
    const task = { id: taskId, tid: 'LOCAL-ONBOARDING-001', movie: '本地接手验证影片', date: '2026-09-11', mode: 'single', groupId: 'g01', batchId };
    await api(first, 'transactions', 'POST', login.token, { id: crypto.randomUUID(), revision: 0, delta: { tasks: [task], batches: [{ id: batchId, movie: task.movie, date: task.date, mode: task.mode, groupId: task.groupId, taskIds: [taskId] }], events: [{ id: crypto.randomUUID(), taskId, type: 'dispatch' }] } });
    assert.equal((await api(first, 'state', 'GET', login.token)).revision, 1);
    report.checks.freshEmptyDatabaseRealLocalApiSave = true;
    await first.close();
    await assert.rejects(raw(first.origin, '/group-workbench-api/health'), /ECONNREFUSED/);
    const second = await launch({ dataDir: first.directory });
    assert.equal((await api(second, 'session', 'GET', login.token)).profile.role, 'admin');
    const persisted = await api(second, 'state', 'GET', login.token);
    assert.equal(persisted.revision, 1); assert.equal(persisted.state.tasks[0].tid, task.tid);
    const worker = await api(second, 'session', 'POST', null, { profile: { name: '本地标注', role: 'annotation', mode: 'single', groupId: 'g01' } });
    await api(second, 'transactions', 'POST', worker.token, { id: crypto.randomUUID(), revision: 1, delta: { events: [{ id: crypto.randomUUID(), taskId, type: 'claim', assignee: '本地标注' }] } });
    const backup = await api(second, 'backup', 'GET', login.token);
    assert.equal(backup.revision, 2); assert.equal(backup.state.tasks.length, 1); assert.equal(backup.state.events.length, 2);
    report.checks.restartPreservesSessionAndRecordsAndAllowsFurtherSave = true;
    report.checks.localBackupPreservesHistory = true;
    if (args.includes('--browser')) {
      const { chromium } = require(require.resolve('playwright', { paths: [repo] }));
      browser = await chromium.launch({ executablePath: process.env.WB_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
      const context = await browser.newContext();
      const errors = [];
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === second.origin) return route.continue();
        report.externalRequests.push(url.origin + url.pathname); return route.abort();
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(second.url);
      await page.locator('#adminEntry').click();
      await page.locator('#identityAdminName').fill('admin'); await page.locator('#identityAdminPin').fill(localAdminPin);
      await page.locator('#identityAdminForm button[type=submit]').click();
      await page.locator('#appShell').waitFor({ state: 'visible' });
      await page.waitForFunction(() => window.GroupWorkbench.getState().tasks.length === 1);
      assert.equal(await page.evaluate(() => localStorage.length), 0);
      await page.reload(); await page.locator('#appShell').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.r2v-work-mode').isVisible(), false);
      assert.deepEqual(errors, []); assert.deepEqual(report.externalRequests, []);
      await context.close(); await browser.close(); browser = null;
      report.checks.realBrowserLoginReloadNoErrorsOrExternalRequests = true;
    }
    await api(second, 'session', 'DELETE', worker.token); await api(second, 'session', 'DELETE', login.token);
    const third = await launch();
    assert.notEqual(third.directory, first.directory); assert.equal((await api(third, 'health')).revision, 0);
    report.checks.defaultEveryStartIsFresh = true;
    assert.deepEqual(sourceHashes(), report.sourceHashes);
    report.checks.sourceHashesStable = true;
    report.launcherSha256 = sha(path.join(__dirname, 'dev-server.cjs'));
    report.ok = true;
  } catch (error) { report.error = { message: error.message, stack: error.stack }; }
  finally {
    if (browser) await browser.close();
    for (const server of openServers) await server.close();
    report.allServersClosed = openServers.every(server => !server.server.listening);
    report.browserClosed = !browser || !browser.isConnected();
    for (const [key, value] of Object.entries(originalEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    report.dataDirectories = [...new Set(report.dataDirectories)];
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ok: report.ok, checks: Object.keys(report.checks).length, allServersClosed: report.allServersClosed, browserClosed: report.browserClosed, report: out, error: report.error?.message }));
    if (!report.ok) process.exitCode = 1;
  }
})();
