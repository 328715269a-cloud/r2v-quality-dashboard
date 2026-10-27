'use strict';
// Isolated synthetic histories. This test never reads or mutates production.
process.env.TZ='UTC';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Reports=require('../group-workbench/reports.js'),Flow=require('../group-workbench/workflow.js'),IO=require('../group-workbench/data-io.js');
const {createExporter}=require('../group-workbench/export-worker.js');
const {fixture}=require('./verify-acceptance-p2-reports.cjs');
const day=n=>`2026-10-${n}T09:00:00+08:00`,range=n=>({dateFrom:`2026-10-${n}`,dateTo:`2026-10-${n}`}),p2={acceptanceIssueLevel:'P2'};
const metric=(f,scope={})=>Reports.acceptanceP2({...f.input(),...scope});
const numbers=({total,p2Count,rate})=>({total,p2Count,rate});
const expected=(total,p2Count)=>({total,p2Count,rate:total?p2Count/total*100:null});
function repair(f,id,at=day('27')) {
  f.addEvent(id,'acceptance_route',{at,actor:'质检员',actorRole:'qc',route:'qc'});
  f.addEvent(id,'qc_repair_done',{at,actor:'质检员',actorRole:'qc'});
}

function checks() {
  for(const mode of ['single','multi']) {
    const f=fixture(mode);f.addTask('repaired');f.verdict('repaired','fail');
    const firstBefore=Reports.acceptanceAccuracy(f.input());
    repair(f,'repaired');f.verdict('repaired','pass',{at:day('27'),acceptanceRound:2,...p2});
    f.verdict('repaired','pass',{at:day('27'),acceptanceRound:3,...p2});
    assert.deepEqual(numbers(metric(f)),expected(1,1),'first fail + repeated reinspection P2 = denominator 1 and numerator 1');
    assert.deepEqual(numbers(metric(f,range('26'))),expected(1,0));
    assert.deepEqual(numbers(metric(f,range('27'))),expected(1,1));
    assert.deepEqual(numbers(metric(f,{dateFrom:'2026-10-26',dateTo:'2026-10-27'})),expected(1,1),'range is not sum of the two days');
    assert.deepEqual(Reports.acceptanceAccuracy(f.input()),firstBefore,'P2 denominator change cannot rewrite any first-accuracy field');
    const row=metric(f).rows[0];assert.equal(row.inspections.length,3);assert.equal(row.p2EventIds.length,2);assert.equal(row.isP2,true);
    assert.deepEqual(row.actualDates,['2026-10-26','2026-10-27']);assert.deepEqual(row.p2Dates,['2026-10-27']);

    f.addTask('unsampled');f.addEvent('unsampled','acceptance_fail',{acceptanceInspection:'uninspected',acceptanceRound:1,acceptanceBatchId:'batch'});
    repair(f,'unsampled');f.verdict('unsampled','pass',{at:day('27'),acceptanceRound:2,...p2});
    assert.deepEqual(numbers(metric(f)),expected(2,2),'later actual P2 is counted even when the first disposition was unsampled');
    assert.equal(Reports.acceptanceAccuracy(f.input()).total,1,'unsampled first round still never enters first accuracy');

    f.addTask('ordinary');f.verdict('ordinary','pass');
    f.addTask('legacy-pass');f.addEvent('legacy-pass','acceptance_pass',{note:'历史普通判定，提到P2也不是P2'});
    f.addTask('legacy-fail');f.addEvent('legacy-fail','acceptance_fail',{note:'历史普通不合格'});
    f.addTask('uninspected-pass');f.verdict('uninspected-pass','uninspected',{acceptanceBatchId:'batch'});
    f.addTask('reject');f.addEvent('reject','acceptance_reject');
    f.addTask('legacy-reject');f.addEvent('legacy-reject','acceptance_fail',{note:'[验收拒绝] 无法处理'});
    f.addTask('qc-p2');f.addEvent('qc-p2','qc_fail',{actorRole:'qc',pLevel:'P2'});
    assert.deepEqual(numbers(metric(f)),expected(5,2),'all actual outcomes enter the denominator; unsampled, rejection and QC P2 do not');

    // Distinct imported records carrying the same TID remain one metric item.
    f.addTask('duplicate',{tid:'TID-repaired'});f.verdict('duplicate','pass',{...p2});
    f.addTask('duplicate-case',{tid:' tid-REPAIRED '});f.verdict('duplicate-case','pass',{...p2});
    assert.deepEqual(numbers(metric(f)),expected(5,2));
    assert.equal(metric(f).rows.find(item=>item.tid==='TID-repaired').taskIds.length,3,'canonical matching ignores TID case and whitespace without changing its displayed original');
    const duplicateDay=Reports.build({...f.input(),kind:'daily'}).daily.rows.find(row=>row.date==='2026-10-26');
    assert.equal(duplicateDay.actualAcceptanceTIDs,4);assert.equal(duplicateDay.acceptanceP2TIDs,1,'same TID casing cannot inflate the daily numerator');
    const all=metric(f),contributions=new Map(f.projected().map(task=>[task.id,Reports.annotationContributors(f.history(task.id))]));let calls=0;
    const input={tasks:f.projected(),mode,contributionForTask:task=>{calls++;return contributions.get(task.id);}};
    Object.defineProperty(input,'events',{get(){throw Error('cached P2 must not read global events');}});
    Object.defineProperty(input,'state',{get(){throw Error('cached P2 must not read global state');}});
    assert.deepEqual(Reports.acceptanceP2(input),all);assert.equal(calls,f.projected().length);
    assert.deepEqual(Reports.acceptanceP2({...input,includeRows:false}),{...numbers(all),rows:[]},'count-only card path matches the full denominator without building detail rows');
    assert.deepEqual(numbers(metric(f,{dateFrom:'2026-10-28',dateTo:'2026-10-27'})),expected(0,0));
    assert.deepEqual(numbers(metric(f,range('29'))),expected(0,0));
    const browser={window:{WorkbenchFlow:Flow}};vm.runInNewContext(fs.readFileSync(require.resolve('../group-workbench/reports.js'),'utf8'),browser);
    assert.deepEqual(JSON.parse(JSON.stringify(browser.window.WorkbenchReports.acceptanceP2(f.input()))),all);
  }
}

function exclusionsAndScope() {
  const f=fixture();
  f.addTask('release');f.verdict('release','pass',p2);f.addEvent('release','admin_release',{at:day('27'),actorRole:'admin'});
  f.addEvent('release','claim',{at:day('27'),actorRole:'annotation',actor:'新标注',assignee:'新标注'});
  f.addEvent('release','submit',{at:day('27'),actorRole:'annotation',actor:'新标注',submissionKind:'initial'});
  f.addEvent('release','qc_pass',{at:day('27'),actorRole:'qc'});f.verdict('release','pass',{at:day('27')});
  f.addTask('deleted');f.verdict('deleted','pass',p2);f.addEvent('deleted','task_deleted',{actorRole:'admin'});
  f.addTask('before-midnight');f.verdict('before-midnight','pass',{at:'2026-10-26T15:59:59.999Z',...p2});
  f.addTask('after-midnight',{groupId:'g07'});f.verdict('after-midnight','pass',{at:'2026-10-26T16:00:00.000Z',...p2});
  f.addTask('single',{mode:'single',groupId:'g01',tid:'TID-before-midnight'});f.verdict('single','pass',p2);
  assert.deepEqual(numbers(metric(f,range('26'))),expected(1,1));
  assert.deepEqual(numbers(metric(f,range('27'))),expected(2,1));
  assert.deepEqual(numbers(metric(f,{groupId:'g06'})),expected(2,1));
  assert.deepEqual(numbers(metric(f,{groupId:'g07'})),expected(1,1));
  assert.deepEqual(numbers(metric(f,{mode:'single'})),expected(1,1));
  assert.deepEqual(numbers(metric(f,{mode:''})),expected(4,3),'the same textual TID in two modes stays separate');
  assert.equal(metric(f).rows.find(row=>row.tid==='TID-release').name,'新标注');
  const firstRelease=f.history('release').find(event=>event.acceptanceIssueLevel==='P2');
  assert(!metric(f).rows.flatMap(row=>row.eventIds).includes(firstRelease.id));
  const report=Reports.build(f.input());
  assert.equal(report.events.rows.find(row=>row.eventId===firstRelease.id).acceptanceP2Included,false);
  assert.match(report.events.rows.find(row=>row.eventId===firstRelease.id).acceptanceActualReason,/释放/);
  assert.equal(report.events.rows.find(row=>row.taskId==='deleted'&&row.acceptanceIssueLevel==='P2').acceptanceP2Included,false);
  const scoped=Reports.build(f.input({...range('26'),kind:'events'})).events;
  assert.equal(scoped.rows.find(row=>row.taskId==='after-midnight'&&row.acceptanceIssueLevel==='P2').acceptanceP2Included,false);
  const conflict=fixture();conflict.addTask('conflict');conflict.verdict('conflict','fail');
  conflict.addEvent('conflict','acceptance_route',{at:day('27'),actorRole:'qc',route:'annotation'});
  conflict.addEvent('conflict','claim',{at:day('27'),actorRole:'qc',assignmentKind:'rework_transfer',fromAssignee:'初标人',assignee:'代修人',assignmentStatus:'acceptance_rework',workflowVersion:4});
  conflict.addEvent('conflict','submit',{at:day('27'),actorRole:'annotation',actor:'初标人',assignee:'初标人',submissionKind:'rework'});
  const staleP2=conflict.verdict('conflict','pass',{at:day('27'),acceptanceRound:2,round:1,workflowVersion:1,...p2});
  conflict.addEvent('conflict','submit',{at:day('27'),actorRole:'annotation',actor:'代修人',assignee:'代修人',submissionKind:'rework'});
  conflict.addEvent('conflict','qc_pass',{at:day('27'),actorRole:'qc'});conflict.verdict('conflict','pass',{at:day('27'),acceptanceRound:2});
  assert(Flow.eventConflicts(conflict.state.events).some(row=>row.eventId===staleP2.id));
  assert.deepEqual(numbers(metric(conflict)),expected(1,0),'stale P2 from before assignment cannot enter the numerator');
  const conflictRow=Reports.build(conflict.input()).events.rows.find(row=>row.eventId===staleP2.id);
  assert.equal(conflictRow.acceptanceP2Included,false);assert.match(conflictRow.acceptanceActualReason,/冲突/);
  for(const extra of [{at:'bad-date'},{acceptanceRound:0},{acceptanceRound:'1'},{acceptanceRound:undefined},{acceptanceInspection:'bad'}]) {
    assert.equal(Reports.actualAcceptanceAssessment({type:'acceptance_pass',at:day('26'),acceptanceRound:1,acceptanceInspection:'pass',...p2,...extra}).included,false);
  }
  return f;
}

async function exports() {
  const f=fixture();f.addTask('repaired');f.verdict('repaired','fail');repair(f,'repaired');f.verdict('repaired','pass',{at:day('27'),acceptanceRound:2,...p2});
  f.verdict('repaired','pass',{at:day('27'),acceptanceRound:3,...p2});
  const before=JSON.stringify(f.state),input=f.input(),report=Reports.build(input),worker=createExporter(Flow,Reports,IO);
  const group=report.groups.rows.find(row=>row.groupId==='g06');
  assert.equal(group.firstAcceptanceAccuracy,'0.0%');assert.equal(group.firstAcceptanceP2TIDs,0);assert.equal(group.firstAcceptanceP2Rate,'0.0%');
  assert.equal(group.actualAcceptanceTIDs,1);assert.equal(group.acceptanceP2TIDs,1);assert.equal(group.acceptanceP2Rate,'100.0%');
  assert.equal(report.movies.rows[0].acceptanceP2Rate,'100.0%');
  for(const [date,num] of [['2026-10-26',0],['2026-10-27',1]]) {const row=report.daily.rows.find(row=>row.date===date);assert.equal(row.actualAcceptanceTIDs,1);assert.equal(row.acceptanceP2TIDs,num);}
  const get=async(kind,scope={})=>{
    const result=worker.generate({kind,groups:input.groups,statusMeta:Flow.STATUS_META,eventLabels:{},scope:{profile:{role:'admin'},mode:'multi',groupId:'g06',range:'all',...scope}},f.state);
    const parsed=IO.parseTable(await result.blob.text()),headers=parsed.records[0].cells;
    return parsed.records.slice(1).map(row=>Object.fromEntries(headers.map((key,index)=>[key,row.cells[index]])));
  };
  for(const scope of [{},{range:'scope',dateFrom:'2026-10-26',dateTo:'2026-10-27'},{range:'scope',...range('27')}]) {
    const rows=await get('acceptanceP2',scope);assert.equal(rows.length,1);assert.equal(rows[0]['是否发生P2'],'是');
    assert.equal((await get('groups',scope))[0]['P2改判率（P2/实际验收TID）'],'100.0%');
  }
  assert.equal((await get('acceptanceP2',{range:'scope',...range('26')}))[0]['是否发生P2'],'否');
  assert.equal((await get('acceptanceP2',{range:'scope',...range('28')})).length,0);
  assert.equal((await get('acceptanceP2',{mode:'single',groupId:'all'})).length,0);
  assert.equal((await get('acceptanceP2',{profile:{role:'qc',groupId:'g07'},groupId:'all'})).length,0);
  const history=await get('acceptanceHistory');assert.equal(history.filter(row=>row['P2实检记录（统计按TID去重）']==='是').length,2);
  assert.equal(history.filter(row=>row['计入实际验收范围（含复验）']==='是').length,3);
  assert.equal(history.filter(row=>row['是否计入首次验收准确率']==='是').length,1);
  assert.equal((await get('tasks'))[0]['是否首轮P2（原首轮口径）'],'否');
  assert.equal((await get('tasks'))[0]['所选范围有P2（按TID去重）'],'是');
  assert.equal(JSON.stringify(f.state),before);
  const badRequest={kind:'acceptanceP2',groups:input.groups,statusMeta:Flow.STATUS_META,eventLabels:{},scope:{profile:{role:'admin'},mode:'multi',groupId:'all',range:'scope',dateFrom:'2026-10-28',dateTo:'2026-10-26'}};
  assert.throws(()=>worker.generate(badRequest,f.state),/日期/);
}
async function main(){checks();exclusionsAndScope();await exports();console.log(JSON.stringify({ok:true,scenario:{firstFailureThenP2:{total:1,p2Count:1,rate:100},firstAccuracyUnchanged:0},checks:['all actual rounds','TID cross-day dedup','unsampled first then actual','legacy ordinary decisions','reject/unsampled/QC P2 exclusion','released/deleted/invalid exclusions','Beijing midnight','mode/group isolation','cached no-global scan','browser parity','task/event/history/group/movie/daily/detail exports','immutable source']}));}
main().catch(error=>{console.error(error);process.exitCode=1;});
