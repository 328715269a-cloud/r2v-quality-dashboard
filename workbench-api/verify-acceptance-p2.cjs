'use strict';

// Entirely synthetic HTTP/SQLite. Optional --legacy-root is a read-only prod81
// source tree, never a production database, environment file or session store.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {fork}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const {createService,API}=require('./server.cjs');
const {snapshot,MODES}=require('./rules.cjs');
const Flow=require('../group-workbench/workflow.js');
const groupPin='isolated-p2-group',adminPin='isolated-p2-admin';
const sourceFiles=['workbench-api/server.cjs','workbench-api/rules.cjs','workbench-api/record-index.cjs','group-workbench/workflow.js'];
const prod81Hashes={
  'workbench-api/server.cjs':'c33691a61e75b77569d87aef9f3905b96a3cdadc178312d129c772696f181c4a',
  'workbench-api/rules.cjs':'732131246e61469a649fe57a24f9bdc5c43c10c204c95d349c8f84c631e551a8',
  'workbench-api/record-index.cjs':'8d38db075f3f5075b58dcb46fb9301d3823d5e54b69cf1d304460cde324d33a0',
  'group-workbench/workflow.js':'e79b50b37b802e90edec52136b9bb1a6c29154d2155247b646ba38ceaa4219f1'
};
const hashes=root=>Object.fromEntries(sourceFiles.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
const event=(task,type,fields={})=>({id:randomUUID(),taskId:task.id,type,...fields});
const profile=(role,groupId)=>({name:{annotation:'测试标注',qc:'测试质检',acceptance:'测试验收'}[role],role,groupId,mode:MODES[groupId]});
async function listen(service){await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${service.server.address().port}${API}`;}
async function request(base,endpoint,{token,body,status=200}={}){
  const response=await fetch(base+endpoint,{method:body?'POST':'GET',headers:{...(token?{'X-Workbench-Session':token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const value=await response.json();if(status!==null)assert.equal(response.status,status,JSON.stringify(value));return{status:response.status,value};
}
const data=async(...args)=>(await request(...args)).value;
async function child(){
  const legacyRoot=process.argv[4],factory=legacyRoot?require(path.join(legacyRoot,'workbench-api/server.cjs')).createService:createService;
  const service=factory({directory:process.argv[3],groupPin,adminPin,existingDatabaseOnly:true,skipStartupBackup:true,backupIntervalMs:0});
  process.send({base:await listen(service),pid:process.pid});
  process.once('message',async()=>{await service.close();process.exit(0);});
}
async function main(){
  const arg=process.argv.indexOf('--legacy-root');
  if(arg>=0)assert(process.argv[arg+1]&&!process.argv[arg+1].startsWith('--'),'--legacy-root requires a source directory');
  const legacyRoot=arg>=0?path.resolve(process.argv[arg+1]):'',legacySourceSha256=legacyRoot?hashes(legacyRoot):null;
  if(legacyRoot)assert.deepEqual(legacySourceSha256,prod81Hashes,'Retained runtime must exactly match prod81');
  const legacyFlow=legacyRoot?require(path.join(legacyRoot,'group-workbench/workflow.js')):Flow;
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'r2v-acceptance-p2-'));
  let service=createService({directory,groupPin,adminPin,skipStartupBackup:true,backupIntervalMs:0}),base=await listen(service);
  const worker=fork(__filename,['--peer',directory,legacyRoot],{stdio:['ignore','ignore','inherit','ipc']});
  const ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Isolated peer startup timed out')),15000);
    worker.once('message',value=>{clearTimeout(timer);resolve(value);});
    worker.once('error',error=>{clearTimeout(timer);reject(error);});
    worker.once('exit',code=>{clearTimeout(timer);reject(new Error('Isolated peer exited '+code));});
  });
  const proofs=[],groups={};let invalidCases=0;
  const current=task=>snapshot(service.state(),task.id);
  const tx=async(session,delta,url=base,extras={})=>{
    const before=await data(url,'state',{token:session.token}),body={id:randomUUID(),revision:before.revision,delta,...extras};
    return{body,result:await data(url,'transactions',{token:session.token,body})};
  };
  async function reject(session,events,status=400,code='INVALID_TRANSACTION',extras={}){
    const before=service.exportBackup(),body={id:randomUUID(),revision:before.revision,delta:{events},...extras};
    const result=await data(base,'transactions',{token:session.token,body,status});assert.equal(result.error.code,code);
    const after=service.exportBackup();assert.deepEqual(after.state,before.state);assert.deepEqual(after.transactions,before.transactions);assert.equal(after.revision,before.revision);invalidCases++;
  }
  const decision=(task,type='acceptance_pass',inspection='pass',fields={})=>event(task,type,{acceptanceInspection:inspection,acceptanceRound:current(task).acceptanceRound,expectedUpdatedAt:current(task).updatedAt,...fields});
  const p2=(task,fields={})=>decision(task,'acceptance_pass','pass',{acceptanceIssueLevel:'P2',...fields});
  try{
    const peer=await ready;assert.notEqual(peer.pid,process.pid);
    const health=await data(base,'health');assert.deepEqual(health.capabilities.acceptanceP2,{supported:true,version:1});assert.deepEqual(health.capabilities.acceptanceInspection,{supported:true,version:1});assert.equal(health.schemaVersion,1);
    if(legacyRoot)assert.equal((await data(peer.base,'health')).capabilities.acceptanceP2,undefined);
    // These sessions and pre-existing operations originate on the retained API.
    const login=(who,pin)=>data(peer.base,'session',{body:{profile:who,pin}}),admin=await login({name:'admin',role:'admin'},adminPin);
    for(const groupId of ['g01','g02','g06','m_newcomer']){
      const annotation=await login(profile('annotation',groupId)),qc=await login(profile('qc',groupId),groupPin),acceptance=await login(profile('acceptance',groupId),groupPin);
      const batch={id:randomUUID(),groupId,mode:MODES[groupId],movie:'验收P2隔离影片',date:'2031-01-02'};
      const tasks=Array.from({length:8},(_,index)=>({id:randomUUID(),tid:'P2-'+groupId+'-'+index,groupId,mode:batch.mode,movie:batch.movie,date:batch.date,batchId:batch.id}));batch.taskIds=tasks.map(task=>task.id);
      const saved=await tx(admin,{tasks,batches:[batch],events:tasks.map(task=>event(task,'dispatch'))},peer.base);groups[groupId]={annotation,qc,acceptance,tasks:saved.result.delta.tasks};
      await tx(annotation,{events:tasks.flatMap(task=>[event(task,'claim'),event(task,'submit')])},peer.base);
      await tx(qc,{events:tasks.map(task=>event(task,'qc_pass'))},peer.base);
      for(const session of [annotation,qc,acceptance])assert.deepEqual((await data(base,'session',{token:session.token})).profile,session.profile);
    }
    const initial=service.state(),one=groups.g01,two=groups.g02,multi=groups.g06,newcomer=groups.m_newcomer;
    assert(initial.events.every(row=>!Object.hasOwn(row,'acceptanceIssueLevel')));
    assert(Object.values(groups).every(group=>group.tasks.every(task=>current(task).status==='pending_acceptance'&&current(task).acceptanceIssueLevel==='')));
    proofs.push('旧会话与已有单/多镜含新人组任务直接接续；health增量声明P2能力，其余能力和schema版本保持');

    // A valid first row precedes every invalid row, proving all-or-nothing writes.
    const valid=()=>p2(two.tasks[3]),bad=fields=>p2(two.tasks[4],fields);
    for(const level of ['P0','P1','p2',' P2 ','',null,2,{},[]])await reject(one.acceptance,[valid(),bad({acceptanceIssueLevel:level})]);
    for(const inspection of ['fail','uninspected','',null])await reject(one.acceptance,[valid(),bad({acceptanceInspection:inspection})]);
    const missing=bad({});delete missing.acceptanceInspection;await reject(one.acceptance,[valid(),missing]);
    for(const type of ['acceptance_fail','acceptance_reject'])await reject(one.acceptance,[valid(),bad({type,note:'拒绝非法P2组合'})]);
    await reject(one.acceptance,[valid(),bad({type:'acceptance_fail',note:'[验收拒绝] 不可通过'})]);
    for(const type of ['qc_pass','qc_fail','qc_reject','submit','claim','acceptance_route','qc_repair_done','admin_release','group_daily_edit'])await reject(one.acceptance,[valid(),bad({type})]);
    await reject(one.acceptance,[valid(),bad({expectedUpdatedAt:'stale'})],409,'STATE_CONFLICT');
    const noExpected=bad({});delete noExpected.expectedUpdatedAt;await reject(one.acceptance,[valid(),noExpected],409,'STATE_CONFLICT');
    await reject(one.acceptance,[p2(two.tasks[3],{acceptanceBatchId:'A'}),p2(two.tasks[4],{acceptanceBatchId:'B'})]);
    await reject(one.acceptance,[p2(two.tasks[3],{acceptanceBatchId:''})]);
    await reject(one.acceptance,[p2(two.tasks[3],{acceptanceBatchId:'incomplete'}),event(two.tasks[4],'acceptance_pass')]);
    await reject(one.acceptance,[p2(two.tasks[3],{acceptanceBatchId:'duplicate'}),p2(two.tasks[3],{acceptanceBatchId:'duplicate'})]);
    proofs.push('未知等级、缺实检字段、未实检/不合格/拒绝/非验收组合及非法批次全部原子拒绝；陈旧或缺失任务版本返回409');

    const plain=await tx(one.acceptance,{events:[p2(one.tasks[0]),p2(one.tasks[1],{note:'验收现场修正细节'})]});
    assert.equal(plain.result.delta.events[0].note,undefined);assert.equal(plain.result.delta.events[1].note,'验收现场修正细节');
    for(const row of plain.result.delta.events){assert.equal(row.type,'acceptance_pass');assert.equal(row.acceptanceInspection,'pass');assert.equal(row.acceptanceIssueLevel,'P2');assert.equal(row.acceptanceRound,1);assert(!Object.hasOwn(row,'pLevel'));assert(!Object.hasOwn(row,'tags'));assert(!Object.hasOwn(row,'acceptanceBatchId'));}
    for(const task of one.tasks.slice(0,2)){
      const now=current(task);assert.equal(now.status,'accepted');assert.equal(now.acceptanceInspection,'pass');assert.equal(now.acceptanceIssueLevel,'P2');assert.equal(now.round,1);assert.equal(now.qcRound,1);assert.equal(now.acceptanceRound,1);assert.equal(Flow.label(now),'P2已修正 · 验收通过');
      assert.equal(legacyFlow.project(task,service.state().events).status,'accepted');
    }
    const repeated=await data(peer.base,'transactions',{token:one.acceptance.token,body:plain.body});assert.deepEqual(repeated,plain.result);
    const latest=await data(base,'state?after='+(plain.result.revision-1),{token:one.acceptance.token});assert.equal(latest.delta.events.filter(row=>row.acceptanceIssueLevel==='P2').length,2);
    await reject(one.qc,[event(one.tasks[0],'acceptance_route',{route:'qc',note:'不得重开已通过任务'})],409,'STATE_CONFLICT');
    await reject(admin,[event(one.tasks[0],'admin_release',{note:'不得释放已通过任务'})],409,'STATE_CONFLICT',{pin:adminPin});
    proofs.push('P2可不填说明且可多选实检，原样持久化为pass/pass/P2；直接闭环不增加轮次、不生成QC等级/标签；旧投影理解通过、跨进程重试幂等、终态保护保持');

    const batchId=randomUUID(),batch=await tx(one.acceptance,{events:[p2(two.tasks[0],{acceptanceBatchId:batchId}),decision(two.tasks[1],'acceptance_pass','pass',{acceptanceBatchId:batchId}),decision(two.tasks[2],'acceptance_pass','uninspected',{acceptanceBatchId:batchId})]});
    assert.deepEqual(batch.result.delta.events.map(row=>row.acceptanceIssueLevel||''),['P2','','']);
    assert(batch.result.delta.events.every(row=>row.acceptanceBatchId===batchId));
    assert.equal(Flow.label(current(two.tasks[1])),'实检合格 · 验收通过');assert.equal(Flow.label(current(two.tasks[2])),'未实检 · 随批放行');
    for(const session of [one.qc,one.annotation,admin])await reject(session,[p2(two.tasks[4])],403,'FORBIDDEN');
    await reject(two.qc,[event(one.tasks[5],'acceptance_route',{route:'qc',note:'不能跨组'})],403,'FORBIDDEN');
    await tx(one.acceptance,{events:[p2(multi.tasks[0]),p2(newcomer.tasks[0])]});
    for(const [groupId,group]of Object.entries(groups)){
      const scoped=await data(base,'state?scope=role-v1',{token:group.qc.token}),ownIds=new Set(group.tasks.map(task=>task.id));
      assert(scoped.state.tasks.every(task=>task.groupId===groupId));assert(scoped.state.events.every(row=>ownIds.has(row.taskId)));assert.equal(scoped.state.tasks.length,8);
      const inc=await data(base,'state?scope=role-v1&after='+plain.body.revision,{token:group.qc.token});assert(inc.delta.events.every(row=>ownIds.has(row.taskId)));
    }
    proofs.push('P2可加入合法统一batchId的实检/随批事务，标记不会传播到普通或未实检通过；验收可跨组和单多镜头，其他角色边界及质检原组同步隔离保持');

    const oldPass=await tx(one.acceptance,{events:[event(one.tasks[2],'acceptance_pass')]});
    const oldFail=await tx(one.acceptance,{events:[event(one.tasks[3],'acceptance_fail',{note:'旧页普通退回'})]});
    const oldReject=await tx(one.acceptance,{events:[event(one.tasks[4],'acceptance_reject',{note:'旧页拒绝'})]});
    for(const result of [oldPass,oldFail,oldReject])assert(!Object.hasOwn(result.result.delta.events[0],'acceptanceIssueLevel'));
    assert.equal(Flow.label(current(one.tasks[2])),'验收通过');assert.equal(current(one.tasks[3]).status,'acceptance_return_pending');assert.equal(current(one.tasks[4]).status,'rejected');
    assert.equal(current(one.tasks[2]).acceptanceIssueLevel,'');assert.equal(Flow.acceptanceInspection(oldPass.result.delta.events[0]),'pass');assert.equal(Flow.acceptanceInspection(oldFail.result.delta.events[0]),'fail');
    // Older API continues a new normal return, then candidate records P2 in round2.
    await tx(one.qc,{events:[event(one.tasks[3],'acceptance_route',{route:'qc',note:'原组质检修改'}),event(one.tasks[3],'qc_repair_done',{note:'完成修改'})]},peer.base);
    const secondRound=await tx(one.acceptance,{events:[p2(one.tasks[3],{acceptanceRound:1})]});assert.equal(secondRound.result.delta.events[0].acceptanceRound,2);assert.equal(current(one.tasks[3]).qcRound,1);
    for(const [task,issue]of [[one.tasks[5],true],[two.tasks[6],false]]){
      const group=task.groupId==='g01'?one:two;
      await tx(group.acceptance,{events:[decision(task,'acceptance_fail','fail',{note:'实际验收不合格'})]});
      await tx(group.qc,{events:[event(task,'acceptance_route',{route:'annotation',note:'退标注修改'})]},peer.base);
      await tx(group.annotation,{events:[event(task,'submit')]},peer.base);
      await tx(group.qc,{events:[event(task,'qc_fail',{pLevel:'P2',tags:['命名/ID对齐错误'],note:'既有质检P2'})]},peer.base);
      assert.equal(current(task).acceptanceIssueLevel,'');assert.equal(current(task).status,'rework');
      await tx(group.annotation,{events:[event(task,'submit')]},peer.base);await tx(group.qc,{events:[event(task,'qc_pass')]},peer.base);
      await tx(group.acceptance,{events:[issue?p2(task):event(task,'acceptance_pass')]});
      assert.equal(current(task).acceptanceIssueLevel,issue?'P2':'');assert.equal(current(task).qcRound,3);assert.equal(current(task).round,3);assert.equal(current(task).acceptanceRound,2);
      const qcEvents=service.state().events.filter(row=>row.taskId===task.id&&row.type.startsWith('qc_'));
      assert(qcEvents.every(row=>!Object.hasOwn(row,'acceptanceIssueLevel')));assert.equal(qcEvents.filter(row=>row.pLevel==='P2').length,1);
      assert.equal(Flow.label(current(task)),issue?'P2已修正 · 验收通过':'验收通过');
    }
    proofs.push('旧格式通过/退回/拒绝保持原义；旧API可继续普通返修，服务端规范化旧轮次；质检P2与验收P2互不推导，标注返修和质检自修轮次不变');

    const race=one.tasks[7],before=service.getRevision();
    const contenders=[{id:randomUUID(),revision:before,delta:{events:[p2(race)]}},{id:randomUUID(),revision:before,delta:{events:[event(race,'acceptance_fail',{note:'旧页同时退回'})]}}];
    const raced=await Promise.all([request(base,'transactions',{token:one.acceptance.token,body:contenders[0],status:null}),request(peer.base,'transactions',{token:one.acceptance.token,body:contenders[1],status:null})]);
    assert.deepEqual(raced.map(row=>row.status).sort(),[200,409]);const winner=raced.findIndex(row=>row.status===200);assert.equal(raced[1-winner].value.error.code,'REVISION_CONFLICT');assert.equal(service.getRevision(),before+1);
    for(const url of [base,peer.base])assert.deepEqual(await data(url,'transactions',{token:one.acceptance.token,body:contenders[winner]}),raced[winner].value);
    assert.equal(service.state().events.filter(row=>row.taskId===race.id&&['acceptance_pass','acceptance_fail'].includes(row.type)).length,1);
    proofs.push('新P2通过与旧页退回并发只有一个完整结果；另一方409，成功请求跨进程重试不重复写入');

    // Projection reset tests use synthetic historical sequences. Accepted tasks
    // cannot be reopened through the API, and their ignored release stays ignored.
    const projectionTask={id:'projection'},p2Event={taskId:'projection',type:'acceptance_pass',acceptanceInspection:'pass',acceptanceIssueLevel:'P2',acceptanceRound:1,workflowVersion:3};
    assert.equal(Flow.project(projectionTask,[]).acceptanceIssueLevel,'');
    for(const next of [
      {type:'acceptance_pass'}, {type:'acceptance_pass',acceptanceInspection:'pass'},
      {type:'acceptance_pass',acceptanceInspection:'uninspected',acceptanceBatchId:'sample'},
      {type:'acceptance_fail',acceptanceInspection:'fail'}, {type:'acceptance_reject'},
      {type:'acceptance_fail',note:'[验收拒绝] 原因'}
    ])assert.equal(Flow.project(projectionTask,[p2Event,{...next,taskId:'projection',acceptanceRound:2,workflowVersion:3}]).acceptanceIssueLevel,'');
    assert.equal(Flow.project(projectionTask,[p2Event,{taskId:'projection',type:'admin_release'}]).acceptanceIssueLevel,'P2','Ignored closed-task release must remain ignored');
    const released=Flow.project(projectionTask,[p2Event,{taskId:'projection',type:'admin_reassign',toRole:'annotation',assignee:'旧例标注'},{taskId:'projection',type:'admin_release'}]);
    assert.equal(released.acceptanceIssueLevel,'');assert.equal(released.acceptanceInspection,'');assert.equal(released.status,'unclaimed');
    for(const malformed of [{...p2Event,type:'acceptance_fail'},{...p2Event,acceptanceInspection:'uninspected'},{...p2Event,acceptanceIssueLevel:'P1'}])assert.equal(Flow.project(projectionTask,[malformed]).acceptanceIssueLevel,'');
    const releaseTask=two.tasks[5];await tx(admin,{events:[event(releaseTask,'admin_release',{note:'隔离释放'})]},base,{pin:adminPin});assert.equal(current(releaseTask).acceptanceIssueLevel,'');assert.equal(current(releaseTask).status,'unclaimed');
    proofs.push('投影每次验收决定重新计算P2，普通通过/退回/拒绝不残留；合法释放清空，已闭环释放继续忽略，QC标签显示不受影响');

    for(const row of initial.tasks)assert.deepEqual(service.state().tasks.find(item=>item.id===row.id),row);
    for(const row of initial.events)assert.deepEqual(service.state().events.find(item=>item.id===row.id),row);
    const final=await data(base,'state',{token:admin.token});assert.deepEqual(await data(peer.base,'state',{token:admin.token}),final);
    const peerExited=new Promise(resolve=>worker.once('exit',resolve));worker.send('close');await peerExited;
    const schema=service.db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all();
    await service.close();service=createService({directory,groupPin,adminPin,existingDatabaseOnly:true,skipStartupBackup:true,backupIntervalMs:0});base=await listen(service);
    assert.deepEqual(await data(base,'state',{token:admin.token}),final);assert.deepEqual(service.db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all(),schema);
    assert.equal(service.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(service.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');assert(!fs.existsSync(path.join(directory,'backups')));
    assert.equal(current(two.tasks[3]).status,'pending_acceptance');assert.equal(current(two.tasks[4]).status,'pending_acceptance');
    proofs.push('HTTP完整/增量及重开数据库保留P2字段与旧会话；历史任务事件原文不改、无迁移或重复备份、无关待验收任务保持');
    const result={ok:true,runtime:process.version,checkedAt:new Date().toISOString(),legacySourceVerified:!!legacyRoot,legacySourceSha256,sourceSha256:hashes(path.resolve(__dirname,'..')),independentProcesses:true,productionDataAccessed:false,invalidCases,revision:final.revision,tasks:final.state.tasks.length,events:final.state.events.length,proofs};
    if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));return result;
  }finally{
    if(worker.exitCode===null&&worker.signalCode===null){const exited=new Promise(resolve=>worker.once('exit',resolve));worker.send('close');await exited;}
    await service.close();
  }
}
if(require.main===module)(process.argv[2]==='--peer'?child():main()).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main};
