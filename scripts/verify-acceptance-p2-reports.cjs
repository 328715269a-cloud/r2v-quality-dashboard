'use strict';
// Synthetic, offline reporting fixtures only. No production reads or writes.
process.env.TZ = 'UTC';
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const Flow = require('../group-workbench/workflow.js');
const Reports = require('../group-workbench/reports.js');
const IO = require('../group-workbench/data-io.js');
const {createExporter} = require('../group-workbench/export-worker.js');
const groups = [
  {id:'g01',name:'单镜头1组',defaultMode:'single'},
  {id:'g02',name:'单镜头2组',defaultMode:'single'},
  {id:'g06',name:'多镜头1组',defaultMode:'multi'},
  {id:'g07',name:'多镜头2组',defaultMode:'multi'}
];
const day = value => `2026-10-${value}T09:00:00+08:00`;
const range = value => ({dateFrom:`2026-10-${value}`,dateTo:`2026-10-${value}`});
const p2 = {acceptanceIssueLevel:'P2'};
const metricValues = ({passed,total,rate,p2Count,p2Rate}) => ({passed,total,rate,p2Count,p2Rate});
function fixture(mode='multi') {
  const state = {tasks:[],events:[],batches:[]}; let serial=0;
  const groupId=mode==='multi'?'g06':'g01';
  const addEvent=(taskId,type,extra={})=>{
    const value={id:`event-${++serial}`,taskId,type,at:day('26'),actor:'验收员',actorRole:'acceptance',workflowVersion:4,...extra};
    state.events.push(value);return value;
  };
  const addTask=(id,extra={})=>{
    const value={id,tid:`TID-${id}`,movie:'P2统计示例',mode,groupId,date:'2026-10-25',createdAt:day('25'),...extra};
    state.tasks.push(value);
    addEvent(id,'claim',{at:day('25'),actor:'初标人',actorRole:'annotation',assignee:'初标人'});
    addEvent(id,'submit',{at:day('25'),actor:'初标人',actorRole:'annotation',submissionKind:'initial'});
    addEvent(id,'qc_pass',{at:day('25'),actor:'质检员',actorRole:'qc'});
    return value;
  };
  const verdict=(id,inspection='pass',extra={})=>addEvent(id,inspection==='fail'?'acceptance_fail':'acceptance_pass',{
    acceptanceInspection:inspection,acceptanceRound:1,note:'检查说明',...extra
  });
  const history=id=>state.events.filter(event=>event.taskId===id);
  const projected=()=>state.tasks.map(task=>({...task,...Flow.project(task,history(task.id))}));
  const metric=(scope={})=>Reports.acceptanceAccuracy({state,tasks:projected(),mode,...scope});
  const input=(scope={})=>({state,tasks:projected(),groups,statusMeta:Flow.STATUS_META,mode,localDate:Reports.acceptanceDate,
    groupLabel:id=>groups.find(group=>group.id===id)?.name||id,...scope});
  return {state,mode,groupId,addTask,addEvent,verdict,history,projected,metric,input};
}

function checkMetric() {
  for (const mode of ['single','multi']) {
    const f=fixture(mode);
    for(let index=0;index<10;index++) {f.addTask(`sample-${index}`);f.verdict(`sample-${index}`,index===9?'fail':'pass',index===8?p2:{});}
    const expected={passed:9,total:10,rate:90,p2Count:1,p2Rate:10};
    assert.deepEqual(metricValues(f.metric()),expected,'8 ordinary + 1 P2 + 1 fail: 90% accuracy, 10% P2');
    const marked=f.metric().rows.find(row=>row.isP2);
    assert.equal(marked.taskId,'sample-8');assert.equal(marked.passed,true);
    assert.equal(marked.acceptanceIssueLevel,'P2');assert.match(marked.inspectionLabel,/P2/);
    assert.equal(f.projected().find(task=>task.id==='sample-8').status,'accepted','P2 directly completes the acceptance flow');
    const unmarked=structuredClone(f.state);unmarked.events.forEach(event=>delete event.acceptanceIssueLevel);
    assert.deepEqual(metricValues(Reports.acceptanceAccuracy({state:unmarked,tasks:f.projected(),mode})),{...expected,p2Count:0,p2Rate:0},'the marker never changes the old pass denominator or numerator');

    // Later verification, repairs, duplicate cycles and a changed current owner
    // must not overwrite the first actual decision or its P2 classification.
    f.verdict('sample-8','pass',{at:day('27'),acceptanceRound:2});
    f.verdict('sample-8','pass',{at:day('27'),acceptanceRound:3,...p2});
    f.verdict('sample-0','pass',{at:day('27'),acceptanceRound:2,...p2});
    f.verdict('sample-9','pass',{at:day('27'),acceptanceRound:2,...p2});
    f.addEvent('sample-8','admin_reassign',{at:day('27'),actorRole:'admin',assignee:'接续人',toRole:'annotation'});
    assert.deepEqual(metricValues(f.metric()),expected);
    assert.deepEqual(metricValues(f.metric({...range('26')})),expected);
    assert.deepEqual(metricValues(f.metric({dateFrom:'2026-10-26',dateTo:'2026-10-27'})),expected,'cross-day interval counts each first decision once');
    assert.deepEqual(metricValues(f.metric(range('27'))),{passed:0,total:0,rate:null,p2Count:0,p2Rate:null});
    assert.equal(f.metric().rows.find(row=>row.isP2).name,'初标人');
    assert.deepEqual(metricValues(f.metric({dateFrom:'2026-10-27',dateTo:'2026-10-26'})),{passed:0,total:0,rate:null,p2Count:0,p2Rate:null});

    const cached=new Map(f.projected().map(task=>[task.id,Reports.annotationContributors(f.history(task.id))]));let calls=0;
    const cachedInput={tasks:f.projected(),mode,contributionForTask:task=>{calls++;return cached.get(task.id);}};
    Object.defineProperty(cachedInput,'events',{get(){throw new Error('cached metric must not rescan events');}});
    assert.deepEqual(Reports.acceptanceAccuracy(cachedInput),f.metric());assert.equal(calls,10);
    const browser={window:{WorkbenchFlow:Flow}};
    vm.runInNewContext(fs.readFileSync(require.resolve('../group-workbench/reports.js'),'utf8'),browser);
    assert.deepEqual(JSON.parse(JSON.stringify(browser.window.WorkbenchReports.acceptanceAccuracy({state:f.state,tasks:f.projected(),mode}))),f.metric());
  }
}

function checkExclusionsAndScope() {
  const f=fixture();
  f.addTask('uninspected');f.verdict('uninspected','uninspected');f.verdict('uninspected','pass',{at:day('27'),acceptanceRound:2,...p2});
  f.addTask('batch-return');f.addEvent('batch-return','acceptance_fail',{acceptanceInspection:'uninspected',acceptanceRound:1,acceptanceBatchId:'batch'});f.verdict('batch-return','pass',{at:day('27'),acceptanceRound:2,...p2});
  f.addTask('reject');f.addEvent('reject','acceptance_reject',{note:'拒绝'});f.verdict('reject','pass',{at:day('27'),acceptanceRound:2,...p2});
  f.addTask('legacy-reject');f.addEvent('legacy-reject','acceptance_fail',{note:'[验收拒绝] 无法处理'});
  f.addTask('round-two');f.verdict('round-two','pass',{acceptanceRound:2,...p2});
  f.addTask('deleted');f.verdict('deleted','pass',p2);f.addEvent('deleted','task_deleted',{actorRole:'admin'});
  f.addTask('released');f.verdict('released','pass',p2);f.addEvent('released','admin_release',{at:day('27'),actorRole:'admin'});
  assert.deepEqual(metricValues(f.metric()),{passed:0,total:0,rate:null,p2Count:0,p2Rate:null},'uninspected, rejected, later-round, deleted and released records are excluded');

  f.addTask('qc-p2');f.addEvent('qc-p2','qc_fail',{actorRole:'qc',pLevel:'P2'});f.verdict('qc-p2','pass',{note:'质检提过 P2，不能推断为验收P2'});
  f.addTask('legacy-note');f.addEvent('legacy-note','acceptance_pass',{note:'历史 P2 修改后通过'});
  f.addTask('ordinary-level');f.verdict('ordinary-level','pass',{pLevel:'P2'});
  assert.deepEqual(metricValues(f.metric()),{passed:3,total:3,rate:100,p2Count:0,p2Rate:0},'QC levels and free-text history never invent acceptance P2');

  f.addTask('boundary-before');f.verdict('boundary-before','pass',{at:'2026-10-26T15:59:59.999Z',...p2});
  f.addTask('boundary-after',{groupId:'g07'});f.verdict('boundary-after','pass',{at:'2026-10-26T16:00:00.000Z',...p2});
  f.addTask('single-p2',{groupId:'g01',mode:'single'});f.verdict('single-p2','pass',p2);
  assert.equal(f.metric(range('26')).p2Count,1);assert.equal(f.metric(range('27')).p2Count,1);
  assert.equal(f.metric({groupId:'g06'}).p2Count,1);assert.equal(f.metric({groupId:'g07'}).p2Count,1);
  assert.equal(f.metric({mode:'single'}).p2Count,1);assert.equal(f.metric({mode:''}).p2Count,3);

  // Invalid combinations can exist in a synthetic/legacy dataset; they must
  // never inflate P2 even before the API's write validation is considered.
  for(const event of [
    {type:'acceptance_fail',acceptanceInspection:'fail',...p2},
    {type:'acceptance_fail',acceptanceInspection:'pass',acceptanceBatchId:'batch',...p2},
    {type:'acceptance_pass',acceptanceInspection:'uninspected',...p2},
    {type:'acceptance_reject',acceptanceInspection:'pass',...p2},
    {type:'qc_pass',acceptanceInspection:'pass',...p2},
    {type:'acceptance_pass',...p2},
    {type:'acceptance_pass',acceptanceInspection:'pass',acceptanceIssueLevel:'P1'}
  ]) assert.equal(Reports.acceptanceAssessment({id:'synthetic',at:day('26'),acceptanceRound:1,...event},{eventId:'synthetic'}).isP2,false);
}

async function checkExports() {
  const f=fixture();
  for(let index=0;index<10;index++) {f.addTask(`sample-${index}`);f.verdict(`sample-${index}`,index===9?'fail':'pass',index===8?p2:{});}
  f.verdict('sample-8','pass',{at:day('27'),acceptanceRound:2,...p2});
  const before=JSON.stringify(f.state), report=Reports.build(f.input());
  const detail=Reports.build({...f.input(),kind:'acceptanceAccuracy'}).acceptanceAccuracy;
  assert.equal(detail.p2Count,1);assert.equal(detail.p2Rate,10);assert.equal(detail.rows.filter(row=>row.isP2).length,1);
  assert(detail.columns.some(column=>column.key==='acceptanceIssueLevel'));
  const task=report.tasks.rows.find(row=>row.taskId==='sample-8');
  assert.equal(task.firstAcceptanceIssueLevel,'P2');assert.equal(task.firstAcceptanceP2Included,true);
  assert.equal(task.acceptanceIssueLevel,'P2','current inspection marker is exported separately from the first marker');
  const p2Events=report.events.rows.filter(row=>row.acceptanceIssueLevel==='P2');
  assert.equal(p2Events.length,2);assert.equal(p2Events.filter(row=>row.acceptanceP2Included).length,2,'both effective P2 inspections are eligible; the new metric deduplicates their TID');
  for(const summary of [report.groups.rows.find(row=>row.groupId==='g06'),report.movies.rows[0],report.daily.rows.find(row=>row.date==='2026-10-26'&&row.groupId==='g06')]) {
    assert.equal(summary.firstAcceptanceInspectedTIDs,10);assert.equal(summary.firstAcceptancePassedTIDs,9);
    assert.equal(summary.firstAcceptanceAccuracy,'90.0%');assert.equal(summary.firstAcceptanceP2TIDs,1);assert.equal(summary.acceptanceP2Rate,'10.0%');
  }
  const secondDay=report.daily.rows.find(row=>row.date==='2026-10-27'&&row.groupId==='g06');
  assert.equal(secondDay.firstAcceptanceP2TIDs,0);assert.equal(secondDay.firstAcceptanceP2Rate,'');assert.equal(secondDay.acceptanceP2Rate,'100.0%');
  const exporter=createExporter(Flow,Reports,IO);
  const output=async kind=>{
    const value=exporter.generate({kind,groups,statusMeta:Flow.STATUS_META,eventLabels:{},scope:{profile:{role:'admin'},mode:'multi',groupId:'g06',range:'all'}},f.state);
    const parsed=IO.parseTable(await value.blob.text()),headers=parsed.records[0].cells;
    return parsed.records.slice(1).map(row=>Object.fromEntries(headers.map((key,index)=>[key,row.cells[index]])));
  };
  assert.equal((await output('acceptanceAccuracy')).filter(row=>row['验收瑕疵等级']==='P2').length,1);
  assert.equal((await output('groups'))[0]['P2改判率（P2/实际验收TID）'],'10.0%');
  const history=await output('acceptanceHistory');
  assert.equal(history.filter(row=>row['实际检查结果']==='P2瑕疵，实检合格').length,2);
  assert.equal(history.filter(row=>row['实际检查结果']==='P2瑕疵，实检合格'&&row['是否计入首次验收准确率']==='是').length,1);
  assert.equal(history.filter(row=>row['验收瑕疵等级']==='P2').length,2);
  assert.equal(history.filter(row=>row['P2实检记录（统计按TID去重）']==='是').length,2);
  const tasks=await output('tasks');assert.equal(tasks.filter(row=>row['首轮验收实际检查结果']==='P2瑕疵，实检合格').length,1);
  assert.equal(tasks.filter(row=>row['首轮验收瑕疵等级']==='P2').length,1);
  assert.equal(tasks.filter(row=>row['最近验收瑕疵等级']==='P2').length,1);
  assert.equal(tasks.filter(row=>row['是否首轮P2（原首轮口径）']==='是').length,1);
  assert.equal(JSON.stringify(f.state),before,'all metric and export operations leave source records unchanged');
  f.verdict('sample-8','pass',{at:day('27'),acceptanceRound:3});
  const laterTask=(await output('tasks')).find(row=>row.TID==='TID-sample-8');
  assert.equal(laterTask['首轮验收瑕疵等级'],'P2');assert.equal(laterTask['最近验收瑕疵等级'],'');
  assert.equal(laterTask['是否首轮P2（原首轮口径）'],'是','a later ordinary pass never erases the first P2 metric');
}

async function main() {
  checkMetric();checkExclusionsAndScope();await checkExports();
  console.log(JSON.stringify({ok:true,scenario:{ordinaryPass:8,p2Pass:1,fail:1,firstAccuracy:'90.0%',p2Rate:'10.0%'},checks:['single/multi parity','unchanged pass accuracy','first-round P2 freeze','uninspected/reject/reinspection exclusion','Beijing dates and group scopes','QC P2 separation','cached no-event scan','browser parity','task/event/group/movie/daily and worker exports','immutable sources']}));
}
module.exports={fixture};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
