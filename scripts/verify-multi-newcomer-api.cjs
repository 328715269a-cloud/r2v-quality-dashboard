'use strict';

// Synthetic SQLite/HTTP only. --legacy-root accepts a read-only prod74 source
// tree containing workbench-api/ and group-workbench/. No production DB is used.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {fork}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..');
const runtimeFiles=['workbench-api/server.cjs','workbench-api/rules.cjs','workbench-api/record-index.cjs','group-workbench/workflow.js'];
const baselineHashes={
  'workbench-api/server.cjs':'c33691a61e75b77569d87aef9f3905b96a3cdadc178312d129c772696f181c4a',
  'workbench-api/rules.cjs':'f6491dc4996d3a81d7412c6c4260c555032cd679d4c78f133d31309ae73ad109',
  'workbench-api/record-index.cjs':'8d38db075f3f5075b58dcb46fb9301d3823d5e54b69cf1d304460cde324d33a0',
  'group-workbench/workflow.js':'e79b50b37b802e90edec52136b9bb1a6c29154d2155247b646ba38ceaa4219f1'
};
const oldModes={g01:'single',g02:'single',g03:'single',g04:'single',g05:'single',s06:'single',g06:'multi',g07:'multi',g08:'multi',g09:'multi',g10:'multi',m06:'multi',m07:'multi',m08:'multi',m09:'multi',m10:'multi',m11:'multi',m12:'multi'};
const groupId='m_newcomer',groupName='多镜头新人组';
const groupPin='synthetic-newcomer-group-pin',adminPin='synthetic-newcomer-admin-pin';
const hash=value=>createHash('sha256').update(value).digest('hex');
const event=(task,type,fields={})=>({id:randomUUID(),taskId:task.id,type,...fields});
const profile=(role,id)=>({role,groupId:id,mode:id===groupId?'multi':oldModes[id],name:{annotation:'验证标注',qc:'验证质检',acceptance:'验证验收'}[role]});

async function legacyChild(legacyRoot,directory){
  const {createService}=require(path.join(legacyRoot,'workbench-api/server.cjs'));
  const {MODES}=require(path.join(legacyRoot,'workbench-api/rules.cjs'));
  const service=createService({directory,groupPin,adminPin,skipStartupBackup:true,backupIntervalMs:0});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  process.send({port:service.server.address().port,pid:process.pid,modes:MODES});
  process.once('message',async()=>{await service.close();process.exit(0);});
}
function startLegacy(legacyRoot,directory){
  const child=fork(__filename,['--legacy-child',legacyRoot,directory],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Synthetic legacy API startup timed out')),15000);
    child.once('message',value=>{clearTimeout(timer);resolve(value);});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('Synthetic legacy API exited '+code+': '+stderr.slice(-2000)));});
  });
  const close=async()=>{
    if(child.exitCode!==null||child.signalCode!==null)return;
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(new Error('Synthetic legacy API close timed out'));},10000);
      child.once('exit',()=>{clearTimeout(timer);resolve();});child.send({close:true});
    });
  };
  return{ready,close};
}
function client(port){
  async function call(endpoint,{token,body,status=200}={}){
    return new Promise((resolve,reject)=>{
      const serialized=body===undefined?null:JSON.stringify(body);
      const request=http.request({host:'127.0.0.1',port,path:'/group-workbench-api/'+endpoint,method:serialized?'POST':'GET',headers:{...(token?{'X-Workbench-Session':token}:{}),...(serialized?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(serialized)}:{})}},response=>{
        let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>{
          try{const value=JSON.parse(text);if(status!==null)assert.equal(response.statusCode,status,JSON.stringify(value));resolve({status:response.statusCode,value});}catch(error){reject(error);}
        });
      });
      request.setTimeout(15000,()=>request.destroy(new Error('Synthetic HTTP request timed out')));request.on('error',reject);request.end(serialized);
    });
  }
  const data=async(endpoint,options)=>(await call(endpoint,options)).value;
  return{call,data,login:(who,pin)=>data('session',{body:{profile:who,pin}})};
}
function importDelta(id,count=4,prefix='NEWGROUP'){
  const batch={id:randomUUID(),groupId:id,mode:id===groupId?'multi':oldModes[id],date:'2031-01-02',movie:'新人组隔离影片'};
  const tasks=Array.from({length:count},(_,index)=>({id:randomUUID(),tid:prefix+'-'+id+'-'+index,batchId:batch.id,groupId:id,mode:batch.mode,date:batch.date,movie:batch.movie}));
  batch.taskIds=tasks.map(task=>task.id);return{tasks,batches:[batch],events:tasks.map(task=>event(task,'dispatch'))};
}
async function main(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'r2v-multi-newcomer-'));
  const arg=process.argv.indexOf('--legacy-root');
  if(arg>=0)assert(process.argv[arg+1]&&!process.argv[arg+1].startsWith('--'),'--legacy-root requires a source directory');
  let legacyRoot=arg>=0?path.resolve(process.argv[arg+1]):path.join(directory,'baseline-source');
  if(arg<0){
    // Offline default restores the one allowlist addition, then verifies every
    // byte against the pinned prod74 hashes. Runtime checks pass the real source.
    for(const relative of runtimeFiles){
      let bytes=fs.readFileSync(path.join(root,relative));
      if(relative.endsWith('/rules.cjs'))bytes=Buffer.from(bytes.toString().replace(",m_newcomer:'multi'",''));
      const destination=path.join(legacyRoot,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,bytes);
    }
  }
  const legacySourceSha256=Object.fromEntries(runtimeFiles.map(relative=>[relative,hash(fs.readFileSync(path.join(legacyRoot,relative)))]));
  assert.deepEqual(legacySourceSha256,baselineHashes,'Legacy fixture must exactly match deployed prod74 runtime source');
  const {createService}=require('../workbench-api/server.cjs');
  const {MODES,snapshot}=require('../workbench-api/rules.cjs');
  const Reports=require('../group-workbench/reports.js');
  assert.deepEqual(MODES,{...oldModes,[groupId]:'multi'},'The only group-map change must be the new multi group');
  const legacy=startLegacy(legacyRoot,directory);let service;
  const proofs=[];
  try{
    const legacyReady=await legacy.ready,old=client(legacyReady.port);assert.notEqual(legacyReady.pid,process.pid);assert.deepEqual(legacyReady.modes,oldModes);
    const admin=await old.login({name:'admin',role:'admin'},adminPin),groups={};
    async function save(api,session,delta,extra={}){
      const {revision}=await api.data('state',{token:session.token});
      const body={id:randomUUID(),revision,delta,...extra};return{body,result:await api.data('transactions',{token:session.token,body})};
    }
    for(const id of ['g01','g06','m12']){
      const annotation=await old.login(profile('annotation',id)),qc=await old.login(profile('qc',id),groupPin),acceptance=await old.login(profile('acceptance',id),groupPin);
      const saved=await save(old,admin,importDelta(id));groups[id]={annotation,qc,acceptance,tasks:saved.result.delta.tasks};
      await save(old,annotation,{events:[event(groups[id].tasks[0],'claim')]});
      await old.data('state?scope=role-v1',{token:qc.token});
    }
    const beforeStart=await old.data('backup',{token:admin.token});
    service=createService({directory,groupPin,adminPin,existingDatabaseOnly:true,skipStartupBackup:true,backupIntervalMs:0});
    await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
    const current=client(service.server.address().port),view=task=>snapshot(service.state(),task.id);
    assert.deepEqual(service.state(),beforeStart.state);assert.equal(service.getRevision(),beforeStart.revision);
    assert.equal((await current.data('health')).backup.mode,'delegated');
    for(const session of [admin,...Object.values(groups).flatMap(group=>[group.annotation,group.qc,group.acceptance])])assert.deepEqual((await current.data('session',{token:session.token})).profile,session.profile);
    proofs.push('候选与 prod74 为独立进程，共享合成 WAL；候选启动不改旧状态，原管理员/单多镜标注/质检/验收会话全部直接可用');

    const annotation=await current.login(profile('annotation',groupId)),qc=await current.login(profile('qc',groupId),groupPin),acceptance=await current.login(profile('acceptance',groupId),groupPin);
    const newcomer={annotation,qc,acceptance};
    for(const role of ['annotation','qc','acceptance']){
      await current.call('session',{body:{profile:{...profile(role,groupId),mode:'single'},pin:groupPin},status:400});
      await current.call('session',{body:{profile:{...profile(role,groupId),groupId:'m_unknown'},pin:groupPin},status:400});
    }
    await current.call('session',{body:{profile:profile('qc',groupId),pin:'incorrect-synthetic-pin'},status:403});
    await old.call('session',{body:{profile:profile('annotation',groupId)},status:400});
    async function reject(api,session,delta,status,code,extra={}){
      const before=service.exportBackup();
      const body={id:randomUUID(),revision:before.revision,delta,...extra};
      const response=await api.data('transactions',{token:session.token,body,status});assert.equal(response.error.code,code);
      const after=service.exportBackup();assert.deepEqual(after.state,before.state);assert.deepEqual(after.transactions,before.transactions);assert.equal(after.revision,before.revision);
    }
    await reject(current,qc,importDelta(groupId,1,'QC-IMPORT'),403,'FORBIDDEN');
    const wrongMode=importDelta(groupId,1,'WRONG-MODE');wrongMode.tasks[0].mode='single';wrongMode.batches[0].mode='single';
    await reject(current,admin,wrongMode,400,'INVALID_TRANSACTION');
    const saved=await save(current,admin,importDelta(groupId,5));newcomer.tasks=saved.result.delta.tasks;groups[groupId]=newcomer;
    const tasks=newcomer.tasks,originalTasks=service.state().tasks;
    proofs.push('原有18组映射精确不变；m_newcomer 仅允许多镜，三种作业身份可登记，错模块/未知组/错口令与非管理员导入均拒绝');

    await reject(current,groups.g06.annotation,{events:[event(groups.g06.tasks[1],'claim'),event(tasks[4],'claim')]},403,'FORBIDDEN');
    await reject(current,annotation,{events:[event(tasks[4],'claim'),event(groups.m12.tasks[1],'claim')]},403,'FORBIDDEN');
    await save(current,annotation,{events:tasks.slice(0,3).flatMap(task=>[event(task,'claim'),event(task,'submit')])});
    await reject(current,groups.g06.qc,{events:[event(tasks[0],'qc_pass')]},403,'FORBIDDEN');
    await save(current,qc,{events:[event(tasks[0],'qc_fail',{pLevel:'P1',tags:['命名/ID对齐错误'],note:'隔离测试返修'})]});
    assert.equal(view(tasks[0]).status,'rework');
    await save(current,annotation,{events:[event(tasks[0],'submit')]});assert.equal(view(tasks[0]).status,'pending_reqc');
    await save(current,qc,{events:tasks.slice(0,3).map(task=>event(task,'qc_pass'))});
    await reject(current,groups.g01.acceptance,{events:[event(tasks[0],'acceptance_pass')]},403,'FORBIDDEN');
    function decision(task,type,inspection,batchId){const now=view(task);return event(task,type,{acceptanceInspection:inspection,...(batchId?{acceptanceBatchId:batchId}:{}),expectedUpdatedAt:now.updatedAt,acceptanceRound:now.acceptanceRound,note:'新人组隔离验收'});}
    await save(current,groups.g06.acceptance,{events:[decision(tasks[0],'acceptance_fail','fail')]});
    await save(current,qc,{events:[event(tasks[0],'acceptance_route',{route:'annotation',note:'回原组标注返修'})]});
    assert.equal(view(tasks[0]).status,'acceptance_rework');
    await save(current,annotation,{events:[event(tasks[0],'submit')]});await save(current,qc,{events:[event(tasks[0],'qc_pass')]});
    assert.equal(view(tasks[0]).acceptanceRound,2);await save(current,acceptance,{events:[decision(tasks[0],'acceptance_pass','pass')]});
    const returnBatch=randomUUID();await save(current,acceptance,{events:[decision(tasks[1],'acceptance_fail','uninspected',returnBatch)]});
    await save(current,qc,{events:[event(tasks[1],'acceptance_route',{route:'qc',note:'本组质检返修'})]});assert.equal(view(tasks[1]).status,'qc_self_rework');
    await save(current,qc,{events:[event(tasks[1],'qc_repair_done',{note:'本组复查完成'})]});
    await save(current,acceptance,{events:[event(tasks[1],'acceptance_pass')]}); // Existing event shape is unchanged.
    await save(current,acceptance,{events:[decision(tasks[2],'acceptance_pass','uninspected',randomUUID())]});
    assert(tasks.slice(0,3).every(task=>view(task).status==='accepted'));assert.equal(view(tasks[0]).round,3);
    assert.deepEqual(service.state().tasks,originalTasks);
    proofs.push('新人组完成导入→认领→提交→质检返修→重提→验收退回→标注/质检两条返修路径→通过；跨组标注/质检和单镜验收原子拒绝，多镜验收可按原权限处理');

    const settingDate=Reports.acceptanceDate(new Date().toISOString());
    function setting(id,before,after){return{id:randomUUID(),taskId:'group:'+id,type:'group_daily_edit',groupId:id,mode:id===groupId?'multi':oldModes[id],date:settingDate,before,after,note:'隔离测试组日设置'};}
    const empty={leader:'待填写',total:null,headcount:null},configured={leader:'新人组长',total:12,headcount:2.5};
    await save(current,qc,{events:[setting(groupId,empty,configured)]},{pin:groupPin});
    await reject(current,qc,{events:[setting(groupId,empty,configured)]},409,'STATE_CONFLICT',{pin:groupPin});
    await reject(current,groups.g06.qc,{events:[setting(groupId,configured,configured)]},403,'FORBIDDEN',{pin:groupPin});
    await reject(current,qc,{events:[setting(groupId,configured,{...configured,headcount:2.1})]},400,'INVALID_TRANSACTION',{pin:groupPin});
    for(const [id,group]of Object.entries(groups))for(const session of [group.annotation,group.qc]){
      const full=await current.data('state?scope=role-v1',{token:session.token}),delta=await current.data('state?scope=role-v1&after='+beforeStart.revision,{token:session.token});
      const ownIds=new Set(full.state.tasks.map(task=>task.id));assert(full.state.tasks.every(task=>task.groupId===id));
      assert.equal(ownIds.size,group.tasks.length);
      for(const rows of [full.state,delta.delta]){
        assert(rows.tasks.every(task=>task.groupId===id));assert(rows.events.every(row=>ownIds.has(row.taskId)||row.groupId===id));
        assert(rows.batches.every(batch=>batch.groupId===id&&batch.taskIds.every(taskId=>ownIds.has(taskId))));
      }
    }
    proofs.push('group:m_newcomer 组日设置、半人天人数与原乐观冲突规则可用；角色完整/增量同步按原组隔离，不泄漏其他组任务或组日记录');

    // Existing sessions are reused on both sides after new-group rows exist.
    for(const id of ['g01','g06','m12']){
      const group=groups[id],task=group.tasks[0];
      await save(current,group.annotation,{events:[event(task,'submit')]});
      await save(old,group.qc,{events:[event(task,'qc_pass')]});
      await save(current,group.acceptance,{events:[event(task,'acceptance_pass')]});assert.equal(view(task).status,'accepted');
    }
    await save(old,groups.g06.qc,{events:[setting('g06',empty,{leader:'原组组长',total:20,headcount:3})]},{pin:groupPin});
    await reject(old,qc,{events:[event(tasks[3],'claim')]},403,'FORBIDDEN');
    // Annotation has the right role but old prod74 lacks the new group map.
    await reject(old,annotation,{events:[event(tasks[3],'claim')]},400,'INVALID_TRANSACTION');
    proofs.push('新组记录存在后，旧会话在候选与 prod74 两侧继续完成原单/多镜组保存；旧 API 全量校验及组日编辑正常；prod74 无新组写权限，切换后不能作为新组流量回退目标');

    const revision=service.getRevision(),raced=[
      {api:old,session:groups.g06.annotation,task:groups.g06.tasks[1]},
      {api:current,session:annotation,task:tasks[3]}
    ];
    const contenders=raced.map(row=>({id:randomUUID(),revision,delta:{events:[event(row.task,'claim')]}}));
    const responses=await Promise.all(raced.map((row,index)=>row.api.call('transactions',{token:row.session.token,body:contenders[index],status:null})));
    assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
    const winner=responses.findIndex(response=>response.status===200),loser=1-winner;
    assert.equal(responses[loser].value.error.code,'REVISION_CONFLICT');assert.equal(service.getRevision(),revision+1);
    for(const api of [old,current])assert.deepEqual(await api.data('transactions',{token:raced[winner].session.token,body:contenders[winner]}),responses[winner].value);
    await save(raced[loser].api,raced[loser].session,contenders[loser].delta);
    assert(raced.every(row=>view(row.task).status==='annotating'));assert.equal(service.getRevision(),revision+2);
    const duplicate={id:randomUUID(),revision:service.getRevision(),delta:{events:[event(groups.g06.tasks[2],'claim')]}};
    const duplicates=await Promise.all([old,current].map(api=>api.data('transactions',{token:groups.g06.annotation.token,body:duplicate})));
    assert.deepEqual(duplicates[0],duplicates[1]);assert.equal(service.getRevision(),duplicate.revision+1);
    await reject(current,annotation,{events:[event(tasks[4],'claim',{expectedUpdatedAt:'stale'})]},409,'STATE_CONFLICT');
    proofs.push('两独立进程并发写同 WAL 仅一方版本成功、另一方409；同步后重试成功；跨进程同请求重复点击只提交一次，过期任务零写入');

    const state=service.state(),projected=state.tasks.map(task=>view(task));
    for(const row of beforeStart.state.tasks)assert.deepEqual(state.tasks.find(task=>task.id===row.id),row);
    for(const row of beforeStart.state.events)assert.deepEqual(state.events.find(item=>item.id===row.id),row);
    assert.deepEqual((await current.data('backup',{token:admin.token})).state,state);
    const reportGroups=Object.entries(MODES).map(([id,mode])=>({id,name:id===groupId?groupName:id,defaultMode:mode}));
    const input={state,tasks:projected,groups:reportGroups,groupLabel:id=>id===groupId?groupName:id,localDate:Reports.acceptanceDate};
    for(const kind of ['tasks','events','groups','daily']){
      const report=Reports.build({...input,kind,mode:'multi'}),rows=report[kind].rows.filter(row=>row.groupId===groupId);
      assert(rows.length>0,kind+' must include the new group');assert(rows.every(row=>row.group===groupName));
      assert.equal(Reports.build({...input,kind,mode:'single'})[kind].rows.filter(row=>row.groupId===groupId).length,0);
      if(kind==='tasks'){assert.equal(rows.length,5);assert.equal(rows.filter(row=>row.status==='accepted').length,3);}
      if(kind==='groups'){assert.equal(rows[0].acceptedTIDs,3);assert.equal(rows[0].closedTIDs,3);}
      if(kind==='daily')assert(rows.some(row=>row.leader===configured.leader&&row.total===12&&row.headcount===2.5));
    }
    assert.equal(service.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(service.db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
    assert(!fs.existsSync(path.join(directory,'backups')));
    proofs.push('新人组任务/事件/小组/日报导出保留独立ID及中文组名，单镜导出不混入；通过/闭环与组日配置可见；旧任务和旧事件原文不变、无重复备份、SQLite完整性正常');
    const sourceSha256=Object.fromEntries(runtimeFiles.map(relative=>[relative,hash(fs.readFileSync(path.join(root,relative)))]));
    const result={ok:true,runtime:process.version,checkedAt:new Date().toISOString(),legacySourceVerified:true,legacySourceSha256,sourceSha256,testDependencySha256:{'group-workbench/reports.js':hash(fs.readFileSync(path.join(root,'group-workbench/reports.js')))},independentProcesses:true,productionDataAccessed:false,groupId,existingGroupCount:Object.keys(oldModes).length,transactions:service.getRevision(),tasks:state.tasks.length,events:state.events.length,proofs};
    if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result,null,2));return result;
  }finally{if(service)await service.close();await legacy.close();}
}
if(require.main===module){
  const run=process.argv[2]==='--legacy-child'?legacyChild(process.argv[3],process.argv[4]):main();
  run.catch(error=>{console.error(error);process.exitCode=1;});
}
module.exports={main};
