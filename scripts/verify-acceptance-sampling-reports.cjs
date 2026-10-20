'use strict';
// Offline contract test. No service, credentials, production data or writes.
process.env.TZ = 'UTC';
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const Flow = require('../group-workbench/workflow.js');
const Reports = require('../group-workbench/reports.js');
const IO = require('../group-workbench/data-io.js');
const {createExporter} = require('../group-workbench/export-worker.js');
const groups = [{id:'g01',name:'一组',defaultMode:'single'},{id:'g02',name:'二组',defaultMode:'single'},{id:'g06',name:'多镜头组',defaultMode:'multi'}];
const state = {tasks:[],events:[],batches:[]};
let serial = 0;
const at = day => `2026-10-${day}T09:00:00+08:00`;
function event(taskId,type,details={}) {
  const value = {id:`event-${++serial}`,taskId,type,at:at('20'),actor:'验收员',actorRole:'acceptance',workflowVersion:3,...details};
  state.events.push(value); return value;
}
function task(id,{groupId='g01',mode='single',owner='初标甲'}={}) {
  const value={id,tid:`TID-${id}`,movie:'抽检示例',groupId,mode,date:'2026-09-01',createdAt:at('19')};
  state.tasks.push(value);
  event(id,'claim',{at:at('19'),actor:owner,actorRole:'annotation',assignee:owner});
  event(id,'submit',{at:at('19'),actor:owner,actorRole:'annotation',submissionKind:'initial'});
  event(id,'qc_pass',{at:at('19'),actor:'质检员',actorRole:'qc'});
  return value;
}
function verdict(id,inspection,type='acceptance_fail',details={}) {
  return event(id,type,{acceptanceRound:1,acceptanceInspection:inspection,acceptanceBatchId:'sample-batch',...details});
}
const history = id => state.events.filter(item=>item.taskId===id);
const tasks = () => state.tasks.map(item=>({...item,...Flow.project(item,history(item.id))}));
const metric = (scope={}) => Reports.acceptanceAccuracy({tasks:tasks(),state,...scope});
const counts = value => ({passed:value.passed,total:value.total,rate:value.rate});
const expected = (passed,total) => ({passed,total,rate:total?passed/total*100:null});
const day20={dateFrom:'2026-10-20',dateTo:'2026-10-20'};
const day21={dateFrom:'2026-10-21',dateTo:'2026-10-21'};
const input = () => ({state,tasks:tasks(),groups,statusMeta:Flow.STATUS_META,groupLabel:id=>groups.find(g=>g.id===id)?.name||id,localDate:Reports.acceptanceDate});
const sum = (rows,key) => rows.reduce((total,row)=>total+row[key],0);
const firstIds=[];
for(let index=0;index<100;index++) {
  const id=`sample-${index}`;task(id);
  firstIds.push(verdict(id,index<8?'pass':index<10?'fail':'uninspected').id);
}
assert.deepEqual(counts(metric()),expected(8,10),'100 returned, 10 sampled, 8 good: 80%, never 2% or 8%');
assert(tasks().every(item=>item.status==='acceptance_return_pending'),'all 100 tasks really return');
const firstReports=Reports.build(input());
assert.equal(sum(firstReports.daily.rows,'acceptanceFailActions'),100,'flow remains 100 returns');
assert.equal(sum(firstReports.daily.rows,'acceptanceInspectedPassActions'),8);
assert.equal(sum(firstReports.daily.rows,'acceptanceInspectedFailActions'),2,'only two actual defects');
assert.equal(sum(firstReports.daily.rows,'acceptanceBatchReturnActions'),98,'8 good plus 90 uninspected travel back');
assert.equal(sum(firstReports.daily.rows,'completedTIDs'),0);
assert.equal(firstReports.groups.rows.find(row=>row.groupId==='g01').firstAcceptanceAccuracy,'80.0%');
assert.equal(firstReports.movies.rows[0].firstAcceptanceAccuracy,'80.0%');

// Reinspect all 100 the next day. None of the 90 unsampled first rounds enters
// the first-round denominator; the first 8 passes and 2 failures stay frozen.
for(let index=0;index<100;index++) {
  const id=`sample-${index}`;
  event(id,'acceptance_route',{at:at('21'),actorRole:'qc',route:'qc'});
  event(id,'qc_repair_done',{at:at('21'),actorRole:'qc'});
  verdict(id,'pass','acceptance_pass',{at:at('21'),acceptanceRound:2,acceptanceBatchId:'reinspection'});
}
assert(tasks().every(item=>item.status==='accepted'));
assert.deepEqual(counts(metric()),expected(8,10));
assert.deepEqual(counts(metric(day20)),expected(8,10));
assert.deepEqual(counts(metric(day21)),expected(0,0),'filter only after identifying first round from full history');
assert.equal(Reports.annotationContributors(history('sample-50')).firstAcceptance.eventId,history('sample-50').at(-1).id,'real completion still follows the first pass');
const repaired=Reports.build(input());
assert.equal(sum(repaired.daily.rows,'completedTIDs'),100);
assert.equal(repaired.groups.rows.find(row=>row.groupId==='g01').acceptedTIDs,100);
assert.equal(repaired.groups.rows.find(row=>row.groupId==='g01').acceptancePassTIDs,100,'existing export pass-volume columns are populated from the same daily model');
assert.equal(repaired.groups.rows.find(row=>row.groupId==='g01').qcPassTIDs,100);
assert.equal(sum(repaired.daily.rows,'firstAcceptanceInspectedTIDs'),10);
assert.equal(sum(repaired.daily.rows,'firstAcceptancePassedTIDs'),8);
assert.equal(sum(repaired.daily.rows,'acceptanceInspectedPassActions'),108,'all-round inspection flow stays separate');
assert.equal(Reports.build({...input(),kind:'groups',...day21}).groups.rows.find(row=>row.groupId==='g01').firstAcceptanceInspectedTIDs,0);

// Historical records retain their original metric, including existing round
// fields. Never infer inspection from free text or the selection size.
task('legacy',{groupId:'g02'});
const legacy=event('legacy','acceptance_fail',{acceptanceRound:2,note:'过去记录写过随批退回字样，不能重解释'});
verdict('legacy','pass','acceptance_pass',{at:at('21'),acceptanceRound:3});
assert.deepEqual(Reports.annotationContributors(history('legacy')).firstAcceptanceDecision,
  {name:'初标甲',rawName:'初标甲',at:legacy.at,eventId:legacy.id,type:'acceptance_fail'});
assert.deepEqual(counts(metric({groupId:'g02'})),expected(0,1));
task('marked-round2',{groupId:'g02'});verdict('marked-round2','pass','acceptance_pass',{acceptanceRound:2});
task('reject',{groupId:'g02'});event('reject','acceptance_fail',{note:'[验收拒绝] 无法继续'});
verdict('reject','pass','acceptance_pass',{at:at('21'),acceptanceRound:2});
task('explicit-reject',{groupId:'g02'});event('explicit-reject','acceptance_reject',{note:'无法继续'});
task('invalid-date',{groupId:'g02'});verdict('invalid-date','pass','acceptance_pass',{at:'invalid'});
verdict('invalid-date','pass','acceptance_pass',{at:at('21'),acceptanceRound:2});
task('missing-round',{groupId:'g02'});verdict('missing-round','pass','acceptance_pass',{acceptanceRound:undefined});
task('noncanonical-round',{groupId:'g02'});verdict('noncanonical-round','pass','acceptance_pass',{acceptanceRound:'1'});
assert.deepEqual(counts(metric({groupId:'g02'})),expected(0,1),'reject, missing canonical first round, invalid first date do not promote later passes');

task('released',{groupId:'g02'});verdict('released','fail');
event('released','admin_release',{at:at('21'),actor:'管理员',actorRole:'admin'});
event('released','claim',{at:at('21'),actor:'新标注',actorRole:'annotation',assignee:'新标注'});
event('released','submit',{at:at('21'),actor:'新标注',actorRole:'annotation',submissionKind:'initial'});
event('released','qc_pass',{at:at('21'),actorRole:'qc'});
const restarted=verdict('released','pass','acceptance_pass',{at:at('21')});
assert.equal(metric({groupId:'g02',...day21}).rows.find(row=>row.taskId==='released').name,'新标注');
assert.equal(metric({groupId:'g02',...day21}).rows.find(row=>row.taskId==='released').eventId,restarted.id);
task('transferred',{groupId:'g02'});verdict('transferred','fail');
event('transferred','admin_reassign',{at:at('21'),actor:'管理员',actorRole:'admin',toRole:'annotation',assignee:'接手者'});
event('transferred','submit',{at:at('21'),actor:'接手者',actorRole:'annotation',assignee:'接手者'});
event('transferred','qc_pass',{at:at('21'),actorRole:'qc'});
verdict('transferred','pass','acceptance_pass',{at:at('21'),acceptanceRound:2});
assert.equal(metric({groupId:'g02'}).rows.find(row=>row.taskId==='transferred').name,'初标甲','later transfers cannot move first-round accountability');
task('deleted',{groupId:'g02'});verdict('deleted','pass','acceptance_pass');
event('deleted','task_deleted',{at:at('21'),actorRole:'admin'});
assert(!metric().rows.some(row=>row.taskId==='deleted'));
task('multi-pass',{groupId:'g06',mode:'multi'});verdict('multi-pass','pass');
task('multi-batch',{groupId:'g06',mode:'multi'});verdict('multi-batch','uninspected','acceptance_pass');
assert.deepEqual(counts(metric({mode:'multi'})),expected(1,1));
assert.equal(tasks().find(row=>row.id==='multi-batch').status,'accepted','batch release still completes task');

task('midnight-before',{groupId:'g02'});verdict('midnight-before','pass','acceptance_pass',{at:'2026-10-20T15:59:59.999Z'});
task('midnight-after',{groupId:'g02'});verdict('midnight-after','fail','acceptance_fail',{at:'2026-10-20T16:00:00.000Z'});
assert(metric(day20).rows.some(row=>row.taskId==='midnight-before'));
assert(!metric(day20).rows.some(row=>row.taskId==='midnight-after'));
assert(metric(day21).rows.some(row=>row.taskId==='midnight-after'));
assert.deepEqual(counts(metric({dateFrom:'2026-10-22',dateTo:'2026-10-20'})),expected(0,0));
const all=metric(),byPerson=new Map();
all.rows.forEach(row=>{const key=JSON.stringify([row.groupId,row.name]);if(!byPerson.has(key))byPerson.set(key,{passed:0,total:0});const value=byPerson.get(key);value.total++;if(row.passed)value.passed++;});
assert.equal(sum([...byPerson.values()],'total'),all.total);
assert.equal(sum([...byPerson.values()],'passed'),all.passed);
assert.equal(groups.reduce((n,group)=>n+metric({groupId:group.id}).total,0),all.total);
assert.equal(['single','multi'].reduce((n,mode)=>n+metric({mode}).passed,0),all.passed);
const projected=tasks(),byTask=new Map(projected.map(row=>[row.id,Reports.annotationContributors(history(row.id))]));
assert.deepEqual(Reports.acceptanceAccuracy({tasks:projected,contributionForTask:row=>byTask.get(row.id)}),all,'cached UI and event-based export share exactly one contract');
const original=JSON.stringify(state);
const exporter=createExporter(Flow,Reports,IO);
async function output(kind,scope={}) {
  const result=exporter.generate({kind,groups,statusMeta:Flow.STATUS_META,eventLabels:{},scope:{profile:{role:'admin'},mode:'single',groupId:'g01',range:'all',dateFrom:'',dateTo:'',...scope}},state);
  const parsed=IO.parseTable(await result.blob.text()),headers=parsed.records[0].cells;
  const rows=parsed.records.slice(1).map(row=>Object.fromEntries(headers.map((header,index)=>[header,row.cells[index]])));
  assert.equal(rows.length,result.rowCount);return {headers,rows};
}
async function main() {
  const accuracy=await output('acceptanceAccuracy',{range:'scope',...day20});
  assert.equal(accuracy.rows.length,10);
  assert.equal(accuracy.rows.filter(row=>row['实际检查结果']==='实检合格').length,8);
  assert(accuracy.rows.every(row=>firstIds.includes(row['首验事件ID'])),'export drill rows are precisely the original denominator');
  assert.equal((await output('acceptanceAccuracy',{range:'scope',...day21})).rows.length,0);
  const histories=await output('acceptanceHistory',{range:'scope',...day20});
  assert.equal(histories.rows.length,100);
  assert.equal(histories.rows.filter(row=>row['是否计入首次验收准确率']==='是').length,10);
  assert.equal(histories.rows.filter(row=>row['实际检查结果']==='实检不合格').length,2);
  assert.equal(histories.rows.filter(row=>row['任务处置方式']==='随批退回质检').length,98);
  assert(histories.rows.every(row=>row['验收批次ID']==='sample-batch'));
  assert((await output('acceptanceHistory',{range:'scope',...day21})).rows.every(row=>row['是否计入首次验收准确率']==='否'));
  const groupExport=await output('groups',{range:'scope',...day20});
  assert.equal(groupExport.rows[0]['首次验收准确率'],'80.0%','aggregate export is not erased by the generic row.date filter');
  const taskExport=await output('tasks');
  assert.deepEqual(taskExport.headers.slice(0,10),['TID','影片 / 包','小组','类型','标注人','组长 / 质检操作人','轮次','当前状态','首次质检','最后更新（北京时间）'],'preserve prod69 task export fields and order');
  assert.equal(taskExport.rows.filter(row=>row['是否计入首次验收准确率']==='是').length,10);
  const isolated=await output('acceptanceAccuracy',{mode:'multi',groupId:'all'});
  assert.equal(isolated.rows.length,1);
  assert.equal(isolated.rows[0].TID,'TID-multi-pass');
  const restricted=await output('acceptanceAccuracy',{profile:{role:'qc',groupId:'g02'},groupId:'all'});
  assert(restricted.rows.every(row=>row['小组']==='二组'),'export preserves caller group visibility');
  const browser={window:{WorkbenchFlow:Flow}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../group-workbench/reports.js'),'utf8'),browser);
  assert.deepEqual(JSON.parse(JSON.stringify(browser.window.WorkbenchReports.acceptanceAccuracy({tasks:tasks(),state}))),metric());
  assert.equal(JSON.stringify(state),original,'all reporting and exports are read-only');
  console.log(JSON.stringify({ok:true,scenario:{returned:100,inspected:10,passed:8,failed:2,accuracy:'80.0%',reinspectionCompleted:100},checks:['first-round freeze','uninspected never promoted','legacy compatibility','rejection and release','ownership','Beijing dates','group person mode parity','flow and defect separation','history and denominator exports','production task columns','visibility and immutability']}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
