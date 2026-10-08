'use strict';

// Offline regression: evaluate the shipped overview expressions and helpers
// against synthetic, frozen histories. No store, API, browser or business data.
process.env.TZ = 'Asia/Shanghai';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Flow = require('../group-workbench/workflow.js');
const sourceFile = path.resolve(__dirname, '../group-workbench/app.js');
const source = fs.readFileSync(sourceFile, 'utf8');
const lines = source.split(/\r?\n/);

function extract(name) {
  const start = lines.findIndex(line => line.startsWith(`  function ${name}(`));
  assert.notEqual(start, -1, `production helper ${name} must exist`);
  if (lines[start].trimEnd().endsWith('}')) return lines[start];
  const end = lines.findIndex((line, index) => index > start && /^  }\s*$/.test(line));
  assert.ok(end > start, `production helper ${name} must have a closing boundary`);
  return lines.slice(start, end + 1).join('\n');
}

const overview = extract('renderOverview');
function metricExpression(name) {
  const match = new RegExp(`${name}:(validScopeRange\\(\\)\\?countRangeVolume\\(\\[[^\\]]*\\]\\):'—')`).exec(overview);
  assert.ok(match, `${name} must use the real overview volume expression`);
  return new vm.Script(match[1], {filename: `${sourceFile}#${name}`});
}
const qcMetric = metricExpression('metricQcVolume');
const acceptanceMetric = metricExpression('metricAcceptanceVolume');
const helpers = [
  'localDateString', 'eventDate', 'selectedRange', 'validScopeRange', 'inDateRange',
  'canViewAllGroups', 'canViewGroup', 'selectedGroup', 'inCurrentScope',
  'eventsForTask', 'liveEvents', 'taskSnapshot', 'taskWithSnapshot', 'taskIndex',
  'allTasks', 'countRangeVolume'
].map(extract).join('\n');

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const at = (day, time = '09:00:00') => `2026-10-${day}T${time}+08:00`;
const review = (type, day = '07', extra = {}) => ({type, at: at(day), ...extra});
const range = (from, to = from) => ({dateFrom: `2026-10-${from}`, dateTo: `2026-10-${to}`});

function fixture(specs) {
  const state = {version: 3, tasks: [], events: [], batches: []};
  specs.forEach(({id, events = [], groupId = 'g01', mode = 'single'}) => {
    state.tasks.push({id, tid: id, movie: '合成质检量级验证', groupId, mode,
      date: '2026-09-01', createdAt: '2026-09-01T01:00:00Z'});
    events.forEach((event, index) => state.events.push({
      id: `${id}-event-${index}`, taskId: id, workflowVersion: 3,
      actor: '合成测试人员', actorRole: event.type.startsWith('acceptance_') ? 'acceptance' : 'qc',
      ...event
    }));
  });
  return freeze(state);
}

let assertions = 0;
function harness(state) {
  const original = JSON.stringify(state);
  const controls = {scopeDateFrom: {value: ''}, scopeDateTo: {value: ''}, scopeGroup: {value: 'all'}};
  const context = vm.createContext({
    window: {WorkbenchFlow: Flow}, state, activeMode: 'single', profile: {role: 'admin'},
    eventIndexes: new WeakMap(), snapshotCache: new WeakMap(), $: id => controls[id]
  });
  vm.runInContext(helpers, context, {filename: sourceFile});
  return {
    check(label, expectedQc, expectedAcceptance, {
      dateFrom = '', dateTo = '', groupId = 'all', mode = 'single', user = {role: 'admin'}
    } = {}) {
      controls.scopeDateFrom.value = dateFrom;
      controls.scopeDateTo.value = dateTo;
      controls.scopeGroup.value = groupId;
      context.activeMode = mode;
      context.profile = user;
      // A new identity gets a fresh state revision, as on a real sign-in.
      context.state = {...state};
      assert.equal(qcMetric.runInContext(context), expectedQc, `${label}: QC volume`);
      assert.equal(acceptanceMetric.runInContext(context), expectedAcceptance, `${label}: acceptance volume`);
      assert.equal(JSON.stringify(state), original, `${label}: input history stays unchanged`);
      assertions += 3;
    },
    context
  };
}

const cases = [
  {id: 'qc-pass', events: [review('qc_pass')], qc: 1, acceptance: 0},
  {id: 'qc-fail', events: [review('qc_fail', '07', {note: '普通打回'})], qc: 1, acceptance: 0},
  {id: 'direct-qc-reject', events: [review('qc_reject')], qc: 1, acceptance: 0},
  {id: 'legacy-qc-reject', events: [review('qc_fail', '07', {note: '[质检拒绝] 无法继续'})], qc: 1, acceptance: 0},
  {id: 'reject-confirm-only', events: [review('reject_confirm')], qc: 1, acceptance: 0},
  {id: 'annotation-request-confirmed', events: [review('annotator_reject', '06'), review('reject_confirm')], qc: 1, acceptance: 0},
  {id: 'qc-and-confirm-same-tid', events: [review('qc_fail'), review('annotator_reject'), review('reject_confirm')], qc: 1, acceptance: 0},
  {id: 'annotation-request-only', events: [review('annotator_reject')], qc: 0, acceptance: 0},
  {id: 'annotation-request-returned', events: [review('annotator_reject'), review('reject_return')], qc: 0, acceptance: 0},
  {id: 'acceptance-reject-only', events: [review('acceptance_reject')], qc: 0, acceptance: 1},
  {id: 'acceptance-fail-only', events: [review('acceptance_fail')], qc: 0, acceptance: 1},
  {id: 'legacy-acceptance-reject', events: [review('acceptance_fail', '07', {note: '[验收拒绝] 无法继续'})], qc: 0, acceptance: 1},
  {id: 'acceptance-pass-only', events: [review('acceptance_pass')], qc: 0, acceptance: 1},
  {id: 'acceptance-repeated-same-tid', events: [review('acceptance_fail'), review('acceptance_pass'), review('acceptance_reject')], qc: 0, acceptance: 1},
  {id: 'deleted-confirmation', events: [review('reject_confirm'), review('task_deleted', '08')], qc: 0, acceptance: 0},
  {id: 'no-history', events: [], qc: 0, acceptance: 0}
];
for (const mode of ['single', 'multi']) {
  const groupId = mode === 'single' ? 'g01' : 'g06';
  for (const spec of cases) {
    const ui = harness(fixture([{...spec, mode, groupId}]));
    ui.check(`${mode}/${spec.id}`, spec.qc, spec.acceptance, {...range('07'), mode, groupId});
  }
}

// The scope uses decision dates, never the old task allocation date or a later
// acceptance rejection date. A range counts one case even across several days.
for (const mode of ['single', 'multi']) {
  const ui = harness(fixture([{id: 'qc-then-acceptance-reject', mode,
    events: [review('qc_pass', '06'), review('acceptance_reject', '07')]}]));
  ui.check(`${mode}/QC day only`, 1, 0, {...range('06'), mode});
  ui.check(`${mode}/later acceptance rejection`, 0, 1, {...range('07'), mode});
  ui.check(`${mode}/both stages in range`, 1, 1, {...range('06', '07'), mode});

  const confirmation = harness(fixture([{id: 'qc-then-confirmation', mode,
    events: [review('qc_fail', '06'), review('annotator_reject', '07'), review('reject_confirm', '08')]}]));
  confirmation.check(`${mode}/first QC date`, 1, 0, {...range('06'), mode});
  confirmation.check(`${mode}/request date alone`, 0, 0, {...range('07'), mode});
  confirmation.check(`${mode}/confirmation date`, 1, 0, {...range('08'), mode});
  confirmation.check(`${mode}/QC plus later confirmation deduplicated`, 1, 0, {...range('06', '08'), mode});
}

const scoped = harness(fixture([
  {id: 'single-group-1', groupId: 'g01', events: [review('reject_confirm'), review('acceptance_fail')]},
  {id: 'single-group-2', groupId: 'g02', events: [review('reject_confirm'), review('acceptance_reject')]},
  {id: 'multi-group-6', groupId: 'g06', mode: 'multi', events: [review('reject_confirm'), review('acceptance_pass')]},
  {id: 'multi-group-7', groupId: 'g07', mode: 'multi', events: [review('reject_confirm'), review('acceptance_fail')]}
]));
for (const [mode, groupId, otherGroup] of [['single', 'g01', 'g02'], ['multi', 'g06', 'g07']]) {
  scoped.check(`${mode}/admin all groups`, 2, 2, {...range('07'), mode});
  scoped.check(`${mode}/selected group`, 1, 1, {...range('07'), mode, groupId});
  scoped.check(`${mode}/other group`, 1, 1, {...range('07'), mode, groupId: otherGroup});
  scoped.check(`${mode}/unknown group`, 0, 0, {...range('07'), mode, groupId: 'missing'});
  scoped.check(`${mode}/acceptance role all groups`, 2, 2, {...range('07'), mode, user: {role: 'acceptance'}});
  for (const role of ['qc', 'annotation']) {
    scoped.check(`${mode}/${role} cannot expand group permission`, 1, 1,
      {...range('07'), mode, groupId: 'all', user: {role, groupId}});
    scoped.check(`${mode}/${role} cannot select another group`, 1, 1,
      {...range('07'), mode, groupId: otherGroup, user: {role, groupId}});
  }
}
scoped.check('restricted single group cannot see multi cases', 0, 0,
  {...range('07'), mode: 'multi', user: {role: 'qc', groupId: 'g01'}});

const midnight = harness(fixture([
  {id: 'before-local-midnight', events: [{type: 'reject_confirm', at: '2026-10-06T15:59:59.999Z'}]},
  {id: 'at-local-midnight', events: [{type: 'reject_confirm', at: '2026-10-06T16:00:00.000Z'}]},
  {id: 'last-local-millisecond', events: [{type: 'reject_confirm', at: '2026-10-07T15:59:59.999Z'}]},
  {id: 'next-local-midnight', events: [{type: 'reject_confirm', at: '2026-10-07T16:00:00.000Z'}]}
]));
midnight.check('Beijing previous day', 1, 0, range('06'));
midnight.check('Beijing day inclusive boundaries', 2, 0, range('07'));
midnight.check('Beijing next day', 1, 0, range('08'));
midnight.check('date range inclusive endpoints', 3, 0, range('06', '07'));
midnight.check('open start', 3, 0, {dateTo: '2026-10-07'});
midnight.check('open end', 3, 0, {dateFrom: '2026-10-07'});
midnight.check('all dates', 4, 0);
midnight.check('reversed dates preserve overview placeholder', '—', '—', range('08', '06'));

// Release coverage includes a valid nonterminal workflow and more than one
// release. Only decisions after the final stored release survive statistics.
for (const mode of ['single', 'multi']) {
  const prior = [review('qc_pass', '04'), review('acceptance_fail', '05'), review('admin_release', '06')];
  const released = harness(fixture([{id: 'released', mode, events: prior}]));
  released.check(`${mode}/pre-release QC and acceptance excluded`, 0, 0, {...range('04', '08'), mode});
  const resumed = harness(fixture([{id: 'resumed', mode, events: [...prior,
    review('annotator_reject', '07'), review('reject_confirm', '08')]}]));
  resumed.check(`${mode}/old QC day after release`, 0, 0, {...range('04'), mode});
  resumed.check(`${mode}/post-release request alone`, 0, 0, {...range('07'), mode});
  resumed.check(`${mode}/post-release confirmation counts`, 1, 0, {...range('08'), mode});
  resumed.check(`${mode}/post-release confirmation over full range`, 1, 0, {...range('04', '08'), mode});
  const rereleased = harness(fixture([{id: 'released-twice', mode, events: [...prior,
    review('qc_fail', '07'), review('admin_release', '08'), review('reject_confirm', '09')]}]));
  rereleased.check(`${mode}/latest release wins`, 0, 0, {...range('04', '08'), mode});
  rereleased.check(`${mode}/latest release leaves new confirmation`, 1, 0, {...range('09'), mode});
}

console.log(JSON.stringify({ok: true, assertions, cases: assertions / 3,
  source: 'group-workbench/app.js',
  checks: ['real overview expressions and production helpers in VM',
    'QC outcomes and rejection confirmation; per-case deduplication',
    'single/multi modes, group selection and permissions',
    'decision dates and Beijing midnight boundaries',
    'latest release, deleted tasks and immutable input histories',
    'acceptance volume unchanged']}, null, 2));
