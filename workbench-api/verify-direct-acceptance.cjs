'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {fork}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {createService,API}=require('./server.cjs');
const {snapshot}=require('./rules.cjs');
const Flow=require('../group-workbench/workflow.js');
const Reports=require('../group-workbench/reports.js');
const groupPin='isolated-test-group-pin',adminPin='isolated-test-admin-pin';
const uid=kind=>`${kind}_${randomUUID()}`;

async function listen(service){await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${service.server.address().port}${API}`;}
async function runChild(){
  const service=createService({directory:process.argv[3],groupPin,adminPin,existingDatabaseOnly:true,skipStartupBackup:true,backupIntervalMs:0});
  process.send({base:await listen(service)});
  process.on('message',async message=>{if(message==='close'){await service.close();process.exit(0);}});
}

async function main(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'r2v-direct-acceptance-'));
  let service=createService({directory,groupPin,adminPin,skipStartupBackup:true,backupIntervalMs:0});
  let base=await listen(service),child;
  const checks={directAcceptanceRules:false,batchDecisions:false,cloudPersistence:false,legacySessionAndWrites:false,sharedWalConcurrency:false,exportsPreserved:false,node22PinnedRuntime:process.versions.node.split('.')[0]==='22'};
  const proofs=[];
  async function request(endpoint,{token,body,method='GET',status=200,url=base}={}){
    const response=await fetch(url+endpoint,{method,headers:{...(token?{'X-Workbench-Session':token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;
  }
  const profile=(name,role,groupId='g01',mode='single')=>({name,role,groupId,mode});
  const login=(value,pin)=>request('session',{method:'POST',body:{profile:value,pin}});
  const event=(task,type,fields={})=>({id:uid('event'),taskId:task.id,type,workflowVersion:3,...fields});
  async function state(session){return request('state',{token:session.token});}
  async function view(task,session){return snapshot((await state(session)).state,task.id);}
  async function tx(session,delta){const before=await state(session);return request('transactions',{method:'POST',token:session.token,body:{id:randomUUID(),revision:before.revision,delta}});}
  async function fail(session,delta,status=409,code){const before=await state(session);const result=await request('transactions',{method:'POST',token:session.token,body:{id:randomUUID(),revision:before.revision,delta},status});if(code)assert.equal(result.error.code,code);assert.deepEqual(await state(session),before,'failed batch must preserve every record and revision');return result;}
  function importDelta(tids,{groupId='g01',mode='single'}={}){
    const batch={id:uid('batch'),date:'2026-09-20',groupId,mode,movie:'隔离验收验证影片'};
    const tasks=tids.map(tid=>({id:uid('task'),tid,date:batch.date,groupId,mode,movie:batch.movie,batchId:batch.id}));
    batch.taskIds=tasks.map(task=>task.id);return{tasks,batches:[batch],events:tasks.map(task=>event(task,'dispatch'))};
  }
  async function packageDelta(tasks,owner,stage='qc'){
    const current=(await state(owner)).state,views=tasks.map(task=>snapshot(current,task.id)),first=views[0];
    const batch={id:uid('package'),kind:'handoff',stage,date:first.date,groupId:first.groupId,mode:first.mode,movie:first.movie,packageName:'真实旧页格式建包',taskIds:tasks.map(task=>task.id)};
    return{batches:[batch],events:views.flatMap(task=>{
      const details={stage,packageId:batch.id,packageName:batch.packageName,packageRound:stage==='qc'?task.qcRound+1:task.acceptanceRound};
      return[event(task,'package_built',details),event(task,'package_claimed',details)];
    })};
  }
  async function ready(tasks,annotation,qc){
    await tx(annotation,{events:tasks.flatMap(task=>[event(task,'claim'),event(task,'submit',{round:1})])});
    await tx(qc,await packageDelta(tasks,qc));
    await tx(qc,{events:tasks.map(task=>event(task,'qc_pass',{qcRound:1,round:1}))});
    for(const task of tasks){const current=await view(task,qc);assert.equal(current.status,'pending_acceptance');assert.equal(current.acceptanceRound,1);assert.equal(current.acceptancePackageId,'');}
  }
  try{
    const admin=await login({name:'admin',role:'admin'},adminPin);
    const annotation=await login(profile('标注甲','annotation'));
    const qc=await login(profile('组长甲','qc'),groupPin);
    const acceptance=await login(profile('验收甲','acceptance'),groupPin);
    const acceptanceTwo=await login(profile('验收乙','acceptance'),groupPin);
    const otherQc=await login(profile('组长乙','qc','g02'),groupPin);
    const otherAnnotation=await login(profile('标注乙','annotation','g02'));
    const multiQc=await login(profile('多镜组长','qc','g06','multi'),groupPin);
    const multiAnnotation=await login(profile('多镜标注','annotation','g06','multi'));
    const imported=await tx(admin,importDelta(['PASS-A','PASS-B','RETURN','REJECT-MARKER','REJECT-EXPLICIT','LEGACY-PACK','RACE','ATOMIC','QC-REJECT']));
    const [passA,passB,returned,rejectMarker,rejectExplicit,legacy,race,atomic,qcReject]=imported.delta.tasks;
    await ready(imported.delta.tasks.slice(0,8),annotation,qc);
    const inAcceptance=(await state(admin)).state;
    assert.equal(inAcceptance.batches.filter(batch=>batch.kind==='handoff'&&batch.stage==='acceptance').length,0,'direct flow creates no acceptance packages');
    await fail(qc,{events:[event(passA,'acceptance_pass')]},403,'FORBIDDEN');
    await fail(acceptance,{events:[event(passA,'acceptance_pass',{acceptanceRound:99})]},409,'STATE_CONFLICT');
    await fail(acceptance,{events:[event(passA,'acceptance_fail',{note:''})]},400);
    await fail(acceptance,{events:[event(passA,'acceptance_reject',{note:'[验收拒绝]'})]},400);
    await fail(acceptance,{events:[event(passA,'acceptance_fail',{note:'[验收拒绝]   '})]},400);
    await fail(acceptance,{events:[event(passA,'acceptance_fail',{note:'  [验收拒绝]   '})]},400);
    const expected=(await view(passA,acceptance)).updatedAt;
    await fail(acceptance,{events:[event(passA,'acceptance_pass',{acceptanceRound:1,expectedUpdatedAt:expected+'old'})]},409,'STATE_CONFLICT');
    await tx(acceptance,{events:[event(passA,'acceptance_pass',{acceptanceRound:1,expectedUpdatedAt:expected}),event(passB,'acceptance_pass',{acceptanceRound:1})]});
    assert.equal((await view(passA,acceptance)).status,'accepted');assert.equal((await view(passB,acceptance)).status,'accepted');
    await tx(acceptance,{events:[event(returned,'acceptance_fail',{acceptanceRound:1,note:'轮廓需要修正',source:'acceptance_import'})]});
    assert.equal((await view(returned,qc)).status,'acceptance_return_pending','ordinary failure returns to QC, not annotation');
    await tx(acceptance,{events:[event(rejectMarker,'acceptance_fail',{acceptanceRound:1,note:'[验收拒绝] 片源不可用'}),event(rejectExplicit,'acceptance_reject',{acceptanceRound:1,note:'任务失效'})]});
    for(const task of [rejectMarker,rejectExplicit]){const current=await view(task,acceptance);assert.equal(current.status,'rejected');assert.equal(current.finalRejectStage,'acceptance');assert(current.finalRejectReason);await fail(qc,{events:[event(task,'acceptance_route',{route:'annotation',note:'不允许复活'})]});await fail(qc,{events:[event(task,'qc_repair_done',{note:'不允许复活'})]});await fail(acceptance,{events:[event(task,'acceptance_pass')]});}
    const canonicalEvent=(await state(admin)).state.events.find(item=>item.taskId===rejectExplicit.id&&item.note==='[验收拒绝] 任务失效');
    assert.equal(canonicalEvent.type,'acceptance_fail','explicit reject retains the existing marker event contract for open WorkBuddy pages');
    checks.directAcceptanceRules=true;
    proofs.push('质检通过不建验收包即进入待验收；验收通过/不通过退质检/拒绝终止三结果；空拒绝原因、错误轮次、旧时间戳与终态再流转全部拦截');
    await fail(acceptance,{events:[event(atomic,'acceptance_pass'),event(rejectMarker,'acceptance_pass')]});
    assert.equal((await view(atomic,acceptance)).status,'pending_acceptance');
    await fail(acceptance,{events:[event(atomic,'acceptance_pass'),event(atomic,'acceptance_fail',{note:'同批重复冲突'})]});
    checks.batchDecisions=true;
    proofs.push('多条验收通过/拒绝原子保存；任一任务已处理或同批重复矛盾时，整批不写入');

    await tx(qc,{events:[event(returned,'acceptance_route',{route:'qc',note:'质检自行修改'})]});
    await tx(qc,{events:[event(returned,'qc_repair_done',{note:'已修改'})]});
    assert.equal((await view(returned,qc)).status,'pending_acceptance');assert.equal((await view(returned,qc)).acceptanceRound,2);
    // Open WorkBuddy pages used round 1 here and did not send expectedUpdatedAt.
    await fail(acceptance,{events:[event(returned,'acceptance_fail',{acceptanceRound:19,note:'任意旧轮次必须失败'})]});
    const legacyFail=await tx(acceptance,{events:[event(returned,'acceptance_fail',{acceptanceRound:1,note:'还需标注修正'})]});
    assert.equal(legacyFail.delta.events[0].acceptanceRound,2,'known legacy round is normalized by the server');
    await tx(qc,{events:[event(returned,'acceptance_route',{route:'annotation',note:'退回标注修改'})]});
    assert.equal((await view(returned,qc)).status,'acceptance_rework');
    await fail(acceptance,{events:[event(returned,'acceptance_pass')]});
    await tx(annotation,{events:[event(returned,'submit',{round:2})]});
    await fail(acceptance,{events:[event(returned,'acceptance_pass')]});
    await tx(qc,await packageDelta([returned],qc));
    await tx(qc,{events:[event(returned,'qc_pass',{qcRound:2,round:2})]});
    const third=await view(returned,qc);assert.equal(third.status,'pending_acceptance');assert.equal(third.acceptanceRound,3);assert.equal(third.qcRound,2);assert.equal(third.round,2);
    const legacyPass=await tx(acceptance,{events:[event(returned,'acceptance_pass',{acceptanceRound:2})]});
    assert.equal(legacyPass.delta.events[0].acceptanceRound,3);assert.equal((await view(returned,acceptance)).status,'accepted');
    proofs.push('验收退质检自行修复直接进入第2次验收；退标注需重新建质检包并质检通过后进入第3次验收；旧页精确历史轮次兼容且存为正确轮次');

    const oldPackage=await packageDelta([legacy],qc,'acceptance');
    await tx(qc,oldPackage);
    const oldPacked=await view(legacy,qc);assert.equal(oldPacked.status,'pending_acceptance');assert.equal(oldPacked.acceptanceRound,1);assert.equal(oldPacked.acceptancePackageId,oldPackage.batches[0].id);assert.equal(oldPacked.acceptancePackageClaimer,qc.profile.name);
    await fail(qc,await packageDelta([legacy],qc,'acceptance'));
    await tx(acceptance,{events:[event(legacy,'acceptance_pass',{acceptanceRound:1})]});
    await fail(qc,await packageDelta([legacy],qc,'acceptance'));
    const pendingLegacyTask={id:'legacy-projection-fixture'};
    const pendingLegacyHistory=[{type:'qc_pass',taskId:pendingLegacyTask.id,qcRound:1},{type:'package_built',taskId:pendingLegacyTask.id,stage:'acceptance',packageId:'legacy-package',packageRound:1}];
    const legacyProjection=Flow.project(pendingLegacyTask,pendingLegacyHistory);assert.equal(legacyProjection.status,'pending_acceptance');assert.equal(legacyProjection.acceptanceRound,1);assert.equal(legacyProjection.acceptancePackageId,'legacy-package');
    checks.legacySessionAndWrites=true;
    proofs.push('旧页面原会话、无时间戳事件格式和既有建/领验收包操作仍可保存；仅作为历史记录，不新增验收轮次、不重复建包、不复活终态；历史未领取验收包自动可验收');

    await tx(annotation,{events:[event(qcReject,'claim'),event(qcReject,'submit',{round:1})]});
    await tx(qc,await packageDelta([qcReject],qc));
    await tx(qc,{events:[event(qcReject,'qc_fail',{qcRound:1,note:'[质检拒绝] 无效片源',pLevel:'P0',tags:['其他']})]});
    assert.equal((await view(qcReject,qc)).status,'rejected');assert.equal((await view(qcReject,qc)).finalRejectStage,'qc');
    const otherTask=(await tx(admin,importDelta(['OTHER-GROUP'],{groupId:'g02'}))).delta.tasks[0];
    await ready([otherTask],otherAnnotation,otherQc);
    await fail(qc,{events:[event(otherTask,'acceptance_route',{route:'qc',note:'跨组'})]},403,'FORBIDDEN');
    await tx(acceptance,{events:[event(otherTask,'acceptance_pass')]});
    const multiTask=(await tx(admin,importDelta(['OTHER-MODE'],{groupId:'g06',mode:'multi'}))).delta.tasks[0];
    await ready([multiTask],multiAnnotation,multiQc);
    await fail(acceptance,{events:[event(multiTask,'acceptance_pass')]},403,'FORBIDDEN');
    await fail(qc,{events:[event(multiTask,'qc_pass')]},403,'FORBIDDEN');
    proofs.push('现有质检拒绝marker正确终止；组长不能跨组、单镜验收不能跨到多镜；验收仍可处理本模块多个小组');

    child=fork(__filename,['--wal-peer',directory],{stdio:['ignore','ignore','inherit','ipc']});
    const peer=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('WAL peer did not start')),15000);child.once('message',message=>{clearTimeout(timer);resolve(message);});child.once('error',error=>{clearTimeout(timer);reject(error);});});
    assert.deepEqual((await request('session',{token:qc.token,url:peer.base})).profile,qc.profile,'old sessions work on a new process sharing the same database');
    const beforeRace=await state(admin),timestamp=snapshot(beforeRace.state,race.id).updatedAt;
    const requests=[{id:randomUUID(),revision:beforeRace.revision,delta:{events:[event(race,'acceptance_pass',{acceptanceRound:1,expectedUpdatedAt:timestamp})]}},{id:randomUUID(),revision:beforeRace.revision,delta:{events:[event(race,'acceptance_reject',{acceptanceRound:1,expectedUpdatedAt:timestamp,note:'并发拒绝'})]}}];
    const responses=await Promise.all(requests.map((body,index)=>fetch((index?peer.base:base)+'transactions',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Session':(index?acceptanceTwo:acceptance).token},body:JSON.stringify(body)})));
    assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
    const raceResults=await Promise.all(responses.map(response=>response.json()));const winning=responses.findIndex(response=>response.status===200),losing=1-winning;
    assert.equal(raceResults[losing].error.code,'REVISION_CONFLICT');
    const replay=await request('transactions',{method:'POST',token:(winning?acceptanceTwo:acceptance).token,body:requests[winning],url:peer.base});assert.deepEqual(replay,raceResults[winning]);
    const raced=await state(admin);assert.equal(raced.revision,beforeRace.revision+1);assert.equal(raced.state.events.filter(item=>item.taskId===race.id&&['acceptance_pass','acceptance_fail'].includes(item.type)).length,1);
    assert.deepEqual(await request('state',{token:admin.token,url:peer.base}),raced);checks.sharedWalConcurrency=true;
    proofs.push('两个独立Node进程同时读写同一临时SQLite WAL；已有会话有效；并发同TID只能一方成功；另一方409且无额外记录；获胜请求跨进程重试幂等');

    const final=await state(admin),projected=final.state.tasks.map(raw=>({...raw,...Flow.project(raw,final.state.events)}));
    const report=Reports.build({state:final.state,tasks:projected,auditTasks:projected,statusMeta:Flow.STATUS_META,groupLabel:id=>id,eventLabel:event=>event.type});
    assert.equal(report.tasks.rows.length,final.state.tasks.length);assert.equal(report.events.rows.length,final.state.events.length);assert.equal(report.imports.rows.length,3);
    assert(report.packages.rows.some(row=>row.packageId===oldPackage.batches[0].id&&row.stage==='acceptance'),'legacy package audit must remain exportable');
    assert.equal(report.tasks.rows.find(row=>row.taskId===returned.id).acceptanceRound,3);
    for(const task of [rejectMarker,rejectExplicit])assert.equal(report.tasks.rows.find(row=>row.taskId===task.id).finalRejectStage,'acceptance');
    const daily=report.daily.rows;assert.equal(daily.reduce((sum,row)=>sum+row.acceptanceFailActions,0),2,'rejects must not count as failures');
    assert.equal(daily.reduce((sum,row)=>sum+row.qcSelfRepairActions,0),1);
    assert(daily.reduce((sum,row)=>sum+row.acceptanceRejectedTIDs,0)>=2);
    const movie=report.movies.rows.find(row=>row.modeCode==='single');assert(movie.closedTIDs>=8);assert.equal(movie.totalTIDs,10);checks.exportsPreserved=true;
    proofs.push('全部任务/影片/每日统计/原始流水/历史建包导出完整；验收拒绝不计打回，返修轮次及最终拒绝阶段保留');
    const backup=await request('backup',{token:admin.token});assert.deepEqual(backup.state,final.state);assert.equal(backup.transactions.length,final.revision);
    const online=await service.onlineBackup(path.join(directory,'verified-backup.sqlite'));assert.equal(online.revision,final.revision);
    const childStopped=new Promise(resolve=>child.once('exit',resolve));child.send('close');await childStopped;child=null;
    await service.close();service=createService({directory,groupPin,adminPin,existingDatabaseOnly:true,skipStartupBackup:true,backupIntervalMs:0});base=await listen(service);
    assert.deepEqual(await state(admin),final);assert.deepEqual((await request('session',{token:acceptance.token})).profile,acceptance.profile);
    assert.equal(service.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(service.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
    const backupDirectory=path.join(directory,'restore');fs.mkdirSync(backupDirectory);fs.copyFileSync(path.join(directory,'verified-backup.sqlite'),path.join(backupDirectory,'workbench.sqlite'));
    const restored=createService({directory:backupDirectory,groupPin,adminPin,skipStartupBackup:true,backupIntervalMs:0});assert.deepEqual(restored.state(),final.state);await restored.close();checks.cloudPersistence=true;
    proofs.push('真实HTTP保存后服务重启与原session恢复；在线备份恢复一致；追加审计与SQLite完整性、WAL均通过');
    const result={ok:true,checkedAt:new Date().toISOString(),runtime:process.version,checks,proofs,revision:final.revision,tasks:final.state.tasks.length,events:final.state.events.length,batches:final.state.batches.length,temporaryDirectory:directory};
    if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
    return result;
  }finally{
    if(child){child.kill();await new Promise(resolve=>child.once('exit',resolve));}
    await service.close();
  }
}

if(process.argv[2]==='--wal-peer')runChild().catch(error=>{console.error(error);process.exit(1);});
else main().catch(error=>{console.error(error);process.exitCode=1;});
