'use strict';

// Offline regression of the real overview metric helpers. Every task/event is
// synthetic and frozen: this script never opens a browser, API, store or network.
process.env.TZ = 'Asia/Shanghai';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Flow = require('../group-workbench/workflow.js');
const Reports = require('../group-workbench/reports.js');
const sourceFile = path.resolve(__dirname, '../group-workbench/app.js');
const source = fs.readFileSync(sourceFile, 'utf8');
const lines = source.split(/\r?\n/);

function extract(name) {
  const start = lines.findIndex(line => line.startsWith(`  function ${name}(`));
  assert.notEqual(start, -1, `production helper ${name} must exist`);
  if (lines[start].trimEnd().endsWith('}')) return lines[start];
  const end = lines.findIndex((line, index) => index > start && /^  }\s*$/.test(line));
  assert.ok(end > start, `production helper ${name} closing boundary`);
  return lines.slice(start, end + 1).join('\n');
}

const overview = extract('renderOverview');
function metricExpression(name, expression) {
  const match = new RegExp(`${name}:(${expression})`).exec(overview);
  assert.ok(match, `${name} uses the real production expression`);
  return new vm.Script(match[1], {filename: `${sourceFile}#${name}`});
}
const qcMetric = metricExpression('metricQcVolume', "validScopeRange\\(\\)\\?countRangeQcVolume\\(\\):'—'");
const acceptanceMetric = metricExpression('metricAcceptanceVolume', "validScopeRange\\(\\)\\?countRangeVolume\\(\\[[^\\]]*\\]\\):'—'");
const helpers = [
  'localDateString', 'eventDate', 'acceptanceEventDate', 'selectedRange', 'validScopeRange', 'inDateRange', 'singleScopeDate',
  'canViewAllGroups', 'canViewGroup', 'selectedGroup', 'inCurrentScope',
  'eventsForTask', 'liveEvents', 'taskSnapshot', 'taskWithSnapshot', 'taskIndex', 'allTasks',
  'overviewCacheForState', 'overviewMemo', 'overviewTasks', 'overviewReviewFacts',
  'countFirstRejections', 'countRangeQcVolume', 'countRangeVolume', 'countRangeRejected',
  'renderTodayMetrics', 'countDayActors', 'pendingReworkSplit', 'countRangeReworkTasks'
].map(extract).join('\n');

const groups = [
  {id: 'g01', defaultMode: 'single', name: '单镜头一组'},
  {id: 'g02', defaultMode: 'single', name: '单镜头二组'},
  {id: 'g06', defaultMode: 'multi', name: '多镜头一组'},
  {id: 'g07', defaultMode: 'multi', name: '多镜头二组'}
];
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
const at = (day, time = '09:00:00') => `2026-10-${String(day).padStart(2, '0')}T${time}+08:00`;
const review = (type, day = 7, extra = {}) => ({type, at: at(day), ...extra});
const range = (from, to = from) => ({dateFrom: `2026-10-${String(from).padStart(2, '0')}`, dateTo: `2026-10-${String(to).padStart(2, '0')}`});
function fixture(specs) {
  const state = {version: 3, tasks: [], events: [], batches: []};
  specs.forEach(({id, tid = id, events = [], mode = 'single', groupId = mode === 'single' ? 'g01' : 'g06'}) => {
    state.tasks.push({id, tid, movie: '合成拒绝分列验证', groupId, mode,
      date: '2026-09-01', createdAt: '2026-09-01T01:00:00Z'});
    events.forEach((event, index) => state.events.push({
      id: `${id}-event-${index}`, taskId: id, workflowVersion: 3,
      actor: '合成测试人员', actorRole: ['claim', 'submit', 'annotator_reject'].includes(event.type)
        ? 'annotation' : event.type.startsWith('acceptance_') ? 'acceptance' : 'qc',
      ...event
    }));
  });
  return freeze(state);
}

let assertions = 0, scenarios = 0;
function equal(actual, expected, label) { assert.equal(actual, expected, label); assertions += 1; }
function harness(initialState) {
  let state = initialState, original = JSON.stringify(state);
  const controls = {scopeDateFrom: {value: ''}, scopeDateTo: {value: ''}, scopeGroup: {value: 'all'}};
  const writes = new Map();
  const context = vm.createContext({
    window: {WorkbenchFlow: Flow, WorkbenchReports: Reports}, state, activeMode: 'single', profile: {role: 'admin'},
    eventIndexes: new WeakMap(), snapshotCache: new WeakMap(),
    overviewComputationCache: {source: null, identity: '', values: new Map(), contributions: new Map()},
    $: id => controls[id], setText: (id, value) => writes.set(id, value)
  });
  vm.runInContext(helpers, context, {filename: sourceFile});
  function scope({dateFrom = '', dateTo = '', groupId = 'all', mode = 'single', user = {role: 'admin'}} = {}) {
    controls.scopeDateFrom.value = dateFrom; controls.scopeDateTo.value = dateTo;
    controls.scopeGroup.value = groupId; context.activeMode = mode; context.profile = user;
  }
  function rows() {
    const tasks = context.overviewTasks();
    const selected = context.selectedGroup();
    const daily = Reports.build({kind: 'daily', state, tasks, groups: groups.filter(group =>
      group.defaultMode === context.activeMode && (selected === 'all' || selected === group.id)
      && context.canViewGroup(group.id)), mode: context.activeMode, statusMeta: Flow.STATUS_META,
      localDate: value => context.localDateString(new Date(value))}).daily.rows;
    return daily.filter(row => context.inDateRange(row.date));
  }
  return {
    check(label, expected, options = {}) {
      scenarios += 1; scope(options);
      const valid = context.validScopeRange();
      equal(valid ? context.countFirstRejections('annotation') : '—', expected.annotation, `${label}: first annotation rejection`);
      equal(valid ? context.countFirstRejections('qc') : '—', expected.qcReject, `${label}: first QC rejection`);
      equal(qcMetric.runInContext(context), expected.qc, `${label}: ordinary QC metric`);
      equal(acceptanceMetric.runInContext(context), expected.acceptance ?? 0, `${label}: acceptance volume unchanged`);
      if ('final' in expected) equal(valid ? context.countRangeRejected() : '—', expected.final, `${label}: final rejection unchanged`);
      writes.clear(); context.renderTodayMetrics(valid ? rows() : null);
      equal(writes.get('metricAnnotationRejected'), expected.annotation, `${label}: rendered annotation rejection`);
      equal(writes.get('metricQcRejected'), expected.qcReject, `${label}: rendered QC rejection`);
      if ('completed' in expected) {
        equal(writes.get('metricTodayAnnotation'), expected.completed, `${label}: submitted completion is independent of rejection`);
      }
      equal(JSON.stringify(state), original, `${label}: frozen input history unchanged`);
    },
    setState(next) { state = next; original = JSON.stringify(next); context.state = next; },
    scope, context, writes
  };
}

const cases = [
  {id: 'normal-pass', events: [review('submit'), review('qc_pass')], expected: {annotation: 0, qcReject: 0, qc: 1, completed: 1, final: 0}},
  {id: 'normal-return', events: [review('submit'), review('qc_fail', 7, {note: '普通打回'})], expected: {annotation: 0, qcReject: 0, qc: 1, completed: 1, final: 0}},
  {id: 'direct-reject', events: [review('submit'), review('qc_reject')], expected: {annotation: 0, qcReject: 1, qc: 0, completed: 1, final: 1}},
  {id: 'legacy-direct-reject', events: [review('submit'), review('qc_fail', 7, {note: '[质检拒绝] 无法继续'})], expected: {annotation: 0, qcReject: 1, qc: 0, completed: 1, final: 1}},
  {id: 'request-only', events: [review('annotator_reject')], expected: {annotation: 1, qcReject: 0, qc: 0, completed: 0, final: 0}},
  {id: 'request-confirmed', events: [review('annotator_reject'), review('reject_confirm')], expected: {annotation: 1, qcReject: 1, qc: 0, completed: 0, final: 1}},
  {id: 'request-returned', events: [review('annotator_reject'), review('reject_return')], expected: {annotation: 1, qcReject: 0, qc: 0, completed: 0, final: 0}},
  {id: 'request-returned-completed', events: [review('annotator_reject'), review('reject_return'), review('submit'), review('qc_pass')], expected: {annotation: 1, qcReject: 0, qc: 1, completed: 1, final: 0}},
  {id: 'completed-returned-request-confirmed', events: [review('submit'), review('qc_fail'), review('annotator_reject'), review('reject_confirm')], expected: {annotation: 1, qcReject: 1, qc: 1, completed: 1, final: 1}},
  {id: 'pass-then-acceptance-reject', events: [review('submit'), review('qc_pass'), review('acceptance_reject')], expected: {annotation: 0, qcReject: 0, qc: 1, acceptance: 1, completed: 1, final: 1}},
  {id: 'legacy-acceptance-reject', events: [review('submit'), review('qc_pass'), review('acceptance_fail', 7, {note: '[验收拒绝] 无法继续'})], expected: {annotation: 0, qcReject: 0, qc: 1, acceptance: 1, completed: 1, final: 1}},
  {id: 'acceptance-pass', events: [review('submit'), review('qc_pass'), review('acceptance_pass')], expected: {annotation: 0, qcReject: 0, qc: 1, acceptance: 1, completed: 1, final: 0}},
  {id: 'multiple-qc', events: [review('submit'), review('qc_fail'), review('submit', 7, {submissionKind: 'rework'}), review('qc_pass')], expected: {annotation: 0, qcReject: 0, qc: 1, completed: 1, final: 0}},
  {id: 'repeated-reject-same-day', events: [review('annotator_reject'), review('reject_return'), review('annotator_reject'), review('reject_confirm'), review('reject_confirm')], expected: {annotation: 1, qcReject: 1, qc: 0, completed: 0, final: 1}},
  {id: 'deleted', events: [review('submit'), review('qc_fail'), review('annotator_reject'), review('reject_confirm'), review('task_deleted', 8)], expected: {annotation: 0, qcReject: 0, qc: 0, completed: 0, final: 0}},
  {id: 'empty', events: [], expected: {annotation: 0, qcReject: 0, qc: 0, completed: 0, final: 0}}
];
for (const mode of ['single', 'multi']) for (const spec of cases) {
  const groupId = mode === 'single' ? 'g01' : 'g06';
  harness(fixture([{...spec, mode, groupId}])).check(`${mode}/${spec.id}`, spec.expected, {...range(7), mode, groupId});
}

// First rejection belongs to its earliest effective event, not the first event
// found after applying the date filter. A later request never shifts that date.
for (const mode of ['single', 'multi']) {
  const repeated = harness(fixture([{id: 'repeated', mode, events: [review('annotator_reject', 5),
    review('reject_return', 6), review('annotator_reject', 7), review('reject_confirm', 8), review('reject_confirm', 9)]}]));
  repeated.check(`${mode}/first request day`, {annotation: 1, qcReject: 0, qc: 0}, {...range(5), mode});
  repeated.check(`${mode}/returned day`, {annotation: 0, qcReject: 0, qc: 0}, {...range(6), mode});
  repeated.check(`${mode}/second request excluded`, {annotation: 0, qcReject: 0, qc: 0}, {...range(7), mode});
  repeated.check(`${mode}/first confirmation day`, {annotation: 0, qcReject: 1, qc: 0}, {...range(8), mode});
  repeated.check(`${mode}/duplicate confirmation later excluded`, {annotation: 0, qcReject: 0, qc: 0}, {...range(9), mode});
  repeated.check(`${mode}/whole history no repeated counts`, {annotation: 1, qcReject: 1, qc: 0}, {...range(5, 9), mode});
  repeated.check(`${mode}/later range cannot manufacture first request`, {annotation: 0, qcReject: 1, qc: 0}, {...range(7, 9), mode});

  const separated = harness(fixture([{id: 'separate-days', mode, events: [review('submit', 5),
    review('qc_fail', 6), review('annotator_reject', 7), review('reject_confirm', 8)]}]));
  separated.check(`${mode}/completion day survives later rejection`, {annotation: 0, qcReject: 0, qc: 0, completed: 1, final: 0}, {...range(5), mode});
  separated.check(`${mode}/QC day survives later rejection`, {annotation: 0, qcReject: 0, qc: 1, completed: 0, final: 0}, {...range(6), mode});
  separated.check(`${mode}/annotation request day`, {annotation: 1, qcReject: 0, qc: 0, completed: 0, final: 0}, {...range(7), mode});
  separated.check(`${mode}/QC confirmation day`, {annotation: 0, qcReject: 1, qc: 0, completed: 0, final: 1}, {...range(8), mode});
  separated.check(`${mode}/prior work and rejection remain separate`, {annotation: 1, qcReject: 1, qc: 1, completed: 1, final: 1}, {...range(5, 8), mode});

  const normalRepeated = harness(fixture([{id: 'repeat-normal-qc', mode, events: [review('qc_fail', 6), review('qc_pass', 7), review('qc_reject', 8)]}]));
  normalRepeated.check(`${mode}/normal QC day one`, {annotation: 0, qcReject: 0, qc: 1}, {...range(6), mode});
  normalRepeated.check(`${mode}/normal QC day two remains work`, {annotation: 0, qcReject: 0, qc: 1}, {...range(7), mode});
  normalRepeated.check(`${mode}/later reject has no ordinary QC`, {annotation: 0, qcReject: 1, qc: 0}, {...range(8), mode});
  normalRepeated.check(`${mode}/ordinary QC range deduplicates`, {annotation: 0, qcReject: 1, qc: 1}, {...range(6, 8), mode});
}

const scoped = harness(fixture(groups.map(group => ({id: group.id, mode: group.defaultMode, groupId: group.id,
  events: [review('submit'), review('qc_fail'), review('annotator_reject'), review('reject_confirm')]}))));
for (const [mode, groupId, other] of [['single', 'g01', 'g02'], ['multi', 'g06', 'g07']]) {
  const one = {annotation: 1, qcReject: 1, qc: 1, completed: 1, final: 1};
  scoped.check(`${mode}/admin all`, {annotation: 2, qcReject: 2, qc: 2, completed: 2, final: 2}, {...range(7), mode});
  scoped.check(`${mode}/selected group`, one, {...range(7), mode, groupId});
  scoped.check(`${mode}/second group`, one, {...range(7), mode, groupId: other});
  scoped.check(`${mode}/acceptance role`, {annotation: 2, qcReject: 2, qc: 2}, {...range(7), mode, user: {role: 'acceptance'}});
  for (const role of ['qc', 'annotation']) {
    scoped.check(`${mode}/${role} locked group`, one, {...range(7), mode, user: {role, groupId}});
    scoped.check(`${mode}/${role} cannot choose foreign group`, one, {...range(7), mode, groupId: other, user: {role, groupId}});
  }
}
scoped.check('restricted single cannot see multi', {annotation: 0, qcReject: 0, qc: 0}, {...range(7), mode: 'multi', user: {role: 'qc', groupId: 'g01'}});

const midnight = harness(fixture([
  ['before', '2026-10-06T15:59:59.999Z'], ['start', '2026-10-06T16:00:00.000Z'],
  ['last', '2026-10-07T15:59:59.999Z'], ['after', '2026-10-07T16:00:00.000Z']
].map(([id, time]) => ({id, events: [review('annotator_reject', 7, {at: time}), review('reject_confirm', 7, {at: time})]}))));
for (const [label, options, count] of [
  ['prior day', range(6), 1], ['inclusive midnight', range(7), 2], ['next day', range(8), 1],
  ['inclusive endpoints', range(6, 7), 3], ['open start', {dateTo: '2026-10-07'}, 3],
  ['open end', {dateFrom: '2026-10-07'}, 3], ['all dates', {}, 4]
]) midnight.check(`Beijing/${label}`, {annotation: count, qcReject: count, qc: 0}, options);
midnight.check('invalid reversed range', {annotation: '—', qcReject: '—', qc: '—', acceptance: '—', completed: '—', final: '—'}, range(8, 6));

for (const mode of ['single', 'multi']) {
  const released = harness(fixture([{id: 'released', mode, events: [review('submit', 3), review('qc_fail', 4),
    review('annotator_reject', 5), review('admin_release', 6), review('claim', 7), review('submit', 7),
    review('qc_fail', 7), review('annotator_reject', 8), review('reject_confirm', 9)]}]));
  released.check(`${mode}/release removes old history`, {annotation: 0, qcReject: 0, qc: 0, completed: 0}, {...range(3, 5), mode});
  released.check(`${mode}/release permits fresh initial submit`, {annotation: 0, qcReject: 0, qc: 1, completed: 1}, {...range(7), mode});
  released.check(`${mode}/release permits fresh first request`, {annotation: 1, qcReject: 0, qc: 0, completed: 0}, {...range(8), mode});
  released.check(`${mode}/release new confirmation`, {annotation: 0, qcReject: 1, qc: 0, completed: 0}, {...range(9), mode});
  released.check(`${mode}/release all dates remains one lifecycle`, {annotation: 1, qcReject: 1, qc: 1, completed: 1, final: 1}, {mode});
}

// A replacement worker's task must not gain the previous owner's stale reject.
const conflict = harness(fixture([{id: 'transferred', events: [
  review('claim', 4, {actor: '甲', assignee: '甲'}), review('submit', 5, {actor: '甲', assignee: '甲'}),
  review('qc_fail', 5), review('claim', 6, {assignmentKind: 'rework_transfer', fromAssignee: '甲', assignee: '乙', actor: '组长', actorRole: 'qc'}),
  review('annotator_reject', 7, {actor: '甲', assignee: '甲'}),
  review('qc_fail', 7, {workflowVersion: 2, note: '[质检拒绝] 旧页错误提交'}),
  review('annotator_reject', 8, {actor: '乙', assignee: '乙'}), review('reject_confirm', 9)
]}]));
conflict.check('stale owner and stale QC rejected events excluded', {annotation: 0, qcReject: 0, qc: 0}, range(7));
conflict.check('valid replacement rejection', {annotation: 1, qcReject: 0, qc: 0}, range(8));
conflict.check('valid replacement confirmed', {annotation: 0, qcReject: 1, qc: 0}, range(9));

// Cache correctness across dates, identities and immutable shared-state updates.
const cache = harness(fixture([{id: 'cached', events: [review('annotator_reject', 7)]}]));
cache.scope(range(7));
const facts = cache.context.overviewReviewFacts();
equal(cache.context.overviewReviewFacts(), facts, 'unchanged snapshot reuses review facts');
cache.scope(range(8));
equal(cache.context.overviewReviewFacts(), facts, 'date change reuses full-history facts');
cache.check('first date omitted after cache hit', {annotation: 0, qcReject: 0, qc: 0}, range(8));
cache.setState(fixture([{id: 'cached', events: [review('annotator_reject', 7), review('reject_confirm', 8)]}]));
equal(cache.context.overviewReviewFacts() === facts, false, 'new shared snapshot invalidates facts');
cache.check('new snapshot rejection visible', {annotation: 0, qcReject: 1, qc: 0}, range(8));
cache.setState(fixture([{id: 'cached', tid: 'RENAMED', events: [review('annotator_reject', 7), review('reject_confirm', 8)]}]));
cache.check('TID rename keeps one task contribution', {annotation: 1, qcReject: 1, qc: 0}, range(7, 8));
cache.setState(fixture([{id: 'cached', tid: 'RENAMED', events: [review('annotator_reject', 7), review('reject_confirm', 8), review('task_deleted', 9)]}]));
cache.check('deleted task disappears after snapshot invalidation', {annotation: 0, qcReject: 0, qc: 0}, range(7, 9));
cache.setState(fixture([{id: 'cached', events: [review('annotator_reject', 7), review('admin_release', 8)]}]));
cache.check('release invalidates prior cached rejection', {annotation: 0, qcReject: 0, qc: 0}, range(7, 8));

for (const [label, types] of [
  ['legacy then explicit', ['qc_fail', 'qc_reject']],
  ['confirmation then explicit', ['reject_confirm', 'qc_reject']],
  ['explicit then confirmation', ['qc_reject', 'reject_confirm']]
]) {
  const combined = harness(fixture([{id: label, events: types.map((type, index) =>
    review(type, 7 + index, type === 'qc_fail' ? {note: '[质检拒绝] 历史兼容'} : {}))}]));
  combined.check(`${label}/first QC rejection`, {annotation: 0, qcReject: 1, qc: 0}, range(7));
  combined.check(`${label}/later encoding does not create another first`, {annotation: 0, qcReject: 0, qc: 0}, range(8));
  combined.check(`${label}/range deduplicates both encodings`, {annotation: 0, qcReject: 1, qc: 0}, range(7, 8));
}
harness(fixture([{id: 'empty-all-dates'}])).check('all dates has no fabricated rejection', {annotation: 0, qcReject: 0, qc: 0, completed: 0});

// The new counters use Beijing calendar days even on another browser timezone.
// Existing non-target cards retain their own prior date handling unchanged.
const originalZone = process.env.TZ;
try {
  process.env.TZ = 'America/Los_Angeles';
  const foreignZone = harness(fixture([{id: 'foreign-zone', events: [
    review('qc_fail', 7, {at: '2026-10-06T16:01:00Z'}),
    review('annotator_reject', 7, {at: '2026-10-06T16:02:00Z'}),
    review('reject_confirm', 7, {at: '2026-10-06T16:03:00Z'})
  ]}]));
  foreignZone.check('foreign browser timezone still uses Beijing day', {annotation: 1, qcReject: 1, qc: 1}, range(7));
  foreignZone.check('foreign browser previous local day excluded', {annotation: 0, qcReject: 0, qc: 0}, range(6));
} finally { process.env.TZ = originalZone; }

console.log(JSON.stringify({ok: true, assertions, scenarios, source: 'group-workbench/app.js',
  checks: ['real production helpers and QC/acceptance overview expressions',
    'first-ever rejection before date filter; cross-day deduplication',
    'annotation requests and direct/legacy/confirmed QC rejection split',
    'ordinary QC and prior submitted completion survive later rejection',
    'final rejection and acceptance volume preserved',
    'single/multi scopes and locked roles on the same state object',
    'Beijing date boundaries, release, deletion and stale transfer conflicts',
    'snapshot cache invalidation, date reuse and immutable histories']}, null, 2));
