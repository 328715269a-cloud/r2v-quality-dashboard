#!/usr/bin/env node
'use strict';

// Local development only. No package installation, seed data or remote proxy.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const HOST = '127.0.0.1';
const FILES = ['index.html', 'styles.css', 'app.js', 'data-io.js', 'shared-store.js', 'workflow.js', 'reports.js'];
const API_PATHS = new Set(['health', 'session', 'state', 'transactions', 'backup'].map(name => '/group-workbench-api/' + name));
const MARKER = '.workbuddy-local-data.json';
const MARKER_FORMAT = 'workbuddy-workbench-local-development';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

function fail(message) { throw new Error(message); }
function parseArgs(args) {
  const options = {};
  const flags = { '--repo': 'repo', '--port': 'port', '--data-dir': 'dataDir' };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (!flags[flag]) fail('Unknown option: ' + flag + '. Use --help.');
    const value = args[++index];
    if (!value || value.startsWith('--')) fail('Missing value for ' + flag);
    if (options[flags[flag]] !== undefined) fail('Repeated option: ' + flag);
    options[flags[flag]] = value;
  }
  return options;
}

function checkRuntime() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (!((major === 22 && (minor > 23 || (minor === 23 && patch >= 2))) || major > 24 || (major === 24 && minor >= 18))) {
    fail('Use Node.js 22.23.2+ (22.x) or 24.18.0+ with built-in node:sqlite. Current: ' + process.version);
  }
  require('node:sqlite');
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function realFile(filename, root) {
  const resolved = fs.realpathSync(filename);
  if (!inside(root, resolved) || !fs.statSync(resolved).isFile()) fail('File must remain inside its source directory: ' + filename);
  return resolved;
}

function resolveRepo(input) {
  const candidates = input ? [path.resolve(input)] : [
    path.resolve(__dirname, '..', 'github-r2v-quality-dashboard'),
    path.resolve(__dirname, '..', 'project'),
  ];
  const selected = candidates.find(candidate => fs.existsSync(path.join(candidate, 'workbench-api', 'server.cjs')));
  if (!selected) fail('Source repository not found. Pass --repo <path-to-github-r2v-quality-dashboard>.');
  const repo = fs.realpathSync(selected);
  const frontend = fs.realpathSync(path.join(repo, 'group-workbench'));
  const backend = fs.realpathSync(path.join(repo, 'workbench-api'));
  if (!inside(repo, frontend) || !inside(repo, backend)) fail('Source directories must remain inside --repo.');
  for (const file of FILES) realFile(path.join(frontend, file), frontend);
  realFile(path.join(backend, 'rules.cjs'), backend);
  return { repo, frontend, apiFile: realFile(path.join(backend, 'server.cjs'), backend) };
}

function localDirectory(input) {
  if (!input) return fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-workbench-'));
  if (/^(?:\\\\|\/\/)/.test(input)) fail('--data-dir cannot be a network/UNC path.');
  const resolved = path.resolve(input);
  if (resolved === path.parse(resolved).root) fail('--data-dir cannot be a filesystem root.');
  // Never adopt a production data directory, even when it happens to be empty.
  if (/^(?:\/var\/(?:lib|www)|\/opt|\/srv|\/etc)(?:\/|$)/i.test(resolved)) fail('Use a local development directory outside server/system paths.');
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) fail('--data-dir must be a directory, not a database file.');
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const real = fs.realpathSync(resolved);
  if (/^(?:\\\\|\/\/)/.test(real) || real === path.parse(real).root || /^(?:\/var\/(?:lib|www)|\/opt|\/srv|\/etc)(?:\/|$)/i.test(real)) {
    fail('Resolved --data-dir must be a local development directory.');
  }
  return real;
}

function prepareData(input) {
  const directory = localDirectory(input);
  const markerFile = path.join(directory, MARKER);
  const entries = fs.readdirSync(directory);
  if (entries.length) {
    if (!fs.existsSync(markerFile) || !fs.lstatSync(markerFile).isFile() || fs.lstatSync(markerFile).isSymbolicLink()) {
      fail('Refusing an existing nonempty directory without this launcher\'s local-data marker: ' + directory);
    }
    let marker;
    try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch { fail('Invalid local-data marker: ' + markerFile); }
    if (marker.format !== MARKER_FORMAT || marker.version !== 1) fail('Unrecognized local-data marker: ' + markerFile);
  } else {
    fs.writeFileSync(markerFile, JSON.stringify({ format: MARKER_FORMAT, version: 1, id: randomUUID(), createdAt: new Date().toISOString(), localOnly: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  for (const filename of ['workbench.sqlite', 'workbench.sqlite-wal', 'workbench.sqlite-shm']) {
    const file = path.join(directory, filename);
    if (!fs.existsSync(file) && !fs.lstatSync(file, { throwIfNoEntry: false })) continue;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || !inside(directory, fs.realpathSync(file))) {
      fail('Database and journal files must be ordinary isolated local files: ' + file);
    }
  }
  return directory;
}

function localHtml(html) {
  // The production-only mode bar links to another app, which is not served here.
  // These presentation changes exist only in the HTTP response, never on disk.
  return html
    .replace(/<link\b[^>]*href=["']\/work-mode-entry\.[^"']+["'][^>]*>\s*/gi, '')
    .replace('<title>', '<title>[本地开发] ')
    .replace('</head>', '<style>.r2v-work-mode,.identity-current-mode{display:none!important}</style></head>')
    .replace('任务与操作记录保存到云端。', '本地开发：任务保存在独立 SQLite 目录，与正式平台完全隔离。');
}

function requestPath(url) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return null;
  const raw = url.split('?')[0];
  // Reject before URL normalization so encoded traversal cannot become a route.
  if (/%(?:2f|5c)/i.test(raw)) return null;
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  if (/[\\\0#?]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) return null;
  return decoded;
}

async function start(options = {}) {
  checkRuntime();
  const adminPin = process.env.WB_LOCAL_ADMIN_PIN;
  const groupPin = process.env.WB_LOCAL_GROUP_PIN;
  if (!adminPin || !groupPin || adminPin.length > 64 || groupPin.length > 64 || !adminPin.trim() || !groupPin.trim()) {
    fail('Set nonempty WB_LOCAL_ADMIN_PIN and WB_LOCAL_GROUP_PIN (up to 64 characters) for this local environment. They are never printed.');
  }
  const portText = String(options.port ?? '0');
  if (!/^\d+$/.test(portText) || Number(portText) > 65535) fail('--port must be an integer from 0 to 65535; 0 selects a free port.');
  const source = resolveRepo(options.repo);
  const directory = prepareData(options.dataDir);
  const { createService } = require(source.apiFile);
  let service, origin, closePromise;
  const hosts = new Set();
  const server = http.createServer((request, response) => {
    const send = (status, text) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : text);
    };
    if (!hosts.has(request.headers.host)) return send(421, 'This development server accepts only its loopback host.');
    if (request.headers.origin && request.headers.origin !== origin && request.headers.origin !== origin.replace('127.0.0.1', 'localhost')) return send(403, 'Local same-origin requests only.');
    const pathname = requestPath(request.url);
    if (!pathname) return send(400, 'Invalid path.');
    if (!service) return send(503, 'Starting the isolated local database.');
    if (API_PATHS.has(pathname)) {
      service.server.emit('request', request, response);
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) return send(405, 'Static files allow GET and HEAD only.');
    if (pathname === '/' || pathname === '/group-workbench') {
      response.writeHead(302, { Location: '/group-workbench/', 'Cache-Control': 'no-store' });
      return response.end();
    }
    const filename = pathname === '/group-workbench/' ? 'index.html' : pathname.startsWith('/group-workbench/') ? pathname.slice('/group-workbench/'.length) : '';
    if (!FILES.includes(filename)) return send(404, 'Not found. Only the seven formal frontend files and local API are served.');
    try {
      const file = realFile(path.join(source.frontend, filename), source.frontend);
      let data = fs.readFileSync(file);
      if (filename === 'index.html') data = Buffer.from(localHtml(data.toString('utf8')));
      const contentType = filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : 'text/javascript';
      response.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': CSP });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch {
      send(500, 'Unable to read a whitelisted source file. Check the local repository.');
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: HOST, port: Number(portText) }, () => { server.removeListener('error', reject); resolve(); });
    });
    const port = server.address().port;
    origin = 'http://' + HOST + ':' + port;
    hosts.add(HOST + ':' + port);
    hosts.add('localhost:' + port);
    service = createService({ directory, adminPin, groupPin, allowedOrigins: [origin, origin.replace('127.0.0.1', 'localhost')], importDeleteEnabled: true, existingDatabaseOnly: false, skipStartupBackup: false, backupIntervalMs: 0 });
  } catch (error) {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (service) await service.close();
    throw error;
  }
  function close() {
    if (!closePromise) closePromise = (async () => {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await service.close();
    })();
    return closePromise;
  }
  return { url: origin + '/group-workbench/', origin, directory, dbPath: service.dbPath, repo: source.repo, server, close };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Local WorkBuddy development server (Node 22.23.2+ / 24.18.0+; no npm dependencies)\n\n' +
      'Required environment: WB_LOCAL_ADMIN_PIN, WB_LOCAL_GROUP_PIN (choose local-only values).\n' +
      'node tools/dev-server.cjs --repo ./github-r2v-quality-dashboard [--port 0] [--data-dir ./local-data]\n\n' +
      'Default: bind only 127.0.0.1, choose a free port, create a NEW isolated temporary database.\n' +
      'Reuse only an explicit directory created by this launcher. Empty directories are initialized.\n' +
      'All local test deletion operations are enabled. No production proxy or Demo seed data.\n' +
      'Ctrl+C stops this server and preserves its SQLite data. No production environment variables are used.\n');
    return;
  }
  const running = await start(options);
  process.stdout.write(JSON.stringify({ event: 'workbuddy_local_ready', localOnly: true, url: running.url, repo: running.repo, dataDirectory: running.directory, database: running.dbPath, pid: process.pid, deletionEnabledForLocalTests: true }) + '\n');
  process.stdout.write('Local data only. Keep the printed data directory to resume with --data-dir. Press Ctrl+C to stop.\n');
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    running.close().then(() => {
      process.stdout.write(JSON.stringify({ event: 'workbuddy_local_stopped', dataPreserved: true, dataDirectory: running.directory }) + '\n');
    }).catch(error => { process.stderr.write('Local shutdown failed: ' + error.message + '\n'); process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

module.exports = { start, parseArgs };
if (require.main === module) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
