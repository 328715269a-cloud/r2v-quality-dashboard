'use strict';

// Run the actual browser metric/person renderers with production replay and
// contributor modules. These synthetic fixtures never connect to the API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const Reports = require('../group-workbench/reports.js');
const Flow = require('../group-workbench/workflow.js');
const {fixture: roundFixture} = require('./verify-acceptance-accuracy.cjs');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'group-workbench/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'group-workbench/index.html'), 'utf8');

function browserFunction(name) {
  const lines = app.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(`  function ${name}(`));
  assert.notEqual(start, -1, `production helper ${name} exists`);
  if (lines[start].trimEnd().endsWith('}')) return lines[start];
  const end = lines.findIndex((line, index) => index > start && /^  }\s*$/.test(line));
  assert.ok(end > start, `production helper ${name} closes`);
  return lines.slice(start, end + 1).join('\n');
}
const helpers = [
  'escapeHtml', 'emptyRow', 'localDateString', 'eventDate', 'selectedRange', 'validScopeRange',
  'singleScopeDate', 'scopeRangeLabel', 'inDateRange', 'canViewAllGroups', 'canViewGroup',
  'selectedGroup', 'inCurrentScope', 'eventsForTask', 'taskSnapshot', 'taskWithSnapshot',
  'taskIndex', 'allTasks', 'firstQcAccuracy', 'acceptanceEventDate', 'acceptanceAccuracy', 'renderPersonStats'
];
const overviewSource = browserFunction('renderOverview');
const metricRenderer = overviewSource.slice(0, overviewSource.indexOf('    const followups=')) + '\n  }';
assert.ok(metricRenderer.includes("setText('metricAcceptanceAccuracyDetail'"), 'extract the full actual metric output');
const makeHarness = new Function('Reports', 'Flow', 'fixture', `
  const window = {WorkbenchReports: Reports, WorkbenchFlow: Flow};
  let state = fixture, activeMode = 'single', profile = {role:'admin'};
  const eventIndexes = new WeakMap(), snapshotCache = new WeakMap();
  const controls = {scopeDateFrom:{value:''},scopeDateTo:{value:''},scopeGroup:{value:'g01'},personStatsBody:{innerHTML:''}};
  const rendered = {}, counts = Flow.counts, countRangeRejected = () => 0;
  const groupLabel = id => id;
  const setText = (id,value) => {rendered[id] = value;};
  const $ = id => controls[id];
  ${helpers.map(browserFunction).join('\n')}
  ${metricRenderer}
  return {
    setScope({dateFrom='',dateTo='',groupId='g01',mode='single',user={role:'admin'}}={}) {
      controls.scopeDateFrom.value=dateFrom; controls.scopeDateTo.value=dateTo;
      controls.scopeGroup.value=groupId; activeMode=mode; profile=user;
      state={...fixture}; // Login/identity changes create a fresh snapshot.
    },
    selectDates({dateFrom='',dateTo=''}) {controls.scopeDateFrom.value=dateFrom;controls.scopeDateTo.value=dateTo;},
    switchModule(mode,groupId='all') {activeMode=mode;controls.scopeGroup.value=groupId;},
    tasks() {return allTasks().filter(task=>inCurrentScope(task,false));},
    metric(range) {return acceptanceAccuracy(this.tasks(),range);},
    taskMetric(id,range) {return acceptanceAccuracy(this.tasks().filter(task=>task.id===id),range);},
    render() {renderOverview();renderPersonStats();return {value:rendered.metricAcceptanceAccuracy,detail:rendered.metricAcceptanceAccuracyDetail,people:controls.personStatsBody.innerHTML};},
    acceptanceEventDate
  };
`);

const state = {tasks:[],events:[],batches:[]};
let serial=0;
const at = (date,time='09:00:00') => `${date}T${time}+08:00`;
function addTask(id,verdicts,{groupId='g01',mode='single',owner='张甲',deleted=false}={}) {
  state.tasks.push({id,tid:id,movie:'日期口径验证',groupId,mode,date:'2026-09-01',createdAt:at('2026-09-01')});
  const history=[
    {type:'claim',at:at('2026-09-18'),actor:owner,assignee:owner,actorRole:'annotation'},
    {type:'submit',at:at('2026-09-19'),actor:owner,actorRole:'annotation',submissionKind:'initial'},
    {type:'qc_pass',at:at('2026-09-19','10:00:00'),actor:'组长',actorRole:'qc'},
    ...verdicts,
    ...(deleted?[{type:'task_deleted',at:at('2026-09-23'),actor:'管理员',actorRole:'admin'}]:[])
  ];
  history.forEach(value=>state.events.push({id:`acceptance-ui-${++serial}`,taskId:id,workflowVersion:3,actor:'验收人员',actorRole:'acceptance',...value}));
}
const pass = stamp => ({type:'acceptance_pass',at:stamp});
const fail = stamp => ({type:'acceptance_fail',at:stamp,note:'请修改'});
addTask('single-pass20',[pass('2026-09-20T15:59:59.999Z')]);
addTask('single-fail21',[fail('2026-09-20T16:00:00.000Z')],{owner:'李乙'});
addTask('single-pass21',[pass('2026-09-21T15:59:59.999Z')]);
addTask('single-pass21-extra',[pass(at('2026-09-21'))]);
addTask('single-pass22',[pass('2026-09-21T16:00:00.000Z')]);
addTask('explicit-reject',[{type:'acceptance_reject',at:at('2026-09-20'),note:'无法继续'},pass(at('2026-09-22'))]);
addTask('legacy-reject',[{type:'acceptance_fail',at:at('2026-09-21'),note:'[验收拒绝] 无法继续'},pass(at('2026-09-22'))]);
addTask('invalid-date',[pass('invalid-date'),pass(at('2026-09-22'))]);
addTask('missing-date',[fail('')]);
addTask('no-verdict',[]);
addTask('deleted-verdict',[pass(at('2026-09-20'))],{deleted:true});
addTask('group-two-fail20',[fail(at('2026-09-20'))],{groupId:'g02',owner:'张甲'});
addTask('multi-fail20',[fail(at('2026-09-20'))],{groupId:'g06',mode:'multi',owner:'王丙'});
addTask('multi-pass21',[pass(at('2026-09-21'))],{groupId:'g06',mode:'multi',owner:'赵丁'});
addTask('multi-pass21-extra',[pass(at('2026-09-21','13:00:00'))],{groupId:'g06',mode:'multi',owner:'赵丁'});
addTask('multi-group-two-pass20',[pass(at('2026-09-20'))],{groupId:'g07',mode:'multi',owner:'王丙'});

const original=JSON.stringify(state), ui=makeHarness(Reports,Flow,state);
const range=(dateFrom,dateTo=dateFrom)=>({dateFrom,dateTo});
const expected=(passed,total)=>({passed,total,rate:total?passed/total*100:null});
const cases=[];
function check(label,actual,wanted) {assert.deepEqual(actual,wanted,label);cases.push(label);}
function people(markup) {
  return [...markup.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(match=>{
    const cells=[...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(cell=>cell[1]);
    if(cells.length!==13)return {empty:true,cells};
    const decision=/首验 (\d+) 条 · 一次通过 (\d+)/.exec(cells[11]);
    return {name:cells[0],groupId:cells[1],passed:decision?Number(decision[2]):0,total:decision?Number(decision[1]):0,accuracy:cells[11].replace(/<[^>]+>/g,''),cells};
  });
}
function assertPersonParity(label,harness=ui) {
  const rendered=harness.render(),rows=people(rendered.people).filter(row=>!row.empty);
  const totals=rows.reduce((sum,row)=>({passed:sum.passed+row.passed,total:sum.total+row.total}),{passed:0,total:0});
  const metric=harness.metric();check(`${label}: personal numerators and denominators reconcile to overview`,totals,{passed:metric.passed,total:metric.total});
  check(`${label}: card rate formatting`,rendered.value,metric.rate===null?'—':`${metric.rate.toFixed(1)}%`);
  return rows;
}

check('Beijing day just before midnight',ui.acceptanceEventDate({at:'2026-09-20T15:59:59.999Z'}),'2026-09-20');
check('Beijing midnight starts the new date',ui.acceptanceEventDate({at:'2026-09-20T16:00:00.000Z'}),'2026-09-21');
check('Beijing last millisecond is inclusive',ui.acceptanceEventDate({at:'2026-09-21T15:59:59.999Z'}),'2026-09-21');
check('Beijing next midnight excluded from previous date',ui.acceptanceEventDate({at:'2026-09-21T16:00:00.000Z'}),'2026-09-22');
for(const at of ['invalid-date','',undefined,null])check(`invalid/missing event timestamp ${String(at)}`,ui.acceptanceEventDate({at}),'');

ui.setScope(range('2026-09-20'));
check('single day follows acceptance event, not allocation/submission date',ui.metric(),expected(1,1));
assertPersonParity('single day 20');
ui.selectDates(range('2026-09-21'));
check('single day counts first pass/fail verdicts on both inclusive boundaries',ui.metric(),expected(2,3));
const day21People=assertPersonParity('single day 21');
check('failed person stays at zero despite other people passing',day21People.find(row=>row.name==='李乙').accuracy,'0.0%首验 1 条 · 一次通过 0');
check('passing person has independent result',day21People.find(row=>row.name==='张甲').accuracy,'100.0%首验 2 条 · 一次通过 2');
ui.selectDates(range('2026-09-20','2026-09-21'));
check('multi-day accuracy uses weighted totals, not mean daily rates',ui.metric(),expected(3,4));
assert.notEqual(ui.metric().rate,(100+2/3*100)/2);
assertPersonParity('weighted interval');
check('range detail displays summed counts',ui.render().detail,'2026-09-20 至 2026-09-21 · 首验 4 条 · 一次通过 3');
ui.selectDates(range('2026-09-22'));
check('next day contains only next-midnight verdict',ui.metric(),expected(1,1));
ui.selectDates({});
check('all dates exclude invalid timestamps, rejection and deleted tasks',ui.metric(),expected(4,5));
assertPersonParity('all dates');
check('all-date detail labels range',ui.render().detail,'全部日期 · 首验 5 条 · 一次通过 4');
check('open lower date bound',ui.metric({dateFrom:'',dateTo:'2026-09-20'}),expected(1,1));
check('open upper date bound',ui.metric({dateFrom:'2026-09-21',dateTo:''}),expected(3,4));
for(const id of ['explicit-reject','legacy-reject','invalid-date','missing-date','no-verdict'])check(`${id} has no denominator`,ui.taskMetric(id),expected(0,0));
for(const day of ['2026-09-01','2026-09-19','2026-09-30']) {
  ui.selectDates(range(day));check(`${day}: allocation/submission/no-verdict day has no accuracy`,ui.metric(),expected(0,0));
  check(`${day}: no-data card`,ui.render().value,'—');
  check(`${day}: no-data detail`,ui.render().detail,`${day} · 暂无首次验收记录`);
  assertPersonParity(`${day}: no-data personal table`);
}
ui.selectDates(range('2026-09-22','2026-09-20'));
check('reversed range has no metric',ui.metric(),expected(0,0));
check('invalid range card text',ui.render().detail,'请修正日期区间');
assert.match(ui.render().people,/<td colspan="13"[^>]*>请修正日期区间<\/td>/);
check('explicit valid range independent of reversed selected dates',ui.metric(range('2026-09-20')),expected(1,1));
ui.selectDates(range('2026-09-20'));
check('explicit reversed range never leaks data',ui.metric(range('2026-09-22','2026-09-20')),expected(0,0));

ui.setScope({...range('2026-09-20'),groupId:'g02'});
check('selected single group excludes other group',ui.metric(),expected(0,1));
assertPersonParity('single group 2');
ui.setScope({...range('2026-09-20'),groupId:'all'});
check('all single groups exclude multi groups',ui.metric(),expected(1,2));
assertPersonParity('all single groups');
ui.switchModule('multi');
check('switch to multi reuses cache without single leakage',ui.metric(),expected(1,2));
assertPersonParity('all multi groups');
ui.switchModule('multi','g06');
check('multi day 20 has no passes',ui.metric(),expected(0,1));
assertPersonParity('multi day 20');
ui.selectDates(range('2026-09-21'));
check('multi day 21 updates to all passes',ui.metric(),expected(2,2));
assertPersonParity('multi day 21');
ui.selectDates(range('2026-09-20','2026-09-21'));
check('multi weighted interval differs from single and mean of days',ui.metric(),expected(2,3));
assertPersonParity('multi weighted interval');
ui.switchModule('single','g01');
check('switch back to single restores its own weighted result',ui.metric(),expected(3,4));
for(const role of ['annotation','qc']) {
  ui.setScope({...range('2026-09-20'),groupId:'all',user:{role,groupId:'g02'}});
  check(`${role} all-group input cannot bypass its own group`,ui.metric(),expected(0,1));
  check(`${role} person table cannot show another group`,[...new Set(assertPersonParity(role).map(row=>row.groupId))],['g02']);
  ui.switchModule('multi','all');check(`${role} forced foreign mode cannot reveal tasks`,ui.metric(),expected(0,0));
}
ui.setScope({...range('2026-09-20'),groupId:'all',user:{role:'acceptance',groupId:'g01'}});
check('acceptance role may view all selected-mode groups',ui.metric(),expected(1,2));
ui.setScope({groupId:'nonexistent'});
check('empty group has no metric',ui.metric(),expected(0,0));
assert.match(ui.render().people,/<td colspan="13"[^>]*>当前范围还没有人员作业记录。<\/td>/);
assert.equal(JSON.stringify(state),original,'UI calculation/rendering never edits source history');

for(const mode of ['single','multi']) {
  const input=roundFixture(mode),historyOriginal=JSON.stringify(input.state),rounds=makeHarness(Reports,Flow,input.state);
  rounds.setScope({mode,groupId:'all'});
  check(`${mode}: repeated acceptance counts only the first effective decision`,rounds.metric(),expected(0,1));
  const rows=assertPersonParity(`${mode}: historical-owner totals`,rounds);
  check(`${mode}: old first failure remains with original annotator after replacement`,rows.find(row=>row.name==='张明').accuracy,'0.0%首验 1 条 · 一次通过 0');
  check(`${mode}: replacement recheck pass is not first acceptance`,rows.find(row=>row.name==='李明').accuracy,'暂无首验');
  check(`${mode}: current owner cannot acquire a historical first decision`,rows.find(row=>row.name==='王明').accuracy,'暂无首验');
  check(`${mode}: current status is already accepted`,rounds.tasks()[0].status,'accepted');
  for(const [day,counts] of [['2026-09-20',[0,1]],['2026-09-21',[0,0]],['2026-09-22',[0,0]]]) {
    rounds.selectDates(range(day));check(`${mode}: history on ${day} remains independent of latest status`,rounds.metric(),expected(...counts));
    assertPersonParity(`${mode}: historical-owner day ${day}`,rounds);
  }
  assert.equal(JSON.stringify(input.state),historyOriginal);
}

// Missing historical ownership must not disappear from personal totals or be
// assigned to the current worker who joined after the first decision.
for(const mode of ['single','multi']) {
  const task={id:'orphan-first',tid:'orphan-first',movie:'缺失历史标注人',mode,groupId:mode==='single'?'g01':'g06',date:'2026-09-01',createdAt:at('2026-09-01')};
  const orphanState={tasks:[task],batches:[],events:[
    {id:'unknown-first',taskId:task.id,type:'acceptance_pass',actor:'验收员',actorRole:'acceptance',at:at('2026-09-20'),workflowVersion:3},
    {id:'later-owner',taskId:task.id,type:'admin_reassign',actor:'管理员',actorRole:'admin',at:at('2026-09-21'),assignee:'后来标注人',toRole:'annotation',workflowVersion:3}
  ]};
  const orphan=makeHarness(Reports,Flow,orphanState);orphan.setScope({...range('2026-09-20'),mode,groupId:'all'});
  check(`${mode}: unknown historical annotator still contributes first acceptance`,orphan.metric(),expected(1,1));
  const rows=assertPersonParity(`${mode}: unknown-owner parity`,orphan);
  check(`${mode}: missing historical owner has dedicated row`,rows.find(row=>row.name==='未记录标注人').accuracy,'100.0%首验 1 条 · 一次通过 1');
  check(`${mode}: latest owner does not inherit orphan first result`,rows.find(row=>row.name==='后来标注人').accuracy,'暂无首验');
}

const cumulativeAt=html.indexOf('class="overview-metrics overview-metrics-cumulative"');
const dailyAt=html.indexOf('class="overview-metrics overview-metrics-today"');
const firstAt=html.indexOf('id="metricFirstQcAccuracy"'),rejectedAt=html.indexOf('id="metricRejected"'),acceptanceAt=html.indexOf('id="metricAcceptanceAccuracy"');
assert.equal((html.match(/id="metricAcceptanceAccuracy"/g)||[]).length,1,'single shared card renders both modules');
assert.ok(cumulativeAt<dailyAt&&dailyAt<firstAt&&firstAt<rejectedAt&&rejectedAt<acceptanceAt&&acceptanceAt<html.indexOf('</section>',dailyAt),'card appended after current date metrics in requested order');
assert(!html.slice(cumulativeAt,dailyAt).includes('metricAcceptanceAccuracy'),'accuracy not placed in cumulative metrics');
const bodyAt=html.indexOf('<tbody id="personStatsBody">');
const table=html.slice(html.lastIndexOf('<thead>',bodyAt),bodyAt);
const headers=[...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(match=>match[1].replace(/<[^>]+>/g,''));
check('person headers retain existing fields and insert first-acceptance accuracy after first-QC',headers,['人员','小组','首次提交','返修提交','验收通过','首次质检','首检通过','P0','P1','P2','首检准确率','首次验收准确率','常犯错误点标签看分布']);
assert.match(html.slice(rejectedAt,html.indexOf('</section>',dailyAt)),/>首次验收准确率<\/span>/,'card label is explicit about first acceptance');

const sourceHashes=Object.fromEntries(['app.js','index.html','reports.js'].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'group-workbench',file))).digest('hex')]));
const result={ok:true,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,checks:cases.length,cases,productionHelpers:helpers,realOverviewRenderer:true,realPersonRenderer:true,sourceHashes};
if(!process.env.ACCEPTANCE_UI_TZ_CHILD) {
  result.timezoneRuns=[];
  for(const timezone of ['UTC','Asia/Shanghai']) {
    const child=spawnSync(process.execPath,[__filename],{encoding:'utf8',env:{...process.env,TZ:timezone,ACCEPTANCE_UI_TZ_CHILD:'1',RESULT_PATH:''}});
    assert.equal(child.status,0,`${timezone} run failed: ${child.stderr || child.stdout}`);
    const report=JSON.parse(child.stdout);assert.equal(report.ok,true);assert.deepEqual(report.sourceHashes,sourceHashes,'source frozen throughout timezone checks');
    result.timezoneRuns.push({timezone:report.timezone,ok:report.ok,checks:report.checks});
  }
  if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify(result,null,2));
