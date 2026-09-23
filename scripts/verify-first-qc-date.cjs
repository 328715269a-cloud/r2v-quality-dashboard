'use strict';

// Exercise the real browser helpers with the production reports/workflow modules.
process.env.TZ = 'Asia/Shanghai';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Reports = require('../group-workbench/reports.js');
const Flow = require('../group-workbench/workflow.js');
const app = fs.readFileSync(path.join(__dirname, '../group-workbench/app.js'), 'utf8');

function browserFunction(name) {
  const lines = app.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(`  function ${name}(`));
  assert.notEqual(start, -1, `production helper ${name} must exist`);
  if (lines[start].trimEnd().endsWith('}')) return lines[start];
  const end = lines.findIndex((line, index) => index > start && /^  }\s*$/.test(line));
  assert.ok(end > start, `production helper ${name} must have a closing brace`);
  return lines.slice(start, end + 1).join('\n');
}

const helperNames = [
  'localDateString', 'eventDate', 'selectedRange', 'validScopeRange', 'singleScopeDate', 'scopeRangeLabel', 'inDateRange',
  'canViewAllGroups', 'canViewGroup', 'selectedGroup', 'inCurrentScope',
  'eventsForTask', 'taskSnapshot', 'taskWithSnapshot', 'taskIndex', 'allTasks', 'firstQcAccuracy'
];
const overviewSource = browserFunction('renderOverview');
const metricRenderSource = overviewSource.slice(0, overviewSource.indexOf('    const followups=')) + '\n  }';
assert.ok(metricRenderSource.includes("setText('metricFirstQcDetail'"), 'exercise the real metric renderer through its date detail');
const makeHarness = new Function('Reports', 'Flow', 'fixture', `
  const window = { WorkbenchReports: Reports, WorkbenchFlow: Flow };
  let state = fixture, activeMode = 'single', profile = {role: 'admin'};
  const eventIndexes = new WeakMap(), snapshotCache = new WeakMap();
  const controls = {scopeDateFrom: {value: ''}, scopeDateTo: {value: ''}, scopeGroup: {value: 'g01'}};
  const rendered = {}, counts = Flow.counts, countRangeRejected = () => 0;
  const setText = (id, value) => { rendered[id] = value; };
  const $ = id => controls[id];
  ${helperNames.map(browserFunction).join('\n')}
  ${metricRenderSource}
  return {
    setScope({dateFrom = '', dateTo = '', groupId = 'g01', mode = 'single', user = {role: 'admin'}} = {}) {
      controls.scopeDateFrom.value = dateFrom; controls.scopeDateTo.value = dateTo;
      controls.scopeGroup.value = groupId; activeMode = mode; profile = user;
      // Changing identity starts a fresh snapshot, as happens on a real login.
      state = {...fixture};
    },
    switchModule(mode, groupId = 'all') { activeMode = mode; controls.scopeGroup.value = groupId; },
    selectDates({dateFrom = '', dateTo = ''}) { controls.scopeDateFrom.value = dateFrom; controls.scopeDateTo.value = dateTo; },
    scopedTasks() { return allTasks().filter(task => inCurrentScope(task, false)); },
    metric(range) { return firstQcAccuracy(this.scopedTasks(), range); },
    taskMetric(id, range) { return firstQcAccuracy(this.scopedTasks().filter(task => task.id === id), range); },
    renderMetric() { renderOverview(); return {value: rendered.metricFirstQcAccuracy, detail: rendered.metricFirstQcDetail}; },
    eventDate
  };
`);

let serial = 0;
const state = {tasks: [], events: [], batches: []};
const at = (date, time = '09:00:00') => `${date}T${time}+08:00`;
function addTask(id, reviews, groupId = 'g01', mode = 'single') {
  state.tasks.push({id, tid: id, movie: '首检日期验证', groupId, mode, date: '2026-09-01', createdAt: at('2026-09-01')});
  const history = [
    {type: 'claim', at: at('2026-09-18'), actor: '张明', assignee: '张明'},
    {type: 'submit', at: at('2026-09-19'), actor: '张明', submissionKind: 'initial'},
    ...reviews
  ];
  for (const value of history) state.events.push({
    id: `first-qc-event-${++serial}`, taskId: id, workflowVersion: 3,
    actor: '首检组长', actorRole: value.type === 'claim' || value.type === 'submit' ? 'annotation' : 'qc',
    ...value
  });
}

addTask('pass20', [{type: 'qc_pass', at: at('2026-09-20', '08:00:00')}]);
addTask('fail20-repaired21', [
  {type: 'qc_fail', at: at('2026-09-20'), pLevel: 'P1', tags: ['主体/对象漏标']},
  {type: 'submit', at: at('2026-09-21'), actor: '张明', submissionKind: 'rework'},
  {type: 'qc_pass', at: at('2026-09-21', '10:00:00')}
]);
addTask('pass21-local-midnight', [{type: 'qc_pass', at: '2026-09-20T16:00:00.000Z'}]);
addTask('fail21-local-last-ms', [{type: 'qc_fail', at: '2026-09-21T15:59:59.999Z', pLevel: 'P2'}]);
addTask('pass22-local-midnight', [{type: 'qc_pass', at: '2026-09-21T16:00:00.000Z'}]);
addTask('explicit-reject20', [
  {type: 'qc_reject', at: at('2026-09-20')},
  {type: 'qc_pass', at: at('2026-09-21')}
]);
addTask('legacy-reject20', [{type: 'qc_fail', at: at('2026-09-20'), note: '[质检拒绝] 无法继续', pLevel: 'P0'}]);
addTask('invalid-qc-date', [{type: 'qc_pass', at: 'invalid-date'}]);
addTask('no-qc', []);
addTask('other-group-pass20', [{type: 'qc_pass', at: at('2026-09-20')}], 'g02');
addTask('multi-fail20', [{type: 'qc_fail', at: at('2026-09-20'), pLevel: 'P1'}], 'g06', 'multi');
addTask('deleted-pass20', [
  {type: 'qc_pass', at: at('2026-09-20')},
  {type: 'task_deleted', at: at('2026-09-22'), reason: '测试删除历史'}
]);

const original = JSON.stringify(state);
const ui = makeHarness(Reports, Flow, state);
const range = (dateFrom, dateTo = dateFrom) => ({dateFrom, dateTo});
const expected = (firstPass, firstTotal) => ({firstPass, firstTotal, rate: firstTotal ? firstPass / firstTotal * 100 : null});
const cases = [];
function check(label, actual, wanted) { assert.deepEqual(actual, wanted, label); cases.push(label); }

assert.equal(new Date('2026-09-20T16:00:00Z').getHours(), 0, 'test runtime must use Asia/Shanghai');
assert.equal(ui.eventDate({at: '2026-09-20T16:00:00.000Z'}), '2026-09-21');
assert.equal(ui.eventDate({at: '2026-09-21T15:59:59.999Z'}), '2026-09-21');
assert.equal(ui.eventDate({at: '2026-09-21T16:00:00.000Z'}), '2026-09-22');

ui.setScope(range('2026-09-20'));
check('one selected day uses first QC date, independent of allocation/submission dates', ui.metric(), expected(1, 2));
ui.setScope(range('2026-09-21'));
check('local midnight/end-of-day bounds are inclusive; rework pass does not become first QC', ui.metric(), expected(1, 2));
check('later repair pass contributes no first QC on its repair date', ui.taskMetric('fail20-repaired21'), expected(0, 0));
check('original first fail remains a fail after repair succeeds', ui.taskMetric('fail20-repaired21', range('2026-09-20')), expected(0, 1));
ui.setScope(range('2026-09-20', '2026-09-21'));
check('multi-day range sums first decisions', ui.metric(), expected(2, 4));
ui.setScope();
check('all dates include every valid first QC date once and exclude rejects/invalid timestamps', ui.metric(), expected(3, 5));
check('explicit rejection cannot be replaced by a later pass', ui.taskMetric('explicit-reject20'), expected(0, 0));
check('legacy qc_fail rejection marker remains excluded', ui.taskMetric('legacy-reject20'), expected(0, 0));
assert.equal(Reports.annotationContributors(state.events.filter(event => event.taskId === 'legacy-reject20')).firstQc.type, 'qc_reject');
check('open lower date bound', ui.metric({dateFrom: '', dateTo: '2026-09-20'}), expected(1, 2));
check('open upper date bound', ui.metric({dateFrom: '2026-09-21', dateTo: ''}), expected(2, 3));
ui.setScope(range('2026-09-19'));
check('day with submissions but no first QC has no rate', ui.metric(), expected(0, 0));
check('empty task scope has no rate', ui.taskMetric('missing'), expected(0, 0));
ui.setScope(range('2026-09-22', '2026-09-20'));
check('reversed selected range produces no rate', ui.metric(), expected(0, 0));
check('explicit valid range works independently of invalid selected range', ui.metric(range('2026-09-20')), expected(1, 2));
ui.setScope(range('2026-09-20'));
check('explicit reversed range is rejected even when selected range is valid', ui.metric(range('2026-09-22', '2026-09-20')), expected(0, 0));

ui.setScope({...range('2026-09-20'), groupId: 'g02'});
check('selected group excludes other groups', ui.metric(), expected(1, 1));
ui.setScope({...range('2026-09-20'), groupId: 'all'});
check('all single-shot groups exclude multi-shot tasks and deleted tasks', ui.metric(), expected(2, 3));
ui.setScope({...range('2026-09-20'), groupId: 'all', mode: 'multi'});
check('multi-shot module excludes single-shot tasks', ui.metric(), expected(0, 1));
ui.setScope({...range('2026-09-20'), groupId: 'all', user: {role: 'qc', groupId: 'g02'}});
check('restricted identity stays in its permitted group', ui.metric(), expected(1, 1));
assert.equal(JSON.stringify(state), original, 'metric calculation must not mutate task/event history');

// One shared state/snapshot cache is reused while switching modules and dates.
// The single-shot cohort intentionally has a different result from multi-shot.
const moduleFixture = {tasks: [], events: [], batches: []};
function copyCohort(fromId, id, mode, groupId) {
  moduleFixture.tasks.push({...state.tasks.find(task => task.id === fromId), id, tid: id, mode, groupId});
  moduleFixture.events.push(...state.events.filter(event => event.taskId === fromId).map(event => ({...event, id: `${id}:${event.id}`, taskId: id})));
}
copyCohort('pass20', 'multi-pass20', 'multi', 'g06');
copyCohort('fail21-local-last-ms', 'multi-fail21', 'multi', 'g06');
copyCohort('explicit-reject20', 'multi-reject20', 'multi', 'g06');
copyCohort('legacy-reject20', 'multi-legacy-reject20', 'multi', 'g06');
copyCohort('fail20-repaired21', 'single-fail20', 'single', 'g01');
const switched = makeHarness(Reports, Flow, moduleFixture), moduleEvidence = [];
function multiCase(label, dates, wanted, text) {
  switched.selectDates(dates);
  check(label, switched.metric(), wanted);
  const rendered = switched.renderMetric();
  assert.equal(rendered.value, text, `${label}: real renderer text`);
  moduleEvidence.push({label, ...dates, result: switched.metric(), rendered});
}
switched.setScope({mode: 'multi', groupId: 'all'});
multiCase('multi-shot day 20 is 100%, including no rejected decisions', range('2026-09-20'), expected(1, 1), '100.0%');
multiCase('multi-shot day 21 is 0%, using local first-QC date', range('2026-09-21'), expected(0, 1), '0.0%');
multiCase('multi-shot inclusive two-day range is 50%', range('2026-09-20', '2026-09-21'), expected(1, 2), '50.0%');
multiCase('multi-shot day with no first QC renders dash', range('2026-09-22'), expected(0, 0), '—');
assert.equal(switched.renderMetric().detail, '2026-09-22 · 暂无首检记录');
switched.selectDates(range('2026-09-20'));
switched.switchModule('single');
check('cached switch from multi to single uses its own first-QC cohort', switched.metric(), expected(0, 1));
assert.equal(switched.renderMetric().value, '0.0%');
switched.switchModule('multi');
check('cached switch back to multi restores 100% on the same date', switched.metric(), expected(1, 1));
assert.equal(switched.renderMetric().value, '100.0%');
switched.switchModule('single');
switched.selectDates(range('2026-09-21'));
check('single-shot later repair pass is not a new first QC after mode switches', switched.metric(), expected(0, 0));
switched.switchModule('multi', 'g06');
check('multi selected group retains its real first failure after mode switches', switched.metric(), expected(0, 1));
assert.equal(switched.renderMetric().value, '0.0%');

const html = fs.readFileSync(path.join(__dirname, '../group-workbench/index.html'), 'utf8');
const cumulativeAt = html.indexOf('class="overview-metrics overview-metrics-cumulative"');
const dailyAt = html.indexOf('class="overview-metrics overview-metrics-today"');
const firstQcAt = html.indexOf('id="metricFirstQcAccuracy"');
assert.equal((html.match(/id="metricFirstQcAccuracy"/g) || []).length, 1, 'there is only one shared first-QC card for both modules');
assert.ok(cumulativeAt < dailyAt && dailyAt < firstQcAt && firstQcAt < html.indexOf('</section>', dailyAt), 'shared first-QC card belongs to daily/range metrics, outside cumulative metrics');
assert.ok(!html.slice(cumulativeAt, dailyAt).includes('metricFirstQc'), 'cumulative metrics contain no first-QC card');

console.log(JSON.stringify({ok: true, timezone: process.env.TZ, productionHelpers: helperNames, checks: cases.length, cases, moduleEvidence, sharedCardInDateMetrics: true}, null, 2));
