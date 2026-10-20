'use strict';

// Synthetic temporary data only. --legacy-root points to retained source code,
// never a production database or environment file.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {fork}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {createService,API}=require('./server.cjs');
const {snapshot,MODES}=require('./rules.cjs');
const Flow=require('../group-workbench/workflow.js');
const groupPin='isolated-inspection-group',adminPin='isolated-inspection-admin';
const event=(task,type,fields={})=>({id:randomUUID(),taskId:task.id,type,...fields});
const profile=(role,groupId='g01')=>({name:{annotation:'测试标注',qc:'测试质检',acceptance:'测试验收'}[role],role,groupId,mode:MODES[groupId]});
async function listen(service){await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${service.server.address().port}${API}`;}
async function request(base,endpoint,{token,body,status=200}={}){
  const response=await fetch(base+endpoint,{method:body?'POST':'GET',headers:{...(token?{'X-Workbench-Session':token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;
}
async function child(){
  const legacyRoot=process.argv[4],factory=legacyRoot?require(path.join(legacyRoot,'workbench-api/server.cjs')).createService:createService;
  const service=factory({directory:process.argv[3],groupPin,adminPin,existingDatabaseOnly:true,skipStartupBackup:true,backupIntervalMs:0});
  process.send({base:await listen(service)});
  process.on('message',async message=>{if(message==='close'){await service.close();process.exit(0);}});
}
async function main(){
  const legacyArg=process.argv.indexOf('--legacy-root'),legacyRoot=legacyArg>=0?path.resolve(process.argv[legacyArg+1]):'';
  if(legacyRoot)assert(fs.existsSync(path.join(legacyRoot,'workbench-api/server.cjs')),'Legacy root must contain source code');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'r2v-acceptance-inspection-'));
  let service=createService({directory,groupPin,adminPin,skipStartupBackup:true,backupIntervalMs:0}),base=await listen(service);
  const children=[],proofs=[];
  const legacyFlow=legacyRoot?require(path.join(legacyRoot,'group-workbench/workflow.js')):Flow;
  async function startPeer(root=''){
    const worker=fork(__filename,['--peer',directory,root],{stdio:['ignore','ignore','inherit','ipc']});children.push(worker);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Peer startup timed out')),20000);
      worker.once('message',message=>{clearTimeout(timer);resolve({...message,worker});});
      worker.once('error',error=>{clearTimeout(timer);reject(error);});
      worker.once('exit',code=>{clearTimeout(timer);reject(new Error(`Peer exited: ${code}`));});
    });
  }
  async function stopPeer(peer){const exited=new Promise(resolve=>peer.worker.once('exit',resolve));peer.worker.send('close');await exited;children.splice(children.indexOf(peer.worker),1);}
  const login=(who,pin)=>request(base,'session',{body:{profile:who,pin}});
  const state=session=>request(base,'state',{token:session.token});
  const tx=async(session,delta,url=base)=>{
    const before=await request(url,'state',{token:session.token});
    return request(url,'transactions',{token:session.token,body:{id:randomUUID(),revision:before.revision,delta}});
  };
  const fail=async(session,delta,status=400,code)=>{
    const before=await state(session);
    const rejected=await request(base,'transactions',{token:session.token,status,body:{id:randomUUID(),revision:before.revision,delta}});
    if(code)assert.equal(rejected.error.code,code);
    assert.deepEqual(await state(session),before,'Rejected batch must preserve all data and revision');
  };
  function imported(count,groupId='g01',prefix='TASK'){
    const batch={id:randomUUID(),date:'2031-01-02',groupId,mode:MODES[groupId],movie:'隔离实检影片'};
    const tasks=Array.from({length:count},(_,i)=>({id:randomUUID(),tid:`${prefix}-${i}`,date:batch.date,groupId,mode:batch.mode,movie:batch.movie,batchId:batch.id}));
    batch.taskIds=tasks.map(task=>task.id);
    return{tasks,batches:[batch],events:tasks.map(task=>event(task,'dispatch'))};
  }
  const current=task=>snapshot(service.state(),task.id);
  const decision=(task,type,inspection,fields={})=>event(task,type,{acceptanceRound:current(task).acceptanceRound,expectedUpdatedAt:current(task).updatedAt,acceptanceInspection:inspection,...(type==='acceptance_fail'?{note:'隔离验证退回原因'}:{}),...fields});
  async function ready(tasks,annotation,qc){
    await tx(annotation,{events:tasks.flatMap(task=>[event(task,'claim'),event(task,'submit')])});
    await tx(qc,{events:tasks.map(task=>event(task,'qc_pass'))});
    tasks.forEach(task=>assert.equal(current(task).status,'pending_acceptance'));
  }
  try{
    const admin=await login({name:'admin',role:'admin'},adminPin);
    const annotation=await login(profile('annotation')),qc=await login(profile('qc'),groupPin),acceptance=await login(profile('acceptance'),groupPin),multiAcceptance=await login(profile('acceptance','g06'),groupPin);
    assert.deepEqual((await request(base,'health')).capabilities.acceptanceInspection,{supported:true,version:1});
    const hundred=imported(100,'g01','HUNDRED');await tx(admin,hundred);await ready(hundred.tasks,annotation,qc);
    const spare=imported(12,'g01','SPARE');await tx(admin,spare);await ready(spare.tasks,annotation,qc);
    const [invalid,atomic,race,legacyRound,legacyPass,legacyFail,rejected,releaseA,releaseB,inspectedBad,uninspectedBad,hold]=spare.tasks;

    const beforeStartup={revision:service.getRevision(),records:service.state(),sessions:service.db.prepare('SELECT count(*) AS count FROM sessions').get().count};
    const retained=await startPeer(legacyRoot),peer=await startPeer();
    assert.equal(service.getRevision(),beforeStartup.revision);
    assert.deepEqual(service.state(),beforeStartup.records);
    assert.equal(service.db.prepare('SELECT count(*) AS count FROM sessions').get().count,beforeStartup.sessions);
    assert(!fs.existsSync(path.join(directory,'backups')),'Parallel start must not create a backup owner');
    for(const session of [admin,annotation,qc,acceptance]){
      assert.deepEqual((await request(peer.base,'session',{token:session.token})).profile,session.profile);
      assert.deepEqual((await request(retained.base,'session',{token:session.token})).profile,session.profile);
    }
    proofs.push('新旧独立进程共享临时 WAL；已有会话持续有效；启动没有初始化、任务写入或重复备份');

    const batchId=randomUUID(),batch=hundred.tasks.map((task,i)=>decision(task,'acceptance_fail',i<8?'pass':i<10?'fail':'uninspected',{acceptanceBatchId:batchId}));
    const beforeBatch=service.getRevision(),saved=await tx(acceptance,{events:batch});
    assert.equal(saved.revision,beforeBatch+1);assert.equal(saved.delta.events.length,100);
    const inspections=saved.delta.events.map(Flow.acceptanceInspection);
    assert.equal(inspections.filter(value=>value==='pass').length,8);
    assert.equal(inspections.filter(value=>value==='fail').length,2);
    assert.equal(inspections.filter(value=>value==='uninspected').length,90);
    assert.equal(inspections.filter(value=>value==='pass').length/inspections.filter(value=>value!=='uninspected').length,0.8);
    for(const task of hundred.tasks){
      const projected=current(task);assert.equal(projected.status,'acceptance_return_pending');assert.equal(projected.acceptanceFlowAction,'return');assert.equal(projected.acceptanceBatchId,batchId);
      assert.equal(legacyFlow.project(task,service.state().events).status,'acceptance_return_pending','Old page must understand real return');
    }
    assert.equal(current(hundred.tasks[0]).acceptanceInspection,'pass');
    assert.equal(current(hundred.tasks[8]).acceptanceInspection,'fail');
    assert.equal(current(hundred.tasks[10]).acceptanceInspection,'uninspected');
    assert.equal(Flow.label(current(hundred.tasks[0])),'实检合格 · 随批退回');
    assert.equal(Flow.label(current(hundred.tasks[8])),'实检不合格 · 退回质检');
    assert.equal(Flow.label(current(hundred.tasks[10])),'未实检 · 随批退回');
    await fail(acceptance,{events:[decision(hundred.tasks[0],'acceptance_pass','uninspected',{acceptanceBatchId:randomUUID()})]},409,'STATE_CONFLICT');
    assert.deepEqual(service.state().events.filter(row=>row.acceptanceBatchId===batchId),saved.delta.events);
    proofs.push('100 条整批退回：8 实检合格、2 实检不合格、90 未实检；真实退回100条，实检准确率80%，既有结果不可覆盖');

    for(const value of ['',null,0,'checked'])await fail(acceptance,{events:[decision(invalid,'acceptance_pass',value)]});
    await fail(acceptance,{events:[decision(invalid,'acceptance_pass','fail')]});
    await fail(acceptance,{events:[decision(invalid,'acceptance_fail','pass')]});
    await fail(acceptance,{events:[decision(invalid,'acceptance_fail','uninspected')]});
    await fail(acceptance,{events:[decision(invalid,'acceptance_pass','uninspected')]});
    await fail(acceptance,{events:[decision(invalid,'acceptance_fail','fail',{note:''})]});
    await fail(acceptance,{events:[decision(invalid,'acceptance_pass','pass',{expectedUpdatedAt:undefined})]},409,'STATE_CONFLICT');
    await fail(acceptance,{events:[decision(invalid,'acceptance_pass','pass',{expectedUpdatedAt:'outdated'})]},409,'STATE_CONFLICT');
    await fail(qc,{events:[decision(invalid,'qc_pass','pass')]});
    await fail(acceptance,{events:[event(invalid,'acceptance_pass',{acceptanceBatchId:randomUUID()})]});
    await fail(acceptance,{events:[decision(invalid,'acceptance_reject','fail',{note:'拒绝'})]});
    await fail(acceptance,{events:[decision(invalid,'acceptance_fail','fail',{note:'[验收拒绝] 拒绝'})]});
    await fail(acceptance,{events:[decision(invalid,'acceptance_fail','uninspected',{acceptanceBatchId:''})]});
    await fail(acceptance,{events:[decision(invalid,'acceptance_fail','uninspected',{acceptanceBatchId:'x'.repeat(129)})]});
    const invalidBatch=randomUUID();
    await fail(acceptance,{events:[decision(atomic,'acceptance_pass','pass',{acceptanceBatchId:invalidBatch}),decision(invalid,'acceptance_fail','fail')]});
    await fail(acceptance,{events:[decision(atomic,'acceptance_pass','pass',{acceptanceBatchId:invalidBatch}),decision(invalid,'acceptance_fail','fail',{acceptanceBatchId:randomUUID()})]});
    await fail(acceptance,{events:[decision(atomic,'acceptance_pass','pass',{acceptanceBatchId:invalidBatch}),decision(atomic,'acceptance_fail','fail',{acceptanceBatchId:invalidBatch})]});
    await fail(acceptance,{events:[decision(atomic,'acceptance_pass','pass'),decision(atomic,'acceptance_fail','fail')]},409,'STATE_CONFLICT');
    await fail(acceptance,{events:[decision(atomic,'acceptance_pass','uninspected',{acceptanceBatchId:invalidBatch}),decision(invalid,'acceptance_pass','uninspected',{acceptanceBatchId:invalidBatch,expectedUpdatedAt:'outdated'})]},409,'STATE_CONFLICT');
    await fail(qc,{events:[decision(invalid,'acceptance_pass','pass')]},403,'FORBIDDEN');
    await fail(multiAcceptance,{events:[decision(invalid,'acceptance_pass','pass')]},403,'FORBIDDEN');
    proofs.push('枚举、字段适用范围、非法组合、必填原因、批次名单、重复任务、版本与权限拒绝均整批原子且不丢数据');

    const released=await tx(acceptance,{events:[decision(releaseA,'acceptance_pass','uninspected',{acceptanceBatchId:'release-single'}),decision(releaseB,'acceptance_pass','uninspected',{acceptanceBatchId:'release-single'})]});
    assert(released.delta.events.every(row=>Flow.acceptanceInspection(row)==='uninspected'));
    for(const task of [releaseA,releaseB]){assert.equal(current(task).status,'accepted');assert.equal(current(task).acceptanceFlowAction,'pass');assert.equal(legacyFlow.project(task,service.state().events).status,'accepted');}
    const errors=await tx(acceptance,{events:[decision(inspectedBad,'acceptance_fail','fail'),decision(uninspectedBad,'acceptance_fail','fail')]});
    assert(errors.delta.events.every(row=>Flow.acceptanceInspection(row)==='fail'),'Selecting multiple actual errors remains inspected');
    const mixed=await tx(acceptance,{events:[decision(atomic,'acceptance_fail','fail',{acceptanceBatchId:'mixed-release'}),decision(invalid,'acceptance_pass','uninspected',{acceptanceBatchId:'mixed-release'})]});
    assert.equal(mixed.delta.events.length,2);assert.equal(current(atomic).status,'acceptance_return_pending');assert.equal(current(invalid).status,'accepted');
    proofs.push('多选实际错误仍全部算实检；随批放行真实通过且不计实检；放行批次中的实检不合格项仍退回');

    for(const [groupId,mode] of Object.entries(MODES)){
      const annotationGroup=await login(profile('annotation',groupId)),qcGroup=await login(profile('qc',groupId),groupPin),reviewer=mode==='single'?acceptance:multiAcceptance;
      const four=imported(4,groupId,`GROUP-${groupId}`);await tx(admin,four);await ready(four.tasks,annotationGroup,qcGroup);
      const groupBatch=randomUUID(),[a,b,c,d]=four.tasks;
      const result=await tx(reviewer,{events:[decision(a,'acceptance_pass','pass',{acceptanceBatchId:groupBatch}),decision(b,'acceptance_fail','fail',{acceptanceBatchId:groupBatch}),decision(c,'acceptance_fail','uninspected',{acceptanceBatchId:groupBatch}),decision(d,'acceptance_pass','uninspected',{acceptanceBatchId:groupBatch})]});
      assert.deepEqual(result.delta.events.map(Flow.acceptanceInspection),['pass','fail','uninspected','uninspected']);
      assert.deepEqual(four.tasks.map(task=>current(task).status),['accepted','acceptance_return_pending','acceptance_return_pending','accepted']);
    }
    proofs.push(`全部 ${Object.keys(MODES).length} 个单/多镜小组均通过四种动作；验收保留同模块跨小组权限`);

    const oldPass=await tx(acceptance,{events:[event(legacyPass,'acceptance_pass')]},retained.base);
    const oldFail=await tx(acceptance,{events:[event(legacyFail,'acceptance_fail',{note:'旧页原格式'})]},base);
    assert.equal(Flow.acceptanceInspection(oldPass.delta.events[0]),'pass');assert.equal(Flow.acceptanceInspection(oldFail.delta.events[0]),'fail');
    assert(!Object.hasOwn(oldPass.delta.events[0],'acceptanceInspection'));assert(!Object.hasOwn(oldFail.delta.events[0],'acceptanceInspection'));
    assert.equal(Flow.label(current(legacyPass)),'验收通过');assert.equal(Flow.label(current(legacyFail)),'验收打回·待质检处理');
    await tx(acceptance,{events:[event(legacyRound,'acceptance_fail',{acceptanceRound:1,note:'旧页首次退回'})]},retained.base);
    await tx(qc,{events:[event(legacyRound,'acceptance_route',{route:'qc',note:'自行修复'}),event(legacyRound,'qc_repair_done',{note:'修复完成'})]},retained.base);
    assert.equal(current(legacyRound).acceptanceRound,2);
    const normalized=await tx(acceptance,{events:[event(legacyRound,'acceptance_pass',{acceptanceRound:1})]},base);
    assert.equal(normalized.delta.events[0].acceptanceRound,2);
    const reject=await tx(acceptance,{events:[event(rejected,'acceptance_reject',{note:'旧拒绝契约'})]});
    assert.equal(reject.delta.events[0].type,'acceptance_fail');assert.equal(reject.delta.events[0].note,'[验收拒绝] 旧拒绝契约');
    assert.equal(Flow.acceptanceInspection(reject.delta.events[0]),'');assert.equal(current(rejected).status,'rejected');
    proofs.push('旧页无新字段的通过、退回、精确旧轮次、拒绝 marker 均保持；历史统计语义未改');

    const continued=hundred.tasks[0],initialRecord=saved.delta.events[0];
    await tx(qc,{events:[event(continued,'acceptance_route',{route:'annotation',note:'旧页接续新随批退回'})]},retained.base);
    assert.equal(current(continued).status,'acceptance_rework');
    assert.equal(Flow.label(current(continued)),'实检合格 · 随批退回 · 待标注返修');
    await tx(annotation,{events:[event(continued,'submit',{round:2})]},retained.base);
    assert.equal(current(continued).status,'pending_reqc');assert.equal(current(continued).qcRound,2);
    assert.equal(Flow.label(current(continued)),'待二次质检');
    await tx(qc,{events:[event(continued,'qc_pass',{qcRound:2})]},retained.base);
    assert.equal(current(continued).status,'pending_acceptance');assert.equal(current(continued).acceptanceRound,2);
    await tx(acceptance,{events:[decision(continued,'acceptance_pass','pass')]},peer.base);
    assert.equal(current(continued).status,'accepted');
    assert.deepEqual(service.state().events.find(row=>row.id===initialRecord.id),initialRecord,'Old API continuations must preserve the original inspection');
    const selfRepair=hundred.tasks[8];
    await tx(qc,{events:[event(selfRepair,'acceptance_route',{route:'qc',note:'旧页自行修复新实检错误'})]},retained.base);
    assert.equal(Flow.label(current(selfRepair)),'实检不合格 · 质检自行返修');
    await tx(qc,{events:[event(selfRepair,'qc_repair_done',{note:'已修复'})]},retained.base);
    assert.equal(current(selfRepair).status,'pending_acceptance');assert.equal(current(selfRepair).acceptanceRound,2);
    const continuedLegacy=await tx(acceptance,{events:[event(selfRepair,'acceptance_pass',{acceptanceRound:1})]});
    assert.equal(continuedLegacy.delta.events[0].acceptanceRound,2);
    const beforeClosed=await request(retained.base,'state',{token:qc.token});
    await request(retained.base,'transactions',{token:qc.token,status:409,body:{id:randomUUID(),revision:beforeClosed.revision,delta:{events:[event(releaseA,'acceptance_route',{route:'qc',note:'终态不得重开'})]}}});
    assert.deepEqual(await request(retained.base,'state',{token:qc.token}),beforeClosed);
    proofs.push('真实旧 prod63 接续新随批退回：转标注、提交、复检、再验收及质检自修轮次全部正确；原实检记录保留，随批放行终态不可重开');

    const beforeRace=await state(admin),raceA={id:randomUUID(),revision:beforeRace.revision,delta:{events:[decision(race,'acceptance_pass','pass')]}},raceB={id:randomUUID(),revision:beforeRace.revision,delta:{events:[event(race,'acceptance_fail',{note:'旧页并发退回'})]}};
    const raceResponses=await Promise.all([fetch(base+'transactions',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Session':acceptance.token},body:JSON.stringify(raceA)}),fetch(retained.base+'transactions',{method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Session':acceptance.token},body:JSON.stringify(raceB)})]);
    assert.deepEqual(raceResponses.map(response=>response.status).sort(),[200,409]);
    const raceResults=await Promise.all(raceResponses.map(response=>response.json())),winner=raceResponses.findIndex(response=>response.status===200),winnerBody=winner?raceB:raceA;
    assert.equal(raceResults[1-winner].error.code,'REVISION_CONFLICT');
    const replay=await request(peer.base,'transactions',{token:acceptance.token,body:winnerBody});assert.deepEqual(replay,raceResults[winner]);
    assert.equal(service.getRevision(),beforeRace.revision+1);
    assert.deepEqual(await request(peer.base,'state',{token:admin.token}),await state(admin));
    assert.deepEqual(await request(retained.base,'state',{token:admin.token}),await state(admin));
    proofs.push('新旧 API 争用同一版本仅一方成功，另一方409；获胜事务跨进程重试幂等，两端缓存一致');

    const projectionTask={id:'projection'};
    const projectionEvents=[{taskId:'projection',type:'acceptance_fail',workflowVersion:3,acceptanceRound:1,acceptanceInspection:'pass',actor:'测试验收',at:'2031-01-01T00:00:01Z'},{taskId:'projection',type:'acceptance_fail',workflowVersion:3,acceptanceRound:1,acceptanceInspection:'uninspected',acceptanceBatchId:'later',at:'2031-01-01T00:00:02Z'}];
    const preserved=Flow.project(projectionTask,projectionEvents);assert.equal(preserved.acceptanceInspection,'pass');assert.equal(preserved.acceptanceInspectionAt,projectionEvents[0].at);assert.equal(preserved.acceptanceFlowAction,'return');
    assert.equal(Flow.project(projectionTask,[...projectionEvents,{...projectionEvents[1],acceptanceRound:2}]).acceptanceInspection,'uninspected');
    assert.equal(Flow.project(projectionTask,[...projectionEvents,{type:'admin_release',taskId:'projection'}]).acceptanceInspection,'');
    assert.equal(Flow.acceptanceInspection({type:'qc_pass',acceptanceInspection:'pass'}),'');
    assert.equal(Flow.acceptanceFlowAction({type:'acceptance_fail',note:'[验收拒绝] 原因'}),'reject');
    for(const status of ['acceptance_rework','qc_self_rework']){
      const task={...current(hundred.tasks[10]),status};
      assert(Flow.label(task).includes('未实检 · 随批退回'));
    }
    proofs.push('投影的检查结果与流转动作独立，同轮随批不覆盖实检，新轮次与管理员释放明确重置维度');

    await stopPeer(retained);await stopPeer(peer);
    const final=await state(admin),databaseSchema=service.db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all();
    await service.close();service=createService({directory,groupPin,adminPin,existingDatabaseOnly:true,skipStartupBackup:true,backupIntervalMs:0});base=await listen(service);
    assert.deepEqual(await state(admin),final);
    assert.deepEqual(service.db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all(),databaseSchema);
    assert.equal(service.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(service.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
    assert(!fs.existsSync(path.join(directory,'backups')));
    assert.equal(current(hold).status,'pending_acceptance','Unrelated in-progress task must remain untouched');
    proofs.push('新实例重新读取相同 WAL 与旧会话，记录完整；无数据库迁移、备份副作用或无关任务变动');
    const result={ok:true,runtime:process.version,legacySourceVerified:!!legacyRoot,proofs,revision:final.revision,tasks:final.state.tasks.length,events:final.state.events.length};
    if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result,null,2));
  }finally{
    for(const worker of children){if(worker.exitCode===null){const exited=new Promise(resolve=>worker.once('exit',resolve));worker.send('close');await exited;}}
    await service.close();
  }
}
if(process.argv[2]==='--peer')child().catch(error=>{console.error(error);process.exit(1);});
else main().catch(error=>{console.error(error);process.exitCode=1;});
