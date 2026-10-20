'use strict';

// Synthetic, offline regression of the production overview helpers and renderer.
// Never opens the website or writes any task, event, browser store or API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Flow = require('../group-workbench/workflow.js');
const sourcePath = path.resolve(__dirname, '../group-workbench/app.js');
const lines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/);
const html = fs.readFileSync(path.resolve(__dirname, '../group-workbench/index.html'), 'utf8');
let checks = 0;
function equal(actual, expected, label) { assert.equal(actual, expected, label); checks += 1; }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function extract(name) {
  const start = lines.findIndex(line => line.startsWith(`  function ${name}(`));
  assert.notEqual(start, -1, `production helper ${name} exists`);
  if (lines[start].trimEnd().endsWith('}')) return lines[start];
  const end = lines.findIndex((line, index) => index > start && /^  }\s*$/.test(line));
  assert.ok(end > start, `production helper ${name} closes`);
  return lines.slice(start, end + 1).join('\n');
}
const helpers = [
  'localDateString', 'eventDate', 'acceptanceEventDate', 'selectedRange', 'validScopeRange',
  'inDateRange', 'singleScopeDate', 'canViewAllGroups', 'canViewGroup', 'selectedGroup',
  'inCurrentScope', 'eventsForTask', 'liveEvents', 'taskSnapshot', 'taskWithSnapshot',
  'taskIndex', 'allTasks', 'overviewCacheForState', 'overviewMemo', 'overviewTasks',
  'overviewReviewFacts', 'countRangeAcceptance', 'renderTodayMetrics'
].map(extract).join('\n');
const at = (day, time = '09:00:00') => `2026-10-${day}T${time}+08:00`;
const event = (type, day = 20, extra = {}) => ({type, at: at(day), ...extra});
const pass = (day = 20, extra = {}) => event('acceptance_pass', day, extra);
const returned = (day = 20, extra = {}) => event('acceptance_fail', day, extra);
function fixture(specs) {
  const state = {version: 3, tasks: [], events: [], batches: []};
  specs.forEach(({id, tid = id, mode = 'single', groupId = mode === 'single' ? 'g01' : 'g06', events = []}) => {
    state.tasks.push({id, tid, mode, groupId, movie: '验收打回指标合成验证',
      date: '2026-09-01', createdAt: '2026-09-01T01:00:00Z'});
    events.forEach((item, index) => state.events.push({
      id: `${id}-${index}`, taskId: id, actor: '合成测试人员',
      actorRole: 'acceptance', workflowVersion: 3, ...item
    }));
  });
  return freeze(state);
}
function harness(initial) {
  const controls = {scopeDateFrom: {value: ''}, scopeDateTo: {value: ''}, scopeGroup: {value: 'all'}};
  const writes = new Map();
  let current = initial, original = JSON.stringify(initial);
  const context = vm.createContext({
    window: {WorkbenchFlow: Flow}, state: current, activeMode: 'single', profile: {role: 'admin'},
    eventIndexes: new WeakMap(), snapshotCache: new WeakMap(),
    overviewComputationCache: {source: null, identity: '', values: new Map(), contributions: new Map()},
    $: id => controls[id], setText: (id, value) => writes.set(id, value),
    // Unrelated cards are deliberately isolated; these assertions exercise the
    // actual new counters, scoped projections, cache and shared card renderer.
    pendingReworkSplit: () => ({qcPending: 0, reworkPending: 0}),
    countFirstRejections: () => 0, countRangeReworkTasks: () => 0,
    countDayActors: () => 0, countRangeRejected: () => 0
  });
  vm.runInContext(helpers, context, {filename: sourcePath});
  function scope({from = '2026-10-20', to = from, mode = 'single', groupId = 'all', user = {role: 'admin'}} = {}) {
    controls.scopeDateFrom.value = from; controls.scopeDateTo.value = to;
    controls.scopeGroup.value = groupId; context.activeMode = mode; context.profile = user;
  }
  return {
    context, scope, writes,
    check(label, passed, returns, options = {}) {
      scope(options);
      equal(context.countRangeAcceptance('pass'), passed, `${label}: passed TIDs`);
      equal(context.countRangeAcceptance('return'), returns, `${label}: returned TIDs`);
      writes.clear();
      context.renderTodayMetrics([{completedTIDs: 999, acceptanceFailActions: 999}]);
      equal(writes.get('metricTodayAccept'), passed, `${label}: rendered passed TIDs use lifecycle facts`);
      equal(writes.get('metricTodayAcceptReturn'), returns, `${label}: rendered returned TIDs use lifecycle facts`);
      equal(JSON.stringify(current), original, `${label}: input history is unchanged`);
    },
    setState(next) { current = next; original = JSON.stringify(next); context.state = next; }
  };
}

for (const mode of ['single', 'multi']) {
  const h = harness(fixture([
    {id: 'repeat', tid: 'SHARED', mode, events: [pass(), pass(), returned(), returned(), pass(21), returned(21)]},
    {id: 'legacy-duplicate-task', tid: ' SHARED ', mode, events: [pass(), returned(21)]},
    {id: 'different', mode, events: [returned(), pass(21)]}
  ]));
  h.check(`${mode}: first day deduplicates repeated events and duplicate task rows`, 1, 2, {mode});
  h.check(`${mode}: second day includes the day's actual operations`, 2, 1, {mode, from: '2026-10-21'});
  h.check(`${mode}: interval unions TIDs across days rather than summing days`, 2, 2, {mode, to: '2026-10-21'});
  h.check(`${mode}: empty day`, 0, 0, {mode, from: '2026-10-22'});
  h.check(`${mode}: all dates`, 2, 2, {mode, from: '', to: ''});
  equal(h.writes.get('metricTodayAcceptHint').includes('跨天去重'), true, `${mode}: pass hint is explicit`);
  equal(h.writes.get('metricTodayAcceptReturnHint').includes('跨天去重'), true, `${mode}: return hint is explicit`);
}

const categories = harness(fixture([
  {id: 'inspected-fail', events: [returned(20, {acceptanceInspection: 'fail', acceptanceBatchId: 'batch'})]},
  {id: 'uninspected-batch-return', events: [returned(20, {acceptanceInspection: 'uninspected', acceptanceBatchId: 'batch'})]},
  {id: 'inspected-pass-batch-return', events: [returned(20, {acceptanceInspection: 'pass', acceptanceBatchId: 'batch'})]},
  {id: 'historical-normal-return', events: [returned(20, {note: '请修正'})]},
  {id: 'explicit-rejection', events: [event('acceptance_reject')]},
  {id: 'historical-rejection-marker', events: [returned(20, {note: '[验收拒绝] 无法继续'})]},
  {id: 'qc-return', events: [event('qc_fail')]},
  {id: 'annotation-reject', events: [event('annotator_reject')]},
  {id: 'batch-pass', events: [pass(20, {acceptanceInspection: 'uninspected', acceptanceBatchId: 'batch'})]},
  {id: 'normal-pass', events: [pass(20, {acceptanceInspection: 'pass'})]}
]));
categories.check('flow returns include actual failures and batch returns, excluding final rejection and QC returns', 2, 4);

const scopes = harness(fixture([
  {id: 'single-1', events: [pass(), returned()]},
  {id: 'single-2', groupId: 'g02', events: [pass(), returned()]},
  {id: 'multi-1', mode: 'multi', events: [pass(), returned()]},
  {id: 'multi-2', mode: 'multi', groupId: 'g07', events: [pass(), returned()]}
]));
for (const [mode, first, second] of [['single', 'g01', 'g02'], ['multi', 'g06', 'g07']]) {
  scopes.check(`${mode}: administrator all groups`, 2, 2, {mode});
  scopes.check(`${mode}: selected first group`, 1, 1, {mode, groupId: first});
  scopes.check(`${mode}: selected second group`, 1, 1, {mode, groupId: second});
  scopes.check(`${mode}: acceptance role all groups`, 2, 2, {mode, user: {role: 'acceptance'}});
  for (const role of ['qc', 'annotation']) {
    scopes.check(`${mode}: ${role} locked to own group despite foreign selection`, 1, 1,
      {mode, groupId: second, user: {role, groupId: first}});
  }
}
scopes.check('restricted single user cannot view multi tasks', 0, 0,
  {mode: 'multi', user: {role: 'qc', groupId: 'g01'}});

const lifecycle = harness(fixture([
  {id: 'released', events: [pass(), returned(), event('admin_release', 21)]},
  {id: 'restarted', events: [pass(), returned(), event('admin_release', 21), pass(21), returned(21)]},
  {id: 'deleted', events: [pass(), returned(), event('task_deleted', 21)]},
  {id: 'active', events: [pass(), returned()]},
  {id: 'deleted-duplicate', tid: 'active', events: [pass(), returned(), event('task_deleted', 21)]}
]));
lifecycle.check('deleted and released histories excluded; active duplicate remains', 1, 1);
lifecycle.check('new lifecycle after release contributes on new day only', 1, 1, {from: '2026-10-21'});
lifecycle.check('valid lifecycles across interval', 2, 2, {to: '2026-10-21'});

const timestamps = [
  '2026-10-19T15:59:59.999Z', '2026-10-19T16:00:00.000Z',
  '2026-10-20T15:59:59.999Z', '2026-10-20T16:00:00.000Z'
];
const boundaries = harness(fixture(timestamps.map((stamp, index) => ({
  id: `boundary-${index}`, events: [pass(20, {at: stamp}), returned(20, {at: stamp})]
})).concat([
  {id: 'invalid-date', events: [pass(20, {at: 'not-a-date'}), returned(20, {at: ''})]},
  {id: 'missing-date', events: [pass(20, {at: undefined}), returned(20, {at: null})]}
])));
boundaries.check('Beijing midnight boundaries inclusive', 2, 2);
boundaries.check('previous Beijing day', 1, 1, {from: '2026-10-19'});
boundaries.check('next Beijing day', 1, 1, {from: '2026-10-21'});
boundaries.check('open lower bound', 3, 3, {from: '', to: '2026-10-20'});
boundaries.check('open upper bound', 3, 3, {from: '2026-10-20', to: ''});
boundaries.check('all dates exclude malformed timestamps', 4, 4, {from: '', to: ''});
const oldZone = process.env.TZ;
try {
  process.env.TZ = 'America/Los_Angeles';
  boundaries.check('Beijing reporting date independent of browser host timezone', 2, 2);
} finally {
  if (oldZone === undefined) delete process.env.TZ; else process.env.TZ = oldZone;
}
boundaries.scope({from: '2026-10-21', to: '2026-10-20'});
equal(boundaries.context.validScopeRange(), false, 'reversed dates rejected');
boundaries.context.renderTodayMetrics(null);
equal(boundaries.writes.get('metricTodayAccept'), '—', 'invalid range does not leave prior pass value');
equal(boundaries.writes.get('metricTodayAcceptReturn'), '—', 'invalid range does not leave prior return value');

const cache = harness(fixture([{id: 'cached', events: [pass(), returned()]}]));
cache.scope();
const facts = cache.context.overviewReviewFacts();
equal(cache.context.overviewReviewFacts(), facts, 'unchanged scoped state reuses facts');
cache.scope({from: '2026-10-21'});
equal(cache.context.overviewReviewFacts(), facts, 'changing dates reuses existing lifecycle facts');
cache.check('cached dates still filtered at read', 0, 0, {from: '2026-10-21'});
cache.setState(fixture([{id: 'cached', events: [pass(), returned(), returned(21)]}]));
equal(cache.context.overviewReviewFacts() === facts, false, 'new shared snapshot invalidates lifecycle cache');
cache.check('newly synchronized return visible without stale cache', 0, 1, {from: '2026-10-21'});
const nextFacts = cache.context.overviewReviewFacts();
cache.scope({user: {role: 'annotation', groupId: 'g02'}});
equal(cache.context.overviewReviewFacts() === nextFacts, false, 'identity changes invalidate lifecycle cache');
cache.check('changed identity cannot retain previous group counts', 0, 0,
  {user: {role: 'annotation', groupId: 'g02'}});

const passCard = html.indexOf('id="metricTodayAccept"');
const returnCard = html.indexOf('id="metricTodayAcceptReturn"');
const nextCard = html.indexOf('id="metricTodayRework"');
equal(passCard >= 0 && returnCard > passCard && nextCard > returnCard, true,
  'return metric appears immediately after acceptance pass and before rework');
console.log(JSON.stringify({ok: true, checks, source: 'group-workbench/app.js',
  coverage: ['single/multi and group/role isolation', 'cross-day and duplicate-TID deduplication',
    'actual failure and follow-batch return; final rejection excluded', 'release and deletion',
    'Beijing dates, invalid ranges and empty days', 'cached facts and synchronization',
    'actual renderer and card order; immutable synthetic histories']}, null, 2));
