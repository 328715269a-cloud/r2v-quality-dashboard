'use strict';

// Only synthetic records in an independent temporary SQLite database.
// This test never opens production data, credentials, or network endpoints.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {randomUUID,createHash}=require('node:crypto');
const {createService,API}=require('../workbench-api/server.cjs');
const {snapshot,MODES}=require('../workbench-api/rules.cjs');
const Flow=require('../group-workbench/workflow.js');
const groupPin='isolated-cross-group-pin',adminPin='isolated-cross-group-admin';
const event=(task,type,fields={})=>({id:randomUUID(),taskId:task.id,type,...fields});
const profile=(role,groupId)=>({role,groupId,mode:MODES[groupId],name:{annotation:'验证标注',qc:'验证质检',acceptance:'验证验收'}[role]});

async function main(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'r2v-cross-group-return-'));
  const service=createService({directory,groupPin,adminPin,skipStartupBackup:true,backupIntervalMs:0});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const port=service.server.address().port,proofs=[];
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
  const login=async(who,pin)=>data('session',{body:{profile:who,pin}});
  const state=session=>data('state',{token:session.token});
  const view=task=>snapshot(service.state(),task.id);
  async function apply(session,events){
    const before=await state(session),body={id:randomUUID(),revision:before.revision,delta:{events}};
    return{body,result:await data('transactions',{token:session.token,body})};
  }
  async function rejectBatch(session,events,status,code){
    const before=service.exportBackup();
    const response=await data('transactions',{token:session.token,status,body:{id:randomUUID(),revision:before.revision,delta:{events}}});
    assert.equal(response.error.code,code);
    const after=service.exportBackup();
    assert.deepEqual(after.state,before.state,'Every task and event must remain unchanged after rejection');
    assert.deepEqual(after.transactions,before.transactions,'Rejection must not leave a partial transaction');
    assert.equal(after.revision,before.revision);
  }
  function decision(task,batchId,inspection='uninspected',extra={}){
    const current=view(task);
    return event(task,'acceptance_fail',{acceptanceBatchId:batchId,acceptanceInspection:inspection,acceptanceRound:current.acceptanceRound,expectedUpdatedAt:current.updatedAt,note:'整批退回，统一复查（隔离验证）',...extra});
  }
  function imported(groupId){
    const batch={id:randomUUID(),groupId,mode:MODES[groupId],date:'2031-01-02',movie:'跨组隔离影片-'+groupId};
    const tasks=Array.from({length:5},(_,i)=>({id:randomUUID(),tid:'CROSS-'+groupId+'-'+i,batchId:batch.id,groupId,mode:batch.mode,date:batch.date,movie:batch.movie}));
    batch.taskIds=tasks.map(task=>task.id);
    return{tasks,batches:[batch],events:tasks.map(task=>event(task,'dispatch'))};
  }
  try{
    const admin=await login({name:'admin',role:'admin'},adminPin);
    const reviewers={single:await login(profile('acceptance','g01'),groupPin),multi:await login(profile('acceptance','g06'),groupPin)};
    const groups={};
    for(const groupId of ['g01','g02','s06','g06','g07','m12']){
      const annotation=await login(profile('annotation',groupId)),qc=await login(profile('qc',groupId),groupPin),delta=imported(groupId);
      const revision=service.getRevision();
      const saved=await data('transactions',{token:admin.token,body:{id:randomUUID(),revision,delta}});
      const tasks=saved.delta.tasks;groups[groupId]={annotation,qc,tasks};
      await apply(annotation,tasks.flatMap(task=>[event(task,'claim'),event(task,'submit')]));
      await apply(qc,tasks.map(task=>event(task,'qc_pass')));
      tasks.forEach(task=>assert.equal(view(task).status,'pending_acceptance'));
    }
    const originalTasks=service.state().tasks;
    const single=['g01','g02','s06'].map(groupId=>groups[groupId].tasks[0]);
    const multi=['g06','g07','m12'].map(groupId=>groups[groupId].tasks[0]);
    const pendingSingle=['g01','g02'].map(groupId=>groups[groupId].tasks[1]);
    const pendingMulti=['g06','g07'].map(groupId=>groups[groupId].tasks[1]);

    // The existing API deliberately accepts one batch ID, not one per group.
    await rejectBatch(reviewers.single,pendingSingle.map(task=>decision(task,randomUUID())),400,'INVALID_TRANSACTION');
    proofs.push('同一事务按组使用不同 batchId 会被现有 API 拒绝，且没有任何部分保存');

    const beforeSingle=service.getRevision(),singleBatch=randomUUID();
    const singleResult=await apply(reviewers.single,single.map((task,index)=>decision(task,singleBatch,['pass','fail','uninspected'][index])));
    assert.equal(singleResult.result.revision,beforeSingle+1);
    assert.equal(singleResult.result.delta.events.length,3);
    assert(singleResult.result.delta.events.every(row=>row.acceptanceBatchId===singleBatch));
    assert.deepEqual(singleResult.result.delta.events.map(Flow.acceptanceInspection),['pass','fail','uninspected']);
    assert(single.every(task=>view(task).status==='acceptance_return_pending'));
    assert.equal(Flow.label(view(single[0])),'实检合格 · 随批退回');
    assert.equal(Flow.label(view(single[1])),'实检不合格 · 退回质检');
    const multiBatch=randomUUID(),beforeMulti=service.getRevision();
    const multiResult=await apply(reviewers.multi,multi.map(task=>decision(task,multiBatch)));
    assert.equal(multiResult.result.revision,beforeMulti+1);
    assert(multi.every(task=>view(task).status==='acceptance_return_pending'));
    assert.deepEqual(service.state().tasks,originalTasks,'Returns must not rewrite original task ownership, group, movie or import batch');
    proofs.push('单镜和多镜各自跨3组使用一个 batchId、一个事务成功退回；原组别、影片、归属与实检结果完整保留');

    for(const [groupId,group]of Object.entries(groups)){
      const scoped=await data('state?scope=role-v1',{token:group.qc.token});
      assert(scoped.state.tasks.every(task=>task.groupId===groupId));
      const ownIds=new Set(group.tasks.map(task=>task.id));
      assert(scoped.state.events.every(row=>ownIds.has(row.taskId)||row.groupId===groupId));
      assert.equal(scoped.state.events.filter(row=>row.acceptanceBatchId===(MODES[groupId]==='single'?singleBatch:multiBatch)).length,1);
      const projected=scoped.state.tasks.map(task=>({...task,...Flow.project(task,scoped.state.events)}));
      assert.equal(projected.filter(task=>task.status==='acceptance_return_pending').length,1);
      const incremental=await data('state?scope=role-v1&after='+beforeSingle,{token:group.qc.token});
      assert(incremental.delta.events.every(row=>ownIds.has(row.taskId)||row.groupId===groupId));
      assert.equal(incremental.delta.events.filter(row=>row.type==='acceptance_fail').length,1);
    }
    proofs.push('各组质检完整快照和增量同步只收到本组退回任务；跨组批次不混入其他组质检队列');

    const mixedModeBatch=randomUUID();
    await rejectBatch(reviewers.single,[decision(pendingSingle[0],mixedModeBatch),decision(pendingMulti[0],mixedModeBatch)],403,'FORBIDDEN');
    await rejectBatch(reviewers.multi,[decision(pendingMulti[0],mixedModeBatch),decision(pendingSingle[0],mixedModeBatch)],403,'FORBIDDEN');
    for(const session of [groups.g01.qc,groups.g01.annotation,admin])await rejectBatch(session,pendingSingle.map(task=>decision(task,'role-rejection')),403,'FORBIDDEN');
    await rejectBatch(groups.g01.qc,[event(single[0],'acceptance_route',{route:'annotation',note:'本组合法'}),event(single[1],'acceptance_route',{route:'annotation',note:'跨组禁止'})],403,'FORBIDDEN');
    proofs.push('单多镜混选、非验收身份和质检跨组处理全部原子拒绝；允许跨组的只有同模块验收角色');

    await rejectBatch(reviewers.single,[decision(pendingSingle[0],'stale-batch'),decision(pendingSingle[1],'stale-batch','uninspected',{expectedUpdatedAt:'stale'})],409,'STATE_CONFLICT');
    await rejectBatch(reviewers.single,[decision(pendingSingle[0],'closed-batch'),decision(single[0],'closed-batch')],409,'STATE_CONFLICT');
    await rejectBatch(reviewers.single,[decision(pendingSingle[0],'duplicate-batch'),decision(pendingSingle[0],'duplicate-batch')],400,'INVALID_TRANSACTION');
    proofs.push('任一组出现过期任务、已处理任务或重复任务时，整个跨组名单零写入，其他组不会先被退回');

    // Two independent HTTP requests contend for the same cross-group list.
    const raced=['g01','g02'].map(groupId=>groups[groupId].tasks[4]),raceRevision=service.getRevision();
    const contenders=[0,1].map(index=>({id:randomUUID(),revision:raceRevision,delta:{events:raced.map(task=>decision(task,'race-'+index))}}));
    const racedResponses=await Promise.all(contenders.map(body=>call('transactions',{token:reviewers.single.token,body,status:null})));
    assert.deepEqual(racedResponses.map(response=>response.status).sort(),[200,409]);
    const winner=racedResponses.findIndex(response=>response.status===200);
    assert.equal(racedResponses[1-winner].value.error.code,'REVISION_CONFLICT');
    assert.equal(service.getRevision(),raceRevision+1);
    assert.equal(service.state().events.filter(row=>raced.some(task=>task.id===row.taskId)&&row.type==='acceptance_fail').length,2);
    const replay=await data('transactions',{token:reviewers.single.token,body:contenders[winner]});
    assert.deepEqual(replay,racedResponses[winner].value);assert.equal(service.getRevision(),raceRevision+1);
    proofs.push('并发跨组退回只有一个完整事务成功；另一方409，重试幂等且不会重复计入或漏退某组');

    for(const [groupId,group]of Object.entries(groups)){
      const task=group.tasks[0];
      await apply(group.qc,[event(task,'acceptance_route',{route:'annotation',note:'原小组质检转标注复查'})]);
      assert.equal(view(task).status,'acceptance_rework');assert.equal(view(task).groupId,groupId);
      await apply(group.annotation,[event(task,'submit')]);assert.equal(view(task).status,'pending_reqc');
      await apply(group.qc,[event(task,'qc_pass')]);assert.equal(view(task).status,'pending_acceptance');assert.equal(view(task).acceptanceRound,2);
    }
    proofs.push('退回后各原小组质检和标注可继续返修、提交、复检及第2轮验收，无需重新分组或改派');

    // Preserve the existing single-group sampling combinations unchanged.
    const sameGroup=[groups.g01.tasks[1],groups.g01.tasks[3]],sampleId=randomUUID();
    const sample=await apply(reviewers.single,[decision(sameGroup[0],sampleId,'pass',{type:'acceptance_pass',note:'同组实检合格'}),decision(sameGroup[1],sampleId,'fail')]);
    assert.deepEqual(sample.result.delta.events.map(Flow.acceptanceInspection),['pass','fail']);
    assert.equal(view(sameGroup[0]).status,'accepted');assert.equal(view(sameGroup[1]).status,'acceptance_return_pending');
    assert.equal(view(groups.g02.tasks[1]).status,'pending_acceptance','Unselected task in another group must remain untouched');
    assert.deepEqual(service.state().tasks,originalTasks);
    assert.equal(service.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert(!fs.existsSync(path.join(directory,'backups')));
    proofs.push('既有同组抽检通过/不合格组合和实检标记不变；未选任务、原始归属及数据库完整性保持');

    const sourceFiles=['workbench-api/server.cjs','workbench-api/rules.cjs','workbench-api/record-index.cjs','group-workbench/workflow.js'];
    const sourceSha256=Object.fromEntries(sourceFiles.map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(__dirname,'..',name))).digest('hex')]));
    const result={ok:true,runtime:process.version,checkedAt:new Date().toISOString(),groups:Object.keys(groups),transactions:service.getRevision(),tasks:service.state().tasks.length,events:service.state().events.length,sourceSha256,proofs};
    if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result,null,2));
  }finally{await service.close();}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main};
