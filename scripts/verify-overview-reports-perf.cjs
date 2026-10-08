'use strict';

// Offline differential regression. The immutable prod65 resource is the oracle;
// all input is generated here, with no store, server, network or business data.
process.env.TZ = 'Asia/Shanghai';
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const Reports = require('../group-workbench/reports.js');
const Baseline = require('../group-workbench/reports.20260924-prod65-reject-col.js');
const Flow = require('../group-workbench/workflow.js');

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const localDate = value => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
const groups = freeze([
  { id: 'g01', defaultMode: 'single', name: '一组', leader: '组长甲' },
  { id: 'g02', defaultMode: 'single', name: '二组', leader: '组长乙' },
  { id: 'g06', defaultMode: 'multi', name: '一组', leader: '组长丙' },
  { id: 'g07', defaultMode: 'multi', name: '二组', leader: '组长丁' },
  { id: 'empty', defaultMode: 'single', name: '空组' }
]);
const event = (type, day = 7, extra = {}) => ({ type, at: `2026-10-${String(day).padStart(2, '0')}T09:00:00+08:00`, ...extra });
const submit = (day = 7, extra = {}) => event('submit', day, { actorRole: 'annotation', actor: '标注甲', ...extra });
const qc = (type, day = 7, extra = {}) => event(type, day, { actorRole: 'qc', actor: '质检甲', ...extra });
const accept = (type, day = 7, extra = {}) => event(type, day, { actorRole: 'acceptance', actor: '验收甲', ...extra });
const specs = [
  { name: 'pending', chain: [] },
  { name: 'initial', chain: [submit(7, { submissionKind: 'initial' })] },
  { name: 'qc-pass', chain: [submit(), qc('qc_pass')] },
  { name: 'accepted', chain: [submit(), qc('qc_pass'), accept('acceptance_pass')] },
  { name: 'rework', chain: [submit(), qc('qc_fail', 7, { pLevel: 'P1', tags: ['缺失'] }), submit(8, { submissionKind: 'rework' }), qc('qc_pass', 8), accept('acceptance_fail', 8), event('acceptance_route', 8, { route: 'annotation' }), submit(9, { submissionKind: 'rework' }), qc('qc_pass', 9), accept('acceptance_pass', 9)] },
  { name: 'qc-reject', chain: [submit(), qc('qc_reject', 8)] },
  { name: 'qc-legacy-reject', chain: [submit(), qc('qc_fail', 8, { note: '[质检拒绝] 无法继续' })] },
  { name: 'acceptance-reject', chain: [submit(), qc('qc_pass'), accept('acceptance_reject', 8)] },
  { name: 'acceptance-legacy-reject', chain: [submit(), qc('qc_pass'), accept('acceptance_fail', 8, { note: '[验收拒绝] 无法继续' })] },
  { name: 'annotation-reject', chain: [event('annotator_reject', 7, { actorRole: 'annotation', actor: '标注甲' }), qc('reject_confirm', 8)] },
  { name: 'reject-return', chain: [event('annotator_reject', 7, { actorRole: 'annotation', actor: '标注甲' }), qc('reject_return', 8), submit(8), qc('qc_pass', 9)] },
  { name: 'release', chain: [submit(), qc('qc_pass'), accept('acceptance_fail'), event('admin_release', 8), event('claim', 9, { actorRole: 'annotation', actor: '标注乙', assignee: '标注乙' }), submit(9, { submissionKind: 'initial', actor: '标注乙' }), qc('qc_pass', 9), accept('acceptance_pass', 9)] },
  { name: 'release-reject', chain: [event('annotator_reject', 7, { actorRole: 'annotation', actor: '标注甲' }), event('admin_release', 8), submit(9, { submissionKind: 'initial' })] },
  { name: 'self-repair', chain: [submit(), qc('qc_pass'), accept('acceptance_fail'), event('acceptance_route', 8, { route: 'qc' }), qc('qc_repair_done', 8), accept('acceptance_pass', 9)] },
  { name: 'transfer', chain: [submit(), qc('qc_fail', 7, { pLevel: 'P2' }), event('claim', 8, { assignmentKind: 'rework_transfer', fromAssignee: '标注甲', assignee: '标注乙', actor: '质检甲', actorRole: 'qc' }), submit(8, { submissionKind: 'rework', actor: '标注甲' }), submit(9, { submissionKind: 'rework', actor: '标注乙' }), qc('qc_pass', 9)] },
  { name: 'alias', chain: [submit(7, { previousAssignee: 'worker_a', actor: '张明', identityAlias: true }), submit(8, { actor: '张明', submissionKind: 'rework' })] },
  { name: 'duplicate-a', tid: 'DUPLICATE', chain: [submit(), qc('qc_pass'), qc('qc_pass'), accept('acceptance_pass'), accept('acceptance_pass', 8)] },
  { name: 'duplicate-b', tid: 'DUPLICATE', chain: [submit(), qc('qc_pass'), event('admin_release', 8), submit(9, { submissionKind: 'initial' }), qc('qc_pass', 9)] },
  { name: 'midnight', chain: [submit(7, { at: '2026-10-07T15:59:59Z' }), qc('qc_pass', 8, { at: '2026-10-07T16:00:00Z' }), accept('acceptance_pass', 8)] },
  { name: 'deleted', chain: [submit(), qc('qc_pass'), event('task_deleted', 8, { note: '合成删除历史' })] }
];

function fixture(copies = 1) {
  const state = { tasks: [], events: [], batches: [] };
  for (let copy = 0; copy < copies; copy += 1) for (const group of groups.slice(0, 4)) for (const spec of specs) {
    const id = `${group.id}-${copy}-${spec.name}`;
    const task = { id, tid: spec.tid ? `${copy}-${spec.tid}` : id, movie: `合成影片${copy % 3}`, mode: group.defaultMode, groupId: group.id,
      date: spec.name === 'midnight' ? '2026-10-08' : '2026-10-06', createdAt: spec.name === 'midnight' ? '2026-10-07T16:00:00Z' : '2026-10-06T01:00:00Z', batchId: `import-${group.id}-${copy}`, extra: '审计字段\n原始数据' };
    state.tasks.push(task);
    const chain = [event('dispatch', 6), event('claim', 7, { actorRole: 'annotation', actor: spec.name === 'alias' ? 'worker_a' : '标注甲', assignee: '标注甲' }), ...spec.chain];
    if (spec.name === 'pending') chain.splice(1);
    if (spec.name === 'qc-pass' || spec.name === 'accepted') {
      const packageId = `package-${group.id}-${copy}`;
      chain.splice(3, 0, event('package_built', 7, { packageId, stage: 'qc', packageRound: 1 }), event('package_claimed', 7, { packageId, stage: 'qc', packageRound: 1, actorRole: 'qc' }));
    }
    chain.forEach((entry, index) => state.events.push({ id: `${id}-e${index}`, taskId: id, actor: '合成管理员', ...entry }));
  }
  for (let copy = 0; copy < copies; copy += 1) for (const group of groups.slice(0, 4)) {
    const members = state.tasks.filter(task => task.groupId === group.id && task.batchId === `import-${group.id}-${copy}`);
    state.batches.push({ id: `import-${group.id}-${copy}`, kind: 'import', taskIds: members.map(task => task.id), mode: group.defaultMode, groupId: group.id, movie: members[0].movie, createdAt: members[0].createdAt });
    // The second member is intentionally supplied only by a package event.
    state.batches.push({ id: `package-${group.id}-${copy}`, kind: 'handoff', stage: 'qc', taskIds: [`${group.id}-${copy}-qc-pass`], createdAt: '2026-10-07T01:00:00Z' });
    state.batches.push({ id: `acceptance-${group.id}-${copy}`, kind: 'handoff', stage: 'acceptance', taskIds: [`${group.id}-${copy}-accepted`], createdAt: '2026-10-08T01:00:00Z' });
  }
  for (const group of groups) for (const [day, headcount] of [[7, 1.5], [8, null], [9, 0]]) state.events.push({
    id: `setting-${group.id}-${day}`, taskId: `group:${group.id}`, type: 'group_daily_edit', groupId: group.id, mode: group.defaultMode,
    date: `2026-10-0${day}`, at: `2026-10-0${day}T12:00:00+08:00`, actor: '组长', before: {}, after: { leader: group.leader || '', total: 200 + day, headcount }
  });
  const byTask = new Map(state.tasks.map(task => [task.id, []]));
  for (const entry of state.events) if (byTask.has(entry.taskId)) byTask.get(entry.taskId).push(entry);
  const tasks = state.tasks.map(task => ({ ...task, ...Flow.project(task, byTask.get(task.id)) }));
  return freeze({ state, tasks, auditTasks: tasks, groups, statusMeta: Flow.STATUS_META, localDate, groupLabel: id => groups.find(group => group.id === id)?.name || id });
}

let comparisons = 0;
function same(actual, expected, label) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), label);
  comparisons += 1;
}
const input = fixture();
const before = JSON.stringify(input);
const ranges = [ {}, { dateFrom: '2026-10-07', dateTo: '2026-10-07' }, { dateFrom: '2026-10-07', dateTo: '2026-10-09' },
  { dateFrom: '2026-10-08', dateTo: '2026-10-08' }, { dateFrom: '2026-10-10', dateTo: '2026-10-11' }, { dateFrom: '', dateTo: '2026-10-08' }, { dateFrom: '2026-10-08', dateTo: '' } ];
for (const mode of ['', 'single', 'multi']) for (const range of ranges) for (const groupId of ['all', 'g01', 'g06']) {
  const scoped = { ...input, mode, ...range, tasks: input.tasks.filter(task => groupId === 'all' || task.groupId === groupId),
    groups: input.groups.filter(group => (!mode || group.defaultMode === mode) && (groupId === 'all' || group.id === groupId)) };
  const label = `${mode || 'both'} / ${groupId} / ${JSON.stringify(range)}`;
  const baseline = Baseline.build(scoped);
  same(Reports.build(scoped), baseline, `${label}: complete exports stay byte-identical`);
  same(Reports.build({ ...scoped, kind: 'closure' }), { closure: baseline.closure }, `${label}: closure fast path`);
  same(Reports.build({ ...scoped, kind: 'daily' }), { daily: baseline.daily, closure: baseline.closure }, `${label}: daily fast path`);
  same(Reports.groupDaily(scoped), Baseline.groupDaily(scoped), `${label}: group range model`);
  same(Reports.personDaily(scoped), Baseline.personDaily(scoped), `${label}: people range model`);
}
for (const kind of ['imports', 'tasks', 'events', 'packages', 'movies', 'groups', 'summary', 'daily', 'personDaily', 'closure', 'unknown']) {
  same(Reports.build({ ...input, kind }), Baseline.build({ ...input, kind }), `${kind}: pre-existing targeted schema`);
}
for (const extra of [{ groups: undefined }, { tasks: [], auditTasks: [] }, { state: {}, tasks: [], groups: [] }]) {
  const scoped = { ...input, ...extra };
  const baseline = Baseline.build(scoped);
  same(Reports.build(scoped), baseline, 'fallback groups / empty state: default');
  same(Reports.build({ ...scoped, kind: 'closure' }).closure, baseline.closure, 'fallback groups / empty state: closure');
  same(Reports.build({ ...scoped, kind: 'daily' }).daily, baseline.daily, 'fallback groups / empty state: daily');
}
for (const date of ['2026-02-30', '2026-13-01', 'not-a-date']) for (const kind of ['daily', 'closure']) {
  assert.throws(() => Reports.build({ ...input, kind, dateFrom: date }), RangeError, `${kind}: invalid dates keep rejection`);
}
same(JSON.stringify(input), before, 'frozen input and raw histories are unchanged');

// Audit-only input must not be visited for an overview report. Poison getters
// catch accidental export work even when the final numeric output is correct.
const noAudit = { ...input, kind: 'daily', state: { ...input.state, get tasks() { throw Error('raw task audit was read'); } } };
Object.defineProperty(noAudit, 'auditTasks', { enumerable: false, get() { throw Error('deleted task audit was read'); } });
same(Reports.build(noAudit).daily, Baseline.build(input).daily, 'daily does not read raw task audit');
const closureOnly = { ...input, kind: 'closure', state: { events: input.state.events,
  get tasks() { throw Error('closure read audit tasks'); }, get batches() { throw Error('closure read batches'); } } };
same(Reports.build(closureOnly).closure, Baseline.build(input).closure, 'closure does not read audit tasks or batches');

const large = fixture(Number(process.env.REPORT_PERF_COPIES || 12));
function median(run) {
  run();
  const samples = [];
  for (let round = 0; round < 5; round += 1) { const start = performance.now(); run(); samples.push(performance.now() - start); }
  return Number(samples.sort((a, b) => a - b)[2].toFixed(2));
}
const perf = {
  taskCount: large.tasks.length, eventCount: large.state.events.length,
  baselineFullTwiceMs: median(() => { Baseline.build(large); Baseline.build(large); }),
  selectedClosureAndDailyMs: median(() => { Reports.build({ ...large, kind: 'closure' }); Reports.build({ ...large, kind: 'daily' }); }),
  baselineClosureMs: median(() => Baseline.build({ ...large, kind: 'closure' })),
  selectedClosureMs: median(() => Reports.build({ ...large, kind: 'closure' })),
  baselineDailyMs: median(() => Baseline.build({ ...large, kind: 'daily' })),
  selectedDailyMs: median(() => Reports.build({ ...large, kind: 'daily' }))
};
perf.fullToSelectedSpeedup = Number((perf.baselineFullTwiceMs / perf.selectedClosureAndDailyMs).toFixed(2));
console.log(JSON.stringify({ ok: true, oracle: 'reports.20260924-prod65-reject-col.js', comparisons,
  checks: ['frozen synthetic state', 'complete export bytes', 'all report kinds', 'date/mode/group scopes', 'initial/rework/reject/release/transfer/alias/duplicate TID/midnight/deleted/empty/package events', 'no audit input access'], perf }, null, 2));
