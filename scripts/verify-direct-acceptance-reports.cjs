'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const F=require('../group-workbench/workflow.js'),R=require('../group-workbench/reports.js');
const state={tasks:[],events:[],batches:[]};let serial=0;
function task(id,tail){const t={id,tid:id,movie:'测试影片',mode:'single',groupId:'g01',date:'2026-09-01',createdAt:'2026-09-01T00:00:00Z'};state.tasks.push(t);let time=0;for(const value of [{type:'dispatch'},{type:'claim',assignee:'测试标注'},{type:'submit'},{type:'package_built',stage:'qc',packageRound:1},{type:'package_claimed',stage:'qc',packageRound:1},{type:'qc_pass',qcRound:1},...tail])state.events.push({id:String(++serial),taskId:id,actor:'测试人员',workflowVersion:3,at:new Date(Date.UTC(2026,8,20,0,0,time++)).toISOString(),...value});return {...t,...F.project(t,state.events)};}
const accepted=task('PASS',[{type:'acceptance_pass',acceptanceRound:1}]);
const returned=task('RETURN',[{type:'acceptance_fail',note:'需要修改',acceptanceRound:1}]);
const rejected=task('REJECT',[{type:'acceptance_fail',note:'[验收拒绝] 无法继续',acceptanceRound:1}]);
const repaired=task('REPAIR',[{type:'acceptance_fail',note:'需要修改',acceptanceRound:1},{type:'acceptance_route',route:'qc'},{type:'qc_repair_done',note:'已修复'}]);
const historical=task('HISTORY',[{type:'package_built',stage:'acceptance',packageId:'old-package',packageName:'历史包',packageRound:1}]);
assert.equal(accepted.status,'accepted');assert.equal(returned.status,'acceptance_return_pending');assert.equal(rejected.status,'rejected');assert.equal(rejected.finalRejectStage,'acceptance');assert.equal(repaired.status,'pending_acceptance');assert.equal(repaired.acceptanceRound,2);assert.equal(historical.status,'pending_acceptance');assert.equal(historical.acceptancePackageName,'历史包');
const tasks=[accepted,returned,rejected,repaired,historical],report=R.build({state,tasks,statusMeta:F.STATUS_META});
for(const [name,sheet] of Object.entries(report))assert.equal(new Set(sheet.columns.map(c=>c.key)).size,sheet.columns.length,`${name} columns must be unique`);
const sum=k=>report.daily.rows.reduce((s,r)=>s+r[k],0);
assert.equal(sum('acceptanceFailActions'),2);assert.equal(sum('acceptanceRejectedTIDs'),1);assert.equal(sum('rejectedTIDs'),1);assert.equal(sum('completedTIDs'),1);assert.equal(sum('qcSelfRepairActions'),1);
assert.equal(report.events.rows.length,state.events.length);assert.equal(report.tasks.rows.length,5);assert.equal(report.movies.rows[0].closedTIDs,2);assert.equal(report.movies.rows[0].activeTIDs,3);
assert.equal(report.tasks.rows.find(r=>r.tid==='REJECT').finalRejectReason,'无法继续');
const output={ok:true,exportsPreserved:true,checks:['three distinct states','repair round 2','legacy acceptance package included','fail and reject separate daily counts','all history export preserved','closure keeps active return tasks'],events:state.events.length};
if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(output,null,2));console.log(JSON.stringify(output));
