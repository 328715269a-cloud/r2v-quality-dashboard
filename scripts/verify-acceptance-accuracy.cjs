'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const Reports = require('../group-workbench/reports.js');
const Flow = require('../group-workbench/workflow.js');

function event(id, type, at, details = {}) {
  const actorRole = ['claim', 'submit'].includes(type) ? 'annotation' : type.startsWith('acceptance_') ? 'acceptance' : 'qc';
  return { id, taskId: 'rounds', type, at, actor: actorRole === 'annotation' ? '张明' : actorRole === 'acceptance' ? '验收人员' : '质检人员', actorRole, workflowVersion: 3, ...details };
}
const rounds = [
  event('claim-a', 'claim', '2026-09-19T01:00:00Z', { assignee: '张明' }),
  event('submit-a', 'submit', '2026-09-19T02:00:00Z', { submissionKind: 'initial' }),
  event('qc-a', 'qc_pass', '2026-09-19T03:00:00Z'),
  event('fail-a-1', 'acceptance_fail', '2026-09-20T15:59:59.999Z', { acceptanceRound: 1, note: '正常打回' }),
  event('route-qc', 'acceptance_route', '2026-09-20T15:59:59.999Z', { route: 'qc', actorRole: 'qc' }),
  event('repair-qc', 'qc_repair_done', '2026-09-20T15:59:59.999Z'),
  event('fail-a-2', 'acceptance_fail', '2026-09-20T16:00:00.000Z', { acceptanceRound: 2 }),
  event('route-annotation', 'acceptance_route', '2026-09-21T01:00:00Z', { route: 'annotation', actorRole: 'qc' }),
  event('transfer-b', 'claim', '2026-09-21T02:00:00Z', { actor: '分配组长', actorRole: 'qc', assignmentKind: 'rework_transfer', fromAssignee: '张明', assignee: '李明', assignmentStatus: 'acceptance_rework', workflowVersion: 4 }),
  event('stale-submit-a', 'submit', '2026-09-21T03:00:00Z', { assignee: '张明', submissionKind: 'rework' }),
  event('stale-pass', 'acceptance_pass', '2026-09-21T03:01:00Z', { workflowVersion: 1, round: 1 }),
  event('stale-fail', 'acceptance_fail', '2026-09-21T03:02:00Z', { workflowVersion: 1, round: 1 }),
  event('submit-b', 'submit', '2026-09-21T04:00:00Z', { actor: '李明', assignee: '李明', previousAssignee: '张明', submissionKind: 'rework' }),
  event('qc-b', 'qc_pass', '2026-09-21T05:00:00Z'),
  event('pass-b', 'acceptance_pass', '2026-09-21T15:59:59.999Z', { acceptanceRound: 3 }),
  event('admin-c', 'admin_reassign', '2026-09-21T16:00:00Z', { actor: '管理员', actorRole: 'admin', toRole: 'annotation', assignee: '王明' }),
  event('submit-c', 'submit', '2026-09-21T16:00:00Z', { actor: '王明', assignee: '王明', submissionKind: 'rework' }),
  event('qc-c', 'qc_pass', '2026-09-21T16:00:00Z'),
  event('pass-c', 'acceptance_pass', '2026-09-21T16:00:00.000Z', { acceptanceRound: 4 })
];
const clone = value => JSON.parse(JSON.stringify(value));
const stripFirstDecision = ({ firstAcceptanceDecision, ...legacy }) => legacy;
const dateOf = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const entry = (history, id, name, rawName = name) => {
  const value = history.find(row => row.id === id);
  return { name, rawName, at: value.at, eventId: id, type: value.type };
};

function fixture(mode = 'single') {
  const task = { id: 'rounds', tid: '000001', movie: '验收准确率回归', groupId: mode === 'single' ? 'g01' : 'g06', mode, date: '2026-09-18', createdAt: '2026-09-18T00:00:00Z' };
  const history = clone(rounds);
  return { state: { version: 3, tasks: [task], events: history, batches: [] }, tasks: [{ ...task, ...Flow.project(task, history) }], mode, statusMeta: Flow.STATUS_META, localDate: dateOf };
}

function main() {
  const before = JSON.stringify(rounds);
  const contributions = Reports.annotationContributors(rounds);
  const expected = entry(rounds, 'fail-a-1', '张明');
  assert.deepEqual(contributions.firstAcceptanceDecision, expected, 'first failure stays fixed after QC self repair, transfers, later submissions and passes');
  assert(!Object.hasOwn(contributions, 'acceptances'), 'no all-round collection is retained');
  assert.equal(Flow.project({ id: 'rounds' }, rounds).assignee, '王明');
  assert.equal(contributions.firstAcceptanceDecision.name, '张明', 'a current owner cannot rewrite the first verdict');
  assert.equal(contributions.firstQc.name, '张明');
  assert.equal(contributions.firstQc.type, 'qc_pass');
  assert.deepEqual(contributions.firstAcceptance, { name: '李明', rawName: '李明', at: rounds.find(row => row.id === 'pass-b').at, eventId: 'pass-b' }, 'firstAcceptance still means the first pass, not the first decision');
  assert.deepEqual(contributions.submissions.map(row => [row.name, row.kind]), [['张明', 'initial'], ['李明', 'rework'], ['王明', 'rework']]);
  assert.deepEqual(contributions.rework.map(row => [row.name, row.count]), [['李明', 1], ['王明', 1]]);
  assert.deepEqual(Flow.eventConflicts(rounds).map(row => row.eventId), ['stale-submit-a', 'stale-pass', 'stale-fail']);
  const conflictsFirst = [rounds[0], rounds[1], { ...rounds[2], type: 'qc_fail' }, rounds[8], rounds[10], rounds[11], rounds[12], rounds[13], { ...rounds[14], type: 'acceptance_fail' }, rounds[18]];
  assert.deepEqual(Reports.annotationContributors(conflictsFirst).firstAcceptanceDecision, entry(conflictsFirst, 'pass-b', '李明'), 'conflicting cached verdicts do not occupy the first effective decision');

  // Locate the first verdict using full history before consumers select dates.
  // The first-day failure cannot turn into a pass on a later repair date.
  const first = contributions.firstAcceptanceDecision;
  assert.equal(dateOf(first.at), '2026-09-20');
  assert.equal(first.type, 'acceptance_fail');
  assert.equal([first].filter(row => dateOf(row.at) >= '2026-09-21' && dateOf(row.at) <= '2026-09-22').length, 0);
  const boundaryTimes = ['2026-09-20T15:59:59.999Z', '2026-09-20T16:00:00.000Z', '2026-09-21T15:59:59.999Z', '2026-09-21T16:00:00.000Z'];
  const boundaryFirsts = boundaryTimes.map(at => Reports.annotationContributors([rounds[0], rounds[1], event('first-boundary', 'acceptance_pass', at)]).firstAcceptanceDecision);
  assert.deepEqual(boundaryFirsts.map(row => row.at), boundaryTimes);
  assert.deepEqual(boundaryFirsts.map(row => dateOf(row.at)), ['2026-09-20', '2026-09-21', '2026-09-21', '2026-09-22']);
  assert.equal(boundaryFirsts.filter(row => dateOf(row.at) >= '2026-09-21' && dateOf(row.at) <= '2026-09-21').length, 2);

  const noData = { initial: null, submissions: [], rework: [], firstQc: null, firstAcceptance: null, firstAcceptanceDecision: null };
  assert.deepEqual(Reports.annotationContributors(), noData);
  assert.deepEqual(Reports.annotationContributors([rounds.find(row => row.id === 'transfer-b')]), noData, 'assignment alone is not a contributor');
  assert.equal(Reports.annotationContributors(rounds.slice(0, 3)).firstAcceptanceDecision, null);
  const claimOnly = [event('claim-only', 'claim', '2026-09-20T01:00:00Z', { actor: '认领人' }), event('claim-verdict', 'acceptance_fail', '2026-09-20T02:00:00Z')];
  assert.deepEqual(Reports.annotationContributors(claimOnly).firstAcceptanceDecision, entry(claimOnly, 'claim-verdict', '认领人'), 'first annotation claim is the legacy fallback');
  const orphan = event('orphan', 'acceptance_pass', 'invalid-date');
  assert.deepEqual(Reports.annotationContributors([orphan, rounds.at(-1)]).firstAcceptanceDecision, entry([orphan], 'orphan', ''), 'missing ownership is left empty; an invalid first timestamp cannot promote a later pass');

  const rejects = [rounds[0], rounds[1], event('explicit-reject', 'acceptance_reject', '2026-09-20T01:00:00Z'), event('legacy-reject', 'acceptance_fail', '2026-09-20T02:00:00Z', { note: '[验收拒绝] 无法处理' }), event('ordinary-fail', 'acceptance_fail', '2026-09-20T03:00:00Z', { note: '正常打回，讨论[验收拒绝]文案' }), rounds.at(-1)];
  assert.deepEqual(Reports.annotationContributors(rejects).firstAcceptanceDecision, entry(rejects, 'explicit-reject', '张明'), 'explicit first rejection locks the first position before later pass/fail');
  const legacyRejects = rejects.filter(row => row.id !== 'explicit-reject');
  assert.deepEqual(Reports.annotationContributors(legacyRejects).firstAcceptanceDecision, { ...entry(rejects, 'legacy-reject', '张明'), type: 'acceptance_reject' }, 'legacy rejection is normalized and cannot be skipped to find a later pass');
  assert.equal(Reports.annotationContributors(rejects.filter(row => !row.id.includes('reject'))).firstAcceptanceDecision.type, 'acceptance_fail', 'marker text away from the prefix is a normal failure');
  const firstPass = [rounds[0], rounds[1], event('first-pass', 'acceptance_pass', '2026-09-20T01:00:00Z'), rounds[3], rounds[6]];
  assert.deepEqual(Reports.annotationContributors(firstPass).firstAcceptanceDecision, entry(firstPass, 'first-pass', '张明'), 'later failures cannot change an original first pass');

  const alias = [event('old-submit', 'submit', '2026-09-20T01:00:00Z', { actor: '成员01A', submissionKind: 'initial' }), event('old-verdict', 'acceptance_fail', '2026-09-20T02:00:00Z'), event('alias-submit', 'submit', '2026-09-20T03:00:00Z', { actor: '张明', previousAssignee: '成员01A', identityAlias: true, submissionKind: 'rework' }), event('alias-verdict', 'acceptance_pass', '2026-09-20T04:00:00Z')];
  assert.deepEqual(Reports.annotationContributors(alias).firstAcceptanceDecision, entry(alias, 'old-verdict', '张明', '成员01A'));
  const legacyAlias = alias.map(({ identityAlias, ...row }) => row);
  assert.deepEqual(Reports.annotationContributors(legacyAlias).firstAcceptanceDecision, Reports.annotationContributors(alias).firstAcceptanceDecision);
  const separate = alias.map(row => ({ ...row, ...(row.id === 'alias-submit' ? { previousAssignee: '张三', actor: '李四', identityAlias: false } : row.id === 'old-submit' ? { actor: '张三' } : {}) }));
  assert.equal(Reports.annotationContributors(separate).firstAcceptanceDecision.name, '张三');
  const transfer = [alias[0], alias[1], event('route-transfer', 'acceptance_route', '2026-09-20T02:10:00Z', { route: 'annotation' }), event('real-transfer', 'claim', '2026-09-20T02:20:00Z', { actor: '组长', actorRole: 'qc', assignmentKind: 'rework_transfer', fromAssignee: '成员01A', assignee: '张明' }), { ...alias[2], assignee: '张明' }, event('transfer-qc', 'qc_pass', '2026-09-20T03:30:00Z'), alias[3]];
  assert.equal(Reports.annotationContributors(transfer).firstAcceptanceDecision.name, '成员01A', 'real transfer does not transfer first-decision ownership or merge real workers as aliases');
  const transferBeforeFirst = transfer.filter(row => row.id !== 'old-verdict');
  assert.deepEqual(Reports.annotationContributors(transferBeforeFirst).firstAcceptanceDecision, entry(transferBeforeFirst, 'alias-verdict', '张明'), 'transfer before the first verdict credits the actual replacement submitter');

  const deleted = [...rounds, event('deleted', 'task_deleted', '2026-09-22T01:00:00Z'), event('post-delete-fail', 'acceptance_fail', '2026-09-22T02:00:00Z'), event('post-delete-pass', 'acceptance_pass', '2026-09-22T03:00:00Z')];
  assert.deepEqual(Reports.annotationContributors(deleted).firstAcceptanceDecision, expected, 'deletion keeps the earlier valid first decision');
  assert.equal(Reports.annotationContributors([rounds[0], rounds[1], ...deleted.slice(-3)]).firstAcceptanceDecision, null, 'post-deletion writes cannot invent a first decision');

  // Storage replays revision/ordinal order. Helpers must not invent a sort from
  // event IDs or client clocks, including same-time atomic actions.
  const sameTime = [event('z-submit', 'submit', '2026-09-20T01:00:00Z', { actor: '甲' }), event('y-fail', 'acceptance_fail', '2026-09-20T01:00:00Z'), event('x-submit', 'submit', '2026-09-20T01:00:00Z', { actor: '乙', submissionKind: 'rework' }), event('a-pass', 'acceptance_pass', '2026-09-19T01:00:00Z')];
  assert.deepEqual(Reports.annotationContributors(sameTime).firstAcceptanceDecision, entry(sameTime, 'y-fail', '甲'), 'tied timestamps and a later event with an older clock cannot change the first stored decision');
  const stored = sameTime.map((row, index) => ({ revision: 7 + Math.floor(index / 2), ordinal: index % 2, row }));
  const reordered = [stored[3], stored[1], stored[2], stored[0]];
  const canonical = reordered.slice().sort((a, b) => a.revision - b.revision || a.ordinal - b.ordinal).map(record => record.row);
  assert.deepEqual(Reports.annotationContributors(canonical), Reports.annotationContributors(sameTime));

  for (const mode of ['single', 'multi']) {
    const input = fixture(mode), original = JSON.stringify(input);
    const rows = Reports.build(input).tasks.rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].assignee, '王明');
    const oldColumns = JSON.parse(rows[0].annotationContributionsJSON);
    assert.deepEqual(oldColumns, stripFirstDecision(contributions), 'existing contribution JSON retains the exact old schema and values');
    assert.deepEqual(Object.keys(oldColumns), ['initial', 'submissions', 'rework', 'firstQc', 'firstAcceptance']);
    assert(!Object.hasOwn(rows[0], 'firstAcceptanceDecision'));
    assert.deepEqual(Reports.annotationContributors(input.state.events).firstAcceptanceDecision, expected, 'single/multi share the same first-decision algorithm');
    assert.equal(JSON.stringify(input), original);
  }
  const reportSource = fs.readFileSync(path.join(__dirname, '../group-workbench/reports.js'), 'utf8');
  const browser = { window: { WorkbenchFlow: Flow } };
  vm.runInNewContext(reportSource, browser);
  assert.deepEqual(clone(browser.window.WorkbenchReports.annotationContributors(rounds)), contributions, 'browser global and CommonJS dependencies return identical contributions');
  contributions.firstAcceptanceDecision.name = '外部修改';
  assert.equal(JSON.stringify(rounds), before);
  assert.deepEqual(Reports.annotationContributors(rounds).firstAcceptanceDecision, expected, 'returned decision never aliases mutable event fields');

  const result = { ok: true, firstAcceptanceDecisions: 1, laterRoundsExcluded: 3, firstType: expected.type, firstOwner: expected.name, checks: ['first effective decision only; later pass/fail cannot change it', 'first failure remains on its original day, later repair dates contribute nothing', 'Beijing midnight timestamps preserved for inclusive date filtering', 'QC repair and later transfers cannot move first-decision ownership', 'transfers before first acceptance credit the actual submitter', 'first claim fallback, empty histories, and invalid first timestamp', 'firstAcceptance remains first pass and firstQc unchanged', 'explicit and legacy rejection lock first position with normalized type', 'identity aliases retain raw names; real workers stay separate', 'conflicting early verdicts and post-delete writes cannot become first', 'storage revision/ordinal ordering with tied and reversed clocks', 'single/multi shared behavior and old export JSON schema', 'browser/CommonJS parity and immutable source'], sourceHash: crypto.createHash('sha256').update(reportSource).digest('hex') };
  if (process.env.RESULT_PATH) fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { fixture, rounds };
if (require.main === module) main();
