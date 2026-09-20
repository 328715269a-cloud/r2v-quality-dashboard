'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {createService,API}=require('./server.cjs');
const {snapshot}=require('./rules.cjs');
const uid=kind=>`${kind}_${randomUUID()}`;
const groupPin='isolated-group-pin',adminPin='isolated-admin-pin';

async function main(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'r2v-admin-import-'));
  let service=createService({directory,groupPin,adminPin,skipStartupBackup:true,backupIntervalMs:0}),base;
  const proofs=[];
  async function listen(){await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${service.server.address().port}${API}`;}
  async function request(endpoint,{token,body,method='GET',status=200}={}){
    const response=await fetch(base+endpoint,{method,headers:{...(token?{'X-Workbench-Session':token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;
  }
  const profile=(name,role,groupId='g01',mode='single')=>({name,role,groupId,mode});
  const login=(value,pin)=>request('session',{method:'POST',body:{profile:value,pin}});
  const event=(task,type,details={})=>({id:uid('event'),taskId:task.id,type,workflowVersion:3,...details});
  const state=session=>request('state',{token:session.token});
  async function tx(session,delta,extras={}){const current=await state(session);const body={id:randomUUID(),revision:current.revision,delta,...extras};const result=await request('transactions',{method:'POST',token:session.token,body});return{result,body};}
  async function fail(session,delta,{status=403,code='FORBIDDEN',...extras}={}){
    const before=await state(session),transactions=service.exportBackup().transactions.length;
    const body={id:randomUUID(),revision:before.revision,delta,...extras};
    const result=await request('transactions',{method:'POST',token:session.token,body,status});assert.equal(result.error.code,code);
    assert.deepEqual(await state(session),before,'denied import must preserve every task, event, batch and revision');
    assert.equal(service.exportBackup().transactions.length,transactions,'denied import must not leave a transaction or audit business mutation');
    assert.deepEqual((await request('session',{token:session.token})).profile,session.profile,'denial must not invalidate the existing work session');
    return result;
  }
  function imported(tids,{groupId='g01',mode='single',movie='仅管理员分配影片'}={}){
    const batch={id:uid('batch'),kind:'import',date:'2026-09-20',groupId,mode,movie};
    const tasks=tids.map(tid=>({id:uid('task'),tid,date:batch.date,groupId,mode,movie,batchId:batch.id,createdBy:'伪造身份'}));batch.taskIds=tasks.map(task=>task.id);
    return{tasks,batches:[batch],events:tasks.map(task=>event(task,'dispatch',{actor:'admin',actorRole:'admin'}))};
  }
  function merged(...deltas){return{tasks:deltas.flatMap(delta=>delta.tasks||[]),batches:deltas.flatMap(delta=>delta.batches||[]),events:deltas.flatMap(delta=>delta.events||[])};}
  async function pack(task,owner){
    const current=snapshot((await state(owner)).state,task.id),batch={id:uid('package'),kind:'handoff',date:current.date,groupId:current.groupId,mode:current.mode,movie:current.movie,stage:'qc',packageName:'原组长继续质检包',taskIds:[task.id]};
    return{batches:[batch],events:['package_built','package_claimed'].map(type=>event(task,type,{stage:'qc',packageId:batch.id,packageRound:current.qcRound+1}))};
  }
  try{
    await listen();
    const admin=await login({name:'admin',role:'admin'},adminPin),qc=await login(profile('原组长','qc'),groupPin),annotation=await login(profile('原标注','annotation')),substitute=await login(profile('代修标注','annotation')),acceptance=await login(profile('原验收','acceptance'),groupPin);
    const initial=await tx(admin,merged(imported(['SINGLE-A','SINGLE-B']),imported(['MULTI-A'],{groupId:'g06',mode:'multi',movie:'多镜影片'})));
    const [a,b,multi]=initial.result.delta.tasks;
    assert.equal(initial.result.delta.batches.length,2);assert.equal(initial.result.delta.events.length,3);
    assert(initial.result.delta.tasks.every(task=>task.createdBy==='admin'));
    assert(initial.result.delta.events.every(item=>item.actor==='admin'&&item.actorRole==='admin'));
    assert.equal(a.mode,'single');assert.equal(multi.mode,'multi');
    assert.deepEqual(await request('transactions',{method:'POST',token:admin.token,body:initial.body}),initial.result,'administrator import retry remains idempotent');
    proofs.push('管理员已登录会话可在同次原子事务分配单/多镜头；服务端规范操作者，原请求幂等返回而不重复导入');

    const pendingOldQcImport=imported(['OLD-QC-IMPORT']);
    await tx(annotation,{events:[event(a,'claim'),event(a,'submit',{round:1})]});
    const beforeRestart=await state(admin),tokens={qc:qc.token,annotation:annotation.token,acceptance:acceptance.token};
    await service.close();service=createService({directory,groupPin,adminPin,existingDatabaseOnly:true,skipStartupBackup:true,backupIntervalMs:0});await listen();
    assert.deepEqual(await state(admin),beforeRestart);
    for(const session of [qc,annotation,acceptance])assert.deepEqual((await request('session',{token:session.token})).profile,session.profile);
    assert.deepEqual({qc:qc.token,annotation:annotation.token,acceptance:acceptance.token},tokens);
    for(const session of [qc,annotation,acceptance]){
      const denied=await fail(session,pendingOldQcImport);assert.equal(denied.error.message,'仅管理员可以导入影片任务');
      await fail(session,pendingOldQcImport,{pin:adminPin});
    }
    await fail(qc,pendingOldQcImport,{pin:groupPin});
    await fail(qc,{tasks:pendingOldQcImport.tasks});
    const forgedBatch={...pendingOldQcImport.batches[0],kind:'handoff',stage:'qc',packageName:'伪装质检包'};
    await fail(qc,{...pendingOldQcImport,batches:[forgedBatch]}, {pin:adminPin});
    await fail(qc,{tasks:pendingOldQcImport.tasks,batches:[forgedBatch],events:[]},{pin:adminPin});
    const batchOnly={...pendingOldQcImport.batches[0],id:uid('batch'),taskIds:[a.id]};
    await fail(qc,{batches:[batchOnly]});
    const legacyBatch={...batchOnly,id:uid('batch')};delete legacyBatch.kind;await fail(qc,{batches:[legacyBatch]});
    await fail(qc,{events:[event(a,'dispatch',{actorRole:'admin',actor:'admin'})]},{pin:adminPin});
    await fail(qc,{events:[event(a,'dispatch',{actorRole:'admin'})],batches:[{...batchOnly,id:uid('batch'),kind:'handoff',stage:'qc',packageName:'伪装批次'}]});
    proofs.push('原QC/标注/验收会话保留且全部导入入口403；管理或小组密码不提升角色；新任务伪装handoff、独立导入批次、独立dispatch及旧QC未提交导入全批拒绝无业务写入');

    const qcPackage=await pack(a,qc);
    await fail(qc,merged(qcPackage,pendingOldQcImport));
    assert.equal(snapshot((await state(admin)).state,a.id).status,'annotation_done','mixed forbidden import must not partially perform a valid QC package action');
    await tx(qc,qcPackage);
    assert.equal(snapshot((await state(admin)).state,a.id).status,'pending_qc');
    const qcReview=await tx(qc,{events:[event(a,'qc_fail',{qcRound:1,round:1,pLevel:'P1',tags:['其他'],note:'仍需修改'})]});
    assert.deepEqual(await request('transactions',{method:'POST',token:qc.token,body:qcReview.body}),qcReview.result,'QC review retry remains idempotent');
    await tx(qc,{events:[event(a,'claim',{workflowVersion:4,assignmentKind:'rework_transfer',fromAssignee:annotation.profile.name,assignee:substitute.profile.name,assignmentStatus:'rework',note:'请假代修'})]});
    const transferred=snapshot((await state(admin)).state,a.id);assert.equal(transferred.status,'rework');assert.equal(transferred.assignee,substitute.profile.name);
    await tx(substitute,{events:[event(a,'submit',{round:2})]});await tx(qc,await pack(a,qc));await tx(qc,{events:[event(a,'qc_pass',{qcRound:2,round:2})]});
    assert.equal(snapshot((await state(admin)).state,a.id).status,'pending_acceptance');
    await tx(acceptance,{events:[event(a,'acceptance_pass',{acceptanceRound:1})]});assert.equal(snapshot((await state(admin)).state,a.id).status,'accepted');
    proofs.push('原QC会话继续登记质检包、质检打回/通过及幂等重试；请假代修和标注返修到验收完整流转不变；混有导入的质检操作全部回滚');

    const daily={id:uid('group_day'),taskId:'group:g01',type:'group_daily_edit',groupId:'g01',mode:'single',date:'2026-09-20',before:{leader:'待填写',total:null,headcount:null},after:{leader:'原组长',total:0,headcount:1.5},note:'实际在班人数登记'};
    await fail(qc,{events:[daily]},{code:'PIN_INVALID'});
    await tx(qc,{events:[daily]},{pin:groupPin});
    const savedDaily=(await state(admin)).state.events.find(item=>item.id===daily.id);assert.equal(savedDaily.after.headcount,1.5);assert.equal(savedDaily.actor,qc.profile.name);
    const edit=event(b,'metadata_edit',{before:{tid:b.tid,movie:b.movie},after:{tid:'SINGLE-B-RENAMED',movie:b.movie},note:'既有任务资料更正'});
    await fail(qc,{events:[edit]},{code:'PIN_INVALID'});await tx(qc,{events:[edit]},{pin:adminPin});
    const edited=snapshot((await state(admin)).state,b.id);assert.equal(edited.tid,'SINGLE-B-RENAMED');assert.equal(edited.status,'unclaimed');
    proofs.push('组长小组设置密码与0.5人数精度保持；既有metadata_edit仍需管理密码且原组长权限未扩大或收回');

    const extra=await tx(admin,imported(['ADMIN-NEW-AFTER-RESTART'],{groupId:'g02',movie:'后续分配'}));assert.equal(extra.result.delta.tasks.length,1);
    const final=await state(admin);assert.equal(final.state.tasks.length,4);
    assert(!final.state.tasks.some(task=>task.tid==='OLD-QC-IMPORT'));
    assert.equal(service.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    const backup=await request('backup',{token:admin.token});assert.deepEqual(backup.state,final.state);assert.equal(backup.transactions.length,final.revision);
    const result={ok:true,checkedAt:new Date().toISOString(),runtime:process.version,checks:{adminOnlyImports:true,allEntryPointsGuarded:true,oldSessionsPreserved:true,qcWorkflowPreserved:true,atomicDeniedImports:true,idempotencyPreserved:true,adminSingleMultiImports:true,groupAndMetadataPermissionsPreserved:true},proofs,revision:final.revision,tasks:final.state.tasks.length,events:final.state.events.length,temporaryDirectory:directory,sourceHash:createHash('sha256').update(fs.readFileSync(path.join(__dirname,'rules.cjs'))).digest('hex')};
    if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
  }finally{await service.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
