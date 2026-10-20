'use strict';

// Only frozen synthetic histories, production projections/reporting helpers and
// an in-memory DOM adapter. This test never accesses the website or an API.
process.env.TZ = 'Asia/Shanghai';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Flow = require('../group-workbench/workflow.js');
const Reports = require('../group-workbench/reports.js');
const sourcePath = path.resolve(__dirname, '../group-workbench/app.js');
const lines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/);
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
  'overviewReviewFacts', 'countRangeAcceptance', 'countRangeQcPass', 'renderTodayMetrics'
].map(extract).join('\n');
const at = (day, time = '09:00:00') => `2026-10-${day}T${time}+08:00`;
const event = (type, day = 20, extra = {}) => ({type, at: at(day), ...extra});
const pass = (day = 20, extra = {}) => event('qc_pass', day, extra);
const submit = (day = 20, extra = {}) => event('submit', day,
  {actorRole: 'annotation', actor: '合成标注人员', assignee: '合成标注人员', ...extra});
function fixture(specs) {
  const state = {version: 3, tasks: [], events: [], batches: []};
  specs.forEach(({id, tid = id, mode = 'single', groupId = mode === 'single' ? 'g01' : 'g06', events = []}) => {
    state.tasks.push({id, tid, mode, groupId, movie: '质检通过区间去重合成验证',
      date: '2026-09-01', createdAt: '2026-09-01T01:00:00Z'});
    events.forEach((item, index) => state.events.push({
      id: `${id}-${index}`, taskId: id, actor: '合成质检人员',
      actorRole: 'qc', workflowVersion: 3, ...item
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
    pendingReworkSplit: () => ({qcPending: 0, reworkPending: 0}),
    countFirstRejections: () => 0, countRangeReworkTasks: () => 0,
    countDayActors: () => 0, countRangeRejected: () => 0
  });
  vm.runInContext(helpers, context, {filename: sourcePath});
  function scope({from = '2026-10-20', to = from, mode = 'single', groupId = 'all', user = {role: 'admin'}} = {}) {
    controls.scopeDateFrom.value = from; controls.scopeDateTo.value = to;
    controls.scopeGroup.value = groupId; context.activeMode = mode; context.profile = user;
  }
  function dailyRows() {
    const tasks = context.overviewTasks();
    const groups = Array.from(new Set(tasks.map(task => task.groupId)),
      id => ({id, name: id, defaultMode: context.activeMode}));
    return Reports.build({kind: 'daily', state: current, tasks, groups, mode: context.activeMode,
      statusMeta: Flow.STATUS_META, localDate: value => context.localDateString(new Date(value))})
      .daily.rows.filter(row => context.inDateRange(row.date));
  }
  return {
    context, scope, writes,
    check(label, qcPassed, options = {}, annotationCompleted) {
      scope(options);
      equal(context.countRangeQcPass(), qcPassed, `${label}: QC TIDs`);
      writes.clear();
      const rows = annotationCompleted === undefined ? [{qcPassActions: 999}] : dailyRows();
      context.renderTodayMetrics(rows);
      equal(writes.get('metricTodayQcPass'), qcPassed, `${label}: actual card uses range facts`);
      if (annotationCompleted !== undefined) {
        equal(writes.get('metricTodayAnnotation'), annotationCompleted, `${label}: annotation remains first submission only`);
      }
      equal(JSON.stringify(current), original, `${label}: input history unchanged`);
    },
    setState(next) { current = next; original = JSON.stringify(next); context.state = next; }
  };
}

for (const mode of ['single', 'multi']) {
  const h = harness(fixture([
    {id: 'repeated', tid: 'SHARED', mode, events: [pass(), pass(), pass(21)]},
    {id: 'legacy-duplicate', tid: ' SHARED ', mode, events: [pass(), pass(21)]},
    {id: 'different', mode, events: [pass(21)]}
  ]));
  h.check(`${mode}: repeat same-day events and duplicate TID rows count once`, 1, {mode});
  h.check(`${mode}: later recheck counts as work on its day`, 2, {mode, from: '2026-10-21'});
  h.check(`${mode}: multiple days union TIDs rather than adding daily counts`, 2, {mode, to: '2026-10-21'});
  h.check(`${mode}: empty date`, 0, {mode, from: '2026-10-22'});
  h.check(`${mode}: all dates`, 2, {mode, from: '', to: ''});
  equal(h.writes.get('metricTodayQcPassHint').includes('跨天去重'), true, `${mode}: explicit range deduplication hint`);

  const completed = harness(fixture([{id: 'submit-return-resubmit', mode, events: [
    submit(20, {submissionKind: 'initial'}), event('qc_fail'), submit(21, {submissionKind: 'rework'}),
    pass(21), event('qc_fail', 22), submit(22, {submissionKind: 'rework'}), pass(22)
  ]}]));
  completed.check(`${mode}: annotation first submission day`, 0, {mode}, 1);
  completed.check(`${mode}: rework submission not another annotation completion`, 1, {mode, from: '2026-10-21'}, 0);
  completed.check(`${mode}: another rework not another completion`, 1, {mode, from: '2026-10-22'}, 0);
  completed.check(`${mode}: first annotation plus deduped QC across interval`, 1, {mode, to: '2026-10-22'}, 1);
}

const verdicts = harness(fixture([
  {id: 'normal-pass', events: [pass()]},
  {id: 'pass-later-rejected', events: [pass(), event('qc_reject', 21)]},
  {id: 'normal-return', events: [event('qc_fail')]},
  {id: 'direct-reject', events: [event('qc_reject')]},
  {id: 'legacy-reject', events: [event('qc_fail', 20, {note: '[质检拒绝] 无法继续'})]},
  {id: 'confirm-reject', events: [event('reject_confirm')]},
  {id: 'acceptance-only', events: [event('acceptance_pass')]}
]));
verdicts.check('only QC pass events count; later rejection preserves earlier pass', 2);
verdicts.check('no QC pass on rejection date', 0, {from: '2026-10-21'});

const scopes = harness(fixture([
  {id: 'single-1', events: [pass()]},
  {id: 'single-2', groupId: 'g02', events: [pass()]},
  {id: 'multi-1', mode: 'multi', events: [pass()]},
  {id: 'multi-2', mode: 'multi', groupId: 'g07', events: [pass()]}
]));
for (const [mode, first, second] of [['single', 'g01', 'g02'], ['multi', 'g06', 'g07']]) {
  scopes.check(`${mode}: administrator sees mode only`, 2, {mode});
  scopes.check(`${mode}: first group`, 1, {mode, groupId: first});
  scopes.check(`${mode}: second group`, 1, {mode, groupId: second});
  scopes.check(`${mode}: acceptance role`, 2, {mode, user: {role: 'acceptance'}});
  for (const role of ['qc', 'annotation']) {
    scopes.check(`${mode}: ${role} locked despite foreign group selector`, 1,
      {mode, groupId: second, user: {role, groupId: first}});
  }
}
scopes.check('locked single user cannot view multi mode', 0,
  {mode: 'multi', user: {role: 'qc', groupId: 'g01'}});

const lifecycle = harness(fixture([
  {id: 'released', events: [pass(), event('admin_release', 21)]},
  {id: 'restarted', events: [pass(), event('admin_release', 21), pass(21)]},
  {id: 'deleted', events: [pass(), event('task_deleted', 21)]},
  {id: 'active', events: [pass()]},
  {id: 'deleted-duplicate', tid: 'active', events: [pass(), event('task_deleted', 21)]}
]));
lifecycle.check('release and deletion invalidate old passes; active duplicate remains', 1);
lifecycle.check('new post-release lifecycle', 1, {from: '2026-10-21'});
lifecycle.check('only effective lifecycles across range', 2, {to: '2026-10-21'});

const stamps = [
  '2026-10-19T15:59:59.999Z', '2026-10-19T16:00:00.000Z',
  '2026-10-20T15:59:59.999Z', '2026-10-20T16:00:00.000Z'
];
const boundaries = harness(fixture(stamps.map((stamp, i) => ({
  id: `boundary-${i}`, events: [pass(20, {at: stamp})]
})).concat([{id: 'invalid', events: [pass(20, {at: 'invalid'}), pass(20, {at: ''}), pass(20, {at: undefined})]}])));
boundaries.check('Beijing midnight inclusive bounds', 2);
boundaries.check('previous Beijing day', 1, {from: '2026-10-19'});
boundaries.check('next Beijing day', 1, {from: '2026-10-21'});
boundaries.check('open lower bound', 3, {from: '', to: '2026-10-20'});
boundaries.check('open upper bound', 3, {from: '2026-10-20', to: ''});
boundaries.check('all dates excludes invalid timestamps', 4, {from: '', to: ''});
const priorZone = process.env.TZ;
try {
  process.env.TZ = 'America/Los_Angeles';
  boundaries.check('reporting day stays Beijing in another host timezone', 2);
} finally { process.env.TZ = priorZone; }
boundaries.scope({from: '2026-10-21', to: '2026-10-20'});
equal(boundaries.context.validScopeRange(), false, 'reversed range invalid');
boundaries.context.renderTodayMetrics(null);
equal(boundaries.writes.get('metricTodayQcPass'), '—', 'invalid range clears prior card');

const cache = harness(fixture([{id: 'cached', events: [pass()]}]));
cache.scope();
const facts = cache.context.overviewReviewFacts();
equal(cache.context.overviewReviewFacts(), facts, 'same snapshot reuses facts');
cache.scope({from: '2026-10-21'});
equal(cache.context.overviewReviewFacts(), facts, 'date change reuses full lifecycle facts');
cache.check('cache does not retain prior date filter', 0, {from: '2026-10-21'});
cache.setState(fixture([{id: 'cached', events: [pass(), pass(21)]}]));
equal(cache.context.overviewReviewFacts() === facts, false, 'shared snapshot update invalidates facts');
cache.check('newly synchronized pass is visible', 1, {from: '2026-10-21'});
const updatedFacts = cache.context.overviewReviewFacts();
cache.scope({user: {role: 'qc', groupId: 'g02'}});
equal(cache.context.overviewReviewFacts() === updatedFacts, false, 'identity change invalidates facts');
cache.check('new identity cannot retain foreign group count', 0, {user: {role: 'qc', groupId: 'g02'}});

console.log(JSON.stringify({ok: true, checks, source: 'group-workbench/app.js',
  coverage: ['day and cross-day TID deduplication', 'annotation completion remains first submission',
    'single/multi and group/role isolation', 'return/rejection are not passes',
    'release/deletion and duplicate TIDs', 'Beijing dates, invalid ranges and empty dates',
    'cached facts, synchronization and immutable histories']}, null, 2));
