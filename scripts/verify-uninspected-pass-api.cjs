'use strict';

// Synthetic HTTP and report checks only. No production endpoint, data or secret.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {randomUUID,createHash}=require('node:crypto');
const {createService,API}=require('../workbench-api/server.cjs');
const {snapshot,MODES}=require('../workbench-api/rules.cjs');
const Flow=require('../group-workbench/workflow.js');
const Reports=require('../group-workbench/reports.js');
const groupPin='isolated-uninspected-pass-pin',adminPin='isolated-uninspected-pass-admin';
const groupIds=['g01','g02','s06','g06','g07','m12'];
const event=(task,type,fields={})=>({id:randomUUID(),taskId:task.id,type,...fields});
const profile=(role,groupId,name)=>({role,groupId,mode:MODES[groupId],name:name||{annotation:'验证标注',qc:'验证质检',acceptance:'验证验收'}[role]});

async function main(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'r2v-uninspected-pass-'));
  const service=createService({directory,groupPin,adminPin,skipStartupBackup:true,backupIntervalMs:0});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const port=service.server.address().port,proofs=[],groups={};
  function call(endpoint,{token,body,status=200}={}){
    return new Promise((resolve,reject)=>{
      const serialized=body===undefined?null:JSON.stringify(body);
      const request=http.request({host:'127.0.0.1',port,path:API+endpoint,method:serialized?'POST':'GET',headers:{...(token?{'X-Workbench-Session':token}:{}),...(serialized?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(serialized)}:{})}},response=>{
        let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>{
          try{const value=JSON.parse(text);if(status!==null)assert.equal(response.statusCode,status,JSON.stringify(value));resolve({status:response.statusCode,value});}catch(error){reject(error);}
        });
      });
      request.setTimeout(15000,()=>request.destroy(new Error('Isolated HTTP request timed out')));
      request.on('error',reject);request.end(serialized);
    });
  }
  const data=async(endpoint,options)=>(await call(endpoint,options)).value;
  const login=(who,pin)=>data('session',{body:{profile:who,pin}});
  const view=task=>snapshot(service.state(),task.id);
  async function apply(session,events){
    const body={id:randomUUID(),revision:service.getRevision(),delta:{events}};
    return{body,result:await data('transactions',{token:session.token,body})};
  }
  async function rejectBatch(session,events,status,code){
    const before=service.exportBackup();
    const response=await data('transactions',{token:session.token,status,body:{id:randomUUID(),revision:before.revision,delta:{events}}});
    assert.equal(response.error.code,code);
    const after=service.exportBackup();
    assert.deepEqual(after.state,before.state,'Rejected batch must write no task or event');
    assert.deepEqual(after.transactions,before.transactions,'Rejected batch must leave no transaction');
    assert.equal(after.revision,before.revision);
  }
  function decision(task,batchId,extra={}){
    const current=view(task);
    return event(task,'acceptance_pass',{acceptanceBatchId:batchId,acceptanceInspection:'uninspected',acceptanceRound:current.acceptanceRound,expectedUpdatedAt:current.updatedAt,note:'未实检，随批通过（隔离验证）',...extra});
  }
  function report(){
    const state=service.state(),tasks=state.tasks.map(task=>view(task));
    const input={state,tasks,groups:groupIds.map(id=>({id,name:id,defaultMode:MODES[id]})),localDate:Reports.acceptanceDate};
    const quality=Reports.acceptanceAccuracy(input),output=Reports.build(input);
    const personal=new Map();
    // The same row aggregation used by app.renderPersonStats.
    quality.rows.forEach(row=>{const key=JSON.stringify([row.groupId,row.name]);if(!personal.has(key))personal.set(key,{total:0,passed:0});const person=personal.get(key);person.total++;if(row.passed)person.passed++;});
    return{quality,output,personal:[...personal],input};
  }
  function qualityFingerprint(report){
    return{passed:report.quality.passed,total:report.quality.total,rate:report.quality.rate,personal:report.personal,groups:report.output.groups.rows.map(row=>({groupId:row.groupId,total:row.firstAcceptanceInspectedTIDs,passed:row.firstAcceptancePassedTIDs,rate:row.firstAcceptanceAccuracy}))};
  }
  function checkTotals(expectedAccepted,expectedBatchPass){
    const current=report();
    assert.equal(current.output.groups.rows.reduce((sum,row)=>sum+row.acceptedTIDs,0),expectedAccepted);
    assert.equal(current.output.groups.rows.reduce((sum,row)=>sum+row.closedTIDs,0),expectedAccepted);
    assert.equal(current.output.groups.rows.reduce((sum,row)=>sum+row.acceptancePassTIDs,0),expectedAccepted);
    assert.equal(current.output.daily.rows.reduce((sum,row)=>sum+row.completedTIDs,0),expectedAccepted);
    assert.equal(current.output.daily.rows.reduce((sum,row)=>sum+row.acceptanceBatchPassActions,0),expectedBatchPass);
    assert.equal(current.output.daily.rows.reduce((sum,row)=>sum+row.firstAcceptanceInspectedTIDs,0),24);
    return current;
  }
  try{
    const health=await data('health');assert.deepEqual(health.capabilities.acceptanceInspection,{supported:true,version:1});
    const admin=await login({name:'admin',role:'admin'},adminPin);
    const reviewers={single:await login(profile('acceptance','g01'),groupPin),multi:await login(profile('acceptance','g06'),groupPin)};
    for(const groupId of groupIds){
      const annotation=await login(profile('annotation',groupId)),bypassAnnotation=await login(profile('annotation',groupId,'随批标注')),qc=await login(profile('qc',groupId),groupPin);
      const batch={id:randomUUID(),groupId,mode:MODES[groupId],date:'2031-01-02',movie:'随批通过隔离影片-'+groupId};
      const tasks=Array.from({length:8},(_,i)=>({id:randomUUID(),tid:'UNINSPECTED-'+groupId+'-'+i,batchId:batch.id,groupId,mode:batch.mode,date:batch.date,movie:batch.movie}));
      batch.taskIds=tasks.map(task=>task.id);
      const saved=await data('transactions',{token:admin.token,body:{id:randomUUID(),revision:service.getRevision(),delta:{tasks,batches:[batch],events:tasks.map(task=>event(task,'dispatch'))}}});
      groups[groupId]={annotation,bypassAnnotation,qc,tasks:saved.delta.tasks};
      await apply(annotation,tasks.filter((_,i)=>i!==4&&i!==5).flatMap(task=>[event(task,'claim'),event(task,'submit')]));
      await apply(bypassAnnotation,tasks.slice(4,6).flatMap(task=>[event(task,'claim'),event(task,'submit')]));
      await apply(qc,tasks.map(task=>event(task,'qc_pass')));
      tasks.forEach(task=>assert.equal(view(task).status,'pending_acceptance'));
      // Legacy requests omit both new fields; new ordinary inspections are explicit.
      await apply(reviewers[batch.mode],[event(tasks[0],'acceptance_pass'),event(tasks[1],'acceptance_fail',{note:'历史首验不合格'}),
        event(tasks[2],'acceptance_pass',{acceptanceInspection:'pass',expectedUpdatedAt:view(tasks[2]).updatedAt}),
        event(tasks[3],'acceptance_fail',{acceptanceInspection:'fail',expectedUpdatedAt:view(tasks[3]).updatedAt,note:'首轮实检不合格'})]);
    }
    const original=structuredClone(service.state()),baseline=checkTotals(12,0),fingerprint=qualityFingerprint(baseline);
    assert.deepEqual([baseline.quality.passed,baseline.quality.total,baseline.quality.rate],[12,24,50]);
    assert(baseline.output.groups.rows.every(row=>row.firstAcceptanceAccuracy==='50.0%'));
    const legacyIds=new Set(groupIds.flatMap(id=>groups[id].tasks.slice(0,2).map(task=>task.id)));
    const legacyEvents=original.events.filter(row=>legacyIds.has(row.taskId)&&['acceptance_pass','acceptance_fail'].includes(row.type));
    assert.equal(legacyEvents.length,12);assert(legacyEvents.every(row=>!Object.hasOwn(row,'acceptanceInspection')&&!Object.hasOwn(row,'acceptanceBatchId')));
    proofs.push('旧请求通过/不通过与显式普通实检保持原口径：六组各2合格/4实检，整体12/24=50%');

    const single=groupIds.filter(id=>MODES[id]==='single').map(id=>groups[id].tasks[4]);
    const multi=groupIds.filter(id=>MODES[id]==='multi').map(id=>groups[id].tasks[4]);
    for(const [mode,tasks]of Object.entries({single,multi})){
      const batchId=randomUUID(),before=service.getRevision(),saved=await apply(reviewers[mode],tasks.map(task=>decision(task,batchId)));
      assert.equal(saved.result.revision,before+1);assert.equal(saved.result.delta.events.length,3);
      assert(saved.result.delta.events.every(row=>row.acceptanceBatchId===batchId&&row.acceptanceInspection==='uninspected'&&row.type==='acceptance_pass'));
      tasks.forEach(task=>{assert.equal(view(task).status,'accepted');assert.equal(Flow.label(view(task)),'未实检 · 随批放行');});
    }
    assert.deepEqual(service.state().tasks,original.tasks,'Original group/import/ownership records must not change');
    const afterDirect=checkTotals(18,6);assert.deepEqual(qualityFingerprint(afterDirect),fingerprint);
    assert(!afterDirect.quality.rows.some(row=>row.name==='随批标注'),'Only-uninspected people must have no accuracy denominator');
    for(const groupId of groupIds){
      const scoped=await data('state?scope=role-v1',{token:groups[groupId].qc.token});
      assert(scoped.state.tasks.every(task=>task.groupId===groupId));
      assert.equal(snapshot(scoped.state,groups[groupId].tasks[4].id).status,'accepted');
      const own=Reports.acceptanceAccuracy({...afterDirect.input,groupId});assert.deepEqual([own.passed,own.total,own.rate],[2,4,50]);
    }
    proofs.push('单镜和多镜分别跨3组一次事务随批通过：通过量和闭环各增加6，原小组归属保留；个人/小组/整体首轮准确率完全不变');

    const pending=['g01','g02'].map(id=>groups[id].tasks[6]),multiPending=groups.g06.tasks[6];
    await rejectBatch(reviewers.single,pending.map(task=>decision(task,randomUUID())),400,'INVALID_TRANSACTION');
    await rejectBatch(reviewers.single,[decision(pending[0],'mixed'),decision(multiPending,'mixed')],403,'FORBIDDEN');
    await rejectBatch(reviewers.multi,[decision(multiPending,'mixed'),decision(pending[0],'mixed')],403,'FORBIDDEN');
    for(const who of [groups.g01.qc,groups.g01.annotation,admin])await rejectBatch(who,pending.map(task=>decision(task,'wrong-role')),403,'FORBIDDEN');
    const missingBatch=decision(pending[0],'unused');delete missingBatch.acceptanceBatchId;
    await rejectBatch(reviewers.single,[missingBatch],400,'INVALID_TRANSACTION');
    const missingExpected=decision(pending[0],'no-version');delete missingExpected.expectedUpdatedAt;
    await rejectBatch(reviewers.single,[missingExpected],409,'STATE_CONFLICT');
    await rejectBatch(reviewers.single,[decision(pending[0],'invalid-fail',{acceptanceInspection:'fail'})],400,'INVALID_TRANSACTION');
    await rejectBatch(reviewers.single,[decision(pending[0],'stale'),decision(pending[1],'stale',{expectedUpdatedAt:'stale'})],409,'STATE_CONFLICT');
    await rejectBatch(reviewers.single,[decision(pending[0],'closed'),decision(single[0],'closed')],409,'STATE_CONFLICT');
    await rejectBatch(reviewers.single,[decision(pending[0],'duplicate'),decision(pending[0],'duplicate')],400,'INVALID_TRANSACTION');
    assert(pending.every(task=>view(task).status==='pending_acceptance'));
    proofs.push('跨镜头、错误角色、分组不同batchId、缺失批次/版本、实检fail冒充通过、任一任务过期/已处理/重复均整批零写入');

    for(const mode of ['single','multi']){
      const raced=groupIds.filter(id=>MODES[id]===mode).map(id=>groups[id].tasks[5]),revision=service.getRevision();
      const contenders=[0,1].map(i=>({id:randomUUID(),revision,delta:{events:raced.map(task=>decision(task,'race-'+mode+'-'+i))}}));
      const responses=await Promise.all(contenders.map(body=>call('transactions',{token:reviewers[mode].token,body,status:null})));
      assert.deepEqual(responses.map(row=>row.status).sort(),[200,409]);
      const winner=responses.findIndex(row=>row.status===200);assert.equal(responses[1-winner].value.error.code,'REVISION_CONFLICT');
      const after=service.exportBackup();assert.equal(after.revision,revision+1);
      for(let i=0;i<3;i++)assert.deepEqual(await data('transactions',{token:reviewers[mode].token,body:contenders[winner]}),responses[winner].value);
      const replayed=service.exportBackup();
      assert.deepEqual(replayed.state,after.state,'Same request replay must not create any extra event');
      assert.deepEqual(replayed.transactions,after.transactions,'Same request replay must not create any extra transaction');
      assert.equal(replayed.revision,after.revision);
      await rejectBatch(reviewers[mode],raced.map(task=>decision(task,'fresh-double-click-'+mode)),409,'STATE_CONFLICT');
      raced.forEach(task=>assert.equal(service.state().events.filter(row=>row.taskId===task.id&&row.type==='acceptance_pass').length,1));
    }
    assert.deepEqual(qualityFingerprint(checkTotals(24,12)),fingerprint);
    proofs.push('同名单并发只成功一个事务；原请求重复3次完全幂等，新请求重复点击409，验收通过量与随批通过量均不重复增加');

    // A task not inspected in round one must never enter first-round accuracy later.
    for(const mode of ['single','multi']){
      const tasks=groupIds.filter(id=>MODES[id]===mode).map(id=>groups[id].tasks[7]),batchId=randomUUID();
      await apply(reviewers[mode],tasks.map(task=>decision(task,batchId,{type:'acceptance_fail',note:'首轮未实检，随批退回'})));
    }
    for(const groupId of groupIds){
      const group=groups[groupId],task=group.tasks[7];
      await apply(group.qc,[event(task,'acceptance_route',{route:'annotation',note:'原组返修'})]);
      await apply(group.annotation,[event(task,'submit')]);await apply(group.qc,[event(task,'qc_pass')]);
      assert.equal(view(task).acceptanceRound,2);
    }
    for(const mode of ['single','multi']){
      const tasks=groupIds.filter(id=>MODES[id]===mode).map(id=>groups[id].tasks[7]),batchId=randomUUID();
      await apply(reviewers[mode],tasks.map(task=>decision(task,batchId)));
    }
    const final=checkTotals(30,18);assert.deepEqual(qualityFingerprint(final),fingerprint);
    groupIds.forEach(id=>{const task=groups[id].tasks[7],first=Reports.annotationContributors(service.state().events.filter(row=>row.taskId===task.id)).firstAcceptanceDecision;assert.equal(first.acceptanceInspection,'uninspected');assert.equal(first.acceptanceRound,1);assert.equal(Reports.acceptanceAssessment(first,first).reason,'首轮未实检');});
    assert.deepEqual(service.state().events.slice(0,original.events.length),original.events,'All earlier events must remain byte-for-byte equivalent');
    assert.deepEqual(service.state().tasks,original.tasks);
    assert.equal(service.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert(!fs.existsSync(path.join(directory,'backups')));
    proofs.push('首轮未实检退回后第二轮随批通过计入闭环但仍不补首验分母；全部旧事件、未选任务和原任务归属保持，数据库完整');

    const sourceFiles=['workbench-api/server.cjs','workbench-api/rules.cjs','workbench-api/record-index.cjs','group-workbench/workflow.js','group-workbench/reports.js'];
    const sourceSha256=Object.fromEntries(sourceFiles.map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(__dirname,'..',name))).digest('hex')]));
    const result={ok:true,runtime:process.version,checkedAt:new Date().toISOString(),groups:groupIds,transactions:service.getRevision(),tasks:service.state().tasks.length,events:service.state().events.length,metrics:{accepted:30,closed:30,uninspectedPasses:18,firstInspected:24,firstPassed:12,accuracy:50},sourceSha256,proofs};
    if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result,null,2));
  }finally{await service.close();}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main};
