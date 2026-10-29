'use strict';

// Synthetic HTTP + SQLite WAL only. --legacy-root may point to retained prod82
// source; it never selects a database, credentials, or a production endpoint.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {fork}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const {createService,API}=require('./server.cjs');
const {snapshot,MODES}=require('./rules.cjs');
const Flow=require('../group-workbench/workflow.js');
const Reports=require('../group-workbench/reports.js');
const groupPin='isolated-cross-mode-group',adminPin='isolated-cross-mode-admin';
const sourceFiles=['workbench-api/server.cjs','workbench-api/rules.cjs','workbench-api/record-index.cjs','group-workbench/workflow.js'];
const prod82Hashes={
  'workbench-api/server.cjs':'c87d77080b4d410eb242c425d19923a12434f3aa4cb702fa10735658e0873f9c',
  'workbench-api/rules.cjs':'e2c732bc3d3cd7d83427d5027a3a2d710b3d27504d893f68e9504b8f2f2132c7',
  'workbench-api/record-index.cjs':'8d38db075f3f5075b58dcb46fb9301d3823d5e54b69cf1d304460cde324d33a0',
  'group-workbench/workflow.js':'99f53e8ba222f9f2055d51f894592555c983efe7746ce7d0d04ba354ac941556'
};
const hashes=root=>Object.fromEntries(sourceFiles.map(file=>[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]));
const event=(task,type,fields={})=>({id:randomUUID(),taskId:task.id,type,...fields});
const profile=(role,groupId)=>({name:{annotation:'验证标注',qc:'验证质检',acceptance:'验证验收'}[role],role,groupId,mode:MODES[groupId]});
async function listen(service){await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${service.server.address().port}${API}`;}
async function request(base,endpoint,{token,body,status=200}={}){
  const response=await fetch(base+endpoint,{method:body?'POST':'GET',headers:{...(token?{'X-Workbench-Session':token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
  const value=await response.json();if(status!==null)assert.equal(response.status,status,JSON.stringify(value));return{status:response.status,value};
}
const data=async(...args)=>(await request(...args)).value;
async function child(){
  const factory=process.argv[4]?require(path.join(process.argv[4],'workbench-api/server.cjs')).createService:createService;
  const service=factory({directory:process.argv[3],groupPin,adminPin,existingDatabaseOnly:true,skipStartupBackup:true,backupIntervalMs:0});
  process.send({base:await listen(service),pid:process.pid});
  process.once('message',async()=>{await service.close();process.exit(0);});
}
async function main(){
  const arg=process.argv.indexOf('--legacy-root');
  if(arg>=0)assert(process.argv[arg+1]&&!process.argv[arg+1].startsWith('--'),'--legacy-root requires a source directory');
  const legacyRoot=arg>=0?path.resolve(process.argv[arg+1]):'',legacySourceSha256=legacyRoot?hashes(legacyRoot):null;
  if(legacyRoot)assert.deepEqual(legacySourceSha256,prod82Hashes,'Retained source must exactly match prod82');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'r2v-acceptance-cross-mode-'));
  const service=createService({directory,groupPin,adminPin,skipStartupBackup:true,backupIntervalMs:0});
  const base=await listen(service),worker=fork(__filename,['--peer',directory,legacyRoot],{stdio:['ignore','ignore','inherit','ipc']});
  const ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Isolated peer startup timed out')),15000);
    worker.once('message',value=>{clearTimeout(timer);resolve(value);});worker.once('error',error=>{clearTimeout(timer);reject(error);});
    worker.once('exit',code=>{clearTimeout(timer);reject(new Error('Isolated peer exited '+code));});
  });
  const proofs=[],metricChecks=[],groups={},current=task=>snapshot(service.state(),task.id);let invalidCases=0,fullService;
  const tx=async(session,delta,url=base,extras={})=>{
    const before=await data(url,'state',{token:session.token}),body={id:randomUUID(),revision:before.revision,delta,...extras};
    return{body,result:await data(url,'transactions',{token:session.token,body})};
  };
  const decision=(task,type='acceptance_pass',inspection='pass',fields={})=>event(task,type,{acceptanceInspection:inspection,acceptanceRound:current(task).acceptanceRound,expectedUpdatedAt:current(task).updatedAt,...fields});
  async function reject(session,events,status=403,code='FORBIDDEN',url=base,extras={}){
    const before=service.exportBackup(),body={id:randomUUID(),revision:before.revision,delta:{events},...extras};
    const result=await data(url,'transactions',{token:session.token,body,status});assert.equal(result.error.code,code);
    const after=service.exportBackup();assert.deepEqual(after.state,before.state);assert.deepEqual(after.transactions,before.transactions);assert.equal(after.revision,before.revision);invalidCases++;
  }
  try{
    const peer=await ready;assert.notEqual(peer.pid,process.pid);
    const health=await data(base,'health');assert.deepEqual(health.capabilities.acceptanceCrossMode,{supported:true,version:1});assert.deepEqual(health.capabilities.acceptanceInspection,{supported:true,version:1});assert.deepEqual(health.capabilities.acceptanceP2,{supported:true,version:1});assert.equal(health.schemaVersion,1);assert.equal(health.backup.mode,'delegated');
    if(legacyRoot)assert.equal((await data(peer.base,'health')).capabilities.acceptanceCrossMode,undefined);
    // Sessions originate on the peer. When provided, this is the unchanged old API.
    const login=(who,pin)=>data(peer.base,'session',{body:{profile:who,pin}}),admin=await login({name:'admin',role:'admin'},adminPin);
    for(const groupId of ['g01','g02','g06','m_newcomer']){
      const annotation=await login(profile('annotation',groupId)),qc=await login(profile('qc',groupId),groupPin),acceptance=await login(profile('acceptance',groupId),groupPin);
      const batch={id:randomUUID(),groupId,mode:MODES[groupId],movie:'混合镜头隔离影片-'+groupId,date:'2031-01-02'};
      const tasks=Array.from({length:16},(_,index)=>({id:randomUUID(),tid:'CROSS-MODE-'+groupId+'-'+index,groupId,mode:batch.mode,movie:batch.movie,date:batch.date,batchId:batch.id}));batch.taskIds=tasks.map(task=>task.id);
      const imported=await tx(admin,{tasks,batches:[batch],events:tasks.map(task=>event(task,'dispatch'))},peer.base);groups[groupId]={annotation,qc,acceptance,tasks:imported.result.delta.tasks};
      await tx(annotation,{events:tasks.filter((_,i)=>i!==14).flatMap(task=>[event(task,'claim'),event(task,'submit')])},peer.base);
      await tx(qc,{events:tasks.slice(0,14).map(task=>event(task,'qc_pass'))},peer.base);
      for(const session of [annotation,qc,acceptance])assert.deepEqual((await data(base,'session',{token:session.token})).profile,session.profile);
    }
    const initial=service.state(),groupList=Object.values(groups),at=index=>groupList.map(group=>group.tasks[index]),single=groups.g01,multi=groups.g06;
    proofs.push('4组单/多镜含新人组，旧API身份和既有任务直接接续；health只增量声明跨镜头验收能力');
    if(legacyRoot){
      await reject(single.acceptance,at(9).map(task=>decision(task)),403,'FORBIDDEN',peer.base);
      await reject(multi.acceptance,at(9).reverse().map(task=>decision(task)),403,'FORBIDDEN',peer.base);
      proofs.push('实际prod82仍拒绝跨镜头事务且零写入；候选能力不是通过修改旧版本取得');
    }
    // Every operation uses all four groups, with both single and multi sessions.
    const scenarios=[
      {name:'实检通过',type:'acceptance_pass',inspection:'pass',status:'accepted'},
      {name:'P2修正通过',type:'acceptance_pass',inspection:'pass',issue:'P2',status:'accepted'},
      {name:'未实检随批通过',type:'acceptance_pass',inspection:'uninspected',batch:true,status:'accepted'},
      {name:'实检不合格',type:'acceptance_fail',inspection:'fail',status:'acceptance_return_pending'},
      {name:'随批退回',type:'acceptance_fail',inspection:'uninspected',batch:true,status:'acceptance_return_pending'},
      {name:'验收拒绝',type:'acceptance_reject',status:'rejected'}
    ];
    for(const [index,scenario]of scenarios.entries()){
      const tasks=at(index),batchId=randomUUID(),session=index%2?multi.acceptance:single.acceptance;
      const rows=tasks.map(task=>scenario.inspection?decision(task,scenario.type,scenario.inspection,{note:scenario.name,...(scenario.issue?{acceptanceIssueLevel:scenario.issue}:{}),...(scenario.batch?{acceptanceBatchId:batchId}:{})}):event(task,scenario.type,{note:'无效素材，结束流转',expectedUpdatedAt:current(task).updatedAt,acceptanceRound:current(task).acceptanceRound}));
      const revision=service.getRevision(),saved=await tx(session,{events:rows});assert.equal(saved.result.revision,revision+1);assert.equal(saved.result.delta.events.length,4);
      for(const row of saved.result.delta.events){assert.equal(row.acceptanceRound,1);assert.equal(row.actor,session.profile.name);assert.equal(Flow.acceptanceFlowAction(row),scenario.status==='rejected'?'reject':scenario.type==='acceptance_pass'?'pass':'return');
        if(scenario.inspection)assert.equal(row.acceptanceInspection,scenario.inspection);else{assert.equal(row.type,'acceptance_fail');assert(Flow.isAcceptanceReject(row));assert(!Object.hasOwn(row,'acceptanceInspection'));}
        assert.equal(row.acceptanceIssueLevel,scenario.issue);if(scenario.batch)assert.equal(row.acceptanceBatchId,batchId);else assert(!Object.hasOwn(row,'acceptanceBatchId'));
      }
      for(const task of tasks){const view=current(task);assert.equal(view.status,scenario.status);assert.equal(view.groupId,task.groupId);assert.equal(view.mode,task.mode);assert.equal(view.assignee,'验证标注');assert.equal(view.qcRound,1);}
      assert.deepEqual(await data(peer.base,'transactions',{token:session.token,body:saved.body}),saved.result,'Committed mixed request replays on old API without revalidation');
      assert.equal(service.getRevision(),revision+1);
    }
    assert.deepEqual(service.state().tasks,initial.tasks);
    proofs.push('六类验收均跨4组/单多镜以单事务保存；原group/mode/归属不变、字段和轮次原样；旧API可幂等返回已提交的新跨镜头事务');

    // Statistics follow the task's mode/group and its submitting annotator,
    // never the acceptance session's login mode. Use the real HTTP events.
    const reportState=service.state(),inspectedTasks=groupList.flatMap(group=>group.tasks.slice(0,6)).map(current),sum=(rows,key)=>rows.reduce((n,row)=>n+Number(row[key]||0),0);
    for(const mode of ['single','multi'])for(const groupId of ['all',...Object.keys(groups).filter(id=>MODES[id]===mode)]){
      const selected=inspectedTasks.filter(task=>task.mode===mode&&(groupId==='all'||task.groupId===groupId)),ids=new Set(selected.map(task=>task.id)),count=groupId==='all'?2:1;
      const input={tasks:selected,auditTasks:selected,state:reportState,events:reportState.events,mode,groupId,statusMeta:Flow.STATUS_META,localDate:Reports.acceptanceDate};
      const first=Reports.acceptanceAccuracy(input),actual=Reports.acceptanceP2(input),report=Reports.build(input);
      assert.equal(first.total,3*count);assert.equal(first.passed,2*count);assert.equal(first.p2Count,count);assert.equal(first.rate,2/3*100);
      assert.equal(actual.total,3*count);assert.equal(actual.p2Count,count);assert.equal(actual.nonP2Count,2*count);assert.equal(actual.rate,2/3*100);
      for(const row of first.rows){const task=selected.find(task=>task.id===row.taskId);assert(task);assert.equal(row.mode,mode);assert.equal(row.groupId,task.groupId);assert.equal(row.name,'验证标注');}
      for(const row of actual.rows){assert.equal(row.mode,mode);assert.equal(row.name,'验证标注');assert(row.taskIds.every(id=>ids.has(id)));for(const inspection of row.inspections)assert.equal(inspection.groupId,selected.find(task=>task.id===inspection.taskId).groupId);}
      for(const id of new Set(selected.map(task=>task.groupId))){
        const personal=first.rows.filter(row=>row.groupId===id&&row.name==='验证标注');assert.equal(personal.length,3);assert.equal(personal.filter(row=>row.passed).length,2);
        const personalActual=actual.rows.filter(row=>row.groupId===id&&row.name==='验证标注');assert.equal(personalActual.length,3);assert.equal(personalActual.filter(row=>row.isP2).length,1);
      }
      assert.equal(report.groups.rows.length,count);
      for(const row of report.groups.rows){
        assert.equal(MODES[row.groupId],mode);
        for(const [key,value]of Object.entries({acceptedTIDs:3,rejectedTIDs:1,closedTIDs:4,firstAcceptanceInspectedTIDs:3,firstAcceptancePassedTIDs:2,firstAcceptanceP2TIDs:1,actualAcceptanceTIDs:3,acceptanceP2TIDs:1,acceptanceNonP2TIDs:2}))assert.equal(row[key],value,key);
        assert.equal(row.firstAcceptanceAccuracy,'66.7%');assert.equal(row.acceptanceP2Rate,'66.7%');
      }
      assert.equal(sum(report.daily.rows,'completedTIDs'),3*count);assert.equal(sum(report.daily.rows,'acceptanceFailActions'),2*count);
      assert.equal(sum(report.daily.rows,'acceptanceBatchReturnActions'),count);assert.equal(sum(report.daily.rows,'acceptanceBatchPassActions'),count);
      const outcomes=reportState.events.filter(event=>ids.has(event.taskId)&&['acceptance_pass','acceptance_fail'].includes(event.type));assert.equal(outcomes.length,6*count);
      for(const event of outcomes){const row=report.events.rows.find(row=>row.eventId===event.id);assert(row);const actualIncluded=['pass','fail'].includes(event.acceptanceInspection)&&!Flow.isAcceptanceReject(event);assert.equal(row.acceptanceFirstIncluded,actualIncluded);assert.equal(row.acceptanceActualIncluded,actualIncluded);assert.equal(row.acceptanceP2Included,event.acceptanceIssueLevel==='P2');}
      metricChecks.push({mode,groupId,firstPassed:first.passed,firstTotal:first.total,actualTotal:actual.total,p2Count:actual.p2Count,nonP2Count:actual.nonP2Count,passed:3*count,returned:2*count,rejected:count,annotator:'验证标注'});
    }
    proofs.push('真实HTTP流水按任务单/多镜、小组、提交人分别核对首验/非P2及通过退回量；每组实检2/3、P2为1/3，随批通过/退回与拒绝排除实检，卡片口径及导出事件一致');

    // Old payloads omit inspection, batch ID, expected timestamp and new flags.
    for(const group of groupList){
      for(const [index,type]of [[6,'acceptance_pass'],[7,'acceptance_fail'],[8,'acceptance_reject']]){
        const saved=await tx(group.acceptance,{events:[event(group.tasks[index],type,{note:'旧页原格式'})]});
        assert(!Object.hasOwn(saved.result.delta.events[0],'acceptanceInspection'));assert(!Object.hasOwn(saved.result.delta.events[0],'acceptanceIssueLevel'));
        assert.deepEqual(await data(peer.base,'transactions',{token:group.acceptance.token,body:saved.body}),saved.result);
      }
    }
    proofs.push('旧单镜/多镜页面原通过、退回、拒绝格式无需新字段继续成功；原会话无需重新登录');

    const pending=at(9),batchId=randomUUID();
    // A valid first row precedes the bad middle row; the third row is untouched.
    await reject(single.acceptance,[decision(pending[0]),decision(pending[2],'acceptance_pass','pass',{expectedUpdatedAt:'stale'}),decision(pending[1])],409,'STATE_CONFLICT');
    await reject(single.acceptance,[decision(pending[0]),decision(at(0)[2]),decision(pending[1])],409,'STATE_CONFLICT');
    await reject(single.acceptance,[decision(pending[0]),decision(pending[2],'acceptance_pass','fail'),decision(pending[1])],400,'INVALID_TRANSACTION');
    await reject(single.acceptance,[decision(pending[0],'acceptance_fail','uninspected',{note:'批次A',acceptanceBatchId:'A'}),decision(pending[2],'acceptance_fail','uninspected',{note:'批次B',acceptanceBatchId:'B'})],400,'INVALID_TRANSACTION');
    await reject(single.acceptance,[decision(pending[0],'acceptance_pass','uninspected',{acceptanceBatchId:batchId}),decision(pending[0],'acceptance_pass','uninspected',{acceptanceBatchId:batchId})],400,'INVALID_TRANSACTION');
    const noExpected=decision(pending[2]);delete noExpected.expectedUpdatedAt;await reject(single.acceptance,[decision(pending[0]),noExpected],409,'STATE_CONFLICT');
    // Client fields cannot grant acceptance authority or broaden other actions.
    for(const session of [single.annotation,single.qc,admin])await reject(session,pending.map(task=>decision(task,'acceptance_pass','pass',{mode:session.profile.mode,actorRole:'acceptance'})));
    for(const task of [groups.g02.tasks[15],multi.tasks[15]])await reject(single.qc,[event(single.tasks[15],'qc_pass'),event(task,'qc_pass',{mode:'single',groupId:'g01'})]);
    for(const task of [groups.g02.tasks[14],multi.tasks[14]])await reject(single.annotation,[event(single.tasks[14],'claim'),event(task,'claim',{mode:'single',groupId:'g01'})]);
    for(const type of ['claim','submit','qc_pass','acceptance_route','qc_repair_done','metadata_edit','admin_release'])await reject(single.acceptance,[decision(pending[0]),event(multi.tasks[15],type,{note:'不可跨角色操作',route:'qc'})]);
    await reject(single.qc,[event(single.tasks[3],'acceptance_route',{route:'annotation',note:'本组'}),event(multi.tasks[3],'acceptance_route',{route:'annotation',note:'跨模块'})]);
    for(const task of pending)assert.equal(current(task).status,'pending_acceptance');
    assert.equal(current(single.tasks[14]).status,'unclaimed');assert.equal(current(single.tasks[15]).status,'pending_qc');
    proofs.push('陈旧/终态中间任务、非法检查组合、批次不一致/重复/缺版本均整批回滚；冒充角色、质检/标注跨组跨镜、验收混入其他动作仍403');

    const beforeFollowup=service.getRevision();
    for(const [groupId,group]of Object.entries(groups)){
      const own=new Set(group.tasks.map(task=>task.id));
      const scoped=await data(base,'state?scope=role-v1',{token:group.qc.token});assert.equal(scoped.state.tasks.length,16);assert(scoped.state.tasks.every(task=>task.groupId===groupId));assert(scoped.state.events.every(row=>own.has(row.taskId)));
      const incremental=await data(base,'state?scope=role-v1&after='+12,{token:group.qc.token});assert(incremental.delta.events.every(row=>own.has(row.taskId)));
      // Retained old API routes new returns to the original group's owner.
      await tx(group.qc,{events:[event(group.tasks[4],'acceptance_route',{route:'annotation',note:'本组标注复查'})]},peer.base);
      await tx(group.annotation,{events:[event(group.tasks[4],'submit')]},peer.base);
      await tx(group.qc,{events:[event(group.tasks[4],'qc_pass')]},peer.base);
      await tx(group.qc,{events:[event(group.tasks[3],'acceptance_route',{route:'qc',note:'本组质检修改'}),event(group.tasks[3],'qc_repair_done',{note:'已完成修改'})]},peer.base);
      for(const index of [3,4])assert.equal(current(group.tasks[index]).acceptanceRound,2);
      await tx(group.annotation,{events:[event(group.tasks[14],'claim'),event(group.tasks[14],'submit')]},peer.base);
      await tx(group.qc,{events:[event(group.tasks[15],'qc_pass')]},peer.base);
    }
    const roundTwo=await tx(multi.acceptance,{events:at(4).map(task=>decision(task))});assert(roundTwo.result.delta.events.every(row=>row.acceptanceRound===2));
    const roundTwoP2=await tx(single.acceptance,{events:at(3).map(task=>decision(task,'acceptance_pass','pass',{acceptanceIssueLevel:'P2'}))});assert(roundTwoP2.result.delta.events.every(row=>row.acceptanceRound===2));
    proofs.push('原组质检完整/增量队列隔离保持；旧API能接续跨镜头随批退回和实检失败，原组返修后跨镜头复验仍规范化第2轮');

    // One mixed request races a valid old single-mode request on the same WAL.
    const raceTasks=at(10),revision=service.getRevision(),mixed={id:randomUUID(),revision,delta:{events:raceTasks.map(task=>decision(task))}},old={id:randomUUID(),revision,delta:{events:[event(raceTasks[0],'acceptance_fail',{note:'旧页并发退回'})]}};
    const raced=await Promise.all([request(base,'transactions',{token:single.acceptance.token,body:mixed,status:null}),request(peer.base,'transactions',{token:single.acceptance.token,body:old,status:null})]);
    assert.deepEqual(raced.map(row=>row.status).sort(),[200,409]);const winner=raced.findIndex(row=>row.status===200),bodies=[mixed,old];assert.equal(raced[1-winner].value.error.code,'REVISION_CONFLICT');assert.equal(service.getRevision(),revision+1);
    assert.equal(service.state().events.filter(row=>raceTasks.some(task=>task.id===row.taskId)&&['acceptance_pass','acceptance_fail'].includes(row.type)).length,winner===0?4:1);
    if(winner===1)raceTasks.slice(1).forEach(task=>assert.equal(current(task).status,'pending_acceptance'));
    for(const url of [base,peer.base])assert.deepEqual(await data(url,'transactions',{token:single.acceptance.token,body:bodies[winner]}),raced[winner].value);
    const beforeMismatch=service.exportBackup(),changed={...bodies[winner],delta:{events:at(11).map(task=>decision(task))}};
    const mismatch=await data(base,'transactions',{token:single.acceptance.token,body:changed,status:409});assert.equal(mismatch.error.code,'IDEMPOTENCY_MISMATCH');assert.deepEqual(service.exportBackup().state,beforeMismatch.state);assert.deepEqual(service.exportBackup().transactions,beforeMismatch.transactions);
    proofs.push('新跨镜头与旧单镜头请求双进程并发只提交完整赢家；失败方409无部分保存，成功请求跨新旧API重试幂等，复用ID改内容拒绝');

    // Cover the full validator fallback as well as the default indexed path.
    fullService=createService({directory,groupPin,adminPin,existingDatabaseOnly:true,skipStartupBackup:true,backupIntervalMs:0,relatedValidation:false});const fullBase=await listen(fullService);
    const full=await tx(single.acceptance,{events:at(13).map(task=>decision(task))},fullBase);assert.equal(full.result.delta.events.length,4);assert(at(13).every(task=>current(task).status==='accepted'));
    await fullService.close();fullService=null;
    for(const task of initial.tasks)assert.deepEqual(service.state().tasks.find(row=>row.id===task.id),task);
    for(const row of initial.events)assert.deepEqual(service.state().events.find(event=>event.id===row.id),row);
    assert(at(9).every(task=>current(task).status==='pending_acceptance'));assert(at(11).every(task=>current(task).status==='pending_acceptance'));assert(at(12).every(task=>current(task).status==='pending_acceptance'));
    assert.deepEqual(await data(peer.base,'state',{token:admin.token}),await data(base,'state',{token:admin.token}));
    assert.equal(service.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(service.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');assert(!fs.existsSync(path.join(directory,'backups')));
    assert(beforeFollowup<service.getRevision());proofs.push('默认局部校验及完整校验两条路径均支持混合验收；旧历史/原始任务不改，无迁移、额外备份或未选任务写入');
    const result={ok:true,runtime:process.version,checkedAt:new Date().toISOString(),legacySourceVerified:!!legacyRoot,legacySourceSha256,sourceSha256:hashes(path.resolve(__dirname,'..')),reportSourceSha256:createHash('sha256').update(fs.readFileSync(require.resolve('../group-workbench/reports.js'))).digest('hex'),independentProcesses:true,productionDataAccessed:false,invalidCases,groups:Object.keys(groups),tasks:service.state().tasks.length,events:service.state().events.length,revision:service.getRevision(),metricChecks,proofs};
    if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));return result;
  }finally{
    if(fullService)await fullService.close();
    if(worker.exitCode===null&&worker.signalCode===null){const exited=new Promise(resolve=>worker.once('exit',resolve));worker.send('close');await exited;}
    await service.close();
  }
}
if(require.main===module)(process.argv[2]==='--peer'?child():main()).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main};
