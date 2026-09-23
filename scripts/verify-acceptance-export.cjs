'use strict';
process.env.TZ='UTC';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const Flow=require('../group-workbench/workflow.js'),Reports=require('../group-workbench/reports.js'),IO=require('../group-workbench/data-io.js');
const {createExporter}=require('../group-workbench/export-worker.js');
const directory=path.join(__dirname,'../group-workbench');
const groups=[{id:'g01',name:'单镜头1组',defaultMode:'single'},{id:'g02',name:'单镜头2组',defaultMode:'single'},{id:'g06',name:'多镜头1组',defaultMode:'multi'}];
const state={version:3,tasks:[],events:[],batches:[],preferences:{}};
let serial=0;
function addPending(id,groupId='g01',mode='single',movie='测试影片'){
  const task={id,tid:`TID-${id}`,movie,groupId,mode,date:'2000-01-01',createdAt:'2026-09-19T00:00:00Z'};state.tasks.push(task);
  event(id,'claim','2026-09-19T01:00:00Z',{actor:'原标注',actorRole:'annotation',assignee:'原标注'});
  event(id,'submit','2026-09-19T02:00:00Z',{actor:'原标注',actorRole:'annotation',assignee:'原标注',round:1,submissionKind:'initial'});
  event(id,'qc_pass','2026-09-19T03:00:00Z',{actor:'负责质检',actorRole:'qc',qcRound:1,note:'通过质检'});
  return task;
}
function event(taskId,type,at,details={}){const value={id:`event-${++serial}`,taskId,type,at,workflowVersion:3,actor:'负责验收',actorRole:'acceptance',...details};state.events.push(value);return value;}
for(let i=0;i<65;i++)addPending(`pending-${i}`,'g01','single',i===0?'=SUM(1,2)':'测试影片');
for(let i=0;i<3;i++)addPending(`group2-${i}`,'g02');
for(let i=0;i<2;i++)addPending(`multi-${i}`,'g06','multi');

addPending('accepted');const firstPass=event('accepted','acceptance_pass','2026-09-20T15:59:59Z',{actor:'=验收人员',note:' \t=HYPERLINK("example")\n带逗号,和换行'});
addPending('returned');const returned=event('returned','acceptance_fail','2026-09-20T16:00:00Z',{note:'仍待质检处理'});
addPending('reentered');const reentered=event('reentered','acceptance_fail','2026-09-20T16:05:00Z',{note:'第一次验收不通过'});
event('reentered','acceptance_route','2026-09-20T17:00:00Z',{actor:'负责质检',actorRole:'qc',route:'qc'});
event('reentered','qc_repair_done','2026-09-20T18:00:00Z',{actor:'负责质检',actorRole:'qc',note:'质检已自行修正'});

addPending('multi-round');const round1=event('multi-round','acceptance_fail','2026-09-20T16:10:00Z',{note:'第一轮打回'});
event('multi-round','acceptance_route','2026-09-20T17:10:00Z',{actor:'负责质检',actorRole:'qc',route:'qc'});
event('multi-round','qc_repair_done','2026-09-20T18:10:00Z',{actor:'负责质检',actorRole:'qc'});
const round2=event('multi-round','acceptance_fail','2026-09-21T15:59:59Z',{note:'第二轮打回'});
event('multi-round','acceptance_route','2026-09-21T16:00:00Z',{actor:'负责质检',actorRole:'qc',route:'qc'});
event('multi-round','qc_repair_done','2026-09-21T16:01:00Z',{actor:'负责质检',actorRole:'qc'});
const round3=event('multi-round','acceptance_pass','2026-09-21T16:02:00Z',{note:'第三轮通过，历史保留'});

addPending('legacy-reject');const legacyReject=event('legacy-reject','acceptance_fail','2026-09-20T16:20:00Z',{workflowVersion:2,note:'[验收拒绝] 原始旧记录'});
addPending('explicit-reject');const explicitReject=event('explicit-reject','acceptance_reject','2026-09-20T16:21:00Z',{note:'直接拒绝'});
addPending('group2-accepted','g02');const group2Pass=event('group2-accepted','acceptance_pass','2026-09-20T16:22:00Z');
addPending('multi-accepted','g06','multi');const multiPass=event('multi-accepted','acceptance_pass','2026-09-20T16:23:00Z');

addPending('deleted-pending');event('deleted-pending','task_deleted','2026-09-20T00:00:00Z',{actor:'admin',actorRole:'admin'});
addPending('deleted-history');const deletedPass=event('deleted-history','acceptance_pass','2026-09-20T16:24:00Z');
event('deleted-history','task_deleted','2026-09-21T00:00:00Z',{actor:'admin',actorRole:'admin'});
const afterDeletion=event('deleted-history','acceptance_fail','2026-09-21T01:00:00Z',{note:'删除后旧页面写入，必须排除'});

addPending('transfer-conflict');const transferFail=event('transfer-conflict','acceptance_fail','2026-09-20T16:25:00Z');
event('transfer-conflict','acceptance_route','2026-09-20T17:25:00Z',{actor:'负责质检',actorRole:'qc',route:'annotation'});
event('transfer-conflict','claim','2026-09-20T18:25:00Z',{actor:'负责质检',actorRole:'qc',assignmentKind:'rework_transfer',fromAssignee:'原标注',assignee:'接手标注',assignmentStatus:'acceptance_rework'});
const conflict=event('transfer-conflict','acceptance_pass','2026-09-20T19:25:00Z',{workflowVersion:2,round:1,note:'旧页越过返修，必须排除'});
event('transfer-conflict','submit','2026-09-20T20:25:00Z',{actor:'接手标注',actorRole:'annotation',assignee:'接手标注',round:2,submissionKind:'rework'});
event('transfer-conflict','qc_pass','2026-09-20T21:25:00Z',{actor:'负责质检',actorRole:'qc',qcRound:2});
event('transfer-conflict','metadata_edit','2026-09-20T22:25:00Z',{actor:'admin',actorRole:'admin',after:{tid:'TID-更正',movie:'更正影片'}});
const transferPass=event('transfer-conflict','acceptance_pass','2026-09-20T23:25:00Z',{note:'有效第二轮验收'});
event('transfer-conflict','metadata_edit','2026-09-21T00:25:00Z',{actor:'admin',actorRole:'admin',after:{tid:'TID-最新',movie:'最新影片'}});

const request=(kind,scope={})=>({kind,groups,statusMeta:Flow.STATUS_META,eventLabels:{},scope:{profile:{role:'acceptance',name:'负责验收',groupId:'g01'},mode:'single',groupId:'all',range:'all',dateFrom:'',dateTo:'',...scope}});
const original=JSON.stringify(state);
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value;}
freeze(state);
let projections=0;
const exporter=createExporter({...Flow,project(task,events){assert(events.every(item=>item.taskId===task.id),'projection must use only this task history');projections++;return Flow.project(task,events);}},Reports,IO);
async function decode(result){const bytes=Buffer.from(await result.blob.arrayBuffer()),text=bytes.toString('utf8');assert.equal(bytes.subarray(0,3).toString('hex'),'efbbbf','UTF-8 BOM');const parsed=IO.parseTable(text);assert(parsed.records.every(row=>!row.error));const headers=parsed.records[0].cells,rows=parsed.records.slice(1).map(row=>Object.fromEntries(headers.map((header,index)=>[header,row.cells[index]])));assert.equal(rows.length,result.rowCount);return {headers,rows,text};}
async function output(kind,scope={}){return decode(exporter.generate(request(kind,scope),state));}
async function protocol(kind){
  const messages=[],ctx={Blob,URL,location:{href:'https://isolated.test/group-workbench/export-worker.js',origin:'https://isolated.test'},postMessage:message=>messages.push(message)};ctx.self=ctx;vm.createContext(ctx);
  ctx.importScripts=url=>vm.runInContext(fs.readFileSync(path.join(directory,new URL(url).pathname.split('/').pop()),'utf8'),ctx);
  vm.runInContext(fs.readFileSync(path.join(directory,'export-worker.js'),'utf8'),ctx);
  ctx.onmessage({data:{type:'start',request:request(kind),dependencies:['workflow.js','data-io.js','reports.js'].map(file=>`https://isolated.test/group-workbench/${file}`),state:{version:3,preferences:{}}}});
  for(const collection of ['tasks','events','batches'])for(let i=0;i<state[collection].length;i+=17)ctx.onmessage({data:{type:'chunk',collection,rows:state[collection].slice(i,i+17)}});
  ctx.onmessage({data:{type:'generate'}});assert(!messages.some(message=>message.type==='error'));assert(messages.some(message=>message.type==='progress'));
  return decode(messages.find(message=>message.type==='complete'));
}
async function main(){
  const pending=await output('acceptancePending');assert.equal(pending.rows.length,69,'65+3 pending tasks plus one reentered task across all single groups');assert(pending.rows.length>50);
  assert.equal(new Set(pending.rows.map(row=>row.TID)).size,69);assert(!pending.rows.some(row=>/accepted|deleted|reject|returned|multi-round/.test(row.TID)));
  assert.equal(pending.rows.find(row=>row.TID==='TID-reentered')['验收轮次'],'2');assert.equal(pending.rows.find(row=>row.TID==='TID-reentered')['质检返修说明'],'质检已自行修正');
  assert.equal(pending.rows.find(row=>row.TID==='TID-pending-0')['影片 / 包'],"'=SUM(1,2)");
  assert.equal(pending.rows[0]['最近提交时间（北京时间）'],'2026-09-19 10:00:00');assert.equal(pending.rows[0]['质检人'],'负责质检');
  for(const scope of [{range:'scope',dateFrom:'2099-01-01',dateTo:'2099-01-02'},{range:'scope',dateFrom:'2099-01-02',dateTo:'2099-01-01',page:2,selectedIds:['pending-0']}])assert.equal((await output('acceptancePending',scope)).text,pending.text,'pending ignores dates, page, and selection');
  assert.equal((await output('acceptancePending',{groupId:'g01'})).rows.length,66);assert.equal((await output('acceptancePending',{mode:'multi'})).rows.length,2);
  assert.equal((await output('acceptancePending',{profile:{role:'qc',groupId:'g02'},groupId:'all'})).rows.length,3);assert.equal((await output('acceptancePending',{profile:{role:'annotation',groupId:'g01'},groupId:'g02'})).rows.length,0);
  const history=await output('acceptanceHistory'),byId=new Map(history.rows.map(row=>[row['事件ID'],row]));assert.equal(history.rows.length,12);
  for(const id of [firstPass.id,returned.id,reentered.id,round1.id,round2.id,round3.id,legacyReject.id,explicitReject.id,group2Pass.id,deletedPass.id,transferFail.id,transferPass.id])assert(byId.has(id),id);
  assert(!byId.has(conflict.id));assert(!byId.has(afterDeletion.id));assert(!byId.has(multiPass.id));
  assert.equal(byId.get(firstPass.id)['验收结果'],'通过');assert.equal(byId.get(returned.id)['验收结果'],'不通过');assert.equal(byId.get(legacyReject.id)['验收结果'],'拒绝');assert.equal(byId.get(explicitReject.id)['验收结果'],'拒绝');
  assert.equal(byId.get(firstPass.id)['验收人'],"'=验收人员");assert(byId.get(firstPass.id)['验收说明'].startsWith("' \t=HYPERLINK"));assert(byId.get(firstPass.id)['验收说明'].includes('\n带逗号,和换行'));
  assert.deepEqual([round1,round2,round3].map(row=>byId.get(row.id)['验收轮次']),['1','2','3'],'legacy missing round fields use the corresponding projection, not current final round');
  assert.equal(byId.get(transferFail.id)['验收时标注人'],'原标注');assert.equal(byId.get(transferPass.id)['验收时标注人'],'接手标注');assert.equal(byId.get(transferPass.id).TID,'TID-更正');assert.equal(byId.get(transferPass.id)['影片 / 包'],'更正影片');
  assert.equal(byId.get(deletedPass.id)['当前最新状态'],'已删除');assert.equal(byId.get(reentered.id)['当前最新状态'],'待第 2 次验收');
  assert.equal(byId.get(firstPass.id)['验收日期（北京时间）'],'2026-09-20');assert.equal(byId.get(returned.id)['验收日期（北京时间）'],'2026-09-21');
  const day20=await output('acceptanceHistory',{range:'scope',dateFrom:'2026-09-20',dateTo:'2026-09-20'});assert.deepEqual(day20.rows.map(row=>row['事件ID']),[firstPass.id]);
  const day21=await output('acceptanceHistory',{range:'scope',dateFrom:'2026-09-21',dateTo:'2026-09-21'});assert.equal(day21.rows.length,10);assert(day21.rows.some(row=>row['事件ID']===returned.id));assert(day21.rows.some(row=>row['事件ID']===round2.id));assert(!day21.rows.some(row=>row['事件ID']===round3.id));
  assert.equal((await output('acceptanceHistory',{range:'scope',dateFrom:'2026-09-20',dateTo:'2026-09-22'})).rows.length,12);assert.equal((await output('acceptanceHistory',{range:'all',dateFrom:'2099-01-01',dateTo:'2000-01-01'})).text,history.text);
  assert.throws(()=>exporter.generate(request('acceptanceHistory',{range:'scope',dateFrom:'2026-09-22',dateTo:'2026-09-21'}),state),/日期/);
  assert.equal((await output('acceptanceHistory',{groupId:'g02'})).rows.length,1);assert.equal((await output('acceptanceHistory',{profile:{role:'qc',groupId:'g02'},groupId:'all'})).rows.length,1);assert.equal((await output('acceptanceHistory',{profile:{role:'qc',groupId:'g01'},groupId:'g02'})).rows.length,0);assert.deepEqual((await output('acceptanceHistory',{mode:'multi'})).rows.map(row=>row['事件ID']),[multiPass.id]);
  for(const kind of ['acceptancePending','acceptanceHistory']){const empty=await output(kind,{groupId:'none'});assert.equal(empty.rows.length,0);assert(empty.headers.includes('TID'));assert(empty.headers.includes(kind==='acceptanceHistory'?'事件ID':'验收轮次'));assert.equal((await protocol(kind)).text,(await output(kind)).text,'Worker message protocol matches direct generator bytes');}
  process.env.TZ='America/Los_Angeles';assert.equal((await output('acceptanceHistory')).text,history.text,'Beijing date and time are independent of machine timezone');assert.equal((await output('acceptancePending')).text,pending.text);
  assert.equal(JSON.stringify(state),original,'all exports preserve every original record');
  console.log(JSON.stringify({ok:true,pendingRows:pending.rows.length,historyRows:history.rows.length,checks:['single/multi and role/group boundaries','69 pending tasks independent of pagination,selection,dates','reentry,3 verdict rounds and inferred legacy rounds','pass/fail/explicit reject and legacy rejection marker','Beijing midnight and inclusive actual-date filtering','historical owner and TID/movie before later edits','conflicts excluded after full-history projection','deleted-task valid verdict retained,post-delete verdict excluded','empty CSV headers,BOM and formula/multiline escaping','chunked Worker protocol unchanged','immutable source and task-local projections'],projections,sourceHash:crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,'export-worker.js'))).digest('hex')},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
